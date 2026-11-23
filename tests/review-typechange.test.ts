import assert from "node:assert/strict";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { TaskManager } from "../src/orchestration/tasks.ts";
import { defaultRoles } from "../src/orchestration/roles.ts";
import { defaultPolicy } from "../src/policy.ts";
import { taskContext } from "../src/orchestration/context.ts";
import { diffTool } from "../src/orchestration/tools.ts";
import { reviewDiffView } from "../src/orchestration/review-view.ts";
import { reviewPatches } from "../src/orchestration/review-patches.ts";
import { git, reviewDiffOptions, workspaceDiff } from "../src/orchestration/worktrees.ts";
import { temporaryRepository, reviewedProject } from "./fixtures/review-project.ts";

const result = { summary: "Fixture done", files: [], tests: [], findings: [], questions: [] };
const builderRole = defaultRoles().find((r) => r.name === "builder")!;
const reviewerRole = defaultRoles().find((r) => r.name === "reviewer")!;
const cases = [
	{ name: "file to symlink", before: "file", after: "link", file: "type.txt" },
	{ name: "symlink to file", before: "link", after: "file", file: "type.txt" },
	{ name: "off-page typechange", before: "file", after: "link", file: "z-type.txt", offPage: true },
	{ name: "refused-name typechange", before: "link", after: "file", file: "config/.env" },
	{ name: "symlink target change", before: "link", after: "link", file: "type.txt" },
	{
		name: "oversized typechange pair",
		before: "link",
		after: "file",
		file: "type.txt",
		large: true,
	},
];

for (const entry of cases) {
	test(`${entry.name} completes reviews and recovers without losing patch attribution`, async () => {
		const { root, directory } = temporaryRepository();
		const initial = join(root, entry.file);
		mkdirSync(dirname(initial), { recursive: true });
		if (entry.before === "link") symlinkSync("old-target", initial);
		else writeFileSync(initial, "before type\n");
		git(root, ["add", "."]);
		git(root, ["commit", "-m", "Fixture source type"]);
		let fail = false;
		const manager = new TaskManager(
			join(directory, "tasks"),
			root,
			defaultPolicy,
			async ({ task }) => {
				if (task.role.editing) {
					const file = join(task.workspace.path, entry.file);
					rmSync(file, { force: true });
					if (entry.after === "link") symlinkSync("new-target", file);
					else writeFileSync(file, "after type\n".repeat(entry.large ? 7000 : 1));
					if (entry.offPage)
						for (let n = 0; n < 60; n++)
							writeFileSync(
								join(task.workspace.path, `a${String(n).padStart(3, "0")}.txt`),
								"ordinary\n",
							);
					if (fail) throw new Error("Fixture interruption");
				}
				return result;
			},
		);
		const input = {
			parent: "fixture",
			role: builderRole,
			provider: "openai-codex",
			model: "fixture",
			brief: "Inspect the source type change",
		};
		try {
			const builder = await manager.wait(manager.dispatch(input).id);
			assert.equal(builder.status, "completed", "Source type changes must complete before review");
			const packet = taskContext("Fixture knowledge", builder);
			const review = await manager.wait(
				manager.dispatch({
					...input,
					role: reviewerRole,
					provider: "kimi-coding",
					reviewOf: builder.id,
					context: packet,
				}).id,
			);
			assert.equal(review.status, "completed");
			assert.equal(review.context, packet);
			const tool = diffTool(review.workspace.path, review.reviewBase!);
			let offset = 0,
				index = "";
			do {
				const page = await tool.execute(
					"fixture",
					{ path: ".", offset },
					undefined,
					undefined,
					{} as any,
				);
				const text = (page.content[0] as any).text as string;
				index += text;
				const next = /Next file offset: (\d+)/.exec(text);
				offset = next ? Number(next[1]) : 0;
			} while (offset);
			assert.ok(index.includes(entry.file));
			const views = [
				builder.artifacts!.find((a) => a.kind === "diff")!.content,
				packet,
				workspaceDiff(builder.workspace).diff,
			];
			if (entry.file === "config/.env") {
				for (const view of views) {
					assert.match(view, /refused by path policy/);
					assert.ok(!view.includes("after type"));
				}
				await assert.rejects(
					tool.execute("fixture", { path: entry.file }, undefined, undefined, {} as any),
					/outside approved source context/,
				);
			} else {
				const exact = reviewDiffView(
					builder.workspace.path,
					builder.workspace.base,
					builder.revision!,
					[join(builder.workspace.path, entry.file)],
					48000,
					{ exactPath: entry.file },
				);
				if (entry.large) {
					assert.match(exact, /\[not shown {2}\] "type.txt"/);
					assert.ok(!exact.includes("diff --git"));
				} else {
					assert.equal(
						(exact.match(/\ndiff --git /g) || []).length,
						entry.before === entry.after ? 1 : 2,
					);
					assert.match(exact, entry.after === "link" ? /new-target/ : /after type/);
				}
				if (entry.after === "link")
					await assert.rejects(
						tool.execute("fixture", { path: entry.file }, undefined, undefined, {} as any),
						/symlink access refused/,
					);
				else {
					const patch = await tool.execute(
						"fixture",
						{ path: entry.file },
						undefined,
						undefined,
						{} as any,
					);
					assert.equal((patch.content[0] as any).text, exact);
				}
			}
			fail = true;
			const failed = await manager.wait(manager.dispatch(input).id);
			assert.equal(failed.status, "failed");
			fail = false;
			const recovered = await manager.wait(
				manager.dispatch({ ...input, replacementOf: failed.id }).id,
			);
			assert.equal(recovered.status, "completed", "Recovery must retain source type changes");
		} finally {
			await manager.close();
		}
	});
}

test("unexpected patch-to-index attribution remains fail closed", () => {
	const { root } = temporaryRepository();
	writeFileSync(join(root, "app.txt"), "after\n");
	const base = git(root, ["rev-parse", "HEAD"]);
	assert.throws(
		() =>
			reviewPatches(
				root,
				["--literal-pathspecs", "diff", ...reviewDiffOptions, base],
				["different.txt"],
				["different.txt"],
				48000,
			),
		/does not match its file index/,
	);
});

test("typechange integration preview retains both source sections", async () => {
	let host: Awaited<ReturnType<typeof reviewedProject>> | undefined;
	await assert.doesNotReject(async () => {
		host = await reviewedProject((task) => {
			rmSync(join(task.workspace.path, "app.txt"));
			symlinkSync("new-target", join(task.workspace.path, "app.txt"));
		});
	}, "Typechanging source must reach the independent review and integration preview");
	try {
		await host!.commands.get("task").handler(`${host!.builder.id} integrate`, host!.ctx);
		const preview = host!.notices.find((text) => text.includes("Review findings:"))!;
		assert.match(preview, /deleted file mode 100644/);
		assert.match(preview, /new file mode 120000/);
		assert.match(preview, /new-target/);
	} finally {
		await host!.close();
	}
});
