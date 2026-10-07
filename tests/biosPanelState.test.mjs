/**
 * R36-1 永久回归：**BIOS 面板的身份隔离与迟到结果**（纯状态机，无需浏览器）。
 *
 * 覆盖验收列出的场景：延迟 A→切 B、换任务、换代次、撤权（配置代次变化）、旧回执、
 * 首次只有一个项目、空列表、读取失败。规则是：状态机只接受"当前代次"的结果，
 * 身份/配置一变就立刻失效旧正文，并且**不隐式选中第一项**。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// 纯模块（type-only 依赖），可直接交给 node 跑：用 loadTsCommonJs 保持与其它渲染层模块一致。
const panel = loadTsCommonJs("src/renderer/src/components/app/settings/biosPanelState.ts");

const project = (projectId) => ({ projectId, profileRevision: 1, identity: [], workspaces: [], needsReviewCount: 0, problems: [] });
const task = (taskId) => ({ projectId: "p1", taskId, revision: 1, status: "planned", requirement: "R", workspaceId: "w1", updatedAt: 1, blockerCount: 0, todoCount: 0 });
const preview = (text) => ({
	status: "ok",
	text,
	maySendToModel: true,
	identityUsable: true,
	stable: true,
	outboundNote: null,
	budget: { maxChars: 100, maxBytes: 100, usedChars: 1, usedBytes: 1, truncated: false, clamped: false },
	retainedSources: [],
	inspectedSources: [],
	retainedSourceCount: 0,
	inspectedSourceCount: 0,
	sourcesTruncated: false,
	expiredSources: [],
	problems: [],
});

const identityA = { sessionId: "s-a", agentId: "agent-a", generation: 3 };
const identityB = { sessionId: "s-b", agentId: "agent-b", generation: 7 };

test("R37-2：切任务必须拒绝正在返回的旧任务预览", () => {
	let state = panel.chooseTask(panel.chooseProject(bootA(), "p1"), "a");
	state = panel.beginRequest(state, 20, "preview");
	state = panel.chooseTask(state, "b");
	state = panel.applyPreview(state, 20, preview("preview-of-a"));
	assert.equal(state.taskId, "b");
	assert.equal(state.preview, null);
	assert.equal(state.busy, null);
});

/** 面板的最初状态：已绑定身份 A、配置代次 1。 */
function bootA() {
	return panel.syncScope(panel.initialBiosPanelState(), panel.identityKeyOf(identityA), 1, 1);
}

/**
 * 与 hook 一致的调用方式：先 `beginRequest`（推进接受代次），结果回来再 `settle` 落地。
 * 注意 `settle` 必须拿到 begin 之后的状态，否则"代次没推进"会把正常结果也丢掉。
 */
function apply(state, epoch, patchOf) {
	const begun = panel.beginRequest(state, epoch, "request");
	return panel.settle(begun, epoch, patchOf(begun));
}

test("R36-1：迟到的 A 预览不得写进已切换到 B 的面板（卸载/切会话后不更新）", () => {
	let state = bootA();
	// A 上发起请求（代次 2）。
	state = panel.beginRequest(state, 2, "preview");
	// 用户切到 Session B：身份变化 ⇒ 代次推进到 3，旧请求作废。
	state = panel.syncScope(state, panel.identityKeyOf(identityB), 1, 3);
	assert.equal(state.preview, null);
	assert.equal(state.busy, null, "切身份要清掉 busy");
	// A 的结果此刻才回来：必须被丢弃。
	const late = panel.applyPreview(state, 2, preview("A 的商业正文"));
	assert.equal(late, state, "迟到结果必须原样返回（同一引用）");
	assert.equal(late.preview, null, "B 的面板不得出现 A 的正文");
	// 正对照：代次匹配时正常落地。
	const fresh = panel.applyPreview(panel.beginRequest(state, 4, "preview"), 4, preview("B 的正文"));
	assert.equal(fresh.preview?.text, "B 的正文");
});

test("R36-1：配置代次变化（撤权）立即失效旧预览与旧回执，即使身份没变", () => {
	let state = bootA();
	state = panel.chooseProject(state, "p1");
	state = panel.chooseTask(state, "t1");
	state = panel.applyPreview(panel.beginRequest(state, 2, "preview"), 2, preview("撤权前的正文"));
	state = panel.markSynced(state, { projectId: "p1", taskId: "t1", workspaceId: null, contextEnabled: true }, "已同步");
	assert.equal(state.preview?.maySendToModel, true);
	// 配置代次 +1（保存了收窄后的可信配置 / onChanged 通知）：身份不变也要清正文。
	state = panel.syncScope(state, panel.identityKeyOf(identityA), 2, 3);
	assert.equal(state.preview, null, "撤权后不得继续展示旧正文");
	assert.equal(state.receipt, null, "旧回执（已同步）也要失效");
	assert.equal(panel.selectionView(state).status, "candidate", "同意状态退回候选");
	// 迟到的旧预览同样进不来。
	const late = panel.applyPreview(state, 2, preview("撤权前的正文"));
	assert.equal(late.preview, null);
});

test("R36-1：换代次（runtime 重开）视为新身份，旧列表/选择/预览全部清空", () => {
	let state = bootA();
	state = apply(state, 2, (s) => panel.projectPatch(s, [project("p1")]));
	state = panel.chooseProject(state, "p1");
	state = apply(state, 3, (s) => panel.taskPatch(s, [task("t1")]));
	state = panel.chooseTask(state, "t1");
	assert.equal(panel.selectionView(state).status, "candidate");

	const restarted = { ...identityA, generation: 4 };
	const next = panel.syncScope(state, panel.identityKeyOf(restarted), 1, 4);
	assert.deepEqual([...next.projects], [], "换代次后必须重新拉列表");
	assert.equal(next.projectId, null);
	assert.equal(next.taskId, null);
	assert.equal(next.preview, null);
	assert.equal(panel.selectionView(next).status, "none");
});

test("R36-1：首次刷新只有一个项目时，必须先拿到该列表再串任务（显式返回值，不靠旧闭包）", () => {
	// 模拟组件的首次刷新：先拉项目 → 用**返回值**决定项目 → 再拉任务。
	let state = bootA();
	const listedProjects = [project("p-only")];
	state = apply(state, 2, (s) => panel.projectPatch(s, listedProjects));
	// 列表不隐式选中第一项：显式选择（UI 用返回列表里的第一项做默认值，但状态机只接受显式调用）。
	state = panel.chooseProject(state, listedProjects[0].projectId);
	assert.equal(state.projectId, "p-only");
	const listedTasks = [task("t-only")];
	state = apply(state, 3, (s) => panel.taskPatch(s, listedTasks));
	assert.deepEqual(
		[...state.tasks].map((entry) => entry.taskId),
		["t-only"],
		"有任务就必须看到它（首刷缺陷）",
	);
	assert.equal(state.taskId, null, "任务默认仍是未选择（候选），不隐式确认第一项");
	assert.equal(panel.selectionView(state).status, "none");
});

test("R36-1：项目/任务失效时清空，且清空任务后不再显示旧的已同步选择", () => {
	let state = bootA();
	state = panel.chooseProject(state, "p1");
	state = panel.chooseTask(state, "t1");
	state = panel.markSynced(state, { projectId: "p1", taskId: "t1", workspaceId: null, contextEnabled: true }, "已同步");
	assert.equal(panel.selectionView(state).status, "synced");

	// 列表里没有这个项目了（撤权/删除）⇒ 项目与任务一起清空，同意状态失效。
	state = apply(state, 4, (s) => panel.projectPatch(s, [project("p2")]));
	assert.equal(state.projectId, null);
	assert.equal(state.taskId, null);
	assert.equal(panel.selectionView(state).status, "none");

	// 有同步但任务被撤下 ⇒ 退回候选。
	state = panel.chooseProject(state, "p2");
	state = panel.chooseTask(state, "t2");
	state = panel.markSynced(state, { projectId: "p2", taskId: "t2", workspaceId: null, contextEnabled: true }, "已同步");
	state = apply(state, 5, (s) => panel.taskPatch(s, [task("t3")]));
	assert.equal(state.taskId, null);
	assert.equal(panel.selectionView(state).status, "none");
});

test("R36-1：空列表与读取失败都如实反馈，且不进新面板", () => {
	let state = bootA();
	// 空列表：projects 为空、gap 有值 ⇒ 面板显示缺口，不假装有内容。
	state = apply(state, 2, (s) => ({ ...panel.projectPatch(s, []), problem: "未配置知识根" }));
	assert.deepEqual([...state.projects], []);
	assert.equal(state.problem, "未配置知识根");

	// 读取失败：写进 problem；迟到失败（旧代次）不写。
	state = panel.beginRequest(state, 3, "preview");
	state = panel.applyFailure(state, 3, "会话已结束");
	assert.equal(state.problem, "会话已结束");
	const late = panel.applyFailure(panel.syncScope(state, panel.identityKeyOf(identityB), 1, 5), 3, "A 的旧错误");
	assert.equal(late.problem, null, "旧会话的错误不得飘进新会话");
});

test("R36-1：本地选择只是候选；后端未确认（回执失败）不得显示成已生效", () => {
	let state = bootA();
	state = panel.chooseProject(state, "p1");
	state = panel.chooseTask(state, "t1");
	assert.equal(panel.selectionView(state).status, "candidate", "本地选择 = 候选");

	state = panel.markUnsynced(state, "当前会话未同步：等待回执超时", "未同步");
	assert.equal(panel.selectionView(state).status, "candidate", "没拿到回执不算已生效");
	assert.equal(state.receipt?.synced, false);
	assert.equal(state.problem, "未同步");

	state = panel.markSynced(state, { projectId: "p1", taskId: "t1", workspaceId: "w1", contextEnabled: true }, "已同步到当前会话");
	const view = panel.selectionView(state);
	assert.equal(view.status, "synced");
	assert.equal(view.contextEnabled, true, "已同步时要能显示实际开关状态");
});
