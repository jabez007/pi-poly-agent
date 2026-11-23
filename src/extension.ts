import { loadIntegrations } from "./platform/integrations.ts";
import { doctor, formatDoctor } from "./doctor.ts";
import { loadPlatform } from "./platform/config.ts";
import { ProviderRegistry, nativeWorkerProvider } from "./platform/providers.ts";
import { ContextRegistry, nativeContext, memPalaceContext } from "./platform/context.ts";
import type { ContextBackend } from "./platform/context.ts";
import type { WorkerResources } from "./platform/contracts.ts";
import { focusedContext } from "./orchestration/context.ts";
import { draftHandoff, handoffMarkdown, parseHandoffMarkdown } from "./handoff.ts";
import { registerOrchestration } from "./orchestration/extension.ts";
import { registerClaudeBridge } from "./providers/claude.ts";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type {
	ExtensionAPI,
	ExtensionContext,
	ProviderConfig,
} from "@earendil-works/pi-coding-agent";
import {
	ACP_PROVIDER,
	BRIDGE_PROVIDER,
	assertEnvironment,
	assertInvocationEnvironment,
	assertRequest,
	guardedProvider,
	providerStatus,
} from "./policy.ts";
import {
	PROFILE,
	loadPolicy,
	validateProfile,
	validateClaudeSettings,
	validateProjectSafetySettings,
} from "./profile.ts";
import { AcpSession, officialAcpFactory, type AcpFactory } from "./providers/acp.ts";
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
	integrations: {
		providers?: ProviderRegistry;
		context?: ContextBackend[];
		resources?: WorkerResources;
	} = {},
): Promise<void> {
	const profile = process.env.PI_POLY_PROFILE || PROFILE;
	pi.registerCommand("poly-doctor", {
		description: "Inspect configuration, resources and eligibility without executing a provider",
		handler: async (_args, context) =>
			context.ui.notify(formatDoctor(await doctor(profile, context.cwd)), "info"),
	});
	const policy = validateProfile(profile);
	const platform = loadPlatform(profile);
	const memoryEnabled = usesMemPalace(platform, policy.memory.enabled);
	const providers = integrations.providers || new ProviderRegistry(() => loadPolicy(profile));
	const installed = await loadIntegrations(profile, providers, {
		registerCommand: pi.registerCommand.bind(pi),
		on: pi.on.bind(pi),
	});
	for (const instance of platform.providers) providers.register(instance);
	const contexts = new ContextRegistry();
	contexts.register(nativeContext(() => focusedContext(handoff, "")));
	contexts.register(memPalaceContext(policy.memory.sharedWings));
	for (const backend of [...installed.context, ...(integrations.context || [])])
		contexts.register(backend);
	let ctx: ExtensionContext;
	let directPrompt: string | undefined;
	let acp: AcpSession | undefined;
	let memoryTransport: MemoryTransport | undefined;
	let recalled = "";
	let handoff: Handoff | undefined;
	let savedDigest = "";
	let acpBinding: { sessionId: string; cwd: string } | undefined;

	const check = (provider: string) => {
		assertEnvironment(process.env);
		if (ctx) validateProjectSafetySettings(ctx.cwd);
		if (provider === BRIDGE_PROVIDER) validateClaudeSettings();
		assertRequest(provider, loadPolicy(profile));
	};
	for (const provider of builtinProviders()) {
		if (["openai-codex", "kimi-coding", "zai"].includes(provider.id)) continue;
		pi.registerProvider({
			...provider,
			auth: {
				apiKey: {
					name: "Disabled in managed profile",
					check: async () => undefined,
					resolve: async () => undefined,
				},
			},
			getModels: () => [],
			getAllModels: () => [],
			refreshModels: undefined,
			generateImages: undefined,
			classify: undefined,
			stream: () => {
				throw new Error("Provider disabled in managed profile");
			},
			streamSimple: () => {
				throw new Error("Provider disabled in managed profile");
			},
		});
	}
	const codex = nativeWorkerProvider("openai-codex");
	pi.registerProvider(guardedProvider(codex, () => check(codex.id)));
	const kimi = nativeWorkerProvider("kimi-coding");
	if (!policy.kimiApiKey) kimi.auth.apiKey = undefined;
	pi.registerProvider(guardedProvider(kimi, () => check(kimi.id)));
	const zai = nativeWorkerProvider("zai");
	pi.registerProvider(guardedProvider(zai, () => check(zai.id)));

	registerInstanceProviders(pi, providers);

	await registerClaudeBridge(pi, profile, policy.claude, () => check(BRIDGE_PROVIDER));

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
			assertInvocationEnvironment(options);
			assertRequest(
				ACP_PROVIDER,
				loadPolicy(profile),
				ctx?.hasUI && ctx.mode === "tui" && directPrompt !== undefined,
			);
			if (!acp) throw new Error("Run /poly-google-discover first");
			const prompt = directPrompt!;
			directPrompt = undefined; // A capability consumed by exactly one provider request.
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
		directPrompt = undefined;
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
		context.ui.setStatus(
			"poly",
			activeProviderStatus(context.model?.provider || "no provider", providers, policy),
		);
		await recall(context);
	});
	pi.on("input", (event, context) => {
		directPrompt = undefined;
		if (context.model?.provider !== ACP_PROVIDER) return { action: "continue" };
		if (event.source !== "interactive" || !context.hasUI || context.mode !== "tui") {
			context.ui.notify("Google ACP accepts direct interactive user input only.", "error");
			return { action: "handled" };
		}
		if (event.streamingBehavior) {
			context.ui.notify(
				"Wait for or cancel the current Google turn before submitting another prompt.",
				"warning",
			);
			return { action: "handled" };
		}
		if (event.images?.length || event.text.startsWith("!")) {
			context.ui.notify(
				"This ACP slice accepts text prompts. Shell commands and image prompts are not forwarded.",
				"warning",
			);
			return { action: "handled" };
		}
		directPrompt = event.text;
		return { action: "continue" };
	});
	pi.on("agent_settled", () => {
		directPrompt = undefined;
	});
	pi.on("model_select", async (_event, context) => {
		directPrompt = undefined;
		context.ui.setStatus(
			"poly",
			activeProviderStatus(context.model?.provider || "no provider", providers, policy),
		);
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
		handler: async (_args, context) =>
			context.ui.notify(
				[
					"openai-codex: native ChatGPT OAuth",
					`kimi-coding: native OAuth${policy.kimiApiKey ? " or explicitly allowed coding-plan key" : " only"}`,
					`zai: coding-plan key ${policy.zaiCodingPlan ? "allowed" : "locked"}`,
					`claude-bridge: official SDK ${policy.claude.enabled ? "activated, live unverified" : "locked, authorization unresolved"}`,
					`antigravity-acp: direct user only, ${policy.google.enabled ? "activated, live unverified" : "locked"}`,
					`memory: ${memoryEnabled ? "enabled" : "optional, disabled"}`,
				].join("\n"),
				"info",
			),
	});
	pi.registerCommand("poly-google-discover", {
		description: "Explicitly start the reviewed official ACP runtime and discover Gemini models",
		handler: async (args, context) => {
			assertRequest(ACP_PROVIDER, policy, context.hasUI && context.mode === "tui");
			if (
				!(await context.ui.confirm(
					"Start official Google ACP?",
					"This is a live, authenticated runtime operation. Continue?",
				))
			)
				return;
			acp?.close();
			acp = new AcpSession(
				acpFactory || officialAcpFactory(policy.google, context.cwd),
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
			try {
				const models = await acp.discover(args.trim() === "new");
				if (!models.length) throw new Error("No Gemini models");
				pi.registerProvider(ACP_PROVIDER, googleConfig(models));
				context.ui.notify("Gemini models discovered. Choose one with /model.", "info");
			} catch {
				acp.close();
				acp = undefined;
				context.ui.notify(
					"ACP discovery failed. Check the reviewed official runtime and native login.",
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
				"Compaction canceled. Prepare /handoff and enable MemPalace for an explicit checkpoint. Google ACP and automatic recovery compaction remain disabled.",
				"warning",
			);
			return { cancel: true };
		}
	});
	registerOrchestration(
		pi,
		profile,
		async (brief, sources) => {
			if (!ctx) return focusedContext(handoff, "");
			const configuration = loadPlatform(profile, ctx.cwd);
			const selected = configuration.context;
			const configured =
				configuration.legacy && memoryEnabled
					? [...selected, "mempalace"]
					: selected.filter((id) => id !== "mempalace" || memoryEnabled);
			const ids = sources ? configured.filter((id) => sources.includes(id)) : configured;
			const result = await contexts.retrieve(ids, {
				project: projectIdentity(ctx.cwd).wing,
				objective: brief || "current project task",
				budget: 14000,
			});
			if (result.unavailable.length)
				ctx.ui.notify(
					`Context unavailable: ${result.unavailable.join(", ")}. Local task execution remains available.`,
					"warning",
				);
			return result.text;
		},
		undefined,
		{ providers, resources: integrations.resources || installed.resources },
	);
	pi.on("session_shutdown", async () => {
		acp?.close();
		await memoryTransport?.close();
		await contexts.close();
	});
}

function registerInstanceProviders(pi: ExtensionAPI, providers: ProviderRegistry): void {
	for (const instance of providers
		.list()
		.filter(
			(p) => !["openai-codex", "kimi-coding", "zai", BRIDGE_PROVIDER, ACP_PROVIDER].includes(p.id),
		)) {
		if (instance.enabled) pi.registerProvider(providers.provider(instance.id, true));
	}
}

function activeProviderStatus(
	id: string,
	providers: ProviderRegistry,
	policy: Parameters<typeof providerStatus>[1],
): string {
	try {
		const instance = providers.get(id);
		if (["local", "api"].includes(instance.billing))
			return `Poly | ${id} | ${instance.billing} | ${providers.capabilities(id).delegation ? "worker eligible" : "direct only"}`;
	} catch {
		/* Pi can display an unavailable historical model. */
	}
	return providerStatus(id, policy);
}

function usesMemPalace(platform: ReturnType<typeof loadPlatform>, enabled: boolean): boolean {
	return enabled && (platform.legacy || platform.context.includes("mempalace"));
}
