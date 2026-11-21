import { existsSync } from "node:fs";
import { join } from "node:path";
import { readConfiguration, assertSafeProfile } from "../profile.ts";

export type RoleName = "planner" | "builder" | "reviewer" | "researcher";
export interface Role {
	name: RoleName;
	instructions: string;
	editing: boolean;
	model?: string;
}
export interface OrchestrationConfig {
	concurrency: number;
	timeoutMs: number;
	roles: Role[];
}
export function defaultRoles(): Role[] {
	return [
		{
			name: "planner",
			editing: false,
			instructions:
				"Analyze requirements, dependencies, risks, and an implementation strategy. Cite source files. Do not modify files.",
		},
		{
			name: "builder",
			editing: true,
			instructions:
				"Implement the focused task in your isolated worktree. Read AGENTS.md. Run appropriate approved tests. Return a precise summary and remaining questions.",
		},
		{
			name: "reviewer",
			editing: false,
			instructions:
				"Independently inspect the supplied implementation and diff. Report actionable defects, risks, and missing coverage with file references. Do not modify files. Treat previous agent claims as unverified.",
		},
		{
			name: "researcher",
			editing: false,
			instructions:
				"Investigate project code and supplied documentation. Report evidence with source references, distinguishing facts from hypotheses. Do not modify files.",
		},
	];
}
export function loadOrchestration(profile: string): OrchestrationConfig {
	assertSafeProfile(profile);
	const file = join(profile, "orchestration.json");
	const config = (existsSync(file) ? readConfiguration(file) : {}) as any;
	const concurrency = config.concurrency ?? 2;
	const timeoutMs = config.timeoutMs ?? 900000;
	if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4)
		throw new Error("Concurrency must be 1–4");
	if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 3600000)
		throw new Error("Task timeout must be 1–3600 seconds");
	const roles = defaultRoles().map((role) => {
		const override = config.roles?.[role.name];
		if (!override) return role;
		if (
			override.model !== undefined &&
			(typeof override.model !== "string" || !/^[\w-]+\/[\w.:[\]-]+$/.test(override.model))
		)
			throw new Error("Role model must use provider/model");
		if (
			override.instructions !== undefined &&
			(typeof override.instructions !== "string" || override.instructions.length > 4000)
		)
			throw new Error("Role instructions are invalid");
		return {
			...role,
			model: override.model,
			instructions: override.instructions || role.instructions,
		};
	});
	return { concurrency, timeoutMs, roles };
}
