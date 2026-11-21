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
	parentBranch?: string;
}
export function createWorkspace(
	cwd: string,
	directory: string,
	id: string,
	ref = "HEAD",
	beforeCreate: (workspace: Workspace) => void = () => {},
): Workspace {
	const root = git(cwd, ["rev-parse", "--show-toplevel"]);
	const parentBranch = git(root, ["branch", "--show-current"]);
	if (!parentBranch)
		throw new Error(
			"Delegation requires a named parent branch. Switch to a branch before creating worktrees.",
		);
	if (git(root, ["status", "--porcelain"]))
		throw new Error("Commit or stash project changes before delegation; nothing was changed");
	const base = git(root, ["rev-parse", "--verify", `${ref}^{commit}`]);
	const path = resolve(directory, id, "worktree");
	assertSafeProfile(path);
	if (existsSync(path)) throw new Error("Task worktree already exists");
	mkdirSync(resolve(directory, id), { recursive: true, mode: 0o700 });
	const branch = `poly/task-${id}`;
	beforeCreate({ root, path, branch, base, parentBranch });
	git(root, ["worktree", "add", "-b", branch, path, base]);
	return { root, path: realpathSync(path), branch, base, parentBranch };
}
export function workspaceDiff(workspace: Workspace): { files: string[]; diff: string } {
	assertSafeProfile(workspace.path);
	if (!existsSync(workspace.path))
		throw new Error("Task worktree missing; inspect its retained branch manually");
	// Include untracked source in the review snapshot, without committing or staging it in the user's tree.
	git(workspace.path, ["add", "-N", "--", "."]);
	const files = git(workspace.path, ["diff", "--name-only", workspace.base])
		.split("\n")
		.filter(Boolean);
	const diff = git(workspace.path, ["diff", "--no-ext-diff", "--no-textconv", workspace.base]);
	return { files, diff };
}
export function snapshotWorkspace(workspace: Workspace): string {
	if (git(workspace.path, ["branch", "--show-current"]) !== workspace.branch)
		throw new Error("Task branch changed; snapshot refused");
	git(workspace.path, ["add", "--all"]);
	const tree = git(workspace.path, ["write-tree"]);
	// One reviewable commit includes every change against the original base, including recovered edits.
	const revision = git(workspace.path, [
		"-c",
		"user.name=Pi Poly Agent",
		"-c",
		"user.email=pi-poly-agent@localhost",
		"-c",
		"commit.gpgsign=false",
		"commit-tree",
		tree,
		"-p",
		workspace.base,
		"-m",
		"Capture delegated task for independent review",
	]);
	git(workspace.path, ["reset", "--soft", revision]);
	return revision;
}

export function cleanupWorkspace(workspace: Workspace): void {
	assertSafeProfile(workspace.path);
	if (!existsSync(workspace.path))
		throw new Error("Task worktree is missing; inspect its retained branch with Git worktree list");
	if (git(workspace.path, ["status", "--porcelain"]))
		throw new Error("Worktree has changes; cleanup refused");
	git(workspace.root, ["worktree", "remove", workspace.path]);
	// Preserve branches and commits; never force removal.
}
export function assertIntegration(workspace: Workspace, revision: string): void {
	if (!existsSync(workspace.path))
		throw new Error("Task worktree missing; inspect its retained branch");
	const branch = git(workspace.root, ["branch", "--show-current"]);
	if (!branch)
		throw new Error("Parent HEAD is detached; switch to the original branch before integration");
	if (workspace.parentBranch && branch !== workspace.parentBranch)
		throw new Error("Parent branch changed; integrate manually");
	for (const name of ["CHERRY_PICK_HEAD", "MERGE_HEAD", "rebase-merge", "rebase-apply"])
		if (existsSync(resolve(workspace.root, git(workspace.root, ["rev-parse", "--git-path", name]))))
			throw new Error("Parent Git operation is unfinished; inspect and resolve it manually");
	if (git(workspace.root, ["status", "--porcelain"]))
		throw new Error("Integration requires a clean parent tree");
	if (git(workspace.root, ["rev-parse", "HEAD"]) !== workspace.base)
		throw new Error("Parent moved since delegation; integrate manually");
	if (!/^[a-f0-9]{40,64}$/.test(revision)) throw new Error("Invalid task revision");
}
export function integrateWorkspace(workspace: Workspace, revision: string): void {
	assertIntegration(workspace, revision);
	git(workspace.root, ["cherry-pick", revision]);
}

export function inspectWorkspace(workspace: Workspace): string[] {
	if (!existsSync(workspace.path))
		return [
			"Worktree directory is missing. Inspect its retained task branch with Git or Lazygit; no automatic recreation attempted.",
		];
	try {
		const notes = [
			git(workspace.path, ["status", "--porcelain"])
				? "Uncommitted changes preserved. Inspect the diff before recovery or cleanup."
				: "Worktree is clean; committed changes and task branch are retained.",
		];
		if (git(workspace.path, ["branch", "--show-current"]) !== workspace.branch)
			notes.push("Task branch changed; inspect manually before recovery.");
		return notes;
	} catch {
		return ["Worktree Git metadata unavailable. Files retained for manual recovery."];
	}
}
