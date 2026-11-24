import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { diffTool, scopedTools } from "../src/orchestration/tools.ts";
import { createWorkspace } from "../src/orchestration/worktrees.ts";
import { temporaryRepository } from "./fixtures/review-project.ts";

const pathRefusal = "Worker path is outside approved source context";
const permissionSkip =
	process.getuid?.() === 0 ? "mode-000 unreadability cannot be tested as root" : false;
function fixture() {
	const { root, directory } = temporaryRepository();
	return createWorkspace(root, directory, "fixture");
}
function refusal(message: string, root: string) {
	return (error: Error) => {
		assert.equal(error.message, message, "Worker filesystem failures must use the fixed refusal");
		assert.ok(
			!error.message.includes(root),
			"Worker errors must not contain the absolute worktree path",
		);
		return true;
	};
}

for (const toolName of ["read", "review_diff"]) {
	for (const kind of ["symlink loop", "mode-000 directory", "overlong name"]) {
		test(
			`${toolName} redacts filesystem errors from a ${kind}`,
			{ skip: kind === "mode-000 directory" && permissionSkip },
			async () => {
				const workspace = fixture();
				let path: string;
				if (kind === "symlink loop") {
					symlinkSync("loop", join(workspace.path, "loop"));
					path = "loop/child.txt";
				} else if (kind === "mode-000 directory") {
					mkdirSync(join(workspace.path, "locked"));
					writeFileSync(join(workspace.path, "locked/child.txt"), "fixture\n");
					chmodSync(join(workspace.path, "locked"), 0);
					path = "locked/child.txt";
				} else path = "x".repeat(300);
				try {
					const tool =
						toolName === "read"
							? scopedTools(workspace.path, false)[0]
							: diffTool(workspace.path, workspace.base);
					await assert.rejects(
						tool.execute("fixture", { path }, undefined, undefined, {} as any),
						refusal(pathRefusal, workspace.path),
					);
				} finally {
					if (kind === "mode-000 directory") chmodSync(join(workspace.path, "locked"), 0o700);
				}
			},
		);
	}
}

test("read refuses a missing file without a host-path diagnostic", async () => {
	const workspace = fixture();
	const tool = scopedTools(workspace.path, false)[0];
	await assert.rejects(
		tool.execute("fixture", { path: "missing.txt" }, undefined, undefined, {} as any),
		refusal(pathRefusal, workspace.path),
	);
	const output = await tool.execute(
		"fixture",
		{ path: "app.txt" },
		undefined,
		undefined,
		{} as any,
	);
	assert.equal((output.content[0] as any).text, "before\n");
});

test(
	"read redacts failures opening an existing mode-000 file",
	{ skip: permissionSkip },
	async () => {
		const workspace = fixture();
		const file = join(workspace.path, "locked.txt");
		writeFileSync(file, "fixture\n");
		chmodSync(file, 0);
		try {
			await assert.rejects(
				scopedTools(workspace.path, false)[0].execute(
					"fixture",
					{ path: "locked.txt" },
					undefined,
					undefined,
					{} as any,
				),
				refusal(pathRefusal, workspace.path),
			);
		} finally {
			chmodSync(file, 0o600);
		}
	},
);

test("read redacts a missing worktree root during canonicalization", async () => {
	const workspace = fixture();
	const tool = scopedTools(workspace.path, false)[0];
	rmSync(workspace.path, { recursive: true });
	await assert.rejects(
		tool.execute("fixture", { path: "app.txt" }, undefined, undefined, {} as any),
		refusal(pathRefusal, workspace.path),
	);
});

test(
	"review_diff refuses an unreadable walk without a host-path diagnostic",
	{ skip: permissionSkip },
	async () => {
		const workspace = fixture();
		const locked = join(workspace.path, "locked");
		mkdirSync(locked);
		chmodSync(locked, 0);
		try {
			await assert.rejects(
				diffTool(workspace.path, workspace.base).execute(
					"fixture",
					{ path: "app.txt" },
					undefined,
					undefined,
					{} as any,
				),
				refusal(
					"Worktree contains a nested repository; inspect the worktree manually",
					workspace.path,
				),
			);
		} finally {
			chmodSync(locked, 0o700);
		}
	},
);

test("review_diff redacts a native capture failure and retains policy diagnostics", async () => {
	const workspace = fixture();
	const tool = diffTool(workspace.path, workspace.base);
	const read = fs.readSync;
	fs.readSync = (() => {
		throw Object.assign(new Error(`Fixture I/O failure at ${workspace.path}`), {
			syscall: "read",
			code: "EIO",
			path: workspace.path,
		});
	}) as any;
	syncBuiltinESMExports();
	try {
		await assert.rejects(
			tool.execute("fixture", { path: "app.txt" }, undefined, undefined, {} as any),
			refusal(pathRefusal, workspace.path),
		);
	} finally {
		fs.readSync = read;
		syncBuiltinESMExports();
	}
	await assert.rejects(
		tool.execute("fixture", { path: ".", offset: -1 }, undefined, undefined, {} as any),
		/Invalid review file offset/,
	);
});
