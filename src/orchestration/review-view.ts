import { reviewPatches } from "./review-patches.ts";
import { assertNoSecrets } from "../secrets.ts";
import { ReviewBudgetError } from "./errors.ts";
import { assertLiteralSourceFiles, sourcePathAllowed } from "./path-policy.ts";
import {
	controlFileNotice,
	escapeDiffText,
	git,
	readGitOutput,
	renderReviewDiff,
	reviewDiffOptions,
	withCheckedGitRead,
} from "./worktrees.ts";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
export const REVIEW_CONTEXT_BUDGET = 6000;
interface FileStat {
	file: string;
	added: string;
	removed: string;
}
function diffArguments(base: string, revision: string, paths: string[]): string[] {
	if (!/^[a-f0-9]{40,64}$/.test(base) || (revision && !/^[a-f0-9]{40,64}$/.test(revision)))
		throw new Error("Invalid review revision");
	return [...reviewDiffOptions, base, ...(revision ? [revision] : []), "--", ...paths];
}

export function reviewFileIndex(cwd: string, options: string[]): FileStat[] {
	const records: FileStat[] = [];
	let pending = "";
	readGitOutput(cwd, ["--literal-pathspecs", "diff", "--numstat", "-z", ...options], (chunk) => {
		pending += chunk;
		const parts = pending.split("\0");
		pending = parts.pop()!;
		for (const record of parts) {
			const [added, removed, ...file] = record.split("\t");
			records.push({ file: file.join("\t"), added, removed });
		}
	});
	assertNoSecrets(records);
	return records;
}

function inspectionCommands(
	cwd: string,
	base: string,
	revision: string,
): { patch: string; index: string } {
	const directory = git(cwd, ["rev-parse", revision ? "--git-common-dir" : "--absolute-git-dir"]);
	const prefix = `git --git-dir ${quote(directory)} ${revision ? "" : `--work-tree ${quote(cwd)} `}-c core.hooksPath=/dev/null -c core.fsmonitor=false -c diff.ignoreSubmodules=all diff --ignore-submodules=all`;
	const refs = `${quote(base)}${revision ? ` ${quote(revision)}` : ""} --`;
	return {
		patch: `${prefix} ${reviewDiffOptions.join(" ")} ${refs}`,
		index: `${prefix} --no-renames --numstat ${refs}`,
	};
}

function lineCounts(record: FileStat): string {
	return record.added === "-" || record.removed === "-"
		? "Git reports binary; added/removed line counts unavailable"
		: `+${record.added} -${record.removed}`;
}

interface ViewSelection {
	offset?: number;
	indexOnly?: boolean;
	exactPath?: string;
}
function selectedRecords(cwd: string, options: string[], selection: ViewSelection): FileStat[] {
	const records = reviewFileIndex(cwd, options);
	if (selection.exactPath !== undefined)
		assertLiteralSourceFiles(
			records.map((r) => r.file),
			selection.exactPath,
		);
	return records;
}
function controlNotice(records: FileStat[]): string {
	const controls = records.filter((r) => /(^|\/)\.(gitattributes|gitmodules)$/.test(r.file));
	const shown: string[] = [];
	for (const { file } of controls) {
		if (controlFileNotice([...shown, file]).length > 512) break;
		shown.push(file);
	}
	return (
		controlFileNotice(shown) +
		(controls.length > shown.length
			? `${controls.length - shown.length} additional control files; use the full file index command.\n`
			: "")
	);
}
function filePage(records: FileStat[], offset: number): FileStat[] {
	const page: FileStat[] = [];
	let used = 0;
	for (const record of records.slice(offset)) {
		const cost = statLine(record, false).length + 1;
		if (page.length && (used + cost > 1024 || page.length === 32)) break;
		page.push(record);
		used += cost;
	}
	return page;
}
function statLine(record: FileStat, shown: boolean): string {
	const state = sourcePathAllowed(record.file)
		? shown
			? "patch shown"
			: "not shown  "
		: "refused by path policy";
	return `[${state}] ${escapeDiffText(JSON.stringify(record.file))} ${lineCounts(record)}`;
}
function pageContent(page: FileStat[], patches: Map<string, string>): string {
	return (
		page.map((record) => statLine(record, patches.has(record.file))).join("\n") +
		"\n" +
		[...patches.values()].join("")
	);
}

/** Both the file index and patches are bounded; the existing review tool can page the index. */
export function reviewDiffView(
	cwd: string,
	base: string,
	revision: string,
	paths: string[] = [],
	budget = 48000,
	selection: ViewSelection = {},
): string {
	return withCheckedGitRead(cwd, () => buildView(cwd, base, revision, paths, budget, selection));
}
function buildView(
	cwd: string,
	base: string,
	revision: string,
	paths: string[],
	budget: number,
	selection: ViewSelection,
): string {
	const options = diffArguments(base, revision, paths);
	const records = selectedRecords(cwd, options, selection);
	if (!records.length) return "";
	const commands = inspectionCommands(cwd, base, revision);
	const header = `${controlNotice(records)}${renderReviewDiff("")}Base: ${base}\nRevision: ${revision || "uncommitted worktree"}\nChanged-file index. Refused entries have no patch access; not shown entries have no patch in this view.\n`;
	const footer = `\nList every changed file:\n${commands.index}\nInspect the full ${revision ? "committed" : "uncommitted"} diff:\n${commands.patch}`;
	const available = budget - header.length - footer.length - 256;
	const offset = selection.offset ?? 0;
	const page = filePage(records, offset);
	const indexSize = page.map((r) => statLine(r, false)).join("\n").length + 1;
	if (available < indexSize) throw new ReviewBudgetError(budget - available + indexSize, budget);
	const next = offset + page.length;
	const pagination = `\nFiles not listed in this view: ${records.length - page.length} of ${records.length}.\n${next < records.length ? `Next file offset: ${next}\n` : ""}Use review_diff with path "." and offset to page the approved file index.\n`;
	const patchBudget = available - indexSize;
	const patches = reviewPatches(
		cwd,
		["--literal-pathspecs", "diff", ...options],
		records.map((r) => r.file),
		selection.indexOnly ? [] : page.map((r) => r.file),
		patchBudget,
	);
	return header + pageContent(page, patches) + pagination + footer;
}
