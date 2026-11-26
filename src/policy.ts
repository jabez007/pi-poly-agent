import type { Provider } from "@earendil-works/pi-ai";

export const NATIVE_PROVIDERS = ["openai-codex", "kimi-coding", "zai"] as const;
export const BRIDGE_PROVIDER = "claude-bridge";
export const CLAUDE_ACP_PROVIDER = "claude-acp";
export const CLAUDE_REVIEW_REVISION = "2026-11-25.1";
export const ACP_PROVIDER = "antigravity-acp";
export const POLICY_REVISION = "2026-11-21.1";

export interface Activation {
	enabled: boolean;
	review: string;
	runtime: string;
	sha256: string;
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
	const activation = (): Activation => ({ enabled: false, review: "", runtime: "", sha256: "" });
	return {
		version: 1,
		claude: activation(),
		google: activation(),
		kimiApiKey: false,
		zaiCodingPlan: false,
		memory: { enabled: false, sharedWings: [] },
	};
}

export function providerStatus(provider: string, policy: Policy): string {
	const modes: Record<string, string> = {
		"openai-codex": "ChatGPT OAuth",
		"kimi-coding": policy.kimiApiKey ? "Kimi plan OAuth/key" : "Kimi plan OAuth",
		zai: policy.zaiCodingPlan ? "Z.AI coding-plan key" : "coding-plan key locked",
		[BRIDGE_PROVIDER]: claudeStatus(BRIDGE_PROVIDER, policy),
		[CLAUDE_ACP_PROVIDER]: claudeStatus(CLAUDE_ACP_PROVIDER, policy),
		[ACP_PROVIDER]: policy.google.enabled
			? "personal OAuth, direct user only"
			: "Google auth locked",
	};
	return `Poly | ${provider} | ${modes[provider] || "unconfigured"}`;
}

function claudeStatus(provider: string, policy: Policy): string {
	if (policy.claude.enabled && policy.claude.review !== CLAUDE_REVIEW_REVISION)
		return `needs reapproval; re-review and update claude.review to ${CLAUDE_REVIEW_REVISION}`;
	if (!policy.claude.enabled) return "Claude auth locked";
	if (provider !== `claude-${claudeMode(policy)}`) return "Claude mode unselected";
	return provider === BRIDGE_PROVIDER
		? "activated, live unverified; native Claude auth, Pi tools"
		: "activated, live unverified; native Claude auth, direct user only";
}

export function validatePolicy(value: unknown): Policy {
	const p = value as Policy;
	if (!p || p.version !== 1) throw new Error("Unsupported profile policy");
	validateActivation(p.claude, null);
	if (p.claude.mode !== undefined && !["acp", "bridge"].includes(p.claude.mode))
		throw new Error("Claude mode must be acp or bridge");
	validateActivation(p.google);
	if (typeof p.kimiApiKey !== "boolean" || typeof p.zaiCodingPlan !== "boolean") {
		throw new Error("Coding-plan acknowledgements must be boolean");
	}
	if (typeof p.memory?.enabled !== "boolean" || !Array.isArray(p.memory.sharedWings)) {
		throw new Error("Invalid memory policy");
	}
	if (
		!p.memory.sharedWings.every((w) => typeof w === "string" && /^[a-z][a-z0-9_]{0,100}$/.test(w))
	) {
		throw new Error("Invalid shared memory wing");
	}
	validateMemoryBudget(p.memory.contextBudget);
	return p;
}

function validateActivation(a: Activation, revision: string | null = POLICY_REVISION): void {
	if (!a || typeof a.enabled !== "boolean") throw new Error("Invalid activation policy");
	if (![a.review, a.runtime, a.sha256].every((v) => typeof v === "string")) {
		throw new Error("Invalid runtime attestation");
	}
	if (
		a.enabled &&
		((revision !== null && a.review !== revision) ||
			!a.runtime.startsWith("/") ||
			!/^[a-f0-9]{64}$/.test(a.sha256))
	) {
		throw new Error("Activation needs a current review and an absolute, checksum-pinned runtime");
	}
}

// Report names only. Values can contain secrets, URLs, or proxy credentials.
export function conflictingEnvironment(env: NodeJS.ProcessEnv): string[] {
	return Object.keys(env)
		.filter(
			(key) =>
				env[key] &&
				(/^(ANTHROPIC_|CLAUDE_CODE_|CLAUDE_BRIDGE_|GOOGLE_|GEMINI_|AGY_|PI_AGY_)/.test(key) ||
					/^(HTTPS?_PROXY|ALL_PROXY|https?_proxy|all_proxy|NODE_EXTRA_CA_CERTS|NODE_TLS_REJECT_UNAUTHORIZED|NODE_OPTIONS|NODE_PATH)$/.test(
						key,
					) ||
					/^(OPENAI_BASE_URL|OPENAI_API_KEY|OPENAI_API_BASE|KIMI_BASE_URL|ZAI_BASE_URL|LD_.*|AWS_ENDPOINT_URL.*|AWS_BEARER_TOKEN.*|ANTHROPIC_FOUNDRY_.*|ENABLE_CLAUDEAI_MCP_SERVERS)$/.test(
						key,
					)),
		)
		.sort();
}

export function assertEnvironment(env: NodeJS.ProcessEnv): void {
	if (conflictingEnvironment(env).length) {
		throw new Error(
			"Conflicting provider, proxy, or debug environment detected. Run validate for variable names.",
		);
	}
}

/** Check both sources before a provider can merge request overrides into its process environment. */
export function assertInvocationEnvironment(
	options?: { env?: Record<string, string> },
	inherited: NodeJS.ProcessEnv = process.env,
): void {
	assertEnvironment(inherited);
	const overrides = options?.env || {};
	assertEnvironment(overrides);
	// Stored credential environments are also untrusted. Even empty overrides can remove guards.
	if (Object.keys(overrides).some((key) => !/^(LANG|LC_ALL|TZ|TERM|NO_COLOR)$/.test(key)))
		throw new Error("Unreviewed per-request environment override refused; values withheld");
}

export function assertRequest(provider: string, policy: Policy, direct = false): void {
	if (provider === ACP_PROVIDER) {
		if (!policy.google.enabled)
			throw new Error("Google ACP is locked pending review and explicit activation");
		if (!direct)
			throw new Error(
				"Google ACP requires a direct interactive user prompt; delegation is forbidden",
			);
		return;
	}
	if (isClaudeProvider(provider)) {
		assertClaudeRequest(provider, policy, direct);
		return;
	}
	if (!NATIVE_PROVIDERS.includes(provider as (typeof NATIVE_PROVIDERS)[number])) {
		throw new Error("Provider is outside the managed coding-plan profile");
	}
	if (provider === "zai" && !policy.zaiCodingPlan)
		throw new Error("Z.AI requires explicit coding-plan opt-in");
}

export function claudeMode(policy: Policy): "acp" | "bridge" {
	return policy.claude.mode ?? "acp";
}

export function isClaudeProvider(provider: string): boolean {
	return provider === BRIDGE_PROVIDER || provider === CLAUDE_ACP_PROVIDER;
}

function assertClaudeRequest(provider: string, policy: Policy, direct: boolean): void {
	if (!policy.claude.enabled)
		throw new Error("Claude subscription integration is locked pending authorization review");
	validateActivation(policy.claude, null);
	if (policy.claude.review !== CLAUDE_REVIEW_REVISION)
		throw new Error(
			`Claude integration needs reapproval; re-review and update claude.review to ${CLAUDE_REVIEW_REVISION}`,
		);
	const selected = claudeMode(policy) === "acp" ? CLAUDE_ACP_PROVIDER : BRIDGE_PROVIDER;
	if (provider !== selected) throw new Error("Claude mode is not selected in policy");
	if (provider === CLAUDE_ACP_PROVIDER && !direct)
		throw new Error(
			"Claude ACP requires a direct interactive user prompt; delegation is forbidden",
		);
}

export function guardedProvider(provider: Provider, check: () => void): Provider {
	const guard = (model: { baseUrl: string }, options?: { env?: Record<string, string> }) => {
		check();
		assertInvocationEnvironment(options);
		if (model.baseUrl !== provider.baseUrl) throw new Error("Provider endpoint override refused");
	};
	return {
		...provider,
		stream: (...args) => {
			guard(args[0], args[2]);
			return provider.stream(args[0], args[1], { ...args[2], maxRetries: 0 } as (typeof args)[2]);
		},
		streamSimple: (...args) => {
			guard(args[0], args[2]);
			return provider.streamSimple(args[0], args[1], {
				...args[2],
				maxRetries: 0,
			} as (typeof args)[2]);
		},
	};
}

function validateMemoryBudget(value: number | undefined): void {
	if (value !== undefined && (!Number.isInteger(value) || value < 256 || value > 24000))
		throw new Error("Memory context budget must be 256–24000 characters");
}
