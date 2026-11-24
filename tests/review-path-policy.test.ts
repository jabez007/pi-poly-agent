import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { TaskManager } from "../src/orchestration/tasks.ts";
import { taskContext } from "../src/orchestration/context.ts";
import { diffTool } from "../src/orchestration/tools.ts";
import { defaultRoles } from "../src/orchestration/roles.ts";
import { defaultPolicy } from "../src/policy.ts";
import { git } from "../src/orchestration/worktrees.ts";
import { temporaryRepository } from "./fixtures/review-project.ts";

for (const state of ["deleted", "replaced", "existing"]) {
	test(`review_diff refuses ${state} directory paths and excludes refused descendants`, async () => {
		const { root, directory } = temporaryRepository();
		mkdirSync(join(root, "config"));
		writeFileSync(join(root, "config/.env"), "private fixture note\n");
		writeFileSync(join(root, "config/app.txt"), "before\n");
		git(root, ["add", "."]);
		git(root, ["commit", "-m", "Fixture directory"]);
		const roles = defaultRoles();
		const manager = new TaskManager(
			join(directory, "tasks"),
			root,
			defaultPolicy,
			async ({ task }) => {
				if (task.role.editing) {
					if (state !== "existing")
						rmSync(join(task.workspace.path, "config"), { recursive: true });
					if (state === "replaced")
						writeFileSync(join(task.workspace.path, "config"), "replacement fixture\n");
					if (state === "existing")
						writeFileSync(join(task.workspace.path, "config/app.txt"), "visible fixture change\n");
				}
				return { summary: "Done", files: [], tests: [], findings: [], questions: [] };
			},
		);
		try {
			const built = await manager.wait(
				manager.dispatch({
					parent: "fixture",
					role: roles.find((r) => r.name === "builder")!,
					provider: "openai-codex",
					model: "fixture",
					brief: "Change fixture directory",
				}).id,
			);
			assert.equal(built.status, "completed");
			const review = await manager.wait(
				manager.dispatch({
					parent: "fixture",
					role: roles.find((r) => r.name === "reviewer")!,
					provider: "kimi-coding",
					model: "fixture",
					brief: "Review fixture",
					reviewOf: built.id,
					context: taskContext("", built),
				}).id,
			);
			const tool = diffTool(review.workspace.path, review.reviewBase!);
			assert.ok(
				!review.context!.includes("private fixture note"),
				"The shared name policy must also protect review packets",
			);
			let output: unknown,
				failure = "";
			try {
				output = await tool.execute("fixture", { path: "config" }, undefined, undefined, {} as any);
			} catch (error) {
				failure = String(error);
			}
			assert.ok(
				!JSON.stringify(output || "").includes("private fixture note"),
				"A directory's prior contents must not bypass the literal-file policy",
			);
			assert.match(failure, /requires a literal file path/);
			await assert.rejects(
				tool.execute("fixture", { path: "config/.env" }, undefined, undefined, {} as any),
				/outside approved source context/,
			);
			if (state === "existing") {
				const literal = await tool.execute(
					"fixture",
					{ path: "config/app.txt" },
					undefined,
					undefined,
					{} as any,
				);
				assert.match(JSON.stringify(literal), /visible fixture change/);
			}
		} finally {
			await manager.close();
		}
	});
}
