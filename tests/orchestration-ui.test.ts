import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { bootstrap } from "../src/profile.ts";
import { registerOrchestration } from "../src/orchestration/extension.ts";
import { git } from "../src/orchestration/worktrees.ts";
import type { Task } from "../src/orchestration/tasks.ts";

test("Pi commands reconcile builder/reviewer results and require final integration approval", async () => {
	const root = mkdtempSync(join(tmpdir(), "poly-command-project-"));
	const profile = mkdtempSync(join(tmpdir(), "poly-command-profile-"));
	bootstrap(profile);
	git(root, ["init", "-b", "main"]);
	git(root, ["config", "user.name", "Fixture"]);
	git(root, ["config", "user.email", "fixture@example.invalid"]);
	writeFileSync(join(root, "app.ts"), "before\n");
	git(root, ["add", "."]);
	git(root, ["commit", "-m", "base"]);
	const commands = new Map<string, any>();
	const tools = new Map<string, any>();
	const events = new Map<string, any>();
	const completed: Task[] = [];
	const notifications: string[] = [];
	let allow = true;
	const session = SessionManager.inMemory(root);
	const pi = {
		registerCommand: (name: string, config: any) => commands.set(name, config),
		registerTool: (tool: any) => tools.set(tool.name, tool),
		on: (event: string, fn: any) => events.set(event, fn),
		appendEntry: (type: string, data: any) => {
			if (type === "poly-task-complete") completed.push(data);
		},
		sendMessage: (_message: any, options: any) => assert.equal(options.triggerTurn, false),
	} as unknown as ExtensionAPI;
	const ctx: any = {
		cwd: root,
		hasUI: true,
		mode: "tui",
		model: { provider: "openai-codex" },
		sessionManager: session,
		modelRegistry: { getAvailable: () => [] },
		ui: {
			notify: (text: string) => notifications.push(text),
			setStatus: () => {},
			confirm: async () => allow,
			editor: async (_title: string, text: string) => text,
		},
	};
	registerOrchestration(
		pi,
		profile,
		() => "Verified project constraint",
		() =>
			async ({ task }) => {
				if (task.role.editing) writeFileSync(join(task.workspace.path, "app.ts"), "after\n");
				return {
					summary: `${task.role.name} done`,
					files: [],
					tests: [],
					findings: [{ text: "Inspected app", source: "app.ts:1", severity: "info" }],
					questions: [],
				};
			},
	);
	const flush = () => new Promise((resolve) => setImmediate(resolve));
	await commands.get("delegate").handler("builder openai-codex/fixture Implement change", ctx);
	await flush();
	const builder = completed.find((t) => t.role.name === "builder")!;
	assert.equal(builder.status, "completed");
	await assert.rejects(
		commands.get("task").handler(`${builder.id} integrate`, ctx),
		/independent review/,
	);
	await commands.get("review").handler(`${builder.id} kimi-coding/fixture`, ctx);
	await flush();
	assert.equal(completed.find((t) => t.role.name === "reviewer")!.reviewOf, builder.id);
	allow = false;
	await commands.get("task").handler(`${builder.id} integrate`, ctx);
	assert.equal(readFileSync(join(root, "app.ts"), "utf8"), "before\n");
	allow = true;
	await commands.get("task").handler(`${builder.id} integrate`, ctx);
	assert.equal(readFileSync(join(root, "app.ts"), "utf8"), "after\n");
	ctx.mode = "rpc";
	await assert.rejects(
		tools
			.get("delegate_task")
			.execute(
				"tool",
				{ role: "builder", model: "openai-codex/fixture", brief: "synthetic request" },
				undefined,
				undefined,
				ctx,
			),
		/interactive/,
	);
	ctx.mode = "tui";
	await assert.rejects(
		tools
			.get("delegate_task")
			.execute(
				"tool",
				{ role: "builder", model: "antigravity-acp/fixture", brief: "approved delegation" },
				undefined,
				undefined,
				ctx,
			),
		/authorized/,
	);
	ctx.model.provider = "antigravity-acp";
	await assert.rejects(
		tools
			.get("delegate_task")
			.execute(
				"tool",
				{ role: "builder", model: "openai-codex/fixture", brief: "synthetic Google delegation" },
				undefined,
				undefined,
				ctx,
			),
		/authorized/,
	);
	await events.get("session_shutdown")();
});
