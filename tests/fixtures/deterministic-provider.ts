import { createAssistantMessageEventStream, type Provider } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";

/** A transport fixture only. Pi still owns sessions, the agent loop and tool execution. */
export function deterministicProvider(
	id: string,
	respond: (context: any) => any[],
	observe: (options: any) => void = () => {},
): Provider {
	const base = builtinProviders().find((p) => p.id === id)!;
	const model = { ...base.getModels()[0], id: "fixture", provider: id };
	const stream = (_model: any, context: any, options: any) => {
		observe(options);
		const events = createAssistantMessageEventStream();
		setImmediate(() => {
			const content = respond(context);
			const message: any = {
				role: "assistant",
				content,
				provider: id,
				model: "fixture",
				api: model.api,
				timestamp: 0,
				stopReason: content.some((c) => c.type === "toolCall") ? "toolUse" : "stop",
				usage: {
					input: 0,
					output: 0,
					totalTokens: 0,
					cacheRead: 0,
					cacheWrite: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			};
			events.push({ type: "done", reason: message.stopReason, message });
			events.end();
		});
		return events;
	};
	return {
		...base,
		auth: {
			apiKey: {
				name: "Offline fixture",
				check: async () => ({ type: "api_key", source: "fixture" }),
				resolve: async () => ({ auth: { apiKey: "fixture-no-network" } }),
			} as any,
		},
		getModels: () => [model],
		getAllModels: () => [model],
		stream: stream as any,
		streamSimple: stream as any,
	};
}
