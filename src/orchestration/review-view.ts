import { assertNoSecrets } from "../secrets.ts";
import { controlFileNotice, escapeDiffText, git, renderReviewDiff } from "./worktrees.ts";

const diffOptions = ["--text", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames"];
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** Patch content is bounded; the complete omitted-file index is always retained. */
export function reviewDiffView(
	cwd: string,
	base: string,
	revision: string,
	paths: string[] = [],
	budget = 48000,
): string {
	if (![base, revision].every((value) => /^[a-f0-9]{40,64}$/.test(value)))
		throw new Error("Invalid review revision");
	const options = [...diffOptions, base, revision, "--", ...paths];
	const raw = git(cwd, ["--literal-pathspecs", "diff", ...options]);
	assertNoSecrets(raw);
	const full = renderReviewDiff(raw);
	const records = git(cwd, ["--literal-pathspecs", "diff", "--numstat", "-z", ...options])
		.split("\0")
		.filter(Boolean)
		.map((record) => {
			const [added, removed, ...file] = record.split("\t");
			return { file: file.join("\t"), added, removed };
		});
	const notice = controlFileNotice(records.map((record) => record.file));
	if (full.length <= budget) return notice + full;
	const stats = records.map(
		(record) =>
			`${escapeDiffText(JSON.stringify(record.file))} +${record.added} -${record.removed}`,
	);
	const parts = raw.split(/(?=^diff --git )/m).filter(Boolean);
	const shown: string[] = [],
		omitted: string[] = [];
	let remaining = Math.max(0, budget - stats.join("\n").length - 1500);
	for (const [index, part] of (parts.length === stats.length ? parts : []).entries()) {
		const rendered = renderReviewDiff(part);
		if (parts.length === stats.length && rendered.length <= remaining) {
			shown.push(rendered);
			remaining -= rendered.length;
		} else omitted.push(stats[index] || "Unknown file; inspect the full diff command");
	}
	if (parts.length !== stats.length) omitted.push(...stats);
	const gitDir = git(cwd, ["rev-parse", "--absolute-git-dir"]);
	const command = [
		"git",
		"--git-dir",
		quote(gitDir),
		"--work-tree",
		quote(cwd),
		"-c core.hooksPath=/dev/null -c core.fsmonitor=false -c diff.ignoreSubmodules=all",
		"diff --ignore-submodules=all",
		...diffOptions,
		quote(base),
		quote(revision),
		"--",
	].join(" ");
	return `${notice}Bounded review view. Unicode escapes are shown. Files not shown here are not fully reviewed by this view.\n${shown.join("\n")}\nFiles omitted from the displayed patch:\n${omitted.join("\n")}\nInspect the full committed diff:\n${command}`;
}
