import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { assertEnvironment, CLAUDE_ACP_PROVIDER } from "../policy.ts";
import { runtimePath } from "../profile.ts";
import { AcpRuntimeError, configModels, type AcpPort, type AcpRuntime } from "./acp.ts";

export const CLAUDE_LOGIN_MESSAGE =
	"Claude Code is not logged in. Run claude auth login, then retry.";
export class ClaudeAcpError extends AcpRuntimeError {}
export function claudeAcpError(error: unknown, fallback: string): Error {
	if (error instanceof ClaudeAcpError) return error;
	return new ClaudeAcpError(
		(error as { code?: number })?.code === -32000 ? CLAUDE_LOGIN_MESSAGE : fallback,
	);
}
export async function requireClaudeLogin(request: AcpPort["request"]): Promise<void> {
	const status = await request("auth/status", {}, { signal: AbortSignal.timeout(10000) });
	if (status?.state !== "authenticated") throw new ClaudeAcpError(CLAUDE_LOGIN_MESSAGE);
}
export const CLAUDE_ACP_RUNTIME = {
	provider: CLAUDE_ACP_PROVIDER,
	discoveryCommand: "poly-claude-discover",
	command: (activation) => {
		assertEnvironment(CLAUDE_ACP_PROVIDER);
		const executable = runtimePath(activation, "claude");
		const require = createRequire(import.meta.url);
		const manifest = require.resolve("@agentclientprotocol/claude-agent-acp/package.json");
		if (JSON.parse(readFileSync(manifest, "utf8")).version !== "0.112.0")
			throw new ClaudeAcpError("Claude ACP dependency differs from its installed pin");
		return {
			executable: process.execPath,
			args: [join(dirname(manifest), "dist/index.js")],
			env: { ...process.env, CLAUDE_CODE_EXECUTABLE: executable, CLAUDE_AGENT_ACP_PROTOCOL: "v1" },
		};
	},
	login: async (initialized, request) => {
		if (initialized.authMethods?.length || !initialized.agentCapabilities?.auth?.status)
			throw new ClaudeAcpError(CLAUDE_LOGIN_MESSAGE);
		await requireClaudeLogin(request);
	},
	models: (session) => configModels(session),
	beforeRequest: async () => assertEnvironment(CLAUDE_ACP_PROVIDER),
	error: claudeAcpError,
} satisfies AcpRuntime;
