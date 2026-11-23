import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { diffTool } from "../src/orchestration/tools.ts";
import { createWorkspace, git, snapshotWorkspace } from "../src/orchestration/worktrees.ts";
import { temporaryRepository } from "./fixtures/review-project.ts";

test("review_diff refuses a replaced parent directory without exposing its absolute path", async () => {
	const { root, directory } = temporaryRepository();
	mkdirSync(join(root, "config"));
	writeFileSync(join(root, "config/app.txt"), "before\n");
	git(root, ["add", "."]);
	git(root, ["commit", "-m", "Fixture configuration source"]);
	const workspace = createWorkspace(root, directory, "fixture");
	rmSync(join(workspace.path, "config"), { recursive: true });
	writeFileSync(join(workspace.path, "config"), "replacement\n");
	snapshotWorkspace(workspace);
	const tool = diffTool(workspace.path, workspace.base);
	await assert.rejects(
		tool.execute("fixture", { path: "config/app.txt" }, undefined, undefined, {} as any),
		(error: Error) => {
			assert.equal(
				error.message,
				"Worker path is outside approved source context",
				"A non-directory path component must use the normal source-path refusal",
			);
			assert.ok(!error.message.includes(workspace.path));
			assert.ok(!error.message.includes(directory));
			return true;
		},
	);
	const allowed = await tool.execute(
		"fixture",
		{ path: "app.txt" },
		undefined,
		undefined,
		{} as any,
	);
	assert.equal((allowed.content[0] as any).text, "");
});
