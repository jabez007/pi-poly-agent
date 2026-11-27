import { assertNoSecrets } from "./secrets.ts";
export { assertNoSecrets } from "./secrets.ts";
import {
	durableKnowledge,
	parseMemoryRecords,
	selectMemory,
	renderMemory,
} from "./memory-context.ts";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { directOnlyProvider } from "./policy.ts";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export interface Handoff {
	version: 1;
	objective: string;
	completed: string[];
	decisions: string[];
	questions: string[];
	files: string[];
	facts: { text: string; source: string; verified: boolean }[];
	hypotheses: string[];
	provenance: {
		session: string;
		project: string;
		revision: string;
		provider: string;
		createdAt: string;
	};
}

export interface MemoryTransport {
	call(name: string, args: Record<string, unknown>): Promise<unknown>;
	close(): Promise<void>;
}

export function validateHandoff(value: unknown): Handoff {
	if (!value || typeof value !== "object") throw new Error("Invalid handoff");
	const h = value as Handoff;
	if (h.version !== 1 || typeof h.objective !== "string" || !h.objective.trim())
		throw new Error("Handoff needs an objective");
	for (const field of [h.completed, h.decisions, h.questions, h.files, h.hypotheses]) {
		if (!Array.isArray(field) || !field.every((s) => typeof s === "string"))
			throw new Error("Invalid handoff list");
	}
	validateFacts(h.facts);
	validateProvenance(h.provenance);
	if (JSON.stringify(h).length > 24000) throw new Error("Checkpoint exceeds 24 KB");
	const allowed = [
		"version",
		"objective",
		"completed",
		"decisions",
		"questions",
		"files",
		"facts",
		"hypotheses",
		"provenance",
	];
	if (Object.keys(h).some((k) => !allowed.includes(k)))
		throw new Error("Unexpected checkpoint field");
	assertNoSecrets(h);
	return h;
}

function validateProvenance(provenance: Handoff["provenance"]): void {
	const fields = ["session", "project", "revision", "provider", "createdAt"] as const;
	if (
		!provenance ||
		!fields.every((key) => typeof provenance[key] === "string" && provenance[key].length > 0)
	)
		throw new Error("Invalid provenance");
	if (Object.keys(provenance).some((key) => !fields.includes(key as (typeof fields)[number])))
		throw new Error("Unexpected provenance field");
}

function validateFacts(facts: Handoff["facts"]): void {
	if (!Array.isArray(facts)) throw new Error("Facts need sources and verification status");
	for (const f of facts) {
		if (
			!f ||
			typeof f.text !== "string" ||
			typeof f.source !== "string" ||
			!f.source ||
			typeof f.verified !== "boolean"
		)
			throw new Error("Facts need sources and verification status");
	}
}

function git(cwd: string, args: string[]): string {
	try {
		return execFileSync(
			"git",
			["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args],
			{
				cwd,
				env: Object.fromEntries(
					Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
				),
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
				timeout: 10000,
				maxBuffer: 65536,
			},
		).trim();
	} catch {
		return "unknown";
	}
}

export function projectIdentity(cwd: string): { root: string; wing: string; revision: string } {
	const common = git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
	const root = common === "unknown" ? realpathSync(cwd) : common;
	return {
		root,
		wing: `pi_${createHash("sha256").update(root).digest("hex").slice(0, 20)}`,
		revision: git(cwd, ["rev-parse", "HEAD"]),
	};
}

export function checkpointDigest(h: Handoff): string {
	// Timestamps do not turn an unchanged checkpoint into new knowledge.
	return createHash("sha256")
		.update(JSON.stringify({ ...h, provenance: { ...h.provenance, createdAt: "" } }))
		.digest("hex");
}

export class ProjectMemory {
	constructor(
		private transport: MemoryTransport,
		readonly wing: string,
		private sharedWings: string[] = [],
		private contextBudget = 12000,
	) {}

	async save(handoff: Handoff): Promise<void> {
		const h = validateHandoff(handoff);
		const result = await this.transport.call("mempalace_checkpoint", {
			added_by: "pi-poly-agent",
			dedup_threshold: 1,
			items: [
				...durableKnowledge(h, this.wing).map((item) => ({
					wing: this.wing,
					room: "knowledge",
					content: JSON.stringify(item),
				})),
				{ wing: this.wing, room: "handoffs", content: JSON.stringify(h) },
			],
		});
		assertToolSuccess(result);
	}

	async recall(query: string): Promise<string> {
		assertNoSecrets(query);
		const results = await Promise.all(
			[this.wing, ...this.sharedWings].map(async (wing) => {
				const result = await this.transport.call("mempalace_search", {
					query: query.slice(0, 250),
					wing,
					limit: 12,
				});
				assertToolSuccess(result);
				return parseMemoryRecords(result, wing);
			}),
		);
		const selected = selectMemory(results.flat(), query, this.contextBudget);
		const text = renderMemory(selected);
		assertNoSecrets(text);
		return text;
	}
}

function assertToolSuccess(result: unknown): void {
	const r = result as {
		isError?: boolean;
		error?: unknown;
		errors?: unknown[];
		content?: { type: string; text?: string }[];
	};
	if (r && (r.isError || r.error || (r.errors && r.errors.length)))
		throw new Error("MemPalace operation failed");
	for (const block of r?.content ?? []) {
		if (block.type !== "text" || !block.text) continue;
		let value: unknown;
		try {
			value = JSON.parse(block.text);
		} catch {
			continue;
		}
		assertToolSuccess(value);
	}
}

export function discoverMemPalace(
	env: NodeJS.ProcessEnv = process.env,
): { command: string; configDir: string; palace: string } | undefined {
	const home = env.HOME || homedir();
	const legacy = join(home, ".mempalace");
	const configDir =
		env.MEMPALACE_CONFIG_DIR ||
		(existsSync(join(legacy, "config.json"))
			? legacy
			: join(env.XDG_CONFIG_HOME || join(home, ".config"), "mempalace"));
	let palace = join(configDir, "palace");
	const file = join(configDir, "config.json");
	if (existsSync(file)) {
		const config = JSON.parse(readFileSync(file, "utf8")) as { palace_path?: string };
		if (config.palace_path) palace = config.palace_path.replace(/^~(?=\/)/, home);
	}
	const command = (env.PATH || "")
		.split(":")
		.map((p) => join(p, "mempalace-mcp"))
		.find((p) => p.startsWith("/") && existsSync(p));
	if (!command || !existsSync(palace)) return undefined;
	return { command, configDir, palace };
}

export async function connectMemPalace(): Promise<MemoryTransport> {
	const found = discoverMemPalace();
	if (!found) throw new Error("Existing MemPalace installation unavailable");
	// Opening an empty path can initialize storage in some MemPalace versions.
	// This slice supports the existing Chroma installation, never a new palace.
	if (!existsSync(join(found.palace, "chroma.sqlite3")))
		throw new Error("Existing MemPalace Chroma storage is required; no initialization attempted");
	const transport = new StdioClientTransport({
		command: found.command,
		args: ["--transport", "stdio"],
		stderr: "ignore",
		env: {
			PATH: process.env.PATH || "/usr/bin:/bin",
			HOME: homedir(),
			MEMPALACE_CONFIG_DIR: found.configDir,
			ANONYMIZED_TELEMETRY: "false",
		},
	});
	const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
	const client = new Client({ name: "pi-poly-agent", version });
	try {
		await client.connect(transport, { timeout: 8000 });
	} catch {
		await transport.close();
		throw new Error("MemPalace unavailable");
	}
	return {
		call: (name, args) => client.callTool({ name, arguments: args }, undefined, { timeout: 8000 }),
		close: () => client.close(),
	};
}

export async function checkpointBeforeCompaction(
	input: {
		manual: boolean;
		willRetry: boolean;
		interactive: boolean;
		provider: string;
		memoryEnabled: boolean;
		handoff?: Handoff;
	},
	confirm: () => Promise<boolean>,
	save: (handoff: Handoff) => Promise<void>,
): Promise<boolean> {
	if (
		!input.manual ||
		input.willRetry ||
		!input.interactive ||
		directOnlyProvider(input.provider) ||
		!input.memoryEnabled ||
		!input.handoff
	)
		return false;
	try {
		if (!(await confirm())) return false;
		await save(validateHandoff(input.handoff));
		return true;
	} catch {
		return false;
	}
}
