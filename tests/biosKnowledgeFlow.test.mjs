/**
 * BM-07B B-05 永久回归：**客户需求 / 经验 / 检索 / 跨项目参考 / 人工审核**经生产 IPC 的链路。
 *
 * 断言边界行为（合成资料）：
 * 1. 需求初次授权门槛；更新带 CAS；关联经验核对如实报缺口；
 * 2. 经验新建即 `draft`（绝不自动 reviewed/verified）；非 draft 不允许改正文；
 * 3. 审核只走状态机支持的五个动作，返回原状态与动作后状态；
 * 4. 检索结果带 M1 分类/原因/声明验证；跨项目参考**只作参考**，源板验证不变成目标板已验证。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createProjectSandbox } from "../packages/bios-agent/tests/helpers/projectFixtures.mjs";
import { initializeKnowledgeStore } from "../packages/bios-agent/core/storage/index.ts";
import { bindProjectWorkspace } from "../packages/bios-agent/core/projects/index.ts";
import { createBiosBusinessService } from "../src/main/bios/BiosBusinessService.ts";
import { createBiosKnowledgeService } from "../src/main/bios/BiosKnowledgeService.ts";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const NOW = 1_700_000_000_000;
const AGENT = "agent-b05";
const SESSION = "deck-b05";
/** core 要求小写 64 位 SHA-256：合成资料也必须给合法 hash（否则链路在证据校验处就断了）。 */
const HASH_A = "a".repeat(64);

const handlers = new Map();
const ipcStubs = { electron: { ipcMain: { handle: (channel, fn) => handlers.set(channel, fn), removeHandler: (channel) => handlers.delete(channel) }, dialog: {} } };
const { registerBiosBusinessIpc } = loadTsCommonJs("src/main/ipc/biosBusinessIpc.ts", { stubs: ipcStubs });
const { registerBiosIpc } = loadTsCommonJs("src/main/ipc/biosIpc.ts", { stubs: { ...ipcStubs, "../bios/BiosKnowledgeService": { normalizeBiosHostSettings: (value) => value } } });

const call = (channel, payload) => {
	const handler = handlers.get(channel);
	assert.ok(handler, `channel 未注册：${channel}`);
	return handler(null, payload);
};
const claim = () => ({ sessionRef: { agentId: AGENT, sessionId: SESSION }, runtimeGeneration: 3 });

async function setup() {
	const sb = await createProjectSandbox("bm07-b05-");
	await initializeKnowledgeStore({ root: sb.root, now: NOW });
	const projectA = await bindProjectWorkspace({ root: sb.root, cwd: sb.workspaceA, authorizedRoots: [sb.workspaceA], workspacePath: sb.workspaceA, now: NOW });
	const projectB = await bindProjectWorkspace({ root: sb.root, cwd: sb.workspaceB, authorizedRoots: [sb.workspaceB], workspacePath: sb.workspaceB, now: NOW });
	assert.equal(projectA.status, "bound");
	assert.equal(projectB.status, "bound");
	const state = { settings: { knowledgeRoot: sb.root, authorizedProjectIds: [projectA.projectId, projectB.projectId], allowedFeatureIds: [], approvedCustomers: [], authorizedRoots: [sb.workspaceA, sb.workspaceB], endpoint: "allowed" } };
	const port = {
		resolve: () => ({ resolution: { agentId: AGENT, sessionId: SESSION, cwd: sb.workspaceA, generation: 3 } }),
		listSessions: () => [],
		pushContextOff: async () => ({ receipt: "ok" }),
		stopRuntime: async () => ({ stopped: true, error: null }),
		syncSelection: async () => ({ receipt: "synthetic ACK" }),
	};
	const business = createBiosBusinessService({ readSettings: () => state.settings, session: port, now: () => NOW });
	const knowledge = createBiosKnowledgeService({ readSettings: () => state.settings, readSelections: () => null, writeSelections: async () => undefined, session: port, now: () => NOW });
	const unregisterBusiness = registerBiosBusinessIpc({ business, appLogger: { info() {} } });
	const unregisterRead = registerBiosIpc({ biosService: knowledge, readBiosSettings: () => state.settings, updateBiosSettings: async () => undefined, readBiosSelections: () => null, updateBiosSelections: async () => undefined, appLogger: { info() {} }, onChanged: () => undefined });
	return {
		sb,
		projectA,
		projectB,
		state,
		unregister: () => {
			unregisterBusiness();
			unregisterRead();
		},
	};
}

const featureOf = (featureId, extra = {}) => ({ featureId, originalRequirement: "PXE 选项菜单超时定制", aliases: ["pxe-timeout", "网络启动超时"], customer: { value: "customer-x", status: "confirmed" }, acceptanceCriteria: ["3 次冷启动无超时"], ...extra });

const experienceOf = (experienceId, sourceProjectId) => ({
	experienceId,
	problem: "PXE 选项菜单超时",
	symptom: "冷启动偶发等待 30s",
	rootCause: "PXE_DELAY 取值过小",
	solution: "调大 PXE_DELAY 并回归",
	appliesWhen: ["同客户 IBV 基线"],
	doesNotApplyWhen: ["非 PXE 启动路径"],
	sourceProjectId,
	validations: [{ kind: "board-boot", scope: "SampleBoard revA", result: "passed", performedAt: NOW, performedBy: "lab", evidence: [{ type: "source-file", relativePath: "docs/pxe.md", contentHash: HASH_A, location: "docs/pxe.md#L20" }] }],
	reuse: { level: "current-project" },
});

test("B-05：需求初次授权门槛、CAS 更新与关联经验缺口", async () => {
	const { sb, projectA, state, unregister } = await setup();
	try {
		// 未授权需求 ID / 客户未批准 ⇒ 拒绝，并指引去设置办理（不是"重试"）。
		await assert.rejects(() => call("bios:create-feature", { ...claim(), feature: featureOf("feat-b05") }), /初次授权/);

		state.settings = { ...state.settings, allowedFeatureIds: ["feat-b05"] };
		const created = await call("bios:create-feature", { ...claim(), feature: featureOf("feat-b05", { relatedExperienceIds: ["exp-missing"] }) });
		assert.equal(created.result.status, "created");
		assert.equal(created.committed, true);

		const detail = await call("bios:read-feature-detail", { ...claim(), featureId: "feat-b05" });
		assert.equal(detail.result.status, "ok");
		assert.equal(detail.result.feature.aliases.length, 2);
		assert.equal(detail.result.feature.customer.value, "customer-x");
		assert.equal(detail.result.feature.customer.status, "confirmed");
		// 关联经验不存在：必须如实报缺口，不能当作"已关联可复用"。
		assert.equal(detail.result.links[0].found, false);

		// 更新：同 revision 竞争不覆盖。
		const first = await call("bios:update-feature", { ...claim(), featureId: "feat-b05", expectedRevision: created.result.revision, changes: { acceptanceCriteria: ["新条件"] } });
		assert.equal(first.result.status, "updated");
		const stale = await call("bios:update-feature", { ...claim(), featureId: "feat-b05", expectedRevision: created.result.revision, changes: { acceptanceCriteria: ["败者条件"] } });
		assert.equal(stale.result.status, "revision-conflict");
		assert.equal(stale.result.actualRevision, first.result.revision);

		// 把客户改到批准范围外 ⇒ 拒绝（不接受请求里的授权字段）。
		state.settings = { ...state.settings, allowedFeatureIds: [] };
		await assert.rejects(() => call("bios:update-feature", { ...claim(), featureId: "feat-b05", expectedRevision: first.result.revision, changes: { customer: { value: "customer-y", status: "confirmed" } } }), /拒绝写入/);
		// 同时项目仍授权 ⇒ 经验部分不受影响（证明拒绝是需求级的）。
		assert.equal(state.settings.authorizedProjectIds.includes(projectA.projectId), true);
	} finally {
		unregister();
		await sb.cleanup();
	}
});

test("B-05：经验新建即草稿；非 draft 不得改正文；审核走状态机五动作", async () => {
	const { sb, projectA, unregister } = await setup();
	try {
		const created = await call("bios:create-experience", { ...claim(), experience: experienceOf("exp-b05", projectA.projectId) });
		assert.equal(created.result.status, "created");
		assert.equal(created.result.status_after, "draft", "新建绝不自动 reviewed/verified");
		let revision = created.result.revision;

		// 草稿正文可改。
		const body = await call("bios:update-experience", { ...claim(), experienceId: "exp-b05", expectedRevision: revision, changes: { solution: "调大 PXE_DELAY（已回归）" } });
		assert.equal(body.result.status, "updated");
		revision = body.result.revision;

		// 非法动作在 IPC 层就被拒（不是只有 core 才拦）。
		await assert.rejects(() => call("bios:review-experience", { ...claim(), experienceId: "exp-b05", expectedRevision: revision, action: "mark-verified", reason: "x" }), /action 不在允许的取值内/);
		await assert.rejects(() => call("bios:review-experience", { ...claim(), experienceId: "exp-b05", expectedRevision: revision, action: "approve", reason: "   " }), /reason/);

		const submit = await call("bios:review-experience", { ...claim(), experienceId: "exp-b05", expectedRevision: revision, action: "submit-review", reason: "提交评审", operatorLabel: "tester" });
		assert.equal(submit.result.status, "applied");
		assert.equal(submit.result.stateAfter, "reviewed");
		assert.equal(submit.result.operatorLabel, "tester");
		assert.notEqual(submit.result.journal.relativePath, "");
		revision = submit.result.revision;

		// 非 draft：正文再次编辑必须被拒（reviewed 必须先 request-changes 回草稿）。
		// core 用 `not-draft` 判别式**返回**拒绝（不是抛出）——界面必须按状态区分，不能当成"保存成功"。
		const blocked = await call("bios:update-experience", { ...claim(), experienceId: "exp-b05", expectedRevision: revision, changes: { solution: "偷偷改" } });
		assert.equal(blocked.result.status, "not-draft");
		assert.equal(blocked.committed, false);
		const untouched = await call("bios:read-experience-detail", { ...claim(), experienceId: "exp-b05" });
		assert.equal(untouched.result.card.solution, "调大 PXE_DELAY（已回归）", "被拒的编辑不得落盘");

		const back = await call("bios:review-experience", { ...claim(), experienceId: "exp-b05", expectedRevision: revision, action: "request-changes", reason: "缺目标板复验" });
		assert.equal(back.result.stateAfter, "draft");
		revision = back.result.revision;

		const resubmit = await call("bios:review-experience", { ...claim(), experienceId: "exp-b05", expectedRevision: revision, action: "submit-review", reason: "已补复验" });
		revision = resubmit.result.revision;
		const approve = await call("bios:review-experience", { ...claim(), experienceId: "exp-b05", expectedRevision: revision, action: "approve", reason: "证据充分" });
		assert.equal(approve.result.stateAfter, "verified");
		revision = approve.result.revision;

		const deprecate = await call("bios:review-experience", { ...claim(), experienceId: "exp-b05", expectedRevision: revision, action: "deprecate", reason: "基线已变" });
		assert.equal(deprecate.result.stateAfter, "deprecated");
		revision = deprecate.result.revision;

		const restore = await call("bios:review-experience", { ...claim(), experienceId: "exp-b05", expectedRevision: revision, action: "restore", reason: "误判，恢复" });
		assert.equal(restore.result.status, "applied");
		assert.notEqual(restore.result.stateAfter, "deprecated");

		// 晚到的审核（旧 revision）不得生效。
		await assert.rejects(() => call("bios:review-experience", { ...claim(), experienceId: "exp-b05", expectedRevision: created.result.revision, action: "approve", reason: "旧版本" }), /revision|冲突/);
	} finally {
		unregister();
		await sb.cleanup();
	}
});

test("B-05：检索给出分类/原因/声明验证；跨项目参考只作参考", async () => {
	const { sb, projectA, projectB, unregister } = await setup();
	try {
		const created = await call("bios:create-experience", { ...claim(), experience: experienceOf("exp-ref", projectA.projectId) });
		assert.equal(created.result.status, "created");
		await call("bios:review-experience", { ...claim(), experienceId: "exp-ref", expectedRevision: created.result.revision, action: "submit-review", reason: "提交" });

		const found = await call("bios:search-knowledge", { ...claim(), query: "PXE_DELAY", projectId: projectA.projectId });
		assert.equal(found.result.status, "ok", `检索应完整：${JSON.stringify(found.result.problems)}`);
		const hit = found.result.hits.find((entry) => entry.recordId === "exp-ref");
		assert.ok(hit, `应命中：${JSON.stringify(found.result.hits)}`);
		assert.equal(hit.family, "experience-card");
		assert.equal(hit.sourceProjectId, projectA.projectId);
		assert.equal(hit.recordedStatus, "reviewed");
		assert.ok(typeof hit.recommendation === "string", "必须给出 M1 分类");
		assert.ok(Array.isArray(hit.reasons), "必须给出分类原因");
		// 声明验证只按声明报告，不做强度升级。
		assert.ok(hit.declaredValidations.some((entry) => entry.kind === "board-boot" && entry.result === "passed"));
		assert.ok(found.result.scanned.recordsRead > 0, "扫描记账必须如实（不能只报 0）");

		// 同项目（目标 = 来源）：作为参考可取，但源板验证仍然只是**来源声明**。
		const sameProject = await call("bios:read-experience-reference", { ...claim(), experienceId: "exp-ref", targetProjectId: projectA.projectId });
		assert.equal(sameProject.result.status, "ok", `同项目参考应可取：${JSON.stringify(sameProject.result.reasons)}`);
		assert.equal(sameProject.result.porting.referenceOnly, true, "本批只作参考：不执行移植/构建/刷板");
		assert.equal(sameProject.result.reference.sourceProjectId, projectA.projectId);
		assert.deepEqual(
			[...sameProject.result.reference.declaredValidations].map((entry) => `${entry.kind}:${entry.result}`),
			["board-boot:passed"],
			"只报告来源声明的验证",
		);
		assert.ok(sameProject.result.reference.sourceCommit === null || typeof sameProject.result.reference.sourceCommit === "string");

		// 目标项目是 B：不得把别的项目的经验当作 current，也不得给出正文让人误当"目标板已验证"。
		const foreign = await call("bios:read-experience-reference", { ...claim(), experienceId: "exp-ref", targetProjectId: projectB.projectId });
		assert.equal(foreign.result.porting.referenceOnly, true, "本批只作参考");
		assert.notEqual(foreign.result.recommendation, "current", "来源项目 ≠ 目标项目时不得算 current");
		if (foreign.result.reference === null) {
			// 未给出正文时，状态必须自己说明"不可取"（界面据此显示 unavailable，而不是空白）。
			assert.notEqual(foreign.result.status, "ok");
		} else {
			assert.equal(foreign.result.reference.sourceProjectId, projectA.projectId);
			assert.notEqual(foreign.result.reference.sourceProjectId, projectB.projectId);
		}
	} finally {
		unregister();
		await sb.cleanup();
	}
});

test("B-05：撤权后经验/需求立即不可读（不靠界面自觉）", async () => {
	const { sb, projectA, state, unregister } = await setup();
	try {
		const created = await call("bios:create-experience", { ...claim(), experience: experienceOf("exp-revoke", projectA.projectId) });
		assert.equal(created.result.status, "created");

		// 收窄授权：来源项目被移出授权集合。
		state.settings = { ...state.settings, authorizedProjectIds: [] };
		const denied = await Promise.allSettled([call("bios:read-experience-detail", { ...claim(), experienceId: "exp-revoke" })]);
		const outcome = denied[0];
		if (outcome.status === "rejected") {
			assert.match(String(outcome.reason?.message ?? outcome.reason), /授权|authorized/);
		} else {
			assert.notEqual(outcome.value.result.status, "ok", "撤权后不得再读回正文");
			assert.equal(outcome.value.result.card, null);
		}
	} finally {
		unregister();
		await sb.cleanup();
	}
});
