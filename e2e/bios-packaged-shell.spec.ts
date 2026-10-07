import { test, expect, _electron as electron } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { armStartupOverlayDismissal } from "./startupOverlays";
import { ensureWindowsProfileSkeleton } from "./win-profile";

/**
 * BM-07B B-08：**包内启动**的新 UI 冒烟（只有设了 `PIDEK_E2E_EXECUTABLE_PATH` 才跑）。
 *
 * 目的与边界：
 * - 目的：证明 BIOS 工作台/首次使用闸门/备份薄入口这些新界面**在目录包里**能起来，
 *   且不依赖开发机源码绝对路径（profile 里**不写** `customPiPath`，Pi CLI 仍需另装）；
 * - 边界：这条用例**不发送任何消息**，因此不覆盖"包内真实 pi + 会话身份"的业务链路
 *   （那条链路由 `bios-packaged-business.spec.mts` 的本机真实 Pi + 离线模型覆盖，
 *   见交付说明"未测项"）。
 */
const executable = process.env.PIDEK_E2E_EXECUTABLE_PATH ? resolve(process.env.PIDEK_E2E_EXECUTABLE_PATH) : null;
const repoRoot = resolve(__dirname, "..");
const seedScript = join(repoRoot, "e2e", "biosWorkbenchSeed.mjs");

test.skip(executable === null || !existsSync(executable), "需要 PIDEK_E2E_EXECUTABLE_PATH 指向目录包里的可执行文件");

test("B-08 包内启动：工作台、备份薄入口与 UX-03 简化界面可用", async ({}, testInfo) => {
	test.setTimeout(180_000);
	const userDataRoot = mkdtempSync(join(tmpdir(), "pideck-pkg-bios-"));
	const profile = join(userDataRoot, "profile");
	const workspace = join(userDataRoot, "SyntheticBoard");
	const storeRoot = join(userDataRoot, "knowledge");
	mkdirSync(profile, { recursive: true });
	if (process.platform === "win32") ensureWindowsProfileSkeleton(userDataRoot);

	const seed = JSON.parse(execFileSync(process.execPath, [seedScript, "--root", storeRoot, "--workspace", workspace], { encoding: "utf8" }).trim().split(/\r?\n/).pop() as string) as { projectId: string };

	// 刻意**不写** customPiPath：不依赖开发机源码绝对路径；这里不发送模型请求。
	writeFileSync(
		join(profile, "settings.json"),
		JSON.stringify({
			piEnvironmentChecked: true,
			checkUpdatesOnStartup: false,
			dshHomeDir: join(userDataRoot, "dsh-home"),
			biosHost: { knowledgeRoot: storeRoot, authorizedProjectIds: [seed.projectId], allowedFeatureIds: [], approvedCustomers: [], authorizedRoots: [workspace], endpoint: "allowed" },
		}),
	);
	writeFileSync(join(profile, "projects.json"), JSON.stringify([{ id: "packaged-bios-ws", name: "Packaged BIOS WS", path: workspace, lastOpenedAt: Date.now(), sortOrder: 0 }]));

	const env = {
		...process.env,
		CI: "1",
		PIDECK_E2E: "1",
		PIDECK_E2E_USER_DATA_DIR: profile,
		...(process.platform === "win32" ? { APPDATA: userDataRoot, LOCALAPPDATA: userDataRoot, USERPROFILE: userDataRoot, HOME: userDataRoot } : { HOME: userDataRoot }),
	};
	delete env.ELECTRON_RENDERER_URL;
	delete env.ELECTRON_RUN_AS_NODE;

	const app = await electron.launch({ executablePath: executable as string, args: [`--user-data-dir=${profile}`], env });
	try {
		const window = await app.firstWindow();
		await window.waitForLoadState("domcontentloaded");
		await armStartupOverlayDismissal(window);
		await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 30_000 });
		await window.screenshot({ path: testInfo.outputPath("packaged-boot.png") });

		// 新 UI 入口：活动栏 → BIOS 工作台（包内首屏就是草稿会话，无需再点「新会话」）。
		// 无 runtime 时业务区如实提示"没有运行中的会话"，但闸门与状态必须显示。
		await window.locator(".header-drawer-toggle").first().click();
		await window.getByTestId("drawer-rail-bios").click();
		const workbench = window.getByTestId("bios-workbench");
		await expect(workbench).toBeVisible({ timeout: 20_000 });
		await expect(window.getByTestId("bios-compact-status")).toBeVisible();
		await expect(window.getByTestId("bios-store-ready")).toHaveCount(0, "store details are not part of the default sidebar");
		await window.getByTestId("bios-manage-open").click();
		await expect(window.getByTestId("bios-store-ready")).toContainText("知识库可用", { timeout: 20_000 });
		await expect(window.getByTestId("bios-store-ready")).toContainText(storeRoot);
		await window.screenshot({ path: testInfo.outputPath("packaged-workbench.png") });
		await window.keyboard.press("Escape");

		// 备份薄入口（独立组件）在包内可打开；默认不许确认。
		await window.getByRole("button", { name: "设置", exact: true }).first().click();
		const modal = window.locator(".settings-modal");
		await expect(modal).toBeVisible();
		await modal.getByText("BIOS 知识库").click();
		const section = modal.getByTestId("bios-backup-section");
		await expect(section).toBeVisible({ timeout: 20_000 });
		await expect(section.getByTestId("bios-backup-consent-app-quiet")).toHaveAttribute("data-state", "unchecked");
		await expect(section.getByTestId("bios-backup-export-run")).toBeDisabled();
		await expect(modal.getByRole("textbox", { name: /授权项目 ID/ })).not.toBeVisible();
		await modal.locator("summary", { hasText: "高级：管理项目、需求、客户和目录授权" }).click();
		await expect(modal.getByRole("textbox", { name: /授权项目 ID/ })).toHaveValue(seed.projectId);
		await window.screenshot({ path: testInfo.outputPath("packaged-settings.png") });
		await window.keyboard.press("Escape");

		// 已有绑定无需重复确认；管理窗口也不提供第二份接入表单。
		await window.getByRole("tab", { name: "项目", exact: true }).click();
		const project = window.locator(".conversation", { hasText: "Packaged BIOS WS" }).first();
		await project.click();
		await project.hover();
		await project.getByRole("button", { name: "普通会话", exact: true }).first().click();
		await window.locator(".header-drawer-toggle").first().click();
		await window.getByTestId("drawer-rail-bios").click();
		const settingsBeforePreview = await window.evaluate(() => window.piDesktop.bios.getSettings());
		await window.getByTestId("bios-manage-open").click();
		await expect(window.getByTestId("bios-management-dialog")).toBeVisible();
		await expect(window.getByTestId("bios-onboarding")).toHaveCount(0);
		await expect(window.getByTestId("bios-first-run")).toHaveCount(0);
		await window.screenshot({ path: testInfo.outputPath("packaged-onboarding-preview.png") });
		await window.keyboard.press("Escape");
		expect(await window.evaluate(() => window.piDesktop.bios.getSettings())).toEqual(settingsBeforePreview);
	} finally {
		await app.close();
	}
});
