import assert from "node:assert/strict";
import { test } from "node:test";
import { AcpSession, type AcpPort } from "../src/providers/acp.ts";
import { CLAUDE_ACP_RUNTIME } from "../src/providers/claude-acp.ts";

function sessionFixture(mode: string, restore = true) {
	let current = mode;
	const calls: string[] = [];
	const reports: string[] = [];
	let closed = false;
	const port: AcpPort = {
		supportsLoad: true,
		request: async (method, params) => {
			calls.push(method);
			if (method === "session/load" || method === "session/new")
				return {
					sessionId: "fixture",
					modes: {
						currentModeId: mode,
						availableModes: ["default", "plan", "acceptEdits"].map((id) => ({ id, name: id })),
					},
					configOptions: [
						{
							id: "model",
							category: "model",
							type: "select",
							name: "Model",
							currentValue: "claude-fixture",
							options: [{ value: "claude-fixture", name: "Fixture" }],
						},
					],
				};
			if (method === "session/set_mode") current = params.modeId;
			return {};
		},
		notify: async () => {},
		close: () => {
			closed = true;
		},
	};
	const session = new AcpSession(
		async () => port,
		"/fixture",
		async () => undefined,
		{
			saved: restore ? { sessionId: "fixture", cwd: "/fixture" } : undefined,
			save: () => {},
			report: (text) => reports.push(text),
		},
		CLAUDE_ACP_RUNTIME,
	);
	return { session, calls, reports, current: () => current, closed: () => closed };
}
for (const mode of ["plan", "acceptEdits"])
	test(`restored Claude ${mode} session resets to default`, async () => {
		const f = sessionFixture(mode);
		await assert.doesNotReject(f.session.discover());
		assert.equal(f.current(), "default");
		assert.deepEqual(f.calls, ["session/load", "session/set_mode"]);
	});
for (const mode of ["auto", "bypassPermissions"])
	test(`restored Claude ${mode} session refuses with explicit new-session guidance`, async () => {
		const f = sessionFixture(mode);
		await assert.rejects(f.session.discover());
		assert.match(f.reports.join("\n"), /poly-claude-discover new/);
		assert.equal(f.closed(), true);
		assert.deepEqual(f.calls, ["session/load"]);
	});
test("new Claude plan session is still refused before default can be selected", async () => {
	const f = sessionFixture("plan", false);
	await assert.rejects(f.session.discover(), /did not start in default/);
	assert.deepEqual(f.calls, ["session/new"]);
});
