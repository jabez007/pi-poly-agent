import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { assertNoSecrets, discoverMemPalace } from "./memory.ts";
import { conflictingEnvironment, providerStatus, type Policy } from "./policy.ts";
import {
	assertInteractiveResourceTrust,
	validateProfile,
	validateProjectSafetySettings,
} from "./profile.ts";
import { loadPlatform } from "./platform/config.ts";
import { agentPolicy, effectivePolicy } from "./platform/contracts.ts";
import { validateIntegrations } from "./platform/integrations.ts";
import { nativeResourceInventory } from "./platform/pi-resources.ts";
import { ProviderRegistry, nativeWorkerProvider } from "./platform/providers.ts";
import { git } from "./orchestration/worktrees.ts";
import { worktreeReadiness } from "./orchestration/preparation.ts";

export interface Diagnostic {
	id: string;
	status: "ok" | "warning" | "error";
	summary: string;
	action?: string;
}
export interface DoctorReport {
	version: 1;
	profile: string;
	project: string;
	checks: Diagnostic[];
	providers: unknown[];
	configuration?: unknown;
	resources?: Awaited<ReturnType<typeof nativeResourceInventory>>;
}

/** Read-only inspection. No credentials are resolved and no executable integration is imported. */
export async function doctor(profile: string, project: string): Promise<DoctorReport> {
	const report: DoctorReport = { version: 1, profile, project, checks: [], providers: [] };
	check(
		report,
		"runtime",
		() => {
			const [major, minor] = process.versions.node.split(".").map(Number);
			if (major < 22 || (major === 22 && minor < 19)) throw new Error();
			for (const name of ["pi-coding-agent", "pi-ai"]) {
				const file = join(
					import.meta.dirname,
					"../node_modules/@earendil-works",
					name,
					"package.json",
				);
				if (JSON.parse(readFileSync(file, "utf8")).version !== "1.5.2") throw new Error();
			}
		},
		"Node and pinned Pi 1.5.2 are compatible.",
		"Use Node >=22.19 and npm ci --ignore-scripts.",
	);
	let policy: Policy | undefined;
	check(
		report,
		"profile",
		() => {
			policy = validateProfile(profile);
		},
		"Managed profile is valid.",
		"Run bootstrap for this profile, or review settings/poly.json. Existing files are never replaced.",
	);
	check(
		report,
		"project-policy",
		() => validateProjectSafetySettings(project),
		"Project safety settings accepted.",
		"Remove project overrides of managed retry, compaction, proxy or trust safeguards.",
	);
	const conflicts = conflictingEnvironment(process.env);
	report.checks.push({
		id: "environment",
		status: conflicts.length ? "error" : "ok",
		summary: conflicts.length
			? `Conflicting variable names: ${conflicts.join(", ")}`
			: "No conflicting provider environment overrides.",
		action: "Resolve conflicts in your launch shell; values are never shown.",
	});
	if (policy) await configured(report, policy);
	workspace(report);
	report.checks.push({
		id: "sandbox",
		status: "warning",
		summary: existsSync("/usr/bin/bwrap")
			? "Bubblewrap installed; namespace startup has NOT been probed."
			: "Bubblewrap missing; worker tests cannot run.",
		action:
			"Install Bubblewrap and run PI_POLY_SANDBOX_TEST=1 npm test. No host-shell fallback exists.",
	});
	report.checks.push({
		id: "memory",
		status: "ok",
		summary: memoryAvailable()
			? "Existing MemPalace installation discovered, not contacted."
			: "MemPalace unavailable; native context remains usable.",
	});
	assertNoSecrets(report);
	return report;
}

export function formatDoctor(report: DoctorReport): string {
	return [
		`Pi Poly Agent doctor | ${report.profile}\nProject: ${report.project}`,
		...report.checks.map(
			(c) => `${c.status.toUpperCase()} ${c.id}: ${c.summary}${c.action ? `\n  ${c.action}` : ""}`,
		),
		"Provider configuration, not a credential or live qualification check:",
		...report.providers.map(
			(p: any) =>
				`${p.id}: ${p.authentication}, ${p.billing}; direct ${p.capabilities.direct ? "allowed" : "locked"}, delegation ${p.capabilities.delegation ? "allowed" : "blocked"}`,
		),
		"Use npm run doctor for resource paths, resolved permissions and configuration origins.",
	].join("\n");
}

function check(
	report: DoctorReport,
	id: string,
	run: () => void,
	summary: string,
	action: string,
): void {
	try {
		run();
		report.checks.push({ id, status: "ok", summary });
	} catch {
		report.checks.push({
			id,
			status: "error",
			summary: `${id} validation failed; configuration values withheld.`,
			action,
		});
	}
}
async function configured(report: DoctorReport, policy: Policy): Promise<void> {
	check(
		report,
		"configuration",
		() => {
			const config = loadPlatform(report.profile, report.project);
			const registry = new ProviderRegistry(() => policy);
			for (const instance of config.providers) registry.register(instance);
			for (const agent of config.agents)
				check(
					report,
					`agent-${agent.name}`,
					() => {
						if (agent.model) assertAgentAssignment(registry, agent.model);
						if (agent.selection?.instance) registry.assert(agent.selection.instance, 1);
					},
					"Agent assignment is configured or requires an explicit interactive model choice.",
					"Choose a registered, eligible worker instance and a model from its declared or pinned catalog. Doctor does not authenticate.",
				);
			report.configuration = {
				legacy: config.legacy,
				sources: config.sources,
				agents: config.agents.map((a) => ({
					name: a.name,
					model: a.model,
					selection: a.selection,
					policy: effectivePolicy(agentPolicy(a), config.policy),
				})),
				workflows: config.workflows.map((w) => ({ id: w.id, steps: w.steps.map((s) => s.id) })),
				context: config.context,
				ui: config.ui,
			};
			report.providers = registry.list().map((p) => ({
				id: p.id,
				adapter: p.adapter,
				authentication: p.authentication,
				billing: p.billing,
				models: p.models || "native catalog; use /model",
				capabilities: registry.capabilities(p.id),
				mode: providerStatus(p.id, policy),
				credentials: "not checked; use supported /login",
			}));
		},
		"Configuration and provider declarations resolved.",
		"Review configuration layer schemas and provider IDs. Executable adapters are not loaded during inspection.",
	);
	check(
		report,
		"integrations",
		() => {
			validateIntegrations(report.profile);
		},
		"Integration approvals valid; no modules executed.",
		"Review integrations.json inventories/digests and explicit application-code trust. Restart after updates.",
	);
	check(
		report,
		"native-trust",
		() => assertInteractiveResourceTrust(report.profile),
		"User resource trust acknowledged or no executable resources configured.",
		"Review resources, then explicitly launch --trust-native-resources. Project trust remains separate.",
	);
	try {
		report.resources = await nativeResourceInventory(report.profile, report.project);
		report.checks.push({
			id: "native-resources",
			status: "ok",
			summary: "Native resource paths/filters inspected; executable resources not loaded.",
		});
		const missing = report.resources.packages.some(
			(p) => !p.installedPath || !existsSync(p.installedPath),
		);
		report.checks.push({
			id: "native-packages",
			status: missing ? "warning" : "ok",
			summary: missing
				? "Some configured Pi packages are missing. No download was attempted."
				: "Configured native package paths are present.",
			action: missing
				? "Review sources, then explicitly install them with the native Pi command in this profile."
				: undefined,
		});
	} catch {
		report.checks.push({
			id: "native-resources",
			status: "error",
			summary: "Native resource inspection failed; values withheld.",
			action: "Review native settings paths and installed packages using pi list/config.",
		});
	}
}
function workspace(report: DoctorReport): void {
	check(
		report,
		"git",
		() => {
			git(report.project, ["rev-parse", "--verify", "HEAD"]);
			if (
				!git(report.project, ["branch", "--show-current"]) ||
				git(report.project, ["--no-optional-locks", "status", "--porcelain"])
			)
				throw new Error();
		},
		"Named branch and clean Git worktree ready for delegation.",
		"Commit or stash changes and select a named branch. Interactive Pi can still be used in a dirty repository.",
	);
	for (const item of worktreeReadiness(report.project))
		report.checks.push({
			id: `prerequisite-${item.kind}`,
			status: item.ready ? "ok" : "warning",
			summary: item.details.join(" "),
			action: "Worker dependencies require separate preparation approval.",
		});
}

function memoryAvailable(): boolean {
	try {
		return !!discoverMemPalace();
	} catch {
		return false;
	}
}

function assertAgentAssignment(registry: ProviderRegistry, model: string): void {
	const slash = model.indexOf("/"),
		id = model.slice(0, slash),
		name = model.slice(slash + 1);
	registry.assert(id, 1);
	const instance = registry.get(id);
	const models =
		instance.models ||
		nativeWorkerProvider(id)
			.getModels()
			.map((m) => m.id);
	if (!models.includes(name)) throw new Error("Unknown configured model");
}
