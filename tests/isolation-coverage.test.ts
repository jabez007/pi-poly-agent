import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";

test(
	"historical worker isolation cases all reach the path protection boundary",
	{ skip: process.env.PI_POLY_HISTORICAL_TEST !== "1", timeout: 45000 },
	() => {
		const root = mkdtempSync(join(tmpdir(), "poly-historical-isolation-"));
		const env = Object.fromEntries(
			Object.entries(process.env).filter(
				([key]) => !key.startsWith("GIT_") && !key.startsWith("NODE_TEST_"),
			),
		);
		const files = execFileSync("git", ["ls-tree", "-rz", "--name-only", "525ec19", "src"], {
			env,
			encoding: "utf8",
		})
			.split("\0")
			.filter(Boolean);
		for (const file of files) {
			const target = join(root, file);
			mkdirSync(dirname(target), { recursive: true });
			writeFileSync(target, execFileSync("git", ["show", `525ec19:${file}`], { env }));
		}
		mkdirSync(join(root, "tests"));
		for (const name of ["isolate.mjs", "worker-isolation.test.ts"])
			cpSync(resolve("tests", name), join(root, "tests", name));
		writeFileSync(join(root, "package.json"), '{"type":"module"}');
		symlinkSync(resolve("node_modules"), join(root, "node_modules"));
		const run = spawnSync(
			process.execPath,
			[
				"--import",
				"./tests/isolate.mjs",
				"--import",
				"tsx",
				"--test",
				"tests/worker-isolation.test.ts",
			],
			{ cwd: root, env, encoding: "utf8", timeout: 30000, maxBuffer: 2000000 },
		);
		writeFileSync(join(root, "historical-run.tap"), run.stdout);
		writeFileSync(join(root, "historical-run.stderr"), run.stderr);
		console.log(`Historical source 525ec19 evidence: ${join(root, "historical-run.tap")}`);
		const total = Number(/^# tests (\d+)/m.exec(run.stdout)?.[1]);
		const passed = Number(/^# pass (\d+)/m.exec(run.stdout)?.[1]);
		const failed = Number(/^# fail (\d+)/m.exec(run.stdout)?.[1]);
		assert.ok(total >= 15, "Every negative path case must execute against the original source");
		assert.equal(
			passed,
			0,
			"No negative path case may pass on the original unprotected implementation",
		);
		assert.equal(failed, total);
		assert.doesNotMatch(
			run.stdout,
			/Edit tool input is invalid|EISDIR/,
			"Historical failures must reach file access, not invalid input or directory semantics",
		);
	},
);
