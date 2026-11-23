import { agentPolicy, effectivePolicy, type ExecutionPolicy } from "../platform/contracts.ts";
import { existsSync } from "node:fs";
import { loadPlatform } from "../platform/config.ts";
import { ProviderRegistry } from "../platform/providers.ts";
import { WorkflowEngine, type WorkflowRun } from "../platform/workflows.ts";
import { emptyResources } from "../platform/resources.ts";
import type { WorkerResources } from "../platform/contracts.ts";
import { taskContext } from "./context.ts";
import { taskLine, formatTask } from "./presentation.ts";
import { worktreeReadiness, importNodeDependencies } from "./preparation.ts";
import { join } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadPolicy } from "../profile.ts";
import { assertNoSecrets, projectIdentity } from "../memory.ts";
import { type Role } from "./roles.ts";
import { TaskManager, type Dispatch, type Task } from "./tasks.ts";
import type { TaskRunner } from "./tasks.ts";
import { approvedTest, type ApproveTest } from "./tools.ts";
import { createPiRunner } from "./runner.ts";
import { cleanupWorkspace, workspaceDiff, git } from "./worktrees.ts";
import { reviewDiffView } from "./review-view.ts";

export function registerOrchestration(
	pi: ExtensionAPI,
	profile: string,
	contextPacket: (brief?: string, sources?: string[]) => string | Promise<string>,
	makeRunner?: (approve: ApproveTest) => TaskRunner,
	integrations: { providers?: ProviderRegistry; resources?: WorkerResources } = {},
): void {
	let manager: TaskManager | undefined;
	let workflows: WorkflowEngine | undefined;
	const registry = integrations.providers || new ProviderRegistry(() => loadPolicy(profile));
	const resources = integrations.resources || emptyResources();
	const registered = new Set(registry.list().map((p) => p.id));
	let current: ExtensionContext;
	let stopped = false;
	let generation = 0;
	const published = new Set<string>();
	const preparations = new Set<AbortController>();
	const config = () => loadPlatform(profile, current?.cwd);
	async function chooseTask(ctx: ExtensionContext, id?: string): Promise<Task | undefined> {
		const all = tasks(ctx).list().reverse();
		if (id) {
			const matches = all.filter((t) => t.id.startsWith(id));
			if (matches.length !== 1)
				throw new Error("Unknown or ambiguous task reference. Use /tasks to select one.");
			return matches[0];
		}
		if (!ctx.hasUI || ctx.mode !== "tui" || !all.length) return;
		const choices = all.slice(0, 20).map((t) => taskLine(t));
		const picked = await ctx.ui.select("Select task", choices);
		return picked ? all[choices.indexOf(picked)] : undefined;
	}
	function configure(): void {
		for (const instance of config().providers)
			if (!registered.has(instance.id)) {
				registry.register(instance);
				registered.add(instance.id);
			}
	}
	function inspectionAgent(): Role {
		const role =
			config().agents.find((a) => a.name === "reviewer") ||
			config().agents.find((a) => a.tags?.includes("inspection") && !a.editing);
		if (!role)
			throw new Error(
				"No inspection agent configured. Use /workflow or define an agent tagged inspection.",
			);
		return role;
	}
	function publish(task: Task): void {
		const active = manager ? manager.list().filter((t) => t.status === "running") : [];
		if (config().ui.status)
			current.ui.setStatus(
				"poly-tasks",
				active.length
					? active
							.slice(0, 4)
							.map((t) => taskLine(t))
							.join(" | ")
					: "Workers idle | /tasks",
			);
		if (task.status === "running" || stopped || published.has(task.id)) return;
		published.add(task.id);
		if (config().ui.notifications)
			current.ui.notify(
				`${task.role.name} ${task.id.slice(0, 8)} ${task.status}${task.reviewOf ? "; review available" : ""}. ${task.integration?.state === "awaiting_review" ? "Independent review required." : ""} /tasks`,
				task.status === "completed" ? "info" : "warning",
			);
		pi.appendEntry("poly-task-complete", task);
		pi.sendMessage(
			{
				customType: "poly-task-result",
				display: true,
				content: formatTask(task),
				details: {
					taskId: task.id,
					parent: task.parent,
					provider: task.provider,
					model: task.model,
				},
			},
			{ triggerTurn: false },
		);
	}
	function tasks(ctx: ExtensionContext): TaskManager {
		current = ctx;
		configure();
		if (!manager) {
			const project = projectIdentity(ctx.cwd);
			manager = new TaskManager(
				join(profile, "tasks", project.wing),
				ctx.cwd,
				() => loadPolicy(profile),
				(
					makeRunner ||
					((approve) => createPiRunner(profile, approve, undefined, registry, resources))
				)(async (command, cwd, signal) => {
					if (signal.aborted || !current.hasUI || current.mode !== "tui") return false;
					return current.ui.confirm(
						"Run this test once in an isolated sandbox?",
						`${command}\nWorktree: ${cwd}\nNetwork and host credentials are unavailable. The command may modify this task's worktree.`,
					);
				}),
				config().concurrency,
				config().timeoutMs,
				publish,
				prepareWorker,
				registry,
				config().policy,
			);
			for (const notice of manager.diagnostics) ctx.ui.notify(notice, "warning");
			const recoverable = manager
				.list()
				.filter((t) => t.status === "interrupted" || t.integration?.state === "interrupted");
			if (recoverable.length)
				ctx.ui.notify(
					`${recoverable.length} interrupted tasks need inspection. Use /tasks or /task ID recover. No request was replayed.`,
					"warning",
				);
		}
		return manager;
	}
	async function prepareWorker(task: Task, signal: AbortSignal): Promise<void> {
		const checks = worktreeReadiness(task.workspace.path);
		if (!checks.length) return;
		current.ui.notify(checks.flatMap((c) => c.details).join("\n"), "info");
		if (!task.role.editing || !checks.some((c) => c.kind === "node" && !c.ready)) return;
		const approved = await current.ui.confirm(
			"Prepare dependencies for this worker?",
			"Copy the parent's node_modules through secret screening into this isolated worktree. No installer, network request, or lifecycle script runs. Decline to continue without dependencies.",
		);
		if (signal.aborted) throw new Error("Canceled preparation");
		if (approved) importNodeDependencies(task.workspace);
	}
	async function prepareExisting(ctx: ExtensionContext, task: Task, command = ""): Promise<void> {
		if (!ctx.hasUI || ctx.mode !== "tui" || task.status === "running")
			throw new Error("Preparation requires an inactive task and interactive approval");
		assertPreparation(task, command, config().policy);
		if (command) {
			const controller = new AbortController();
			preparations.add(controller);
			try {
				const details = await approvedTest(
					command,
					task.workspace.path,
					async (text, cwd) =>
						ctx.ui.confirm(
							"Run preparation command once in the sandbox?",
							`${text}\n${cwd}\nNo networking or host credentials. Inspect lifecycle scripts yourself before approving.`,
						),
					controller.signal,
				);
				if (controller.signal.aborted)
					throw new Error("Preparation canceled by session shutdown or switch");
				tasks(ctx).recordPreparation(task.id, command, details.exitCode);
				ctx.ui.notify(`Preparation exit ${details.exitCode}\n${details.output}`, "info");
			} finally {
				preparations.delete(controller);
			}
			return;
		}
		ctx.ui.notify(
			worktreeReadiness(task.workspace.path)
				.flatMap((p) => p.details)
				.join("\n") || "No recognized manifests.",
			"info",
		);
		if (
			await ctx.ui.confirm(
				"Copy screened parent dependencies?",
				`Copy node_modules into ${task.workspace.path}. No network or installer; source changes retained.`,
			)
		)
			importNodeDependencies(task.workspace);
	}
	async function recoverTask(ctx: ExtensionContext, task: Task): Promise<void> {
		ctx.ui.notify(formatTask(task), "info");
		const choice = await modelChoice(ctx, task.role);
		if (choice) await launch(ctx, task.role, task.brief, choice, task.reviewOf, task.id);
	}
	async function taskActions(ctx: ExtensionContext, task: Task): Promise<void> {
		ctx.ui.notify(formatTask(task), "info");
		const actions = ["Inspect diff", "Leave for later"];
		if (task.status === "completed" && task.role.editing)
			actions.unshift("Review implementation", "Inspect review and integrate");
		if (["failed", "canceled", "timed_out", "interrupted"].includes(task.status))
			actions.unshift("Recover with a new worker");
		if (task.status === "running") actions.unshift("Cancel worker");
		const choice = await ctx.ui.select("Task actions", actions);
		if (choice === "Inspect diff")
			ctx.ui.notify(workspaceDiff(task.workspace).diff || "No source diff.", "info");
		if (choice === "Recover with a new worker") await recoverTask(ctx, task);
		if (choice === "Cancel worker") await manager!.cancel(task.id);
		if (choice === "Inspect review and integrate") await integrateTask(ctx, task, manager!);
		if (choice === "Review implementation") {
			const role = inspectionAgent();
			const model = await modelChoice(ctx, role, task.workflowReviewModel);
			if (model)
				await launch(ctx, role, `Independently review ${task.id}: ${task.brief}`, model, task.id);
		}
	}
	async function modelChoice(
		ctx: ExtensionContext,
		role: Role,
		explicit?: string,
	): Promise<string | undefined> {
		configure();
		if (explicit || role.model) {
			const model = explicit || role.model!;
			if (role.model && explicit && model !== role.model)
				throw new Error("Agent requires its configured exact model");
			registry.assert(model.split("/")[0], 1);
			return model;
		}
		if (role.selection) return registry.resolve(role.selection, ctx.modelRegistry.getAvailable());
		const available = ctx.modelRegistry
			.getAvailable()
			.filter((model) => {
				try {
					return registry.capabilities(model.provider).delegation;
				} catch {
					return false;
				}
			})
			.map((model) => `${model.provider}/${model.id}`);
		if (role.model && available.includes(role.model))
			available.unshift(...available.splice(available.indexOf(role.model), 1));
		return ctx.ui.select(`Select ${role.name} provider/model`, available);
	}
	async function launch(
		ctx: ExtensionContext,
		role: Role,
		brief: string,
		model: string,
		reviewOf?: string,
		replacementOf?: string,
		workflowReviewModel?: string,
		requestBudget?: Dispatch["requestBudget"],
	): Promise<Task | undefined> {
		const epoch = generation;
		if (!ctx.hasUI || ctx.mode !== "tui")
			throw new Error("Delegation requires interactive authorization");
		const slash = model.indexOf("/");
		if (slash < 1) throw new Error("Choose provider/model explicitly");
		const provider = model.slice(0, slash);
		registry.assert(provider, 1);
		const list = tasks(ctx);
		const reference = reviewOf || replacementOf;
		const previous = reference ? list.get(reference) : undefined;
		const execution = effectivePolicy(agentPolicy(role), config().policy);
		const context = taskContext(
			await contextPacket(brief, role.context),
			previous,
			execution.contextBudget,
		);
		assertNoSecrets({ brief, context });
		const draft = await ctx.ui.editor(
			"Review focused task context. No parent transcript is inherited.",
			JSON.stringify({ brief, context }, null, 2),
		);
		if (!draft) return;
		const edited = parseTaskPacket(draft);
		if (
			!(await ctx.ui.confirm(
				`Launch ${role.name} with ${model}?`,
				replacementOf
					? "Create a NEW worker from preserved source changes. This captures a task-only snapshot, retains the original task, and does not restore provider-private execution state."
					: launchDescription(execution, registry.get(provider), requestBudget),
			))
		)
			return;
		const input: Dispatch = {
			parent: ctx.sessionManager.getSessionId(),
			role,
			provider,
			model: model.slice(slash + 1),
			brief: edited.brief,
			context: edited.context,
			depth: 1,
			reviewOf,
			replacementOf,
			workflowReviewModel,
			requestBudget,
		};
		if (epoch !== generation || stopped) throw new Error("Session changed; task launch canceled");
		const task = list.dispatch(input);
		ctx.ui.notify(`Started ${task.id} (${role.name}, ${model}). Use /tasks or /task.`, "info");
		return task;
	}
	async function delegate(args: string, ctx: ExtensionContext): Promise<void> {
		current = ctx;
		configure();
		const [requested, model, ...words] = args.trim().split(/\s+/);
		const name =
			requested ||
			(ctx.hasUI && ctx.mode === "tui"
				? await ctx.ui.select(
						"Select agent",
						config().agents.map((a) => a.name),
					)
				: undefined);
		const chosenRole = config().agents.find((r) => r.name === name);
		if (!chosenRole) {
			ctx.ui.notify(
				`Usage: /delegate AGENT [instance/model] task brief. Agents: ${
					config()
						.agents.map((a) => a.name)
						.join(", ") || "none configured"
				}`,
				"info",
			);
			return;
		}
		const explicit = model?.includes("/") ? model : undefined;
		const brief =
			(explicit ? words : [model, ...words]).filter(Boolean).join(" ") ||
			(await ctx.ui.input("Task objective and acceptance criteria"));
		if (!brief) return;
		const choice = await modelChoice(ctx, chosenRole, explicit);
		if (choice) await launch(ctx, chosenRole, brief, choice);
	}
	pi.registerCommand("agents", {
		description: "Show roles and provider delegation capabilities",
		handler: async (args, ctx) => {
			current = ctx;
			configure();
			const rows = registry
				.list()
				.map((instance) => ({ provider: instance.id, ...registry.capabilities(instance.id) }));
			ctx.ui.notify(
				`${config()
					.agents.map(
						(r) =>
							`${r.name}: ${r.editing ? "isolated editing" : "read only"}${r.model ? ` (${r.model})` : ""}`,
					)
					.join(
						"\n",
					)}\n\n${args.trim() === "details" ? JSON.stringify(rows, null, 2) : rows.map((row) => `${row.provider}: direct ${row.direct ? "allowed" : "locked"}, worker ${row.delegation ? "allowed" : "blocked"}, ${row.billing}`).join("\n")}\nPolicy permissions shown. Model availability requires supported login; /agents details lists all capabilities.`,
				"info",
			);
		},
	});
	pi.registerCommand("delegate", {
		description: "Launch a focused independent agent",
		handler: delegate,
	});
	pi.registerCommand("poly-qualify", {
		description: "Explicitly approve one bounded, tool-free provider qualification request",
		handler: async (args, ctx) => {
			current = ctx;
			if (!ctx.hasUI || ctx.mode !== "tui")
				throw new Error("Qualification requires direct interactive approval");
			const role: Role = {
				name: "qualification-probe",
				editing: false,
				instructions:
					"This is a bounded qualification observation. Do not call any tools. Return the required structured JSON with a short summary and empty arrays. Do not claim any other capability was verified.",
				context: ["native"],
				policy: {
					permissions: ["read"],
					tools: [],
					skills: [],
					extensions: [],
					timeoutMs: 30000,
					contextBudget: 512,
				},
			};
			const model = await modelChoice(ctx, role, args.trim() || undefined);
			if (model)
				await launch(
					ctx,
					role,
					"Return a brief response confirming this single request completed. No tool, cancellation, quota, or multi-agent qualification is implied.",
					model,
					undefined,
					undefined,
					undefined,
					{ requests: 1, outputTokens: 512 },
				);
		},
	});
	pi.registerCommand("tasks", {
		description: "Inspect active and recovered work, results, and next actions",
		handler: async (args, ctx) => {
			const all = tasks(ctx).list().reverse();
			ctx.ui.notify(all.map((t) => taskLine(t)).join("\n") || "No tasks.", "info");
			if (!all.length || args.trim() === "all" || !ctx.hasUI || ctx.mode !== "tui") return;
			const choices = all.slice(0, 20).map((t) => taskLine(t));
			const selected = await ctx.ui.select("Inspect task (most recent 20)", choices);
			if (selected) await taskActions(ctx, all[choices.indexOf(selected)]);
		},
	});
	async function workflow(args: string, ctx: ExtensionContext): Promise<void> {
		if (!ctx.hasUI || ctx.mode !== "tui")
			throw new Error("Workflow requires interactive authorization");
		current = ctx;
		const [requested, ...words] = args.trim().split(/\s+/);
		const name =
			requested ||
			(await ctx.ui.select(
				"Select workflow",
				config().workflows.map((w) => w.id),
			));
		const definition = config().workflows.find((w) => w.id === name);
		if (!definition) {
			ctx.ui.notify(
				`Workflows: ${
					config()
						.workflows.map((w) => w.id)
						.join(", ") || "none configured"
				}`,
				"info",
			);
			return;
		}
		const brief =
			words.join(" ") || (await ctx.ui.input("Workflow objective and acceptance criteria"));
		if (!brief) return;
		const engine = workflowHost(ctx);
		const run = engine.start(definition, brief, ctx.sessionManager.getSessionId());
		const epoch = generation;
		void engine
			.wait(run.id)
			.then(async (completed) => {
				if (stopped || epoch !== generation || completed.status !== "completed") return;
				const editing = Object.values(completed.steps)
					.map((s) => (s.task ? manager!.get(s.task) : undefined))
					.find((t) => t?.role.editing);
				if (editing) await taskActions(ctx, editing);
			})
			.catch(() =>
				ctx.ui.notify("Workflow results retained. Use /tasks to inspect them.", "warning"),
			);
		ctx.ui.notify(`Workflow ${run.id} started. Each step requires approval.`, "info");
	}
	function workflowHost(ctx: ExtensionContext): WorkflowEngine {
		const host = tasks(ctx);
		return (workflows ??= new WorkflowEngine(
			join(profile, "tasks", projectIdentity(ctx.cwd).wing, "workflows"),
			host,
			config().agents,
			{
				model: (agent, model) => modelChoice(ctx, agent, model),
				context: async (objective, agent) => await contextPacket(objective, agent.context),
				approve: async (step, input, signal) => {
					const epoch = generation;
					const previous = input.reviewOf ? host.get(input.reviewOf) : undefined;
					const edited = await ctx.ui.editor(
						"Review focused task context. No parent transcript is inherited.",
						JSON.stringify(
							{ brief: input.brief, context: taskContext(input.context || "", previous) },
							null,
							2,
						),
					);
					if (!edited || signal.aborted) return false;
					const packet = parseTaskPacket(edited);
					const approved = await ctx.ui.confirm(
						step.approval || `Launch ${input.role.name} with ${input.provider}/${input.model}?`,
						`Independent authorized worker, isolated worktree. Effective permissions: ${effectivePolicy(agentPolicy(input.role), config().policy).permissions.join(", ")}. Test commands require separate approval.`,
					);
					return approved && !signal.aborted && epoch === generation && !stopped
						? { ...input, ...packet }
						: false;
				},
				changed: (run) => {
					if (config().ui.status)
						ctx.ui.setStatus(
							"poly-workflow",
							run.status === "waiting_approval"
								? `Workflow ${run.id.slice(0, 8)}: approval required`
								: undefined,
						);
					if (
						config().ui.notifications &&
						["completed", "failed", "interrupted"].includes(run.status)
					)
						ctx.ui.notify(
							`Workflow ${run.id.slice(0, 8)} ${run.status}. /tasks and /workflow-runs show preserved results.`,
							"info",
						);
				},
			},
			config().concurrency,
		));
	}
	pi.registerCommand("workflow", {
		description: "Run any configured sequential or parallel recipe",
		handler: workflow,
	});
	pi.registerCommand("workflow-runs", {
		description: "Inspect, cancel, or explicitly continue interrupted workflow runs",
		handler: async (args, ctx) => {
			let [id, action] = args.trim().split(/\s+/);
			const engine = workflowHost(ctx);
			if (!id) {
				ctx.ui.notify(JSON.stringify(engine.list(), null, 2), "info");
				const chosen = await selectRun(ctx, engine.list());
				if (!chosen) return;
				id = chosen.id;
				action = chosen.action;
			}
			if (id && action === "cancel") await engine.cancel(id);
			if (id && action === "continue") {
				const approved = await ctx.ui.confirm(
					"Continue interrupted workflow?",
					"Reuse validated completed artifacts. Pending steps require new approval. No provider session is resumed and completed operations are not replayed.",
				);
				engine.continueRun(id, ctx.sessionManager.getSessionId(), approved);
			}
			ctx.ui.notify(JSON.stringify(engine.list(), null, 2), "info");
		},
	});
	if (config().workflows.some((w) => w.id === "implementation-review"))
		pi.registerCommand("implement", {
			description: "Compatibility alias for /workflow implementation-review",
			handler: (args, ctx) => workflow(`implementation-review ${args}`, ctx),
		});
	if (config().agents.some((a) => a.name === "reviewer" || a.tags?.includes("inspection")))
		pi.registerCommand("review", {
			description: "Launch an independent read-only review of a completed editing task",
			handler: async (args, ctx) => {
				const [id, explicit] = args.trim().split(/\s+/);
				const builder = await chooseTask(ctx, id);
				if (!builder) return;
				const role = inspectionAgent();
				const choice = await modelChoice(ctx, role, explicit);
				if (choice)
					await launch(
						ctx,
						role,
						`Independently review task ${builder.id}. Inspect changed files against acceptance criteria: ${builder.brief}. Report defects with paths and lines, tests missing, and remaining risks.`,
						choice,
						builder.id,
					);
			},
		});
	pi.registerCommand("task", {
		description: "Inspect, cancel, diff, integrate, or clean a task",
		handler: async (args, ctx) => {
			const [reference, action = "show", ...command] = args.trim().split(/\s+/);
			const list = tasks(ctx);
			const task = await chooseTask(ctx, reference);
			if (!task) return;
			if (!reference) {
				await taskActions(ctx, task);
				return;
			}
			const id = task.id;
			if (action === "cancel") {
				await list.cancel(id);
				return;
			}
			if (action === "diff") {
				ctx.ui.notify(workspaceDiff(task.workspace).diff || "No source diff.", "info");
				return;
			}
			if (action === "integrate") {
				await integrateTask(ctx, task, list);
				return;
			}
			if (action === "recover") {
				await recoverTask(ctx, task);
				return;
			}
			if (action === "prepare") {
				await prepareExisting(ctx, task, command.join(" "));
				return;
			}
			if (action === "next") {
				await taskActions(ctx, task);
				return;
			}
			if (action === "cleanup") {
				await cleanupTask(ctx, task);
				return;
			}
			ctx.ui.notify(formatTask(task), "info");
		},
	});
	pi.registerTool({
		name: "delegate_task",
		label: "Delegate task",
		description:
			"Request a depth-one independent task. Requires interactive user approval and an authorized provider/model. Google ACP and Claude subscription workers are forbidden.",
		parameters: Type.Object({
			role: Type.String(),
			model: Type.String(),
			brief: Type.String({ maxLength: 6000 }),
			reviewOf: Type.Optional(Type.String()),
		}),
		execute: async (_id, args: any, _signal, _update, ctx) => {
			current = ctx;
			configure();
			registry.assert(ctx.model?.provider || "", 1);
			const role = config().agents.find((r) => r.name === args.role);
			if (!role) throw new Error("Unknown role");
			const task = await launch(ctx, role, args.brief, args.model, args.reviewOf);
			return {
				content: [
					{
						type: "text",
						text: task
							? JSON.stringify({ id: task.id, status: task.status })
							: "Delegation declined",
					},
				],
				details: { taskId: task?.id },
			};
		},
	});
	pi.registerTool({
		name: "task_status",
		label: "Inspect delegated task",
		description:
			"Read durable task status and structured results. Does not start a provider or wait in a polling loop.",
		parameters: Type.Object({ id: Type.String() }),
		execute: async (_id, args: any, _signal, _update, ctx) => {
			const task = tasks(ctx).get(args.id);
			return {
				content: [{ type: "text", text: formatTask(task) }],
				details: { taskId: task.id, status: task.status },
			};
		},
	});
	pi.on("session_start", async (_event, ctx) => {
		current = ctx;
		if (
			ctx.hasUI &&
			ctx.mode === "tui" &&
			(config().agents.length || existsSync(join(profile, "tasks", projectIdentity(ctx.cwd).wing)))
		) {
			tasks(ctx);
			workflowHost(ctx);
		}
	});
	pi.on("session_before_switch", async () => {
		generation++;
		for (const controller of preparations) controller.abort();
		await workflows?.close();
		workflows = undefined;
		if (manager) {
			stopped = true;
			await manager.close();
			manager = undefined;
		}
		stopped = false;
	});
	pi.on("session_shutdown", async () => {
		generation++;
		for (const controller of preparations) controller.abort();
		stopped = true;
		await workflows?.close();
		await manager?.close();
	});
}

async function integrateTask(
	ctx: ExtensionContext,
	task: Task,
	manager: TaskManager,
): Promise<void> {
	if (task.status !== "completed" || !task.role.editing || !task.revision)
		throw new Error("Only completed editing task snapshots can be integrated");
	const reviews = manager
		.list()
		.filter(
			(r) =>
				r.reviewOf === task.id &&
				!r.role.editing &&
				r.status === "completed" &&
				(r.reviewRevision || r.workspace.base) === task.revision,
		);
	if (!reviews.length) throw new Error("Complete an independent review before integration");
	if (
		git(task.workspace.path, ["status", "--porcelain"]) ||
		git(task.workspace.path, ["rev-parse", "HEAD"]) !== task.revision
	)
		throw new Error("Task worktree changed after review; request a new review before integration");
	const diff = reviewDiffView(task.workspace.path, task.workspace.base, task.revision);
	ctx.ui.notify(
		`${diff}\n\nReview findings:\n${reviews.map((r) => JSON.stringify(r.result)).join("\n")}`,
		"info",
	);
	if (
		ctx.hasUI &&
		ctx.mode === "tui" &&
		(await ctx.ui.confirm(
			"Integrate the reviewed task snapshot?",
			"Cherry-pick into the clean, unchanged parent branch. Review all findings and the diff first.",
		))
	)
		manager.integrate(task.id);
}

async function selectRun(
	ctx: ExtensionContext,
	runs: WorkflowRun[],
): Promise<{ id: string; action: string } | undefined> {
	if (!ctx.hasUI || ctx.mode !== "tui" || !runs.length) return;
	const choices = runs.map((r) => `${r.id.slice(0, 8)} ${r.definition.id}: ${r.status}`);
	const selected = await ctx.ui.select("Select workflow run", choices);
	const run = selected ? runs[choices.indexOf(selected)] : undefined;
	if (!run) return;
	const actions = ["Inspect preserved results", "Leave for later"];
	if (run.status === "interrupted") actions.unshift("Continue from validated checkpoints");
	if (["running", "waiting_approval"].includes(run.status)) actions.push("Cancel workflow");
	const choice = await ctx.ui.select("Workflow actions", actions);
	if (choice === "Continue from validated checkpoints") return { id: run.id, action: "continue" };
	if (choice === "Cancel workflow") return { id: run.id, action: "cancel" };
	if (choice === "Inspect preserved results") ctx.ui.notify(JSON.stringify(run, null, 2), "info");
	return;
}

function parseTaskPacket(text: string): { brief: string; context: string } {
	try {
		const value = JSON.parse(text);
		if (typeof value?.brief !== "string" || typeof value?.context !== "string")
			throw new Error("Invalid fields");
		assertNoSecrets(value);
		return { brief: value.brief, context: value.context };
	} catch {
		throw new Error("Invalid or sensitive task brief; values withheld");
	}
}

function assertPreparation(
	task: Task,
	command: string,
	restrictions: Partial<ExecutionPolicy>,
): void {
	const permissions = effectivePolicy(
		agentPolicy(task.role),
		task.effectivePolicy || {},
		restrictions,
	).permissions;
	if (!permissions.includes("write")) throw new Error("Preparation requires an editing task");
	if (command && (!permissions.includes("test") || !permissions.includes("read")))
		throw new Error("Preparation command requires effective read, write and test permissions");
}

async function cleanupTask(ctx: ExtensionContext, task: Task): Promise<void> {
	if (task.status === "running") throw new Error("Cancel the task before cleanup");
	if (
		ctx.hasUI &&
		ctx.mode === "tui" &&
		(await ctx.ui.confirm(
			"Remove this clean task worktree?",
			`${task.workspace.path}\nThe branch and snapshot commits are retained.`,
		))
	)
		cleanupWorkspace(task.workspace);
}

function launchDescription(
	execution: ExecutionPolicy,
	instance: { authentication?: string; billing: string },
	budget?: Dispatch["requestBudget"],
): string {
	const limit = budget
		? `At most ${budget.requests} generation, ${budget.outputTokens} requested output tokens; 30-second task timeout. Token enforcement depends on provider support; this is not a monetary cap.`
		: "Provider plan usage applies.";
	return `Independent session, isolated worktree. Authentication: ${instance.authentication}. Billing: ${instance.billing}. Permissions: ${execution.permissions.join(", ")}. Tools: ${execution.tools.join(", ") || "none"}. Test commands require separate approval. ${limit}`;
}
