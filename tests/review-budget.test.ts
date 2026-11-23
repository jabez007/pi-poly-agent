import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { taskContext } from "../src/orchestration/context.ts";
import { safeFailure } from "../src/orchestration/errors.ts";
import { TaskManager } from "../src/orchestration/tasks.ts";
import { defaultRoles } from "../src/orchestration/roles.ts";
import { defaultPolicy } from "../src/policy.ts";
import { temporaryRepository } from "./fixtures/review-project.ts";

for (const count of [60, 600]) {
	for (const budget of [1500, 3000, 5000, 6000, 6500, ...(count === 60 ? [256] : [])]) {
		test(`${count} files with context budget ${budget} dispatch or report the required size`, async () => {
			const { root, directory } = temporaryRepository();
			const roles = defaultRoles();
			const manager = new TaskManager(
				join(directory, "tasks"),
				root,
				defaultPolicy,
				async ({ task }) => {
					if (task.role.editing) {
						mkdirSync(join(task.workspace.path, "src"));
						for (let n = 0; n < count; n++)
							writeFileSync(
								join(task.workspace.path, `src/${String(n).padStart(4, "0")}.ts`),
								"ordinary source\n",
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
						brief: "Context-budget fixture",
					}).id,
				);
				let packet: string | undefined, failure: unknown;
				try {
					packet = taskContext("Project knowledge", builder, budget);
				} catch (error) {
					failure = error;
				}
				if (failure) {
					const message = String(failure);
					const match =
						/requires at least (\d+) characters.*configured context budget is (\d+)/.exec(message);
					assert.ok(
						match,
						"Packet refusal must name the required size and configured context budget",
					);
					assert.ok(Number(match[1]) > budget);
					assert.equal(Number(match[2]), budget);
					assert.match(
						safeFailure(failure).message,
						/requires at least/,
						"Workflow failure reporting must retain safe numeric size diagnostics",
					);
					return;
				}
				assert.notEqual(budget, 256, "A minimal context budget must refuse with a required size");
				assert.ok(packet!.length <= budget);
				assert.match(
					packet!,
					/Review diff:/,
					"The required view must never be dropped by the context selector",
				);
				const role = roles.find((r) => r.name === "reviewer")!;
				const review = await manager.wait(
					manager.dispatch({
						parent: "fixture",
						role: { ...role, policy: { ...role.policy, contextBudget: budget } },
						provider: "kimi-coding",
						model: "fixture",
						brief: "Review",
						reviewOf: builder.id,
						context: packet,
					}).id,
				);
				assert.equal(review.status, "completed");
				assert.equal(review.context, packet);
			} finally {
				await manager.close();
			}
		});
	}
}
