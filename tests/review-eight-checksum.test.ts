import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AcpSession, officialAcpFactory, type AcpPort } from "../src/providers/acp.ts";
import { CLAUDE_ACP_RUNTIME } from "../src/providers/claude-acp.ts";

for (const method of ["session/new", "session/load", "session/prompt"])
	test(`Claude executable replacement before ${method} refuses and closes the port`, async (t) => {
		const root = mkdtempSync(join(tmpdir(), "poly-review8-checksum-"));
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
		const runtime = join(root, "never-execute-claude");
		writeFileSync(runtime, "reviewed fixture");
		const activation = {
			enabled: true,
			review: "2026-11-25.1",
			runtime,
			sha256: createHash("sha256").update("reviewed fixture").digest("hex"),
		};
		const fixture = join(root, "mock-acp.mjs");
		// The local protocol fixture follows the round-eight wire test; it never executes the native path.
		writeFileSync(
			fixture,
			`import {createInterface} from 'node:readline';
createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);if(!m.method)return;let result={};
 if(m.method==='initialize')result={protocolVersion:1,authMethods:[],agentCapabilities:{loadSession:true,auth:{status:{}}}};
 else if(m.method==='auth/status')result={state:'authenticated',accounts:[{_meta:{claudeCode:{kind:'account'}}}]};
 else if(m.method==='session/new'||m.method==='session/load')result={sessionId:'fixture',modes:{currentModeId:'default',availableModes:[{id:'default',name:'Default'}]},configOptions:[{id:'model',category:'model',type:'select',name:'Model',currentValue:'claude-fixture',options:[{value:'claude-fixture',name:'Fixture'}]}]};
 else if(m.method==='session/prompt')result={stopReason:'end_turn'};
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');
});`,
		);
		const description = {
			...CLAUDE_ACP_RUNTIME,
			command: async (a: any, cwd: string) => ({
				...(await CLAUDE_ACP_RUNTIME.command(a, cwd)),
				args: [fixture],
			}),
		};
		const factory = officialAcpFactory(activation, root, description);
		let closed = false;
		let port: AcpPort | undefined;
		const session = new AcpSession(
			async (handlers) => {
				port = await factory(handlers);
				const close = port.close;
				port.close = () => {
					closed = true;
					close();
				};
				if (method !== "session/prompt") writeFileSync(runtime, "replacement fixture");
				return port;
			},
			root,
			async () => undefined,
			{
				saved: method === "session/load" ? { sessionId: "fixture", cwd: root } : undefined,
				save: () => {},
				report: () => {},
			},
			description,
		);
		t.after(() => session.close());
		if (method === "session/prompt") {
			await session.discover();
			writeFileSync(runtime, "replacement fixture");
			await assert.rejects(
				session.prompt("claude-fixture", "Human task", undefined, () => {}),
				/executable changed.*new review/,
			);
		} else await assert.rejects(session.discover(), /executable changed.*new review/);
		assert.equal(closed, true, "The changed native executable must close its session port");
		await assert.rejects(
			port!.notify("session/cancel", { sessionId: "fixture" }),
			"The underlying connection must be closed",
		);
	});
