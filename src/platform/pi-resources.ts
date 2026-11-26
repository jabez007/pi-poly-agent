import {
	DefaultPackageManager,
	ProjectTrustStore,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";

function manager(profile: string, cwd: string) {
	const trusted = new ProjectTrustStore(profile).get(cwd) === true;
	const settings = SettingsManager.create(cwd, profile, { projectTrusted: trusted });
	const packages = new DefaultPackageManager({ cwd, agentDir: profile, settingsManager: settings });
	return { settings, packages };
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
