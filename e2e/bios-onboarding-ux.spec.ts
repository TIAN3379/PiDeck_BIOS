import { test, expect } from "./mock-pi-fixture";
import type { Page } from "@playwright/test";
import { makeSeedProject } from "./open-session";

const workspace = makeSeedProject("BiosUxSynthetic");
test.use({ seedProjects: [workspace] });

async function startSession(window: Page): Promise<void> {
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	await window.getByRole("tab", { name: "项目", exact: true }).click();
	const project = window.locator(".conversation", { hasText: "BiosUxSynthetic" }).first();
	await project.click();
	await project.hover();
	await project.getByRole("button", { name: "普通会话", exact: true }).first().click();
	await send(window, "UX smoke");
	await expect(window.locator(".message-timeline")).toContainText("Mock 回复：「UX smoke」", { timeout: 30_000 });
}

async function send(window: Page, prompt: string): Promise<void> {
	const composer = window.locator(".composer .rich-input");
	await expect(composer).toHaveAttribute("contenteditable", "true", { timeout: 30_000 });
	await composer.fill(prompt);
	await composer.press("Enter");
}

test("UX-01: 可修改预填、切题保留、多行原样提交", async ({ window }, testInfo) => {
	test.setTimeout(120_000);
	await startSession(window);
	await send(window, "ASK_PREFILL");
	const bar = window.locator(".ask-inline-bar");
	await expect(bar).toBeVisible({ timeout: 15_000 });
	await expect(bar).toContainText("已答 0/2");
	await expect(bar.locator("input")).toHaveValue("SampleBoard");
	await expect(bar).toContainText("已预填建议");
	await bar.locator("input").fill("EditedBoard");
	await bar.locator(".ask-batch-tab").nth(1).click();
	await expect(bar.locator("textarea")).toHaveValue("第一行\n第二行");
	await bar.locator(".ask-batch-tab").nth(0).click();
	await expect(bar.locator("input")).toHaveValue("EditedBoard");
	await bar.getByRole("button", { name: "提交", exact: true }).click();
	await bar.locator(".ask-batch-tab").nth(1).click();
	await window.screenshot({ path: testInfo.outputPath("prefill-draft.png") });
	await bar.getByRole("button", { name: "提交", exact: true }).click();
	await bar.getByRole("tab", { name: "提交审阅", exact: true }).click();
	await expect(bar).toContainText("确认全部回答");
	await bar.getByRole("button", { name: "提交", exact: true }).click();
	await expect(window.locator(".message-timeline")).toContainText("EditedBoard", { timeout: 15_000 });
	await expect(window.locator(".message-timeline")).toContainText("第二行");
});

test("UX-02: 首次配置失效旧 Pi，重开后收到新端点策略", async ({ window }) => {
	test.setTimeout(120_000);
	await startSession(window);
	const before = await window.evaluate(() => window.piDesktop.sessions.listRuntimes());
	expect(before).toHaveLength(1);
	await send(window, "BIOS_CONFIG_STATE");
	await expect(window.locator(".message-timeline")).toContainText("BIOS_ENDPOINT=unknown", { timeout: 15_000 });
	// 合成配置：测试中显式批准，不操作任何实际用户配置。
	await window.getByRole("button", { name: /^设置/ }).click();
	const modal = window.locator(".settings-modal");
	await expect(modal).toBeVisible();
	await modal.getByText("BIOS 知识库", { exact: true }).click();
	await modal.getByRole("textbox", { name: "知识根目录", exact: true }).fill(workspace.path);
	await modal.getByRole("combobox", { name: "模型端点策略" }).click();
	await window.getByRole("option", { name: "允许向当前模型发送受控 BIOS 知识", exact: true }).click();
	await modal.getByRole("button", { name: "保存可信配置", exact: true }).click();
	await expect(modal).toContainText("已停止旧会话（待重开）", { timeout: 15_000 });
	expect((await window.evaluate(() => window.piDesktop.bios.getSettings())).endpoint).toBe("allowed");
	expect((await window.evaluate(() => window.piDesktop.bios.getSettings())).knowledgeRoot).toBe(workspace.path);
	expect((await window.evaluate(() => window.piDesktop.bios.runtimeState())).pendingRestart).toBe(true);
	await window.keyboard.press("Escape");
	// 复用既有会话启动入口；保留同一会话历史，得到新运行代次。
	const reopened = await window.evaluate((sessionId) => window.piDesktop.sessions.activateRuntime(sessionId), before[0].sessionId);
	expect(reopened.ok).toBe(true);
	if (!reopened.ok) throw new Error(reopened.error.code);
	expect(reopened.value.sessionId).toBe(before[0].sessionId);
	expect(reopened.value.runtimeGeneration).toBeGreaterThan(before[0].runtimeGeneration);
	await send(window, "BIOS_CONFIG_STATE");
	await expect(window.locator(".message-timeline")).toContainText("BIOS_ENDPOINT=allowed", { timeout: 15_000 });
	await expect(window.locator(".message-timeline")).toContainText(`BIOS_KNOWLEDGE_ROOT=${workspace.path}`);
	const unchanged = await window.evaluate(() => window.piDesktop.bios.updateSettings({ endpoint: "allowed" }));
	expect(unchanged.invalidated).toEqual([]);
});
