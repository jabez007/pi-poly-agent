import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { AcpSession, type AcpPort } from "../src/providers/acp.ts";
import {
	durableKnowledge,
	parseMemoryRecords,
	selectMemory,
	renderMemory,
	type MemoryRecord,
} from "../src/memory-context.ts";
import { draftHandoff, handoffMarkdown, parseHandoffMarkdown } from "../src/handoff.ts";
import { type Handoff, ProjectMemory, checkpointBeforeCompaction } from "../src/memory.ts";

const handoff: Handoff = {
	version: 1,
	objective: "Preserve architecture",
	completed: [],
	decisions: ["Use Pi sessions"],
	questions: ["Can ACP restore?"],
	files: ["src/policy.ts"],
	facts: [
		{ text: "Google ACP delegation is prohibited", source: "docs/security.md:1", verified: true },
	],
	hypotheses: [],
	provenance: {
		session: "one",
		project: "pi_fixture",
		revision: "a".repeat(40),
		provider: "openai-codex",
		createdAt: "2026-11-21T00:00:00Z",
	},
};

test("durable knowledge identity excludes session, timestamps, and transient objective", async () => {
	const first = durableKnowledge(handoff, "pi_fixture");
	assert.deepEqual(
		first,
		durableKnowledge(
			{
				...handoff,
				objective: "Different task",
				provenance: { ...handoff.provenance, session: "two", createdAt: "later" },
			},
			"pi_fixture",
		),
	);
	const items: any[] = [];
	const memory = new ProjectMemory(
		{
			call: async (_name, args) => {
				items.push(...(args.items as any[]));
				return { errors: [] };
			},
			close: async () => {},
		},
		"pi_fixture",
	);
	await memory.save(handoff);
	assert.equal(items.filter((item) => item.room === "knowledge").length, 3);
	assert.equal(items.at(-1).room, "handoffs");
	assert.ok(!JSON.stringify(first).includes('"session"'));
});

test("structured retrieval keeps sourced contradictions and older decisions, deduplicates, and obeys budget", () => {
	const record = (
		id: string,
		text: string,
		kind = "fact",
		verified = true,
		date = "2026-11-20T00:00:00Z",
	): MemoryRecord => ({
		id,
		project: "pi_fixture",
		text,
		kind,
		verified,
		source: `src/${id}.ts:1`,
		createdAt: date,
		score: 0,
	});
	const records = [
		record("old", "Architecture uses Pi sessions", "decision", true, "2020-01-01T00:00:00Z"),
		record("new", "Architecture uses a daemon", "hypothesis", false),
		record("duplicate", "Architecture uses Pi sessions", "decision", false),
		record("noise", "Banana bread recipe"),
	];
	const selected = selectMemory(records, "architecture sessions", 1800, Date.parse("2026-11-21"));
	assert.equal(selected.length, 2);
	const text = renderMemory(selected);
	assert.match(text, /Pi sessions/);
	assert.match(text, /daemon/);
	assert.match(text, /unverified hypothesis/);
	assert.match(text, /src\/old.ts:1/);
	assert.ok(!text.includes("Banana"));
	assert.ok(renderMemory(selectMemory(records, "architecture sessions", 400)).length <= 400);
	assert.equal(
		selectMemory([record("large", "architecture ".repeat(100))], "architecture", 256).length,
		0,
	);
	const data = {
		content: [
			{
				type: "text",
				text: JSON.stringify({
					results: [
						{
							drawer_id: "drawer",
							text: JSON.stringify(durableKnowledge(handoff, "pi_fixture")[0]),
							wing: "pi_fixture",
						},
						{ drawer_id: "private", text: "Other project architecture", wing: "pi_other" },
					],
				}),
			},
		],
	};
	assert.equal(parseMemoryRecords(data, "pi_fixture").length, 1);
});

test("guided handoff derives session context, keeps uncertainty, and supports editable Markdown", () => {
	const session = SessionManager.inMemory("/tmp");
	session.appendMessage({ role: "user", content: "Implement cancellation safely", timestamp: 0 });
	const draft = draftHandoff(
		session.getBranch(),
		handoff.provenance,
		"Unverified previous finding",
		handoff,
	);
	assert.equal(draft.objective, "Implement cancellation safely");
	assert.match(draft.hypotheses.join(" "), /historical memory/);
	const rendered = handoffMarkdown(draft).replace(
		"Implement cancellation safely",
		"Implement bounded cancellation",
	);
	const parsed = parseHandoffMarkdown(rendered, handoff.provenance);
	assert.equal(parsed.objective, "Implement bounded cancellation");
	assert.deepEqual(parsed.provenance, handoff.provenance);
	assert.equal(parsed.facts[0].verified, true);
});

test("ACP restores advertised sessions, preserves failed bindings, and requires explicit fresh-session authorization", async () => {
	const response = {
		modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Ask" }] },
		configOptions: [],
	};
	for (const scenario of ["supported", "unsupported", "failed"]) {
		const calls: string[] = [];
		const reports: string[] = [];
		let saved: any;
		const port: AcpPort = {
			supportsLoad: scenario !== "unsupported",
			request: async (method) => {
				calls.push(method);
				if (method === "session/load" && scenario === "failed") throw new Error("fixture failure");
				return { ...response, sessionId: "new" };
			},
			notify: async () => {},
			close: () => {},
		};
		const session = new AcpSession(
			async () => port,
			"/project",
			async () => undefined,
			{
				saved: { sessionId: "saved-session", cwd: "/project" },
				save: (b) => {
					saved = b;
				},
				report: (m) => reports.push(m),
			},
		);
		await assert.rejects(
			session.prompt("model", "synthetic", undefined, () => {}),
			/authorize/,
		);
		assert.equal(calls.length, 0);
		if (scenario === "supported") {
			await session.discover();
			assert.equal(saved.sessionId, "saved-session");
			assert.ok(calls.includes("session/load"));
		} else {
			await assert.rejects(session.discover());
			assert.ok(!calls.includes("session/new"));
			assert.ok(reports.some((r) => r.includes("handoff")));
			await session.discover(true);
			assert.ok(calls.includes("session/new"));
		}
		session.close();
	}
});

test("memory transport failure is reported to its caller", async () => {
	const memory = new ProjectMemory(
		{
			call: async () => {
				throw new Error("offline");
			},
			close: async () => {},
		},
		"pi_fixture",
	);
	await assert.rejects(memory.recall("architecture"));
});

test("manual compaction needs a successful reviewed checkpoint and never authorizes Google or replay", async () => {
	const input = {
		manual: true,
		willRetry: false,
		interactive: true,
		provider: "openai-codex",
		memoryEnabled: true,
		handoff,
	};
	let saves = 0;
	assert.equal(
		await checkpointBeforeCompaction(
			input,
			async () => true,
			async () => {
				saves++;
			},
		),
		true,
	);
	for (const change of [
		{ manual: false },
		{ willRetry: true },
		{ interactive: false },
		{ provider: "antigravity-acp" },
		{ memoryEnabled: false },
		{ handoff: undefined },
	])
		assert.equal(
			await checkpointBeforeCompaction(
				{ ...input, ...change },
				async () => true,
				async () => {
					saves++;
				},
			),
			false,
		);
	assert.equal(saves, 1);
	assert.equal(
		await checkpointBeforeCompaction(
			input,
			async () => true,
			async () => {
				throw new Error("Backend unavailable");
			},
		),
		false,
	);
});
