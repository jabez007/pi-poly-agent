import { cpSync, mkdirSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function nestedRepository(root: string, worktree: string, directory: string, form: string) {
	const sub = join(worktree, form === "deep" ? "a/b" : "sub");
	mkdirSync(sub, { recursive: true });
	const metadata =
		form === "file" || form === "symlink" ? join(worktree, "metadata") : join(sub, ".git");
	cpSync(join(root, ".git"), metadata, { recursive: true });
	if (form === "file") writeFileSync(join(sub, ".git"), `gitdir: ${metadata}\n`);
	if (form === "symlink") symlinkSync(metadata, join(sub, ".git"));
	const marker = join(directory, "nested-command-marker");
	const filter = join(directory, "fixture-filter.sh");
	writeFileSync(filter, `#!/bin/sh\nprintf invoked > '${marker}'\ncat\n`, { mode: 0o700 });
	const config = join(metadata, "config");
	writeFileSync(
		config,
		`${readFileSync(config, "utf8")}\n[filter "fixture"]\n\tclean = ${filter}\n`,
	);
	writeFileSync(join(sub, ".gitattributes"), "app.txt filter=fixture\n");
	writeFileSync(join(sub, "app.txt"), "before\n");
	const later = new Date(Date.now() + 5000);
	utimesSync(join(sub, "app.txt"), later, later);
	return { sub, marker };
}
