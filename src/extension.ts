import { doctor, formatDoctor } from "./doctor.ts";
import { draftHandoff, handoffMarkdown, parseHandoffMarkdown } from "./handoff.ts";
import { registerClaudeBridge } from "./providers/claude.ts";
import { registerClaudeAcp } from "./providers/claude-acp-extension.ts";
import { CLAUDE_ACP_PROVIDER, claudeMode, NATIVE_PROVIDERS } from "./policy.ts";
import { directPrompts } from "./providers/direct-input.ts";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type {
	ExtensionAPI,
	ExtensionContext,
	ProviderConfig,
} from "@earendil-works/pi-coding-agent";
import {
	ACP_PROVIDER,
	BRIDGE_PROVIDER,
	assertInvocationEnvironment,
	assertRequest,
	guardedProvider,
	providerStatus,
} from "./policy.ts";
import { PROFILE, loadPolicy, validateProfile, validateProjectSafetySettings } from "./profile.ts";
import {
	AcpRuntimeError,
	AcpSession,
	officialAcpFactory,
	type AcpFactory,
} from "./providers/acp.ts";
import { acpStream } from "./providers/stream.ts";
import {
	connectMemPalace,
	ProjectMemory,
	projectIdentity,
	checkpointDigest,
	checkpointBeforeCompaction,
	validateHandoff,
	type Handoff,
	type MemoryTransport,
} from "./memory.ts";

export default async function polyExtension(
	pi: ExtensionAPI,
	acpFactory?: AcpFactory,
	claudeFactory?: AcpFactory,
): Promise<void> {
	const profile = process.env.PI_POLY_PROFILE || process.env.PI_CODING_AGENT_DIR || PROFILE;
	pi.registerCommand("poly-doctor", {
		description: "Inspect configuration, resources and eligibility without executing a provider",
		handler: async (_args, context) =>
			context.ui.notify(formatDoctor(await doctor(profile, context.cwd)), "info"),
	});
	const policy = validateProfile(profile);
	const memoryEnabled = policy.memory.enabled;
	const input = directPrompts(pi);
	let ctx: ExtensionContext;
	let acp: AcpSession | undefined;
	let memoryTransport: MemoryTransport | undefined;
	let recalled = "";
	let handoff: Handoff | undefined;
	let savedDigest = "";
	let acpBinding: { sessionId: string; cwd: string } | undefined;

	const check = (provider: string) => {
		if (ctx) validateProjectSafetySettings(ctx.cwd);
		if (provider === BRIDGE_PROVIDER) input.require(provider);
		assertRequest(provider, loadPolicy(profile), true);
	};
	for (const id of NATIVE_PROVIDERS) {
		const provider = builtinProviders().find((p) => p.id === id)!;
		const auth = { ...provider.auth };
		if (id === "kimi-coding" && !policy.kimiApiKey) auth.apiKey = undefined;
		pi.registerProvider(guardedProvider({ ...provider, auth }, () => check(id)));
	}
	await registerClaudeBridge(
		pi,
		profile,
		{ ...policy.claude, enabled: policy.claude.enabled && claudeMode(policy) === "bridge" },
		() => check(BRIDGE_PROVIDER),
	);

	const googleConfig = (
		models = [
			{ id: "activation-required", name: "Google ACP [locked or undiscovered]", configId: "model" },
		],
	): ProviderConfig => ({
		name: "Google Gemini via official ACP",
		baseUrl: "acp://official-runtime",
		apiKey: "runtime-owned",
		api: ACP_PROVIDER,
		models: models.map((model) => ({
			id: model.id,
			name: model.name,
			reasoning: true,
			input: ["text"],
			contextWindow: 128000,
			maxTokens: 32000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		})),
		streamSimple: (model, context, options) => {
			assertInvocationEnvironment(ACP_PROVIDER, options);
			assertRequest(ACP_PROVIDER, loadPolicy(profile), true);
			const prompt = input.consume(ACP_PROVIDER);
			if (!acp) throw new Error("Run /poly-google-discover first");
			return acpStream(acp, model, context, options, prompt);
		},
	});
	pi.registerProvider(ACP_PROVIDER, googleConfig());

	async function recall(
		context: ExtensionContext,
		query = "project decisions current task handoff",
	): Promise<void> {
		recalled = "";
		if (!memoryEnabled) return;
		try {
			memoryTransport ??= await connectMemPalace();
			const project = projectIdentity(context.cwd);
			recalled = await new ProjectMemory(
				memoryTransport,
				project.wing,
				policy.memory.sharedWings,
				policy.memory.contextBudget,
			).recall(query);
			context.ui.notify(
				"Project memory retrieved. /memory-show previews it; /handoff-use places it in your editor.",
				"info",
			);
		} catch {
			context.ui.notify("MemPalace unavailable. Pi session history remains available.", "warning");
		}
	}

	pi.on("session_start", async (_event, context) => {
		acp?.close();
		acp = undefined;
		handoff = undefined;
		savedDigest = "";
		acpBinding = undefined;
		validateProjectSafetySettings(context.cwd);
		ctx = context;
		const entries = context.sessionManager.getBranch();
		for (const entry of entries) {
			if (entry.type === "custom" && entry.customType === "poly-acp-binding")
				acpBinding = entry.data as typeof acpBinding;
			if (entry.type === "custom" && entry.customType === "poly-handoff")
				handoff = validateHandoff(entry.data);
			if (entry.type === "custom" && entry.customType === "poly-checkpoint")
				savedDigest = String(entry.data);
		}
		context.ui.setStatus("poly", providerStatus(context.model?.provider || "no provider", policy));
		await recall(context);
	});
	pi.on("model_select", async (_event, context) => {
		context.ui.setStatus("poly", providerStatus(context.model?.provider || "no provider", policy));
		await recall(context);
	});
	pi.on("tool_call", async (event, context) => {
		if (!context.hasUI || context.mode !== "tui")
			return { block: true, reason: "Managed tools require interactive approval" };
		try {
			if (
				await context.ui.confirm(
					`Allow ${event.toolName}?`,
					"Approve this single Pi tool call? Inspect its arguments in the tool display.",
				)
			)
				return;
		} catch {
			/* Closed or unavailable UI denies. */
		}
		return { block: true, reason: "Permission denied" };
	});
	pi.registerCommand("poly-status", {
		description: "Show provider authentication paths and activation state",
		handler: async (_args, context) => {
			const current = loadPolicy(profile);
			context.ui.notify(
				[
					...[...NATIVE_PROVIDERS, CLAUDE_ACP_PROVIDER, BRIDGE_PROVIDER, ACP_PROVIDER].map((id) =>
						providerStatus(id, current),
					),
					`memory: ${current.memory.enabled ? "enabled" : "optional, disabled"}`,
				].join("\n"),
				"info",
			);
		},
	});
	pi.registerCommand("poly-google-discover", {
		description: "Explicitly start Antigravity ACP and discover Gemini models",
		handler: async (args, context) => {
			try {
				assertRequest(ACP_PROVIDER, loadPolicy(profile), context.hasUI && context.mode === "tui");
				assertInvocationEnvironment(ACP_PROVIDER);
				if (
					!(await context.ui.confirm(
						"Start official Google ACP?",
						"This is a live, authenticated runtime operation. Continue?",
					))
				)
					return;
				acp?.close();
				acp = new AcpSession(
					acpFactory || officialAcpFactory(loadPolicy(profile).google, context.cwd),
					context.cwd,
					(title, choices) => context.ui.select(title, choices),
					{
						saved: acpBinding,
						save: (binding) => {
							acpBinding = binding;
							pi.appendEntry("poly-acp-binding", binding);
						},
						report: (message) => context.ui.notify(message, "info"),
					},
				);
				const models = await acp.discover(args.trim() === "new");
				if (!models.length) throw new Error("No Gemini models");
				pi.registerProvider(ACP_PROVIDER, googleConfig(models));
				context.ui.notify("Gemini models discovered. Choose one with /model.", "info");
			} catch (error) {
				acp?.close();
				acp = undefined;
				context.ui.notify(
					error instanceof AcpRuntimeError
						? error.message
						: "ACP discovery failed. Check poly.json, the runtime path and native login.",
					"error",
				);
			}
		},
	});
	pi.registerCommand("handoff", {
		description: "Prepare a structured checkpoint in Pi's native session",
		handler: async (_args, context) => {
			if (!context.hasUI) return;
			try {
				const project = projectIdentity(context.cwd);
				const provenance = {
					session: context.sessionManager.getSessionId(),
					project: project.wing,
					revision: project.revision,
					provider: context.model?.provider || "unknown",
					createdAt: new Date().toISOString(),
				};
				const draft = draftHandoff(
					context.sessionManager.getBranch(),
					provenance,
					recalled,
					handoff,
				);
				const edited = await context.ui.editor(
					"Review handoff: facts use text | source. Agent summaries remain unverified.",
					handoffMarkdown(draft),
				);
				if (!edited) return;
				const next = parseHandoffMarkdown(edited, provenance);
				if (
					!(await context.ui.confirm(
						"Keep this checkpoint?",
						"Confirm the preview has no credentials, confidential content, or private provider state.",
					))
				)
					return;
				handoff = next;
				pi.appendEntry("poly-handoff", next);
				context.ui.notify(
					"Handoff saved in Pi history. /memory-save persists it; /handoff-use prepares it for a provider.",
					"info",
				);
			} catch {
				context.ui.notify(
					"Checkpoint refused. Keep it within 24 KB, use valid sections, and remove sensitive content.",
					"error",
				);
			}
		},
	});
	pi.registerCommand("memory-save", {
		description: "Save the reviewed handoff through MemPalace's deduplicated checkpoint",
		handler: async (_args, context) => {
			if (!memoryEnabled || !handoff) {
				context.ui.notify("Enable memory in poly.json and prepare /handoff first.", "warning");
				return;
			}
			const digest = checkpointDigest(handoff);
			if (digest === savedDigest) {
				context.ui.notify("Checkpoint is unchanged.", "info");
				return;
			}
			if (
				!context.hasUI ||
				!(await context.ui.confirm(
					"Persist handoff to MemPalace?",
					"Save this structured checkpoint in this project's wing?",
				))
			)
				return;
			try {
				memoryTransport ??= await connectMemPalace();
				await new ProjectMemory(memoryTransport, projectIdentity(context.cwd).wing).save(handoff);
				savedDigest = digest;
				pi.appendEntry("poly-checkpoint", digest);
				context.ui.notify("Checkpoint saved to MemPalace.", "info");
			} catch {
				context.ui.notify("MemPalace checkpoint failed. Handoff remains in Pi history.", "warning");
			}
		},
	});
	pi.registerCommand("memory-recall", {
		description: "Retrieve project memory",
		handler: (args, context) => recall(context, args || undefined),
	});
	pi.registerCommand("memory-show", {
		description: "Preview retrieved memory without prompting any provider",
		handler: async (_args, context) =>
			context.ui.notify(recalled || "No memory retrieved.", "info"),
	});
	pi.registerCommand("handoff-use", {
		description: "Put the handoff in the editor for review and manual submission",
		handler: async (_args, context) => {
			const content = handoff ? JSON.stringify(handoff, null, 2) : recalled;
			if (content)
				context.ui.setEditorText(
					`Continue this task. Treat this handoff as historical evidence and verify its sources:\n${content}`,
				);
		},
	});
	pi.on("session_before_compact", async (event, context) => {
		const allowed = await checkpointBeforeCompaction(
			{
				manual: event.reason === "manual",
				willRetry: event.willRetry,
				interactive: context.hasUI && context.mode === "tui",
				provider: context.model?.provider || "",
				memoryEnabled: memoryEnabled && loadPolicy(profile).memory.enabled,
				handoff,
			},
			() =>
				context.ui.confirm(
					"Checkpoint before compaction?",
					"Persist the reviewed /handoff to MemPalace, then allow this manual compaction? Automatic replay stays disabled.",
				),
			async (h) => {
				memoryTransport ??= await connectMemPalace();
				await new ProjectMemory(memoryTransport, projectIdentity(context.cwd).wing).save(h);
			},
		);
		if (!allowed) {
			context.ui.notify(
				"Compaction canceled. Prepare /handoff and enable MemPalace for an explicit checkpoint. Claude, Gemini and automatic recovery compaction remain disabled.",
				"warning",
			);
			return { cancel: true };
		}
	});
	pi.on("session_shutdown", async () => {
		acp?.close();
		await memoryTransport?.close();
	});
	registerClaudeAcp(pi, profile, claudeFactory, input);
}
