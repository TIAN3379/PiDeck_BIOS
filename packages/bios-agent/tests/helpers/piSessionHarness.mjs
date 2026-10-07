/**
 * 真实 Pi SDK 会话的**离线测试台**（r31/r32/r33 共用）。
 *
 * 组成：
 * - 本机回环 SSE provider：记录**真实请求体**，可按脚本返回文本或真实 tool call；
 *   自带请求体上限、请求数上限、请求/头部超时与带 socket 清理的关闭等待（不是无限挂起的桩）。
 * - `withSession`：临时 agentDir + `models.json` + `DefaultResourceLoader`（**必须 reload**，
 *   否则扩展没加载 ⇒ 假通过）+ 真实 `AgentSession`；结束后还原环境变量并清理临时目录。
 *
 * 全部离线：不联网、不读客户库、不调用真实模型。
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXTENSION_ENTRY, HOST_MISSING_MESSAGE, PI_MODULE_ENTRY } from "./biosExtension.mjs";

/** 测试 provider 的硬限额（避免桩本身挂死或吃满内存）。 */
export const MAX_BODY_BYTES = 4 * 1024 * 1024;
export const MAX_REQUESTS = 40;

/**
 * 本机 SSE 测试 provider。`respond(parsedBody, index)` 返回 `{ text }` 或 `{ toolCall }`。
 */
export async function startTestProvider(respond) {
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
			const chunk = (delta, finish) => `data: ${JSON.stringify({ id: "chatcmpl-bios", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
			if (scripted.toolCall === undefined) {
				res.write(chunk({ role: "assistant", content: scripted.text ?? "acknowledged" }, null));
				res.write(chunk({}, "stop"));
			} else {
				res.write(
					chunk(
						{
							role: "assistant",
							content: null,
							tool_calls: [{ index: 0, id: scripted.toolCallId ?? "call-1", type: "function", function: { name: scripted.toolCall.name, arguments: JSON.stringify(scripted.toolCall.arguments) } }],
						},
						null,
					),
				);
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

/**
 * 跑一段真实会话用例：注入 env（并在结束后还原）、装载扩展、创建 `AgentSession`。
 *
 * `extra` 直接并入 `createAgentSession`（例如 `{ noTools: false }`：不传时**不传该键**，
 * 保持宿主默认行为）。
 */
export async function withSession(sb, env, respond, fn, extra = {}) {
	assert.ok(PI_MODULE_ENTRY, HOST_MISSING_MESSAGE);
	const pi = await import(`file:///${PI_MODULE_ENTRY.replace(/\\/g, "/")}`);
	const provider = await startTestProvider(respond);
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
		assert.ok(model !== undefined, "models.json 注册的测试模型必须可见");
		const resourceLoader = new pi.DefaultResourceLoader({ cwd: sb.workspaceA, agentDir, additionalExtensionPaths: [EXTENSION_ENTRY], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
		// 必须显式 reload（否则 getExtensions() 为空 ⇒ 扩展没加载的假通过）。
		await resourceLoader.reload();
		const loaded = resourceLoader.getExtensions();
		assert.deepEqual(loaded.errors, [], "会话侧扩展加载不应产生错误");
		const created = await pi.createAgentSession({ cwd: sb.workspaceA, model, modelRuntime, resourceLoader, ...extra });
		session = created.session;
		return await fn({ session, requests: provider.requests, provider, applyEnv: (patch) => applyEnvPatch(applied, saved, patch) });
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

/** 会话中途安全改配置（记录原值以便最终还原）。 */
function applyEnvPatch(applied, saved, patch) {
	for (const [key, value] of Object.entries(patch)) {
		applied[key] = value;
		if (!(key in saved)) saved[key] = process.env[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

/** path.delimiter 分隔（适配层注入授权根的官方分隔符）。 */
export function rootsOf(...paths) {
	return paths.join(process.platform === "win32" ? ";" : ":");
}
