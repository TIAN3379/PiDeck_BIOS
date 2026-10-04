/**
 * BM-04 永久回归：需求（Feature）、经验卡（含人工审核）与有界检索。
 *
 * 覆盖 bm04_development_plan.md §5 要求的行为：
 * 创建/草稿更新/CAS 冲突无覆盖/托管字段不可绕过/真实审核审计往返/
 * 合法与非法废弃恢复/授权先于标题与计数/别名匹配/draft 与废弃不进当前推荐/
 * history 可解释/端点策略/源变化无陈旧推荐/数量与实际读取预算/不可读计数。
 *
 * 全部使用自建临时知识库与合成内容；不读任何真实客户资料。
 */
import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { initializeKnowledgeStore, readRecord, readRegistry } from "../core/storage/index.ts";
import { bindProjectWorkspace, openProjectProfile } from "../core/projects/index.ts";
import { createExperienceDraft, createFeature, readExperienceDetail, readExperienceReference, readFeatureDetail, reviewExperience, searchKnowledge, updateExperienceDraft, updateFeature } from "../core/knowledge/index.ts";
import { createProjectSandbox, writeDsc } from "./helpers/projectFixtures.mjs";

const NOW = 1_700_000_000_000;

function access(workspacePath) {
	return { cwd: workspacePath, authorizedRoots: [workspacePath] };
}

/** 一个已绑定两个项目的合成知识库（A 为来源项目，B 为目标项目）。 */
async function knowledgeSandbox() {
	const sandbox = await createProjectSandbox("bm04-");
	await initializeKnowledgeStore({ root: sandbox.root, now: NOW });
	await writeDsc(sandbox.workspaceA, "Platform/SamplePkg/Sample.dsc", { platformName: "SamplePlatformA" });
	await writeDsc(sandbox.workspaceB, "Platform/SamplePkg/Sample.dsc", { platformName: "SamplePlatformB" });
	const projectA = await bindProjectWorkspace({ ...access(sandbox.workspaceA), root: sandbox.root, workspacePath: sandbox.workspaceA, now: NOW });
	const projectB = await bindProjectWorkspace({ ...access(sandbox.workspaceB), root: sandbox.root, workspacePath: sandbox.workspaceB, now: NOW });
	return { ...sandbox, projectA, projectB };
}

function featureDraft(overrides = {}) {
	return {
		featureId: "feat-pxe",
		originalRequirement: "客户要求关闭 PXE 以缩短启动时间",
		aliases: ["PXE", "快速启动"],
		customer: { value: "customer-alpha", status: "confirmed" },
		productLine: { value: "line-x", status: "confirmed" },
		acceptanceCriteria: ["开机不再尝试 PXE 引导"],
		relatedExperienceIds: [],
		...overrides,
	};
}

function experienceDraft(overrides = {}) {
	return {
		experienceId: "exp-pxe",
		problem: "PXE 默认开启导致启动变慢",
		rootCause: "平台默认值未关闭 PXE",
		solution: "在平台 DSC 里关闭 PXE 默认值",
		appliesWhen: ["客户要求快速启动"],
		doesNotApplyWhen: ["需要网络引导的产线"],
		sourceProjectId: "project-placeholder",
		...overrides,
	};
}

/* ------------------------------------------------------------------ 需求（Feature） */

test("B1：需求录入原样保存原文与别名，CAS 冲突不覆盖", async () => {
	const sandbox = await knowledgeSandbox();
	try {
		const created = await createFeature({ root: sandbox.root, feature: featureDraft(), now: NOW });
		assert.equal(created.status, "created");
		assert.equal(created.revision, 0);
		assert.deepEqual(created.needsReview, []);

		const stored = await readRecord({ root: sandbox.root, kind: "feature-record", id: "feat-pxe" });
		// 原文与别名顺序原样保存（检索键是派生值，不回写）。
		assert.equal(stored.record.originalRequirement, "客户要求关闭 PXE 以缩短启动时间");
		assert.deepEqual(stored.record.aliases, ["PXE", "快速启动"]);
		assert.equal(stored.record.customer.status, "confirmed");
		assert.equal(stored.record.customer.value, "customer-alpha");
		assert.equal(stored.record.productLine.value, "line-x");

		// 重复创建 → revision 冲突（不是"又建一条"）。
		const again = await createFeature({ root: sandbox.root, feature: featureDraft(), now: NOW + 1 });
		assert.equal(again.status, "revision-conflict");
		assert.equal(again.actualRevision, 0);

		// 更新：只改点名字段，未触达字段保留。
		const updated = await updateFeature({ root: sandbox.root, featureId: "feat-pxe", expectedRevision: 0, changes: { aliases: ["PXE", "快速启动", "静默启动"] }, now: NOW + 2 });
		assert.equal(updated.status, "updated");
		assert.deepEqual(updated.changedFields, ["aliases"]);
		const after = await readRecord({ root: sandbox.root, kind: "feature-record", id: "feat-pxe" });
		assert.deepEqual(after.record.aliases, ["PXE", "快速启动", "静默启动"]);
		assert.equal(after.record.originalRequirement, "客户要求关闭 PXE 以缩短启动时间", "未触达字段必须原样保留");
		assert.equal(after.record.customer.value, "customer-alpha");

		// 用过期 revision 更新 → 不写。
		const conflict = await updateFeature({ root: sandbox.root, featureId: "feat-pxe", expectedRevision: 0, changes: { originalRequirement: "被覆盖" }, now: NOW + 3 });
		assert.equal(conflict.status, "revision-conflict");
		assert.equal((await readRecord({ root: sandbox.root, kind: "feature-record", id: "feat-pxe" })).record.originalRequirement, "客户要求关闭 PXE 以缩短启动时间");

		// 相同内容 → unchanged（不制造无意义的 revision）。
		const unchanged = await updateFeature({ root: sandbox.root, featureId: "feat-pxe", expectedRevision: after.record.revision, changes: { aliases: ["PXE", "快速启动", "静默启动"] }, now: NOW + 4 });
		assert.equal(unchanged.status, "unchanged");
		assert.equal(unchanged.revision, after.record.revision);
	} finally {
		await sandbox.cleanup();
	}
});

test("B1：非法输入与未确认身份都不进【可直接复用】结论", async () => {
	const sandbox = await knowledgeSandbox();
	try {
		// 确认程度必须显式声明（不能靠文本推断）。
		await assert.rejects(createFeature({ root: sandbox.root, feature: featureDraft({ customer: { value: "customer-alpha" } }) }), (error) => String(error.message).includes("candidate") || String(error.message).includes("confirmed"));
		await assert.rejects(createFeature({ root: sandbox.root, feature: featureDraft({ customer: { value: null, status: "confirmed" } }) }), /不能把/);
		await assert.rejects(createFeature({ root: sandbox.root, feature: featureDraft({ relatedExperienceIds: ["exp-a", "exp-a"] }) }), /重复/);
		await assert.rejects(createFeature({ root: sandbox.root, feature: featureDraft({ aliases: ["x".repeat(400)] }) }), /字符上限/);
		await assert.rejects(createFeature({ root: sandbox.root, feature: featureDraft({ acceptanceCriteria: Array.from({ length: 20 }, (_, index) => `c${index}`) }) }), /上限/);
		await assert.rejects(createFeature({ root: sandbox.root, feature: featureDraft({ customer: { value: "c", status: "confirmed", relativePath: "a.txt", contentHash: "short" } }) }), /SHA-256/);

		// 未确认客户 ⇒ 只能作候选参考。
		await createFeature({ root: sandbox.root, feature: featureDraft({ featureId: "feat-unknown", customer: { value: "customer-alpha", status: "candidate" }, productLine: { value: "line-x", status: "candidate" } }), now: NOW });
		const detail = await readFeatureDetail({ root: sandbox.root, featureId: "feat-unknown" });
		assert.equal(detail.status, "ok");
		assert.equal(detail.usableAsReference, false);
		assert.ok(detail.referenceReasons.some((reason) => /客户身份未确认/.test(reason)));
		assert.ok(detail.referenceReasons.some((reason) => /产品线未确认/.test(reason)));

		// 授权可见集合：不在其中的需求连内容都不返回。
		const denied = await readFeatureDetail({ root: sandbox.root, featureId: "feat-unknown", visibility: { allowedFeatureIds: ["feat-other"] } });
		assert.equal(denied.status, "not-authorized");
		assert.equal(denied.feature, null);

		// 关联缺失/不可读显式显示（不补造来源）。
		await createFeature({ root: sandbox.root, feature: featureDraft({ featureId: "feat-link", relatedExperienceIds: ["exp-missing"] }), now: NOW + 1 });
		const linked = await readFeatureDetail({ root: sandbox.root, featureId: "feat-link" });
		assert.equal(linked.links.length, 1);
		assert.equal(linked.links[0].found, false);
		assert.match(linked.links[0].reason, /不存在/);
		assert.equal(linked.usableAsReference, false, "关联无法核对 ⇒ 需求沿革不完整");
	} finally {
		await sandbox.cleanup();
	}
});

/* ------------------------------------------------------------------ 经验与审核 */

test("B2：草稿写入不接受托管字段，reviewed/verified 只能由审核动作产生", async () => {
	const sandbox = await knowledgeSandbox();
	try {
		const source = sandbox.projectA.projectId;
		await assert.rejects(createExperienceDraft({ root: sandbox.root, experience: { ...experienceDraft({ sourceProjectId: source }), status: "verified" } }), /审核状态/);
		await assert.rejects(createExperienceDraft({ root: sandbox.root, experience: { ...experienceDraft({ sourceProjectId: source }), reviewer: "someone" } }), /审核人/);
		await assert.rejects(createExperienceDraft({ root: sandbox.root, experience: experienceDraft({ sourceProjectId: source, reuse: { level: "internal-general" } }) }), /显式授权/);

		const created = await createExperienceDraft({ root: sandbox.root, experience: experienceDraft({ sourceProjectId: source, reuse: { level: "customer", customers: ["customer-alpha"] } }), now: NOW });
		assert.equal(created.status, "created");
		assert.equal(created.status_after, "draft", "新建恒为 draft");

		// 草稿可以改；把 status 塞进 changes 仍被拒绝。
		const updated = await updateExperienceDraft({ root: sandbox.root, experienceId: "exp-pxe", expectedRevision: 0, changes: { solution: "关闭 PXE 默认值并记录变更点" }, now: NOW + 1 });
		assert.equal(updated.status, "updated");
		assert.equal(updated.status_after, "draft");
		await assert.rejects(updateExperienceDraft({ root: sandbox.root, experienceId: "exp-pxe", expectedRevision: 1, changes: { status: "verified" } }), /审核状态/);

		// 审核动作：submit-review → reviewed，并产生真实审计事件。
		const opened = await readExperienceDetail({ root: sandbox.root, experienceId: "exp-pxe" });
		const reviewed = await reviewExperience({ root: sandbox.root, experienceId: "exp-pxe", expectedRevision: opened.revision, action: "submit-review", operatorLabel: "engineer-a", reason: "证据与复现步骤完整", now: NOW + 2 });
		assert.equal(reviewed.status, "applied");
		assert.equal(reviewed.stateAfter, "reviewed");
		assert.equal(reviewed.revision, opened.revision + 1);
		assert.notEqual(reviewed.audit, null, "审核必须留下审计事件");
		assert.equal(reviewed.journal.state, "committed");
		assert.deepEqual(reviewed.needsReview, []);

		// reviewed 之后普通编辑被拒绝（必须先 request-changes）。
		const blocked = await updateExperienceDraft({ root: sandbox.root, experienceId: "exp-pxe", expectedRevision: reviewed.revision, changes: { solution: "偷偷改掉" }, now: NOW + 3 });
		assert.equal(blocked.status, "not-draft");
		assert.ok(blocked.problems.some((problem) => /request-changes/.test(problem)));

		// request-changes → 回到 draft；approve → verified；deprecate → deprecated；restore → draft。
		const back = await reviewExperience({ root: sandbox.root, experienceId: "exp-pxe", expectedRevision: reviewed.revision, action: "request-changes", operatorLabel: "engineer-a", reason: "补充不适用条件", now: NOW + 4 });
		assert.equal(back.stateAfter, "draft");
		const approved = await reviewExperience({ root: sandbox.root, experienceId: "exp-pxe", expectedRevision: back.revision, action: "submit-review", operatorLabel: "engineer-a", reason: "已补充", now: NOW + 5 });
		assert.equal(approved.stateAfter, "reviewed");
		const deprecateAttempt = await reviewExperience({ root: sandbox.root, experienceId: "exp-pxe", expectedRevision: approved.revision, action: "deprecate", operatorLabel: "engineer-a", reason: "被新平台结论取代", now: NOW + 6 });
		assert.equal(deprecateAttempt.stateAfter, "deprecated");
		const restored = await reviewExperience({ root: sandbox.root, experienceId: "exp-pxe", expectedRevision: deprecateAttempt.revision, action: "restore", operatorLabel: "engineer-a", reason: "复核后仍然适用", now: NOW + 7 });
		assert.equal(restored.stateAfter, "draft");

		// 用过期 revision 审核 → 冲突且不写。
		await assert.rejects(reviewExperience({ root: sandbox.root, experienceId: "exp-pxe", expectedRevision: 0, action: "approve", operatorLabel: "x", reason: "y", now: NOW + 8 }), (error) => error.code === "revision-conflict");

		// 验证级别只按实际声明报告（不把编译说成板卡启动）。
		const withCompile = await updateExperienceDraft({
			root: sandbox.root,
			experienceId: "exp-pxe",
			expectedRevision: restored.revision,
			changes: { validations: [{ kind: "compile", scope: "SamplePlatformA", result: "passed", performedAt: NOW, performedBy: "engineer-a" }] },
			now: NOW + 9,
		});
		assert.equal(withCompile.status, "updated");
		const detail = await readExperienceDetail({ root: sandbox.root, experienceId: "exp-pxe" });
		assert.deepEqual(
			detail.card.validations.map((validation) => validation.kind),
			["compile"],
		);
		assert.equal(detail.card.status, "draft", "写验证记录不等于卡已审核");
	} finally {
		await sandbox.cleanup();
	}
});

/* ------------------------------------------------------------------ 检索 */

function searchInput(sandbox, overrides = {}) {
	return {
		root: sandbox.root,
		query: "PXE",
		visibility: { authorizedProjectIds: [sandbox.projectA.projectId] },
		target: { projectId: sandbox.projectB.projectId, customerId: "customer-alpha", boardName: "BoardB", buildTarget: "SamplePlatformB" },
		authorization: { endpointAllowed: true, allowInternalGeneral: false, customers: ["customer-alpha"] },
		...overrides,
	};
}

async function seedReviewedExperience(sandbox, overrides = {}) {
	const created = await createExperienceDraft({
		root: sandbox.root,
		experience: experienceDraft({
			sourceProjectId: sandbox.projectA.projectId,
			reuse: { level: "customer", customers: ["customer-alpha"] },
			...overrides,
		}),
		now: NOW,
	});
	assert.equal(created.status, "created");
	return { created };
}

test("B3：授权先于标题与计数；draft 不作当前推荐；受控操作后可检索", async () => {
	const sandbox = await knowledgeSandbox();
	try {
		await seedReviewedExperience(sandbox);

		// draft：命中但只能作待复核（不是 current）。
		const draftResult = await searchKnowledge(searchInput(sandbox));
		assert.equal(draftResult.hits.length, 1);
		assert.equal(draftResult.hits[0].recordedStatus, "draft");
		assert.equal(draftResult.hits[0].recommendation, "needs-review");
		assert.ok(draftResult.hits[0].reasons.includes("not-reviewed"));

		// 人工审核（submit-review）后重新检索：状态是 reviewed，可作为参考（v1 无时态/快照 ⇒ reference）。
		const opened = await readExperienceDetail({ root: sandbox.root, experienceId: "exp-pxe" });
		await reviewExperience({ root: sandbox.root, experienceId: "exp-pxe", expectedRevision: opened.revision, action: "submit-review", operatorLabel: "engineer-a", reason: "可复用", now: NOW + 1 });
		const reviewed = await searchKnowledge(searchInput(sandbox));
		assert.equal(reviewed.hits[0].recordedStatus, "reviewed");
		assert.equal(reviewed.hits[0].recommendation, "reference", "v1 没有生效区间/依赖快照 ⇒ 只作参考");

		// 未授权来源项目 ⇒ 连 ID、标题、计数都不出现（服务层闸门 + M1 判定两道都关）。
		const denied = await searchKnowledge(searchInput(sandbox, { visibility: { authorizedProjectIds: [] } }));
		assert.equal(denied.hits.length, 0);
		assert.doesNotMatch(JSON.stringify(denied), /exp-pxe/);
		assert.doesNotMatch(JSON.stringify(denied), /PXE 默认开启/, "未授权不得泄漏正文片段");
		// 客户不在授权列表里同样不可见（customer 级复用必须两端都授权）。
		const otherCustomer = await searchKnowledge(searchInput(sandbox, { authorization: { endpointAllowed: true, allowInternalGeneral: false, customers: [] } }));
		assert.equal(otherCustomer.hits.length, 0);
		assert.doesNotMatch(JSON.stringify(otherCustomer), /exp-pxe/);

		// 端点策略：deny ⇒ 不出现；unknown ⇒ 不能是当前结论。
		const endpointDenied = await searchKnowledge(searchInput(sandbox, { authorization: { endpointAllowed: false, allowInternalGeneral: false, customers: ["customer-alpha"] } }));
		assert.equal(endpointDenied.hits.length, 0);
		const endpointUnknown = await searchKnowledge(searchInput(sandbox, { authorization: { endpointAllowed: null, allowInternalGeneral: false, customers: ["customer-alpha"] } }));
		assert.equal(endpointUnknown.hits[0].recommendation, "reference");
		assert.ok(endpointUnknown.hits[0].reasons.includes("endpoint-unknown"));
	} finally {
		await sandbox.cleanup();
	}
});

test("B3：别名匹配、history 与废弃、源变化立即生效（无陈旧推荐）", async () => {
	const sandbox = await knowledgeSandbox();
	try {
		await createFeature({ root: sandbox.root, feature: featureDraft({ aliases: ["PXE", "快速启动", "alias-marker"] }), now: NOW });
		const seeded = await seedReviewedExperience(sandbox);
		assert.equal(seeded.created.status, "created");
		const opened = await readExperienceDetail({ root: sandbox.root, experienceId: "exp-pxe" });

		// 别名检索命中需求（原文里没有出现这个词）。
		const byAlias = await searchKnowledge(searchInput(sandbox, { query: "alias-marker", visibility: { authorizedProjectIds: [sandbox.projectA.projectId], allowedFeatureIds: ["feat-pxe"] }, authorization: { endpointAllowed: true, allowInternalGeneral: true, customers: ["customer-alpha"] } }));
		assert.equal(byAlias.hits.length, 1);
		assert.equal(byAlias.hits[0].family, "feature-record");
		assert.ok(byAlias.hits[0].matchedFields.includes("aliases"));

		// 未显式授权的需求不出现在结果里：客户不在授权列表、也没有显式需求可见范围。
		const featureHidden = await searchKnowledge(searchInput(sandbox, { query: "alias-marker", authorization: { endpointAllowed: true, allowInternalGeneral: true, customers: [] } }));
		assert.equal(featureHidden.hits.length, 0);
		assert.doesNotMatch(JSON.stringify(featureHidden), /feat-pxe/, "未授权需求连 ID 都不能出现");
		// 已确认客户 + 授权客户命中：需求可以按客户级复用被看见。
		const featureByCustomer = await searchKnowledge(searchInput(sandbox, { query: "alias-marker", authorization: { endpointAllowed: true, allowInternalGeneral: false, customers: ["customer-alpha"] } }));
		assert.equal(featureByCustomer.hits.length, 1);
		assert.equal(featureByCustomer.hits[0].recommendation, "reference");

		// 多词 AND 语义：不相关的词组合不命中。
		const andSemantics = await searchKnowledge(searchInput(sandbox, { query: "PXE 不存在的词" }));
		assert.equal(andSemantics.hits.length, 0);

		// 非法状态迁移是**受控的业务拒绝**（不是 io-error）：draft 不能直接 deprecate。
		await assert.rejects(reviewExperience({ root: sandbox.root, experienceId: "exp-pxe", expectedRevision: opened.revision, action: "deprecate", operatorLabel: "engineer-a", reason: "先试一下", now: NOW + 2 }), (error) => error.code === "inconsistent" && /deprecate/.test(error.message));

		// 先 submit-review 到 reviewed，再废弃：废弃后当前检索不再推荐；history 查询可以解释。
		const reviewed = await reviewExperience({ root: sandbox.root, experienceId: "exp-pxe", expectedRevision: opened.revision, action: "submit-review", operatorLabel: "engineer-a", reason: "可参考", now: NOW + 2 });
		const deprecated = await reviewExperience({ root: sandbox.root, experienceId: "exp-pxe", expectedRevision: reviewed.revision, action: "deprecate", operatorLabel: "engineer-a", reason: "新平台已内置修复", now: NOW + 3 });
		assert.equal(deprecated.stateAfter, "deprecated");
		const current = await searchKnowledge(searchInput(sandbox));
		const currentExperience = current.hits.find((hit) => hit.recordId === "exp-pxe");
		assert.equal(currentExperience.recommendation, "excluded", "废弃后不得进入当前推荐");
		assert.ok(currentExperience.reasons.includes("deprecated"));
		const history = await searchKnowledge(searchInput(sandbox, { intent: "history" }));
		const historyExperience = history.hits.find((hit) => hit.recordId === "exp-pxe");
		assert.equal(historyExperience.recommendation, "history");
		assert.ok(historyExperience.reasons.includes("history-record"), "显式 history 查询可以解释废弃记录");
		assert.equal(historyExperience.recordedStatus, "deprecated");

		// 源变化立即生效：把卡改回 draft（request-changes 后再改内容）⇒ 立刻回到"待复核"。
		const back = await reviewExperience({ root: sandbox.root, experienceId: "exp-pxe", expectedRevision: deprecated.revision, action: "restore", operatorLabel: "engineer-a", reason: "复核", now: NOW + 3 });
		const rewrite = await updateExperienceDraft({ root: sandbox.root, experienceId: "exp-pxe", expectedRevision: back.revision, changes: { solution: "改成完全不同的做法" }, now: NOW + 4 });
		assert.equal(rewrite.status, "updated");
		const afterRewrite = await searchKnowledge(searchInput(sandbox));
		const rewritten = afterRewrite.hits.find((hit) => hit.recordId === "exp-pxe");
		assert.equal(rewritten.recordedStatus, "draft");
		assert.equal(rewritten.recommendation, "needs-review", "没有任何缓存能让旧结论继续存在");
		assert.ok(rewritten.reasons.includes("not-reviewed"));

		// 记录被外部删除 ⇒ 检索不再推荐它（无缓存 ⇒ 不会继续用旧内容）。
		const { rm: remove } = await import("node:fs/promises");
		await remove(join(sandbox.root, "experiences", "exp-pxe.json"));
		const removed = await searchKnowledge(searchInput(sandbox));
		assert.equal(
			removed.hits.some((hit) => hit.recordId === "exp-pxe"),
			false,
			"源已删除就不能继续推荐",
		);

		// 文件存在但内容坏掉 ⇒ 进入有界诊断并把整体标成不完整（"没看到"不等于"没有"）。
		await writeFile(join(sandbox.root, "experiences", "exp-pxe.json"), "{ broken");
		const broken = await searchKnowledge(searchInput(sandbox));
		assert.ok(
			broken.problems.some((problem) => /exp-pxe/.test(problem)),
			`坏条目必须进入有界诊断：${JSON.stringify(broken.problems)}`,
		);
		assert.equal(broken.status, "incomplete");
	} finally {
		await sandbox.cleanup();
	}
});

test("B3：预算（扫描/返回/片段/取消）与跨项目参考详情", async () => {
	const sandbox = await knowledgeSandbox();
	try {
		// 造 3 条命中的经验，验证返回上限。
		for (const index of [1, 2, 3]) {
			await createExperienceDraft({ root: sandbox.root, experience: experienceDraft({ experienceId: `exp-${index}`, sourceProjectId: sandbox.projectA.projectId, reuse: { level: "customer", customers: ["customer-alpha"] }, problem: `PXE 问题 ${index}` }), now: NOW + index });
		}
		const limited = await searchKnowledge(searchInput(sandbox, { limits: { maxSearchResults: 1 } }));
		assert.equal(limited.hits.length, 1);
		assert.ok(limited.matchedButDropped >= 1, "被结果上限截断的命中最少 1 条");
		assert.equal(limited.status, "incomplete");

		const scanLimited = await searchKnowledge(searchInput(sandbox, { limits: { maxScanRecords: 1 } }));
		assert.equal(scanLimited.status, "incomplete");
		assert.ok(scanLimited.scanned.recordsSkipped >= 1, "未读取的记录必须显式计数");

		// 取消：立即失败，不返回半份结果。
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(searchKnowledge(searchInput(sandbox, { signal: controller.signal })), (error) => error.code === "cancelled");

		// 跨项目参考详情：来源项目 / 声明的验证级别 / 移植口径都要显式。
		const seeded = await createExperienceDraft({
			root: sandbox.root,
			experience: experienceDraft({ experienceId: "exp-ref", sourceProjectId: sandbox.projectA.projectId, reuse: { level: "customer", customers: ["customer-alpha"] }, validations: [{ kind: "board-boot", scope: "BoardA", result: "passed", performedAt: NOW, performedBy: "engineer-a" }] }),
			now: NOW + 10,
		});
		const opened = await readExperienceDetail({ root: sandbox.root, experienceId: "exp-ref" });
		await reviewExperience({ root: sandbox.root, experienceId: "exp-ref", expectedRevision: opened.revision, action: "submit-review", operatorLabel: "engineer-a", reason: "可参考", now: NOW + 11 });

		const reference = await readExperienceReference({
			root: sandbox.root,
			experienceId: "exp-ref",
			targetProjectId: sandbox.projectB.projectId,
			targetCustomerId: "customer-alpha",
			authorization: { endpointAllowed: true, allowInternalGeneral: false, customers: ["customer-alpha"], authorizedProjectIds: [sandbox.projectA.projectId] },
			now: NOW + 12,
		});
		assert.equal(reference.status, "ok");
		assert.equal(reference.reference.sourceProjectId, sandbox.projectA.projectId);
		assert.deepEqual(
			reference.reference.declaredValidations.map((validation) => validation.kind),
			["board-boot"],
		);
		assert.equal(reference.porting.referenceOnly, true);
		assert.equal(reference.porting.needsPortingReview, true);
		assert.ok(reference.porting.reasons.some((reason) => /移植参考/.test(reason)));
		assert.ok(reference.porting.reasons.some((reason) => /目标项目不同/.test(reason)));

		// 未授权 ⇒ 连内容都不展示（来源项目没被授权、客户也不在授权列表里）。
		const denied = await readExperienceReference({ root: sandbox.root, experienceId: "exp-ref", targetProjectId: sandbox.projectB.projectId, targetCustomerId: "customer-beta", authorization: { endpointAllowed: true, allowInternalGeneral: false, customers: [] }, now: NOW + 13 });
		assert.equal(denied.status, "not-recommended");
		assert.equal(denied.reference, null);
		assert.doesNotMatch(JSON.stringify(denied), /PXE 默认开启/);
		// 来源项目未列入授权范围时不展示内容（即使客户匹配）。
		const wrongProject = await readExperienceReference({
			root: sandbox.root,
			experienceId: "exp-ref",
			targetProjectId: sandbox.projectB.projectId,
			targetCustomerId: "customer-alpha",
			authorization: { endpointAllowed: true, allowInternalGeneral: false, customers: ["customer-alpha"], authorizedProjectIds: [sandbox.projectB.projectId] },
			now: NOW + 14,
		});
		assert.equal(wrongProject.status, "not-recommended");
		assert.equal(wrongProject.reference, null);
		assert.match(wrongProject.porting.reasons[0], /来源项目不在授权范围内/);
	} finally {
		await sandbox.cleanup();
	}
});

test("B3：不可读记录进入计数与有界诊断（不当作没命中）", async () => {
	const sandbox = await knowledgeSandbox();
	try {
		await seedReviewedExperience(sandbox);
		// 放一个坏 JSON：目录里有它，但读不出来（列表阶段就会报问题）。
		await writeFile(join(sandbox.root, "experiences", "exp-broken.json"), "{ this is not json");
		const result = await searchKnowledge(searchInput(sandbox));
		assert.ok(
			result.problems.some((problem) => /exp-broken/.test(problem)),
			`坏条目必须进入有界诊断：${JSON.stringify(result.problems)}`,
		);
		assert.equal(result.status, "incomplete", "有读不出来的记录就不能说检索完整");
		assert.equal(result.hits.length, 1, "坏条目不能被当成命中，也不能拖走好条目");
		const registry = await readRegistry({ root: sandbox.root });
		assert.equal(registry.projects.length, 2, "检索不得改动 registry");
	} finally {
		await sandbox.cleanup();
	}
});
