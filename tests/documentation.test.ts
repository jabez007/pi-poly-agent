import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkDocumentation } from "../scripts/check-docs.ts";

test("documentation checker validates local links, headings, commands and JSON examples", () => {
	const root = mkdtempSync(join(tmpdir(), "poly-docs-"));
	mkdirSync(join(root, "docs"));
	writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { bootstrap: "fixture" } }));
	writeFileSync(
		join(root, "README.md"),
		"# Fixture\n[guide](docs/guide.md#setup)\nnpm run bootstrap\n",
	);
	writeFileSync(join(root, "docs/guide.md"), '# Guide\n## Setup\n```json\n{"version":1}\n```\n');
	assert.deepEqual(checkDocumentation(root), []);
	writeFileSync(join(root, "README.md"), "[missing](gone.md)\nnpm run unknown\n```json\n{\n```\n");
	assert.equal(checkDocumentation(root).length, 3);
});
