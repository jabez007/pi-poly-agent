import type { Provider } from "@earendil-works/pi-ai";

export const NATIVE_PROVIDERS = ["openai-codex", "kimi-coding", "zai"] as const;
export const BRIDGE_PROVIDER = "claude-bridge";
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
	claude: Activation;
	google: Activation;
	kimiApiKey: boolean;
	zaiCodingPlan: boolean;
	memory: { enabled: boolean; sharedWings: string[] };
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
		[BRIDGE_PROVIDER]: policy.claude.enabled ? "native Claude auth" : "Claude auth locked",
		[ACP_PROVIDER]: policy.google.enabled
			? "personal OAuth, direct user only"
			: "Google auth locked",
	};
	return `Poly | ${provider} | ${modes[provider] || "unconfigured"}`;
}

export function validatePolicy(value: unknown): Policy {
	const p = value as Policy;
	if (!p || p.version !== 1) throw new Error("Unsupported profile policy");
	validateActivation(p.claude);
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
	return p;
}

function validateActivation(a: Activation): void {
	if (!a || typeof a.enabled !== "boolean") throw new Error("Invalid activation policy");
	if (![a.review, a.runtime, a.sha256].every((v) => typeof v === "string")) {
		throw new Error("Invalid runtime attestation");
	}
	if (
		a.enabled &&
		(a.review !== POLICY_REVISION || !a.runtime.startsWith("/") || !/^[a-f0-9]{64}$/.test(a.sha256))
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
					/^(HTTPS?_PROXY|ALL_PROXY|https?_proxy|all_proxy|NODE_EXTRA_CA_CERTS|NODE_TLS_REJECT_UNAUTHORIZED|NODE_OPTIONS)$/.test(
						key,
					) ||
					/^(OPENAI_BASE_URL|OPENAI_API_KEY|OPENAI_API_BASE|KIMI_BASE_URL|ZAI_BASE_URL)$/.test(
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
	if (provider === BRIDGE_PROVIDER) {
		if (!policy.claude.enabled)
			throw new Error("Claude subscription integration is locked pending authorization review");
		return;
	}
	if (!NATIVE_PROVIDERS.includes(provider as (typeof NATIVE_PROVIDERS)[number])) {
		throw new Error("Provider is outside the managed coding-plan profile");
	}
	if (provider === "zai" && !policy.zaiCodingPlan)
		throw new Error("Z.AI requires explicit coding-plan opt-in");
}

export function guardedProvider(provider: Provider, check: () => void): Provider {
	const guard = (model: { baseUrl: string }, options?: { env?: Record<string, string> }) => {
		check();
		assertEnvironment(options?.env || {});
		if (model.baseUrl !== provider.baseUrl) throw new Error("Provider endpoint override refused");
	};
	return {
		...provider,
		stream: (...args) => {
			guard(args[0], args[2]);
			return provider.stream(...args);
		},
		streamSimple: (...args) => {
			guard(args[0], args[2]);
			return provider.streamSimple(...args);
		},
	};
}
