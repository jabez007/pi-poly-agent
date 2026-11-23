import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { taskContext } from "../src/orchestration/context.ts";
import { diffTool } from "../src/orchestration/tools.ts";
import { TaskManager } from "../src/orchestration/tasks.ts";
import { defaultRoles } from "../src/orchestration/roles.ts";
import { defaultPolicy } from "../src/policy.ts";
import { temporaryRepository } from "./fixtures/review-project.ts";

const roles = defaultRoles();
for (const [count, long] of [
	[600, false],
	[300, true],
] as const) {
	test(`review dispatch bounds the manifest for ${count} ${long ? "long" : "short"} paths`, async () => {
		const { root, directory } = temporaryRepository();
		const names = Array.from(
			{ length: count },
			(_, n) => `sources/${String(n).padStart(4, "0")}${long ? "-" + "name".repeat(50) : ""}.txt`,
		);
		const manager = new TaskManager(
			join(directory, "tasks"),
			root,
			defaultPolicy,
			async ({ task }) => {
				if (task.role.editing) {
					mkdirSync(join(task.workspace.path, "sources"));
					for (const file of names)
						writeFileSync(join(task.workspace.path, file), "fixture change\n");
				}
				return { summary: "Done", files: [], tests: [], findings: [], questions: [] };
			},
		);
		try {
			const builder = await manager.wait(
				manager.dispatch({
					parent: "fixture",
					role: roles.find((r) => r.name === "builder")!,
					provider: "openai-codex",
					model: "fixture",
					brief: "Many files",
				}).id,
			);
			assert.equal(builder.status, "completed");
			const packet = taskContext("Knowledge", builder);
			assert.match(
				packet,
				/Files not listed in this view: \d+/,
				"Approval packet must disclose the bounded manifest before dispatch",
			);
			assert.match(packet, /git .*--numstat/);
			let review;
			assert.doesNotThrow(() => {
				review = manager.dispatch({
					parent: "fixture",
					role: roles.find((r) => r.name === "reviewer")!,
					provider: "kimi-coding",
					model: "fixture",
					brief: "Review many files",
					reviewOf: builder.id,
					context: packet,
				});
			}, "File count must not prevent review dispatch");
			const reviewed = await manager.wait(review!.id);
			assert.equal(reviewed.status, "completed");
			assert.ok(reviewed.context!.length <= 16000);
			const found = new Set<string>();
			let offset = 0;
			for (let page = 0; page < count + 1; page++) {
				const output = await diffTool(reviewed.workspace.path, reviewed.reviewBase!).execute(
					"fixture",
					{ path: ".", offset },
					undefined,
					undefined,
					{} as any,
				);
				const view = (output.content[0] as any).text as string;
				assert.ok(view.length <= 48000, "Paginated tool output stays bounded");
				for (const file of names) if (view.includes(JSON.stringify(file))) found.add(file);
				const next = /Next file offset: (\d+)/.exec(view);
				if (!next) break;
				assert.ok(Number(next[1]) > offset, "Pagination must make progress");
				offset = Number(next[1]);
			}
			assert.equal(
				found.size,
				count,
				"Every changed filename remains discoverable through review_diff",
			);
		} finally {
			await manager.close();
		}
	});
}

test("task context names oversized parts instead of silently dropping them", () => {
	const packet = taskContext("Project knowledge " + "x".repeat(20000), undefined, 512);
	assert.match(
		packet,
		/Omitted for context budget:.*Project knowledge/,
		"The approval packet must name dropped project knowledge",
	);
	assert.ok(packet.length <= 512);
});
