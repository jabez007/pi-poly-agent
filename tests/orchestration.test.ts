import { taskContext } from "../src/orchestration/context.ts";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAssistantMessageEventStream, type Provider } from "@earendil-works/pi-ai";
import { bootstrap } from "../src/profile.ts";
import { defaultPolicy } from "../src/policy.ts";
import { assertDelegation, providerCapabilities } from "../src/orchestration/capabilities.ts";
import { defaultRoles, loadOrchestration } from "../src/orchestration/roles.ts";
import { TaskManager, type TaskResult } from "../src/orchestration/tasks.ts";
import { createPiRunner, nativeWorkerProvider } from "../src/orchestration/runner.ts";
import {
	git,
	workspaceDiff,
	integrateWorkspace,
	cleanupWorkspace,
} from "../src/orchestration/worktrees.ts";
import { scopedPath, scopedTools, sandboxedTest, testTool } from "../src/orchestration/tools.ts";

function repository() {
	const root = mkdtempSync(join(tmpdir(), "poly-orchestration-"));
	git(root, ["init", "-b", "main"]);
	git(root, ["config", "user.name", "Fixture"]);
	git(root, ["config", "user.email", "fixture@example.invalid"]);
	writeFileSync(join(root, "app.ts"), "export const answer = 0;\n");
	git(root, ["add", "."]);
	git(root, ["commit", "-m", "Fixture base"]);
	return root;
}
const result: TaskResult = {
	summary: "Fixture complete",
	files: [],
	tests: [],
	findings: [],
	questions: [],
};
const role = (name: string) => defaultRoles().find((r) => r.name === name)!;
const input = (name = "researcher", provider = "openai-codex") => ({
	parent: "parent-session",
	role: role(name),
	provider,
	model: "fixture-model",
	brief: "Implement answer = 42 and independently inspect it",
});

test("capabilities deny Google, Claude, unknown endpoints, nested delegation, and unapproved billing", () => {
	const policy = defaultPolicy();
	for (const provider of ["antigravity-acp", "claude-bridge", "unknown", "zai"])
		assert.throws(() => assertDelegation(provider, policy, 1));
	policy.google.enabled = true;
	policy.claude = {
		enabled: true,
		mode: "bridge",
		review: "2026-11-25.1",
		runtime: "/reviewed/claude",
		sha256: "a".repeat(64),
	};
	for (const provider of ["antigravity-acp", "claude-bridge"]) {
		assert.equal(providerCapabilities(provider, policy).direct, true);
		assert.throws(() => assertDelegation(provider, policy, 1));
	}
	assert.throws(() => assertDelegation("openai-codex", policy, 2));
	assert.doesNotThrow(() => assertDelegation("kimi-coding", policy, 1));
	assert.deepEqual(
		defaultRoles().map((r) => r.name),
		["planner", "builder", "reviewer", "researcher"],
	);
	const dir = mkdtempSync(join(tmpdir(), "poly-role-config-"));
	writeFileSync(
		join(dir, "orchestration.json"),
		JSON.stringify({ roles: { reviewer: { model: "kimi-coding/model", editing: true } } }),
	);
	assert.equal(loadOrchestration(dir).roles.find((r) => r.name === "reviewer")!.editing, false);
});

test("two concurrent tasks, limit, cancellation, timeouts, failures and restart recovery", async () => {
	const root = repository();
	const store = mkdtempSync(join(tmpdir(), "poly-task-state-"));
	const manager = new TaskManager(
		store,
		root,
		defaultPolicy,
		async ({ signal }) => {
			await new Promise<void>((resolve) =>
				signal.addEventListener("abort", () => resolve(), { once: true }),
			);
			return result;
		},
		2,
		10000,
	);
	const one = manager.dispatch(input());
	const two = manager.dispatch(input());
	assert.notEqual(one.workspace.path, two.workspace.path);
	assert.equal(one.parent, "parent-session");
	assert.throws(() => manager.dispatch(input()), /concurrency/);
	await manager.cancel(one.id);
	assert.equal(manager.get(one.id).status, "canceled");
	assert.throws(() => new TaskManager(store, root, defaultPolicy, async () => result), /host/);
	await manager.close();
	const recovered = new TaskManager(store, root, defaultPolicy, async () => result);
	assert.equal(recovered.get(two.id).status, "canceled");
	await recovered.close();
	const failed = new TaskManager(
		mkdtempSync(join(tmpdir(), "poly-fail-")),
		root,
		defaultPolicy,
		async () => {
			throw new Error("Bearer secret-value");
		},
	);
	const bad = failed.dispatch(input());
	assert.equal((await failed.wait(bad.id)).status, "failed");
	assert.ok(!JSON.stringify(failed.list()).includes("secret-value"));
	const timed = new TaskManager(
		mkdtempSync(join(tmpdir(), "poly-timeout-")),
		root,
		defaultPolicy,
		async ({ signal }) => {
			await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
			return result;
		},
		2,
		10,
	);
	const expired = timed.dispatch(input());
	assert.equal((await timed.wait(expired.id)).status, "timed_out");
});

test("read-only workers cannot access parent, secrets, symlinks, shell tools, or write source", async () => {
	const root = repository();
	for (const path of [
		"../other",
		join(tmpdir(), "outside"),
		".git/config",
		".poly/agent/auth.json",
		".env.local",
	])
		assert.throws(() => scopedPath(root, path));
	symlinkSync(tmpdir(), join(root, "link"));
	assert.throws(() => scopedPath(root, "link/file"));
	const tools = scopedTools(root, false);
	assert.deepEqual(
		tools.map((t) => t.name),
		["read"],
	);
	assert.equal(scopedPath(root, "app.ts"), join(root, "app.ts"));
	writeFileSync(join(root, "secret.ts"), "Bearer fixture-sensitive-data");
	await assert.rejects(
		tools[0].execute("read", { path: "secret.ts" }, undefined, undefined, {} as any),
		/Sensitive/,
	);
});

function replayProvider(id: string, requests: any[]): Provider {
	const provider = nativeWorkerProvider(id);
	const model = { ...provider.getModels()[0], id: "fixture-model", provider: id };
	let turn = 0;
	const stream = (selected: any, context: any) => {
		requests.push({ provider: id, model: selected.id, context });
		const s = createAssistantMessageEventStream();
		queueMicrotask(() => {
			const content: any[] =
				turn++ === 0
					? id === "openai-codex"
						? [
								{
									type: "toolCall",
									id: "edit-fixture",
									name: "write",
									arguments: { path: "app.ts", content: "export const answer = 42;\n" },
								},
							]
						: [
								{
									type: "toolCall",
									id: "review-fixture",
									name: context.messages.some(
										(message: any) =>
											message.role === "system" &&
											message.toolsAdded?.some((tool: any) => tool.name === "review_diff"),
									)
										? "review_diff"
										: "read",
									arguments: { path: "app.ts" },
								},
							]
					: [
							{
								type: "text",
								text: JSON.stringify({
									...result,
									summary:
										id === "openai-codex" ? "Implemented answer" : "Independent review complete",
									findings:
										id === "kimi-coding"
											? [
													{
														text: "Answer is 42; verify runtime expectations",
														source: "app.ts:1",
														severity: "info",
													},
												]
											: [],
								}),
							},
						];
			const message: any = {
				role: "assistant",
				content,
				api: model.api,
				provider: id,
				model: model.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: content[0].type === "toolCall" ? "toolUse" : "stop",
				timestamp: Date.now(),
			};
			s.push({ type: "done", reason: message.stopReason, message });
			s.end();
		});
		return s;
	};
	return {
		...provider,
		auth: {
			apiKey: {
				name: "Fixture only",
				check: async () => ({ configured: true }),
				resolve: async () => ({ auth: { apiKey: "fixture-no-network" } }),
			} as any,
		},
		getModels: () => [model],
		getAllModels: () => [model],
		stream: stream as any,
		streamSimple: stream as any,
	};
}

test("real independent Pi SDK sessions implement with Codex and review with Kimi in separate worktrees", async () => {
	const root = repository();
	const profile = mkdtempSync(join(tmpdir(), "poly-workflow-"));
	bootstrap(profile);
	const policy = defaultPolicy();
	policy.kimiApiKey = true;
	writeFileSync(join(profile, "poly.json"), JSON.stringify(policy));
	const requests: any[] = [];
	const runner = createPiRunner(
		profile,
		async () => false,
		(id) => replayProvider(id, requests),
	);
	const manager = new TaskManager(join(profile, "tasks"), root, () => policy, runner);
	const builder = manager.dispatch(input("builder"));
	const built = await manager.wait(builder.id);
	assert.equal(built.status, "completed", JSON.stringify(built));
	assert.deepEqual(built.result!.files, ["app.ts"]);
	assert.equal(readFileSync(join(root, "app.ts"), "utf8"), "export const answer = 0;\n");
	assert.match(workspaceDiff(built.workspace).diff, /answer = 42/);
	const reviewer = manager.dispatch({
		...input("reviewer", "kimi-coding"),
		context: taskContext(`Review builder ${built.id}. Git snapshot ${built.revision}`, built),
		reviewOf: built.id,
	});
	const reviewed = await manager.wait(reviewer.id);
	assert.equal(reviewed.status, "completed", JSON.stringify(reviewed));
	assert.equal(reviewed.reviewOf, built.id);
	assert.notEqual(reviewed.workspace.path, built.workspace.path);
	assert.equal(
		readFileSync(join(reviewed.workspace.path, "app.ts"), "utf8"),
		"export const answer = 42;\n",
	);
	assert.ok(
		requests.some((r) => r.provider === "openai-codex") &&
			requests.some((r) => r.provider === "kimi-coding"),
	);
	for (const request of requests) {
		const names = request.context.messages
			.filter((m: any) => m.role === "system")
			.flatMap((m: any) => m.toolsAdded || [])
			.map((tool: any) => tool.name);
		assert.ok(
			!names.some((name: string) =>
				["bash", "delegate_task", "subagent", "workflow"].includes(name),
			),
		);
		if (request.provider === "kimi-coding") assert.deepEqual(names.sort(), ["read", "review_diff"]);
	}
	const kimi = requests.find((r) => r.provider === "kimi-coding");
	assert.ok(
		!kimi.context.messages.some((m: any) => m.role === "toolResult"),
		"reviewer did not inherit builder transcript",
	);
	const reviewedRequest = requests.filter((r) => r.provider === "kimi-coding").at(-1);
	assert.ok(
		reviewedRequest.context.messages.some(
			(m: any) => m.role === "toolResult" && JSON.stringify(m.content).includes("answer = 42"),
		),
		"independent reviewer inspected the actual implementation diff",
	);
	assert.equal(reviewed.result!.findings[0].source, "app.ts:1");
	integrateWorkspace(built.workspace, built.revision!);
	assert.match(readFileSync(join(root, "app.ts"), "utf8"), /42/);
	cleanupWorkspace(reviewed.workspace);
	assert.equal(existsSync(reviewed.workspace.path), false);
});

test("dirty parent trees are preserved and unapproved child sessions never reach a transport", async () => {
	const root = repository();
	const store = mkdtempSync(join(tmpdir(), "poly-reject-"));
	let invoked = false;
	const manager = new TaskManager(store, root, defaultPolicy, async () => {
		invoked = true;
		return result;
	});
	for (const provider of ["antigravity-acp", "claude-bridge", "zai"])
		assert.throws(() => manager.dispatch(input("builder", provider)), /authorized/);
	writeFileSync(join(root, "app.ts"), "user's pending work\n");
	assert.throws(() => manager.dispatch(input("builder")), /Commit or stash/);
	assert.equal(invoked, false);
	assert.equal(readFileSync(join(root, "app.ts"), "utf8"), "user's pending work\n");
});

test("cancellation is bounded even when a mock transport ignores abort", async () => {
	const root = repository();
	const manager = new TaskManager(
		mkdtempSync(join(tmpdir(), "poly-ignoring-abort-")),
		root,
		defaultPolicy,
		async () => new Promise(() => {}),
	);
	const task = manager.dispatch(input());
	assert.equal((await manager.cancel(task.id)).status, "canceled");
});

test("test permissions reject unattended commands and cancellation after approval", async () => {
	const root = repository();
	const tests: string[] = [];
	const controller = new AbortController();
	const denied = testTool(root, async () => false, tests);
	await assert.rejects(
		denied.execute(
			"test",
			{ command: "touch should-not-exist" },
			controller.signal,
			undefined,
			{} as any,
		),
		/permission denied/,
	);
	const canceled = testTool(
		root,
		async () => {
			controller.abort();
			return true;
		},
		tests,
	);
	await assert.rejects(
		canceled.execute(
			"test",
			{ command: "touch should-not-exist" },
			controller.signal,
			undefined,
			{} as any,
		),
		/permission denied/,
	);
	assert.equal(existsSync(join(root, "should-not-exist")), false);
	assert.equal(tests.length, 0);
});

test(
	"Bubblewrap tests isolate HOME, billing credentials, networking, and parent writes",
	{ skip: process.env.PI_POLY_SANDBOX_TEST !== "1" },
	async () => {
		const root = repository();
		const child = mkdtempSync(join(tmpdir(), "poly-sandbox-source-"));
		const command = `test -z "$ANTHROPIC_API_KEY" && test -z "$OPENAI_API_KEY" && test "$HOME" = /home/worker && test ! -e '${root}/app.ts' && echo isolated > /workspace/proof.txt`;
		const result = await sandboxedTest(command, child, new AbortController().signal);
		assert.equal(result.exitCode, 0, result.output);
		assert.equal(readFileSync(join(child, "proof.txt"), "utf8"), "isolated\n");
		assert.equal(readFileSync(join(root, "app.ts"), "utf8"), "export const answer = 0;\n");
	},
);

test("fresh child session construction cannot enable Google, Claude, nested delegation, or model fallback", async () => {
	const root = repository();
	const profile = mkdtempSync(join(tmpdir(), "poly-child-gates-"));
	bootstrap(profile);
	let entered = 0;
	const runner = createPiRunner(
		profile,
		async () => false,
		(id) => {
			entered++;
			return nativeWorkerProvider(id);
		},
	);
	const manager = new TaskManager(join(profile, "tasks"), root, defaultPolicy, runner);
	const task = manager.dispatch({ ...input("builder"), model: "missing-fixture-model" });
	const failed = await manager.wait(task.id);
	assert.equal(failed.status, "failed");
	assert.equal(entered, 1);
	for (const provider of ["antigravity-acp", "claude-bridge", "zai"]) {
		await assert.rejects(
			runner({
				task: { ...failed, provider },
				signal: new AbortController().signal,
				progress: () => {},
			}),
			/authorized/,
		);
	}
	await assert.rejects(
		runner({
			task: { ...failed, depth: 2 } as any,
			signal: new AbortController().signal,
			progress: () => {},
		}),
		/depth/,
	);
	assert.equal(entered, 1, "forbidden child initialization never loads a provider transport");
});

test("two real Pi SDK sessions execute concurrently with independent provider and worktree contexts", async () => {
	const root = repository();
	const profile = mkdtempSync(join(tmpdir(), "poly-parallel-sdk-"));
	bootstrap(profile);
	const policy = defaultPolicy();
	policy.kimiApiKey = true;
	writeFileSync(join(profile, "poly.json"), JSON.stringify(policy));
	const requests: any[] = [];
	const manager = new TaskManager(
		join(profile, "tasks"),
		root,
		() => policy,
		createPiRunner(
			profile,
			async () => false,
			(id) => replayProvider(id, requests),
		),
		2,
	);
	const builder = manager.dispatch(input("builder", "openai-codex"));
	const researcher = manager.dispatch(input("researcher", "kimi-coding"));
	assert.equal(manager.list().filter((task) => task.status === "running").length, 2);
	const [built, researched] = await Promise.all([
		manager.wait(builder.id),
		manager.wait(researcher.id),
	]);
	assert.equal(built.status, "completed");
	assert.equal(researched.status, "completed");
	assert.notEqual(built.workspace.path, researched.workspace.path);
	assert.deepEqual(built.result!.files, ["app.ts"]);
	assert.deepEqual(researched.result!.files, []);
	assert.match(readFileSync(join(built.workspace.path, "app.ts"), "utf8"), /42/);
	assert.match(readFileSync(join(researched.workspace.path, "app.ts"), "utf8"), /0/);
	assert.ok(
		requests
			.filter((request) => request.provider === "kimi-coding")
			.at(-1)
			.context.messages.some(
				(message: any) =>
					message.role === "toolResult" && JSON.stringify(message.content).includes("answer = 0"),
			),
	);
	await manager.close();
});
