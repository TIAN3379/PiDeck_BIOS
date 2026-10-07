/** A genuinely live second process owns a pending reflection until the test releases it. */
import assert from "node:assert/strict";
import { currentAutomationBootId } from "../../extensions/automationState.ts";
import { recordReflectionMark } from "../../extensions/automationRuntime.ts";
import { readWorkspaceState } from "../../core/automation/store.ts";

const target = JSON.parse(process.env.BIOS_TEST_REFLECTION_TARGET);
assert.equal((await recordReflectionMark({ ...target, requestKey: "live-owner-request", runId: "live-owner-run", saved: false, attempts: 1, finished: false, ownerBootId: currentAutomationBootId(), ownerSessionId: "live-owner-session" })).status, "ok");
process.on("message", async (message) => {
	if (message === "verify") {
		const result = await readWorkspaceState(target);
		process.send({ kind: "verified", mark: result.value.reflectionMarks.find((mark) => mark.requestKey === "live-owner-request") });
	}
	if (message === "stop") process.disconnect();
});
process.send({ kind: "ready", bootId: currentAutomationBootId() });
