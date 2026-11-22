import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrap } from "../src/profile.ts";
import { defaultPolicy } from "../src/policy.ts";
import { TaskManager, type TaskResult } from "../src/orchestration/tasks.ts";
import { git } from "../src/orchestration/worktrees.ts";
import {
	WorkflowEngine,
	type WorkflowRun,
	type WorkflowDefinition,
} from "../src/platform/workflows.ts";
import type { AgentDefinition } from "../src/platform/contracts.ts";
import { ProviderRegistry } from "../src/platform/providers.ts";

const agent: AgentDefinition = {
	name: "evidence-specialist",
	instructions: "Cite evidence",
	editing: false,
	policy: { permissions: ["read"], tools: ["read"] },
};
const result: TaskResult = {
	summary: "Evidence retained",
	files: [],
	tests: [],
	findings: [],
	questions: [],
};
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "poly-workflow-recovery-"));
	const profile = join(root, "agent");
	bootstrap(profile);
	const project = join(root, "project");
	mkdirSync(project);
	git(project, ["init", "-b", "main"]);
	git(project, ["config", "user.name", "Fixture"]);
	git(project, ["config", "user.email", "fixture@example.invalid"]);
	writeFileSync(join(project, "source.txt"), "before\n");
	git(project, ["add", "."]);
	git(project, ["commit", "-m", "base"]);
	let requests = 0;
	let approvals = 0;
	const registry = new ProviderRegistry(defaultPolicy);
	const tasks = new TaskManager(
		join(profile, "tasks"),
		project,
		defaultPolicy,
		async () => {
			requests++;
			return structuredClone(result);
		},
		2,
		900000,
		undefined,
		undefined,
		registry,
	);
	const directory = join(profile, "runs");
	mkdirSync(directory);
	const hooks = {
		model: async () => "openai-codex/fixture",
		context: async () => "Bounded evidence",
		approve: async (_: any, input: any) => {
			approvals++;
			return input;
		},
	};
	const engine = () => new WorkflowEngine(directory, tasks, [agent], hooks);
	function save(
		definition: WorkflowDefinition,
		steps: WorkflowRun["steps"],
		status: WorkflowRun["status"] = "running",
	) {
		const run: WorkflowRun = {
			id: randomUUID(),
			definition,
			input: "Inspect source",
			parent: "old-session",
			status,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			steps,
		};
		writeFileSync(join(directory, `${run.id}.json`), JSON.stringify(run));
		return run;
	}
	return {
		profile,
		project,
		tasks,
		engine,
		save,
		counts: () => ({ requests, approvals }),
		registry,
	};
}
const sequential: WorkflowDefinition = {
	id: "sequential",
	steps: [
		{ id: "one", agent: agent.name, objective: "First" },
		{
			id: "two",
			agent: agent.name,
			objective: "Second",
			needs: ["one"],
			contextFrom: ["one"],
			approval: "Inspect checkpoint?",
		},
	],
};

test("explicit continuation reuses completed durable tasks even when the workflow completion notification was interrupted", async () => {
	const f = fixture();
	try {
		const completed = await f.tasks.wait(
			f.tasks.dispatch({
				parent: "old",
				role: agent,
				provider: "openai-codex",
				model: "fixture",
				brief: "First",
			}).id,
		);
		const original = f.save(sequential, {
			one: { status: "running", task: completed.id },
			two: { status: "pending" },
		});
		const engine = f.engine();
		assert.equal(engine.list()[0].status, "interrupted");
		assert.deepEqual(f.counts(), { requests: 1, approvals: 0 });
		assert.throws(
			() => engine.continueRun(original.id, "new-session", false),
			/explicitly approved/,
		);
		const next = await engine.wait(engine.continueRun(original.id, "new-session", true).id);
		assert.equal(next.status, "completed");
		assert.equal(next.continuedFrom, original.id);
		assert.equal(next.steps.one.task, completed.id);
		assert.throws(
			() => engine.continueRun(original.id, "another-session", true),
			/already has a continuation/,
		);
		assert.deepEqual(f.counts(), { requests: 2, approvals: 1 });
		assert.equal(
			JSON.parse(readFileSync(join(f.profile, "runs", `${original.id}.json`), "utf8")).status,
			"interrupted",
		);
		await engine.close();
	} finally {
		await f.tasks.close();
	}
});

test("parallel checkpoint results survive and only the approval-gated pending consumer runs", async () => {
	const f = fixture();
	try {
		const completed = await Promise.all(
			["one", "two"].map(
				async (brief) =>
					await f.tasks.wait(
						f.tasks.dispatch({
							parent: "parallel",
							role: agent,
							provider: "openai-codex",
							model: "fixture",
							brief,
						}).id,
					),
			),
		);
		const graph: WorkflowDefinition = {
			id: "parallel",
			steps: [
				{ id: "one", agent: agent.name, objective: "A" },
				{ id: "two", agent: agent.name, objective: "B" },
				{
					id: "collect",
					agent: agent.name,
					objective: "Collect",
					needs: ["one", "two"],
					contextFrom: ["one", "two"],
				},
			],
		};
		const previous = f.save(graph, {
			one: { status: "completed", task: completed[0].id },
			two: { status: "completed", task: completed[1].id },
			collect: { status: "waiting_approval" },
		});
		const engine = f.engine();
		const next = await engine.wait(engine.continueRun(previous.id, "new", true).id);
		assert.equal(next.status, "completed");
		assert.deepEqual(f.counts(), { requests: 3, approvals: 1 });
		assert.equal(f.tasks.get(next.steps.collect.task!).context.includes("Evidence retained"), true);
		await engine.close();
	} finally {
		await f.tasks.close();
	}
});

test("stale source, missing artifacts, changed provider policy and canceled runs cannot continue", async () => {
	const f = fixture();
	try {
		const completed = await f.tasks.wait(
			f.tasks.dispatch({
				parent: "old",
				role: agent,
				provider: "openai-codex",
				model: "fixture",
				brief: "First",
			}).id,
		);
		const previous = f.save(sequential, {
			one: { status: "completed", task: completed.id },
			two: { status: "pending" },
		});
		const engine = f.engine();
		writeFileSync(join(completed.workspace.path, "source.txt"), "unreviewed changes\n");
		assert.throws(() => engine.continueRun(previous.id, "new", true), /checkpoint source changed/);
		git(completed.workspace.path, ["restore", "source.txt"]);
		const providerAssert = f.registry.assert.bind(f.registry);
		f.registry.assert = () => {
			throw new Error("Provider policy changed");
		};
		assert.throws(() => engine.continueRun(previous.id, "new", true), /policy changed/);
		f.registry.assert = providerAssert;
		const broken = f.save(
			{
				...sequential,
				id: "missing-artifact",
				steps: [{ ...sequential.steps[0], artifacts: ["unavailable"] }, sequential.steps[1]],
			},
			previous.steps,
		);
		const reopened = f.engine();
		assert.throws(() => reopened.continueRun(broken.id, "new", true), /artifact contracts/);
		await engine.cancel(previous.id);
		assert.throws(() => engine.continueRun(previous.id, "new", true), /explicitly approved/);
		assert.equal(f.counts().requests, 1);
		await engine.close();
		await reopened.close();
	} finally {
		await f.tasks.close();
	}
});

test("an uncertain failed or interrupted worker is never replayed by workflow continuation", async () => {
	const f = fixture();
	try {
		const completed = await f.tasks.wait(
			f.tasks.dispatch({
				parent: "old",
				role: agent,
				provider: "openai-codex",
				model: "fixture",
				brief: "First",
			}).id,
		);
		// Persisted status fixture models a worker interrupted during consequential execution.
		const file = join(f.profile, "tasks", completed.id, "task.json");
		const record = JSON.parse(readFileSync(file, "utf8"));
		record.status = "interrupted";
		writeFileSync(file, JSON.stringify(record));
		await f.tasks.close();
		const tasks = new TaskManager(join(f.profile, "tasks"), f.project, defaultPolicy, async () => {
			throw new Error("Must not replay");
		});
		const previous = f.save(sequential, {
			one: { status: "running", task: completed.id },
			two: { status: "pending" },
		});
		const engine = new WorkflowEngine(join(f.profile, "runs"), tasks, [agent], {
			model: async () => "openai-codex/fixture",
			context: async () => "",
			approve: async (_, input) => input,
		});
		assert.throws(() => engine.continueRun(previous.id, "new", true), /unfinished worker/);
		await engine.close();
		await tasks.close();
	} finally {
		await f.tasks.close();
	}
});

test("a crash between task dispatch and workflow persistence reconciles the durable step identity without replay", async () => {
	const f = fixture();
	try {
		const previous = f.save(sequential, {
			one: { status: "waiting_approval" },
			two: { status: "pending" },
		});
		const completed = await f.tasks.wait(
			f.tasks.dispatch({
				parent: `workflow:${previous.id}`,
				workflowStep: "one",
				role: agent,
				provider: "openai-codex",
				model: "fixture",
				brief: "First",
			}).id,
		);
		const engine = f.engine();
		const continued = await engine.wait(engine.continueRun(previous.id, "new", true).id);
		assert.equal(continued.status, "completed");
		assert.equal(continued.steps.one.task, completed.id);
		assert.deepEqual(f.counts(), { requests: 2, approvals: 1 });
		await engine.close();
	} finally {
		await f.tasks.close();
	}
});

test("completed implementation and independent inspection snapshots remain reusable before an approved collection step", async () => {
	const f = fixture();
	const builder: AgentDefinition = {
		name: "change-specialist",
		instructions: "Implement",
		editing: true,
		policy: { permissions: ["read", "write"], tools: ["read", "write"] },
	};
	try {
		const implementation = await f.tasks.wait(
			f.tasks.dispatch({
				parent: "old",
				role: builder,
				provider: "openai-codex",
				model: "fixture",
				brief: "Implement",
			}).id,
		);
		const inspection = await f.tasks.wait(
			f.tasks.dispatch({
				parent: "old",
				role: agent,
				provider: "kimi-coding",
				model: "fixture",
				brief: "Inspect",
				reviewOf: implementation.id,
			}).id,
		);
		const graph: WorkflowDefinition = {
			id: "review-collection",
			steps: [
				{ id: "change", agent: builder.name, objective: "Implement" },
				{
					id: "inspect",
					agent: agent.name,
					objective: "Inspect",
					needs: ["change"],
					inspect: "change",
				},
				{
					id: "collect",
					agent: agent.name,
					objective: "Collect",
					needs: ["change", "inspect"],
					contextFrom: ["change", "inspect"],
				},
			],
		};
		const previous = f.save(graph, {
			change: { status: "completed", task: implementation.id },
			inspect: { status: "completed", task: inspection.id },
			collect: { status: "pending" },
		});
		const engine = new WorkflowEngine(join(f.profile, "runs"), f.tasks, [builder, agent], {
			model: async () => "openai-codex/fixture",
			context: async () => "",
			approve: async (_, input) => input,
		});
		const completed = await engine.wait(engine.continueRun(previous.id, "new", true).id);
		assert.equal(completed.status, "completed");
		assert.equal(completed.steps.inspect.task, inspection.id);
		assert.equal(f.counts().requests, 3);
		await engine.close();
	} finally {
		await f.tasks.close();
	}
});
