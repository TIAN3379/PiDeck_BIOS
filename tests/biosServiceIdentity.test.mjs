import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { deferred } from "./helpers/biosHookHarness.mjs";

const { resolveBiosService } = loadTsCommonJs("src/main/bios/biosServiceIdentity.ts");
const ref = { agentId: "agent-a", sessionId: "session-a", generation: 2 };
const tab = () => ({ id: "agent-a", deckSessionId: "session-a", runtimeGeneration: 2, status: "idle" });
const model = { provider: "mock", modelId: "model-a", modelEndpointOrigin: "https://api.mock.invalid" };

test("F3: trusted service resolution rechecks session and runtime after delayed RPC", async () => {
	for (const change of ["ended", "generation", "session", "replacement"]) {
		const pending = deferred();
		let current = tab();
		const result = resolveBiosService({ list: () => (current === null ? [] : [current]), getRuntimeState: () => pending.promise }, ref);
		if (change === "ended") current = null;
		if (change === "generation") current.runtimeGeneration++;
		if (change === "session") current.deckSessionId = "other";
		if (change === "replacement") current = tab();
		pending.resolve(model);
		assert.equal(await result, null, change);
	}
	const current = tab();
	assert.deepEqual(JSON.parse(JSON.stringify(await resolveBiosService({ list: () => [current], getRuntimeState: async () => model }, ref))), { provider: "mock", modelId: "model-a", origin: "https://api.mock.invalid" });
});
