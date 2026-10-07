/**
 * R31-2 永久回归：**请求级上下文的身份、所有权、隔离与失败路径**。
 *
 * 覆盖 round31 §4 R31-2 的实际观察：
 * - 进程 cwd ≠ 会话 cwd 时用真实 `ctx.cwd`（并能看到真实 HEAD）；
 * - 注入消息是扩展**自有类型**（`role: "custom"` + `customType`），不再按字符串子串删除普通消息；
 * - 会话身份 / 选择代次 / 可信配置指纹三者共同隔离，策略变化时**移除旧注入**并自动关闭；
 * - 关闭/未选择/未授权时放行并移除自己的旧注入，不阻塞普通 Pi；
 * - 选择经真实服务校验（不存在的任务、错工作区都被拒绝），换任务**清除**旧工作区；
 * - 命令返回可读回执（失败也有），不静默忽略。
 */
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { initializeKnowledgeStore, readRecord } from "../core/storage/index.ts";
import { bindProjectWorkspace, confirmProfileFields } from "../core/projects/index.ts";
import { createExperienceDraft, createFeature, reviewExperience } from "../core/knowledge/index.ts";
import { createTask, updateTask } from "../core/tasks/index.ts";
import { handleBiosContextCommand, handleBiosTaskCommand } from "../extensions/commands.ts";
import { BIOS_CONTEXT_CUSTOM_TYPE, isOwnInjection } from "../extensions/contextInjection.ts";
import { createProjectSandbox, writeDsc } from "./helpers/projectFixtures.mjs";
import { loadBiosExtension } from "./helpers/biosExtension.mjs";

const NOW = 1_700_000_000_000;
const SECRET = "SECRET-CONTEXT-BODY";

async function buildKnowledge() {
	const sb = await createProjectSandbox("bm07-r31-ctx-");
	await initializeKnowledgeStore({ root: sb.root, now: NOW });
	await writeDsc(sb.workspaceA, "Platform/SamplePkg/Sample.dsc", { platformName: "SamplePlatformA" });
	await mkdir(sb.workspaceB, { recursive: true });
	await writeDsc(sb.workspaceB, "Platform/SamplePkg/Sample.dsc", { platformName: "SamplePlatformB" });
	const projectA = await bindProjectWorkspace({ root: sb.root, cwd: sb.workspaceA, authorizedRoots: [sb.workspaceA, sb.workspaceB], workspacePath: sb.workspaceA, now: NOW });
	const projectB = await bindProjectWorkspace({ root: sb.root, cwd: sb.workspaceB, authorizedRoots: [sb.workspaceA, sb.workspaceB], workspacePath: sb.workspaceB, now: NOW });
	await confirmProfileFields({ root: sb.root, projectId: projectA.projectId, workspaceId: projectA.workspaceId, expectedProfileRevision: 0, values: [{ field: "boardName", value: "BoardA-name" }], operatorLabel: "engineer-test", now: NOW + 1 });
	const created = await createExperienceDraft({ root: sb.root, authorizedProjectIds: [projectA.projectId], experience: { experienceId: "exp-ctx", problem: "PXE 默认开启", rootCause: SECRET, solution: "关闭默认值", sourceProjectId: projectA.projectId, reuse: { level: "current-project" } }, now: NOW + 2 });
	await reviewExperience({ root: sb.root, authorizedProjectIds: [projectA.projectId], experienceId: "exp-ctx", expectedRevision: created.revision, action: "submit-review", operatorLabel: "engineer-test", reason: "ok", now: NOW + 3 });
	await createTask({ root: sb.root, projectId: projectA.projectId, taskId: "task-ctx", workspaceId: projectA.workspaceId, cwd: sb.workspaceA, authorizedRoots: [sb.workspaceA], requirement: "关闭 PXE 缩短启动时间", authorizedProjectIds: [projectA.projectId] });
	await updateTask({ root: sb.root, projectId: projectA.projectId, taskId: "task-ctx", expectedRevision: 0, changes: { sourceExperienceIds: ["exp-ctx"] }, authorizedProjectIds: [projectA.projectId], now: NOW + 4 });
	return { ...sb, projectA, projectB };
}

/** 运行一次 `context` handler（真实注册的处理器）。 */
async function runContext(extension, messages, ctx) {
	const handlers = extension.handlers.get("context") ?? [];
	assert.ok(handlers.length > 0, "必须注册 context 处理器");
	let result;
	for (const handler of handlers) {
		const outcome = await handler({ type: "context", messages: result?.messages ?? messages }, ctx);
		if (outcome && Array.isArray(outcome.messages)) result = outcome;
	}
	return result;
}

function textOf(message) {
	const content = message?.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) return content.map((part) => part?.text ?? "").join("\n");
	return "";
}

async function withEnv(env, fn) {
	const saved = {};
	for (const [key, value] of Object.entries(env)) {
		saved[key] = process.env[key];
		process.env[key] = value;
	}
	try {
		return await fn();
	} finally {
		for (const key of Object.keys(env)) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key];
		}
	}
}

function envFor(sb, endpoint = "allowed") {
	return {
		BIOS_KNOWLEDGE_ROOT: sb.root,
		BIOS_AUTHORIZED_PROJECTS: sb.projectA.projectId,
		BIOS_APPROVED_CUSTOMERS: "customer-alpha",
		BIOS_ENDPOINT: endpoint,
		BIOS_AUTHORIZED_ROOTS: sb.workspaceA,
	};
}

test("R31-2：命令回执可读且经真实校验；换任务清除旧工作区；打开注入需要已选任务", async () => {
	const sb = await buildKnowledge();
	try {
		await withEnv(envFor(sb), async () => {
			const cwd = sb.workspaceA;
			const ctx = { cwd };
			const missing = await handleBiosTaskCommand("select " + `${sb.projectA.projectId} no-such-task`, ctx);
			assert.equal(missing.ok, false, "不存在的任务必须被拒绝");
			assert.match(missing.text, /不存在|未授权/, "拒绝也要给可读原因");

			const wrongWorkspace = await handleBiosTaskCommand(`select ${sb.projectA.projectId} task-ctx ${sb.projectB.workspaceId}`, ctx);
			assert.equal(wrongWorkspace.ok, false, "工作区不属于该任务时必须被拒绝");
			assert.match(wrongWorkspace.text, /工作区/, "说明是工作区不匹配");

			const unauthorizedProject = await handleBiosTaskCommand("select 11111111-2222-4333-8444-555555555555 task-x", ctx);
			assert.equal(unauthorizedProject.ok, false, "未授权项目必须被拒绝");

			// 未选任务时不能打开注入（不自动挑任务）。
			const onWithoutSelection = await handleBiosContextCommand("on", ctx);
			assert.equal(onWithoutSelection.ok, false);

			const selected = await handleBiosTaskCommand(`select ${sb.projectA.projectId} task-ctx ${sb.projectA.workspaceId}`, ctx);
			assert.equal(selected.ok, true, `正常选择应成功：${selected.text}`);
			const status = await handleBiosTaskCommand("status", ctx);
			assert.match(status.text, /task-ctx/);
			const on = await handleBiosContextCommand("on", ctx);
			assert.equal(on.ok, true);

			// 换任务（省略 workspace）⇒ 按新任务绑定重建，不沿用旧工作区。
			await createTask({ root: sb.root, projectId: sb.projectA.projectId, taskId: "task-ctx-2", workspaceId: sb.projectA.workspaceId, cwd: sb.workspaceA, authorizedRoots: [sb.workspaceA], requirement: "第二条任务", authorizedProjectIds: [sb.projectA.projectId] });
			const switched = await handleBiosTaskCommand(`select ${sb.projectA.projectId} task-ctx-2`, ctx);
			assert.equal(switched.ok, true);
			assert.equal(switched.details.workspaceId, sb.projectA.workspaceId, "缺省工作区必须按任务绑定重建");
			const cleared = await handleBiosContextCommand("off", ctx);
			assert.equal(cleared.ok, true);
		});
	} finally {
		await sb.cleanup();
	}
});

test("R31-2：注入用扩展自有消息类型；普通消息即使含标记也完整保留；会话/代次隔离", async () => {
	const sb = await buildKnowledge();
	const { extension, cleanup } = await loadBiosExtension();
	try {
		await withEnv(envFor(sb), async () => {
			const sessionManager = { getSessionId: () => "s-1" };
			const ctx = { cwd: sb.workspaceA, sessionManager };
			const { commandOf } = await import("./helpers/biosExtension.mjs");
			await commandOf(extension, "bios-task")(`select ${sb.projectA.projectId} task-ctx ${sb.projectA.workspaceId}`, ctx);
			await commandOf(extension, "bios-context")("on", ctx);

			// 普通消息：一条讨论注入标记的 user 消息必须被完整保留（不是按字符串子串删除）。
			const ordinary = { role: "user", content: [{ type: "text", text: `讨论 ${BIOS_CONTEXT_CUSTOM_TYPE} 这个标记本身，不要删我` }], timestamp: 1 };
			const first = await runContext(extension, [ordinary], ctx);
			assert.ok(first !== undefined, "开启后必须注入");
			const injected = first.messages.filter(isOwnInjection);
			assert.equal(injected.length, 1, "只应有一条自有注入");
			assert.equal(injected[0].role, "custom");
			assert.equal(injected[0].customType, BIOS_CONTEXT_CUSTOM_TYPE);
			assert.ok(first.messages.includes(ordinary), "普通消息必须原样保留");
			assert.ok(textOf(injected[0]).includes(SECRET) || textOf(injected[0]).includes("关闭 PXE"), "允许端点下注入应含任务/经验正文");

			// 再次请求：仍然只有一条自有注入（替换，不累积）。
			const second = await runContext(extension, first.messages, ctx);
			assert.equal(second.messages.filter(isOwnInjection).length, 1, "不得累积注入");

			// 会话隔离：别的会话读不到本会话的选择 ⇒ 不注入，并且**移除**自己的旧注入。
			const otherSession = await runContext(extension, first.messages, { cwd: sb.workspaceA, sessionManager: { getSessionId: () => "s-OTHER" } });
			assert.equal(otherSession.messages.filter(isOwnInjection).length, 0, "不同会话不得沿用选择/注入");
			assert.ok(otherSession.messages.includes(ordinary), "普通消息仍然保留");
		});
	} finally {
		cleanup();
		await sb.cleanup();
	}
});

test("R31-2：可信配置变化自动关闭注入并说明；deny 时不注入商业正文；关闭后回到普通 Pi", async () => {
	const sb = await buildKnowledge();
	const { extension, cleanup } = await loadBiosExtension();
	try {
		await withEnv(envFor(sb, "allowed"), async () => {
			const sessionManager = { getSessionId: () => "s-1" };
			const ctx = { cwd: sb.workspaceA, sessionManager };
			const { commandOf } = await import("./helpers/biosExtension.mjs");
			await commandOf(extension, "bios-task")(`select ${sb.projectA.projectId} task-ctx ${sb.projectA.workspaceId}`, ctx);
			await commandOf(extension, "bios-context")("on", ctx);

			// 端点从 allowed 变成 denied（可信配置指纹变化）⇒ 自动关闭并给原因，不注入正文。
			process.env.BIOS_ENDPOINT = "denied";
			const afterPolicyChange = await runContext(extension, [], ctx);
			assert.ok(!(afterPolicyChange?.messages ?? []).some(isOwnInjection), "策略变化后不得注入旧商业正文");
			const status = await handleBiosContextCommand("status", { cwd: sb.workspaceA });
			assert.match(status.text, /自动关闭|端点/, "状态回执必须说明自动关闭或端点策略");
			assert.equal(status.details.selection.contextEnabled, false, "配置变化后开关必须落成关闭");

			// 关闭注入 ⇒ 移除自有消息，但普通消息保留、不阻塞。
			const ordinary = { role: "user", content: [{ type: "text", text: "普通消息" }], timestamp: 2 };
			const off = await handleBiosContextCommand("off", ctx);
			assert.equal(off.ok, true);
			const afterOff = await runContext(extension, [ordinary], ctx);
			assert.equal(afterOff, undefined, "关闭且无自有注入时不应改动消息");
		});
	} finally {
		cleanup();
		await sb.cleanup();
	}
});
