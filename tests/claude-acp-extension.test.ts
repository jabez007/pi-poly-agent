import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { normalizeContext } from "@earendil-works/pi-ai";
import { bootstrap } from "../src/profile.ts";
import { defaultPolicy } from "../src/policy.ts";
import { registerClaudeAcp } from "../src/providers/claude-acp-extension.ts";

async function setup(t: TestContext) {
	const root = mkdtempSync(join(tmpdir(), "claude-acp-extension-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const previous = process.env.CLAUDE_CONFIG_DIR;
	t.after(() => {
		if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
		else process.env.CLAUDE_CONFIG_DIR = previous;
	});
	process.env.CLAUDE_CONFIG_DIR = join(root, "claude");
	mkdirSync(process.env.CLAUDE_CONFIG_DIR);
	const profile = join(root, "profile");
	bootstrap(profile);
	const runtime = join(root, "never-execute");
	writeFileSync(runtime, "fixture");
	const policy = defaultPolicy();
	policy.claude = {
		enabled: true,
		path: runtime,
	};
	writeFileSync(join(profile, "poly.json"), JSON.stringify(policy));
	const commands = new Map<string, any>();
	const handlers = new Map<string, any[]>();
	const providers = new Map<string, any>();
	const requests: { method: string; params: any }[] = [];
	const notices: string[] = [];
	let starts = 0;
	const sessionManager = SessionManager.inMemory(root);
	const pi = {
		registerProvider: (id: string, config: any) => providers.set(id, config),
		registerCommand: (id: string, config: any) => commands.set(id, config),
		appendEntry: (type: string, data: any) => sessionManager.appendCustomEntry(type, data),
		on: (name: string, handler: any) =>
			handlers.set(name, [...(handlers.get(name) || []), handler]),
	} as unknown as ExtensionAPI;
	const ctx: any = {
		cwd: root,
		hasUI: true,
		mode: "tui",
		model: { provider: "claude-acp" },
		sessionManager,
		ui: {
			confirm: async () => true,
			select: async () => "plan",
			notify: (message: string) => notices.push(message),
		},
	};
	registerClaudeAcp(pi, profile, async () => {
		starts++;
		return {
			supportsLoad: true,
			request: async (method, params) => {
				requests.push({ method, params });
				if (method === "session/new" || method === "session/load")
					return {
						sessionId: "claude-mock",
						modes: {
							currentModeId: "default",
							availableModes: ["default", "plan", "acceptEdits"].map((id) => ({ id, name: id })),
						},
						configOptions: [
							{
								id: "model",
								name: "Model",
								category: "model",
								type: "select",
								currentValue: "claude-fixture",
								options: [{ value: "claude-fixture", name: "Claude fixture" }],
							},
						],
					};
				return { stopReason: "end_turn" };
			},
			notify: async () => {},
			close: () => {},
		};
	});
	for (const handler of handlers.get("session_start") || []) await handler({}, ctx);
	return {
		root,
		profile,
		policy,
		pi,
		commands,
		handlers,
		providers,
		requests,
		notices,
		ctx,
		starts: () => starts,
	};
}

test("Claude ACP registration starts nothing and discovery requires live confirmation", async (t) => {
	const f = await setup(t);
	assert.equal(f.starts(), 0);
	assert.equal(f.providers.get("claude-acp").models[0].id, "activation-required");
	f.ctx.ui.confirm = async () => false;
	await f.commands.get("poly-claude-discover").handler("", f.ctx);
	assert.equal(f.starts(), 0);
	f.ctx.ui.confirm = async () => true;
	await f.commands.get("poly-claude-discover").handler("", f.ctx);
	assert.equal(f.starts(), 1);
	assert.equal(f.providers.get("claude-acp").models[0].id, "claude-fixture");
});
test("Claude ACP rejects generated, RPC, queued and automatic handoff prompts and consumes direct input once", async (t) => {
	const f = await setup(t);
	await f.commands.get("poly-claude-discover").handler("", f.ctx);
	const provider = f.providers.get("claude-acp");
	const model = { ...provider.models[0], provider: "claude-acp", api: "claude-acp" };
	const input = f.handlers.get("input")![0];
	const stream = () => provider.streamSimple(model, normalizeContext({ messages: [] }));
	for (const source of ["extension", "rpc"]) {
		assert.equal(input({ source, text: "Generated handoff" }, f.ctx).action, "handled");
		assert.throws(stream, /direct interactive/);
	}
	assert.equal(
		input({ source: "interactive", text: "Queued", streamingBehavior: "steer" }, f.ctx).action,
		"handled",
	);
	input({ source: "interactive", text: "Human prompt" }, f.ctx);
	assert.equal((await stream().result()).stopReason, "stop");
	assert.throws(stream, /direct interactive/);
	assert.deepEqual(f.requests.find((r) => r.method === "session/prompt")!.params.prompt, [
		{ type: "text", text: "Human prompt" },
	]);
});
test("Claude ACP command restores its own binding only after confirmation and mode selection stays explicit", async (t) => {
	const f = await setup(t);
	await f.commands.get("poly-claude-discover").handler("", f.ctx);
	await f.commands.get("poly-claude-mode").handler("plan", f.ctx);
	assert.equal(f.requests.at(-1)!.params.modeId, "plan");
	await f.commands.get("poly-claude-mode").handler("auto", f.ctx);
	assert.match(f.notices.at(-1)!, /offered mode/);
	for (const handler of f.handlers.get("session_start") || []) await handler({}, f.ctx);
	await f.commands.get("poly-claude-discover").handler("", f.ctx);
	assert.ok(f.requests.some((r) => r.method === "session/load"));
});
