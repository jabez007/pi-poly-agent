import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { bootstrap } from "../src/profile.ts";
import { registerOrchestration } from "../src/orchestration/extension.ts";
import { git } from "../src/orchestration/worktrees.ts";
import type { Task } from "../src/orchestration/tasks.ts";

test("native command pickers launch arbitrary agents/workflows and inspect task prefixes without memorized IDs", async () => {
	const root = mkdtempSync(join(tmpdir(), "poly-navigation-"));
	const profile = join(root, ".poly/agent");
	bootstrap(profile);
	git(root, ["init", "-b", "main"]);
	git(root, ["config", "user.name", "Fixture"]);
	git(root, ["config", "user.email", "fixture@example.invalid"]);
	writeFileSync(join(root, ".gitignore"), ".poly/\n");
	writeFileSync(join(root, "source.txt"), "before\n");
	git(root, ["add", "."]);
	git(root, ["commit", "-m", "base"]);
	writeFileSync(
		join(profile, "platform.json"),
		JSON.stringify({
			version: 1,
			agents: {
				analyst: {
					instructions: "Read source",
					model: "openai-codex/fixture",
					policy: { permissions: ["read"] },
				},
			},
			workflows: {
				audit: { steps: [{ id: "observe", agent: "analyst", objective: "{{input}}" }] },
			},
		}),
	);
	const commands = new Map<string, any>(),
		events = new Map<string, any>();
	const completed: Task[] = [],
		notices: string[] = [],
		titles: string[] = [];
	let approve = true;
	const pi: any = {
		registerCommand: (n: string, c: any) => commands.set(n, c),
		registerTool: () => {},
		on: (n: string, h: any) => events.set(n, h),
		appendEntry: (_n: string, t: Task) => completed.push(t),
		sendMessage: () => {},
	};
	const ctx: any = {
		cwd: root,
		hasUI: true,
		mode: "tui",
		model: { provider: "kimi-coding", id: "parent" },
		sessionManager: SessionManager.inMemory(root),
		modelRegistry: { getAvailable: () => [] },
		ui: {
			setStatus: () => {},
			notify: (s: string) => notices.push(s),
			input: async () => "Inspect source.txt",
			editor: async (_t: string, s: string) => s,
			confirm: async () => approve,
			select: async (title: string, choices: string[]) => {
				titles.push(title);
				return title === "Task actions" ? "Leave for later" : choices[0];
			},
		},
	};
	registerOrchestration(
		pi,
		profile,
		() => "",
		() => async () => ({
			summary: "Observed source",
			files: [],
			tests: [],
			findings: [],
			questions: [],
		}),
	);
	try {
		await commands.get("delegate").handler("", ctx);
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.equal(completed.length, 1);
		assert.ok(titles.includes("Select agent"));
		await commands.get("task").handler(completed[0].id.slice(0, 8), ctx);
		assert.ok(notices.some((n) => n.includes("Observed source")));
		await commands.get("task").handler("", ctx);
		assert.ok(titles.includes("Select task"));
		await commands.get("workflow").handler("", ctx);
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.equal(completed.length, 2);
		assert.ok(titles.includes("Select workflow"));
		await assert.rejects(commands.get("poly-qualify").handler("antigravity-acp/fixture", ctx));
		approve = false;
		await commands.get("poly-qualify").handler("openai-codex/fixture", ctx);
		assert.equal(completed.length, 2, "Declined qualification starts no worker");
		approve = true;
		await commands.get("poly-qualify").handler("openai-codex/fixture", ctx);
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.deepEqual(completed[2].requestBudget, { requests: 1, outputTokens: 512 });
		assert.deepEqual(completed[2].effectivePolicy!.tools, []);
		assert.equal(ctx.model.provider, "kimi-coding", "Child selection never switches the parent");
		ctx.mode = "rpc";
		await assert.rejects(
			commands.get("poly-qualify").handler("openai-codex/fixture", ctx),
			/interactive/,
		);
	} finally {
		await events.get("session_shutdown")();
	}
});
