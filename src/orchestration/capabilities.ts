import {
	ACP_PROVIDER,
	BRIDGE_PROVIDER,
	CLAUDE_ACP_PROVIDER,
	assertRequest,
	type Policy,
} from "../policy.ts";

export interface Capabilities {
	direct: boolean;
	delegation: boolean;
	background: boolean;
	concurrent: boolean;
	streaming: boolean;
	cancellation: boolean;
	persistentSessions: boolean;
	tools: boolean;
	readOnly: boolean;
	editing: boolean;
	nativeSubagents: boolean;
	handoffs: boolean;
	billing: "subscription" | "coding-plan" | "locked" | "api" | "local";
}

export function providerCapabilities(provider: string, policy: Policy): Capabilities {
	const native = ["openai-codex", "kimi-coding", "zai"].includes(provider);
	let allowed = false;
	try {
		assertRequest(provider, policy, true);
		allowed = true;
	} catch {
		/* Locked capability. */
	}
	return {
		direct: allowed,
		delegation: allowed && native,
		background: allowed && native,
		concurrent: allowed && native,
		streaming: true,
		cancellation: true,
		persistentSessions: native,
		tools: true,
		readOnly: native,
		editing: native,
		nativeSubagents: false,
		handoffs: true,
		billing: !allowed
			? "locked"
			: provider === "zai" || (provider === "kimi-coding" && policy.kimiApiKey)
				? "coding-plan"
				: "subscription",
	};
}

export function assertDelegation(provider: string, policy: Policy, depth: number): void {
	if (depth !== 1) throw new Error("Delegation depth is limited to one");
	const capabilities = providerCapabilities(provider, policy);
	if (!capabilities.delegation || !capabilities.background || !capabilities.concurrent)
		throw new Error("Provider is not authorized for delegated execution");
}
export const MANAGED_PROVIDERS = [
	"openai-codex",
	"kimi-coding",
	"zai",
	BRIDGE_PROVIDER,
	CLAUDE_ACP_PROVIDER,
	ACP_PROVIDER,
];
