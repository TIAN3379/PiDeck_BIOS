#!/usr/bin/env node
/**
 * BM-M1 **合成 PXE 场景演示**（纯 Node，无 IO/无时钟/无模型）。
 *
 * 它调用真实的记忆决策 API（`core/memory`），把同一轮里"客观存在"的材料放在一起：
 * 目标 Board B 的新需求未来才生效、Board A 的旧经验、已撤回结论的旧会话摘要、
 * 另一家客户未经授权的资料，以及一条与人工确认值不一致的新检测候选。
 *
 * 目的是让"当前可用 / 仅供参考 / 需复核 / 冲突 / 显式历史 / 排除"六类结果在一条命令里
 * 可复现地打印出来——**不是**生产命令（不接入 `knowledge`，也没有 npm script），
 * 也不读任何真实知识库或客户资料。
 *
 * 运行：`node cli/memory-scenario.mjs [--intent current|history]`
 * 输出：stdout 恰好一个 JSON 对象；诊断只走 stderr。
 *
 * 本文件参与 `npm run typecheck`（tsconfig 的 checkJs）。
 */
import { decideMemory } from "../core/memory/index.ts";

/** @typedef {import("../core/memory/index.ts").MemoryCandidate} MemoryCandidate */

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const PROJECT = "3f2504e0-4f89-4a1c-9a3d-1f0d3c9a4b7e";

/** @param {Partial<import("../core/memory/index.ts").MemoryScopeDeclaration>} overrides */
function scope(overrides = {}) {
	return { projectId: PROJECT, workspaceId: null, customerId: "customer-own", boardName: null, boardRevision: null, buildTarget: null, ...overrides };
}

const SNAPSHOT_B = { commit: "head-b2", boardRevision: "B1", buildTarget: "BoardBPkg", contentHashes: ["pxe-dxe-hash"] };

/**
 * @param {Partial<MemoryCandidate>} overrides
 * @returns {MemoryCandidate}
 */
function candidate(overrides = {}) {
	return {
		recordId: "exp-0",
		family: "experience-card",
		revision: 1,
		authority: "authoritative-read",
		sourceFingerprint: "fp-0",
		status: "reviewed",
		scope: scope({ boardName: "BoardB", boardRevision: "B1", buildTarget: "BoardBPkg" }),
		reuse: { level: "current-project", customers: [], authorization: null },
		time: { occurredAt: NOW - 2 * DAY, recordedAt: NOW - 2 * DAY, effectiveFrom: NOW - 2 * DAY, effectiveTo: null },
		confirmedFields: [],
		validations: [],
		evidence: [],
		dependencySnapshot: SNAPSHOT_B,
		derivedFromSummaryOf: null,
		factKey: null,
		value: null,
		title: null,
		...overrides,
	};
}

/** 目标：Board B、新需求，HEAD 已前进到 head-b2。 */
const target = { scope: scope({ boardName: "BoardB", boardRevision: "B1", buildTarget: "BoardBPkg" }), snapshot: SNAPSHOT_B };

/** 授权：只允许本项目客户 + 内部通用；模型端点显式允许。 */
const authorization = { customers: ["customer-own"], allowInternalGeneral: true, endpointAllowed: true };

/** @type {MemoryCandidate[]} */
const candidates = [
	// 1) Board A 的旧经验：真实历史，但在 Board B 目标上范围不适用。
	candidate({
		recordId: "exp-board-a",
		scope: scope({ boardName: "BoardA", boardRevision: "A1", buildTarget: "BoardAPkg" }),
		dependencySnapshot: { commit: "head-a1", boardRevision: "A1", buildTarget: "BoardAPkg", contentHashes: ["pxe-dxe-hash-a"] },
		validations: [{ kind: "board-boot", result: "passed", performedAt: NOW - 30 * DAY }],
		title: "Board A：Setup 里关闭 PXE 引导项",
	}),
	// 2) 目标 Board B 的**未来**需求：现在还不生效。
	candidate({
		recordId: "exp-future-pxe",
		time: { occurredAt: NOW, recordedAt: NOW, effectiveFrom: NOW + 5 * DAY, effectiveTo: null },
		title: "Board B：默认保留 PXE（下个客户批次起生效）",
	}),
	// 3) 已撤回结论的旧会话摘要：摘要不得让撤回的结论复活。
	candidate({
		recordId: "summary-session-42",
		family: "session-summary",
		derivedFromSummaryOf: "exp-retracted",
		dependencySnapshot: null,
		title: "旧会话摘要：建议沿用 PXE 开启",
	}),
	// 4) 另一家客户未经授权的资料：必须完全不出现（连标题/ID/计数都不出现）。
	candidate({
		recordId: "exp-other-customer",
		scope: scope({ customerId: "customer-other", boardName: "BoardB" }),
		reuse: { level: "customer", customers: ["customer-other"], authorization: "客户 A 允许内部复用" },
		title: "另一家客户的私密现象",
	}),
	// 5) Board B 人工确认的 PXE 默认值。
	candidate({
		recordId: "profile-board-b",
		family: "project-profile",
		status: "unknown",
		scope: scope({ boardName: "BoardB" }),
		factKey: "pxeEnabled",
		value: "on",
		confirmedFields: [{ field: "pxeEnabled", value: "on", status: "confirmed" }],
		validations: [{ kind: "compile", result: "passed", performedAt: NOW - DAY }],
		title: null,
	}),
	// 6) 新检测候选与确认值不一致：保留两者、交人工确认（不自动覆盖）。
	candidate({
		recordId: "detect-pxe-default",
		family: "detected-candidate",
		status: "unknown",
		scope: scope({ boardName: "BoardB" }),
		factKey: "pxeEnabled",
		value: "off",
		confirmedFields: [{ field: "pxeEnabled", value: "off", status: "candidate" }],
		title: null,
	}),
	// 7) v1 形态的经验：没有生效区间也没有依赖快照 ⇒ 只能作参考。
	candidate({
		recordId: "exp-legacy-note",
		time: { occurredAt: null, recordedAt: NOW - 90 * DAY, effectiveFrom: null, effectiveTo: null },
		dependencySnapshot: null,
		title: "早期笔记：PXE 与 DXE 顺序的经验",
	}),
	// 8) 已被显式撤回的 Board B 结论。
	candidate({ recordId: "exp-retracted", title: "Board B：PXE 关闭（已被撤回）" }),
	// 9) Board B 上"范围与快照都对得上"的经验：唯一一条可以作当前结论；
	//    验证强度按实际记录报告（compile 不会升级成 board-boot）。
	candidate({
		recordId: "exp-board-b-verified",
		validations: [
			{ kind: "compile", result: "passed", performedAt: NOW - 3 * DAY },
			{ kind: "board-boot", result: "passed", performedAt: NOW - 2 * DAY },
		],
		title: "Board B：关闭 PXE 后引导顺序符合客户验收",
	}),
	// 10) 撤回声明方：**真实存在的当期记录**。关系两端都必须能解析到具名记录身份，
	//     否则"被撤回"只是声明方的口头断言（R27-2）。
	candidate({
		recordId: "exp-board-b-retract",
		time: { occurredAt: NOW - DAY, recordedAt: NOW - DAY, effectiveFrom: NOW - DAY, effectiveTo: null },
		title: "Board B：撤回关闭 PXE 的结论（改用默认开启）",
	}),
];

/** @type {import("../core/memory/index.ts").MemoryRelation[]} */
const relations = [
	// 撤回：端点写全 记录族 + 记录 ID + revision，并声明作用范围。
	// 声明方（exp-board-b-retract）与目标（exp-retracted）都在候选中，因此这是一条有效断言。
	{
		type: "retracts",
		source: { family: "experience-card", recordId: "exp-board-b-retract", revision: 1 },
		target: { family: "experience-card", recordId: "exp-retracted", revision: 1 },
		scope: scope({ boardName: "BoardB" }),
	},
];

const intentArg = process.argv.indexOf("--intent");
const intent = intentArg === -1 ? "current" : process.argv[intentArg + 1];
if (intent !== "current" && intent !== "history") {
	process.stderr.write(`未知意图：${String(intent)}（只接受 current / history）\n`);
	process.exitCode = 2;
} else {
	const result = decideMemory({ intent, now: NOW, target, authorization, candidates, relations });
	const counts = { current: 0, reference: 0, "needs-review": 0, conflict: 0, history: 0, excluded: 0 };
	for (const item of result.items) counts[item.class] += 1;
	process.stdout.write(
		`${JSON.stringify({
			scenario: "pxe-board-b",
			intent: result.intent,
			status: result.status,
			counts,
			dropped: result.dropped,
			items: result.items,
		})}\n`,
	);
}
