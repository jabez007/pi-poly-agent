import {
	DefaultPackageManager,
	DefaultResourceLoader,
	ProjectTrustStore,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { assertSafeProfile, readConfiguration } from "../profile.ts";
import { assertNoSecrets } from "../memory.ts";
import type { Task } from "../orchestration/tasks.ts";
import { agentPolicy, effectivePolicy } from "./contracts.ts";

function manager(profile: string, cwd: string) {
	const trusted = new ProjectTrustStore(profile).get(cwd) === true;
	const settings = SettingsManager.create(cwd, profile, { projectTrusted: trusted });
	const packages = new DefaultPackageManager({ cwd, agentDir: profile, settingsManager: settings });
	return { settings, packages };
}
/** An explicit reference to an already installed native Pi package. Never installs or imports code. */
export function nativePackageConfiguration(profile: string, source: string): string {
	const { packages } = manager(profile, process.cwd());
	const installed = packages
		.listConfiguredPackages()
		.find(
			(p) =>
				p.scope === "user" &&
				(p.source === source || (isAbsolute(source) && p.installedPath === source)),
		);
	if (!installed?.installedPath)
		throw new Error("Pi package reference is not installed in this profile; use pi install first");
	const root = resolve(installed.installedPath);
	assertSafeProfile(root);
	assertSafeProfile(join(root, "package.json"));
	const manifest: any = readConfiguration(join(root, "package.json"));
	const file = manifest["pi-poly-agent"]?.configuration;
	if (
		typeof file !== "string" ||
		isAbsolute(file) ||
		file.split(/[\\/]/).includes("..") ||
		!file.endsWith(".json")
	)
		throw new Error("Pi package requires a relative pi-poly-agent.configuration JSON path");
	const path = resolve(root, file);
	if (!path.startsWith(root + sep)) throw new Error("Pi package configuration escaped its package");
	assertSafeProfile(path);
	return path;
}

function installedSettings(profile: string, cwd: string) {
	const { settings, packages } = manager(profile, cwd);
	const installed = packages.listConfiguredPackages();
	const global = scopedSettings(settings.getGlobalSettings(), "user", installed);
	const project = scopedSettings(settings.getProjectSettings(), "project", installed);
	// Preserve Pi's two scopes rather than promoting a merged project view into user settings.
	const snapshot = SettingsManager.fromStorage(
		{
			withLock(scope, read) {
				if (read(JSON.stringify(scope === "global" ? global : project)) !== undefined)
					throw new Error("Inspection settings are read-only");
			},
		},
		{ projectTrusted: settings.isProjectTrusted() },
	);
	return { settings: snapshot, installed };
}

function scopedSettings(
	config: ReturnType<SettingsManager["getGlobalSettings"]>,
	scope: "user" | "project",
	installed: ReturnType<DefaultPackageManager["listConfiguredPackages"]>,
) {
	const sources = (config.packages || []).flatMap((entry) => {
		const source = typeof entry === "string" ? entry : entry.source;
		const found = installed.find((p) => p.source === source && p.scope === scope);
		if (!found?.installedPath || !existsSync(found.installedPath)) return [];
		return [
			typeof entry === "string" ? found.installedPath : { ...entry, source: found.installedPath },
		];
	});
	return { ...config, packages: sources };
}

/** Resolve native resource metadata only; no extension import, server startup or missing-package install. */
export async function nativeResourceInventory(profile: string, cwd: string) {
	const { settings, installed } = installedSettings(profile, cwd);
	const packages = new DefaultPackageManager({ cwd, agentDir: profile, settingsManager: settings });
	return {
		packages: installed,
		projectTrusted: settings.isProjectTrusted(),
		resources: await packages.resolve(async () => "skip"),
	};
}

/** Native discovery of data only. Installed packages become local paths, so missing sources cannot download. */
export async function nativeInstructionLoader(
	profile: string,
	cwd: string,
): Promise<DefaultResourceLoader> {
	const { settings } = installedSettings(profile, cwd);
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir: profile,
		settingsManager: settings,
		noExtensions: true,
		noThemes: true,
		noContextFiles: true,
	});
	await loader.reload();
	if (loader.getExtensions().extensions.length)
		throw new Error("Executable worker resources refused");
	return loader;
}

/** Snapshot selected instructional text. Scripts, hooks, providers and native tools are never imported. */
export async function nativeWorkerInstructions(
	task: Task,
	profile: string,
): Promise<Record<string, string>> {
	const ids = effectivePolicy(agentPolicy(task.role), task.effectivePolicy || {}).skills.filter(
		(id) => id.startsWith("pi:"),
	);
	if (!ids.length) return {};
	const loader = await nativeInstructionLoader(profile, task.workspace.root);
	const texts: Record<string, string> = {};
	for (const id of ids) {
		const skill = loader.getSkills().skills.find((s) => id === `pi:skill:${s.name}`);
		const prompt = loader.getPrompts().prompts.find((p) => id === `pi:prompt:${p.name}`);
		const path = skill?.filePath || prompt?.filePath;
		if (!path)
			throw new Error(
				"Selected native instruction unavailable, disabled, conflicting or untrusted",
			);
		assertSafeProfile(path);
		const diagnostics = [...loader.getSkills().diagnostics, ...loader.getPrompts().diagnostics];
		if (diagnostics.some((d) => /collision|conflict|duplicate/i.test(d.message)))
			throw new Error("Resolve native instructional resource collisions before delegation");
		const text = skill ? readFileSync(path, "utf8") : prompt!.content;
		assertNoSecrets(text);
		if (text.length > 24000) throw new Error("Native instructional resource exceeds worker budget");
		texts[id] =
			`Native Pi instruction, source ${path}. Supporting files and scripts are not granted execution access.\n${text}`;
	}
	return texts;
}
