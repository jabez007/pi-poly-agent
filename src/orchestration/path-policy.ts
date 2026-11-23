import { isAbsolute } from "node:path";

/** Metadata checks must agree even when the filesystem folds filename case. */
export function gitMetadataName(name: string): boolean {
	return /^\.git(\.|$)/i.test(name);
}

export function pathHasUnicodeSpace(path: string): boolean {
	return /[\u00a0\u2000-\u200a\u202f\u205f\u3000]/.test(path);
}

/** Git names are relative to the worktree; filesystem and symlink checks stay in the file tools. */
export function sourcePathAllowed(path: string): boolean {
	return (
		!!path &&
		!path.startsWith("..") &&
		!isAbsolute(path) &&
		!pathHasUnicodeSpace(path) &&
		!path
			.split("/")
			.some(
				(part) => gitMetadataName(part) || /^\.(poly|env|aws|claude|codex|ssh)(\.|$)/i.test(part),
			)
	);
}

export const literalFileMessage =
	'review_diff requires a literal file path; use path "." for the paginated file index';
export function assertLiteralSourceFiles(files: string[], requested: string): void {
	if (files.length > 1 || files.some((file) => file !== requested || !sourcePathAllowed(file)))
		throw new Error(literalFileMessage);
}
