import { readFileSync } from "node:fs";
import { join } from "node:path";
import { discoverMemPalace, assertNoSecrets } from "./memory.ts";
import {
	ACP_PROVIDER,
	CLAUDE_ACP_PROVIDER,
	claudeMode,
	conflictingEnvironment,
	providerStatus,
	type Policy,
} from "./policy.ts";
import {
	assertInteractiveResourceTrust,
	runtimePath,
	validateProfile,
	validateProjectSafetySettings,
} from "./profile.ts";
import { nativeResourceInventory } from "./platform/pi-resources.ts";

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
	providers: string[];
	resources?: Awaited<ReturnType<typeof nativeResourceInventory>>;
}
/** Inspect configuration and resource metadata without resolving credentials or launching runtimes. */
export async function doctor(profile: string, project: string): Promise<DoctorReport> {
	const report: DoctorReport = { version: 1, profile, project, checks: [], providers: [] };
	check(
		report,
		"runtime",
		() => {
			const [major, minor] = process.versions.node.split(".").map(Number);
			if (major < 22 || (major === 22 && minor < 19)) throw new Error();
			for (const name of ["pi-coding-agent", "pi-ai"])
				if (
					JSON.parse(
						readFileSync(
							join(import.meta.dirname, "../node_modules/@earendil-works", name, "package.json"),
							"utf8",
						),
					).version !== "1.5.2"
				)
					throw new Error();
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
		"Isolated profile is valid.",
		"Run bootstrap or inspect settings.json and poly.json.",
	);
	check(
		report,
		"project-trust",
		() => validateProjectSafetySettings(project),
		"Project settings preserve interactive operation and native trust.",
		"Remove automatic trust or retry/compaction overrides from project settings.",
	);
	check(
		report,
		"native-trust",
		() => assertInteractiveResourceTrust(profile),
		"Native resource trust accepted.",
		"Review resources, then launch with --trust-native-resources once.",
	);
	if (policy) providerChecks(report, policy);
	try {
		if (policy) report.resources = await nativeResourceInventory(profile, project);
	} catch {
		report.checks.push({
			id: "resources",
			status: "warning",
			summary: "Native resource inventory unavailable; no executable resource was loaded.",
		});
	}
	report.checks.push({
		id: "memory",
		status: "ok",
		summary: discoverMemPalace()
			? "MemPalace installation found, not contacted."
			: "MemPalace unavailable; Pi history and handoffs remain usable.",
	});
	assertNoSecrets(report);
	return report;
}
function providerChecks(report: DoctorReport, policy: Policy): void {
	report.providers = [
		"openai-codex",
		"kimi-coding",
		"zai",
		"claude-acp",
		"claude-bridge",
		ACP_PROVIDER,
	].map((id) => providerStatus(id, policy));
	for (const [id, activation, command] of [
		[CLAUDE_ACP_PROVIDER, policy.claude, "claude"],
		[ACP_PROVIDER, policy.google, "agy"],
	] as const) {
		if (!activation.enabled) continue;
		const names = conflictingEnvironment(process.env, id);
		report.checks.push({
			id: `${id}-environment`,
			status: names.length ? "warning" : "ok",
			summary: names.length
				? `Runtime start refused by variable names: ${names.join(", ")}`
				: "No runtime billing environment overrides.",
			action: "Only this runtime is affected. Values are never shown.",
		});
		check(
			report,
			`${id}-executable`,
			() => {
				runtimePath(activation, command);
			},
			`${command} found, not executed (${command === "claude" ? claudeMode(policy) : "acp"}).`,
			`Install ${command} on PATH or set its path in poly.json.`,
			"warning",
		);
	}
}
function check(
	report: DoctorReport,
	id: string,
	run: () => void,
	summary: string,
	action: string,
	status: Diagnostic["status"] = "error",
): void {
	try {
		run();
		report.checks.push({ id, status: "ok", summary });
	} catch {
		report.checks.push({ id, status, summary: `${id} check failed; values withheld.`, action });
	}
}
export function formatDoctor(report: DoctorReport): string {
	return [
		"Pi Poly Agent doctor",
		...report.checks.map(
			(c) => `${c.status.toUpperCase()} ${c.id}: ${c.summary}${c.action ? `\n  ${c.action}` : ""}`,
		),
		"Provider configuration only; credentials were not checked:",
		...report.providers,
	].join("\n");
}
