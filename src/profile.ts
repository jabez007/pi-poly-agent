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
	if (!settings || typeof settings !== "object" || Array.isArray(settings))
		throw new Error("Managed settings must be a JSON object");
	validateSafetySettings(settings);
	for (const key of ["compaction", "retry", "cacheWarming"] as const)
		if (settings[key] === undefined)
			throw new Error("Managed safety setting missing; existing configuration was left untouched");
}

/** Native Pi owns resource and display settings. These execution safeguards remain fixed. */
export function validateSafetySettings(settings: Record<string, any>): void {
	for (const key of ["compaction", "retry", "cacheWarming"] as const) {
		if (
			settings[key] !== undefined &&
			JSON.stringify(settings[key]) !== JSON.stringify(SETTINGS[key])
		)
			throw new Error("Managed safety settings differ; existing configuration was left untouched");
	}
	if (settings.httpProxy || settings.defaultProjectTrust === "always")
		throw new Error(
			"Proxy overrides and automatic project trust require a separate reviewed environment",
		);
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
	for (const name of ["models.json"]) {
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

export function validateProjectSafetySettings(cwd: string): void {
	const file = join(resolve(cwd), ".pi/settings.json");
	if (existsSync(file)) validateSafetySettings(readConfiguration(file) as Record<string, unknown>);
}

export class ResourceTrustRequired extends Error {
	constructor() {
		super(
			"Native Pi resources have application-process privileges. Review this profile's packages/extensions/MCP configuration, then launch with --trust-native-resources once. No resources were loaded. See docs/pi-ecosystem.md.",
		);
	}
}
/** User-owned trust acknowledgment, separate from Pi's native per-project trust store. */
export function trustInteractiveResources(profile: string): void {
	assertSafeProfile(profile);
	const file = join(profile, "interactive-trust.json");
	assertSafeProfile(file);
	createOrCheck(file, { version: 1, nativeResources: "trusted-application-code" });
}
export function assertInteractiveResourceTrust(profile: string): void {
	const settings = readConfiguration(join(profile, "settings.json")) as Record<string, any>;
	const executable =
		settings.extensions?.length ||
		settings.packages?.length ||
		existsSync(join(profile, "extensions")) ||
		existsSync(join(profile, "mcp.json"));
	if (!executable) return;
	const file = join(profile, "interactive-trust.json");
	if (!existsSync(file)) throw new ResourceTrustRequired();
	assertSafeProfile(file);
	const trust = readConfiguration(file) as any;
	if (trust.version !== 1 || trust.nativeResources !== "trusted-application-code")
		throw new ResourceTrustRequired();
}
