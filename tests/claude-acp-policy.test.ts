import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultPolicy, assertRequest, validatePolicy } from "../src/policy.ts";
import { checkpointBeforeCompaction } from "../src/memory.ts";

test("Claude selects ACP by default and bridge only when explicitly selected", () => {
	const policy = validatePolicy({ ...defaultPolicy(), claude: { enabled: true } });
	assert.doesNotThrow(() => assertRequest("claude-acp", policy, true));
	assert.throws(() => assertRequest("claude-bridge", policy, true), /selected/);
	policy.claude.mode = "bridge";
	assert.doesNotThrow(() => assertRequest("claude-bridge", policy, true));
	assert.throws(() => assertRequest("claude-acp", policy, true), /selected/);
});
for (const provider of ["claude-acp", "claude-bridge", "antigravity-acp"])
	test(`${provider} compaction refuses without invoking a provider or a checkpoint`, async () => {
		let called = false;
		assert.equal(
			await checkpointBeforeCompaction(
				{
					manual: true,
					willRetry: false,
					interactive: true,
					provider,
					memoryEnabled: true,
					handoff: {} as any,
				},
				async () => {
					called = true;
					return true;
				},
				async () => {
					called = true;
				},
			),
			false,
		);
		assert.equal(called, false);
	});
