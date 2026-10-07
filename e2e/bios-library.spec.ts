import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test as base } from "./fixtures";
import { makeSeedProject } from "./open-session";

const workspace = makeSeedProject("KnowledgeLibrarySynthetic");
const test = base.extend({
	seedSettings: async ({ userDataRoot }, use) => {
		const root = join(userDataRoot, "knowledge");
		const { projectId } = JSON.parse(execFileSync(process.execPath, [resolve("e2e/biosLibrarySeed.mjs"), root, workspace.path], { encoding: "utf8" }));
		await use({ biosHost: { knowledgeRoot: root, authorizedProjectIds: [projectId], authorizedRoots: [workspace.path], approvedCustomers: [], allowedFeatureIds: [], endpoint: "unknown" } });
	},
});
test.use({ seedProjects: [workspace] });
test.afterAll(() => rmSync(workspace.path, { recursive: true, force: true }));

async function openSidebar(window: import("@playwright/test").Page) {
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	await window.locator(".header-drawer-toggle").first().click();
	await window.getByTestId("drawer-rail-bios").click();
	await expect(window.getByTestId("bios-compact-status")).toBeVisible();
}

test("legacy authorized project: sidebar retry opens confirmation and repairs the existing ID", async ({ window, userDataRoot }, info) => {
	await window.getByRole("tab", { name: "项目", exact: true }).click();
	await window.locator(".conversation", { hasText: workspace.name }).first().click();
	const gate = window.getByTestId("bios-first-run");
	await expect(gate).toBeVisible({ timeout: 20_000 });
	await gate.getByRole("button", { name: "取消接入", exact: true }).click();
	await openSidebar(window);
	await expect(window.getByTestId("bios-compact-connection")).toContainText("尚未接入");
	const path = join(userDataRoot, "knowledge", "registry.json");
	const before = JSON.parse(readFileSync(path, "utf8"));
	await window.getByTestId("bios-onboarding-open").click();
	await expect(gate).toBeVisible();
	await expect(gate).toContainText(workspace.path);
	await gate.getByTestId("bios-first-run-consent").click();
	await gate.getByRole("button", { name: "确认授权并接入", exact: true }).click();
	await expect(gate).toContainText("项目已接入", { timeout: 30_000 });
	await gate.getByRole("button", { name: "关闭", exact: true }).click();
	await expect(window.getByTestId("bios-compact-connection")).toContainText("已接入");
	await expect(window.getByTestId("bios-onboarding-open")).toHaveCount(0);
	const after = JSON.parse(readFileSync(path, "utf8"));
	expect(after.projects).toHaveLength(1);
	expect(after.projects[0].biosProjectId).toBeTruthy();
	expect(after.projects[0].biosProjectId).toBe(before.projects[0].biosProjectId);
	expect(after.projects[0].desktopProjectId).toBe(workspace.id);
	expect(JSON.parse(readFileSync(join(userDataRoot, "knowledge", "experiences", "exp-draft.json"), "utf8")).solution).toBe("Original synthetic solution");
	await window.screenshot({ path: info.outputPath("legacy-binding-repaired.png") });
});

test("human library browses and edits experiences/requirements offline, with discard confirmation", async ({ window, userDataRoot }, info) => {
	await openSidebar(window);
	const before = await window.evaluate(() => window.piDesktop.bios.getSettings());
	await window.getByTestId("bios-library-open").click();
	const dialog = window.getByTestId("bios-library-dialog");
	await expect(dialog).toBeVisible();
	await dialog.getByTestId("bios-library-entry").filter({ hasText: "S3 synthetic issue" }).click();
	await expect(dialog).toContainText("Original synthetic solution");
	await dialog.getByText("高级：查看完整记录与证据（只读）", { exact: true }).click();
	await expect(dialog.getByTestId("bios-library-full-record")).toContainText("sourceProjectId");
	await window.screenshot({ path: info.outputPath("knowledge-library-record.png") });
	await dialog.getByTestId("bios-library-edit").click();
	await dialog.getByRole("textbox", { name: "方案", exact: true }).fill("Manually corrected synthetic solution");
	await dialog.getByRole("button", { name: "保存草稿", exact: true }).click();
	await expect(dialog).toContainText("已保存到本地知识库");
	const expPath = join(userDataRoot, "knowledge", "experiences", "exp-draft.json");
	expect(JSON.parse(readFileSync(expPath, "utf8")).solution).toBe("Manually corrected synthetic solution");
	await dialog.getByTestId("bios-library-edit").click();
	await dialog.getByRole("textbox", { name: "方案", exact: true }).fill("Unsaved must not persist");
	await dialog.locator('[data-slot="dialog-close"]').click();
	const discard = window.getByRole("alertdialog");
	await expect(discard).toBeVisible();
	await discard.getByRole("button", { name: "取消", exact: true }).click();
	await expect(dialog.getByRole("textbox", { name: "方案", exact: true })).toHaveValue("Unsaved must not persist");
	await dialog.getByRole("button", { name: "客户需求", exact: true }).click();
	await discard.getByRole("button", { name: "丢弃并继续", exact: true }).click();
	await dialog.getByTestId("bios-library-entry").filter({ hasText: "Synthetic PXE requirement" }).click();
	await dialog.getByTestId("bios-library-edit").click();
	await dialog.getByRole("textbox", { name: "原始要求", exact: true }).fill("Corrected synthetic customer requirement");
	await dialog.getByRole("button", { name: "保存更新", exact: true }).click();
	await expect(dialog).toContainText("已保存到本地知识库");
	expect(JSON.parse(readFileSync(join(userDataRoot, "knowledge", "features", "feature-pxe.json"), "utf8")).originalRequirement).toBe("Corrected synthetic customer requirement");
	expect(JSON.parse(readFileSync(expPath, "utf8")).solution).not.toBe("Unsaved must not persist");
	await dialog.locator('[data-slot="dialog-close"]').click();
	await window.getByTestId("bios-library-open").click();
	await dialog.getByTestId("bios-library-entry").filter({ hasText: "S3 synthetic issue" }).click();
	await expect(dialog).toContainText("Manually corrected synthetic solution");
	expect(await window.evaluate(() => window.piDesktop.bios.getSettings())).toEqual(before);
	expect(await window.evaluate(() => window.piDesktop.sessions.listRuntimes())).toHaveLength(0);
});

test("reviewed knowledge requires explicit return to draft; narrow layout stays in viewport", async ({ window, userDataRoot }, info) => {
	await openSidebar(window);
	await window.getByTestId("bios-library-open").click();
	const dialog = window.getByTestId("bios-library-dialog");
	await dialog.getByTestId("bios-library-entry").filter({ hasText: "Reviewed synthetic issue" }).click();
	await expect(dialog.getByTestId("bios-library-edit")).toHaveCount(0);
	await dialog.getByRole("button", { name: "退回草稿后修改", exact: true }).click();
	const review = window.getByTestId("bios-library-review-dialog");
	await expect(review).not.toContainText("{action}");
	await expect(review.getByRole("button", { name: "确认变更", exact: true })).toBeDisabled();
	await review.getByRole("textbox").fill("Correct synthetic example after inspection");
	await review.getByRole("button", { name: "确认变更", exact: true }).click();
	await expect(dialog.getByTestId("bios-library-edit")).toBeVisible();
	const record = JSON.parse(readFileSync(join(userDataRoot, "knowledge", "experiences", "exp-reviewed.json"), "utf8"));
	expect(record.status).toBe("draft");
	const auditDir = join(userDataRoot, "knowledge", "audit", "exp-reviewed");
	const events = readdirSync(auditDir).map((file) => JSON.parse(readFileSync(join(auditDir, file), "utf8")));
	expect(events.some((event) => event.reason === "Correct synthetic example after inspection")).toBe(true);
	await window.setViewportSize({ width: 900, height: 600 });
	await expect.poll(() => dialog.evaluate((e) => e.getBoundingClientRect().top)).toBeGreaterThanOrEqual(0);
	expect(await dialog.evaluate((e) => e.getBoundingClientRect().bottom)).toBeLessThanOrEqual(600);
	await window.screenshot({ path: info.outputPath("knowledge-library-narrow.png") });
});
