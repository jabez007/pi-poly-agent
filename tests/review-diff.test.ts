import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { workspaceDiff } from "../src/orchestration/worktrees.ts";
import { diffTool } from "../src/orchestration/tools.ts";
import { taskContext } from "../src/orchestration/context.ts";
import { taskPrompt } from "../src/orchestration/runner.ts";
import { reviewedProject } from "./fixtures/review-project.ts";

test("non-ASCII control-file paths are unquoted in notices and reviewer file lists", async () => {
	const host = await reviewedProject((task) => {
		mkdirSync(join(task.workspace.path, "é"));
		writeFileSync(join(task.workspace.path, "é/.gitattributes"), "* -diff\n");
		writeFileSync(join(task.workspace.path, "é/.gitmodules"), "# fixture\n");
	});
	try {
		assert.deepEqual(host.builder.result!.files, ["é/.gitattributes", "é/.gitmodules"]);
		const diff = workspaceDiff(host.builder.workspace);
		assert.deepEqual(diff.files, ["é/.gitattributes", "é/.gitmodules"]);
		assert.match(diff.diff.split("\n")[0], /é\/\.gitattributes.*é\/\.gitmodules/);
		const review = host.completed.find((task) => task.reviewOf === host.builder.id)!;
		assert.match(taskPrompt(review), /é\/\.gitattributes.*é\/\.gitmodules/);
	} finally {
		await host.close();
	}
});

test("attributes cannot hide text changes from artifacts, reviewer tools or integration previews", async () => {
	const host = await reviewedProject((task) => {
		writeFileSync(join(task.workspace.path, ".gitattributes"), "* -diff\n");
		writeFileSync(join(task.workspace.path, ".gitmodules"), "# fixture metadata\n");
		writeFileSync(join(task.workspace.path, "app.txt"), "after\n");
	});
	try {
		const artifact = host.builder.artifacts!.find((a) => a.kind === "diff")!;
		assert.match(artifact.content, /\+after/);
		const snapshot = workspaceDiff(host.builder.workspace).diff;
		assert.match(snapshot, /\+after/);
		assert.match(snapshot.split("\n")[0], /\.gitattributes.*\.gitmodules/);
		const review = host.completed.find((t) => t.reviewOf === host.builder.id)!;
		const result = await diffTool(review.workspace.path, review.reviewBase!).execute(
			"fixture",
			{ path: "app.txt" },
			undefined,
			undefined,
			{} as any,
		);
		assert.match(JSON.stringify(result), /\+after/);
		assert.match(taskContext("", host.builder).split("\n")[0], /\.gitattributes.*\.gitmodules/);
		assert.match(
			taskPrompt(review),
			/Repository control files changed:.*\.gitattributes.*\.gitmodules/,
		);
		host.notices.length = 0;
		await host.commands.get("task").handler(`${host.builder.id} integrate`, host.ctx);
		const preview = host.notices.find((n) => n.includes("Review findings:"))!;
		assert.match(preview, /\+after/);
		assert.match(preview.split("\n")[0], /\.gitattributes.*\.gitmodules/);
		assert.equal(readFileSync(join(host.root, "app.txt"), "utf8"), "before\n");
	} finally {
		await host.close();
	}
});

test("binary review output names the changed file and escapes control bytes without dropping lines", async () => {
	const host = await reviewedProject((task) =>
		writeFileSync(join(task.workspace.path, "asset.bin"), Buffer.from([0, 1, 2, 3, 27])),
	);
	try {
		const diff = workspaceDiff(host.builder.workspace).diff;
		assert.match(diff, /asset\.bin/);
		assert.ok(diff.includes("\\u0000") && diff.includes("\\u001b"));
		assert.ok(!diff.includes("\u0000") && !diff.includes("\u001b"));
	} finally {
		await host.close();
	}
});
