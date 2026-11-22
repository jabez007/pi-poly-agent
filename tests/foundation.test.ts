import { normalizeContext } from "@earendil-works/pi-ai";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
	bootstrap,
	loadPolicy,
	validateProfile,
	validateClaudeSettings,
	readConfiguration,
} from "../src/profile.ts";
import {
	ACP_PROVIDER,
	assertEnvironment,
	assertRequest,
	conflictingEnvironment,
	defaultPolicy,
	guardedProvider,
	POLICY_REVISION,
	validatePolicy,
} from "../src/policy.ts";
import { assertNode, launchArguments, assertProjectConfiguration } from "../scripts/cli.ts";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";

test("bootstrap is idempotent and preserves existing configuration", () => {
	const root = mkdtempSync(join(tmpdir(), "poly-install-"));
	const profile = join(root, "isolated");
	const existing = join(root, "existing.json");
	writeFileSync(existing, "personal configuration");
	bootstrap(profile);
	const before = readFileSync(join(profile, "poly.json"), "utf8");
	bootstrap(profile);
	assert.equal(readFileSync(join(profile, "poly.json"), "utf8"), before);
	assert.equal(readFileSync(existing, "utf8"), "personal configuration");
	writeFileSync(join(profile, "settings.json"), "custom settings");
	assert.throws(() => bootstrap(profile));
	assert.equal(readFileSync(join(profile, "settings.json"), "utf8"), "custom settings");
});

test("bootstrap accepts Pi's saved model preferences without weakening fixed safeguards", () => {
	const root = mkdtempSync(join(tmpdir(), "poly-preferences-"));
	bootstrap(root);
	const file = join(root, "settings.json");
	const settings = JSON.parse(readFileSync(file, "utf8"));
	settings.lastChangelogVersion = "1.5.2";
	settings.defaultProvider = "kimi-coding";
	settings.defaultModel = "fixture";
	writeFileSync(file, JSON.stringify(settings));
	assert.doesNotThrow(() => bootstrap(root));
	assert.doesNotThrow(() => validateProfile(root));
	settings.compaction.enabled = true;
	writeFileSync(file, JSON.stringify(settings));
	assert.throws(() => validateProfile(root), /untouched/);
});

test("profile rejects symlinks, invalid policy, and unreviewed overrides", () => {
	const root = mkdtempSync(join(tmpdir(), "poly-policy-"));
	bootstrap(join(root, "profile"));
	symlinkSync(join(root, "profile"), join(root, "link"));
	assert.throws(() => bootstrap(join(root, "link")), /symlink/);
	const p = defaultPolicy();
	p.google.enabled = true;
	assert.throws(() => validatePolicy(p), /attestation|review/);
	assert.equal(loadPolicy(join(root, "profile")).google.enabled, false);
	writeFileSync(join(root, "profile/models.json"), "{}");
	assert.throws(() => validateProfile(join(root, "profile")), /Unexpected/);
});

test("Google requires activation and direct user input even with human-approved delegation", () => {
	const p = defaultPolicy();
	assert.throws(() => assertRequest(ACP_PROVIDER, p, true), /locked/);
	p.google = {
		enabled: true,
		review: POLICY_REVISION,
		runtime: "/official/agy",
		sha256: "a".repeat(64),
	};
	assert.doesNotThrow(() => assertRequest(ACP_PROVIDER, p, true));
	assert.throws(() => assertRequest(ACP_PROVIDER, p, false), /delegation/);
	assert.throws(() => assertRequest("claude-bridge", p), /locked/);
	assert.throws(() => assertRequest("google", p, true), /outside/);
	assert.throws(() => assertRequest("openai", p), /outside/);
	assert.throws(() => assertRequest("zai", p), /opt-in/);
	assert.doesNotThrow(() => assertRequest("openai-codex", p));
});

test("environment diagnostics contain names and never credential values", () => {
	const env = {
		ANTHROPIC_API_KEY: "fixture-do-not-print",
		HTTPS_PROXY: "https://fixture:secret@proxy.example",
		GEMINI_API_KEY: "fixture-google",
	};
	assert.deepEqual(conflictingEnvironment(env), [
		"ANTHROPIC_API_KEY",
		"GEMINI_API_KEY",
		"HTTPS_PROXY",
	]);
	assert.throws(
		() => assertEnvironment(env),
		(error: Error) => !/fixture|secret@/.test(error.message),
	);
});

test("native Claude authentication overrides and malformed configuration are refused without value exposure", () => {
	const root = mkdtempSync(join(tmpdir(), "poly-claude-settings-"));
	const file = join(root, "settings.json");
	writeFileSync(file, JSON.stringify({ apiKeyHelper: "fixture helper, never execute" }));
	assert.throws(() => validateClaudeSettings(root), /authentication override/);
	writeFileSync(file, JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://fixture.example" } }));
	assert.throws(() => validateClaudeSettings(root), /conflicting environment/);
	writeFileSync(file, "invalid JSON fixture-sensitive-content");
	assert.throws(
		() => readConfiguration(file),
		(error: Error) => !error.message.includes("fixture-sensitive-content"),
	);
});

test("stream guards reject before invoking native transports, with no API fallback", () => {
	let calls = 0;
	const provider = openaiCodexProvider();
	const guarded = guardedProvider(
		{
			...provider,
			streamSimple: () => {
				calls++;
				throw new Error("transport called");
			},
		},
		() => {
			throw new Error("blocked");
		},
	);
	assert.throws(
		() => guarded.streamSimple(provider.getModels()[0], normalizeContext({ messages: [] })),
		/blocked/,
	);
	assert.equal(calls, 0);
});

test("launcher rejects automation flags and preserves project settings", () => {
	assert.throws(() => assertNode("22.16.0"), /22.19/);
	assert.doesNotThrow(() => assertNode("22.21.1"));
	assert.ok(
		!launchArguments(["--continue", "--model", "openai-codex/example"]).includes("--no-extensions"),
	);
	for (const args of [
		["-p", "prompt"],
		["--mode", "rpc"],
		["--provider", "google"],
		["delegated task"],
	])
		assert.throws(() => launchArguments(args));
	const root = mkdtempSync(join(tmpdir(), "poly-project-"));
	mkdirSync(join(root, ".pi"));
	writeFileSync(join(root, ".pi/settings.json"), '{"packages":["personal"]}');
	assert.doesNotThrow(() => assertProjectConfiguration(root));
	assert.equal(readFileSync(join(root, ".pi/settings.json"), "utf8"), '{"packages":["personal"]}');
});

test("Pi owns durable session creation and restoration", () => {
	const root = mkdtempSync(join(tmpdir(), "poly-session-"));
	const session = SessionManager.create(root, join(root, "sessions"));
	session.appendMessage({ role: "user", content: "fixture task", timestamp: Date.now() });
	session.appendCustomEntry("poly-handoff", { objective: "fixture objective" });
	const restored = SessionManager.open(session.getSessionFile()!);
	assert.equal(restored.getSessionId(), session.getSessionId());
	assert.equal(restored.getBranch().filter((e) => e.type === "custom").length, 1);
});
