import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { bootstrap } from "../../src/profile.ts";
import { registerOrchestration } from "../../src/orchestration/extension.ts";
import { git } from "../../src/orchestration/worktrees.ts";
import type { Task, TaskResult } from "../../src/orchestration/tasks.ts";

export function temporaryRepository() {
	const directory = mkdtempSync(join(tmpdir(), "poly-review-fixture-"));
	const root = join(directory, "repository");
	git(directory, ["init", "-b", "main", root]);
	git(root, ["config", "user.name", "Fixture"]);
	git(root, ["config", "user.email", "fixture@example.invalid"]);
	writeFileSync(join(root, "app.txt"), "before\n");
	git(root, ["add", "."]);
	git(root, ["commit", "-m", "Fixture base"]);
	return { root, directory };
}

export async function reviewedProject(change: (task: Task) => void) {
	const { root, directory } = temporaryRepository();
	const profile = join(directory, "profile");
	bootstrap(profile);
	const commands = new Map<string, any>(),
		events = new Map<string, any>(),
		notices: string[] = [];
	const completed: Task[] = [];
	let resolveTask: ((task: Task) => void) | undefined;
	const pi: any = {
		registerCommand: (n: string, c: any) => commands.set(n, c),
		registerTool: () => {},
		on: (n: string, h: any) => events.set(n, h),
		appendEntry: (_n: string, task: Task) => {
			completed.push(task);
			resolveTask?.(task);
		},
		sendMessage: () => {},
	};
	const ctx: any = {
		cwd: root,
		hasUI: true,
		mode: "tui",
		sessionManager: SessionManager.inMemory(root),
		modelRegistry: { getAvailable: () => [] },
		ui: {
			setStatus: () => {},
			notify: (s: string) => notices.push(s),
			editor: async (_t: string, s: string) => s,
			confirm: async (title: string) => title !== "Integrate the reviewed task snapshot?",
		},
	};
	const result: TaskResult = {
		summary: "Fixture result",
		files: [],
		tests: [],
		findings: [],
		questions: [],
	};
	registerOrchestration(
		pi,
		profile,
		() => "",
		() =>
			async ({ task }) => {
				if (task.role.editing) change(task);
				return result;
			},
	);
	const launch = async (name: string, args: string) => {
		let timer: ReturnType<typeof setTimeout>;
		const done = new Promise<Task>((resolve, reject) => {
			resolveTask = resolve;
			timer = setTimeout(() => reject(new Error("Fixture task timed out")), 10000);
		});
		try {
			await commands.get(name).handler(args, ctx);
			return await done;
		} finally {
			clearTimeout(timer!);
		}
	};
	try {
		const builder = await launch(
			"delegate",
			"builder openai-codex/fixture Apply the bounded change",
		);
		await launch("review", `${builder.id} kimi-coding/fixture`);
		return {
			root,
			profile,
			builder,
			completed,
			notices,
			ctx,
			commands,
			close: () => events.get("session_shutdown")(),
		};
	} catch (error) {
		await events.get("session_shutdown")();
		throw error;
	}
}
