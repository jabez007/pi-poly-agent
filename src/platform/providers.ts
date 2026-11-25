import { createProvider, getDeclaredTools, type Provider } from "@earendil-works/pi-ai";
// Pi 1.5.2's jiti prefix alias corrupts pi-ai/api subpaths. Use the launcher's
// exact installed pin until upstream supports this subpath; this is still Pi's transport.
import { openAICompletionsApi } from "../../node_modules/@earendil-works/pi-ai/dist/api/openai-completions.lazy.js";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import {
	ACP_PROVIDER,
	BRIDGE_PROVIDER,
	CLAUDE_ACP_PROVIDER,
	assertRequest,
	guardedProvider,
	type Policy,
	defaultPolicy,
} from "../policy.ts";
import { providerCapabilities, type Capabilities } from "../orchestration/capabilities.ts";

export interface ProviderInstance {
	id: string;
	adapter: string;
	billing: "subscription" | "coding-plan" | "local" | "api";
	authentication?: "pi-managed" | "native-runtime" | "api-key" | "none";
	enabled: boolean;
	capabilities?: Partial<Capabilities>;
	endpoint?: string;
	models?: string[];
	modelLimits?: { contextWindow: number; maxTokens: number };
}
export interface ProviderAdapter {
	id: string;
	create(instance: ProviderInstance): Provider;
}
const reserved = [
	"openai-codex",
	"kimi-coding",
	"zai",
	BRIDGE_PROVIDER,
	CLAUDE_ACP_PROVIDER,
	ACP_PROVIDER,
];
export function nativeWorkerProvider(id: string): Provider {
	if (!["openai-codex", "kimi-coding", "zai"].includes(id))
		throw new Error("Worker provider is not supported");
	return builtinProviders().find((provider) => provider.id === id)!;
}
function safeEndpoint(endpoint: string, local: boolean): string {
	const url = new URL(endpoint);
	const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
	if (
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		(local ? !loopback : url.protocol !== "https:")
	)
		throw new Error("Provider endpoint requires a credential-free HTTPS or loopback URL");
	if (
		!["https:", "http:"].includes(url.protocol) ||
		/anthropic|claude|google|gemini|antigravity|chatgpt/i.test(url.hostname)
	)
		throw new Error("Subscription endpoints cannot be registered as custom providers");
	return endpoint;
}
function compatible(instance: ProviderInstance): Provider {
	const endpoint = safeEndpoint(instance.endpoint || "", instance.billing === "local");
	return createProvider({
		id: instance.id,
		baseUrl: endpoint,
		auth: {
			apiKey: {
				name: instance.billing === "local" ? "Local endpoint" : "Explicit API credential",
				login:
					instance.billing === "api"
						? async (interaction) => ({
								type: "api_key",
								key: await interaction.prompt({
									type: "secret",
									message: `API key for ${instance.id}. Separately billed usage is enabled for this instance.`,
								}),
							})
						: undefined,
				check: async ({ credential }: any) =>
					instance.billing === "local" || credential?.key
						? { type: "api_key", source: instance.id }
						: undefined,
				resolve: async ({ credential }: any) => {
					if (credential?.env && Object.keys(credential.env).length)
						throw new Error("Custom endpoint credential environment overrides refused");
					if (credential?.type === "oauth")
						throw new Error("Custom endpoint rejects subscription credentials");
					if (instance.billing === "local") return { auth: { apiKey: "local-no-credential" } };
					if (credential?.type !== "api_key") return undefined;
					return { auth: { apiKey: credential.key } };
				},
			},
		},
		models: (instance.models || []).map((id) => ({
			id,
			name: id,
			provider: instance.id,
			api: "openai-completions",
			baseUrl: endpoint,
			reasoning: false,
			input: ["text"],
			contextWindow: instance.modelLimits?.contextWindow ?? 32000,
			maxTokens: instance.modelLimits?.maxTokens ?? 8192,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		})),
		api: openAICompletionsApi(),
	});
}
export function validateInstanceDefinition(instance: ProviderInstance): void {
	if (
		!/^[a-z][a-z0-9-]{0,63}$/.test(instance.id) ||
		!/^[a-z][a-z0-9-]{0,63}$/.test(instance.adapter)
	)
		throw new Error("Invalid provider or adapter identifier");
	if (typeof instance.enabled !== "boolean" || !["local", "api"].includes(instance.billing))
		throw new Error("Custom instances require explicit activation and local or API billing");
	if (instance.endpoint) safeEndpoint(instance.endpoint, instance.billing === "local");
	if (
		instance.modelLimits &&
		(!Number.isInteger(instance.modelLimits.contextWindow) ||
			!Number.isInteger(instance.modelLimits.maxTokens) ||
			instance.modelLimits.contextWindow < 256 ||
			instance.modelLimits.maxTokens < 1 ||
			instance.modelLimits.maxTokens > instance.modelLimits.contextWindow)
	)
		throw new Error("Invalid explicit provider model limits");
	validateInstanceModels(instance);
}
function validateInstanceModels(instance: ProviderInstance): void {
	if (
		instance.adapter === "openai-compatible" &&
		(!instance.endpoint || !Array.isArray(instance.models) || !instance.models.length)
	)
		throw new Error("Compatible endpoint requires an explicit URL and model list");
	if (
		instance.models &&
		instance.models.some((m) => typeof m !== "string" || !/^[\w.:[\]-]+$/.test(m))
	)
		throw new Error("Invalid configured model identifier");
	if (
		instance.capabilities &&
		Object.entries(instance.capabilities).some(
			([k, v]) =>
				!Object.keys(providerCapabilities("openai-codex", defaultPolicy()))
					.filter((key) => key !== "billing")
					.includes(k) || typeof v !== "boolean",
		)
	)
		throw new Error("Provider capability restrictions require known boolean capabilities");
}
/** Trusted registration only. JSON never imports executable provider factories. */
export class ProviderRegistry {
	private instances = new Map<string, ProviderInstance>();
	private adapters = new Map<string, ProviderAdapter>();
	constructor(private policy: () => Policy) {
		this.adapters.set("openai-compatible", { id: "openai-compatible", create: compatible });
		for (const id of reserved)
			this.instances.set(id, {
				id,
				adapter: id,
				enabled: true,
				authentication: [BRIDGE_PROVIDER, CLAUDE_ACP_PROVIDER, ACP_PROVIDER].includes(id)
					? "native-runtime"
					: "pi-managed",
				billing: id === "kimi-coding" || id === "zai" ? "coding-plan" : "subscription",
			});
	}
	registerAdapter(adapter: ProviderAdapter): void {
		if (this.adapters.has(adapter.id) || reserved.includes(adapter.id))
			throw new Error("Adapter identifier already reserved");
		this.adapters.set(adapter.id, adapter);
	}
	register(instance: ProviderInstance): void {
		validateInstanceDefinition(instance);
		if (this.instances.has(instance.id))
			throw new Error("Provider instance identifier already reserved or invalid");
		if (!this.adapters.has(instance.adapter)) throw new Error("Unknown provider adapter");
		this.instances.set(instance.id, {
			...structuredClone(instance),
			authentication: instance.billing === "local" ? "none" : "api-key",
		});
	}
	list(): ProviderInstance[] {
		return structuredClone([...this.instances.values()]);
	}
	capabilities(id: string): Capabilities {
		const instance = this.get(id);
		if (reserved.includes(id)) return providerCapabilities(id, this.policy());
		const base = providerCapabilities("openai-codex", this.policy());
		for (const key of Object.keys(base) as (keyof Capabilities)[])
			if (typeof base[key] === "boolean")
				(base as any)[key] = instance.enabled && instance.capabilities?.[key] !== false;
		base.nativeSubagents = false;
		base.persistentSessions = false;
		base.billing = instance.enabled ? instance.billing : "locked";
		return base;
	}
	get(id: string): ProviderInstance {
		const instance = this.instances.get(id);
		if (!instance) throw new Error("Unknown provider instance; no fallback selected");
		return structuredClone(instance);
	}
	assert(id: string, depth: number, direct = false): void {
		const instance = this.get(id);
		if (direct && reserved.includes(id)) assertRequest(id, this.policy(), true);
		const caps = this.capabilities(id);
		if (!instance.enabled || !(direct ? caps.direct : caps.delegation && caps.background))
			throw new Error("Provider is not authorized for delegated execution");
		if (!direct) assertWorkerRuntime(caps, depth);
	}
	provider(id: string, direct = false, factory?: (id: string) => Provider): Provider {
		this.assert(id, 1, direct);
		const instance = this.get(id);
		const provider = reserved.includes(id)
			? (factory || nativeWorkerProvider)(id)
			: this.adapters.get(instance.adapter)!.create(instance);
		if (provider.id !== id || (instance.endpoint && provider.baseUrl !== instance.endpoint))
			throw new Error("Provider identity or endpoint mismatch");
		if (!reserved.includes(id) && provider.baseUrl)
			safeEndpoint(provider.baseUrl, instance.billing === "local");
		if (!reserved.includes(id) && provider.auth.oauth)
			throw new Error("Custom providers cannot install subscription authentication");
		return guardedProvider(
			reserved.includes(id) ? provider : validateInvocation(provider, this.capabilities(id)),
			() => this.assert(id, 1, direct),
		);
	}
	resolve(
		selection: { instance?: string; requires?: string[] },
		available: { provider: string; id: string }[],
	): string {
		const candidates = available.filter(
			(m) =>
				(!selection.instance || selection.instance === m.provider) &&
				this.matches(m.provider, selection.requires || []),
		);
		if (candidates.length !== 1)
			throw new Error(
				"Provider selection requires exactly one eligible model; choose an explicit provider/model",
			);
		return `${candidates[0].provider}/${candidates[0].id}`;
	}
	private matches(id: string, required: string[]): boolean {
		const caps = this.capabilities(id);
		return caps.delegation && required.every((key) => (caps as any)[key] === true);
	}
}

/** Validate custom requests at transport invocation, including forged model metadata and unsupported tools. */
function validateInvocation(provider: Provider, capabilities: Capabilities): Provider {
	const check = (model: any, context: any) => {
		const registered = provider.getModels().find((m) => m.id === model.id);
		if (
			!registered ||
			["provider", "baseUrl", "api", "contextWindow", "maxTokens"].some(
				(key) => model[key] !== (registered as any)[key],
			)
		)
			throw new Error(
				"Unregistered model or model metadata override refused; no substitution selected",
			);
		if (!capabilities.tools && getDeclaredTools(context.messages).length)
			throw new Error("Provider tools capability is disabled");
	};
	return {
		...provider,
		stream: (...args) => {
			check(args[0], args[1]);
			return provider.stream(...args);
		},
		streamSimple: (...args) => {
			check(args[0], args[1]);
			return provider.streamSimple(...args);
		},
	};
}

function assertWorkerRuntime(caps: Capabilities, depth: number): void {
	if (!caps.streaming || !caps.cancellation)
		throw new Error("Delegated Pi sessions require streaming and cancellation support");
	if (depth !== 1) throw new Error("Delegation depth is limited to one");
}
