import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
	createWorkspace,
	snapshotWorkspace,
	workspaceDiff,
} from "../src/orchestration/worktrees.ts";
import { temporaryRepository } from "./fixtures/review-project.ts";

test("review inspection footer identifies uncommitted and committed source accurately", () => {
	const { root, directory } = temporaryRepository();
	const workspace = createWorkspace(root, directory, "fixture");
	writeFileSync(join(workspace.path, "app.txt"), "after\n");
	const uncommitted = workspaceDiff(workspace).diff;
	assert.match(uncommitted, /Revision: uncommitted worktree/);
	assert.match(
		uncommitted,
		/Inspect the full uncommitted diff:/,
		"An uncommitted view must not call its patch committed",
	);
	snapshotWorkspace(workspace);
	const committed = workspaceDiff(workspace).diff;
	assert.match(committed, /Inspect the full committed diff:/);
	assert.ok(!committed.includes("uncommitted worktree"));
});
