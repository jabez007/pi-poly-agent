import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defaultPolicy } from "../src/policy.ts";
import { TaskManager, type Dispatch, type TaskResult } from "../src/orchestration/tasks.ts";
import { defaultRoles } from "../src/orchestration/roles.ts";
import { git } from "../src/orchestration/worktrees.ts";

export function fixture() {
	const root = mkdtempSync(join(tmpdir(), "poly-reliable-project-"));
	const directory = mkdtempSync(join(tmpdir(), "poly-reliable-tasks-"));
	git(root, ["init", "-b", "main"]);
	git(root, ["config", "user.name", "Fixture"]);
	git(root, ["config", "user.email", "fixture@example.invalid"]);
	writeFileSync(join(root, "app.ts"), "before\n");
	git(root, ["add", "."]);
	git(root, ["commit", "-m", "base"]);
	return { root, directory };
}
export const result: TaskResult = {
	summary: "Done",
	files: [],
	tests: [],
	findings: [],
	questions: [],
};
export function dispatch(role = "builder", provider = "openai-codex"): Dispatch {
	return {
		parent: "parent-session",
		role: defaultRoles().find((r) => r.name === role)!,
		provider,
		model: "fixture",
		brief: "Implement and verify the focused change",
	};
}

test("a project host lease prevents a second manager from interrupting live tasks", async () => {
	const { root, directory } = fixture();
	const manager = new TaskManager(directory, root, defaultPolicy, async () => result);
	try {
		assert.throws(
			() => new TaskManager(directory, root, defaultPolicy, async () => result),
			/host|lease/i,
		);
	} finally {
		await manager.close();
	}
	const restarted = new TaskManager(directory, root, defaultPolicy, async () => result);
	await restarted.close();
});

test("only the reviewer role can produce an integration review", async () => {
	const { root, directory } = fixture();
	const manager = new TaskManager(directory, root, defaultPolicy, async () => result);
	try {
		const builder = await manager.wait(manager.dispatch(dispatch()).id);
		assert.throws(
			() => manager.dispatch({ ...dispatch("planner"), reviewOf: builder.id }),
			/reviewer/i,
		);
	} finally {
		await manager.close();
	}
});

test("killed host recovery preserves source, sessions, history, and explicitly creates a new authorized worker", async () => {
	const { root, directory } = fixture();
	const child = await crashedHost(root, directory);
	let requests = 0;
	const manager = new TaskManager(directory, root, defaultPolicy, async ({ task }) => {
		requests++;
		assert.equal(
			readFileSync(join(task.workspace.path, "recovered.ts"), "utf8"),
			"preserved crash changes\n",
		);
		writeFileSync(join(task.workspace.path, "app.ts"), "replacement changes\n");
		return result;
	});
	try {
		const old = manager.get(child.id);
		assert.equal(old.status, "interrupted");
		assert.match(old.sessionFile!, /fixture.jsonl$/);
		assert.match(old.recovery!.join(" "), /Uncommitted/);
		assert.equal(requests, 0, "restart never replays a request");
		assert.throws(
			() => manager.dispatch({ ...dispatch("builder", "antigravity-acp"), replacementOf: old.id }),
			/authorized/,
		);
		const replaced = await manager.wait(
			manager.dispatch({ ...dispatch(), replacementOf: old.id }).id,
		);
		assert.equal(replaced.status, "completed");
		assert.equal(replaced.replacementOf, old.id);
		assert.equal(manager.get(old.id).replacedBy, replaced.id);
		assert.equal(manager.get(old.id).status, "interrupted");
		assert.equal(readFileSync(join(root, "app.ts"), "utf8"), "before\n");
		const review = await manager.wait(
			manager.dispatch({ ...dispatch("reviewer", "kimi-coding"), reviewOf: replaced.id }).id,
		);
		assert.equal(review.reviewRevision, replaced.revision);
		manager.integrate(replaced.id);
		assert.equal(
			readFileSync(join(root, "recovered.ts"), "utf8"),
			"preserved crash changes\n",
			"integration includes recovered changes, not just the last worker edit",
		);
		assert.equal(manager.get(replaced.id).integration!.state, "integrated");
		assert.throws(() => manager.integrate(replaced.id), /already/);
	} finally {
		await manager.close();
	}
	const reopened = new TaskManager(directory, root, defaultPolicy, async () => {
		throw new Error("must not execute");
	});
	assert.equal(reopened.list().length, 3);
	assert.equal(
		reopened.list().find((t) => t.integration?.state === "integrated")!.status,
		"completed",
	);
	await reopened.close();
});

import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { atomicRecord } from "../src/orchestration/storage.ts";
import {
	createWorkspace,
	workspaceDiff,
	cleanupWorkspace,
} from "../src/orchestration/worktrees.ts";
import { importNodeDependencies, worktreeReadiness } from "../src/orchestration/preparation.ts";
import { safeFailure, classifyFailure } from "../src/orchestration/errors.ts";
import { qualificationPlan } from "../src/orchestration/qualification.ts";
async function crashedHost(root: string, directory: string): Promise<{ id: string }> {
	const child = spawn(
		process.execPath,
		["--import", "tsx", "tests/fixtures/task-host.ts", root, directory],
		{ stdio: ["ignore", "ignore", "pipe", "ipc"] },
	);
	const exited = once(child, "exit");
	const ready: any = await Promise.race([
		once(child, "message"),
		exited.then(() => {
			throw new Error("Host exited before fixture was ready");
		}),
	]);
	child.kill("SIGKILL");
	await exited;
	return ready[0];
}

test("atomic records retain the last complete state, report damaged and orphaned records, and detect missing worktrees", async () => {
	const { root, directory } = fixture();
	const manager = new TaskManager(directory, root, defaultPolicy, async () => result);
	const task = await manager.wait(manager.dispatch(dispatch()).id);
	await manager.close();
	writeFileSync(join(directory, task.id, "task.json.crash.tmp"), '{"status":');
	const malformed = "00000000-0000-0000-0000-000000000001";
	mkdirSync(join(directory, malformed));
	writeFileSync(join(directory, malformed, "task.json"), '{"broken":');
	const orphan = "00000000-0000-0000-0000-000000000002";
	mkdirSync(join(directory, orphan));
	rmSync(task.workspace.path, { recursive: true });
	const restarted = new TaskManager(directory, root, defaultPolicy, async () => result);
	assert.equal(restarted.get(task.id).status, "completed");
	assert.match(restarted.get(task.id).recovery!.join(" "), /missing/);
	assert.equal(restarted.diagnostics.length, 2);
	assert.ok(existsSync(join(directory, malformed, "task.json")));
	assert.throws(() => restarted.dispatch({ ...dispatch(), replacementOf: task.id }), /inactive/);
	await restarted.close();
	atomicRecord(join(directory, "atomic.json"), { state: "complete" });
	assert.deepEqual(JSON.parse(readFileSync(join(directory, "atomic.json"), "utf8")), {
		state: "complete",
	});
});

test("integration rejects stale reviews, changed snapshots, parent branch changes, dirty trees, detached heads and unfinished Git operations", async () => {
	const { root, directory } = fixture();
	const manager = new TaskManager(directory, root, defaultPolicy, async ({ task }) => {
		if (task.role.editing) writeFileSync(join(task.workspace.path, "app.ts"), "after\n");
		return result;
	});
	const builder = await manager.wait(manager.dispatch(dispatch()).id);
	await manager.wait(
		manager.dispatch({ ...dispatch("reviewer", "kimi-coding"), reviewOf: builder.id }).id,
	);
	writeFileSync(join(builder.workspace.path, "app.ts"), "changed after review\n");
	assert.throws(() => manager.integrate(builder.id), /changed/);
	git(builder.workspace.path, ["restore", "app.ts"]);
	git(root, ["switch", "-c", "another"]);
	assert.throws(() => manager.integrate(builder.id), /branch changed/);
	git(root, ["switch", "main"]);
	writeFileSync(join(root, "dirty.txt"), "user data");
	assert.throws(() => manager.integrate(builder.id), /clean/);
	rmSync(join(root, "dirty.txt"));
	git(root, ["checkout", "--detach"]);
	assert.throws(() => manager.integrate(builder.id));
	git(root, ["switch", "main"]);
	writeFileSync(join(root, ".git", "CHERRY_PICK_HEAD"), builder.revision! + "\n");
	assert.throws(() => manager.integrate(builder.id), /unfinished/);
	rmSync(join(root, ".git", "CHERRY_PICK_HEAD"));
	writeFileSync(join(root, "app.ts"), "conflicting parent changes\n");
	git(root, ["add", "."]);
	git(root, ["commit", "-m", "parent advanced"]);
	assert.throws(() => manager.integrate(builder.id), /moved/);
	assert.equal(readFileSync(join(root, "app.ts"), "utf8"), "conflicting parent changes\n");
	await manager.close();
	// Rewrite only the fixture's persisted snapshot to model a stale review association.
	const file = join(directory, builder.id, "task.json");
	const stored = JSON.parse(readFileSync(file, "utf8"));
	stored.revision = git(root, ["rev-parse", "HEAD"]);
	atomicRecord(file, stored);
	const restarted = new TaskManager(directory, root, defaultPolicy, async () => result);
	assert.throws(() => restarted.integrate(builder.id), /exact snapshot/);
	await restarted.close();
});

test("worktree preparation detects Node/Python/Go prerequisites and imports screened dependencies without installers", () => {
	const { root, directory } = fixture();
	writeFileSync(join(root, "package.json"), '{"name":"fixture"}');
	writeFileSync(join(root, ".gitignore"), "node_modules/\n");
	writeFileSync(join(root, "pyproject.toml"), "[project]\n");
	writeFileSync(join(root, "go.mod"), "module example.invalid/fixture\n");
	git(root, ["add", "."]);
	git(root, ["commit", "-m", "manifests"]);
	const workspace = createWorkspace(root, directory, "prepare");
	assert.deepEqual(
		worktreeReadiness(workspace.path).map((p) => p.kind),
		["node", "python", "go"],
	);
	assert.equal(worktreeReadiness(workspace.path)[0].ready, false);
	assert.throws(() => importNodeDependencies(workspace), /missing/);
	mkdirSync(join(root, "node_modules", "fixture"), { recursive: true });
	writeFileSync(join(root, "node_modules", "fixture", "index.js"), "module.exports = 42;\n");
	importNodeDependencies(workspace);
	assert.equal(worktreeReadiness(workspace.path)[0].ready, true);
	assert.equal(
		readFileSync(join(workspace.path, "node_modules", "fixture", "index.js"), "utf8"),
		"module.exports = 42;\n",
	);
	assert.deepEqual(workspaceDiff(workspace).files, []);
	rmSync(join(workspace.path, "node_modules"), { recursive: true });
	writeFileSync(join(root, "node_modules", ".env"), "credential file");
	assert.throws(() => importNodeDependencies(workspace), /Sensitive/);
	assert.equal(existsSync(join(workspace.path, "node_modules")), false);
	rmSync(join(root, "node_modules", ".env"));
	symlinkSync(join(root, "app.ts"), join(root, "node_modules", "outside"));
	assert.throws(() => importNodeDependencies(workspace), /symlink/);
	cleanupWorkspace(workspace);
});

test("provider failures retain useful categories without raw bodies, retries, or billing fallback", async () => {
	for (const [message, expected] of [
		["401 Unauthorized Bearer private-value", "authentication"],
		["429 quota exceeded", "quota"],
		["context window exhausted", "context"],
		["socket ECONNRESET", "transport"],
		["model not found", "model"],
		["503 provider unavailable", "unavailable"],
		["sandbox tool failed", "tool"],
	]) {
		const failure = safeFailure(new Error(message));
		assert.equal(failure.code, expected);
		assert.equal(classifyFailure(failure.message), expected);
		assert.ok(!failure.message.includes("private-value"));
	}
	const { root, directory } = fixture();
	let calls = 0;
	const manager = new TaskManager(directory, root, defaultPolicy, async () => {
		calls++;
		throw Object.assign(new Error("quota reached Bearer private-value"), { status: 429 });
	});
	const failed = await manager.wait(manager.dispatch(dispatch()).id);
	assert.equal(failed.failureCode, "quota");
	assert.equal(calls, 1);
	assert.ok(!JSON.stringify(failed).includes("private-value"));
	await manager.close();
});

test("qualification is a non-authenticated plan for native providers only", () => {
	for (const provider of ["openai-codex", "kimi-coding", "zai"]) {
		const plan = qualificationPlan(provider);
		assert.equal(plan.scenarios.length, 13);
		assert.ok(plan.scenarios.every((s) => s.outcome === "not-run"));
	}
	assert.throws(() => qualificationPlan("antigravity-acp"), /only native/);
});

test(
	"killing a host terminates its owned Bubblewrap process without touching unrelated sessions",
	{ skip: process.env.PI_POLY_SANDBOX_TEST !== "1", timeout: 15000 },
	async () => {
		const { root, directory } = fixture();
		const child = spawn(
			process.execPath,
			["--import", "tsx", "tests/fixtures/task-host.ts", root, directory, "sandbox"],
			{ stdio: ["ignore", "ignore", "pipe", "ipc"] },
		);
		const exited = once(child, "exit");
		try {
			await once(child, "message");
			const ids = readFileSync(`/proc/${child.pid}/task/${child.pid}/children`, "utf8")
				.trim()
				.split(/\s+/)
				.map(Number)
				.filter(Boolean);
			assert.ok(ids.length > 0, "host owns an actual sandbox process");
			await new Promise((resolve) => setTimeout(resolve, 100));
			child.kill("SIGKILL");
			await exited;
			const alive = (id: number) => {
				try {
					return !readFileSync(`/proc/${id}/stat`, "utf8").slice(-500).includes(") Z ");
				} catch {
					return false;
				}
			};
			for (let attempt = 0; attempt < 50 && ids.some(alive); attempt++)
				await new Promise((resolve) => setTimeout(resolve, 20));
			assert.ok(
				ids.every((id) => !alive(id)),
				"sandbox child exits on parent death",
			);
			assert.equal(process.kill(process.pid, 0), true, "unrelated test host is alive");
		} finally {
			child.kill("SIGKILL");
		}
	},
);

test("interrupted integration is visible on restart and is never automatically replayed", async () => {
	const { root, directory } = fixture();
	const manager = new TaskManager(directory, root, defaultPolicy, async () => result);
	const task = await manager.wait(manager.dispatch(dispatch()).id);
	await manager.close();
	const file = join(directory, task.id, "task.json");
	const record = JSON.parse(readFileSync(file, "utf8"));
	record.integration = {
		state: "integrating",
		revision: task.revision,
		parentBefore: task.workspace.base,
	};
	atomicRecord(file, record);
	const before = git(root, ["rev-parse", "HEAD"]);
	const restarted = new TaskManager(directory, root, defaultPolicy, async () => {
		throw new Error("No replay");
	});
	assert.equal(restarted.get(task.id).integration!.state, "interrupted");
	assert.match(restarted.get(task.id).recovery!.join(" "), /Integration was interrupted/);
	assert.equal(git(root, ["rev-parse", "HEAD"]), before);
	await restarted.close();
});

import { focusedContext, taskContext } from "../src/orchestration/context.ts";
import type { Handoff } from "../src/memory.ts";
test("focused task context preserves certainty and sources, bounds oversized results, and excludes private sessions", () => {
	const handoff = {
		provenance: {
			session: "source-session",
			provider: "openai-codex",
			revision: "abc",
			timestamp: "2026-11-21",
		},
		facts: [
			{ text: "Use isolated worktrees", source: "src/worktrees.ts:10", verified: true },
			{ text: "Possible optimization", source: "review.ts:2", verified: false },
		],
		decisions: ["Keep Pi"],
		files: ["src/app.ts"],
		questions: ["Which model?"],
	} as unknown as Handoff;
	const selected = focusedContext(handoff, "Attributed project memory", 700);
	assert.match(selected, /Verified fact: Use isolated worktrees/);
	assert.match(selected, /Unverified claim: Possible optimization/);
	assert.match(selected, /src\/worktrees.ts:10/);
	assert.ok(selected.length <= 700);
	const context = taskContext(
		selected,
		{
			id: "prior",
			provider: "kimi-coding",
			model: "fixture",
			brief: "Build one change",
			workspace: { base: "abc" },
			context: "Old constraint",
			sessionFile: "/private/provider-session.jsonl",
			result: {
				...result,
				summary: "x".repeat(48000),
				findings: [{ text: "Suspected bug", source: "app.ts:4", severity: "warning" }],
			},
		} as any,
		1200,
	);
	assert.ok(context.length <= 1200);
	assert.match(context, /Unverified warning finding/);
	assert.match(context, /app.ts:4/);
	assert.match(context, /Old constraint/);
	assert.ok(!context.includes("provider-session"));
});

import { approvedTest } from "../src/orchestration/tools.ts";
test(
	"approved preparation uses the real sandbox, records exit status, and refuses denied commands",
	{ skip: process.env.PI_POLY_SANDBOX_TEST !== "1" },
	async () => {
		const { root, directory } = fixture();
		const manager = new TaskManager(directory, root, defaultPolicy, async () => result);
		try {
			const task = await manager.wait(manager.dispatch(dispatch()).id);
			const command = "node -e 'console.log(6 * 7)'";
			await assert.rejects(
				approvedTest(command, task.workspace.path, async () => false, new AbortController().signal),
				/denied/,
			);
			const output = await approvedTest(
				command,
				task.workspace.path,
				async () => true,
				new AbortController().signal,
			);
			assert.equal(output.exitCode, 0);
			assert.match(output.output, /42/);
			manager.recordPreparation(task.id, command, output.exitCode);
			assert.deepEqual(manager.get(task.id).preparation, [{ command, exitCode: 0 }]);
		} finally {
			await manager.close();
		}
	},
);

test("malformed host ownership fails closed without exposing record contents", () => {
	const { root, directory } = fixture();
	writeFileSync(join(directory, "host.json"), "{private-lease-body");
	assert.throws(
		() => new TaskManager(directory, root, defaultPolicy, async () => result),
		(error) =>
			error instanceof Error &&
			error.message.includes("Values withheld") &&
			!error.message.includes("private-lease-body"),
	);
	assert.equal(readFileSync(join(directory, "host.json"), "utf8"), "{private-lease-body");
});
