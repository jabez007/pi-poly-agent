import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { defaultPolicy, validatePolicy, type Activation, type Policy } from "./policy.ts";
import { accessSync, constants } from "node:fs";

export const PROFILE = resolve(import.meta.dirname, "../.poly/agent");
export const SETTINGS = {
	defaultProvider: "openai-codex",
	enabledModels: [
		"openai-codex/*",
		"kimi-coding/*",
		"zai/*",
		"claude-bridge/*",
		"claude-acp/*",
		"antigravity-acp/*",
	],
	compaction: { enabled: false },
	retry: { enabled: false },
	cacheWarming: "off",
	packages: [],
	extensions: [resolve(import.meta.dirname, "extension.ts")],
};

export function readConfiguration(file: string): unknown {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		throw new Error("Configuration is missing or malformed; values withheld");
	}
}

// Register only Poly's extension; preserve Pi's saved preferences and resources.
export function bootstrap(profile = PROFILE): void {
	assertSafeProfile(profile);
	mkdirSync(profile, { recursive: true, mode: 0o700 });
	const settings = join(profile, "settings.json");
	if (!existsSync(settings)) createOrCheck(settings, SETTINGS);
	validateSettings(settings);
	const current = readConfiguration(settings) as Record<string, any>;
	const extension = SETTINGS.extensions[0];
	if (!(current.extensions || []).includes(extension)) {
		current.extensions = [extension, ...(current.extensions || [])];
		writeFileSync(settings, JSON.stringify(current, null, 2) + "\n", { mode: 0o600 });
	}
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
	if (settings.defaultProjectTrust === "always")
		throw new Error("Project trust must be decided by the user");
}

export function loadPolicy(profile = PROFILE): Policy {
	assertSafeProfile(profile);
	const file = join(profile, "poly.json");
	if (lstatSync(file).isSymbolicLink()) throw new Error("Policy must not be a symlink");
	const value = readConfiguration(file);
	const policy = validatePolicy(value);
	legacyNotice(profile, value);
	return policy;
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

export function runtimePath(a: Activation, name: "claude" | "agy"): string {
	const candidates = a.path
		? [a.path]
		: (process.env.PATH || "")
				.split(":")
				.filter(Boolean)
				.map((directory) => join(directory, name));
	for (const candidate of candidates) {
		try {
			accessSync(candidate, constants.X_OK);
			if (lstatSync(candidate).isDirectory()) continue;
			return resolve(candidate);
		} catch {
			/* Try the next PATH entry. */
		}
	}
	throw new Error(`Cannot find ${name}; install it on PATH or set its path in poly.json`);
}

export function validateProfile(profile = PROFILE): Policy {
	assertSafeProfile(profile);
	if (!existsSync(join(profile, "settings.json")))
		throw new Error("Missing profile; run bootstrap first");
	validateSettings(join(profile, "settings.json"));
	return loadPolicy(profile);
}

const noticed = new Set<string>();
function legacyNotice(profile: string, value: any): void {
	if (noticed.has(profile)) return;
	const retired = ["review", "runtime", "sha256"];
	const oldActivation = [value?.claude, value?.google].some((a) =>
		retired.some((field) => a && Object.hasOwn(a, field)),
	);
	const oldConfiguration = [
		"agents",
		"roles",
		"packages",
		"concurrency",
		"timeoutMs",
		"integrations",
		"workflows",
		"recipes",
		"orchestration",
		"policy",
		"providers",
		"context",
		"ui",
	].some((field) => Object.hasOwn(value, field));
	const oldFiles = ["platform.json", "orchestration.json", "integrations.json"].some((file) =>
		existsSync(join(profile, file)),
	);
	if (oldActivation || oldConfiguration || oldFiles) {
		noticed.add(profile);
		console.warn("v0.6 ignores retired orchestration and runtime-review configuration.");
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
		settings.extensions?.some((path: string) => path !== SETTINGS.extensions[0]) ||
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
