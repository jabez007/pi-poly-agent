import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrap } from "../src/profile.ts";
import { loadPlatform } from "../src/platform/config.ts";
import {
	IntegrationReviewRequired,
	loadIntegrations,
	validateIntegrations,
} from "../src/platform/integrations.ts";
import { ProviderRegistry } from "../src/platform/providers.ts";
import { defaultPolicy } from "../src/policy.ts";

const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "poly-integrity-"));
	const profile = join(root, "profile");
	const directory = join(root, "reviewed");
	const marker = join(root, "executed");
	bootstrap(profile);
	mkdirSync(directory);
	const entry = join(directory, "entry.mjs");
	const helper = join(directory, "helper.mjs");
	writeFileSync(helper, 'export const evidence = "reviewed";');
	writeFileSync(
		entry,
		`import { writeFileSync } from 'node:fs'; import { evidence } from './helper.mjs'; writeFileSync(${JSON.stringify(marker)}, evidence); export const version = 1; export function setup(host) { host.resources.skills.evidence = evidence; }`,
	);
	const approval: any = {
		path: entry,
		sha256: digest(entry),
		trust: "application-code",
		root: directory,
		files: { "entry.mjs": digest(entry), "helper.mjs": digest(helper) },
	};
	const save = (entries = [approval]) =>
		writeFileSync(
			join(profile, "integrations.json"),
			JSON.stringify({ version: 1, modules: entries }),
		);
	const load = () => loadIntegrations(profile, new ProviderRegistry(defaultPolicy));
	save();
	return { root, profile, directory, marker, entry, helper, approval, save, load };
}

test("entry-only review requires explicit acknowledgment of unverified imports", async () => {
	const f = fixture();
	delete f.approval.root;
	delete f.approval.files;
	f.save();
	await assert.rejects(f.load(), /inventory|entry-only-unverified-imports/);
	assert.equal(existsSync(f.marker), false);
	f.approval.integrity = "entry-only-unverified-imports";
	f.save();
	assert.equal((await f.load()).resources.skills.evidence, "reviewed");
});

test("unchanged directory approvals remain valid and reviewed dependency updates need fresh process loading", async () => {
	const f = fixture();
	assert.equal((await f.load()).resources.skills.evidence, "reviewed");
	writeFileSync(f.helper, 'export const evidence = "updated";');
	await assert.rejects(f.load(), /file changed/);
	f.approval.files["helper.mjs"] = digest(f.helper);
	f.save();
	assert.doesNotThrow(() => validateIntegrations(f.profile));
	await assert.rejects(f.load(), /restart Pi/);
	const fresh = spawnSync(
		process.execPath,
		[
			"--import",
			"tsx",
			"--input-type=module",
			"-e",
			`
import { loadIntegrations } from './src/platform/integrations.ts';
import { ProviderRegistry } from './src/platform/providers.ts';
import { defaultPolicy } from './src/policy.ts';
const loaded = await loadIntegrations(${JSON.stringify(f.profile)}, new ProviderRegistry(defaultPolicy));
if (loaded.resources.skills.evidence !== 'updated') throw new Error('Updated dependency was not loaded');
`,
		],
		{ encoding: "utf8" },
	);
	assert.equal(fresh.status, 0, "Reapproved fixture must load in a new process");
	assert.equal(readFileSync(f.marker, "utf8"), "updated");
});

for (const mutation of [
	"entry",
	"dependency",
	"missing",
	"added",
	"symlink",
	"escape",
	"trust",
] as const) {
	test(`integration ${mutation} tampering fails before top-level execution`, async () => {
		const f = fixture();
		if (mutation === "entry")
			writeFileSync(f.entry, readFileSync(f.entry, "utf8") + "\n// changed");
		if (mutation === "dependency") writeFileSync(f.helper, 'export const evidence = "tampered";');
		if (mutation === "missing") rmSync(f.helper);
		if (mutation === "added") writeFileSync(join(f.directory, "unexpected.mjs"), "export {};");
		if (mutation === "symlink") {
			rmSync(f.helper);
			symlinkSync(f.entry, f.helper);
		}
		if (mutation === "escape") {
			f.approval.files["../helper.mjs"] = f.approval.files["helper.mjs"];
			delete f.approval.files["helper.mjs"];
		}
		if (mutation === "trust") f.approval.trust = "project-approved";
		f.save();
		await assert.rejects(f.load());
		assert.equal(existsSync(f.marker), false);
	});
}

test("all integration approvals are checked before any module executes", async () => {
	const f = fixture();
	f.save([f.approval, { ...f.approval, sha256: "0".repeat(64) }]);
	await assert.rejects(f.load(), /checksum/);
	assert.equal(existsSync(f.marker), false);
});

test("failed initialization still requires restart after reapproval instead of using cached code", async () => {
	const f = fixture();
	writeFileSync(
		f.entry,
		'export const version = 1; export function setup() { throw new Error("initialization failed"); }',
	);
	f.approval.sha256 = f.approval.files["entry.mjs"] = digest(f.entry);
	f.save();
	await assert.rejects(f.load(), /initialization failed/);
	await assert.rejects(f.load(), /restart Pi/);
	writeFileSync(
		f.entry,
		'export const version = 1; export function setup(host) { host.resources.skills.evidence = "replacement"; }',
	);
	f.approval.sha256 = f.approval.files["entry.mjs"] = digest(f.entry);
	f.save();
	await assert.rejects(f.load(), /restart Pi/);
});

test("project JSON cannot authorize integrations or packages", () => {
	const f = fixture();
	const project = join(f.root, "project");
	mkdirSync(join(project, ".pi"), { recursive: true });
	for (const overrides of [{ integrations: [f.approval] }, { packages: ["pi:untrusted"] }]) {
		writeFileSync(join(project, ".pi/poly.json"), JSON.stringify({ version: 1, ...overrides }));
		assert.throws(() => loadPlatform(f.profile, project));
		assert.equal(existsSync(f.marker), false);
	}
});

test("missing trust, unknown integrity modes and ambiguous scope metadata fail before execution", async () => {
	for (const override of [
		{ trust: undefined },
		{ integrity: "whole-import-graph" },
		{ integrity: "entry-only-unverified-imports" },
		{ root: undefined },
	]) {
		const f = fixture();
		Object.assign(f.approval, override);
		f.save();
		await assert.rejects(f.load());
		assert.equal(existsSync(f.marker), false);
	}
});

test("module path aliases and symlinked review roots cannot evade cache or inventory checks", async () => {
	const f = fixture();
	f.approval.path = f.directory + "/./entry.mjs";
	f.save();
	await assert.rejects(f.load(), /absolute module path/);
	const alias = join(f.root, "alias");
	symlinkSync(f.directory, alias);
	f.approval.path = join(alias, "entry.mjs");
	f.approval.root = alias;
	f.save();
	await assert.rejects(f.load(), /symlink/);
	assert.equal(existsSync(f.marker), false);
});

test("directory review does not attest imports outside its root, which retain application-code authority", async () => {
	const f = fixture();
	const outside = join(f.root, "external.mjs");
	writeFileSync(outside, 'export const evidence = "external application code";');
	writeFileSync(f.entry, readFileSync(f.entry, "utf8").replace("./helper.mjs", "../external.mjs"));
	f.approval.sha256 = f.approval.files["entry.mjs"] = digest(f.entry);
	f.save();
	assert.equal((await f.load()).resources.skills.evidence, "external application code");
	writeFileSync(outside, 'export const evidence = "outside the reviewed inventory";');
	assert.doesNotThrow(() => validateIntegrations(f.profile));
});

test("actionable integration review diagnostics never interpolate configuration values", () => {
	const f = fixture();
	f.approval.trust = "fixture-private-value";
	f.save();
	assert.throws(
		() => validateIntegrations(f.profile),
		(error) => {
			assert.ok(error instanceof IntegrationReviewRequired);
			assert.match(error.message, /explicit trust/);
			assert.ok(!error.message.includes("fixture-private-value"));
			return true;
		},
	);
});
