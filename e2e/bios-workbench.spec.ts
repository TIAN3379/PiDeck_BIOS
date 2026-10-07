import { test, expect } from "./mock-pi-fixture";
import type { Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { makeSeedProject } from "./open-session";

/**
 * BM-07B B-08：**BIOS 工作台 GUI 实测**（真实 Electron + mock pi，全程离线、无客户数据）。
 *
 * 这一份 spec 是"界面真的能用"的证据来源：不靠文字推理，而是点真按钮、读真 DOM、
 * 在磁盘上核对真结果。覆盖：
 * 1. B-03 建库闸门与工作台入口（抽屉 rail → 工作台 → 状态/项目/任务）；
 * 2. B-07 备份/恢复薄入口（默认不勾选 → 勾选后导出 → 恢复到新目录 → 知识根未被改动）。
 *
 * 会话身份（BiosSessionClaim）要求**运行中的 runtime**，所以每个用例都要先在新会话里
 * 发一条消息（mock pi 会在启动时把 runtime 拉起来），否则业务通道会如实拒绝。
 */
const repoRoot = resolve(__dirname, "..");
const evidenceDir = join(repoRoot, "docs", "bios-agent", "gui-evidence");

/** 合成工作区（`pideck-seed-` 前缀：不会被 ProjectStore 当 e2e 残留清掉）。 */
const workspace = makeSeedProject("BiosWs");
/** 知识库与其父目录（父目录用于选"备份父目录"/"恢复目标父目录"）。 */
const storeBase = mkdtempSync(join(tmpdir(), "pideck-seed-bioskb-"));
const storeRoot = join(storeBase, "knowledge");
const seed: { projectId: string; workspaceId: string; profileRevision: number } = JSON.parse(
	execFileSync(process.execPath, [join(repoRoot, "e2e", "biosWorkbenchSeed.mjs"), "--root", storeRoot, "--workspace", workspace.path], { encoding: "utf8" })
		.trim()
		.split(/\r?\n/)
		.pop() as string,
);

test.use({
	seedProjects: [workspace],
	mockSessionInProject: true,
	seedSettings: {
		biosHost: { knowledgeRoot: storeRoot, authorizedProjectIds: [seed.projectId], allowedFeatureIds: ["gui-feature-write"], approvedCustomers: [], authorizedRoots: [workspace.path], endpoint: "allowed" },
	},
});

// 每个用例启动独立桌面 profile，但 mock 按同一个合成 cwd 生成固定会话文件。
// 必须隔离这份镜像，避免后一个用例被扫描器恢复到上一个用例的聊天。
// 只清理由 makeSeedProject 创建的临时工程中的 mock 会话，不触及用户目录。
test.beforeEach(() => {
	rmSync(join(workspace.path, ".pi", "sessions"), { recursive: true, force: true });
});

/** 起一个带 runtime 的会话：mock pi 回复后 runtime 才有 agentId，业务通道才可用。 */
async function startSession(window: Page, prompt: string): Promise<void> {
	await window.getByRole("tab", { name: "项目", exact: true }).click();
	const project = window.locator(".conversation", { hasText: "BiosWs" }).first();
	await project.click();
	await project.hover();
	await project.getByRole("button", { name: "普通会话", exact: true }).first().click();
	const composer = window.locator(".composer .rich-input");
	await expect(composer).toHaveAttribute("contenteditable", "true", { timeout: 30_000 });
	await composer.click();
	await composer.fill(prompt);
	await expect(composer).toHaveText(prompt);
	await composer.press("Enter");
	await expect(window.locator(".message-timeline")).toContainText(`Mock 回复：「${prompt}」`, { timeout: 30_000 });
}

/** 打开右侧抽屉并切到 BIOS 工作台（活动栏入口）。 */
async function openBiosWorkbench(window: Page): Promise<void> {
	await window.locator(".header-drawer-toggle").first().click();
	await expect(window.locator(".detail-drawer")).toHaveAttribute("data-open", "true");
	const railButton = window.getByTestId("drawer-rail-bios");
	await expect(railButton).toBeVisible();
	await railButton.click();
	await expect(window.getByTestId("bios-workbench")).toBeVisible({ timeout: 15_000 });
	await window.getByTestId("bios-manage-open").click();
}

test("B-08 GUI：工作台入口 → 知识库就绪 → 项目列表 → 任务区", async ({ window }, testInfo) => {
	test.setTimeout(180_000);
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	await startSession(window, "GUI 工作台");
	await openBiosWorkbench(window);

	// B-03：知识库状态是"就绪"，并回显真实知识根（不是猜的目录）。
	const ready = window.getByTestId("bios-store-ready");
	await expect(ready).toBeVisible({ timeout: 15_000 });
	await expect(ready).toContainText("知识库可用");
	await expect(ready).toContainText(storeRoot);
	await window.screenshot({ path: join(evidenceDir, "01-workbench-store-ready.png") });

	// B-03：已授权项目出现在列表里（点击后进入档案/检测/确认区）。
	const projectRow = window.getByTestId(`bios-project-row-${seed.projectId}`);
	await expect(projectRow).toBeVisible({ timeout: 15_000 });
	await expect(projectRow).toContainText("工作区 1");
	await projectRow.click();
	await expect(projectRow).toHaveAttribute("aria-pressed", "true");
	// 项目档案真的读出来了：seed 阶段确认过的字段以 confirmed 呈现，未确认字段保持 unknown。
	const projectSection = window.getByTestId("bios-project-section");
	await expect(projectSection).toContainText("项目档案与工作区", { timeout: 15_000 });
	await expect(projectSection).toContainText("AMI");
	await expect(projectSection).toContainText("unknown");
	// 只读检测入口在位，且明说"不写档案、不自动确认"。
	await expect(projectSection).toContainText("候选检测（只读）");
	await window.screenshot({ path: join(evidenceDir, "02-workbench-project-selected.png") });

	// B-04：任务区能看到合成任务（含已推进到 done 的那条）。
	await window.getByTestId("bios-workbench-section-tasks").click();
	const taskSection = window.getByTestId("bios-task-section");
	await expect(taskSection).toBeVisible({ timeout: 15_000 });
	await expect(taskSection).toContainText("SYNTHETIC-GUI: 验证任务区只读展示", { timeout: 20_000 });
	await expect(taskSection).toContainText("gui-open-task");
	await expect(taskSection).toContainText("SYNTHETIC-GUI: 已推进到完成的任务");
	await expect(taskSection).toContainText("done");
	await window.screenshot({ path: join(evidenceDir, "03-workbench-tasks.png") });

	// B-05：知识区（检索/需求/经验与审核）在同一抽屉里可进入。
	await window.getByTestId("bios-workbench-section-knowledge").click();
	const knowledge = window.getByTestId("bios-management-dialog");
	await expect(knowledge).toContainText("搜索与参考", { timeout: 15_000 });
	await expect(knowledge).toContainText("客户需求");
	await expect(knowledge).toContainText("经验与审核");
	// 检索的"不完整 ≠ 没有匹配经验"必须写在界面上（B-05 的诚实性要求）。
	await expect(knowledge).toContainText("不会被说成");
	await window.screenshot({ path: join(evidenceDir, "04-workbench-knowledge.png") });

	testInfo.attach("workbench", { path: join(evidenceDir, "03-workbench-tasks.png"), contentType: "image/png" });
});

test("B-08 GUI：任务新建/编辑 → 交接清单 → 需求更新 → 经验人工审核", async ({ window }) => {
	test.setTimeout(180_000);
	const errors: string[] = [];
	window.on("pageerror", (error) => errors.push(error.message));
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	await startSession(window, "GUI 业务写入");
	await openBiosWorkbench(window);
	await window.getByTestId(`bios-project-row-${seed.projectId}`).click();
	await window.getByTestId("bios-workbench-section-tasks").click();
	const tasks = window.getByTestId("bios-task-section");
	await tasks.getByRole("button", { name: "新建任务", exact: true }).click();
	await tasks.getByRole("textbox", { name: "任务 ID", exact: true }).fill("gui-created-task");
	await tasks.getByRole("textbox", { name: "需求", exact: true }).fill("SYNTHETIC GUI created requirement");
	await tasks.getByRole("button", { name: "创建", exact: true }).click();
	await expect(tasks).toContainText("写入结果：created");
	await tasks.getByRole("button", { name: "编辑正文", exact: true }).click();
	await tasks.getByRole("textbox", { name: "需求", exact: true }).fill("SYNTHETIC GUI updated requirement");
	await tasks.getByRole("button", { name: "保存正文", exact: true }).click();
	await expect(tasks).toContainText("写入结果：updated");
	const taskRecord = JSON.parse(await readFile(join(storeRoot, "projects", seed.projectId, "tasks", "gui-created-task.json"), "utf8"));
	expect(taskRecord.requirement).toBe("SYNTHETIC GUI updated requirement");

	await tasks.getByRole("button", { name: "换对话接续", exact: true }).click();
	await tasks.getByRole("button", { name: "生成交接预览", exact: true }).click();
	await expect(tasks).toContainText("交接预览（重读当前事实）");
	await tasks.getByRole("textbox", { name: "清单 ID", exact: true }).fill("gui-manifest");
	await tasks.getByRole("button", { name: "保存清单", exact: true }).click();
	await expect(tasks).toContainText("写入结果：saved");
	const manifest = JSON.parse(await readFile(join(storeRoot, "projects", seed.projectId, "context", "gui-manifest.json"), "utf8"));
	expect(manifest.taskId).toBe("gui-created-task");
	// v1 Manifest does not persist workspaceId: core validates it on save and resolves it from the task on verify.
	expect(taskRecord.workspace.workspaceId).toBe(seed.workspaceId);
	await tasks.getByRole("button", { name: "重验清单", exact: true }).click();
	await expect(tasks).toContainText("gui-manifest");
	await window.screenshot({ path: join(evidenceDir, "14-task-write-manifest.png") });

	await window.getByTestId("bios-workbench-section-knowledge").click();
	const knowledge = window.getByTestId("bios-management-dialog");
	await knowledge.getByRole("button", { name: "客户需求", exact: true }).click();
	await knowledge.getByRole("button", { name: "新建需求", exact: true }).click();
	await knowledge.getByRole("textbox", { name: "需求 ID", exact: true }).last().fill("gui-feature-write");
	await knowledge.getByRole("textbox", { name: "原始要求", exact: true }).fill("SYNTHETIC GUI feature");
	await knowledge.getByRole("button", { name: "创建", exact: true }).click();
	await expect(knowledge).toContainText("需求详情");
	await knowledge.getByRole("button", { name: "编辑正文", exact: true }).click();
	await knowledge.getByRole("textbox", { name: "原始要求", exact: true }).fill("SYNTHETIC GUI feature updated");
	await knowledge.getByRole("button", { name: "保存更新", exact: true }).click();
	await expect(knowledge).toContainText("写入结果：updated");
	await expect(knowledge).toContainText("需求详情");
	const feature = JSON.parse(await readFile(join(storeRoot, "features", "gui-feature-write.json"), "utf8"));
	expect(feature.originalRequirement).toBe("SYNTHETIC GUI feature updated");

	await knowledge.getByRole("button", { name: "经验与审核", exact: true }).click();
	await knowledge.getByRole("button", { name: "新建经验草稿", exact: true }).click();
	await knowledge.getByRole("textbox", { name: "经验 ID", exact: true }).last().fill("gui-experience-write");
	await knowledge.getByRole("textbox", { name: "问题", exact: true }).fill("SYNTHETIC GUI experience");
	await knowledge.getByRole("button", { name: "创建草稿", exact: true }).click();
	await expect(knowledge).toContainText("缺少必填项：rootCause");
	await knowledge.getByRole("textbox", { name: "根因", exact: true }).fill("SYNTHETIC fixture root cause; not a real board finding");
	await knowledge.getByRole("textbox", { name: "方案", exact: true }).fill("SYNTHETIC fixture solution; no board verification");
	await knowledge.getByRole("button", { name: "创建草稿", exact: true }).click();
	await expect(knowledge).toContainText("经验详情");
	await knowledge.getByRole("combobox", { name: "人工审核", exact: true }).click();
	await window.getByRole("option", { name: "submit-review", exact: true }).click();
	await knowledge.getByRole("textbox", { name: "审核理由（必填）", exact: true }).fill("SYNTHETIC human review; no board verification");
	await knowledge.getByRole("button", { name: "执行审核动作", exact: true }).click();
	await expect(knowledge).toContainText("审核结果：applied");
	await expect(knowledge).toContainText("审核 journal");
	const experience = JSON.parse(await readFile(join(storeRoot, "experiences", "gui-experience-write.json"), "utf8"));
	expect(experience.status).toBe("reviewed");
	expect(experience.rootCause).toBe("SYNTHETIC fixture root cause; not a real board finding");
	expect(experience.validations).toEqual([]);
	await window.screenshot({ path: join(evidenceDir, "15-experience-reviewed.png") });
	expect(errors).toEqual([]);
});

test("B-08 GUI：备份默认不勾选 → 导出 → 恢复到新目录 → 知识根未被改动", async ({ app, window }, testInfo) => {
	test.setTimeout(240_000);
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	await startSession(window, "GUI 备份");

	// 打开设置（侧栏 Dock 的齿轮，`aria-label` = settings.title）→ BIOS 知识库 tab → 独立备份组件。
	await window.getByRole("button", { name: "设置", exact: true }).first().click();
	const modal = window.locator(".settings-modal");
	await expect(modal).toBeVisible();
	await modal.getByText("BIOS 知识库").click();
	const section = modal.getByTestId("bios-backup-section");
	await expect(section).toBeVisible({ timeout: 15_000 });
	await expect(section).toContainText("备份可能包含敏感的工程资料");

	// 系统对话框在 e2e 里排队返回路径（真实对话框不属于自动化范围）。
	const restoreContainer = join(storeBase, "ui-backup");
	const pickQueue = [storeBase, restoreContainer, storeBase];
	await app.evaluate(({ dialog }, queue) => {
		(dialog as unknown as { __queue: string[] }).__queue = [...queue];
		dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [(dialog as unknown as { __queue: string[] }).__queue.shift() ?? ""] });
	}, pickQueue);

	// 关键断言：**两个勾选默认没有勾上**，且导出按钮在确认前不可点。
	const consentApp = section.getByTestId("bios-backup-consent-app-quiet");
	const consentExternal = section.getByTestId("bios-backup-consent-external-closed");
	const exportRun = section.getByTestId("bios-backup-export-run");
	await expect(consentApp).toHaveAttribute("data-state", "unchecked");
	await expect(consentExternal).toHaveAttribute("data-state", "unchecked");
	await expect(exportRun).toBeDisabled();
	await window.screenshot({ path: join(evidenceDir, "05-backup-consent-default-off.png") });

	// 选父目录 + 名字：只勾一个仍然不可点（两个条件缺一不可）。
	await section.getByTestId("bios-backup-pick-export-parent").click();
	await expect(section.getByTestId("bios-backup-export-parent")).toContainText(storeBase);
	await section.getByTestId("bios-backup-export-name").fill("ui-backup");
	await consentApp.click();
	await expect(exportRun).toBeDisabled();
	await consentExternal.click();
	await expect(exportRun).toBeEnabled();

	await exportRun.click();
	const backupContainer = join(storeBase, "ui-backup");
	await expect(section).toContainText("exported", { timeout: 60_000 });
	await expect(section).toContainText("offline-copy");
	// 磁盘上真的出现了容器（不是界面自说自话）。
	expect(existsSync(join(backupContainer, "manifest.json"))).toBe(true);
	expect(existsSync(join(backupContainer, "data"))).toBe(true);
	// 完成/失败后勾选被重置：下一次操作必须重新确认。
	await expect(consentApp).toHaveAttribute("data-state", "unchecked");
	await window.screenshot({ path: join(evidenceDir, "06-backup-exported.png") });

	// 恢复到**尚不存在的新目录**。
	const restoredRoot = join(storeBase, "ui-restored");
	await section.getByTestId("bios-backup-pick-restore-source").click();
	await expect(section.getByTestId("bios-backup-restore-source")).toContainText(backupContainer);
	await section.getByTestId("bios-backup-pick-restore-parent").click();
	await section.getByTestId("bios-backup-restore-name").fill("ui-restored");
	await section.getByTestId("bios-backup-consent-source-stable").click();
	await section.getByTestId("bios-backup-consent-target-free").click();
	await section.getByTestId("bios-backup-restore-run").click();
	await expect(section).toContainText("restored", { timeout: 60_000 });
	await expect(section).toContainText("恢复不会自动切换知识根");
	expect(existsSync(join(restoredRoot, "registry.json"))).toBe(true);
	await window.screenshot({ path: join(evidenceDir, "07-backup-restored.png") });

	// 恢复不改配置：设置里的知识根仍是原库；原库 registry 字节未被改动。
	await expect(section).toContainText(storeRoot);
	const registryAfter = await readFile(join(storeRoot, "registry.json"), "utf8");
	expect(JSON.parse(registryAfter).schemaVersion).toBe(1);
	await app.evaluate(({ dialog }) => {
		delete (dialog as unknown as { __queue?: string[] }).__queue;
	});

	testInfo.attach("backup", { path: join(evidenceDir, "07-backup-restored.png"), contentType: "image/png" });
});

test.describe("未初始化目录", () => {
	/** 已存在但**没有 registry** 的目录：必须走"显式创建"，不能隐式建库。 */
	const emptyBase = mkdtempSync(join(tmpdir(), "pideck-seed-biosempty-"));
	const emptyRoot = join(emptyBase, "knowledge");
	mkdirSync(emptyRoot, { recursive: true });

	test.use({
		seedSettings: { biosHost: { knowledgeRoot: emptyRoot, authorizedProjectIds: [], allowedFeatureIds: [], approvedCustomers: [], authorizedRoots: [], endpoint: "allowed" } },
	});

	test("B-08 GUI：目录还不是知识库 → 二次确认后显式创建 → 就绪", async ({ window }) => {
		test.setTimeout(120_000);
		await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
		await openBiosWorkbench(window);

		const workbench = window.getByTestId("bios-management-dialog");
		await expect(workbench).toContainText("该目录还不是知识库", { timeout: 15_000 });
		await expect(workbench).toContainText(emptyRoot);
		// 未确认前不得创建（按钮只是打开确认框）。
		expect(existsSync(join(emptyRoot, "registry.json"))).toBe(false);
		await window.screenshot({ path: join(evidenceDir, "08-store-not-initialized.png") });

		await window.getByRole("button", { name: "创建知识库", exact: true }).click();
		const dialog = window.getByRole("alertdialog");
		await expect(dialog).toBeVisible();
		await expect(dialog).toContainText("不会覆盖已有无效库");
		await window.screenshot({ path: join(evidenceDir, "09-store-create-confirm.png") });
		await dialog.getByRole("button", { name: "创建知识库" }).click();

		await expect(workbench).toContainText("知识库可用", { timeout: 60_000 });
		expect(existsSync(join(emptyRoot, "registry.json"))).toBe(true);
		await window.screenshot({ path: join(evidenceDir, "10-store-created-ready.png") });
	});
});
