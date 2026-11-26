import {
	ResourceTrustRequired,
	assertInteractiveResourceTrust,
	trustInteractiveResources,
	validateProjectSafetySettings,
} from "../src/profile.ts";
import { doctor } from "../src/doctor.ts";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { bootstrap, PROFILE, validateProfile, assertSafeProfile } from "../src/profile.ts";
import { conflictingEnvironment, providerStatus, claudeMode } from "../src/policy.ts";
import { discoverMemPalace } from "../src/memory.ts";

const ROOT = resolve(import.meta.dirname, "..");
const VERSIONS = {
	"@earendil-works/pi-coding-agent": "1.5.2",
	"@earendil-works/pi-ai": "1.5.2",
	"pi-claude-bridge": "0.13.0",
	"@agentclientprotocol/claude-agent-acp": "0.112.0",
	"@agentclientprotocol/sdk": "2.6.0",
	"@modelcontextprotocol/sdk": "1.32.2",
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
				"Installed dependency differs from its pinned version; run npm ci --ignore-scripts",
			);
	}
}

export function launchArguments(args: string[]): string[] {
	const accepted: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--continue" || arg === "--resume") {
			accepted.push(arg);
			continue;
		}

		if (arg === "--model" && /^[\w-]+\/[\w.:[\]-]+$/.test(args[i + 1] || "")) {
			accepted.push(arg, args[++i]);
			continue;
		}
		if (
			[
				"-e",
				"--extension",
				"--skill",
				"--prompt-template",
				"--theme",
				"--use-theme",
				"--session",
			].includes(arg) &&
			args[i + 1] &&
			!args[i + 1].startsWith("-")
		) {
			accepted.push(arg, args[++i]);
			continue;
		}
		if (["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes"].includes(arg)) {
			accepted.push(arg);
			continue;
		}
		throw new Error(
			"Managed launch accepts session, model and native resource flags. Enter prompts inside Pi; automation modes are disabled.",
		);
	}
	return ["--offline", "-e", join(ROOT, "src/extension.ts"), ...accepted];
}

export function assertProjectConfiguration(cwd: string): void {
	validateProjectSafetySettings(cwd);
}

function reportValidation(policy: ReturnType<typeof validateProfile>): void {
	console.log(
		JSON.stringify(
			{
				dependencies: "pinned",
				node: process.versions.node,
				claude: providerStatus(`claude-${claudeMode(policy)}`, policy),
				google: providerStatus("antigravity-acp", policy),
				conflictingVariableNames: {
					claude: policy.claude.enabled ? conflictingEnvironment(process.env, "claude-acp") : [],
					google: policy.google.enabled
						? conflictingEnvironment(process.env, "antigravity-acp")
						: [],
				},
				mempalace: discoverMemPalace()
					? "installation found, not contacted"
					: "unavailable, optional",
			},
			null,
			2,
		),
	);
}
export function commandOptions(input: string[]) {
	const args = [...input];
	const options = { profile: PROFILE, project: process.cwd() };
	for (const name of ["profile", "project"] as const) {
		const flag = `--${name}`;
		const at = args.indexOf(flag);
		if (at < 0) continue;
		if (!args[at + 1] || args[at + 1].startsWith("--") || args.lastIndexOf(flag) !== at)
			throw new Error("Supply one explicit profile/project path");
		options[name] = resolve(args[at + 1]);
		assertSafeProfile(options[name]);
		args.splice(at, 2);
	}
	return { ...options, args };
}

export async function main(input: string[]): Promise<void> {
	const { args, profile, project } = commandOptions(input);
	const command = args[0] || "validate";
	if (command === "doctor") {
		const report = await doctor(profile, project);
		console.log(JSON.stringify(report, null, 2));
		if (report.checks.some((c) => c.status === "error")) process.exitCode = 1;
		return;
	}
	assertNode();
	validateDependencies();
	if (await setupCommand(command, args, profile, project)) return;
	const policy = validateProfile(profile);
	if (command === "validate") {
		reportValidation(policy);
		return;
	}
	if (command !== "launch")
		throw new Error("Commands: doctor, bootstrap, validate, launch, pi install/remove/list/config");
	assertProjectConfiguration(project);
	if (!process.stdin.isTTY || !process.stdout.isTTY)
		throw new Error("Managed Pi launch requires an interactive terminal");
	const trusted = args.includes("--trust-native-resources");
	const launch = launchArguments(args.slice(1).filter((arg) => arg !== "--trust-native-resources"));
	if (trusted) trustInteractiveResources(profile);
	assertInteractiveResourceTrust(profile);
	await spawnPi(launch, profile, project);
}

async function setupCommand(
	command: string,
	args: string[],
	profile: string,
	project: string,
): Promise<boolean> {
	if (command === "bootstrap") {
		bootstrap(profile);
		console.log(
			`Isolated profile ready at ${profile}. Next: run doctor, then launch. No login or provider requests were made.`,
		);
	} else if (command === "pi") await runNativePi(args.slice(1), profile, project);
	else return false;
	return true;
}

/** Forward resource management to the pinned Pi CLI. Installation is an explicit trusted-code action. */
export async function runNativePi(
	args: string[],
	profile = PROFILE,
	project = process.cwd(),
): Promise<void> {
	if (!["install", "remove", "list", "config"].includes(args[0]))
		throw new Error("Native resource commands: pi install, remove, list, config");
	bootstrap(profile);
	if (["install", "config"].includes(args[0])) {
		console.log(
			"Native Pi resources run as trusted application code. Installation may run dependency scripts.",
		);
		trustInteractiveResources(profile);
	}
	await spawnPi(args, profile, project);
}
async function spawnPi(args: string[], profile: string, project: string): Promise<void> {
	const cli = join(ROOT, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
	const child = spawn(process.execPath, [cli, ...args], {
		stdio: "inherit",
		cwd: project,
		env: { ...process.env, PI_CODING_AGENT_DIR: profile, PI_POLY_PROFILE: profile },
	});
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
	main(process.argv.slice(2)).catch((error) => {
		console.error(
			error instanceof ResourceTrustRequired
				? error.message
				: "Managed operation failed. Check Node >=22.19, npm ci --ignore-scripts, profile configuration, and npm run validate. Diagnostic values were withheld.",
		);
		process.exitCode = 1;
	});
}
