import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { assertNoSecrets } from "../memory.ts";
import type { Task } from "../orchestration/tasks.ts";
import { agentPolicy, effectivePolicy, type WorkerResources } from "./contracts.ts";
export const emptyResources = (): WorkerResources => ({ tools: [], skills: {}, extensions: {} });
export function workerTools(
	task: Task,
	builtins: ToolDefinition[],
	resources: WorkerResources,
): ToolDefinition[] {
	const policy = effectivePolicy(agentPolicy(task.role), task.effectivePolicy || {});
	const allowed = (permissions: string[]) =>
		permissions.every((p) => (policy.permissions as string[]).includes(p));
	const builtInPermissions: Record<string, string[]> = {
		read: ["read"],
		review_diff: ["read"],
		write: ["write"],
		edit: ["read", "write"],
		run_test: ["read", "test", "write"],
	};
	const tools = builtins.filter(
		(tool) => policy.tools.includes(tool.name) && allowed(builtInPermissions[tool.name] || []),
	);
	for (const registration of resources.tools) {
		if (!policy.tools.includes(registration.name)) continue;
		if (builtInPermissions[registration.name] || !allowed(registration.permissions))
			throw new Error("Custom tool permission escalation refused");
		const tool = registration.create({ cwd: task.workspace.path, task: structuredClone(task) });
		if (tool.name !== registration.name) throw new Error("Tool registration identity mismatch");
		tools.push({
			...tool,
			execute: async (...args) => {
				assertNoSecrets(args[1]);
				const result = await tool.execute(...args);
				assertNoSecrets(result);
				return result;
			},
		});
	}
	const known = [...Object.keys(builtInPermissions), ...resources.tools.map((r) => r.name)];
	if (policy.tools.some((name) => !known.includes(name)))
		throw new Error("Unknown worker tool registration");
	return tools;
}
export function resourceInstructions(task: Task, resources: WorkerResources): string {
	const policy = effectivePolicy(agentPolicy(task.role), task.effectivePolicy || {});
	const parts: string[] = [];
	for (const id of policy.skills) {
		if (!resources.skills[id]) throw new Error("Unknown approved skill registration");
		parts.push(`Approved skill ${id}:\n${resources.skills[id]}`);
	}
	for (const id of policy.extensions) {
		if (!resources.extensions[id]) throw new Error("Unknown approved instruction extension");
		parts.push(resources.extensions[id](structuredClone(task)));
	}
	const text = parts.join("\n\n");
	if (text.length > 24000) throw new Error("Worker resources exceed instruction budget");
	assertNoSecrets(text);
	return text;
}
