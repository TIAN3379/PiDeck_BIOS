/**
 * R34-2 / R34-3 / R34-4 永久回归（根项目，无需 Electron）。
 *
 * - **R34-2**：末尾复核必须**重新解析真实 runtime**（不能拿调用方传入的旧 generation 自比）；
 *   会话关闭、换代、换 cwd 都要让结果作废；提交的 sessionId 与 agentId 不符直接拒绝。
 * - **R34-3**：命令同步要**两个动作都拿到结构化成功回执**（ok/action/选择）才算已同步；
 *   失败回执、普通消息、迟到回执、绑定变化都不能冒充成功。
 * - **R34-4**：配置**收窄**后按 runtime 失效旧许可（后续读取被挡，直到隔离重开换代次）；
 *   单纯放宽不打断；尽力把"关闭上下文"经命令通道推给旧 runtime 并核对回执。
 */
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import test from "node:test";
import { initializeKnowledgeStore } from "../packages/bios-agent/core/storage/index.ts";
import { bindProjectWorkspace } from "../packages/bios-agent/core/projects/index.ts";
import { createTask } from "../packages/bios-agent/core/tasks/index.ts";
import { createProjectSandbox, writeDsc } from "../packages/bios-agent/tests/helpers/projectFixtures.mjs";
import { BiosKnowledgeService, isNarrowing } from "../src/main/bios/BiosKnowledgeService.ts";
import { createBiosSessionPort, receiptMatches, resolveSessionClaim } from "../src/main/bios/BiosSessionPort.ts";

const NOW = 1_700_000_000_000;
const SECRET = "SECRET-R34-RUNTIME-REQUIREMENT";
const AGENT = "agent-r34";
const SESSION = "session-r34";

async function sandbox() {
	const sb = await createProjectSandbox("bm07-r34-");
	await initializeKnowledgeStore({ root: sb.root, now: NOW });
	await writeDsc(sb.workspaceA, "Platform/SamplePkg/Sample.dsc", { platformName: "SamplePlatformA" });
	await mkdir(sb.workspaceB, { recursive: true });
	await writeDsc(sb.workspaceB, "Platform/SamplePkg/Sample.dsc", { platformName: "SamplePlatformB" });
	const projectA = await bindProjectWorkspace({ root: sb.root, cwd: sb.workspaceA, authorizedRoots: [sb.workspaceA], workspacePath: sb.workspaceA, now: NOW });
	await createTask({ root: sb.root, projectId: projectA.projectId, taskId: "task-r34", workspaceId: projectA.workspaceId, cwd: sb.workspaceA, authorizedRoots: [sb.workspaceA], requirement: SECRET, authorizedProjectIds: [projectA.projectId] });
	return { ...sb, projectA };
}

const settingsOf = (sb, overrides = {}) => ({ knowledgeRoot: sb.root, authorizedProjectIds: [sb.projectA.projectId], allowedFeatureIds: [], approvedCustomers: [], authorizedRoots: [sb.workspaceA], endpoint: "allowed", ...overrides });

/** 可变会话端口：测试用 set 改变 generation / cwd / 存活，模拟"读取期间真实 runtime 变了"。 */
function mutablePort(sb, { generation = 3, cwd = null, alive = true } = {}) {
	const state = { generation, cwd: cwd ?? sb.workspaceA, alive };
	return {
		state,
		port: {
			resolve(claim) {
				if (!state.alive) return { error: "会话不存在或已结束：请刷新后重新选择" };
				if (claim.sessionRef.agentId !== AGENT) return { error: "会话不存在或已结束：请刷新后重新选择" };
				if (claim.sessionRef.sessionId !== SESSION) return { error: "会话身份不一致：提交的 sessionId 与当前 agent 的会话不符" };
				if (claim.runtimeGeneration !== state.generation) return { error: `会话运行时代次已变化（当前 ${state.generation}，请求 ${claim.runtimeGeneration}）：请刷新后重试` };
				return { resolution: { agentId: AGENT, sessionId: SESSION, cwd: state.cwd, generation: state.generation } };
			},
			listSessions: () => [{ agentId: AGENT, sessionId: SESSION, cwd: state.cwd, generation: state.generation }],
			pushContextOff: async () => ({ receipt: "已关闭" }),
			stopRuntime: async () => ({ stopped: true, error: null }),
		},
	};
}

function serviceFor(sb, sessionPort, extra = {}) {
	const state = { settings: settingsOf(sb) };
	return {
		state,
		service: new BiosKnowledgeService({ readSettings: () => state.settings, session: sessionPort, now: () => NOW, ...extra }),
	};
}

const claim = (generation = 3) => ({ sessionRef: { agentId: AGENT, sessionId: SESSION }, runtimeGeneration: generation });

/* ------------------------------------------------------------ R34-2 */

test("R34-2：读取期间换代 / 关闭 / 换 cwd 都让结果作废且不返回旧正文", async () => {
	const sb = await sandbox();
	try {
		for (const [label, mutate] of [
			["换代", (state) => (state.generation = 4)],
			["关闭会话", (state) => (state.alive = false)],
			["换 cwd", (state) => (state.cwd = sb.workspaceB)],
		]) {
			const { port, state } = mutablePort(sb);
			const { service } = serviceFor(sb, port);
			const pending = service.preview({ ...claim(), projectId: sb.projectA.projectId, taskId: "task-r34", workspaceId: sb.projectA.workspaceId });
			mutate(state);
			// 换代后旧代次的请求会被拒绝（"不用旧请求新 runtime"），所以这里捕获缺口而不是要求成功；
			// 换代前已开始的读取则会以"已作废"收尾。
			const outcome = await pending.then(
				(value) => value,
				(error) => ({ text: String(error.message), stable: false, maySendToModel: false }),
			);
			assert.equal(outcome.stable, false, `${label}：必须标为不稳定`);
			assert.equal(outcome.maySendToModel, false, `${label}：发送标志必须为 false`);
			assert.ok(!outcome.text.includes(SECRET), `${label}：不得返回旧正文：${outcome.text.slice(0, 300)}`);
		}

		// 正对照：什么都不改时必须稳定且真的读到正文。
		const { port: stablePort } = mutablePort(sb);
		const { service: stableService } = serviceFor(sb, stablePort);
		const positive = await stableService.preview({ ...claim(), projectId: sb.projectA.projectId, taskId: "task-r34", workspaceId: sb.projectA.workspaceId });
		assert.equal(positive.stable, true);
		assert.equal(positive.maySendToModel, true);
		assert.ok(positive.text.includes(SECRET));
	} finally {
		await sb.cleanup();
	}
});

test("R34-2：提交的 sessionId 与 agentId 不符 / 迟到的列表请求都被拒绝", async () => {
	const sb = await sandbox();
	try {
		const { port } = mutablePort(sb);
		const { service } = serviceFor(sb, port);
		const wrongSession = await service.listProjects({ sessionRef: { agentId: AGENT, sessionId: "another-session" }, runtimeGeneration: 3 });
		assert.deepEqual(wrongSession.items, []);
		assert.match(wrongSession.gap ?? "", /身份不一致/);
		const late = await service.listProjects(claim(9));
		assert.deepEqual(late.items, []);
		assert.match(late.gap ?? "", /代次/);
		const ok = await service.listProjects(claim());
		assert.equal(ok.gap, null);
	} finally {
		await sb.cleanup();
	}
});

test("R34-2：端口解析本身拒绝 sessionId 与 agent 不匹配（静态遗漏）", () => {
	const tabs = [{ agentId: AGENT, sessionId: SESSION, deckSessionId: null, cwd: "C:/ws", runtimeGeneration: 3 }];
	assert.equal("resolution" in resolveSessionClaim({ sessionRef: { agentId: AGENT, sessionId: SESSION }, runtimeGeneration: 3 }, tabs), true);
	const mismatch = resolveSessionClaim({ sessionRef: { agentId: AGENT, sessionId: "other" }, runtimeGeneration: 3 }, tabs);
	assert.ok("error" in mismatch && /身份不一致/.test(mismatch.error));
	// 同一个 sessionId 被另一个 agent 持有时：拒绝（不把旧请求算到新 runtime）。
	const moved = resolveSessionClaim({ sessionRef: { agentId: "agent-old", sessionId: SESSION }, runtimeGeneration: 3 }, tabs);
	assert.ok("error" in moved && /另一个 agent/.test(moved.error), `实际：${JSON.stringify(moved)}`);
});

/* ------------------------------------------------------------ R34-3 */

test("R34-3：结构化回执核对只认本动作的成功标志（失败/普通消息/迟到都不算）", () => {
	assert.equal(receiptMatches({ ok: true, action: "select", projectId: "p", taskId: "t" }, { action: "select", projectId: "p", taskId: "t" }), true);
	assert.equal(receiptMatches({ ok: false, action: "select", projectId: "p", taskId: "t" }, { action: "select", projectId: "p", taskId: "t" }), false, "失败回执不算 ACK");
	assert.equal(receiptMatches({ ok: true, action: "status" }, { action: "select", projectId: "p", taskId: "t" }), false, "别的动作不算 ACK");
	assert.equal(receiptMatches({ ok: true, action: "select", projectId: "other", taskId: "t" }, { action: "select", projectId: "p", taskId: "t" }), false, "选择不符不算 ACK");
	assert.equal(receiptMatches(undefined, { action: "off" }), false, "没有结构化 details 不算 ACK");
	assert.equal(receiptMatches({ ok: true, action: "on", opened: true }, { action: "on", opened: true }), true);
	assert.equal(receiptMatches({ ok: true, action: "off", opened: false }, { action: "off", opened: true }), false, "开关结果不符不算 ACK");
});

/* ------------------------------------------------------------ R34-4 */

test("UX-02/R34-4：放宽和收窄都失效旧 runtime；重开换代次后恢复", async () => {
	const sb = await sandbox();
	try {
		const { port, state } = mutablePort(sb);
		const { service, state: settingsState } = serviceFor(sb, port, { readSelections: () => ({ bySession: {}, bootId: "boot" }), writeSelections: async () => {} });
		const allowedSettings = settingsOf(sb);

		// 正对照：还没改配置时读得到。
		const before = await service.preview({ ...claim(), projectId: sb.projectA.projectId, taskId: "task-r34", workspaceId: sb.projectA.workspaceId });
		assert.equal(before.stable, true);

		// 放宽也必须更新 Pi 启动时的环境快照。
		const widened = await service.updateSettings({ ...allowedSettings, approvedCustomers: ["customer-x"] });
		assert.deepEqual(widened.invalidated, [`${AGENT}@3`], "放宽必须失效旧环境快照");
		assert.equal(widened.runtime.pendingRestart, true);
		await assert.rejects(() => service.preview({ ...claim(), projectId: sb.projectA.projectId, taskId: "task-r34", workspaceId: sb.projectA.workspaceId }), /隔离重开/);

		// 收窄（撤回目录根）：按 runtime 标记旧许可，并尽力推"关闭上下文"。
		const narrowed = await service.updateSettings({ ...allowedSettings, authorizedRoots: [] });
		assert.deepEqual([...narrowed.invalidated], [`${AGENT}@3`], "收窄必须按 runtime 记录旧许可");
		// R36-2：**优先落实停止**——停成功后不再去等 off 回执（弹出一条已经没进程的命令没有意义）。
		assert.deepEqual([...narrowed.stopped], [AGENT], "必须真的停掉旧 runtime");
		assert.deepEqual([...narrowed.pushedOff], [], "停止已生效时不必再推关闭上下文");
		assert.equal(narrowed.runtime.pendingRestart, true);
		await assert.rejects(() => service.preview({ ...claim(), projectId: sb.projectA.projectId, taskId: "task-r34", workspaceId: sb.projectA.workspaceId }), /隔离重开/);
		const blocked = await service.listTasks({ ...claim(), projectId: sb.projectA.projectId });
		assert.deepEqual(blocked.items, [], "旧许可 runtime 不得再列出任务");
		assert.match(blocked.gap ?? "", /隔离重开/);

		// 恢复一个可用配置；重开（换代次）后同一 agent 不再算旧许可。
		await service.updateSettings(allowedSettings);
		state.generation = 4;
		const revived = await service.preview({ ...claim(4), projectId: sb.projectA.projectId, taskId: "task-r34", workspaceId: sb.projectA.workspaceId });
		assert.equal(revived.stable, true, "隔离重开（换代次）后应恢复");
		assert.equal(service.runtimeState().pendingRestart, false, "换代次后不再有待重启");
		assert.ok(settingsState.settings.knowledgeRoot === sb.root);
	} finally {
		await sb.cleanup();
	}
});

test("R34-4：isNarrowing 只认收窄（端点/知识根/目录/项目/需求/客户）", () => {
	const base = { knowledgeRoot: "C:/kb", authorizedProjectIds: ["p1", "p2"], allowedFeatureIds: ["f1"], approvedCustomers: ["c1"], authorizedRoots: ["C:/a", "C:/b"], endpoint: "allowed" };
	assert.equal(isNarrowing(base, { ...base, authorizedRoots: ["C:/a"] }), true, "撤回目录根是收窄");
	assert.equal(isNarrowing(base, { ...base, authorizedRoots: ["C:/a", "C:/b", "C:/c"] }), false, "新增目录根是放宽");
	assert.equal(isNarrowing(base, { ...base, endpoint: "denied" }), true);
	assert.equal(isNarrowing(base, { ...base, authorizedProjectIds: ["p1"] }), true);
	assert.equal(isNarrowing(base, { ...base, approvedCustomers: ["c1", "c2"] }), false);
	assert.equal(isNarrowing(base, { ...base, knowledgeRoot: "C:/other" }), true, "换知识根必须失效旧许可");
	assert.equal(isNarrowing(base, { ...base, knowledgeRoot: null }), true);
	assert.equal(isNarrowing(base, base), false);
});
