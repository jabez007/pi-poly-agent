import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { reviewedProject } from "./fixtures/review-project.ts";
import { git, workspaceDiff } from "../src/orchestration/worktrees.ts";
import { taskContext } from "../src/orchestration/context.ts";

const actions = [
	"diff",
	"cleanup",
	"recover",
	"review",
	"integrate",
	"menu-diff",
	"menu-recover",
	"menu-review",
	"menu-integrate",
];
for (const action of actions) {
	test(`${action} refuses during preparation and works after it settles`, async () => {
		let fail = false;
		const host = await reviewedProject((task) => {
			if (fail) throw new Error("Fixture worker failure");
			writeFileSync(join(task.workspace.path, "app.txt"), "after\n");
		});
		let release!: (approved: boolean) => void, entered!: () => void;
		const waiting = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let pending: Promise<unknown> | undefined;
		try {
			let target = host.builder;
			if (action.includes("recover")) {
				fail = true;
				await host.commands
					.get("delegate")
					.handler("builder openai-codex/fixture Interrupted fixture", host.ctx);
				await setImmediate();
				target = host.completed.at(-1)!;
				assert.equal(target.status, "failed");
				fail = false;
			}
			host.ctx.modelRegistry.getAvailable = () => [{ provider: "openai-codex", id: "fixture" }];
			host.ctx.ui.confirm = (title: string) =>
				title === "Run preparation command once in the sandbox?"
					? new Promise<boolean>((resolve) => {
							release = resolve;
							entered();
						})
					: true;
			const menu = {
				"menu-diff": "Inspect diff",
				"menu-recover": "Recover with a new worker",
				"menu-review": "Review implementation",
				"menu-integrate": "Inspect review and integrate",
			};
			host.ctx.ui.select = async (title: string, choices: string[]) =>
				(title === "Task actions" ? menu[action as keyof typeof menu] : undefined) || choices[0];
			pending = host.commands
				.get("task")
				.handler(`${target.id} prepare true`, host.ctx)
				.catch(() => {});
			await waiting;
			const invoke = () =>
				action === "review"
					? host.commands.get("review").handler(`${target.id} kimi-coding/fixture`, host.ctx)
					: host.commands
							.get("task")
							.handler(`${target.id} ${action.startsWith("menu-") ? "next" : action}`, host.ctx);
			await assert.rejects(
				invoke(),
				/Task preparation is active/,
				"Every source-inspecting task action must refuse during preparation",
			);
			assert.throws(
				() => workspaceDiff(target.workspace),
				/Task preparation is active/,
				"Git inspection reached through workflow context must use the same preparation guard",
			);
			if (target.revision)
				assert.throws(() => taskContext("Workflow context", target), /Task preparation is active/);
			release(false);
			await pending;
			await assert.doesNotReject(invoke(), "The action must work once preparation settles");
			await setImmediate();
			if (action.includes("recover") || action.includes("review"))
				assert.equal(host.completed.at(-1)!.status, "completed");
			if (action.includes("integrate"))
				assert.notEqual(git(host.root, ["rev-parse", "HEAD"]), target.workspace.base);
			if (action === "cleanup") assert.equal(existsSync(target.workspace.path), false);
		} finally {
			release?.(false);
			await pending;
			await host.close();
		}
	});
}

for (const action of ["review", "integrate"]) {
	test(`${action} rechecks preparation after its approval yields`, async () => {
		const host = await reviewedProject((task) =>
			writeFileSync(join(task.workspace.path, "app.txt"), "after\n"),
		);
		let release!: (approved: boolean) => void, entered!: () => void;
		const waiting = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let pending: Promise<unknown> | undefined;
		host.ctx.ui.confirm = async (title: string) => {
			if (title === "Run preparation command once in the sandbox?")
				return new Promise<boolean>((resolve) => {
					release = resolve;
					entered();
				});
			if (title.startsWith("Launch ") || title === "Integrate the reviewed task snapshot?") {
				pending = host.commands
					.get("task")
					.handler(`${host.builder.id} prepare true`, host.ctx)
					.catch(() => {});
				await waiting;
			}
			return true;
		};
		try {
			const command =
				action === "review"
					? host.commands.get("review").handler(`${host.builder.id} kimi-coding/fixture`, host.ctx)
					: host.commands.get("task").handler(`${host.builder.id} integrate`, host.ctx);
			await assert.rejects(
				command,
				/Task preparation is active/,
				"Approval cannot admit a source action after preparation starts",
			);
			assert.equal(git(host.root, ["rev-parse", "HEAD"]), host.builder.workspace.base);
		} finally {
			release?.(false);
			await pending;
			await host.close();
		}
	});
}
