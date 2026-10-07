import { test, expect, _electron as electron } from "@playwright/test";
import { existsSync, mkdtempSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { seedBiosGui } from "./biosGuiSeed.mjs";
import { startTestProvider } from "../packages/bios-agent/tests/helpers/piSessionHarness.mjs";
import { armStartupOverlayDismissal } from "./startupOverlays.ts";

const executable = process.env.PIDEK_E2E_EXECUTABLE_PATH ? resolve(process.env.PIDEK_E2E_EXECUTABLE_PATH) : null;
test.skip(executable === null || !existsSync(executable), "需要指定隔离目录包；不启动本机已安装的软件");

/** Directory package + auto-detected installed Pi + localhost SSE provider; Pi CLI is NOT bundled. */
test("B-08 目录包 + 本机真实 Pi：13 工具/2 Skills → 业务写入 → ACK → 真退出撤权", async ({}, testInfo) => {
	test.setTimeout(180_000);
	const provider = await startTestProvider(() => ({ text: "SYNTHETIC-BM07B: offline model response." }));
	const base = join(mkdtempSync(join(tmpdir(), "bios-bm07b-package-")), "isolated");
	let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
	try {
		const seeded = await seedBiosGui(base, provider.port);
		const settingsFile = join(seeded.profile, "settings.json");
		const settings = JSON.parse(await readFile(settingsFile, "utf8"));
		delete settings.customPiPath; // Exercise production CLI auto-detection; do not pin the repo's development dependency.
		await writeFile(settingsFile, JSON.stringify(settings));
		// Trust only this generated fixture in this isolated home, never the user's actual projects.
		await writeFile(join(seeded.agentDir, "trust.json"), JSON.stringify({ [seeded.workspace]: true }));
		const env = { ...process.env, CI: "1", PIDECK_E2E: "1", PIDECK_E2E_USER_DATA_DIR: seeded.profile, PI_CODING_AGENT_DIR: seeded.agentDir, USERPROFILE: base, HOME: base, APPDATA: join(base, "AppData", "Roaming"), LOCALAPPDATA: join(base, "AppData", "Local") };
		delete env.ELECTRON_RENDERER_URL;
		delete env.ELECTRON_RUN_AS_NODE;
		app = await electron.launch({ executablePath: executable!, args: [`--user-data-dir=${seeded.profile}`], env });
		const window = await app.firstWindow();
		await window.waitForLoadState("domcontentloaded");
		await armStartupOverlayDismissal(window);
		await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 30_000 });
		await window.getByRole("tab", { name: "项目", exact: true }).click();
		const project = window.locator(".conversation", { hasText: "Synthetic BIOS GUI" }).first();
		await project.click();
		await project.hover();
		await project.getByRole("button", { name: "普通会话", exact: true }).first().click();
		const composer = window.locator(".composer .rich-input");
		await expect(composer).toHaveAttribute("contenteditable", "true", { timeout: 30_000 });
		await composer.fill("SYNTHETIC package runtime check");
		await window.locator(".composer").getByRole("button", { name: "发送", exact: true }).click();
		await expect(window.locator(".message-timeline")).toContainText("SYNTHETIC-BM07B", { timeout: 45_000 });
		const firstBody = provider.requests[0].body;
		const biosTools = firstBody.tools.filter((entry: { function: { name: string } }) => entry.function.name.startsWith("bios_")).map((entry: { function: { name: string } }) => entry.function.name);
		expect(new Set(biosTools).size).toBe(13);
		const system = JSON.stringify(firstBody.messages.filter((entry: { role: string }) => entry.role === "system"));
		expect(system).toContain("bios-project-onboarding");
		expect(system).toContain("customer-feature-porting");
		const skillText = firstBody.messages
			.filter((entry: { role: string }) => entry.role === "system")
			.map((entry: { content: string }) => entry.content)
			.join("\n")
			.replaceAll("\\", "/")
			.toLowerCase();
		expect(skillText).toContain(join(executable!, "..", "resources", "bios-agent", "skills").replaceAll("\\", "/").toLowerCase());

		await window.locator(".header-drawer-toggle").first().click();
		await window.getByTestId("drawer-rail-bios").click();
		await window.getByTestId("bios-manage-open").click();
		await window.getByTestId(`bios-project-row-${seeded.projectId}`).click();
		await window.getByTestId("bios-workbench-section-tasks").click();
		const tasks = window.getByTestId("bios-task-section");
		await tasks.getByRole("button", { name: /SYNTHETIC-GUI-gui-task-a/ }).click();
		await tasks.getByRole("button", { name: "编辑正文", exact: true }).click();
		await tasks.getByRole("textbox", { name: "需求", exact: true }).fill("SYNTHETIC package business persisted");
		await tasks.getByRole("button", { name: "保存正文", exact: true }).click();
		await expect(tasks).toContainText("写入结果：updated");
		const task = JSON.parse(await readFile(join(seeded.root, "projects", seeded.projectId, "tasks", "gui-task-a.json"), "utf8"));
		expect(task.requirement).toBe("SYNTHETIC package business persisted");
		await tasks.getByRole("button", { name: "换对话接续", exact: true }).click();
		await tasks.getByRole("button", { name: "选择并打开上下文", exact: true }).click();
		await expect(tasks).toContainText("已同步", { timeout: 20_000 });
		await window.getByTestId("bios-management-dialog").getByRole("button", { name: "Close", exact: true }).click();
		await composer.fill("SYNTHETIC capture current context");
		await window.locator(".composer").getByRole("button", { name: "发送", exact: true }).click();
		// Title generation may make extra provider calls; locate the actual agent request, not request index 1.
		const currentRequest = () => provider.requests.find((request) => JSON.stringify(request.body?.messages).includes("SYNTHETIC capture current context") && request.body?.tools?.some((entry: { function: { name: string } }) => entry.function.name.startsWith("bios_")));
		await expect.poll(() => currentRequest() !== undefined, { timeout: 30_000 }).toBe(true);
		expect(JSON.stringify(currentRequest()!.body.messages)).toContain("SYNTHETIC package business persisted");

		// Exercise the production preload -> settings service -> AgentManager -> real OS exit chain.
		const result = await window.evaluate(async () => {
			const settings = await window.piDesktop.bios.getSettings();
			return window.piDesktop.bios.updateSettings({ ...settings, endpoint: "denied" });
		});
		expect(result.invalidated.length).toBeGreaterThan(0);
		expect(result.stopFailed).toEqual([]);
		expect(result.stopped.length).toBe(result.invalidated.length);
		await window.screenshot({ path: testInfo.outputPath("packaged-business-revoked.png") });
	} finally {
		if (app) await app.close();
		await provider.close();
	}
});
