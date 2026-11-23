import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { validateHandoff, type Handoff } from "./memory.ts";
import type { Task } from "./orchestration/tasks.ts";

export function draftHandoff(
	entries: SessionEntry[],
	provenance: Handoff["provenance"],
	memory: string,
	previous?: Handoff,
): Handoff {
	const users = entries.filter((e) => e.type === "message" && e.message.role === "user");
	const objective = users.length
		? entryText(users.at(-1)!).slice(0, 2000)
		: previous?.objective || "Describe the current objective";
	const tasks = entries
		.filter((e) => e.type === "custom" && e.customType === "poly-task-complete")
		.map((e) => (e as any).data as Task)
		.filter((t) => t.status === "completed" && t.result);
	const files = [
		...new Set([...(previous ? previous.files : []), ...tasks.flatMap((t) => t.result!.files)]),
	];
	const recent = entries
		.filter((e) => e.type === "message" && e.message.role === "assistant")
		.slice(-2)
		.map(entryText)
		.filter(Boolean);
	const findings = tasks.flatMap((task) =>
		task.result!.findings.map((f) => ({
			text: f.text,
			source: `${f.source} (task ${task.id}, ${task.provider}/${task.model})`,
			verified: false,
		})),
	);
	return validateHandoff({
		version: 1,
		objective,
		completed: [...new Set(tasks.map((t) => `${t.id}: ${t.result!.summary}`))],
		decisions: [...new Set(previous?.decisions || [])],
		questions: [
			...new Set([...(previous?.questions || []), ...tasks.flatMap((t) => t.result!.questions)]),
		],
		files,
		facts: [
			...new Map(
				[...(previous?.facts || []), ...findings].map((fact) => [
					JSON.stringify([fact.text, fact.source, fact.verified]),
					fact,
				]),
			).values(),
		],
		hypotheses: [
			...recent.map((text) => `Agent summary, unverified: ${text.slice(0, 1500)}`),
			...(memory
				? [`Selected historical memory; verify before use:\n${memory.slice(0, 6000)}`]
				: []),
		],
		provenance,
	});
}
function entryText(entry: SessionEntry): string {
	if (entry.type !== "message") return "";
	const content = (entry.message as any).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((c) => c.type === "text")
		.map((c) => c.text)
		.join("\n");
}
const SECTIONS = [
	"Objective",
	"Completed",
	"Decisions",
	"Questions",
	"Files",
	"Verified facts",
	"Unverified findings",
	"Hypotheses",
];
export function handoffMarkdown(h: Handoff): string {
	const list = (values: string[]) =>
		values.map((value) => `- ${value.replace(/\n/g, " ")}`).join("\n");
	const facts = (verified: boolean) =>
		list(h.facts.filter((f) => f.verified === verified).map((f) => `${f.text} | ${f.source}`));
	const bodies = [
		h.objective.replace(/^# /gm, "    # "),
		list(h.completed),
		list(h.decisions),
		list(h.questions),
		list(h.files),
		facts(true),
		facts(false),
		list(h.hypotheses),
	];
	return SECTIONS.map((title, index) => `# ${title}\n${bodies[index]}\n`).join("\n");
}
export function parseHandoffMarkdown(text: string, provenance: Handoff["provenance"]): Handoff {
	const values = new Map<string, string[]>();
	let section = "";
	for (const line of text.split("\n")) {
		if (line.startsWith("# ")) {
			section = line.slice(2).trim();
			if (!SECTIONS.includes(section)) throw new Error("Unknown handoff section");
			values.set(section, []);
			continue;
		}
		if (line.trim()) values.get(section)?.push(line.replace(/^[-*] /, "").trim());
	}
	const get = (key: string) => values.get(key) || [];
	const facts = (key: string, verified: boolean) =>
		get(key).map((line) => {
			const divider = line.lastIndexOf(" | ");
			if (divider < 1) throw new Error("Facts require text | source");
			return { text: line.slice(0, divider), source: line.slice(divider + 3), verified };
		});
	return validateHandoff({
		version: 1,
		objective: get("Objective").join("\n"),
		completed: get("Completed"),
		decisions: get("Decisions"),
		questions: get("Questions"),
		files: get("Files"),
		facts: [...facts("Verified facts", true), ...facts("Unverified findings", false)],
		hypotheses: get("Hypotheses"),
		provenance,
	});
}
