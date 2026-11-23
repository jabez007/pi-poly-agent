import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { TaskManager } from "../src/orchestration/tasks.ts";
import { git } from "../src/orchestration/worktrees.ts";
import { diffTool } from "../src/orchestration/tools.ts";
import { defaultPolicy } from "../src/policy.ts";
import { reviewedProject, temporaryRepository } from "./fixtures/review-project.ts";

test("Git refuses unregistered worktree paths under an active task store", async () => {
	const { root } = temporaryRepository();
	writeFileSync(join(root, ".gitignore"), ".poly/\n");
	git(root, ["add", ".gitignore"]);
	git(root, ["commit", "-m", "Fixture ignore"]);
	const directory = join(root, ".poly/agent/tasks");
	const manager = new TaskManager(directory, root, defaultPolicy, async () => {
		throw new Error("No worker");
	});
	try {
		const path = join(directory, "unknown/worktree");
		mkdirSync(path, { recursive: true });
		assert.throws(
			() => git(path, ["status", "--porcelain"]),
			/unregistered task worktree|pinned workspace/i,
		);
	} finally {
		await manager.close();
	}
});

for (const path of [".*", ":(glob).*", ":(exclude)app.txt"]) {
	test(`review_diff treats ${path} as a literal checked filename`, async () => {
		const host = await reviewedProject((task) => {
			writeFileSync(join(task.workspace.path, ".env"), "sensitive fixture note\n");
			writeFileSync(join(task.workspace.path, "app.txt"), "ordinary source\n");
		});
		try {
			const review = host.completed.find((task) => task.reviewOf === host.builder.id)!;
			const result = await diffTool(review.workspace.path, review.reviewBase!).execute(
				"fixture",
				{ path },
				undefined,
				undefined,
				{} as any,
			);
			assert.ok(
				!JSON.stringify(result).includes("sensitive fixture note"),
				"Pathspec syntax must not expose blocked files",
			);
		} finally {
			await host.close();
		}
	});
}
