/**
 * R33-2 / R33-3 / R33-4 永久回归（根项目，无需 Electron）：
 *
 * - **R33-2**：会话身份与代次、目录包含关系（不用原始 startsWith）、列表/预览的末尾撤权门禁、
 *   `maySendToModel` 与身份一致、按会话归属的选择；
 * - **R33-3**：权威 env 构造（先清除列举键再写当前值、空授权/无选择/默认关闭显式覆盖）、
 *   旧数据不继承、两会话互不沿用、重启后保守关闭、PiProcess 依赖图保持"纯"；
 * - **R33-4**：12,000 字符 / 24 KiB 硬上限在 IPC 与领域入口共用，参数只能收紧，
 *   非法预算（NaN/Infinity/小数/非正）拒绝，Unicode 与极小值都守得住，元数据另设限额。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { MODEL_CONTENT_MAX_BYTES, MODEL_CONTENT_MAX_CHARS, resolveModelBudget } from "../packages/bios-agent/core/context/policy.ts";
import { initializeKnowledgeStore } from "../packages/bios-agent/core/storage/index.ts";
import { bindProjectWorkspace } from "../packages/bios-agent/core/projects/index.ts";
import { createTask } from "../packages/bios-agent/core/tasks/index.ts";
import { createProjectSandbox, writeDsc } from "../packages/bios-agent/tests/helpers/projectFixtures.mjs";
import { applyBiosEnv, BIOS_CONFIG_ENV_KEYS, currentBiosBootId, normalizeBiosHostSettings, resolveSessionSelection } from "../src/main/bios/biosProcessEnv.ts";
import { BiosKnowledgeService, isCwdAuthorized, splitValidAuthorizedRoots } from "../src/main/bios/BiosKnowledgeService.ts";

const NOW = 1_700_000_000_000;
const SECRET = "SECRET-R33-DESKTOP-REQUIREMENT";
const AGENT_ID = "agent-a";

/* ------------------------------------------------------------ R33-3：权威 env */

test("R33-3：权威构造先清除列举键，旧知识根/旧授权/内网复用标记都不被继承", () => {
	const env = {
		BIOS_KNOWLEDGE_ROOT: "C:/old-library",
		BIOS_AUTHORIZED_PROJECTS: "11111111-1111-4111-8111-111111111111",
		BIOS_ALLOWED_FEATURE_IDS: "feat-old",
		BIOS_APPROVED_CUSTOMERS: "customer-old",
		BIOS_AUTHORIZED_ROOTS: "C:/old-root",
		BIOS_ENDPOINT: "allowed",
		BIOS_ALLOW_INTERNAL_GENERAL: "1",
		BIOS_SELECTED_PROJECT_ID: "old-project",
		BIOS_SELECTED_TASK_ID: "old-task",
		BIOS_SELECTED_WORKSPACE_ID: "old-workspace",
		BIOS_CONTEXT_ENABLED: "1",
		PIDECK_SESSION_ID: "keep-me",
	};
	// 桌面设置：什么都没配（未配置即拒绝）。
	const authoritative = applyBiosEnv(env, normalizeBiosHostSettings(null));
	assert.equal(authoritative.PIDECK_SESSION_ID, "keep-me", "不属于本包的键不得改动");
	assert.equal(authoritative.BIOS_KNOWLEDGE_ROOT, "", "旧知识根必须被清掉");
	assert.equal(authoritative.BIOS_AUTHORIZED_PROJECTS, "", "旧项目授权必须被清掉");
	assert.equal(authoritative.BIOS_ALLOWED_FEATURE_IDS, "");
	assert.equal(authoritative.BIOS_APPROVED_CUSTOMERS, "");
	assert.equal(authoritative.BIOS_AUTHORIZED_ROOTS, "");
	assert.equal(authoritative.BIOS_ALLOW_INTERNAL_GENERAL, "0", "内网复用标记必须显式关闭");
	assert.equal(authoritative.BIOS_SELECTED_TASK_ID, "", "旧任务不可留存");
	assert.equal(authoritative.BIOS_CONTEXT_ENABLED, "0");
	assert.equal(authoritative.BIOS_ENDPOINT, "unknown", "未配置=unknown（扩展保持惰性）");
	for (const key of BIOS_CONFIG_ENV_KEYS) assert.ok(key in authoritative, `${key} 必须被显式写入（不能靠"没设"表示未授权）`);
});

test("R33-3：两会话选择互相独立；重启（bootId 变化）后保守关闭且找不到的会话不给选择", () => {
	const stored = {
		bySession: {
			"session-a": { projectId: "p-a", taskId: "t-a", workspaceId: "w-a", contextEnabled: true, updatedAt: 1 },
			"session-b": { projectId: "p-b", taskId: "t-b", workspaceId: "w-b", contextEnabled: true, updatedAt: 1 },
		},
		bootId: "boot-1",
	};
	assert.deepEqual(resolveSessionSelection(stored, "boot-1", "session-a"), { projectId: "p-a", taskId: "t-a", workspaceId: "w-a", contextEnabled: true });
	assert.deepEqual(resolveSessionSelection(stored, "boot-1", "session-b"), { projectId: "p-b", taskId: "t-b", workspaceId: "w-b", contextEnabled: true });
	assert.equal(resolveSessionSelection(stored, "boot-1", "session-c"), undefined, "别的会话的选择不得沿用");
	assert.equal(resolveSessionSelection(stored, "boot-1", null), undefined, "没有会话身份就没有选择");
	// 重启：记录还在，但"已打开"不沿用（必须重新验证后再打开）。
	assert.deepEqual(resolveSessionSelection(stored, "boot-2", "session-a"), { projectId: "p-a", taskId: "t-a", workspaceId: "w-a", contextEnabled: false });
	assert.equal(resolveSessionSelection(null, currentBiosBootId(), "session-a"), undefined);
});

test("R33-3：PiProcess 只依赖纯 env 模块（不再把包内 core 拉进 VM 加载图）", () => {
	const processSource = readFileSync("src/main/pi/PiProcess.ts", "utf8");
	assert.match(processSource, /from "\.\.\/bios\/biosProcessEnv"/, "必须使用纯 env 模块");
	assert.ok(!processSource.includes("bios/BiosKnowledgeService"), "不得把（会 import 包内 core 的）服务拉进进程装配层");
	const pureSource = readFileSync("src/main/bios/biosProcessEnv.ts", "utf8");
	assert.ok(!/^\s*import \{[^}]*\} from "\.\.\/\.\.\/\.\.\/packages/m.test(pureSource), "纯模块不得有包内值导入");
	for (const line of pureSource.split("\n")) {
		if (/^\s*import\b/.test(line)) assert.ok(/^import (type )?\{?[^"]*from "(node:crypto|\.\.\/\.\.\/shared\/types\/bios\.ts)"/.test(line.trim()), `纯模块只允许 node 内置与类型导入：${line.trim()}`);
	}
});

/* ------------------------------------------------------------ R33-2：路径与身份 */

test("R33-2：目录授权用标准化 + 包含关系（同前缀与 .. 逃逸都不放行）", () => {
	const roots = ["D:\\allowed"];
	assert.equal(isCwdAuthorized("D:\\allowed", roots), true);
	assert.equal(isCwdAuthorized("D:\\allowed\\sub\\dir", roots), true);
	assert.equal(isCwdAuthorized("D:\\allowed-evil", roots), false, "同前缀目录不是根内");
	assert.equal(isCwdAuthorized("D:\\allowed\\..\\outside", roots), false, ".. 逃逸必须被规范化后拒绝");
	assert.equal(isCwdAuthorized("relative\\dir", roots), false, "相对路径不接受");
	assert.equal(isCwdAuthorized("D:\\allowed", []), false, "没有任何授权根 ⇒ 不放行");

	const split = splitValidAuthorizedRoots(["D:\\ok", "relative", "\\\\server\\share\\kb", "", "C:name"]);
	assert.deepEqual(split.valid, ["D:\\ok", "\\\\server\\share\\kb"]);
	assert.deepEqual(split.dropped, ["relative", "", "C:name"], "非法目录根必须被丢弃并如实报告");
});

async function sandbox() {
	const sb = await createProjectSandbox("bm07-r33-desk-");
	await initializeKnowledgeStore({ root: sb.root, now: NOW });
	await writeDsc(sb.workspaceA, "Platform/SamplePkg/Sample.dsc", { platformName: "SamplePlatformA" });
	await mkdir(sb.workspaceB, { recursive: true });
	await writeDsc(sb.workspaceB, "Platform/SamplePkg/Sample.dsc", { platformName: "SamplePlatformB" });
	const projectA = await bindProjectWorkspace({ root: sb.root, cwd: sb.workspaceA, authorizedRoots: [sb.workspaceA, sb.workspaceB], workspacePath: sb.workspaceA, now: NOW });
	const projectB = await bindProjectWorkspace({ root: sb.root, cwd: sb.workspaceB, authorizedRoots: [sb.workspaceA, sb.workspaceB], workspacePath: sb.workspaceB, now: NOW });
	await createTask({ root: sb.root, projectId: projectA.projectId, taskId: "task-r33", workspaceId: projectA.workspaceId, cwd: sb.workspaceA, authorizedRoots: [sb.workspaceA], requirement: SECRET, todos: ["待办一"], authorizedProjectIds: [projectA.projectId] });
	return { ...sb, projectA, projectB };
}

/** 合成会话端口：cwd / 代次由测试控制（模拟主进程从真实会话表解析）。 */
function sessionPort({ cwd, generation = 3, agentId = AGENT_ID, receipt = null }) {
	return {
		resolve(claim) {
			if (claim.sessionRef.agentId !== agentId) return { error: "会话不存在或已结束：请刷新后重新选择" };
			if (claim.runtimeGeneration !== generation) return { error: `会话运行时代次已变化（当前 ${generation}，请求 ${claim.runtimeGeneration}）` };
			return { resolution: { agentId, sessionId: "session-a", cwd, generation } };
		},
		async syncSelection() {
			return receipt === null ? { error: "命令通道不可用" } : { receipt };
		},
		// R35：端口能力全部必填（生产装配必须接全）。
		listSessions: () => [{ agentId, sessionId: "session-a", generation }],
		pushContextOff: async () => ({ receipt: "已关闭" }),
		stopRuntime: async () => ({ stopped: true, error: null }),
	};
}

function serviceFor(sb, { settings, session, now = () => NOW } = {}) {
	const state = { settings };
	return {
		service: new BiosKnowledgeService({
			readSettings: () => state.settings,
			readSelections: () => state.selections ?? null,
			writeSelections: async (next) => {
				state.selections = next;
			},
			...(session === undefined ? {} : { session }),
			now,
		}),
		state,
	};
}

const allowedSettings = (sb) => ({ knowledgeRoot: sb.root, authorizedProjectIds: [sb.projectA.projectId], allowedFeatureIds: [], approvedCustomers: ["customer-alpha"], authorizedRoots: [sb.workspaceA], endpoint: "allowed" });
const claim = (generation = 3) => ({ sessionRef: { agentId: AGENT_ID, sessionId: "session-a" }, runtimeGeneration: generation });

test("R33-2：假身份 / 迟到代次 / 目录不符都被拒绝，且不读取任何记录", async () => {
	const sb = await sandbox();
	try {
		const { service } = serviceFor(sb, { settings: allowedSettings(sb), session: sessionPort({ cwd: sb.workspaceA }) });
		const fake = await service.listProjects({ sessionRef: { agentId: "agent-ghost", sessionId: null }, runtimeGeneration: 3 });
		assert.equal(fake.items.length, 0);
		assert.match(fake.gap ?? "", /会话不存在/, `假身份必须给缺口：${fake.gap}`);

		const late = await service.listProjects(claim(2));
		assert.equal(late.items.length, 0);
		assert.match(late.gap ?? "", /代次/);

		const ok = await service.listProjects(claim());
		assert.equal(ok.gap, null);
		assert.deepEqual(
			ok.items.map((project) => project.projectId),
			[sb.projectA.projectId],
		);

		// 会话目录不在授权范围内 ⇒ 预览直接拒绝（不是给出正文再过滤）。
		const outside = serviceFor(sb, { settings: allowedSettings(sb), session: sessionPort({ cwd: sb.workspaceB }) }).service;
		await assert.rejects(() => outside.preview({ ...claim(), projectId: sb.projectA.projectId, taskId: "task-r33", workspaceId: sb.projectA.workspaceId }), /不在已授权的目录根内/);

		// 没有会话端口 ⇒ 一律拒绝。
		const noPort = serviceFor(sb, { settings: allowedSettings(sb) }).service;
		assert.match((await noPort.listProjects(claim())).gap ?? "", /会话解析/);
	} finally {
		await sb.cleanup();
	}
});

test("R33-2：列表中撤权（读取期间清空授权）只给有限缺口，不返回旧需求", async () => {
	const sb = await sandbox();
	try {
		const { service, state } = serviceFor(sb, { settings: allowedSettings(sb), session: sessionPort({ cwd: sb.workspaceA }) });
		const pending = service.listTasks({ ...claim(), projectId: sb.projectA.projectId });
		// 读取途中撤权：清空项目授权（列表返回前必须重新检查）。
		state.settings = { ...allowedSettings(sb), authorizedProjectIds: [] };
		const result = await pending;
		assert.equal(result.items.length, 0, `撤权后不得返回旧任务：${JSON.stringify(result.items).slice(0, 200)}`);
		assert.match(result.gap ?? "", /已变化|授权/, "必须给出受控缺口原因");

		// 正对照：不改配置时确实列出任务（避免"全空"被当成通过）。
		state.settings = allowedSettings(sb);
		const positive = await service.listTasks({ ...claim(), projectId: sb.projectA.projectId });
		assert.equal(positive.gap, null);
		assert.deepEqual(
			positive.items.map((task) => task.taskId),
			["task-r33"],
		);
		assert.equal(positive.items[0].requirement, SECRET, "本地展示可见需求正文");
	} finally {
		await sb.cleanup();
	}
});

test("R33-2：预览在读取途中收窄（allowed→denied 且清空授权）⇒ 正文作废且 maySendToModel=false", async () => {
	const sb = await sandbox();
	try {
		const { service, state } = serviceFor(sb, { settings: allowedSettings(sb), session: sessionPort({ cwd: sb.workspaceA }) });
		const pending = service.preview({ ...claim(), projectId: sb.projectA.projectId, taskId: "task-r33", workspaceId: sb.projectA.workspaceId });
		state.settings = { ...allowedSettings(sb), authorizedProjectIds: [], endpoint: "denied" };
		const result = await pending;
		assert.equal(result.stable, false, "配置变了必须标为不稳定");
		assert.equal(result.maySendToModel, false);
		assert.ok(!result.text.includes(SECRET), `收窄后不得返回旧正文：${result.text.slice(0, 300)}`);
		assert.match(result.text, /已作废/);

		// 正对照：允许 + 身份可用 ⇒ 真的读到正文且可发送。
		state.settings = allowedSettings(sb);
		const positive = await service.preview({ ...claim(), projectId: sb.projectA.projectId, taskId: "task-r33", workspaceId: sb.projectA.workspaceId });
		assert.equal(positive.stable, true);
		assert.equal(positive.identityUsable, true);
		assert.equal(positive.maySendToModel, true, "allowed + 身份可用时必须可发送（否则全撤回会被误当安全）");
		assert.ok(positive.text.includes(SECRET));
	} finally {
		await sb.cleanup();
	}
});

test("R33-2：身份不可用时 maySendToModel=false（正文撤回），但不能把所有 incomplete 一刀切", async () => {
	const sb = await sandbox();
	try {
		// 会话目录在 ws-b，而任务绑定 ws-a ⇒ 身份不可用。
		const service = serviceFor(sb, { settings: allowedSettings(sb), session: sessionPort({ cwd: sb.workspaceB }) }).service;
		const settings = allowedSettings(sb);
		// 预览路径本身会被目录授权挡住；这里直接构造"授权目录含 ws-b"的场景，观察身份闸门结果。
		const viaPort = new BiosKnowledgeService({
			readSettings: () => ({ ...settings, authorizedRoots: [sb.workspaceB] }),
			session: sessionPort({ cwd: sb.workspaceB }),
			now: () => NOW,
		});
		const result = await viaPort.preview({ ...claim(), projectId: sb.projectA.projectId, taskId: "task-r33", workspaceId: sb.projectA.workspaceId });
		assert.equal(result.identityUsable, false, "工作区不在会话授权范围 ⇒ 身份不可用");
		assert.equal(result.maySendToModel, false, "身份不可用时发送标志必须为 false");
		assert.ok(!result.text.includes(SECRET));

		// 反向：身份可用但状态 incomplete（例：HEAD 不是实时观察）仍然可发送——"不一刀切"。
		const usable = serviceFor(sb, { settings: allowedSettings(sb), session: sessionPort({ cwd: sb.workspaceA }) }).service;
		const incomplete = await usable.preview({ ...claim(), projectId: sb.projectA.projectId, taskId: "task-r33", workspaceId: sb.projectA.workspaceId });
		assert.equal(incomplete.identityUsable, true);
		if (incomplete.status === "incomplete") assert.equal(incomplete.maySendToModel, true, "incomplete 但身份/端点可用时必须可发送");
	} finally {
		await sb.cleanup();
	}
});

/* ------------------------------------------------------------ R33-4：硬上限 */

test("R33-4：12,000 字符 / 24 KiB 是共享硬上限，参数只能收紧", () => {
	const over = resolveModelBudget({ maxChars: 100_000, maxBytes: 10 * 1024 * 1024 });
	assert.equal(over.maxChars, MODEL_CONTENT_MAX_CHARS);
	assert.equal(over.maxBytes, MODEL_CONTENT_MAX_BYTES);
	assert.equal(over.clamped, true, "超限必须如实标记 clamped");
	const tightened = resolveModelBudget({ maxChars: 500, maxBytes: 1_024 });
	assert.deepEqual(tightened, { maxChars: 500, maxBytes: 1_024, clamped: false });
	for (const invalid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
		assert.throws(() => resolveModelBudget({ maxChars: invalid }), /正整数/, `${invalid} 必须被拒绝`);
	}
});

test("R33-4：桌面预览守 12,000 字符与 24 KiB（超限夹紧，极小值不越限，Unicode 按字符）", async () => {
	const sb = await sandbox();
	try {
		const service = serviceFor(sb, { settings: allowedSettings(sb), session: sessionPort({ cwd: sb.workspaceA }) }).service;
		// 单条需求有 8,000 字符上限，因此用**多条**合法需求把总量推到 12,000 以上（触顶靠总量而不是超长单条）。
		const { createFeature } = await import("../packages/bios-agent/core/knowledge/index.ts");
		for (let index = 0; index < 3; index += 1) {
			await createFeature({
				root: sb.root,
				feature: { featureId: `feat-r33-long-${index}`, originalRequirement: `汉${index}${"长".repeat(6_000)}`, aliases: [`r33long${index}`], customer: { value: "customer-alpha", status: "confirmed" }, productLine: { value: "line-x", status: "confirmed" }, acceptanceCriteria: [], relatedExperienceIds: [] },
				now: NOW + 5 + index,
			});
		}

		const over = await service.preview({ ...claim(), projectId: sb.projectA.projectId, taskId: "task-r33", workspaceId: sb.projectA.workspaceId, budgetChars: 100_000 });
		assert.equal(over.budget.maxChars, MODEL_CONTENT_MAX_CHARS, "超限必须夹紧到 12,000");
		assert.equal(over.budget.clamped, true);
		assert.ok([...over.text].length <= MODEL_CONTENT_MAX_CHARS, `字符上限被突破：${[...over.text].length}`);
		assert.ok(Buffer.byteLength(over.text, "utf8") <= MODEL_CONTENT_MAX_BYTES, "字节上限被突破");

		for (const budgetChars of [1, 10, 20, 999]) {
			const small = await service.preview({ ...claim(), projectId: sb.projectA.projectId, taskId: "task-r33", workspaceId: sb.projectA.workspaceId, budgetChars });
			assert.ok([...small.text].length <= budgetChars, `预算 ${budgetChars} 下越限：${[...small.text].length}`);
			assert.ok(Buffer.byteLength(small.text, "utf8") <= MODEL_CONTENT_MAX_BYTES);
		}

		// 元数据另设限额：来源清单被裁剪但总数可读。
		assert.ok(over.retainedSources.length <= 6, "结构化元数据必须另设限额");
		assert.equal(typeof over.retainedSourceCount, "number");
		assert.equal(typeof over.sourcesTruncated, "boolean");
	} finally {
		await sb.cleanup();
	}
});

/* ------------------------------------------------------------ R33-3：生命周期 */

test("R33-3：写配置会丢弃非法目录根、标记运行中会话待重启，并按会话登记选择", async () => {
	const sb = await sandbox();
	try {
		const { service, state } = serviceFor(sb, { settings: allowedSettings(sb), session: sessionPort({ cwd: sb.workspaceA, receipt: "已选择任务 task-r33（项目已授权）" }) });
		const outcome = await service.updateSettings({ ...allowedSettings(sb), authorizedRoots: [sb.workspaceA, "relative-dir"] });
		assert.deepEqual(outcome.settings.authorizedRoots, [sb.workspaceA], "非法目录根必须被丢弃");
		assert.deepEqual(outcome.droppedRoots, ["relative-dir"]);
		// R34-4：`pendingRestart` 只由**真实存在的旧许可 runtime** 决定——
		// 这个假会话端口没有 listSessions（没有已知运行中会话），因此不能凭空报"待重启"。
		assert.deepEqual(outcome.invalidated, [], "没有已知运行中会话时不应标记失效");
		assert.equal(outcome.runtime.pendingRestart, false, "没有真实旧 runtime 时不得用文案代替生效事实");
		// 有运行中会话且配置收窄时，才按 runtime 标记（详见 biosRuntimeGate.test.mjs）。
		const withSessions = serviceFor(sb, { settings: allowedSettings(sb), session: { ...sessionPort({ cwd: sb.workspaceA }), listSessions: () => [{ agentId: AGENT_ID, sessionId: "session-a", generation: 3 }] } }).service;
		const narrowed = await withSessions.updateSettings({ ...allowedSettings(sb), authorizedRoots: [] });
		assert.deepEqual(narrowed.invalidated, [`${AGENT_ID}@3`]);
		assert.equal(narrowed.runtime.pendingRestart, true);
		assert.match(narrowed.runtime.note ?? "", /已停止|停止失败|无法确认/);

		// 有命令通道 + 回执 ⇒ rpc，并声称当前会话已同步；没有回执 ⇒ env 且不得声称已同步。
		const synced = await service.applySelection({ ...claim(), projectId: sb.projectA.projectId, taskId: "task-r33", workspaceId: sb.projectA.workspaceId, contextEnabled: true });
		assert.equal(synced.mode, "rpc");
		assert.equal(synced.currentSessionSynced, true);
		assert.match(synced.receipt, /已同步到当前会话/);

		const withoutReceipt = serviceFor(sb, { settings: allowedSettings(sb), session: sessionPort({ cwd: sb.workspaceA, receipt: null }) }).service;
		const queued = await withoutReceipt.applySelection({ ...claim(), projectId: sb.projectA.projectId, taskId: "task-r33", workspaceId: sb.projectA.workspaceId, contextEnabled: true });
		assert.equal(queued.mode, "env", "拿不到回执只能说明待启动生效");
		assert.equal(queued.currentSessionSynced, false, "不得把待启动生效冒充当前会话已生效");
		assert.match(queued.receipt, /当前会话未同步/);

		// 未授权项目 / 假身份：不采纳，也不写选择。
		const rejected = await service.applySelection({ ...claim(), projectId: sb.projectB.projectId, taskId: "task-r33", workspaceId: null, contextEnabled: true });
		assert.equal(rejected.applied, false);
		assert.equal(rejected.reason, "project-unauthorized");
		const ghost = await service.applySelection({ sessionRef: { agentId: "ghost", sessionId: null }, runtimeGeneration: 3, projectId: sb.projectA.projectId, taskId: "task-r33", workspaceId: null, contextEnabled: true });
		assert.equal(ghost.mode, "none");
		assert.equal(ghost.applied, false);
		assert.equal(state.settings.knowledgeRoot, sb.root, "拒绝路径不改动可信配置");
	} finally {
		await sb.cleanup();
	}
});

test("R33-3：两会话注入环境互不沿用（PiProcess 用本会话 sessionId 取选择）", () => {
	const settings = normalizeBiosHostSettings({ knowledgeRoot: "C:/kb", authorizedProjectIds: ["p1"], endpoint: "allowed", authorizedRoots: ["C:/ws"] });
	const stored = {
		bySession: {
			"session-a": { projectId: "p-a", taskId: "t-a", workspaceId: "w-a", contextEnabled: true, updatedAt: 1 },
			"session-b": { projectId: "p-b", taskId: "t-b", workspaceId: "w-b", contextEnabled: false, updatedAt: 1 },
		},
		bootId: currentBiosBootId(),
	};
	const envA = applyBiosEnv({}, settings, resolveSessionSelection(stored, currentBiosBootId(), "session-a"));
	assert.equal(envA.BIOS_SELECTED_TASK_ID, "t-a");
	assert.equal(envA.BIOS_CONTEXT_ENABLED, "1");
	const envB = applyBiosEnv({}, settings, resolveSessionSelection(stored, currentBiosBootId(), "session-b"));
	assert.equal(envB.BIOS_SELECTED_TASK_ID, "t-b");
	assert.equal(envB.BIOS_CONTEXT_ENABLED, "0");
	const envC = applyBiosEnv({}, settings, resolveSessionSelection(stored, currentBiosBootId(), "session-c"));
	assert.equal(envC.BIOS_SELECTED_TASK_ID, "", "第三个会话不得沿用别人的任务");
	assert.equal(envC.BIOS_CONTEXT_ENABLED, "0");
});
