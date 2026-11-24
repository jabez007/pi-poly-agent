import { assertNoSecrets, secretScanner } from "../secrets.ts";
import { execFileSync } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	realpathSync,
	mkdtempSync,
	openSync,
	closeSync,
	readSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { StringDecoder } from "node:string_decoder";
import { isAbsolute, join, relative, resolve } from "node:path";
import { assertSafeProfile } from "../profile.ts";
import { reviewDiffView, reviewFileIndex } from "./review-view.ts";
import { gitMetadataName } from "./path-policy.ts";

const pinnedWorkspaces = new Map<string, Workspace>();
const taskDirectories = new Set<string>();
const metadataBufferLimit = 2 * 1024 * 1024;
const checkedReads = new Map<string, ReturnType<typeof freshGitInvocation>>();
const preparingWorkspaces = new Set<string>();

/** Internal lifetime of an explicitly approved preparation command, including approval waits. */
export function holdWorkspacePreparation(path: string): () => void {
	assertWorkspaceIdle(path);
	const root = resolve(path);
	preparingWorkspaces.add(root);
	return () => {
		preparingWorkspaces.delete(root);
	};
}

export function assertWorkspaceIdle(path: string): void {
	if ([...preparingWorkspaces].some((root) => containsPath(root, path)))
		throw new Error("Task preparation is active; wait for it to finish before this action");
}

function readonlyQuery(args: string[]): boolean {
	const command = args[0] === "--literal-pathspecs" ? 1 : 0;
	const rest = args.slice(command + 1);
	if (args[command] === "rev-parse")
		return (
			rest.length === 1 && ["HEAD", "--git-common-dir", "--absolute-git-dir"].includes(rest[0])
		);
	if (args[command] === "status") return rest.length === 1 && rest[0] === "--porcelain";
	if (args[command] !== "diff") return false;
	const end = rest.indexOf("--");
	return rest
		.slice(0, end < 0 ? rest.length : end)
		.every(
			(arg) =>
				[...reviewDiffOptions, "--numstat", "--raw", "-z", "--ignore-submodules=all"].includes(
					arg,
				) || /^[a-f0-9]{40,64}$/.test(arg),
		);
}

function synchronousRead<T>(operation: () => T): T {
	const result = operation();
	if (result && typeof (result as any).then === "function")
		throw new Error("Checked Git read scopes must stay synchronous");
	return result;
}

/** Internal scope for one synchronous, read-only view or source inspection. */
export function withCheckedGitRead<T>(cwd: string, operation: () => T): T {
	const key = resolve(cwd);
	if (checkedReads.has(key)) return synchronousRead(operation);
	checkedReads.set(key, gitInvocation(cwd, []));
	try {
		return synchronousRead(operation);
	} finally {
		checkedReads.delete(key);
	}
}

/** Internal registration from the task controller; never inferred from task-owned files. */
export function registerTaskDirectory(directory: string): void {
	taskDirectories.add(resolve(directory));
}
function containsPath(root: string, target: string): boolean {
	const path = relative(root, resolve(target));
	return !path || (!path.startsWith("..") && !isAbsolute(path));
}

function gitInvocation(cwd: string, args: string[]) {
	assertWorkspaceIdle(cwd);
	const key = resolve(cwd),
		checked = checkedReads.get(key);
	if (checked && readonlyQuery(args)) {
		// Worker tools are sequential and these scopes are synchronous and query-only. Every Git
		// entry rejects active preparation, including workflow reads. No owned writer overlaps a view.
		// This is not protection against unrelated host processes. Other Git commands invalidate it.
		return { ...checked, args: [...checked.args, ...submoduleSafeArgs(args, true)] };
	}
	checkedReads.delete(key);
	return freshGitInvocation(cwd, args);
}
function freshGitInvocation(cwd: string, args: string[]) {
	const workspace = [...pinnedWorkspaces.values()].find((w) => containsPath(w.path, cwd));
	if (!workspace && [...taskDirectories].some((directory) => containsPath(directory, cwd)))
		throw new Error("Unregistered task worktree has no pinned workspace; inspect manually");
	const location = workspace ? workspaceLocation(workspace) : [];
	const env = Object.fromEntries(
		Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
	);
	return {
		cwd,
		env,
		args: [
			"-c",
			"core.hooksPath=/dev/null",
			"-c",
			"core.fsmonitor=false",
			"-c",
			"diff.ignoreSubmodules=all",
			...location,
			...submoduleSafeArgs(args, !!workspace),
		],
	};
}
export function git(cwd: string, args: string[]): string {
	const invocation = gitInvocation(cwd, args);
	try {
		return execFileSync("git", invocation.args, {
			cwd: invocation.cwd,
			env: invocation.env,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			maxBuffer: metadataBufferLimit,
			timeout: 15000,
		}).trim();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOBUFS") {
			throw new Error(
				`Git metadata output is more than the ${metadataBufferLimit} byte limit; inspect the retained task branch manually`,
			);
		}
		throw new Error("Git operation failed; diagnostics withheld");
	}
}

/** Git writes directly to a private spool; callers never buffer an entire patch. */
export function readGitOutput(
	cwd: string,
	args: string[],
	consume: (chunk: string) => boolean | void,
	chunkSize = 65536,
): void {
	const invocation = gitInvocation(cwd, args);
	const directory = mkdtempSync(join(tmpdir(), "poly-git-output-"));
	const fd = openSync(join(directory, "output"), "wx+", 0o600);
	try {
		try {
			execFileSync("git", invocation.args, {
				cwd,
				env: invocation.env,
				stdio: ["ignore", fd, "ignore"],
				timeout: 15000,
			});
		} catch {
			throw new Error(
				"Git patch output failed; check available temporary storage and inspect the retained task branch manually",
			);
		}
		const buffer = Buffer.alloc(chunkSize),
			decoder = new StringDecoder("utf8");
		let offset = 0,
			count: number;
		while ((count = readSync(fd, buffer, 0, buffer.length, offset))) {
			offset += count;
			if (consume(decoder.write(buffer.subarray(0, count))) === false) return;
		}
		consume(decoder.end());
	} finally {
		closeSync(fd);
		rmSync(directory, { recursive: true, force: true });
	}
}
export function scanGitOutput(cwd: string, args: string[]): void {
	const scan = secretScanner();
	readGitOutput(cwd, args, scan);
}
export const reviewDiffOptions = [
	"--text",
	"--no-color",
	"--no-ext-diff",
	"--no-textconv",
	"--no-renames",
];

function submoduleSafeArgs(args: string[], task: boolean): string[] {
	const command = args[0] === "--literal-pathspecs" ? 1 : 0;
	if (!task || !["diff", "status"].includes(args[command])) return args;
	return [...args.slice(0, command + 1), "--ignore-submodules=all", ...args.slice(command + 1)];
}

const nestedRepositoryMessage =
	"Worktree contains a nested repository; inspect the worktree manually";
function refuseNestedRepositories(root: string, directory = root): void {
	try {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			if (gitMetadataName(entry.name)) {
				if (directory === root && entry.name === ".git") continue;
				throw new Error(nestedRepositoryMessage);
			}
			if (entry.isDirectory()) refuseNestedRepositories(root, join(directory, entry.name));
		}
	} catch {
		throw new Error(nestedRepositoryMessage);
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
function prepareWorkspace(workspace: Workspace): void {
	assertSafeProfile(workspace.path);
	if (!existsSync(workspace.path))
		throw new Error("Task worktree missing; inspect its retained branch manually");
	pinWorkspace(workspace);
	// Include untracked source in the review snapshot, without committing or staging it in the user's tree.
	git(workspace.path, ["add", "-N", "--", "."]);
}
function workspaceFiles(workspace: Workspace): string[] {
	return reviewFileIndex(workspace.path, [...reviewDiffOptions, workspace.base]).map(
		(record) => record.file,
	);
}
export function screenWorkspace(workspace: Workspace): string[] {
	prepareWorkspace(workspace);
	return withCheckedGitRead(workspace.path, () => {
		const files = workspaceFiles(workspace);
		scanGitOutput(workspace.path, ["diff", ...reviewDiffOptions, workspace.base]);
		return files;
	});
}
export function workspaceDiff(workspace: Workspace): { files: string[]; diff: string } {
	prepareWorkspace(workspace);
	return withCheckedGitRead(workspace.path, () => {
		const files = workspaceFiles(workspace);
		const revision = workspaceChanged(workspace.path)
			? ""
			: git(workspace.path, ["rev-parse", "HEAD"]);
		return { files, diff: reviewDiffView(workspace.path, workspace.base, revision) };
	});
}

function workspaceChanged(cwd: string): boolean {
	let changed = false;
	readGitOutput(cwd, ["status", "--porcelain"], (chunk) => {
		changed ||= !!chunk.trim();
		return !changed;
	});
	return changed;
}

export function controlFileNotice(files: string[]): string {
	const controls = files.filter((file) => /(^|\/)\.(gitattributes|gitmodules)$/.test(file));
	return controls.length
		? `Repository control files changed: ${controls.map((file) => escapeDiffText(JSON.stringify(file))).join(", ")}\n`
		: "";
}

/** Escape unsafe characters without dropping any source line. */
export function escapeDiffText(text: string): string {
	return text.replace(
		/[\\\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\u2800\u3164]/gu,
		(character) => {
			if (character === "\n") return "\n";
			const point = character.codePointAt(0)!;
			const hex = point.toString(16).padStart(4, "0");
			return point > 0xffff ? `\\u{${hex}}` : `\\u${hex}`;
		},
	);
}
export function renderReviewDiff(diff: string): string {
	assertNoSecrets(diff);
	return (
		"Review diff: controls, bidirectional and other invisible characters and backslashes use visible Unicode escapes.\n" +
		escapeDiffText(diff)
	);
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
	// Retained unavailable tasks must never fall back to repository discovery.
	pinnedWorkspaces.set(resolve(workspace.path), { ...workspace, gitDir: undefined });
	if (!existsSync(workspace.path))
		return [
			"Worktree directory is missing. Inspect its retained task branch with Git or Lazygit; no automatic recreation attempted.",
		];
	if (workspace.gitDir && !existsSync(workspace.gitDir))
		return [
			"Worktree Git metadata unavailable. Files and task history retained for manual inspection.",
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
