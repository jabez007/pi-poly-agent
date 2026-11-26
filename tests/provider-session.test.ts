import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerHooks, syncBuiltinESMExports } from "node:module";
import fs from "node:fs";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, normalizeContext } from "@earendil-works/pi-ai";
import { directPrompts } from "../src/providers/direct-input.ts";
import { guardedClaudeStream } from "../src/providers/claude.ts";
import { CLAUDE_ACP_RUNTIME, CLAUDE_LOGIN_MESSAGE } from "../src/providers/claude-acp.ts";
import {
	GOOGLE_ACP_RUNTIME,
	GOOGLE_LOGIN_MESSAGE,
	officialAcpFactory,
} from "../src/providers/acp.ts";
import { bootstrap, PROFILE } from "../src/profile.ts";
import { defaultPolicy } from "../src/policy.ts";
import extension from "../src/extension.ts";

for (const provider of ["claude-acp", "claude-bridge", "antigravity-acp"])
	test(`${provider} requires an interactive Pi turn and discards authorization at turn or model changes`, () => {
		const handlers = new Map<string, any[]>();
		const input = directPrompts({
			on: (name: string, handler: any) =>
				handlers.set(name, [...(handlers.get(name) || []), handler]),
		} as any);
		const context: any = {
			hasUI: true,
			mode: "tui",
			model: { provider },
			ui: { notify: () => {} },
		};
		const receive = handlers.get("input")![0];
		for (const source of ["extension", "rpc"]) {
			assert.equal(receive({ source, text: "Generated handoff" }, context).action, "handled");
			assert.throws(() => input.require(provider), /direct interactive/);
		}
		receive({ source: "interactive", text: "Human objective" }, context);
		assert.equal(input.require(provider), "Human objective");
		for (const event of ["agent_settled", "model_select", "session_start", "session_shutdown"]) {
			for (const handler of handlers.get(event)!) handler();
			assert.throws(() => input.require(provider), /direct interactive/);
			receive({ source: "interactive", text: "Human objective" }, context);
		}
	});

for (const mode of ["acp", "bridge"] as const)
	test(`full registration gates bridge loading for the selected Claude ${mode} mode`, async () => {
		const root = mkdtempSync(join(tmpdir(), "poly-bridge-mode-"));
		bootstrap(root);
		const binary = join(root, "claude");
		writeFileSync(binary, "inert fixture; never executed");
		chmodSync(binary, 0o755);
		const policy = defaultPolicy();
		policy.claude = { enabled: true, mode, path: binary };
		writeFileSync(join(root, "poly.json"), JSON.stringify(policy));
		const file = join(root, "claude-bridge.json");
		if (mode === "bridge")
			writeFileSync(
				file,
				JSON.stringify({
					provider: {
						plan: "max",
						longContextExtraUsage: false,
						strictMcpConfig: true,
						autoMemoryEnabled: false,
					},
				}),
			);
		let imports = 0,
			starts = 0;
		const hooks = registerHooks({
			resolve(specifier, context, next) {
				if (specifier !== "pi-claude-bridge/src/index.ts") return next(specifier, context);
				imports++;
				return {
					url: 'data:text/javascript,export default pi=>pi.registerProvider("claude-bridge",{api:"claude-bridge",models:[],streamSimple:()=>{throw new Error("never invoked")}})',
					shortCircuit: true,
				};
			},
		});
		const previous = process.env.PI_POLY_PROFILE;
		process.env.PI_POLY_PROFILE = root;
		const commands = new Set<string>();
		try {
			const factory = async () => {
				starts++;
				throw new Error("must not start on registration");
			};
			await extension(
				{
					registerProvider: () => {},
					registerCommand: (name: string) => commands.add(name),
					on: () => {},
				} as any,
				factory,
				factory,
			);
			assert.equal(imports, mode === "bridge" ? 1 : 0);
			assert.equal(starts, 0);
			assert.equal(commands.has("delegate"), false);
			if (mode === "bridge")
				assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {
					provider: {
						plan: "max",
						longContextExtraUsage: false,
						pathToClaudeCodeExecutable: binary,
					},
				});
			else assert.equal(existsSync(file), false);
		} finally {
			hooks.deregister();
			if (previous === undefined) delete process.env.PI_POLY_PROFILE;
			else process.env.PI_POLY_PROFILE = previous;
		}
	});

test("Google relies on cached native login and never calls ACP authenticate", async () => {
	let calls = 0;
	await GOOGLE_ACP_RUNTIME.login({ authMethods: [{ id: "oauth-personal" }] }, async () => {
		calls++;
		throw new Error("no client login");
	});
	assert.equal(calls, 0);
	await assert.rejects(
		GOOGLE_ACP_RUNTIME.login({ authMethods: [{ id: "gemini-api-key" }] }, async () => {
			calls++;
		}),
		{ message: GOOGLE_LOGIN_MESSAGE },
	);
	assert.equal(calls, 0);
	const root = mkdtempSync(join(tmpdir(), "poly-agy-path-"));
	const binary = join(root, "agy");
	writeFileSync(binary, "never executed");
	chmodSync(binary, 0o755);
	assert.deepEqual(await GOOGLE_ACP_RUNTIME.command({ enabled: true, path: binary }, root), {
		executable: binary,
		args: ["acp"],
	});
});

test("bridge login errors use the fixed native login command and iterator failures settle without replay", async () => {
	const model: any = { id: "fixture", api: "claude-bridge", provider: "claude-bridge" };
	const original: any = {
		role: "assistant",
		api: "claude-bridge",
		provider: "claude-bridge",
		model: "fixture",
		content: [],
		stopReason: "error",
		errorMessage: "Not logged in; use native login",
		timestamp: 0,
		usage: {},
	};
	const source = createAssistantMessageEventStream();
	const wrapped = guardedClaudeStream(
		() => source,
		() => {},
	);
	const result = wrapped(model, normalizeContext({ messages: [] }));
	source.push({ type: "error", reason: "error", error: original });
	source.end();
	assert.equal((await result.result()).errorMessage, CLAUDE_LOGIN_MESSAGE);
	const broken = guardedClaudeStream(
		(() => ({
			async *[Symbol.asyncIterator]() {
				yield await Promise.reject(new Error("fixture private diagnostic"));
			},
		})) as any,
		() => {},
	);
	assert.match(
		(await broken(model, normalizeContext({ messages: [] })).result()).errorMessage!,
		/no fallback/,
	);
});

test("session history remains native Pi data when no memory backend is enabled", () => {
	const root = mkdtempSync(join(tmpdir(), "poly-history-"));
	const session = SessionManager.create(root, join(root, "sessions"));
	session.appendMessage({ role: "user", content: "Human objective", timestamp: 1 });
	session.appendCustomEntry("poly-handoff", { objective: "Retained data" });
	const restored = SessionManager.open(session.getSessionFile()!);
	assert.equal(restored.getSessionId(), session.getSessionId());
	assert.equal(restored.getBranch().length, session.getBranch().length);
});

test("ordinary Pi launches use the native profile without consulting the checkout profile", async () => {
	const root = mkdtempSync(join(tmpdir(), "poly-native-profile-"));
	bootstrap(root);
	const policy = defaultPolicy();
	policy.kimiApiKey = true;
	writeFileSync(join(root, "poly.json"), JSON.stringify(policy));
	const previous = { poly: process.env.PI_POLY_PROFILE, pi: process.env.PI_CODING_AGENT_DIR };
	delete process.env.PI_POLY_PROFILE;
	process.env.PI_CODING_AGENT_DIR = root;
	const originals = {
		existsSync: fs.existsSync,
		lstatSync: fs.lstatSync,
		readFileSync: fs.readFileSync,
	};
	for (const key of ["existsSync", "lstatSync", "readFileSync"] as const) {
		(fs as any)[key] = (...args: any[]) => {
			assert.ok(!String(args[0]).startsWith(PROFILE), "The checkout profile must not be consulted");
			return (originals[key] as any)(...args);
		};
	}
	syncBuiltinESMExports();
	const providers = new Map<string, any>();
	try {
		await extension({
			on: () => {},
			registerCommand: () => {},
			registerProvider: (id: any, config: any) =>
				providers.set(typeof id === "string" ? id : id.id, config || id),
		} as any);
		assert.ok(providers.get("kimi-coding").auth.apiKey);
	} finally {
		Object.assign(fs, originals);
		syncBuiltinESMExports();
		if (previous.poly === undefined) delete process.env.PI_POLY_PROFILE;
		else process.env.PI_POLY_PROFILE = previous.poly;
		if (previous.pi === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous.pi;
	}
});

for (const runtime of [GOOGLE_ACP_RUNTIME, CLAUDE_ACP_RUNTIME])
	test(`${runtime.provider} refuses a disabled factory before resolving its executable`, async () => {
		const root = mkdtempSync(join(tmpdir(), "poly-disabled-factory-"));
		let commands = 0;
		const description = {
			...runtime,
			command: () => {
				commands++;
				throw new Error("Runtime description must not be reached");
			},
		};
		await assert.rejects(
			officialAcpFactory(
				{ enabled: false },
				root,
				description,
			)({ update: () => {}, permission: async () => ({ outcome: { outcome: "cancelled" } }) }),
			/off/,
		);
		assert.equal(commands, 0);
	});
