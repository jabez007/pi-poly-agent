import assert from "node:assert/strict";
import { test } from "node:test";
import { permissionDecision } from "../src/providers/acp.ts";

test("ACP approvals include actionable single-use details and deny opaque requests", async () => {
	const request: any = {
		sessionId: "s",
		toolCall: {
			toolCallId: "t",
			title: "Run tests",
			kind: "execute",
			rawInput: { command: "npm test", cwd: "/project" },
			locations: [{ path: "/project/src/app.ts", line: 3 }],
		},
		options: [
			{ optionId: "once", name: "Allow", kind: "allow_once" },
			{ optionId: "all", name: "Always", kind: "allow_always" },
		],
	};
	let shown = "";
	const choose = async (title: string, options: string[]) => {
		shown = title;
		return options[0];
	};
	assert.deepEqual(await permissionDecision(request, choose), {
		outcome: { outcome: "selected", optionId: "once" },
	});
	for (const detail of [
		"Run tests",
		"npm test",
		"/project/src/app.ts",
		"execute",
		"this invocation",
	])
		assert.ok(shown.includes(detail), detail);
	for (const toolCall of [
		{ toolCallId: "t" },
		{ toolCallId: "t", title: "Please approve" },
		{ toolCallId: "t", title: "Write file", kind: "edit" },
		{ toolCallId: "t", title: "Run tests", kind: "execute", locations: [{ path: "/project" }] },
	]) {
		assert.deepEqual(
			await permissionDecision({ ...request, toolCall }, () => {
				throw new Error("must not prompt");
			}),
			{ outcome: { outcome: "cancelled" } },
		);
	}
});
