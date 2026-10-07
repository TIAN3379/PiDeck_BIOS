/**
 * AW 第三轮独立验收（`docs/bios-agent/test_checklist.md`（历史编号保留））D1～D3 的**正式回归**。
 *
 * 断言的是**整改后的正确行为**（不是复现脚本的观察）：
 * - D1：真实子进程重启后，新用户请求不能再沿用旧请求键；未终结的阶段最多恢复一次；
 * - D2：任务关联的检查点不再被永久保护（正常连续保存不会占满容量）；同请求旧待补记记录
 *   按"有证据的覆盖关系"收口；补记预算用尽时如实呈现"部分保存"且不放宽 2 次请求硬上限；
 * - D3：显式选中的任务优先决定正文与关联身份；读不到选中的任务时不静默换成别的候选。
 *
 * 纪律：全部离线。知识库/工程是临时合成目录，模型是本机回环 SSE；不联网、不碰真实工程。
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bindProjectWorkspace } from "../core/projects/index.ts";
import { initializeKnowledgeStore } from "../core/storage/index.ts";
import { listRecords } from "../core/storage/records.ts";
import { AUTOMATION_LIMITS } from "../core/automation/contract.ts";
import { persistCheckpointRecord, readWorkspaceState } from "../core/automation/store.ts";
import { beginOriginalRequest, bindPersistedRequestEntry, durableMarkOf, hydrateDurableMarks, markedDurably, noteDurableMark, noteReflectionProviderRequest, reflectionWriteBudgetExhausted, requestKeyOf, resetAutomationSession, snapshotRun, startReflectionStage } from "../extensions/automationState.ts";
import { renderAwaitingCheckNote, renderUnrecoveredNote, shouldRequestReflection, unrecoveredReflections } from "../core/automation/policy.ts";
import { createProjectSandbox, writeDsc } from "./helpers/projectFixtures.mjs";
import { PI_MODULE_ENTRY } from "./helpers/biosExtension.mjs";
import { withSession } from "./helpers/piSessionHarness.mjs";

const AUTOMATION_ENV = { BIOS_AUTOMATION_ENABLED: "1", BIOS_AUTOMATION_BOOKKEEPING: "1", BIOS_AUTOMATION_INJECT: "1", BIOS_AUTOMATION_VERSION: "1" };
const INVESTIGATION = "排查 USB 启动问题，先不要改源码";
const RESTART_CHILD = fileURLToPath(new URL("./helpers/piSessionRestartChild.mjs", import.meta.url));

async function fixture(prefix) {
	const sb = await createProjectSandbox(prefix);
	await initializeKnowledgeStore({ root: sb.root });
	await writeDsc(sb.workspaceA, "Sample.dsc", { platformName: "SyntheticThirdReview" });
	const binding = await bindProjectWorkspace({ root: sb.root, cwd: sb.workspaceA, workspacePath: sb.workspaceA });
	return { ...sb, ...binding, env: { ...AUTOMATION_ENV, BIOS_KNOWLEDGE_ROOT: sb.root, BIOS_AUTHORIZED_PROJECTS: binding.projectId, BIOS_AUTHORIZED_ROOTS: sb.workspaceA, BIOS_ENDPOINT: "allowed" } };
}

const statePathOf = (f) => join(f.root, "automation", "workspaces", f.workspaceId, "state.json");
const checkpointsDirOf = (f) => join(f.root, "automation", "workspaces", f.workspaceId, "checkpoints");
const readState = async (f) => JSON.parse(await readFile(statePathOf(f), "utf8"));
const readCheckpointFiles = async (f) => {
	const dir = checkpointsDirOf(f);
	if (!existsSync(dir)) return [];
	const out = [];
	for (const name of (await readdir(dir)).filter((entry) => entry.endsWith(".json"))) out.push(JSON.parse(await readFile(join(dir, name), "utf8")));
	return out;
};
const requestText = (requests) => JSON.stringify(requests.flatMap((request) => request.body?.messages ?? []));
const instructionCount = (requests) => requests.filter((request) => JSON.stringify(request.body?.messages ?? []).includes("[BIOS 自动化补记]")).length;

/** 一个最小但完整的执行事实检查点（只用于存储层行为断言）。 */
function checkpointOf(f, input) {
	return {
		version: 1,
		runId: input.runId,
		projectId: f.projectId,
		workspaceId: f.workspaceId,
		sessionId: "s",
		branch: null,
		requestKey: input.requestKey ?? `r-${input.runId}`,
		recordedAt: input.recordedAt ?? 1,
		baseline: { workspacePath: f.workspaceA, branch: null, commit: null, fileHashes: {}, capturedAt: 1 },
		executed: [{ tool: "bios_get_project_info", outcome: "ok", files: [], wrote: false, businessStatus: null }],
		changedFiles: [],
		task: input.taskId === undefined || input.taskId === null ? null : { taskId: input.taskId, revision: 1 },
		outcome: "in-progress",
		pendingReflection: input.pendingReflection === true,
	};
}

/* --------------------------------------------------------------------- D1 */

test("D1：同一 entry 的稳定键不受它在进程内第几次请求影响", () => {
	resetAutomationSession();
	beginOriginalRequest("session-1", "C:\\ws", "前一个请求", "entry-before");
	const original = beginOriginalRequest("session-1", "C:\\ws", "排查", "entry-target");
	resetAutomationSession();
	assert.equal(beginOriginalRequest("session-1", "C:\\ws", "排查", "entry-target"), original, "新进程恢复同一 entry 必须定位到原来的耐久标记");
	resetAutomationSession();
});

test("D1：首次 context 绑定后，steer 的新叶子不会重置本轮身份或预算", () => {
	resetAutomationSession();
	beginOriginalRequest("session-1", "C:\\ws", "排查");
	bindPersistedRequestEntry("session-1", "C:\\ws", "entry-target");
	noteReflectionProviderRequest();
	const before = snapshotRun();
	bindPersistedRequestEntry("session-1", "C:\\ws", "steering-entry");
	assert.equal(snapshotRun().requestKey, before.requestKey);
	assert.deepEqual(snapshotRun().budget, before.budget);
	resetAutomationSession();
});

test("D1：请求键必须由**真实用户 entry** 区分（重启后自增序号会重来）", () => {
	resetAutomationSession();
	const first = beginOriginalRequest("session-1", "C:\\ws", "继续排查", "entry-1");
	// 同一个 entry 重复进入（Pi 重放/分支恢复）⇒ 保持同一个键，不产生第二份预算。
	assert.equal(beginOriginalRequest("session-1", "C:\\ws", "继续排查", "entry-1"), first);
	const second = beginOriginalRequest("session-1", "C:\\ws", "继续排查", "entry-2");
	assert.notEqual(second, first, "不同用户 entry 必须是不同请求键");
	// 模拟真实重启：新进程里序号从 0 重来、prompt 完全相同，只有 entry 不同。
	resetAutomationSession();
	const afterRestart = beginOriginalRequest("session-1", "C:\\ws", "继续排查", "entry-2");
	assert.notEqual(afterRestart, first, "重启后同样的 prompt 不能复用重启前的请求键");
	// 拿不到 entry 信息时退回"会话内序号 + prompt 前缀"：连续两次同样的输入仍是两个请求（C1 语义保持）。
	resetAutomationSession();
	const fallbackFirst = beginOriginalRequest("session-1", "C:\\ws", "继续排查");
	assert.notEqual(beginOriginalRequest("session-1", "C:\\ws", "继续排查"), fallbackFirst, "无 entry 时同前缀的连续请求也必须各有独立预算");
});

test("D1：阶段尝试与恢复尝试分开；未终结的阶段允许一次有界恢复，之后才终结", () => {
	resetAutomationSession();
	const key = beginOriginalRequest("session-1", "C:\\ws", "排查", "entry-a");
	// 阶段开始：attempts=1 但**尚未终结**（只是"开始过"）。
	noteDurableMark(key, false, 1, false);
	assert.equal(markedDurably(key), false, `阶段开始不等于已处理：必须允许恢复（attempts=1）`);
	// 恢复一次：attempts=2 ⇒ 用尽恢复上限，终结（明确失败）。
	noteDurableMark(key, false, 2, false);
	assert.equal(markedDurably(key), true);
	// 拿到真实完成回执 ⇒ 无论 attempts 多少都终结。
	noteDurableMark(key, true, 1, true);
	assert.equal(markedDurably(key), true);
	noteDurableMark(key, false, 1, true);
	assert.equal(markedDurably(key), true, "明确失败（finished=true）也是终结，不能无限重试");
	assert.ok(AUTOMATION_LIMITS.maxReflectionRecoveryAttempts >= 1, "恢复上限必须是正数（否则从未真正恢复）");
});

test("D1：有界恢复的真实决策链——重启后允许一次，恢复用尽即终结（不再无限重试）", () => {
	// 用**产品真实的**状态机与门禁走一遍：beginOriginalRequest → startReflectionStage → noteReflectionProviderRequest
	// → shouldRequestReflection → noteDurableMark，断言"一次恢复"而不是只测标记助手。
	const budgetOf = () => ({ ...snapshotRun().budget });
	const decide = (key) =>
		shouldRequestReflection({
			budget: budgetOf(),
			pending: true,
			aborted: false,
			scopeStable: true,
			alreadyMarked: markedDurably(key),
			outcome: "completed",
		});

	resetAutomationSession();
	const key = beginOriginalRequest("session-1", "C:\\ws", "排查 USB 启动", "entry-1");
	// 第一次阶段：真的开了阶段并花掉 provider 预算。
	noteDurableMark(key, false, 1, false);
	assert.equal(startReflectionStage(), true, "第一次应能开启补记阶段");
	noteReflectionProviderRequest();
	noteReflectionProviderRequest();
	assert.equal(reflectionWriteBudgetExhausted(), false);
	// 同一请求内不得再开第二个阶段（硬上限保持）。
	assert.equal(decide(key).request, false, `同一请求内不得重复开阶段：${decide(key).reason}`);

	// 模拟进程重启：内存预算清空、耐久标记仍在（阶段已开始但未终结）。
	resetAutomationSession();
	hydrateDurableMarks([{ requestKey: key, saved: false, attempts: 1, finished: false }]);
	assert.equal(beginOriginalRequest("session-1", "C:\\ws", "排查 USB 启动", "entry-1"), key, "重启后同一 entry 仍派生同一请求键");
	assert.equal(markedDurably(key), false, "阶段开始不等于已处理");
	assert.equal(decide(key).request, true, "未终结 ⇒ 必须允许**一次**有界恢复");

	// 同一进程内重放同一 entry：预算被重置一次（否则同进程内重放永远见不到恢复）。
	assert.equal(startReflectionStage(), true, "重放应重置一次预算以允许恢复");
	noteDurableMark(key, false, 2, false);
	assert.equal(decide(key).request, false, `恢复用尽即终结（attempts=${durableMarkOf(key)?.attempts}）：${decide(key).reason}`);

	// 恢复用尽后再重放：预算不再被重置 ⇒ 不再重复补记。
	noteReflectionProviderRequest();
	noteReflectionProviderRequest();
	beginOriginalRequest("session-1", "C:\\ws", "排查 USB 启动", "entry-1");
	assert.equal(decide(key).request, false, "达到恢复上限后不得再开阶段");
	resetAutomationSession();
});

test("D1/V2：没有恢复路径的未终结补记必须给出明确回执口径（要有可信终止依据，不凭请求不同判死）", () => {
	const mark = (overrides) => ({ requestKey: "k-1", runId: "k-1", recordedAt: 1, saved: false, attempts: 1, finished: false, ...overrides });
	const ctx = { currentRequestKey: "k-new", bootId: "boot-current", sessionId: "session-a" };
	// 有恢复路径的两个反例：当前请求自己（正在恢复）、已终结（成功或明确失败）。
	assert.deepEqual(unrecoveredReflections({ marks: [mark({})], ...ctx, currentRequestKey: "k-1" }), [], "当前请求不算未恢复");
	assert.deepEqual(unrecoveredReflections({ marks: [mark({ finished: true })], ...ctx }), [], "已终结不算未恢复");
	assert.deepEqual(unrecoveredReflections({ marks: [mark({ saved: true, finished: true })], ...ctx }), []);
	// V2（§13.2）：所有者未知的旧记录、以及**同一进程里其它会话**的 pending，都不能算未恢复
	// —— 旧实现只看"requestKey 不是当前请求"，于是别的会话仍在跑也会被判死。
	assert.deepEqual(unrecoveredReflections({ marks: [mark({})], ...ctx }), [], "所有者未知不能凭请求不同就判死");
	assert.deepEqual(unrecoveredReflections({ marks: [mark({ ownerBootId: "boot-current", ownerSessionId: "session-b" })], ...ctx }), [], "其它会话的 pending 不能判成未恢复");
	// Different process UUIDs cannot prove termination, even with the same session id.
	assert.deepEqual(unrecoveredReflections({ marks: [mark({ ownerBootId: "boot-old", ownerSessionId: "session-a" })], ...ctx }), []);
	const gone = unrecoveredReflections({ marks: [mark({ ownerBootId: "boot-current", ownerSessionId: "session-a" })], ...ctx });
	assert.equal(gone.length, 1);
	assert.equal(gone[0].reason, "no-recovery-path");
	assert.equal(gone[0].attempts, 1);
	// 可信依据二：同一会话已被新请求取代（同一会话一次只处理一个请求）。
	assert.equal(unrecoveredReflections({ marks: [mark({ ownerBootId: "boot-current", ownerSessionId: "session-a" })], ...ctx }).length, 1, "同一会话被新请求取代即可确认未恢复");
	// 恢复次数用尽要给出不同原因（不再暗示"等一等就能恢复"）。
	const exhausted = unrecoveredReflections({ marks: [mark({ ownerBootId: "boot-current", ownerSessionId: "session-a", attempts: 1 + AUTOMATION_LIMITS.maxReflectionRecoveryAttempts })], ...ctx });
	assert.equal(exhausted[0].reason, "recovery-exhausted");
	// 已经回执过的不再重复（避免每轮刷屏）。
	assert.deepEqual(unrecoveredReflections({ marks: [mark({ ownerBootId: "boot-old", unrecoveredAt: 1 })], ...ctx }), []);
	// 文案：不承诺已恢复、不要求模型代做，但要说证据保留。
	const note = renderUnrecoveredNote(gone);
	assert.ok(note.includes("未恢复"), note);
	assert.ok(note.includes("已保留"), `必须说明证据保留：${note}`);
	assert.ok(!note.includes("已自动恢复"), "不得声称已经自动恢复");
	assert.equal(renderUnrecoveredNote([]), "");
	// V3：「待核对」另有文案，不得把它说成已经中断。
	const awaiting = renderAwaitingCheckNote([mark({})]);
	assert.ok(awaiting.includes("待核对"), awaiting);
	assert.ok(!awaiting.includes("未恢复（"), `待核对不能说成"未恢复"：${awaiting}`);
	assert.ok(awaiting.includes("已保留"), "待核对的证据保留也必须说明");
	assert.equal(renderAwaitingCheckNote([]), "");
});

test("D1：旧格式耐久标记按 saved 推断 finished（未保存的旧标记允许一次恢复）", () => {
	resetAutomationSession();
	hydrateDurableMarks([
		{ requestKey: "legacy-unsaved", saved: false, attempts: 1 },
		{ requestKey: "legacy-saved", saved: true, attempts: 1 },
	]);
	assert.equal(markedDurably("legacy-unsaved"), false, "旧记录 saved=false 且未终结：允许一次恢复");
	assert.equal(markedDurably("legacy-saved"), true);
});

test("D1：真实子进程重启后，同样的用户输入必须拿到**自己的**补记（不沿用旧标记）", async () => {
	const f = await fixture("aw-d1-restart-");
	try {
		// 第一轮：真实工具 + 补记阶段真实保存任务（saved=true 的耐久标记）。
		const { SessionManager } = await import(pathToFileURL(PI_MODULE_ENTRY).href);
		const created = SessionManager.create(f.workspaceA, join(f.base, "sessions"));
		let sessionPath = null;
		await withSession(
			f,
			f.env,
			(_body, index) => {
				if (index === 0) return { toolCallId: "first-investigate", toolCall: { name: "bios_get_project_info", arguments: {} } };
				if (index === 2) return { toolCallId: "first-save", toolCall: { name: "bios_manage_task", arguments: { action: "create", requirement: "SYNTHETIC D1 首轮任务" } } };
				return { text: "SYNTHETIC first finished" };
			},
			async ({ session, requests }) => {
				await session.prompt(INVESTIGATION);
				sessionPath = session.sessionManager.getSessionFile();
				assert.ok(instructionCount(requests) >= 1, "第一轮必须有补记阶段");
				const user = session.sessionManager.getBranch().findLast((entry) => entry.type === "message" && entry.message.role === "user");
				assert.ok(user !== undefined);
				const marks = (await readState(f)).reflectionMarks;
				assert.equal(marks[0].requestKey, requestKeyOf(session.sessionManager.getSessionId(), f.workspaceA, `entry:${user.id}`), "耐久键必须绑定本次实际持久化的用户 entry，而不是 before_agent_start 时的上一条叶子");
			},
			{ sessionManager: created },
		);
		assert.ok(typeof sessionPath === "string" && sessionPath !== "", "会话必须真实持久化到磁盘");
		const afterFirst = await readState(f);
		assert.equal(afterFirst.reflectionMarks.length, 1, JSON.stringify(afterFirst.reflectionMarks));
		assert.equal(afterFirst.reflectionMarks[0].saved, true, "首轮补记真实保存 ⇒ saved=true");
		assert.equal(afterFirst.reflectionMarks[0].finished, true, "完成回执必须标记 finished=true");

		// 第二轮：**全新进程**重开同一会话，发出**内容相同**的新用户请求。
		const child = spawnSync(process.execPath, [RESTART_CHILD, JSON.stringify({ workspaceA: f.workspaceA, sessionPath, env: f.env, prompt: INVESTIGATION })], { encoding: "utf8", timeout: 60_000 });
		assert.equal(child.status, 0, `重启子进程必须成功：${child.stderr}`);
		const line = (child.stdout ?? "").split(/\r?\n/).find((entry) => entry.startsWith("RESTART-RESULT "));
		assert.ok(line !== undefined, `子进程必须输出结果行：${child.stdout}`);
		const observed = JSON.parse(line.slice("RESTART-RESULT ".length));
		assert.ok(observed.instructions >= 1, `重启后的新请求必须有自己的补记（实际 ${JSON.stringify(observed)}）`);
		const afterRestart = await readState(f);
		assert.equal(afterRestart.reflectionMarks.length, 2, `新请求必须有独立的耐久标记：${JSON.stringify(afterRestart.reflectionMarks)}`);
		const keys = afterRestart.reflectionMarks.map((mark) => mark.requestKey);
		assert.equal(new Set(keys).size, keys.length, `不同请求的标记键不得重复：${JSON.stringify(keys)}`);
	} finally {
		await f.cleanup();
	}
});

/* --------------------------------------------------------------------- D2 */

test("D1：真实 Pi 树回退后，同内容新 entry 在新分支有独立补记身份", async () => {
	const f = await fixture("aw-d1-tree-");
	try {
		await withSession(
			f,
			f.env,
			(_body, index) => (index % 3 === 0 ? { toolCallId: `tree-investigate-${index}`, toolCall: { name: "bios_get_project_info", arguments: {} } } : { text: "SYNTHETIC 调查结果" }),
			async ({ session, requests }) => {
				await session.prompt(INVESTIGATION);
				const firstUser = session.sessionManager.getBranch().findLast((entry) => entry.type === "message" && entry.message.role === "user");
				assert.ok(firstUser !== undefined);
				await session.prompt(INVESTIGATION);
				const oldLeaf = session.sessionManager.getLeafId();
				const moved = await session.navigateTree(firstUser.id, { summarize: false });
				assert.equal(moved.cancelled, false);
				await session.prompt(INVESTIGATION);
				assert.ok(!session.sessionManager.getBranch().some((entry) => entry.id === oldLeaf), "新请求必须实际位于回退后的另一分支");
				const marks = (await readState(f)).reflectionMarks;
				assert.equal(marks.length, 3);
				assert.equal(new Set(marks.map((mark) => mark.requestKey)).size, 3);
				assert.equal(instructionCount(requests), 3, "三个真实请求各有一次补记，分支回退不吞新请求");
			},
		);
	} finally {
		await f.cleanup();
	}
});

test("D1：真实 Pi 在补记阶段取消时，不能写成 finished 或自行续跑", async () => {
	const f = await fixture("aw-d1-cancel-");
	try {
		await withSession(
			f,
			f.env,
			(_body, index) => {
				if (index === 0) return { toolCallId: "cancel-investigation", toolCall: { name: "bios_get_project_info", arguments: {} } };
				return { text: "SYNTHETIC 只读结果" };
			},
			async ({ session, requests }) => {
				let aborted = false;
				const off = session.subscribe((event) => {
					if (!aborted && event.type === "message_start" && requests.length === 3) {
						aborted = true;
						void session.abort();
					}
				});
				try {
					await session.prompt(INVESTIGATION);
					assert.equal(aborted, true, "必须在真实补记阶段执行取消");
					const mark = (await readState(f)).reflectionMarks[0];
					assert.equal(mark.saved, false);
					assert.equal(mark.finished, false, "取消只表示中断，不能冒充补记终结");
					assert.equal(mark.attempts, 1);
					assert.equal(requests.length, 3, "取消后不得在扩展中另开模型循环");
				} finally {
					off();
				}
			},
		);
	} finally {
		await f.cleanup();
	}
});

test("D2：活跃任务数正好占满上限时，新任务如实 full + 耐久回执，同任务新记录仍能轮换自己", async () => {
	const f = await fixture("aw-d2-boundary-");
	try {
		const target = { root: f.root, projectId: f.projectId, workspaceId: f.workspaceId };
		const max = AUTOMATION_LIMITS.maxRecentCheckpoints;
		// 极端形状：**每个活跃任务各一条**（50 个任务）——这正是审查里"正常使用占满容量"的成因。
		const statuses = [];
		for (let index = 1; index <= max; index += 1) {
			const taskId = `task-${String(index).padStart(2, "0")}`;
			const outcome = await persistCheckpointRecord({ ...target, checkpoint: checkpointOf(f, { runId: `${taskId}-run`, taskId, recordedAt: index, pendingReflection: false }), protectedFromRotation: false });
			statuses.push(outcome.status);
		}
		assert.ok(!statuses.includes("full"), `上限内的正常保存必须都能写入：${JSON.stringify(statuses)}`);
		const before = await readWorkspaceState(target);
		assert.equal(before.value.checkpoints.length, max);
		const filesBefore = (await readdir(checkpointsDirOf(f))).length;

		// 品牌新任务：容量已满 ⇒ 如实 full（不写文件、不丢已有事实），并落耐久回执供宿主显示。
		const overflow = await persistCheckpointRecord({ ...target, checkpoint: checkpointOf(f, { runId: "extra-run", taskId: "task-extra", recordedAt: 9_000, pendingReflection: false }), protectedFromRotation: false });
		assert.equal(overflow.status, "full", JSON.stringify(overflow));
		assert.equal(overflow.indexed, max);
		const after = await readWorkspaceState(target);
		assert.equal(after.value.checkpoints.length, max, "容量满时索引不得增长");
		assert.equal((await readdir(checkpointsDirOf(f))).length, filesBefore, "容量满时不得产生孤儿文件");
		assert.equal(after.value.lastReceipt?.kind, "checkpoint-full", JSON.stringify(after.value.lastReceipt));
		assert.equal(after.value.checkpoints.filter((ref) => ref.taskId !== null).length, max, "已保留的权威事实必须一条不少");

		// 任务关联**不是**永久占用：同一任务的新记录应能直接轮换掉它自己的旧记录，且集合不超上限。
		const rotate = await persistCheckpointRecord({ ...target, checkpoint: checkpointOf(f, { runId: "task-25-run-2", taskId: "task-25", recordedAt: 10_000, pendingReflection: false }), protectedFromRotation: false });
		assert.equal(rotate.status, "created", `容量满时同任务的新记录仍应写入：${JSON.stringify(rotate)}`);
		assert.deepEqual(rotate.rotatedOut, ["task-25-run"], "轮换掉的必须是同任务的旧记录（不能动别人的最新依据）");
		const boundary = await readWorkspaceState(target);
		assert.equal(boundary.value.checkpoints.length, max, "轮换不得让集合超过上限");
		assert.ok(boundary.value.checkpoints.some((ref) => ref.runId === "task-25-run-2"));
		assert.equal((await readdir(checkpointsDirOf(f))).length, max, "磁盘必须依然有界");
	} finally {
		await f.cleanup();
	}
});

test("D2：任务关联的检查点不是永久保护——超过上限的连续正常保存仍能保留最新必要记录", async () => {
	const f = await fixture("aw-d2-retention-");
	try {
		// 默认上限 50；用 3 个活跃任务连续 60 轮"调查 + 保存任务"。
		// 旧实现把任务关联当永久保护 ⇒ 第 50 轮起容量被占满、后续轮次再也写不进去（§9.3 D2 实测）。
		const target = { root: f.root, projectId: f.projectId, workspaceId: f.workspaceId };
		const rounds = 60;
		const tasks = [1, 2, 3];
		const statuses = [];
		let lastRunIdByTask = new Map();
		for (let round = 1; round <= rounds; round += 1) {
			const taskId = `task-${tasks[round % tasks.length]}`;
			const runId = `round-${String(round).padStart(3, "0")}`;
			lastRunIdByTask.set(taskId, runId);
			const outcome = await persistCheckpointRecord({ ...target, checkpoint: checkpointOf(f, { runId, taskId, recordedAt: round, pendingReflection: false, requestKey: `req-${round}` }), protectedFromRotation: false });
			statuses.push(outcome.status);
		}
		assert.ok(!statuses.includes("full"), `正常连续保存不得占满容量（实际 ${JSON.stringify(statuses)}）`);
		const state = await readWorkspaceState(target);
		assert.equal(state.status, "ok");
		assert.ok(state.value.checkpoints.length <= AUTOMATION_LIMITS.maxRecentCheckpoints, `索引必须始终有界：${state.value.checkpoints.length}`);
		// 每个任务的**最新**一条必须还在（按 taskId 检索的依据不能因为轮换消失）。
		for (const [taskId, runId] of lastRunIdByTask) {
			const kept = state.value.checkpoints.find((ref) => ref.runId === runId);
			assert.ok(kept !== undefined, `任务 ${taskId} 的最新检查点必须保留：${runId}`);
			assert.equal(kept.taskId, taskId);
		}
		// 磁盘有界：轮换必须真的清理文件。
		assert.equal((await readdir(checkpointsDirOf(f))).length, state.value.checkpoints.length, "磁盘文件数必须与索引一致（轮换 = 新增 + 清理）");
	} finally {
		await f.cleanup();
	}
});

test("D2：同请求旧待补记记录按有证据的覆盖关系收口（不再永久占位）", async () => {
	const f = await fixture("aw-d2-integrate-");
	try {
		const target = { root: f.root, projectId: f.projectId, workspaceId: f.workspaceId, max: 4 };
		// 旧记录：同一请求、待补记、受保护。
		await persistCheckpointRecord({ ...target, checkpoint: checkpointOf(f, { runId: "req-1-turn-0", requestKey: "req-1", recordedAt: 1, pendingReflection: true }), protectedFromRotation: true });
		await persistCheckpointRecord({ ...target, checkpoint: checkpointOf(f, { runId: "req-2-turn-0", requestKey: "req-2", recordedAt: 2, pendingReflection: true }), protectedFromRotation: true });
		// 新权威记录：同一请求 req-1、已不再待补记（settle 时的完整事实）。
		const authoritative = await persistCheckpointRecord({ ...target, checkpoint: checkpointOf(f, { runId: "req-1-settle", requestKey: "req-1", recordedAt: 3, pendingReflection: false }), protectedFromRotation: false });
		assert.notEqual(authoritative.status, "full", JSON.stringify(authoritative));
		const state = await readWorkspaceState(target);
		assert.equal(state.status, "ok");
		const settled = state.value.checkpoints.find((ref) => ref.runId === "req-1-settle");
		assert.ok(settled !== undefined, "权威记录必须在索引里");
		const superseded = state.value.checkpoints.find((ref) => ref.runId === "req-1-turn-0");
		if (superseded !== undefined) assert.equal(superseded.pendingReflection, false, "被覆盖的旧记录不再待补记");
		assert.equal(superseded?.protectedFromRotation ?? false, false, "被覆盖的旧记录不再受保护");
		// 另一个请求的待补记记录不能被误收口。
		const other = state.value.checkpoints.find((ref) => ref.runId === "req-2-turn-0");
		if (other !== undefined) assert.equal(other.pendingReflection, true, "其它请求的待补记记录必须保持原状");
		for (const ref of state.value.checkpoints) {
			const onDisk = JSON.parse(await readFile(join(checkpointsDirOf(f), `${ref.runId}.json`), "utf8"));
			assert.equal(ref.pendingReflection, onDisk.pendingReflection, "收口后的索引与不可变检查点正文必须一致");
		}
	} finally {
		await f.cleanup();
	}
});

test("D2：同请求但未覆盖独有事实或代码基线时，不能清除旧 pending 证据", async () => {
	const f = await fixture("aw-d2-coverage-");
	try {
		const target = { root: f.root, projectId: f.projectId, workspaceId: f.workspaceId };
		const pending = checkpointOf(f, { runId: "unique-pending", requestKey: "req", pendingReflection: true });
		await persistCheckpointRecord({ ...target, checkpoint: pending, protectedFromRotation: true });
		for (const [runId, changes] of [
			["missing-facts", { executed: [] }],
			["different-baseline", { baseline: { ...pending.baseline, commit: "different-head" } }],
			["different-session", { sessionId: "other-session" }],
		]) {
			await persistCheckpointRecord({ ...target, checkpoint: { ...pending, ...changes, runId, recordedAt: 2, pendingReflection: false }, protectedFromRotation: false });
			const state = await readWorkspaceState(target);
			assert.equal(state.status, "ok");
			const retained = state.value.checkpoints.find((ref) => ref.runId === pending.runId);
			assert.equal(retained?.pendingReflection, true, `${runId} 不具有事实覆盖证据，必须保留旧 pending`);
			assert.ok(existsSync(join(checkpointsDirOf(f), `${pending.runId}.json`)));
		}
	} finally {
		await f.cleanup();
	}
});

test("D2：收紧容量不能裁掉已经存在的唯一待补记证据", async () => {
	const f = await fixture("aw-d2-tighten-");
	try {
		const target = { root: f.root, projectId: f.projectId, workspaceId: f.workspaceId };
		for (let index = 0; index < 3; index += 1) await persistCheckpointRecord({ ...target, checkpoint: checkpointOf(f, { runId: `existing-${index}`, pendingReflection: true }), protectedFromRotation: true });
		const before = (await readWorkspaceState(target)).value.checkpoints;
		const result = await persistCheckpointRecord({ ...target, max: 2, checkpoint: checkpointOf(f, { runId: "blocked-new", pendingReflection: true }), protectedFromRotation: true });
		assert.equal(result.status, "full");
		assert.deepEqual((await readWorkspaceState(target)).value.checkpoints, before, "满容量回执不能顺便裁掉原索引");
		assert.equal((await readCheckpointFiles(f)).length, 3, "拒绝新增不产生孤儿，也不删除旧唯一证据");
	} finally {
		await f.cleanup();
	}
});

test("D2：补记预算用尽时如实呈现部分保存（任务已保存、草稿未保存），且不放宽 2 次请求硬上限", async () => {
	const f = await fixture("aw-d2-partial-");
	try {
		await withSession(
			f,
			f.env,
			(_body, index) => {
				// 0：原始调查工具；1：收口文本（随后请求补记）；
				// 2：补记请求 #1 返回任务写入（允许，providerRequests=1）；
				// 3：补记请求 #2 返回经验草稿写入 —— 此时预算已用尽，必须被拦下并如实记为"未保存"。
				if (index === 0) return { toolCallId: "investigate", toolCall: { name: "bios_get_project_info", arguments: {} } };
				if (index === 2) return { toolCallId: "reflection-save-task", toolCall: { name: "bios_manage_task", arguments: { action: "create", requirement: "SYNTHETIC D2 部分成功任务" } } };
				if (index === 3) return { toolCallId: "reflection-save-draft", toolCall: { name: "bios_save_experience_draft", arguments: { problem: "SYNTHETIC D2 草稿", rootCause: "unknown", solution: "synthetic" } } };
				return { text: "SYNTHETIC 收口。" };
			},
			async ({ session, requests }) => {
				await session.prompt(INVESTIGATION);
				assert.equal(instructionCount(requests), 1, "必须有且只有一次补记阶段");
				const reflectionRequests = requests.length - 2;
				assert.ok(reflectionRequests >= 1, `应发生补记阶段请求：${requests.length}`);
				assert.ok(reflectionRequests <= AUTOMATION_LIMITS.maxReflectionProviderRequests, `补记阶段实际 provider 请求必须 <= ${AUTOMATION_LIMITS.maxReflectionProviderRequests}，实际 ${reflectionRequests}`);
				// 任务真实落盘，草稿**没有**落盘（被预算硬闸门拦下）。
				const tasks = await listRecords({ root: f.root, kind: "task-record", projectId: f.projectId });
				assert.equal(tasks.entries.length, 1, "任务写入必须真实发生");
				const drafts = await listRecords({ root: f.root, kind: "experience-card", projectId: f.projectId });
				assert.equal(drafts.entries.length, 0, "预算用尽后的草稿写入必须被拒绝（不放宽第 3 次请求）");
				// 如实呈现"部分保存"：耐久回执落盘，宿主默认面板据此显示。
				const state = await readState(f);
				assert.equal(state.lastReceipt?.kind, "reflection-partial", `必须写入部分成功回执：${JSON.stringify(state.lastReceipt)}`);
				assert.match(state.lastReceipt.detail, /经验草稿/, `回执必须说明哪一部分没保存：${state.lastReceipt.detail}`);
				const facts = (await readCheckpointFiles(f)).flatMap((checkpoint) => checkpoint.executed);
				assert.ok(
					facts.some((fact) => fact.tool === "bios_manage_task"),
					"任务事实必须入账",
				);
			},
		);
	} finally {
		await f.cleanup();
	}
});

/* --------------------------------------------------------------------- D3 */

async function seedSelectedTasks(f) {
	const { changeTaskStatus, createTask } = await import("../core/tasks/index.ts");
	for (const [taskId, requirement] of [
		["selected-done", "SYNTHETIC-D3-SELECTED-DONE"],
		["other-active", "SYNTHETIC-D3-UNSELECTED-ACTIVE"],
	]) {
		await createTask({ root: f.root, projectId: f.projectId, taskId, workspaceId: f.workspaceId, cwd: f.workspaceA, authorizedRoots: [f.workspaceA], authorizedProjectIds: [f.projectId], requirement });
		await changeTaskStatus({ root: f.root, projectId: f.projectId, taskId, expectedRevision: 0, to: "in_progress", reason: "synthetic", authorizedProjectIds: [f.projectId] });
	}
	await changeTaskStatus({ root: f.root, projectId: f.projectId, taskId: "selected-done", expectedRevision: 1, to: "done", reason: "synthetic", humanConfirmed: true, authorizedProjectIds: [f.projectId] });
}

/** D3 的三个用例共用：真实采纳初始选择需要一个真实的"首轮"请求（宿主在首轮完成采纳）。 */
async function runWithAdoptedSelection(f, selectedTaskId) {
	const env = { ...f.env, BIOS_SELECTED_PROJECT_ID: f.projectId, BIOS_SELECTED_TASK_ID: selectedTaskId, BIOS_SELECTED_WORKSPACE_ID: f.workspaceId };
	return withSession(
		f,
		env,
		() => ({ text: "SYNTHETIC D3 回答。" }),
		async ({ session, requests }) => {
			// 先发一次不触发背景准备的请求，让宿主完成"初始选择采纳"（真实链路，不靠桩）。
			await session.prompt("你好");
			requests.length = 0;
			await session.prompt("请说明这个任务当前的记录与状态");
			return requestText(requests);
		},
	);
}

test("D3：显式选中的**已完成**任务优先于其它自动候选（不注入未选任务的续接指令）", async () => {
	const f = await fixture("aw-d3-selected-done-");
	try {
		await seedSelectedTasks(f);
		const sent = await runWithAdoptedSelection(f, "selected-done");
		assert.ok(sent.includes("SYNTHETIC-D3-SELECTED-DONE"), `必须注入**选中**任务的正文：${sent.slice(0, 600)}`);
		assert.ok(!sent.includes("SYNTHETIC-D3-UNSELECTED-ACTIVE"), `不得注入未选中的其它候选任务：${sent.slice(0, 600)}`);
		assert.ok(!sent.includes("请从这里继续"), "选中的是已完成任务：可以查看/讨论，但不得静默重开或续接");
	} finally {
		await f.cleanup();
	}
});

test("D3：显式选中的**未完成**任务既给正文也允许从这里继续", async () => {
	const f = await fixture("aw-d3-selected-active-");
	try {
		await seedSelectedTasks(f);
		const sent = await runWithAdoptedSelection(f, "other-active");
		assert.ok(sent.includes("SYNTHETIC-D3-UNSELECTED-ACTIVE"), `必须注入**选中**任务的正文：${sent.slice(0, 600)}`);
		assert.ok(!sent.includes("SYNTHETIC-D3-SELECTED-DONE"), "不得把已完成的另一个任务当成当前工作");
		assert.ok(sent.includes("请从这里继续"), "选中的是未完成任务：应允许从这里继续");
	} finally {
		await f.cleanup();
	}
});

test("D3：显式选中的任务读不到时如实说明，且不静默换成别的候选", async () => {
	const f = await fixture("aw-d3-missing-");
	try {
		await seedSelectedTasks(f);
		// 先让选择被真实采纳（任务当时可读），再让该任务的记录变成不可读（撤权/坏记录/被删）。
		const taskFile = join(f.root, "projects", f.projectId, "tasks", "selected-done.json");
		const { rm } = await import("node:fs/promises");
		const sent = await (async () => {
			const env = { ...f.env, BIOS_SELECTED_PROJECT_ID: f.projectId, BIOS_SELECTED_TASK_ID: "selected-done", BIOS_SELECTED_WORKSPACE_ID: f.workspaceId };
			return withSession(
				f,
				env,
				() => ({ text: "SYNTHETIC D3 回答。" }),
				async ({ session, requests }) => {
					await session.prompt("你好");
					await rm(taskFile, { force: true });
					requests.length = 0;
					await session.prompt("请说明这个任务当前的记录与状态");
					return requestText(requests);
				},
			);
		})();
		assert.ok(sent.includes("读不到"), `必须如实说明选中的任务读不到：${sent.slice(0, 600)}`);
		assert.ok(!sent.includes("SYNTHETIC-D3-UNSELECTED-ACTIVE"), `不得把别的候选当成唯一可信对象：${sent.slice(0, 600)}`);
		assert.ok(!sent.includes("请从这里继续"), "没有可用的选中正文时不得给出续接指令");
	} finally {
		await f.cleanup();
	}
});
