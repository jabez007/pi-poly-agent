import { safeFailure } from "../orchestration/errors.ts";
import { untilCanceled } from "../orchestration/cancellation.ts";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { atomicRecord } from "../orchestration/storage.ts";
import { taskContext } from "../orchestration/context.ts";
import { TaskManager, type Dispatch, type Task } from "../orchestration/tasks.ts";
import { assertNoSecrets } from "../memory.ts";
import { assertSafeProfile } from "../profile.ts";
import { fields, identifier } from "./config.ts";
import { agentPolicy, type AgentDefinition } from "./contracts.ts";

export interface WorkflowStep {
	id: string;
	agent: string;
	objective: string;
	needs?: string[];
	contextFrom?: string[];
	inspect?: string;
	model?: string;
	distinctModelFrom?: string;
	approval?: string;
	when?: "completed" | "no-errors";
	artifacts?: string[];
}
export interface WorkflowDefinition {
	id: string;
	description?: string;
	steps: WorkflowStep[];
	failure?: "stop" | "continue";
}
export interface WorkflowRun {
	id: string;
	continuedFrom?: string;
	continuedBy?: string;
	definition: WorkflowDefinition;
	input: string;
	parent: string;
	status: "running" | "waiting_approval" | "completed" | "failed" | "canceled" | "interrupted";
	createdAt: string;
	updatedAt: string;
	steps: Record<string, { status: string; task?: string; error?: string }>;
}
export function validateWorkflow(workflow: WorkflowDefinition, agents: AgentDefinition[]): void {
	identifier(workflow.id);
	fields(workflow, ["id", "description", "steps", "failure"], "workflow");
	if (!Array.isArray(workflow.steps) || !workflow.steps.length || workflow.steps.length > 32)
		throw new Error("Workflow requires 1–32 steps");
	if (workflow.failure && !["stop", "continue"].includes(workflow.failure))
		throw new Error("Invalid workflow failure behavior");
	const visited = new Set<string>();
	for (const step of workflow.steps) {
		validateStep(step, visited, agents);
		visited.add(step.id);
	}
}
function validateStep(step: WorkflowStep, visited: Set<string>, agents: AgentDefinition[]): void {
	fields(
		step,
		[
			"id",
			"agent",
			"objective",
			"needs",
			"contextFrom",
			"inspect",
			"model",
			"distinctModelFrom",
			"approval",
			"when",
			"artifacts",
		],
		"workflow step",
	);
	identifier(step.id);
	if (visited.has(step.id) || !agents.some((a) => a.name === step.agent))
		throw new Error("Duplicate step or unknown workflow agent");
	if (typeof step.objective !== "string" || !step.objective.trim() || step.objective.length > 6000)
		throw new Error("Workflow objective required");
	validateStepTransfers(step, visited);
}
function validateStepTransfers(step: WorkflowStep, visited: Set<string>): void {
	const dependencies = step.needs || [];
	if (!Array.isArray(dependencies) || dependencies.some((id) => !visited.has(id)))
		throw new Error("Workflow dependencies must precede their consumers; cycles are forbidden");
	for (const id of [
		...(step.contextFrom || []),
		...(step.inspect ? [step.inspect] : []),
		...(step.distinctModelFrom ? [step.distinctModelFrom] : []),
	])
		if (!dependencies.includes(id))
			throw new Error("Context and snapshot transfers require explicit dependencies");
	validateStepOutcome(step);
}

function validateStepOutcome(step: WorkflowStep): void {
	if (step.when && !["completed", "no-errors"].includes(step.when))
		throw new Error("Unknown workflow condition");
	if (
		step.artifacts &&
		(!Array.isArray(step.artifacts) ||
			step.artifacts.some((k) => typeof k !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(k)))
	)
		throw new Error("Unsupported required artifact");
}
export interface WorkflowHooks {
	model(agent: AgentDefinition, requested?: string): Promise<string | undefined>;
	context(objective: string, agent: AgentDefinition): Promise<string>;
	approve(step: WorkflowStep, dispatch: Dispatch, signal: AbortSignal): Promise<Dispatch | false>;
	changed?(run: WorkflowRun): void;
}
/** A bounded DAG coordinator. TaskManager owns all execution, policy checks and workspaces. */
export class WorkflowEngine {
	private runs = new Map<string, WorkflowRun>();
	private approvals: Promise<unknown> = Promise.resolve();
	private active = new Map<string, { signal: AbortController; done: Promise<void> }>();
	constructor(
		private directory: string,
		private tasks: TaskManager,
		private agents: AgentDefinition[],
		private hooks: WorkflowHooks,
		private concurrency = 2,
	) {
		assertSafeProfile(directory);
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		for (const file of readdirSync(directory).filter((f) => /^[a-f0-9-]{36}\.json$/.test(f))) {
			const path = join(directory, file);
			assertSafeProfile(path);
			const run = JSON.parse(readFileSync(path, "utf8")) as WorkflowRun;
			assertNoSecrets(run);
			if (`${run.id}.json` !== file) throw new Error("Invalid workflow record");
			if (["running", "waiting_approval"].includes(run.status)) run.status = "interrupted";
			this.runs.set(run.id, run);
			this.persist(run);
		}
	}
	list(): WorkflowRun[] {
		return structuredClone([...this.runs.values()]);
	}
	start(
		definition: WorkflowDefinition,
		input: string,
		parent: string,
		checkpoint?: WorkflowRun,
	): WorkflowRun {
		validateWorkflow(definition, this.agents);
		if (!input.trim() || input.length > 6000) throw new Error("Workflow input exceeds task budget");
		if (checkpoint && this.runs.get(checkpoint.id) !== checkpoint)
			throw new Error("Use continueRun to validate checkpoint reuse");
		assertNoSecrets({ definition, input });
		const run: WorkflowRun = {
			id: randomUUID(),
			continuedFrom: checkpoint?.id,
			definition: structuredClone(definition),
			input,
			parent,
			status: "running",
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			steps: Object.fromEntries(
				definition.steps.map((s) => [
					s.id,
					checkpoint?.steps[s.id].status === "completed"
						? structuredClone(checkpoint.steps[s.id])
						: { status: "pending" },
				]),
			),
		};
		this.runs.set(run.id, run);
		this.persist(run);
		if (checkpoint) {
			checkpoint.continuedBy = run.id;
			this.persist(checkpoint);
		}
		const slot = { signal: new AbortController(), done: Promise.resolve() };
		this.active.set(run.id, slot);
		slot.done = this.execute(run, slot.signal.signal)
			.catch(() => {
				run.status = "failed";
				this.persist(run);
			})
			.finally(() => this.active.delete(run.id));
		return structuredClone(run);
	}
	/** Explicit replacement run. Completed tasks are reused; pending work always receives fresh approval. */
	continueRun(id: string, parent: string, approved: boolean): WorkflowRun {
		const original = this.runs.get(id);
		if (!approved || !original || original.status !== "interrupted")
			throw new Error("Only an explicitly approved interrupted workflow can continue");
		if (original.continuedBy || [...this.runs.values()].some((run) => run.continuedFrom === id))
			throw new Error(
				"Workflow already has a continuation; inspect its linked run instead of replaying pending steps",
			);
		validateWorkflow(original.definition, this.agents);
		for (const step of original.definition.steps) this.validateRecoveryStep(original, step);
		return this.start(original.definition, original.input, parent, original);
	}
	private validateRecoveryStep(run: WorkflowRun, step: WorkflowStep): void {
		const state = run.steps[step.id];
		if (!state.task) state.task = this.recoverDispatch(run, step);
		if (!state.task) return;
		let task = this.tasks.get(state.task);
		if (task.replacedBy) {
			const replacement = this.tasks.get(task.replacedBy);
			if (replacement.replacementOf !== task.id)
				throw new Error("Invalid replacement task relationship");
			task = replacement;
		}
		// Reconcile an interrupted completion notification from durable task state, without a request replay.
		if (task.status === "completed") {
			const agent = this.agents.find((a) => a.name === step.agent)!;
			if (
				task.role.name !== agent.name ||
				(step.model && step.model !== `${task.provider}/${task.model}`)
			)
				throw new Error("Workflow checkpoint agent or model mismatch");
			this.tasks.validateCheckpoint(task.id, agent);
			if (this.outcome(task, step) !== "completed")
				throw new Error("Workflow recovery requires retained artifact contracts");
			state.status = "completed";
			state.task = task.id;
			return;
		}
		throw new Error(
			"Workflow contains unfinished worker execution. Recover or replace its task explicitly; continuation cannot replay uncertain operations.",
		);
	}

	private recoverDispatch(run: WorkflowRun, step: WorkflowStep): string | undefined {
		const known = new Set(Object.values(run.steps).map((s) => s.task));
		const orphans = this.tasks
			.list()
			.filter((t) => t.parent === `workflow:${run.id}` && !known.has(t.id));
		if (orphans.some((t) => !t.workflowStep))
			throw new Error(
				"Unlinked legacy workflow task requires manual reconciliation; replay refused",
			);
		const matches = orphans.filter((t) => t.workflowStep === step.id);
		if (matches.length > 1) throw new Error("Ambiguous workflow dispatch history; replay refused");
		return matches[0]?.id;
	}

	async wait(id: string): Promise<WorkflowRun> {
		await this.active.get(id)?.done;
		const run = this.runs.get(id);
		if (!run) throw new Error("Unknown workflow run");
		return structuredClone(run);
	}
	async cancel(id: string): Promise<void> {
		const run = this.runs.get(id);
		if (!run) throw new Error("Unknown workflow run");
		this.active.get(id)?.signal.abort();
		run.status = "canceled";
		this.persist(run);
		await Promise.all(
			Object.values(run.steps)
				.filter((s) => s.task)
				.map((s) => this.tasks.cancel(s.task!)),
		);
	}
	async close(): Promise<void> {
		for (const id of this.active.keys()) await this.cancel(id);
	}
	private persist(run: WorkflowRun): void {
		run.updatedAt = new Date().toISOString();
		atomicRecord(join(this.directory, `${run.id}.json`), run);
		try {
			this.hooks.changed?.(structuredClone(run));
		} catch {
			/* UI failures do not discard records. */
		}
	}
	private async execute(run: WorkflowRun, signal: AbortSignal): Promise<void> {
		// Each iteration consumes at least one declared step. No polling or dynamic expansion.
		for (let count = 0; count < run.definition.steps.length && !signal.aborted; count++) {
			const ready = run.definition.steps.filter(
				(s) =>
					run.steps[s.id].status === "pending" &&
					(s.needs || []).every(
						(id) => !["pending", "running", "waiting_approval"].includes(run.steps[id].status),
					),
			);
			if (!ready.length) break;
			await Promise.all(
				ready.slice(0, this.concurrency).map((step) => this.step(run, step, signal)),
			);
			if (run.status === "canceled") return;
			if (
				run.definition.failure !== "continue" &&
				Object.values(run.steps).some((s) => s.status === "failed")
			) {
				run.status = "failed";
				this.persist(run);
				return;
			}
		}
		if (!signal.aborted)
			run.status = Object.values(run.steps).every((s) =>
				["completed", "skipped"].includes(s.status),
			)
				? "completed"
				: "failed";
		this.persist(run);
	}
	private async step(run: WorkflowRun, step: WorkflowStep, signal: AbortSignal): Promise<void> {
		const state = run.steps[step.id];
		const previous = (step.needs || []).map((id) => run.steps[id]);
		if (previous.some((s) => s.status !== "completed") || !this.condition(run, step)) {
			state.status = "skipped";
			this.persist(run);
			return;
		}
		const agent = this.agents.find((a) => a.name === step.agent)!;
		try {
			const approved = await this.approve(run, step, agent, signal);
			if (!approved || signal.aborted) {
				await this.cancel(run.id);
				return;
			}
			const task = this.tasks.dispatch(approved);
			state.task = task.id;
			state.status = "running";
			run.status = "running";
			this.persist(run);
			const completed = await this.tasks.wait(task.id);
			state.status = this.outcome(completed, step);
			if (state.status === "failed")
				state.error = completed.error || "Required artifact unavailable; inspect the task result.";
			this.persist(run);
		} catch (error) {
			state.error = safeFailure(error).message;
			state.status = signal.aborted ? "canceled" : "failed";
			this.persist(run);
		}
	}
	private async approve(
		run: WorkflowRun,
		step: WorkflowStep,
		agent: AgentDefinition,
		signal: AbortSignal,
	): Promise<Dispatch | false> {
		const choose = async (): Promise<Dispatch | false> => {
			const state = run.steps[step.id];
			signal.throwIfAborted();
			const chosen = await untilCanceled(this.hooks.model(agent, step.model), signal);
			if (!chosen || signal.aborted) return false;
			const slash = chosen.indexOf("/");
			if (slash < 1) throw new Error("Choose an explicit workflow provider/model");
			const input = await this.input(run, step, agent, chosen, signal);
			this.distinctModel(run, step, input);
			state.status = "waiting_approval";
			run.status = "waiting_approval";
			this.persist(run);
			const approved = await untilCanceled(
				this.hooks.approve(step, structuredClone(input), signal),
				signal,
			);
			if (!approved || signal.aborted) return false;
			// Approval may correct only context and brief, never substitute policy, identity or workspace.
			return { ...input, brief: approved.brief, context: approved.context };
		};
		// One interactive picker/editor at a time, while approved workers execute concurrently.
		const next = this.approvals.then(() => untilCanceled(choose(), signal));
		this.approvals = next.catch(() => {});
		return untilCanceled(next, signal);
	}
	private async input(
		run: WorkflowRun,
		step: WorkflowStep,
		agent: AgentDefinition,
		chosen: string,
		signal: AbortSignal,
	): Promise<Dispatch> {
		const slash = chosen.indexOf("/");
		const brief = step.objective.replaceAll("{{input}}", run.input);
		const budget = agentPolicy(agent).contextBudget;
		let context = await untilCanceled(this.hooks.context(brief, agent), signal);
		for (const id of (step.contextFrom || []).filter((id) => id !== step.inspect))
			context = taskContext(context, this.tasks.get(run.steps[id].task!), budget);
		const inspected = step.inspect ? this.tasks.get(run.steps[step.inspect].task!) : undefined;
		context = taskContext(context, inspected, budget);
		return {
			parent: `workflow:${run.id}`,
			workflowStep: step.id,
			role: agent,
			provider: chosen.slice(0, slash),
			model: chosen.slice(slash + 1),
			brief,
			context,
			reviewOf: step.inspect ? run.steps[step.inspect].task : undefined,
		};
	}
	private distinctModel(run: WorkflowRun, step: WorkflowStep, input: Dispatch): void {
		if (!step.distinctModelFrom) return;
		const other = this.tasks.get(run.steps[step.distinctModelFrom].task!);
		if (`${other.provider}/${other.model}` === `${input.provider}/${input.model}`)
			throw new Error("Workflow requires a different provider/model for this step");
	}
	private outcome(task: Task, step: WorkflowStep): string {
		if (task.status !== "completed") return "failed";
		const kinds = new Set(task.artifacts?.map((a) => a.kind));
		return (step.artifacts || []).every((kind) => kinds.has(kind)) ? "completed" : "failed";
	}
	private condition(run: WorkflowRun, step: WorkflowStep): boolean {
		if (step.when !== "no-errors") return true;
		return (step.needs || []).every((id) => {
			const task = run.steps[id].task;
			return task && !this.tasks.get(task).result?.findings.some((f) => f.severity === "error");
		});
	}
}
