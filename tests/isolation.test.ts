import assert from "node:assert/strict";
import { dirname } from "node:path";
import { test } from "node:test";

test("test preload confines Poly and Pi profiles to the temporary test root", () => {
	assert.ok(process.env.PI_POLY_PROFILE, "Poly must never fall back to the checkout profile");
	assert.equal(dirname(process.env.PI_POLY_PROFILE), process.env.HOME);
	assert.equal(dirname(process.env.PI_CODING_AGENT_DIR!), process.env.HOME);
});
