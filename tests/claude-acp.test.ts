import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
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

function response(mode = "plan") {
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
function fixture(saved?: string) {
	const calls: { method: string; params: any }[] = [];
	let handlers: AcpHandlers;
	let closed = false;
	const port: AcpPort = {
		supportsLoad: true,
		request: async (method, params) => {
			calls.push({ method, params });
			if (method === "session/new" || method === "session/load") return response();
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
					],
				});
				calls.push({ method: "permission-response", params: decision });
				return { stopReason: "end_turn" };
			}
			return {};
		},
		notify: async () => {},
		close: () => {
			closed = true;
		},
	};
	const reports: string[] = [];
	const session = new AcpSession(
		async (h) => {
			handlers = h;
			return port;
		},
		"/fixture",
		async (_title, choices) => choices[1],
		{
			saved: saved ? { sessionId: saved, cwd: "/fixture" } : undefined,
			save: () => {},
			report: (text) => reports.push(text),
		},
		CLAUDE_ACP_RUNTIME,
	);
	return {
		session,
		port,
		calls,
		reports,
		get closed() {
			return closed;
		},
	};
}

test("Claude ACP selects default before prompting without tools, prompt or metadata overrides", async () => {
	const f = fixture();
	assert.equal((await f.session.discover())[0].id, "claude-fixture");
	assert.deepEqual(f.calls[0], {
		method: "session/new",
		params: { cwd: "/fixture", mcpServers: [] },
	});
	assert.deepEqual(f.calls[1], {
		method: "session/set_mode",
		params: { sessionId: "claude-fixture", modeId: "default" },
	});
});

test("Claude ACP exposes every offered mode and rejects unavailable selections", async () => {
	const f = fixture();
	await f.session.discover();
	assert.deepEqual(
		f.session.availableModes(),
		response().modes.availableModes.map((m) => m.id),
	);
	for (const mode of f.session.availableModes()) await f.session.selectMode(mode);
	await assert.rejects(f.session.selectMode("missing"), /unavailable/);
	assert.deepEqual(
		f.calls.filter((c) => c.method === "session/set_mode").map((c) => c.params.modeId),
		["default", ...f.session.availableModes()],
	);
});

test("Claude ACP sends contextual single-use denial back to the native tool", async () => {
	const f = fixture();
	await f.session.discover();
	await f.session.prompt("claude-fixture", "Human task", undefined, () => {});
	assert.deepEqual(f.calls.find((c) => c.method === "permission-response")!.params, {
		outcome: { outcome: "selected", optionId: "deny" },
	});
});

test("Claude native login status does not enforce an account-kind policy or start client login", async () => {
	const initialized = { authMethods: [], agentCapabilities: { auth: { status: {} } } };
	const methods: string[] = [];
	await CLAUDE_ACP_RUNTIME.login(initialized, async (method) => {
		methods.push(method);
		return { state: "authenticated" };
	});
	assert.deepEqual(methods, ["auth/status"]);
	await assert.rejects(
		CLAUDE_ACP_RUNTIME.login(initialized, async () => ({ state: "unauthenticated" })),
		{ message: CLAUDE_LOGIN_MESSAGE },
	);
	for (const id of ["gateway", "console-login", "terminal-login"])
		await assert.rejects(
			CLAUDE_ACP_RUNTIME.login({ ...initialized, authMethods: [{ id }] }, async () => {
				throw new Error("must not authenticate");
			}),
			{ message: CLAUDE_LOGIN_MESSAGE },
		);
});

test("Claude load resets the restored mode to default and failed load requires explicit new", async () => {
	const f = fixture("saved");
	await f.session.discover();
	assert.equal(f.calls[0].method, "session/load");
	assert.equal(f.calls[1].params.modeId, "default");
	const failed = fixture("saved");
	failed.port.supportsLoad = false;
	await assert.rejects(failed.session.discover());
	assert.match(failed.reports[0], /poly-claude-discover new/);
	assert.equal(failed.calls.length, 0);
	await failed.session.discover(true);
	assert.equal(failed.calls[0].method, "session/new");
});

test("Claude authentication errors contain fixed native-login guidance", async () => {
	const f = fixture();
	f.port.request = async () => {
		throw { code: -32000, message: "fixture private diagnostic" };
	};
	await assert.rejects(f.session.discover(), { message: CLAUDE_LOGIN_MESSAGE });
	assert.equal(f.closed, true);
});

test("Claude startup resolves PATH or an explicit path without inspecting settings or checksums", async () => {
	const root = mkdtempSync(join(tmpdir(), "poly-claude-path-"));
	const binary = join(root, "claude");
	writeFileSync(binary, "fixture; never executed");
	chmodSync(binary, 0o755);
	mkdirSync(join(root, ".claude"));
	writeFileSync(
		join(root, ".claude/settings.json"),
		JSON.stringify({
			apiKeyHelper: "fixture-never-executed",
			permissions: { defaultMode: "auto" },
		}),
	);
	const oldPath = process.env.PATH;
	try {
		process.env.PATH = root;
		for (const activation of [{ enabled: true }, { enabled: true, path: binary }]) {
			const command = CLAUDE_ACP_RUNTIME.command(activation);
			assert.equal(command.env.CLAUDE_CODE_EXECUTABLE, binary);
			assert.equal(command.env.CLAUDE_AGENT_ACP_PROTOCOL, "v1");
			assert.match(command.args[0], /claude-agent-acp\/dist\/index.js$/);
		}
		writeFileSync(binary, "updated fixture; still never executed");
		assert.doesNotThrow(() => CLAUDE_ACP_RUNTIME.command({ enabled: true, path: binary }));
		for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"]) {
			process.env[name] = "fixture";
			assert.throws(() => CLAUDE_ACP_RUNTIME.command({ enabled: true, path: binary }), /refused/);
			delete process.env[name];
		}
	} finally {
		process.env.PATH = oldPath;
	}
});

test("Claude ACP protocol fixture receives no terminal auth, provider routing or session overrides", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "poly-claude-wire-"));
	const script = join(root, "wire.mjs");
	writeFileSync(
		script,
		`import {createInterface} from 'node:readline';
const session=${JSON.stringify(response())};
createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);if(!m.method)return;let result={};
 if(m.method==='initialize'){if(JSON.stringify(m.params.clientCapabilities)!=='{}')process.exit(41); result={protocolVersion:1,authMethods:[],agentCapabilities:{loadSession:true,auth:{status:{}}}};}
 else if(m.method==='auth/status')result={state:'authenticated'};
 else if(m.method==='session/new'||m.method==='session/load'){const keys=Object.keys(m.params);if(keys.some(k=>!['cwd','mcpServers','sessionId'].includes(k)))process.exit(42);result=session;}
 else if(m.method==='session/set_mode'){if(!session.modes.availableModes.some(x=>x.id===m.params.modeId))process.exit(43);}
 else if(m.method==='session/set_config_option')result={configOptions:[]};
 else if(m.method==='session/prompt')result={stopReason:'end_turn'};else process.exit(44);
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');});`,
	);
	const runtime = {
		...CLAUDE_ACP_RUNTIME,
		command: () => ({ executable: process.execPath, args: [script] }),
	};
	const session = new AcpSession(
		officialAcpFactory({ enabled: true }, root, runtime),
		root,
		async () => undefined,
		undefined,
		runtime,
	);
	t.after(() => session.close());
	assert.equal((await session.discover())[0].id, "claude-fixture");
	for (const mode of session.availableModes()) await session.selectMode(mode);
	assert.equal(
		await session.prompt("claude-fixture", "Direct human prompt", undefined, () => {}),
		"end_turn",
	);
});
