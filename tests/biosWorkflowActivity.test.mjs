import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
const { projectWorkflowActivity } = loadTsCommonJs("src/renderer/src/components/bios/workflowActivity.ts");
const { stripToolResultForDelivery } = loadTsCommonJs("src/main/pi/agentUtils.ts");
const { biosWorkflowTaskReceipt } = loadTsCommonJs("src/shared/biosWorkflowReceipt.ts");
const message = (id, result, extra = {}) => ({ id, role: "tool", timestamp: 1, meta: { toolName: "bios_manage_task", result, ...extra } });
test("CW 活动只显示真实保存回执，失败/冲突不冒充成功", () => {
	const cases = [
		["created", "saved"],
		["updated", "saved"],
		["selected", "read"],
		["revision-conflict", "attention"],
		["declined", "attention"],
		["failed", "attention"],
	];
	for (const [status, state] of cases) assert.equal(projectWorkflowActivity([message(status, JSON.stringify({ status }))])[0].state, state);
	assert.equal(projectWorkflowActivity([message("broken", "truncated JSON")])[0].state, "read");
	assert.equal(projectWorkflowActivity([message("busy", "", { status: "running" })])[0].state, "running");
	assert.equal(projectWorkflowActivity([message("error", "", { isError: true })])[0].state, "attention");
});

test("WM 任务回执仅投影有效具名选择；无授权/正文/上下文ACK", () => {
	const value = { status: "created", projectId: "11111111-1111-1111-1111-111111111111", taskId: "task-real", secret: "PRIVATE", contextEnabled: true };
	assert.equal(JSON.stringify(biosWorkflowTaskReceipt(JSON.stringify(value))), JSON.stringify({ projectId: value.projectId, taskId: value.taskId }));
	for (const invalid of [
		{ ...value, status: "failed" },
		{ ...value, taskId: "../outside" },
		{ ...value, projectId: "not-an-id" },
	])
		assert.equal(biosWorkflowTaskReceipt(JSON.stringify(invalid)), undefined);
	const delivered = stripToolResultForDelivery([message("real", JSON.stringify(value))]);
	assert.equal(JSON.stringify(delivered[0].meta.biosWorkflowTask), JSON.stringify({ projectId: value.projectId, taskId: value.taskId }));
	assert.ok(!JSON.stringify(delivered).includes("PRIVATE"));
	assert.equal(stripToolResultForDelivery([message("error", JSON.stringify(value), { isError: true })])[0].meta.biosWorkflowTask, undefined);
});
test("CW 活动有界且不泄露正文，只投影当前传入的会话", () => {
	const messages = Array.from({ length: 250 }, (_, i) => message(String(i), JSON.stringify({ status: "created", secret: "PRIVATE" })));
	messages.push({ id: "not-tool", role: "assistant", meta: { toolName: "bios_fake" } });
	const projected = projectWorkflowActivity(messages);
	assert.equal(projected.length, 6);
	assert.equal(projected[0].id, "249");
	assert.ok(!JSON.stringify(projected).includes("PRIVATE"));
	assert.equal(projectWorkflowActivity([]).length, 0);
});

test("CW 生产瘦身链剥离正文后仍保留真实保存/失败状态", () => {
	for (const [status, state] of [
		["created", "saved"],
		["revision-conflict", "attention"],
	]) {
		const delivered = stripToolResultForDelivery([message("real", JSON.stringify({ status, secret: "PRIVATE" }))]);
		assert.equal(delivered[0].meta.result, undefined);
		assert.equal(projectWorkflowActivity(delivered)[0].state, state);
		assert.ok(!JSON.stringify(delivered).includes("PRIVATE"));
	}
});
