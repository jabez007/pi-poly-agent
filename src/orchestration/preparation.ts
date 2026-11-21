import {
	existsSync,
	mkdirSync,
	readdirSync,
	lstatSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	copyFileSync,
	symlinkSync,
	renameSync,
	rmSync,
} from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { assertNoSecrets } from "../memory.ts";
import { assertSafeProfile } from "../profile.ts";
import { git, type Workspace } from "./worktrees.ts";
export interface Prerequisite {
	kind: "node" | "python" | "go";
	ready: boolean;
	details: string[];
}
export function worktreeReadiness(cwd: string): Prerequisite[] {
	const checks: Prerequisite[] = [];
	if (existsSync(join(cwd, "package.json")))
		checks.push({
			kind: "node",
			ready: existsSync(join(cwd, "node_modules")),
			details: [
				"Node runtime is mounted from the Pi process.",
				existsSync(join(cwd, "node_modules"))
					? "node_modules present; run the project's approved tests to verify compatibility."
					: "node_modules missing. Use /task ID prepare dependencies to approve a screened copy from the parent, or provision dependencies manually.",
			],
		});
	if (["pyproject.toml", "requirements.txt", "setup.py"].some((f) => existsSync(join(cwd, f))))
		checks.push({
			kind: "python",
			ready: false,
			details: [
				existsSync("/usr/bin/python3")
					? "System Python available at /usr/bin/python3."
					: "Install system Python before testing.",
				"Verify required Python packages manually. Parent virtualenvs and caches are not mounted; no pip install runs automatically.",
			],
		});
	if (existsSync(join(cwd, "go.mod")))
		checks.push({
			kind: "go",
			ready: false,
			details: [
				existsSync("/usr/local/go/bin/go") || existsSync("/usr/bin/go")
					? "System Go available."
					: "Install Go under /usr before testing.",
				existsSync(join(cwd, "vendor"))
					? "Vendor directory present. Approve go test -mod=vendor ./... after inspection."
					: "Go module cache is unavailable. Provision vendor dependencies manually before sandbox tests.",
			],
		});
	return checks;
}
function denied(name: string): boolean {
	return /^(\.(env|git|poly|aws|ssh|claude|codex|npmrc|pypirc|netrc)(\.|$)|.*\.(pem|key|p12)$)/i.test(
		name,
	);
}
/** Import only dependency artifacts. No executable installer, network, external symlink, or credential file. */
export function importNodeDependencies(workspace: Workspace): void {
	const source = join(workspace.root, "node_modules");
	const target = join(workspace.path, "node_modules");
	assertSafeProfile(source);
	assertSafeProfile(target);
	if (!existsSync(source) || existsSync(target))
		throw new Error(
			"Parent dependencies missing or worker dependencies already exist; nothing copied",
		);
	if (!git(workspace.path, ["check-ignore", "node_modules/"]))
		throw new Error("Ignore node_modules in Git before dependency preparation");
	const temporary = join(dirname(workspace.path), `dependencies-${randomUUID()}`);
	let total = 0;
	let count = 0;
	function copy(from: string, to: string): void {
		if (++count > 100000) throw new Error("Dependency copy exceeds file budget");
		const stat = lstatSync(from);
		if (stat.isSymbolicLink()) {
			const destination = realpathSync(from);
			const rel = relative(source, destination);
			if (
				rel.startsWith("..") ||
				resolve(destination) === source ||
				resolve(readlinkSync(from)) === readlinkSync(from)
			)
				throw new Error("External or absolute dependency symlink refused");
			symlinkSync(readlinkSync(from), to);
		} else if (stat.isDirectory()) {
			mkdirSync(to, { mode: 0o700 });
			for (const name of readdirSync(from)) {
				if (denied(name)) throw new Error("Sensitive dependency filename refused");
				copy(join(from, name), join(to, name));
			}
		} else if (stat.isFile()) {
			total += stat.size;
			if (stat.size > 32000000 || total > 512000000)
				throw new Error("Dependency copy exceeds byte budget");
			assertNoSecrets(readFileSync(from).toString("utf8"));
			copyFileSync(from, to);
		} else throw new Error("Special dependency file refused");
	}
	try {
		copy(source, temporary);
		renameSync(temporary, target);
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
}
