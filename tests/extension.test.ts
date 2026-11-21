import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { normalizeContext } from "@earendil-works/pi-ai";
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../src/extension.ts";
import { bootstrap } from "../src/profile.ts";
import { defaultPolicy, POLICY_REVISION, conflictingEnvironment } from "../src/policy.ts";
import type { AcpHandlers } from "../src/providers/acp.ts";

test("Pi registration, picker discovery, one-shot Google input gate, and approvals", async () => {
	const root = mkdtempSync(join(tmpdir(), "poly-extension-"));
	bootstrap(root);
	const runtime = join(root, "agy-fixture");
	writeFileSync(runtime, "fixture, never execute");
	const policy = defaultPolicy();
	policy.google = {
		enabled: true,
		review: POLICY_REVISION,
		runtime,
		sha256: createHash("sha256").update("fixture, never execute").digest("hex"),
	};
	writeFileSync(join(root, "poly.json"), JSON.stringify(policy));
	const savedEnv = { ...process.env };
	for (const key of conflictingEnvironment(process.env)) delete process.env[key];
	const previous = process.env.PI_POLY_PROFILE;
	process.env.PI_POLY_PROFILE = root;
	const handlers = new Map<string, any[]>();
	const commands = new Map<string, any>();
	const providers = new Map<string, any>();
	const notifications: string[] = [];
	const pi = {
		on: (name: string, handler: any) => {
			handlers.set(name, [...(handlers.get(name) || []), handler]);
		},
		registerCommand: (name: string, config: any) => commands.set(name, config),
		registerProvider: (name: any, config: any) =>
			providers.set(typeof name === "string" ? name : name.id, config || name),
	} as unknown as ExtensionAPI;
	const session = SessionManager.inMemory(root);
	const context: any = {
		cwd: root,
		mode: "tui",
		hasUI: true,
		model: { provider: "antigravity-acp" },
		sessionManager: session,
		ui: {
			notify: (text: string) => notifications.push(text),
			setStatus: () => {},
			confirm: async () => true,
			select: async () => undefined,
		},
	};
	const requests: string[] = [];
	let callbacks: AcpHandlers;
	try {
		await extension(pi, async (h) => {
			callbacks = h;
			return {
				request: async (method: string) => {
					requests.push(method);
					if (method === "session/new")
						return {
							sessionId: "acp-fixture",
							modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Ask" }] },
							configOptions: [
								{
									id: "model",
									category: "model",
									type: "select",
									name: "Model",
									currentValue: "gemini-fixture",
									options: [{ value: "gemini-fixture", name: "Gemini fixture" }],
								},
							],
						};
					if (method === "session/prompt") {
						callbacks.update({
							sessionId: "acp-fixture",
							update: {
								sessionUpdate: "agent_message_chunk",
								content: { type: "text", text: "Mock Gemini" },
							},
						});
						return { stopReason: "end_turn" };
					}
					return {};
				},
				notify: async () => {},
				close: () => {},
			};
		});
		assert.ok(providers.get("claude-bridge").models.length > 0);
		assert.ok(
			providers.has("openai-codex") && providers.has("kimi-coding") && providers.has("zai"),
		);
		assert.equal(providers.get("google").getModels().length, 0);
		assert.equal(providers.get("google").auth.oauth, undefined);
		assert.equal(providers.get("kimi-coding").auth.apiKey, undefined);
		for (const h of handlers.get("session_start") || []) await h({}, context);
		assert.equal(requests.length, 0, "startup never initializes Google");
		await commands.get("poly-google-discover").handler("", context);
		const provider = providers.get("antigravity-acp");
		assert.equal(provider.models[0].id, "gemini-fixture");
		const model = { ...provider.models[0], api: "antigravity-acp", provider: "antigravity-acp" };
		const stream = () => provider.streamSimple(model, normalizeContext({ messages: [] }));
		const input = handlers.get("input")![0];
		assert.equal(input({ source: "rpc", text: "Delegated prompt" }, context).action, "handled");
		assert.throws(stream, /direct interactive/);
		input({ source: "interactive", text: "Human task" }, context);
		assert.equal((await stream().result()).stopReason, "stop");
		assert.throws(
			stream,
			/direct interactive/,
			"automatic continuation lacks a new user capability",
		);
		context.hasUI = false;
		const result = await handlers.get("tool_call")![0]({ toolName: "write" }, context);
		assert.equal(result.block, true);
		assert.ok(notifications.some((n) => n.includes("direct interactive")));
	} finally {
		for (const key of conflictingEnvironment(savedEnv)) process.env[key] = savedEnv[key];
		if (previous === undefined) delete process.env.PI_POLY_PROFILE;
		else process.env.PI_POLY_PROFILE = previous;
	}
});
