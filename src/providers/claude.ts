import { join } from "node:path";
import { existsSync, writeFileSync } from "node:fs";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import { BRIDGE_PROVIDER, assertInvocationEnvironment, type Activation } from "../policy.ts";
import { runtimePath, readConfiguration, assertSafeProfile } from "../profile.ts";
import { CLAUDE_LOGIN_MESSAGE } from "./claude-acp.ts";

export async function registerClaudeBridge(
	pi: ExtensionAPI,
	profile: string,
	activation: Activation,
	check: () => void,
): Promise<void> {
	// Loading the bridge registers native lifecycle hooks, so opt-in precedes its import.
	if (!activation.enabled) {
		pi.registerProvider(BRIDGE_PROVIDER, {
			baseUrl: "locked://claude-sdk",
			apiKey: "runtime-owned",
			api: BRIDGE_PROVIDER,
			models: builtinProviders()
				.find((p) => p.id === "anthropic")!
				.getModels()
				.map((m) => ({ ...m, name: `${m.name} [off]` })),
			streamSimple: () => {
				check();
				throw new Error("Claude bridge is off or unselected in poly.json");
			},
		});
		return;
	}
	assertInvocationEnvironment(BRIDGE_PROVIDER);
	prepareBridgeConfiguration(profile, activation);
	const bridgePath: string = "pi-claude-bridge/src/index.ts";
	const upstream = await import(bridgePath);
	const facade = Object.create(pi) as ExtensionAPI;
	facade.registerProvider = ((id: string, config: ProviderConfig) => {
		pi.registerProvider(id, {
			...config,
			streamSimple: guardedClaudeStream(config.streamSimple!, check),
		});
	}) as ExtensionAPI["registerProvider"];
	upstream.default(facade);
}

/** Upstream requires its executable path in this file; only billing choices remain user policy. */
function prepareBridgeConfiguration(profile: string, activation: Activation): void {
	const file = join(profile, "claude-bridge.json");
	assertSafeProfile(file);
	const previous = existsSync(file)
		? (readConfiguration(file) as { provider?: Record<string, unknown> })
		: {};
	const billing = previous.provider || {};
	const plan = billing.plan ?? "pro";
	const longContextExtraUsage = billing.longContextExtraUsage ?? false;
	if (!["pro", "max"].includes(plan as string) || typeof longContextExtraUsage !== "boolean")
		throw new Error(
			"Claude bridge billing settings require plan pro/max and boolean longContextExtraUsage",
		);
	const provider = {
		plan,
		longContextExtraUsage,
		pathToClaudeCodeExecutable: runtimePath(activation, "claude"),
	};
	const text = JSON.stringify({ provider }, null, 2) + "\n";
	if (JSON.stringify(previous) !== JSON.stringify({ provider }))
		writeFileSync(file, text, { mode: 0o600 });
}

export function guardedClaudeStream(
	stream: NonNullable<ProviderConfig["streamSimple"]>,
	check: () => void,
): NonNullable<ProviderConfig["streamSimple"]> {
	return (...args) => {
		check();
		assertInvocationEnvironment(BRIDGE_PROVIDER, args[2]);
		const source = stream(...args);
		const output = createAssistantMessageEventStream();
		void (async () => {
			try {
				for await (const event of source) {
					if (
						event.type === "error" &&
						/not logged|unauthenticated|authentication required|login required/i.test(
							event.error.errorMessage || "",
						)
					)
						event.error.errorMessage = CLAUDE_LOGIN_MESSAGE;
					output.push(event);
				}
			} catch {
				output.push({ type: "error", reason: "error", error: bridgeFailure(args[0]) });
			} finally {
				output.end();
			}
		})();
		return output;
	};
}

function bridgeFailure(model: Parameters<NonNullable<ProviderConfig["streamSimple"]>>[0]) {
	return {
		role: "assistant" as const,
		api: model.api,
		provider: model.provider,
		model: model.id,
		content: [],
		stopReason: "error" as const,
		timestamp: Date.now(),
		errorMessage: "Claude Code bridge request failed; no fallback attempted.",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}
