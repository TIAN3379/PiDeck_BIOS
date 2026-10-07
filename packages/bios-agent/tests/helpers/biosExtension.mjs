/**
 * 测试用：**真实 Pi 宿主加载器**装载本包扩展。
 *
 * 多个测试都要"用宿主实际注册的 tool.execute / 事件 handler / 命令 handler"，因此把装载逻辑
 * 集中在这里（避免每个测试各写一份，也避免某一份悄悄用桩替代真实加载器）。
 * 宿主缺失时**失败**（不是 skip）：离线证据必须来自真实安装的宿主版本。
 */
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PACKAGE_ROOT = fileURLToPath(new URL("../..", import.meta.url));
export const EXTENSION_ENTRY = join(PACKAGE_ROOT, "extensions", "index.ts");
const LOCAL_HOST_ROOT = join(PACKAGE_ROOT, "node_modules", "@earendil-works", "pi-coding-agent");
export const HOST_MISSING_MESSAGE = `未找到本机安装的 @earendil-works/pi-coding-agent（${LOCAL_HOST_ROOT}）：请先在 packages/bios-agent 下 npm install`;

function resolvePiFile(relativePath) {
	const roots = [process.env.PI_CODING_AGENT_ROOT, LOCAL_HOST_ROOT].filter((value) => typeof value === "string" && value !== "");
	for (const root of roots) {
		const candidate = join(root, relativePath);
		if (existsSync(candidate)) return candidate;
	}
	return undefined;
}

export const PI_MODULE_ENTRY = resolvePiFile("dist/index.js");

/** @returns {Promise<{ pi: Record<string, any>, extension: Record<string, any>, agentDir: string, cleanup: () => void }>} */
export async function loadBiosExtension() {
	assert.ok(PI_MODULE_ENTRY, HOST_MISSING_MESSAGE);
	const pi = await import(pathToFileURL(PI_MODULE_ENTRY).href);
	// agentDir 指向空目录：隔离宿主已安装的个人扩展，保证断言只针对本包。
	const agentDir = mkdtempSync(join(tmpdir(), "bios-agent-ext-"));
	const result = await pi.discoverAndLoadExtensions([EXTENSION_ENTRY], PACKAGE_ROOT, agentDir);
	assert.deepEqual(result.errors, [], "扩展加载不应产生错误");
	assert.equal(result.extensions.length, 1, "只应有一个自动加载入口");
	return { pi, extension: result.extensions[0], runtime: result.runtime, agentDir, cleanup: () => rmSync(agentDir, { recursive: true, force: true }) };
}

/** 取真实注册的工具定义（找不到即失败）。 */
export function toolOf(extension, name) {
	const registered = extension.tools.get(name);
	assert.ok(registered !== undefined, `${name} 必须注册`);
	return registered.definition;
}

/** 取真实注册的命令 handler。 */
export function commandOf(extension, name) {
	const registered = extension.commands.get(name);
	assert.ok(registered !== undefined, `${name} 必须注册`);
	return registered.handler;
}

/** 调用一次工具并返回结果（真实 execute 契约：toolCallId, params, signal, onUpdate, ctx）。 */
export async function callTool(extension, name, params, { cwd, signal, sessionManager } = {}) {
	const definition = toolOf(extension, name);
	return definition.execute(`call-${name}`, params, signal, undefined, { cwd, sessionManager });
}

/** 结果里所有模型可见字节（content 文本 + details JSON）。 */
export function visibleBytes(result) {
	const texts = (result.content ?? []).map((part) => (typeof part === "string" ? part : (part?.text ?? "")));
	return `${texts.join("\n")}\n${JSON.stringify(result.details ?? {})}`;
}
