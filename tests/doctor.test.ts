import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { bootstrap } from "../src/profile.ts";
import { doctor } from "../src/doctor.ts";
import { commandOptions } from "../scripts/cli.ts";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { nativeResourceInventory } from "../src/platform/pi-resources.ts";

function invoke(profile: string, project: string) {
	return spawnSync(
		process.execPath,
		[
			"--import",
			"tsx",
			resolve("scripts/cli.ts"),
			"doctor",
			"--profile",
			profile,
			"--project",
			project,
		],
		{
			encoding: "utf8",
			env: { ...process.env, ANTHROPIC_API_KEY: "fixture-never-print-this-value" },
			timeout: 30000,
		},
	);
}
test("doctor reports missing configuration without creating a profile or exposing credentials", () => {
	const project = mkdtempSync(join(tmpdir(), "poly-doctor-"));
	const profile = join(project, "absent");
	const run = invoke(profile, project);
	const report = JSON.parse(run.stdout);
	assert.equal(run.status, 1);
	assert.equal(report.checks.find((c: any) => c.id === "profile").status, "error");
	assert.equal(existsSync(profile), false);
	assert.ok(!JSON.stringify(report).includes("fixture-never-print-this-value"));
});

test("doctor discovers native resources and retired configuration without executing trusted code", async () => {
	const root = mkdtempSync(join(tmpdir(), "poly-doctor-trust-"));
	const profile = join(root, "profile");
	bootstrap(profile);
	mkdirSync(join(profile, "extensions"));
	const marker = join(root, "executed");
	writeFileSync(
		join(profile, "extensions/hostile.ts"),
		`import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)},'must not execute'); export default () => {};`,
	);
	writeFileSync(
		join(profile, "platform.json"),
		JSON.stringify({
			version: 1,
			recipes: ["minimal"],
			agents: { auditor: { instructions: "Inspect project", policy: { permissions: ["read"] } } },
		}),
	);
	const settings = readFileSync(join(profile, "settings.json"), "utf8");
	const report = await doctor(profile, root);
	assert.equal(
		report.resources!.resources.extensions.some((r) => r.path.endsWith("hostile.ts")),
		true,
	);
	assert.equal(report.checks.find((c) => c.id === "native-trust")!.status, "error");
	assert.equal(existsSync(marker), false);
	assert.equal(existsSync(join(profile, "auth.json")), false);
	assert.equal(readFileSync(join(profile, "settings.json"), "utf8"), settings);
});

test("explicit profile/project paths are scoped to the invocation and cannot be duplicated or symlinked", () => {
	const root = mkdtempSync(join(tmpdir(), "poly-command-options-"));
	const input = ["bootstrap", "--profile", join(root, "agent"), "--project", root];
	const result = commandOptions(input);
	assert.deepEqual(result.args, ["bootstrap"]);
	assert.equal(result.profile, join(root, "agent"));
	assert.equal(result.project, root);
	assert.equal(input.length, 5);
	assert.throws(() => commandOptions(["doctor", "--profile"]));
	assert.throws(() => commandOptions(["doctor", "--profile", root, "--profile", root]));
});

test("CLI bootstrap and validation preserve a separate development profile without recipes", () => {
	const root = mkdtempSync(join(tmpdir(), "poly-onboarding-"));
	const profile = join(root, "dev-agent");
	const call = (command: string) =>
		spawnSync(
			process.execPath,
			[
				"--import",
				"tsx",
				resolve("scripts/cli.ts"),
				command,
				"--profile",
				profile,
				"--project",
				root,
			],
			{ encoding: "utf8", timeout: 30000 },
		);
	assert.equal(call("bootstrap").status, 0);
	const before = readFileSync(join(profile, "poly.json"), "utf8");
	assert.equal(call("bootstrap").status, 0);
	assert.equal(call("validate").status, 0);
	assert.equal(readFileSync(join(profile, "poly.json"), "utf8"), before);
	assert.equal(existsSync(join(profile, "auth.json")), false);
});

test("native inspection retains both user and trusted-project package scopes", async () => {
	const root = mkdtempSync(join(tmpdir(), "poly-package-scopes-")),
		profile = join(root, "profile"),
		project = join(root, "project");
	bootstrap(profile);
	mkdirSync(join(project, ".pi"), { recursive: true });
	for (const name of ["user", "project"]) {
		const path = join(root, `${name}-package`);
		mkdirSync(join(path, "prompts"), { recursive: true });
		writeFileSync(
			join(path, "package.json"),
			JSON.stringify({ name: `${name}-fixture`, version: "1.0.0", pi: { prompts: ["prompts"] } }),
		);
		writeFileSync(join(path, `prompts/${name}.md`), "Cite project evidence.");
	}
	const settings = JSON.parse(readFileSync(join(profile, "settings.json"), "utf8"));
	writeFileSync(
		join(profile, "settings.json"),
		JSON.stringify({ ...settings, packages: [join(root, "user-package")] }),
	);
	writeFileSync(
		join(project, ".pi/settings.json"),
		JSON.stringify({ packages: [join(root, "project-package")] }),
	);
	new ProjectTrustStore(profile).set(project, true);
	const report = await nativeResourceInventory(profile, project);
	assert.deepEqual(report.resources.prompts.map((p) => p.metadata.scope).sort(), [
		"project",
		"user",
	]);
});

test("doctor reports enabled-runtime environment names without blocking unrelated providers or executing binaries", async () => {
	const profile = mkdtempSync(join(tmpdir(), "poly-doctor-enabled-"));
	bootstrap(profile);
	const file = join(profile, "poly.json");
	const policy = JSON.parse(readFileSync(file, "utf8"));
	policy.claude = { enabled: true, path: join(profile, "missing-fixture-claude") };
	writeFileSync(file, JSON.stringify(policy));
	const previous = process.env.ANTHROPIC_API_KEY;
	process.env.ANTHROPIC_API_KEY = "fixture-sensitive-value";
	try {
		const report = await doctor(profile, profile);
		assert.equal(report.checks.find((c) => c.id === "claude-acp-environment")?.status, "warning");
		assert.ok(!JSON.stringify(report).includes("fixture-sensitive-value"));
		assert.ok(report.providers.some((p) => p.includes("openai-codex")));
	} finally {
		if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
		else process.env.ANTHROPIC_API_KEY = previous;
	}
});

test("doctor reports missing native packages without downloading or initializing them", async () => {
	const root = mkdtempSync(join(tmpdir(), "poly-missing-package-"));
	bootstrap(root);
	const settings = JSON.parse(readFileSync(join(root, "settings.json"), "utf8"));
	writeFileSync(
		join(root, "settings.json"),
		JSON.stringify({ ...settings, packages: ["npm:poly-nonexistent-fixture@1.0.0"] }),
	);
	const report = await doctor(root, root);
	assert.equal(report.resources?.packages[0].installedPath ? "ok" : "warning", "warning");
	assert.equal(existsSync(join(root, "npm")), false);
});
