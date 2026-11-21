import { validateIntegrations } from "../src/platform/integrations.ts";
import { loadPlatform } from "../src/platform/config.ts";
import { ProviderRegistry, validateInstanceDefinition } from "../src/platform/providers.ts";
import { qualificationPlan } from "../src/orchestration/qualification.ts";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { bootstrap, PROFILE, validateProfile, assertSafeProfile } from "../src/profile.ts";
import { assertEnvironment, conflictingEnvironment } from "../src/policy.ts";
import { discoverMemPalace } from "../src/memory.ts";

const ROOT = resolve(import.meta.dirname, "..");
const VERSIONS = {
	"@earendil-works/pi-coding-agent": "1.5.2",
	"@earendil-works/pi-ai": "1.5.2",
	"pi-claude-bridge": "0.13.0",
	"@agentclientprotocol/sdk": "2.6.0",
	"@modelcontextprotocol/sdk": "1.32.2",
	typebox: "1.3.27",
};

export function assertNode(version = process.versions.node): void {
	const [major, minor] = version.split(".").map(Number);
	if (major < 22 || (major === 22 && minor < 19))
		throw new Error("Node >=22.19.0 is required. No installed runtime was changed.");
}

export function validateDependencies(): void {
	for (const [name, expected] of Object.entries(VERSIONS)) {
		const manifest = JSON.parse(
			readFileSync(join(ROOT, "node_modules", name, "package.json"), "utf8"),
		);
		if (manifest.version !== expected)
			throw new Error(
				"Installed dependency differs from reviewed pin; run npm ci --ignore-scripts",
			);
	}
}

export function launchArguments(
	args: string[],
	providers = ["openai-codex", "kimi-coding", "zai", "claude-bridge", "antigravity-acp"],
): string[] {
	const accepted: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--continue" || arg === "--resume") {
			accepted.push(arg);
			continue;
		}
		if (
			arg === "--model" &&
			/^[\w-]+\/[\w.:[\]-]+$/.test(args[i + 1] || "") &&
			providers.includes((args[i + 1] || "").split("/")[0])
		) {
			accepted.push(arg, args[++i]);
			continue;
		}
		throw new Error(
			"Managed launch accepts only --continue, --resume, and --model provider/model. Enter prompts inside Pi.",
		);
	}
	return [
		"--offline",
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--no-themes",
		"-e",
		join(ROOT, "src/extension.ts"),
		...accepted,
	];
}

export function assertProjectConfiguration(cwd: string): void {
	// Pi can merge project settings before extensions load. Refuse unknown executable configuration.
	let directory = resolve(cwd);
	while (directory !== dirname(directory)) {
		for (const name of ["settings.json", "models.json", "mcp.json"]) {
			if (existsSync(join(directory, ".pi", name)))
				throw new Error(
					"Existing project .pi configuration needs review before managed launch; it was preserved",
				);
		}
		directory = dirname(directory);
	}
}

export function selectRecipe(recipe: string, profile = PROFILE): void {
	assertSafeProfile(profile);
	if (!["minimal", "implementation-review", "agent-team", "odoo-team"].includes(recipe))
		throw new Error("Choose a supplied recipe");
	const file = join(profile, "platform.json");
	if (existsSync(file))
		throw new Error(
			"platform.json already exists; edit it explicitly. No configuration was overwritten.",
		);
	writeFileSync(file, JSON.stringify({ version: 1, recipes: [recipe] }, null, 2) + "\n", {
		flag: "wx",
		mode: 0o600,
	});
	console.log(`Selected ${recipe}. No provider login or request occurred.`);
}

function reportValidation(
	policy: ReturnType<typeof validateProfile>,
	platform: ReturnType<typeof loadPlatform>,
): void {
	const names = conflictingEnvironment(process.env);
	console.log(
		JSON.stringify(
			{
				dependencies: "pinned",
				agents: platform.agents.map((a) => a.name),
				workflows: platform.workflows.map((w) => w.id),
				node: process.versions.node,
				claude: policy.claude.enabled ? "activated, live unverified" : "locked",
				google: policy.google.enabled ? "activated, live unverified" : "locked",
				conflictingVariableNames: names,
				mempalace: discoverMemPalace()
					? "existing installation discovered, not contacted"
					: "unavailable, optional",
			},
			null,
			2,
		),
	);
	if (names.length) process.exitCode = 1;
}
export async function main(args: string[]): Promise<void> {
	assertNode();
	validateDependencies();
	const command = args[0] || "validate";
	if (command === "bootstrap") {
		bootstrap();
		console.log("Isolated profile ready at .poly/agent. No login or provider requests were made.");
		return;
	}
	if (command === "recipe") {
		selectRecipe(args[1]);
		return;
	}
	const policy = validateProfile();
	const platform = loadPlatform(PROFILE);
	validateIntegrations(PROFILE);
	const providers = new ProviderRegistry(() => validateProfile());
	for (const instance of platform.providers) validateInstanceDefinition(instance);
	if (command === "qualify") {
		console.log(JSON.stringify(qualificationPlan(args[1], policy), null, 2));
		return;
	}
	if (command === "validate") {
		reportValidation(policy, platform);
		return;
	}
	if (command !== "launch")
		throw new Error("Commands: bootstrap, recipe NAME, validate, qualify PROVIDER, launch");
	assertEnvironment(process.env);
	assertProjectConfiguration(process.cwd());
	if (!process.stdin.isTTY || !process.stdout.isTTY)
		throw new Error("Managed Pi launch requires an interactive terminal");
	const cli = join(ROOT, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
	const child = spawn(
		process.execPath,
		[
			cli,
			...launchArguments(
				args.slice(1),
				[...providers.list(), ...platform.providers].map((p) => p.id),
			),
		],
		{
			stdio: "inherit",
			env: { ...process.env, PI_CODING_AGENT_DIR: PROFILE, PI_POLY_PROFILE: PROFILE },
		},
	);
	const forward = (signal: NodeJS.Signals) => {
		if (child.exitCode === null) child.kill(signal);
	};
	const terminate = () => forward("SIGTERM");
	const interrupt = () => forward("SIGINT");
	process.on("SIGTERM", terminate);
	process.on("SIGINT", interrupt);
	await new Promise<void>((resolve, reject) => {
		child.once("error", () => reject(new Error("Pi could not start")));
		child.once("exit", (code) => {
			process.removeListener("SIGTERM", terminate);
			process.removeListener("SIGINT", interrupt);
			process.exitCode = code ?? 1;
			resolve();
		});
	});
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	main(process.argv.slice(2)).catch(() => {
		console.error(
			"Managed operation failed. Check Node >=22.19, npm ci --ignore-scripts, profile configuration, and npm run validate. Diagnostic values were withheld.",
		);
		process.exitCode = 1;
	});
}
