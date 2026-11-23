import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { scopedTools } from "../src/orchestration/tools.ts";

for (const variant of ["at", "tilde-file", "tilde-root", "file-url", "unicode-space"]) {
	for (const operation of ["read", "write", "edit"]) {
		test(`real worker ${operation} refuses ${variant} path reinterpretation`, async () => {
			const root = mkdtempSync(join(tmpdir(), "poly-path-check-"));
			const worktree = join(root, "worktree"),
				outside = join(root, "outside"),
				home = join(root, "fixture-home");
			for (const path of [worktree, outside, home]) mkdirSync(path);
			const oldHome = process.env.HOME;
			const selectedHome = variant === "tilde-root" ? join(home, "controlled-file") : home;
			process.env.HOME = selectedHome;
			try {
				const target =
					variant === "tilde-root"
						? selectedHome
						: variant.startsWith("tilde")
							? join(home, "x")
							: join(outside, "x");
				writeFileSync(target, "outside fixture content\n");
				symlinkSync(outside, join(worktree, "with space"));
				const paths: Record<string, string> = {
					at: `@${target}`,
					"tilde-file": "~/x",
					"tilde-root": "~",
					"file-url": `file://${target}`,
					"unicode-space": "with\u00a0space/x",
				};
				const tool = scopedTools(worktree, true).find((t) => t.name === operation)!;
				let refusal = "",
					result: unknown;
				try {
					result = await tool.execute(
						"fixture",
						{
							path: paths[variant],
							content: "changed\n",
							edits: [{ oldText: "outside fixture content", newText: "changed" }],
						},
						undefined,
						undefined,
						{} as any,
					);
				} catch (error) {
					refusal = String(error);
				}
				assert.equal(readFileSync(target, "utf8"), "outside fixture content\n");
				assert.ok(
					!JSON.stringify(result)?.includes("outside fixture content"),
					"Outside content must not be returned",
				);
				assert.match(
					refusal,
					/Worker path shorthand or Unicode space normalization refused/,
					"Refusal must come from the path boundary, not invalid tool input",
				);
				if (operation === "write" && variant !== "tilde-root") {
					const missing = paths[variant].replace(/x$/, "new-file");
					await assert.rejects(
						tool.execute(
							"fixture",
							{ path: missing, content: "created" },
							undefined,
							undefined,
							{} as any,
						),
					);
					assert.equal(existsSync(join(outside, "new-file")), false);
					assert.equal(existsSync(join(home, "new-file")), false);
				}
			} finally {
				if (oldHome === undefined) delete process.env.HOME;
				else process.env.HOME = oldHome;
			}
		});
	}
}
