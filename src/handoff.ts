import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { validateHandoff, type Handoff } from "./memory.ts";

function entryForm(value: string): string {
	return value.replace(/\r\n?|\n/g, " ").trim();
}
function uniqueEntries(values: string[]): string[] {
	return [...new Set(values.map(entryForm))];
}
function uniqueFacts(facts: Handoff["facts"]): Handoff["facts"] {
	return [
		...new Map(
			facts.map((fact) => {
				const normalized = { ...fact, text: entryForm(fact.text), source: entryForm(fact.source) };
				return [
					JSON.stringify([normalized.text, normalized.source, normalized.verified]),
					normalized,
				];
			}),
		).values(),
	];
}

export function draftHandoff(
	entries: SessionEntry[],
	provenance: Handoff["provenance"],
	memory: string,
	previous?: Handoff,
): Handoff {
	const prior = previous || {
		objective: "Describe the current objective",
		completed: [],
		decisions: [],
		questions: [],
		files: [],
		facts: [],
	};
	const users = entries.filter((e) => e.type === "message" && e.message.role === "user");
	const objective = users.length ? entryText(users.at(-1)!).slice(0, 2000) : prior.objective;
	const recent = entries
		.filter((e) => e.type === "message" && e.message.role === "assistant")
		.slice(-2)
		.map(entryText)
		.filter(Boolean);
	return validateHandoff({
		version: 1,
		objective,
		completed: uniqueEntries(prior.completed),
		decisions: uniqueEntries(prior.decisions),
		questions: uniqueEntries(prior.questions),
		files: uniqueEntries(prior.files),
		facts: uniqueFacts(prior.facts),
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
	const list = (values: string[]) => values.map((value) => `- ${entryForm(value)}`).join("\n");
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
