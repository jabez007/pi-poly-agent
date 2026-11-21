import { normalizeContext } from "@earendil-works/pi-ai";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { NewSessionResponse } from "@agentclientprotocol/sdk";
import {
	AcpSession,
	discoveredModels,
	permissionDecision,
	type AcpHandlers,
	type AcpPort,
} from "../src/providers/acp.ts";
import { acpStream } from "../src/providers/stream.ts";

const response: NewSessionResponse = {
	sessionId: "fixture-acp-session",
	modes: {
		currentModeId: "yolo",
		availableModes: [
			{ id: "default", name: "Ask" },
			{ id: "yolo", name: "No approvals" },
		],
	},
	configOptions: [
		{
			id: "model",
			name: "Model",
			category: "model",
			type: "select",
			currentValue: "gemini-fixture",
			options: [
				{ value: "gemini-fixture", name: "Gemini fixture" },
				{ value: "other-model", name: "Other" },
			],
		},
	],
};

function fixture() {
	let handlers: AcpHandlers;
	const calls: { method: string; params: any }[] = [];
	let closed = false;
	const port: AcpPort = {
		request: async (method, params) => {
			calls.push({ method, params });
			if (method === "session/new") return response;
			if (method === "session/prompt") {
				handlers.update({
					sessionId: response.sessionId,
					update: {
						sessionUpdate: "agent_message_chunk",
						content: { type: "text", text: "Fixture response" },
					},
				});
				handlers.update({
					sessionId: response.sessionId,
					update: {
						sessionUpdate: "agent_message_chunk",
						content: { type: "text", text: " continued" },
					},
				});
				return { stopReason: "end_turn" };
			}
			return {};
		},
		notify: async (method, params) => {
			calls.push({ method, params });
		},
		close: () => {
			closed = true;
		},
	};
	const session = new AcpSession(
		async (h) => {
			handlers = h;
			return port;
		},
		"/tmp",
		async () => undefined,
	);
	return {
		session,
		calls,
		port,
		get closed() {
			return closed;
		},
	};
}

test("model discovery selects official ACP and forces prompting mode", async () => {
	const f = fixture();
	assert.deepEqual(await f.session.discover(), [
		{ id: "gemini-fixture", name: "Gemini fixture", configId: "model" },
	]);
	assert.deepEqual(
		f.calls.map((c) => c.method),
		["session/new", "session/set_mode"],
	);
	assert.equal(f.calls[1].params.modeId, "default");
	await f.session.discover();
	assert.equal(f.calls.length, 2);
	f.session.close();
	await f.session.discover();
	assert.equal(f.calls.length, 4);
});

test("mock ACP streams through Pi without forwarding private transcript or system prompts", async () => {
	const f = fixture();
	const model = {
		id: "gemini-fixture",
		name: "Fixture",
		provider: "antigravity-acp",
		api: "antigravity-acp",
		baseUrl: "acp://official-runtime",
		reasoning: true,
		input: ["text"] as ["text"],
		contextWindow: 128000,
		maxTokens: 32000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
	await f.session.discover();
	const stream = acpStream(
		f.session,
		model,
		normalizeContext({ messages: [] }),
		undefined,
		"User's direct prompt",
	);
	const events = [];
	for await (const event of stream) events.push(event.type);
	assert.ok(events.includes("text_delta"));
	assert.equal((await stream.result()).stopReason, "stop");
	assert.deepEqual((await stream.result()).content, [
		{ type: "text", text: "Fixture response continued" },
	]);
	const sent = f.calls.find((c) => c.method === "session/prompt")!.params;
	assert.deepEqual(sent.prompt, [{ type: "text", text: "User's direct prompt" }]);
});

test("permission cancellation, unavailable UI, and unknown options fail closed", async () => {
	const request = {
		sessionId: "s",
		toolCall: {
			toolCallId: "t",
			title: "Write file",
			kind: "edit" as const,
			rawInput: { path: "/tmp/file", content: "fixture" },
		},
		options: [
			{ optionId: "one", name: "Allow once", kind: "allow_once" as const },
			{ optionId: "all", name: "Always", kind: "allow_always" as const },
		],
	};
	assert.deepEqual(
		await permissionDecision(request, async (_title, options) => {
			assert.equal(options.length, 1);
			return options[0];
		}),
		{ outcome: { outcome: "selected", optionId: "one" } },
	);
	for (const choose of [
		async () => undefined,
		async () => "unknown",
		async () => {
			throw new Error("UI unavailable");
		},
	])
		assert.deepEqual(await permissionDecision(request, choose), {
			outcome: { outcome: "cancelled" },
		});
});

test("cancellation reaches official ACP and provider initialization failure does not fall back", async () => {
	const f = fixture();
	const controller = new AbortController();
	await f.session.discover();
	const original = f.port.request;
	f.port.request = async (method, params, options) => {
		if (method !== "session/prompt") return original(method, params, options);
		controller.abort();
		throw new Error("fixture cancellation");
	};
	await assert.rejects(f.session.prompt("gemini-fixture", "hello", controller.signal, () => {}));
	assert.ok(f.calls.some((c) => c.method === "session/cancel"));
	assert.equal(f.closed, true);
	const failed = new AcpSession(
		async () => {
			throw new Error("fixture secret");
		},
		"/tmp",
		async () => undefined,
	);
	await assert.rejects(failed.discover(), (e: Error) => !e.message.includes("fixture secret"));
	assert.deepEqual(discoveredModels({ sessionId: "empty" }), []);
});
