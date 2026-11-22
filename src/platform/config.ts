import { nativePackageConfiguration } from "./pi-resources.ts";
import { git } from "../orchestration/worktrees.ts";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { assertSafeProfile, readConfiguration } from "../profile.ts";
import { assertNoSecrets } from "../memory.ts";
import { agentPolicy, type AgentDefinition, type ExecutionPolicy } from "./contracts.ts";
import type { ProviderInstance } from "./providers.ts";
import { defaultRoles, loadOrchestration } from "../orchestration/roles.ts";
import { validateWorkflow, type WorkflowDefinition } from "./workflows.ts";

export interface PlatformConfig {
	version: 1;
	legacy: boolean;
	agents: AgentDefinition[];
	workflows: WorkflowDefinition[];
	providers: ProviderInstance[];
	policy: Partial<ExecutionPolicy>;
	concurrency: number;
	timeoutMs: number;
	ui: { status: boolean; notifications: boolean };
	context: string[];
}
const agentRestrictions = new WeakMap<PlatformConfig, Map<string, Partial<ExecutionPolicy>>>();
function retainAgentRestrictions(result: PlatformConfig): void {
	const restrictions = agentRestrictions.get(result) || new Map();
	for (const agent of result.agents) {
		agent.policy = mergePolicy(restrictions.get(agent.name) || {}, agentPolicy(agent));
		agent.editing = agent.policy.permissions!.includes("write");
		restrictions.set(agent.name, agent.policy);
	}
	agentRestrictions.set(result, restrictions);
}
export function identifier(value: unknown): asserts value is string {
	if (typeof value !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(value))
		throw new Error("Invalid configuration identifier");
}
export function fields(value: any, allowed: string[], location: string): void {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).some((key) => !allowed.includes(key))
	)
		throw new Error(`Unknown or invalid fields in ${location}`);
}
function strings(value: unknown, field: string): asserts value is string[] {
	if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || v.length > 4000))
		throw new Error(`Invalid ${field}`);
}
export function validateExecution(value: any): void {
	fields(
		value,
		[
			"permissions",
			"tools",
			"skills",
			"extensions",
			"workspace",
			"sandbox",
			"maxDepth",
			"timeoutMs",
			"concurrency",
			"contextBudget",
		],
		"execution policy",
	);
	for (const key of ["permissions", "tools", "skills", "extensions"])
		if (value[key] !== undefined) strings(value[key], key);
	if (value.permissions?.some((p: string) => !["read", "write", "test"].includes(p)))
		throw new Error("Unknown permission");
	validateMechanisms(value);

	const bounds: Record<string, [number, number]> = {
		maxDepth: [1, 1],
		timeoutMs: [1000, 3600000],
		concurrency: [1, 4],
		contextBudget: [256, 16000],
	};
	for (const [key, [min, max]] of Object.entries(bounds))
		if (
			value[key] !== undefined &&
			(!Number.isInteger(value[key]) || value[key] < min || value[key] > max)
		)
			throw new Error(`Invalid ${key} limit`);
}
function validateMechanisms(value: any): void {
	if (value.workspace !== undefined && value.workspace !== "isolated")
		throw new Error("Only isolated workspaces are supported");
	if (value.sandbox !== undefined && value.sandbox !== "bubblewrap")
		throw new Error("Sandbox cannot be disabled");
}
function textFile(base: string, file: unknown): string {
	if (
		typeof file !== "string" ||
		!/^[\w/-]+\.md$/.test(file) ||
		file.split("/").includes("..") ||
		file.startsWith("/")
	)
		throw new Error("Instruction file must be a relative Markdown path");
	const path = resolve(base, file);
	assertSafeProfile(path);
	const text = readFileSync(path, "utf8");
	if (text.length > 16000) throw new Error("Instruction file exceeds budget");
	assertNoSecrets(text);
	return text;
}
function agent(name: string, raw: any, base: string): AgentDefinition {
	identifier(name);
	fields(
		raw,
		[
			"description",
			"instructions",
			"instructionsFile",
			"model",
			"selection",
			"policy",
			"tags",
			"context",
			"outputs",
		],
		"agent",
	);
	if (raw.policy !== undefined) validateExecution(raw.policy);
	if (
		raw.model !== undefined &&
		(typeof raw.model !== "string" || !/^[\w-]+\/[\w.:[\]-]+$/.test(raw.model))
	)
		throw new Error("Agent model must use instance/model");
	validateSelection(raw);
	const instructions =
		raw.instructionsFile !== undefined
			? textFile(base, raw.instructionsFile)
			: (raw.instructions ?? "");
	if (typeof instructions !== "string" || instructions.length > 16000)
		throw new Error("Invalid agent instructions");
	validateAgentMetadata(raw);
	return {
		...raw,
		name,
		instructions,
		instructionsFile: undefined,
		editing: !!raw.policy?.permissions?.includes("write"),
	};
}
function validateAgentMetadata(raw: any): void {
	if (raw.description !== undefined && typeof raw.description !== "string")
		throw new Error("Invalid agent description");
	if (raw.tags !== undefined) strings(raw.tags, "agent tags");
	if (raw.context !== undefined) strings(raw.context, "agent context sources");
	if (raw.outputs !== undefined) strings(raw.outputs, "agent output contracts");
}
function validateSelection(raw: any): void {
	if (raw.selection !== undefined) {
		fields(raw.selection, ["instance", "requires"], "provider selection");
		if (raw.selection.instance) identifier(raw.selection.instance);
		if (raw.selection.requires) strings(raw.selection.requires, "required capabilities");
	}
}
function read(file: string): any {
	assertSafeProfile(file);
	if (readFileSync(file).length > 128000) throw new Error("Configuration exceeds budget");
	const config = readConfiguration(file);
	fields(
		config,
		[
			"version",
			"recipes",
			"packages",
			"compatibility",
			"agents",
			"workflows",
			"providers",
			"policy",
			"ui",
			"context",
		],
		"platform configuration",
	);
	validateShape(config);
	if ((config as any).version !== 1) throw new Error("Unsupported platform contract version");
	assertNoSecrets(config);
	return config;
}
function validateShape(raw: any): void {
	for (const key of ["recipes", "packages", "providers", "context"])
		if (raw[key] !== undefined && !Array.isArray(raw[key]))
			throw new Error(`Invalid ${key} configuration`);
	for (const key of ["agents", "workflows"])
		if (
			raw[key] !== undefined &&
			(!raw[key] || typeof raw[key] !== "object" || Array.isArray(raw[key]))
		)
			throw new Error(`Invalid ${key} definitions`);
	if (raw.compatibility !== undefined && typeof raw.compatibility !== "boolean")
		throw new Error("Invalid compatibility flag");
}
function mergePolicy(
	target: Partial<ExecutionPolicy>,
	source: Partial<ExecutionPolicy>,
): Partial<ExecutionPolicy> {
	const merged: any = { ...target, ...source };
	for (const key of ["permissions", "tools", "skills", "extensions"] as const)
		if (target[key] && source[key])
			merged[key] = target[key]!.filter((x: string) => (source[key] as string[]).includes(x));
	for (const key of ["maxDepth", "timeoutMs", "concurrency", "contextBudget"] as const)
		if (target[key] !== undefined && source[key] !== undefined)
			merged[key] = Math.min(target[key]!, source[key]!);
	return merged;
}
export function loadPlatform(
	profile: string,
	cwd = process.cwd(),
	invocation?: unknown,
	userFile = join(homedir(), ".config/pi-poly-agent/platform.json"),
): PlatformConfig {
	const result: PlatformConfig = {
		version: 1,
		legacy: false,
		agents: [],
		workflows: [],
		providers: [],
		policy: {},
		concurrency: 2,
		timeoutMs: 900000,
		ui: { status: true, notifications: true },
		context: ["native"],
	};
	const profileFile = join(profile, "platform.json");
	const projectFile = projectConfiguration(cwd);
	const files = [userFile, profileFile, projectFile].filter(existsSync);
	if (!files.length && !invocation) {
		result.legacy = true;
		const legacy = loadOrchestration(profile);
		result.agents = legacy.roles;
		result.concurrency = legacy.concurrency;
		result.timeoutMs = legacy.timeoutMs;
		apply(
			result,
			read(join(import.meta.dirname, "../../recipes/implementation-review.json")),
			dirname(profileFile),
			false,
		);
		result.agents = legacy.roles;
	}
	for (const file of files) fileLayer(result, profile, file, projectFile);
	if (invocation) {
		assertNoSecrets(invocation);
		fields(
			invocation,
			["version", "agents", "workflows", "policy", "ui", "context"],
			"invocation configuration",
		);
		apply(result, invocation, cwd, true);
	}
	result.concurrency = result.policy.concurrency ?? result.concurrency;
	result.timeoutMs = result.policy.timeoutMs ?? result.timeoutMs;
	for (const workflow of result.workflows) validateWorkflow(workflow, result.agents);
	return result;
}
function projectConfiguration(cwd: string): string {
	try {
		return join(git(cwd, ["rev-parse", "--show-toplevel"]), ".pi/poly.json");
	} catch {
		return join(cwd, ".pi/poly.json");
	}
}
function fileLayer(
	result: PlatformConfig,
	profile: string,
	file: string,
	projectFile: string,
): void {
	const raw = read(file);
	const project = file === projectFile;
	for (const name of raw.recipes || []) {
		identifier(name);
		const recipe = join(import.meta.dirname, "../../recipes", `${name}.json`);
		apply(result, read(recipe), dirname(recipe), project);
	}
	if (project && (raw.packages || raw.providers || raw.compatibility))
		throw new Error(
			"Project configuration cannot install providers, packages, or legacy privileges",
		);
	for (const packageFile of raw.packages || []) {
		if (
			typeof packageFile !== "string" ||
			(!packageFile.startsWith("pi:") && !/^[a-z0-9-]+\.json$/.test(packageFile))
		)
			throw new Error(
				"Packages must be installed JSON files in the managed profile packages directory",
			);
		const file = packageConfiguration(profile, packageFile);
		apply(result, read(file), dirname(file), false);
	}
	apply(result, raw, dirname(file), project);
}
function packageConfiguration(profile: string, file: string): string {
	return file.startsWith("pi:")
		? nativePackageConfiguration(profile, file.slice(3))
		: join(profile, "packages", file);
}

function apply(result: PlatformConfig, raw: any, base: string, project: boolean): void {
	fields(
		raw,
		[
			"version",
			"recipes",
			"packages",
			"compatibility",
			"agents",
			"workflows",
			"providers",
			"policy",
			"ui",
			"context",
		],
		"configuration layer",
	);
	validateShape(raw);
	if (raw.version !== 1) throw new Error("Unsupported platform contract version");
	if (raw.compatibility === true) result.agents = defaultRoles();
	if (raw.compatibility === false) result.agents = [];
	applyAgents(result, raw.agents || {}, base);
	for (const [id, workflow] of Object.entries(raw.workflows || {})) {
		identifier(id);
		result.workflows = result.workflows.filter((w) => w.id !== id);
		if (workflow !== null) result.workflows.push({ ...(workflow as any), id });
	}
	applyProviders(result, raw, project);
	if (raw.policy) {
		validateExecution(raw.policy);
		result.policy = mergePolicy(result.policy, raw.policy);
	}
	if (raw.ui) {
		fields(raw.ui, ["status", "notifications"], "UI");
		if (Object.values(raw.ui).some((v) => typeof v !== "boolean"))
			throw new Error("UI flags must be boolean");
		result.ui = { ...result.ui, ...raw.ui };
	}
	if (raw.context) {
		strings(raw.context, "context backends");
		result.context = raw.context;
	}
	retainAgentRestrictions(result);
}

function applyAgents(result: PlatformConfig, agents: object, base: string): void {
	for (const [name, value] of Object.entries(agents)) {
		identifier(name);
		const previous = result.agents.find((a) => a.name === name);
		result.agents = result.agents.filter((a) => a.name !== name);
		if (value !== null) {
			const defaults = previous
				? {
						instructions: previous.instructions,
						description: previous.description,
						model: previous.model,
						policy: previous.policy,
						selection: previous.selection,
						tags: previous.tags,
						context: previous.context,
						outputs: previous.outputs,
					}
				: {};
			const next = agent(name, { ...defaults, ...(value as object) }, base);
			if (previous?.policy && next.policy) next.policy = mergePolicy(previous.policy, next.policy);
			next.editing = !!next.policy?.permissions?.includes("write");
			result.agents.push(next);
		}
	}
}

function applyProviders(result: PlatformConfig, raw: any, project: boolean): void {
	if (raw.providers) {
		if (project) throw new Error("Project configuration cannot install provider instances");
		for (const instance of raw.providers) {
			fields(
				instance,
				[
					"id",
					"adapter",
					"billing",
					"enabled",
					"capabilities",
					"endpoint",
					"models",
					"modelLimits",
				],
				"provider instance",
			);
			result.providers = result.providers.filter((p) => p.id !== instance.id);
			result.providers.push(instance);
		}
	}
}
