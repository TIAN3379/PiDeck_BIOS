/**
 * M1 纯决策用例的**合成输入构造器**（测试专用）。
 *
 * 只构造"调用方已经读到的记录/策略/快照"，不落盘、不读真实知识库；
 * 每个字段都能被单个用例覆盖，避免"为了造一个场景顺带打开一堆无关语义"。
 */

/** 查询时间：所有用例显式传入，模块自己不读时钟。 */
export const NOW = 1_800_000_000_000;
export const DAY = 86_400_000;

export const PROJECT_A = "3f2504e0-4f89-4a1c-9a3d-1f0d3c9a4b7e";
export const PROJECT_B = "8c1b2f44-6a5d-4b3e-9f7a-2d4c8e1b5a90";
export const WORKSPACE_A = "b7d1e9f2-3c4a-4d5e-8f9a-0b1c2d3e4f50";

export function emptyScope(overrides = {}) {
	return { projectId: null, workspaceId: null, customerId: null, boardName: null, boardRevision: null, buildTarget: null, ...overrides };
}

export function emptyTime(overrides = {}) {
	return { occurredAt: null, recordedAt: NOW - DAY, effectiveFrom: null, effectiveTo: null, ...overrides };
}

/** 一条候选；默认是"本项目、已审核、当前可用"的最简形态。 */
export function candidate(overrides = {}) {
	return {
		recordId: "exp-a",
		family: "experience-card",
		revision: 1,
		authority: "authoritative-read",
		sourceFingerprint: null,
		status: "reviewed",
		scope: emptyScope({ projectId: PROJECT_A }),
		reuse: { level: "current-project", customers: [], authorization: null },
		time: emptyTime(),
		confirmedFields: [],
		validations: [],
		evidence: [],
		dependencySnapshot: null,
		derivedFromSummaryOf: null,
		factKey: null,
		value: null,
		title: "PXE 默认开启",
		...overrides,
	};
}

/**
 * "可以成为当前结论"的候选：声明了生效区间**或**依赖快照。
 *
 * 这不是测试技巧，而是契约本身的要求：既没有生效时间、也没有依赖快照的 v1 记录
 * 说不清"什么时候适用、依赖哪份代码"，因此只能作参考（`legacy-unspecified`）。
 */
export function currentCandidate(overrides = {}) {
	return candidate({
		time: emptyTime({ effectiveFrom: NOW - DAY }),
		dependencySnapshot: { commit: null, boardRevision: null, buildTarget: null, contentHashes: [] },
		...overrides,
	});
}

export function target(overrides = {}) {
	return {
		scope: emptyScope({ projectId: PROJECT_A }),
		snapshot: { commit: null, boardRevision: null, buildTarget: null, contentHashes: [] },
		...overrides,
	};
}

export function authorization(overrides = {}) {
	return { customers: [], allowInternalGeneral: false, endpointAllowed: true, ...overrides };
}

export function query(overrides = {}) {
	return { intent: "current", now: NOW, target: target(), authorization: authorization(), candidates: [], relations: [], ...overrides };
}

/** 关系端点（记录族 + 记录 ID + revision）。 */
export function ref(family, recordId, revision = 1) {
	return { family, recordId, revision };
}

/** 一条经验卡端点（最常用）。 */
export function expRef(recordId, revision = 1) {
	return ref("experience-card", recordId, revision);
}

/**
 * 关系：**两端**都写全记录身份 + 作用范围。
 *
 * 默认是"exp-new（当期经验卡）替代 exp-a"；`overrides` 可改任意一端或类型。
 */
export function relation(overrides = {}) {
	return { type: "supersedes", source: expRef("exp-new"), target: expRef("exp-a"), scope: emptyScope({}), ...overrides };
}

/** 按 recordId（可选 revision）取一条决策。 */
export function pick(result, recordId, revision) {
	return result.items.find((item) => item.recordId === recordId && (revision === undefined || item.revision === revision));
}
