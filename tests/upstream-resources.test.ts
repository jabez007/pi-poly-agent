import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	DefaultPackageManager,
	DefaultResourceLoader,
	SettingsManager,
	ModelRuntime,
	ModelRegistry,
	ProjectTrustStore,
	SessionManager,
	createAgentSession,
} from "@earendil-works/pi-coding-agent";
import { loadThemeFromPath } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { bootstrap } from "../src/profile.ts";
import { git } from "../src/orchestration/worktrees.ts";
import { nativeWorkerInstructions } from "../src/platform/pi-resources.ts";
import type { Task } from "../src/orchestration/tasks.ts";
import { deterministicProvider } from "./fixtures/deterministic-provider.ts";

const upstream = resolve("node_modules/@earendil-works/pi-coding-agent/examples/extensions");
const json = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value));
async function host(pkg: string, extraExtensions: string[] = []) {
	const root = mkdtempSync(join(tmpdir(), "poly-upstream-")),
		profile = join(root, "profile"),
		project = join(root, "project");
	bootstrap(profile);
	mkdirSync(project);
	json(join(profile, "platform.json"), { version: 1, recipes: ["minimal"] });
	git(project, ["init", "-b", "main"]);
	git(project, ["config", "user.name", "Fixture"]);
	git(project, ["config", "user.email", "fixture@example.invalid"]);
	git(project, ["commit", "--allow-empty", "-m", "base"]);
	const settings = SettingsManager.create(project, profile, { projectTrusted: false });
	const packages = new DefaultPackageManager({
		cwd: project,
		agentDir: profile,
		settingsManager: settings,
	});
	await packages.installAndPersist(pkg);
	const loader = new DefaultResourceLoader({
		cwd: project,
		agentDir: profile,
		settingsManager: settings,
		noContextFiles: true,
		additionalExtensionPaths: extraExtensions,
	});
	const previous = process.env.PI_POLY_PROFILE;
	const restoreProfile = () => {
		if (previous === undefined) delete process.env.PI_POLY_PROFILE;
		else process.env.PI_POLY_PROFILE = previous;
	};
	process.env.PI_POLY_PROFILE = profile;
	let loaded = false;
	try {
		await loader.reload();
		const runtime = await ModelRuntime.create({
			authPath: join(profile, "auth.json"),
			modelsPath: null,
			allowModelNetwork: false,
			refreshOnCreate: false,
		});
		const sessions = SessionManager.create(project, join(profile, "sessions"));
		const { session } = await createAgentSession({
			cwd: project,
			agentDir: profile,
			resourceLoader: loader,
			modelRuntime: runtime,
			sessionManager: sessions,
			settingsManager: settings,
			tools: ["hello", "todo"],
		});
		const notices: string[] = [],
			statuses = new Map<string, string>();
		const theme = loadThemeFromPath(
			resolve(
				"node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/dark.json",
			),
		);
		await session.bindExtensions({
			uiContext: {
				...session.extensionRunner.getUIContext(),
				theme,
				confirm: async () => true,
				notify: (s: string) => notices.push(s),
				setStatus: (k: string, s: string | undefined) => {
					if (s) statuses.set(k, s);
				},
			},
			mode: "tui",
		});
		loaded = true;
		return {
			root,
			project,
			profile,
			packages,
			loader,
			session,
			sessions,
			runtime,
			notices,
			statuses,
			theme,
			close: () => {
				try {
					session.dispose();
				} finally {
					restoreProfile();
				}
			},
		};
	} finally {
		if (!loaded) restoreProfile();
	}
}

test("unmodified Pi 1.5.2 session, todo, status and dynamic resources coexist with Poly commands", async () => {
	const pkg = mkdtempSync(join(tmpdir(), "poly-official-examples-"));
	mkdirSync(join(pkg, "extensions"));
	for (const name of ["session-name.ts", "todo.ts", "status-line.ts", "dynamic-resources"])
		cpSync(join(upstream, name), join(pkg, "extensions", name), { recursive: true });
	json(join(pkg, "package.json"), {
		name: "official-example-qualification-bundle",
		version: "1.5.2",
		pi: {
			extensions: [
				"extensions/session-name.ts",
				"extensions/todo.ts",
				"extensions/status-line.ts",
				"extensions/dynamic-resources/index.ts",
			],
		},
	});
	const h = await host(pkg, [resolve("src/extension.ts")]);
	try {
		assert.deepEqual(h.loader.getExtensions().errors, []);
		assert.ok(h.session.extensionRunner.getCommand("poly-doctor"));
		await h.session.extensionRunner.emit({ type: "session_start", reason: "startup" });
		assert.match(h.statuses.get("status-demo")!, /Ready/);
		await h.session.extensionRunner.emit({ type: "turn_start", turnIndex: 0, timestamp: 0 });
		assert.match(h.statuses.get("status-demo")!, /Turn 1/);
		await h.session.prompt("/session-name Product compatibility fixture");
		assert.equal(h.sessions.getSessionName(), "Product compatibility fixture");
		new ModelRegistry(h.runtime).registerProvider(
			deterministicProvider("openai-codex", (context) =>
				context.messages.some((m: any) => m.role === "toolResult")
					? [{ type: "text", text: "Todo recorded." }]
					: [
							{
								type: "toolCall",
								id: "fixture-todo",
								name: "todo",
								arguments: { action: "add", text: "Verify native package" },
							},
						],
			),
		);
		await h.session.setModel(h.runtime.getModel("openai-codex", "fixture")!);
		await h.session.prompt("Add the bounded fixture todo.");
		assert.ok(
			h.session.messages.some(
				(m) => m.role === "toolResult" && JSON.stringify(m).includes("Verify native package"),
			),
		);
		assert.equal(
			SessionManager.open(h.sessions.getSessionFile()!).getSessionName(),
			"Product compatibility fixture",
		);
		await h.session.reload();
		const restored = await h.session
			.getToolDefinition("todo")!
			.execute(
				"list",
				{ action: "list" },
				undefined,
				undefined,
				h.session.extensionRunner.createToolContext("list", undefined),
			);
		assert.match(JSON.stringify(restored.content), /Verify native package/);
		assert.ok(h.loader.getSkills().skills.some((s) => s.name === "dynamic-resources"));
		assert.ok(h.loader.getPrompts().prompts.some((p) => p.name === "dynamic"));
		const task = {
			role: {
				name: "reader",
				editing: false,
				instructions: "",
				policy: { skills: ["pi:skill:dynamic-resources"] },
			},
			workspace: { root: h.project },
		} as Task;
		await assert.rejects(nativeWorkerInstructions(task, h.profile), /unavailable/);
		const settings = JSON.parse(readFileSync(join(h.profile, "settings.json"), "utf8"));
		json(join(h.profile, "settings.json"), {
			...settings,
			skills: [join(pkg, "extensions/dynamic-resources/SKILL.md")],
		});
		assert.match(
			(await nativeWorkerInstructions(task, h.profile))["pi:skill:dynamic-resources"],
			/Dynamic Resources Skill/,
		);
	} finally {
		h.close();
	}
});

test("the pinned real template package executes commands/tools and a selection widget without a Poly adapter", async () => {
	const pkg = resolve("tests/fixtures/vendor/pi-package-template");
	const approval = JSON.parse(
		readFileSync(resolve("tests/fixtures/vendor/pi-package-template.review.json"), "utf8"),
	);
	assert.equal(
		readdirSync(pkg, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).length,
		Object.keys(approval.files).length,
	);
	for (const [name, digest] of Object.entries(approval.files))
		assert.equal(
			createHash("sha256")
				.update(readFileSync(join(pkg, name)))
				.digest("hex"),
			digest,
		);
	assert.equal(JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")).version, "1.2.0");
	const h = await host(pkg);
	try {
		assert.deepEqual(h.loader.getExtensions().errors, []);
		await h.session.prompt("/hello developer");
		assert.ok(h.notices.some((n) => n.includes("Hello, developer!")));
		const tool = await h.session
			.getToolDefinition("hello")!
			.execute(
				"greet",
				{ name: "developer" },
				undefined,
				undefined,
				h.session.extensionRunner.createToolContext("greet", undefined),
			);
		assert.deepEqual(tool.details, { greeted: "developer" });
		let rendered = "";
		h.session.extensionRunner.setUIContext(
			{
				...h.session.extensionRunner.getUIContext(),
				custom: async <T>(factory: any): Promise<T> => {
					let finish!: (value: T) => void;
					const result = new Promise<T>((resolve) => {
						finish = resolve;
					});
					const view = await factory({ requestRender: () => {} }, h.theme, {}, finish);
					rendered = view.render(80).join("\n");
					view.handleInput("\r");
					return result;
				},
			},
			"tui",
		);
		await h.session.prompt("/pick");
		assert.match(rendered, /Option A/);
		assert.ok(h.notices.some((n) => n.includes("Selected: alpha")));
		assert.equal(h.loader.getPrompts().prompts[0].name, "hello");
		assert.equal(h.session.messages.length, 0);
		assert.match(h.loader.getThemes().themes[0].fg("accent", "template render"), /template render/);
		assert.equal(h.loader.getSkills().skills.length, 0);
		assert.ok(
			h.loader.getSkills().diagnostics.some((d) => d.message === "description is required"),
		);
	} finally {
		h.close();
	}
});

test("a real SDK host activates project-local commands and worker instructions only after saved native trust", async () => {
	const h = await host(resolve("tests/fixtures/vendor/pi-package-template"));
	try {
		mkdirSync(join(h.project, ".pi/extensions"), { recursive: true });
		mkdirSync(join(h.project, ".pi/skills/project-evidence"), { recursive: true });
		writeFileSync(
			join(h.project, ".pi/extensions/evidence.ts"),
			'export default pi => pi.registerCommand("project-evidence",{description:"Read local evidence",handler:async(_,ctx)=>ctx.ui.notify("Project evidence loaded","info")});',
		);
		writeFileSync(
			join(h.project, ".pi/skills/project-evidence/SKILL.md"),
			"---\nname: project-evidence\ndescription: Cite current project evidence\n---\nRead approved project source.\n",
		);
		await h.session.reload();
		assert.equal(h.session.extensionRunner.getCommand("project-evidence"), undefined);
		new ProjectTrustStore(h.profile).set(h.project, true);
		await h.loader.reload({
			resolveProjectTrust: async () => new ProjectTrustStore(h.profile).get(h.project) === true,
		});
		await h.session.reload();
		assert.ok(h.session.extensionRunner.getCommand("project-evidence"));
		await h.session.prompt("/project-evidence");
		assert.ok(h.notices.includes("Project evidence loaded"));
		const task = {
			role: {
				name: "local-reader",
				editing: false,
				instructions: "",
				policy: { skills: ["pi:skill:project-evidence"] },
			},
			workspace: { root: h.project },
		} as Task;
		assert.match(
			(await nativeWorkerInstructions(task, h.profile))["pi:skill:project-evidence"],
			/Read approved/,
		);
	} finally {
		h.close();
	}
});
