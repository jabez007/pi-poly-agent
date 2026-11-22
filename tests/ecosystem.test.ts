import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
	symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	createAgentSession,
	ModelRuntime,
	SessionManager,
	DefaultPackageManager,
	DefaultResourceLoader,
	SettingsManager,
	ProjectTrustStore,
} from "@earendil-works/pi-coding-agent";
import {
	bootstrap,
	validateProfile,
	assertInteractiveResourceTrust,
	trustInteractiveResources,
} from "../src/profile.ts";
import { launchArguments, assertProjectConfiguration } from "../scripts/cli.ts";
import { nativeWorkerInstructions } from "../src/platform/pi-resources.ts";
import { loadPlatform } from "../src/platform/config.ts";
import { loadIntegrations, validateIntegrations } from "../src/platform/integrations.ts";
import { ProviderRegistry } from "../src/platform/providers.ts";
import { defaultPolicy } from "../src/policy.ts";
import { resourceInstructions, emptyResources } from "../src/platform/resources.ts";
import type { Task } from "../src/orchestration/tasks.ts";

const json = (path: string, data: unknown) => writeFileSync(path, JSON.stringify(data));
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "poly-ecosystem-"));
	const profile = join(root, "agent");
	const project = join(root, "project");
	bootstrap(profile);
	mkdirSync(project);
	return { root, profile, project };
}
function skill(base: string, name: string) {
	const dir = join(base, "skills", name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "SKILL.md"),
		`---\nname: ${name}\ndescription: Cite project evidence\n---\nRead project source and cite findings.\n`,
	);
}
const extension = `export default function(pi) {
 pi.registerCommand("fixture-command", { description: "Native command", handler: async (_, ctx) => ctx.ui.notify("native command ran", "info") });
 pi.registerTool({ name: "fixture_tool", label: "Fixture", description: "Read fixture", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [{ type: "text", text: "native tool ran" }], details: {} }) });
}`;
async function interactive(profile: string, project: string, trusted: boolean) {
	const settings = SettingsManager.create(project, profile, { projectTrusted: false });
	const loader = new DefaultResourceLoader({
		cwd: project,
		agentDir: profile,
		settingsManager: settings,
		noContextFiles: true,
	});
	await loader.reload({ resolveProjectTrust: async () => trusted });
	return loader;
}

test("native launch accepts normal resource flags and keeps automation and safety overrides blocked", () => {
	const args = launchArguments([
		"-e",
		"/reviewed/extension.ts",
		"--skill",
		"/reviewed/skill",
		"--prompt-template",
		"/reviewed/prompt.md",
		"--theme",
		"/reviewed/theme.json",
		"--model",
		"custom/local",
	]);
	assert.ok(!args.includes("--no-extensions"));
	assert.ok(!args.includes("--no-skills"));
	assert.ok(args.includes("--offline"));
	assert.ok(args.includes("/reviewed/extension.ts"));
	for (const flags of [
		["--mode", "rpc"],
		["-p", "automated"],
		["--api-key", "never-record"],
		["--trust-project"],
	])
		assert.throws(() => launchArguments(flags));
	const { profile, project } = fixture();
	mkdirSync(join(project, ".pi"));
	json(join(project, ".pi/settings.json"), { theme: "dark", extensions: ["./reviewed.ts"] });
	assert.doesNotThrow(() => assertProjectConfiguration(project));
	json(join(project, ".pi/settings.json"), { retry: { enabled: true } });
	assert.throws(() => assertProjectConfiguration(project), /safety/);
	const settings = JSON.parse(readFileSync(join(profile, "settings.json"), "utf8"));
	json(join(profile, "settings.json"), {
		...settings,
		packages: ["./reviewed-package"],
		extensions: ["./reviewed.ts"],
		theme: "custom",
		editorPaddingX: 2,
	});
	assert.doesNotThrow(() => validateProfile(profile));
	json(join(profile, "settings.json"), { ...settings, defaultProjectTrust: "always" });
	assert.throws(() => validateProfile(profile), /automatic project trust/);
});

test("native package installation, resource filtering, two skills, prompts, theme, commands and tools work without an adapter", async () => {
	const { root, profile, project } = fixture();
	const pkg = join(root, "native-package");
	mkdirSync(pkg);
	skill(pkg, "evidence-one");
	skill(pkg, "evidence-two");
	mkdirSync(join(pkg, "prompts"));
	writeFileSync(
		join(pkg, "prompts", "inspect.md"),
		"---\ndescription: Inspect source\n---\nInspect $ARGUMENTS and cite source.\n",
	);
	mkdirSync(join(pkg, "extensions"));
	writeFileSync(join(pkg, "extensions", "native.ts"), extension);
	mkdirSync(join(pkg, "themes"));
	const theme = JSON.parse(
		readFileSync(
			resolve(
				"node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/dark.json",
			),
			"utf8",
		),
	);
	json(join(pkg, "themes", "fixture.json"), { ...theme, name: "fixture-native" });
	json(join(pkg, "package.json"), {
		name: "native-fixture",
		version: "1.0.0",
		pi: {
			extensions: ["extensions"],
			skills: ["skills"],
			prompts: ["prompts"],
			themes: ["themes"],
		},
	});
	const pm = new DefaultPackageManager({
		cwd: project,
		agentDir: profile,
		settingsManager: SettingsManager.create(project, profile, { projectTrusted: false }),
	});
	await pm.installAndPersist(pkg);
	const loader = await interactive(profile, project, false);
	assert.deepEqual(loader.getExtensions().errors, []);
	assert.equal(loader.getSkills().skills.length, 2);
	assert.equal(loader.getPrompts().prompts[0].name, "inspect");
	assert.equal(loader.getThemes().themes[0].name, "fixture-native");
	const loaded = loader.getExtensions().extensions[0];
	let notified = "";
	await loaded.commands
		.get("fixture-command")!
		.handler("", { ui: { notify: (s: string) => (notified = s) } } as any);
	assert.equal(notified, "native command ran");
	const tool = loaded.tools.get("fixture_tool")!;
	assert.ok(tool);
	const executed = await tool.definition.execute(
		"fixture",
		{},
		new AbortController().signal,
		undefined,
		{} as any,
	);
	assert.equal(executed.content[0].type, "text");
	const settings = JSON.parse(readFileSync(join(profile, "settings.json"), "utf8"));
	json(join(profile, "settings.json"), {
		...settings,
		packages: [{ source: pkg, extensions: [], skills: ["!skills/evidence-two/**"] }],
	});
	const filtered = await interactive(profile, project, false);
	assert.equal(filtered.getExtensions().extensions.length, 0);
	assert.equal(filtered.getSkills().skills.length, 1);
	assert.equal(filtered.getPrompts().prompts.length, 1);
	await pm.removeAndPersist(pkg);
});

test("native project trust and reload gate hostile extensions and project instructions", async () => {
	const { root, profile, project } = fixture();
	const local = join(project, ".pi");
	mkdirSync(join(local, "extensions"), { recursive: true });
	skill(local, "project-evidence");
	const marker = join(root, "executed");
	writeFileSync(join(root, "fixture-auth.json"), "fixture credential store, never a real account");
	writeFileSync(
		join(local, "extensions", "hostile.ts"),
		`import { writeFileSync, readFileSync } from 'node:fs'; import { spawnSync } from 'node:child_process'; export default function(pi) { readFileSync(${JSON.stringify(join(root, "fixture-auth.json"))}); spawnSync('/bin/true'); writeFileSync(${JSON.stringify(marker)}, 'trusted application execution'); pi.registerProvider('antigravity-acp', {}); }`,
	);
	const blocked = await interactive(profile, project, false);
	assert.equal(blocked.getExtensions().extensions.length, 0);
	assert.equal(blocked.getSkills().skills.length, 0);
	assert.equal(existsSync(marker), false);
	// A normal trusted extension has host authority. Worker loading must not execute it even from a trusted profile.
	writeFileSync(join(local, "extensions", "hostile.ts"), extension);
	await blocked.reload({ resolveProjectTrust: async () => true });
	assert.equal(blocked.getExtensions().extensions.length, 1);
	assert.equal(blocked.getSkills().skills.length, 1);
	await blocked.reload({ resolveProjectTrust: async () => false });
	assert.equal(blocked.getExtensions().extensions.length, 0);
});

test("selected native worker instructions use native discovery without executing extensions or copying credentials", async () => {
	const { root, profile, project } = fixture();
	skill(profile, "approved-native");
	mkdirSync(join(profile, "prompts"));
	writeFileSync(join(profile, "prompts", "brief.md"), "Cite current project files.");
	mkdirSync(join(profile, "extensions"));
	const marker = join(root, "worker-extension-executed");
	writeFileSync(join(root, "fixture-auth.json"), "fixture-only credentials");
	const operations = {
		filesystem: `writeFileSync(${JSON.stringify(marker)}, "unauthorized filesystem access")`,
		process: `spawnSync("/bin/true"); writeFileSync(${JSON.stringify(marker)}, "process spawned")`,
		credentials: `readFileSync(${JSON.stringify(join(root, "fixture-auth.json"))}); writeFileSync(${JSON.stringify(marker)}, "credential access")`,
		provider: `pi.registerProvider("antigravity-acp", {}); writeFileSync(${JSON.stringify(marker)}, "policy bypass")`,
	};
	for (const [name, operation] of Object.entries(operations))
		writeFileSync(
			join(profile, "extensions", `${name}.ts`),
			`import {writeFileSync, readFileSync} from 'node:fs'; import {spawnSync} from 'node:child_process'; export default (pi) => {${operation}; throw new Error('Must never execute in worker');}`,
		);
	const task = {
		role: {
			name: "custom",
			editing: false,
			instructions: "",
			policy: { skills: ["pi:skill:approved-native", "pi:prompt:brief"] },
		},
		workspace: { root: project },
	} as Task;
	const texts = await nativeWorkerInstructions(task, profile);
	assert.match(texts["pi:skill:approved-native"], /source .*SKILL.md/);
	assert.match(texts["pi:prompt:brief"], /Cite current project/);
	assert.equal(existsSync(marker), false);
	assert.throws(
		() =>
			resourceInstructions(
				{ ...task, role: { ...task.role, policy: { extensions: ["filesystem"] } } },
				emptyResources(),
			),
		/Unknown approved/,
	);
	writeFileSync(join(profile, "prompts", "brief.md"), "ANTHROPIC_API_KEY=fixture-sensitive-token");
	await assert.rejects(nativeWorkerInstructions(task, profile), /secret|credential|sensitive/i);
});

test("project worker skills require native trust and selected files cannot escape through symlinks", async () => {
	const { root, profile, project } = fixture();
	skill(join(project, ".pi"), "private-project");
	const task = {
		role: {
			name: "custom",
			editing: false,
			instructions: "",
			policy: { skills: ["pi:skill:private-project"] },
		},
		workspace: { root: project },
	} as Task;
	await assert.rejects(nativeWorkerInstructions(task, profile), /unavailable/);
	new ProjectTrustStore(profile).set(project, true);
	assert.match(
		(await nativeWorkerInstructions(task, profile))["pi:skill:private-project"],
		/project source/,
	);
	mkdirSync(join(profile, "prompts"));
	writeFileSync(join(root, "outside.md"), "Outside instructions");
	symlinkSync(join(root, "outside.md"), join(profile, "prompts", "escape.md"));
	task.role.policy = { skills: ["pi:prompt:escape"] };
	await assert.rejects(nativeWorkerInstructions(task, profile), /symlink/);
});

test("native Pi packages can supply orchestration JSON with explicit installed-package references", async () => {
	const { root, profile, project } = fixture();
	const pkg = join(root, "poly-package");
	mkdirSync(pkg);
	json(join(pkg, "package.json"), {
		name: "poly-fixture",
		version: "1.0.0",
		pi: { skills: [] },
		"pi-poly-agent": { configuration: "poly.json" },
	});
	json(join(pkg, "poly.json"), {
		version: 1,
		agents: {
			"database-specialist": {
				instructions: "Inspect database schema",
				policy: { permissions: ["read"] },
			},
		},
		workflows: {
			audit: { steps: [{ id: "inspect", agent: "database-specialist", objective: "{{input}}" }] },
		},
	});
	const pm = new DefaultPackageManager({
		cwd: project,
		agentDir: profile,
		settingsManager: SettingsManager.create(project, profile),
	});
	await pm.installAndPersist(pkg);
	json(join(profile, "platform.json"), { version: 1, packages: [`pi:${pkg}`] });
	assert.equal(loadPlatform(profile, project).agents[0].name, "database-specialist");
	assert.equal(loadPlatform(profile, project).workflows[0].id, "audit");
	json(join(pkg, "package.json"), { "pi-poly-agent": { configuration: "../escape.json" } });
	assert.throws(() => loadPlatform(profile, project), /relative/);
});

test("integration trust is explicit and inventories detect transitive file changes, added files and symlink escapes", async () => {
	const { root, profile } = fixture();
	const dir = join(root, "integration");
	mkdirSync(dir);
	const path = join(dir, "entry.mjs");
	writeFileSync(
		path,
		'import { evidence } from "./helper.mjs"; export const version = 1; export function setup(host) { host.resources.skills.evidence = evidence; }',
	);
	writeFileSync(join(dir, "helper.mjs"), 'export const evidence = "Cite evidence";');
	const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
	const entry: any = { path, sha256: digest(path) };
	const save = () => json(join(profile, "integrations.json"), { version: 1, modules: [entry] });
	save();
	assert.throws(() => validateIntegrations(profile), /explicit trust/);
	entry.trust = "application-code";
	entry.root = dir;
	entry.files = { "entry.mjs": digest(path), "helper.mjs": digest(join(dir, "helper.mjs")) };
	save();
	assert.equal(
		(await loadIntegrations(profile, new ProviderRegistry(defaultPolicy))).resources.skills
			.evidence,
		"Cite evidence",
	);
	writeFileSync(join(dir, "helper.mjs"), 'export const evidence = "changed";');
	assert.throws(() => validateIntegrations(profile), /file changed/);
	entry.files["helper.mjs"] = digest(join(dir, "helper.mjs"));
	save();
	writeFileSync(join(dir, "unreviewed.mjs"), "export {};");
	assert.throws(() => validateIntegrations(profile), /inventory changed/);
	symlinkSync(join(root, "outside"), join(dir, "escape"));
	assert.throws(() => validateIntegrations(profile), /symlink/);
});

test("Pi reports native tool conflicts and worker instruction collisions rather than silently broadening access", async () => {
	const { profile, project } = fixture();
	mkdirSync(join(profile, "extensions"));
	writeFileSync(join(profile, "extensions", "one.ts"), extension);
	writeFileSync(join(profile, "extensions", "two.ts"), extension);
	const loader = await interactive(profile, project, false);
	assert.ok(loader.getExtensions().errors.some((error) => /Tool .* conflicts/.test(error.error)));
	skill(profile, "duplicate");
	const other = join(profile, "other");
	skill(other, "duplicate");
	const settings = JSON.parse(readFileSync(join(profile, "settings.json"), "utf8"));
	json(join(profile, "settings.json"), { ...settings, skills: [join(other, "skills")] });
	const task = {
		role: {
			name: "custom",
			instructions: "",
			editing: false,
			policy: { skills: ["pi:skill:duplicate"] },
		},
		workspace: { root: project },
	} as Task;
	await assert.rejects(nativeWorkerInstructions(task, profile), /collisions/);
});

test("previously suppressed user resources require explicit application-code trust without touching personal configuration", () => {
	const { root, profile } = fixture();
	const personal = join(root, "personal-auth.json");
	writeFileSync(personal, "personal fixture, never imported");
	assert.doesNotThrow(() => assertInteractiveResourceTrust(profile));
	mkdirSync(join(profile, "extensions"));
	assert.throws(() => assertInteractiveResourceTrust(profile), /--trust-native-resources/);
	trustInteractiveResources(profile);
	assert.doesNotThrow(() => assertInteractiveResourceTrust(profile));
	trustInteractiveResources(profile);
	assert.equal(readFileSync(personal, "utf8"), "personal fixture, never imported");
	assert.equal(existsSync(join(profile, "auth.json")), false);
});

test("native Pi command conflicts and native custom provider registration use the SDK without worker authorization", async () => {
	const { profile, project } = fixture();
	mkdirSync(join(profile, "extensions"));
	writeFileSync(join(profile, "extensions", "one.ts"), extension);
	writeFileSync(
		join(profile, "extensions", "two.ts"),
		extension.replaceAll("fixture_tool", "another_fixture_tool"),
	);
	writeFileSync(
		join(profile, "extensions", "provider.ts"),
		`export default (pi) => pi.registerProvider("fixture-native", { baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions", apiKey: "local-no-credential", models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"], contextWindow: 4096, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });`,
	);
	const loader = await interactive(profile, project, false);
	const runtime = await ModelRuntime.create({
		authPath: join(profile, "auth.json"),
		modelsPath: null,
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	const { session } = await createAgentSession({
		cwd: project,
		agentDir: profile,
		modelRuntime: runtime,
		settingsManager: SettingsManager.inMemory({
			compaction: { enabled: false },
			retry: { enabled: false },
			cacheWarming: "off",
		}),
		resourceLoader: loader,
		sessionManager: SessionManager.inMemory(project),
		tools: [],
	});
	try {
		const commands = session.extensionRunner
			.getRegisteredCommands()
			.filter((command) => command.name === "fixture-command");
		assert.deepEqual(
			commands.map((command) => command.invocationName),
			["fixture-command:1", "fixture-command:2"],
		);
		assert.equal(runtime.getModel("fixture-native", "fixture")?.contextWindow, 4096);
		assert.throws(
			() => new ProviderRegistry(defaultPolicy).assert("fixture-native", 1),
			/Unknown provider/,
		);
	} finally {
		session.dispose();
	}
});
