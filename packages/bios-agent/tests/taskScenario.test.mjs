/**
 * BM-05 演示的永久回归：真实 CLI 子进程跑完整任务/交接闭环。
 *
 * 断言方式与 BM-03/BM-04 演示一致：解析单个 JSON 对象的 `status` 与每步 `ok`，
 * 不只看子进程退出码（退出码只证明"没崩"，证明不了语义）。
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";
import { PACKAGE_ROOT } from "./helpers/projectFixtures.mjs";

const SCENARIO = join(PACKAGE_ROOT, "cli", "task-scenario.mjs");

/** @returns {{ status: string, steps: Array<{ name: string, ok: boolean }>, failures: string[] }} */
function runScenario() {
	const stdout = execFileSync(process.execPath, [SCENARIO], { cwd: PACKAGE_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 300_000 });
	return JSON.parse(stdout.trim());
}

test("BM-05 演示：任务事实/交接包/清单重验/经验沉淀，全部步骤符合预期", () => {
	const summary = runScenario();
	assert.equal(summary.failures.length, 0, `失败步骤：${JSON.stringify(summary.failures)}`);
	for (const step of summary.steps) assert.equal(step.ok, true, `步骤未通过：${step.name}`);
	assert.equal(summary.status, "ok");
	assert.ok(summary.steps.length >= 7, "演示必须覆盖方案 C3 的 7 组步骤");
});

test("BM-05 演示：重复运行仍然全部通过（可复现，不依赖上一次残留）", () => {
	const again = runScenario();
	assert.equal(again.status, "ok", `失败步骤：${JSON.stringify(again.failures)}`);
});
