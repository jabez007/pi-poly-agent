import assert from "node:assert/strict";
import { test } from "node:test";

test("pinned Claude bridge routes through a mocked official SDK query", async () => {
	const path: string = "pi-claude-bridge/src/index.ts";
	const bridge = await import(path);
	let captured: any;
	bridge.__test.setQuery(({ options }: any) => {
		captured = options;
		const query: any = (async function* () {
			yield {
				type: "result",
				subtype: "success",
				is_error: false,
				result: "Mocked Claude SDK response",
			};
		})();
		query.interrupt = async () => {};
		query.close = () => {};
		return query;
	});
	try {
		const model = {
			id: "claude-fixture",
			name: "Fixture",
			api: "claude-bridge",
			provider: "claude-bridge",
			reasoning: true,
			input: ["text"],
			contextWindow: 200000,
			maxTokens: 32000,
		};
		const result = await bridge.__test
			.isolatedStreamFn(
				model,
				{ messages: [{ role: "user", content: "Fixture prompt", timestamp: 0 }] },
				{ cacheRetention: "none" },
			)
			.result();
		assert.equal(result.stopReason, "stop");
		assert.ok(result.content.some((block: any) => block.text === "Mocked Claude SDK response"));
		assert.equal(captured.strictMcpConfig, true);
		assert.deepEqual(captured.settingSources, []);
		assert.equal(captured.settings.autoMemoryEnabled, false);
		assert.equal(captured.env.ANTHROPIC_API_KEY, undefined);
	} finally {
		bridge.__test.setQuery(null);
	}
});
