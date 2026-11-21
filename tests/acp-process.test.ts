import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { AcpSession, officialAcpFactory } from "../src/providers/acp.ts";
import { POLICY_REVISION } from "../src/policy.ts";

test(
	"official ACP SDK subprocess protocol supports discovery, prompting, and interactive permissions",
	{ timeout: 15000 },
	async () => {
		const runtime = resolve("tests/fixtures/acp-agent.mjs");
		const activation = {
			enabled: true,
			review: POLICY_REVISION,
			runtime,
			sha256: createHash("sha256").update(readFileSync(runtime)).digest("hex"),
		};
		const session = new AcpSession(
			officialAcpFactory(activation, process.cwd()),
			process.cwd(),
			async (_title, options) => options[0],
		);
		try {
			const models = await session.discover();
			assert.equal(models[0].id, "gemini-fixture-process");
			const chunks: string[] = [];
			const reason = await session.prompt(
				models[0].id,
				"Fixture direct prompt",
				undefined,
				({ update }) => {
					if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text")
						chunks.push(update.content.text);
				},
			);
			assert.equal(reason, "end_turn");
			assert.deepEqual(chunks, ["ACP subprocess fixture succeeded"]);
		} finally {
			session.close();
		}
	},
);
