import type {
	ExtensionAPI,
	ExtensionContext,
	ProviderConfig,
} from "@earendil-works/pi-coding-agent";
import { CLAUDE_ACP_PROVIDER, assertInvocationEnvironment, assertRequest } from "../policy.ts";
import { loadPolicy } from "../profile.ts";
import { AcpSession, officialAcpFactory, type AcpFactory } from "./acp.ts";
import { CLAUDE_ACP_RUNTIME, ClaudeAcpError } from "./claude-acp.ts";
import { assertClaudeAcpSettings } from "./claude-acp-settings.ts";
import { acpStream } from "./stream.ts";

/** Claude owns tools and private execution state. Only fresh human input crosses this seam. */
export function registerClaudeAcp(pi: ExtensionAPI, profile: string, factory?: AcpFactory): void {
	let session: AcpSession | undefined;
	let binding: { sessionId: string; cwd: string } | undefined;
	let directPrompt: string | undefined;
	let context: ExtensionContext | undefined;
	const check = async (ctx: ExtensionContext) => {
		assertRequest(CLAUDE_ACP_PROVIDER, loadPolicy(profile), ctx.hasUI && ctx.mode === "tui");
		await assertClaudeAcpSettings(ctx.cwd);
	};
	const configure = (
		models = [
			{ id: "activation-required", name: "Claude ACP [locked or undiscovered]", configId: "model" },
		],
	): ProviderConfig => ({
		name: "Claude Code via ACP",
		baseUrl: "acp://claude-code",
		apiKey: "runtime-owned",
		api: CLAUDE_ACP_PROVIDER,
		models: models.map((model) => ({
			...model,
			reasoning: true,
			input: ["text"],
			contextWindow: 128000,
			maxTokens: 32000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		})),
		streamSimple: (model, transcript, options) => {
			assertInvocationEnvironment(options);
			assertRequest(
				CLAUDE_ACP_PROVIDER,
				loadPolicy(profile),
				!!context?.hasUI && context.mode === "tui" && directPrompt !== undefined,
			);

			if (!session) throw new Error("Run /poly-claude-discover first");
			const prompt = directPrompt!;
			directPrompt = undefined;
			return acpStream(session, model, transcript, options, prompt);
		},
	});
	pi.registerProvider(CLAUDE_ACP_PROVIDER, configure());
	pi.registerCommand("poly-claude-discover", {
		description: "Explicitly start reviewed Claude Code ACP and discover its models",
		handler: async (args, ctx) => {
			try {
				await check(ctx);
				if (
					!(await ctx.ui.confirm(
						"Start Claude Code ACP?",
						"This is a live, authenticated runtime operation. Continue?",
					))
				)
					return;
				session?.close();
				session = new AcpSession(
					factory || officialAcpFactory(loadPolicy(profile).claude, ctx.cwd, CLAUDE_ACP_RUNTIME),
					ctx.cwd,
					(title, options) => ctx.ui.select(title, options),
					{
						saved: binding,
						save: (next) => {
							binding = next;
							pi.appendEntry("poly-claude-acp-binding", next);
						},
						report: (message) => ctx.ui.notify(message, "info"),
					},
					CLAUDE_ACP_RUNTIME,
				);
				const models = await session.discover(args.trim() === "new");
				if (!models.length) throw new Error("No models discovered");
				pi.registerProvider(CLAUDE_ACP_PROVIDER, configure(models));
				ctx.ui.notify("Claude Code models discovered. Choose one with /model.", "info");
			} catch (error) {
				session?.close();
				session = undefined;
				ctx.ui.notify(
					error instanceof ClaudeAcpError
						? error.message
						: "Claude ACP discovery refused. Check activation, native default permission mode, settings, checksum and login.",
					"error",
				);
			}
		},
	});
	pi.registerCommand("poly-claude-mode", {
		description: "Select a permitted Claude Code mode for the current ACP session",
		handler: async (args, ctx) => {
			try {
				await check(ctx);
				if (!session) throw new Error("Discovery required");
				const mode =
					args.trim() ||
					(await ctx.ui.select("Claude Code permission mode", session.availableModes()));
				if (mode) await session.selectMode(mode);
			} catch (error) {
				ctx.ui.notify(
					error instanceof ClaudeAcpError
						? error.message
						: "Claude ACP mode refused. Discover first and choose an advertised default, plan or acceptEdits mode while idle.",
					"error",
				);
			}
		},
	});
	pi.on("session_start", async (_event, ctx) => {
		session?.close();
		session = undefined;
		directPrompt = undefined;
		binding = undefined;
		context = ctx;
		for (const entry of ctx.sessionManager.getBranch())
			if (entry.type === "custom" && entry.customType === "poly-claude-acp-binding")
				binding = entry.data as typeof binding;
	});
	pi.on("input", (event, ctx) => {
		directPrompt = undefined;
		if (ctx.model?.provider !== CLAUDE_ACP_PROVIDER) return { action: "continue" };
		if (event.source !== "interactive" || !ctx.hasUI || ctx.mode !== "tui") {
			ctx.ui.notify("Claude ACP accepts direct interactive user input only.", "error");
			return { action: "handled" };
		}
		if (event.streamingBehavior || event.images?.length || event.text.startsWith("!")) {
			ctx.ui.notify(
				"Claude ACP accepts one direct text turn at a time. Wait for or cancel the current turn.",
				"warning",
			);
			return { action: "handled" };
		}
		directPrompt = event.text;
		context = ctx;
		return { action: "continue" };
	});
	pi.on("agent_settled", () => {
		directPrompt = undefined;
	});
	pi.on("model_select", () => {
		directPrompt = undefined;
	});
	pi.on("session_shutdown", async () => {
		session?.close();
	});
}
