/**
 * AW：默认自主工作流的定向测试。
 *
 * 覆盖五个层面，每层都尽量用**独立观察**（直接读磁盘 / 真实 Pi 加载器）：
 * 1. 纯策略：意图粗分类、补记预算上限、检查点保留策略、保存状态投影、续接决策；
 * 2. 附属记录存储：真实临时知识根下的幂等创建、CAS 冲突、未知版本拒写、路径注入拒绝；
 * 3. working 用途：只读精确工作区的 draft，未授权不泄漏标题/计数，deprecated 不复活；
 * 4. 摘要扫描：真实 Git 基线 + EDK II 解析候选，基线未变则跳过重扫；
 * 5. 扩展行为：宿主许可解析、项目级许可不再逐会话确认、`/bios-workflow off` 后不自动重授权。
 *
 * 纪律：不读任何真实知识库/客户源码；不使用脚本 SSE 冒充真实模型决策。
 */
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { initializeKnowledgeStore } from "../core/storage/index.ts";
import { bindProjectWorkspace } from "../core/projects/index.ts";
import { createExperienceDraft } from "../core/knowledge/experiences.ts";
import { reviewExperience } from "../core/knowledge/experiences.ts";
import { classifyRequestIntent, projectSaveStatus, resolveRetrievalPlan, shouldRequestReflection, hasUnsavedProgress } from "../core/automation/policy.ts";
import { decideContinuation } from "../core/automation/resume.ts";
import { initialWorkspaceState, planCheckpointIndex, publishCheckpoint, readCheckpoint, readWorkspaceState, writeWorkspaceState } from "../core/automation/store.ts";
import { searchWorkingMemory, renderWorkingLeads } from "../core/automation/working.ts";
import { scanProjectSummary, toSummaryBaseline } from "../core/automation/summary.ts";
import { AUTOMATION_LIMITS, stableRunId } from "../core/automation/contract.ts";
import { createProjectSandbox, writeDsc, initGitRepo, gitAvailable, git } from "./helpers/projectFixtures.mjs";
import { loadBiosExtension, toolOf, commandOf } from "./helpers/biosExtension.mjs";
import { resetAutomationSession } from "../extensions/automationState.ts";

/* ------------------------------------------------------------ 1. 纯策略 */

test("AW 意图粗分类：寒暄不准备背景，工程词命中工程请求，其余交给模型", () => {
	assert.equal(classifyRequestIntent("你好").intent, "greeting");
	assert.equal(classifyRequestIntent("thanks!").intent, "greeting");
	assert.equal(classifyRequestIntent("帮我分析 USB 速度为什么只有 USB 2.0，先不要修改代码").intent, "engineering");
	assert.equal(classifyRequestIntent("investigate why the board hangs at POST").intent, "engineering");
	assert.equal(classifyRequestIntent("什么是 UEFI").intent, "conceptual");
	assert.equal(classifyRequestIntent("今天天气不错").intent, "unclear");
});

test("AW 补记预算：每个原始请求最多一次阶段；结局/取消/撤权/已标记/写入上限都不发总结模型", () => {
	const base = { budget: { requestKey: "r", stagesRequested: 0, providerRequests: 0, writeCalls: 0 }, pending: true, aborted: false, scopeStable: true, alreadyMarked: false, outcome: "completed" };
	assert.equal(shouldRequestReflection(base).request, true);
	assert.equal(shouldRequestReflection({ ...base, pending: false }).request, false);
	assert.equal(shouldRequestReflection({ ...base, aborted: true }).request, false);
	assert.equal(shouldRequestReflection({ ...base, scopeStable: false }).request, false);
	assert.equal(shouldRequestReflection({ ...base, alreadyMarked: true }).request, false);
	// R3：settled outcome 参与门禁——取消/模型错误不算"正常完成"。
	assert.equal(shouldRequestReflection({ ...base, outcome: "aborted" }).request, false);
	assert.equal(shouldRequestReflection({ ...base, outcome: "error" }).request, false);
	assert.equal(shouldRequestReflection({ ...base, budget: { ...base.budget, stagesRequested: AUTOMATION_LIMITS.maxReflectionStagesPerRequest } }).request, false);
	assert.equal(shouldRequestReflection({ ...base, budget: { ...base.budget, providerRequests: AUTOMATION_LIMITS.maxReflectionProviderRequests } }).request, false);
	// R3：写入上限必须在决策里就生效（旧实现 writeCalls=999 仍然请求补记）。
	assert.equal(shouldRequestReflection({ ...base, budget: { ...base.budget, writeCalls: AUTOMATION_LIMITS.maxReflectionWriteCalls } }).request, false);
	assert.equal(shouldRequestReflection({ ...base, budget: { ...base.budget, writeCalls: 999 } }).request, false);
});

test("AW 只读调查也算未保存进展；只有**真实落盘**的 BIOS 保存才算已保存", () => {
	assert.equal(hasUnsavedProgress([]), false);
	assert.equal(hasUnsavedProgress([{ tool: "grep", outcome: "ok", files: [], wrote: false }]), true);
	// R6：`isError=false` 但业务状态是 declined/stale 等结构化失败时，不算已保存。
	assert.equal(
		hasUnsavedProgress([
			{ tool: "read", outcome: "ok", files: [], wrote: false },
			{ tool: "bios_manage_task", outcome: "ok", files: [], wrote: false, businessStatus: "declined" },
		]),
		true,
	);
	assert.equal(
		hasUnsavedProgress([
			{ tool: "read", outcome: "ok", files: [], wrote: false },
			{ tool: "bios_manage_task", outcome: "ok", files: [], wrote: false, businessStatus: "created" },
		]),
		false,
	);
	assert.equal(
		hasUnsavedProgress([
			{ tool: "read", outcome: "ok", files: [], wrote: false },
			{ tool: "bios_save_experience_draft", outcome: "ok", files: [], wrote: false, businessStatus: "unchanged" },
		]),
		false,
	);
	assert.equal(hasUnsavedProgress([{ tool: "read", outcome: "error", files: [], wrote: false }]), false);
});

test("AW 检查点保留策略：待补记/受保护记录不被轮换，占满预算时停止新增", () => {
	const made = (index, pending = false) => ({ runId: `run-${index}`, recordedAt: index, taskId: null, pendingReflection: pending, protectedFromRotation: pending });
	const existing = Array.from({ length: 3 }, (_, index) => made(index));
	const small = planCheckpointIndex({ existing, next: made(99), max: 3 });
	assert.equal(small.status, "ok");
	assert.equal(small.refs[0]?.runId, "run-99");
	assert.deepEqual(small.rotatedOut, ["run-2"]);

	// 三个受保护记录占满 3 格：新记录放不进去 ⇒ full，且不删除任何受保护记录。
	const protectedExisting = Array.from({ length: 3 }, (_, index) => made(index, true));
	const full = planCheckpointIndex({ existing: protectedExisting, next: made(99), max: 3 });
	assert.equal(full.status, "full");
	assert.equal(full.refs.length, 3);
	assert.equal(full.rotatedOut.length, 0);
	assert.ok(!full.refs.some((ref) => ref.runId === "run-99"), "full 时不得把新记录算进集合（否则会出现孤儿文件）");

	// R6 反例：50 条受保护 + 再一条受保护 ⇒ 仍然必须 full，且集合不超过上限。
	const fiftyProtected = Array.from({ length: 50 }, (_, index) => made(index, true));
	const overBudget = planCheckpointIndex({ existing: fiftyProtected, next: made(50, true) });
	assert.equal(overBudget.status, "full");
	assert.equal(overBudget.refs.length, 50);
	assert.ok(!overBudget.refs.some((ref) => ref.runId === "run-50"));
});

test("AW 保存状态投影：经验已保存但回链失败不整体报未保存", () => {
	assert.equal(projectSaveStatus({ automationEnabled: false, checkpoint: "none", progress: "none", draft: "none", link: "none", pendingReflection: false }).status, "automation-off");
	assert.equal(projectSaveStatus({ automationEnabled: true, checkpoint: "ok", progress: "ok", draft: "ok", link: "failed", pendingReflection: false }).status, "partial");
	assert.equal(projectSaveStatus({ automationEnabled: true, checkpoint: "ok", progress: "ok", draft: "ok", link: "failed", pendingReflection: false }).note, "经验已保存，任务关联待重试");
	assert.equal(projectSaveStatus({ automationEnabled: true, checkpoint: "none", progress: "none", draft: "none", link: "none", pendingReflection: true }).status, "pending-reflection");
	assert.equal(projectSaveStatus({ automationEnabled: true, checkpoint: "failed", progress: "none", draft: "none", link: "none", pendingReflection: false }).status, "save-failed");
});

test("AW 检索预算只能收紧，不能放大既有上限", () => {
	const widened = resolveRetrievalPlan({ maxLeads: 999, maxProjectLeads: 999, maxDetailReads: 999, maxCommits: 999 });
	assert.equal(widened.maxLeads, AUTOMATION_LIMITS.maxWorkingLeads);
	assert.equal(widened.maxProjectLeads, AUTOMATION_LIMITS.maxProjectLeads);
	assert.equal(widened.maxDetailReads, AUTOMATION_LIMITS.maxDetailReads);
	const tightened = resolveRetrievalPlan({ maxLeads: 2 });
	assert.equal(tightened.maxLeads, 2);
});

test("AW 续接决策：唯一进行中可续接，多任务询问，done 只作历史，列表不完整不猜", () => {
	const task = (taskId, status) => ({ taskId, revision: 1, status, requirement: `req-${taskId}` });
	assert.equal(decideContinuation({ tasks: [task("t1", "in_progress")], incomplete: false }).kind, "resume");
	assert.equal(decideContinuation({ tasks: [task("t1", "in_progress"), task("t2", "in_progress")], incomplete: false }).kind, "choose");
	assert.equal(decideContinuation({ tasks: [task("t1", "planned")], incomplete: false }).kind, "ask-planned");
	assert.equal(decideContinuation({ tasks: [task("t1", "done")], incomplete: false }).kind, "history");
	assert.equal(decideContinuation({ tasks: [task("t1", "in_progress")], incomplete: true }).kind, "incomplete");
	assert.equal(decideContinuation({ tasks: [], incomplete: false }).kind, "none");
});

/* --------------------------------------------------- 2. 附属记录存储 */

async function storeFixture(prefix = "aw-store-") {
	const sandbox = await createProjectSandbox(prefix);
	await initializeKnowledgeStore({ root: sandbox.root });
	const bound = await bindProjectWorkspace({ root: sandbox.root, cwd: sandbox.workspaceA, workspacePath: sandbox.workspaceA });
	return { ...sandbox, ...bound, cleanup: sandbox.cleanup };
}

function checkpoint(runId, overrides = {}) {
	return {
		version: 1,
		runId,
		projectId: "p",
		workspaceId: "w",
		sessionId: "s",
		branch: "main",
		requestKey: "r",
		recordedAt: 1,
		baseline: { workspacePath: "x", branch: "main", commit: null, fileHashes: {}, capturedAt: 1 },
		executed: [],
		changedFiles: [],
		task: null,
		outcome: "in-progress",
		pendingReflection: false,
		...overrides,
	};
}

test("AW 检查点：真实写入知识根 automation/ 下，重复回调幂等且不覆盖", async () => {
	const fixture = await storeFixture();
	try {
		const target = { root: fixture.root, projectId: fixture.projectId, workspaceId: fixture.workspaceId };
		const first = await publishCheckpoint({ ...target, checkpoint: checkpoint("run-abc") });
		assert.equal(first.status, "created", JSON.stringify(first));
		const again = await publishCheckpoint({ ...target, checkpoint: checkpoint("run-abc", { outcome: "error" }) });
		assert.equal(again.status, "unchanged");
		const read = await readCheckpoint({ ...target, runId: "run-abc" });
		assert.equal(read.status, "ok");
		// 幂等证据：磁盘上仍是第一次写入的 outcome。
		assert.equal(read.value.outcome, "in-progress");
		const onDisk = JSON.parse(await readFile(join(fixture.root, "automation", "workspaces", fixture.workspaceId, "checkpoints", "run-abc.json"), "utf8"));
		assert.equal(onDisk.version, 1);
		assert.equal(onDisk.outcome, "in-progress");
	} finally {
		await fixture.cleanup();
	}
});

test("AW 状态 CAS：旧 revision 不覆盖新状态；未知版本拒写且保留原字节", async () => {
	const fixture = await storeFixture();
	try {
		const target = { root: fixture.root, projectId: fixture.projectId, workspaceId: fixture.workspaceId };
		const empty = initialWorkspaceState({ projectId: fixture.projectId, workspaceId: fixture.workspaceId, now: 1 });
		const created = await writeWorkspaceState({ ...target, state: empty, expectedRevision: null });
		assert.equal(created.status, "created");
		const updated = await writeWorkspaceState({ ...target, state: { ...empty, summaryBaseline: null }, expectedRevision: created.revision });
		assert.equal(updated.status, "updated");
		// 用旧 revision 再写一次：必须冲突，不覆盖。
		const stale = await writeWorkspaceState({ ...target, state: empty, expectedRevision: created.revision });
		assert.equal(stale.status, "revision-conflict");

		// 未来版本：拒写并保留原字节。
		const statePath = join(fixture.root, "automation", "workspaces", fixture.workspaceId, "state.json");
		const future = `${JSON.stringify({ version: 99, revision: 0, workspaceId: fixture.workspaceId }, null, "\t")}\n`;
		await writeFile(statePath, future, "utf8");
		const refused = await writeWorkspaceState({ ...target, state: empty, expectedRevision: 0 });
		assert.equal(refused.status, "unsupported-version");
		assert.equal(await readFile(statePath, "utf8"), future);
		assert.equal((await readWorkspaceState(target)).status, "unsupported-version");
	} finally {
		await fixture.cleanup();
	}
});

test("AW 存储边界：非法工作区 ID / 运行 ID 直接拒绝，不拼出根外路径", async () => {
	const fixture = await storeFixture();
	try {
		const target = { root: fixture.root, projectId: fixture.projectId };
		await assert.rejects(() => publishCheckpoint({ ...target, workspaceId: "../escape", checkpoint: checkpoint("run-1") }));
		await assert.rejects(() => publishCheckpoint({ ...target, workspaceId: fixture.workspaceId, checkpoint: checkpoint("../../etc/passwd") }));
	} finally {
		await fixture.cleanup();
	}
});

/* ------------------------------------------------------- 3. working 用途 */

async function workingFixture() {
	const sandbox = await createProjectSandbox("aw-working-");
	await initializeKnowledgeStore({ root: sandbox.root });
	const bound = await bindProjectWorkspace({ root: sandbox.root, cwd: sandbox.workspaceA, workspacePath: sandbox.workspaceA });
	const draft = {
		experienceId: "exp-usb-speed",
		problem: "USB 端口只跑 USB 2.0 速度",
		rootCause: "样例合成根因，尚未确认",
		solution: "样例合成方案",
		appliesWhen: ["目标平台 UEFI"],
		sourceProjectId: bound.projectId,
		evidence: [{ type: "source-file", workspaceId: bound.workspaceId, relativePath: "Sample.dsc", contentHash: "0".repeat(64) }],
		reuse: { level: "current-project" },
	};
	await createExperienceDraft({ root: sandbox.root, authorizedProjectIds: [bound.projectId], experience: draft });
	return { ...sandbox, ...bound, cleanup: sandbox.cleanup };
}

test("AW working：只读精确工作区的 draft，标记未验证，未授权不泄漏标题", async () => {
	const fixture = await workingFixture();
	try {
		const result = await searchWorkingMemory({ root: fixture.root, projectId: fixture.projectId, workspaceId: fixture.workspaceId, taskId: null, query: "USB 速度 为什么只有 USB 2.0", authorizedProjectIds: [fixture.projectId] });
		assert.equal(result.status, "ok", JSON.stringify(result));
		assert.equal(result.leads.length, 1);
		assert.equal(result.leads[0].recordId, "exp-usb-speed");
		assert.equal(result.leads[0].verification, "unverified");
		const rendered = renderWorkingLeads(result);
		assert.match(rendered, /未验证/);

		// 未授权：不返回标题/计数。
		const denied = await searchWorkingMemory({ root: fixture.root, projectId: fixture.projectId, workspaceId: fixture.workspaceId, taskId: null, query: "USB", authorizedProjectIds: [] });
		assert.equal(denied.status, "denied");
		assert.equal(denied.leads.length, 0);
		assert.doesNotMatch(renderWorkingLeads(denied), /USB 端口只跑/);

		// 另一个工作区不进入 working（精确工作区）。
		const otherWorkspace = await searchWorkingMemory({ root: fixture.root, projectId: fixture.projectId, workspaceId: fixture.workspaceB, taskId: null, query: "USB 速度", authorizedProjectIds: [fixture.projectId] });
		assert.equal(otherWorkspace.leads.length, 0);
	} finally {
		await fixture.cleanup();
	}
});

test("AW working：已审核/已退出经验不借 working 重新成为当前事实", async () => {
	const fixture = await workingFixture();
	try {
		// 提交审核（draft → reviewed）→ 不再属于 working 的 draft 用途。
		await reviewExperience({ root: fixture.root, experienceId: "exp-usb-speed", expectedRevision: 0, action: "submit-review", operatorLabel: "fixture", reason: "synthetic", authorizedProjectIds: [fixture.projectId] });
		const result = await searchWorkingMemory({ root: fixture.root, projectId: fixture.projectId, workspaceId: fixture.workspaceId, taskId: null, query: "USB 速度", authorizedProjectIds: [fixture.projectId] });
		assert.equal(result.leads.length, 0, `reviewed 卡不得进入 working：${JSON.stringify(result.leads)}`);
	} finally {
		await fixture.cleanup();
	}
});

/* --------------------------------------------------------- 4. 摘要扫描 */

test("AW 摘要扫描：真实 Git 基线 + EDK II 候选；基线未变时跳过重扫", { skip: gitAvailable() ? false : "本机没有 git 可用" }, async () => {
	const sandbox = await createProjectSandbox("aw-summary-");
	try {
		await initializeKnowledgeStore({ root: sandbox.root });
		const bound = await bindProjectWorkspace({ root: sandbox.root, cwd: sandbox.workspaceA, workspacePath: sandbox.workspaceA });
		await writeDsc(sandbox.workspaceA, "SamplePkg/Sample.dsc", { platformName: "SyntheticAwPlatform", include: "SamplePkg/Sample.dec", extra: ["  # Aptio-like marker for clue scan"] });
		await initGitRepo(sandbox.workspaceA, "aw-summary-first");
		const head = git(sandbox.workspaceA, ["rev-parse", "HEAD"]).trim();
		const first = await scanProjectSummary({ workspacePath: sandbox.workspaceA, workspaceId: bound.workspaceId, cwd: sandbox.workspaceA, authorizedRoots: [sandbox.workspaceA] });
		assert.ok(first.status === "ok" || first.status === "partial", `首次扫描应可用，实际 ${first.status}：${first.problems.join("；")}`);
		assert.equal(first.baseline.commit, head);
		assert.ok(
			first.candidates.some((candidate) => candidate.field === "buildTargets" && candidate.value === "SyntheticAwPlatform"),
			JSON.stringify(first.candidates),
		);
		// 线索是弱证据，不能是 confirmed。
		assert.ok(first.clues.every((clue) => clue.strength === "clue"));

		const second = await scanProjectSummary({
			workspacePath: sandbox.workspaceA,
			workspaceId: bound.workspaceId,
			cwd: sandbox.workspaceA,
			authorizedRoots: [sandbox.workspaceA],
			previous: toSummaryBaseline({ baseline: first.baseline, candidates: first.candidates, truncated: first.truncated, clues: first.clues, gaps: first.gaps }),
		});
		assert.equal(second.status, "unchanged");
		assert.equal(second.candidates.length, 0);
		// R7：unchanged 时**必须**把上一轮有界候选交回（否则下一对话拿不到有证据背景）。
		assert.ok(second.reused !== null, "unchanged 必须带回可复用候选");
		assert.ok(
			second.reused.candidates.some((candidate) => candidate.value === "SyntheticAwPlatform"),
			JSON.stringify(second.reused),
		);

		// R7：HEAD 未变但**相关文件内容变化**（脏工作树）也必须重扫。
		await writeDsc(sandbox.workspaceA, "SamplePkg/Sample.dsc", { platformName: "SyntheticAwPlatformDirty" });
		const dirty = await scanProjectSummary({
			workspacePath: sandbox.workspaceA,
			workspaceId: bound.workspaceId,
			cwd: sandbox.workspaceA,
			authorizedRoots: [sandbox.workspaceA],
			previous: toSummaryBaseline({ baseline: first.baseline, candidates: first.candidates, truncated: first.truncated, clues: first.clues, gaps: first.gaps }),
		});
		assert.notEqual(dirty.status, "unchanged", "相关文件内容变化时不得沿用旧候选");
		assert.ok(
			dirty.candidates.some((candidate) => candidate.value === "SyntheticAwPlatformDirty"),
			JSON.stringify(dirty.candidates),
		);

		// HEAD 变化后必须重扫。
		await writeDsc(sandbox.workspaceA, "SamplePkg/Other.dsc", { platformName: "SyntheticAwPlatform2" });
		git(sandbox.workspaceA, ["add", "-A"]);
		git(sandbox.workspaceA, ["commit", "-q", "-m", "second"]);
		const third = await scanProjectSummary({
			workspacePath: sandbox.workspaceA,
			workspaceId: bound.workspaceId,
			cwd: sandbox.workspaceA,
			authorizedRoots: [sandbox.workspaceA],
			previous: toSummaryBaseline({ baseline: first.baseline, candidates: first.candidates, truncated: first.truncated, clues: first.clues, gaps: first.gaps }),
		});
		assert.notEqual(third.status, "unchanged");
		assert.ok(
			third.candidates.some((candidate) => candidate.value === "SyntheticAwPlatform2"),
			JSON.stringify(third.candidates),
		);
	} finally {
		await sandbox.cleanup();
	}
});

test("AW 稳定运行 ID：同输入同结果、不同输入不同结果（幂等与去重的基础）", () => {
	assert.equal(stableRunId(["s", "main", "req"]), stableRunId(["s", "main", "req"]));
	assert.notEqual(stableRunId(["s", "main", "req"]), stableRunId(["s", "main", "req2"]));
	assert.notEqual(stableRunId(["s1", "main", "req"]), stableRunId(["s2", "main", "req"]));
});

/* --------------------------------------------------------- 5. 扩展行为 */

function withEnv(overrides) {
	const previous = { ...process.env };
	for (const key of Object.keys(process.env)) if (key.startsWith("BIOS_")) delete process.env[key];
	Object.assign(process.env, overrides);
	return () => {
		for (const key of Object.keys(process.env)) if (key.startsWith("BIOS_")) delete process.env[key];
		for (const [key, value] of Object.entries(previous)) if (key.startsWith("BIOS_")) process.env[key] = value;
	};
}

async function extensionFixture(automationEnv) {
	// 模块级会话状态在同一进程内跨测试共享：每个夹具都显式重置，避免上一个用例的撤回/许可泄漏。
	resetAutomationSession();
	const sandbox = await createProjectSandbox("aw-ext-");
	await initializeKnowledgeStore({ root: sandbox.root });
	const bound = await bindProjectWorkspace({ root: sandbox.root, cwd: sandbox.workspaceA, workspacePath: sandbox.workspaceA });
	const loaded = await loadBiosExtension();
	loaded.runtime.sendMessage = async () => {};
	const restore = withEnv({
		BIOS_KNOWLEDGE_ROOT: sandbox.root,
		BIOS_AUTHORIZED_PROJECTS: bound.projectId,
		BIOS_AUTHORIZED_ROOTS: sandbox.workspaceA,
		BIOS_ENDPOINT: "allowed",
		...automationEnv,
	});
	let confirmations = 0;
	const ctx = {
		cwd: sandbox.workspaceA,
		sessionManager: { getSessionId: () => "aw-session" },
		hasUI: true,
		ui: {
			confirm: async () => {
				confirmations += 1;
				return true;
			},
		},
	};
	let callId = 0;
	const createTask = () => toolOf(loaded.extension, "bios_manage_task").execute(`aw-${++callId}`, { action: "create", requirement: "AW synthetic engineering request" }, undefined, undefined, ctx);
	return {
		...sandbox,
		...bound,
		extension: loaded.extension,
		ctx,
		createTask,
		get confirmations() {
			return confirmations;
		},
		afterOff: () => commandOf(loaded.extension, "bios-workflow")("off", ctx),
		async cleanup() {
			restore();
			loaded.cleanup();
			await sandbox.cleanup();
		},
	};
}

test("AW 宿主许可解析：缺省全关；显式开启才生效，版本非法按 0", async () => {
	const { readAutomationCapability } = await import("../extensions/hostConfig.ts");
	assert.deepEqual(readAutomationCapability({}), { enabled: false, localBookkeeping: false, injectProjectData: false, version: 0 });
	assert.deepEqual(readAutomationCapability({ BIOS_AUTOMATION_ENABLED: "1" }), { enabled: true, localBookkeeping: false, injectProjectData: false, version: 1 });
	assert.deepEqual(readAutomationCapability({ BIOS_AUTOMATION_ENABLED: "1", BIOS_AUTOMATION_BOOKKEEPING: "1", BIOS_AUTOMATION_VERSION: "7" }), { enabled: true, localBookkeeping: true, injectProjectData: false, version: 7 });
	assert.equal(readAutomationCapability({ BIOS_AUTOMATION_ENABLED: "0", BIOS_AUTOMATION_BOOKKEEPING: "1" }).enabled, false);
	assert.equal(readAutomationCapability({ BIOS_AUTOMATION_ENABLED: "1", BIOS_AUTOMATION_VERSION: "abc" }).version, 1);
});

test("AW 项目级许可：开启普通记账后不再逐会话确认；关闭时仍走既有会话确认", async () => {
	const off = await extensionFixture({});
	try {
		await off.createTask();
		assert.ok(off.confirmations >= 1, "未开启自动化时必须走既有会话确认（保持旧行为）");
	} finally {
		await off.cleanup();
	}

	const on = await extensionFixture({ BIOS_AUTOMATION_ENABLED: "1", BIOS_AUTOMATION_BOOKKEEPING: "1", BIOS_AUTOMATION_VERSION: "1" });
	try {
		const created = await on.createTask();
		assert.equal(on.confirmations, 0, "宿主项目级许可下不应再弹会话确认");
		assert.equal(created.details.status, "created", JSON.stringify(created.details));
		// `/bios-workflow off` 之后本会话内不得自动重新授权。
		await on.afterOff();
		const afterOff = await on.createTask();
		assert.notEqual(afterOff.details.status, "created");
		assert.equal(on.confirmations, 0, "off 后仍不应弹确认（应为未授权而不是重新弹窗）");
	} finally {
		await on.cleanup();
	}
});
