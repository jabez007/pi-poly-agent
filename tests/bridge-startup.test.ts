import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { normalizeContext } from "@earendil-works/pi-ai";
import extension from "../src/extension.ts";
import { bootstrap } from "../src/profile.ts";
import { defaultPolicy } from "../src/policy.ts";

for (const cause of ["ANTHROPIC_API_KEY", "missing claude"])
	test(`bridge startup isolates ${cause} refusal without importing upstream`, async (t) => {
		const root = mkdtempSync(join(tmpdir(), "poly-bridge-refusal-"));
		t.after(() => rmSync(root, { recursive: true, force: true }));
		bootstrap(root);
		const policy = defaultPolicy();
		policy.claude = { enabled: true, mode: "bridge" };
		const previous = { ...process.env };
		t.after(() => {
			for (const name of ["PI_POLY_PROFILE", "PATH", "ANTHROPIC_API_KEY"])
				if (previous[name] === undefined) delete process.env[name];
				else process.env[name] = previous[name];
		});
		process.env.PI_POLY_PROFILE = root;
		process.env.PATH = root;
		if (cause === "ANTHROPIC_API_KEY") {
			const binary = join(root, "claude");
			writeFileSync(binary, "inert fixture, never executed");
			chmodSync(binary, 0o755);
			process.env.ANTHROPIC_API_KEY = "fixture-private-value";
		}
		writeFileSync(join(root, "poly.json"), JSON.stringify(policy));
		let imports = 0;
		const hooks = registerHooks({
			resolve(specifier, context, next) {
				if (specifier !== "pi-claude-bridge/src/index.ts") return next(specifier, context);
				imports++;
				throw new Error("Bridge import must not be reached");
			},
		});
		t.after(() => hooks.deregister());
		const providers = new Map<string, any>();
		const commands = new Set<string>();
		const handlers = new Map<string, any[]>();
		await assert.doesNotReject(
			extension({
				registerProvider: (id: any, config: any) =>
					providers.set(typeof id === "string" ? id : id.id, config || id),
				registerCommand: (id: string) => commands.add(id),
				on: (id: string, handler: any) => handlers.set(id, [...(handlers.get(id) || []), handler]),
			} as any),
			"Bridge startup refusal must not stop Poly registration",
		);
		assert.equal(imports, 0);
		for (const id of ["openai-codex", "kimi-coding", "zai", "claude-acp", "antigravity-acp"])
			assert.ok(providers.has(id), `${id} remains registered`);
		for (const id of ["poly-status", "poly-doctor", "poly-google-discover", "poly-claude-discover"])
			assert.ok(commands.has(id), `${id} remains registered`);
		assert.equal(handlers.get("tool_call")?.length, 1);
		const context = {
			model: { provider: "claude-bridge" },
			hasUI: true,
			mode: "tui",
		};
		handlers.get("input")![0]({ source: "interactive", text: "Human prompt" }, context);
		const provider = providers.get("claude-bridge");
		assert.throws(
			() => provider.streamSimple(provider.models[0], normalizeContext({ messages: [] })),
			(error: Error) => {
				assert.match(
					error.message,
					cause === "missing claude" ? /Cannot find claude/ : /ANTHROPIC_API_KEY/,
				);
				assert.ok(!error.message.includes("fixture-private-value"));
				return true;
			},
		);
	});
