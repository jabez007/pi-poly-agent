import { assertNoSecrets, type Handoff } from "../memory.ts";
import { controlFileNotice } from "./worktrees.ts";
import { REVIEW_CONTEXT_BUDGET, reviewDiffView } from "./review-view.ts";
/** Select whole attributed entries rather than truncating serialized handoffs or copying transcripts. */
export function focusedContext(
	handoff: Handoff | undefined,
	memory: string,
	budget = 14000,
): string {
	const parts: string[] = [];
	const add = (text: string) => {
		if (parts.join("\n\n").length + text.length + 2 <= budget) parts.push(text);
	};
	if (handoff) {
		add(`Reviewed handoff provenance: ${JSON.stringify(handoff.provenance)}`);
		for (const fact of handoff.facts)
			add(
				`${fact.verified ? "Verified fact" : "Unverified claim"}: ${fact.text}\nSource: ${fact.source}`,
			);
		for (const decision of handoff.decisions) add(`Reviewed decision: ${decision}`);
		for (const file of handoff.files) add(`Relevant source: ${file}`);
		for (const question of handoff.questions) add(`Outstanding question: ${question}`);
	}
	// Retrieval is already structured, attributed, secret-screened, and bounded by ProjectMemory.
	if (memory) add(memory);
	const result = parts.join("\n\n");
	assertNoSecrets(result);
	return result;
}

import type { Task } from "./tasks.ts";
export function taskContext(knowledge: string, previous?: Task, budget = 16000): string {
	const parts: string[] = [],
		omitted = new Set<string>();
	let used = 0;
	const add = (text: string, label: string) => {
		if (!text) return;
		if (used + text.length + 2 <= budget - 384) {
			parts.push(text);
			used += text.length + 2;
		} else omitted.add(label);
	};
	if (previous) {
		add(controlFileNotice(previous.result?.files || []), "Control file notice");
		add(previousReviewView(previous, budget), "Review view");
		add(
			`Historical task ${previous.id}, ${previous.provider}/${previous.model}\nRevision: ${previous.revision || previous.workspace.base}\nAgent claims are unverified; inspect original task for omitted details.`,
			"Task provenance",
		);
		add(`Previous objective: ${previous.brief}`, "Previous objective");
		if (previous.result) {
			add(`Implementation claim: ${previous.result.summary}`, "Implementation claim");
			if (!previous.revision)
				for (const file of previous.result.files) add(`Changed source: ${file}`, "Changed files");
			for (const finding of previous.result.findings)
				add(
					`Unverified ${finding.severity} finding: ${finding.text}\nSource: ${finding.source}`,
					"Previous findings",
				);
			for (const test of previous.result.tests)
				add(`Recorded test execution: ${test}`, "Recorded tests");
			for (const question of previous.result.questions)
				add(`Open question: ${question}`, "Open questions");
		}
		add(`Original approved context:\n${previous.context}`, "Original approved context");
	}
	add(knowledge, "Project knowledge");
	parts.push(...omissionNotice(omitted));
	const result = parts.join("\n\n");
	assertNoSecrets(result);
	return result;
}

function omissionNotice(omitted: Set<string>): string[] {
	return omitted.size
		? [
				`Omitted for context budget: ${[...omitted].join(", ")}. Inspect the original task or context source.`,
			]
		: [];
}

function previousReviewView(task: Task, budget: number): string {
	return task.revision
		? reviewDiffView(
				task.workspace.path,
				task.workspace.base,
				task.revision,
				[],
				Math.min(budget, REVIEW_CONTEXT_BUDGET),
			)
		: "";
}
