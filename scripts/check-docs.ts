import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const prose = (text: string) => text.replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gm, "");
function jsonExamples(file: string, text: string): string[] {
	const errors: string[] = [];
	for (const match of text.matchAll(/^```json\n([\s\S]*?)^```\s*$/gm)) {
		try {
			JSON.parse(match[1]);
		} catch {
			errors.push(`${file}: invalid JSON example`);
		}
	}
	return errors;
}
function anchors(text: string): Set<string> {
	return new Set(
		[...prose(text).matchAll(/^#{1,6}\s+(.+)$/gm)].map((match) =>
			match[1]
				.toLowerCase()
				.replace(/[^\p{L}\p{N}\s_-]/gu, "")
				.replace(/\s/g, "-"),
		),
	);
}

/** Repository Markdown links and literal npm-run commands, without network requests. */
export function checkDocumentation(root: string): string[] {
	const files = [
		"README.md",
		...readdirSync(join(root, "docs"))
			.filter((file) => file.endsWith(".md"))
			.map((file) => `docs/${file}`),
	];
	const scripts = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts;
	const errors: string[] = [];
	for (const file of files) {
		const text = readFileSync(join(root, file), "utf8");
		errors.push(...jsonExamples(file, text));
		for (const match of prose(text).matchAll(/!?\[[^\]]*\]\(([^\s)]+)\)/g)) {
			const target = match[1];
			if (/^(?:[a-z]+:|\/\/)/i.test(target)) continue;
			const [path, anchor] = target.split("#");
			const absolute = path
				? resolve(root, dirname(file), decodeURIComponent(path))
				: join(root, file);
			if (!existsSync(absolute)) errors.push(`${file}: missing local link ${target}`);
			else if (
				anchor &&
				absolute.endsWith(".md") &&
				!anchors(readFileSync(absolute, "utf8")).has(decodeURIComponent(anchor))
			)
				errors.push(`${file}: missing heading ${target}`);
		}
		for (const match of text.matchAll(/\bnpm run ([a-z][a-z0-9:-]*)/g)) {
			if (!Object.hasOwn(scripts, match[1])) errors.push(`${file}: unknown npm script ${match[1]}`);
		}
	}
	return errors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	const errors = checkDocumentation(resolve(import.meta.dirname, ".."));
	if (errors.length) {
		console.error(errors.join("\n"));
		process.exitCode = 1;
	} else console.log("Documentation links, headings and npm scripts are consistent.");
}
