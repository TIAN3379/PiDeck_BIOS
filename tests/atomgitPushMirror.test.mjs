import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

test("BIOS Agent does not install or run an automatic pre-push mirror", () => {
	const pkg = JSON.parse(readFileSync("package.json", "utf8"));
	assert.equal(pkg.scripts.prepare, undefined);
	assert.equal(pkg.scripts["hooks:install"], undefined);
	assert.equal(existsSync(".githooks/pre-push"), false);
});

test("normal postinstall behavior remains available", () => {
	const pkg = JSON.parse(readFileSync("package.json", "utf8"));
	assert.equal(pkg.scripts.postinstall, "node scripts/fix-pty-permissions.js");
});
