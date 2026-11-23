import assert from "node:assert/strict";
import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
	assertIntegration,
	cleanupWorkspace,
	createWorkspace,
	inspectWorkspace,
	snapshotWorkspace,
	workspaceDiff,
} from "../src/orchestration/worktrees.ts";
import { sandboxedTest } from "../src/orchestration/tools.ts";
import { TaskManager } from "../src/orchestration/tasks.ts";
import { defaultPolicy } from "../src/policy.ts";
import { defaultRoles } from "../src/orchestration/roles.ts";
import { nestedRepository } from "./fixtures/nested-repository.ts";
import { reviewedProject, temporaryRepository } from "./fixtures/review-project.ts";

for (const form of ["directory", "deep", "file", "symlink"]) {
	for (const operation of ["diff", "snapshot", "inspect", "cleanup", "integration"]) {
		test(`${operation} refuses a ${form} nested repository before host Git`, () => {
			const { root, directory } = temporaryRepository();
			const workspace = createWorkspace(root, directory, "task");
			const { marker } = nestedRepository(root, workspace.path, directory, form);
			let message = "";
			try {
				if (operation === "diff") workspaceDiff(workspace);
				if (operation === "snapshot") snapshotWorkspace(workspace);
				if (operation === "inspect") message = inspectWorkspace(workspace).join(" ");
				if (operation === "cleanup") cleanupWorkspace(workspace);
				if (operation === "integration") assertIntegration(workspace, workspace.base);
			} catch (error) {
				message = String(error);
			}
			assert.equal(existsSync(marker), false, "Nested configuration must not execute on the host");
			assert.match(message, /nested repository.*inspect.*manually/i);
		});
	}
	test(`preview and restart refuse a ${form} nested repository`, async () => {
		const host = await reviewedProject((task) =>
			writeFileSync(join(task.workspace.path, "app.txt"), "after\n"),
		);
		const directory = dirname(dirname(host.builder.workspace.path));
		const { marker } = nestedRepository(
			host.root,
			host.builder.workspace.path,
			dirname(host.profile),
			form,
		);
		try {
			await assert.rejects(
				host.commands.get("task").handler(`${host.builder.id} integrate`, host.ctx),
				/nested repository.*inspect.*manually/i,
			);
			assert.equal(existsSync(marker), false);
		} finally {
			await host.close();
		}
		const restored = new TaskManager(directory, host.root, defaultPolicy, async () => {
			throw new Error("No replay");
		});
		try {
			assert.match(
				restored.get(host.builder.id).recovery!.join(" "),
				/nested repository.*inspect.*manually/i,
			);
			assert.equal(existsSync(marker), false);
		} finally {
			await restored.close();
		}
	});
}

test(
	"sandbox-created nested repositories are refused at task completion",
	{ skip: process.env.PI_POLY_SANDBOX_TEST !== "1" },
	async () => {
		const { root, directory } = temporaryRepository();
		const result = { summary: "Fixture result", files: [], tests: [], findings: [], questions: [] };
		const manager = new TaskManager(
			join(directory, "tasks"),
			root,
			defaultPolicy,
			async ({ task, signal }) => {
				cpSync(join(root, ".git"), join(task.workspace.path, "payload"), { recursive: true });
				const marker = join(directory, "sandbox-nested-marker");
				const config = join(task.workspace.path, "payload/config");
				writeFileSync(
					config,
					`${readFileSync(config, "utf8")}\n[filter "fixture"]\n\tclean = touch ${marker}\n`,
				);
				const run = await sandboxedTest(
					"mkdir sub && cp -R payload sub/.git && printf 'app.txt filter=fixture\\n' > sub/.gitattributes && printf nested > sub/app.txt",
					task.workspace.path,
					signal,
				);
				assert.equal(run.exitCode, 0);
				return result;
			},
		);
		try {
			const task = await manager.wait(
				manager.dispatch({
					parent: "fixture",
					role: defaultRoles().find((r) => r.name === "builder")!,
					provider: "openai-codex",
					model: "fixture",
					brief: "Fixture task",
				}).id,
			);
			assert.equal(task.status, "failed", "Nested repository completion must be refused");
			assert.match(inspectWorkspace(task.workspace).join(" "), /nested repository/i);
			assert.equal(existsSync(join(directory, "sandbox-nested-marker")), false);
		} finally {
			await manager.close();
		}
	},
);
