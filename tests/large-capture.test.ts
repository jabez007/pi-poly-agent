import assert from "node:assert/strict";
import { execFileSync, execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { TaskManager } from "../src/orchestration/tasks.ts";
import { defaultPolicy } from "../src/policy.ts";
import { defaultRoles } from "../src/orchestration/roles.ts";
import { diffTool } from "../src/orchestration/tools.ts";
import {
	createWorkspace,
	cleanupWorkspace,
	snapshotWorkspace,
	git,
} from "../src/orchestration/worktrees.ts";
import { reviewDiffView } from "../src/orchestration/review-view.ts";
import { nestedRepository } from "./fixtures/nested-repository.ts";
import { reviewedProject, temporaryRepository } from "./fixtures/review-project.ts";

const result = { summary: "Done", files: [], tests: [], findings: [], questions: [] };
const input = {
	parent: "fixture",
	role: defaultRoles().find((r) => r.name === "builder")!,
	provider: "openai-codex",
	model: "fixture",
	brief: "Capture a large fixture",
};
const binary = Buffer.alloc(3 * 1024 * 1024, 1);
binary[0] = 0;
const text = "ordinary source line\n".repeat(125000);

for (const [file, content] of [
	["asset.png", binary],
	["large.txt", text],
] as const) {
	test(`multi-megabyte ${file} completes reviews and renders bounded task views`, async () => {
		let host: Awaited<ReturnType<typeof reviewedProject>> | undefined;
		let failure: unknown;
		try {
			host = await reviewedProject((task) =>
				writeFileSync(join(task.workspace.path, file), content),
			);
		} catch (error) {
			failure = error;
		}
		assert.equal(
			failure,
			undefined,
			"Multi-megabyte changes must complete and start independent review",
		);
		try {
			assert.equal(host!.builder.status, "completed");
			if (file === "asset.png")
				assert.match(
					git(host!.builder.workspace.path, [
						"diff",
						"--numstat",
						host!.builder.workspace.base,
						host!.builder.revision!,
						"--",
						file,
					]),
					/^-\t-\tasset\.png$/,
					"The large binary fixture must be classified as binary by Git without --text",
				);
			const review = host!.completed.find((t) => t.reviewOf === host!.builder.id)!;
			const output = await diffTool(review.workspace.path, review.reviewBase!).execute(
				"fixture",
				{ path: file },
				undefined,
				undefined,
				{} as any,
			);
			await host!.commands.get("task").handler(`${host!.builder.id} diff`, host!.ctx);
			await host!.commands.get("task").handler(`${host!.builder.id} integrate`, host!.ctx);
			const views = [
				host!.builder.artifacts!.find((a) => a.kind === "diff")!.content,
				(output.content[0] as any).text,
				host!.notices.find((n) => n.includes("Review findings:"))!.split("\n\nReview findings:")[0],
			];
			for (const view of views) {
				assert.ok(view.length <= 48000, "Every patch view must respect its whole-output budget");
				if (file === "asset.png")
					assert.match(
						view,
						/asset\.png.*Git reports binary; added\/removed line counts unavailable/,
					);
				else assert.match(view, new RegExp(`${file.replace(".", "\\.")}.*\\+\\d+.*-0`));
				assert.ok(
					view.includes(host!.builder.workspace.base) && view.includes(host!.builder.revision!),
				);
				assert.match(view, /git .*diff/);
			}
			assert.ok(
				host!.notices.some((n) => n === views[0]),
				"Task diff uses the same bounded artifact view",
			);
		} finally {
			await host!.close();
		}
	});
	test(`multi-megabyte ${file} recovers a failed task without buffering the patch`, async () => {
		const { root, directory } = temporaryRepository();
		let fail = true;
		const manager = new TaskManager(
			join(directory, "tasks"),
			root,
			defaultPolicy,
			async ({ task }) => {
				writeFileSync(join(task.workspace.path, file), content);
				if (fail) throw new Error("Fixture interruption");
				return result;
			},
		);
		try {
			const original = await manager.wait(manager.dispatch(input).id);
			fail = false;
			let replacement;
			assert.doesNotThrow(() => {
				replacement = manager.dispatch({ ...input, replacementOf: original.id });
			}, "Recovery must not depend on a full-patch capture buffer");
			assert.equal((await manager.wait(replacement!.id)).status, "completed");
		} finally {
			await manager.close();
		}
	});
}

for (const position of [
	"end",
	"chunk boundary",
	"unbounded whitespace",
	"long private label",
	"long URL",
]) {
	test(`full patch secret screening catches ${position} beyond the view budget`, async () => {
		const { root, directory } = temporaryRepository();
		const manager = new TaskManager(
			join(directory, "tasks"),
			root,
			defaultPolicy,
			async ({ task }) => {
				let secret = 'api_key="fixture-not-a-real-secret"';
				if (position === "unbounded whitespace")
					secret = "api_key" + " ".repeat(20 * 1024 * 1024) + "= fixture";
				if (position === "long private label")
					secret = "-----BEGIN " + "LABEL ".repeat(30000) + "PRIVATE KEY";
				if (position === "long URL")
					secret = "https://" + "u".repeat(150000) + ":fixture@host.invalid";
				const prefix = "x".repeat(3 * 1024 * 1024);
				const path = join(task.workspace.path, "large.txt");
				writeFileSync(path, prefix + "\n");
				if (position === "chunk boundary") {
					git(task.workspace.path, ["add", "-N", "."]);
					const header = execFileSync(
						"git",
						[
							"-c",
							"core.fsmonitor=false",
							"diff",
							"--text",
							"--no-ext-diff",
							"--no-textconv",
							task.workspace.base,
							"--",
							"large.txt",
						],
						{ cwd: task.workspace.path, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
					).indexOf("+xxx");
					const offset = 65536 - header - 4;
					writeFileSync(path, prefix.slice(0, offset) + secret + prefix.slice(offset) + "\n");
				} else writeFileSync(path, prefix + "\n" + secret + "\n");
				return result;
			},
		);
		try {
			const task = await manager.wait(manager.dispatch(input).id);
			assert.equal(
				task.failureCode,
				"output",
				"Full content must fail for sensitive output, never patch capture size",
			);
			assert.ok(!JSON.stringify(task).includes("fixture-not-a-real-secret"));
		} finally {
			await manager.close();
		}
	});
}

test("streamed review capture refuses nested repositories before Git", () => {
	const { root, directory } = temporaryRepository();
	const workspace = createWorkspace(root, directory, "fixture");
	nestedRepository(root, workspace.path, directory, "directory");
	assert.throws(
		() => reviewDiffView(workspace.path, workspace.base, workspace.base),
		/nested repository.*inspect.*manually/i,
	);
});

test("remaining metadata capture limits report a lower bound and manual recovery", () => {
	const { root, directory } = temporaryRepository();
	const workspace = createWorkspace(root, directory, "fixture");
	writeFileSync(join(workspace.path, "large.txt"), binary);
	const revision = snapshotWorkspace(workspace);
	assert.throws(
		() => git(root, ["show", `${revision}:large.txt`]),
		/Git metadata output is more than the 2097152 byte limit.*manually/,
		"A metadata size rejection must never become diagnostics withheld",
	);
});

test("review inspection commands and single headers survive worktree cleanup", () => {
	const { root, directory } = temporaryRepository();
	const workspace = createWorkspace(root, directory, "fixture");
	writeFileSync(join(workspace.path, "large.txt"), "source line\n".repeat(7000));
	const revision = snapshotWorkspace(workspace);
	const view = reviewDiffView(workspace.path, workspace.base, revision, [], 6000);
	const command = view.split("\n").at(-1)!;
	cleanupWorkspace(workspace);
	let failure: unknown;
	let full = "";
	try {
		full = execSync(command, {
			cwd: root,
			encoding: "utf8",
			env: Object.fromEntries(
				Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
			),
		});
	} catch (error) {
		failure = error;
	}
	assert.equal(failure, undefined, "Full inspection commands must remain usable after cleanup");
	assert.ok(full.length > 70000);
	assert.equal(view.split("Review diff:").length - 1, 1);
});
