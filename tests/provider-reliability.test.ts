import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { bootstrap } from "../src/profile.ts";
import { defaultPolicy } from "../src/policy.ts";
import { createPiRunner, nativeWorkerProvider } from "../src/orchestration/runner.ts";
import { TaskManager } from "../src/orchestration/tasks.ts";
import { defaultRoles } from "../src/orchestration/roles.ts";
import { git } from "../src/orchestration/worktrees.ts";

test("real Pi SDK Z.AI worker completes and native transport errors remain categorized and private", async () => {
	const root = mkdtempSync(join(tmpdir(), "poly-provider-project-"));
	const profile = mkdtempSync(join(tmpdir(), "poly-provider-profile-"));
	bootstrap(profile);
	const policy = defaultPolicy();
	policy.zaiCodingPlan = true;
	writeFileSync(join(profile, "poly.json"), JSON.stringify(policy));
	git(root, ["init", "-b", "main"]);
	git(root, ["config", "user.name", "Fixture"]);
	git(root, ["config", "user.email", "fixture@example.invalid"]);
	writeFileSync(join(root, "app.ts"), "before\n");
	git(root, ["add", "."]);
	git(root, ["commit", "-m", "base"]);
	let error: string | undefined;
	let calls = 0;
	const factory = (id: string): any => {
		const provider = nativeWorkerProvider(id);
		const model = { ...provider.getModels()[0], id: "fixture", provider: id };
		const stream = () => {
			calls++;
			const events = createAssistantMessageEventStream();
			queueMicrotask(() => {
				const message: any = {
					role: "assistant",
					content: error
						? []
						: [
								{
									type: "text",
									text: JSON.stringify({
										summary: "Z.AI result",
										files: [],
										tests: [],
										findings: [],
										questions: [],
									}),
								},
							],
					stopReason: error ? "error" : "stop",
					errorMessage: error,
					provider: id,
					api: model.api,
					model: model.id,
					timestamp: 0,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				};
				if (error) events.push({ type: "error", reason: "error", error: message });
				else events.push({ type: "done", reason: "stop", message });
				events.end();
			});
			return events;
		};
		return {
			...provider,
			auth: {
				apiKey: {
					name: "Fixture",
					check: async () => ({ configured: true }),
					resolve: async () => ({ auth: { apiKey: "fixture-no-network" } }),
				},
			},
			getModels: () => [model],
			getAllModels: () => [model],
			stream,
			streamSimple: stream,
		};
	};
	const manager = new TaskManager(
		join(profile, "tasks"),
		root,
		() => policy,
		createPiRunner(profile, async () => false, factory),
	);
	try {
		const input = {
			parent: "test",
			provider: "zai",
			model: "fixture",
			role: defaultRoles().find((r) => r.name === "researcher")!,
			brief: "Inspect project only",
		};
		const completed = await manager.wait(manager.dispatch(input).id);
		assert.equal(completed.status, "completed", JSON.stringify(completed));
		assert.match(completed.result!.summary, /Z.AI/);
		assert.ok(completed.sessionFile);
		for (const [body, code] of [
			["401 Unauthorized", "authentication"],
			["429 quota exhausted", "quota"],
			["socket connection reset", "transport"],
			["context window exhausted", "context"],
		]) {
			error = `${body} Bearer private-provider-value`;
			const before = calls;
			const failed = await manager.wait(manager.dispatch(input).id);
			assert.equal(failed.status, "failed");
			assert.equal(failed.failureCode, code);
			assert.equal(calls - before, 1, "no retries or provider fallback");
			assert.ok(!readFileSync(failed.sessionFile!, "utf8").includes("private-provider-value"));
		}
	} finally {
		await manager.close();
	}
});
