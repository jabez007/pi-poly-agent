import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { registerHooks, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import extension from "../src/extension.ts";
import { bootstrap } from "../src/profile.ts";
import { defaultPolicy, CLAUDE_REVIEW_REVISION } from "../src/policy.ts";

test("ACP activation leaves bridge unattested and unimported during full extension registration", async (t) => {
	const root = fs.mkdtempSync(join(tmpdir(), "poly-review8-extension-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	bootstrap(root);
	const runtime = join(root, "never-execute");
	fs.writeFileSync(runtime, "reviewed fixture");
	const policy = defaultPolicy();
	policy.claude = {
		enabled: true,
		review: CLAUDE_REVIEW_REVISION,
		runtime,
		sha256: createHash("sha256").update("reviewed fixture").digest("hex"),
	};
	fs.writeFileSync(join(root, "poly.json"), JSON.stringify(policy));
	fs.writeFileSync(
		join(root, "claude-bridge.json"),
		JSON.stringify({
			provider: {
				pathToClaudeCodeExecutable: runtime,
				longContextExtraUsage: false,
				strictMcpConfig: true,
				autoMemoryEnabled: false,
			},
		}),
	);
	const before = process.env.PI_POLY_PROFILE;
	process.env.PI_POLY_PROFILE = root;
	t.after(() => {
		if (before === undefined) delete process.env.PI_POLY_PROFILE;
		else process.env.PI_POLY_PROFILE = before;
	});
	let nativeReads = 0;
	let bridgeImports = 0;
	const read = fs.readFileSync;
	t.mock.method(fs, "readFileSync", (...args: any[]) => {
		if (args[0] === runtime) nativeReads++;
		return (read as any)(...args);
	});
	syncBuiltinESMExports();
	t.after(() => {
		t.mock.restoreAll();
		syncBuiltinESMExports();
	});
	const hook = registerHooks({
		resolve(specifier, context, next) {
			if (specifier === "pi-claude-bridge/src/index.ts") {
				bridgeImports++;
				throw new Error("Fixture blocks upstream bridge execution");
			}
			return next(specifier, context);
		},
	});
	t.after(() => hook.deregister());
	const providers = new Map<string, any>();
	await assert.doesNotReject(
		extension(
			{
				registerCommand: () => {},
				registerTool: () => {},
				on: () => {},
				appendEntry: () => {},
				registerProvider: (id: any, config: any) =>
					providers.set(typeof id === "string" ? id : id.id, config || id),
			} as any,
			async () => {
				assert.fail("Registration must not start a runtime");
			},
		),
	);
	assert.equal(nativeReads, 1, "Only profile validation may attest the native executable");
	assert.equal(bridgeImports, 0, "ACP activation must never import the bridge");
	assert.equal(providers.get("claude-bridge").baseUrl, "locked://claude-sdk");
});
