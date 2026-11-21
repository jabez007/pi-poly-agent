import { safeFailure } from "./errors.ts";
import {
	createAssistantMessageEventStream,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Provider,
} from "@earendil-works/pi-ai";
import { assertNoSecrets } from "../memory.ts";

/** Never persist raw provider errors or partial credentials in child Pi histories. */
function protectedStream(
	source: () => AssistantMessageEventStream,
	model: any,
	progress: () => void,
): AssistantMessageEventStream {
	const output = createAssistantMessageEventStream();
	void (async () => {
		try {
			for await (const event of source()) {
				progress();
				// Pi receives the completed message. UI progress exposes activity, not provider bodies.
				if (event.type === "done") {
					assertNoSecrets(event.message);
					output.push({ type: "start", partial: event.message });
					output.push(event);
				}
				if (event.type === "error") throw safeFailure(event.error.errorMessage);
			}
		} catch (failure) {
			const error: AssistantMessage = {
				role: "assistant",
				content: [],
				api: model.api,
				provider: model.provider,
				model: model.id,
				timestamp: Date.now(),
				stopReason: "error",
				errorMessage: safeFailure(failure).message,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			};
			output.push({ type: "error", reason: "error", error });
		} finally {
			output.end();
		}
	})();
	return output;
}
export function protectedWorkerProvider(provider: Provider, progress: () => void): Provider {
	return {
		...provider,
		stream: (...args) => protectedStream(() => provider.stream(...args), args[0], progress),
		streamSimple: (...args) =>
			protectedStream(() => provider.streamSimple(...args), args[0], progress),
	};
}
