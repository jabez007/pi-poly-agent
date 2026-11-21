import { untilCanceled } from "./cancellation.ts";
import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { assertEnvironment, type Policy } from "../policy.ts";
import { assertNoSecrets } from "../memory.ts";
import { assertSafeProfile } from "../profile.ts";
import { assertDelegation } from "./capabilities.ts";
import type { Role } from "./roles.ts";
import { createWorkspace, workspaceDiff, snapshotWorkspace, type Workspace } from "./worktrees.ts";

export type TaskStatus =
	| "running"
	| "completed"
	| "failed"
	| "canceled"
	| "timed_out"
	| "interrupted";
export interface Finding {
	text: string;
	source: string;
	severity: "info" | "warning" | "error";
}
export interface TaskResult {
	summary: string;
	files: string[];
	tests: string[];
	findings: Finding[];
	questions: string[];
}
export interface Task {
	id: string;
	parent: string;
	role: Role;
	provider: string;
	model: string;
	depth: 1;
	brief: string;
	context: string;
	status: TaskStatus;
	workspace: Workspace;
	startedAt: string;
	finishedAt?: string;
	result?: TaskResult;
	error?: string;
	revision?: string;
	reviewOf?: string;
	reviewBase?: string;
	progress: string;
}
export interface RunInput {
	task: Task;
	signal: AbortSignal;
	progress(text: string): void;
}
export type TaskRunner = (input: RunInput) => Promise<TaskResult>;
export interface Dispatch {
	parent: string;
	role: Role;
	provider: string;
	model: string;
	brief: string;
	context?: string;
	depth?: number;
	reviewOf?: string;
}

export function validateTaskResult(value: unknown): TaskResult {
	const r = value as TaskResult;
	if (!r || typeof r.summary !== "string" || !r.summary.trim())
		throw new Error("Worker returned no structured summary");
	for (const field of [r.files, r.tests, r.questions])
		if (!Array.isArray(field) || !field.every((x) => typeof x === "string"))
			throw new Error("Invalid structured worker lists");
	if (
		!Array.isArray(r.findings) ||
		!r.findings.every(
			(f) =>
				f &&
				typeof f.text === "string" &&
				typeof f.source === "string" &&
				f.source &&
				["info", "warning", "error"].includes(f.severity),
		)
	)
		throw new Error("Findings require sources and severity");
	if (JSON.stringify(r).length > 48000) throw new Error("Worker result exceeds budget");
	assertNoSecrets(r);
	return {
		summary: r.summary,
		files: r.files,
		tests: r.tests,
		findings: r.findings,
		questions: r.questions,
	};
}

export class TaskManager {
	private tasks = new Map<string, Task>();
	private active = new Map<string, { controller: AbortController; done: Promise<void> }>();
	constructor(
		private directory: string,
		private cwd: string,
		private policy: () => Policy,
		private runner: TaskRunner,
		private concurrency = 2,
		private timeoutMs = 900000,
		private changed: (task: Task) => void = () => {},
	) {
		assertSafeProfile(directory);
		if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4)
			throw new Error("Invalid task concurrency");
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		this.restore();
	}
	private restore(): void {
		for (const id of readdirSync(this.directory).filter((id) => /^[a-f0-9-]{36}$/.test(id))) {
			const file = join(this.directory, id, "task.json");
			if (!existsSync(file)) continue;
			assertSafeProfile(file);
			try {
				const task = JSON.parse(readFileSync(file, "utf8")) as Task;
				if (task.id !== id || !task.workspace || task.depth !== 1) continue;
				assertNoSecrets(task);
				if (task.status === "running") {
					task.status = "interrupted";
					task.error =
						"Pi restarted; execution was not replayed. Inspect the preserved worktree and handoff.";
				}
				this.tasks.set(id, task);
				this.persist(task, false);
			} catch {
				/* A damaged record must not prevent independent tasks. */
			}
		}
	}
	list(): Task[] {
		return [...this.tasks.values()].map((task) => structuredClone(task));
	}
	get(id: string): Task {
		const task = this.tasks.get(id);
		if (!task) throw new Error("Unknown task");
		return structuredClone(task);
	}
	private persist(task: Task, notify = true): void {
		const path = join(this.directory, task.id, "task.json");
		assertSafeProfile(path);
		const temporary = `${path}.${randomUUID()}.tmp`;
		writeFileSync(temporary, JSON.stringify(task, null, 2), { mode: 0o600, flag: "wx" });
		renameSync(temporary, path);
		if (notify) {
			try {
				this.changed(structuredClone(task));
			} catch {
				/* UI failure cannot discard durable task results. */
			}
		}
	}
	dispatch(input: Dispatch): Task {
		assertEnvironment(process.env);
		assertDelegation(input.provider, this.policy(), input.depth ?? 1);
		if (this.active.size >= this.concurrency) throw new Error("Task concurrency limit reached");
		validateDispatch(input);
		const review = this.reviewTarget(input);
		const id = randomUUID();
		const workspace = createWorkspace(this.cwd, this.directory, id, review?.revision);
		const task: Task = {
			...input,
			context: input.context || "",
			id,
			depth: 1,
			status: "running",
			workspace,
			reviewBase: review?.workspace.base,
			startedAt: new Date().toISOString(),
			progress: "Starting isolated Pi session",
		};
		const controller = new AbortController();
		this.tasks.set(id, task);
		this.persist(task);
		// Install the active slot before async execution can finish or dispatch another task.
		const slot = { controller, done: Promise.resolve() };
		this.active.set(id, slot);
		slot.done = this.execute(task, controller);
		return structuredClone(task);
	}
	private reviewTarget(input: Dispatch): Task | undefined {
		if (!input.reviewOf) return;
		const review = this.get(input.reviewOf);
		if (review.status !== "completed" || !review.revision || input.role.editing)
			throw new Error("Review requires a completed snapshot and a read-only role");
		return review;
	}
	private async execute(task: Task, controller: AbortController): Promise<void> {
		const timer = setTimeout(() => {
			task.status = "timed_out";
			controller.abort();
		}, this.timeoutMs);
		try {
			assertDelegation(task.provider, this.policy(), task.depth);
			const result = await untilCanceled(
				this.runner({
					task: structuredClone(task),
					signal: controller.signal,
					progress: (text) => {
						try {
							assertNoSecrets(text);
							task.progress = text.slice(0, 1000);
							this.changed(structuredClone(task));
						} catch {
							task.progress = "Sensitive progress withheld";
						}
					},
				}),
				controller.signal,
			);
			if (controller.signal.aborted) return;
			task.result = validateTaskResult(result);
			const changes = workspaceDiff(task.workspace);
			assertNoSecrets(changes);
			if (!task.role.editing && changes.files.length)
				throw new Error("Read-only worker modified files");
			task.result.files = changes.files;
			if (task.role.editing) task.revision = snapshotWorkspace(task.workspace);
			task.status = "completed";
		} catch {
			if (!controller.signal.aborted) {
				task.status = "failed";
				task.error =
					"Worker failed or returned invalid/sensitive output; inspect the preserved worktree. No provider fallback attempted.";
			}
		} finally {
			clearTimeout(timer);
			task.finishedAt = new Date().toISOString();
			if (task.status === "running") task.status = "canceled";
			this.active.delete(task.id);
			this.persist(task);
		}
	}
	async wait(id: string): Promise<Task> {
		await this.active.get(id)?.done;
		return this.get(id);
	}
	async cancel(id: string): Promise<Task> {
		const task = this.tasks.get(id);
		if (!task) throw new Error("Unknown task");
		const active = this.active.get(id);
		if (active) {
			task.status = "canceled";
			active.controller.abort();
			await active.done;
		}
		return this.get(id);
	}
	async close(): Promise<void> {
		await Promise.all([...this.active.keys()].map((id) => this.cancel(id)));
	}
}

function validateDispatch(input: Dispatch): void {
	if (!input.brief.trim() || input.brief.length > 6000 || (input.context || "").length > 16000)
		throw new Error("Task brief or context exceeds budget");
	if (!input.model || !/^[\w.:[\]-]+$/.test(input.model))
		throw new Error("Choose an explicit worker model");
	assertNoSecrets(input);
}
