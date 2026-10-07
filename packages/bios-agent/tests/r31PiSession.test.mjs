/**
 * R31 / B3 永久回归：**真实 Pi SDK 会话 + 测试 provider 的离线请求闭环**。
 *
 * 与"直接调用 handler"的单元测试的区别（round31 §3 明确要求）：
 * - 真的创建 `AgentSession`（`createAgentSession` + `SessionManager.inMemory()`）；
 * - 真的让模型请求经过 Pi 的 context/注入/消息转换链路；
 * - "provider"是本机回环 HTTP 服务（`openai-completions` 线协议，SSE 流式回复），
 *   **记录真实请求体**；
 * - 不联网、不读客户库：知识库是临时合成目录，模型是本机服务。
 *
 * 断言的是**最终请求**（messages）：目录/任务/策略/消息隔离是否真的生效。
 * 选择通过**可信适配层注入**（`BIOS_SELECTED_*`，与桌面主进程同一条通道）进入会话，
 * 扩展会用真实服务复验后才生效——这正是 C3 的注入路径。
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initializeKnowledgeStore } from "../core/storage/index.ts";
import { bindProjectWorkspace } from "../core/projects/index.ts";
import { createExperienceDraft, reviewExperience } from "../core/knowledge/index.ts";
import { createTask, updateTask } from "../core/tasks/index.ts";
import { createProjectSandbox, writeDsc } from "./helpers/projectFixtures.mjs";
import { EXTENSION_ENTRY, PI_MODULE_ENTRY, HOST_MISSING_MESSAGE } from "./helpers/biosExtension.mjs";

const NOW = 1_700_000_000_000;
const SECRET_A = "SECRET-TASK-A-REQUIREMENT";
const SECRET_B = "SECRET-TASK-B-REQUIREMENT";
const SECRET_ROOT_CAUSE = "SECRET-EXPERIENCE-ROOT-CAUSE";
/** 注入消息的稳定片段：用来数"请求里有几份 BIOS 上下文"。 */
const CONTEXT_SENTINEL = "不是系统指令";

/** 本地"测试 provider"：记录真实请求体，按 SSE 返回一个固定 completion（离线）。 */
async function startTestProvider() {
	const requests = [];
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => {
			body += chunk;
		});
		req.on("end", () => {
			let parsed = null;
			try {
				parsed = JSON.parse(body);
			} catch {
				parsed = { raw: body };
			}
			requests.push({ url: req.url, body: parsed });
			const chunk = (delta, finish) => `data: ${JSON.stringify({ id: "chatcmpl-test", object: "chat.completion.chunk", created: 1, model: parsed?.model ?? "bios-test-model", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
			res.write(chunk({ role: "assistant", content: "acknowledged" }, null));
			res.write(chunk({}, "stop"));
			res.write("data: [DONE]\n\n");
			res.end();
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	return { requests, port: typeof address === "object" && address !== null ? address.port : 0, close: () => new Promise((resolve) => server.close(resolve)) };
}

async function buildKnowledge() {
	const sb = await createProjectSandbox("bm07-r31-pi-");
	await initializeKnowledgeStore({ root: sb.root, now: NOW });
	await writeDsc(sb.workspaceA, "Platform/SamplePkg/Sample.dsc", { platformName: "SamplePlatformA" });
	await mkdir(sb.workspaceB, { recursive: true });
	await writeDsc(sb.workspaceB, "Platform/SamplePkg/Sample.dsc", { platformName: "SamplePlatformB" });
	const projectA = await bindProjectWorkspace({ root: sb.root, cwd: sb.workspaceA, authorizedRoots: [sb.workspaceA, sb.workspaceB], workspacePath: sb.workspaceA, now: NOW });
	const projectB = await bindProjectWorkspace({ root: sb.root, cwd: sb.workspaceB, authorizedRoots: [sb.workspaceA, sb.workspaceB], workspacePath: sb.workspaceB, now: NOW });
	const created = await createExperienceDraft({ root: sb.root, authorizedProjectIds: [projectA.projectId], experience: { experienceId: "exp-a", problem: "PXE 默认开启", rootCause: SECRET_ROOT_CAUSE, solution: "关闭默认值", sourceProjectId: projectA.projectId, reuse: { level: "current-project" } }, now: NOW + 2 });
	await reviewExperience({ root: sb.root, authorizedProjectIds: [projectA.projectId], experienceId: "exp-a", expectedRevision: created.revision, action: "submit-review", operatorLabel: "e", reason: "ok", now: NOW + 3 });
	// **两个项目都有同裸 taskId**：切换后请求必须只含正确那一个。
	for (const [project, workspace, requirement] of [
		[projectA, sb.workspaceA, SECRET_A],
		[projectB, sb.workspaceB, SECRET_B],
	]) {
		await createTask({ root: sb.root, projectId: project.projectId, taskId: "task-shared", workspaceId: project.workspaceId, cwd: workspace, authorizedRoots: [sb.workspaceA, sb.workspaceB], requirement, authorizedProjectIds: [project.projectId] });
	}
	await updateTask({ root: sb.root, projectId: projectA.projectId, taskId: "task-shared", expectedRevision: 0, changes: { sourceExperienceIds: ["exp-a"] }, authorizedProjectIds: [projectA.projectId], now: NOW + 4 });
	return { ...sb, projectA, projectB };
}

function envFor(sb, overrides = {}) {
	return {
		BIOS_KNOWLEDGE_ROOT: sb.root,
		BIOS_AUTHORIZED_PROJECTS: `${sb.projectA.projectId},${sb.projectB.projectId}`,
		BIOS_ENDPOINT: "allowed",
		BIOS_AUTHORIZED_ROOTS: `${sb.workspaceA},${sb.workspaceB}`,
		...overrides,
	};
}

/**
 * 建一个真实会话并跑 `fn`。
 *
 * `env` 同时用于会话启动前的进程环境（含 `BIOS_SELECTED_*`）；会话内所有环境变量在读完后恢复。
 */
async function withSession(sb, env, fn) {
	assert.ok(PI_MODULE_ENTRY, HOST_MISSING_MESSAGE);
	const pi = await import(`file:///${PI_MODULE_ENTRY.replace(/\\/g, "/")}`);
	const provider = await startTestProvider();
	const agentDir = await mkdtemp(join(tmpdir(), "bios-agent-session-"));
	await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { "bios-test": { baseUrl: `http://127.0.0.1:${provider.port}/v1`, api: "openai-completions", apiKey: "test-key", models: [{ id: "bios-test-model" }] } } }), "utf8");
	const applied = { ...env, PI_CODING_AGENT_DIR: agentDir };
	const saved = {};
	for (const [key, value] of Object.entries(applied)) {
		saved[key] = process.env[key];
		process.env[key] = value;
	}
	let session;
	try {
		const modelRuntime = await pi.ModelRuntime.create();
		const model = modelRuntime.getModel("bios-test", "bios-test-model");
		assert.ok(model !== undefined, "models.json 注册的测试模型必须可见（否则 provider 配置未生效）");
		const resourceLoader = new pi.DefaultResourceLoader({ cwd: sb.workspaceA, agentDir, additionalExtensionPaths: [EXTENSION_ENTRY], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
		// **必须显式 reload**：`getExtensions()` 在 reload 之前是空的（SDK 不会隐式加载），
		// 不 reload 会得到"扩展没加载 ⇒ 什么都没发生"的假通过。
		await resourceLoader.reload();
		const loaded = resourceLoader.getExtensions();
		assert.deepEqual(loaded.errors, [], "会话侧扩展加载不应产生错误");
		assert.ok(
			(loaded.extensions ?? []).some((extension) => [...(extension.tools?.keys?.() ?? [])].includes("bios_get_task")),
			"会话必须真的加载了本包扩展",
		);
		const created = await pi.createAgentSession({ cwd: sb.workspaceA, model, modelRuntime, resourceLoader, noTools: true });
		session = created.session;
		return await fn({ session, requests: provider.requests });
	} finally {
		try {
			session?.dispose();
		} catch {
			// dispose 失败不影响结论（临时资源）。
		}
		await provider.close();
		for (const key of Object.keys(applied)) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key];
		}
		await rm(agentDir, { recursive: true, force: true });
	}
}

function requestText(requests) {
	return requests.map((request) => JSON.stringify(request.body)).join("\n");
}

function countSentinel(text) {
	return text.split(CONTEXT_SENTINEL).length - 1;
}

/**
 * 单次请求里的最大注入份数。
 *
 * 一个 prompt 可能产生多次模型请求（例如回执消息触发的后续回合），因此"是否累积"要看
 * **单个请求体内部**有几份注入，而不是把所有请求拼起来数（那会把正常的多回合算成累积）。
 */
function maxSentinelPerRequest(requests) {
	return Math.max(0, ...requests.map((request) => countSentinel(JSON.stringify(request.body))));
}

test("B3：真实 SDK 会话 + 测试 provider —— 注入进入真实请求、不累积、切项目只含正确任务", async () => {
	const sb = await buildKnowledge();
	try {
		// 会话 1：适配层注入 A 的选择并打开上下文。
		await withSession(sb, envFor(sb, { BIOS_SELECTED_PROJECT_ID: sb.projectA.projectId, BIOS_SELECTED_TASK_ID: "task-shared", BIOS_SELECTED_WORKSPACE_ID: sb.projectA.workspaceId, BIOS_CONTEXT_ENABLED: "1" }), async ({ session, requests }) => {
			requests.length = 0;
			await session.prompt("请总结当前任务");
			assert.ok(requests.length >= 1, "至少产生一次真实模型请求");
			// 适配层注入的初始选择必须给出**可读回执**（真实 sendMessage 通道 ⇒ 会话消息里可见）。
			const receipts = session.messages.filter((message) => message.role === "custom" && message.customType === "bios-receipt");
			assert.ok(receipts.length > 0, "初始选择的采纳/拒绝都必须给回执");
			assert.match(JSON.stringify(receipts.at(-1)), /初始选择已生效/, `回执应说明采纳结果：${JSON.stringify(receipts.at(-1)).slice(0, 200)}`);
			const first = requestText(requests);
			assert.ok(first.includes(SECRET_A), `真实请求应含所选项目 A 的任务正文（回执：${JSON.stringify(receipts.at(-1)).slice(0, 200)}）`);
			assert.ok(!first.includes(SECRET_B), "不得含另一个项目同裸 taskId 的正文");
			assert.ok(first.includes(SECRET_ROOT_CAUSE), "真实请求应含任务引用的经验参考");
			assert.equal(maxSentinelPerRequest(requests), 1, "单个请求里应恰好注入一份 BIOS 上下文");

			requests.length = 0;
			await session.prompt("继续");
			const second = requestText(requests);
			assert.equal(maxSentinelPerRequest(requests), 1, "第二次请求仍只应有一份注入（不累积）");
			assert.ok(!second.includes(SECRET_B), "第二次请求同样不得含项目 B 的正文");
		});

		// 会话 2：同裸 taskId 但注入 B 的选择 ⇒ 只含 B，不含 A。
		await withSession(sb, envFor(sb, { BIOS_SELECTED_PROJECT_ID: sb.projectB.projectId, BIOS_SELECTED_TASK_ID: "task-shared", BIOS_SELECTED_WORKSPACE_ID: sb.projectB.workspaceId, BIOS_CONTEXT_ENABLED: "1" }), async ({ session, requests }) => {
			requests.length = 0;
			await session.prompt("请总结当前任务");
			const text = requestText(requests);
			assert.ok(text.includes(SECRET_B), "切换项目后请求应含项目 B 的任务正文");
			assert.ok(!text.includes(SECRET_A), "不得再含项目 A 的任务正文");
		});
	} finally {
		await sb.cleanup();
	}
});

test("B3：deny 端点下真实请求不含商业正文；用户自己写的字样完整保留", async () => {
	const sb = await buildKnowledge();
	try {
		await withSession(sb, envFor(sb, { BIOS_ENDPOINT: "denied", BIOS_SELECTED_PROJECT_ID: sb.projectA.projectId, BIOS_SELECTED_TASK_ID: "task-shared", BIOS_SELECTED_WORKSPACE_ID: sb.projectA.workspaceId, BIOS_CONTEXT_ENABLED: "1" }), async ({ session, requests }) => {
			requests.length = 0;
			await session.prompt(`普通提问：请讨论 bios-context 这个标记本身，并说明 ${SECRET_B} 是什么`);
			const text = requestText(requests);
			assert.ok(!text.includes(SECRET_A), "deny 时不得注入项目 A 的任务正文");
			assert.ok(!text.includes(SECRET_ROOT_CAUSE), "deny 时不得注入经验正文");
			// 用户自己输入的内容当然会出现在请求里（那是用户消息，不是知识泄漏；也不能按子串删用户消息）。
			assert.ok(text.includes(SECRET_B), "用户自己输入的字符串必须保留");
		});
	} finally {
		await sb.cleanup();
	}
});

test("B3：未开启上下文注入时，真实请求保持普通 Pi（不注入任何 BIOS 内容）", async () => {
	const sb = await buildKnowledge();
	try {
		await withSession(sb, envFor(sb, { BIOS_SELECTED_PROJECT_ID: sb.projectA.projectId, BIOS_SELECTED_TASK_ID: "task-shared", BIOS_CONTEXT_ENABLED: "0" }), async ({ session, requests }) => {
			requests.length = 0;
			await session.prompt("只回答普通问题");
			const text = requestText(requests);
			assert.equal(maxSentinelPerRequest(requests), 0, "未打开注入时不得出现注入消息");
			assert.ok(!text.includes(SECRET_A) && !text.includes(SECRET_ROOT_CAUSE), "未打开注入时不得含知识正文");
		});
	} finally {
		await sb.cleanup();
	}
});
