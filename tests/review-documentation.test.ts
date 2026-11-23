import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("review guidance keeps literal paths canonical offsets and required sizes aligned", () => {
	for (const file of ["docs/architecture.md", "docs/security.md", "docs/workflows.md"]) {
		const text = readFileSync(file, "utf8");
		assert.match(
			text,
			/one ordered changed-file index/,
			`${file} must describe one shared pagination index`,
		);
		assert.match(text, /refused by path policy/);
		assert.match(text, /deleted or replaced/);
		assert.match(text, /required size/);
		assert.doesNotMatch(text, /source-filtered metadata|index filtered by/);
	}
	const architecture = readFileSync("docs/architecture.md", "utf8");
	assert.match(architecture, /one worktree walk per view/);
	assert.doesNotMatch(architecture, /measured-size diagnostics/);
	const security = readFileSync("docs/security.md", "utf8");
	assert.match(security, /Default_Ignorable_Code_Point/);
	assert.match(security, /U\+2800/);
});
