import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { normalizeContext } from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { bootstrap, validateProfile, readConfiguration, SETTINGS } from "../src/profile.ts";
import {
	ACP_PROVIDER,
	BRIDGE_PROVIDER,
	CLAUDE_ACP_PROVIDER,
	assertEnvironment,
	assertInvocationEnvironment,
	assertRequest,
	CLAUDE_BILLING_ENV,
	GOOGLE_BILLING_ENV,
	conflictingEnvironment,
	defaultPolicy,
	guardedProvider,
	validatePolicy,
} from "../src/policy.ts";
import { assertNode, launchArguments, assertProjectConfiguration } from "../scripts/cli.ts";

test("bootstrap preserves policy and native resources and registers only its own extension idempotently", () => {
	const profile = mkdtempSync(join(tmpdir(), "poly-bootstrap-"));
	bootstrap(profile);
	const file = join(profile, "settings.json");
	const settings = JSON.parse(readFileSync(file, "utf8"));
	settings.extensions = ["./personal.ts"];
	settings.packages = ["./installed-package"];
	settings.defaultProvider = "kimi-coding";
	writeFileSync(file, JSON.stringify(settings));
	const policy = readFileSync(join(profile, "poly.json"), "utf8");
	bootstrap(profile);
	const before = readFileSync(file, "utf8");
	bootstrap(profile);
	assert.equal(readFileSync(file, "utf8"), before);
	assert.equal(readFileSync(join(profile, "poly.json"), "utf8"), policy);
	assert.deepEqual(JSON.parse(before).extensions, [...SETTINGS.extensions, "./personal.ts"]);
	assert.deepEqual(JSON.parse(before).packages, ["./installed-package"]);
	assert.equal(JSON.parse(before).defaultProvider, "kimi-coding");
});

test("round nine activation fields and retired files are ignored with one notice without rewriting them", () => {
	const profile = mkdtempSync(join(tmpdir(), "poly-legacy-"));
	bootstrap(profile);
	const value = {
		...defaultPolicy(),
		agents: { ignored: true },
		claude: { enabled: true, review: "old", runtime: "old relative path", sha256: "old checksum" },
		google: { enabled: true, review: "old", runtime: "/old/agy", sha256: "bad" },
	};
	const file = join(profile, "poly.json");
	const text = JSON.stringify(value);
	writeFileSync(file, text);
	for (const name of ["platform.json", "orchestration.json", "integrations.json"])
		writeFileSync(join(profile, name), "ignored malformed retired configuration");
	const messages: string[] = [];
	const previous = console.warn;
	console.warn = (message) => {
		messages.push(message);
	};
	try {
		bootstrap(profile);
		bootstrap(profile);
		const policy = validateProfile(profile);
		assert.deepEqual(policy.claude, { enabled: true, mode: "acp" });
		assert.deepEqual(policy.google, { enabled: true });
		assert.equal(messages.length, 1);
		assert.match(messages[0], /no longer used|ignores retired/);
		assert.equal(readFileSync(file, "utf8"), text);
	} finally {
		console.warn = previous;
	}
});

test("both Claude modes and Gemini require opt-in and direct human input", () => {
	for (const provider of [BRIDGE_PROVIDER, CLAUDE_ACP_PROVIDER, ACP_PROVIDER]) {
		const policy = defaultPolicy();
		assert.throws(() => assertRequest(provider, policy, true), /off/);
		policy.claude.enabled = policy.google.enabled = true;
		policy.claude.mode = provider === BRIDGE_PROVIDER ? "bridge" : "acp";
		assert.throws(() => assertRequest(provider, policy), /direct interactive/);
		assert.doesNotThrow(() => assertRequest(provider, policy, true));
	}
	assert.throws(() => assertRequest("zai", defaultPolicy()), /opt-in/);
	for (const provider of ["openai-codex", "kimi-coding"])
		assert.doesNotThrow(() => assertRequest(provider, defaultPolicy()));
});

const expectedClaudeBilling = [
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_AUTH_TOKEN",
	"ANTHROPIC_BASE_URL",
	"ANTHROPIC_CUSTOM_HEADERS",
	"ANTHROPIC_PROFILE",
	"ANTHROPIC_FEDERATION_RULE_ID",
	"CLAUDE_CODE_USE_BEDROCK",
	"CLAUDE_CODE_USE_VERTEX",
	"CLAUDE_CODE_USE_FOUNDRY",
	"CLAUDE_CODE_USE_MANTLE",
	"CLAUDE_CODE_USE_ANTHROPIC_AWS",
	"CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
] as const;
const expectedGoogleBilling = [
	"GEMINI_API_KEY",
	"GOOGLE_API_KEY",
	"GOOGLE_GEMINI_BASE_URL",
	"AGY_ADC_AUTH",
] as const;

test("billing environment variable names stay pinned independently of implementation lists", () => {
	assert.deepEqual(CLAUDE_BILLING_ENV, expectedClaudeBilling);
	assert.deepEqual(GOOGLE_BILLING_ENV, expectedGoogleBilling);
});

for (const [provider, names] of [
	[CLAUDE_ACP_PROVIDER, expectedClaudeBilling],
	[BRIDGE_PROVIDER, expectedClaudeBilling],
	[ACP_PROVIDER, expectedGoogleBilling],
] as const) {
	for (const name of names)
		test(`${provider} refuses ${name} at inherited and request environments without values`, () => {
			for (const env of [{ [name]: "fixture-sensitive-value" }]) {
				assert.deepEqual(conflictingEnvironment(env, provider), [name]);
				assert.throws(
					() => assertInvocationEnvironment(provider, undefined, env),
					(e: Error) => /refused/.test(e.message) && !e.message.includes("fixture-sensitive-value"),
				);
				assert.throws(() => assertInvocationEnvironment(provider, { env }, {}), /refused/);
			}
		});
}

test("billing environment guards affect only the runtime being started", () => {
	assert.doesNotThrow(() => assertEnvironment("openai-codex", { ANTHROPIC_API_KEY: "fixture" }));
	assert.doesNotThrow(() => assertEnvironment(ACP_PROVIDER, { ANTHROPIC_API_KEY: "fixture" }));
	assert.doesNotThrow(() => assertEnvironment(CLAUDE_ACP_PROVIDER, { GEMINI_API_KEY: "fixture" }));
	for (const provider of [CLAUDE_ACP_PROVIDER, ACP_PROVIDER])
		assert.doesNotThrow(() =>
			assertInvocationEnvironment(
				provider,
				{
					env: {
						HTTPS_PROXY: "fixture",
						NODE_OPTIONS: "fixture",
						LD_PRELOAD: "fixture",
						LANG: "C",
					},
				},
				{},
			),
		);
});

test("profile validates retained fields and allows native model resources", () => {
	const profile = mkdtempSync(join(tmpdir(), "poly-profile-"));
	bootstrap(profile);
	writeFileSync(join(profile, "models.json"), "{}");
	assert.doesNotThrow(() => validateProfile(profile));
	assert.throws(() => validatePolicy({ version: 1, claude: { enabled: "yes" } }), /activation/);
	assert.throws(
		() => validatePolicy({ version: 1, google: { enabled: true, path: "relative" } }),
		/absolute/,
	);
	assert.throws(
		() => validatePolicy({ version: 1, claude: { enabled: true, mode: "invalid" } }),
		/mode/,
	);
	const sibling = join(profile, "alias");
	symlinkSync(profile, sibling);
	assert.throws(() => bootstrap(sibling), /symlink/);
	writeFileSync(join(profile, "poly.json"), "not-json-sensitive-value");
	assert.throws(
		() => readConfiguration(join(profile, "poly.json")),
		(e: Error) => !e.message.includes("sensitive-value"),
	);
});

test("native stream guards refuse before transport and preserve bounded retries and endpoints", () => {
	const provider = openaiCodexProvider();
	let calls = 0;
	const guarded = guardedProvider(
		{
			...provider,
			streamSimple: (_m: any, _c: any, options: any) => {
				calls++;
				assert.equal(options.maxRetries, 0);
				return {} as any;
			},
		},
		() => {},
	);
	guarded.streamSimple(provider.getModels()[0], normalizeContext({ messages: [] }));
	assert.throws(
		() =>
			guarded.streamSimple(
				{ ...provider.getModels()[0], baseUrl: "https://unselected.invalid" },
				normalizeContext({ messages: [] }),
			),
		/endpoint/,
	);
	assert.equal(calls, 1);
});

test("launcher accepts native resources and session references but refuses automated prompts", () => {
	assert.throws(() => assertNode("22.16.0"), /22.19/);
	assert.doesNotThrow(() => assertNode("22.21.1"));
	assert.ok(
		launchArguments(["--session", "/tmp/fixture-session", "--theme", "fixture"]).includes(
			"/tmp/fixture-session",
		),
	);
	for (const args of [["-p", "prompt"], ["--mode", "rpc"], ["automated prompt"]])
		assert.throws(() => launchArguments(args));
	const project = mkdtempSync(join(tmpdir(), "poly-project-"));
	mkdirSync(join(project, ".pi"));
	writeFileSync(
		join(project, ".pi/settings.json"),
		JSON.stringify({ packages: ["./native"], httpProxy: "fixture" }),
	);
	assert.doesNotThrow(() => assertProjectConfiguration(project));
});
