import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createWorkspace, workspaceDiff } from "../src/orchestration/worktrees.ts";
import { scopedTools, diffTool } from "../src/orchestration/tools.ts";
import { temporaryRepository, reviewedProject } from "./fixtures/review-project.ts";

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
