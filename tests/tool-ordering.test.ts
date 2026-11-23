import assert from "node:assert/strict";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { TaskManager } from "../src/orchestration/tasks.ts";
import { createPiRunner } from "../src/orchestration/runner.ts";
import { defaultPolicy } from "../src/policy.ts";
import { defaultRoles } from "../src/orchestration/roles.ts";
import { temporaryRepository } from "./fixtures/review-project.ts";
import { deterministicProvider } from "./fixtures/deterministic-provider.ts";
import { bootstrap } from "../src/profile.ts";

test(
	"worker file access waits until an approved-command tool settles",
	{ timeout: 15000 },
	async () => {
		const { root, directory } = temporaryRepository(),
			profile = join(directory, "profile");
		bootstrap(profile);
		let release!: (value: boolean) => void, entered!: () => void;
		const enteredCommand = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const command = new Promise<boolean>((resolve) => {
			release = resolve;
		});
		let turns = 0;
		const runner = createPiRunner(
			profile,
			async () => {
				entered();
				return command;
			},
			(id) =>
				deterministicProvider(id, () =>
					++turns === 1
						? [
								{
									type: "toolCall",
									id: "command",
									name: "run_test",
									arguments: { command: "true" },
								},
								{ type: "toolCall", id: "read", name: "read", arguments: { path: "app.txt" } },
							]
						: [
								{
									type: "text",
									text: JSON.stringify({
										summary: "Done",
										files: [],
										tests: [],
										findings: [],
										questions: [],
									}),
								},
							],
				),
		);
		const progress: string[] = [];
		const manager = new TaskManager(
			join(directory, "tasks"),
			root,
			defaultPolicy,
			runner,
			2,
			10000,
			(task) => progress.push(task.progress),
		);
		const task = manager.dispatch({
			parent: "fixture",
			role: defaultRoles().find((r) => r.name === "builder")!,
			provider: "openai-codex",
			model: "fixture",
			brief: "Check serialized tools",
		});
		try {
			await enteredCommand;
			for (let n = 0; n < 5; n++) await setImmediate();
			assert.ok(
				!progress.includes("Executing read"),
				"Read must not overlap an unsettled command tool",
			);
		} finally {
			release(false);
			await manager.wait(task.id);
			await manager.close();
		}
	},
);
