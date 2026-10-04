/**
 * v1 记录的**内存投影**（BM-M1）：把已通过严格校验的现有记录变成决策候选。
 *
 * 为什么不落盘、也不改输入：
 * - 现有业务 schema 仍是 v1，**本批不升版**。时间/关系/范围里 v1 表达不了的字段一律 `null`
 *   （unspecified），绝不用 `createdAt` 伪造 `effectiveFrom`，也绝不在记录上新增字段；
 * - 投影只加"内存里的 legacy 标签"（哪些维度是未指定），输入对象**不被修改**
 *   （测试用深比较兜住）。
 *
 * 唯一可复用的真实时间字段是记录头的 `createdAt`：它的语义就是"录入时间"，
 * 因此映射到 `recordedAt`——**不**用它推导工程生效时间或硬件验证时间。
 */
import type { RecordKind } from "../contracts/index.ts";
import { ExperienceCardSchema, FeatureRecordSchema, ProjectProfileSchema, TaskRecordSchema, type ExperienceCard, type FeatureRecord, type ProjectProfile, type TaskRecord } from "../contracts/records.ts";
import { validateRecord } from "../contracts/validate.ts";
import { EMPTY_SCOPE, EMPTY_TIME, type MemoryCandidate, type MemoryDependencySnapshot, type MemoryEvidenceRef, type MemoryReuseDeclaration, type MemoryScopeDeclaration, type MemoryValidationRef } from "./contract.ts";

export type MemoryProjectionResult = { readonly ok: true; readonly candidate: MemoryCandidate } | { readonly ok: false; readonly code: "invalid-record"; readonly issues: readonly string[] };

function scopeWith(overrides: Partial<MemoryScopeDeclaration>): MemoryScopeDeclaration {
	return { ...EMPTY_SCOPE, ...overrides };
}

function evidenceRefs(evidence: readonly { readonly validity: MemoryEvidenceRef["validity"]; readonly contentHash?: string }[]): MemoryEvidenceRef[] {
	return evidence.map((entry) => ({ validity: entry.validity, contentHash: entry.contentHash ?? null }));
}

function validationRefs(validations: readonly { readonly kind: MemoryValidationRef["kind"]; readonly result: MemoryValidationRef["result"]; readonly performedAt: number }[]): MemoryValidationRef[] {
	return validations.map((entry) => ({ kind: entry.kind, result: entry.result, performedAt: entry.performedAt }));
}

/** v1 不携带依赖快照 ⇒ `null`（不得声称当前硬件验证通过）。 */
const NO_SNAPSHOT: MemoryDependencySnapshot | null = null;

/** 经验卡的复用范围：v1 已能表达 level/customers/authorization，直接复用。 */
function reuseOf(reuse: ExperienceCard["reuseScope"]): MemoryReuseDeclaration {
	return { level: reuse.level, customers: [...reuse.customers], authorization: reuse.authorization ?? null };
}

/**
 * `experience-card` → 候选。
 *
 * 关键映射：`sourceProjectId` 是**强项目身份**（不是厂商名/板名推断）；
 * `boardName`/`boardRevision`/`buildTarget` v1 未声明 ⇒ `null`，因此这条经验在
 * "当前硬件验证通过"这件事上只能算 legacy/未指定（见 decide 的范围与验证策略）。
 */
export function projectV1ExperienceCard(record: ExperienceCard): MemoryCandidate {
	return {
		recordId: record.id,
		family: "experience-card",
		revision: record.revision,
		authority: "authoritative-read",
		sourceFingerprint: null,
		status: record.status,
		scope: scopeWith({ projectId: record.sourceProjectId }),
		reuse: reuseOf(record.reuseScope),
		time: { ...EMPTY_TIME, recordedAt: record.createdAt },
		confirmedFields: [],
		validations: validationRefs(record.validations),
		evidence: evidenceRefs(record.evidence),
		dependencySnapshot: NO_SNAPSHOT,
		derivedFromSummaryOf: null,
		// v1 没有事实键：只有调用方显式给出"同一业务属性"的键时才能参与冲突判定，
		// 因此投影**不**用 problem 文本猜键（相同文字不代表同一事实）。
		factKey: null,
		value: null,
		title: record.problem,
	};
}

/** `feature-record` → 候选：客户/产品线是 `ProjectField`，只有 `confirmed` 才算确认事实。 */
export function projectV1FeatureRecord(record: FeatureRecord): MemoryCandidate {
	return {
		recordId: record.id,
		family: "feature-record",
		revision: record.revision,
		authority: "authoritative-read",
		sourceFingerprint: null,
		status: "unknown",
		scope: scopeWith({ customerId: record.customer.value }),
		reuse: { level: "current-project", customers: [], authorization: null },
		time: { ...EMPTY_TIME, recordedAt: record.createdAt },
		confirmedFields: [
			{ field: "customer", value: record.customer.value, status: record.customer.status },
			{ field: "productLine", value: record.productLine.value, status: record.productLine.status },
		],
		validations: [],
		evidence: [],
		dependencySnapshot: NO_SNAPSHOT,
		derivedFromSummaryOf: null,
		factKey: null,
		value: null,
		title: record.originalRequirement,
	};
}

/** `project-profile` → 候选：身份字段的 `status` 原样保留（confirmed 不得被检测候选覆盖）。 */
export function projectV1ProjectProfile(record: ProjectProfile): MemoryCandidate {
	const identity = record.identity;
	return {
		recordId: record.id,
		family: "project-profile",
		revision: record.revision,
		authority: "authoritative-read",
		sourceFingerprint: null,
		status: "unknown",
		scope: scopeWith({
			projectId: record.id,
			customerId: identity.customer.value,
			boardName: identity.boardName.value,
			boardRevision: identity.boardRevision.value,
		}),
		reuse: { level: "current-project", customers: [], authorization: null },
		time: { ...EMPTY_TIME, recordedAt: record.createdAt },
		confirmedFields: [
			{ field: "customer", value: identity.customer.value, status: identity.customer.status },
			{ field: "boardName", value: identity.boardName.value, status: identity.boardName.status },
			{ field: "boardRevision", value: identity.boardRevision.value, status: identity.boardRevision.status },
			{ field: "chipsetFamily", value: identity.chipsetFamily.value, status: identity.chipsetFamily.status },
		],
		validations: [],
		evidence: [],
		dependencySnapshot: NO_SNAPSHOT,
		derivedFromSummaryOf: null,
		factKey: null,
		value: null,
		title: null,
	};
}

/** `task-record` → 候选：任务记忆按 projectId/workspace 隔离。 */
export function projectV1TaskRecord(record: TaskRecord): MemoryCandidate {
	return {
		recordId: record.id,
		family: "task-record",
		revision: record.revision,
		authority: "authoritative-read",
		sourceFingerprint: null,
		status: record.status === "done" ? "reviewed" : "draft",
		scope: scopeWith({ projectId: record.projectId, workspaceId: record.workspace.workspaceId }),
		reuse: { level: "current-project", customers: [], authorization: null },
		time: { ...EMPTY_TIME, recordedAt: record.createdAt },
		confirmedFields: [],
		validations: validationRefs(record.validations),
		evidence: [],
		dependencySnapshot: NO_SNAPSHOT,
		derivedFromSummaryOf: null,
		factKey: null,
		value: null,
		title: record.requirement,
	};
}

/**
 * 走**现有严格校验**再投影：坏记录在这里止住，而不是被"尽力解释"成一条候选。
 *
 * 校验失败只回受控问题码，不回显被拒材料的正文。
 */
export function projectV1Record(kind: RecordKind, value: unknown): MemoryProjectionResult {
	// 每个分支都用**该类型自己的 schema** 校验：这样 `value` 的静态类型就是目标记录类型，
	// 不需要 `as` 抹掉不确定性（"校验与使用脱钩"正是 02D1 记录的教训）。
	switch (kind) {
		case "experience-card": {
			const validated = validateRecord(ExperienceCardSchema, value);
			if (!validated.ok) return failed(validated.issues);
			return { ok: true, candidate: projectV1ExperienceCard(validated.value) };
		}
		case "feature-record": {
			const validated = validateRecord(FeatureRecordSchema, value);
			if (!validated.ok) return failed(validated.issues);
			return { ok: true, candidate: projectV1FeatureRecord(validated.value) };
		}
		case "project-profile": {
			const validated = validateRecord(ProjectProfileSchema, value);
			if (!validated.ok) return failed(validated.issues);
			return { ok: true, candidate: projectV1ProjectProfile(validated.value) };
		}
		case "task-record": {
			const validated = validateRecord(TaskRecordSchema, value);
			if (!validated.ok) return failed(validated.issues);
			return { ok: true, candidate: projectV1TaskRecord(validated.value) };
		}
		default:
			// `context-manifest` 是派生物，不批准事实：不投影成候选。
			return { ok: false, code: "invalid-record", issues: ["context-manifest-is-derived"] };
	}
}

/** 校验失败只回受控码，不回显被拒材料。 */
function failed(issues: readonly { readonly code: string }[]): MemoryProjectionResult {
	return { ok: false, code: "invalid-record", issues: issues.map((issue) => issue.code) };
}
