/**
 * 用量查询配置管理 IPC 契约：配置入口在「模型/认证页」的用量查询弹窗，
 * 渲染层经三条通道读写/测试 usage-probes.json，必须三处同步
 * （通道 / 主进程 handler / preload），previewApi 同步提供 stub。
 * 配置宿主已收敛为 pi（~/.pi/agent），不再有 DSH 链路。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const ipc = readFileSync("src/shared/ipc.ts", "utf8");
const preload = readFileSync("src/preload/index.ts", "utf8");
const systemIpc = readFileSync("src/main/ipc/systemIpc.ts", "utf8");
const previewApi = readFileSync("src/renderer/src/previewApi.ts", "utf8");
const sharedTypes = readFileSync("src/shared/types/providerUsage.ts", "utf8");
const userUsageProbes = readFileSync("src/main/config/userUsageProbes.ts", "utf8");
const configManager = readFileSync("src/main/config/ConfigManager.ts", "utf8");

test("三条探针管理通道集中定义在 shared/ipc.ts", () => {
	assert.match(ipc, /configGetUsageProbes: "config:get-usage-probes"/);
	assert.match(ipc, /configSaveUsageProbes: "config:save-usage-probes"/);
	assert.match(ipc, /configTestUsageProbe: "config:test-usage-probe"/);
	// 旧的「轻量内置识别」通道已删除：内置命中不再隐藏「用量查询」按钮（认证页/模型页都要能点）。
	assert.doesNotMatch(ipc, /configUsageRecognized/);
});

test("主进程三个 handler 都注册且先校验后动作", () => {
	for (const channel of ["configGetUsageProbes", "configSaveUsageProbes", "configTestUsageProbe"]) {
		assert.match(systemIpc, new RegExp(`ipcChannels\\.${channel}`));
	}
	// 读取：按 provider 名请求（弹窗作用域），走 ConfigManager 的 per-provider 设置读取。
	const getHandler = systemIpc.match(/ipcMain\.handle\(ipcChannels\.configGetUsageProbes,[\s\S]*?\n\t\}\);/)?.[0] ?? "";
	assert.match(getHandler, /getUsageProbeSettings/);
	// 保存：入口 provider 校验 + 主进程校验后按 provider 合并落盘（保留其它条目）。
	const saveHandler = systemIpc.match(/ipcMain\.handle\(ipcChannels\.configSaveUsageProbes,[\s\S]*?\n\t\}\);/)?.[0] ?? "";
	assert.match(saveHandler, /saveUsageProbeForProvider/);
	assert.match(saveHandler, /Invalid provider name/);
	// 测试：模板 id 白名单校验（声明式 + 内置），复用 provider 端点解析。
	const testHandler = systemIpc.match(/ipcMain\.handle\(ipcChannels\.configTestUsageProbe,[\s\S]*?\n\t\}\);/)?.[0] ?? "";
	assert.match(testHandler, /configManager\.testUsageProbe/);
	assert.match(testHandler, /Unknown template/);
});

test("主进程写入路径固定在 configDir（禁止拼接渲染层传入路径）", () => {
	// 保存以 configManager.getUsageProbeConfigDir() 为根（~/.pi/agent），不接受渲染层传目录。
	assert.match(systemIpc, /saveUsageProbeForProvider\(\s*configManager\.getUsageProbeConfigDir\(\)/);
	// 探针载荷（apiKey/accessToken 等）绝不整体落日志：
	// 日志字段只允许 provider/template/success 这类非敏感摘要。
	const saveHandler = systemIpc.match(/ipcMain\.handle\(ipcChannels\.configSaveUsageProbes,[\s\S]*?\n\t\}\);/)?.[0] ?? "";
	assert.doesNotMatch(saveHandler, /apiKey\s*:/);
	assert.doesNotMatch(saveHandler, /accessToken\s*:/);
	assert.doesNotMatch(saveHandler, /userId\s*:/);
});

test("shared 契约：per-provider 配置类型 + 识别结果类型齐全", () => {
	assert.match(sharedTypes, /UsageProbeProviderConfig/);
	assert.match(sharedTypes, /UsageProbeRecognition/);
	assert.match(sharedTypes, /UsageProbeSettingsResult/);
	assert.match(sharedTypes, /UsageProbeSaveInput/);
	assert.match(sharedTypes, /UsageProbeTestInput/);
	// 安全边界：声明式模板不含任意代码执行面（无脚本/函数字段）。
	assert.doesNotMatch(sharedTypes, /extractor/);
	assert.doesNotMatch(sharedTypes, /code\s*:/);
	// providers 映射保存保留旧 probes 数组（AI 直接写的能力不丢）。
	assert.match(userUsageProbes, /existing\.probes/);
	// DSH 宿主维度已删除：不再有 backend 参数类型与 dsh 专用端点模块。
	assert.doesNotMatch(sharedTypes, /UsageProbeBackend/);
	assert.doesNotMatch(sharedTypes, /\bdsh\b/i);
});

test("preload 暴露与 previewApi stub 三处同步", () => {
	assert.match(preload, /getUsageProbes: \(provider: string\)/);
	assert.match(preload, /fetchUsage: \(provider: string\)/);
	assert.match(preload, /saveUsageProbes: \(payload: UsageProbeSaveInput\)/);
	assert.match(preload, /testUsageProbe: \(payload: UsageProbeTestInput\)/);
	assert.doesNotMatch(preload, /usageRecognized/);
	assert.match(previewApi, /getUsageProbes: async \(\) => \(\{ recognized: null/);
	assert.match(previewApi, /saveUsageProbes: async \(\) => \(\{ ok: false/);
	assert.match(previewApi, /testUsageProbe: async \(\) => \(\{ success: false/);
	assert.doesNotMatch(previewApi, /usageRecognized/);
});

test("配置宿主收敛为 pi：目录只解析 configDir，缓存 key 就是 provider 名", () => {
	// 配置目录不再按 backend 分流。
	assert.match(configManager, /private usageProbeSettingsDir\(\): string/);
	assert.doesNotMatch(configManager, /pideckUsageProbesDir|DSH_HOME|dshUsageEndpoint|normalizeDshDeepseekProvider/);
	// 用量读取/保存/识别/测试都不再带 backend 维度。
	assert.match(configManager, /async fetchProviderUsage\(provider: string\)/);
	assert.match(configManager, /async getUsageProbeSettings\(provider: string\)/);
	assert.match(configManager, /async recognizeUsageTemplate\(provider: string\)/);
	assert.match(configManager, /async testUsageProbe\(/);
	// 渲染层缓存 key = provider 名；发送给主进程的必须是原始 provider 名。
	const usageHook = readFileSync("src/renderer/src/hooks/useProviderUsage.ts", "utf8");
	assert.match(usageHook, /export function usageCacheKey\(provider: string\): string/);
	assert.match(usageHook, /usageCacheKey\(provider: string\): string \{\s*return provider;/);
	assert.match(usageHook, /fetchUsage\(provider\)/);
	assert.doesNotMatch(usageHook, /fetchUsage\(cacheKey/);
	assert.doesNotMatch(usageHook, /fetchUsage\(key/);
	assert.doesNotMatch(usageHook, /\bdsh\b/i);
	// DSH 专用端点模块与卡片已删除。
	assert.doesNotMatch(systemIpc, /DshProviderCards|dshUsageEndpoint/);
});

test("shared 契约包含旧探针配置类型（AI 直接写的 probes 数组兼容读取）", () => {
	assert.match(sharedTypes, /export type UsageProbeConfig = \{/);
	assert.match(sharedTypes, /export type UsageProbeParseConfig/);
});

test('用户探针明确拒绝 kind:"custom"（专用解析器仅限内置）', () => {
	assert.match(userUsageProbes, /probe\.parse\.kind === "custom"/);
	assert.match(userUsageProbes, /仅限内置，不支持用户配置/);
});

test("ConfigManager 用量查询按 provider 名路由：门控 + 识别 + 测试共用探测层", () => {
	// 统一入口签名（per-provider 路由取代「调用方先解析端点」）。
	assert.match(configManager, /async fetchProviderUsage\(provider: string\)/);
	assert.match(configManager, /async getUsageProbeSettings\(provider: string\)/);
	assert.match(configManager, /async recognizeUsageTemplate\(provider: string\)/);
	assert.match(configManager, /async testUsageProbe\(/);
	// 门控：用户未显式开启（enabled !== true）快速返回。
	assert.match(configManager, /enabled !== true/);
	// 声明式模板构建（general/newapi）在主进程，渲染层不可见密钥。
	assert.match(configManager, /buildDeclarativeUsageProbeTemplate/);
	// 三入口都经由 runUsageProbes（preflight/截断/redirect fail-closed 行为一致）。
	assert.match(configManager, /private async runUsageProbes\(/);
	assert.match(configManager, /await this\.runUsageProbes\(/);
});
