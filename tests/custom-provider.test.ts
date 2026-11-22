import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import { normalizeContext } from "@earendil-works/pi-ai";
import { ProviderRegistry } from "../src/platform/providers.ts";
import { defaultPolicy } from "../src/policy.ts";
import { qualificationPlan } from "../src/orchestration/qualification.ts";

const context = () =>
	normalizeContext({
		messages: [{ role: "user", content: "Inspect local fixture", timestamp: 0 }],
	});
const chunk = (delta: object, finish_reason: string | null = null) => ({
	id: "local",
	object: "chat.completion.chunk",
	created: 0,
	model: "fixture",
	choices: [{ index: 0, delta, finish_reason }],
});
async function endpoint(handler: RequestListener) {
	const server = createServer(handler);
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	return {
		url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
		close: () => {
			server.closeAllConnections();
			return new Promise<void>((done) => server.close(() => done()));
		},
	};
}
function registration(url: string) {
	const registry = new ProviderRegistry(defaultPolicy);
	registry.register({
		id: "local-one",
		adapter: "openai-compatible",
		enabled: true,
		billing: "local",
		endpoint: url,
		models: ["fixture"],
		modelLimits: { contextWindow: 4096, maxTokens: 1024 },
	});
	return registry;
}

test("local compatible transports stream text and fragmented JSON tool arguments using Pi's pinned client", async () => {
	const requests: any[] = [];
	const local = await endpoint((request, response) => {
		let body = "";
		request.on("data", (data) => (body += data));
		request.on("end", () => {
			requests.push(JSON.parse(body));
			response.writeHead(200, { "content-type": "text/event-stream" });
			for (const data of [
				chunk({ role: "assistant", content: "Inspecting source" }),
				chunk({
					tool_calls: [
						{
							index: 0,
							id: "call-1",
							type: "function",
							function: { name: "inspect_source", arguments: '{"path":' },
						},
					],
				}),
				chunk({ tool_calls: [{ index: 0, function: { arguments: '"source.ts"}' } }] }),
				chunk({}, "tool_calls"),
			])
				response.write(`data: ${JSON.stringify(data)}\n\n`);
			response.end("data: [DONE]\n\n");
		});
	});
	try {
		const provider = registration(local.url).provider("local-one");
		const model = provider.getModels()[0];
		assert.equal(model.contextWindow, 4096);
		assert.equal(model.maxTokens, 1024);
		const input = normalizeContext({
			...context(),
			tools: [
				{
					name: "inspect_source",
					description: "Inspect one file",
					parameters: {
						type: "object",
						properties: { path: { type: "string" } },
						required: ["path"],
					},
				},
			],
		});
		const stream = provider.streamSimple(model, input, { apiKey: "local-no-credential" });
		const events: string[] = [];
		for await (const event of stream) events.push(event.type);
		const output = await stream.result();
		assert.ok(events.includes("text_delta"));
		assert.ok(events.includes("toolcall_end"));
		const tool = output.content.find((part) => part.type === "toolCall");
		assert.equal(tool?.name, "inspect_source");
		assert.deepEqual(tool?.arguments, { path: "source.ts" });
		assert.equal(requests.length, 1);
		assert.equal(requests[0].model, "fixture");
		assert.equal(requests[0].tools[0].function.name, "inspect_source");
	} finally {
		await local.close();
	}
});

test("multiple instances share the Pi adapter without sharing activation, models, limits or capabilities", () => {
	const registry = registration("http://127.0.0.1:1/v1");
	registry.register({
		id: "local-two",
		adapter: "openai-compatible",
		enabled: true,
		billing: "local",
		endpoint: "http://127.0.0.1:2/v1",
		models: ["second"],
		capabilities: { tools: false, nativeSubagents: true, persistentSessions: true },
	});
	const provider = registry.provider("local-two");
	const model = provider.getModels()[0];
	assert.equal(model.id, "second");
	assert.equal(registry.capabilities("local-two").tools, false);
	assert.equal(registry.capabilities("local-two").persistentSessions, false);
	assert.equal(registry.capabilities("local-two").nativeSubagents, false);
	assert.throws(
		() => provider.streamSimple({ ...model, id: "missing" }, context()),
		/Unregistered/,
	);
	assert.throws(
		() => provider.streamSimple({ ...model, contextWindow: 999999 }, context()),
		/metadata override/,
	);
	assert.throws(
		() =>
			provider.streamSimple(
				model,
				normalizeContext({
					...context(),
					tools: [
						{
							name: "forbidden",
							parameters: { type: "object", properties: {} },
							description: "No tools",
						},
					],
				}),
			),
		/capability is disabled/,
	);
	assert.throws(
		() =>
			registry.register({
				id: "bad",
				adapter: "openai-compatible",
				enabled: true,
				billing: "local",
				endpoint: "http://127.0.0.1:1",
				models: ["fixture"],
				modelLimits: { contextWindow: 100, maxTokens: 1000 },
			}),
		/model limits/,
	);
	assert.throws(
		() =>
			registry.register({
				id: "bad-subscription",
				adapter: "openai-compatible",
				enabled: true,
				billing: "subscription",
				endpoint: "http://127.0.0.1:1",
				models: ["fixture"],
			}),
		/local or API/,
	);
	assert.throws(
		() =>
			registry.register({
				id: "antigravity-acp",
				adapter: "openai-compatible",
				enabled: true,
				billing: "local",
				endpoint: "http://127.0.0.1:1",
				models: ["fixture"],
			}),
		/reserved/,
	);
	assert.throws(
		() => registry.resolve({ instance: "unknown" }, [{ provider: "local-one", id: "fixture" }]),
		/exactly one/,
	);
});

test("endpoint failures and malformed responses terminate without retries or provider substitution", async () => {
	for (const status of [401, 429, 503, 200]) {
		let requests = 0;
		const local = await endpoint((request, response) => {
			requests++;
			request.resume();
			response.writeHead(status, {
				"content-type": status === 200 ? "text/event-stream" : "application/json",
			});
			response.end(
				status === 200
					? "data: {malformed-json}\n\ndata: [DONE]\n\n"
					: JSON.stringify({ error: { message: "Offline fixture error", type: "fixture" } }),
			);
		});
		try {
			const provider = registration(local.url).provider("local-one");
			const stream = provider.streamSimple(provider.getModels()[0], context(), {
				apiKey: "local-no-credential",
			});
			const output = await stream.result();
			assert.equal(output.stopReason, "error", `status ${status}`);
			assert.equal(requests, 1);
		} finally {
			await local.close();
		}
	}
	const provider = registration("http://127.0.0.1:1/v1").provider("local-one");
	assert.equal(
		(
			await provider
				.streamSimple(provider.getModels()[0], context(), { apiKey: "local-no-credential" })
				.result()
		).stopReason,
		"error",
	);
});

test("transport cancellation aborts the local connection and cannot trigger fallback", async () => {
	let requestStarted!: () => void;
	const started = new Promise<void>((done) => (requestStarted = done));
	let requests = 0;
	const local = await endpoint((request, response) => {
		requests++;
		request.resume();
		response.writeHead(200, { "content-type": "text/event-stream" });
		response.write(`data: ${JSON.stringify(chunk({ role: "assistant", content: "begin" }))}\n\n`);
		requestStarted();
	});
	try {
		const provider = registration(local.url).provider("local-one");
		const abort = new AbortController();
		const stream = provider.streamSimple(provider.getModels()[0], context(), {
			apiKey: "local-no-credential",
			signal: abort.signal,
		});
		await started;
		abort.abort();
		assert.equal((await stream.result()).stopReason, "aborted");
		assert.equal(requests, 1);
	} finally {
		await local.close();
	}
});

test("custom live qualification is an offline checklist with explicit local or API billing and no subscription runtime activation", () => {
	const registry = registration("http://127.0.0.1:1/v1");
	const plan = qualificationPlan("local-one", defaultPolicy(), registry.list());
	assert.equal(plan.capabilities.billing, "local");
	assert.ok(plan.scenarios.every((s) => s.outcome === "not-run"));
	assert.match(plan.scenarios[0].procedure, /No subscription credential/);
	assert.throws(() => qualificationPlan("antigravity-acp"), /remain blocked/);
});
