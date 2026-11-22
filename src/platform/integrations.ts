import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, lstatSync } from "node:fs";
import { isAbsolute, join, resolve, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { assertSafeProfile, readConfiguration } from "../profile.ts";
import { assertNoSecrets } from "../memory.ts";
import { fields } from "./config.ts";
import { emptyResources } from "./resources.ts";
import type { WorkerResources } from "./contracts.ts";
import type { ProviderRegistry } from "./providers.ts";
import type { ContextBackend } from "./context.ts";
export interface IntegrationEntry {
	path: string;
	sha256: string;
	trust?: "application-code";
	root?: string;
	files?: Record<string, string>;
}
export interface IntegrationHost {
	version: 1;
	providers: ProviderRegistry;
	resources: WorkerResources;
	context: ContextBackend[];
	ui?: Pick<ExtensionAPI, "registerCommand" | "on">;
}
/** Only the user-owned managed profile can opt into executable integrations, by digest. */
export async function loadIntegrations(
	profile: string,
	providers: ProviderRegistry,
	ui?: IntegrationHost["ui"],
): Promise<IntegrationHost> {
	const host: IntegrationHost = {
		version: 1,
		providers,
		resources: emptyResources(),
		context: [],
		ui,
	};
	for (const entry of validateIntegrations(profile)) await loadModule(entry, host);
	assertNoSecrets({ skills: host.resources.skills });
	return host;
}

const loadedIntegrations = new Map<string, string>();
async function loadModule(entry: IntegrationEntry, host: IntegrationHost): Promise<void> {
	validateModule(entry);
	const identity = JSON.stringify(entry);
	if (loadedIntegrations.has(entry.path) && loadedIntegrations.get(entry.path) !== identity)
		throw new Error(
			"Reviewed integration changed during this process; restart Pi to reload dependencies",
		);
	const module = await import(pathToFileURL(entry.path).href);
	if (module.version !== 1 || typeof module.setup !== "function")
		throw new Error("Integration does not implement contract version 1");
	await module.setup(host);
	loadedIntegrations.set(entry.path, identity);
}

export function validateIntegrations(profile: string): IntegrationEntry[] {
	const file = join(profile, "integrations.json");
	if (!existsSync(file)) return [];
	assertSafeProfile(file);
	const raw: any = readConfiguration(file);
	fields(raw, ["version", "modules"], "integration manifest");
	if (raw.version !== 1 || !Array.isArray(raw.modules) || raw.modules.length > 16)
		throw new Error("Unsupported integration manifest");
	for (const entry of raw.modules) validateModule(entry);
	return raw.modules;
}

function validateModule(entry: any): void {
	fields(entry, ["path", "sha256", "trust", "root", "files"], "trusted integration");
	if (
		typeof entry.path !== "string" ||
		!isAbsolute(entry.path) ||
		!/\.(mjs|js|ts)$/.test(entry.path) ||
		!/^[a-f0-9]{64}$/.test(entry.sha256)
	)
		throw new Error("Integration requires an absolute module path and SHA-256");
	if (entry.trust !== "application-code")
		throw new Error(
			"Integration requires explicit trust: application-code. Entry hashing does not attest imports or sandbox execution; review dependencies first.",
		);
	if (entry.root !== undefined || entry.files !== undefined) validateInventory(entry);

	assertSafeProfile(entry.path);
	if (createHash("sha256").update(readFileSync(entry.path)).digest("hex") !== entry.sha256)
		throw new Error("Integration checksum differs; no module was loaded");
}

/** Review inventory for local package contents, not a claim about code imported outside the root. */
function validateInventory(entry: IntegrationEntry): void {
	if (!validInventoryShape(entry))
		throw new Error("Integration inventory requires an absolute root and file digest map");
	assertSafeProfile(entry.root!);
	const root = resolve(entry.root!);
	const listed = Object.keys(entry.files!);
	if (!listed.length || listed.length > 512 || !listed.includes(relative(root, entry.path)))
		throw new Error("Integration inventory must include its entry and at most 512 files");
	const actual = inventory(root);
	if (actual.length !== listed.length)
		throw new Error("Integration file inventory changed; review added or removed files");
	for (const name of listed) {
		if (!actual.includes(name) || !/^[a-f0-9]{64}$/.test(entry.files![name]))
			throw new Error("Integration inventory path or digest invalid");
		const hash = createHash("sha256")
			.update(readFileSync(join(root, name)))
			.digest("hex");
		if (hash !== entry.files![name])
			throw new Error("Reviewed integration file changed; review dependency integrity");
	}
}
function validInventoryShape(entry: IntegrationEntry): boolean {
	return (
		!!entry.root &&
		isAbsolute(entry.root) &&
		!!entry.files &&
		typeof entry.files === "object" &&
		!Array.isArray(entry.files)
	);
}

function inventory(root: string, base = root, files: string[] = [], depth = 0): string[] {
	if (depth > 32) throw new Error("Integration inventory nesting exceeds review budget");
	for (const name of readdirSync(base)) {
		const path = join(base, name);
		const stat = lstatSync(path);
		if (stat.isSymbolicLink()) throw new Error("Integration inventory symlink refused");
		if (stat.isDirectory()) inventory(root, path, files, depth + 1);
		else if (stat.isFile()) files.push(relative(root, path));
		else throw new Error("Integration inventory contains a special file");
		if (files.length > 512) throw new Error("Integration inventory exceeds review budget");
	}
	return files;
}
