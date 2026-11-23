import {
	agentPolicy,
	effectivePolicy,
	type ExecutionPolicy,
	type Artifact,
} from "../platform/contracts.ts";
import { ProviderRegistry } from "../platform/providers.ts";
import { atomicRecord, acquireHost } from "./storage.ts";
import { safeFailure, type FailureCode } from "./errors.ts";
import { type Capabilities } from "./capabilities.ts";
import { worktreeReadiness, type Prerequisite } from "./preparation.ts";
import { untilCanceled } from "./cancellation.ts";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { assertEnvironment, type Policy } from "../policy.ts";
import { assertNoSecrets } from "../memory.ts";
import { REVIEW_CONTEXT_BUDGET, reviewDiffView } from "./review-view.ts";
import { assertSafeProfile } from "../profile.ts";
import type { Role } from "./roles.ts";
import {
	createWorkspace,
	workspaceDiff,
	snapshotWorkspace,
	inspectWorkspace,
	integrateWorkspace,
	assertIntegration,
	git,
	registerTaskDirectory,
	type Workspace,
} from "./worktrees.ts";

export type TaskStatus =
	| "running"
	| "completed"
	| "failed"
	| "canceled"
	| "timed_out"
	| "interrupted"
	| "created";
export interface Finding {
	text: string;
	source: string;
	severity: "info" | "warning" | "error";
}
export interface TaskResult {
	artifacts?: Artifact[];
	summary: string;
	files: string[];
	tests: string[];
	findings: Finding[];
	questions: string[];
}
export interface Task {
	id: string;
	parent: string;
	workflowStep?: string;
	role: Role;
	provider: string;
	model: string;
	requestBudget?: RequestBudget;
	depth: number;
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
	effectivePolicy?: ExecutionPolicy;
	artifacts?: Artifact[];
	project?: string;
	createdAt?: string;
	updatedAt?: string;
	capabilities?: Capabilities;
	sessionFile?: string;
	prerequisites?: Prerequisite[];
	preparation?: { command: string; exitCode: number }[];
	failureCode?: FailureCode;
	workflowReviewModel?: string;
	replacementOf?: string;
	replacedBy?: string;
	reviewRevision?: string;
	integration?: {
		state: "awaiting_review" | "ready" | "integrating" | "integrated" | "interrupted" | "created";
		revision: string;
		parentBefore?: string;
		parentAfter?: string;
	};
	recovery?: string[];
}
export interface RunInput {
	task: Task;
	signal: AbortSignal;
	progress(text: string): void;
	session?(file: string): void;
}
export type TaskRunner = (input: RunInput) => Promise<TaskResult>;
export interface RequestBudget {
	requests: number;
	outputTokens: number;
}
export interface Dispatch {
	parent: string;
	workflowStep?: string;
	role: Role;
	provider: string;
	model: string;
	requestBudget?: RequestBudget;
	brief: string;
	context?: string;
	depth?: number;
	reviewOf?: string;
	workflowReviewModel?: string;
	replacementOf?: string;
	policy?: Partial<ExecutionPolicy>;
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
		artifacts: validateArtifacts(r.artifacts),
	};
}

function validateArtifacts(artifacts: Artifact[] | undefined): Artifact[] {
	if (artifacts === undefined) return [];
	if (!Array.isArray(artifacts) || artifacts.length > 16) throw new Error("Invalid task artifacts");
	return artifacts.map((artifact) => {
		if (
			!artifact ||
			!/^[a-z][a-z0-9-]{0,63}$/.test(artifact.kind) ||
			typeof artifact.content !== "string" ||
			typeof artifact.source !== "string" ||
			!artifact.source
		)
			throw new Error("Artifact requires a kind, content and source");
		if (["summary", "findings", "tests", "diff"].includes(artifact.kind))
			throw new Error("Artifact kind reserved for application output");
		return {
			kind: artifact.kind,
			content: artifact.content,
			source: artifact.source,
			certainty: "claim",
		};
	});
}

export class TaskManager {
	readonly diagnostics: string[] = [];
	private release: () => void;
	private closed = false;
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
		private prepare: (task: Task, signal: AbortSignal) => Promise<void> = async () => {},
		private registry = new ProviderRegistry(policy),
		private restrictions: Partial<ExecutionPolicy> = {},
	) {
		assertSafeProfile(directory);
		registerTaskDirectory(directory);
		if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4)
			throw new Error("Invalid task concurrency");
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		this.release = acquireHost(directory);
		try {
			this.restore();
		} catch (error) {
			this.release();
			throw error;
		}
	}
	private restore(): void {
		for (const id of readdirSync(this.directory).filter((id) => /^[a-f0-9-]{36}$/.test(id))) {
			const file = join(this.directory, id, "task.json");
			if (!existsSync(file)) {
				this.diagnostics.push(
					`Task ${id}: missing committed record. Preserved temporary files or worktree require manual inspection.`,
				);
				continue;
			}
			try {
				this.restoreTask(id, file);
			} catch {
				this.diagnostics.push(
					`Task ${id}: damaged, unsafe, or unreadable record. Original files retained for manual recovery.`,
				);
			}
		}
	}
	private restoreTask(id: string, file: string): void {
		assertSafeProfile(file);
		const task = JSON.parse(readFileSync(file, "utf8")) as Task;
		if (task.id !== id || !task.workspace || task.depth !== 1) throw new Error("Invalid task");
		if (
			task.workspace.root !== git(this.cwd, ["rev-parse", "--show-toplevel"]) ||
			task.workspace.path !== resolve(this.directory, id, "worktree")
		)
			throw new Error("Task belongs to another project or path");
		assertSafeProfile(task.workspace.path);
		assertNoSecrets(task);
		if (["running", "created"].includes(task.status)) {
			task.status = "interrupted";
			task.error =
				"Pi restarted; execution was not replayed. Inspect the preserved worktree and handoff.";
		}
		task.recovery = inspectWorkspace(task.workspace);
		if (task.integration?.state === "integrating") {
			task.integration.state = "interrupted";
			task.recovery.push(
				"Integration was interrupted. Inspect parent Git status and CHERRY_PICK_HEAD; no cherry-pick was replayed.",
			);
		}
		this.tasks.set(id, task);
		this.persist(task, false);
	}
	list(): Task[] {
		return [...this.tasks.values()]
			.sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt) || a.id.localeCompare(b.id))
			.map((task) => structuredClone(task));
	}
	get(id: string): Task {
		const task = this.tasks.get(id);
		if (!task) throw new Error("Unknown task");
		return structuredClone(task);
	}
	private persist(task: Task, notify = true): void {
		const path = join(this.directory, task.id, "task.json");
		assertSafeProfile(path);
		task.updatedAt = new Date().toISOString();
		atomicRecord(path, task);
		if (notify) {
			try {
				this.changed(structuredClone(task));
			} catch {
				/* UI failure cannot discard durable task results. */
			}
		}
	}
	dispatch(input: Dispatch): Task {
		if (this.closed) throw new Error("Task host is closed");
		assertEnvironment(process.env);
		this.registry.assert(input.provider, input.depth ?? 1);
		input = this.admit(input);
		if (this.active.size >= this.concurrency) throw new Error("Task concurrency limit reached");
		validateDispatch(input);

		const review = this.reviewTarget(input);
		const task = this.createTask(input, review);
		const id = task.id;
		const controller = new AbortController();
		task.status = "running";
		this.persist(task);
		// Install the active slot before async execution can finish or dispatch another task.
		const slot = { controller, done: Promise.resolve() };
		this.active.set(id, slot);
		slot.done = this.execute(task, controller).catch(() => {
			this.diagnostics.push(
				`Task ${task.id}: persistence failed. Stop this host and inspect preserved files; do not replay automatically.`,
			);
		});
		return structuredClone(task);
	}
	/** Recovery validates current policy and exact retained source, without dispatching anything. */
	validateCheckpoint(id: string, role: Role): Task {
		const task = this.get(id);
		this.registry.assert(task.provider, task.depth);
		assertAgentModel({ ...task, role }, this.registry.capabilities(task.provider));
		if (!existsSync(task.workspace.path))
			throw new Error("Workflow checkpoint worktree missing; inspect its retained branch manually");
		const revision = task.revision || task.workspace.base;
		if (
			git(task.workspace.root, ["rev-parse", "HEAD"]) !== (task.reviewBase || task.workspace.base)
		)
			throw new Error(
				"Workflow checkpoint parent revision changed; inspect retained work manually",
			);
		if (
			git(task.workspace.path, ["rev-parse", "HEAD"]) !== revision ||
			git(task.workspace.path, ["branch", "--show-current"]) !== task.workspace.branch ||
			git(task.workspace.path, ["status", "--porcelain"])
		)
			throw new Error(
				"Workflow checkpoint source changed or worktree is unavailable; inspect it manually",
			);
		if (task.status !== "completed" || !task.result || !task.artifacts?.length)
			throw new Error("Workflow checkpoint requires a completed task and retained artifacts");
		return task;
	}

	private admit(input: Dispatch): Dispatch {
		const execution = effectivePolicy(
			agentPolicy(input.role),
			this.restrictions,
			input.policy || {},
		);
		if ((input.context || "").length > execution.contextBudget)
			throw new Error(
				`Approved context is ${input.context!.length} characters; effective budget is ${execution.contextBudget}, exceeded by ${input.context!.length - execution.contextBudget}. Review and shorten the packet before dispatch.`,
			);
		const capabilities = this.registry.capabilities(input.provider);
		assertAgentModel(input, capabilities);
		if (execution.permissions.includes("write") && !capabilities.editing)
			throw new Error("Provider does not support editing");
		if (
			!capabilities.concurrent &&
			[...this.active.keys()].some((id) => this.tasks.get(id)?.provider === input.provider)
		)
			throw new Error("Provider does not permit concurrent sessions");
		if (!capabilities.tools && execution.tools.length)
			throw new Error("Provider does not support tools");
		if (this.active.size >= execution.concurrency)
			throw new Error("Agent concurrency limit reached");
		return {
			...input,
			role: { ...input.role, editing: execution.permissions.includes("write") },
			policy: execution,
		};
	}

	private createTask(input: Dispatch, review?: Task): Task {
		const id = randomUUID();
		const replacement = input.replacementOf
			? this.replacementTarget(input.replacementOf)
			: undefined;
		if (replacement && replacement.role.name !== input.role.name)
			throw new Error("Replacement must preserve the original role");
		const recoveryRevision = replacementRevision(replacement);
		let task: Task | undefined;
		try {
			const workspace = createWorkspace(
				this.cwd,
				this.directory,
				id,
				review?.revision || recoveryRevision,
				(planned) => {
					if (replacement) planned.base = replacement.workspace.base;
					task = {
						...input,
						requestBudget: intersectRequestBudget(input.requestBudget, replacement?.requestBudget),
						context: reviewContext(input, review),
						id,
						depth: 1,
						status: "created",
						workspace: planned,
						reviewBase: review?.workspace.base,
						reviewRevision: review?.revision,
						project: planned.root,
						createdAt: new Date().toISOString(),
						startedAt: new Date().toISOString(),
						capabilities: this.registry.capabilities(input.provider),
						effectivePolicy: input.policy as ExecutionPolicy,
						progress: "Preparing isolated Pi session",
					};
					this.tasks.set(id, task);
					this.persist(task, false);
				},
			);
			if (replacement) workspace.base = replacement.workspace.base;
			task!.workspace = workspace;
			task!.prerequisites = worktreeReadiness(workspace.path);
			if (replacement) {
				const original = this.tasks.get(replacement.id)!;
				original.replacedBy = id;
				this.persist(original, false);
			}
			return task!;
		} catch (error) {
			if (task) {
				task.status = "failed";
				task.error = safeFailure(error).message;
				this.persist(task, false);
			}
			throw error;
		}
	}
	private reviewTarget(input: Dispatch): Task | undefined {
		if (!input.reviewOf) return;
		const review = this.get(input.reviewOf);
		if (
			review.status !== "completed" ||
			!review.revision ||
			input.role.editing ||
			!input.policy?.permissions?.includes("read")
		)
			throw new Error("Review requires a completed snapshot and a read-only inspection agent");
		assertIntegrationSnapshot(review);
		return review;
	}
	private async execute(task: Task, controller: AbortController): Promise<void> {
		const timer = setTimeout(
			() => {
				task.status = "timed_out";
				controller.abort();
			},
			Math.min(this.timeoutMs, task.effectivePolicy?.timeoutMs ?? this.timeoutMs),
		);
		try {
			this.registry.assert(task.provider, task.depth);
			await untilCanceled(
				this.prepare(structuredClone(task), controller.signal),
				controller.signal,
			);
			if (controller.signal.aborted) return;
			task.prerequisites = worktreeReadiness(task.workspace.path);
			this.persist(task, false);
			const result = await untilCanceled(
				this.runner({
					task: structuredClone(task),
					signal: controller.signal,
					session: (file) => {
						if (controller.signal.aborted) return;
						assertSafeProfile(file);
						if (!file.startsWith(join(this.directory, task.id, "sessions") + "/"))
							throw new Error("Invalid worker session reference");
						task.sessionFile = file;
						this.persist(task, false);
					},
					progress: (text) => {
						try {
							if (controller.signal.aborted) return;
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
			this.complete(task, result);
		} catch (error) {
			if (!controller.signal.aborted) {
				task.status = "failed";
				const failure = safeFailure(error);
				task.error = failure.message;
				task.failureCode = failure.code;
			}
		} finally {
			clearTimeout(timer);
			task.finishedAt = new Date().toISOString();
			if (task.status === "running") task.status = "canceled";
			this.active.delete(task.id);
			this.persist(task);
		}
	}
	private complete(task: Task, result: TaskResult): void {
		task.result = validateTaskResult(result);
		this.persist(task, false);
		const changes = workspaceDiff(task.workspace);
		assertNoSecrets(changes);
		if (!task.role.editing && changes.files.length)
			throw new Error("Read-only worker modified files");
		task.result.files = changes.files;
		if (task.role.editing) task.revision = snapshotWorkspace(task.workspace);
		if (task.revision)
			changes.diff = reviewDiffView(task.workspace.path, task.workspace.base, task.revision);
		task.artifacts = [
			...(task.result.artifacts || []),
			{ kind: "summary", content: task.result.summary, source: task.id, certainty: "claim" },
			{
				kind: "findings",
				content: JSON.stringify(task.result.findings),
				source: task.id,
				certainty: "claim",
			},
			{
				kind: "tests",
				content: JSON.stringify(task.result.tests),
				source: task.id,
				certainty: "observed",
			},
			{
				kind: "diff",
				content: changes.diff,
				source: task.revision || task.workspace.base,
				certainty: "observed",
			},
		];
		if (task.role.outputs?.some((kind) => !task.artifacts!.some((a) => a.kind === kind)))
			throw new Error("Missing required agent artifact");
		task.status = "completed";
		if (task.revision) task.integration = { state: "awaiting_review", revision: task.revision };
		if (task.reviewOf) {
			const inspected = this.tasks.get(task.reviewOf)!;
			inspected.integration = { state: "ready", revision: task.reviewRevision! };
			this.persist(inspected, false);
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
		this.closed = true;
		try {
			await Promise.all([...this.active.keys()].map((id) => this.cancel(id)));
		} finally {
			this.release();
		}
	}
	recordPreparation(id: string, command: string, exitCode: number): void {
		const task = this.tasks.get(id);
		if (!task || task.status === "running")
			throw new Error("Preparation requires an inactive task");
		assertNoSecrets(command);
		task.preparation = [...(task.preparation || []), { command, exitCode }];
		task.prerequisites = worktreeReadiness(task.workspace.path);
		this.persist(task, false);
	}
	private replacementTarget(id: string): Task {
		const previous = this.get(id);
		if (["running", "completed"].includes(previous.status) || previous.replacedBy)
			throw new Error(
				"Only an inactive failed, canceled, timed-out or interrupted task without a replacement can be replaced",
			);
		if (!existsSync(previous.workspace.path))
			throw new Error("Original worktree is missing; inspect its retained branch manually");
		if (git(previous.workspace.root, ["rev-parse", "HEAD"]) !== previous.workspace.base)
			throw new Error("Parent changed; recover the original task branch manually");
		assertNoSecrets(workspaceDiff(previous.workspace));
		return previous;
	}
	integrate(id: string): Task {
		const task = this.tasks.get(id);
		if (!task || task.status !== "completed" || !task.role.editing || !task.revision)
			throw new Error("Only completed editing snapshots can be integrated");
		if (task.integration?.state === "integrated") throw new Error("Task is already integrated");
		const review = this.list().find(
			(r) =>
				r.reviewOf === id &&
				r.status === "completed" &&
				!r.role.editing &&
				(r.reviewRevision || r.workspace.base) === task.revision,
		);
		if (!review)
			throw new Error("Complete an independent review of the exact snapshot before integration");
		assertIntegrationSnapshot(task);
		assertIntegration(task.workspace, task.revision);
		task.integration = {
			state: "integrating",
			revision: task.revision,
			parentBefore: task.workspace.base,
		};
		this.persist(task, false);
		try {
			integrateWorkspace(task.workspace, task.revision);
			task.integration.state = "integrated";
			task.integration.parentAfter = git(task.workspace.root, ["rev-parse", "HEAD"]);
		} catch (error) {
			task.integration.state = "interrupted";
			this.persist(task, false);
			throw error;
		}
		this.persist(task, false);
		return this.get(id);
	}
}

function reviewContext(input: Dispatch, review?: Task): string {
	const context = input.context || "";
	if (!review?.revision) return context;
	const limit = input.policy?.contextBudget ?? 16000;
	const view = reviewDiffView(
		review.workspace.path,
		review.workspace.base,
		review.revision,
		[],
		Math.min(limit, REVIEW_CONTEXT_BUDGET),
	);
	if (!view) return context;
	if (!context.includes(view))
		throw new Error(
			"Approved context is missing the required review view; reopen the context editor and retain it unchanged",
		);
	if (context.split(view).length !== 2)
		throw new Error(
			"Approved context must contain the required review view exactly once; reopen the context editor",
		);
	return context;
}

function assertAgentModel(input: Dispatch, capabilities: Capabilities): void {
	if (input.role.model && input.role.model !== `${input.provider}/${input.model}`)
		throw new Error("Agent requires its configured exact model");
	const selection = input.role.selection;
	if (selection?.instance && selection.instance !== input.provider)
		throw new Error("Agent provider selection constraint was not satisfied");
	if (selection?.requires?.some((key) => (capabilities as any)[key] !== true))
		throw new Error("Required agent provider capability is unsupported");
}

function validateDispatch(input: Dispatch): void {
	validateRequestBudget(input.requestBudget);
	if (!input.role.name || typeof input.role.instructions !== "string")
		throw new Error("Invalid agent definition");
	if (!input.brief.trim() || input.brief.length > 6000 || (input.context || "").length > 16000)
		throw new Error("Task brief or context exceeds budget");
	if (!input.model || !/^[\w.:[\]-]+$/.test(input.model))
		throw new Error("Choose an explicit worker model");
	assertNoSecrets(input);
}

export function validateRequestBudget(budget?: RequestBudget): void {
	if (!budget) return;
	if (
		!Number.isInteger(budget.requests) ||
		budget.requests < 1 ||
		budget.requests > 64 ||
		!Number.isInteger(budget.outputTokens) ||
		budget.outputTokens < 64 ||
		budget.outputTokens > 4096
	)
		throw new Error("Invalid explicit worker request budget");
}
function intersectRequestBudget(
	current?: RequestBudget,
	previous?: RequestBudget,
): RequestBudget | undefined {
	if (!previous) return current;
	if (!current) return previous;
	return {
		requests: Math.min(current.requests, previous.requests),
		outputTokens: Math.min(current.outputTokens, previous.outputTokens),
	};
}

function assertIntegrationSnapshot(task: Task): void {
	if (!existsSync(task.workspace.path))
		throw new Error("Task worktree missing; inspect retained branch manually");
	if (
		git(task.workspace.path, ["status", "--porcelain"]) ||
		git(task.workspace.path, ["rev-parse", "HEAD"]) !== task.revision
	)
		throw new Error(
			"Builder worktree changed after snapshot; capture and review changes explicitly before integration",
		);
}

function replacementRevision(task?: Task): string | undefined {
	if (!task) return;
	return task.role.editing ? snapshotWorkspace(task.workspace) : task.workspace.base;
}
