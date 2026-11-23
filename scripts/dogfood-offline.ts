import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { bootstrap } from "../src/profile.ts";
import { defaultPolicy } from "../src/policy.ts";
import { assertNoSecrets } from "../src/memory.ts";
import { loadPlatform } from "../src/platform/config.ts";
import { WorkflowEngine } from "../src/platform/workflows.ts";
import { createPiRunner } from "../src/orchestration/runner.ts";
import { TaskManager, type TaskResult } from "../src/orchestration/tasks.ts";
import { atomicRecord } from "../src/orchestration/storage.ts";
import { git, workspaceDiff } from "../src/orchestration/worktrees.ts";
import { deterministicProvider } from "../tests/fixtures/deterministic-provider.ts";

const ROOT = resolve(import.meta.dirname, "..");
export const DOGFOOD_FILE = "docs/dogfooding-observation.md";
export const DOGFOOD_CONTENT =
	"# Dogfooding observation\n\nQualification status: live testing pending.\n";
export const DOGFOOD_TEST = `node --input-type=module -e 'import assert from "node:assert/strict"; import {readFileSync} from "node:fs"; assert.equal(readFileSync("${DOGFOOD_FILE}","utf8"),${JSON.stringify(DOGFOOD_CONTENT)});'`;
export const DOGFOOD_OBJECTIVE = `Create only ${DOGFOOD_FILE} containing exactly ${JSON.stringify(DOGFOOD_CONTENT)}. Run this acceptance command after approval: ${DOGFOOD_TEST}. Do not edit authentication, provider-policy or implementation files. Return sourced evidence; independent review and integration are separate approvals.`;

function responses(provider: string, context: any): any[] {
	const turns = context.messages.filter((m: any) => m.role === "toolResult").length;
	const tool = (name: string, args: object) => [
		{ type: "toolCall", id: `fixture-${turns}`, name, arguments: args },
	];
	if (provider === "openai-codex" && turns === 0)
		return tool("write", { path: DOGFOOD_FILE, content: DOGFOOD_CONTENT });
	if (provider === "openai-codex" && turns === 1)
		return tool("run_test", { command: DOGFOOD_TEST });
	if (provider === "kimi-coding" && turns === 0) return tool("review_diff", { path: DOGFOOD_FILE });
	if (provider === "kimi-coding" && turns === 1) return tool("read", { path: DOGFOOD_FILE });
	const result: TaskResult = {
		summary: `${provider}: offline fixture completed`,
		files: [DOGFOOD_FILE],
		tests: [],
		findings:
			provider === "kimi-coding"
				? [
						{
							text: "The exact file states that live testing is pending.",
							source: `${DOGFOOD_FILE}:3`,
							severity: "info",
						},
					]
				: [],
		questions: [],
	};
	return [{ type: "text", text: JSON.stringify(result) }];
}

/** Product exercise through the real workflow/task/SDK engine. Providers and approvals are fixtures. */
export async function dogfoodOffline(integrate = false) {
	const directory = mkdtempSync(join(tmpdir(), "poly-dogfood-"));
	const project = join(directory, "repository"),
		profile = join(project, ".poly/agent");
	git(ROOT, ["clone", "--no-hardlinks", "--no-checkout", ROOT, project]);
	git(project, ["checkout", "-b", "dogfood/offline", "HEAD"]);
	git(project, ["config", "user.name", "Offline qualification"]);
	git(project, ["config", "user.email", "fixture@example.invalid"]);
	bootstrap(profile);
	const policy = defaultPolicy();
	policy.kimiApiKey = true; // Only permits the injected fixture auth seam; no real key or network transport exists.
	writeFileSync(join(profile, "poly.json"), JSON.stringify(policy));
	writeFileSync(
		join(profile, "platform.json"),
		readFileSync(join(ROOT, "examples/dogfood/platform.json")),
	);
	const config = loadPlatform(profile, project);
	let requests = 0,
		testApprovals = 0,
		stepApprovals = 0;
	const runner = createPiRunner(
		profile,
		async () => {
			testApprovals++;
			return true;
		},
		(id) =>
			deterministicProvider(
				id,
				(c) => responses(id, c),
				() => requests++,
			),
	);
	const tasks = new TaskManager(join(profile, "tasks"), project, () => policy, runner);
	const engine = new WorkflowEngine(join(profile, "workflows"), tasks, config.agents, {
		model: async (agent) => (agent.editing ? "openai-codex/fixture" : "kimi-coding/fixture"),
		context: async () => "Native-only context. No MemPalace backend is configured.",
		approve: async (_step, input) => {
			stepApprovals++;
			return { ...input, requestBudget: { requests: 8, outputTokens: 1024 } };
		},
	});
	try {
		const run = await engine.wait(
			engine.start(config.workflows[0], DOGFOOD_OBJECTIVE, "offline-dogfood-parent").id,
		);
		assert.equal(run.status, "completed");
		const implementation = tasks.get(run.steps.document.task!),
			review = tasks.get(run.steps.inspect.task!);
		assert.equal(review.reviewRevision, implementation.revision);
		assert.ok(implementation.result!.tests.some((t) => t.includes("exit 0")));
		assert.equal(testApprovals, 1);
		assert.equal(stepApprovals, 2);
		const parentBefore = git(project, ["rev-parse", "HEAD"]);
		const diff = workspaceDiff(implementation.workspace).diff;
		assert.match(diff, /live testing pending/);
		if (integrate) tasks.integrate(implementation.id);
		else assert.equal(git(project, ["rev-parse", "HEAD"]), parentBefore);
		const report = {
			mode: "offline-fixture",
			liveQualified: false,
			directory,
			project,
			profile,
			sourceRevision: parentBefore,
			workflow: run.id,
			requests,
			testApprovals,
			stepApprovals,
			integrated: integrate,
			tasks: tasks.list(),
			diff,
		};
		assertNoSecrets(report);
		atomicRecord(join(directory, "report.json"), report);
		return report;
	} finally {
		await engine.close();
		await tasks.close();
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	dogfoodOffline()
		.then((r) =>
			console.log(
				`Offline product exercise passed. Live dogfooding remains pending.\nArtifacts: ${join(r.directory, "report.json")}`,
			),
		)
		.catch(() => {
			console.error(
				"Offline product exercise failed. No live provider was used; preserved worktrees require inspection.",
			);
			process.exitCode = 1;
		});
}
