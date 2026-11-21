import { loadPlatform } from "./platform/config.ts";
import { createHash } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import {
	conflictingEnvironment,
	NATIVE_PROVIDERS,
	BRIDGE_PROVIDER,
	ACP_PROVIDER,
	defaultPolicy,
	validatePolicy,
	type Activation,
	type Policy,
} from "./policy.ts";

export const PROFILE = resolve(import.meta.dirname, "../.poly/agent");
export const SETTINGS = {
	defaultProvider: "openai-codex",
	enabledModels: [
		"openai-codex/*",
		"kimi-coding/*",
		"zai/*",
		"claude-bridge/*",
		"antigravity-acp/*",
	],
	compaction: { enabled: false },
	retry: { enabled: false },
	cacheWarming: "off",
	packages: [],
};

export function readConfiguration(file: string): unknown {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		throw new Error("Configuration is missing or malformed; values withheld");
	}
}

// Never merge into an unknown profile. Pi may save its own model and display preferences.
export function bootstrap(profile = PROFILE): void {
	assertSafeProfile(profile);
	mkdirSync(profile, { recursive: true, mode: 0o700 });
	const settings = join(profile, "settings.json");
	if (!existsSync(settings)) createOrCheck(settings, SETTINGS);
	validateSettings(settings);
	const policyFile = join(profile, "poly.json");
	if (!existsSync(policyFile)) createOrCheck(policyFile, defaultPolicy());
	loadPolicy(profile);
}

function validateSettings(file: string): void {
	if (lstatSync(file).isSymbolicLink()) throw new Error("Managed settings must not be a symlink");
	const settings = readConfiguration(file) as Record<string, unknown>;
	const mutable = [
		"defaultProvider",
		"defaultModel",
		"defaultThinkingLevel",
		"modelThinkingLevels",
		"lastChangelogVersion",
		"theme",
		"hideThinkingBlock",
	];
	for (const [key, value] of Object.entries(SETTINGS)) {
		if (key === "defaultProvider") continue;
		if (JSON.stringify(settings[key]) !== JSON.stringify(value))
			throw new Error("Managed settings differ; existing configuration was left untouched");
	}
	const allowed = [...NATIVE_PROVIDERS, BRIDGE_PROVIDER, ACP_PROVIDER] as unknown[];
	allowed.push(...loadPlatform(dirname(file)).providers.map((p) => p.id));
	if (!allowed.includes(settings.defaultProvider))
		throw new Error("Default provider is outside the managed profile");
	if (Object.keys(settings).some((key) => !(key in SETTINGS) && !mutable.includes(key)))
		throw new Error("Unreviewed profile settings were left untouched");
}

export function loadPolicy(profile = PROFILE): Policy {
	assertSafeProfile(profile);
	const file = join(profile, "poly.json");
	if (lstatSync(file).isSymbolicLink()) throw new Error("Policy must not be a symlink");
	return validatePolicy(readConfiguration(file));
}

export function assertSafeProfile(profile: string): void {
	let path = resolve(profile);
	while (path !== dirname(path)) {
		if (existsSync(path) && lstatSync(path).isSymbolicLink())
			throw new Error("Profile path contains a symlink");
		path = dirname(path);
	}
}

function createOrCheck(file: string, value: unknown): void {
	const content = `${JSON.stringify(value, null, 2)}\n`;
	if (existsSync(file)) {
		if (lstatSync(file).isSymbolicLink() || readFileSync(file, "utf8") !== content) {
			throw new Error("Existing configuration differs; bootstrap left it untouched");
		}
		return;
	}
	writeFileSync(file, content, { flag: "wx", mode: 0o600 });
}

export function attestRuntime(a: Activation): string {
	const path = realpathSync(a.runtime);
	const hash = createHash("sha256").update(readFileSync(path)).digest("hex");
	if (hash !== a.sha256) throw new Error("Runtime checksum differs from reviewed version");
	return path;
}

export function validateProfile(profile = PROFILE): Policy {
	assertSafeProfile(profile);
	if (!existsSync(join(profile, "settings.json")))
		throw new Error("Missing profile; run bootstrap first");
	validateSettings(join(profile, "settings.json"));
	for (const name of ["models.json", "mcp.json", "extensions", "SYSTEM.md", "APPEND_SYSTEM.md"]) {
		if (existsSync(join(profile, name)))
			throw new Error("Unexpected profile resource; manual review required");
	}
	const policy = loadPolicy(profile);
	if (policy.claude.enabled) {
		attestRuntime(policy.claude);
		validateClaudeSettings();
	}
	if (policy.google.enabled) attestRuntime(policy.google);
	return policy;
}

export function validateClaudeSettings(
	directory = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"),
): void {
	for (const name of ["settings.json", "settings.local.json"]) {
		const file = join(directory, name);
		if (!existsSync(file)) continue;
		const settings = readConfiguration(file) as Record<string, unknown>;
		if (
			["apiKeyHelper", "awsAuthRefresh", "awsCredentialExport", "forceLoginOrgUUID"].some(
				(key) => key in settings,
			)
		)
			throw new Error("Claude native settings contain an authentication override; review required");
		if (settings.forceLoginMethod && settings.forceLoginMethod !== "claudeai")
			throw new Error("Claude native settings select a different authentication method");
		if (settings.env && conflictingEnvironment(settings.env as NodeJS.ProcessEnv).length)
			throw new Error("Claude native settings contain conflicting environment overrides");
	}
}
