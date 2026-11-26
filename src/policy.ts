import type { Provider } from "@earendil-works/pi-ai";

export const NATIVE_PROVIDERS = ["openai-codex", "kimi-coding", "zai"] as const;
export const BRIDGE_PROVIDER = "claude-bridge";
export const CLAUDE_ACP_PROVIDER = "claude-acp";
export const ACP_PROVIDER = "antigravity-acp";

export interface Activation {
	enabled: boolean;
	path?: string;
}
export interface Policy {
	version: 1;
	claude: Activation & { mode?: "acp" | "bridge" };
	google: Activation;
	kimiApiKey: boolean;
	zaiCodingPlan: boolean;
	memory: { enabled: boolean; sharedWings: string[]; contextBudget?: number };
}

export function defaultPolicy(): Policy {
	return {
		version: 1,
		claude: { enabled: false, mode: "acp" },
		google: { enabled: false },
		kimiApiKey: false,
		zaiCodingPlan: false,
		memory: { enabled: false, sharedWings: [] },
	};
}

export function claudeMode(policy: Policy): "acp" | "bridge" {
	return policy.claude.mode ?? "acp";
}
export function isClaudeProvider(provider: string): boolean {
	return provider === BRIDGE_PROVIDER || provider === CLAUDE_ACP_PROVIDER;
}
export function directOnlyProvider(provider: string): boolean {
	return isClaudeProvider(provider) || provider === ACP_PROVIDER;
}
export function providerStatus(provider: string, policy: Policy): string {
	if (isClaudeProvider(provider)) {
		const state = !policy.claude.enabled
			? "off"
			: provider === `claude-${claudeMode(policy)}`
				? "on, native login, direct user only"
				: "unselected";
		return `Poly | ${provider} | ${state}`;
	}
	const modes: Record<string, string> = {
		"openai-codex": "ChatGPT OAuth",
		"kimi-coding": policy.kimiApiKey ? "Kimi plan OAuth/key" : "Kimi plan OAuth",
		zai: policy.zaiCodingPlan ? "Z.AI coding-plan key" : "coding-plan key off",
		[ACP_PROVIDER]: policy.google.enabled ? "on, native login, direct user only" : "off",
	};
	return `Poly | ${provider} | ${modes[provider] || "Pi provider"}`;
}

export function validatePolicy(value: unknown): Policy {
	const p = value as Partial<Policy>;
	if (!p || p.version !== 1) throw new Error("Unsupported profile policy");
	const defaults = defaultPolicy();
	const claude = claudeActivation(p.claude ?? defaults.claude);
	const kimiApiKey = booleanChoice(p.kimiApiKey);
	const zaiCodingPlan = booleanChoice(p.zaiCodingPlan);
	return {
		version: 1,
		claude,
		google: activation(p.google ?? defaults.google),
		kimiApiKey,
		zaiCodingPlan,
		memory: memoryPolicy(p.memory ?? defaults.memory),
	};
}
function claudeActivation(value: Policy["claude"]): Policy["claude"] {
	const mode = value.mode ?? "acp";
	if (!["acp", "bridge"].includes(mode)) throw new Error("Claude mode must be acp or bridge");
	return { ...activation(value), mode };
}
function booleanChoice(value: unknown = false): boolean {
	if (typeof value !== "boolean") throw new Error("Coding-plan acknowledgements must be boolean");
	return value;
}
function activation(value: Activation): Activation {
	if (!value || typeof value.enabled !== "boolean") throw new Error("Invalid activation policy");
	if (value.path !== undefined && (typeof value.path !== "string" || !value.path.startsWith("/")))
		throw new Error("Optional runtime path must be absolute");
	return value.path === undefined
		? { enabled: value.enabled }
		: { enabled: value.enabled, path: value.path };
}
function memoryPolicy(value: Policy["memory"]): Policy["memory"] {
	if (typeof value?.enabled !== "boolean" || !Array.isArray(value.sharedWings))
		throw new Error("Invalid memory policy");
	if (!value.sharedWings.every((w) => typeof w === "string" && /^[a-z][a-z0-9_]{0,100}$/.test(w)))
		throw new Error("Invalid shared memory wing");
	const budget = value.contextBudget;
	if (budget !== undefined && (!Number.isInteger(budget) || budget < 256 || budget > 24000))
		throw new Error("Memory context budget must be 256–24000 characters");
	return {
		enabled: value.enabled,
		sharedWings: value.sharedWings,
		...(budget === undefined ? {} : { contextBudget: budget }),
	};
}

// Exact billing/authentication selectors from the native runtimes' documented environments.
export const CLAUDE_BILLING_ENV = [
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_AUTH_TOKEN",
	"ANTHROPIC_BASE_URL",
	"ANTHROPIC_CUSTOM_HEADERS",
	"ANTHROPIC_PROFILE",
	"ANTHROPIC_FEDERATION_RULE_ID",
	"CLAUDE_CODE_USE_BEDROCK",
	"CLAUDE_CODE_USE_VERTEX",
	"CLAUDE_CODE_USE_FOUNDRY",
	"CLAUDE_CODE_USE_MANTLE",
	"CLAUDE_CODE_USE_ANTHROPIC_AWS",
	"CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
] as const;
export const GOOGLE_BILLING_ENV = [
	"GEMINI_API_KEY",
	"GOOGLE_API_KEY",
	"GOOGLE_GEMINI_BASE_URL",
	"AGY_ADC_AUTH",
] as const;
export function conflictingEnvironment(env: NodeJS.ProcessEnv, provider: string): string[] {
	const names = isClaudeProvider(provider)
		? CLAUDE_BILLING_ENV
		: provider === ACP_PROVIDER
			? GOOGLE_BILLING_ENV
			: [];
	return names.filter((name) => !!env[name]).sort();
}
export function assertEnvironment(provider: string, env: NodeJS.ProcessEnv = process.env): void {
	if (conflictingEnvironment(env, provider).length)
		throw new Error(
			"Runtime billing or authentication environment override refused; values withheld",
		);
}
export function assertInvocationEnvironment(
	provider: string,
	options?: { env?: Record<string, string> },
	inherited: NodeJS.ProcessEnv = process.env,
): void {
	assertEnvironment(provider, inherited);
	assertEnvironment(provider, options?.env || {});
}
export function assertRequest(provider: string, policy: Policy, direct = false): void {
	if (directOnlyProvider(provider)) {
		const enabled = isClaudeProvider(provider) ? policy.claude.enabled : policy.google.enabled;
		if (!enabled)
			throw new Error(
				`${isClaudeProvider(provider) ? "Claude" : "Google ACP"} is off; enable it in poly.json`,
			);
		if (isClaudeProvider(provider) && provider !== `claude-${claudeMode(policy)}`)
			throw new Error("Claude mode is not selected in poly.json");
		if (!direct) throw new Error("This runtime requires a direct interactive user prompt");
	}
	if (provider === "zai" && !policy.zaiCodingPlan)
		throw new Error("Z.AI requires explicit coding-plan opt-in");
}
export function guardedProvider(provider: Provider, check: () => void): Provider {
	const guard = (model: { baseUrl: string }) => {
		check();
		if (model.baseUrl !== provider.baseUrl) throw new Error("Provider endpoint override refused");
	};
	return {
		...provider,
		stream: (...args) => {
			guard(args[0]);
			return provider.stream(args[0], args[1], { ...args[2], maxRetries: 0 } as (typeof args)[2]);
		},
		streamSimple: (...args) => {
			guard(args[0]);
			return provider.streamSimple(args[0], args[1], {
				...args[2],
				maxRetries: 0,
			} as (typeof args)[2]);
		},
	};
}
