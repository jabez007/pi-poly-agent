import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createWorkspace, git, snapshotWorkspace } from "../src/orchestration/worktrees.ts";
import { temporaryRepository } from "./fixtures/review-project.ts";

test("metadata overflow states a lower bound rather than a captured total", () => {
	const { root, directory } = temporaryRepository();
	const workspace = createWorkspace(root, directory, "fixture");
	writeFileSync(join(workspace.path, "large.dat"), Buffer.alloc(5 * 1024 * 1024, 1));
	const revision = snapshotWorkspace(workspace);
	assert.throws(
		() => git(root, ["show", `${revision}:large.dat`]),
		(error: Error) => {
			assert.match(
				error.message,
				/more than the 2097152 byte limit/,
				"A bounded capture cannot report the full output size",
			);
			assert.match(error.message, /inspect.*manually/);
			assert.ok(!error.message.includes("reached"));
			return true;
		},
	);
});
