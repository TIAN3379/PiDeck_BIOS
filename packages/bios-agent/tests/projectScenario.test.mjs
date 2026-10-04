/**
 * BM-03 **合成端到端演示**的永久回归（真实子进程跑 `cli/project-scenario.mjs`）。
 *
 * 演示脚本本身调用真实 CLI 子进程，因此这条用例覆盖的是"整条链路在真实进程边界上仍然成立"：
 * 绑定 → 检测 → 确认 → 新进程读回 → 证据/HEAD 变化 → 显式刷新 → 第二工作区不串快照。
 *
 * 只断言"每一步都符合预期"（`step.ok`）与关键不变量，不比对绝对路径或 UUID
 * （它们每次运行都不同，写死会把输出当成产品身份）。
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCENARIO = join(PACKAGE_ROOT, "cli", "project-scenario.mjs");

function runScenario() {
	const stdout = execFileSync(process.execPath, [SCENARIO], { cwd: PACKAGE_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 180_000 });
	return JSON.parse(stdout.trim());
}

test("BM-03 演示：绑定→检测→确认→新进程读回→变化提示→双工作区，全部步骤符合预期", () => {
	const summary = runScenario();

	assert.equal(summary.scenario, "bm03-project-facts");
	assert.equal(summary.status, "ok", `失败步骤：${JSON.stringify(summary.failures)}`);
	assert.deepEqual(summary.failures, []);
	assert.ok(summary.steps.length >= 10, `步骤太少（${summary.steps.length}），演示可能被截断`);

	// 每一步都必须真的通过（不是只跑通脚本）。
	const failed = summary.steps.filter((step) => step.ok !== true);
	assert.deepEqual(failed, [], "所有演示步骤都必须通过");

	const byName = new Map(summary.steps.map((step) => [step.name, step]));
	const refused = byName.get("未确认写入被拒绝");
	assert.equal(refused.exitCode, 3);
	assert.equal(refused.code, "write-not-confirmed");

	const readBack = byName.get("新进程读回同一身份与确认值");
	assert.equal(readBack.sameProject, true);
	assert.equal(readBack.sameWorkspace, true);
	assert.equal(readBack.profileRevision, readBack.expectedRevision, "读到的 profile revision 必须等于写回者报告的那一版");
	assert.equal(readBack.boardNameClass, "current");

	const drift = byName.get("证据变化 / HEAD 变化：结论退回待复核，确认值未被覆写");
	assert.equal(drift.boardNameClass, "needs-review");
	assert.ok(drift.boardNameReasons.includes("verification-drift"));
	assert.ok(drift.buildTargetsReasons.includes("needs-confirmation"), "检测候选与确认值的差异必须交人工");
	assert.equal(drift.storedBoardName.value, "SyntheticBoardA", "变化提示不得覆写人工确认值");
	assert.equal(drift.storedBoardName.status, "confirmed");

	const second = byName.get("第二工作区独立快照，不与第一工作区互串");
	assert.notEqual(second.workspaceA.head, second.workspaceB.head, "两个工作区必须有各自的 HEAD");
	assert.equal(second.readBWorkspace, summary.workspaces.b);

	const outside = byName.get("未授权路径在 IO 之前被拒绝");
	assert.equal(outside.code, "not-authorized");
});

test("BM-03 演示：重复运行仍然全部通过（可复现，且不依赖上一次的残留）", () => {
	const first = runScenario();
	const second = runScenario();
	assert.equal(first.status, "ok");
	assert.equal(second.status, "ok");
	assert.deepEqual(second.failures, []);
	// 身份按运行生成 ⇒ 两次的 UUID 必须不同（防止把某次运行的 ID 当固定身份）。
	assert.notEqual(first.projectId, second.projectId);
	assert.notEqual(first.workspaces.a, second.workspaces.a);
});
