/**
 * AW-09：**打包态**自主工作流验证（独立目录包，不是开发态、不是本机已安装版本）。
 *
 * 本文件只用**真实目录包 + 真实 Pi 加载器 + 本机回环 SSE provider**，
 * 不调用真实模型、不读写任何真实知识库或客户源码。
 *
 * 两条独立证据：
 * 1. 许可开启：用户只说了一句工程问题（没有提醒"查经验/记住/保存"），
 *    包内扩展自动准备背景、自动调用 BIOS 只读工具，并把**真实执行事实**写成检查点与状态索引；
 *    四份 Skills 与自动化指导确实进了系统提示；
 *    设置的持久开关能真正关掉许可并落盘。
 * 2. 许可未开（负例对照）：同一路径下不注入自动化指导、不产生任何 `automation/` 记录。
 *
 * 边界：脚本 SSE 只用于**触发真实工具循环**，不能作为"真实模型自主决策质量"的证据。
 * 真实模型闭环、GUI 目视与安装器安装/卸载矩阵不在本文件范围。
 */
import { test, expect, _electron as electron } from "@playwright/test";
import { existsSync, mkdtempSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { seedBiosGui } from "./biosGuiSeed.mjs";
import { startTestProvider } from "../packages/bios-agent/tests/helpers/piSessionHarness.mjs";
import { armStartupOverlayDismissal } from "./startupOverlays.ts";

const executable = process.env.PIDEK_E2E_EXECUTABLE_PATH ? resolve(process.env.PIDEK_E2E_EXECUTABLE_PATH) : null;
test.skip(executable === null || !existsSync(executable), "需要指定隔离目录包；不启动本机已安装的软件");

const PROMPT = "SYNTHETIC-AW: 分析一下这个工程为什么启动慢，先不要改代码";
const MARKER = "SYNTHETIC-AW";

/**
 * 第一次请求触发真实 BIOS 只读工具；一旦出现**工具结果消息**就只回文本。
 *
 * 不能用"消息里出现工具名"判断：系统提示会列出可用工具名，会被误判成已有结果。
 */
function automationScript() {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	return (parsed: any) => {
		const hasToolResult = (parsed?.messages ?? []).some((message: any) => message?.role === "tool" || message?.tool_call_id !== undefined);
		return hasToolResult ? { text: "SYNTHETIC-AW-RESULT: 已按只读方式调查，未修改任何文件。" } : { toolCall: { name: "bios_get_project_info", arguments: {} } };
	};
}

async function launchPackaged(base: string, profile: string, agentDir: string, workspace: string) {
	const trustFile = join(agentDir, "trust.json");
	await writeFile(trustFile, JSON.stringify({ [workspace]: true }));
	const env = {
		...process.env,
		CI: "1",
		PIDECK_E2E: "1",
		PIDECK_E2E_USER_DATA_DIR: profile,
		PI_CODING_AGENT_DIR: agentDir,
		USERPROFILE: base,
		HOME: base,
		APPDATA: join(base, "AppData", "Roaming"),
		LOCALAPPDATA: join(base, "AppData", "Local"),
	};
	delete (env as Record<string, unknown>).ELECTRON_RENDERER_URL;
	delete (env as Record<string, unknown>).ELECTRON_RUN_AS_NODE;
	const app = await electron.launch({ executablePath: executable!, args: [`--user-data-dir=${profile}`], env });
	const window = await app.firstWindow();
	await window.waitForLoadState("domcontentloaded");
	await armStartupOverlayDismissal(window);
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 30_000 });
	return { app, window };
}

/** 打开合成工程 + 普通会话，只发一句工程问题（不带任何"保存/查经验"提醒）。 */
async function sendEngineeringPrompt(window: { getByRole: (role: string, options?: unknown) => any; locator: (selector: string) => any }) {
	await window.getByRole("tab", { name: "项目", exact: true }).click();
	const project = window.locator(".conversation", { hasText: "Synthetic BIOS GUI" }).first();
	await project.click();
	await project.hover();
	await project.getByRole("button", { name: "普通会话", exact: true }).first().click();
	const composer = window.locator(".composer .rich-input");
	await expect(composer).toHaveAttribute("contenteditable", "true", { timeout: 30_000 });
	await composer.fill(PROMPT);
	await window.locator(".composer").getByRole("button", { name: "发送", exact: true }).click();
}

function automationDir(root: string, workspaceId: string) {
	return join(root, "automation", "workspaces", workspaceId);
}

test("AW-09 目录包：未提醒也会自动准备/检索/记账，且设置开关可持久关闭", async ({}, testInfo) => {
	test.setTimeout(300_000);
	const provider = await startTestProvider(automationScript());
	const base = join(mkdtempSync(join(tmpdir(), "bios-aw-package-")), "isolated");
	let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
	try {
		const seeded = await seedBiosGui(base, provider.port, { automation: true });
		const settingsFile = join(seeded.profile, "settings.json");
		const settings = JSON.parse(await readFile(settingsFile, "utf8"));
		delete settings.customPiPath; // 走生产自动探测，不用仓库相对路径。
		await writeFile(settingsFile, JSON.stringify(settings));
		expect(settings.biosHost.automation?.enabled).toBe(true);

		({ app } = await launchPackaged(base, seeded.profile, seeded.agentDir, seeded.workspace));
		const window = await app!.firstWindow();
		await sendEngineeringPrompt(window);
		await expect(window.locator(".message-timeline")).toContainText(`${MARKER}-RESULT`, { timeout: 90_000 });

		// 1) 系统提示里确实有自动化指导与四份 Skills（包内 resources 加载）。
		const agentRequest = () => provider.requests.find((request) => JSON.stringify(request.body?.messages).includes(MARKER) && request.body?.tools?.some((entry: { function: { name: string } }) => entry.function.name.startsWith("bios_")));
		await expect.poll(() => agentRequest() !== undefined, { timeout: 30_000 }).toBe(true);
		const system = JSON.stringify(agentRequest()!.body.messages.filter((entry: { role: string }) => entry.role === "system"));
		expect(system).toContain("BIOS 默认自主工作流");
		for (const skill of ["common-uefi", "bios-investigation", "bios-project-onboarding", "customer-feature-porting"]) expect(system).toContain(skill);

		// 2) 真实执行事实在打包态被自动落盘（用户没有说"保存"）。
		const dir = automationDir(seeded.root, seeded.workspaceId);
		const checkpointsDir = join(dir, "checkpoints");
		await expect.poll(async () => (existsSync(checkpointsDir) ? (await readdir(checkpointsDir)).length : 0), { timeout: 30_000 }).toBeGreaterThan(0);
		const files = (await readdir(checkpointsDir)).filter((name) => name.endsWith(".json"));
		const checkpoints = [];
		for (const name of files) {
			const checkpoint = JSON.parse(await readFile(join(checkpointsDir, name), "utf8"));
			expect(checkpoint.version).toBe(1);
			expect(checkpoint.projectId).toBe(seeded.projectId);
			expect(checkpoint.workspaceId).toBe(seeded.workspaceId);
			// 文件名的稳定运行 ID 必须就是记录里的 runId（幂等去重的基础）。
			expect(checkpoint.runId).toBe(name.replace(/\.json$/, ""));
			checkpoints.push(checkpoint);
		}
		// 真实执行事实（自动调用的 BIOS 只读工具）必须被记进检查点。
		expect(checkpoints.flatMap((checkpoint) => checkpoint.executed.map((fact: { tool: string }) => fact.tool))).toContain("bios_get_project_info");
		const state = JSON.parse(await readFile(join(dir, "state.json"), "utf8"));
		expect(state.version).toBe(1);
		expect(state.checkpoints.length).toBeGreaterThan(0);
		await window.screenshot({ path: testInfo.outputPath("packaged-automation-run.png") });

		// 3) 持久开关：设置页默认勾选，取消后保存必须真正落盘（关闭 = 回到手动模式）。
		await window.getByRole("button", { name: "设置", exact: true }).first().click();
		const modal = window.locator(".settings-modal");
		await expect(modal).toBeVisible();
		await modal.getByText("BIOS 知识库", { exact: true }).click();
		const toggle = modal.getByTestId("bios-settings-automation");
		await expect(toggle).toHaveAttribute("data-state", "checked", { timeout: 20_000 });
		await toggle.click();
		await expect(toggle).toHaveAttribute("data-state", "unchecked");
		await modal.getByRole("button", { name: "保存可信配置", exact: true }).click();
		await expect
			.poll(
				async () => {
					const saved = JSON.parse(await readFile(settingsFile, "utf8"));
					return saved.biosHost?.automation?.enabled;
				},
				{ timeout: 20_000 },
			)
			.toBe(false);
		const saved = JSON.parse(await readFile(settingsFile, "utf8"));
		expect(saved.biosHost.automation.localBookkeeping).toBe(false);
		expect(saved.biosHost.automation.injectProjectData).toBe(false);
		// 关闭后许可版本回到 0（"未授予"而不是"关着但还带旧版本"）：旧指纹永远不会再匹配。
		expect(saved.biosHost.automation.version).toBe(0);
		await window.screenshot({ path: testInfo.outputPath("packaged-automation-settings.png") });
	} finally {
		if (app) await app.close();
		await provider.close();
	}
});

test("AW-09 目录包负例：未开启自动化时不注入指导、不产生任何自动化记录", async ({}, testInfo) => {
	test.setTimeout(240_000);
	const provider = await startTestProvider(automationScript());
	const base = join(mkdtempSync(join(tmpdir(), "bios-aw-package-off-")), "isolated");
	let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
	try {
		const seeded = await seedBiosGui(base, provider.port);
		const settingsFile = join(seeded.profile, "settings.json");
		const settings = JSON.parse(await readFile(settingsFile, "utf8"));
		delete settings.customPiPath;
		await writeFile(settingsFile, JSON.stringify(settings));
		// 缺省即为关闭（与 0.9.1 行为一致）。
		expect(settings.biosHost.automation).toBeUndefined();

		({ app } = await launchPackaged(base, seeded.profile, seeded.agentDir, seeded.workspace));
		const window = await app!.firstWindow();
		await sendEngineeringPrompt(window);
		await expect(window.locator(".message-timeline")).toContainText(`${MARKER}-RESULT`, { timeout: 90_000 });

		const agentRequest = () => provider.requests.find((request) => JSON.stringify(request.body?.messages).includes(MARKER) && request.body?.tools?.some((entry: { function: { name: string } }) => entry.function.name.startsWith("bios_")));
		await expect.poll(() => agentRequest() !== undefined, { timeout: 30_000 }).toBe(true);
		const system = JSON.stringify(agentRequest()!.body.messages.filter((entry: { role: string }) => entry.role === "system"));
		expect(system).not.toContain("BIOS 默认自主工作流");
		// Skills 仍随包加载（能力在，只是不做自动记账）。
		expect(system).toContain("common-uefi");

		await expect.poll(() => existsSync(automationDir(seeded.root, seeded.workspaceId)), { timeout: 10_000 }).toBe(false);
		await window.screenshot({ path: testInfo.outputPath("packaged-automation-off.png") });
	} finally {
		if (app) await app.close();
		await provider.close();
	}
});
