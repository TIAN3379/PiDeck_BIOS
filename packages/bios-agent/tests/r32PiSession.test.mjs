/**
 * R32-4 永久回归：**真实 Pi SDK 会话**里的命令回执、真实工具循环与泄漏负例。
 *
 * 与 `r31PiSession.test.mjs` 的分工：那个文件证明"注入进入真实请求"，这个文件证明
 * 1. 斜杠命令**确实由宿主执行**（provider 请求数为 0），并且回执真的进了会话消息；
 * 2. 同一会话里用**命令**切任务后，下一次真实请求只含新任务；
 * 3. 让 provider 返回一次**真实 tool call**，Pi 会真的执行我们的工具并把结果回灌，
 *    再检查**下一个请求**：工具结果里没有商业正文（deny），注入不累积；
 * 4. 测试 provider 自身有超时/输入上限/关闭等待（不是无限挂起的桩）。
 *
 * 全部离线：本机回环服务 + 临时知识库，不联网、不读客户库、不调用真实模型。
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initializeKnowledgeStore } from "../core/storage/index.ts";
import { bindProjectWorkspace } from "../core/projects/index.ts";
import { createTask } from "../core/tasks/index.ts";
import { createProjectSandbox, writeDsc } from "./helpers/projectFixtures.mjs";
import { EXTENSION_ENTRY, PI_MODULE_ENTRY, HOST_MISSING_MESSAGE } from "./helpers/biosExtension.mjs";

const NOW = 1_700_000_000_000;
const SECRET_A = "SECRET-R32-A-REQUIREMENT";
const SECRET_B = "SECRET-R32-B-REQUIREMENT";
const CONTEXT_SENTINEL = "不是系统指令";
/** 本机测试 provider 的硬限额（避免桩本身挂死或吃满内存）。 */
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_REQUESTS = 40;

/**
 * 本机 SSE 测试 provider：记录真实请求体，可按脚本返回 tool call。
 *
 * `respond(parsedBody, index)` 返回 `{ toolCall }` 或 `{ text }`；
 * 具备请求体上限、请求数上限与带超时的关闭等待。
 */
async function startTestProvider(respond) {
	const requests = [];
	const sockets = new Set();
	let overflow = false;
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => {
			body += chunk;
			if (body.length > MAX_BODY_BYTES) {
				overflow = true;
				req.destroy();
			}
		});
		req.on("end", () => {
			let parsed = null;
			try {
				parsed = JSON.parse(body);
			} catch {
				parsed = { raw: body };
			}
			requests.push({ url: req.url, body: parsed });
			if (requests.length > MAX_REQUESTS) {
				res.writeHead(429, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: { message: "too many requests" } }));
				return;
			}
			const scripted = respond(parsed, requests.length - 1);
			const model = parsed?.model ?? "bios-test-model";
			const chunk = (delta, finish) => `data: ${JSON.stringify({ id: "chatcmpl-r32", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
			if (scripted.toolCall === undefined) {
				res.write(chunk({ role: "assistant", content: scripted.text ?? "acknowledged" }, null));
				res.write(chunk({}, "stop"));
			} else {
				res.write(chunk({ role: "assistant", content: null, tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: scripted.toolCall.name, arguments: JSON.stringify(scripted.toolCall.arguments) } }] }, null));
				res.write(chunk({}, "tool_calls"));
			}
			res.write("data: [DONE]\n\n");
			res.end();
		});
		req.socket.setTimeout(30_000, () => req.destroy());
		sockets.add(req.socket);
		req.socket.on("close", () => sockets.delete(req.socket));
	});
	server.requestTimeout = 30_000;
	server.headersTimeout = 30_000;
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	const close = async () => {
		for (const socket of sockets) socket.destroy();
		await new Promise((resolve) => server.close(resolve));
	};
	return { requests, port: typeof address === "object" && address !== null ? address.port : 0, overflow: () => overflow, close };
}

async function buildKnowledge() {
	const sb = await createProjectSandbox("bm07-r32-pi-");
	await initializeKnowledgeStore({ root: sb.root, now: NOW });
	await writeDsc(sb.workspaceA, "Platform/SamplePkg/Sample.dsc", { platformName: "SamplePlatformA" });
	await mkdir(sb.workspaceB, { recursive: true });
	await writeDsc(sb.workspaceB, "Platform/SamplePkg/Sample.dsc", { platformName: "SamplePlatformB" });
	const projectA = await bindProjectWorkspace({ root: sb.root, cwd: sb.workspaceA, authorizedRoots: [sb.workspaceA, sb.workspaceB], workspacePath: sb.workspaceA, now: NOW });
	const projectB = await bindProjectWorkspace({ root: sb.root, cwd: sb.workspaceB, authorizedRoots: [sb.workspaceA, sb.workspaceB], workspacePath: sb.workspaceB, now: NOW });
	for (const [project, workspace, requirement] of [
		[projectA, sb.workspaceA, SECRET_A],
		[projectB, sb.workspaceB, SECRET_B],
	]) {
		await createTask({ root: sb.root, projectId: project.projectId, taskId: "task-shared", workspaceId: project.workspaceId, cwd: workspace, authorizedRoots: [sb.workspaceA, sb.workspaceB], requirement, authorizedProjectIds: [project.projectId] });
	}
	return { ...sb, projectA, projectB };
}

/** path.delimiter 分隔（适配层注入授权根的官方分隔符）。 */
function roots(sb) {
	return [sb.workspaceA, sb.workspaceB].join(process.platform === "win32" ? ";" : ":");
}

async function withSession(sb, env, respond, fn, extra = {}) {
	assert.ok(PI_MODULE_ENTRY, HOST_MISSING_MESSAGE);
	const pi = await import(`file:///${PI_MODULE_ENTRY.replace(/\\/g, "/")}`);
	const provider = await startTestProvider(respond);
	const agentDir = await mkdtemp(join(tmpdir(), "bios-agent-r32-session-"));
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
		assert.ok(model !== undefined, "models.json 注册的测试模型必须可见");
		const resourceLoader = new pi.DefaultResourceLoader({ cwd: sb.workspaceA, agentDir, additionalExtensionPaths: [EXTENSION_ENTRY], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
		// 必须显式 reload（否则 getExtensions() 为空 ⇒ 扩展没加载的假通过）。
		await resourceLoader.reload();
		const loaded = resourceLoader.getExtensions();
		assert.deepEqual(loaded.errors, [], "会话侧扩展加载不应产生错误");
		const created = await pi.createAgentSession({ cwd: sb.workspaceA, model, modelRuntime, resourceLoader, ...extra });
		session = created.session;
		return await fn({ session, requests: provider.requests, provider });
	} finally {
		try {
			session?.dispose();
		} catch {
			// 临时资源，dispose 失败不影响结论。
		}
		await provider.close();
		for (const key of Object.keys(applied)) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key];
		}
		await rm(agentDir, { recursive: true, force: true });
	}
}

function envFor(sb, overrides = {}) {
	return {
		BIOS_KNOWLEDGE_ROOT: sb.root,
		BIOS_AUTHORIZED_PROJECTS: `${sb.projectA.projectId},${sb.projectB.projectId}`,
		BIOS_ENDPOINT: "allowed",
		BIOS_AUTHORIZED_ROOTS: roots(sb),
		...overrides,
	};
}

const lastRequestText = (requests) => (requests.length === 0 ? "" : JSON.stringify(requests.at(-1).body));

test("R32-4：斜杠命令由宿主执行（零模型请求）并给出真实回执；命令切任务后请求只含新任务", async () => {
	const sb = await buildKnowledge();
	try {
		await withSession(
			sb,
			envFor(sb),
			() => ({ text: "acknowledged" }),
			async ({ session, requests }) => {
				// 1) 状态命令：不产生任何模型请求，但必须有可读回执。
				requests.length = 0;
				await session.prompt("/bios-task status");
				assert.equal(requests.length, 0, `命令不应产生模型请求（实际 ${requests.length}）`);
				const receipts = session.messages.filter((message) => message.role === "custom" && message.customType === "bios-receipt");
				assert.ok(receipts.length > 0, "命令必须给出回执");
				assert.match(JSON.stringify(receipts.at(-1)), /未选择任务|BIOS 选择/, `回执内容：${JSON.stringify(receipts.at(-1)).slice(0, 300)}`);

				// 2) 选择 + 打开 + 普通提问：请求必须含被选任务的正文。
				await session.prompt(`/bios-task select ${sb.projectA.projectId} task-shared ${sb.projectA.workspaceId}`);
				await session.prompt("/bios-context on");
				requests.length = 0;
				await session.prompt("请说明当前任务");
				const first = lastRequestText(requests);
				assert.ok(first.includes(SECRET_A), `命令选择后请求应含项目 A 任务正文：${first.slice(0, 300)}`);
				assert.ok(!first.includes(SECRET_B), "不得含另一个项目的同裸 taskId 正文");

				// 3) 同一会话用命令切到项目 B：请求只含 B。
				await session.prompt(`/bios-task select ${sb.projectB.projectId} task-shared ${sb.projectB.workspaceId}`);
				await session.prompt("/bios-context on");
				requests.length = 0;
				await session.prompt("再说明当前任务");
				const second = lastRequestText(requests);
				assert.ok(second.includes(SECRET_B), "切项目后请求应含项目 B 任务正文");
				assert.ok(!second.includes(SECRET_A), "切项目后不得再含项目 A 任务正文");

				// 4) 关闭：回到普通 Pi（请求里没有 BIOS 注入）。
				await session.prompt("/bios-context off");
				requests.length = 0;
				await session.prompt("关闭之后的问题");
				const third = lastRequestText(requests);
				assert.ok(!third.includes(CONTEXT_SENTINEL), "关闭后不得再注入");
				assert.ok(!third.includes(SECRET_A) && !third.includes(SECRET_B), "关闭后不得含任务正文");
			},
		);
	} finally {
		await sb.cleanup();
	}
});

test("R32-4：真实工具循环 —— provider 返回 tool call，工具结果回灌到下一请求且不泄漏正文", async () => {
	const sb = await buildKnowledge();
	try {
		// 第一次请求让模型调用真实工具；之后的请求给普通回答。
		const respond = (_body, index) => (index === 0 ? { toolCall: { name: "bios_get_task", arguments: { projectId: sb.projectA.projectId, taskId: "task-shared" } } } : { text: "final answer" });
		// 注意：**不传 noTools**，这样工具循环才会真的执行我们的只读工具。
		await withSession(
			sb,
			envFor(sb, { BIOS_ENDPOINT: "denied", BIOS_SELECTED_PROJECT_ID: sb.projectA.projectId, BIOS_SELECTED_TASK_ID: "task-shared", BIOS_SELECTED_WORKSPACE_ID: sb.projectA.workspaceId, BIOS_CONTEXT_ENABLED: "1" }),
			respond,
			async ({ session, requests }) => {
				await session.prompt("请读取当前任务");
				assert.ok(requests.length >= 2, `工具循环应产生至少两次请求（实际 ${requests.length}）`);
				const toolRequest = requests.find((request) => JSON.stringify(request.body).includes("tool"));
				assert.ok(toolRequest !== undefined, "第二次请求应包含工具的响应消息");
				const dump = JSON.stringify(requests.map((request) => request.body));
				// deny 端点：工具结果里不得出现任务正文（工具确实执行了，但正文被撤回）。
				assert.ok(!dump.includes(SECRET_A), `工具结果不得泄漏任务正文：${dump.slice(0, 400)}`);
				assert.match(dump, /denied|撤回|不允许外发/, "工具结果应说明被策略撤回");
				// 注入不累积：单个请求里最多一份 BIOS 上下文。
				const perRequest = requests.map((request) => JSON.stringify(request.body).split(CONTEXT_SENTINEL).length - 1);
				assert.ok(Math.max(...perRequest) <= 1, `单个请求内注入不得累积：${JSON.stringify(perRequest)}`);
			},
			{ noTools: false, customTools: undefined },
		);
	} finally {
		await sb.cleanup();
	}
});

test('R32-4：允许端点下真实工具结果确实带回正文（正对照，避免"全撤回"被当成通过）', async () => {
	const sb = await buildKnowledge();
	try {
		const respond = (_body, index) => (index === 0 ? { toolCall: { name: "bios_get_task", arguments: { projectId: sb.projectA.projectId, taskId: "task-shared" } } } : { text: "final answer" });
		await withSession(
			sb,
			envFor(sb, { BIOS_SELECTED_PROJECT_ID: sb.projectA.projectId, BIOS_SELECTED_TASK_ID: "task-shared", BIOS_SELECTED_WORKSPACE_ID: sb.projectA.workspaceId }),
			respond,
			async ({ session, requests, provider }) => {
				await session.prompt("请读取当前任务");
				assert.equal(provider.overflow(), false, "测试 provider 不应发生请求体溢出");
				const dump = JSON.stringify(requests.map((request) => request.body));
				assert.ok(requests.length >= 2, "应有工具循环请求");
				assert.ok(dump.includes(SECRET_A), `允许端点下工具结果应含任务正文：${dump.slice(0, 400)}`);
			},
			{ noTools: false },
		);
	} finally {
		await sb.cleanup();
	}
});
