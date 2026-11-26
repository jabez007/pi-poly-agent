import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerClaudeBridge } from "../src/providers/claude.ts";
import { bootstrap } from "../src/profile.ts";
import { test } from "node:test";
import { defaultPolicy, assertRequest, validatePolicy, POLICY_REVISION } from "../src/policy.ts";
import { ProviderRegistry } from "../src/platform/providers.ts";
import { checkpointBeforeCompaction } from "../src/memory.ts";

const reviewed = () => ({
	enabled: true,
	review: "2026-11-25.1",
	runtime: "/fixture/claude",
	sha256: "a".repeat(64),
});

test("both Claude modes are locked before activation", () => {
	for (const id of ["claude-acp", "claude-bridge"])
		assert.throws(() => assertRequest(id, defaultPolicy(), true), /locked|review/);
});
test("Claude activation selects ACP by default and bridge only by explicit configuration", () => {
	const policy = defaultPolicy();
	policy.claude = reviewed();
	assert.doesNotThrow(() => assertRequest("claude-acp", policy, true));
	assert.throws(() => assertRequest("claude-bridge", policy, true), /selected/);
	Object.assign(policy.claude, { mode: "bridge" });
	assert.doesNotThrow(() => assertRequest("claude-bridge", policy, true));
	assert.throws(() => assertRequest("claude-acp", policy, true), /selected/);
});
test("Claude reapproval leaves the existing Google review revision valid", () => {
	const policy = defaultPolicy();
	policy.claude = reviewed();
	policy.google = { ...reviewed(), review: POLICY_REVISION };
	assert.doesNotThrow(() => validatePolicy(policy));
	policy.claude.review = POLICY_REVISION;
	assert.doesNotThrow(() => validatePolicy(policy));
	assert.doesNotThrow(() => assertRequest("antigravity-acp", policy, true));
	assert.throws(() => assertRequest("claude-acp", policy, true), /reapproval.*claude\.review/);
});
test("Claude ACP requires direct interaction and neither mode can become a worker or alias", () => {
	const policy = defaultPolicy();
	policy.claude = reviewed();
	assert.throws(() => assertRequest("claude-acp", policy), /direct interactive/);
	const registry = new ProviderRegistry(() => policy);
	for (const id of ["claude-acp", "claude-bridge"]) {
		assert.equal(registry.capabilities(id).delegation, false);
		assert.throws(() => registry.assert(id, 1), /authorized/);
		assert.throws(
			() =>
				registry.registerAdapter({
					id,
					create: () => {
						throw new Error("never run");
					},
				}),
			/reserved/,
		);
	}
	assert.throws(
		() =>
			registry.register({
				id: "claude-alias",
				adapter: "claude-acp",
				enabled: true,
				billing: "local",
			}),
		/Unknown/,
	);
});
test("Claude ACP compaction refuses before requesting a handoff checkpoint", async () => {
	let called = false;
	assert.equal(
		await checkpointBeforeCompaction(
			{
				manual: true,
				willRetry: false,
				interactive: true,
				provider: "claude-acp",
				memoryEnabled: true,
				handoff: {} as any,
			},
			async () => {
				called = true;
				return true;
			},
			async () => {},
		),
		false,
	);
	assert.equal(called, false);
});

test("explicit bridge activation retains its reviewed claude-bridge.json requirement", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "claude-bridge-preservation-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	bootstrap(root);
	const runtime = join(root, "never-execute");
	writeFileSync(runtime, "fixture");
	const activation = {
		...reviewed(),
		runtime,
		sha256: createHash("sha256").update("fixture").digest("hex"),
	};
	await assert.rejects(
		registerClaudeBridge({} as ExtensionAPI, root, activation, () => {}),
		/Configuration is missing/,
	);
});
