import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import extension from "../src/extension.ts";
import { bootstrap } from "../src/profile.ts";
import { draftHandoff, handoffMarkdown, parseHandoffMarkdown } from "../src/handoff.ts";

async function handoffHost(taskCount: number, summary = "Completed fixture task") {
	const root = mkdtempSync(join(tmpdir(), "poly-handoff-fixture-"));
	bootstrap(root);
	writeFileSync(join(root, "platform.json"), JSON.stringify({ version: 1, recipes: ["minimal"] }));
	const session = SessionManager.inMemory(root);
	session.appendMessage({ role: "user", content: "Current objective", timestamp: 1 });
	for (let n = 0; n < taskCount; n++)
		session.appendCustomEntry("poly-task-complete", {
			id: `fixture-${n}`,
			status: "completed",
			provider: "openai-codex",
			model: "fixture",
			result: {
				summary,
				files: ["app.txt"],
				questions: ["Open fixture question"],
				findings: [{ text: "Fixture finding", source: "app.txt:1", severity: "info" }],
			},
		});
	const commands = new Map<string, any>(),
		notices: string[] = [];
	const previous = process.env.PI_POLY_PROFILE;
	process.env.PI_POLY_PROFILE = root;
	try {
		await extension({
			registerProvider: () => {},
			registerTool: () => {},
			on: () => {},
			registerCommand: (n: string, c: any) => commands.set(n, c),
			appendEntry: (n: string, d: any) => session.appendCustomEntry(n, d),
		} as any);
	} finally {
		if (previous === undefined) delete process.env.PI_POLY_PROFILE;
		else process.env.PI_POLY_PROFILE = previous;
	}
	const context: any = {
		cwd: root,
		hasUI: true,
		model: { provider: "openai-codex" },
		sessionManager: session,
		ui: {
			editor: async (_t: string, s: string) => s,
			confirm: async () => true,
			notify: (s: string) => notices.push(s),
		},
	};
	return { session, context, notices, handoff: () => commands.get("handoff").handler("", context) };
}

test("three unedited handoff commands preserve one copy of branch facts and questions", async () => {
	const host = await handoffHost(1);
	const counts: number[][] = [];
	for (let n = 0; n < 3; n++) {
		await host.handoff();
		const entry = host.session
			.getBranch()
			.filter((e) => e.type === "custom" && e.customType === "poly-handoff")
			.at(-1) as any;
		counts.push([entry.data.facts.length, entry.data.questions.length, entry.data.files.length]);
	}
	assert.deepEqual(counts, [
		[1, 1, 1],
		[1, 1, 1],
		[1, 1, 1],
	]);
});

test("multiline handoff facts questions and completed entries stay stable across unedited runs", async () => {
	const host = await handoffHost(0);
	host.session.appendCustomEntry("poly-task-complete", {
		id: "multiline-fixture",
		status: "completed",
		provider: "openai-codex",
		model: "fixture",
		result: {
			summary: "Summary line one\nline two",
			files: ["app.txt"],
			questions: ["Question line one\nline two"],
			findings: [
				{
					text: "Finding line one\nline two",
					source: "app.txt:1\nfixture evidence",
					severity: "info",
				},
			],
		},
	});
	const counts: number[][] = [];
	for (let n = 0; n < 3; n++) {
		await host.handoff();
		const entry = host.session
			.getBranch()
			.filter((e) => e.type === "custom" && e.customType === "poly-handoff")
			.at(-1) as any;
		counts.push([
			entry.data.facts.length,
			entry.data.questions.length,
			entry.data.completed.length,
		]);
	}
	assert.deepEqual(counts, [
		[1, 1, 1],
		[1, 1, 1],
		[1, 1, 1],
	]);
});

test("an oversized handoff draft reports a user-facing limit instead of throwing", async () => {
	const host = await handoffHost(30, "Long fixture summary ".repeat(70));
	await assert.doesNotReject(host.handoff);
	assert.ok(host.notices.some((message) => message.includes("24 KB")));
	assert.equal(
		host.session.getBranch().filter((e) => e.type === "custom" && e.customType === "poly-handoff")
			.length,
		0,
	);
});

test("heading-like objective text round-trips through an unedited handoff draft", async () => {
	const host = await handoffHost(0);
	const objective = "Current objective\n# heading\nFollow-up detail";
	host.session.appendMessage({ role: "user", content: objective, timestamp: 2 });
	const provenance = {
		session: "fixture",
		project: "fixture",
		revision: "fixture",
		provider: "fixture",
		createdAt: "fixture",
	};
	const draft = draftHandoff(host.session.getBranch(), provenance, "");
	assert.equal(parseHandoffMarkdown(handoffMarkdown(draft), provenance).objective, objective);
	await assert.doesNotReject(host.handoff);
	assert.ok(host.notices.some((message) => message.includes("Handoff saved")));
});
