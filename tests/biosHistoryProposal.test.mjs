import test from "node:test";
import assert from "node:assert/strict";
import { encodeBiosHistoryEvidence, parseBiosHistoryProposal } from "../src/renderer/src/components/bios/knowledge/biosHistoryProposal.ts";

const expected = { token: "analysis-a", commit: "a".repeat(40) };
const proposal = { ...expected, problem: "S3", rootCause: "", solution: "patch", appliesWhen: ["source board"], doesNotApplyWhen: [] };
test("HX evidence JSON preserves exact data without triggering chat references/commands", () => {
	const evidence = { diff: "@@ -1 +1 @@\n+ @file &session /compact", path: "a/Board.c" };
	const encoded = encodeBiosHistoryEvidence(evidence);
	assert.doesNotMatch(encoded, /[@&/]/);
	assert.deepEqual(JSON.parse(encoded), evidence);
});
test("HX-03 accepts bounded JSON, preserves unknown facts, rejects managed fields and wrong analysis", () => {
	assert.deepEqual(parseBiosHistoryProposal(JSON.stringify(proposal), expected), proposal);
	assert.equal(parseBiosHistoryProposal("```json\n" + JSON.stringify(proposal) + "\n```", expected).rootCause, "");
	for (const extra of [{ token: "old" }, { commit: "b".repeat(40) }, { status: "verified" }, { customer: "Guessed" }, { sourceProjectId: "foreign" }, { validations: ["passed"] }, { solution: "x".repeat(8001) }, { appliesWhen: [42] }])
		assert.throws(() => parseBiosHistoryProposal(JSON.stringify({ ...proposal, ...extra }), expected));
	assert.throws(() => parseBiosHistoryProposal("x".repeat(40001), expected));
	assert.throws(() => parseBiosHistoryProposal("Explanation " + JSON.stringify(proposal), expected));
});
