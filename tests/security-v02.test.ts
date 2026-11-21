import assert from "node:assert/strict";
import { test } from "node:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { protectedWorkerProvider } from "../src/orchestration/stream.ts";
import { nativeWorkerProvider } from "../src/orchestration/runner.ts";
import { guardedClaudeStream } from "../src/providers/claude.ts";
import { assertInvocationEnvironment, conflictingEnvironment } from "../src/policy.ts";
import { permissionDecision } from "../src/providers/acp.ts";

test("Claude invocation refuses inherited and credential-supplied environments before SDK entry", () => {
	const saved = { ...process.env };
	for (const key of conflictingEnvironment(process.env)) delete process.env[key];
	let invoked = false;
	const stream = guardedClaudeStream(
		(() => {
			invoked = true;
		}) as any,
		() => {},
	);
	try {
		for (const name of [
			"ANTHROPIC_API_KEY",
			"ANTHROPIC_AUTH_TOKEN",
			"ANTHROPIC_BASE_URL",
			"CLAUDE_CODE_USE_BEDROCK",
			"CLAUDE_CODE_USE_VERTEX",
			"CLAUDE_CODE_USE_FOUNDRY",
			"HTTPS_PROXY",
			"LD_PRELOAD",
			"HOME",
			"PATH",
			"CLAUDE_CONFIG_DIR",
			"ENABLE_CLAUDEAI_MCP_SERVERS",
			"OTHER_GATEWAY",
		]) {
			for (const value of ["fixture-secret", ""]) {
				assert.throws(
					() => stream({} as any, {} as any, { env: { [name]: value } }),
					(e: Error) => !e.message.includes("fixture-secret"),
				);
			}
		}
		process.env.ANTHROPIC_AUTH_TOKEN = "fixture-secret";
		assert.throws(() => stream({} as any, {} as any), /Conflicting/);
		assert.equal(invoked, false);
		assert.throws(
			() => assertInvocationEnvironment({}, { ANTHROPIC_BASE_URL: "fixture-secret" }),
			/Conflicting/,
		);
	} finally {
		process.env = saved;
	}
});

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

test("child-provider failures with sensitive bodies never enter Pi histories or progress", async () => {
	const provider = nativeWorkerProvider("openai-codex");
	const model = provider.getModels()[0];
	const source = createAssistantMessageEventStream();
	const error: any = {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		content: [],
		stopReason: "error",
		errorMessage: "Bearer fixture-sensitive-value",
		timestamp: 0,
		usage: {},
	};
	let updates = 0;
	const guarded = protectedWorkerProvider({ ...provider, streamSimple: () => source }, () => {
		updates++;
	});
	const output = guarded.streamSimple(model, {} as any);
	source.push({ type: "error", reason: "error", error });
	source.end();
	const result = await output.result();
	assert.equal(result.stopReason, "error");
	assert.ok(!JSON.stringify(result).includes("fixture-sensitive-value"));
	assert.equal(updates, 1);
});

test("synchronous child transport exceptions are redacted before native session persistence", async () => {
	const provider = nativeWorkerProvider("openai-codex");
	const model = provider.getModels()[0];
	const safe = protectedWorkerProvider(
		{
			...provider,
			streamSimple: () => {
				throw new Error("Bearer fixture-sync-sensitive-value");
			},
		},
		() => {},
	);
	const result = await safe.streamSimple(model, {} as any).result();
	assert.equal(result.stopReason, "error");
	assert.ok(!JSON.stringify(result).includes("fixture-sync-sensitive-value"));
});
