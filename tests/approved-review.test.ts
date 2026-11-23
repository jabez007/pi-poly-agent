import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { taskContext } from "../src/orchestration/context.ts";
import { TaskManager } from "../src/orchestration/tasks.ts";
import { defaultRoles } from "../src/orchestration/roles.ts";
import { defaultPolicy } from "../src/policy.ts";
import { temporaryRepository } from "./fixtures/review-project.ts";
import { WorkflowEngine } from "../src/platform/workflows.ts";

async function preparedReview() {
	const { root, directory } = temporaryRepository();
	const observed: string[] = [];
	const manager = new TaskManager(
		join(directory, "tasks"),
		root,
		defaultPolicy,
		async ({ task }) => {
			if (task.role.editing)
				writeFileSync(join(task.workspace.path, "app.txt"), "changed line\n".repeat(150));
			else observed.push(task.context!);
			return { summary: "Done", files: [], tests: [], findings: [], questions: [] };
		},
	);
	const builder = await manager.wait(
		manager.dispatch({
			parent: "fixture",
			role: defaultRoles().find((r) => r.name === "builder")!,
			provider: "openai-codex",
			model: "fixture",
			brief: "Change fixture",
		}).id,
	);
	const input = {
		parent: "fixture",
		role: defaultRoles().find((r) => r.name === "reviewer")!,
		provider: "kimi-coding",
		model: "fixture",
		brief: "Review fixture",
		reviewOf: builder.id,
	};
	return { manager, builder, input, observed };
}

test("review dispatch delivers the approved packet byte for byte with one view and its tail", async () => {
	const fixture = await preparedReview();
	try {
		const packet = taskContext(
			"Project knowledge ".repeat(400) + "USER-APPROVED-TAIL",
			fixture.builder,
		);
		assert.ok(packet.endsWith("USER-APPROVED-TAIL"));
		const task = await fixture.manager.wait(
			fixture.manager.dispatch({ ...fixture.input, context: packet }).id,
		);
		assert.equal(task.context, packet, "Dispatch must preserve every byte of the approved packet");
		assert.deepEqual(fixture.observed, [packet]);
		assert.equal(task.context!.split("Review diff:").length - 1, 1);
	} finally {
		await fixture.manager.close();
	}
});

test("workflow inspection assembles its required view once before approval without contextFrom", async () => {
	const fixture = await preparedReview();
	const approved: string[] = [];
	const directory = join(fixture.builder.workspace.root, "../workflow-records");
	const engine = new WorkflowEngine(directory, fixture.manager, defaultRoles(), {
		model: async (agent) =>
			agent.name === "builder" ? "openai-codex/fixture" : "kimi-coding/fixture",
		context: async () => "Workflow project evidence",
		approve: async (_step, input) => {
			approved.push(input.context!);
			return input;
		},
	});
	try {
		const run = await engine.wait(
			engine.start(
				{
					id: "inspection-without-context-copy",
					steps: [
						{ id: "produce", agent: "builder", objective: "Produce fixture" },
						{
							id: "audit",
							agent: "reviewer",
							objective: "Inspect fixture",
							needs: ["produce"],
							inspect: "produce",
						},
					],
				},
				"Fixture",
				"parent",
			).id,
		);
		assert.equal(run.status, "completed");
		const review = fixture.manager.get(run.steps.audit.task!);
		assert.equal(
			review.context,
			approved[1],
			"Workflow inspection must receive its packet exactly as approved",
		);
		assert.equal(approved[1].split("Review diff:").length - 1, 1);
	} finally {
		await engine.close();
		await fixture.manager.close();
	}
});

test("review dispatch refuses an edited packet missing the exact required view", async () => {
	const fixture = await preparedReview();
	try {
		assert.throws(
			() =>
				fixture.manager.dispatch({
					...fixture.input,
					context: "Approved notes with the required view removed",
				}),
			/missing the required review view/i,
			"Removing the view must refuse execution rather than silently rewrite approval",
		);
		assert.deepEqual(fixture.observed, []);
		assert.equal(fixture.manager.list().length, 1);
	} finally {
		await fixture.manager.close();
	}
});

test("review dispatch refuses an oversized approved packet with its exact excess", async () => {
	const fixture = await preparedReview();
	try {
		const packet = taskContext("", fixture.builder);
		const oversized = packet + "x".repeat(16001 - packet.length);
		assert.throws(
			() => fixture.manager.dispatch({ ...fixture.input, context: oversized }),
			/16001.*16000.*exceeded by 1/,
			"Budget rejection must report the approved size and excess without truncation",
		);
		assert.deepEqual(fixture.observed, []);
	} finally {
		await fixture.manager.close();
	}
});
