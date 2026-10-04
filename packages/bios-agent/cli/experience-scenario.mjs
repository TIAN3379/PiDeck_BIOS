#!/usr/bin/env node
/**
 * BM-04 **跨项目经验参考演示**（`node cli/experience-scenario.mjs`）。
 *
 * 每一步都用**子进程**跑真实 CLI（`cli/project.mjs` 绑定/确认，`cli/business.mjs` 录入/审核/检索），
 * 因此"新进程读回"和"跨进程竞争"都是真的；只对合成临时目录读写，不读任何真实客户资料。
 *
 * 场景（对应 bm04_development_plan.md §4）：
 * 1. 绑定合成项目 A/B，由**人工确认**表达 A=Insyde/Intel、B=AMI/AMD（不是检测器自动识别）；
 * 2. 录入客户 PXE 需求（含别名与原始验收条件）与 A 的经验草稿；
 * 3. 新进程读回；draft 不作当前推荐；人工审核后重新检索；
 * 4. 在 B 按别名找回 A 的经验并展示参考口径（跨平台需移植评审、B 尚未验证）；
 * 5. 未授权客户/项目/需求不可见；端点 deny/unknown 明确降级；
 * 6. 废弃后当前检索不再推荐，显式 history 可以解释；
 * 7. 预算不足如实报告；经验操作不改动项目确认与其它工作区数据。
 *
 * 输出：一段可解析 JSON（`status` + `steps`），任一步不符合预期则 exit 1。
 */
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { initializeKnowledgeStore } from "../core/storage/index.ts";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const PROJECT_CLI = join(PACKAGE_ROOT, "cli", "project.mjs");
const BUSINESS_CLI = join(PACKAGE_ROOT, "cli", "business.mjs");

/**
 * @typedef {{
 *   status?: string, code?: string, exitCode?: number, projectId?: string, workspaceId?: string,
 *   revision?: number | null,
 *   featureId?: string, experienceId?: string,
 *   usableAsReference?: boolean, referenceReasons?: string[],
 *   links?: Array<{ experienceId: string, found: boolean, reason: string | null }>,
 *   status_after?: string | null,
 *   hits?: Array<{ family: string, recordId: string, revision: number, recordedStatus: string, recommendation: string, reasons: string[], snippet: string | null, sourceProjectId: string | null, declaredValidations: Array<{ kind: string, result: string }> }>,
 *   scanned?: { experiences: number, features: number, recordsRead: number, recordsSkipped: number },
 *   matchedButDropped?: number, unreadable?: number, problems?: string[],
 *   reference?: { sourceProjectId: string, problem: string, rootCause: string, solution: string, appliesWhen: string[], doesNotApplyWhen: string[], declaredValidations: Array<{ kind: string, result: string }>, reuseScope: { level: string } } | null,
 *   recommendation?: string | null, reasons?: string[], porting?: { referenceOnly: boolean, needsPortingReview: boolean, reasons: string[] },
 *   profileRevision?: number | null, registryRevision?: number | null, changedFields?: string[], usable?: boolean,
 *   stateAfter?: string | null, action?: string
 * }} CliPayload
 */

/** @type {Array<Record<string, unknown>>} */
const steps = [];
/** @type {string[]} */
const failures = [];

/**
 * 跑真实 CLI 子进程（返回退出码与解析后的 JSON）。
 * @param {string} cli @param {string[]} args @returns {{ code: number, json: CliPayload | null, stdout: string }}
 */
function runCli(cli, args) {
	try {
		const stdout = execFileSync(process.execPath, [cli, ...args], { cwd: PACKAGE_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 });
		return { code: 0, json: JSON.parse(stdout.trim()), stdout };
	} catch (error) {
		const failure = /** @type {{ status?: number, stdout?: string }} */ (error);
		const stdout = typeof failure.stdout === "string" ? failure.stdout : "";
		let json = null;
		try {
			json = JSON.parse(stdout.trim());
		} catch {
			json = null;
		}
		return { code: typeof failure.status === "number" ? failure.status : 1, json, stdout };
	}
}

/** @param {string} name @param {Record<string, unknown>} detail @param {boolean} ok */
function record(name, detail, ok) {
	steps.push({ name, ok, ...detail });
	if (!ok) failures.push(name);
}

/** @param {unknown} condition @param {string} message @returns {asserts condition} */
function assert(condition, message) {
	if (!condition) throw new Error(message);
}

/** @param {string} text @returns {string} */
function sha256(text) {
	return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

const base = await mkdtemp(join(tmpdir(), "bm04-scenario-"));
const root = join(base, "knowledge");
const workspaceA = join(base, "ws-a");
const workspaceB = join(base, "ws-b");

/** @param {string} platformName @returns {string} */
const dsc = (platformName) => ["[Defines]", `  PLATFORM_NAME = ${platformName}`, "", "[Components]", "  Sample.inf", ""].join("\n");
/** @param {string} workspace @returns {string[]} */
const projectArgs = (workspace) => ["--root", root, "--cwd", workspace, "--authorized-root", workspaceA, "--authorized-root", workspaceB, "--json"];
const businessArgs = ["--root", root, "--json"];

try {
	await mkdir(join(workspaceA, "Platform"), { recursive: true });
	await mkdir(join(workspaceB, "Platform"), { recursive: true });
	await (await import("node:fs/promises")).writeFile(join(workspaceA, "Platform", "A.dsc"), dsc("PlatformA"));
	await (await import("node:fs/promises")).writeFile(join(workspaceB, "Platform", "B.dsc"), dsc("PlatformB"));
	await initializeKnowledgeStore({ root });

	// ---- 1) 绑定两个合成项目，并由人工确认平台身份（不是检测器识别） ----
	const boundA = runCli(PROJECT_CLI, ["bind", ...projectArgs(workspaceA), "--workspace", workspaceA, "--write"]);
	assert(boundA.code === 0, `绑定 A 失败：${boundA.stdout}`);
	const boundB = runCli(PROJECT_CLI, ["bind", ...projectArgs(workspaceB), "--workspace", workspaceB, "--write"]);
	assert(boundB.code === 0, `绑定 B 失败：${boundB.stdout}`);
	const projectA = /** @type {string} */ (boundA.json?.projectId);
	const projectB = /** @type {string} */ (boundB.json?.projectId);
	const workspaceAId = /** @type {string} */ (boundA.json?.workspaceId);

	const openedA = runCli(PROJECT_CLI, ["open", ...projectArgs(workspaceA), "--workspace", workspaceA]);
	const confirmedA = runCli(PROJECT_CLI, [
		"confirm",
		...projectArgs(workspaceA),
		"--project-id",
		projectA,
		"--workspace-id",
		workspaceAId,
		"--revision",
		String(openedA.json?.profileRevision ?? 0),
		"--set",
		"ibv=Insyde",
		"--set",
		"chipsetVendor=Intel",
		"--set",
		"boardName=BoardA",
		"--operator",
		"engineer-scenario",
		"--write",
	]);
	assert(confirmedA.code === 0, `确认 A 失败：${confirmedA.stdout}`);
	const openedB = runCli(PROJECT_CLI, ["open", ...projectArgs(workspaceB), "--workspace", workspaceB]);
	const confirmedB = runCli(PROJECT_CLI, [
		"confirm",
		...projectArgs(workspaceB),
		"--project-id",
		projectB,
		"--workspace-id",
		boundB.json?.workspaceId ?? "",
		"--revision",
		String(openedB.json?.profileRevision ?? 0),
		"--set",
		"ibv=AMI",
		"--set",
		"chipsetVendor=AMD",
		"--set",
		"boardName=BoardB",
		"--operator",
		"engineer-scenario",
		"--write",
	]);
	assert(confirmedB.code === 0, `确认 B 失败：${confirmedB.stdout}`);
	record("绑定并人工确认两个合成项目", { projectA, projectB, confirmedARevision: confirmedA.json?.revision ?? null, confirmedBRevision: confirmedB.json?.revision ?? null }, projectA !== projectB && confirmedA.json?.status === "confirmed" && confirmedB.json?.status === "confirmed");

	// 经验操作前的档案指纹：后面用来证明"经验操作不改动项目确认"。
	const profileABefore = await readFile(join(root, "projects", projectA, "profile.json"), "utf8");

	// ---- 2) 录入需求与经验草稿（关联指向真实记录） ----
	const createdFeature = runCli(BUSINESS_CLI, [
		"feature-create",
		...businessArgs,
		"--feature-id",
		"feat-pxe",
		"--requirement",
		"客户要求关闭 PXE 以缩短启动时间",
		"--alias",
		"PXE",
		"--alias",
		"静默启动",
		"--customer",
		"customer-alpha",
		"--customer-status",
		"confirmed",
		"--product-line",
		"line-x",
		"--product-line-status",
		"confirmed",
		"--acceptance",
		"开机不再尝试 PXE 引导",
		"--write",
	]);
	assert(createdFeature.code === 0, `录入需求失败：${createdFeature.stdout}`);
	const draft = runCli(BUSINESS_CLI, [
		"experience-create",
		...businessArgs,
		"--experience-id",
		"exp-pxe-a",
		"--problem",
		"PXE 默认开启导致启动变慢",
		"--root-cause",
		"平台默认值未关闭 PXE",
		"--solution",
		"在平台 DSC 里关闭 PXE 默认值",
		"--source-project",
		projectA,
		"--feature-id",
		"feat-pxe",
		"--applies-when",
		"客户要求快速启动",
		"--does-not-apply-when",
		"需要网络引导的产线",
		"--reuse-level",
		"customer",
		"--reuse-customer",
		"customer-alpha",
		"--validation",
		"compile:PlatformA:passed:1700000000000:engineer-scenario",
		"--write",
	]);
	assert(draft.code === 0, `录入经验草稿失败：${draft.stdout}`);
	const featureDetail = runCli(BUSINESS_CLI, ["feature-show", ...businessArgs, "--feature-id", "feat-pxe", "--authorized-project", projectA, "--allowed-feature-id", "feat-pxe", "--customer-id", "customer-alpha"]);
	const draftSearch = runCli(BUSINESS_CLI, ["search", ...businessArgs, "--query", "PXE", "--authorized-project", projectA, "--allowed-feature-id", "feat-pxe", "--customer-id", "customer-alpha", "--target-project", projectB, "--endpoint", "allowed"]);
	const draftHits = draftSearch.json?.hits ?? [];
	const draftExperience = draftHits.find((hit) => hit.recordId === "exp-pxe-a");
	record(
		"录入需求与经验草稿；draft 不作当前可信推荐",
		{
			featureRevision: createdFeature.json?.revision ?? null,
			experienceStatus: draft.json?.status_after ?? null,
			links: featureDetail.json?.links ?? [],
			draftRecommendation: draftExperience?.recommendation ?? null,
			draftReasons: draftExperience?.reasons ?? [],
		},
		createdFeature.json?.status === "created" && draft.json?.status_after === "draft" && (featureDetail.json?.links ?? []).length === 0 && draftExperience !== undefined && draftExperience.recommendation === "needs-review" && draftExperience.reasons.includes("not-reviewed"),
	);

	// ---- 3) 新进程读回 + 人工审核（并验证审计事实） ----
	const reread = runCli(BUSINESS_CLI, ["experience-show", ...businessArgs, "--experience-id", "exp-pxe-a"]);
	assert(reread.code === 0, `读回经验失败：${reread.stdout}`);
	const reviewed = runCli(BUSINESS_CLI, ["review", ...businessArgs, "--experience-id", "exp-pxe-a", "--revision", String(reread.json?.revision ?? 0), "--action", "submit-review", "--operator", "engineer-scenario", "--reason", "现象与复现步骤完整", "--write"]);
	assert(reviewed.code === 0, `审核失败：${reviewed.stdout}`);
	record(
		"新进程读回草稿并经人工审核（写入审计事件）",
		{ rereadRevision: reread.json?.revision ?? null, reviewStatus: reviewed.json?.status ?? null, stateAfter: reviewed.json?.stateAfter ?? null, revision: reviewed.json?.revision ?? null },
		reread.json?.revision === 0 && reviewed.json?.status === "applied" && reviewed.json?.stateAfter === "reviewed",
	);

	// ---- 4) 在 B 按别名找回 A 的经验，并给出跨平台参考口径 ----
	const byAlias = runCli(BUSINESS_CLI, ["search", ...businessArgs, "--query", "静默启动", "--authorized-project", projectA, "--allowed-feature-id", "feat-pxe", "--customer-id", "customer-alpha", "--target-project", projectB, "--endpoint", "allowed"]);
	const aliasHits = byAlias.json?.hits ?? [];
	const featureHit = aliasHits.find((hit) => hit.family === "feature-record");
	const reference = runCli(BUSINESS_CLI, ["reference", ...businessArgs, "--experience-id", "exp-pxe-a", "--authorized-project", projectA, "--target-project", projectB, "--customer-id", "customer-alpha", "--endpoint", "allowed"]);
	const referencePayload = reference.json;
	record(
		"在 B 按别名找回 A 的经验：展示参考内容与移植口径",
		{
			aliasHitFields: featureHit !== undefined,
			recommendation: referencePayload?.recommendation ?? null,
			reasonCount: (referencePayload?.reasons ?? []).length,
			declaredValidations: referencePayload?.reference?.declaredValidations ?? [],
			portingReasons: referencePayload?.porting?.reasons ?? [],
			linkFound: (runCli(BUSINESS_CLI, ["feature-show", ...businessArgs, "--feature-id", "feat-pxe", "--authorized-project", projectA, "--allowed-feature-id", "feat-pxe"]).json?.links ?? []).map((link) => link.found),
		},
		featureHit !== undefined &&
			reference.code === 0 &&
			referencePayload?.reference?.rootCause?.includes("默认值") === true &&
			(referencePayload?.reference?.appliesWhen ?? []).includes("客户要求快速启动") &&
			(referencePayload?.reference?.declaredValidations ?? []).length === 1 &&
			(referencePayload?.porting?.reasons ?? []).some((reason) => /移植参考/.test(reason)) &&
			(referencePayload?.porting?.reasons ?? []).some((reason) => /目标项目不同/.test(reason)),
	);

	// ---- 5) 未授权不可见；端点策略明确降级 ----
	const noAuth = runCli(BUSINESS_CLI, ["search", ...businessArgs, "--query", "PXE", "--customer-id", "customer-alpha", "--target-project", projectB, "--endpoint", "allowed"]);
	const otherCustomer = runCli(BUSINESS_CLI, ["search", ...businessArgs, "--query", "PXE", "--authorized-project", projectA, "--customer-id", "customer-beta", "--target-project", projectB, "--endpoint", "allowed"]);
	const endpointDenied = runCli(BUSINESS_CLI, ["search", ...businessArgs, "--query", "PXE", "--authorized-project", projectA, "--customer-id", "customer-alpha", "--endpoint", "denied"]);
	const endpointUnknown = runCli(BUSINESS_CLI, ["search", ...businessArgs, "--query", "PXE", "--authorized-project", projectA, "--customer-id", "customer-alpha", "--target-project", projectB, "--endpoint", "unknown"]);
	const noAuthExperience = (noAuth.json?.hits ?? []).some((hit) => hit.family === "experience-card");
	record(
		"未授权客户/项目不可见；端点 deny/unknown 明确降级",
		{
			noAuthExperienceHit: noAuthExperience,
			noAuthLeaksBody: noAuth.stdout.includes("平台默认值未关闭 PXE"),
			otherCustomerHits: (otherCustomer.json?.hits ?? []).length,
			deniedHits: (endpointDenied.json?.hits ?? []).length,
			unknownRecommendation: (endpointUnknown.json?.hits ?? [])[0]?.recommendation ?? null,
			unknownReasons: (endpointUnknown.json?.hits ?? [])[0]?.reasons ?? [],
		},
		// 来源项目没有授权 ⇒ 经验卡连 ID/标题/片段都不出现；客户不匹配 ⇒ 需求也不出现。
		!noAuthExperience && !noAuth.stdout.includes("平台默认值未关闭 PXE") && !noAuth.stdout.includes("exp-pxe-a") && otherCustomer.json?.hits?.length === 0 && (endpointDenied.json?.hits ?? []).length === 0 && (endpointUnknown.json?.hits ?? [])[0]?.recommendation === "reference",
	);

	// ---- 6) 废弃后当前检索不再推荐；history 可以解释 ----
	const openedForDeprecate = runCli(BUSINESS_CLI, ["experience-show", ...businessArgs, "--experience-id", "exp-pxe-a"]);
	const deprecated = runCli(BUSINESS_CLI, ["review", ...businessArgs, "--experience-id", "exp-pxe-a", "--revision", String(openedForDeprecate.json?.revision ?? 0), "--action", "deprecate", "--operator", "engineer-scenario", "--reason", "新平台已内置修复", "--write"]);
	assert(deprecated.code === 0, `废弃失败：${deprecated.stdout}`);
	const currentAfterDeprecate = runCli(BUSINESS_CLI, ["search", ...businessArgs, "--query", "PXE", "--authorized-project", projectA, "--customer-id", "customer-alpha", "--target-project", projectB, "--endpoint", "allowed"]);
	const historyAfterDeprecate = runCli(BUSINESS_CLI, ["search", ...businessArgs, "--query", "PXE", "--intent", "history", "--authorized-project", projectA, "--customer-id", "customer-alpha", "--target-project", projectB, "--endpoint", "allowed"]);
	const currentHit = (currentAfterDeprecate.json?.hits ?? []).find((hit) => hit.recordId === "exp-pxe-a");
	const historyHit = (historyAfterDeprecate.json?.hits ?? []).find((hit) => hit.recordId === "exp-pxe-a");
	record(
		"废弃后当前检索不再推荐，显式 history 能解释它的废弃",
		{ currentRecommendation: currentHit?.recommendation ?? null, currentReasons: currentHit?.reasons ?? [], historyRecommendation: historyHit?.recommendation ?? null, recordedStatus: historyHit?.recordedStatus ?? null },
		currentHit?.recommendation === "excluded" && currentHit.reasons.includes("deprecated") && historyHit?.recommendation === "history" && historyHit.recordedStatus === "deprecated",
	);

	// ---- 7) 预算不足如实报告；经验操作不改动项目确认 ----
	const limited = runCli(BUSINESS_CLI, ["search", ...businessArgs, "--query", "启动", "--authorized-project", projectA, "--allowed-feature-id", "feat-pxe", "--customer-id", "customer-alpha", "--target-project", projectB, "--endpoint", "allowed", "--limit", "1"]);
	const profileAAfter = await readFile(join(root, "projects", projectA, "profile.json"), "utf8");
	record(
		"预算不足如实报告不完整；经验操作不改动项目确认",
		{
			limitedStatus: limited.json?.status ?? null,
			limitedExit: limited.code,
			matchedButDropped: limited.json?.matchedButDropped ?? null,
			profileUnchanged: sha256(profileAAfter) === sha256(profileABefore),
			confirmedBoard: JSON.parse(profileAAfter).identity.boardName.value,
		},
		limited.json?.status === "incomplete" && limited.code === 7 && (limited.json?.matchedButDropped ?? 0) >= 1 && sha256(profileAAfter) === sha256(profileABefore) && JSON.parse(profileAAfter).identity.boardName.value === "BoardA",
	);

	const summary = {
		scenario: "bm04-cross-project-reference",
		status: failures.length === 0 ? "ok" : "failed",
		projects: { a: projectA, b: projectB },
		steps,
		failures,
		notes: [
			"全部数据是合成需求/经验与临时目录；A=Insyde/Intel、B=AMI/AMD 由**人工确认**写入，不是检测器识别结果。",
			"每一步都是真实 CLI 子进程；检索、审核与跨项目参考都走 core 领域 API。",
			"演示不执行移植、构建或刷板：跨平台结论只作参考（porting.referenceOnly）。",
			"演示里的“声明验证级别”来自合成记录，不代表真实硬件验收。",
		],
	};
	process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
	if (failures.length > 0) process.exitCode = 1;
} catch (error) {
	process.stdout.write(`${JSON.stringify({ scenario: "bm04-cross-project-reference", status: "failed", error: error instanceof Error ? error.message : String(error), steps, failures }, null, 2)}\n`);
	process.exitCode = 1;
} finally {
	await rm(base, { recursive: true, force: true });
}
