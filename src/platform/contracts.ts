import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Task } from "../orchestration/tasks.ts";

export const CONTRACT_VERSION = 1;
export type Permission = "read" | "write" | "test";
export interface ExecutionPolicy {
	permissions: Permission[];
	tools: string[];
	skills: string[];
	extensions: string[];
	workspace: "isolated";
	sandbox: "bubblewrap";
	maxDepth: number;
	timeoutMs: number;
	concurrency: number;
	contextBudget: number;
}
export interface AgentDefinition {
	name: string;
	description?: string;
	instructions: string;
	/** Legacy projection only. Effective policy determines privileges. */
	editing: boolean;
	model?: string;
	selection?: { instance?: string; requires?: string[] };
	policy?: Partial<ExecutionPolicy>;
	tags?: string[];
	context?: string[];
	outputs?: string[];
}
export interface Artifact {
	kind: string;
	content: string;
	source: string;
	certainty: "observed" | "claim";
}
export interface ToolRegistration {
	name: string;
	permissions: Permission[];
	create(context: { cwd: string; task: Task }): ToolDefinition;
}
export interface WorkerResources {
	tools: ToolRegistration[];
	/** Approved text resources, never executable project modules. */
	skills: Record<string, string>;
	/** Trusted programmatic instruction extensions. No Pi hooks or provider overrides. */
	extensions: Record<string, (task: Readonly<Task>) => string>;
}
export const SECURITY_CEILING: ExecutionPolicy = {
	permissions: ["read", "write", "test"],
	tools: ["read", "write", "edit", "run_test", "review_diff"],
	skills: [],
	extensions: [],
	workspace: "isolated",
	sandbox: "bubblewrap",
	maxDepth: 1,
	timeoutMs: 3600000,
	concurrency: 4,
	contextBudget: 16000,
};
export function effectivePolicy(...layers: Partial<ExecutionPolicy>[]): ExecutionPolicy {
	const result = structuredClone(SECURITY_CEILING);
	// Unknown resources are inert until a trusted registration supplies implementation.
	result.tools = [...new Set([...result.tools, ...(layers[0]?.tools || [])])];
	result.skills = [...(layers[0]?.skills || [])];
	result.extensions = [...(layers[0]?.extensions || [])];
	for (const layer of layers) restrict(result, layer);
	return result;
}
function restrict(result: ExecutionPolicy, layer: Partial<ExecutionPolicy>): void {
	for (const field of ["permissions", "tools", "skills", "extensions"] as const) {
		const allowed = layer[field] as string[] | undefined;
		if (allowed)
			(result[field] as string[]) = result[field].filter((item) => allowed.includes(item));
	}
	for (const field of ["maxDepth", "timeoutMs", "concurrency", "contextBudget"] as const) {
		const limit = layer[field];
		if (limit !== undefined) {
			if (!Number.isInteger(limit) || limit < 1) throw new Error("Invalid execution limit");
			result[field] = Math.min(result[field], limit);
		}
	}
	if (layer.workspace && layer.workspace !== "isolated")
		throw new Error("Only isolated workspaces are supported");
	if (layer.sandbox && layer.sandbox !== "bubblewrap")
		throw new Error("Sandbox cannot be disabled");
}
export function agentPolicy(agent: AgentDefinition): ExecutionPolicy {
	return effectivePolicy({
		permissions: agent.editing ? ["read", "write", "test"] : ["read"],
		...agent.policy,
	});
}
