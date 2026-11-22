import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import {
	existsSync,
	readFileSync,
	readdirSync,
	lstatSync,
	openSync,
	closeSync,
	fstatSync,
	constants,
} from "node:fs";
import { isAbsolute, join, resolve, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { assertSafeProfile, readConfiguration } from "../profile.ts";
import { assertNoSecrets } from "../memory.ts";
import { fields } from "./config.ts";
import { emptyResources } from "./resources.ts";
import type { WorkerResources } from "./contracts.ts";
import type { ProviderRegistry } from "./providers.ts";
import type { ContextBackend } from "./context.ts";
/** Only fixed review messages from this loader may be shown by the managed CLI. */
export class IntegrationReviewRequired extends Error {}
export interface IntegrationEntry {
	path: string;
	sha256: string;
	trust?: "application-code";
	/** Directory review is the default. Entry-only review explicitly trusts unverified imports. */
	integrity?: "directory" | "entry-only-unverified-imports";
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

const loadedIntegrations = new Map<string, { identity: string; initialized: boolean }>();
async function loadModule(entry: IntegrationEntry, host: IntegrationHost): Promise<void> {
	validateModule(entry);
	const identity = JSON.stringify(entry);
	const previous = loadedIntegrations.get(entry.path);
	if (previous && (previous.identity !== identity || !previous.initialized))
		throw new IntegrationReviewRequired(
			"Reviewed integration changed or initialization failed during this process; restart Pi to reload dependencies",
		);
	// Import and setup may have side effects even if they throw. Never reuse a failed module cache.
	loadedIntegrations.set(entry.path, { identity, initialized: false });
	const module = await import(pathToFileURL(entry.path).href);
	if (module.version !== 1 || typeof module.setup !== "function")
		throw new IntegrationReviewRequired("Integration does not implement contract version 1");
	await module.setup(host);
	loadedIntegrations.set(entry.path, { identity, initialized: true });
}

export function validateIntegrations(profile: string): IntegrationEntry[] {
	const file = join(profile, "integrations.json");
	if (!existsSync(file)) return [];
	assertSafeProfile(file);
	const raw: any = readConfiguration(file);
	fields(raw, ["version", "modules"], "integration manifest");
	if (raw.version !== 1 || !Array.isArray(raw.modules) || raw.modules.length > 16)
		throw new IntegrationReviewRequired("Unsupported integration manifest");
	for (const entry of raw.modules) validateModule(entry);
	return raw.modules;
}

function validateModule(entry: any): void {
	fields(entry, ["path", "sha256", "trust", "integrity", "root", "files"], "trusted integration");
	if (
		typeof entry.path !== "string" ||
		!isAbsolute(entry.path) ||
		resolve(entry.path) !== entry.path ||
		!/\.(mjs|js|ts)$/.test(entry.path) ||
		!/^[a-f0-9]{64}$/.test(entry.sha256)
	)
		throw new IntegrationReviewRequired(
			"Integration requires a normalized absolute module path and SHA-256",
		);
	if (entry.trust !== "application-code")
		throw new IntegrationReviewRequired(
			"Integration requires explicit trust: application-code. Entry hashing does not attest imports or sandbox execution; review dependencies first.",
		);
	validateIntegrityScope(entry);

	assertSafeProfile(entry.path);
	if (fileDigest(entry.path) !== entry.sha256)
		throw new IntegrationReviewRequired("Integration checksum differs; no module was loaded");
}

function validateIntegrityScope(entry: IntegrationEntry): void {
	if (entry.integrity === "entry-only-unverified-imports") {
		if (entry.root !== undefined || entry.files !== undefined)
			throw new IntegrationReviewRequired(
				"Entry-only review cannot also declare a directory inventory",
			);
		return;
	}
	if (entry.integrity !== undefined && entry.integrity !== "directory")
		throw new IntegrationReviewRequired("Unknown integration integrity scope");
	if (!entry.root || !entry.files)
		throw new IntegrationReviewRequired(
			"Integration requires a reviewed root/files inventory. For deliberately unverified imports, explicitly approve integrity: entry-only-unverified-imports. See docs/platform.md.",
		);
	validateInventory(entry);
}

/** Refuse final-component symlinks and special files without blocking on a FIFO. */
function fileDigest(path: string): string {
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		if (!fstatSync(fd).isFile())
			throw new IntegrationReviewRequired("Integration digest requires a regular file");
		return createHash("sha256").update(readFileSync(fd)).digest("hex");
	} finally {
		closeSync(fd);
	}
}

/** Review inventory for local package contents, not a claim about code imported outside the root. */
function validateInventory(entry: IntegrationEntry): void {
	if (!validInventoryShape(entry))
		throw new IntegrationReviewRequired(
			"Integration inventory requires an absolute root and file digest map",
		);
	assertSafeProfile(entry.root!);
	const root = resolve(entry.root!);
	const listed = Object.keys(entry.files!);
	if (!listed.length || listed.length > 512 || !listed.includes(relative(root, entry.path)))
		throw new IntegrationReviewRequired(
			"Integration inventory must include its entry and at most 512 files",
		);
	const actual = inventory(root);
	if (actual.length !== listed.length)
		throw new IntegrationReviewRequired(
			"Integration file inventory changed; review added or removed files",
		);
	for (const name of listed) {
		if (!actual.includes(name) || !/^[a-f0-9]{64}$/.test(entry.files![name]))
			throw new IntegrationReviewRequired("Integration inventory path or digest invalid");
		const hash = fileDigest(join(root, name));
		if (hash !== entry.files![name])
			throw new IntegrationReviewRequired(
				"Reviewed integration file changed; review dependency integrity",
			);
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
	if (depth > 32)
		throw new IntegrationReviewRequired("Integration inventory nesting exceeds review budget");
	for (const name of readdirSync(base)) {
		const path = join(base, name);
		const stat = lstatSync(path);
		if (stat.isSymbolicLink())
			throw new IntegrationReviewRequired("Integration inventory symlink refused");
		if (stat.isDirectory()) inventory(root, path, files, depth + 1);
		else if (stat.isFile()) files.push(relative(root, path));
		else throw new IntegrationReviewRequired("Integration inventory contains a special file");
		if (files.length > 512)
			throw new IntegrationReviewRequired("Integration inventory exceeds review budget");
	}
	return files;
}
