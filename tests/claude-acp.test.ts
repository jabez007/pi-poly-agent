import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	AcpSession,
	officialAcpFactory,
	type AcpHandlers,
	type AcpPort,
} from "../src/providers/acp.ts";
import { CLAUDE_ACP_RUNTIME, CLAUDE_LOGIN_MESSAGE } from "../src/providers/claude-acp.ts";

function response(mode = "default") {
	return {
		sessionId: "claude-fixture",
		modes: {
			currentModeId: mode,
			availableModes: [
				"default",
				"plan",
				"acceptEdits",
				"bypassPermissions",
				"dontAsk",
				"auto",
			].map((id) => ({ id, name: id })),
		},
		configOptions: [
			{
				id: "model",
				name: "Model",
				category: "model" as const,
				type: "select" as const,
				currentValue: "claude-fixture",
				options: [{ value: "claude-fixture", name: "Claude fixture" }],
			},
		],
	};
}
function fixture() {
	const calls: { method: string; params: any }[] = [];
	let handlers: AcpHandlers;
	const port: AcpPort = {
		supportsLoad: true,
		request: async (method, params) => {
			calls.push({ method, params });
			if (method === "session/new" || method === "session/load") return response();
			if (method === "auth/status")
				return {
					state: "authenticated",
					accounts: [{ _meta: { claudeCode: { kind: "account" } } }],
				};
			if (method === "session/prompt") {
				const decision = await handlers.permission({
					sessionId: "claude-fixture",
					toolCall: {
						toolCallId: "t",
						title: "Edit source",
						kind: "edit",
						rawInput: { path: "source.ts", content: "proposal" },
					},
					options: [
						{ kind: "allow_once", optionId: "once", name: "Allow once" },
						{ kind: "reject_once", optionId: "deny", name: "Deny once" },
						{ kind: "allow_always", optionId: "always", name: "Always" },
					],
				});
				calls.push({ method: "permission-response", params: decision });
				return { stopReason: "end_turn" };
			}
			return {};
		},
		notify: async (method, params) => {
			calls.push({ method, params });
		},
		close: () => {},
	};
	const session = new AcpSession(
		async (h) => {
			handlers = h;
			return port;
		},
		"/fixture",
		async (title, choices) => {
			assert.match(title, /source.ts/);
			assert.equal(choices.length, 2);
			return choices[1];
		},
		undefined,
		CLAUDE_ACP_RUNTIME,
	);
	return { calls, port, session };
}

test("Claude ACP discovers native models, starts default mode, and sends no tool or prompt overrides", async () => {
	const f = fixture();
	assert.equal((await f.session.discover())[0].id, "claude-fixture");
	assert.deepEqual(f.calls[0], {
		method: "session/new",
		params: { cwd: "/fixture", mcpServers: [] },
	});
	assert.equal(f.calls[1].params.modeId, "default");
});
test("Claude ACP accepts advertised plan and acceptEdits but refuses bypass, dontAsk and auto", async () => {
	const f = fixture();
	await f.session.discover();
	for (const mode of ["bypassPermissions", "dontAsk", "auto", "missing"])
		await assert.rejects(f.session.selectMode(mode), /forbidden/);
	for (const mode of ["plan", "acceptEdits", "default"]) await f.session.selectMode(mode);
	assert.deepEqual(
		f.calls.filter((c) => c.method === "session/set_mode").map((c) => c.params.modeId),
		["default", "plan", "acceptEdits", "default"],
	);
});
test("Claude ACP refuses a runtime session that starts in an unsafe mode", async () => {
	const f = fixture();
	f.port.request = async () => response("auto");
	await assert.rejects(f.session.discover(), /did not start in default/);
});
test("Claude ACP sends contextual single-use denial back to its native tool", async () => {
	const f = fixture();
	await f.session.discover();
	await f.session.prompt("claude-fixture", "Human task", undefined, () => {});
	assert.deepEqual(f.calls.find((c) => c.method === "permission-response")!.params, {
		outcome: { outcome: "selected", optionId: "deny" },
	});
});
test("Claude ACP login queries native status and rejects client-auth and provider-routing methods", async () => {
	const calls: string[] = [];
	await CLAUDE_ACP_RUNTIME.login(
		{ authMethods: [], agentCapabilities: { auth: { status: {} }, providers: {} } },
		async (method) => {
			calls.push(method);
			return { state: "authenticated", accounts: [{ _meta: { claudeCode: { kind: "account" } } }] };
		},
	);
	assert.deepEqual(calls, ["auth/status"]);
	for (const method of ["gateway", "gateway-bedrock", "console-login", "claude-ai-login"])
		await assert.rejects(
			CLAUDE_ACP_RUNTIME.login(
				{ authMethods: [{ id: method }], agentCapabilities: {} },
				async () => {
					throw new Error("must not authenticate");
				},
			),
			/without client authentication/,
		);
	for (const method of ["authenticate", "providers/list", "providers/set", "providers/disable"])
		await assert.rejects(
			CLAUDE_ACP_RUNTIME.beforeRequest!(
				method,
				"/fixture",
				async () => {
					throw new Error("must not route");
				},
				{},
			),
			/outside the reviewed/,
		);
});
test("Claude ACP reports missing login with fixed native-login guidance and refuses other billing modes", async () => {
	const initialized = { authMethods: [], agentCapabilities: { auth: { status: {} } } };
	await assert.rejects(
		CLAUDE_ACP_RUNTIME.login(initialized, async () => ({ state: "unauthenticated" })),
		{ message: CLAUDE_LOGIN_MESSAGE },
	);
	for (const kind of ["api_key", "gateway", "external", "none"])
		await assert.rejects(
			CLAUDE_ACP_RUNTIME.login(initialized, async () => ({
				state: "authenticated",
				accounts: [{ _meta: { claudeCode: { kind } } }],
			})),
			/verified native subscription/,
		);
	const f = fixture();
	f.port.request = async () => {
		throw { code: -32000, message: "sensitive runtime diagnostic" };
	};
	await assert.rejects(f.session.discover(), { message: CLAUDE_LOGIN_MESSAGE });
	const restored = new AcpSession(
		async () => f.port,
		"/fixture",
		async () => undefined,
		{ saved: { sessionId: "saved", cwd: "/fixture" }, save: () => {}, report: () => {} },
		CLAUDE_ACP_RUNTIME,
	);
	await assert.rejects(restored.discover(), { message: CLAUDE_LOGIN_MESSAGE });
	const active = fixture();
	await active.session.discover();
	active.port.request = async () => {
		throw { code: -32000, message: "sensitive runtime diagnostic" };
	};
	await assert.rejects(active.session.selectMode("plan"), { message: CLAUDE_LOGIN_MESSAGE });
});
test("Claude ACP preserves explicit restoration and requires discovery new after unavailable load", async () => {
	const f = fixture();
	const reports: string[] = [];
	const session = new AcpSession(
		async () => ({ ...f.port, supportsLoad: false }),
		"/fixture",
		async () => undefined,
		{
			saved: { sessionId: "saved", cwd: "/fixture" },
			save: () => {},
			report: (text) => reports.push(text),
		},
		CLAUDE_ACP_RUNTIME,
	);
	await assert.rejects(session.discover());
	assert.match(reports[0], /poly-claude-discover new/);
	assert.equal(f.calls.length, 0);
	await session.discover(true);
	assert.equal(f.calls[0].method, "session/new");
});
test("Claude ACP startup pins the reviewed native executable and refuses changed checksums and settings", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "claude-acp-start-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const env = { ...process.env };
	t.after(() => {
		process.env = env;
	});
	process.env.CLAUDE_CONFIG_DIR = join(root, "native");
	mkdirSync(process.env.CLAUDE_CONFIG_DIR);
	const settings = join(process.env.CLAUDE_CONFIG_DIR, "settings.json");
	writeFileSync(settings, JSON.stringify({ permissions: { defaultMode: "default" } }));
	const runtime = join(root, "claude-never-execute");
	writeFileSync(runtime, "never execute fixture");
	const activation = {
		enabled: true,
		review: "2026-11-25.1",
		runtime,
		sha256: createHash("sha256").update("never execute fixture").digest("hex"),
	};
	const command = await CLAUDE_ACP_RUNTIME.command(activation, root);
	assert.equal(command.env!.CLAUDE_CODE_EXECUTABLE, realpathSync(runtime));
	assert.match(command.args[0], /claude-agent-acp\/dist\/index.js$/);
	assert.equal(command.env!.CLAUDE_AGENT_ACP_PROTOCOL, "v1");
	await assert.rejects(
		() => CLAUDE_ACP_RUNTIME.command({ ...activation, sha256: "0".repeat(64) }, root),
		/checksum/,
	);
	for (const key of [
		"ANTHROPIC_API_KEY",
		"ANTHROPIC_AUTH_TOKEN",
		"ANTHROPIC_BASE_URL",
		"CLAUDE_CODE_EXECUTABLE",
		"CLAUDE_AGENT_LOGS",
	]) {
		process.env[key] = "unreviewed";
		await assert.rejects(
			() => CLAUDE_ACP_RUNTIME.command(activation, root),
			/override|Conflicting/,
		);
		delete process.env[key];
	}
	mkdirSync(join(root, ".claude"));
	writeFileSync(join(root, ".claude/settings.json"), JSON.stringify({ apiKeyHelper: "never-run" }));
	await assert.rejects(
		() => CLAUDE_ACP_RUNTIME.command(activation, root),
		/authentication or policy helper override/,
	);
	writeFileSync(
		join(root, ".claude/settings.json"),
		JSON.stringify({ permissions: { defaultMode: "auto" } }),
	);
	await assert.rejects(() => CLAUDE_ACP_RUNTIME.command(activation, root), /defaultMode/);
	writeFileSync(join(root, ".claude/settings.json"), "{}");
	for (const key of ["ANTHROPIC_API_KEY", "CLAUDE_CODE_EXECUTABLE", "CLAUDE_CONFIG_DIR", "HOME"]) {
		writeFileSync(
			settings,
			JSON.stringify({ permissions: { defaultMode: "default" }, env: { [key]: "" } }),
		);
		await assert.rejects(
			async () => CLAUDE_ACP_RUNTIME.command(activation, root),
			/environment overrides/,
		);
	}
	for (const key of ["proxyAuthHelper", "gcpAuthRefresh", "processWrapper", "policyHelper"]) {
		const value =
			key === "policyHelper"
				? { path: join(root, "never-execute-helper") }
				: "never execute helper";
		writeFileSync(
			settings,
			JSON.stringify({ permissions: { defaultMode: "default" }, [key]: value }),
		);
		await assert.rejects(
			async () => CLAUDE_ACP_RUNTIME.command(activation, root),
			/helper override/,
		);
	}
	writeFileSync(settings, JSON.stringify({ permissions: { defaultMode: "default" } }));
	// Even the real factory must refuse before it can spawn the adapter.
	writeFileSync(join(root, ".claude/settings.json"), "{}");
	await assert.rejects(
		officialAcpFactory(
			{ ...activation, sha256: "0".repeat(64) },
			root,
			CLAUDE_ACP_RUNTIME,
		)({ update: () => {}, permission: async () => ({ outcome: { outcome: "cancelled" } }) }),
		/checksum/,
	);
});

test("pinned ACP client wire initialization omits terminal auth and never routes providers", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "claude-acp-wire-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const fixture = join(root, "mock-acp.mjs");
	writeFileSync(
		fixture,
		`import { createInterface } from 'node:readline';
const session = ${JSON.stringify(response())};
createInterface({input:process.stdin}).on('line',line=>{
 const message=JSON.parse(line); if(!message.method) return;
 let result={};
 if(message.method==='initialize') {
  if(JSON.stringify(message.params.clientCapabilities)!=='{}') process.exit(42);
  result={protocolVersion:1,authMethods:[],agentCapabilities:{loadSession:true,auth:{status:{}},providers:{}}};
 } else if(message.method==='auth/status') result={state:'authenticated',accounts:[{_meta:{claudeCode:{kind:'account'}}}]};
 else if(message.method==='session/new') result=session;
 else if(message.method==='session/set_mode') { if(message.params.modeId!=='default') process.exit(43); }
 else if(message.method==='session/set_config_option') result={configOptions:[]};
 else if(message.method==='session/prompt') result={stopReason:'end_turn'};
 else process.exit(44);
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,result})+'\\n');
});`,
	);
	const runtime = {
		...CLAUDE_ACP_RUNTIME,
		command: () => ({ executable: process.execPath, args: [fixture] }),
		beforeRequest: async (_method: string, _cwd: string, request: AcpPort["request"]) => {
			await CLAUDE_ACP_RUNTIME.login(
				{ authMethods: [], agentCapabilities: { auth: { status: {} } } },
				request,
			);
		},
	};
	const session = new AcpSession(
		officialAcpFactory({} as any, root, runtime),
		root,
		async () => undefined,
		undefined,
		runtime,
	);
	t.after(() => session.close());
	assert.equal((await session.discover())[0].id, "claude-fixture");
	assert.equal(
		await session.prompt("claude-fixture", "Direct human prompt", undefined, () => {}),
		"end_turn",
	);
});

test("Claude ACP request boundary rejects unsafe modes and session overrides without querying authentication", async () => {
	const neverRequest: AcpPort["request"] = async () => {
		throw new Error("must refuse before a request");
	};
	for (const modeId of ["bypassPermissions", "dontAsk", "auto"])
		await assert.rejects(
			CLAUDE_ACP_RUNTIME.beforeRequest!("session/set_mode", "/fixture", neverRequest, { modeId }),
			/forbidden/,
		);
	await assert.rejects(
		CLAUDE_ACP_RUNTIME.beforeRequest!("session/set_config_option", "/fixture", neverRequest, {
			configId: "mode",
			value: "auto",
		}),
		/configuration override/,
	);
	for (const key of ["systemPrompt", "_meta", "disableBuiltInTools", "tools"])
		await assert.rejects(
			CLAUDE_ACP_RUNTIME.beforeRequest!("session/new", "/fixture", neverRequest, { [key]: true }),
			/session override/,
		);
});
test("Claude ACP refuses a runtime that demands provider routing rather than attempting it", async () => {
	const f = fixture();
	f.port.request = async (method, params) => {
		f.calls.push({ method, params });
		throw new Error("requires providers/set");
	};
	await assert.rejects(f.session.discover(), /prompting mode is required/);
	assert.deepEqual(
		f.calls.map((c) => c.method),
		["session/new"],
	);
});
test("Claude ACP closes a turn if runtime notifications select a forbidden permission mode", async () => {
	const f = fixture();
	await f.session.discover();
	const original = f.port.request;
	let closed = false;
	f.port.close = () => {
		closed = true;
	};
	const session = new AcpSession(
		async (handlers) => ({
			...f.port,
			request: async (method, params, options) => {
				if (method === "session/prompt") {
					handlers.update({
						sessionId: "claude-fixture",
						update: { sessionUpdate: "current_mode_update", currentModeId: "auto" },
					});
					return { stopReason: "end_turn" };
				}
				return original(method, params, options);
			},
		}),
		"/fixture",
		async () => undefined,
		undefined,
		CLAUDE_ACP_RUNTIME,
	);
	await session.discover();
	await assert.rejects(
		session.prompt("claude-fixture", "Human task", undefined, () => {}),
		/forbidden permission mode/,
	);
	assert.equal(closed, true);
});
