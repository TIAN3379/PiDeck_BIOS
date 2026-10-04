#!/usr/bin/env node
/**
 * BM-04 人工入口：**薄**业务 CLI（`node cli/business.mjs <命令>`）。
 *
 * 与 `cli/project.mjs` 同一套骨架（参数白名单、退出码、单对象 JSON）。
 * 领域规则都在 `core/knowledge` 里；这里只做参数解析、调用与受控输出。
 *
 * 纪律：
 * - **显式路径与显式授权**：`--root` 必填；读取经验卡必须给出来源项目授权
 *   （`--authorized-project`），读取需求必须给出需求可见范围（`--allowed-feature-id`）；
 * - **写确认**：`feature-create` / `feature-update` / `experience-create` /
 *   `experience-update` / `review` 必须带 `--write`；
 * - **审核是独立动作**：`review` 命令走既有审核入口，`--action` 与 `--revision` 必填；
 * - **端点策略显式**：`--endpoint allowed|denied|unknown` 默认 `unknown`
 *   （"资料在本地"不等于"允许发给当前模型"）；
 * - 这个入口是给工程师/验收用的本地人工 CLI，**不是**模型可调用的知识写工具。
 */
import process from "node:process";
import { createExperienceDraft, createFeature, readExperienceReference, readFeatureDetail, reviewExperience, searchKnowledge, updateExperienceDraft, updateFeature } from "../core/knowledge/index.ts";
import { EXIT, outcome, parseArgv, refuseWrite, reportError, resolveCommand, setExit, short, takeBool, takeInt, takeList, takeString, UsageError, writeJson } from "./cliArgs.mjs";

const USAGE = `用法：node cli/business.mjs <命令> [选项]（命令与选项顺序无关）

命令：
  feature-create     录入需求本体（需要 --write）
  feature-update     更新需求（需要 --write，CAS）
  feature-show       需求详情 + 关联核对 + 是否可直接复用
  experience-create  录入经验**草稿**（需要 --write；审核状态只能由 review 改）
  experience-update  更新经验草稿正文（需要 --write，CAS）
  experience-show    经验卡详情（含声明的验证级别）
  review             人工审核经验卡（submit-review / request-changes / approve / deprecate / restore）
  search             有界关键词/别名检索（授权先于标题与计数）
  reference          单条经验的跨项目参考详情（含移植口径）
  help               显示本帮助

通用选项：
  --root <绝对路径>            知识根（必填）
  --json                       stdout 输出单个 JSON 对象
  --write                      确认执行写入（缺失时拒绝并 exit 3）

授权与范围（读取经验/需求时必填其一）：
  --authorized-project <uuid>  被授权读取的来源项目（可重复；经验卡按来源项目授权）
  --allowed-feature-id <id>    被授权读取的需求记录 ID（可重复；需求没有项目归属，必须显式给）
  --customer-id <id>           本次目标的客户
  --target-project <uuid>      本次目标项目（跨项目参考与"是否可直接复用"用）

端点策略：
  --endpoint allowed|denied|unknown   能否发给当前模型（默认 unknown ⇒ 只作参考/待复核）
  --allow-internal-general            放行 internal-general 复用的经验（默认不放行）

feature-create：
  --feature-id <id> --requirement <正文> [--alias <文本>（可重复）]
  [--customer <值>] [--customer-status candidate|confirmed]
  [--product-line <值>] [--product-line-status candidate|confirmed]
  [--acceptance <文本>（可重复）] [--related <经验ID>（可重复）]

feature-update：
  --feature-id <id> --revision <非负整数> [--requirement] [--alias ...] [--acceptance ...]
  [--related ...] [--customer] [--customer-status] [--product-line] [--product-line-status]

experience-create：
  --experience-id <id> --problem <正文> --root-cause <正文> --solution <正文>
  --source-project <uuid> [--symptom <正文>] [--feature-id <id>]
  [--applies-when <文本>（可重复）] [--does-not-apply-when <文本>（可重复）]
  [--reuse-level current-project|customer|internal-general]
  [--reuse-customer <id>（可重复）] [--reuse-authorization <说明>]
  [--validation <kind>:<scope>:<result>:<performedAt>:<performedBy>（可重复）]

experience-update：--experience-id <id> --revision <非负整数> [上面任意正文/条件选项]

review：--experience-id <id> --revision <非负整数> --action <动作> --operator <标签> --reason <理由>

search：--query <文本> [--intent current|history] [--limit <正整数>] [--family experience-card|feature-record（可重复）]
  [--status draft|reviewed|verified|deprecated（可重复）]

reference：--experience-id <id>

退出码：0 成功｜2 用法错误｜3 被拒绝（缺 --write / 未授权）｜4 revision 冲突｜5 不一致或不可用｜
6 未找到｜7 取消、IO 失败或结果不完整｜8 已写入但需要人工核对（审计/journal 待收口）`;

/** 选项白名单（可按命令覆写）。 */
const OPTION_SPEC = {
	help: { value: false, repeatable: false },
	json: { value: false, repeatable: false },
	write: { value: false, repeatable: false },
	root: { value: true, repeatable: false },
	"feature-id": { value: true, repeatable: false },
	requirement: { value: true, repeatable: false },
	alias: { value: true, repeatable: true },
	customer: { value: true, repeatable: false },
	"customer-status": { value: true, repeatable: false },
	"product-line": { value: true, repeatable: false },
	"product-line-status": { value: true, repeatable: false },
	acceptance: { value: true, repeatable: true },
	related: { value: true, repeatable: true },
	revision: { value: true, repeatable: false },
	"experience-id": { value: true, repeatable: false },
	problem: { value: true, repeatable: false },
	symptom: { value: true, repeatable: false },
	"root-cause": { value: true, repeatable: false },
	solution: { value: true, repeatable: false },
	"applies-when": { value: true, repeatable: true },
	"does-not-apply-when": { value: true, repeatable: true },
	"source-project": { value: true, repeatable: false },
	"reuse-level": { value: true, repeatable: false },
	"reuse-customer": { value: true, repeatable: true },
	"reuse-authorization": { value: true, repeatable: false },
	validation: { value: true, repeatable: true },
	action: { value: true, repeatable: false },
	operator: { value: true, repeatable: false },
	reason: { value: true, repeatable: false },
	query: { value: true, repeatable: false },
	intent: { value: true, repeatable: false },
	limit: { value: true, repeatable: false },
	family: { value: true, repeatable: true },
	status: { value: true, repeatable: true },
	"authorized-project": { value: true, repeatable: true },
	"allowed-feature-id": { value: true, repeatable: true },
	"customer-id": { value: true, repeatable: false },
	"target-project": { value: true, repeatable: false },
	endpoint: { value: true, repeatable: false },
	"allow-internal-general": { value: false, repeatable: false },
};

/** 每个命令允许的选项（白名单；不在其中的选项在读取任何文件之前拒绝）。 */
const COMMAND_OPTIONS = {
	help: ["help", "json"],
	"feature-create": ["help", "json", "root", "write", "feature-id", "requirement", "alias", "customer", "customer-status", "product-line", "product-line-status", "acceptance", "related"],
	"feature-update": ["help", "json", "root", "write", "feature-id", "revision", "requirement", "alias", "acceptance", "related", "customer", "customer-status", "product-line", "product-line-status"],
	"feature-show": ["help", "json", "root", "feature-id", "authorized-project", "allowed-feature-id", "customer-id"],
	"experience-create": ["help", "json", "root", "write", "experience-id", "problem", "symptom", "root-cause", "solution", "applies-when", "does-not-apply-when", "source-project", "feature-id", "reuse-level", "reuse-customer", "reuse-authorization", "validation"],
	"experience-update": ["help", "json", "root", "write", "experience-id", "revision", "problem", "symptom", "root-cause", "solution", "applies-when", "does-not-apply-when", "feature-id", "reuse-level", "reuse-customer", "reuse-authorization", "validation"],
	"experience-show": ["help", "json", "root", "experience-id"],
	review: ["help", "json", "root", "write", "experience-id", "revision", "action", "operator", "reason"],
	search: ["help", "json", "root", "query", "intent", "limit", "family", "status", "authorized-project", "allowed-feature-id", "customer-id", "target-project", "endpoint", "allow-internal-general"],
	reference: ["help", "json", "root", "experience-id", "authorized-project", "target-project", "customer-id", "endpoint", "allow-internal-general"],
};

/**
 * @typedef {{ flags: Map<string, string | true>, repeated: Map<string, Array<string | true>>, positionals: string[] }} ParsedArgs
 * @typedef {(args: ParsedArgs, asJson: boolean, signal: AbortSignal) => Promise<void>} CommandHandler
 */

const REVIEW_ACTIONS = ["submit-review", "request-changes", "approve", "deprecate", "restore"];

/**
 * `--endpoint allowed|denied|unknown` → 端点策略三态。默认 `unknown`（不放行到 current）。
 * @param {ParsedArgs} args @returns {boolean | null}
 */
function endpointPolicy(args) {
	const raw = takeString(args, "endpoint") ?? "unknown";
	if (raw === "allowed") return true;
	if (raw === "denied") return false;
	if (raw === "unknown") return null;
	throw new UsageError("--endpoint 只能是 allowed / denied / unknown");
}

/**
 * @param {ParsedArgs} args
 * @returns {{ endpointAllowed: boolean | null, allowInternalGeneral: boolean, customers: string[], authorizedProjectIds: string[] }}
 */
function authorizationOf(args) {
	const reuseCustomers = takeList(args, "reuse-customer");
	return {
		endpointAllowed: endpointPolicy(args),
		allowInternalGeneral: takeBool(args, "allow-internal-general"),
		customers: reuseCustomers.length > 0 ? reuseCustomers : takeList(args, "customer-id"),
		authorizedProjectIds: takeList(args, "authorized-project"),
	};
}

/**
 * `--customer <值> --customer-status confirmed`。
 * @param {ParsedArgs} args @param {string} valueFlag @param {string} statusFlag @param {string} label
 * @returns {{ value: string, status: "candidate" | "confirmed" } | undefined}
 */
function declaredField(args, valueFlag, statusFlag, label) {
	const value = takeString(args, valueFlag);
	const status = takeString(args, statusFlag);
	if (value === undefined && status === undefined) return undefined;
	if (value === undefined || status === undefined) throw new UsageError(`${label}：值（--${valueFlag}）与确认程度（--${statusFlag}）必须同时给出`);
	if (status !== "candidate" && status !== "confirmed") throw new UsageError(`${label}：--${statusFlag} 只能是 candidate 或 confirmed`);
	return { value, status };
}

/**
 * `--validation kind:scope:result:performedAt:performedBy`。
 * @param {ParsedArgs} args
 * @returns {Array<{ kind: "code-review" | "compile" | "board-boot" | "stress-loop" | "customer-acceptance", scope: string, result: "passed" | "failed" | "inconclusive", performedAt: number, performedBy: string }>}
 */
function validationsOf(args) {
	return takeList(args, "validation").map((entry) => {
		const parts = entry.split(":");
		if (parts.length < 5) throw new UsageError(`--validation 需要 <kind>:<scope>:<result>:<performedAt>:<performedBy>，实际：${short(entry)}`);
		const kind = /** @type {"code-review" | "compile" | "board-boot" | "stress-loop" | "customer-acceptance"} */ (parts[0] ?? "");
		const scope = parts[1] ?? "";
		const result = /** @type {"passed" | "failed" | "inconclusive"} */ (parts[2] ?? "");
		const performedAt = Number(parts[3]);
		const performedBy = parts.slice(4).join(":");
		if (!Number.isSafeInteger(performedAt) || performedAt < 0) throw new UsageError("--validation 的时间必须是安全非负整数（epoch 毫秒）");
		return { kind, scope, result, performedAt, performedBy };
	});
}

/**
 * @param {ParsedArgs} args
 * @returns {{ level: "current-project" | "customer" | "internal-general", customers: string[], authorization?: string } | undefined}
 */
function reuseOf(args) {
	const level = /** @type {"current-project" | "customer" | "internal-general" | undefined} */ (takeString(args, "reuse-level"));
	const customers = takeList(args, "reuse-customer");
	const authorization = takeString(args, "reuse-authorization");
	if (level === undefined && customers.length === 0 && authorization === undefined) return undefined;
	if (level === undefined) throw new UsageError("给了复用范围参数就必须同时给出 --reuse-level");
	return { level, customers, ...(authorization === undefined ? {} : { authorization }) };
}

/**
 * @param {{ status: "applied" | "audit-pending" | "journal-pending", action: string, stateAfter: string, revision: number, needsReview: readonly string[] }} result
 * @param {boolean} asJson
 */
function reviewOutcome(result, asJson) {
	const exitCode = result.status === "applied" ? EXIT.ok : EXIT.needsReview;
	writeJson({ ...result, ...outcome(result.status === "applied" ? "ok" : result.status, exitCode) });
	if (!asJson) {
		process.stdout.write(`审核：${result.status}（${result.action} → ${result.stateAfter}，revision=${result.revision}）\n`);
		for (const reason of result.needsReview) process.stdout.write(`  需人工核对：${reason}\n`);
	}
	setExit(exitCode);
}

/** @param {ParsedArgs} args @param {boolean} asJson @param {AbortSignal} signal */
async function commandFeatureCreate(args, asJson, signal) {
	const featureId = takeString(args, "feature-id", { required: true });
	const requirement = takeString(args, "requirement", { required: true });
	if (!takeBool(args, "write")) return refuseWrite("feature-create", asJson, [`在 ${takeString(args, "root", { required: true })} 新建需求 ${featureId}`]);
	const result = await createFeature({
		root: takeString(args, "root", { required: true }),
		signal,
		feature: {
			featureId,
			originalRequirement: requirement,
			aliases: takeList(args, "alias"),
			acceptanceCriteria: takeList(args, "acceptance"),
			relatedExperienceIds: takeList(args, "related"),
			...(declaredField(args, "customer", "customer-status", "客户") === undefined ? {} : { customer: declaredField(args, "customer", "customer-status", "客户") }),
			...(declaredField(args, "product-line", "product-line-status", "产品线") === undefined ? {} : { productLine: declaredField(args, "product-line", "product-line-status", "产品线") }),
		},
	});
	const exitCode = result.status === "created" || result.status === "unchanged" ? EXIT.ok : result.status === "revision-conflict" ? EXIT.conflict : EXIT.needsReview;
	if (asJson) writeJson({ ...result, ...outcome(exitCode === EXIT.ok ? "ok" : result.status, exitCode) });
	else process.stdout.write(`需求：${result.status}（revision=${result.revision ?? "-"}）\n`);
	setExit(exitCode);
}

/** @param {ParsedArgs} args @param {boolean} asJson @param {AbortSignal} signal */
async function commandFeatureUpdate(args, asJson, signal) {
	const featureId = takeString(args, "feature-id", { required: true });
	const revision = /** @type {number} */ (takeInt(args, "revision", { required: true }));
	if (!takeBool(args, "write")) return refuseWrite("feature-update", asJson, [`更新需求 ${featureId}（期望 revision=${revision}）`]);
	const changes = {};
	const requirement = takeString(args, "requirement");
	if (requirement !== undefined) changes.originalRequirement = requirement;
	if (args.repeated.has("alias")) changes.aliases = takeList(args, "alias");
	if (args.repeated.has("acceptance")) changes.acceptanceCriteria = takeList(args, "acceptance");
	if (args.repeated.has("related")) changes.relatedExperienceIds = takeList(args, "related");
	const customer = declaredField(args, "customer", "customer-status", "客户");
	if (customer !== undefined) changes.customer = customer;
	const productLine = declaredField(args, "product-line", "product-line-status", "产品线");
	if (productLine !== undefined) changes.productLine = productLine;
	const result = await updateFeature({ root: takeString(args, "root", { required: true }), featureId, expectedRevision: revision, changes, signal });
	const exitCode = result.status === "updated" || result.status === "unchanged" ? EXIT.ok : result.status === "revision-conflict" ? EXIT.conflict : EXIT.needsReview;
	if (asJson) writeJson({ ...result, ...outcome(exitCode === EXIT.ok ? "ok" : result.status, exitCode) });
	else process.stdout.write(`需求：${result.status}（revision=${result.revision ?? "-"}；变更 ${result.changedFields.join("、") || "无"}）\n`);
	setExit(exitCode);
}

/** @param {ParsedArgs} args @param {boolean} asJson */
async function commandFeatureShow(args, asJson) {
	const result = await readFeatureDetail({
		root: takeString(args, "root", { required: true }),
		featureId: takeString(args, "feature-id", { required: true }),
		visibility: { authorizedProjectIds: takeList(args, "authorized-project"), allowedFeatureIds: takeList(args, "allowed-feature-id") },
		customerId: takeString(args, "customer-id") ?? null,
	});
	const exitCode = result.status === "ok" ? EXIT.ok : result.status === "not-authorized" ? EXIT.refused : result.status === "not-found" ? EXIT.notFound : EXIT.inconsistent;
	if (asJson) writeJson({ ...result, ...outcome(result.status === "ok" ? "ok" : result.status, exitCode) });
	else {
		process.stdout.write(`需求：${result.status}（revision=${result.revision ?? "-"}）\n`);
		if (result.feature !== null) process.stdout.write(`  原文：${result.feature.originalRequirement}\n  别名：${result.feature.aliases.join("、") || "（无）"}\n`);
		process.stdout.write(`  可直接复用：${result.usableAsReference}\n`);
		for (const reason of result.referenceReasons) process.stdout.write(`  限制：${reason}\n`);
		for (const link of result.links) process.stdout.write(`  关联 ${link.experienceId}：${link.found ? `found(${link.status})` : `未核对（${link.reason}）`}\n`);
	}
	setExit(exitCode);
}

/** @param {ParsedArgs} args @param {boolean} asJson @param {AbortSignal} signal */
async function commandExperienceCreate(args, asJson, signal) {
	const experienceId = takeString(args, "experience-id", { required: true });
	if (!takeBool(args, "write")) return refuseWrite("experience-create", asJson, [`在 ${takeString(args, "root", { required: true })} 新建经验草稿 ${experienceId}（状态恒为 draft）`]);
	const validations = validationsOf(args);
	const reuse = reuseOf(args);
	const featureId = takeString(args, "feature-id");
	const symptom = takeString(args, "symptom");
	const result = await createExperienceDraft({
		root: takeString(args, "root", { required: true }),
		signal,
		experience: {
			experienceId,
			problem: takeString(args, "problem", { required: true }),
			...(symptom === undefined ? {} : { symptom }),
			rootCause: takeString(args, "root-cause", { required: true }),
			solution: takeString(args, "solution", { required: true }),
			appliesWhen: takeList(args, "applies-when"),
			doesNotApplyWhen: takeList(args, "does-not-apply-when"),
			sourceProjectId: takeString(args, "source-project", { required: true }),
			...(featureId === undefined ? {} : { featureId }),
			...(validations.length === 0 ? {} : { validations }),
			...(reuse === undefined ? {} : { reuse }),
		},
	});
	const exitCode = result.status === "created" ? EXIT.ok : result.status === "revision-conflict" ? EXIT.conflict : EXIT.needsReview;
	if (asJson) writeJson({ ...result, ...outcome(exitCode === EXIT.ok ? "ok" : result.status, exitCode) });
	else process.stdout.write(`经验草稿：${result.status}（revision=${result.revision ?? "-"}，状态 ${result.status_after ?? "-"}）\n`);
	setExit(exitCode);
}

/** @param {ParsedArgs} args @param {boolean} asJson @param {AbortSignal} signal */
async function commandExperienceUpdate(args, asJson, signal) {
	const experienceId = takeString(args, "experience-id", { required: true });
	const revision = /** @type {number} */ (takeInt(args, "revision", { required: true }));
	if (!takeBool(args, "write")) return refuseWrite("experience-update", asJson, [`更新经验草稿 ${experienceId}（期望 revision=${revision}）`]);
	/** @type {Record<string, unknown>} */
	const changes = {};
	/** @type {ReadonlyArray<readonly [string, string]>} */
	const bodyFlags = [
		["problem", "problem"],
		["symptom", "symptom"],
		["root-cause", "rootCause"],
		["solution", "solution"],
		["feature-id", "featureId"],
	];
	for (const [flag, key] of bodyFlags) {
		const value = takeString(args, flag);
		if (value !== undefined) changes[key] = value;
	}
	if (args.repeated.has("applies-when")) changes.appliesWhen = takeList(args, "applies-when");
	if (args.repeated.has("does-not-apply-when")) changes.doesNotApplyWhen = takeList(args, "does-not-apply-when");
	const validations = validationsOf(args);
	if (validations.length > 0) changes.validations = validations;
	const reuse = reuseOf(args);
	if (reuse !== undefined) changes.reuse = reuse;
	// 选项名 → 记录字段名的映射在运行时确定，类型在这里一次性收窄（字段名由 OPTION_SPEC 白名单保证）。
	const draftChanges = /** @type {Partial<Omit<import("../core/knowledge/index.ts").ExperienceDraft, "experienceId" | "sourceProjectId">>} */ (changes);
	const result = await updateExperienceDraft({ root: takeString(args, "root", { required: true }), experienceId, expectedRevision: revision, changes: draftChanges, signal });
	const exitCode = result.status === "updated" || result.status === "unchanged" ? EXIT.ok : result.status === "revision-conflict" ? EXIT.conflict : result.status === "not-draft" ? EXIT.inconsistent : EXIT.needsReview;
	if (asJson) writeJson({ ...result, ...outcome(exitCode === EXIT.ok ? "ok" : result.status, exitCode) });
	else {
		process.stdout.write(`经验草稿：${result.status}（revision=${result.revision ?? "-"}）\n`);
		for (const problem of result.problems) process.stdout.write(`  提示 ${problem}\n`);
	}
	setExit(exitCode);
}

/** @param {ParsedArgs} args @param {boolean} asJson */
async function commandExperienceShow(args, asJson) {
	const experienceId = takeString(args, "experience-id", { required: true });
	const { readExperienceDetail } = await import("../core/knowledge/index.ts");
	const result = await readExperienceDetail({ root: takeString(args, "root", { required: true }), experienceId });
	const exitCode = result.status === "ok" ? EXIT.ok : EXIT.notFound;
	if (asJson) writeJson({ ...result, ...outcome(result.status === "ok" ? "ok" : "not-found", exitCode) });
	else if (result.card !== null) {
		process.stdout.write(`经验：${experienceId}（revision=${result.revision}，状态 ${result.card.status}）\n`);
		process.stdout.write(`  根因：${result.card.rootCause}\n  方案：${result.card.solution}\n`);
		process.stdout.write(`  声明的验证：${result.card.validations.map((validation) => `${validation.kind}:${validation.result}`).join("、") || "（没有声明）"}\n`);
	}
	setExit(exitCode);
}

/** @param {ParsedArgs} args @param {boolean} asJson @param {AbortSignal} signal */
async function commandReview(args, asJson, signal) {
	const experienceId = takeString(args, "experience-id", { required: true });
	const revision = /** @type {number} */ (takeInt(args, "revision", { required: true }));
	const action = takeString(args, "action", { required: true });
	if (!REVIEW_ACTIONS.includes(action)) throw new UsageError(`--action 只能是 ${REVIEW_ACTIONS.join(" / ")}`);
	const reviewAction = /** @type {"submit-review" | "request-changes" | "approve" | "deprecate" | "restore"} */ (action);
	const operator = takeString(args, "operator", { required: true });
	const reason = takeString(args, "reason", { required: true });
	if (!takeBool(args, "write")) return refuseWrite("review", asJson, [`对经验卡 ${experienceId}（期望 revision=${revision}）执行 ${action}，并写入一条审计事件`]);
	try {
		const result = await reviewExperience({ root: takeString(args, "root", { required: true }), experienceId, expectedRevision: revision, action: reviewAction, operatorLabel: operator, reason, signal });
		reviewOutcome(result, asJson);
	} catch (error) {
		// 非法状态迁移等受控拒绝：报成 inconsistent（不是 io-error）。
		reportError(error, asJson, { command: "review" });
	}
}

/** @param {ParsedArgs} args @param {boolean} asJson @param {AbortSignal} signal */
async function commandSearch(args, asJson, signal) {
	const query = takeString(args, "query", { required: true });
	const intent = takeString(args, "intent") ?? "current";
	if (intent !== "current" && intent !== "history") throw new UsageError("--intent 只能是 current 或 history");
	const limit = takeInt(args, "limit");
	const families = takeList(args, "family");
	for (const family of families) {
		if (family !== "experience-card" && family !== "feature-record") throw new UsageError("--family 只能是 experience-card 或 feature-record");
	}
	const statuses = takeList(args, "status");
	const result = await searchKnowledge({
		root: takeString(args, "root", { required: true }),
		query,
		visibility: { authorizedProjectIds: takeList(args, "authorized-project"), allowedFeatureIds: takeList(args, "allowed-feature-id") },
		target: {
			projectId: takeString(args, "target-project") ?? null,
			customerId: takeString(args, "customer-id") ?? null,
		},
		authorization: authorizationOf(args),
		intent,
		...(families.length === 0 ? {} : { filters: { recordFamilies: /** @type {Array<"experience-card" | "feature-record">} */ (families), ...(statuses.length === 0 ? {} : { statuses: /** @type {Array<"draft" | "reviewed" | "verified" | "deprecated">} */ (statuses) }) } }),
		...(limit === undefined ? {} : { limits: { maxSearchResults: limit } }),
		signal,
	});
	const exitCode = result.status === "ok" ? EXIT.ok : EXIT.failed;
	if (asJson) writeJson({ ...result, ...outcome(result.status === "ok" ? "ok" : "incomplete", exitCode) });
	else {
		process.stdout.write(`检索：${result.status}（命中 ${result.hits.length}；扫描 ${result.scanned.recordsRead} 条）\n`);
		for (const hit of result.hits) process.stdout.write(`  ${hit.recommendation} ${hit.family}/${hit.recordId} rev${hit.revision}${hit.reasons.length > 0 ? ` [${hit.reasons.join(",")}]` : ""}\n`);
		for (const problem of result.problems) process.stdout.write(`  提示 ${problem}\n`);
	}
	setExit(exitCode);
}

/** @param {ParsedArgs} args @param {boolean} asJson @param {AbortSignal} signal */
async function commandReference(args, asJson, signal) {
	const authorization = authorizationOf(args);
	const result = await readExperienceReference({
		root: takeString(args, "root", { required: true }),
		experienceId: takeString(args, "experience-id", { required: true }),
		targetProjectId: takeString(args, "target-project") ?? null,
		targetCustomerId: takeString(args, "customer-id") ?? null,
		authorization: { endpointAllowed: authorization.endpointAllowed, allowInternalGeneral: authorization.allowInternalGeneral, customers: authorization.customers, authorizedProjectIds: authorization.authorizedProjectIds },
		signal,
	});
	const exitCode = result.status === "ok" ? EXIT.ok : result.status === "not-found" ? EXIT.notFound : EXIT.inconsistent;
	if (asJson) writeJson({ ...result, ...outcome(result.status === "ok" ? "ok" : result.status, exitCode) });
	else {
		process.stdout.write(`参考：${result.status}（revision=${result.revision ?? "-"}，推荐强度 ${result.recommendation ?? "-"}）\n`);
		if (result.reference !== null) {
			process.stdout.write(`  来源项目 ${result.reference.sourceProjectId}\n  根因：${result.reference.rootCause}\n  方案：${result.reference.solution}\n`);
			process.stdout.write(`  适用：${result.reference.appliesWhen.join("、") || "（未声明）"}\n  不适用：${result.reference.doesNotApplyWhen.join("、") || "（未声明）"}\n`);
			process.stdout.write(`  声明验证：${result.reference.declaredValidations.map((validation) => `${validation.kind}:${validation.result}`).join("、") || "（没有声明）"}\n`);
		}
		for (const reason of result.porting.reasons) process.stdout.write(`  移植口径：${reason}\n`);
	}
	setExit(exitCode);
}

const COMMANDS = {
	"feature-create": commandFeatureCreate,
	"feature-update": commandFeatureUpdate,
	"feature-show": commandFeatureShow,
	"experience-create": commandExperienceCreate,
	"experience-update": commandExperienceUpdate,
	"experience-show": commandExperienceShow,
	review: commandReview,
	search: commandSearch,
	reference: commandReference,
};

async function main() {
	const { command, rest } = resolveCommand(process.argv.slice(2), OPTION_SPEC);
	const allowed = command === undefined ? ["help", "json"] : (COMMAND_OPTIONS[/** @type {keyof typeof COMMAND_OPTIONS} */ (command)] ?? null);
	let args;
	try {
		args = parseArgv(rest, allowed ?? Object.keys(OPTION_SPEC), OPTION_SPEC);
	} catch (error) {
		reportError(error, rest.includes("--json"), { command: command === undefined ? null : short(command) });
		return;
	}
	const asJson = takeBool(args, "json");

	if (command === undefined || command === "help" || takeBool(args, "help")) {
		if (asJson) writeJson({ ...outcome("ok", EXIT.ok), status: "ok", command: "help", usage: USAGE });
		else process.stdout.write(USAGE);
		return;
	}
	const handler = /** @type {Record<string, CommandHandler | undefined>} */ (COMMANDS)[command];
	if (handler === undefined) {
		reportError(new UsageError(`未知命令：${short(command)}（可用：${Object.keys(COMMANDS).join("、")}、help）`), asJson, { command: short(command) });
		return;
	}

	const controller = new AbortController();
	let interrupted = false;
	const onSignal = () => {
		interrupted = true;
		controller.abort();
	};
	process.on("SIGINT", onSignal);
	process.on("SIGTERM", onSignal);
	try {
		await handler(args, asJson, controller.signal);
	} catch (error) {
		reportError(error, asJson, interrupted ? { cancelled: true, detail: "信号中断，已把取消传给领域层" } : {});
	} finally {
		process.off("SIGINT", onSignal);
		process.off("SIGTERM", onSignal);
	}
}

await main();
