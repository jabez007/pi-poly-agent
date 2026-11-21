import type { Task } from "./tasks.ts";
export function taskLine(task: Task, now = Date.now()): string {
	const end = task.finishedAt ? Date.parse(task.finishedAt) : now;
	const elapsed = Math.max(0, Math.round((end - Date.parse(task.startedAt)) / 1000));
	const action =
		task.status === "interrupted" ? "recovery required" : task.integration?.state || task.progress;
	return `${task.id.slice(0, 8)} ${task.role.name} ${task.provider}/${task.model} | ${task.status} ${elapsed}s | ${action} | ${task.workspace.branch}${task.result ? " | result available" : ""}`;
}
export function formatTask(task: Task): string {
	return [
		`Task ${task.id}: ${task.status}`,
		`${task.role.name} | ${task.provider}/${task.model} | parent ${task.parent}`,
		`Worktree: ${task.workspace.path}\nBranch: ${task.workspace.branch}\nBase: ${task.workspace.base}\nSnapshot: ${task.revision || "none"}\nLocal session: ${task.sessionFile || "not recorded"}`,
		`Integration: ${task.integration?.state || "not applicable"}\nReplacement of: ${task.replacementOf || "none"}\nReplaced by: ${task.replacedBy || "none"}`,
		...(task.recovery || []),
		...(task.prerequisites || []).flatMap((p) => p.details),
		preparationDescription(task),
		task.result
			? `Agent claims and sourced findings (unverified):\n${JSON.stringify(task.result, null, 2)}`
			: "",
		task.error || task.progress,
	]
		.filter(Boolean)
		.join("\n\n");
}

function preparationDescription(task: Task): string {
	return task.preparation?.length
		? `Controller-approved preparation: ${JSON.stringify(task.preparation)}`
		: "";
}
