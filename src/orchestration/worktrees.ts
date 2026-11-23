import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { assertSafeProfile } from "../profile.ts";

const pinnedWorkspaces = new Map<string, Workspace>();

export function git(cwd: string, args: string[]): string {
	const workspace = [...pinnedWorkspaces.values()].find((w) => {
		const path = relative(w.path, resolve(cwd));
		return !path || (!path.startsWith("..") && !isAbsolute(path));
	});
	const location = workspace ? workspaceLocation(workspace) : [];
	const env = Object.fromEntries(
		Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
	);
	try {
		return execFileSync(
			"git",
			[
				"-c",
				"core.hooksPath=/dev/null",
				"-c",
				"core.fsmonitor=false",
				"-c",
				"diff.ignoreSubmodules=all",
				...location,
				...submoduleSafeArgs(args, !!workspace),
			],
			{
				cwd,
				env,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
				maxBuffer: 2 * 1024 * 1024,
				timeout: 15000,
			},
		).trim();
	} catch {
		throw new Error("Git operation failed; diagnostics withheld");
	}
}

function submoduleSafeArgs(args: string[], task: boolean): string[] {
	const command = args[0] === "--literal-pathspecs" ? 1 : 0;
	if (!task || !["diff", "status"].includes(args[command])) return args;
	return [...args.slice(0, command + 1), "--ignore-submodules=all", ...args.slice(command + 1)];
}

const nestedRepositoryMessage =
	"Worktree contains a nested repository; inspect the worktree manually";
function refuseNestedRepositories(root: string, directory = root): void {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (entry.name === ".git") {
			if (directory === root) continue;
			throw new Error(nestedRepositoryMessage);
		}
		if (entry.isDirectory()) refuseNestedRepositories(root, join(directory, entry.name));
	}
}
export interface Workspace {
	path: string;
	branch: string;
	base: string;
	root: string;
	parentBranch?: string;
	gitDir?: string;
}

/** Derive task metadata from the parent repository, including for legacy task records. */
export function pinWorkspace(workspace: Workspace): void {
	const common = git(workspace.root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
	const directory = join(common, "worktrees");
	assertSafeProfile(directory);
	const matches = readdirSync(directory, { withFileTypes: true }).filter((entry) => {
		if (!entry.isDirectory()) return false;
		const file = join(directory, entry.name, "gitdir");
		assertSafeProfile(file);
		return readFileSync(file, "utf8").trim() === join(workspace.path, ".git");
	});
	if (matches.length !== 1) throw new Error("Worktree metadata unavailable; inspect manually");
	const gitDir = realpathSync(join(directory, matches[0].name));
	if (workspace.gitDir && workspace.gitDir !== gitDir)
		throw new Error("Worktree metadata changed; inspect manually");
	workspace.gitDir = gitDir;
	pinnedWorkspaces.set(resolve(workspace.path), { ...workspace });
}

function workspaceLocation(workspace: Workspace): string[] {
	try {
		const file = join(workspace.path, ".git");
		if (!lstatSync(file).isFile()) throw new Error();
		const match = /^gitdir: (.+)\n?$/.exec(readFileSync(file, "utf8"));
		if (!match || realpathSync(resolve(workspace.path, match[1])) !== workspace.gitDir)
			throw new Error();
	} catch {
		throw new Error("Worktree Git metadata changed or unavailable; inspect the worktree manually");
	}
	refuseNestedRepositories(workspace.path);
	return [`--git-dir=${workspace.gitDir}`, `--work-tree=${workspace.path}`];
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
	const workspace = { root, path: realpathSync(path), branch, base, parentBranch };
	pinWorkspace(workspace);
	return workspace;
}
export function workspaceDiff(workspace: Workspace): { files: string[]; diff: string } {
	assertSafeProfile(workspace.path);
	if (!existsSync(workspace.path))
		throw new Error("Task worktree missing; inspect its retained branch manually");
	pinWorkspace(workspace);
	// Include untracked source in the review snapshot, without committing or staging it in the user's tree.
	git(workspace.path, ["add", "-N", "--", "."]);
	const files = git(workspace.path, ["diff", "--name-only", workspace.base])
		.split("\n")
		.filter(Boolean);
	const diff =
		controlFileNotice(files) +
		renderReviewDiff(
			git(workspace.path, [
				"diff",
				"--text",
				"--no-color",
				"--no-ext-diff",
				"--no-textconv",
				workspace.base,
			]),
		);
	return { files, diff };
}

export function controlFileNotice(files: string[]): string {
	const controls = files.filter((file) => /(^|\/)\.(gitattributes|gitmodules)$/.test(file));
	return controls.length ? `Repository control files changed: ${controls.join(", ")}\n` : "";
}

/** Render forced text diffs without sending terminal control bytes or unbounded output. */
export function renderReviewDiff(diff: string): string {
	const rendered = diff
		.split(/(?=^diff --git )/m)
		.map((part) => {
			if (!/\p{Cc}/u.test(part.replace(/[\t\n\r]/g, ""))) return part;
			return `${part.split("\n")[0]}\nBinary or control-byte content changed; raw bytes omitted. Inspect this file separately.\n`;
		})
		.join("");
	if (rendered.length > 48000)
		throw new Error("Diff exceeds 48000 characters; inspect smaller files manually before review");
	return rendered;
}
export function snapshotWorkspace(workspace: Workspace): string {
	pinWorkspace(workspace);
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
	pinWorkspace(workspace);
	if (git(workspace.path, ["status", "--porcelain"]))
		throw new Error("Worktree has changes; cleanup refused");
	git(workspace.root, ["worktree", "remove", workspace.path]);
	// Preserve branches and commits; never force removal.
}
export function assertIntegration(workspace: Workspace, revision: string): void {
	if (!existsSync(workspace.path))
		throw new Error("Task worktree missing; inspect its retained branch");
	pinWorkspace(workspace);
	workspaceLocation(workspace);
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
		pinWorkspace(workspace);
		const notes = [
			git(workspace.path, ["status", "--porcelain"])
				? "Uncommitted changes preserved. Inspect the diff before recovery or cleanup."
				: "Worktree is clean; committed changes and task branch are retained.",
		];
		if (git(workspace.path, ["branch", "--show-current"]) !== workspace.branch)
			notes.push("Task branch changed; inspect manually before recovery.");
		return notes;
	} catch (error) {
		if (error instanceof Error && error.message === nestedRepositoryMessage) return [error.message];
		return [
			"Worktree Git metadata changed or unavailable. Inspect the worktree manually; files retained.",
		];
	}
}
