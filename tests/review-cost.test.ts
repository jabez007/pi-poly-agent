import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { createWorkspace, snapshotWorkspace, git } from "../src/orchestration/worktrees.ts";
import { reviewDiffView } from "../src/orchestration/review-view.ts";
import { diffTool } from "../src/orchestration/tools.ts";
import { TaskManager } from "../src/orchestration/tasks.ts";
import { defaultRoles } from "../src/orchestration/roles.ts";
import { defaultPolicy } from "../src/policy.ts";
import { temporaryRepository } from "./fixtures/review-project.ts";
import { nestedRepository } from "./fixtures/nested-repository.ts";

test("a 600-file review uses one worktree walk and at most four Git queries", () => {
	const { root, directory } = temporaryRepository();
	const workspace = createWorkspace(root, directory, "fixture");
	fs.mkdirSync(join(workspace.path, "src"));
	for (let n = 0; n < 600; n++)
		fs.writeFileSync(join(workspace.path, `src/${n}.txt`), "ordinary source\n");
	const revision = snapshotWorkspace(workspace);
	const readdir = fs.readdirSync,
		exec = childProcess.execFileSync;
	let walks = 0,
		calls = 0;
	fs.readdirSync = ((path: any, ...args: any[]) => {
		if (path === workspace.path) walks++;
		return (readdir as any)(path, ...args);
	}) as any;
	childProcess.execFileSync = ((file: any, args: any, options: any) => {
		if (file === "git" && options.cwd === workspace.path) calls++;
		return (exec as any)(file, args, options);
	}) as any;
	syncBuiltinESMExports();
	try {
		const view = reviewDiffView(workspace.path, workspace.base, revision);
		assert.match(view, /ordinary source/);
		assert.equal(
			walks,
			1,
			"Every query in one synchronous view must share one completed worktree walk",
		);
		assert.ok(calls <= 4, `Git query count must be constant, observed ${calls}`);
	} finally {
		fs.readdirSync = readdir;
		childProcess.execFileSync = exec;
		syncBuiltinESMExports();
	}
});

test("task completion builds only the revision-specific view", async () => {
	const { root, directory } = temporaryRepository();
	let workspace = "",
		views = 0;
	const exec = childProcess.execFileSync;
	const manager = new TaskManager(
		join(directory, "tasks"),
		root,
		defaultPolicy,
		async ({ task }) => {
			workspace = task.workspace.path;
			fs.writeFileSync(join(workspace, "app.txt"), "after\n");
			return { summary: "Done", files: [], tests: [], findings: [], questions: [] };
		},
	);
	childProcess.execFileSync = ((file: any, args: string[], options: any) => {
		if (
			file === "git" &&
			options.cwd === workspace &&
			(args.includes("--absolute-git-dir") ||
				(args.includes("--git-common-dir") && !args.includes("--path-format=absolute")))
		)
			views++;
		return (exec as any)(file, args, options);
	}) as any;
	syncBuiltinESMExports();
	try {
		const task = await manager.wait(
			manager.dispatch({
				parent: "fixture",
				role: defaultRoles().find((r) => r.name === "builder")!,
				provider: "openai-codex",
				model: "fixture",
				brief: "Count completion views",
			}).id,
		);
		assert.equal(task.status, "completed");
		assert.equal(views, 1, "Completion must not build an uncommitted view it immediately replaces");
	} finally {
		childProcess.execFileSync = exec;
		syncBuiltinESMExports();
		await manager.close();
	}
});

test("view checks expire before subsequent nested repository changes", async () => {
	const { root, directory } = temporaryRepository();
	const workspace = createWorkspace(root, directory, "fixture");
	reviewDiffView(workspace.path, workspace.base, workspace.base);
	const { marker } = nestedRepository(root, workspace.path, directory, "directory");
	assert.throws(
		() => reviewDiffView(workspace.path, workspace.base, workspace.base),
		/nested repository.*inspect.*manually/i,
	);
	await assert.rejects(
		diffTool(workspace.path, workspace.base).execute(
			"fixture",
			{ path: "app.txt" },
			undefined,
			undefined,
			{} as any,
		),
		/nested repository.*inspect.*manually/i,
	);
	assert.equal(fs.existsSync(marker), false);
});

test("streamed patch views retain logic and Unicode escapes across chunk boundaries", async () => {
	const { root, directory } = temporaryRepository();
	const workspace = createWorkspace(root, directory, "fixture");
	const tag = String.fromCodePoint(0xe0001);
	const source = `// \u2028diff --git a/fiction b/fiction ${tag}${"z".repeat(24)}\nlogic=42\n`;
	const large = join(workspace.path, "a-large.txt");
	fs.writeFileSync(large, "a".repeat(66000));
	fs.writeFileSync(join(workspace.path, "z-small.txt"), source);
	git(workspace.path, ["add", "-N", "."]);
	const raw = git(workspace.path, ["diff", "--text", "--no-renames", workspace.base]);
	const offset = Buffer.byteLength(raw.slice(0, raw.indexOf(tag)));
	fs.writeFileSync(large, "a".repeat(66000 + 65521 - offset));
	const revision = snapshotWorkspace(workspace);
	const view = reviewDiffView(workspace.path, workspace.base, revision);
	const tool = await diffTool(workspace.path, workspace.base).execute(
		"fixture",
		{ path: "z-small.txt" },
		undefined,
		undefined,
		{} as any,
	);
	for (const text of [view, (tool.content[0] as any).text]) {
		assert.match(text, /logic=42/);
		assert.ok(text.includes("\\u2028diff --git a/fiction b/fiction"));
		assert.ok(text.includes("\\u{e0001}"));
		assert.ok(!text.includes(tag));
	}
});
