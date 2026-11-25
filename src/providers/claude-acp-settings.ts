import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { assertInvocationEnvironment, conflictingEnvironment } from "../policy.ts";

/** Use the adapter's own pinned SDK merge engine, which resolves settings without starting Claude. */
export async function assertClaudeAcpSettings(cwd: string): Promise<void> {
	assertInvocationEnvironment();
	if (Object.keys(process.env).some((key) => key.startsWith("CLAUDE_AGENT_") && process.env[key]))
		throw new Error("Claude ACP environment override refused; values withheld");
	if (process.platform !== "linux")
		throw new Error("Claude ACP settings preflight currently supports Linux only");
	const settings = await resolvedSettings(cwd);
	if (settings.machinePolicy?.didNotLoad !== false)
		throw new Error("Claude ACP cannot validate managed policy; runtime operation refused");
	for (const source of settings.sources) checkClaudeSettings(source.settings);
	checkClaudeSettings(settings.effective);
	// This adapter defaults to Auto when no native default is set. Do not start that session.
	if (settings.effective.permissions?.defaultMode !== "default")
		throw new Error(
			'Claude ACP requires native permissions.defaultMode "default" before discovery',
		);
}

async function resolvedSettings(cwd: string): Promise<any> {
	try {
		const adapter = createRequire(
			import.meta.resolve("@agentclientprotocol/claude-agent-acp/package.json"),
		);
		const sdk = await import(pathToFileURL(adapter.resolve("@anthropic-ai/claude-agent-sdk")).href);
		return await sdk.resolveSettings({ cwd, settingSources: ["user", "project", "local"] });
	} catch {
		throw new Error("Claude ACP cannot validate native settings; runtime operation refused");
	}
}

function checkClaudeSettings(settings: Record<string, any>): void {
	if (
		[
			"apiKeyHelper",
			"proxyAuthHelper",
			"gcpAuthRefresh",
			"processWrapper",
			"awsAuthRefresh",
			"awsCredentialExport",
			"forceLoginOrgUUID",
			"policyHelper",
			"policyHelpers",
		].some((key) => key in settings)
	)
		throw new Error(
			"Claude native settings contain an authentication or policy helper override; review required",
		);
	if (settings.forceLoginMethod && settings.forceLoginMethod !== "claudeai")
		throw new Error("Claude native settings select a different authentication method");
	if (
		settings.env &&
		(conflictingEnvironment(
			Object.fromEntries(Object.keys(settings.env).map((key) => [key, "present"])),
		).length ||
			Object.keys(settings.env).some((key) =>
				/^(CLAUDE_AGENT_|CLAUDE_CONFIG_DIR$|HOME$|USERPROFILE$|XDG_CONFIG_HOME$|PATH$)/.test(key),
			))
	)
		throw new Error("Claude native settings contain conflicting environment overrides");
	if (
		settings.permissions?.defaultMode !== undefined &&
		settings.permissions.defaultMode !== "default"
	)
		throw new Error(
			'Claude ACP requires native permissions.defaultMode "default" before discovery',
		);
}
