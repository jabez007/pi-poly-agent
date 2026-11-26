import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AcpSession, officialAcpFactory, type AcpHandlers } from "../src/providers/acp.ts";
import { CLAUDE_ACP_RUNTIME } from "../src/providers/claude-acp.ts";
import { bootstrap } from "../src/profile.ts";
import { defaultPolicy, CLAUDE_REVIEW_REVISION } from "../src/policy.ts";

const safeMeta = { claudeCode: { options: { allowDangerouslySkipPermissions: false } } };
for (const method of ["session/new", "session/load"])
	test(`Claude ${method} sends only the explicit bypass-disable metadata on the wire`, async (t) => {
		const root = mkdtempSync(join(tmpdir(), "poly-review8-meta-"));
		t.after(() => rmSync(root, { recursive: true, force: true }));
		const before = process.env.CLAUDE_CONFIG_DIR;
		process.env.CLAUDE_CONFIG_DIR = join(root, "native");
		mkdirSync(process.env.CLAUDE_CONFIG_DIR);
		writeFileSync(
			join(process.env.CLAUDE_CONFIG_DIR, "settings.json"),
			JSON.stringify({ permissions: { defaultMode: "default" } }),
		);
		t.after(() => {
			if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR;
			else process.env.CLAUDE_CONFIG_DIR = before;
		});
		const capture = join(root, "session-params.json");
		const fixture = join(root, "mock-acp.mjs");
		writeFileSync(
			fixture,
			`import {createInterface} from 'node:readline';
import {writeFileSync} from 'node:fs';
createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);if(!m.method)return;let result={};
 if(m.method==='initialize') result={protocolVersion:1,authMethods:[],agentCapabilities:{auth:{status:{}}}};
 else if(m.method==='auth/status') result={state:'authenticated',accounts:[{_meta:{claudeCode:{kind:'account'}}}]};
 else if(m.method==='session/new'||m.method==='session/load') {writeFileSync(${JSON.stringify(capture)},JSON.stringify(m.params));result={sessionId:'fixture'};}
 else process.exit(45);
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');
});`,
		);
		const runtime = {
			...CLAUDE_ACP_RUNTIME,
			command: () => ({ executable: process.execPath, args: [fixture] }),
		};
		const port = await officialAcpFactory(
			{} as any,
			root,
			runtime,
		)({ update: () => {}, permission: async () => ({ outcome: { outcome: "cancelled" } }) });
		t.after(() => port.close());
		const params =
			method === "session/load"
				? { cwd: root, mcpServers: [], sessionId: "fixture" }
				: { cwd: root, mcpServers: [] };
		await port.request(method, params);
		assert.deepEqual(JSON.parse(readFileSync(capture, "utf8")), { ...params, _meta: safeMeta });
	});

test("Claude session boundary rejects any metadata beyond the reviewed bypass-disable option", async () => {
	for (const _meta of [
		undefined,
		true,
		null,
		{},
		{ claudeCode: {} },
		{ claudeCode: { options: { allowDangerouslySkipPermissions: true } } },
		{ ...safeMeta, other: false },
		{ claudeCode: { options: { ...safeMeta.claudeCode.options, other: false } } },
		{ claudeCode: { ...safeMeta.claudeCode, other: false } },
	])
		for (const method of ["session/new", "session/load"])
			await assert.rejects(
				CLAUDE_ACP_RUNTIME.beforeRequest!(
					method,
					"/fixture",
					async () => {
						assert.fail("Invalid metadata must refuse before authentication");
					},
					{ _meta },
				),
				/session override/,
			);
});

test("forbidden mode during a pending Claude prompt preserves its specific refusal after port closure", async (t) => {
	let handlers!: AcpHandlers;
	let rejectPrompt!: (error: Error) => void;
	let signalStarted!: () => void;
	const started = new Promise<void>((resolve) => {
		signalStarted = resolve;
	});
	let closed = false;
	const session = new AcpSession(
		async (h) => {
			handlers = h;
			return {
				request: async (method) => {
					if (method === "session/new")
						return {
							sessionId: "fixture",
							modes: {
								currentModeId: "default",
								availableModes: [{ id: "default", name: "Default" }],
							},
							configOptions: [
								{
									id: "model",
									category: "model",
									type: "select",
									name: "Model",
									currentValue: "claude-fixture",
									options: [{ value: "claude-fixture", name: "Fixture" }],
								},
							],
						};
					if (method === "session/prompt")
						return new Promise((_resolve, reject) => {
							rejectPrompt = reject;
							signalStarted();
						});
					return {};
				},
				notify: async () => {},
				close: () => {
					closed = true;
					rejectPrompt?.(new Error("Connection closed"));
				},
			};
		},
		"/fixture",
		async () => undefined,
		undefined,
		CLAUDE_ACP_RUNTIME,
	);
	t.after(() => session.close());
	await session.discover();
	const rejected = assert.rejects(
		session.prompt("claude-fixture", "Human task", undefined, () => {}),
		/forbidden permission mode/,
	);
	await started;
	handlers.update({
		sessionId: "fixture",
		update: { sessionUpdate: "current_mode_update", currentModeId: "auto" },
	});
	await rejected;
	assert.equal(closed, true);
});

for (const mode of ["acp", "bridge"] as const)
	test(`validate identifies the activated Claude ${mode} mode without starting it`, (t) => {
		const root = mkdtempSync(join(tmpdir(), "poly-review8-validate-"));
		t.after(() => rmSync(root, { recursive: true, force: true }));
		bootstrap(root);
		const runtime = join(root, "never-execute");
		writeFileSync(runtime, "reviewed fixture");
		const policy = defaultPolicy();
		policy.claude = {
			enabled: true,
			mode,
			review: CLAUDE_REVIEW_REVISION,
			runtime,
			sha256: createHash("sha256").update("reviewed fixture").digest("hex"),
		};
		writeFileSync(join(root, "poly.json"), JSON.stringify(policy));
		const output = execFileSync(
			process.execPath,
			["--import", "tsx", "scripts/cli.ts", "validate", "--profile", root, "--project", root],
			{ env: { ...process.env, PI_OFFLINE: "1" }, encoding: "utf8" },
		);
		assert.match(JSON.parse(output).claude, new RegExp(`claude-${mode}`));
	});
