import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { reviewedProject } from "./fixtures/review-project.ts";
import { registerOrchestration } from "../src/orchestration/extension.ts";
import type { Task, TaskResult } from "../src/orchestration/tasks.ts";

for (const action of ["diff", "next", "cleanup"]) {
	test(`task ${action} refuses while its preparation command is active`, async () => {
		const host = await reviewedProject((task) =>
			writeFileSync(join(task.workspace.path, "app.txt"), "after\n"),
		);
		let deny!: (allowed: boolean) => void, entered!: () => void;
		const waiting = new Promise<void>((resolve) => {
			entered = resolve;
		});
		host.ctx.ui.confirm = (title: string) => {
			if (title === "Run preparation command once in the sandbox?")
				return new Promise<boolean>((resolve) => {
					deny = resolve;
					entered();
				});
			return false;
		};
		host.ctx.ui.select = async () => "Inspect diff";
		const pending = host.commands
			.get("task")
			.handler(`${host.builder.id} prepare true`, host.ctx)
			.catch(() => {});
		try {
			await waiting;
			await assert.rejects(
				host.commands.get("task").handler(`${host.builder.id} ${action}`, host.ctx),
				/preparation.*active|wait.*preparation/i,
				"Task actions must wait for their active preparation command",
			);
		} finally {
			deny(false);
			await pending;
			await host.close();
		}
	});
}

test("both task diff actions refuse an active worker", async () => {
	const host = await reviewedProject((task) =>
		writeFileSync(join(task.workspace.path, "app.txt"), "after\n"),
	);
	await host.close();
	const commands = new Map<string, any>(),
		events = new Map<string, any>();
	let active: Task | undefined, finish: ((result: TaskResult) => void) | undefined;
	let entered!: () => void, timer: ReturnType<typeof setTimeout>;
	const ready = new Promise<void>((resolve, reject) => {
		entered = resolve;
		timer = setTimeout(() => reject(new Error("Fixture worker did not start")), 5000);
	});
	registerOrchestration(
		{
			registerCommand: (name: string, command: any) => commands.set(name, command),
			registerTool: () => {},
			on: (name: string, handler: any) => events.set(name, handler),
			appendEntry: () => {},
			sendMessage: () => {},
		} as any,
		host.profile,
		() => "",
		() =>
			async ({ task }) =>
				new Promise<TaskResult>((resolve) => {
					active = task;
					finish = resolve;
					entered();
				}),
	);
	host.ctx.ui.select = async () => "Inspect diff";
	try {
		await commands
			.get("delegate")
			.handler("builder openai-codex/fixture Wait for fixture release", host.ctx);
		await ready;
		assert.ok(active);
		for (const action of ["diff", "next"])
			await assert.rejects(
				commands.get("task").handler(`${active.id} ${action}`, host.ctx),
				/Cancel the running task/,
				"Both diff actions must wait for active worker execution",
			);
	} finally {
		clearTimeout(timer!);
		finish?.({ summary: "Done", files: [], tests: [], findings: [], questions: [] });
		await events.get("session_shutdown")();
	}
});
