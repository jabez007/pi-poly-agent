import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { TaskManager } from "../src/orchestration/tasks.ts";
import { defaultRoles } from "../src/orchestration/roles.ts";
import { defaultPolicy } from "../src/policy.ts";
import { ReviewBudgetError } from "../src/orchestration/errors.ts";
import { taskContext } from "../src/orchestration/context.ts";
import { reviewDiffView } from "../src/orchestration/review-view.ts";
import { temporaryRepository } from "./fixtures/review-project.ts";

for (const count of [1, 60]) {
	test(`required review size is exact for ${count} changed files`, async () => {
		const { root, directory } = temporaryRepository();
		const roles = defaultRoles();
		const manager = new TaskManager(
			join(directory, "tasks"),
			root,
			defaultPolicy,
			async ({ task }) => {
				if (task.role.editing)
					for (let n = 0; n < count; n++)
						writeFileSync(
							join(task.workspace.path, `source-${String(n).padStart(3, "0")}.txt`),
							"after\n",
						);
				return { summary: "Done", files: [], tests: [], findings: [], questions: [] };
			},
		);
		const input = {
			parent: "fixture",
			role: roles.find((r) => r.name === "builder")!,
			provider: "openai-codex",
			model: "fixture",
			brief: "Minimum budget fixture",
		};
		try {
			const builder = await manager.wait(manager.dispatch(input).id);
			for (const offset of count === 1 ? [0] : [0, 55]) {
				const view = (budget: number) =>
					reviewDiffView(
						builder.workspace.path,
						builder.workspace.base,
						builder.revision!,
						[],
						budget,
						{ offset },
					);
				let required = 0;
				assert.throws(
					() => view(1),
					(error: ReviewBudgetError) => {
						required = error.required;
						return required > 1;
					},
				);
				assert.equal(
					view(required).length,
					required,
					"The reported minimum must equal the whole view's actual metadata size",
				);
				assert.throws(
					() => view(required - 1),
					(error: ReviewBudgetError) => error.required === required,
				);
			}
			let required = 0;
			assert.throws(
				() => taskContext("Knowledge", builder, 256),
				(error: ReviewBudgetError) => {
					required = error.required;
					return required > 256;
				},
			);
			const packet = taskContext("Knowledge", builder, required);
			const review = await manager.wait(
				manager.dispatch({
					...input,
					role: {
						...roles.find((r) => r.name === "reviewer")!,
						policy: { contextBudget: required },
					},
					provider: "kimi-coding",
					reviewOf: builder.id,
					context: packet,
				}).id,
			);
			assert.equal(review.status, "completed");
			assert.equal(review.context, packet);
			assert.throws(
				() => taskContext("Knowledge", builder, required - 1),
				(error: ReviewBudgetError) => error.required === required,
			);
		} finally {
			await manager.close();
		}
	});
}
