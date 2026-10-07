/**
 * §7.4 / §9.4 遗留项 R4 的正式回归：**正式与 working 的合并预算**，以及跨客户/跨平台正式经验正例。
 *
 * 为什么必须新写：
 * - 旧行为里正式检索与 working 检索**各自** `resolveRetrievalPlan()` 后各自按 `maxLeads` 截断，
 *   同一份计划被消费两次 ⇒ 实际"取几条"可以是 `2 × maxLeads`。单库正例永远证明不了合并预算，
 *   所以这里在**同一用例**里同时跑两边，断言合并后的总条数受同一份预算约束，并量测截断量。
 * - §7.4 还要求补"已批准客户/跨平台正式经验正例与拒绝例"：这里用**另一个项目的正式经验**
 *   验证客户级复用（显式批准才可见）、跨项目参考标记，以及未授权来源仍被拒绝。
 *
 * 全部离线：临时知识根 + 临时工程，不联网、不碰真实工程。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { initializeKnowledgeStore } from "../core/storage/index.ts";
import { bindProjectWorkspace } from "../core/projects/index.ts";
import { createExperienceDraft, reviewExperience } from "../core/knowledge/experiences.ts";
import { confirmedCustomerOf, createRetrievalLedger } from "../core/automation/policy.ts";
import { searchReviewedKnowledge, searchWorkingMemory } from "../core/automation/working.ts";
import { createProjectSandbox, writeDsc } from "./helpers/projectFixtures.mjs";

async function fixture(prefix) {
	const sb = await createProjectSandbox(prefix);
	await initializeKnowledgeStore({ root: sb.root });
	await writeDsc(sb.workspaceA, "Sample.dsc", { platformName: "SyntheticR4A" });
	await writeDsc(sb.workspaceB, "Sample.dsc", { platformName: "SyntheticR4B" });
	const a = await bindProjectWorkspace({ root: sb.root, cwd: sb.workspaceA, workspacePath: sb.workspaceA });
	const b = await bindProjectWorkspace({ root: sb.root, cwd: sb.workspaceB, workspacePath: sb.workspaceB });
	return { ...sb, a, b };
}

const QUERY = "USB 端口只跑 2.0 速度";

/** 造一条**已提交审核**的正式经验（正式检索只认 reviewed/verified）。 */
async function reviewed(f, input) {
	const draft = await createExperienceDraft({
		root: f.root,
		authorizedProjectIds: [f.a.projectId, f.b.projectId],
		experience: {
			experienceId: input.experienceId,
			problem: `${input.marker} USB 端口只跑 2.0 速度`,
			rootCause: `${input.marker} 根因`,
			solution: `${input.marker} 解法`,
			appliesWhen: input.appliesWhen ?? ["synthetic only"],
			sourceProjectId: input.sourceProjectId,
			evidence: [{ type: "source-file", workspaceId: input.workspaceId, relativePath: "Sample.dsc", contentHash: "0".repeat(64) }],
			reuse: input.reuse ?? { level: "current-project" },
		},
	});
	await reviewExperience({ root: f.root, authorizedProjectIds: [f.a.projectId, f.b.projectId], experienceId: input.experienceId, expectedRevision: draft.revision, action: "submit-review", operatorLabel: "fixture", reason: "synthetic" });
}

/** 造一条**未审核草稿**（working 只认 draft）。 */
async function draft(f, input) {
	await createExperienceDraft({
		root: f.root,
		authorizedProjectIds: [f.a.projectId, f.b.projectId],
		experience: {
			experienceId: input.experienceId,
			problem: `${input.marker} USB 端口只跑 2.0 速度`,
			rootCause: `${input.marker} 根因`,
			solution: `${input.marker} 解法`,
			appliesWhen: ["synthetic only"],
			sourceProjectId: input.sourceProjectId,
			evidence: [{ type: "source-file", workspaceId: input.workspaceId, relativePath: "Sample.dsc", contentHash: "0".repeat(64) }],
			reuse: { level: "current-project" },
		},
	});
}

test("R4：正式与 working **共享同一份合并预算**（不能各拿一份 plan），并量测截断量", async () => {
	const f = await fixture("aw-r4-budget-");
	try {
		for (let index = 1; index <= 5; index += 1) await reviewed(f, { experienceId: `exp-formal-${index}`, marker: `SYNTHETIC_FORMAL_${index}`, sourceProjectId: f.a.projectId, workspaceId: f.a.workspaceId });
		for (let index = 1; index <= 3; index += 1) await draft(f, { experienceId: `exp-draft-${index}`, marker: `SYNTHETIC_DRAFT_${index}`, sourceProjectId: f.a.projectId, workspaceId: f.a.workspaceId });
		// 预算全部取硬上限以内的值（`maxProjectLeads` 硬上限是 2、`maxDetailReads` 是 3）：
		// 合并预算只能在既有上限内**收紧**，不能借这次改动放宽任何硬限制。
		const plan = { maxLeads: 3, maxProjectLeads: 2, maxDetailReads: 3 };
		const common = { root: f.root, projectId: f.a.projectId, workspaceId: f.a.workspaceId, authorizedProjectIds: [f.a.projectId], allowedFeatureIds: [], approvedCustomers: [], endpointAllowed: true, query: QUERY, plan };

		// 先证明"各自一份 plan"确实会让两边都拿到满额（旧行为），否则合并预算约束无从谈起。
		const formalAlone = await searchReviewedKnowledge(common);
		const workingAlone = await searchWorkingMemory({ ...common, taskId: null });
		assert.equal(formalAlone.leads.length, plan.maxLeads, JSON.stringify(formalAlone.leads.map((lead) => lead.recordId)));
		assert.equal(workingAlone.leads.length, plan.maxProjectLeads, JSON.stringify(workingAlone.leads.map((lead) => lead.recordId)));
		assert.ok(formalAlone.leads.length + workingAlone.leads.length > plan.maxLeads, "单库分别计预算时两边会各自拿满额：这正是需要合并的理由");

		// 合并预算：正式先消费 3 条 ⇒ working 只能拿到 0 条，且必须如实报告"没轮到读"。
		const ledger = createRetrievalLedger(plan);
		const formal = await searchReviewedKnowledge({ ...common, ledger });
		const working = await searchWorkingMemory({ ...common, taskId: null, ledger });
		assert.equal(formal.leads.length + working.leads.length, plan.maxLeads, "合并后的线索总数必须受同一份预算约束");
		assert.equal(working.leads.length, 0);
		assert.equal(working.status, "incomplete", "预算用尽不能显示成 empty（那会被读成没有历史记录）");
		assert.ok(
			working.notes.some((note) => note.includes("合并检索预算")),
			JSON.stringify(working.notes),
		);
		const snapshot = ledger.snapshot();
		assert.equal(snapshot.leads, plan.maxLeads);
		assert.ok(snapshot.leadsTruncated >= 2, `必须能量测截断量（正式 5 条只取 3）：${JSON.stringify(snapshot)}`);
		assert.equal(snapshot.exhausted, true);
	} finally {
		await f.cleanup();
	}
});

test("R4：跨客户/跨平台正式经验正例进入自动检索；未批准客户/未授权来源仍是拒绝例", async () => {
	const f = await fixture("aw-r4-cross-");
	try {
		// 来源项目 B（另一个客户、另一平台）：客户级复用 + 显式批准才可见。
		await reviewed(f, {
			experienceId: "exp-cross-customer",
			marker: "SYNTHETIC_CROSS_CUSTOMER_MARKER",
			sourceProjectId: f.b.projectId,
			workspaceId: f.b.workspaceId,
			appliesWhen: ["SYNTHETIC platform B only"],
			reuse: { level: "customer", customers: ["SYNTHETIC_CUSTOMER_B"] },
		});
		const base = { root: f.root, query: QUERY, projectId: f.a.projectId, workspaceId: f.a.workspaceId, allowedFeatureIds: [], endpointAllowed: true };

		// 目标客户必须来自**人工确认**的档案字段（候选/空值一律不推导）。
		assert.equal(confirmedCustomerOf({ identity: { customer: { value: "SYNTHETIC_CUSTOMER_B", status: "confirmed" } } }), "SYNTHETIC_CUSTOMER_B");
		assert.equal(confirmedCustomerOf({ identity: { customer: { value: "SYNTHETIC_CUSTOMER_B", status: "candidate" } } }), null, "候选值不得当成目标客户");
		assert.equal(confirmedCustomerOf({ identity: { customer: { value: "", status: "confirmed" } } }), null);
		assert.equal(confirmedCustomerOf(null), null);

		// 正例：来源授权 + 目标客户已确认 + 客户显式批准 ⇒ 跨项目参考条目必须出现。
		const allowed = await searchReviewedKnowledge({ ...base, targetCustomerId: "SYNTHETIC_CUSTOMER_B", authorizedProjectIds: [f.a.projectId, f.b.projectId], approvedCustomers: ["SYNTHETIC_CUSTOMER_B"] });
		const hit = allowed.leads.find((lead) => lead.recordId === "exp-cross-customer");
		assert.ok(hit !== undefined, `已批准客户的跨平台正式经验必须能被自动检索到：${JSON.stringify(allowed.leads)}`);
		assert.equal(hit.verification, "reviewed");
		assert.equal(hit.baseline, "跨项目参考", "跨项目条目必须标成参考，不能冒充同项目结论");
		assert.ok(
			allowed.notes.some((note) => note.includes("移植参考")),
			JSON.stringify(allowed.notes),
		);

		// 拒绝例 1：客户未批准 ⇒ 正文与 ID 都不出现。
		const customerDenied = await searchReviewedKnowledge({ ...base, targetCustomerId: "SYNTHETIC_CUSTOMER_B", authorizedProjectIds: [f.a.projectId, f.b.projectId], approvedCustomers: [] });
		assert.equal(
			customerDenied.leads.find((lead) => lead.recordId === "exp-cross-customer"),
			undefined,
			"未批准客户不得返回",
		);

		// 拒绝例 2：目标客户未知（档案未确认）⇒ 客户级经验不得被"推导成公开"。
		const customerUnknown = await searchReviewedKnowledge({ ...base, targetCustomerId: null, authorizedProjectIds: [f.a.projectId, f.b.projectId], approvedCustomers: ["SYNTHETIC_CUSTOMER_B"] });
		assert.equal(
			customerUnknown.leads.find((lead) => lead.recordId === "exp-cross-customer"),
			undefined,
			"目标客户未知时不得返回客户级经验",
		);

		// 拒绝例 3：来源项目未授权 ⇒ 不得借"批准了客户"绕过项目授权。
		const projectDenied = await searchReviewedKnowledge({ ...base, targetCustomerId: "SYNTHETIC_CUSTOMER_B", authorizedProjectIds: [f.a.projectId], approvedCustomers: ["SYNTHETIC_CUSTOMER_B"] });
		assert.equal(
			projectDenied.leads.find((lead) => lead.recordId === "exp-cross-customer"),
			undefined,
			"未授权项目不得返回",
		);

		// 拒绝例 4：端点不明确允许时连正式检索都不做（沿用既有外发策略）。
		const endpointDenied = await searchReviewedKnowledge({ ...base, targetCustomerId: "SYNTHETIC_CUSTOMER_B", authorizedProjectIds: [f.a.projectId, f.b.projectId], approvedCustomers: ["SYNTHETIC_CUSTOMER_B"], endpointAllowed: false });
		assert.equal(endpointDenied.status, "denied");
		assert.equal(endpointDenied.leads.length, 0);
	} finally {
		await f.cleanup();
	}
});
