import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	DefaultResourceLoader,
	getAgentDir,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { bootstrap } from "../src/profile.ts";

for (const inherited of [true, false])
	test(`Pi session restoration ${inherited ? "with" : "without"} the native profile environment loads that environment's resources`, async (t) => {
		const root = mkdtempSync(join(tmpdir(), "poly-herdr-restore-"));
		t.after(() => rmSync(root, { recursive: true, force: true }));
		const project = join(root, "project");
		mkdirSync(project);
		const profile = join(root, "profile");
		bootstrap(profile);
		const original = { ...process.env };
		t.after(() => {
			for (const name of ["HOME", "PI_CODING_AGENT_DIR", "PI_POLY_PROFILE"])
				if (original[name] === undefined) delete process.env[name];
				else process.env[name] = original[name];
		});
		process.env.HOME = join(root, "empty-home");
		delete process.env.PI_POLY_PROFILE;
		if (inherited) process.env.PI_CODING_AGENT_DIR = profile;
		else delete process.env.PI_CODING_AGENT_DIR;
		const session = SessionManager.create(project, join(profile, "sessions"));
		session.appendMessage({ role: "user", content: "Retained history", timestamp: 1 });
		const restored = SessionManager.open(session.getSessionFile()!);
		assert.equal(restored.getSessionId(), session.getSessionId());
		assert.equal(restored.getCwd(), project);
		const agentDir = getAgentDir();
		assert.equal(agentDir, inherited ? profile : join(process.env.HOME, ".pi/agent"));
		const loader = new DefaultResourceLoader({
			cwd: project,
			agentDir,
			settingsManager: SettingsManager.create(project, agentDir, { projectTrusted: false }),
			noContextFiles: true,
		});
		await loader.reload();
		assert.deepEqual(loader.getExtensions().errors, []);
		assert.equal(
			loader.getExtensions().extensions.some((e) => e.commands.has("poly-status")),
			inherited,
			"A session reference does not select the Poly profile",
		);
	});
