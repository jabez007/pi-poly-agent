import { assertNoSecrets } from "../secrets.ts";
import {
	controlFileNotice,
	escapeDiffText,
	git,
	readGitOutput,
	renderReviewDiff,
	reviewDiffOptions,
	scanGitOutput,
} from "./worktrees.ts";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
export const REVIEW_CONTEXT_BUDGET = 6000;
interface FileStat {
	file: string;
	added: string;
	removed: string;
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

function filePatch(
	cwd: string,
	base: string,
	revision: string,
	file: string,
	budget: number,
): string | undefined {
	let raw = "",
		fits = true;
	readGitOutput(
		cwd,
		[
			"--literal-pathspecs",
			"diff",
			...reviewDiffOptions,
			base,
			...(revision ? [revision] : []),
			"--",
			file,
		],
		(chunk) => {
			if (raw.length + chunk.length > budget) {
				fits = false;
				return false;
			}
			raw += chunk;
		},
		Math.min(65536, Math.max(1, budget + 1)),
	);
	if (!fits) return;
	const rendered = escapeDiffText(raw);
	return rendered.length <= budget ? rendered : undefined;
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
	accept?: (file: string) => boolean;
}
function selectedRecords(cwd: string, options: string[], selection: ViewSelection): FileStat[] {
	if (!selection.indexOnly) scanGitOutput(cwd, ["--literal-pathspecs", "diff", ...options]);
	return reviewFileIndex(cwd, options).filter((r) => !selection.accept || selection.accept(r.file));
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
function filePage(records: FileStat[], offset: number, budget: number): FileStat[] {
	const page: FileStat[] = [];
	let used = 0;
	for (const record of records.slice(offset)) {
		const cost = statLine(record, false).length + 1;
		if (used + cost > budget) break;
		page.push(record);
		used += cost;
	}
	return page;
}
function statLine(record: FileStat, shown: boolean): string {
	return `[${shown ? "patch shown" : "not shown  "}] ${escapeDiffText(JSON.stringify(record.file))} ${lineCounts(record)}`;
}
function pageContent(
	cwd: string,
	base: string,
	revision: string,
	page: FileStat[],
	budget: number,
	indexOnly: boolean,
): string {
	const patches: string[] = [],
		index: string[] = [];
	let remaining = budget - page.map((r) => statLine(r, false)).join("\n").length - 1;
	for (const record of page) {
		const patch =
			!indexOnly && remaining > 0
				? filePatch(cwd, base, revision, record.file, remaining)
				: undefined;
		index.push(statLine(record, patch !== undefined));
		if (patch !== undefined) {
			patches.push(patch);
			remaining -= patch.length;
		}
	}
	return index.join("\n") + "\n" + patches.join("");
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
	if (!/^[a-f0-9]{40,64}$/.test(base) || (revision && !/^[a-f0-9]{40,64}$/.test(revision)))
		throw new Error("Invalid review revision");
	const options = [...reviewDiffOptions, base, ...(revision ? [revision] : []), "--", ...paths];
	const records = selectedRecords(cwd, options, selection);
	const commands = inspectionCommands(cwd, base, revision);
	const header = `${controlNotice(records)}${renderReviewDiff("")}Base: ${base}\nRevision: ${revision || "uncommitted worktree"}\nChanged-file index. Entries marked not shown have no patch in this view.\n`;
	const footer = `\nList every changed file:\n${commands.index}\nInspect the full committed diff:\n${commands.patch}`;
	const available = budget - header.length - footer.length - 256;
	if (available < 0)
		throw new Error(
			`Review view needs ${budget - available} characters of metadata; budget is ${budget}. Increase the context budget or inspect the task manually.`,
		);
	const offset = selection.offset ?? 0;
	const page = filePage(records, offset, Math.floor(available / 2));
	const next = offset + page.length;
	const pagination = `\nFiles not listed in this view: ${records.length - page.length} of ${records.length}.\n${next < records.length ? `Next file offset: ${next}\n` : ""}Use review_diff with path "." and offset to page the approved file index.\n`;
	return (
		header +
		pageContent(cwd, base, revision, page, available, !!selection.indexOnly) +
		pagination +
		footer
	);
}
