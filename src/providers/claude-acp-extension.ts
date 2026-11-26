import type {
	ExtensionAPI,
	ExtensionContext,
	ProviderConfig,
} from "@earendil-works/pi-coding-agent";
import { CLAUDE_ACP_PROVIDER, assertInvocationEnvironment, assertRequest } from "../policy.ts";
import { loadPolicy } from "../profile.ts";
import { AcpRuntimeError, AcpSession, officialAcpFactory, type AcpFactory } from "./acp.ts";
import { CLAUDE_ACP_RUNTIME } from "./claude-acp.ts";
import { directPrompts } from "./direct-input.ts";
import { acpStream } from "./stream.ts";

export function registerClaudeAcp(
	pi: ExtensionAPI,
	profile: string,
	factory?: AcpFactory,
	input = directPrompts(pi),
): void {
	let session: AcpSession | undefined;
	let binding: { sessionId: string; cwd: string } | undefined;
	const check = (ctx: ExtensionContext) =>
		assertRequest(CLAUDE_ACP_PROVIDER, loadPolicy(profile), ctx.hasUI && ctx.mode === "tui");
	const configure = (
		models = [
			{ id: "activation-required", name: "Claude ACP [off or undiscovered]", configId: "model" },
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
			assertInvocationEnvironment(CLAUDE_ACP_PROVIDER, options);
			assertRequest(CLAUDE_ACP_PROVIDER, loadPolicy(profile), true);
			const prompt = input.consume(CLAUDE_ACP_PROVIDER);
			if (!session) throw new Error("Run /poly-claude-discover first");
			return acpStream(session, model, transcript, options, prompt);
		},
	});
	pi.registerProvider(CLAUDE_ACP_PROVIDER, configure());
	pi.registerCommand("poly-claude-discover", {
		description: "Start Claude Code ACP explicitly and discover its models",
		handler: async (args, ctx) => {
			try {
				check(ctx);
				assertInvocationEnvironment(CLAUDE_ACP_PROVIDER);
				if (
					!(await ctx.ui.confirm(
						"Start Claude Code ACP?",
						"This starts the native authenticated runtime. Continue?",
					))
				)
					return;
				session?.close();
				session = new AcpSession(
					factory || officialAcpFactory(loadPolicy(profile).claude, ctx.cwd, CLAUDE_ACP_RUNTIME),
					ctx.cwd,
					(title, choices) => ctx.ui.select(title, choices),
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
					error instanceof AcpRuntimeError
						? error.message
						: "Claude ACP discovery refused. Check poly.json, the runtime path and native login.",
					"error",
				);
			}
		},
	});
	pi.registerCommand("poly-claude-mode", {
		description: "Select a mode offered by the current Claude Code session",
		handler: async (args, ctx) => {
			try {
				check(ctx);
				if (!session) throw new Error("Discovery required");
				const mode =
					args.trim() ||
					(await ctx.ui.select("Claude Code permission mode", session.availableModes()));
				if (mode) await session.selectMode(mode);
			} catch (error) {
				ctx.ui.notify(
					error instanceof AcpRuntimeError
						? error.message
						: "Discover Claude ACP first, then choose an offered mode while idle.",
					"error",
				);
			}
		},
	});
	pi.on("session_start", async (_event, ctx) => {
		session?.close();
		session = undefined;
		binding = undefined;
		for (const entry of ctx.sessionManager.getBranch())
			if (entry.type === "custom" && entry.customType === "poly-claude-acp-binding")
				binding = entry.data as typeof binding;
	});
	pi.on("session_shutdown", () => {
		session?.close();
	});
}
