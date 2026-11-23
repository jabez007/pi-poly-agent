import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { bootstrap } from "../src/profile.ts";
import { defaultPolicy } from "../src/policy.ts";
import { git } from "../src/orchestration/worktrees.ts";
import { TaskManager } from "../src/orchestration/tasks.ts";
import { createPiRunner } from "../src/orchestration/runner.ts";
import { deterministicProvider } from "./fixtures/deterministic-provider.ts";

test(
	"qualification request budgets stop uncertain continuation before a second provider invocation",
	{ timeout: 10000 },
	async () => {
		const root = mkdtempSync(join(tmpdir(), "poly-probe-"));
		const profile = join(root, ".poly/agent");
		bootstrap(profile);
		git(root, ["init", "-b", "main"]);
		git(root, ["config", "user.name", "Fixture"]);
		git(root, ["config", "user.email", "fixture@example.invalid"]);
		writeFileSync(join(root, ".gitignore"), ".poly/\n");
		git(root, ["add", "."]);
		git(root, ["commit", "-m", "base"]);
		const options: any[] = [];
		const runner = createPiRunner(
			profile,
			async () => false,
			(id) =>
				deterministicProvider(
					id,
					() => [{ type: "toolCall", id: "unsupported", name: "not_available", arguments: {} }],
					(o) => options.push(o),
				),
		);
		const manager = new TaskManager(join(profile, "tasks"), root, defaultPolicy, runner, 2, 2000);
		try {
			const task = manager.dispatch({
				parent: "qualification",
				role: {
					name: "probe",
					instructions: "No tools",
					editing: false,
					policy: { tools: [], permissions: ["read"] },
				},
				provider: "openai-codex",
				model: "fixture",
				brief: "Check response",
				requestBudget: { requests: 1, outputTokens: 256 },
			});
			const done = await manager.wait(task.id);
			assert.equal(done.status, "failed");
			assert.equal(done.failureCode, "budget");
			assert.equal(options.length, 1, "Uncertain continuation must not reach the transport");
			assert.equal(options[0].maxTokens, 256);
			await assert.rejects(
				runner({
					task: { ...task, requestBudget: { requests: 0, outputTokens: 256 } },
					signal: new AbortController().signal,
					progress: () => {},
				}),
				/Invalid.*budget/,
			);
			assert.equal(options.length, 1, "Child invocation must revalidate saved limits");
			const replacement = manager.dispatch({
				parent: task.parent,
				role: task.role,
				provider: task.provider,
				model: task.model,
				brief: task.brief,
				replacementOf: task.id,
				requestBudget: { requests: 64, outputTokens: 4096 },
			});
			assert.deepEqual(replacement.requestBudget, { requests: 1, outputTokens: 256 });
			await manager.wait(replacement.id);
			assert.equal(options.length, 2, "Explicit replacement has its own bounded request");
		} finally {
			await manager.close();
		}
	},
);
