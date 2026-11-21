import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { TaskManager } from "../../src/orchestration/tasks.ts";
import { defaultRoles } from "../../src/orchestration/roles.ts";
import { defaultPolicy } from "../../src/policy.ts";
import { sandboxedTest } from "../../src/orchestration/tools.ts";
const [root, directory, mode] = process.argv.slice(2);
if (mode === "sandbox") {
	const pending = sandboxedTest("sleep 60", root, new AbortController().signal);
	process.send?.({ ready: true });
	await pending;
} else {
	const manager = new TaskManager(directory, root, defaultPolicy, async ({ task, session }) => {
		writeFileSync(join(task.workspace.path, "recovered.ts"), "preserved crash changes\n");
		session?.(join(directory, task.id, "sessions", "fixture.jsonl"));
		process.send?.({ id: task.id });
		return new Promise(() => {});
	});
	manager.dispatch({
		parent: "parent-before-crash",
		role: defaultRoles().find((r) => r.name === "builder")!,
		provider: "openai-codex",
		model: "fixture",
		brief: "Preserve crash changes and implement the task",
	});
}
