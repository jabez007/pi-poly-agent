import { join } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadPolicy } from "../profile.ts";
import { assertNoSecrets, projectIdentity } from "../memory.ts";
import { MANAGED_PROVIDERS, assertDelegation, providerCapabilities } from "./capabilities.ts";
import { loadOrchestration, type Role } from "./roles.ts";
import { TaskManager, type Dispatch, type Task } from "./tasks.ts";
import type { TaskRunner } from "./tasks.ts";
import type { ApproveTest } from "./tools.ts";
import { createPiRunner } from "./runner.ts";
import { cleanupWorkspace, integrateWorkspace, workspaceDiff, git } from "./worktrees.ts";

export function registerOrchestration(
	pi: ExtensionAPI,
	profile: string,
	contextPacket: () => string,
	makeRunner: (approve: ApproveTest) => TaskRunner = (approve) => createPiRunner(profile, approve),
): void {
	let manager: TaskManager | undefined;
	let current: ExtensionContext;
	let stopped = false;
	const config = () => loadOrchestration(profile);
	function publish(task: Task): void {
		current?.ui.setStatus(
			"poly-tasks",
			manager
				?.list()
				.map((t) => `${t.id.slice(0, 8)} ${t.role.name}:${t.status}`)
				.join(" | ") || "",
		);
		if (task.status === "running" || stopped) return;
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
		if (!manager) {
			const project = projectIdentity(ctx.cwd);
			manager = new TaskManager(
				join(profile, "tasks", project.wing),
				ctx.cwd,
				() => loadPolicy(profile),
				makeRunner(async (command, cwd, signal) => {
					if (signal.aborted || !current.hasUI || current.mode !== "tui") return false;
					return current.ui.confirm(
						"Run this test once in an isolated sandbox?",
						`${command}\nWorktree: ${cwd}\nNetwork and host credentials are unavailable. The command may modify this task's worktree.`,
					);
				}),
				config().concurrency,
				config().timeoutMs,
				publish,
			);
		}
		return manager;
	}
	async function modelChoice(
		ctx: ExtensionContext,
		role: Role,
		explicit?: string,
	): Promise<string | undefined> {
		if (explicit) return explicit;
		const available = ctx.modelRegistry
			.getAvailable()
			.filter((model) => providerCapabilities(model.provider, loadPolicy(profile)).delegation)
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
	): Promise<Task | undefined> {
		if (!ctx.hasUI || ctx.mode !== "tui")
			throw new Error("Delegation requires interactive authorization");
		const slash = model.indexOf("/");
		if (slash < 1) throw new Error("Choose provider/model explicitly");
		const provider = model.slice(0, slash);
		assertDelegation(provider, loadPolicy(profile), 1);
		const list = tasks(ctx);
		const previous = reviewOf ? list.get(reviewOf) : undefined;
		const context = [
			contextPacket(),
			previous
				? `Independent review of ${previous.id}\nRevision: ${previous.revision}\nChanged files: ${previous.result?.files.join(", ")}\nPrevious agent result (unverified):\n${JSON.stringify(previous.result)}`
				: "",
		]
			.filter(Boolean)
			.join("\n\n");
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
				"Independent session, isolated worktree, depth 1. Test commands require separate approval. Provider plan usage applies.",
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
		};
		const task = list.dispatch(input);
		ctx.ui.notify(`Started ${task.id} (${role.name}, ${model}). Use /tasks or /task.`, "info");
		return task;
	}
	async function delegate(args: string, ctx: ExtensionContext): Promise<void> {
		const [name, model, ...words] = args.trim().split(/\s+/);
		const chosenRole = config().roles.find((r) => r.name === name);
		if (!chosenRole) {
			ctx.ui.notify(
				"Usage: /delegate planner|builder|reviewer|researcher [provider/model] task brief",
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
			const rows = MANAGED_PROVIDERS.map((id) => ({
				provider: id,
				...providerCapabilities(id, loadPolicy(profile)),
			}));
			ctx.ui.notify(
				`${config()
					.roles.map(
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
	pi.registerCommand("tasks", {
		description: "List task state and provider attribution",
		handler: async (_args, ctx) => {
			ctx.ui.notify(
				tasks(ctx)
					.list()
					.map((t) => `${t.id} ${t.role.name} ${t.provider}/${t.model}: ${t.status}`)
					.join("\n") || "No tasks.",
				"info",
			);
		},
	});
	pi.registerCommand("review", {
		description: "Launch an independent read-only review of a completed builder",
		handler: async (args, ctx) => {
			const [id, explicit] = args.trim().split(/\s+/);
			const builder = tasks(ctx).get(id);
			const role = config().roles.find((r) => r.name === "reviewer")!;
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
			const [id, action = "show"] = args.trim().split(/\s+/);
			const list = tasks(ctx);
			const task = list.get(id);
			if (action === "cancel") {
				await list.cancel(id);
				return;
			}
			if (action === "diff") {
				ctx.ui.notify(workspaceDiff(task.workspace).diff || "No source diff.", "info");
				return;
			}
			if (action === "integrate") {
				await integrateTask(ctx, task, list.list());
				return;
			}
			if (action === "cleanup") {
				if (task.status === "running") throw new Error("Cancel the task before cleanup");
				if (
					await ctx.ui.confirm(
						"Remove this clean task worktree?",
						`${task.workspace.path}\nThe branch and snapshot commits are retained.`,
					)
				)
					cleanupWorkspace(task.workspace);
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
			role: Type.Union([
				Type.Literal("planner"),
				Type.Literal("builder"),
				Type.Literal("reviewer"),
				Type.Literal("researcher"),
			]),
			model: Type.String(),
			brief: Type.String({ maxLength: 6000 }),
			reviewOf: Type.Optional(Type.String()),
		}),
		execute: async (_id, args: any, _signal, _update, ctx) => {
			assertDelegation(ctx.model?.provider || "", loadPolicy(profile), 1);
			const role = config().roles.find((r) => r.name === args.role);
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
	pi.on("session_before_switch", async () => {
		if (manager) {
			stopped = true;
			await manager.close();
			manager = undefined;
		}
		stopped = false;
	});
	pi.on("session_shutdown", async () => {
		stopped = true;
		await manager?.close();
	});
}

function formatTask(task: Task): string {
	return [
		`Task ${task.id}: ${task.status}`,
		`${task.role.name} | ${task.provider}/${task.model} | parent ${task.parent}`,
		`Worktree: ${task.workspace.path}\nBranch: ${task.workspace.branch}\nBase: ${task.workspace.base}\nSnapshot: ${task.revision || "none"}`,
		task.result ? JSON.stringify(task.result, null, 2) : task.error || task.progress,
	].join("\n\n");
}
async function integrateTask(ctx: ExtensionContext, task: Task, all: Task[]): Promise<void> {
	if (task.status !== "completed" || !task.role.editing || !task.revision)
		throw new Error("Only completed builder snapshots can be integrated");
	const reviews = all.filter((r) => r.reviewOf === task.id && r.status === "completed");
	if (!reviews.length) throw new Error("Complete an independent review before integration");
	if (
		git(task.workspace.path, ["status", "--porcelain"]) ||
		git(task.workspace.path, ["rev-parse", "HEAD"]) !== task.revision
	)
		throw new Error(
			"Builder worktree changed after review; request a new review before integration",
		);
	const diff = workspaceDiff(task.workspace).diff;
	ctx.ui.notify(
		`${diff}\n\nReview findings:\n${reviews.map((r) => JSON.stringify(r.result)).join("\n")}`,
		"info",
	);
	if (
		ctx.hasUI &&
		ctx.mode === "tui" &&
		(await ctx.ui.confirm(
			"Integrate the reviewed builder snapshot?",
			"Cherry-pick into the clean, unchanged parent branch. Review all findings and the diff first.",
		))
	)
		integrateWorkspace(task.workspace, task.revision);
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
