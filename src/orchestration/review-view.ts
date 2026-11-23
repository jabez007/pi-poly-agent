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

/** Only a budgeted patch view is retained; full source stays in Git and is screened incrementally. */
export function reviewDiffView(
	cwd: string,
	base: string,
	revision: string,
	paths: string[] = [],
	budget = 48000,
): string {
	if (!/^[a-f0-9]{40,64}$/.test(base) || (revision && !/^[a-f0-9]{40,64}$/.test(revision)))
		throw new Error("Invalid review revision");
	const options = [...reviewDiffOptions, base, ...(revision ? [revision] : []), "--", ...paths];
	scanGitOutput(cwd, ["--literal-pathspecs", "diff", ...options]);
	const records = reviewFileIndex(cwd, options);
	const commands = inspectionCommands(cwd, base, revision);
	const header = `${controlFileNotice(records.map((r) => r.file))}${renderReviewDiff("")}Base: ${base}\nRevision: ${revision || "uncommitted worktree"}\n`;
	const footer = `\nInspect the full committed diff:\n${commands.patch}`;
	const stats = records.map(
		(r) => `${escapeDiffText(JSON.stringify(r.file))} ${lineCounts(r)}`,
	);
	const omissionHeader =
		"\nFiles omitted from the displayed patch (not fully reviewed by this view):\n";
	let remaining = Math.max(
		0,
		budget - header.length - footer.length - omissionHeader.length - stats.join("\n").length - 2,
	);
	const shown: string[] = [],
		omitted: string[] = [];
	for (const [index, record] of records.entries()) {
		const patch = remaining ? filePatch(cwd, base, revision, record.file, remaining) : undefined;
		if (patch !== undefined) {
			shown.push(patch);
			remaining -= patch.length;
		} else omitted.push(stats[index]);
	}
	return (
		header + shown.join("") + (omitted.length ? omissionHeader + omitted.join("\n") : "") + footer
	);
}
