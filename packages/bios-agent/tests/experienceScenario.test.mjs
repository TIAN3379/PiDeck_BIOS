/**
 * BM-04 端到端回归：跨项目经验参考演示（真实子进程）+ 业务 CLI 契约。
 *
 * 演示脚本本身逐步启动真实 CLI 子进程，所以这条用例覆盖的是"整条链路在进程边界上仍然成立"：
 * 绑定/确认 → 录入需求与草稿 → 审核 → 跨项目检索与参考 → 未授权不可见 → 废弃与 history → 预算不足。
 *
 * 只断言"每一步都符合预期"与关键不变量，不比对 UUID 或临时绝对路径。
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCENARIO = join(PACKAGE_ROOT, "cli", "experience-scenario.mjs");
const BUSINESS_CLI = join(PACKAGE_ROOT, "cli", "business.mjs");

function runScenario() {
	const stdout = execFileSync(process.execPath, [SCENARIO], { cwd: PACKAGE_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 240_000 });
	return JSON.parse(stdout.trim());
}

function runCli(args) {
	try {
		const stdout = execFileSync(process.execPath, [BUSINESS_CLI, ...args], { cwd: PACKAGE_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
		return { code: 0, stdout };
	} catch (error) {
		return { code: typeof error.status === "number" ? error.status : 1, stdout: typeof error.stdout === "string" ? error.stdout : "" };
	}
}

function parseSingleJson(text) {
	const trimmed = text.trim();
	assert.notEqual(trimmed, "", "stdout 不能为空");
	const parsed = JSON.parse(trimmed);
	assert.equal(Array.isArray(parsed), false);
	return parsed;
}

test("BM-04 演示：录入→审核→跨项目参考→废弃→预算，全部步骤符合预期", () => {
	const summary = runScenario();
	assert.equal(summary.scenario, "bm04-cross-project-reference");
	assert.equal(summary.status, "ok", `失败步骤：${JSON.stringify(summary.failures)}`);
	assert.deepEqual(summary.failures, []);
	assert.ok(summary.steps.length >= 7, `步骤太少（${summary.steps.length}）`);

	const byName = new Map(summary.steps.map((step) => [step.name, step]));
	// 每一个步骤都必须真的通过。
	for (const step of summary.steps) assert.equal(step.ok, true, `步骤未通过：${step.name} → ${JSON.stringify(step)}`);

	// 人工确认表达平台身份（不是检测器识别）。
	const bound = byName.get("绑定并人工确认两个合成项目");
	assert.notEqual(bound.projectA, bound.projectB);
	assert.equal(bound.confirmedARevision, 1);
	assert.equal(bound.confirmedBRevision, 1);

	// draft 不作当前推荐；审核后才是 reviewed。
	const draftStep = byName.get("录入需求与经验草稿；draft 不作当前可信推荐");
	assert.equal(draftStep.experienceStatus, "draft");
	assert.equal(draftStep.draftRecommendation, "needs-review");

	// 跨项目参考口径：移植参考 + 目标项目不同 + 来源证据闭环（R29-2）。
	const referenceStep = byName.get("在 B 按别名找回 A 的经验：展示参考内容、来源证据与移植口径");
	assert.equal(referenceStep.declaredValidations[0].kind, "compile");
	assert.equal(referenceStep.evidenceCount, 1, "参考详情必须展示顶层来源证据");
	assert.equal(referenceStep.sourceCommit, null, "没有带 commit 的合法 EvidenceRef 时必须明确未知");
	assert.equal(referenceStep.featureRequirement, "客户要求关闭 PXE 以缩短启动时间", "显式授权时展示关联需求原文");
	assert.ok(referenceStep.portingReasons.some((reason) => /移植参考/.test(reason)));
	assert.ok(referenceStep.portingReasons.some((reason) => /目标项目不同/.test(reason)));

	// R29-1：公开读取入口缺省拒绝来源授权（不泄漏正文）。
	const denyStep = byName.get("公开读取入口缺省拒绝来源授权：不给（用法错误）或给错（拒绝）都不返回经验内容");
	assert.equal(denyStep.withoutAuthExit, 2);
	assert.equal(denyStep.unauthorizedExit, 3);
	assert.equal(denyStep.leaksBody, false);

	// 未授权与端点策略。
	const authStep = byName.get("未授权客户/项目不可见；端点 deny/unknown 明确降级");
	assert.equal(authStep.noAuthExperienceHit, false);
	assert.equal(authStep.noAuthLeaksBody, false, "未授权不得泄漏正文片段");
	assert.equal(authStep.otherCustomerHits, 0);
	assert.equal(authStep.deniedHits, 0);
	assert.equal(authStep.unknownRecommendation, "reference");

	// 废弃与 history。
	const deprecated = byName.get("废弃后当前检索不再推荐，显式 history 能解释它的废弃");
	assert.equal(deprecated.currentRecommendation, "excluded");
	assert.equal(deprecated.historyRecommendation, "history");

	// 预算与"不改动项目确认"。
	const budget = byName.get("预算不足如实报告不完整；经验操作不改动项目确认");
	assert.equal(budget.limitedStatus, "incomplete");
	assert.equal(budget.profileUnchanged, true, "经验操作不得改写项目确认");
	assert.equal(budget.confirmedBoard, "BoardA");
});

test("BM-04 演示：重复运行仍然全部通过（可复现，不依赖残留）", () => {
	const first = runScenario();
	const second = runScenario();
	assert.equal(first.status, "ok");
	assert.equal(second.status, "ok");
	assert.notEqual(first.projects.a, second.projects.a, "身份按运行生成，不能当成固定身份");
});

test("业务 CLI：参数白名单、写确认、JSON 单对象与退出码", () => {
	// help 与未知命令。
	assert.equal(runCli(["help"]).code, 0);
	assert.match(runCli(["help"]).stdout, /feature-create/);
	assert.equal(runCli(["deploy", "--json"]).code, 2);
	const unknownCommand = parseSingleJson(runCli(["deploy", "--json"]).stdout);
	assert.equal(unknownCommand.code, "invalid-argument");
	assert.equal(unknownCommand.exitCode, 2);

	// 拼错的选项在任何 IO 之前被拒绝（不是"静默忽略后照常读库"）。
	const typo = runCli(["search", "--root", PACKAGE_ROOT, "--qu ery", "x", "--json"]);
	assert.equal(typo.code, 2);

	// 缺少必填 --root / --query。
	assert.equal(runCli(["search", "--query", "x", "--json"]).code, 2);
	assert.equal(runCli(["search", "--root", PACKAGE_ROOT, "--json"]).code, 2);

	// 写确认缺失：exit 3 且明确列出"本来会做什么"。
	const refused = runCli(["feature-create", "--root", PACKAGE_ROOT, "--feature-id", "feat-x", "--requirement", "需求", "--json"]);
	assert.equal(refused.code, 3);
	const refusedPayload = parseSingleJson(refused.stdout);
	assert.equal(refusedPayload.code, "write-not-confirmed");
	assert.equal(refusedPayload.exitCode, 3);
	assert.ok(Array.isArray(refusedPayload.wouldDo) && refusedPayload.wouldDo.length > 0);

	// 字段确认程度必须成对给出。
	const halfDeclared = runCli(["feature-create", "--root", PACKAGE_ROOT, "--feature-id", "feat-x", "--requirement", "需求", "--customer", "c", "--write", "--json"]);
	assert.equal(halfDeclared.code, 2);
	assert.match(parseSingleJson(halfDeclared.stdout).message, /customer-status/);

	// 非法枚举与安全整数越界。
	assert.equal(runCli(["search", "--root", PACKAGE_ROOT, "--query", "x", "--intent", "future", "--json"]).code, 2);
	assert.equal(runCli(["search", "--root", PACKAGE_ROOT, "--query", "x", "--limit", "1e30", "--json"]).code, 2);
	assert.equal(runCli(["review", "--root", PACKAGE_ROOT, "--experience-id", "exp-x", "--revision", "0", "--action", "publish", "--operator", "o", "--reason", "r", "--write", "--json"]).code, 2);
});
