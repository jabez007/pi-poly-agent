import { secretScanner } from "../secrets.ts";
import { sourcePathAllowed } from "./path-policy.ts";
import { escapeDiffText, readGitOutput } from "./worktrees.ts";

function safeReadEnd(text: string): number {
	const end = Math.max(0, text.length - 12);
	const previous = text.charCodeAt(end - 1);
	return previous >= 0xd800 && previous <= 0xdbff ? end - 1 : end;
}

const indexMismatch = "Git patch does not match its file index; inspect retained source manually";

/** Raw status and numstat use the same no-renames options and NUL-delimited order. */
function sectionCounts(cwd: string, args: string[], names: string[]): number[] {
	const counts: number[] = [];
	let pending = "",
		sections = 0;
	readGitOutput(cwd, [...args.slice(0, 2), "--raw", "-z", ...args.slice(2)], (chunk) => {
		const records = (pending + chunk).split("\0");
		pending = records.pop()!;
		for (const record of records) {
			if (sections) {
				if (record !== names[counts.length]) throw new Error(indexMismatch);
				counts.push(sections);
				sections = 0;
			} else {
				const status = /^:[0-7]{6} [0-7]{6} [a-f0-9]+ [a-f0-9]+ ([ADMT])$/.exec(record);
				if (!status) throw new Error(indexMismatch);
				sections = status[1] === "T" ? 2 : 1;
			}
		}
	});
	if (pending || sections || counts.length !== names.length) throw new Error(indexMismatch);
	return counts;
}

/** Git section boundaries use LF; Unicode separators remain source content. */
class PatchCollector {
	private pending = "";
	private lineStart = true;
	private position = -1;
	private sectionsLeft = 0;
	private collecting = false;
	private fits = true;
	private text = "";
	private readonly patches = new Map<string, string>();
	constructor(
		private readonly names: string[],
		private readonly counts: number[],
		private readonly selected: Set<string>,
		private budget: number,
	) {}
	consume(chunk: string): void {
		const text = this.pending + chunk;
		this.process(text, safeReadEnd(text));
	}
	private process(text: string, end: number): void {
		let start = 0;
		for (const match of text.matchAll(/(?:^|\n)diff --git /g)) {
			const position = match.index! + (match[0].startsWith("\n") ? 1 : 0);
			if (position === 0 && !this.lineStart) continue;
			if (position >= end) break;
			this.append(text.slice(start, position));
			this.nextFile();
			start = position;
		}
		this.append(text.slice(start, end));
		if (end) this.lineStart = text[end - 1] === "\n";
		this.pending = text.slice(end);
	}
	private nextFile(): void {
		if (this.sectionsLeft) {
			this.sectionsLeft--;
			return;
		}
		this.completeFile();
		if (++this.position >= this.names.length) throw new Error(indexMismatch);
		this.sectionsLeft = this.counts[this.position] - 1;
		this.collecting = this.selected.has(this.names[this.position]);
		this.fits = true;
		this.text = "";
	}
	private append(text: string): void {
		if (!this.collecting || !this.fits) return;
		const escaped = escapeDiffText(text);
		if (this.text.length + escaped.length > this.budget) {
			this.fits = false;
			this.text = "";
		} else this.text += escaped;
	}
	private completeFile(): void {
		if (this.collecting && this.fits) {
			this.patches.set(this.names[this.position], this.text);
			this.budget -= this.text.length;
		}
	}
	finish(): Map<string, string> {
		this.process(this.pending, this.pending.length);
		this.completeFile();
		if (this.position + 1 !== this.names.length || this.sectionsLeft)
			throw new Error(indexMismatch);
		return this.patches;
	}
}

export function reviewPatches(
	cwd: string,
	args: string[],
	names: string[],
	page: string[],
	budget: number,
): Map<string, string> {
	const collect = new PatchCollector(
		names,
		sectionCounts(cwd, args, names),
		new Set(page.filter(sourcePathAllowed)),
		budget,
	);
	const scan = secretScanner();
	readGitOutput(cwd, args, (chunk) => {
		// Screening continues through the entire stream even after a file exceeds display space.
		scan(chunk);
		collect.consume(chunk);
	});
	return collect.finish();
}
