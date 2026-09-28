import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sessionTreeSource = readFileSync("src/renderer/src/components/sidebar/SessionTree.tsx", "utf8");

test("empty non-loading projects retain their final exit, then remove the session-card container", () => {
	assert.match(sessionTreeSource, /const hasRows = catalogLoading \|\| draftSessions\.length > 0 \|\| display\.visibleChildren\.length > 0 \|\| display\.hiddenChildCount > 0;/);
	assert.match(sessionTreeSource, /if\s*\(\s*!hasRows\s*&&\s*!retainingExit\s*\)\s*return\s+null;/);
	assert.match(sessionTreeSource, /onExitComplete\s*=/);
	assert.match(sessionTreeSource, /if\s*\(\s*!hasRows\s*\)\s*setRetainingExit\(false\)/);
});
