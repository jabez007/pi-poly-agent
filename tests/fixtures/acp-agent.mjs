#!/usr/bin/env node
import { Readable, Writable } from "node:stream";
import process from "node:process";
import { agent, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";

// Protocol fixture only. No provider runtime, account, or network connection.
const app = agent({ name: "fixture" })
	.onRequest("initialize", ({ params }) => {
		if (params.clientInfo.name !== "pi-poly-agent") throw new Error("Unexpected client identity");
		return {
			protocolVersion: PROTOCOL_VERSION,
			agentCapabilities: {},
			agentInfo: { name: "fixture", version: "0.0.0" },
			authMethods: [{ id: "oauth-personal", name: "Fixture native auth" }],
		};
	})
	.onRequest("session/new", () => ({
		sessionId: "fixture-process",
		modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Ask" }] },
		configOptions: [
			{
				id: "model",
				name: "Model",
				category: "model",
				type: "select",
				currentValue: "gemini-fixture-process",
				options: [{ value: "gemini-fixture-process", name: "Gemini fixture process" }],
			},
		],
	}))
	.onRequest("session/set_mode", ({ params }) => {
		if (params.modeId !== "default") throw new Error("Prompting mode required");
		return {};
	})
	.onRequest("session/set_config_option", () => ({ configOptions: [] }))
	.onRequest("session/prompt", async ({ params, client }) => {
		const permission = await client.request("session/request_permission", {
			sessionId: params.sessionId,
			toolCall: {
				toolCallId: "fixture-tool",
				title: "Fixture permission",
				kind: "read",
				rawInput: { path: "/tmp/fixture" },
			},
			options: [{ optionId: "fixture-once", kind: "allow_once", name: "Allow once" }],
		});
		if (permission.outcome.outcome !== "selected") return { stopReason: "cancelled" };
		await client.notify("session/update", {
			sessionId: params.sessionId,
			update: {
				sessionUpdate: "agent_message_chunk",
				content: { type: "text", text: "ACP subprocess fixture succeeded" },
			},
		});
		return { stopReason: "end_turn" };
	});

process.stdin.resume();
const connection = app.connect(
	ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)),
);
await connection.closed;
