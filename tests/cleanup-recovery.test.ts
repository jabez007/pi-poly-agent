import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { TaskManager } from "../src/orchestration/tasks.ts";
import { registerOrchestration } from "../src/orchestration/extension.ts";
import { cleanupWorkspace, git } from "../src/orchestration/worktrees.ts";
import { defaultPolicy } from "../src/policy.ts";
import { reviewedProject } from "./fixtures/review-project.ts";

for (const scenario of [
	"reviewer cleanup",
	"builder cleanup",
	"deleted and pruned",
	"metadata removed",
]) {
	test(`restart retains task history after ${scenario}`, async () => {
		const host = await reviewedProject((task) =>
			writeFileSync(join(task.workspace.path, "app.txt"), "after\n"),
		);
		await host.close();
		const review = host.completed.find((t) => t.reviewOf === host.builder.id)!;
		const removed = scenario === "reviewer cleanup" ? review : host.builder;
		if (scenario.endsWith("cleanup")) cleanupWorkspace(removed.workspace);
		if (scenario === "deleted and pruned") {
			rmSync(removed.workspace.path, { recursive: true });
			git(host.root, ["worktree", "prune"]);
		}
		if (scenario === "metadata removed") rmSync(removed.workspace.gitDir!, { recursive: true });
		const original = childProcess.execFileSync;
		const attempted: string[] = [];
		childProcess.execFileSync = ((file: string, args: string[], options: any) => {
			if (file === "git" && options?.cwd === removed.workspace.path) attempted.push(options.cwd);
			return (original as any)(file, args, options);
		}) as any;
		syncBuiltinESMExports();
		let manager: TaskManager | undefined;
		try {
			manager = new TaskManager(
				dirname(dirname(host.builder.workspace.path)),
				host.root,
				defaultPolicy,
				async () => {
					throw new Error("No replay");
				},
			);
			assert.equal(manager.list().length, 2, "Cleanup must not discard either durable task");
			assert.match(manager.get(removed.id).recovery!.join(" "), /missing|metadata.*unavailable/i);
			assert.deepEqual(attempted, [], "Restart must not run Git in an unavailable worktree");
			if (scenario === "reviewer cleanup") {
				await manager.close();
				manager = undefined;
				const commands = new Map<string, any>(),
					events = new Map<string, any>();
				registerOrchestration(
					{
						registerTool: () => {},
						registerCommand: (n: string, c: any) => commands.set(n, c),
						on: (n: string, h: any) => events.set(n, h),
					} as any,
					host.profile,
					() => "",
					() => async () => {
						throw new Error("No replay");
					},
				);
				try {
					await commands.get("task").handler(`${host.builder.id} integrate`, host.ctx);
				} finally {
					await events.get("session_shutdown")();
				}
				assert.ok(host.notices.some((n) => n.includes("Review findings:")));
				manager = new TaskManager(
					dirname(dirname(host.builder.workspace.path)),
					host.root,
					defaultPolicy,
					async () => {
						throw new Error("No replay");
					},
				);
				assert.equal(manager.integrate(host.builder.id).integration!.state, "integrated");
			}
		} finally {
			await manager?.close();
			childProcess.execFileSync = original;
			syncBuiltinESMExports();
		}
	});
}
