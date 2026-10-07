/**
 * AW-02/03/05/06 生命周期回归：**真实 Pi AgentSession + 本机回环 provider**。
 *
 * 与 `automationWorkflow.test.mjs`（纯策略/存储）互补：这里证明钩子真的接在 Pi 生命周期上——
 * 用户只说一句工程问题（没有提醒"查经验/记住/保存"），扩展会
 * 自动追加系统指导、自动让模型调用 BIOS 只读工具，并把**真实执行事实**落成检查点与状态索引；
 * 未开启许可时两者都不发生（负例对照）。
 *
 * 全部离线：不联网、不读客户库、不调用真实模型。
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { initializeKnowledgeStore } from "../core/storage/index.ts";
import { bindProjectWorkspace } from "../core/projects/index.ts";
import { changeTaskStatus, createTask, updateTask } from "../core/tasks/index.ts";
import { HOST_MISSING_MESSAGE, PI_MODULE_ENTRY } from "./helpers/biosExtension.mjs";
import { withSession } from "./helpers/piSessionHarness.mjs";
import { createProjectSandbox, writeDsc } from "./helpers/projectFixtures.mjs";

const MARKER = "SYNTHETIC-AW-LIFECYCLE";
const PROMPT = `${MARKER}: 分析一下这个工程为什么启动慢，先不要改代码`;

/**
 * 第一次请求让模型调用真实 BIOS 只读工具；一旦看到**工具结果消息**就只回文本。
 *
 * 不能用"消息里出现工具名"判断：系统提示本身就会列出可用工具名（会被误判成已有结果）。
 */
function script() {
	return (parsed) => {
		const hasToolResult = (parsed?.messages ?? []).some((message) => message?.role === "tool" || message?.tool_call_id !== undefined);
		return hasToolResult ? { text: `${MARKER}-RESULT: 只读调查完成` } : { toolCall: { name: "bios_get_project_info", arguments: {} } };
	};
}

async function fixture() {
	assert.ok(PI_MODULE_ENTRY, HOST_MISSING_MESSAGE);
	const sb = await createProjectSandbox("aw-lifecycle-");
	await initializeKnowledgeStore({ root: sb.root });
	await writeDsc(sb.workspaceA, "Platform/SamplePkg/Sample.dsc", { platformName: "SyntheticAwLifecycle" });
	const bound = await bindProjectWorkspace({ root: sb.root, cwd: sb.workspaceA, authorizedRoots: [sb.workspaceA], workspacePath: sb.workspaceA });
	const base = { BIOS_KNOWLEDGE_ROOT: sb.root, BIOS_AUTHORIZED_PROJECTS: bound.projectId, BIOS_AUTHORIZED_ROOTS: sb.workspaceA, BIOS_ENDPOINT: "allowed" };
	return { ...sb, ...bound, base, cleanup: sb.cleanup };
}

function automationDir(root, workspaceId) {
	return join(root, "automation", "workspaces", workspaceId);
}

function systemText(requests) {
	return JSON.stringify(requests.flatMap((request) => request.body?.messages ?? []).filter((message) => message.role === "system"));
}

test("AW 生命周期：开启许可后未提醒也会自动准备/调用工具/落盘检查点", async () => {
	const f = await fixture();
	try {
		await withSession(f, { ...f.base, BIOS_AUTOMATION_ENABLED: "1", BIOS_AUTOMATION_BOOKKEEPING: "1", BIOS_AUTOMATION_INJECT: "1", BIOS_AUTOMATION_VERSION: "1" }, script(), async ({ session, requests }) => {
			requests.length = 0;
			await session.prompt(PROMPT);
			assert.ok(requests.length >= 2, `应发生"工具调用 + 工具结果"至少两轮请求，实际 ${requests.length}`);
			// 1) 自动化指导进了系统提示。
			// （Skills 不在本夹具断言：此处 `DefaultResourceLoader` 显式 `noSkills: true`；
			//  真实加载证据在 `extensionLoad.test.mjs` 的 RPC `get_commands` 与打包态 e2e。）
			assert.ok(systemText(requests).includes("BIOS 默认自主工作流"), "开启许可后系统提示必须包含自动化指导");
			// 2) 真实执行事实被自动落盘。
			const dir = automationDir(f.root, f.workspaceId);
			assert.ok(existsSync(dir), `自动化目录必须自动出现：${dir}`);
			const files = (await readdir(join(dir, "checkpoints"))).filter((name) => name.endsWith(".json"));
			assert.ok(files.length > 0, "必须至少写入一个检查点");
			const checkpoints = [];
			for (const name of files) {
				const checkpoint = JSON.parse(await readFile(join(dir, "checkpoints", name), "utf8"));
				assert.equal(checkpoint.runId, name.replace(/\.json$/, ""), "文件名必须就是稳定运行 ID（幂等去重基础）");
				assert.equal(checkpoint.workspaceId, f.workspaceId);
				assert.equal(checkpoint.projectId, f.projectId);
				assert.equal(checkpoint.version, 1);
				checkpoints.push(checkpoint);
			}
			const tools = checkpoints.flatMap((checkpoint) => checkpoint.executed.map((fact) => fact.tool));
			assert.ok(tools.includes("bios_get_project_info"), `检查点必须记录真实工具事实：${JSON.stringify(tools)}`);
			const state = JSON.parse(await readFile(join(dir, "state.json"), "utf8"));
			assert.equal(state.version, 1);
			assert.ok(state.checkpoints.length > 0, "状态索引必须引用刚写入的检查点");
			assert.ok(
				state.checkpoints.every((ref) => files.includes(`${ref.runId}.json`)),
				"索引不得引用不存在的检查点",
			);
			// 3) 只读调查不得产生任何业务记录（未自动建任务、未自动建经验）。
			assert.ok(!existsSync(join(f.root, "projects", f.projectId, "tasks")), "只读调查不得自动创建任务");
		});
	} finally {
		await f.cleanup();
	}
});

test("R5/R7 生命周期：新对话注入真实任务进展、检查点关联任务；下一对话复用上一轮摘要候选", async () => {
	const f = await fixture();
	try {
		const taskId = "aw-r5-task";
		await createTask({ root: f.root, projectId: f.projectId, taskId, workspaceId: f.workspaceId, cwd: f.workspaceA, authorizedRoots: [f.workspaceA], authorizedProjectIds: [f.projectId], requirement: "SYNTHETIC-R5-REQUIREMENT: 修复 USB 启动失败" });
		await changeTaskStatus({ root: f.root, projectId: f.projectId, taskId, expectedRevision: 0, to: "in_progress", reason: "synthetic", authorizedProjectIds: [f.projectId] });
		await updateTask({ root: f.root, projectId: f.projectId, taskId, expectedRevision: 1, changes: { todos: ["SYNTHETIC-R5-TODO: 检查 xHCI 初始化顺序"], decisions: ["SYNTHETIC-R5-DECISION: 先只读调查"] }, authorizedProjectIds: [f.projectId] });

		const env = { ...f.base, BIOS_AUTOMATION_ENABLED: "1", BIOS_AUTOMATION_BOOKKEEPING: "1", BIOS_AUTOMATION_INJECT: "1", BIOS_AUTOMATION_VERSION: "1" };
		const text = (requests) => JSON.stringify(requests.flatMap((request) => request.body?.messages ?? []));
		await withSession(f, env, script(), async ({ session, requests }) => {
			requests.length = 0;
			await session.prompt("继续上次排查");
			const sent = text(requests);
			// R5：必须注入**真实**任务进展，而不是一句"检测到任务"。
			assert.ok(sent.includes("SYNTHETIC-R5-REQUIREMENT"), "必须注入真实原需求");
			assert.ok(sent.includes("SYNTHETIC-R5-TODO"), "必须注入真实待办");
			assert.ok(sent.includes("SYNTHETIC-R5-DECISION"), "必须注入已记录决定");
			// 检查点必须关联该任务（否则按 taskId 检索不到）。
			const dir = automationDir(f.root, f.workspaceId);
			const linked = [];
			for (const name of (await readdir(join(dir, "checkpoints"))).filter((entry) => entry.endsWith(".json"))) {
				linked.push(JSON.parse(await readFile(join(dir, "checkpoints", name), "utf8")).task);
			}
			assert.ok(
				linked.some((task) => task !== null && task.taskId === taskId),
				`检查点必须关联唯一未完成任务：${JSON.stringify(linked)}`,
			);
		});

		// R7：**新会话**（新对话）不重扫也拿到上一轮的有界候选。
		await withSession(f, env, script(), async ({ session, requests }) => {
			requests.length = 0;
			await session.prompt("再排查一次 USB 启动");
			const sent = text(requests);
			assert.ok(sent.includes("沿用上一轮构建入口候选"), `unchanged 时必须交回上一轮候选：${sent.slice(0, 600)}`);
			assert.ok(sent.includes("SyntheticAwLifecycle"), "复用候选里必须有真实的平台名");
		});
	} finally {
		await f.cleanup();
	}
});

test("AW 生命周期负例：未开启许可时不注入指导、不产生任何自动化记录", async () => {
	const f = await fixture();
	try {
		await withSession(f, f.base, script(), async ({ session, requests }) => {
			requests.length = 0;
			await session.prompt(PROMPT);
			assert.ok(requests.length >= 2, "工具循环仍应正常发生（负例只关自动记账）");
			assert.ok(!systemText(requests).includes("BIOS 默认自主工作流"), "未开启许可时不得注入自动化指导");
			assert.ok(!existsSync(automationDir(f.root, f.workspaceId)), "未开启许可时不得创建自动化目录");
		});
	} finally {
		await f.cleanup();
	}
});
