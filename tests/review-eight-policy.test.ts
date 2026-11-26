import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	defaultPolicy,
	assertRequest,
	validatePolicy,
	providerStatus,
	POLICY_REVISION,
} from "../src/policy.ts";
import { bootstrap, loadPolicy, validateProfile } from "../src/profile.ts";

test("outdated Claude review locks only Claude while Google and coding providers remain usable", (t) => {
	const root = mkdtempSync(join(tmpdir(), "poly-review8-policy-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	bootstrap(root);
	const runtime = join(root, "never-execute");
	writeFileSync(runtime, "reviewed fixture");
	const policy = defaultPolicy();
	const activation = {
		enabled: true,
		review: POLICY_REVISION,
		runtime,
		sha256: createHash("sha256").update("reviewed fixture").digest("hex"),
	};
	policy.claude = { ...activation, runtime: join(root, "old-runtime-absent") };
	policy.google = activation;
	policy.zaiCodingPlan = true;
	writeFileSync(join(root, "poly.json"), JSON.stringify(policy));
	let loaded = policy;
	assert.doesNotThrow(() => {
		loaded = loadPolicy(root);
	}, "A stale Claude review must not prevent loading the whole profile");
	assert.doesNotThrow(
		() => validateProfile(root),
		"Stale Claude must not be attested during profile validation",
	);
	for (const provider of ["antigravity-acp", "openai-codex", "kimi-coding", "zai"])
		assert.doesNotThrow(() => assertRequest(provider, loaded, true));
	for (const provider of ["claude-acp", "claude-bridge"]) {
		assert.throws(() => assertRequest(provider, loaded, true), /reapproval.*claude\.review/);
		assert.match(providerStatus(provider, loaded), /needs reapproval/);
	}
});
test("malformed enabled Claude activation fields still reject the whole profile", () => {
	for (const change of [
		{ enabled: "yes" },
		{ runtime: "relative/claude" },
		{ sha256: "invalid" },
		{ runtime: undefined },
		{ review: undefined },
		{ sha256: undefined },
	]) {
		const policy = defaultPolicy();
		Object.assign(
			policy.claude,
			{
				enabled: true,
				review: POLICY_REVISION,
				runtime: "/fixture/claude",
				sha256: "a".repeat(64),
			},
			change,
		);
		assert.throws(() => validatePolicy(policy));
	}
});
test("Google's stale review continues to reject the whole profile", () => {
	const policy = defaultPolicy();
	policy.google = {
		enabled: true,
		review: "outdated",
		runtime: "/fixture/agy",
		sha256: "a".repeat(64),
	};
	assert.throws(() => validatePolicy(policy), /review/);
});

test("stale Claude review is reported by poly-status and validate without starting a runtime", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "poly-review8-status-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	bootstrap(root);
	const policy = defaultPolicy();
	policy.claude = {
		enabled: true,
		review: POLICY_REVISION,
		runtime: join(root, "old-runtime-absent"),
		sha256: "a".repeat(64),
		mode: "bridge",
	};
	writeFileSync(join(root, "poly.json"), JSON.stringify(policy));
	const before = process.env.PI_POLY_PROFILE;
	process.env.PI_POLY_PROFILE = root;
	t.after(() => {
		if (before === undefined) delete process.env.PI_POLY_PROFILE;
		else process.env.PI_POLY_PROFILE = before;
	});
	const commands = new Map<string, any>();
	const providers = new Map<string, any>();
	const messages: string[] = [];
	const { default: extension } = await import("../src/extension.ts");
	await assert.doesNotReject(
		extension(
			{
				registerCommand: (id: string, c: any) => commands.set(id, c),
				registerProvider: (id: any, config: any) =>
					providers.set(typeof id === "string" ? id : id.id, config || id),
				registerTool: () => {},
				on: () => {},
				appendEntry: () => {},
			} as any,
			async () => {
				assert.fail("A locked runtime must not start");
			},
		),
	);
	await commands
		.get("poly-status")
		.handler("", { ui: { notify: (message: string) => messages.push(message) } });
	assert.match(messages.join("\n"), /claude-acp.*needs reapproval/);
	assert.match(messages.join("\n"), /claude-bridge.*needs reapproval/);
	for (const provider of ["claude-acp", "claude-bridge"])
		assert.throws(() => providers.get(provider).streamSimple({}, {}), /reapproval.*claude\.review/);
	const { execFileSync } = await import("node:child_process");
	const output = execFileSync(
		process.execPath,
		["--import", "tsx", "scripts/cli.ts", "validate", "--profile", root, "--project", root],
		{ env: { ...process.env, PI_OFFLINE: "1" }, encoding: "utf8" },
	);
	assert.match(JSON.parse(output).claude, /needs reapproval/);
});
