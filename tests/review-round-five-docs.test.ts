import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("review documentation explains typechange grouping and shared preparation enforcement", () => {
	for (const file of ["docs/architecture.md", "docs/security.md", "docs/workflows.md"]) {
		const text = readFileSync(file, "utf8");
		assert.match(text, /typechange/i, `${file} must explain typechange patch grouping`);
		assert.match(text, /two sections/);
		assert.match(text, /one file budget/);
		assert.match(text, /Git entry/);
		assert.match(text, /preparation/);
	}
	assert.match(readFileSync("docs/workflows.md", "utf8"), /actual pagination length/);
	assert.match(readFileSync("docs/security.md", "utf8"), /ENOTDIR/);
});
