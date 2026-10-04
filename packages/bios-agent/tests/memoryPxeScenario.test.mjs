/**
 * BM-M1：**合成 PXE 场景演示**的可复现回归。
 *
 * 演示脚本 `cli/memory-scenario.mjs` 调用真实 M1 API（不是写死期望字符串），
 * 这里用真实子进程跑它并断言六类结果、授权泄漏面与确定性。
 *
 * 全部合成数据；不读真实客户资料，也不新增生产命令。
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCENARIO = fileURLToPath(new URL("../cli/memory-scenario.mjs", import.meta.url));

/** @param {string[]} args */
function runScenario(args) {
	const stdout = execFileSync(process.execPath, [SCENARIO, ...args], { cwd: PACKAGE_ROOT, encoding: "utf8", timeout: 60_000 });
	return { stdout, payload: JSON.parse(stdout.trim()) };
}

test("PXE 场景演示：一次输出可复现的六类结果（真实 M1 API）", () => {
	const { stdout, payload } = runScenario([]);

	assert.equal(payload.scenario, "pxe-board-b");
	assert.equal(payload.intent, "current");
	assert.equal(payload.status, "ok", "场景本身没有预算/关系不完整问题");
	assert.equal(payload.dropped, 0);

	const byId = new Map(payload.items.map((item) => [item.recordId, item]));

	// 当前可用：范围与依赖快照都对得上的 Board B 经验。
	assert.equal(byId.get("exp-board-b-verified").class, "current");
	assert.equal(byId.get("exp-board-b-verified").verification.strongestPassed, "board-boot", "有真实上板验证时报告上板，而不是编译");

	// 仅供参考：v1 形态（没有生效区间/依赖快照）。
	assert.equal(byId.get("exp-legacy-note").class, "reference");
	assert.ok(byId.get("exp-legacy-note").reasons.includes("legacy-unspecified"));

	// 撤回声明方：**真实存在的当期记录**（关系两端都能解析到具名记录身份，R27-2）。
	assert.equal(byId.get("exp-board-b-retract").class, "current");
	assert.equal(byId.get("exp-board-b-retract").family, "experience-card");

	// 待确认：未来才生效的需求 + 与人工确认值不一致的新检测候选（两者都要人工看）。
	assert.equal(byId.get("exp-future-pxe").class, "needs-review");
	assert.ok(byId.get("exp-future-pxe").reasons.includes("not-yet-effective"));
	assert.equal(byId.get("detect-pxe-default").class, "needs-review");
	assert.ok(byId.get("detect-pxe-default").reasons.includes("needs-confirmation"));
	assert.ok(byId.get("detect-pxe-default").reasons.includes("field-unconfirmed"), "检测结果只是候选，不是已确认字段");
	assert.equal(byId.get("profile-board-b").class, "needs-review", "确认值也不静默通过，差异交人工");

	// 排除：Board A 的经验在 Board B 目标上不适用；被撤回结论与被撤回结论的旧摘要都不复活。
	assert.equal(byId.get("exp-board-a").class, "excluded");
	assert.ok(byId.get("exp-board-a").reasons.includes("scope-mismatch"));
	assert.equal(byId.get("exp-retracted").class, "excluded");
	assert.ok(byId.get("exp-retracted").reasons.includes("retracted"));
	assert.equal(byId.get("summary-session-42").class, "excluded");
	assert.ok(byId.get("summary-session-42").reasons.includes("summary-derived"));

	// 计数与实际内容一致（不靠实现自报数字互证）。
	const counted = Object.values(payload.counts).reduce((sum, value) => sum + value, 0);
	assert.equal(counted, payload.items.length);
	assert.equal(payload.counts.current, 2, "当期可用：Board B 已验证经验 + 撤回声明方");
	assert.equal(payload.counts.excluded, 3);
	assert.equal(payload.counts["needs-review"], 3);
	assert.equal(payload.counts.reference, 1);
});

test("PXE 场景演示：未授权客户资料在任何输出面都不出现", () => {
	const { stdout, payload } = runScenario([]);
	assert.equal(
		payload.items.some((item) => item.recordId === "exp-other-customer"),
		false,
	);
	assert.doesNotMatch(stdout, /私密现象|customer-other|exp-other-customer/, "未授权候选不得借标题、ID 或计数泄漏");
	assert.equal(payload.dropped, 0, "计数也不能反映被拒材料");

	// history 意图同样受授权约束。
	const history = runScenario(["--intent", "history"]);
	assert.equal(history.payload.intent, "history");
	assert.equal(
		history.payload.items.some((item) => item.recordId === "exp-other-customer"),
		false,
	);
	assert.doesNotMatch(history.stdout, /私密现象|customer-other/, "history 不能绕授权");
	assert.equal(history.payload.counts.history >= 1, true, "history 意图下被替代/撤回的事实带历史标记可见");
});

test("PXE 场景演示：相同输入输出逐字节一致；非法意图受控拒绝", () => {
	const first = runScenario([]).stdout;
	const second = runScenario([]).stdout;
	assert.equal(first, second, "纯决策必须确定性");

	let code = 0;
	let stderr = "";
	try {
		execFileSync(process.execPath, [SCENARIO, "--intent", "everything"], { cwd: PACKAGE_ROOT, encoding: "utf8", timeout: 60_000 });
	} catch (error) {
		code = error.status;
		stderr = error.stderr ?? "";
	}
	assert.equal(code, 2);
	assert.match(stderr, /未知意图/);
});
