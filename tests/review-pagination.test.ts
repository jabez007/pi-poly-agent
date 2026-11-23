import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { taskContext } from "../src/orchestration/context.ts";
import { diffTool } from "../src/orchestration/tools.ts";
import { TaskManager } from "../src/orchestration/tasks.ts";
import { defaultRoles } from "../src/orchestration/roles.ts";
import { defaultPolicy } from "../src/policy.ts";
import { temporaryRepository } from "./fixtures/review-project.ts";

export function listedNames(view: string): string[] {
	return view
		.split("\n")
		.filter((line) => /^\[[^\]]+\] "/.test(line))
		.map((line) => JSON.parse(/^\[[^\]]+\] ("[^"]+")/.exec(line)![1]));
}
function nextOffset(view: string): number | undefined {
	const match = /Next file offset: (\d+)/.exec(view);
	return match ? Number(match[1]) : undefined;
}

test("packet and review_diff pages share one ordered index including refused names", async () => {
	const { root, directory } = temporaryRepository();
	const names = Array.from({ length: 600 }, (_, n) =>
		n < 30 ? `a0/${String(n).padStart(4, "0")}/.env` : `src/${String(n).padStart(4, "0")}.ts`,
	);
	const roles = defaultRoles();
	const manager = new TaskManager(
		join(directory, "tasks"),
		root,
		defaultPolicy,
		async ({ task }) => {
			if (task.role.editing)
				for (const file of names) {
					mkdirSync(dirname(join(task.workspace.path, file)), { recursive: true });
					writeFileSync(
						join(task.workspace.path, file),
						file.endsWith("/.env") ? "private fixture note\n" : "ordinary source\n",
					);
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
				brief: "Many files including refused names",
			}).id,
		);
		const packet = taskContext("", builder);
		const review = await manager.wait(
			manager.dispatch({
				parent: "fixture",
				role: roles.find((r) => r.name === "reviewer")!,
				provider: "kimi-coding",
				model: "fixture",
				brief: "Inspect fixture",
				reviewOf: builder.id,
				context: packet,
			}).id,
		);
		const tool = diffTool(review.workspace.path, review.reviewBase!);
		const first = await tool.execute(
			"fixture",
			{ path: ".", offset: 0 },
			undefined,
			undefined,
			{} as any,
		);
		const firstText = (first.content[0] as any).text as string;
		assert.deepEqual(
			listedNames(firstText),
			listedNames(packet),
			"Packet and tool first pages must contain the same ordered filenames",
		);
		assert.match(firstText, /\[refused by path policy\].*a0\/0000\/\.env/);
		assert.ok(
			!packet.includes("private fixture note"),
			"Refused entries must never contribute patch text to the packet",
		);
		const found = [...listedNames(packet).filter((name) => !name.endsWith("/.env"))];
		let offset = nextOffset(packet);
		for (let page = 0; offset !== undefined && page < 600; page++) {
			const response = await tool.execute(
				"fixture",
				{ path: ".", offset },
				undefined,
				undefined,
				{} as any,
			);
			const text = (response.content[0] as any).text as string;
			found.push(...listedNames(text).filter((name) => !name.endsWith("/.env")));
			assert.ok(!text.includes("private fixture note"));
			const next = nextOffset(text);
			assert.ok(
				next === undefined || next > offset,
				"Offsets must make progress in the same index",
			);
			offset = next;
		}
		assert.deepEqual(
			found,
			names.filter((name) => !name.endsWith("/.env")),
			"Following the packet offset must reach every allowed filename exactly once",
		);
		assert.equal(new Set(found).size, found.length);
	} finally {
		await manager.close();
	}
});
