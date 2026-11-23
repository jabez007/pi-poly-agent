import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { execSync } from "node:child_process";
import { diffTool } from "../src/orchestration/tools.ts";
import { taskPrompt } from "../src/orchestration/runner.ts";
import { TaskManager } from "../src/orchestration/tasks.ts";
import { defaultPolicy } from "../src/policy.ts";
import { defaultRoles } from "../src/orchestration/roles.ts";
import { reviewedProject, temporaryRepository } from "./fixtures/review-project.ts";

for (const [name, character, escape] of [
	["form feed", "\u000c", "\\u000c"],
	["ESC", "\u001b", "\\u001b"],
	["NUL", "\u0000", "\\u0000"],
	["bidi override", "\u202e", "\\u202e"],
]) {
	test(`review paths keep logic changes visible beside ${name}`, async () => {
		const host = await reviewedProject((task) =>
			writeFileSync(join(task.workspace.path, "app.txt"), `// comment ${character}\nlogic=42\n`),
		);
		try {
			const review = host.completed.find((t) => t.reviewOf === host.builder.id)!;
			const output = await diffTool(review.workspace.path, review.reviewBase!).execute(
				"fixture",
				{ path: "app.txt" },
				undefined,
				undefined,
				{} as any,
			);
			await host.commands.get("task").handler(`${host.builder.id} integrate`, host.ctx);
			const previews = [
				host.builder.artifacts!.find((a) => a.kind === "diff")!.content,
				(output.content[0] as any).text,
				host.notices.find((n) => n.includes("Review findings:"))!,
			];
			for (const view of previews) {
				assert.match(view, /\+logic=42/, "Every review path must retain the logic line");
				assert.ok(view.includes(escape), "Characters must have visible Unicode escapes");
				assert.ok(
					!view.includes(character),
					"Raw control or bidirectional characters must not be emitted",
				);
			}
		} finally {
			await host.close();
		}
	});
}

const large = "source line ".repeat(7) + "\n";
test("builder completion screens full diff content beyond the displayed patch", async () => {
	const { root, directory } = temporaryRepository();
	const manager = new TaskManager(
		join(directory, "tasks"),
		root,
		defaultPolicy,
		async ({ task }) => {
			writeFileSync(
				join(task.workspace.path, "large.txt"),
				large.repeat(900) + '\napi_key="fixture-not-a-real-secret"\n',
			);
			return { summary: "Done", files: [], tests: [], findings: [], questions: [] };
		},
	);
	try {
		const task = await manager.wait(
			manager.dispatch({
				parent: "fixture",
				role: defaultRoles().find((r) => r.name === "builder")!,
				provider: "openai-codex",
				model: "fixture",
				brief: "Screen the full fixture",
			}).id,
		);
		assert.equal(task.status, "failed");
		assert.equal(
			task.failureCode,
			"output",
			"Full source must be rejected as sensitive, not as an oversized diff",
		);
		assert.ok(!JSON.stringify(task).includes("fixture-not-a-real-secret"));
	} finally {
		await manager.close();
	}
});

test("large changes complete and bounded review paths identify every omitted file and revision", async () => {
	const host = await reviewedProject((task) => {
		writeFileSync(join(task.workspace.path, "app.txt"), "visible small change\n");
		for (const file of ["large-a.txt", "large-b.txt"])
			writeFileSync(join(task.workspace.path, file), large.repeat(900));
	});
	try {
		assert.equal(host.builder.status, "completed");
		assert.ok(host.builder.artifacts!.find((a) => a.kind === "diff")!.content.length > 70000);
		const review = host.completed.find((t) => t.reviewOf === host.builder.id)!;
		const output = await diffTool(review.workspace.path, review.reviewBase!).execute(
			"fixture",
			{ path: "large-a.txt" },
			undefined,
			undefined,
			{} as any,
		);
		await host.commands.get("task").handler(`${host.builder.id} integrate`, host.ctx);
		for (const text of [
			taskPrompt(review),
			host.notices.find((n) => n.includes("Review findings:"))!,
		]) {
			assert.match(text, /large-a\.txt.*\+900.*-0/);
			assert.match(text, /large-b\.txt.*\+900.*-0/);
			assert.ok(
				text.includes(host.builder.workspace.base) && text.includes(host.builder.revision!),
			);
			assert.match(text, /git .*diff/);
		}
		assert.match((output.content[0] as any).text, /large-a\.txt.*\+900.*-0/);
		const command = ((output.content[0] as any).text as string).split("\n").at(-1)!;
		const rest = execSync(command, {
			cwd: host.root,
			encoding: "utf8",
			env: Object.fromEntries(
				Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
			),
		});
		assert.ok(rest.length > 70000, "The displayed command must show the complete committed patch");
		assert.equal(readFileSync(join(host.root, "app.txt"), "utf8"), "before\n");
	} finally {
		await host.close();
	}
});

test("large failed changes can recover and full-diff scanning catches secrets beyond display limits", async () => {
	const { root, directory } = temporaryRepository();
	let fail = true;
	const result = { summary: "Done", files: [], tests: [], findings: [], questions: [] };
	const manager = new TaskManager(
		join(directory, "tasks"),
		root,
		defaultPolicy,
		async ({ task }) => {
			writeFileSync(join(task.workspace.path, "large.txt"), large.repeat(900));
			if (fail) throw new Error("Fixture interruption");
			return result;
		},
	);
	const input = {
		parent: "fixture",
		role: defaultRoles().find((r) => r.name === "builder")!,
		provider: "openai-codex",
		model: "fixture",
		brief: "Large fixture",
	};
	try {
		const original = await manager.wait(manager.dispatch(input).id);
		fail = false;
		const recovered = await manager.wait(
			manager.dispatch({ ...input, replacementOf: original.id }).id,
		);
		assert.equal(recovered.status, "completed");
		fail = true;
		const sensitive = await manager.wait(manager.dispatch(input).id);
		writeFileSync(
			join(sensitive.workspace.path, "large.txt"),
			large.repeat(900) + '\napi_key="fixture-not-a-real-secret"\n',
		);
		assert.throws(() => manager.dispatch({ ...input, replacementOf: sensitive.id }), /Sensitive/);
	} finally {
		await manager.close();
	}
});
