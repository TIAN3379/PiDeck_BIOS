/**
 * BM-M1：记忆决策模块的**纯策略永久测试**（无 IO、无时钟、无模型）。
 *
 * 结构：
 * - §1 R27-1 当前准入 / 授权优先的 revision 集合 / 当前冲突资格；
 * - §2 R27-2 关系两端复验、多边共同判定与确定性；
 * - §3 R27-3 公共入口闸门与实际输出预算；
 * - §4 既有语义（MT-01～05/07/08/10～12）与 v1 投影。
 *
 * 全部只读合成数据，不读真实客户资料；每个"旧红"都在第二十七轮验收 §4 有独立复现记录。
 */
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";
import { MemoryInputError, decideMemory, projectV1ExperienceCard, projectV1Record } from "../core/memory/index.ts";
import { BIOS_CONTRACTS_SCHEMA_VERSION } from "../core/contracts/index.ts";
import { DAY, NOW, PROJECT_A, PROJECT_B, WORKSPACE_A, authorization, candidate, currentCandidate, emptyScope, emptyTime, expRef, pick, query, ref, relation, target } from "./helpers/memoryFixtures.mjs";

/** 受控错误的判定器：类别 + 文案有界。 */
function isInputError(expected = "invalid-input") {
	return (error) => error instanceof MemoryInputError && error.code === expected && typeof error.message === "string" && error.message.length < 200;
}

/* ------------------------------------------------------------------ §1 R27-1 */

test("R27-1：经验卡按审核状态准入，档案靠字段确认，任务状态不参与可信度", () => {
	// 经验卡：draft / unknown 都不是当前工程依据。
	const draft = currentCandidate({ recordId: "exp-draft", status: "draft" });
	const unknown = currentCandidate({ recordId: "exp-unknown", status: "unknown" });
	const reviewed = currentCandidate({ recordId: "exp-reviewed", status: "reviewed" });
	const verified = currentCandidate({ recordId: "exp-verified", status: "verified" });
	const result = decideMemory(query({ candidates: [draft, unknown, reviewed, verified] }));

	for (const id of ["exp-draft", "exp-unknown"]) {
		assert.equal(pick(result, id).class, "needs-review", `${id} 未审核不得成为当前结论`);
		assert.ok(pick(result, id).reasons.includes("not-reviewed"));
	}
	for (const id of ["exp-reviewed", "exp-verified"]) assert.equal(pick(result, id).class, "current");

	// 档案记录：v1 里 status 是 unknown，但已经人工确认的字段仍然是当前依据（不能一刀切禁 unknown）。
	const confirmedField = currentCandidate({
		recordId: "profile-1",
		family: "project-profile",
		status: "unknown",
		factKey: "project-profile.boardName",
		value: "BoardB",
		confirmedFields: [{ field: "project-profile.boardName", value: "BoardB", status: "confirmed" }],
		title: null,
	});
	assert.equal(pick(decideMemory(query({ candidates: [confirmedField] })), "profile-1").class, "current");

	// 同一档案记录里未确认的字段事实则不是当前依据（字段粒度，不是整条记录）。
	const unconfirmedField = currentCandidate({
		recordId: "profile-1",
		family: "project-profile",
		status: "unknown",
		factKey: "project-profile.chipsetFamily",
		value: "Family-X",
		confirmedFields: [{ field: "project-profile.chipsetFamily", value: "Family-X", status: "candidate" }],
		title: null,
	});
	const fieldResult = pick(decideMemory(query({ candidates: [unconfirmedField] })), "profile-1");
	assert.equal(fieldResult.class, "needs-review");
	assert.ok(fieldResult.reasons.includes("field-unconfirmed"));

	// 任务记录：in_progress 不是"未审核"。
	const task = currentCandidate({ recordId: "task-1", family: "task-record", status: "draft", scope: emptyScope({ projectId: PROJECT_A, workspaceId: WORKSPACE_A }) });
	assert.equal(pick(decideMemory(query({ target: target({ scope: emptyScope({ projectId: PROJECT_A, workspaceId: WORKSPACE_A }) }), candidates: [task] })), "task-1").class, "current");

	// 检测候选：天生只是候选，必须人工确认。
	const detected = currentCandidate({ recordId: "detect-1", family: "detected-candidate", status: "unknown", factKey: "project-profile.boardName", value: "BoardB" });
	const detectedResult = pick(decideMemory(query({ candidates: [detected] })), "detect-1");
	assert.equal(detectedResult.class, "needs-review");
	assert.ok(detectedResult.reasons.includes("field-unconfirmed"));
});

test("R27-1：只有具备当前资格的事实参加当前冲突判定（未来版本 / 旧版本都不污染当前）", () => {
	// 旧红：当前 PXE=off 与"未来才生效"的 PXE=on 被双双标 conflict。
	const active = currentCandidate({ recordId: "exp-now", factKey: "pxe", value: "off" });
	const future = currentCandidate({ recordId: "exp-future", factKey: "pxe", value: "on", time: emptyTime({ recordedAt: NOW - DAY, effectiveFrom: NOW + DAY }) });
	const futureResult = decideMemory(query({ candidates: [active, future] }));
	assert.equal(pick(futureResult, "exp-now").class, "current");
	assert.ok(!pick(futureResult, "exp-now").reasons.includes("conflict"), "未来版本不能污染当前值");
	const futureItem = pick(futureResult, "exp-future");
	assert.equal(futureItem.class, "needs-review");
	assert.ok(futureItem.reasons.includes("not-yet-effective"));
	assert.ok(!futureItem.reasons.includes("conflict"), "未生效事实保留未来提示，不进当前冲突集合");

	// 旧红：同记录 rev1=off / rev2=on 时 rev2 被旧版本拖进 conflict。
	const revisioned = decideMemory(
		query({
			candidates: [currentCandidate({ recordId: "exp-rev", revision: 1, factKey: "pxe", value: "off" }), currentCandidate({ recordId: "exp-rev", revision: 2, factKey: "pxe", value: "on" })],
		}),
	);
	assert.equal(pick(revisioned, "exp-rev", 2).class, "current", "被 revision 淘汰的旧版本不能让新版本虚假冲突");
	assert.ok(!pick(revisioned, "exp-rev", 2).reasons.includes("conflict"));
	assert.equal(pick(revisioned, "exp-rev", 1).class, "excluded");
	assert.ok(pick(revisioned, "exp-rev", 1).reasons.includes("older-revision"));

	// 合法当前矛盾仍然冲突：两条当期已审核经验、同事实键、范围重叠、值不同。
	const conflict = decideMemory(
		query({
			candidates: [currentCandidate({ recordId: "exp-x", factKey: "pxe", value: "off", scope: emptyScope({ projectId: PROJECT_A, boardName: "BoardB" }) }), currentCandidate({ recordId: "exp-y", factKey: "pxe", value: "on", scope: emptyScope({ projectId: PROJECT_A, boardName: "BoardB" }) })],
			target: target({ scope: emptyScope({ projectId: PROJECT_A, boardName: "BoardB" }) }),
		}),
	);
	assert.equal(pick(conflict, "exp-x").class, "conflict");
	assert.equal(pick(conflict, "exp-y").class, "conflict");
});

test("R27-1：未授权的高版本不能决定可见记录的状态", () => {
	// 旧红：同一 ID 的另一项目 rev2 未授权，却让可见的 rev1 被标 older-revision。
	const visible = currentCandidate({ recordId: "exp-shared", revision: 1, scope: emptyScope({ projectId: PROJECT_A }) });
	const unauthorized = currentCandidate({ recordId: "exp-shared", revision: 2, scope: emptyScope({ projectId: PROJECT_B }) });
	const result = decideMemory(query({ candidates: [visible, unauthorized] }));

	assert.equal(pick(result, "exp-shared", 2), undefined, "未授权高版本必须完全不可见");
	const visibleItem = pick(result, "exp-shared", 1);
	assert.equal(visibleItem.class, "current", "未授权输入不能暗中淘汰可见版本");
	assert.ok(!visibleItem.reasons.includes("older-revision"));

	// current 与 history 都守授权。
	const history = decideMemory(query({ intent: "history", candidates: [visible, unauthorized] }));
	assert.equal(pick(history, "exp-shared", 2), undefined, "history 不能绕授权");
});

test("R27-1：可授权的最高版本不可读时，旧版本不复活", () => {
	const older = currentCandidate({ recordId: "exp-r", revision: 1, title: "旧结论" });
	const newest = currentCandidate({ recordId: "exp-r", revision: 2, authority: "unreadable", title: "读不到的新结论" });
	const result = decideMemory(query({ candidates: [older, newest] }));

	const newestItem = pick(result, "exp-r", 2);
	assert.equal(newestItem.class, "needs-review");
	assert.ok(newestItem.reasons.includes("authority-unreadable"));
	assert.equal(newestItem.title, null, "不可读的权威内容不得回显标题");

	const olderItem = pick(result, "exp-r", 1);
	assert.equal(olderItem.class, "excluded", "旧版本不得因新版本不可读而复活");
	assert.ok(olderItem.reasons.includes("older-revision"));
	assert.ok(olderItem.reasons.includes("higher-revision-unreadable"));
});

test("R27-1：记录族是命名空间，相同裸 ID 跨族合法且互不淘汰", () => {
	const experience = currentCandidate({ recordId: "shared", family: "experience-card", revision: 1 });
	const feature = currentCandidate({ recordId: "shared", family: "feature-record", revision: 1 });
	const result = decideMemory(query({ candidates: [experience, feature] }));
	assert.equal(pick(result, "shared").class, "current");
	assert.equal(result.items.length, 2, "同 ID 跨族必须被视为两条记录");
	assert.ok(!result.items.some((item) => item.reasons.includes("older-revision")));

	// 同族同 ID 同 revision 重复才是非法输入。
	assert.throws(() => decideMemory(query({ candidates: [experience, currentCandidate({ recordId: "shared", family: "experience-card", revision: 1 })] })), isInputError("invalid-input"));
});

test("R27-1：确认值与新检测候选的差异保留并按记录族分别判定", () => {
	const scope = emptyScope({ projectId: PROJECT_A, boardName: "BoardA" });
	const confirmed = currentCandidate({
		recordId: "profile-1",
		family: "project-profile",
		status: "unknown",
		scope,
		factKey: "project-profile.boardName",
		value: "BoardA",
		confirmedFields: [{ field: "project-profile.boardName", value: "BoardA", status: "confirmed" }],
		title: null,
	});
	const detected = currentCandidate({
		recordId: "detect-1",
		family: "detected-candidate",
		status: "unknown",
		scope,
		factKey: "project-profile.boardName",
		value: "BoardX",
		title: null,
	});
	const result = decideMemory(query({ target: target({ scope }), candidates: [detected, confirmed] }));

	for (const id of ["profile-1", "detect-1"]) {
		assert.equal(pick(result, id).class, "needs-review");
		assert.ok(pick(result, id).reasons.includes("needs-confirmation"), "差异必须保留并交人工确认");
	}
	assert.ok(!pick(result, "detect-1").reasons.includes("conflict"), "确认值 vs 候选不是两个普通候选的冲突");
});

/* ------------------------------------------------------------------ §2 R27-2 */

/** 一条当期有效、可作关系声明方的经验卡。 */
function sourceCard(recordId, overrides = {}) {
	return currentCandidate({ recordId, title: `声明方 ${recordId}`, ...overrides });
}

test("R27-2：关系声明方不可解析时不得冒充明确替代", () => {
	const base = currentCandidate({ recordId: "exp-a", title: "旧结论" });

	// 旧红 1：只有 exp-a，关系声称 exp-new 替代它 —— 之前返回 ok/superseded。
	const missing = decideMemory(query({ candidates: [base], relations: [relation({ source: expRef("exp-new"), target: expRef("exp-a") })] }));
	assert.equal(pick(missing, "exp-a").class, "needs-review", "缺源必须待复核，不能虚假确定被替代");
	assert.ok(pick(missing, "exp-a").reasons.includes("unresolved-relation"));
	assert.equal(missing.status, "incomplete", "关系集合不完整必须如实报告");

	// 旧红 2：声明方存在但不可读。
	const unreadableSource = sourceCard("exp-new", { authority: "unreadable" });
	const unreadable = decideMemory(query({ candidates: [base, unreadableSource], relations: [relation({ source: expRef("exp-new"), target: expRef("exp-a") })] }));
	assert.equal(pick(unreadable, "exp-a").class, "needs-review");
	assert.ok(pick(unreadable, "exp-a").reasons.includes("unresolved-relation"));
	assert.equal(unreadable.status, "incomplete");

	// 旧红 3（R28-3 修正）：声明方属于未授权项目 —— 既不能出现，也不能改变可见事实。
	//
	// 第二十八轮独立复验指出：之前把"给了但未授权"当成"缺源"处理，于是隐藏来源仍然
	// 把可见的 exp-a 从 current 降成 unresolved-relation。授权必须先于关系参与：
	// 这条边整条被忽略，exp-a 保持 current 且整体 ok。
	const foreignSource = sourceCard("exp-new", { scope: emptyScope({ projectId: PROJECT_B }) });
	const unauthorized = decideMemory(query({ candidates: [base, foreignSource], relations: [relation({ source: expRef("exp-new"), target: expRef("exp-a") })] }));
	assert.equal(pick(unauthorized, "exp-new"), undefined, "未授权声明方必须完全不可见");
	assert.equal(pick(unauthorized, "exp-a").class, "current", "隐藏来源不能改变可见事实");
	assert.equal(unauthorized.status, "ok", "没有可解析的已授权关系 ⇒ 结论完整");

	// 反例（不得泄漏）：结果里不出现未授权声明方的 ID 或标题。
	assert.doesNotMatch(JSON.stringify(unauthorized), /exp-new/);
});

test("R27-2：声明方自身不是当前有效事实时按 not-effective 处理", () => {
	const base = currentCandidate({ recordId: "exp-a" });

	// 旧版本声明方（新 revision 才是当前）。
	const staleSource = decideMemory(
		query({
			candidates: [base, sourceCard("exp-new", { revision: 1 }), sourceCard("exp-new", { revision: 2 })],
			relations: [relation({ source: expRef("exp-new", 1), target: expRef("exp-a") })],
		}),
	);
	assert.equal(pick(staleSource, "exp-a").class, "needs-review");
	assert.ok(pick(staleSource, "exp-a").reasons.includes("relation-not-effective"));
	assert.equal(staleSource.status, "incomplete");

	// 未审核声明方。
	const draftSource = decideMemory(query({ candidates: [base, sourceCard("exp-new", { status: "draft" })], relations: [relation({ source: expRef("exp-new"), target: expRef("exp-a") })] }));
	assert.ok(pick(draftSource, "exp-a").reasons.includes("relation-not-effective"));

	// 未生效声明方。
	const futureSource = decideMemory(
		query({
			candidates: [base, sourceCard("exp-new", { time: emptyTime({ recordedAt: NOW - DAY, effectiveFrom: NOW + DAY }) })],
			relations: [relation({ source: expRef("exp-new"), target: expRef("exp-a") })],
		}),
	);
	assert.ok(pick(futureSource, "exp-a").reasons.includes("relation-not-effective"));

	// 未确认字段的检测候选不能声明替代（端点记录族必须与候选一致，这里就是 detected-candidate）。
	const detectedSource = decideMemory(
		query({
			candidates: [base, sourceCard("exp-new", { family: "detected-candidate", status: "unknown", factKey: "x", value: "y" })],
			relations: [relation({ source: ref("detected-candidate", "exp-new", 1), target: expRef("exp-a") })],
		}),
	);
	assert.ok(pick(detectedSource, "exp-a").reasons.includes("relation-not-effective"));
});

test("R27-2：两端可解析且声明方当期有效时，替代/撤回才成立", () => {
	const base = currentCandidate({ recordId: "exp-a", title: "旧结论" });
	const source = sourceCard("exp-new");

	const supersede = decideMemory(query({ candidates: [base, source], relations: [relation({ type: "supersedes", source: expRef("exp-new"), target: expRef("exp-a") })] }));
	assert.equal(pick(supersede, "exp-a").class, "excluded");
	assert.ok(pick(supersede, "exp-a").reasons.includes("superseded"));
	assert.equal(supersede.status, "ok", "两端都成立、没有循环与截断时结论完整");
	assert.equal(pick(supersede, "exp-new").class, "current", "声明方本身仍是当前事实");

	const retract = decideMemory(query({ candidates: [base, source], relations: [relation({ type: "retracts", source: expRef("exp-new"), target: expRef("exp-a") })] }));
	assert.ok(pick(retract, "exp-a").reasons.includes("retracted"));

	// history 意图下被替代的事实仍可显式查看，且带历史标记。
	const history = decideMemory(query({ intent: "history", candidates: [base, source], relations: [relation({ source: expRef("exp-new"), target: expRef("exp-a") })] }));
	assert.equal(pick(history, "exp-a").class, "history");
	assert.ok(pick(history, "exp-a").reasons.includes("history-record"));
});

test("R27-2：多条适用关系共同判定，矛盾/循环显式保留且与排列无关", () => {
	const base = currentCandidate({ recordId: "exp-a" });
	const superseder = sourceCard("exp-s");
	const retractor = sourceCard("exp-r");
	const conflicting = [relation({ type: "supersedes", source: expRef("exp-s"), target: expRef("exp-a") }), relation({ type: "retracts", source: expRef("exp-r"), target: expRef("exp-a") })];

	// 旧红：同源/同目标两类关系分别 supersedes/retracts，交换顺序输出不同。
	const forward = decideMemory(query({ candidates: [base, superseder, retractor], relations: conflicting }));
	const backward = decideMemory(query({ candidates: [retractor, base, superseder], relations: [...conflicting].reverse() }));
	assert.equal(JSON.stringify(forward), JSON.stringify(backward), "输入排列不得改变结果");
	assert.equal(pick(forward, "exp-a").class, "needs-review");
	assert.ok(pick(forward, "exp-a").reasons.includes("relation-ambiguous"), "矛盾要显式保留，不能第一条获胜");
	assert.ok(!pick(forward, "exp-a").reasons.includes("superseded"));
	assert.ok(!pick(forward, "exp-a").reasons.includes("retracted"));

	// 同向多边（都替代）不是矛盾。
	const agreeing = decideMemory(query({ candidates: [base, superseder, sourceCard("exp-s2")], relations: [relation({ source: expRef("exp-s"), target: expRef("exp-a") }), relation({ source: expRef("exp-s2"), target: expRef("exp-a") })] }));
	assert.ok(pick(agreeing, "exp-a").reasons.includes("superseded"));
	assert.ok(!pick(agreeing, "exp-a").reasons.includes("relation-ambiguous"));

	// 循环：A 被 B 替代、B 被 A 替代。
	const cycle = decideMemory(
		query({
			candidates: [currentCandidate({ recordId: "cyc-a" }), currentCandidate({ recordId: "cyc-b" })],
			relations: [relation({ source: expRef("cyc-b"), target: expRef("cyc-a") }), relation({ source: expRef("cyc-a"), target: expRef("cyc-b") })],
		}),
	);
	for (const id of ["cyc-a", "cyc-b"]) {
		assert.equal(pick(cycle, id).class, "needs-review");
		assert.ok(pick(cycle, id).reasons.includes("relation-ambiguous"));
	}
});

test("R28-3：分叉上的环与撤回来源都保留矛盾，且与输入排列无关", () => {
	// 旧红：图 b→a、c→a、a→c 的结论依赖"第一条边"，正序与反序输出不同。
	const nodes = [currentCandidate({ recordId: "node-a" }), currentCandidate({ recordId: "node-b" }), currentCandidate({ recordId: "node-c" })];
	const edges = [relation({ source: expRef("node-b"), target: expRef("node-a") }), relation({ source: expRef("node-c"), target: expRef("node-a") }), relation({ source: expRef("node-a"), target: expRef("node-c") })];
	const forward = decideMemory(query({ candidates: nodes, relations: edges }));
	const backward = decideMemory(query({ candidates: [...nodes].reverse(), relations: [...edges].reverse() }));
	assert.equal(JSON.stringify(forward), JSON.stringify(backward), "分叉图必须与输入排列无关");
	for (const id of ["node-a", "node-c"]) {
		assert.equal(pick(forward, id).class, "needs-review");
		assert.ok(pick(forward, id).reasons.includes("relation-ambiguous"), "环里的事实保留矛盾，不挑一条边");
	}
	assert.equal(pick(forward, "node-b").class, "current", "环外的声明方不受影响");

	// 撤回来源：b 被 c 撤回 ⇒ b 不再是当前事实，它的"替代 a"也只能降级（不反向复活 a）。
	const retractedChain = decideMemory(
		query({
			candidates: [currentCandidate({ recordId: "r-a" }), currentCandidate({ recordId: "r-b" }), currentCandidate({ recordId: "r-c" })],
			relations: [relation({ type: "supersedes", source: expRef("r-b"), target: expRef("r-a") }), relation({ type: "retracts", source: expRef("r-c"), target: expRef("r-b") })],
		}),
	);
	assert.ok(pick(retractedChain, "r-b").reasons.includes("retracted"));
	const retractedTarget = pick(retractedChain, "r-a");
	assert.equal(retractedTarget.class, "needs-review", "来源已被撤回时不能给出确定替代");
	assert.ok(retractedTarget.reasons.includes("relation-not-effective"));
	assert.ok(!retractedTarget.reasons.includes("superseded"));
	assert.ok(!retractedTarget.reasons.includes("retracted"));
	assert.equal(retractedChain.status, "incomplete", "来源有效性无法证明 ⇒ 整体不完整");

	// 节点预算：被丢掉的**目标**不能看起来"没有任何关系"。
	const many = decideMemory(
		query({
			candidates: [currentCandidate({ recordId: "budget-a" }), currentCandidate({ recordId: "budget-b" })],
			relations: [relation({ source: expRef("budget-b"), target: expRef("budget-a") })],
			limits: { maxRelationNodes: 1 },
		}),
	);
	assert.equal(many.status, "incomplete", "关系图触顶必须如实报不完整");
});

test("R29-4：明确不适用的跨板关系建图前被过滤，不制造假环；隐藏来源的未知范围不牵动可见事实", () => {
	// 旧红：a/b 的相互替代边都明确只作用于 BOARD-OTHER，当前目标是 BOARD-TARGET，
	// 仍被当成 needs-review/relation-ambiguous 的假环（拓扑判环先纳入全部边、后查 scope）。
	const a = currentCandidate({ recordId: "false-a", scope: emptyScope({ projectId: PROJECT_A, boardName: "BoardTARGET" }) });
	const b = currentCandidate({ recordId: "false-b", scope: emptyScope({ projectId: PROJECT_A, boardName: "BoardTARGET" }) });
	const edges = [relation({ source: expRef("false-b"), target: expRef("false-a"), scope: emptyScope({ boardName: "BoardOTHER" }) }), relation({ source: expRef("false-a"), target: expRef("false-b"), scope: emptyScope({ boardName: "BoardOTHER" }) })];
	const result = decideMemory(query({ target: target({ scope: emptyScope({ projectId: PROJECT_A, boardName: "BoardTARGET" }) }), candidates: [a, b], relations: edges }));
	assert.equal(pick(result, "false-a").class, "current", "明确不适用的关系不能把可见事实变成假环");
	assert.equal(pick(result, "false-b").class, "current");
	assert.equal(result.status, "ok");
	assert.ok(!pick(result, "false-a").reasons.includes("relation-ambiguous"));

	// 旧红：未授权 hidden 来源的边声明一个目标尚未知的 boardName，hidden 被隐藏，
	// 但可见 a 仍被降级为 unresolved-relation（unknownScope 早于 unauthorized 生效）。
	const visible = currentCandidate({ recordId: "visible-a" });
	const hidden = candidate({ recordId: "hidden-src", scope: emptyScope({ projectId: PROJECT_B }) });
	const hiddenEdge = relation({ source: expRef("hidden-src"), target: expRef("visible-a"), scope: emptyScope({ boardName: "BoardUnknown" }) });
	const hiddenResult = decideMemory(query({ target: target({ scope: emptyScope({ projectId: PROJECT_A }) }), candidates: [visible, hidden], relations: [hiddenEdge] }));
	assert.equal(pick(hiddenResult, "hidden-src"), undefined, "未授权声明方必须完全不可见");
	assert.equal(pick(hiddenResult, "visible-a").class, "current", "隐藏来源不能借未知范围把可见事实降级");
	assert.equal(hiddenResult.status, "ok");
	assert.doesNotMatch(JSON.stringify(hiddenResult), /hidden-src/);

	// 低节点预算对照：被过滤的边不占节点预算，因此不应因隐藏来源而触顶报不完整。
	const budget = decideMemory(query({ target: target({ scope: emptyScope({ projectId: PROJECT_A, boardName: "BoardTARGET" }) }), candidates: [a, b], relations: edges, limits: { maxRelationNodes: 1 } }));
	assert.equal(budget.status, "ok", "被过滤的边不占节点预算");
});

test("R27-2/R28-3：链长与关系数量有界，且只作用于声明范围内的目标", () => {
	// 链长上限：超过 maxRelationChain 必须停手并如实标记，同时整体不完整。
	//
	// R28-3 之后链上的判定也变了：exp-3 被 exp-4 替代 ⇒ exp-3 自身不再是当前事实，
	// 因此它"替代 exp-2"的断言不能作为确定结论（降级而不是反向复活 exp-2）。
	const chainCandidates = [1, 2, 3, 4].map((index) => currentCandidate({ recordId: `exp-${index}` }));
	const chainRelations = [relation({ source: expRef("exp-2"), target: expRef("exp-1") }), relation({ source: expRef("exp-3"), target: expRef("exp-2") }), relation({ source: expRef("exp-4"), target: expRef("exp-3") })];
	const chained = decideMemory(query({ candidates: chainCandidates, relations: chainRelations, limits: { maxRelationChain: 2 } }));
	assert.equal(pick(chained, "exp-4").class, "current", "链尾没有被任何关系作用");
	assert.ok(pick(chained, "exp-3").reasons.includes("superseded"));
	for (const id of ["exp-1", "exp-2"]) {
		assert.equal(pick(chained, id).class, "needs-review", "声明方自身已被替代 ⇒ 不能给出确定结论");
		assert.ok(pick(chained, id).reasons.includes("relation-not-effective"));
	}
	// exp-1 到链尾是 3 跳 > maxRelationChain(2)：只有它触顶，且必须显式可见。
	assert.ok(pick(chained, "exp-1").reasons.includes("relation-chain-truncated"), "链长触顶必须显式可见");
	assert.ok(!pick(chained, "exp-2").reasons.includes("relation-chain-truncated"), "2 跳仍在预算内");
	assert.equal(chained.status, "incomplete", "链长触顶意味着没有走完关系集合");

	// 关系数量超限：不返回部分结论。
	const tooMany = decideMemory(query({ candidates: chainCandidates, relations: chainRelations, limits: { maxRelations: 1 } }));
	assert.equal(tooMany.status, "incomplete");
	assert.deepEqual(tooMany.items, []);

	// 只作用于 Board A 的替代不影响 Board B。
	const boardA = currentCandidate({ recordId: "exp-board-a", scope: emptyScope({ projectId: PROJECT_A, boardName: "BoardA" }) });
	const boardB = currentCandidate({ recordId: "exp-board-b", scope: emptyScope({ projectId: PROJECT_A, boardName: "BoardB" }) });
	const sourceA = sourceCard("exp-a2", { scope: emptyScope({ projectId: PROJECT_A, boardName: "BoardA" }) });
	const scopedRelations = [relation({ source: expRef("exp-a2"), target: expRef("exp-board-a"), scope: emptyScope({ boardName: "BoardA" }) })];
	const forB = decideMemory(query({ target: target({ scope: emptyScope({ projectId: PROJECT_A, boardName: "BoardB" }) }), candidates: [boardA, boardB, sourceA], relations: scopedRelations }));
	assert.equal(pick(forB, "exp-board-b").class, "current");
	assert.ok(!pick(forB, "exp-board-b").reasons.includes("superseded"));

	// 目标范围未知时不能冒充明确关系。
	const unknownScope = decideMemory(query({ target: target({ scope: emptyScope({ projectId: PROJECT_A }) }), candidates: [boardA, sourceA], relations: scopedRelations }));
	assert.equal(pick(unknownScope, "exp-board-a").class, "needs-review");
	assert.ok(pick(unknownScope, "exp-board-a").reasons.includes("unresolved-relation"));

	// 端点形态缺失属于非法输入（不是"未解析关系"）。
	assert.throws(() => decideMemory(query({ candidates: [currentCandidate()], relations: [{ type: "supersedes", source: expRef("x"), scope: emptyScope({}) }] })), isInputError("invalid-input"));
	assert.throws(() => decideMemory(query({ candidates: [currentCandidate()], relations: [{ type: "supersedes", source: expRef("x"), target: { family: "experience-card", recordId: "exp-a" }, scope: emptyScope({}) }] })), isInputError("invalid-input"));
});

/* ------------------------------------------------------------------ §3 R27-3 */

/** 独立计量：`items` 按 JSON 数组序列化的实际字节数（不借助实现的字段）。 */
function itemsBytes(items) {
	return Buffer.byteLength(JSON.stringify(items), "utf8");
}

test("R27-3：输出字节预算精确到逗号，首条超限不得输出", () => {
	const single = decideMemory(query({ candidates: [currentCandidate({ recordId: "exp-only" })] }));
	assert.equal(single.status, "ok");
	const oneItemBytes = Buffer.byteLength(JSON.stringify(single.items[0]), "utf8");
	assert.equal(itemsBytes(single.items), 2 + oneItemBytes, "单条结果的数组开销恰好是 2 字节括号");
	assert.ok(oneItemBytes > 100, "单条结果本身有可观长度（用于下面的边界对照）");

	// 旧红：maxOutputBytes=1 时保留了整条 201 字节并 dropped=0。
	const overBudget = decideMemory(query({ candidates: [currentCandidate({ recordId: "exp-only" })], limits: { maxOutputBytes: 1 } }));
	assert.deepEqual(overBudget.items, [], "预算 1 字节时连空数组都放不下");
	assert.equal(overBudget.dropped, 1);
	assert.equal(overBudget.status, "incomplete");

	// 空数组固定开销 2 字节：预算 2 恰好能返回"空但不是未知"的结果。
	const emptyArray = decideMemory(query({ candidates: [currentCandidate({ recordId: "exp-only" })], limits: { maxOutputBytes: 2 } }));
	assert.deepEqual(emptyArray.items, []);

	// 精确边界：2 + 单条字节数恰好放得下，差一放不下。
	const exact = decideMemory(query({ candidates: [currentCandidate({ recordId: "exp-only" })], limits: { maxOutputBytes: 2 + oneItemBytes } }));
	assert.equal(itemsBytes(exact.items), 2 + oneItemBytes, "恰好用满预算时序列化结果正好等于预算");
	assert.equal(exact.items.length, 1);
	assert.equal(exact.dropped, 0);
	assert.equal(exact.status, "ok");
	const offByOne = decideMemory(query({ candidates: [currentCandidate({ recordId: "exp-only" })], limits: { maxOutputBytes: 2 + oneItemBytes - 1 } }));
	assert.deepEqual(offByOne.items, []);
	assert.equal(offByOne.status, "incomplete");

	// 两条时逗号开销必须计入：2 + b1 + 1 + b2 恰好两条；减一只剩第一条。
	const two = decideMemory(query({ candidates: [currentCandidate({ recordId: "exp-1" }), currentCandidate({ recordId: "exp-2" })] }));
	assert.equal(two.items.length, 2, "默认预算下两条都在");
	const firstBytes = Buffer.byteLength(JSON.stringify(two.items[0]), "utf8");
	const secondBytes = Buffer.byteLength(JSON.stringify(two.items[1]), "utf8");
	const exactTwo = decideMemory(query({ candidates: [currentCandidate({ recordId: "exp-1" }), currentCandidate({ recordId: "exp-2" })], limits: { maxOutputBytes: 2 + firstBytes + 1 + secondBytes } }));
	assert.equal(exactTwo.items.length, 2);
	assert.equal(itemsBytes(exactTwo.items), 2 + firstBytes + 1 + secondBytes);
	const minusOne = decideMemory(query({ candidates: [currentCandidate({ recordId: "exp-1" }), currentCandidate({ recordId: "exp-2" })], limits: { maxOutputBytes: 2 + firstBytes + 1 + secondBytes - 1 } }));
	assert.equal(minusOne.items.length, 1, "前缀语义：第二条放不下就丢弃第二条及其后");
	assert.equal(minusOne.dropped, 1);
	assert.equal(minusOne.status, "incomplete");
});

test("R27-3：数量闸门先于任何逐项访问", () => {
	let reads = 0;
	const spy = {};
	for (const field of ["family", "recordId", "revision", "authority", "status", "scope", "reuse", "time", "confirmedFields", "validations", "evidence", "dependencySnapshot", "derivedFromSummaryOf", "factKey", "value", "title", "sourceFingerprint"]) {
		Object.defineProperty(spy, field, {
			enumerable: true,
			get() {
				reads += 1;
				return undefined;
			},
		});
	}
	// 旧红：返回 incomplete 之前已经读过 recordId 等字段 3 次。
	const result = decideMemory(query({ candidates: [spy], limits: { maxCandidates: 0 } }));
	assert.equal(result.status, "incomplete");
	assert.deepEqual(result.items, []);
	assert.equal(reads, 0, "数量闸门不得读取任何候选字段");
});

test("R27-3：公共入口拒绝非法形态与非法策略，且不回显长正文", () => {
	assert.throws(() => decideMemory(null), isInputError());
	assert.throws(() => decideMemory(undefined), isInputError());
	assert.throws(() => decideMemory("not an object"), isInputError());
	assert.throws(() => decideMemory(query({ intent: "everything" })), isInputError());
	assert.throws(() => decideMemory(query({ now: -1 })), isInputError());
	assert.throws(() => decideMemory(query({ now: 1.5 })), isInputError());
	assert.throws(() => decideMemory(query({ authorization: authorization({ endpointAllowed: "invalid" }) })), isInputError());
	assert.throws(() => decideMemory(query({ authorization: authorization({ allowInternalGeneral: "yes" }) })), isInputError());
	assert.throws(() => decideMemory(query({ authorization: authorization({ customers: ["ok", 42] }) })), isInputError());
	assert.throws(() => decideMemory(query({ target: target({ scope: { projectId: 42 } }) })), isInputError());
	assert.throws(() => decideMemory(query({ candidates: [{ ...currentCandidate(), family: "unknown-family" }] })), isInputError());
	assert.throws(() => decideMemory(query({ candidates: [{ ...currentCandidate(), status: "maybe" }] })), isInputError());
	assert.throws(() => decideMemory(query({ candidates: [{ ...currentCandidate(), validations: [{ kind: "vibes", result: "passed", performedAt: NOW }] }] })), isInputError());
	assert.throws(() => decideMemory(query({ candidates: [{ ...currentCandidate(), evidence: [{ validity: "gone", contentHash: null }] }] })), isInputError());
	assert.throws(() => decideMemory(query({ candidates: [{ ...currentCandidate(), time: emptyTime({ effectiveFrom: "yesterday" }) }] })), isInputError());

	// 嵌套数组超限：受控拒绝且文案有界（不回显被拒材料）。
	const huge = { ...currentCandidate(), confirmedFields: Array.from({ length: 300 }, (_, index) => ({ field: `f${index}`, value: "v", status: "candidate" })) };
	try {
		decideMemory(query({ candidates: [huge] }));
		assert.fail("嵌套数组超限必须被拒绝");
	} catch (error) {
		assert.ok(error instanceof MemoryInputError);
		assert.ok(error.message.length < 200);
	}
	// 限额本身：非法数字与未知字段都拒绝。
	assert.throws(() => decideMemory(query({ limits: { maxCandidates: -1 } })), isInputError("invalid-limits"));
	assert.throws(() => decideMemory(query({ limits: { maxCandidates: Number.NaN } })), isInputError("invalid-limits"));
	assert.throws(() => decideMemory(query({ limits: { maxCandidatess: 5 } })), isInputError("invalid-limits"));
	assert.throws(() => decideMemory(query({ limits: { maxNestedItems: 1.5 } })), isInputError("invalid-limits"));
});

test("R27-3：输入超限不返回部分结论，合法限额边界可过", () => {
	const candidates = [currentCandidate({ recordId: "exp-1" }), currentCandidate({ recordId: "exp-2" })];
	assert.equal(decideMemory(query({ candidates, limits: { maxCandidates: 2 } })).status, "ok");
	assert.equal(decideMemory(query({ candidates, limits: { maxCandidates: 1 } })).status, "incomplete");
	assert.deepEqual(decideMemory(query({ candidates, limits: { maxCandidates: 1 } })).items, []);
	// maxReasons=0：没地方写原因 ≠ 没有原因。
	const noReasons = decideMemory(query({ candidates: [currentCandidate({ recordId: "exp-r", status: "draft" })], limits: { maxReasons: 0 } }));
	assert.equal(pick(noReasons, "exp-r").reasons.length, 0);
	assert.equal(pick(noReasons, "exp-r").reasonsTruncated, true);
});

/* ------------------------------------------------------------------ §4 既有语义（MT-*） */

test("MT-03：录入与生效分开，未来/过期都不成为当前值", () => {
	const future = currentCandidate({ recordId: "exp-future", time: emptyTime({ recordedAt: NOW - 10 * DAY, effectiveFrom: NOW + DAY }) });
	const ended = currentCandidate({ recordId: "exp-ended", time: emptyTime({ effectiveFrom: NOW - 10 * DAY, effectiveTo: NOW - DAY }) });
	const openEnded = currentCandidate({ recordId: "exp-open", time: emptyTime({ effectiveFrom: NOW - DAY, effectiveTo: null }) });
	const result = decideMemory(query({ candidates: [future, ended, openEnded] }));

	assert.ok(pick(result, "exp-future").reasons.includes("not-yet-effective"));
	assert.ok(pick(result, "exp-ended").reasons.includes("expired"));
	assert.notEqual(pick(result, "exp-ended").class, "current");
	assert.equal(pick(result, "exp-open").class, "current", "半开区间 [from,to)：to 为 null 表示未指定结束，仍然有效");

	// 区间端点：now === effectiveFrom 立即生效；now === effectiveTo 已经过期。
	assert.equal(pick(decideMemory(query({ candidates: [currentCandidate({ recordId: "exp-from", time: emptyTime({ effectiveFrom: NOW }) })] })), "exp-from").class, "current");
	assert.ok(pick(decideMemory(query({ candidates: [currentCandidate({ recordId: "exp-to", time: emptyTime({ effectiveTo: NOW }) })] })), "exp-to").reasons.includes("expired"));
	assert.throws(() => decideMemory(query({ candidates: [candidate({ time: emptyTime({ effectiveFrom: NOW + DAY, effectiveTo: NOW }) })] })), isInputError("invalid-time-range"));
});

test("MT-04：Board A 的替代不影响 Board B；history 可见且带标记", () => {
	const boardA = currentCandidate({ recordId: "exp-a", scope: emptyScope({ projectId: PROJECT_A, boardName: "BoardA" }) });
	const boardB = currentCandidate({ recordId: "exp-b", scope: emptyScope({ projectId: PROJECT_A, boardName: "BoardB" }) });
	const sourceA = sourceCard("exp-a2", { scope: emptyScope({ projectId: PROJECT_A, boardName: "BoardA" }) });
	const relations = [relation({ source: expRef("exp-a2"), target: expRef("exp-a"), scope: emptyScope({ boardName: "BoardA" }) })];

	const forA = decideMemory(query({ target: target({ scope: emptyScope({ projectId: PROJECT_A, boardName: "BoardA" }) }), candidates: [boardA, boardB, sourceA], relations }));
	assert.equal(pick(forA, "exp-a").class, "excluded");
	assert.ok(pick(forA, "exp-a").reasons.includes("superseded"));

	const history = decideMemory(query({ intent: "history", target: target({ scope: emptyScope({ projectId: PROJECT_A, boardName: "BoardA" }) }), candidates: [boardA], relations }));
	assert.equal(pick(history, "exp-a").class, "history");
	assert.ok(pick(history, "exp-a").reasons.includes("history-record"));
});

test("跨客户未授权与端点 unknown：不得返回标题、ID 或计数", () => {
	const secret = currentCandidate({
		recordId: "exp-secret",
		scope: emptyScope({ projectId: PROJECT_B, customerId: "customer-other" }),
		reuse: { level: "customer", customers: ["customer-other"], authorization: "允许内部复用" },
		title: "另一家客户的私密现象",
	});
	const own = currentCandidate({ recordId: "exp-own", title: "本项目现象" });

	const denied = decideMemory(query({ candidates: [secret, own] }));
	assert.equal(pick(denied, "exp-secret"), undefined, "未授权候选完全不出现在结果里");
	assert.equal(denied.dropped, 0, "计数也不能泄漏未授权候选");
	assert.doesNotMatch(JSON.stringify(denied), /私密现象|exp-secret/, "任何输出面都不得出现被拒材料");

	const unknownEndpoint = decideMemory(query({ authorization: authorization({ endpointAllowed: null }), candidates: [own] }));
	assert.equal(pick(unknownEndpoint, "exp-own").class, "reference");
	assert.ok(pick(unknownEndpoint, "exp-own").reasons.includes("endpoint-unknown"));

	const endpointDenied = decideMemory(query({ authorization: authorization({ endpointAllowed: false }), candidates: [own] }));
	assert.equal(pick(endpointDenied, "exp-own"), undefined);
});

test("MT-05/08：撤回不因旧摘要复活；deprecated 陈旧候选不进当前推荐", () => {
	const retracted = currentCandidate({ recordId: "exp-a", title: "已撤回的结论" });
	const summary = currentCandidate({ recordId: "summary-1", family: "session-summary", status: "unknown", derivedFromSummaryOf: "exp-a", title: "旧会话摘要" });
	const source = sourceCard("exp-note");
	const relations = [relation({ type: "retracts", source: expRef("exp-note"), target: expRef("exp-a") })];

	const current = decideMemory(query({ candidates: [retracted, summary, source], relations }));
	assert.equal(pick(current, "exp-a").class, "excluded");
	assert.ok(pick(current, "exp-a").reasons.includes("retracted"));
	assert.equal(pick(current, "summary-1").class, "excluded");
	assert.ok(pick(current, "summary-1").reasons.includes("summary-derived"));

	const stale = currentCandidate({ recordId: "exp-old", status: "deprecated", title: "已弃用做法" });
	assert.equal(pick(decideMemory(query({ candidates: [stale] })), "exp-old").class, "excluded");
	assert.equal(pick(decideMemory(query({ intent: "history", candidates: [stale] })), "exp-old").class, "history");
});

test("MT-07/10：只比较显式声明的依赖；无关变化不全局失效；unavailable 不等于判错", () => {
	const dependent = currentCandidate({
		recordId: "exp-dep",
		validations: [
			{ kind: "compile", result: "passed", performedAt: NOW - DAY },
			{ kind: "board-boot", result: "passed", performedAt: NOW - DAY },
		],
		dependencySnapshot: { commit: "abc123", boardRevision: "A1", buildTarget: "BoardPkg", contentHashes: ["hash-1"] },
	});
	const unrelated = currentCandidate({ recordId: "exp-free", validations: [{ kind: "compile", result: "passed", performedAt: NOW - DAY }] });

	const same = decideMemory(query({ candidates: [dependent, unrelated], target: target({ snapshot: { commit: "abc123", boardRevision: "A1", buildTarget: "BoardPkg", contentHashes: ["hash-1", "hash-9"] } }) }));
	assert.equal(pick(same, "exp-dep").class, "current");
	assert.equal(pick(same, "exp-dep").verification.strongestPassed, "board-boot");

	const drifted = decideMemory(query({ candidates: [dependent, unrelated], target: target({ snapshot: { commit: "abc123", boardRevision: "A2", buildTarget: "BoardPkg", contentHashes: ["hash-1", "hash-9"] } }) }));
	assert.equal(pick(drifted, "exp-dep").class, "needs-review");
	assert.ok(pick(drifted, "exp-dep").reasons.includes("verification-drift"));
	assert.equal(pick(drifted, "exp-free").class, "current", "无关文件变化不得让全部知识失效");

	const unknownTarget = decideMemory(query({ candidates: [dependent], target: target({ snapshot: { commit: null, boardRevision: null, buildTarget: null, contentHashes: [] } }) }));
	assert.ok(pick(unknownTarget, "exp-dep").reasons.includes("verification-drift"));

	const compileOnly = currentCandidate({ recordId: "exp-compile", validations: [{ kind: "compile", result: "passed", performedAt: NOW - DAY }] });
	assert.equal(pick(decideMemory(query({ candidates: [compileOnly] })), "exp-compile").verification.strongestPassed, "compile");

	const unavailable = currentCandidate({ recordId: "exp-unavail", evidence: [{ validity: "unavailable", contentHash: null }] });
	const withUnavailable = decideMemory(query({ candidates: [unavailable] }));
	assert.equal(pick(withUnavailable, "exp-unavail").class, "needs-review");
	assert.ok(pick(withUnavailable, "exp-unavail").reasons.includes("evidence-unavailable"));
});

test("MT-11/12：权威不可读不回显标题；v1 未指定时态/快照只作参考", () => {
	const unreadable = currentCandidate({ recordId: "exp-bad", authority: "unreadable", title: "读不到的内容" });
	const unverified = currentCandidate({ recordId: "exp-raw", authority: "unverified" });
	const result = decideMemory(query({ candidates: [unreadable, unverified] }));
	assert.equal(pick(result, "exp-bad").class, "needs-review");
	assert.equal(pick(result, "exp-bad").title, null);
	assert.ok(pick(result, "exp-bad").reasons.includes("authority-unreadable"));
	assert.equal(pick(result, "exp-raw").class, "reference");
	assert.ok(pick(result, "exp-raw").reasons.includes("authority-unverified"));

	// v1 形态：既没有生效区间、也没有依赖快照 ⇒ 只作参考。
	const legacy = candidate({ recordId: "exp-legacy", time: emptyTime({ effectiveFrom: null, effectiveTo: null, occurredAt: null }), dependencySnapshot: null });
	const legacyResult = pick(decideMemory(query({ candidates: [legacy] })), "exp-legacy");
	assert.equal(legacyResult.class, "reference");
	assert.ok(legacyResult.reasons.includes("legacy-unspecified"));

	// 候选声明了板卡维度而目标未声明 ⇒ 不能确认。
	const scoped = currentCandidate({ recordId: "exp-scoped", scope: emptyScope({ projectId: PROJECT_A, boardName: "BoardB" }) });
	const withUnknownBoard = pick(decideMemory(query({ candidates: [scoped] })), "exp-scoped");
	assert.equal(withUnknownBoard.class, "needs-review");
	assert.ok(withUnknownBoard.reasons.includes("scope-unknown"));
});

test("确定性与有界：输入不被修改、排列不改变结果、标题按字符预算截断", () => {
	const longTitle = "很长的标题".repeat(200);
	const cards = [currentCandidate({ recordId: "exp-a", title: longTitle }), currentCandidate({ recordId: "exp-b", title: "普通标题" })];
	const before = JSON.stringify(cards);

	const first = decideMemory(query({ candidates: cards, limits: { maxTitleChars: 16 } }));
	const second = decideMemory(query({ candidates: [...cards].reverse(), limits: { maxTitleChars: 16 } }));
	assert.equal(JSON.stringify(cards), before, "决策不得修改输入");
	assert.deepEqual(first, second, "顺序置换必须得到相同结果");

	const item = pick(first, "exp-a");
	assert.equal(item.title.length, 16);
	assert.equal(item.titleTruncated, true);
	assert.ok(item.reasons.includes("title-truncated"));
});

/* ------------------------------------------------------------------ §5 v1 投影 */

test("v1 投影：严格校验、不修改输入、不伪造生效时间/验证范围", () => {
	const card = {
		schemaVersion: BIOS_CONTRACTS_SCHEMA_VERSION,
		revision: 3,
		createdAt: NOW - 5 * DAY,
		updatedAt: NOW - 5 * DAY,
		id: "exp-a",
		problem: "PXE 默认开启",
		rootCause: "默认值",
		solution: "关闭 PXE",
		appliesWhen: ["客户要求快速启动"],
		doesNotApplyWhen: [],
		sourceProjectId: PROJECT_A,
		evidence: [],
		validations: [],
		reuseScope: { level: "current-project", customers: [] },
		status: "reviewed",
	};
	const snapshot = JSON.stringify(card);
	const projected = projectV1ExperienceCard(card);

	assert.equal(projected.family, "experience-card");
	assert.equal(projected.recordId, "exp-a");
	assert.equal(projected.scope.projectId, PROJECT_A);
	assert.equal(projected.time.recordedAt, NOW - 5 * DAY, "createdAt 的真实语义是录入时间");
	assert.equal(projected.time.effectiveFrom, null, "不得用 createdAt 伪造生效时间");
	assert.equal(projected.time.occurredAt, null);
	assert.equal(projected.dependencySnapshot, null, "v1 没有依赖快照，不得声称当前硬件验证通过");
	assert.equal(projected.factKey, null, "不得用 problem 文本猜事实键");
	assert.equal(JSON.stringify(card), snapshot, "投影不得修改输入");

	const rejected = projectV1Record("experience-card", { ...card, solution: undefined });
	assert.equal(rejected.ok, false);
	assert.equal(rejected.code, "invalid-record");
	assert.equal(projectV1Record("context-manifest", { schemaVersion: BIOS_CONTRACTS_SCHEMA_VERSION }).ok, false);
});

test("v1 投影后：已审核经验在匹配目标上仍是参考；跨项目不可见", () => {
	const card = {
		schemaVersion: BIOS_CONTRACTS_SCHEMA_VERSION,
		revision: 0,
		createdAt: NOW - DAY,
		updatedAt: NOW - DAY,
		id: "exp-a",
		problem: "PXE 默认开启",
		rootCause: "默认值",
		solution: "关闭 PXE",
		appliesWhen: [],
		doesNotApplyWhen: [],
		sourceProjectId: PROJECT_A,
		evidence: [],
		validations: [{ kind: "board-boot", scope: "BoardA A1", result: "passed", performedAt: NOW - DAY, performedBy: "bob", evidence: [] }],
		reuseScope: { level: "current-project", customers: [] },
		status: "verified",
	};
	const projected = projectV1ExperienceCard(card);
	const result = pick(decideMemory(query({ candidates: [projected] })), "exp-a");
	// v1 卡没有生效区间/依赖快照 ⇒ 只作参考，不冒充"当前已验证事实"（设计 §8）。
	assert.equal(result.class, "reference");
	assert.ok(result.reasons.includes("legacy-unspecified"));
	assert.equal(result.verification.strongestPassed, "board-boot", "验证强度按记录里的实际类别报告，不因 legacy 降级");

	// 目标是别的项目 ⇒ `current-project` 级复用未授权：候选不出现。
	const otherProject = decideMemory(query({ candidates: [projected], target: target({ scope: emptyScope({ projectId: PROJECT_B }) }) }));
	assert.equal(pick(otherProject, "exp-a"), undefined);
	assert.doesNotMatch(JSON.stringify(otherProject), /PXE/);

	// 目标声明了工作区而候选未声明 ⇒ 不作判断（既不是匹配也不是不适用）。
	const withWorkspace = pick(decideMemory(query({ candidates: [projected], target: target({ scope: emptyScope({ projectId: PROJECT_A, workspaceId: WORKSPACE_A }) }) })), "exp-a");
	assert.equal(withWorkspace.class, "reference");
});

test("关系端点的记录族参与身份：跨族同名 ID 的关系不生效", () => {
	const base = currentCandidate({ recordId: "shared", family: "experience-card" });
	// 声明方写成 feature-record：候选中并不存在这条记录身份 ⇒ 不能冒充有效替代。
	const crossFamily = decideMemory(query({ candidates: [base], relations: [relation({ source: ref("feature-record", "shared", 1), target: ref("experience-card", "shared", 1) })] }));
	assert.equal(pick(crossFamily, "shared").class, "needs-review");
	assert.ok(pick(crossFamily, "shared").reasons.includes("unresolved-relation"));
});
