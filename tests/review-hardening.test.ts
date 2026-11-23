import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createWorkspace, workspaceDiff, git } from "../src/orchestration/worktrees.ts";
import { scopedTools, diffTool } from "../src/orchestration/tools.ts";
import { temporaryRepository, reviewedProject } from "./fixtures/review-project.ts";
import { TaskManager } from "../src/orchestration/tasks.ts";
import { defaultRoles } from "../src/orchestration/roles.ts";
import { defaultPolicy } from "../src/policy.ts";

test("renamed control files remain named in the canonical changed-file list", async () => {
	const { root, directory } = temporaryRepository();
	mkdirSync(join(root, "é"));
	writeFileSync(join(root, "é/.gitattributes"), "# fixture\n");
	git(root, ["add", "."]);
	git(root, ["commit", "-m", "Fixture control file"]);
	const manager = new TaskManager(
		join(directory, "tasks"),
		root,
		defaultPolicy,
		async ({ task }) => {
			renameSync(
				join(task.workspace.path, "é/.gitattributes"),
				join(task.workspace.path, "é/attributes.txt"),
			);
			return { summary: "Done", files: [], tests: [], findings: [], questions: [] };
		},
	);
	try {
		const task = await manager.wait(
			manager.dispatch({
				parent: "fixture",
				role: defaultRoles().find((r) => r.name === "builder")!,
				provider: "openai-codex",
				model: "fixture",
				brief: "Rename fixture",
			}).id,
		);
		assert.deepEqual(
			task.result!.files,
			["é/.gitattributes", "é/attributes.txt"],
			"Renames must retain both paths so control-file changes cannot disappear",
		);
		const changes = workspaceDiff(task.workspace);
		assert.deepEqual(changes.files, task.result!.files);
		assert.match(changes.diff.split("\n")[0], /é\/\.gitattributes/);
	} finally {
		await manager.close();
	}
});

test("review_diff directory requests cannot reveal sensitive filenames", async () => {
	const host = await reviewedProject((task) => {
		mkdirSync(join(task.workspace.path, "config"));
		writeFileSync(join(task.workspace.path, "config/.env"), "private fixture note\n");
		writeFileSync(join(task.workspace.path, "config/app.txt"), "visible fixture note\n");
	});
	try {
		const review = host.completed.find((t) => t.reviewOf === host.builder.id)!;
		const tool = diffTool(review.workspace.path, review.reviewBase!);
		let output: unknown;
		let failure = "";
		try {
			output = await tool.execute("fixture", { path: "config" }, undefined, undefined, {} as any);
		} catch (error) {
			failure = String(error);
		}
		assert.ok(
			!JSON.stringify(output || "").includes("private fixture note"),
			"A directory request must not return a name-blocked file's patch",
		);
		assert.match(failure, /literal file path/);
		const index = await tool.execute("fixture", { path: "." }, undefined, undefined, {} as any);
		assert.ok(!JSON.stringify(index).includes("config/.env"));
		assert.ok(JSON.stringify(index).includes("config/app.txt"));
	} finally {
		await host.close();
	}
});

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

test("integration preview preserves the reviewer's approved visibility limits", async () => {
	const host = await reviewedProject((task) =>
		writeFileSync(join(task.workspace.path, "medium.txt"), "source line\n".repeat(700)),
	);
	try {
		const review = host.completed.find((t) => t.reviewOf === host.builder.id)!;
		await host.commands.get("task").handler(`${host.builder.id} integrate`, host.ctx);
		const preview = host.notices.find((n) => n.includes("Review findings:"))!;
		assert.ok(
			preview.includes(review.context!),
			"Integration preview must retain what the reviewer was approved to see, including omissions",
		);
		assert.match(preview, /Reviewer visibility/);
	} finally {
		await host.close();
	}
});

test("all invisible Unicode code points are escaped in every review view", async () => {
	const points = [
		0x00ad,
		0x180e,
		0x200b,
		0x200c,
		0x200d,
		0x2028,
		0x2029,
		0x2060,
		0x3164,
		0xfeff,
		0xfff9,
		0xfffa,
		0xfffb,
		...Array.from({ length: 128 }, (_, n) => 0xe0000 + n),
	];
	const characters = points.map((point) => String.fromCodePoint(point));
	const host = await reviewedProject((task) =>
		writeFileSync(join(task.workspace.path, "app.txt"), `// ${characters.join("|")}\nlogic=42\n`),
	);
	try {
		const review = host.completed.find((t) => t.reviewOf === host.builder.id)!;
		const output = await diffTool(review.workspace.path, review.reviewBase!).execute(
			"fixture",
			{ path: "app.txt" },
			undefined,
			undefined,
			{} as any,
		);
		await host.commands.get("task").handler(`${host.builder.id} integrate`, host.ctx);
		const views = [
			host.builder.artifacts!.find((a) => a.kind === "diff")!.content,
			review.context!,
			(output.content[0] as any).text,
			host.notices.find((n) => n.includes("Review findings:"))!,
		];
		for (const view of views)
			for (const [index, point] of points.entries()) {
				assert.ok(
					!view.includes(characters[index]),
					`U+${point.toString(16)} must never remain invisible in review`,
				);
				const hex = point.toString(16).padStart(4, "0");
				assert.ok(
					view.includes(point > 0xffff ? `\\u{${hex}}` : `\\u${hex}`),
					"Each invisible code point must remain visible as a full Unicode escape",
				);
			}
	} finally {
		await host.close();
	}
});
