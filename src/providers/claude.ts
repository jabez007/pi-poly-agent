import { join } from "node:path";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import { BRIDGE_PROVIDER, assertInvocationEnvironment, type Activation } from "../policy.ts";
import { attestRuntime, readConfiguration } from "../profile.ts";

export async function registerClaudeBridge(
	pi: ExtensionAPI,
	profile: string,
	activation: Activation,
	check: () => void,
): Promise<void> {
	// Lifecycle hooks in the upstream module may query the SDK. Never load it while locked.
	if (!activation.enabled) {
		pi.registerProvider(BRIDGE_PROVIDER, {
			baseUrl: "locked://claude-sdk",
			apiKey: "runtime-owned",
			api: "claude-bridge",
			models: builtinProviders()
				.find((provider) => provider.id === "anthropic")!
				.getModels()
				.map((model) => ({ ...model, name: `${model.name} [locked]` })),
			streamSimple: () => {
				throw new Error("Claude SDK is locked pending authorization review and activation");
			},
		});
		return;
	}
	const runtime = attestRuntime(activation);
	const settings = readConfiguration(join(profile, "claude-bridge.json")) as {
		provider?: Record<string, unknown>;
	};
	const expected = {
		pathToClaudeCodeExecutable: runtime,
		longContextExtraUsage: false,
		strictMcpConfig: true,
		autoMemoryEnabled: false,
	};
	if (!Object.entries(expected).every(([key, value]) => settings.provider?.[key] === value)) {
		throw new Error(
			"Claude bridge requires the reviewed runtime, strict MCP, and no extra usage or separate auto-memory",
		);
	}
	const bridgePath: string = "pi-claude-bridge/src/index.ts";
	const upstream = await import(bridgePath);
	const facade = Object.create(pi) as ExtensionAPI;
	facade.registerProvider = ((id: string, config: ProviderConfig) => {
		const stream = config.streamSimple!;
		pi.registerProvider(id, {
			...config,
			streamSimple: guardedClaudeStream(stream, check),
		});
	}) as ExtensionAPI["registerProvider"];
	upstream.default(facade);
}

export function guardedClaudeStream(
	stream: NonNullable<ProviderConfig["streamSimple"]>,
	check: () => void,
): NonNullable<ProviderConfig["streamSimple"]> {
	return (...args) => {
		check();
		assertInvocationEnvironment(args[2]);
		return stream(...args);
	};
}
