import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readConfiguration, assertSafeProfile } from "../profile.ts";

/** Compatibility names remain ordinary configurable agents. */
export type RoleName = string;
export type Role = import("../platform/contracts.ts").AgentDefinition;
export interface OrchestrationConfig {
	concurrency: number;
	timeoutMs: number;
	roles: Role[];
}
export function defaultRoles(): Role[] {
	const recipe = JSON.parse(
		readFileSync(join(import.meta.dirname, "../../recipes/implementation-review.json"), "utf8"),
	);
	return Object.entries(recipe.agents).map(([name, definition]) => {
		const agent = definition as Role;
		return { ...agent, name, editing: !!agent.policy?.permissions?.includes("write") };
	});
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
	const examples = defaultRoles();
	if (Object.keys(config.roles || {}).some((name) => !examples.some((r) => r.name === name)))
		throw new Error("Unknown legacy role. Define arbitrary agents in platform.json instead.");
	const roles = examples.map((role) => {
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
