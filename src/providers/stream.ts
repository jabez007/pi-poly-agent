import {
	createAssistantMessageEventStream,
	type AssistantMessage,
	type Model,
	type Api,
	type SimpleStreamOptions,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { ClaudeAcpError } from "./claude-acp.ts";
import type { AcpSession } from "./acp.ts";

export function acpStream(
	session: AcpSession,
	model: Model<Api>,
	_context: TranscriptContext,
	options: SimpleStreamOptions | undefined,
	prompt: string,
) {
	const stream = createAssistantMessageEventStream();
	const message: AssistantMessage = {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		content: [],
		stopReason: "pending",
		timestamp: Date.now(),
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
	let openIndex: number | undefined;
	const endBlock = () => {
		if (openIndex === undefined) return;
		const block = message.content[openIndex];
		if (block.type === "text")
			stream.push({
				type: "text_end",
				contentIndex: openIndex,
				content: block.text,
				partial: message,
			});
		if (block.type === "thinking")
			stream.push({
				type: "thinking_end",
				contentIndex: openIndex,
				content: block.thinking,
				partial: message,
			});
		openIndex = undefined;
	};
	const add = (text: string, thinking = false) => {
		const kind = thinking ? "thinking" : "text";
		if (openIndex !== undefined && message.content[openIndex].type !== kind) endBlock();
		if (openIndex === undefined) {
			openIndex = message.content.length;
			message.content.push(
				thinking ? { type: "thinking", thinking: "" } : { type: "text", text: "" },
			);
			stream.push({
				type: thinking ? "thinking_start" : "text_start",
				contentIndex: openIndex,
				partial: message,
			});
		}
		const block = message.content[openIndex];
		if (block.type === "thinking") {
			block.thinking += text;
			stream.push({
				type: "thinking_delta",
				contentIndex: openIndex,
				delta: text,
				partial: message,
			});
		}
		if (block.type === "text") {
			block.text += text;
			stream.push({ type: "text_delta", contentIndex: openIndex, delta: text, partial: message });
		}
	};

	stream.push({ type: "start", partial: message });
	void (async () => {
		try {
			// Pi request hooks run for observability. They cannot rewrite the direct human prompt.
			await options?.onPayload?.({ transport: "official-acp", model: model.id }, model);
			const reason = await session.prompt(model.id, prompt, options?.signal, ({ update }) => {
				if (
					(update.sessionUpdate === "agent_message_chunk" ||
						update.sessionUpdate === "agent_thought_chunk") &&
					update.content.type === "text"
				)
					add(update.content.text, update.sessionUpdate === "agent_thought_chunk");
				if (update.sessionUpdate === "tool_call") add(`\n[ACP tool: ${update.title}]\n`);
				if (update.sessionUpdate === "tool_call_update" && update.status)
					add(`\n[ACP tool ${update.status}]\n`);
			});
			if (reason === "cancelled") throw new Error("Cancelled");
			endBlock();
			message.stopReason = reason === "max_tokens" ? "length" : "stop";
			stream.push({ type: "done", reason: message.stopReason, message });
		} catch (error) {
			endBlock();
			message.stopReason = options?.signal?.aborted ? "aborted" : "error";
			message.errorMessage =
				error instanceof ClaudeAcpError
					? error.message
					: "Official ACP request failed or was cancelled. No fallback attempted. See provider setup documentation.";
			stream.push({ type: "error", reason: message.stopReason, error: message });
		} finally {
			stream.end();
		}
	})();
	return stream;
}
