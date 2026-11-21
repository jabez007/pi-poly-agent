import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	assertNoSecrets,
	checkpointDigest,
	discoverMemPalace,
	ProjectMemory,
	projectIdentity,
	validateHandoff,
	type Handoff,
	type MemoryTransport,
} from "../src/memory.ts";

export function fixtureHandoff(): Handoff {
	return {
		version: 1,
		objective: "Implement fixture",
		completed: ["Configured Pi"],
		decisions: ["Reuse sessions"],
		questions: [],
		files: ["src/memory.ts"],
		facts: [{ text: "Pi owns history", source: "src/extension.ts", verified: true }],
		hypotheses: ["Retrieval relevance may improve"],
		provenance: {
			session: "fixture-session",
			project: "pi_fixture",
			revision: "a".repeat(40),
			provider: "openai-codex",
			createdAt: "2026-11-21T00:00:00Z",
		},
	};
}

test("checkpoint uses MemPalace checkpoint and preserves source and certainty", async () => {
	const calls: { name: string; args: any }[] = [];
	const transport: MemoryTransport = {
		call: async (name, args) => {
			calls.push({ name, args });
			return { added: ["fixture"], errors: [] };
		},
		close: async () => {},
	};
	const memory = new ProjectMemory(transport, "pi_project");
	const h = fixtureHandoff();
	await memory.save(h);
	assert.equal(calls[0].name, "mempalace_checkpoint");
	assert.equal(calls[0].args.items[0].wing, "pi_project");
	assert.deepEqual(JSON.parse(calls[0].args.items[0].content), h);
	assert.equal(
		checkpointDigest(h),
		checkpointDigest({ ...h, provenance: { ...h.provenance, createdAt: "later" } }),
	);
});

test("retrieval is project isolated, and sharing is explicit", async () => {
	const wings: unknown[] = [];
	const memory = new ProjectMemory(
		{
			call: async (_name, args) => {
				wings.push(args.wing);
				return { drawers: [] };
			},
			close: async () => {},
		},
		"pi_project",
		["pi_shared"],
	);
	assert.match(await memory.recall("decisions"), /untrusted historical evidence/);
	assert.deepEqual(wings, ["pi_project", "pi_shared"]);
	const root = mkdtempSync(join(tmpdir(), "poly-memory-"));
	assert.notEqual(projectIdentity(root).wing, projectIdentity(tmpdir()).wing);
});

test("memory rejects secrets, missing sources, oversize input, and MCP partial failures", async () => {
	const memory = new ProjectMemory(
		{
			call: async () => ({
				content: [
					{
						type: "text",
						text: JSON.stringify({ errors: [{ error: "fixture secret withheld" }] }),
					},
				],
			}),
			close: async () => {},
		},
		"pi_fixture",
	);
	await assert.rejects(memory.save(fixtureHandoff()), /MemPalace operation failed/);
	for (const content of [
		"Bearer fixture-secret",
		"refresh_token = fixture-secret",
		"sk-ant-fixture",
		"-----BEGIN RSA PRIVATE KEY-----",
		'api_key="fixture-sensitive-content"',
	])
		assert.throws(() => assertNoSecrets(content), /Sensitive/);
	assert.throws(
		() => validateHandoff({ ...fixtureHandoff(), facts: [{ text: "Guess", verified: true }] }),
		/sources/,
	);
	assert.throws(
		() => validateHandoff({ ...fixtureHandoff(), objective: "x".repeat(25000) }),
		/24 KB/,
	);
});

test("existing MemPalace discovery is read only and never initializes a palace", () => {
	const home = mkdtempSync(join(tmpdir(), "poly-mempalace-"));
	const env = { HOME: home, PATH: join(home, "bin") };
	assert.equal(discoverMemPalace(env), undefined);
	mkdirSync(join(home, "bin"));
	writeFileSync(join(home, "bin/mempalace-mcp"), "fixture executable");
	mkdirSync(join(home, ".config/mempalace/palace"), { recursive: true });
	assert.equal(discoverMemPalace(env)?.palace, join(home, ".config/mempalace/palace"));
});
