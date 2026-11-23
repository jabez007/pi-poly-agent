import process from "node:process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Every test process gets empty auth stores. Never point a fixture at a real account.
const root = mkdtempSync(join(tmpdir(), "pi-poly-test-"));
process.env.HOME = root;
process.env.USERPROFILE = root;
process.env.XDG_CONFIG_HOME = join(root, "config");
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
process.env.CLAUDE_CONFIG_DIR = join(root, "claude");
process.env.MEMPALACE_CONFIG_DIR = join(root, "memory-unavailable");
process.env.PI_OFFLINE = "1";
for (const key of Object.keys(process.env)) {
	if (
		/^(ANTHROPIC_|GOOGLE_|GEMINI_|AGY_|PI_AGY_|CLAUDE_BRIDGE_|CLAUDE_CODE_OAUTH|OPENAI_API_KEY|KIMI_API_KEY|ZAI_API_KEY)/.test(
			key,
		)
	)
		delete process.env[key];
}
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
