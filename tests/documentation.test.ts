import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkDocumentation } from "../scripts/check-docs.ts";
import { bootstrap } from "../src/profile.ts";
import { loadPlatform } from "../src/platform/config.ts";
import { qualificationPlan } from "../src/orchestration/qualification.ts";

test("documentation local links, heading references and command examples resolve", () => {
	assert.deepEqual(checkDocumentation(resolve(import.meta.dirname, "..")), []);
});

test("documentation verification detects broken links, missing headings and invalid commands", () => {
	const root = mkdtempSync(join(tmpdir(), "poly-docs-"));
	mkdirSync(join(root, "docs"));
	writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { check: "true" } }));
	writeFileSync(
		join(root, "README.md"),
		"[missing](docs/missing.md)\n[heading](docs/valid.md#gone)\n```bash\nnpm run typo\n```\n",
	);
	writeFileSync(join(root, "docs/valid.md"), "# Present heading\n");
	assert.equal(checkDocumentation(root).length, 3);
});

test("application, lockfile, installed Pi and CLI pins agree without upgrading dependencies", () => {
	const pkg = JSON.parse(readFileSync("package.json", "utf8"));
	const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
	assert.equal(lock.version, pkg.version);
	assert.equal(lock.packages[""].version, pkg.version);
	for (const name of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai"]) {
		const installed = JSON.parse(readFileSync(`node_modules/${name}/package.json`, "utf8"));
		assert.equal(pkg.dependencies[name], "1.5.2");
		assert.equal(installed.version, pkg.dependencies[name]);
		assert.equal(lock.packages[`node_modules/${name}`].version, installed.version);
	}
	const cli = JSON.parse(
		readFileSync("node_modules/@earendil-works/pi-coding-agent/package.json", "utf8"),
	);
	assert.equal(cli.bin.pi, "dist/bundle/cli.js");
	const node = readFileSync(".nvmrc", "utf8").trim();
	assert.ok(readFileSync(".github/workflows/check.yml", "utf8").includes(`node-version: ${node}`));
});

test("getting-started JSON loads its documented agent and workflow in a temporary profile", () => {
	const text = readFileSync("docs/getting-started.md", "utf8");
	const example = /```json\n([\s\S]*?)\n```/.exec(text)![1];
	const root = mkdtempSync(join(tmpdir(), "poly-doc-example-"));
	bootstrap(root);
	JSON.parse(example);
	writeFileSync(join(root, "platform.json"), example);
	const config = loadPlatform(root, root);
	assert.equal(config.agents[0].name, "source-reader");
	assert.equal(config.workflows[0].id, "source-note");
});

test("documentation verification rejects invalid JSON examples", () => {
	const root = mkdtempSync(join(tmpdir(), "poly-doc-json-"));
	mkdirSync(join(root, "docs"));
	writeFileSync(join(root, "package.json"), '{"scripts":{}}');
	writeFileSync(join(root, "README.md"), '```json\n{"version": 1\n```\n');
	assert.ok(checkDocumentation(root).some((error) => error.includes("invalid JSON example")));
});

test("qualification review procedure names the generic workflow and its required recipe", () => {
	const plan = qualificationPlan("openai-codex");
	const procedure = plan.scenarios.find((s) => s.id === "review")!.procedure;
	assert.match(procedure, /\/workflow implementation-review/);
	assert.match(procedure, /recipe/);
	const root = mkdtempSync(join(tmpdir(), "poly-doc-qualification-"));
	bootstrap(root);
	writeFileSync(
		join(root, "platform.json"),
		JSON.stringify({ version: 1, recipes: ["implementation-review"] }),
	);
	const config = loadPlatform(root, root);
	assert.ok(config.workflows.some((w) => w.id === "implementation-review"));
});
