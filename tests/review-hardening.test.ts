import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createWorkspace, workspaceDiff } from "../src/orchestration/worktrees.ts";
import { scopedTools } from "../src/orchestration/tools.ts";
import { temporaryRepository } from "./fixtures/review-project.ts";

test("case-insensitive Git metadata names are refused in task worktrees", async () => {
	const { root, directory } = temporaryRepository();
	const workspace = createWorkspace(root, directory, "fixture");
	mkdirSync(join(workspace.path, "sub/.GIT"), { recursive: true });
	assert.throws(
		() => workspaceDiff(workspace),
		/nested repository.*inspect.*manually/i,
		"Case variants of Git metadata require the same refusal",
	);
	const read = scopedTools(workspace.path, false)[0];
	await assert.rejects(
		read.execute("fixture", { path: "sub/.GIT/config" }, undefined, undefined, {} as any),
		/outside approved source context/,
	);
});
