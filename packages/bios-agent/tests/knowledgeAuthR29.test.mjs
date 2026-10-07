/**
 * R29-1 / R29-2 / R29-3 永久回归：知识公共入口的**授权、来源存在性与字段闭环**。
 *
 * 每组都先复现 round29_acceptance.md §4 的实际观察，再断言修复后的受控结果：
 * - A1：公开入口缺省拒绝、来源项目必须存在且显式授权、空授权不扫描不泄漏；
 * - A2：别名命中有界关联经验、单字段（symptom）更新、同值/证据变更、顶层证据；
 * - A3：取消穿透、真实额度记账、空候选也汇总不完整。
 *
 * 全部使用自建临时知识库与合成内容；不读任何真实客户资料。
 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { initializeKnowledgeStore } from "../core/storage/index.ts";
import { bindProjectWorkspace } from "../core/projects/index.ts";
import { createExperienceDraft, createFeature, listFeatureIds, readExperienceDetail, readExperienceReference, readFeatureDetail, reviewExperience, searchKnowledge, updateExperienceDraft, updateFeature } from "../core/knowledge/index.ts";
import { createProjectSandbox, writeDsc } from "./helpers/projectFixtures.mjs";

const NOW = 1_700_000_000_000;
const MISSING_PROJECT = "11111111-2222-4333-8444-555555555555";

async function sandbox() {
	const sb = await createProjectSandbox("bm05-r29-");
	await initializeKnowledgeStore({ root: sb.root, now: NOW });
	await writeDsc(sb.workspaceA, "Platform/SamplePkg/Sample.dsc", { platformName: "SamplePlatformA" });
	await writeDsc(sb.workspaceB, "Platform/SamplePkg/Sample.dsc", { platformName: "SamplePlatformB" });
	const projectA = await bindProjectWorkspace({ root: sb.root, cwd: sb.workspaceA, authorizedRoots: [sb.workspaceA, sb.workspaceB], workspacePath: sb.workspaceA, now: NOW });
	const projectB = await bindProjectWorkspace({ root: sb.root, cwd: sb.workspaceB, authorizedRoots: [sb.workspaceA, sb.workspaceB], workspacePath: sb.workspaceB, now: NOW });
	return { ...sb, projectA, projectB };
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
	return { experienceId: "exp-pxe", problem: "PXE 默认开启导致启动变慢", rootCause: "平台默认值未关闭 PXE", solution: "在平台 DSC 里关闭 PXE 默认值", appliesWhen: ["客户要求快速启动"], doesNotApplyWhen: [], ...overrides };
}

function searchInput(sb, overrides = {}) {
	return {
		root: sb.root,
		query: "PXE",
		visibility: { authorizedProjectIds: [sb.projectA.projectId] },
		target: { projectId: sb.projectB.projectId, customerId: "customer-alpha" },
		authorization: { endpointAllowed: true, allowInternalGeneral: false, customers: ["customer-alpha"] },
		...overrides,
	};
}

/* ------------------------------------------------------------------ A1 */

test("R29-1：公开详情/列表缺省即拒绝（省略 visibility 不再读取全部内容）", async () => {
	const sb = await sandbox();
	try {
		await createFeature({ root: sb.root, feature: featureDraft(), now: NOW });

		// 详情：省略 visibility ⇒ not-authorized，且不返回任何内容（连 revision 都不给）。
		const detail = await readFeatureDetail({ root: sb.root, featureId: "feat-pxe" });
		assert.equal(detail.status, "not-authorized");
		assert.equal(detail.feature, null);
		assert.equal(detail.revision, null);

		// 给了授权 ID 才可读。
		const authorized = await readFeatureDetail({ root: sb.root, featureId: "feat-pxe", visibility: { allowedFeatureIds: ["feat-pxe"] } });
		assert.equal(authorized.status, "ok");
		assert.equal(authorized.feature?.originalRequirement, "客户要求关闭 PXE 以缩短启动时间");

		// 列表：缺省拒绝 ⇒ 不枚举任何 ID；给授权才返回。
		assert.deepEqual((await listFeatureIds({ root: sb.root })).ids, []);
		assert.deepEqual((await listFeatureIds({ root: sb.root, visibility: { allowedFeatureIds: [] } })).ids, []);
		assert.deepEqual((await listFeatureIds({ root: sb.root, visibility: { allowedFeatureIds: ["feat-pxe"] } })).ids, ["feat-pxe"]);
	} finally {
		await sb.cleanup();
	}
});

test("R29-1：经验详情缺省拒绝；来源项目必须存在且显式授权（拒绝写入不留卡片）", async () => {
	const sb = await sandbox();
	try {
		// 不存在的来源项目（合法 UUID）⇒ 拒绝写入，磁盘上没有卡片。
		// 授权闸门先过（显式声明允许该 UUID），再核对 registry 里的存在性。
		await assert.rejects(createExperienceDraft({ root: sb.root, authorizedProjectIds: [MISSING_PROJECT], experience: experienceDraft({ sourceProjectId: MISSING_PROJECT }) }), /registry/);
		// 缺省授权也拒绝（R30-1）：不读 registry、不留卡片。
		await assert.rejects(createExperienceDraft({ root: sb.root, experience: experienceDraft({ sourceProjectId: sb.projectA.projectId }) }), (error) => error.code === "not-authorized");
		const missing = await readExperienceDetail({ root: sb.root, experienceId: "exp-pxe", authorizedProjectIds: [sb.projectA.projectId] });
		assert.equal(missing.status, "not-found");

		// 来源项目存在但未在授权集合里 ⇒ 受控拒绝。
		await assert.rejects(createExperienceDraft({ root: sb.root, experience: experienceDraft({ sourceProjectId: sb.projectA.projectId }), authorizedProjectIds: [sb.projectB.projectId] }), (error) => error.code === "not-authorized");
		const stillMissing = await readExperienceDetail({ root: sb.root, experienceId: "exp-pxe", authorizedProjectIds: [sb.projectA.projectId] });
		assert.equal(stillMissing.status, "not-found", "拒绝写入不能留下卡片");

		// 正常写入：来源项目显式授权。
		const created = await createExperienceDraft({ root: sb.root, authorizedProjectIds: [sb.projectA.projectId], experience: experienceDraft({ sourceProjectId: sb.projectA.projectId }), now: NOW });
		assert.equal(created.status, "created");

		// 详情缺省拒绝；给错来源项目拒绝；给对才可读。
		assert.equal((await readExperienceDetail({ root: sb.root, experienceId: "exp-pxe" })).status, "not-authorized");
		assert.equal((await readExperienceDetail({ root: sb.root, experienceId: "exp-pxe", authorizedProjectIds: [sb.projectB.projectId] })).status, "not-authorized");
		assert.equal((await readExperienceDetail({ root: sb.root, experienceId: "exp-pxe", authorizedProjectIds: [sb.projectA.projectId] })).status, "ok");
	} finally {
		await sb.cleanup();
	}
});

test("R29-1：证据的工作区必须属于来源项目；空授权检索不扫描、不泄漏 ID/路径", async () => {
	const sb = await sandbox();
	try {
		const foreignWorkspace = "99999999-8888-4777-8666-555555555555";
		await assert.rejects(
			createExperienceDraft({
				root: sb.root,
				authorizedProjectIds: [sb.projectA.projectId],
				experience: experienceDraft({ sourceProjectId: sb.projectA.projectId, evidence: [{ type: "source-file", relativePath: "Platform/SamplePkg/Sample.dsc", contentHash: "0".repeat(64), workspaceId: foreignWorkspace }] }),
			}),
			/不属于来源项目/,
		);

		await createFeature({ root: sb.root, feature: featureDraft(), now: NOW });
		// 一个损坏的、且**未授权**的 Feature 文件。
		await writeFile(join(sb.root, "features", "feat-broken.json"), "{ broken");

		// 空授权（项目、需求 ID、客户三者都没有）：不读取任何记录（scanned 全零、problems 为空、不泄漏）。
		const denied = await searchKnowledge(searchInput(sb, { visibility: { authorizedProjectIds: [] }, authorization: { endpointAllowed: true, allowInternalGeneral: false, customers: [] } }));
		assert.equal(denied.hits.length, 0);
		assert.deepEqual(denied.scanned, { experiences: 0, features: 0, recordsRead: 0, recordsSkipped: 0, bytesRead: 0 });
		assert.deepEqual(denied.problems, []);
		assert.doesNotMatch(JSON.stringify(denied), /feat-broken|feat-pxe/);

		// 有需求授权但授权 ID 不含损坏记录：诊断不得回显 ID 与绝对路径。
		const authorized = await searchKnowledge(searchInput(sb, { visibility: { authorizedProjectIds: [sb.projectA.projectId], allowedFeatureIds: ["feat-pxe"] } }));
		assert.ok(authorized.problems.length > 0, "损坏条目必须进入有界诊断");
		for (const problem of authorized.problems) {
			assert.doesNotMatch(problem, /feat-broken/, "未授权条目的 ID 不得回显");
			assert.doesNotMatch(problem, /[A-Za-z]:\\|knowledge|features\\/, "诊断不得回显绝对路径或目录结构");
		}
	} finally {
		await sb.cleanup();
	}
});

/* ------------------------------------------------------------------ A2 */

test("R29-2：别名命中经有界关联扩展找回经验；单字段更新与同值/证据变更正确", async () => {
	const sb = await sandbox();
	try {
		await createFeature({ root: sb.root, feature: featureDraft({ featureId: "feat-alias", aliases: ["RapidBootOnlyAlias"], relatedExperienceIds: ["exp-linked"] }), now: NOW });
		// 关联经验：正文里**不含**别名。
		const created = await createExperienceDraft({
			root: sb.root,
			authorizedProjectIds: [sb.projectA.projectId],
			experience: experienceDraft({ experienceId: "exp-linked", problem: "静默启动时平台仍尝试网络引导", rootCause: "默认值", solution: "关闭默认值", sourceProjectId: sb.projectA.projectId, reuse: { level: "customer", customers: ["customer-alpha"] } }),
			now: NOW,
		});
		await reviewExperience({ root: sb.root, authorizedProjectIds: [sb.projectA.projectId], experienceId: "exp-linked", expectedRevision: created.revision, action: "submit-review", operatorLabel: "engineer", reason: "可复用", now: NOW + 1 });

		const byAlias = await searchKnowledge(searchInput(sb, { query: "RapidBootOnlyAlias", visibility: { authorizedProjectIds: [sb.projectA.projectId], allowedFeatureIds: ["feat-alias"] } }));
		const featureHit = byAlias.hits.find((hit) => hit.recordId === "feat-alias");
		const linkedHit = byAlias.hits.find((hit) => hit.recordId === "exp-linked");
		assert.equal(byAlias.status, "ok");
		assert.ok(featureHit !== undefined, "需求必须按别名命中");
		assert.ok(linkedHit !== undefined, "关联经验必须被有界扩展找回");
		assert.ok(linkedHit.matchedFields.includes("relatedExperienceIds"));

		// 审核后普通编辑被拒（必须先 request-changes 回 draft）。
		const before = await readExperienceDetail({ root: sb.root, experienceId: "exp-linked", authorizedProjectIds: [sb.projectA.projectId] });
		const blocked = await updateExperienceDraft({ root: sb.root, authorizedProjectIds: [sb.projectA.projectId], experienceId: "exp-linked", expectedRevision: before.revision, authorizedProjectIds: [sb.projectA.projectId], changes: { symptom: "偷偷改" }, now: NOW + 2 });
		assert.equal(blocked.status, "not-draft");

		const back = await reviewExperience({ root: sb.root, authorizedProjectIds: [sb.projectA.projectId], experienceId: "exp-linked", expectedRevision: before.revision, action: "request-changes", operatorLabel: "engineer", reason: "补充症状", now: NOW + 3 });
		assert.equal(back.stateAfter, "draft");

		// 单字段更新：changedFields 必须准确，磁盘真的变了。
		const updated = await updateExperienceDraft({ root: sb.root, authorizedProjectIds: [sb.projectA.projectId], experienceId: "exp-linked", expectedRevision: back.revision, authorizedProjectIds: [sb.projectA.projectId], changes: { solution: "关闭默认值并记录变更点" }, now: NOW + 4 });
		assert.deepEqual(updated.changedFields, ["solution"]);
		assert.equal(updated.revision, back.revision + 1);
		const withSymptom = await updateExperienceDraft({ root: sb.root, authorizedProjectIds: [sb.projectA.projectId], experienceId: "exp-linked", expectedRevision: updated.revision, authorizedProjectIds: [sb.projectA.projectId], changes: { symptom: "开机自检阶段出现网络重试" }, now: NOW + 5 });
		assert.deepEqual(withSymptom.changedFields, ["symptom"], "symptom-only 更新必须被记账（旧缺陷：赋了值但不进 changedFields ⇒ 直接返回 unchanged）");
		assert.equal((await readExperienceDetail({ root: sb.root, experienceId: "exp-linked", authorizedProjectIds: [sb.projectA.projectId] })).card?.symptom, "开机自检阶段出现网络重试");

		// 同值更新 ⇒ unchanged（不制造无意义 revision）。
		const same = await updateExperienceDraft({ root: sb.root, authorizedProjectIds: [sb.projectA.projectId], experienceId: "exp-linked", expectedRevision: withSymptom.revision, authorizedProjectIds: [sb.projectA.projectId], changes: { symptom: "开机自检阶段出现网络重试" }, now: NOW + 6 });
		assert.equal(same.status, "unchanged");
		assert.equal(same.revision, withSymptom.revision);

		// 需求字段：同值同确认程度但带**新证据** ⇒ 必须算变更。
		const featureBefore = await readFeatureDetail({ root: sb.root, featureId: "feat-alias", visibility: { allowedFeatureIds: ["feat-alias"] } });
		const evidenceOnly = await updateFeature({ root: sb.root, featureId: "feat-alias", expectedRevision: featureBefore.revision ?? 0, changes: { customer: { value: "customer-alpha", status: "confirmed", relativePath: "Platform/SamplePkg/Sample.dsc", contentHash: "a".repeat(64) } }, now: NOW + 6 });
		assert.deepEqual(evidenceOnly.changedFields, ["customer"]);
		const sameAgain = await updateFeature({ root: sb.root, featureId: "feat-alias", expectedRevision: evidenceOnly.revision ?? 0, changes: { customer: { value: "customer-alpha", status: "confirmed", relativePath: "Platform/SamplePkg/Sample.dsc", contentHash: "a".repeat(64) } }, now: NOW + 7 });
		assert.equal(sameAgain.status, "unchanged", "同一份证据不能反复制造 revision");

		// 顶层证据：创建时保存、未知键拒绝。
		const withEvidence = await createExperienceDraft({
			root: sb.root,
			authorizedProjectIds: [sb.projectA.projectId],
			experience: experienceDraft({
				experienceId: "exp-evidence",
				sourceProjectId: sb.projectA.projectId,
				evidence: [
					{ type: "source-file", relativePath: "Platform/SamplePkg/Sample.dsc", contentHash: "b".repeat(64) },
					{ type: "commit", commit: "deadbeef" },
				],
			}),
			now: NOW + 8,
		});
		assert.equal(withEvidence.status, "created");
		const evidenceDetail = await readExperienceDetail({ root: sb.root, experienceId: "exp-evidence", authorizedProjectIds: [sb.projectA.projectId] });
		assert.equal(evidenceDetail.card?.evidence.length, 2);
		await assert.rejects(
			createExperienceDraft({ root: sb.root, authorizedProjectIds: [sb.projectA.projectId], experience: { ...experienceDraft({ experienceId: "exp-bad", sourceProjectId: sb.projectA.projectId }), evidence: [{ type: "source-file", relativePath: "a.txt", contentHash: "c".repeat(64), comment: "拼错的字段" }] } }),
			/未知字段/,
		);
	} finally {
		await sb.cleanup();
	}
});

test("R29-2：参考详情补齐来源证据闭环（证据、commit 未知、关联需求原文）", async () => {
	const sb = await sandbox();
	try {
		await createFeature({ root: sb.root, feature: featureDraft({ featureId: "feat-ref", aliases: ["alias-ref"] }), now: NOW });
		const created = await createExperienceDraft({
			root: sb.root,
			authorizedProjectIds: [sb.projectA.projectId],
			experience: experienceDraft({ experienceId: "exp-ref", sourceProjectId: sb.projectA.projectId, featureId: "feat-ref", reuse: { level: "customer", customers: ["customer-alpha"] }, evidence: [{ type: "commit", commit: "cafe1234" }] }),
			now: NOW,
		});
		await reviewExperience({ root: sb.root, authorizedProjectIds: [sb.projectA.projectId], experienceId: "exp-ref", expectedRevision: created.revision, action: "submit-review", operatorLabel: "engineer", reason: "可参考", now: NOW + 1 });

		const reference = await readExperienceReference({
			root: sb.root,
			experienceId: "exp-ref",
			targetProjectId: sb.projectB.projectId,
			targetCustomerId: "customer-alpha",
			authorization: { endpointAllowed: true, allowInternalGeneral: false, customers: ["customer-alpha"], authorizedProjectIds: [sb.projectA.projectId] },
			allowedFeatureIds: ["feat-ref"],
			now: NOW + 2,
		});
		assert.equal(reference.status, "ok");
		assert.equal(reference.reference?.evidence.length, 1);
		assert.equal(reference.reference?.sourceCommit, "cafe1234", "有合法 EvidenceRef 时展示来源 commit");
		assert.equal(reference.reference?.feature?.originalRequirement, "客户要求关闭 PXE 以缩短启动时间");
		assert.deepEqual(reference.reference?.feature?.acceptanceCriteria, ["开机不再尝试 PXE 引导"]);

		// 没有显式授权关联需求 ⇒ 不展示需求正文，并说明原因（不推断）。
		const withoutFeatureAuth = await readExperienceReference({
			root: sb.root,
			experienceId: "exp-ref",
			targetProjectId: sb.projectB.projectId,
			targetCustomerId: "customer-alpha",
			authorization: { endpointAllowed: true, allowInternalGeneral: false, customers: ["customer-alpha"], authorizedProjectIds: [sb.projectA.projectId] },
			now: NOW + 3,
		});
		assert.equal(withoutFeatureAuth.reference?.feature, null);
		assert.ok(withoutFeatureAuth.problems.some((problem) => /未在显式授权范围内/.test(problem)));
	} finally {
		await sb.cleanup();
	}
});

/* ------------------------------------------------------------------ A3 */

test("R29-3：扫描额度计入目录列举的正文读取；空候选也汇总不完整；取消穿透", async () => {
	const sb = await sandbox();
	try {
		for (const index of [1, 2, 3]) {
			await createExperienceDraft({ root: sb.root, authorizedProjectIds: [sb.projectA.projectId], experience: experienceDraft({ experienceId: `exp-${index}`, problem: `PXE 问题 ${index}`, sourceProjectId: sb.projectA.projectId }), now: NOW + index });
		}
		// R30-3：前置列举必须**服从剩余额度**——预算 1 时最多读取 1 条正文，剩下的计入 skipped，
		// 不能"先超额读 3 条、事后再记账"。
		const tiny = await searchKnowledge(searchInput(sb, { limits: { maxScanRecords: 1 } }));
		assert.equal(tiny.scanned.recordsRead, 1, "前置列举不得超过剩余额度");
		assert.ok(tiny.scanned.recordsSkipped >= 1, "超出预算的条目必须显式计数");
		assert.ok(tiny.scanned.bytesRead > 0, "实际读取字节必须如实记账");
		assert.equal(tiny.status, "incomplete");

		// 空候选分支：坏文件也必须汇总成 incomplete（"没看到"不等于"没有"）。
		await writeFile(join(sb.root, "features", "feat-broken2.json"), "{ broken");
		const noCandidate = await searchKnowledge(searchInput(sb, { query: "完全不存在的关键词", visibility: { authorizedProjectIds: [sb.projectA.projectId], allowedFeatureIds: ["feat-broken2"] } }));
		assert.equal(noCandidate.hits.length, 0);
		assert.equal(noCandidate.status, "incomplete");
		assert.ok(noCandidate.problems.length > 0);

		// 取消：立即失败，不返回半份结果。
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(searchKnowledge(searchInput(sb, { signal: controller.signal })), (error) => error.code === "cancelled");
	} finally {
		await sb.cleanup();
	}
});
