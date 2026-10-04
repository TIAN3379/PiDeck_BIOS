/**
 * 审核动作的**纯策略**：状态流转、reviewer 规则、证据下标校验、after 组装（BM-02C2B / C2B-2）。
 *
 * 为什么单独成模块：这些规则是"产品语义"，而 `writer.ts` 是"取锁 → 落盘 → 提交 → 收口"的
 * IO 时序。混在一起会让"改成什么状态、谁算审核人"这种可单测的规则只活在一条 IO 链里，
 * 想验证它就得准备一个知识库。
 *
 * 三条不变量（每条都对应一个真实后果）：
 *
 * 1. **状态只能按 `AUDIT_ACTION_TRANSITIONS` 走**：审核入口不接受调用方指定 `toStatus`，
 *    否则"人工批准"可以被伪造成任意跳转（`draft → verified` 直达等）。
 * 2. **reviewer 不等于操作者**：只有 `approve` 才把操作者记成审核人；打回/重新提交会**清除**
 *    审核人；废弃**保留**原审核人（废弃不是一次审核通过）。恢复器永远不填 reviewer——
 *    它只搬运已落盘的决定。
 * 3. **内部 status 与 from/to 完全对应**：`after.status` 直接取自动作表推出来的 `toStatus`，
 *    不允许"记了事件但记录状态没变"。
 */
import { type Static, Type } from "typebox";
import { AUDIT_ACTION_TRANSITIONS, AUDIT_EVIDENCE_MAX_ITEMS, AuditEvidenceRefSchema, collectAuditEvidenceIssues, collectSchemaIssues, describeAuditIssues, describeAuditTransitions, isAuditAction, type AuditAction, type AuditEvidenceRef, type ExperienceStatus } from "../../contracts/index.ts";
import { ExperienceCardSchema, type ExperienceCard } from "../../contracts/records.ts";
import { describeIssues, validateRecord, validateShape } from "../../contracts/validate.ts";
import { StorageError } from "../errors.ts";

/**
 * 证据关联的**输入形态** schema（R1）。
 *
 * 为什么入口必须自己先跑一遍：`evidence` 是外部 `unknown`。旧实现把它强转成
 * `AuditEvidenceRef[]` 再交给策略层逐项读 `ref.kind`，于是 `evidence:[null]` 抛的是
 * **裸 TypeError**（没有结构化 code），调用方无法据此提示或重试。这里复用事件/意图的
 * 同一份元素 schema，因此"什么算合法元素"只有一处定义。
 */
const EVIDENCE_LIST_SCHEMA = Type.Array(AuditEvidenceRefSchema, { maxItems: AUDIT_EVIDENCE_MAX_ITEMS });

/** 一个动作对 `reviewer` 字段的效果。 */
export type ReviewerEffect = "clear" | "set-operator" | "keep";

/**
 * 动作 → reviewer 效果（唯一来源；改这里必须同步 `decisions` 的用例与实施记录）。
 *
 * - `clear`：进入"待审"或"退回修改"，此时没有审核人；
 * - `set-operator`：本次操作者就是批准人（`operatorLabel` 是声明，不是身份认证）；
 * - `keep`：废弃/其它不改变审核人的动作，保留原值——**不**把废弃者冒充成审核人。
 */
export const REVIEW_REVIEWER_EFFECT: Readonly<Record<AuditAction, ReviewerEffect>> = {
	"submit-review": "clear",
	"request-changes": "clear",
	approve: "set-operator",
	deprecate: "keep",
	restore: "clear",
};

/** 运行时守卫：非法动作明确报错（而不是走到 `AUDIT_ACTION_TRANSITIONS[action]` 变成 undefined）。 */
export function assertReviewAction(value: unknown): AuditAction {
	if (!isAuditAction(value)) {
		throw new StorageError("invalid-record", `不支持的审核动作：${typeof value === "string" ? value : typeof value}（允许：${describeAuditTransitions()}）`, { detail: "unknown-review-action" });
	}
	return value;
}

/**
 * 由**当前状态**推出该动作唯一的目标状态。
 *
 * 一个动作可能有多个合法 `(from, to)` 对（如 `deprecate` 可从 reviewed 或 verified 出发），
 * 因此必须结合当前状态解析；找不到即拒绝（不允许"强行给一个默认状态"）。
 */
export function resolveReviewTransition(action: AuditAction, fromStatus: ExperienceStatus): ExperienceStatus {
	const match = AUDIT_ACTION_TRANSITIONS[action].filter((transition) => transition.from === fromStatus);
	const first = match[0];
	if (first === undefined || match.length !== 1) {
		throw new StorageError("invalid-record", `${action} 不允许从 ${fromStatus} 出发（可用的 (from→to)：${AUDIT_ACTION_TRANSITIONS[action].map((transition) => `${transition.from}→${transition.to}`).join("/") || "无"}）`, { detail: "review-action-mismatch" });
	}
	return first.to;
}

/** reviewer 字段的下一值（见 `REVIEW_REVIEWER_EFFECT`）。 */
export function nextReviewerLabel(action: AuditAction, operatorLabel: string, current: string | undefined): string | undefined {
	switch (REVIEW_REVIEWER_EFFECT[action]) {
		case "clear":
			return undefined;
		case "set-operator":
			return operatorLabel;
		case "keep":
			return current;
	}
}

/**
 * 审核入口的证据关联校验（**R1：在解引用/遍历之前**）。
 *
 * 顺序刻意分成三步，每一步都挡一类真实故障：
 * 1. 不是数组（含 `undefined` 表示未提供、字符串/对象误传）→ 明确拒绝；
 * 2. **元素形态/数量**由 schema 负责：`null`、`{}`、稀疏数组的洞、未来 `kind`、
 *    非法下标（负数/越界）都在这里被结构化拒绝，**绝不让策略层拿到半个对象**；
 * 3. **互斥规则与字节预算**复用事件/意图的同一份实现（`collectAuditEvidenceIssues`）。
 *
 * 返回的元素已通过 schema，因此下游可以安全地读 `kind/index/recordId`：
 * "先校验形态再解引用"是本函数的唯一目的，不是风格问题。
 */
export function assertEvidenceList(value: unknown, label: string): readonly AuditEvidenceRef[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) {
		throw new StorageError("invalid-record", `${label} 的 evidence 必须是数组（收到 ${typeof value}）`, { detail: "invalid-evidence" });
	}
	const shape = collectSchemaIssues(EVIDENCE_LIST_SCHEMA, value, "invalid-audit-intent");
	if (!shape.ok) {
		throw new StorageError("invalid-record", `${label} 的 evidence 不符合契约：${describeAuditIssues(shape.issues, 3)}`, { detail: "invalid-evidence-shape" });
	}
	const typed = validateShape(EVIDENCE_LIST_SCHEMA, value);
	if (!typed.ok) {
		throw new StorageError("invalid-record", `${label} 的 evidence 无法按契约收窄`, { detail: "invalid-evidence-shape" });
	}
	const rules = collectAuditEvidenceIssues(typed.value);
	if (rules.length > 0) {
		throw new StorageError("invalid-record", `${label} 的证据关联不合法：${describeAuditIssues(rules, 3)}`, { detail: "invalid-evidence-rules" });
	}
	return typed.value;
}

/**
 * 证据引用的下标必须**在当前不可变业务内容里真实存在**。
 *
 * 为什么不能只校验"index 是个整数"：`record-evidence/0` 在一条没有证据的经验卡上
 * 是一条**无法复核**的声明。审核事件一旦落盘就不可改，宁可现在拒绝。
 * `external-reference` 只声明引用了别处，本模块**不**去读那条记录，也不声称已验证。
 */
export function collectEvidenceIndexIssues(evidence: readonly AuditEvidenceRef[], record: ExperienceCard): string[] {
	const issues: string[] = [];
	evidence.forEach((ref, position) => {
		if (ref.kind === "external-reference") return;
		const target = ref.kind === "record-evidence" ? record.evidence : record.validations;
		if (ref.index === undefined || ref.index >= target.length) {
			issues.push(`/evidence/${position}/index 指向不存在的${ref.kind === "record-evidence" ? "证据" : "验证记录"}（当前共 ${target.length} 条）`);
		}
	});
	return issues.slice(0, 3);
}

/**
 * 组装审核后的记录：只改 `status` / `reviewer` / 公共头，其它字段逐字节保留。
 *
 * 递推关系（与普通写一致）：`revision + 1`、`createdAt` 沿用、`updatedAt = max(now, 旧值)`、
 * `schemaVersion` 沿用（写入不是升级结构的机会）。组装后立刻用与读取**完全相同**的
 * `ExperienceCardSchema` 校验，避免写出一个"写成功但读不出来"的文件。
 */
export function buildReviewedRecord(record: ExperienceCard, toStatus: ExperienceStatus, reviewer: string | undefined, now: number, label: string): ExperienceCard {
	const next: ExperienceCard = {
		...record,
		revision: record.revision + 1,
		updatedAt: Math.max(now, record.updatedAt),
		status: toStatus,
	};
	// `reviewer: undefined` 会被 JSON.stringify 丢掉，但对象里仍留着这个键：显式删除，
	// 让"内存里的记录"与"磁盘上的字节"一致（否则指纹比较会看到两副形态）。
	if (reviewer === undefined) delete (next as { reviewer?: string }).reviewer;
	else next.reviewer = reviewer;

	const outcome = validateRecord(ExperienceCardSchema, next);
	if (!outcome.ok) {
		throw new StorageError("invalid-record", `${label} 审核后的记录未通过结构校验：${describeIssues(outcome.issues, 3)}`, { detail: "invalid-reviewed-record" });
	}
	// 类型收窄说明：`ExperienceCardSchema` 与 `ExperienceCard` 是同一份 schema 的两种表达，
	// 上面已用对应 schema 校验通过；这是表驱动带来的类型损失，不是绕过校验。
	return outcome.value as ExperienceCard;
}
