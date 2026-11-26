import assert from "node:assert/strict";
import { mkdtempSync, cpSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { test } from "node:test";
import { AcpSession, GOOGLE_ACP_RUNTIME, officialAcpFactory } from "../src/providers/acp.ts";

test(
	"official ACP wire fixture discovers, prompts and asks permission without invoking native login",
	{ timeout: 15000 },
	async (t) => {
		const root = mkdtempSync(join(tmpdir(), "poly-google-wire-"));
		const script = join(root, "agent.mjs");
		cpSync(resolve("tests/fixtures/acp-agent.mjs"), script);
		symlinkSync(resolve("node_modules"), join(root, "node_modules"));
		const runtime = {
			...GOOGLE_ACP_RUNTIME,
			command: () => ({ executable: process.execPath, args: [script] }),
		};
		const session = new AcpSession(
			officialAcpFactory({ enabled: true }, root, runtime),
			root,
			async (_title, options) => options[0],
		);
		t.after(() => session.close());
		assert.equal((await session.discover())[0].id, "gemini-fixture-process");
		const chunks: string[] = [];
		assert.equal(
			await session.prompt(
				"gemini-fixture-process",
				"Fixture direct prompt",
				undefined,
				({ update }) => {
					if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text")
						chunks.push(update.content.text);
				},
			),
			"end_turn",
		);
		assert.deepEqual(chunks, ["ACP subprocess fixture succeeded"]);
	},
);
