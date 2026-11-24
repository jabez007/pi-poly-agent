import assert from "node:assert/strict";
import fs from "node:fs";
import { readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import promises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { diffTool, scopedTools } from "../src/orchestration/tools.ts";
import { ReviewBudgetError } from "../src/orchestration/errors.ts";
import { createWorkspace } from "../src/orchestration/worktrees.ts";
import { temporaryRepository } from "./fixtures/review-project.ts";

const refusal = "Worker path is outside approved source context";
function fixture(t: TestContext, content = "alpha beta gamma") {
	const { root, directory } = temporaryRepository();
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const workspace = createWorkspace(root, directory, "diagnostics");
	writeFileSync(join(workspace.path, "app.txt"), content);
	return {
		...workspace,
		tool: (name: string) => scopedTools(workspace.path, true).find((tool) => tool.name === name)!,
	};
}
function diagnostic(expected: string, root: string) {
	return (error: Error) => {
		assert.equal(error.message, expected, "Keep Pi's actionable diagnostic with a relative path");
		for (const privatePath of [root, realpathSync(root), homedir()])
			assert.ok(!error.message.includes(privatePath), "Worker messages must omit host paths");
		return true;
	};
}
async function intercept(
	method: "access" | "readFile",
	file: string,
	operation: () => never,
	run: () => Promise<unknown>,
) {
	const original = promises[method];
	(promises as any)[method] = (path: string, ...args: any[]) => {
		if (path === file) operation();
		return (original as any)(path, ...args);
	};
	syncBuiltinESMExports();
	try {
		await run();
	} finally {
		(promises as any)[method] = original;
		syncBuiltinESMExports();
	}
}

const edits = [
	{
		name: "missing exact text",
		content: "alpha beta gamma",
		edits: [{ oldText: "absent", newText: "replacement" }],
		message:
			"Could not find the exact text in app.txt. The old text must match exactly including all whitespace and newlines.",
	},
	{
		name: "duplicate text",
		content: "alpha alpha",
		edits: [{ oldText: "alpha", newText: "replacement" }],
		message:
			"Found 2 occurrences of the text in app.txt. The text must be unique. Please provide more context to make it unique.",
	},
	{
		name: "unchanged replacement",
		content: "alpha beta gamma",
		edits: [{ oldText: "alpha", newText: "alpha" }],
		message:
			"No changes made to app.txt. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.",
	},
	{
		name: "overlapping replacements",
		content: "alpha beta gamma",
		edits: [
			{ oldText: "alpha beta", newText: "replacement" },
			{ oldText: "beta gamma", newText: "replacement" },
		],
		message:
			"edits[0] and edits[1] overlap in app.txt. Merge them into one edit or target disjoint regions.",
	},
];
for (const example of edits) {
	test(`edit retains Pi's ${example.name} diagnostic with a relative path`, async (t) => {
		const workspace = fixture(t, example.content);
		await assert.rejects(
			workspace
				.tool("edit")
				.execute(
					"fixture",
					{ path: "./app.txt", edits: example.edits },
					undefined,
					undefined,
					{} as any,
				),
			diagnostic(example.message, workspace.path),
		);
		assert.equal(readFileSync(join(workspace.path, "app.txt"), "utf8"), example.content);
	});
}

test("read retains Pi's offset-past-EOF diagnostic", async (t) => {
	const workspace = fixture(t, "first\nsecond");
	await assert.rejects(
		workspace
			.tool("read")
			.execute("fixture", { path: "app.txt", offset: 5 }, undefined, undefined, {} as any),
		diagnostic("Offset 5 is beyond end of file (2 lines total)", workspace.path),
	);
});

test("edit retains Pi's invalid-input diagnostic", async (t) => {
	const workspace = fixture(t);
	await assert.rejects(
		workspace
			.tool("edit")
			.execute("fixture", { path: "app.txt", edits: [] }, undefined, undefined, {} as any),
		diagnostic(
			"Edit tool input is invalid. edits must contain at least one replacement.",
			workspace.path,
		),
	);
});

for (const name of ["read", "write", "edit"]) {
	test(`${name} retains Pi's abort diagnostic without changing source`, async (t) => {
		const workspace = fixture(t);
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(
			workspace.tool(name).execute(
				"fixture",
				{
					path: "app.txt",
					content: "replacement",
					edits: [{ oldText: "alpha", newText: "replacement" }],
				},
				controller.signal,
				undefined,
				{} as any,
			),
			diagnostic("Operation aborted", workspace.path),
		);
		assert.equal(readFileSync(join(workspace.path, "app.txt"), "utf8"), "alpha beta gamma");
	});
}

test("edit reports Pi's relative-path diagnostic when the checked file disappears", async (t) => {
	const workspace = fixture(t);
	const file = join(workspace.path, "app.txt");
	const access = promises.access;
	promises.access = (async (path, mode) => {
		if (path === file) rmSync(file);
		return access(path, mode);
	}) as typeof access;
	syncBuiltinESMExports();
	try {
		await assert.rejects(
			workspace
				.tool("edit")
				.execute(
					"fixture",
					{ path: "app.txt", edits: edits[0].edits },
					undefined,
					undefined,
					{} as any,
				),
			diagnostic("Could not edit file: app.txt. Error code: ENOENT.", workspace.path),
		);
	} finally {
		promises.access = access;
		syncBuiltinESMExports();
	}
});

test("file-tool diagnostics rewrite every checked-path and root occurrence", async (t) => {
	const workspace = fixture(t);
	const file = join(workspace.path, "app.txt");
	await intercept(
		"readFile",
		file,
		() => {
			throw new Error(
				`Fixture: ${file}; ${file}; ${workspace.path}/; ${realpathSync(workspace.path)}/`,
			);
		},
		async () => {
			await assert.rejects(
				workspace
					.tool("edit")
					.execute(
						"fixture",
						{ path: file, edits: edits[0].edits },
						undefined,
						undefined,
						{} as any,
					),
				diagnostic("Fixture: app.txt; app.txt; ./; ./", workspace.path),
			);
		},
	);
});

test("file-tool diagnostics rewrite distinct lexical and canonical worktree roots", async (t) => {
	const workspace = fixture(t);
	const cwd = `${workspace.path}/.`;
	const file = join(workspace.path, "app.txt");
	assert.notEqual(cwd, realpathSync(cwd));
	await intercept(
		"readFile",
		file,
		() => {
			throw new Error(`Fixture: ${cwd}/; ${realpathSync(cwd)}/; ${file}`);
		},
		async () => {
			await assert.rejects(
				scopedTools(cwd, true)[2].execute(
					"fixture",
					{ path: "app.txt", edits: edits[0].edits },
					undefined,
					undefined,
					{} as any,
				),
				diagnostic("Fixture: ./; ./; app.txt", cwd),
			);
		},
	);
});

test("review_diff retains validated local budget diagnostics with a code property", async (t) => {
	const workspace = fixture(t);
	const read = fs.readSync;
	fs.readSync = (() => {
		throw new ReviewBudgetError(50001, 48000);
	}) as typeof read;
	syncBuiltinESMExports();
	try {
		await assert.rejects(
			diffTool(workspace.path, workspace.base).execute(
				"fixture",
				{ path: "." },
				undefined,
				undefined,
				{} as any,
			),
			(error: Error) => {
				assert.ok(error instanceof ReviewBudgetError);
				assert.equal(error.required, 50001);
				assert.equal(error.budget, 48000);
				return true;
			},
		);
	} finally {
		fs.readSync = read;
		syncBuiltinESMExports();
	}
});

test("review_diff native code-only errors retain the fixed refusal", async (t) => {
	const workspace = fixture(t);
	const read = fs.readSync;
	fs.readSync = (() => {
		throw Object.assign(new Error("Fixture native failure"), { code: "EIO" });
	}) as typeof read;
	syncBuiltinESMExports();
	try {
		await assert.rejects(
			diffTool(workspace.path, workspace.base).execute(
				"fixture",
				{ path: "." },
				undefined,
				undefined,
				{} as any,
			),
			diagnostic(refusal, workspace.path),
		);
	} finally {
		fs.readSync = read;
		syncBuiltinESMExports();
	}
});

for (const property of ["code", "syscall", "path"]) {
	test(`file-tool errors with a native ${property} property retain the fixed refusal`, async (t) => {
		const workspace = fixture(t);
		await intercept(
			"readFile",
			join(workspace.path, "app.txt"),
			() => {
				throw Object.assign(new Error("Fixture native failure"), { [property]: "fixture" });
			},
			async () => {
				await assert.rejects(
					workspace
						.tool("edit")
						.execute(
							"fixture",
							{ path: "app.txt", edits: edits[0].edits },
							undefined,
							undefined,
							{} as any,
						),
					diagnostic(refusal, workspace.path),
				);
			},
		);
	});
}

for (const privatePath of ["root", "HOME"]) {
	test(`file-tool diagnostics fail closed on an unrewritten ${privatePath} path`, async (t) => {
		const workspace = fixture(t);
		const hidden = privatePath === "root" ? `${workspace.path}-unrecognized` : homedir();
		await intercept(
			"readFile",
			join(workspace.path, "app.txt"),
			() => {
				throw new Error(`Fixture failure at ${hidden}`);
			},
			async () => {
				await assert.rejects(
					workspace
						.tool("edit")
						.execute(
							"fixture",
							{ path: "app.txt", edits: edits[0].edits },
							undefined,
							undefined,
							{} as any,
						),
					diagnostic(refusal, workspace.path),
				);
			},
		);
	});
}
