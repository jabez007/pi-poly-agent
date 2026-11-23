import { git, renderReviewDiff } from "./worktrees.ts";
import { spawn } from "node:child_process";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { Type } from "typebox";
import {
	createReadTool,
	createWriteTool,
	createEditTool,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { assertNoSecrets } from "../memory.ts";

export function scopedPath(root: string, path: string): string {
	const canonical = realpathSync(root);
	const target = resolve(root, path);
	// Pi must receive the same absolute path that passes the source-context check.
	if (/^[@~]|^file:/i.test(path) || /[\u00a0\u2000-\u200a\u202f\u205f\u3000]/.test(target))
		throw new Error("Worker path shorthand or Unicode space normalization refused");
	const rel = relative(canonical, target);
	if (
		!rel ||
		rel.startsWith("..") ||
		isAbsolute(rel) ||
		rel.split("/").some((part) => /^\.(git|poly|env|aws|claude|codex|ssh)(\.|$)/.test(part))
	)
		throw new Error("Worker path is outside approved source context");
	let current = target;
	while (current !== canonical) {
		const status = lstatSync(current, { throwIfNoEntry: false });
		if (status && (status.isSymbolicLink() || realpathSync(current) !== current))
			throw new Error("Worker symlink access refused");
		current = dirname(current);
	}
	return target;
}
export function scopedTools(cwd: string, editing: boolean): ToolDefinition[] {
	const tools = [
		createReadTool(cwd),
		...(editing ? [createWriteTool(cwd), createEditTool(cwd)] : []),
	];
	return tools.map((tool) => ({
		...tool,
		execute: async (id: string, args: any, signal: AbortSignal | undefined, update: any) => {
			const path = scopedPath(cwd, args.path);
			if (tool.name === "read" && !lstatSync(path).isFile())
				throw new Error("Worker read requires an existing regular file");
			assertNoSecrets(args);
			const result = await tool.execute(id, { ...args, path }, signal, update);
			assertNoSecrets(result);
			return result;
		},
	})) as ToolDefinition[];
}

export type ApproveTest = (command: string, cwd: string, signal: AbortSignal) => Promise<boolean>;
export async function sandboxedTest(
	command: string,
	cwd: string,
	signal: AbortSignal,
): Promise<{ exitCode: number; output: string }> {
	assertNoSecrets(command);
	if (signal.aborted) throw new Error("Canceled");
	if (!existsSync("/usr/bin/bwrap"))
		throw new Error(
			"Install Bubblewrap at /usr/bin/bwrap and enable unprivileged user namespaces. No host-shell fallback.",
		);
	// Only source and system runtimes are mounted. No host HOME, auth store, Git common directory,
	// network, project-external write access, or inherited credentials are available to test code.
	const args = [
		"--unshare-all",
		"--die-with-parent",
		"--new-session",
		"--proc",
		"/proc",
		"--dev",
		"/dev",
		"--tmpfs",
		"/tmp",
		"--dir",
		"/home",
		"--dir",
		"/home/worker",
	];
	for (const path of ["/usr", "/bin", "/sbin", "/lib", "/lib64"])
		if (existsSync(path)) args.push("--ro-bind", path, path);
	if (existsSync("/etc/ld.so.cache"))
		args.push("--ro-bind", "/etc/ld.so.cache", "/etc/ld.so.cache");
	const metadata = resolve(cwd, ".git");
	const gitMount = existsSync(metadata) ? ["--ro-bind", metadata, "/workspace/.git"] : [];
	args.push(
		"--ro-bind",
		dirname(process.execPath),
		"/opt/poly-node",
		"--bind",
		cwd,
		"/workspace",
		...gitMount,
		"--chdir",
		"/workspace",
		"--clearenv",
		"--setenv",
		"HOME",
		"/home/worker",
		"--setenv",
		"PATH",
		"/opt/poly-node:/usr/local/go/bin:/usr/bin:/bin",
		"--setenv",
		"CI",
		"true",
		"/bin/bash",
		"--noprofile",
		"--norc",
		"-c",
		command,
	);
	return new Promise((resolve, reject) => {
		const child = spawn("/usr/bin/bwrap", args, {
			stdio: ["ignore", "pipe", "pipe"],
			env: { PATH: "/usr/bin:/bin" },
			detached: true,
		});
		let output = "";
		let oversized = false;
		const stop = () => {
			try {
				process.kill(-child.pid!, "SIGKILL");
			} catch {
				/* Already exited. */
			}
		};
		const timer = setTimeout(stop, 120000);
		signal.addEventListener("abort", stop, { once: true });
		const receive = (data: Buffer) => {
			output += String(data);
			if (output.length > 32000) {
				oversized = true;
				stop();
			}
		};
		child.stdout.on("data", receive);
		child.stderr.on("data", receive);
		child.once("error", () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", stop);
			reject(new Error("Sandboxed test unavailable; no host-shell fallback"));
		});
		child.once("close", (code) => {
			clearTimeout(timer);
			signal.removeEventListener("abort", stop);
			stop();
			try {
				assertNoSecrets(output);
				resolve({ exitCode: oversized ? 1 : (code ?? 1), output: output.slice(0, 32000) });
			} catch {
				reject(new Error("Sensitive test output withheld"));
			}
		});
	});
}

export async function approvedTest(
	command: string,
	cwd: string,
	approve: ApproveTest,
	signal: AbortSignal,
) {
	if (!command.trim() || command.length > 2000)
		throw new Error("Invalid test or preparation command");
	assertNoSecrets(command);
	if (!(await approve(command, cwd, signal)) || signal.aborted)
		throw new Error("Test permission denied");
	return sandboxedTest(command, cwd, signal);
}
export function testTool(cwd: string, approve: ApproveTest, tests: string[]): ToolDefinition {
	return {
		name: "run_test",
		label: "Run isolated test",
		description:
			"Run a user-approved test command in a network-disabled Bubblewrap sandbox. No credentials or host HOME. No host-shell fallback.",
		parameters: Type.Object({ command: Type.String({ maxLength: 2000 }) }),
		execute: async (_id, args: any, signal) => {
			const active = signal || new AbortController().signal;
			const result = await approvedTest(args.command, cwd, approve, active);
			tests.push(`${args.command}: exit ${result.exitCode}`);
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
		},
	};
}

export function diffTool(cwd: string, base: string): ToolDefinition {
	return {
		name: "review_diff",
		label: "Review source diff",
		description:
			"Read the implementation diff against the inspected task's original base. Does not modify files.",
		parameters: Type.Object({ path: Type.String() }),
		execute: async (_id, args: any) => {
			scopedPath(cwd, args.path);
			if (!/^[a-f0-9]{40,64}$/.test(base)) throw new Error("Invalid review base");
			const diff = git(cwd, [
				"diff",
				"--text",
				"--no-color",
				"--no-ext-diff",
				"--no-textconv",
				base,
				"HEAD",
				"--",
				args.path,
			]);
			const rendered = renderReviewDiff(diff);
			assertNoSecrets(rendered);
			return { content: [{ type: "text", text: rendered }], details: { base } };
		},
	};
}
