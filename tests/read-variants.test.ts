import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { scopedTools } from "../src/orchestration/tools.ts";

for (const [name, plain, variant] of [
	["AM-PM", "shot AM.d", "shot\u202fAM.d"],
	["NFD", "éx", "e\u0301x"],
	["curly quote", "a'b", "a’b"],
	["NFD and curly quote", "é'a", "e\u0301’a"],
]) {
	test(`real worker read refuses a missing path with a ${name} lookalike`, async () => {
		const root = mkdtempSync(join(tmpdir(), "poly-read-variant-")),
			worktree = join(root, "worktree"),
			outside = join(root, "outside");
		mkdirSync(worktree);
		mkdirSync(outside);
		writeFileSync(join(outside, "secret.txt"), "outside fixture content\n");
		symlinkSync(outside, join(worktree, variant));
		const read = scopedTools(worktree, false)[0];
		let result: unknown,
			refused = false;
		try {
			result = await read.execute(
				"fixture",
				{ path: `${plain}/secret.txt` },
				undefined,
				undefined,
				{} as any,
			);
		} catch {
			refused = true;
		}
		assert.ok(
			!JSON.stringify(result)?.includes("outside fixture content"),
			"Outside lookalike content must never be returned",
		);
		assert.equal(refused, true, "The checked missing path must fail before Pi fallback");
	});
}

test("real worker read preserves existing files and reports missing files", async () => {
	const root = mkdtempSync(join(tmpdir(), "poly-read-ordinary-"));
	writeFileSync(join(root, "app.txt"), "ordinary fixture\n");
	const read = scopedTools(root, false)[0];
	assert.match(
		JSON.stringify(
			await read.execute("fixture", { path: "app.txt" }, undefined, undefined, {} as any),
		),
		/ordinary fixture/,
	);
	await assert.rejects(
		read.execute("fixture", { path: "missing.txt" }, undefined, undefined, {} as any),
		/ENOENT|exist|missing/i,
	);
});
