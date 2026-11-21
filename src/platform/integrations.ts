import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { assertSafeProfile, readConfiguration } from "../profile.ts";
import { assertNoSecrets } from "../memory.ts";
import { fields } from "./config.ts";
import { emptyResources } from "./resources.ts";
import type { WorkerResources } from "./contracts.ts";
import type { ProviderRegistry } from "./providers.ts";
import type { ContextBackend } from "./context.ts";
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

async function loadModule(entry: any, host: IntegrationHost): Promise<void> {
	validateModule(entry);
	const module = await import(pathToFileURL(entry.path).href);
	if (module.version !== 1 || typeof module.setup !== "function")
		throw new Error("Integration does not implement contract version 1");
	await module.setup(host);
}

export function validateIntegrations(profile: string): { path: string; sha256: string }[] {
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
	fields(entry, ["path", "sha256"], "trusted integration");
	if (
		typeof entry.path !== "string" ||
		!isAbsolute(entry.path) ||
		!/\.(mjs|js|ts)$/.test(entry.path) ||
		!/^[a-f0-9]{64}$/.test(entry.sha256)
	)
		throw new Error("Integration requires an absolute module path and SHA-256");
	assertSafeProfile(entry.path);
	if (createHash("sha256").update(readFileSync(entry.path)).digest("hex") !== entry.sha256)
		throw new Error("Integration checksum differs; no module was loaded");
}
