import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("MemPalace MCP client reports the package version without starting a server", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "poly-memory-version-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const config = join(root, "memory");
	mkdirSync(join(config, "palace"), { recursive: true });
	writeFileSync(join(config, "palace/chroma.sqlite3"), "fixture, never opened");
	writeFileSync(join(root, "mempalace-mcp"), "Never executed");
	chmodSync(join(root, "mempalace-mcp"), 0o755);
	const previous = { ...process.env };
	t.after(() => {
		for (const key of ["PATH", "MEMPALACE_CONFIG_DIR"])
			if (previous[key] === undefined) delete process.env[key];
			else process.env[key] = previous[key];
	});
	process.env.PATH = root;
	process.env.MEMPALACE_CONFIG_DIR = config;
	const url =
		"data:text/javascript," +
		encodeURIComponent(`
export const clients = [];
export class Client {
 constructor(info) { clients.push(info); }
 async connect() {}
 async close() {}
}`);
	const fixture = await import(url);
	const hooks = registerHooks({
		resolve(specifier, context, next) {
			if (specifier === "@modelcontextprotocol/sdk/client/index.js")
				return { shortCircuit: true, url };
			return next(specifier, context);
		},
	});
	t.after(() => hooks.deregister());
	const module: string = "../src/memory.ts?client-version";
	const { connectMemPalace } = await import(module);
	const connection = await connectMemPalace();
	t.after(() => connection.close());
	const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
	assert.deepEqual(fixture.clients, [{ name: "pi-poly-agent", version: pkg.version }]);
});
