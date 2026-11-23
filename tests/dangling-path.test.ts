import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { scopedTools } from "../src/orchestration/tools.ts";

test("worker write refuses dangling symlinks before creating an outside target", async () => {
	const root = mkdtempSync(join(tmpdir(), "poly-dangling-path-"));
	const worktree = join(root, "worktree"),
		outside = join(root, "outside.txt");
	mkdirSync(worktree);
	symlinkSync(outside, join(worktree, "link.txt"));
	let refusal = "";
	try {
		await scopedTools(worktree, true)
			.find((tool) => tool.name === "write")!
			.execute(
				"fixture",
				{ path: "link.txt", content: "fixture" },
				undefined,
				undefined,
				{} as any,
			);
	} catch (error) {
		refusal = String(error);
	}
	assert.equal(existsSync(outside), false, "A missing outside target must never be created");
	assert.match(refusal, /Worker symlink access refused/);
});
