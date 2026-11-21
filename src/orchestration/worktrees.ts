import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { assertSafeProfile } from "../profile.ts";

export function git(cwd: string, args: string[]): string {
	const env = Object.fromEntries(
		Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
	);
	try {
		return execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
			cwd,
			env,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			maxBuffer: 2 * 1024 * 1024,
			timeout: 15000,
		}).trim();
	} catch {
		throw new Error("Git operation failed; diagnostics withheld");
	}
}
export interface Workspace {
	path: string;
	branch: string;
	base: string;
	root: string;
}
export function createWorkspace(
	cwd: string,
	directory: string,
	id: string,
	ref = "HEAD",
): Workspace {
	const root = git(cwd, ["rev-parse", "--show-toplevel"]);
	if (git(root, ["status", "--porcelain"]))
		throw new Error("Commit or stash project changes before delegation; nothing was changed");
	const base = git(root, ["rev-parse", "--verify", `${ref}^{commit}`]);
	const path = resolve(directory, id, "worktree");
	assertSafeProfile(path);
	if (existsSync(path)) throw new Error("Task worktree already exists");
	mkdirSync(resolve(directory, id), { recursive: true, mode: 0o700 });
	const branch = `poly/task-${id}`;
	git(root, ["worktree", "add", "-b", branch, path, base]);
	return { root, path: realpathSync(path), branch, base };
}
export function workspaceDiff(workspace: Workspace): { files: string[]; diff: string } {
	// Include untracked source in the review snapshot, without committing or staging it in the user's tree.
	git(workspace.path, ["add", "-N", "--", "."]);
	const files = git(workspace.path, ["diff", "--name-only", workspace.base])
		.split("\n")
		.filter(Boolean);
	const diff = git(workspace.path, ["diff", "--no-ext-diff", "--no-textconv", workspace.base]);
	return { files, diff };
}
export function snapshotWorkspace(workspace: Workspace): string {
	git(workspace.path, ["add", "--all"]);
	const args = [
		"-c",
		"user.name=Pi Poly Agent",
		"-c",
		"user.email=pi-poly-agent@localhost",
		"-c",
		"commit.gpgsign=false",
		"commit",
		"--allow-empty",
		"-m",
		"Capture delegated task for independent review",
	];
	git(workspace.path, args);
	return git(workspace.path, ["rev-parse", "HEAD"]);
}
export function cleanupWorkspace(workspace: Workspace): void {
	if (git(workspace.path, ["status", "--porcelain"]))
		throw new Error("Worktree has changes; cleanup refused");
	git(workspace.root, ["worktree", "remove", workspace.path]);
	// Preserve branches and commits; never force removal.
}
export function integrateWorkspace(workspace: Workspace, revision: string): void {
	if (git(workspace.root, ["status", "--porcelain"]))
		throw new Error("Integration requires a clean parent tree");
	if (git(workspace.root, ["rev-parse", "HEAD"]) !== workspace.base)
		throw new Error("Parent moved since delegation; integrate manually");
	if (!/^[a-f0-9]{40,64}$/.test(revision)) throw new Error("Invalid task revision");
	git(workspace.root, ["cherry-pick", revision]);
}
