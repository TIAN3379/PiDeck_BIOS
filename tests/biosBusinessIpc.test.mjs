/**
 * BM-07B B-02 永久回归：**人工业务 IPC**（生产 handler → 真实 core，合成资料）。
 *
 * 断言的是边界行为，不是源码字符串：
 * 1. renderer 提交的 `root`/`cwd`/授权集合一律不被采信（用可信配置与真实项目表解析）；
 * 2. 托管字段（revision/status/未知枚举）与缺失 `expectedRevision` 被拒绝；
 * 3. 跨项目、未授权客户/需求、假会话、迟到代次被拒绝；
 * 4. CAS 冲突不覆盖，且如实报 revision-conflict + committed=false；
 * 5. 部分完成/已提交用 `committed` 表达，分步事实保留在 core 判别式里；
 * 6. 动作期间配置/代次变化 ⇒ `guard.stable=false`，但已提交的事实不谎称回滚。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import test from "node:test";
import { createProjectSandbox, writeDsc } from "../packages/bios-agent/tests/helpers/projectFixtures.mjs";
import { initializeKnowledgeStore } from "../packages/bios-agent/core/storage/index.ts";
import { bindProjectWorkspace } from "../packages/bios-agent/core/projects/index.ts";
import { createBiosBusinessService } from "../src/main/bios/BiosBusinessService.ts";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const NOW = 1_700_000_000_000;
const AGENT = "agent-b02";
const SESSION = "deck-b02";

/** 生产 IPC 的 handler 表：用 stub 收下 `ipcMain.handle`（不启动 Electron）。 */
const handlers = new Map();
const { registerBiosBusinessIpc } = loadTsCommonJs("src/main/ipc/biosBusinessIpc.ts", {
	stubs: {
		electron: { ipcMain: { handle: (channel, fn) => handlers.set(channel, fn), removeHandler: (channel) => handlers.delete(channel) }, dialog: {} },
	},
});

const call = (channel, payload) => {
	const handler = handlers.get(channel);
	assert.ok(handler, `channel 未注册：${channel}`);
	return handler(null, payload);
};

/**
 * 合成会话端口：按 claim 的**真实规则**核对身份与代次（假身份/迟到一律拒绝），
 * 并可脚本化"第二次解析就换代"来模拟动作期间的配置/身份变化。
 */
function sessionPort({ generation = 3, cwd, onChange } = {}) {
	let calls = 0;
	return {
		resolve(claim) {
			calls += 1;
			const ref = claim.sessionRef;
			if (ref.agentId !== AGENT) return { error: "会话不存在或已结束：请刷新后重新选择" };
			if (ref.sessionId !== null && ref.sessionId !== SESSION) return { error: `会话身份不一致：提交的 sessionId 与当前 agent 的会话不符（提交 ${ref.sessionId}，实际 ${SESSION}）` };
			const current = calls > 1 && onChange !== undefined ? onChange : generation;
			if (claim.runtimeGeneration !== current) return { error: `会话运行时代次已变化（当前 ${current}，请求 ${claim.runtimeGeneration}）：请刷新后重试` };
			return { resolution: { agentId: AGENT, sessionId: SESSION, cwd, generation: current } };
		},
		listSessions: () => [],
		pushContextOff: async () => ({ receipt: "ok" }),
		stopRuntime: async () => ({ stopped: true, error: null }),
		syncSelection: async () => ({ error: "未使用" }),
	};
}

const claim = (generation = 3) => ({ sessionRef: { agentId: AGENT, sessionId: SESSION }, runtimeGeneration: generation });

async function setup() {
	const sb = await createProjectSandbox("bm07-b02-");
	await initializeKnowledgeStore({ root: sb.root, now: NOW });
	await writeDsc(sb.workspaceA, "Platform/SamplePkg/Sample.dsc", { platformName: "SamplePlatformA" });
	await mkdir(sb.workspaceB, { recursive: true });
	await writeDsc(sb.workspaceB, "Platform/SamplePkg/Sample.dsc", { platformName: "SamplePlatformB" });
	const workspaceC = `${sb.workspaceB}-c`;
	await mkdir(workspaceC, { recursive: true });
	await writeDsc(workspaceC, "Platform/SamplePkg/Sample.dsc", { platformName: "SamplePlatformC" });
	// `biosProjectId` 在 registry schema 里必须是 UUID：用 core 生成的稳定 ID，不手写短名。
	const projectA = await bindProjectWorkspace({ root: sb.root, cwd: sb.workspaceA, authorizedRoots: [sb.workspaceA], workspacePath: sb.workspaceA, now: NOW });
	const projectB = await bindProjectWorkspace({ root: sb.root, cwd: sb.workspaceB, authorizedRoots: [sb.workspaceB], workspacePath: sb.workspaceB, now: NOW });
	assert.equal(projectA.status, "bound", `合成项目 A 必须绑定成功：${JSON.stringify(projectA.problems)}`);
	assert.equal(projectB.status, "bound", `合成项目 B 必须绑定成功：${JSON.stringify(projectB.problems)}`);
	return { ...sb, projectA, projectB, workspaceC };
}

function settingsOf(sb, overrides = {}) {
	return { knowledgeRoot: sb.root, authorizedProjectIds: [sb.projectA.projectId, sb.projectB.projectId], allowedFeatureIds: [], approvedCustomers: [], authorizedRoots: [sb.workspaceA, sb.workspaceB], endpoint: "allowed", ...overrides };
}

function register(business) {
	return registerBiosBusinessIpc({ business, appLogger: { info() {} } });
}

/* ------------------------------------------------------------ 任务：信任边界 */

test("B-02：renderer 提交的 root/cwd/授权集合不被采信；缺失 expectedRevision 被拒", async () => {
	const sb = await setup();
	try {
		const state = { settings: settingsOf(sb) };
		const business = createBiosBusinessService({ readSettings: () => state.settings, session: sessionPort({ cwd: sb.workspaceA }), now: () => NOW, readConfigurationVersion: () => 7 });
		const unregister = register(business);

		// 伪造 root/cwd/授权集合：必须被忽略，写入落到**可信**知识根。
		const created = await call("bios:create-task", {
			...claim(),
			projectId: sb.projectA.projectId,
			taskId: "task-b02",
			workspaceId: sb.projectA.workspaceId,
			requirement: "SYNTHETIC-B02",
			root: "C:/attacker",
			cwd: "C:/attacker",
			authorizedProjectIds: ["evil"],
			authorizedRoots: ["C:/attacker"],
			operatorLabel: "tester",
		});
		assert.equal(created.result.status, "created");
		assert.equal(created.committed, true, "已创建必须标 committed");
		assert.equal(created.guard.stable, true);
		assert.equal(created.guard.configurationVersion, 7);

		// 更新：缺 expectedRevision 直接拒绝（禁止"无 CAS 覆盖"）。
		await assert.rejects(() => call("bios:update-task", { ...claim(), projectId: sb.projectA.projectId, taskId: "task-b02", changes: { requirement: "x" } }), /expectedRevision/);
		// 非法枚举（status 托管字段）不被接受。
		await assert.rejects(() => call("bios:change-task-status", { ...claim(), projectId: sb.projectA.projectId, taskId: "task-b02", expectedRevision: created.result.revision, to: "verified", reason: "x" }), /to 不在允许的取值内/);
		unregister();
	} finally {
		await sb.cleanup();
	}
});

test("B-02：CAS 冲突不覆盖；合法状态推进与显式重开按状态机执行", async () => {
	const sb = await setup();
	try {
		const state = { settings: settingsOf(sb) };
		const business = createBiosBusinessService({ readSettings: () => state.settings, session: sessionPort({ cwd: sb.workspaceA }), now: () => NOW });
		const unregister = register(business);
		const projectId = sb.projectA.projectId;
		const created = await call("bios:create-task", { ...claim(), projectId, taskId: "task-cas", workspaceId: sb.projectA.workspaceId, requirement: "CAS" });

		// 两个编辑请求持同一 revision：一成一拒。
		const okFirst = await call("bios:update-task", { ...claim(), projectId, taskId: "task-cas", expectedRevision: created.result.revision, changes: { todos: ["a"] } });
		assert.equal(okFirst.result.status, "updated");
		const stale = await call("bios:update-task", { ...claim(), projectId, taskId: "task-cas", expectedRevision: created.result.revision, changes: { todos: ["b"] } });
		assert.equal(stale.result.status, "revision-conflict", "不得覆盖胜者");
		assert.equal(stale.committed, false);
		assert.equal(stale.result.actualRevision, okFirst.result.revision, "必须给出实际 revision 供界面重读");

		// 状态推进：planned → in_progress → done；done → in_progress 必须显式重开并给理由。
		const toProgress = await call("bios:change-task-status", { ...claim(), projectId, taskId: "task-cas", expectedRevision: okFirst.result.revision, to: "in_progress", reason: "开始" });
		assert.equal(toProgress.result.status, "changed");
		const toDone = await call("bios:change-task-status", { ...claim(), projectId, taskId: "task-cas", expectedRevision: toProgress.result.revision, to: "done", reason: "完成" });
		assert.equal(toDone.result.status, "changed");
		await assert.rejects(() => call("bios:change-task-status", { ...claim(), projectId, taskId: "task-cas", expectedRevision: toDone.result.revision, to: "in_progress", reason: "" }), /reason/);
		const reopened = await call("bios:change-task-status", { ...claim(), projectId, taskId: "task-cas", expectedRevision: toDone.result.revision, to: "in_progress", reason: "发现回归，重新打开" });
		assert.equal(reopened.result.status, "changed");
		assert.equal(reopened.result.from, "done");

		// 详情：任务正文可读，验证记录保留（重开不清空验证）。
		const detail = await call("bios:read-task-detail", { ...claim(), projectId, taskId: "task-cas" });
		assert.equal(detail.result.status, "ok");
		assert.equal(detail.result.task?.requirement, "CAS");
		unregister();
	} finally {
		await sb.cleanup();
	}
});

test("B-02：假会话 / 迟到代次 / 未授权项目一律拒绝", async () => {
	const sb = await setup();
	try {
		const state = { settings: settingsOf(sb, { authorizedProjectIds: [sb.projectA.projectId] }) };
		const business = createBiosBusinessService({ readSettings: () => state.settings, session: sessionPort({ cwd: sb.workspaceA }), now: () => NOW });
		const unregister = register(business);

		await assert.rejects(() => call("bios:create-task", { sessionRef: { agentId: "nobody", sessionId: SESSION }, runtimeGeneration: 3, projectId: sb.projectA.projectId, taskId: "t", workspaceId: "w", requirement: "x" }), /会话不存在/);
		await assert.rejects(() => call("bios:create-task", { sessionRef: { agentId: AGENT, sessionId: "other" }, runtimeGeneration: 3, projectId: sb.projectA.projectId, taskId: "t", workspaceId: "w", requirement: "x" }), /身份不一致/);
		await assert.rejects(() => call("bios:read-task-detail", { ...claim(9), projectId: sb.projectA.projectId, taskId: "t" }), /代次/);
		await assert.rejects(() => call("bios:create-task", { ...claim(), projectId: sb.projectB.projectId, taskId: "t", workspaceId: "w", requirement: "x" }), /授权/);
		unregister();
	} finally {
		await sb.cleanup();
	}
});

test("B-02：动作期间换代 ⇒ guard.stable=false 但已提交事实不谎称回滚", async () => {
	const sb = await setup();
	try {
		const state = { settings: settingsOf(sb) };
		const business = createBiosBusinessService({ readSettings: () => state.settings, session: sessionPort({ cwd: sb.workspaceA, onChange: 4 }), now: () => NOW });
		const unregister = register(business);
		const created = await call("bios:create-task", { ...claim(), projectId: sb.projectA.projectId, taskId: "task-stale", workspaceId: sb.projectA.workspaceId, requirement: "STALE" });
		assert.equal(created.result.status, "created", "写入确实发生了");
		assert.equal(created.committed, true, "已提交不能被说成回滚");
		assert.equal(created.guard.stable, false, "动作期间换代必须标记为不稳定");
		// 换代后旧请求本身已不被接受 ⇒ 守卫给出"结果作废"（不是把旧结果算到新 runtime）。
		assert.match(created.guard.staleReason ?? "", /作废/);
		unregister();
	} finally {
		await sb.cleanup();
	}
});

/* ------------------------------------------------------------ 需求：显式初次授权 */

test("B-02：需求写入要求显式初次授权（不会因点新建自动放行）", async () => {
	const sb = await setup();
	try {
		const state = { settings: settingsOf(sb) };
		const business = createBiosBusinessService({ readSettings: () => state.settings, session: sessionPort({ cwd: sb.workspaceA }), now: () => NOW });
		const unregister = register(business);

		await assert.rejects(() => call("bios:create-feature", { ...claim(), feature: { featureId: "feat-1", originalRequirement: "PXE 定制", customer: { value: "customer-x", status: "confirmed" } } }), /初次授权/);

		// 办理授权后即可写入。
		state.settings = settingsOf(sb, { allowedFeatureIds: ["feat-1"] });
		const created = await call("bios:create-feature", { ...claim(), feature: { featureId: "feat-1", originalRequirement: "PXE 定制", customer: { value: "customer-x", status: "confirmed" } } });
		assert.equal(created.result.status, "created");
		assert.equal(created.committed, true);

		const detail = await call("bios:read-feature-detail", { ...claim(), featureId: "feat-1" });
		assert.equal(detail.result.status, "ok");
		assert.equal(detail.result.feature?.originalRequirement, "PXE 定制");

		// 更新：把客户改到批准范围外必须被拒（不接受请求里的授权字段）。
		state.settings = settingsOf(sb, { allowedFeatureIds: [] });
		await assert.rejects(() => call("bios:update-feature", { ...claim(), featureId: "feat-1", expectedRevision: created.result.revision, changes: { customer: { value: "customer-y", status: "confirmed" } } }), /拒绝写入/);
		unregister();
	} finally {
		await sb.cleanup();
	}
});

/* ------------------------------------------------------------ 经验：创建 / 审核 / 检索 */

test("B-02：经验草稿创建、审核状态机与检索（合成 PXE 定制）", async () => {
	const sb = await setup();
	try {
		const state = { settings: settingsOf(sb) };
		const business = createBiosBusinessService({ readSettings: () => state.settings, session: sessionPort({ cwd: sb.workspaceA }), now: () => NOW });
		const unregister = register(business);
		const projectId = sb.projectA.projectId;

		// 来源项目未授权 ⇒ 拒绝。
		state.settings = settingsOf(sb, { authorizedProjectIds: [projectId] });
		await assert.rejects(() => call("bios:create-experience", { ...claim(), experience: { experienceId: "exp-1", problem: "PXE 启动后菜单超时", rootCause: "PXE_DELAY 过小", solution: "改大 PXE_DELAY", sourceProjectId: sb.projectB.projectId } }), /来源项目不在授权集合内/);

		const created = await call("bios:create-experience", {
			...claim(),
			experience: {
				experienceId: "exp-1",
				problem: "PXE 启动后菜单超时",
				rootCause: "PXE_DELAY 过小",
				solution: "改大 PXE_DELAY",
				sourceProjectId: projectId,
				appliesWhen: ["同客户基线"],
				doesNotApplyWhen: ["非 PXE 启动"],
				validations: [{ kind: "compile", scope: "SamplePlatformA", result: "passed", performedAt: NOW, performedBy: "tester" }],
			},
		});
		assert.equal(created.result.status, "created");
		assert.equal(created.result.status_after, "draft", "新建即草稿，绝不自动 verified");

		// 审核必须带 expectedRevision 与理由；非法动作被拒。
		await assert.rejects(() => call("bios:review-experience", { ...claim(), experienceId: "exp-1", expectedRevision: created.result.revision, action: "verify", reason: "x" }), /action 不在允许的取值内/);
		// 审核前重读实际 revision（与 UI 一致：写后刷新当前 revision，不凭创建回执猜测）。
		const beforeReview = await call("bios:read-experience-detail", { ...claim(), experienceId: "exp-1" });
		assert.equal(beforeReview.result.status, "ok");
		const submitted = await call("bios:review-experience", { ...claim(), experienceId: "exp-1", expectedRevision: beforeReview.result.revision, action: "submit-review", reason: "提交评审", operatorLabel: "tester" });
		assert.equal(submitted.result.status, "applied");
		assert.equal(submitted.committed, true);
		assert.equal(submitted.result.stateAfter, "reviewed");

		// 晚到的审核（旧 revision）必须失败且不覆盖：core 把 CAS 冲突作为拒绝抛出（不是静默改成成功）。
		await assert.rejects(() => call("bios:review-experience", { ...claim(), experienceId: "exp-1", expectedRevision: created.result.revision, action: "approve", reason: "旧版本" }), /revision|冲突/);

		const approved = await call("bios:review-experience", { ...claim(), experienceId: "exp-1", expectedRevision: submitted.result.revision, action: "approve", reason: "证据充分" });
		assert.equal(approved.result.status, "applied");
		assert.equal(approved.result.stateAfter, "verified");

		// 检索：关键词命中，且来源项目/状态可见。
		const found = await call("bios:search-knowledge", { ...claim(), query: "PXE_DELAY", projectId });
		const hit = found.result.hits.find((entry) => entry.recordId === "exp-1");
		assert.ok(hit, `应命中合成经验：${JSON.stringify(found.result.hits)}`);
		assert.equal(hit.sourceProjectId, projectId);
		assert.equal(hit.recordedStatus, "verified");

		// 跨项目参考：目标项目是 B 时，来源仍是 A，且只作参考。
		state.settings = settingsOf(sb);
		const reference = await call("bios:read-experience-reference", { ...claim(), experienceId: "exp-1", targetProjectId: sb.projectB.projectId });
		assert.equal(reference.result.recordId, "exp-1");
		assert.equal(reference.result.porting.referenceOnly, true, "本批不执行移植：永远只作参考");
		unregister();
	} finally {
		await sb.cleanup();
	}
});

/* ------------------------------------------------------------ 任务沉淀草稿：分步事实 */

test("B-02：任务沉淀草稿分步报告，草稿成功后回链失败不撤销草稿", async () => {
	const sb = await setup();
	try {
		const state = { settings: settingsOf(sb) };
		const business = createBiosBusinessService({ readSettings: () => state.settings, session: sessionPort({ cwd: sb.workspaceA }), now: () => NOW });
		const unregister = register(business);
		const projectId = sb.projectA.projectId;
		const created = await call("bios:create-task", { ...claim(), projectId, taskId: "task-draft", workspaceId: sb.projectA.workspaceId, requirement: "沉淀来源" });

		const prefill = await call("bios:prepare-draft", { ...claim(), projectId, taskId: "task-draft" });
		assert.equal(prefill.result.status, "ok");
		assert.equal(prefill.result.prefill?.suggested.requirement, "沉淀来源");
		assert.ok([...(prefill.result.prefill?.requiredHumanFields ?? [])].includes("rootCause"), "人工必填字段必须显式列出");

		// 故意用旧的任务 revision 回链：草稿应已建立，回链失败，两步事实都要给出。
		const saved = await call("bios:save-draft", {
			...claim(),
			projectId,
			taskId: "task-draft",
			expectedTaskRevision: created.result.revision + 5,
			experience: { experienceId: "exp-draft", problem: "沉淀 PXE 经验", rootCause: "延迟过小", solution: "调大延迟" },
		});
		assert.equal(saved.result.experienceId, "exp-draft");
		assert.ok(saved.result.steps.length >= 1, "必须给出分步结果");
		assert.equal(saved.committed, true, "草稿已提交不能假称回滚");
		assert.match(saved.result.status, /link-|draft-saved/, `分步状态必须如实：${saved.result.status}`);
		unregister();
	} finally {
		await sb.cleanup();
	}
});

/* ------------------------------------------------------------ 管理入口 */

test("B-02：管理动作配置漂移标记 stale；检测拒绝未绑定或伪造工作区归属", async () => {
	const sb = await setup();
	try {
		const state = { settings: settingsOf(sb, { authorizedRoots: [sb.workspaceA, sb.workspaceB, sb.workspaceC] }) };
		const business = createBiosBusinessService({
			readSettings: () => state.settings,
			resolveDesktopProjectPath: (id) => (id === "desktop-a" ? sb.workspaceA : sb.workspaceC),
			now: () => {
				state.settings = { ...state.settings, endpoint: "denied" };
				return NOW;
			},
		});
		const confirmed = await business.confirmProfile({ biosProjectId: sb.projectA.projectId, expectedProfileRevision: sb.projectA.profileRevision, values: [{ field: "boardName", value: "Synthetic guard" }] });
		assert.equal(confirmed.committed, true);
		assert.equal(confirmed.guard.stable, false, "已经提交不能冒充新配置下的当前依据");
		await assert.rejects(() => business.detectCandidates({ desktopProjectId: "desktop-c", biosProjectId: sb.projectA.projectId }), /绑定|工作区/);
		await assert.rejects(() => business.detectCandidates({ desktopProjectId: "desktop-a", biosProjectId: sb.projectA.projectId, workspaceId: sb.projectB.workspaceId }), /绑定|工作区/);
	} finally {
		await sb.cleanup();
	}
});

test("B-02：项目管理入口用真实项目表解析路径，未授权项目不绑定", async () => {
	const sb = await setup();
	try {
		const newProjectId = randomUUID();
		const state = { settings: settingsOf(sb, { authorizedProjectIds: [sb.projectA.projectId], authorizedRoots: [sb.workspaceA, sb.workspaceB, sb.workspaceC] }) };
		const business = createBiosBusinessService({
			readSettings: () => state.settings,
			session: sessionPort({ cwd: sb.workspaceA }),
			resolveDesktopProjectPath: (id) => (id === "desktop-a" ? sb.workspaceA : id === "desktop-c" ? sb.workspaceC : null),
			now: () => NOW,
		});
		const unregister = register(business);

		// 未授权 BIOS 项目：拒绝并指引先办理授权。
		await assert.rejects(() => call("bios:bind-project", { desktopProjectId: "desktop-c", biosProjectId: newProjectId }), /初次授权/);
		// 找不到桌面项目：拒绝（路径只来自真实项目表）。
		state.settings = settingsOf(sb, { authorizedProjectIds: [sb.projectA.projectId, newProjectId], authorizedRoots: [sb.workspaceA, sb.workspaceC] });
		await assert.rejects(() => call("bios:bind-project", { desktopProjectId: "missing", biosProjectId: newProjectId }), /找不到对应的桌面项目路径/);

		// 授权 + 真实路径 ⇒ 绑定成功。
		const bound = await call("bios:bind-project", { desktopProjectId: "desktop-c", biosProjectId: newProjectId, displayName: "合成项目 C" });
		assert.equal(bound.result.status, "bound", `绑定状态：${bound.result.status} / ${JSON.stringify(bound.result.problems)}`);
		assert.equal(bound.committed, true);

		// 检测：只读，不写档案。
		const detected = await call("bios:detect-project", { desktopProjectId: "desktop-a", biosProjectId: sb.projectA.projectId, workspaceId: sb.projectA.workspaceId });
		assert.equal(detected.result.wroteToProfile, false, "检测绝不能自动写档案");
		assert.ok(
			detected.result.candidates.some((candidate) => candidate.value === "SamplePlatformA"),
			`应检测到合成平台名：${JSON.stringify(detected.result.candidates)}`,
		);

		// 人工确认：只改点名字段，带 expectedRevision。
		const view = await call("bios:read-project-view", { biosProjectId: sb.projectA.projectId, desktopProjectId: "desktop-a" });
		const confirmed = await call("bios:confirm-profile", { biosProjectId: sb.projectA.projectId, expectedProfileRevision: view.result.revisions.profile, values: [{ field: "boardName", value: "SyntheticBoardA" }], operatorLabel: "tester" });
		assert.equal(confirmed.result.status, "confirmed");
		assert.deepEqual([...confirmed.result.changedFields], ["boardName"]);
		assert.equal(confirmed.committed, true);
		// 非法字段名由 core 拒绝。
		await assert.rejects(() => call("bios:confirm-profile", { biosProjectId: sb.projectA.projectId, expectedProfileRevision: confirmed.result.revision, values: [{ field: "notAField", value: "x" }] }));

		// 初始化：只能初始化已配置的知识根。
		await assert.rejects(() => call("bios:initialize-store", { knowledgeRoot: "C:/somewhere-else" }), /已配置的知识根/);
		const init = await call("bios:initialize-store", { knowledgeRoot: sb.root });
		assert.equal(init.result.status, "existing", "已存在的库不得被重建");
		assert.equal(init.committed, false, "existing 不算新提交");
		unregister();
	} finally {
		await sb.cleanup();
	}
});

test("B-02/B-06：Manifest 通道的结构校验（缺字段直接拒绝，不进服务层）", async () => {
	const sb = await setup();
	try {
		const state = { settings: settingsOf(sb) };
		const business = createBiosBusinessService({ readSettings: () => state.settings, session: sessionPort({ cwd: sb.workspaceA }), now: () => NOW });
		const unregister = register(business);
		const base = { sessionRef: { agentId: AGENT, sessionId: SESSION }, runtimeGeneration: 3 };
		// 缺少 sources / budget：本层就挡住（不做"看起来合理就放行"的宽松判断）。
		await assert.rejects(() => call("bios:save-manifest", { ...base, manifestId: "m", targetProjectId: "p", profileRevision: 0, generatedAt: NOW }), /sources/);
		await assert.rejects(() => call("bios:save-manifest", { ...base, manifestId: "m", targetProjectId: "p", profileRevision: 0, generatedAt: NOW, sources: [] }), /budget/);
		// 非整数 revision 拒绝。
		await assert.rejects(() => call("bios:save-manifest", { ...base, manifestId: "m", targetProjectId: "p", profileRevision: 0, generatedAt: NOW, sources: [{ recordKind: "task-record", recordId: "t", revision: -1, reason: "x" }], budget: { maxChars: 1, maxBytes: 1, usedChars: 0, truncated: false } }), /revision/);
		// 重验缺 manifestId 拒绝。
		await assert.rejects(() => call("bios:verify-manifest", { ...base, projectId: "p" }), /manifestId/);
		unregister();
	} finally {
		await sb.cleanup();
	}
});
