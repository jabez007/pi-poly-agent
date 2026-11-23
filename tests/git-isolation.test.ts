import assert from "node:assert/strict";
import {
	cpSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
	createWorkspace,
	git,
	inspectWorkspace,
	snapshotWorkspace,
	workspaceDiff,
} from "../src/orchestration/worktrees.ts";
import { sandboxedTest } from "../src/orchestration/tools.ts";
import { reviewedProject, temporaryRepository } from "./fixtures/review-project.ts";
import { TaskManager } from "../src/orchestration/tasks.ts";
import { defaultPolicy } from "../src/policy.ts";
import { projectIdentity } from "../src/memory.ts";

function replaceMetadata(root: string, worktree: string) {
	const marker = join(mkdtempSync(join(tmpdir(), "poly-git-marker-")), "invoked");
	const hook = `${marker}.sh`;
	writeFileSync(hook, `#!/bin/sh\nprintf invoked > '${marker}'\n`, { mode: 0o700 });
	rmSync(join(worktree, ".git"), { recursive: true, force: true });
	cpSync(join(root, ".git"), join(worktree, ".git"), { recursive: true });
	const config = join(worktree, ".git/config");
	writeFileSync(config, `${readFileSync(config, "utf8")}\n[core]\n\tfsmonitor = ${hook}\n`);
	return marker;
}

for (const operation of ["diff", "inspect", "snapshot"]) {
	test(`host ${operation} refuses substituted worktree metadata before Git execution`, () => {
		const { root, directory } = temporaryRepository();
		const workspace = createWorkspace(root, directory, "task");
		const marker = replaceMetadata(root, workspace.path);
		let message = "";
		try {
			if (operation === "diff") workspaceDiff(workspace);
			if (operation === "inspect") message = inspectWorkspace(workspace).join(" ");
			if (operation === "snapshot") snapshotWorkspace(workspace);
		} catch (error) {
			message = String(error);
		}
		assert.equal(existsSync(marker), false, "Host Git must not run worktree-owned configuration");
		assert.match(message, /metadata.*manual|inspect.*manually/i);
	});
}

test("integration preview refuses substituted metadata without executing repository commands", async () => {
	const host = await reviewedProject((task) =>
		writeFileSync(join(task.workspace.path, "app.txt"), "after\n"),
	);
	try {
		const marker = replaceMetadata(host.root, host.builder.workspace.path);
		let rejected = false;
		try {
			await host.commands.get("task").handler(`${host.builder.id} integrate`, host.ctx);
		} catch {
			rejected = true;
		}
		assert.equal(
			existsSync(marker),
			false,
			"Integration preview must not run worktree configuration",
		);
		assert.equal(rejected, true);
	} finally {
		await host.close();
	}
});

test(
	"sandboxed test commands cannot replace the task gitfile",
	{ skip: process.env.PI_POLY_SANDBOX_TEST !== "1" },
	async () => {
		const { root, directory } = temporaryRepository();
		const workspace = createWorkspace(root, directory, "task");
		const original = readFileSync(join(workspace.path, ".git"), "utf8");
		const candidate = join(workspace.path, "candidate");
		cpSync(join(root, ".git"), candidate, { recursive: true });
		const marker = join(directory, "sandbox-metadata-invoked");
		writeFileSync(
			join(candidate, "config"),
			`${readFileSync(join(candidate, "config"), "utf8")}\n[core]\n\tfsmonitor = touch ${marker}\n`,
		);
		await sandboxedTest(
			"rm -f .git && cp -R candidate .git",
			workspace.path,
			new AbortController().signal,
		);
		assert.equal(readFileSync(join(workspace.path, ".git"), "utf8"), original);
		assert.equal(git(workspace.path, ["rev-parse", "HEAD"]), workspace.base);
		assert.equal(existsSync(marker), false);
	},
);

test("legacy task recovery pins parent metadata and reports later substitution without execution", async () => {
	const host = await reviewedProject((task) =>
		writeFileSync(join(task.workspace.path, "app.txt"), "after\n"),
	);
	await host.close();
	const file = join(dirname(host.builder.workspace.path), "task.json");
	const saved = JSON.parse(readFileSync(file, "utf8"));
	delete saved.workspace.gitDir;
	writeFileSync(file, JSON.stringify(saved));
	const directory = dirname(dirname(host.builder.workspace.path));
	let manager = new TaskManager(directory, host.root, defaultPolicy, async () => {
		throw new Error("No replay");
	});
	assert.ok(manager.get(host.builder.id).workspace.gitDir);
	await manager.close();
	const marker = replaceMetadata(host.root, host.builder.workspace.path);
	manager = new TaskManager(directory, host.root, defaultPolicy, async () => {
		throw new Error("No replay");
	});
	try {
		assert.match(manager.get(host.builder.id).recovery!.join(" "), /metadata.*manually/i);
		assert.equal(projectIdentity(host.builder.workspace.path).revision, "unknown");
		assert.equal(existsSync(marker), false);
	} finally {
		await manager.close();
	}
});

test("host Git rejects a symlink substituted for the registered gitfile", () => {
	const { root, directory } = temporaryRepository();
	const workspace = createWorkspace(root, directory, "task");
	const file = join(workspace.path, ".git"),
		copy = join(directory, "gitfile");
	writeFileSync(copy, readFileSync(file));
	rmSync(file);
	symlinkSync(copy, file);
	assert.throws(() => git(workspace.path, ["status", "--porcelain"]), /metadata.*manually/i);
});

test("all host Git invocations disable repository filesystem monitors", () => {
	const { root } = temporaryRepository();
	const marker = replaceMetadata(root, mkdtempSync(join(tmpdir(), "poly-git-generic-")));
	const file = join(root, ".git/config");
	writeFileSync(file, `${readFileSync(file, "utf8")}\n[core]\n\tfsmonitor = ${marker}.sh\n`);
	git(root, ["status", "--porcelain"]);
	assert.equal(existsSync(marker), false);
});
