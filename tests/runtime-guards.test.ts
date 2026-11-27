import assert from "node:assert/strict";
import { chmodSync, cpSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { registerHooks, syncBuiltinESMExports } from "node:module";
import childProcess from "node:child_process";
import { test, type TestContext } from "node:test";
import { normalizeContext } from "@earendil-works/pi-ai";
import { AcpSession, GOOGLE_ACP_RUNTIME, officialAcpFactory } from "../src/providers/acp.ts";
import { guardedClaudeStream } from "../src/providers/claude.ts";
import { bootstrap } from "../src/profile.ts";
import { defaultPolicy } from "../src/policy.ts";
import extension from "../src/extension.ts";

function fixture(t: TestContext) {
	const root = mkdtempSync(join(tmpdir(), "poly-runtime-guard-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const original = { ...process.env };
	t.after(() => {
		for (const key of ["GEMINI_API_KEY", "PI_POLY_PROFILE"])
			if (original[key] === undefined) delete process.env[key];
			else process.env[key] = original[key];
	});
	return root;
}

test("Gemini billing refusal happens before spawning the runtime", async (t) => {
	const root = fixture(t);
	const original = childProcess.spawn;
	let spawned = 0;
	childProcess.spawn = (() => {
		spawned++;
		throw new Error("Fixture spawn reached");
	}) as typeof original;
	syncBuiltinESMExports();
	t.after(() => {
		childProcess.spawn = original;
		syncBuiltinESMExports();
	});
	process.env.GEMINI_API_KEY = "fixture-private";
	const runtime = {
		...GOOGLE_ACP_RUNTIME,
		command: () => ({ executable: process.execPath, args: [] }),
	};
	const pending = officialAcpFactory(
		{ enabled: true },
		root,
		runtime,
	)({
		update: () => {},
		permission: async () => ({ outcome: { outcome: "cancelled" } }),
	});
	await assert.rejects(pending, /environment override refused/);
	assert.equal(spawned, 0, "Billing refusal must precede spawn");
});

test("Gemini port rechecks billing variables before every protocol request", async (t) => {
	const root = fixture(t);
	const script = join(root, "agent.mjs");
	cpSync(resolve("tests/fixtures/acp-agent.mjs"), script);
	symlinkSync(resolve("node_modules"), join(root, "node_modules"));
	const port = await officialAcpFactory({ enabled: true }, root, {
		...GOOGLE_ACP_RUNTIME,
		beforeRequest: undefined,
		command: () => ({ executable: process.execPath, args: [script] }),
	})({ update: () => {}, permission: async () => ({ outcome: { outcome: "cancelled" } }) });
	t.after(() => port.close());
	process.env.GEMINI_API_KEY = "fixture-private";
	await assert.rejects(
		port.request("session/new", { cwd: root, mcpServers: [] }),
		/environment override refused/,
	);
	delete process.env.GEMINI_API_KEY;
	assert.equal(
		(await port.request("session/new", { cwd: root, mcpServers: [] })).sessionId,
		"fixture-process",
	);
});

async function registered(t: TestContext, bridge = false) {
	const root = fixture(t);
	bootstrap(root);
	const policy = defaultPolicy();
	policy.google.enabled = true;
	if (bridge) {
		const binary = join(root, "inert-claude");
		writeFileSync(binary, "Never executed");
		chmodSync(binary, 0o755);
		policy.claude = { enabled: true, mode: "bridge", path: binary };
		const hooks = registerHooks({
			resolve(specifier, context, next) {
				if (specifier !== "pi-claude-bridge/src/index.ts") return next(specifier, context);
				return {
					shortCircuit: true,
					url: 'data:text/javascript,export default pi=>pi.registerProvider("claude-bridge",{models:[],streamSimple:()=>{throw new Error("Bridge fixture reached")}})',
				};
			},
		});
		t.after(() => hooks.deregister());
	}
	writeFileSync(join(root, "poly.json"), JSON.stringify(policy));
	process.env.PI_POLY_PROFILE = root;
	const providers = new Map<string, any>();
	const handlers = new Map<string, any[]>();
	await extension({
		registerProvider: (id: any, config: any) =>
			providers.set(typeof id === "string" ? id : id.id, config || id),
		registerCommand: () => {},
		on: (id: string, handler: any) => handlers.set(id, [...(handlers.get(id) || []), handler]),
	} as any);
	return { providers, handlers };
}

test("Gemini stream checks request environment before prompt consumption or discovery", async (t) => {
	const { providers } = await registered(t);
	const provider = providers.get("antigravity-acp");
	assert.throws(
		() =>
			provider.streamSimple(provider.models[0], normalizeContext({ messages: [] }), {
				env: { GEMINI_API_KEY: "fixture-private" },
			}),
		/environment override refused/,
	);
});

test("bridge stream rechecks inherited and request environments before upstream invocation", (t) => {
	fixture(t);
	let calls = 0;
	const stream = guardedClaudeStream(
		() => {
			calls++;
			throw new Error("Upstream fixture reached");
		},
		() => {},
	);
	const previous = process.env.ANTHROPIC_API_KEY;
	t.after(() => {
		if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
		else process.env.ANTHROPIC_API_KEY = previous;
	});
	for (const inherited of [true, false]) {
		if (inherited) process.env.ANTHROPIC_API_KEY = "fixture-private";
		else delete process.env.ANTHROPIC_API_KEY;
		assert.throws(
			() =>
				stream(
					{} as any,
					normalizeContext({ messages: [] }),
					inherited ? undefined : ({ env: { ANTHROPIC_API_KEY: "fixture-private" } } as any),
				),
			/environment override refused/,
		);
	}
	assert.equal(calls, 0);
});

test("ACP prompt params contain exactly the session identifier and typed prompt", async (t) => {
	const root = fixture(t);
	const requests: any[] = [];
	const session = new AcpSession(
		async () => ({
			request: async (method, params) => {
				if (method === "session/prompt") requests.push(params);
				if (method === "session/new")
					return {
						sessionId: "fixture-session",
						modes: {
							currentModeId: "default",
							availableModes: [{ id: "default", name: "Default" }],
						},
						configOptions: [
							{
								id: "model",
								name: "Model",
								category: "model",
								type: "select",
								currentValue: "gemini-fixture",
								options: [{ value: "gemini-fixture", name: "Fixture" }],
							},
						],
					};
				return { stopReason: "end_turn" };
			},
			notify: async () => {},
			close: () => {},
		}),
		root,
		async () => undefined,
	);
	t.after(() => session.close());
	await session.discover();
	await session.prompt("gemini-fixture", "Exact typed prompt", undefined, () => {});
	assert.deepEqual(requests, [
		{ sessionId: "fixture-session", prompt: [{ type: "text", text: "Exact typed prompt" }] },
	]);
});

test("full bridge registration refuses a request without typed input", async (t) => {
	const { providers, handlers } = await registered(t, true);
	const stream = () =>
		providers.get("claude-bridge").streamSimple({}, normalizeContext({ messages: [] }));
	assert.throws(stream, /direct interactive user prompt/);
	handlers.get("input")![0](
		{ source: "interactive", text: "Human turn" },
		{ hasUI: true, mode: "tui", model: { provider: "claude-bridge" } },
	);
	assert.throws(stream, /Bridge fixture reached/);
});
