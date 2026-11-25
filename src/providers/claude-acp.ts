import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { assertRequest, defaultPolicy, CLAUDE_ACP_PROVIDER } from "../policy.ts";
import { attestRuntime } from "../profile.ts";
import { configModels, type AcpPort, type AcpRuntime } from "./acp.ts";
import { assertClaudeAcpSettings } from "./claude-acp-settings.ts";

export const CLAUDE_LOGIN_MESSAGE =
	"Claude Code is not logged in. Run claude auth login, then retry explicit discovery.";
export class ClaudeAcpError extends Error {}

export function claudeAcpError(error: unknown, fallback: string): Error {
	if (error instanceof ClaudeAcpError) return error;
	if ((error as { code?: number })?.code === -32000)
		return new ClaudeAcpError(CLAUDE_LOGIN_MESSAGE);
	return new ClaudeAcpError(fallback);
}

export async function requireClaudeSubscription(request: AcpPort["request"]): Promise<void> {
	const status = await request("auth/status", {}, { signal: AbortSignal.timeout(10000) });
	if (status?.state === "unauthenticated") throw new ClaudeAcpError(CLAUDE_LOGIN_MESSAGE);
	const accounts = status?.accounts;
	if (
		status?.state !== "authenticated" ||
		!Array.isArray(accounts) ||
		accounts.length !== 1 ||
		accounts[0]?._meta?.claudeCode?.kind !== "account"
	)
		throw new ClaudeAcpError(
			"Claude ACP requires verified native subscription authentication; no alternate billing attempted",
		);
}

export const CLAUDE_ACP_RUNTIME = {
	discoveryCommand: "poly-claude-discover",
	command: async (activation, cwd) => {
		assertRequest(CLAUDE_ACP_PROVIDER, { ...defaultPolicy(), claude: activation }, true);
		await assertClaudeAcpSettings(cwd);
		const executable = attestRuntime(activation);
		const require = createRequire(import.meta.url);
		const manifest = require.resolve("@agentclientprotocol/claude-agent-acp/package.json");
		if (JSON.parse(readFileSync(manifest, "utf8")).version !== "0.112.0")
			throw new ClaudeAcpError("Claude ACP adapter differs from the reviewed dependency pin");
		return {
			executable: process.execPath,
			args: [join(dirname(manifest), "dist/index.js")],
			env: { ...process.env, CLAUDE_CODE_EXECUTABLE: executable, CLAUDE_AGENT_ACP_PROTOCOL: "v1" },
		};
	},
	login: async (initialized, request) => {
		if (initialized.authMethods?.length || !initialized.agentCapabilities?.auth?.status)
			throw new ClaudeAcpError(
				"Claude ACP requires native login status without client authentication or provider routing",
			);
		await requireClaudeSubscription(request);
	},
	models: (session) => configModels(session),
	beforeRequest: async (method, cwd, request, params) => {
		assertNativeRequest(method, params);
		await assertClaudeAcpSettings(cwd);
		await requireClaudeSubscription(request);
	},
	modeAllowed: (mode) => ["default", "plan", "acceptEdits"].includes(mode),
	validateSession: (session) => {
		if (session.modes?.currentModeId !== "default")
			throw new ClaudeAcpError(
				"Claude ACP refused a session that did not start in default permission mode",
			);
	},
	error: claudeAcpError,
} satisfies AcpRuntime;

function assertNativeRequest(method: string, params: any): void {
	if (
		![
			"session/new",
			"session/load",
			"session/set_mode",
			"session/set_config_option",
			"session/prompt",
		].includes(method)
	)
		throw new ClaudeAcpError("Claude ACP request is outside the reviewed native protocol");
	if (method === "session/set_mode" && !["default", "plan", "acceptEdits"].includes(params?.modeId))
		throw new ClaudeAcpError("Claude ACP permission mode is forbidden");
	if (method === "session/set_config_option" && params?.configId !== "model")
		throw new ClaudeAcpError("Claude ACP configuration override refused");
	if (
		["session/new", "session/load"].includes(method) &&
		Object.keys(params || {}).some((key) => !["sessionId", "cwd", "mcpServers"].includes(key))
	)
		throw new ClaudeAcpError("Claude ACP session override refused");
}
