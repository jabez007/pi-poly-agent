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

test("guided /implement selects distinct models, offers review, shows results and preserves final approval", async () => {
	const root = mkdtempSync(join(tmpdir(), "poly-guided-project-"));
	const profile = mkdtempSync(join(tmpdir(), "poly-guided-profile-"));
	bootstrap(profile);
	writeFileSync(
		join(profile, "platform.json"),
		JSON.stringify({
			version: 1,
			recipes: ["implementation-review"],
			compatibility: true,
			policy: { contextBudget: 4000 },
		}),
	);
	git(root, ["init", "-b", "main"]);
	git(root, ["config", "user.name", "Fixture"]);
	git(root, ["config", "user.email", "fixture@example.invalid"]);
	writeFileSync(join(root, "app.ts"), "before\n");
	git(root, ["add", "."]);
	git(root, ["commit", "-m", "base"]);
	const commands = new Map<string, any>();
	const events = new Map<string, any>();
	const completed: Task[] = [];
	const notifications: string[] = [];
	const approvals: string[] = [];
	const packets: string[] = [];
	let integrate = false;
	const pi = {
		registerCommand: (name: string, config: any) => commands.set(name, config),
		registerTool: () => {},
		on: (event: string, fn: any) => events.set(event, fn),
		appendEntry: (type: string, task: Task) => {
			if (type === "poly-task-complete") completed.push(task);
		},
		sendMessage: (_message: any, options: any) => assert.equal(options.triggerTurn, false),
	} as unknown as ExtensionAPI;
	const ctx: any = {
		cwd: root,
		hasUI: true,
		mode: "tui",
		sessionManager: SessionManager.inMemory(root),
		modelRegistry: {
			getAvailable: () => [
				{ provider: "openai-codex", id: "builder-fixture" },
				{ provider: "kimi-coding", id: "review-fixture" },
			],
		},
		ui: {
			notify: (text: string) => notifications.push(text),
			setStatus: () => {},
			editor: async (_title: string, text: string) => {
				const packet = JSON.parse(text);
				packet.context += "\nWORKFLOW-APPROVED-TAIL";
				packets.push(packet.context);
				return JSON.stringify(packet);
			},
			select: async (title: string, choices: string[]) =>
				title.includes("reviewer")
					? choices.find((c) => c.includes("kimi"))
					: title.includes("builder")
						? choices[0]
						: "Inspect review and integrate",
			confirm: async (title: string) => {
				approvals.push(title);
				return title.includes("Integrate") ? integrate : true;
			},
		},
	};
	registerOrchestration(
		pi,
		profile,
		async (brief) => `Selected project context for ${brief}`,
		() =>
			async ({ task, progress }) => {
				progress("Reading approved source");
				if (task.role.editing) writeFileSync(join(task.workspace.path, "app.ts"), "after\n");
				return {
					summary: `${task.provider} ${task.role.name}`,
					files: [],
					tests: [],
					findings: [{ text: "Review evidence", source: "app.ts:1", severity: "info" }],
					questions: [],
				};
			},
	);
	await commands.get("implement").handler("Implement one change and independently review it", ctx);
	for (let i = 0; i < 200 && !approvals.some((a) => a.includes("Integrate")); i++)
		await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(completed.length, 2);
	assert.deepEqual(
		completed.map((task) => task.context),
		packets,
		"Workflow workers must receive their approved packets byte for byte",
	);
	assert.ok(completed.every((task) => task.context!.length <= 4000));
	assert.deepEqual(
		completed.map((t) => t.provider),
		["openai-codex", "kimi-coding"],
	);
	assert.notEqual(completed[0].workspace.path, completed[1].workspace.path);
	assert.equal(completed[1].reviewRevision, completed[0].revision);
	assert.ok(approvals.some((a) => a.includes("Launch independent review")));
	assert.ok(notifications.some((n) => n.includes("Review findings")));
	assert.equal(
		readFileSync(join(root, "app.ts"), "utf8"),
		"before\n",
		"declined integration leaves parent untouched",
	);
	integrate = true;
	await commands.get("task").handler(`${completed[0].id} integrate`, ctx);
	assert.equal(readFileSync(join(root, "app.ts"), "utf8"), "after\n");
	await events.get("session_shutdown")();
});

test("recovery command reviews a fresh replacement and declined approval never dispatches it", async () => {
	const root = mkdtempSync(join(tmpdir(), "poly-recovery-ui-project-"));
	const profile = mkdtempSync(join(tmpdir(), "poly-recovery-ui-profile-"));
	bootstrap(profile);
	git(root, ["init", "-b", "main"]);
	git(root, ["config", "user.name", "Fixture"]);
	git(root, ["config", "user.email", "fixture@example.invalid"]);
	writeFileSync(join(root, "app.ts"), "before\n");
	git(root, ["add", "."]);
	git(root, ["commit", "-m", "base"]);
	const commands = new Map<string, any>();
	const events = new Map<string, any>();
	const completed: Task[] = [];
	const messages: string[] = [];
	const previews: string[] = [];
	let allow = true;
	let calls = 0;
	const pi: any = {
		registerCommand: (n: string, c: any) => commands.set(n, c),
		registerTool: () => {},
		on: (n: string, h: any) => events.set(n, h),
		appendEntry: (n: string, t: Task) => {
			if (n === "poly-task-complete") completed.push(t);
		},
		sendMessage: () => {},
	};
	const ctx: any = {
		cwd: root,
		hasUI: true,
		mode: "tui",
		sessionManager: SessionManager.inMemory(root),
		modelRegistry: { getAvailable: () => [{ provider: "openai-codex", id: "fixture" }] },
		ui: {
			notify: (s: string) => messages.push(s),
			setStatus: () => {},
			select: async (_title: string, choices: string[]) => choices[0],
			confirm: async () => allow,
			editor: async (_title: string, draft: string) => {
				previews.push(draft);
				return draft;
			},
		},
	};
	registerOrchestration(
		pi,
		profile,
		() => "Original approved constraint",
		() =>
			async ({ task, signal }) => {
				calls++;
				if (calls === 1) {
					writeFileSync(join(task.workspace.path, "preserved.ts"), "preserve me\n");
					await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
				}
				return { summary: "Recovered task", files: [], tests: [], findings: [], questions: [] };
			},
	);
	await commands.get("delegate").handler("builder openai-codex/fixture Implement change", ctx);
	await new Promise((resolve) => setImmediate(resolve));
	const id = /^Started ([a-f0-9-]+)/.exec(messages.find((m) => m.startsWith("Started "))!)![1];
	await commands.get("task").handler(`${id} cancel`, ctx);
	allow = false;
	await commands.get("task").handler(`${id} recover`, ctx);
	assert.equal(calls, 1);
	allow = true;
	await commands.get("task").handler(`${id} recover`, ctx);
	for (let i = 0; i < 100 && completed.length < 2; i++)
		await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(calls, 2);
	assert.equal(completed[1].replacementOf, id);
	assert.ok(previews.at(-1)!.includes("Original approved constraint"));
	assert.equal(
		readFileSync(join(completed[1].workspace.path, "preserved.ts"), "utf8"),
		"preserve me\n",
	);
	await events.get("session_shutdown")();
});
