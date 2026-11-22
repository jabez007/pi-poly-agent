import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, type Provider } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { bootstrap } from "../src/profile.ts";
import { defaultPolicy } from "../src/policy.ts";
import { TaskManager, type TaskResult } from "../src/orchestration/tasks.ts";
import { createPiRunner, nativeWorkerProvider } from "../src/orchestration/runner.ts";
import { git } from "../src/orchestration/worktrees.ts";
import { scopedTools } from "../src/orchestration/tools.ts";
import {
	nativeWorkerInstructions,
	loadPlatform,
	ProviderRegistry,
	WorkflowEngine,
	validateWorkflow,
	ContextRegistry,
	nativeContext,
	memPalaceContext,
	workerTools,
	resourceInstructions,
	emptyResources,
	agentPolicy,
	effectivePolicy,
	type AgentDefinition,
	type WorkflowDefinition,
} from "../src/platform/index.ts";

const result = (): TaskResult => ({
	summary: "Claim with source evidence",
	files: [],
	tests: [],
	findings: [{ text: "Inspected", source: "app.ts:1", severity: "info" }],
	questions: [],
});
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "poly-platform-project-"));
	const profile = mkdtempSync(join(tmpdir(), "poly-platform-profile-"));
	bootstrap(profile);
	git(root, ["init", "-b", "main"]);
	git(root, ["config", "user.name", "Fixture"]);
	git(root, ["config", "user.email", "fixture@example.invalid"]);
	writeFileSync(join(root, "app.ts"), "before\n");
	git(root, ["add", "."]);
	git(root, ["commit", "-m", "base"]);
	return { root, profile };
}
function configuration(profile: string, data: object) {
	writeFileSync(join(profile, "platform.json"), JSON.stringify({ version: 1, ...data }));
}
const specialist = (name = "unknown-specialist", permissions = ["read"]): AgentDefinition => ({
	name,
	instructions: "Cite actual source evidence.",
	editing: permissions.includes("write"),
	policy: { permissions: permissions as any },
});
const single = (agent = "unknown-specialist"): WorkflowDefinition => ({
	id: "custom-process",
	steps: [{ id: "inspect", agent, objective: "{{input}}", artifacts: ["summary"] }],
});

test("arbitrary JSON agents, safe Markdown instructions and user/project precedence preserve restrictions", () => {
	const { root, profile } = fixture();
	const user = join(profile, "user.json");
	writeFileSync(
		user,
		JSON.stringify({
			version: 1,
			agents: {
				"database-specialist": {
					instructions: "User instructions",
					policy: { permissions: ["read"], tools: ["read"] },
				},
			},
			policy: { permissions: ["read"], timeoutMs: 3000 },
		}),
	);
	configuration(profile, { agents: { "database-specialist": { model: "openai-codex/fixture" } } });
	mkdirSync(join(root, ".pi"));
	writeFileSync(join(root, ".pi", "instructions.md"), "Project evidence conventions");
	writeFileSync(
		join(root, ".pi/poly.json"),
		JSON.stringify({
			version: 1,
			agents: {
				"database-specialist": {
					instructionsFile: "instructions.md",
					policy: { permissions: ["read", "write"], tools: ["read", "write"] },
				},
			},
			policy: { timeoutMs: 5000 },
		}),
	);
	const config = loadPlatform(profile, root, undefined, user);
	const agent = config.agents[0];
	assert.equal(agent.name, "database-specialist");
	assert.equal(agent.instructions, "Project evidence conventions");
	assert.equal(agent.model, "openai-codex/fixture");
	assert.deepEqual(agent.policy!.permissions, ["read"]);
	assert.deepEqual(config.policy.permissions, ["read"]);
	assert.equal(config.policy.timeoutMs, 3000);
	assert.equal(
		effectivePolicy(agentPolicy(agent), config.policy).permissions.includes("write"),
		false,
	);
});

test("untrusted project JSON cannot install executable code, providers, packages, traversal or disable sandboxes", () => {
	const { root, profile } = fixture();
	mkdirSync(join(root, ".pi"));
	const file = join(root, ".pi/poly.json");
	for (const raw of [
		{ providers: [] },
		{ packages: ["evil.json"] },
		{ extensions: ["evil.ts"] },
		{ agents: { escape: { instructionsFile: "../outside.md" } } },
		{ policy: { sandbox: "host" } },
		{ policy: { maxDepth: 2 } },
		{ agents: { escape: { command: "run me" } } },
	]) {
		writeFileSync(file, JSON.stringify({ version: 1, ...raw }));
		assert.throws(() => loadPlatform(profile, root));
	}
	writeFileSync(join(profile, "instructions.md"), "Safe instruction");
	symlinkSync(join(profile, "instructions.md"), join(root, ".pi/linked.md"));
	writeFileSync(
		file,
		JSON.stringify({ version: 1, agents: { escape: { instructionsFile: "linked.md" } } }),
	);
	assert.throws(() => loadPlatform(profile, root), /symlink/);
});

test("legacy roles keep configured models while the minimal recipe removes all mandatory agents and workflows", () => {
	const { root, profile } = fixture();
	writeFileSync(
		join(profile, "orchestration.json"),
		JSON.stringify({
			roles: { builder: { model: "openai-codex/fixture", instructions: "Legacy brief" } },
		}),
	);
	const old = loadPlatform(profile, root);
	assert.equal(old.agents.find((a) => a.name === "builder")!.model, "openai-codex/fixture");
	configuration(profile, { recipes: ["minimal"] });
	const minimal = loadPlatform(profile, root);
	assert.deepEqual(minimal.agents, []);
	assert.deepEqual(minimal.workflows, []);
	assert.deepEqual(minimal.context, ["native"]);
	assert.equal(minimal.ui.status, false);
});

test("provider instances share adapters, resolve capabilities deterministically and preserve billing and subscription restrictions", () => {
	const policy = defaultPolicy();
	const registry = new ProviderRegistry(() => policy);
	registry.register({
		id: "local-one",
		adapter: "openai-compatible",
		enabled: true,
		billing: "local",
		endpoint: "http://127.0.0.1:9011/v1",
		models: ["one"],
	});
	registry.register({
		id: "local-two",
		adapter: "openai-compatible",
		enabled: true,
		billing: "local",
		endpoint: "http://127.0.0.1:9012/v1",
		models: ["two"],
		capabilities: { editing: false },
	});
	registry.register({
		id: "paid",
		adapter: "openai-compatible",
		enabled: false,
		billing: "api",
		endpoint: "https://inference.example.invalid/v1",
		models: ["three"],
	});
	assert.equal(registry.capabilities("local-one").billing, "local");
	assert.equal(registry.capabilities("local-two").editing, false);
	assert.equal(
		registry.resolve({ requires: ["editing"] }, [
			{ provider: "local-one", id: "one" },
			{ provider: "local-two", id: "two" },
		]),
		"local-one/one",
	);
	assert.throws(
		() =>
			registry.resolve({}, [
				{ provider: "local-one", id: "one" },
				{ provider: "local-two", id: "two" },
			]),
		/exactly one/,
	);
	for (const id of ["paid", "antigravity-acp", "claude-bridge", "zai", "unregistered"])
		assert.throws(() => registry.assert(id, 1));
	assert.throws(() => registry.assert("local-one", 2), /depth/);
	for (const billing of ["subscription", "coding-plan"])
		assert.throws(() =>
			registry.register({
				id: `fake-${billing}`,
				adapter: "openai-compatible",
				billing,
				enabled: true,
			} as any),
		);
	assert.throws(() =>
		registry.register({
			id: "escape",
			adapter: "antigravity-acp",
			billing: "local",
			enabled: true,
		}),
	);
	assert.throws(() =>
		registry.register({
			id: "escape",
			adapter: "openai-compatible",
			billing: "api",
			endpoint: "https://chatgpt.com/backend-api",
			enabled: true,
		}),
	);
	assert.throws(() =>
		registry.registerAdapter({
			id: "openai-codex",
			create: () => nativeWorkerProvider("openai-codex"),
		}),
	);
	const provider = registry.provider("local-one");
	assert.equal(provider.getModels()[0].provider, "local-one");
	assert.throws(
		() =>
			provider.streamSimple({ ...provider.getModels()[0], baseUrl: "http://elsewhere.invalid" }, {
				messages: [],
			} as any),
		/endpoint/,
	);
});

function mockProvider(id: string, observe?: (context: unknown) => void): Provider {
	const base = nativeWorkerProvider("openai-codex");
	const model = {
		...base.getModels()[0],
		id: "fixture",
		provider: id,
		baseUrl: "http://127.0.0.1:1/v1",
	};
	const stream = (_model?: unknown, context?: unknown) => {
		observe?.(context);
		const events = createAssistantMessageEventStream();
		queueMicrotask(() => {
			const message: any = {
				role: "assistant",
				content: [{ type: "text", text: JSON.stringify(result()) }],
				provider: id,
				model: "fixture",
				api: model.api,
				timestamp: 0,
				stopReason: "stop",
				usage: {
					input: 0,
					output: 0,
					totalTokens: 0,
					cacheRead: 0,
					cacheWrite: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			};
			events.push({ type: "done", reason: "stop", message });
			events.end();
		});
		return events;
	};
	return {
		...base,
		id,
		baseUrl: model.baseUrl,
		auth: {
			apiKey: {
				name: "Fixture",
				check: async () => ({ type: "api_key", source: "fixture" }),
				resolve: async () => ({ auth: { apiKey: "fixture-no-network" } }),
			},
		},
		getModels: () => [model],
		getAllModels: () => [model],
		stream,
		streamSimple: stream,
	};
}

test("public provider and resource contracts execute an unknown agent in a real independent Pi SDK session", async () => {
	const { root, profile } = fixture();
	const policy = defaultPolicy();
	const registry = new ProviderRegistry(() => policy);
	let observedNativeSkill = false;
	mkdirSync(join(profile, "skills", "native-evidence"), { recursive: true });
	writeFileSync(
		join(profile, "skills", "native-evidence", "SKILL.md"),
		"---\nname: native-evidence\ndescription: Native worker evidence\n---\nNative real worker evidence.\n",
	);
	registry.registerAdapter({
		id: "fixture-adapter",
		create: (instance) =>
			mockProvider(instance.id, (context) => {
				assert.match(JSON.stringify(context), /Native real worker evidence/);
				observedNativeSkill = true;
			}),
	});
	registry.register({
		id: "fixture-instance",
		adapter: "fixture-adapter",
		billing: "local",
		enabled: true,
	});
	const resources = emptyResources();
	resources.skills["source-reading"] = "Cite source files.";
	resources.extensions["output-convention"] = () => "Keep findings short.";
	const agent = specialist();
	agent.policy = {
		permissions: ["read"],
		tools: ["read", "describe_project"],
		skills: ["source-reading", "pi:skill:native-evidence"],
		extensions: ["output-convention"],
	};
	resources.tools.push({
		name: "describe_project",
		permissions: ["read"],
		create: () => ({
			name: "describe_project",
			label: "Describe project",
			description: "Read-only fixture tool",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "app.ts" }], details: {} }),
		}),
	});
	const manager = new TaskManager(
		join(profile, "tasks"),
		root,
		() => policy,
		createPiRunner(profile, async () => false, undefined, registry, resources),
		2,
		900000,
		undefined,
		undefined,
		registry,
	);
	try {
		const task = await manager.wait(
			manager.dispatch({
				parent: "test",
				role: agent,
				provider: "fixture-instance",
				model: "fixture",
				brief: "Inspect source",
			}).id,
		);
		assert.equal(task.status, "completed", JSON.stringify(task));
		assert.equal(observedNativeSkill, true);
		assert.ok(task.sessionFile);
		assert.ok(task.artifacts?.some((a) => a.kind === "summary" && a.certainty === "claim"));
		const session = readFileSync(task.sessionFile!, "utf8");
		assert.match(session, /Approved skill source-reading/);
		assert.match(session, /Keep findings short/);
		const tools = workerTools(task, scopedTools(task.workspace.path, false), resources);
		assert.deepEqual(
			tools.map((t) => t.name),
			["read", "describe_project"],
		);
		assert.match(
			resourceInstructions(task, {
				...resources,
				skills: { ...resources.skills, ...(await nativeWorkerInstructions(task, profile)) },
			}),
			/source-reading/,
		);
		resources.tools[0].permissions = ["write"];
		assert.throws(() => workerTools(task, [], resources), /escalation/);
	} finally {
		await manager.close();
	}
});

test("all four JSON recipes use the same task and workflow engine with role-independent workspaces", async () => {
	for (const name of ["minimal", "implementation-review", "agent-team", "odoo-team"]) {
		const { root, profile } = fixture();
		configuration(profile, { recipes: [name] });
		const config = loadPlatform(profile, root);
		const seen: string[] = [];
		const manager = new TaskManager(
			join(profile, "tasks"),
			root,
			defaultPolicy,
			async ({ task }) => {
				seen.push(task.role.name);
				if (task.role.editing) writeFileSync(join(task.workspace.path, "app.ts"), "after\n");
				return result();
			},
		);
		const workflow = new WorkflowEngine(join(profile, "workflows"), manager, config.agents, {
			model: async (agent) => (agent.editing ? "openai-codex/fixture" : "kimi-coding/fixture"),
			context: async () => "Approved project source app.ts:1",
			approve: async (_step, input) => input,
		});
		try {
			if (name === "minimal") {
				assert.equal(config.workflows.length, 0);
				continue;
			}
			const run = await workflow.wait(
				workflow.start(config.workflows[0], "Change app.ts", "parent-session").id,
			);
			assert.equal(run.status, "completed", JSON.stringify(run));
			assert.equal(seen.length, config.workflows[0].steps.length);
			assert.equal(new Set(manager.list().map((t) => t.workspace.path)).size, seen.length);
			const editing = manager.list().find((t) => t.role.editing)!;
			const inspection = manager.list().find((t) => t.reviewOf === editing.id)!;
			assert.equal(inspection.reviewRevision, editing.revision);
			assert.match(inspection.context, /Source: app.ts:1/);
			assert.equal(readFileSync(join(root, "app.ts"), "utf8"), "before\n");
			manager.integrate(editing.id);
			assert.equal(readFileSync(join(root, "app.ts"), "utf8"), "after\n");
		} finally {
			await workflow.close();
			await manager.close();
		}
	}
});

test("arbitrary single, sequential and parallel workflows collect results and enforce approval gates", async () => {
	const { root, profile } = fixture();
	const agent = specialist();
	const starts: string[] = [];
	let active = 0,
		peak = 0,
		allow = true;
	const manager = new TaskManager(join(profile, "tasks"), root, defaultPolicy, async ({ task }) => {
		starts.push(task.brief);
		active++;
		peak = Math.max(peak, active);
		await new Promise((r) => setTimeout(r, 25));
		active--;
		return result();
	});
	const engine = new WorkflowEngine(join(profile, "workflows"), manager, [agent], {
		model: async () => "openai-codex/fixture",
		context: async () => "Bounded context",
		approve: async (_s, input) => (allow ? input : false),
	});
	try {
		assert.equal(
			(await engine.wait(engine.start(single(), "Read app.ts", "parent").id)).status,
			"completed",
		);
		const graph: WorkflowDefinition = {
			id: "custom-graph",
			steps: [
				{ id: "one", agent: agent.name, objective: "First" },
				{ id: "two", agent: agent.name, objective: "Second" },
				{
					id: "three",
					agent: agent.name,
					objective: "Collect",
					needs: ["one", "two"],
					contextFrom: ["one", "two"],
					when: "no-errors",
				},
			],
		};
		const run = await engine.wait(engine.start(graph, "Input", "parent").id);
		assert.equal(run.status, "completed");
		assert.equal(peak, 2);
		const collected = manager.get(run.steps.three.task!);
		assert.match(collected.context, /Historical task/);
		assert.equal(collected.parent, `workflow:${run.id}`);
		allow = false;
		const before = starts.length;
		assert.equal(
			(await engine.wait(engine.start(single(), "Declined", "parent").id)).status,
			"canceled",
		);
		assert.equal(starts.length, before);
		assert.throws(
			() =>
				validateWorkflow(
					{
						id: "cyclic",
						steps: [{ id: "bad", agent: agent.name, objective: "X", needs: ["bad"] }],
					},
					[agent],
				),
			/cycles/,
		);
	} finally {
		await engine.close();
		await manager.close();
	}
});

test("workflow failure, validated conditions, cancellation and restart records never replay execution", async () => {
	const { root, profile } = fixture();
	const agent = specialist();
	let calls = 0;
	const manager = new TaskManager(
		join(profile, "tasks"),
		root,
		defaultPolicy,
		async ({ task, signal }) => {
			calls++;
			if (task.brief === "Crash") throw new Error("transport lost");
			if (task.brief === "Wait")
				await new Promise((r) => signal.addEventListener("abort", r, { once: true }));
			return { ...result(), findings: [{ text: "Defect", source: "app.ts:1", severity: "error" }] };
		},
	);
	const hooks = {
		model: async () => "openai-codex/fixture",
		context: async () => "",
		approve: async (_s: any, input: any) => input,
	};
	let engine = new WorkflowEngine(join(profile, "workflows"), manager, [agent], hooks);
	try {
		const failed = await engine.wait(engine.start(single(), "Crash", "parent").id);
		assert.equal(failed.status, "failed");
		const conditional: WorkflowDefinition = {
			id: "conditional",
			steps: [
				{ id: "one", agent: agent.name, objective: "Check" },
				{ id: "two", agent: agent.name, objective: "Continue", needs: ["one"], when: "no-errors" },
			],
		};
		const checked = await engine.wait(engine.start(conditional, "Input", "parent").id);
		assert.equal(checked.steps.two.status, "skipped");
		const waiting = engine.start(single(), "Wait", "parent");
		await new Promise((r) => setTimeout(r, 50));
		await engine.cancel(waiting.id);
		assert.equal((await engine.wait(waiting.id)).status, "canceled");
		await engine.close();
		const file = join(profile, "workflows", `${waiting.id}.json`);
		const persisted = JSON.parse(readFileSync(file, "utf8"));
		persisted.status = "running";
		writeFileSync(file, JSON.stringify(persisted));
		const before = calls;
		engine = new WorkflowEngine(join(profile, "workflows"), manager, [agent], hooks);
		assert.equal(engine.list().find((r) => r.id === waiting.id)!.status, "interrupted");
		assert.equal(calls, before);
	} finally {
		await engine.close();
		await manager.close();
	}
});

test("context contracts support native, optional MemPalace and substituted backends with provenance and isolation", async () => {
	const contexts = new ContextRegistry();
	contexts.register(nativeContext(() => "Reviewed native handoff"));
	contexts.register({
		id: "custom",
		retrieve: async () => [
			{
				text: "Decision",
				source: "architecture.md:8",
				project: "project-a",
				certainty: "verified",
			},
			{ text: "Decision", source: "duplicate", project: "project-a", certainty: "claim" },
			{
				text: "Private other project",
				source: "other.md",
				project: "project-b",
				certainty: "verified",
			},
		],
	});
	contexts.register(
		memPalaceContext([], async () => {
			throw new Error("Backend unavailable");
		}),
	);
	const query = { project: "project-a", objective: "Decision", budget: 400 };
	const selected = await contexts.retrieve(["native", "custom", "mempalace"], query);
	assert.match(selected.text, /architecture.md:8/);
	assert.match(selected.text, /verified: Decision/);
	assert.ok(!selected.text.includes("Private other project"));
	assert.equal(selected.text.match(/Decision/g)?.length, 1);
	assert.ok(selected.text.length <= 400);
	assert.deepEqual(selected.unavailable, ["mempalace"]);
	contexts.register({
		id: "unsafe",
		retrieve: async () => [
			{
				text: "Bearer unsafe-provider-value",
				source: "secret",
				project: "project-a",
				certainty: "claim",
			},
		],
	});
	assert.ok(!(await contexts.retrieve(["unsafe"], query)).text);
	await assert.rejects(
		contexts.checkpoint("custom", query, [
			{ text: "X", source: "Y", project: "project-b", certainty: "claim" },
		]),
		/Cross-project/,
	);
	await contexts.close();
});

test("an explicitly configured local OpenAI-compatible instance executes through Pi's existing transport", async () => {
	const { createServer } = await import("node:http");
	const { root, profile } = fixture();
	let requests = 0;
	const server = createServer((request, response) => {
		requests++;
		assert.equal(request.url, "/v1/chat/completions");
		assert.equal(request.headers.authorization, "Bearer local-no-credential");
		request.resume();
		response.writeHead(200, { "content-type": "text/event-stream" });
		const data = {
			id: "fixture",
			object: "chat.completion.chunk",
			created: 0,
			model: "fixture",
			choices: [
				{
					index: 0,
					delta: { role: "assistant", content: JSON.stringify(result()) },
					finish_reason: null,
				},
			],
		};
		response.write(`data: ${JSON.stringify(data)}\n\n`);
		response.write(
			`data: ${JSON.stringify({ ...data, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
		);
		response.end("data: [DONE]\n\n");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address() as { port: number };
	const registry = new ProviderRegistry(defaultPolicy);
	registry.register({
		id: "local-runtime",
		adapter: "openai-compatible",
		billing: "local",
		enabled: true,
		endpoint: `http://127.0.0.1:${address.port}/v1`,
		models: ["fixture"],
	});
	const manager = new TaskManager(
		join(profile, "tasks"),
		root,
		defaultPolicy,
		createPiRunner(profile, async () => false, undefined, registry),
		2,
		900000,
		undefined,
		undefined,
		registry,
	);
	try {
		const task = await manager.wait(
			manager.dispatch({
				parent: "fixture",
				role: specialist(),
				provider: "local-runtime",
				model: "fixture",
				brief: "Inspect local fixture",
			}).id,
		);
		assert.equal(task.status, "completed", JSON.stringify(task));
		assert.equal(requests, 1);
		assert.equal(task.provider, "local-runtime");
	} finally {
		await manager.close();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

test("a later recipe cannot recreate an agent to drop a user-level permission restriction", () => {
	const { root, profile } = fixture();
	const user = join(profile, "user.json");
	writeFileSync(
		user,
		JSON.stringify({
			version: 1,
			agents: {
				builder: { instructions: "Read only", policy: { permissions: ["read"], tools: ["read"] } },
			},
		}),
	);
	configuration(profile, { recipes: ["implementation-review"] });
	const builder = loadPlatform(profile, root, undefined, user).agents.find(
		(a) => a.name === "builder",
	)!;
	assert.deepEqual(builder.policy!.permissions, ["read"]);
	assert.equal(builder.editing, false);
});

test("attested integration modules load only from the managed profile and checksum failures execute nothing", async () => {
	const { createHash } = await import("node:crypto");
	const { loadIntegrations } = await import("../src/platform/integrations.ts");
	const { profile } = fixture();
	const module = join(profile, "integration.mjs");
	const code =
		'export const version = 1; export function setup(host) { host.resources.skills["evidence"] = "Cite evidence"; host.context.push({ id: "custom", retrieve: async () => [] }); }';
	writeFileSync(module, code);
	writeFileSync(
		join(profile, "integrations.json"),
		JSON.stringify({
			version: 1,
			modules: [{ path: module, trust: "application-code", sha256: "0".repeat(64) }],
		}),
	);
	await assert.rejects(loadIntegrations(profile, new ProviderRegistry(defaultPolicy)), /checksum/);
	writeFileSync(
		join(profile, "integrations.json"),
		JSON.stringify({
			version: 1,
			modules: [
				{
					path: module,
					trust: "application-code",
					sha256: createHash("sha256").update(code).digest("hex"),
				},
			],
		}),
	);
	const installed = await loadIntegrations(profile, new ProviderRegistry(defaultPolicy));
	assert.equal(installed.resources.skills.evidence, "Cite evidence");
	assert.equal(installed.context[0].id, "custom");
});

test("MemPalace's optional adapter uses the supported transport and remains separately attributed", async () => {
	const contexts = new ContextRegistry();
	const calls: string[] = [];
	contexts.register(
		memPalaceContext([], async () => ({
			call: async (name, args) => {
				calls.push(`${name}:${args.wing}`);
				return { drawers: [] };
			},
			close: async () => {},
		})),
	);
	const selected = await contexts.retrieve(["mempalace"], {
		project: "pi_fixture",
		objective: "Architecture",
		budget: 2000,
	});
	assert.deepEqual(selected.unavailable, []);
	assert.match(selected.text, /MemPalace project pi_fixture/);
	assert.equal(calls.length, 1);
	assert.match(calls[0], /pi_fixture/);
	await contexts.close();
});

test("effective model, task permission and provider capability constraints apply below the UI", async () => {
	const { root, profile } = fixture();
	let calls = 0;
	const manager = new TaskManager(
		join(profile, "tasks"),
		root,
		defaultPolicy,
		async () => {
			calls++;
			return result();
		},
		2,
		900000,
		undefined,
		undefined,
		undefined,
		{ permissions: ["read"] },
	);
	const agent = specialist("custom-editor", ["read", "write", "test"]);
	agent.model = "openai-codex/required";
	try {
		assert.throws(
			() =>
				manager.dispatch({
					parent: "parent",
					role: agent,
					provider: "kimi-coding",
					model: "fixture",
					brief: "Refused model",
				}),
			/exact model/,
		);
		const task = await manager.wait(
			manager.dispatch({
				parent: "parent",
				role: agent,
				provider: "openai-codex",
				model: "required",
				brief: "Read-only effective task",
				policy: { permissions: ["read", "write", "test"] },
			}).id,
		);
		assert.equal(task.role.editing, false);
		assert.deepEqual(task.effectivePolicy!.permissions, ["read"]);
		assert.equal(calls, 1);
		const restricted = specialist();
		restricted.selection = { requires: ["nativeSubagents"] };
		assert.throws(
			() =>
				manager.dispatch({
					parent: "parent",
					role: restricted,
					provider: "openai-codex",
					model: "fixture",
					brief: "Unsupported capability",
				}),
			/unsupported/,
		);
	} finally {
		await manager.close();
	}
});

test("workflow approvals serialize UI, preserve execution identity and cannot dispatch after cancellation", async () => {
	const { root, profile } = fixture();
	const agent = specialist();
	let active = 0,
		peak = 0;
	const manager = new TaskManager(join(profile, "tasks"), root, defaultPolicy, async () =>
		result(),
	);
	const engine = new WorkflowEngine(join(profile, "workflows"), manager, [agent], {
		model: async () => "openai-codex/fixture",
		context: async () => "Approved context",
		approve: async (_s, input) => {
			active++;
			peak = Math.max(peak, active);
			await new Promise((r) => setTimeout(r, 10));
			active--;
			return { ...input, provider: "antigravity-acp", role: specialist("unsafe", ["write"]) };
		},
		changed: () => {
			throw new Error("Broken UI fixture");
		},
	});
	try {
		const graph: WorkflowDefinition = {
			id: "parallel",
			steps: [
				{ id: "one", agent: agent.name, objective: "One" },
				{ id: "two", agent: agent.name, objective: "Two" },
			],
		};
		const run = await engine.wait(engine.start(graph, "Input", "parent").id);
		assert.equal(run.status, "completed");
		assert.equal(peak, 1);
		assert.ok(
			manager.list().every((t) => t.provider === "openai-codex" && t.role.name === agent.name),
		);
	} finally {
		await engine.close();
		await manager.close();
	}
	const other = new TaskManager(join(profile, "other-tasks"), root, defaultPolicy, async () => {
		throw new Error("Must not execute");
	});
	let release: (value: any) => void = () => {};
	const blocked = new WorkflowEngine(join(profile, "other-workflows"), other, [agent], {
		model: async () => "openai-codex/fixture",
		context: async () => "",
		approve: async () =>
			new Promise((resolve) => {
				release = resolve;
			}),
	});
	try {
		const run = blocked.start(single(), "Wait for approval", "parent");
		await new Promise((r) => setTimeout(r, 20));
		await blocked.cancel(run.id);
		assert.equal((await blocked.wait(run.id)).status, "canceled");
		release(false);
		assert.equal(other.list().length, 0);
	} finally {
		await blocked.close();
		await other.close();
	}
});

test("unresponsive context backends time out without blocking native context or task creation", async () => {
	const contexts = new ContextRegistry(10);
	contexts.register({ id: "unresponsive", retrieve: async () => new Promise(() => {}) });
	contexts.register(nativeContext(() => "Useful context"));
	const selected = await contexts.retrieve(["unresponsive", "native"], {
		project: "project",
		objective: "Inspect",
		budget: 1000,
	});
	assert.deepEqual(selected.unavailable, ["unresponsive"]);
	assert.match(selected.text, /Useful context/);
});

test("Pi commands discover and run project-defined agents and workflows without a new handler", async () => {
	const { registerOrchestration } = await import("../src/orchestration/extension.ts");
	const { SessionManager } = await import("@earendil-works/pi-coding-agent");
	const { root, profile } = fixture();
	configuration(profile, { recipes: ["minimal"] });
	mkdirSync(join(root, ".pi"));
	writeFileSync(
		join(root, ".pi/poly.json"),
		JSON.stringify({
			version: 1,
			agents: {
				"document-editor": {
					instructions: "Make a bounded source change",
					policy: { permissions: ["read", "write"] },
				},
				"schema-analyst": {
					instructions: "Inspect schema evidence",
					policy: { permissions: ["read"] },
				},
			},
			workflows: {
				evidence: { steps: [{ id: "inspect", agent: "schema-analyst", objective: "{{input}}" }] },
			},
		}),
	);
	git(root, ["add", ".pi"]);
	git(root, ["commit", "-m", "Configure project agents"]);
	const commands = new Map<string, any>(),
		events = new Map<string, any>();
	const notices: string[] = [];
	const completed: any[] = [];
	const pi: any = {
		registerCommand: (n: string, c: any) => commands.set(n, c),
		registerTool: () => {},
		on: (n: string, h: any) => events.set(n, h),
		appendEntry: (_n: string, task: any) => completed.push(task),
		sendMessage: () => {},
	};
	const ctx: any = {
		cwd: root,
		hasUI: true,
		mode: "tui",
		model: { provider: "openai-codex" },
		sessionManager: SessionManager.inMemory(root),
		modelRegistry: { getAvailable: () => [{ provider: "openai-codex", id: "fixture" }] },
		ui: {
			notify: (s: string) => notices.push(s),
			setStatus: () => {},
			select: async (_s: string, choices: string[]) => choices[0],
			editor: async (_s: string, text: string) => text,
			confirm: async () => true,
		},
	};
	registerOrchestration(
		pi,
		profile,
		() => "Source app.ts:1",
		() => async () => result(),
	);
	assert.equal(commands.has("implement"), false);
	assert.equal(commands.has("review"), false);
	await commands.get("delegate").handler("schema-analyst openai-codex/fixture Inspect schema", ctx);
	await new Promise((r) => setTimeout(r, 50));
	assert.equal(completed[0].role.name, "schema-analyst");
	await commands
		.get("workflow")
		.handler("evidence Inspect schema through a declared workflow", ctx);
	await new Promise((r) => setTimeout(r, 100));
	assert.equal(completed.length, 2);
	await commands.get("workflow-runs").handler("", ctx);
	assert.ok(notices.some((n) => n.includes('"status": "completed"')));
	await commands
		.get("delegate")
		.handler("document-editor openai-codex/fixture Make a source change", ctx);
	await new Promise((r) => setImmediate(r));
	assert.equal(completed.length, 3);
	await assert.rejects(
		commands.get("task").handler(`${completed[2].id} prepare true`, ctx),
		/test permissions/,
	);
	await events.get("session_shutdown")();
});

test("the minimal Pi extension retains provider selection without creating workers or requiring memory", async () => {
	const extension = (await import("../src/extension.ts")).default;
	const { root, profile } = fixture();
	configuration(profile, { recipes: ["minimal"] });
	const old = process.env.PI_POLY_PROFILE;
	process.env.PI_POLY_PROFILE = profile;
	const providers = new Map<string, any>(),
		commands = new Map<string, any>(),
		events = new Map<string, any[]>();
	const pi: any = {
		registerProvider: (id: any, value: any) =>
			providers.set(typeof id === "string" ? id : id.id, value || id),
		registerCommand: (n: string, c: any) => commands.set(n, c),
		registerTool: () => {},
		on: (n: string, h: any) => events.set(n, [...(events.get(n) || []), h]),
	};
	try {
		await extension(pi);
		const ctx: any = {
			cwd: root,
			hasUI: true,
			mode: "tui",
			model: { provider: "openai-codex" },
			sessionManager: { getBranch: () => [] },
			ui: { setStatus: () => {}, notify: () => {} },
		};
		for (const handler of events.get("session_start") || []) await handler({}, ctx);
		assert.ok(providers.get("openai-codex").getModels().length);
		assert.ok(providers.get("kimi-coding").getModels().length);
		assert.equal(commands.has("implement"), false);
		assert.equal(commands.has("review"), false);
		const { existsSync } = await import("node:fs");
		assert.equal(existsSync(join(profile, "tasks")), false);
		for (const handler of events.get("session_shutdown") || []) await handler();
	} finally {
		if (old === undefined) delete process.env.PI_POLY_PROFILE;
		else process.env.PI_POLY_PROFILE = old;
	}
});

test("recipe selection creates only an absent profile configuration and preserves existing choices", async () => {
	const { selectRecipe } = await import("../scripts/cli.ts");
	const { root, profile } = fixture();
	selectRecipe("minimal", profile);
	const before = readFileSync(join(profile, "platform.json"), "utf8");
	assert.throws(() => selectRecipe("agent-team", profile), /overwritten/);
	assert.equal(readFileSync(join(profile, "platform.json"), "utf8"), before);
	assert.equal(loadPlatform(profile, root).agents.length, 0);
	assert.throws(() => selectRecipe("../../escape", profile), /recipe/);
});

test("omitted agent permissions default to read-only even when other execution limits are configured", () => {
	const agent: AgentDefinition = {
		name: "limited-reader",
		instructions: "Inspect source",
		editing: false,
		policy: { timeoutMs: 1000, tools: ["read", "write"] },
	};
	assert.deepEqual(agentPolicy(agent).permissions, ["read"]);
	const { root, profile } = fixture();
	configuration(profile, { agents: { "limited-reader": { policy: { timeoutMs: 1000 } } } });
	const loaded = loadPlatform(profile, root).agents[0];
	assert.equal(loaded.editing, false);
	assert.deepEqual(loaded.policy!.permissions, ["read"]);
});

test("custom artifact contracts work without new core types and model certainty is never promoted", async () => {
	const { root, profile } = fixture();
	const agent = specialist("evidence-analyst");
	agent.outputs = ["research-notes"];
	let include = true;
	const manager = new TaskManager(join(profile, "tasks"), root, defaultPolicy, async () => ({
		...result(),
		artifacts: include
			? [
					{
						kind: "research-notes",
						content: "A sourced recommendation",
						source: "app.ts:1",
						certainty: "observed",
					},
				]
			: [],
	}));
	const engine = new WorkflowEngine(join(profile, "workflows"), manager, [agent], {
		model: async () => "openai-codex/fixture",
		context: async () => "",
		approve: async (_s, input) => input,
	});
	try {
		const recipe = single(agent.name);
		recipe.steps[0].artifacts = ["research-notes"];
		const complete = await engine.wait(engine.start(recipe, "Investigate", "parent").id);
		assert.equal(complete.status, "completed");
		assert.equal(
			manager.get(complete.steps.inspect.task!).artifacts!.find((a) => a.kind === "research-notes")!
				.certainty,
			"claim",
		);
		include = false;
		const failed = await engine.wait(engine.start(recipe, "Missing required notes", "parent").id);
		assert.equal(failed.status, "failed");
		assert.ok(manager.get(failed.steps.inspect.task!).result);
	} finally {
		await engine.close();
		await manager.close();
	}
});

test("project agent configuration is discovered when Pi launches from a repository subdirectory", () => {
	const { root, profile } = fixture();
	configuration(profile, { recipes: ["minimal"] });
	mkdirSync(join(root, ".pi"));
	mkdirSync(join(root, "nested"));
	writeFileSync(
		join(root, ".pi/poly.json"),
		JSON.stringify({
			version: 1,
			agents: { "project-specialist": { instructions: "Root project instructions" } },
		}),
	);
	assert.equal(loadPlatform(profile, join(root, "nested")).agents[0].name, "project-specialist");
});
