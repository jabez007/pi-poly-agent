import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import extension from "../src/extension.ts";
import { bootstrap } from "../src/profile.ts";
import { validateHandoff, type Handoff } from "../src/memory.ts";
import { draftHandoff, handoffMarkdown, parseHandoffMarkdown } from "../src/handoff.ts";

function checkpoint(): Handoff {
	return {
		version: 1,
		objective: "Current objective",
		completed: ["Completed fixture"],
		decisions: [],
		questions: ["Open fixture question"],
		files: ["app.txt"],
		facts: [{ text: "Fixture finding", source: "app.txt:1", verified: false }],
		hypotheses: [],
		provenance: {
			session: "fixture",
			project: "fixture",
			revision: "fixture",
			provider: "fixture",
			createdAt: "fixture",
		},
	};
}
async function host(seed = checkpoint()) {
	const root = mkdtempSync(join(tmpdir(), "poly-handoff-fixture-"));
	bootstrap(root);
	const session = SessionManager.inMemory(root);
	session.appendMessage({ role: "user", content: "Current objective", timestamp: 1 });
	session.appendCustomEntry("poly-handoff", validateHandoff(seed));
	const commands = new Map<string, any>(),
		handlers = new Map<string, any[]>(),
		notices: string[] = [];
	const previous = process.env.PI_POLY_PROFILE;
	process.env.PI_POLY_PROFILE = root;
	try {
		await extension({
			registerProvider: () => {},
			on: (name: string, handler: any) =>
				handlers.set(name, [...(handlers.get(name) || []), handler]),
			registerCommand: (name: string, config: any) => commands.set(name, config),
			appendEntry: (name: string, data: any) => session.appendCustomEntry(name, data),
		} as any);
	} finally {
		if (previous === undefined) delete process.env.PI_POLY_PROFILE;
		else process.env.PI_POLY_PROFILE = previous;
	}
	const context: any = {
		cwd: root,
		hasUI: true,
		mode: "tui",
		model: { provider: "openai-codex" },
		sessionManager: session,
		ui: {
			editor: async (_title: string, text: string) => text,
			confirm: async () => true,
			notify: (text: string) => notices.push(text),
			setStatus: () => {},
			setEditorText: (text: string) => {
				context.editorText = text;
			},
		},
	};
	for (const handler of handlers.get("session_start") || []) await handler({}, context);
	return {
		session,
		context,
		notices,
		commands,
		handoff: () => commands.get("handoff").handler("", context),
		latest: () =>
			(
				session
					.getBranch()
					.filter((e) => e.type === "custom" && e.customType === "poly-handoff")
					.at(-1) as any
			).data as Handoff,
	};
}

test("three unedited handoffs preserve saved checkpoint entries without reading retired task records", async () => {
	const h = await host();
	h.session.appendCustomEntry("poly-task-complete", { unsafeOldRecord: "not loaded" });
	for (let n = 0; n < 3; n++) {
		await h.handoff();
		const value = h.latest();
		assert.deepEqual(
			[value.facts.length, value.questions.length, value.completed.length],
			[1, 1, 1],
		);
	}
	for (const command of ["delegate", "tasks", "workflow", "review"])
		assert.equal(h.commands.has(command), false);
});

test("multiline saved handoff entries stay deduplicated across unedited runs", async () => {
	const seed = checkpoint();
	seed.facts[0].text = "Finding\ncontinued";
	seed.facts[0].source = "app.txt:1\nevidence";
	seed.questions = ["Question\ncontinued"];
	seed.completed = ["Summary\ncontinued"];
	const h = await host(seed);
	for (let n = 0; n < 3; n++) {
		await h.handoff();
		const value = h.latest();
		assert.deepEqual(
			[value.facts.length, value.questions.length, value.completed.length],
			[1, 1, 1],
		);
		assert.equal(value.facts[0].text, "Finding continued");
	}
});

test("an oversized rebuilt handoff reports a limit instead of throwing", async () => {
	const seed = checkpoint();
	seed.completed = ["summary ".repeat(2800)];
	const h = await host(seed);
	h.session.appendMessage({ role: "user", content: "objective ".repeat(250), timestamp: 2 });
	const before = h.session.getBranch().length;
	await assert.doesNotReject(h.handoff);
	assert.ok(h.notices.some((s) => s.includes("24 KB")));
	assert.equal(h.session.getBranch().length, before);
});

test("heading-like objectives round-trip and using a handoff only prepares the editor", async () => {
	const h = await host();
	const objective = "Current objective\n# heading\nFollow-up detail";
	h.session.appendMessage({ role: "user", content: objective, timestamp: 2 });
	const draft = draftHandoff(h.session.getBranch(), checkpoint().provenance, "");
	assert.equal(parseHandoffMarkdown(handoffMarkdown(draft), draft.provenance).objective, objective);
	await h.handoff();
	assert.ok(h.notices.some((s) => s.includes("Handoff saved")));
	await h.commands.get("handoff-use").handler("", h.context);
	assert.match(h.context.editorText, /heading/);
	assert.equal(h.context.model.provider, "openai-codex");
});
