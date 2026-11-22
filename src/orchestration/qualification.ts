import { defaultPolicy, type Policy } from "../policy.ts";
import { ProviderRegistry, type ProviderInstance } from "../platform/providers.ts";
import { providerCapabilities } from "./capabilities.ts";
export const QUALIFICATION_SCENARIOS = [
	[
		"authentication",
		"Use /login with this provider's supported coding-plan method. Do not copy native harness tokens.",
	],
	[
		"model",
		"Select an enumerated model using /model. Record the exact ID and authentication mode.",
	],
	["interactive", "Submit a short read-only question in a disposable repository."],
	[
		"streaming",
		"Observe response activity and completed output; worker partial bodies are deliberately screened.",
	],
	[
		"tools",
		"Delegate a bounded builder change; approve one sandbox test and record its actual exit status.",
	],
	[
		"delegation",
		"Confirm the child uses the explicitly chosen provider/model and isolated branch.",
	],
	[
		"independence",
		"Check separate local session references and that no parent transcript is inherited.",
	],
	[
		"cancellation",
		"Cancel a running disposable task. Verify canceled state, retained worktree, and no running sandbox child.",
	],
	[
		"errors",
		"Observe a real provider error only if it occurs. Do not invalidate credentials to provoke one.",
	],
	[
		"quota",
		"Record a naturally occurring quota failure; never consume quota deliberately or rotate accounts.",
	],
	[
		"interruption",
		"Terminate the disposable Pi host, restart, inspect interrupted work, and explicitly authorize a replacement.",
	],
	[
		"review",
		"Use /implement, select a different authorized reviewer, inspect the exact diff and review, and decline then approve integration.",
	],
	[
		"parallel",
		"Launch two independent bounded tasks. Confirm distinct sessions/worktrees, cancel one, and inspect the other result.",
	],
] as const;
/** Offline planning only. It neither resolves credentials nor instantiates an authenticated model runtime. */
export function qualificationPlan(
	provider: string,
	policy: Policy = defaultPolicy(),
	instances: ProviderInstance[] = [],
) {
	const instance = instances.find((p) => p.id === provider);
	if (!["openai-codex", "kimi-coding", "zai"].includes(provider) && !instance)
		throw new Error(
			"Qualification supports native coding plans or explicitly configured custom instances; subscription runtimes remain blocked",
		);
	const registry = new ProviderRegistry(() => policy);
	if (instance) registry.register(instance);
	return {
		provider,
		mode: "manual-live-plan",
		performed: "No authentication, login, inference, or subscription requests were made.",
		capabilities: instance
			? registry.capabilities(provider)
			: providerCapabilities(provider, policy),
		prerequisites: [
			"Review docs/qualification.md first",
			"Use a disposable clean Git repository",
			"Approve each live operation yourself in Pi",
			"Never record credentials or raw provider errors",
		],
		scenarios: QUALIFICATION_SCENARIOS.map(([id, procedure]) => ({
			id,
			procedure:
				id === "authentication" && instance
					? instance.billing === "local"
						? "Verify the configured loopback endpoint and explicit model list. No subscription credential is used."
						: "Review API billing activation, then use Pi /login for this instance. Never use coding-subscription credentials."
					: procedure,
			outcome: "not-run",
			evidence: "",
		})),
	};
}
