import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dogfoodOffline, DOGFOOD_CONTENT, DOGFOOD_FILE } from "../scripts/dogfood-offline.ts";
import { TaskManager } from "../src/orchestration/tasks.ts";
import { defaultPolicy } from "../src/policy.ts";
import { git } from "../src/orchestration/worktrees.ts";

test(
	"the product implements and independently reviews its own repository in a disposable clone without external memory",
	{ skip: process.env.PI_POLY_SANDBOX_TEST !== "1", timeout: 45000 },
	async () => {
		const active = git(process.cwd(), ["rev-parse", "HEAD"]);
		const report = await dogfoodOffline(true);
		assert.deepEqual(
			report.tasks.map((t) => t.provider),
			["openai-codex", "kimi-coding"],
		);
		assert.notEqual(report.tasks[0].workspace.path, report.tasks[1].workspace.path);
		assert.equal(readFileSync(join(report.project, DOGFOOD_FILE), "utf8"), DOGFOOD_CONTENT);
		assert.equal(git(process.cwd(), ["rev-parse", "HEAD"]), active);
		const restarted = new TaskManager(
			join(report.profile, "tasks"),
			report.project,
			defaultPolicy,
			async () => {
				throw new Error("Restart must not replay a provider request");
			},
		);
		try {
			assert.equal(restarted.list().length, 2);
			assert.ok(
				restarted
					.list()
					.every((t) => t.status === "completed" && t.sessionFile && t.artifacts!.length > 0),
			);
			assert.equal(restarted.get(report.tasks[0].id).integration!.state, "integrated");
		} finally {
			await restarted.close();
		}
	},
);
