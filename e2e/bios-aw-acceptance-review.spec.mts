/** Review diagnostics only: isolated profile, synthetic project, mock RPC; no installed EXE. */
import { test, expect } from "./mock-pi-fixture";
import { makeSeedProject } from "./open-session";

const workspace = makeSeedProject("AwAcceptanceFreshSynthetic");
test.use({ seedProjects: [workspace], seedSettings: { biosHost: { knowledgeRoot: null, authorizedProjectIds: [], authorizedRoots: [], approvedCustomers: [], allowedFeatureIds: [], endpoint: "unknown" } } });

test("review: observe first onboarding outside/inside drawer and resulting endpoint policy", async ({ window }, testInfo) => {
	test.setTimeout(90_000);
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	await window.getByRole("tab", { name: "项目", exact: true }).click();
	const project = window.locator(".conversation", { hasText: workspace.name }).first();
	await project.click();
	await expect(window.locator(".composer .rich-input")).toHaveAttribute("contenteditable", "true", { timeout: 30_000 });
	const before = await window.evaluate(() => window.piDesktop.bios.getSettings());
	const onboarding = window.getByTestId("bios-first-run");
	await expect(onboarding).toBeVisible();
	const closedCount = await onboarding.count();
	await window.screenshot({ path: testInfo.outputPath("aw-first-project-drawer-closed.png") });
	await expect(onboarding.getByRole("textbox", { name: "项目名称", exact: true })).toHaveValue(workspace.name);
	await expect(onboarding.getByTestId("bios-first-run-consent")).not.toBeChecked();
	await onboarding.getByTestId("bios-first-run-consent").click();
	await onboarding.getByRole("button", { name: "确认授权并接入", exact: true }).click();
	await expect(onboarding).toContainText("项目已接入", { timeout: 25_000 });
	const after = await window.evaluate(() => window.piDesktop.bios.getSettings());
	expect(closedCount).toBe(1);
	expect(after.authorizedProjectIds).toHaveLength(1);
	expect(after.endpoint).toBe("unknown");
	await onboarding.getByRole("button", { name: "关闭", exact: true }).click();
	await window.locator(".header-drawer-toggle").first().click();
	await window.getByTestId("drawer-rail-bios").click();
	await expect(window.getByTestId("bios-compact-status")).toBeVisible();
	await expect(window.getByTestId("bios-service-consent-inline")).toHaveCount(0);
	console.log(JSON.stringify({ probe: "fresh-onboarding-gui", closedOnboardingCards: closedCount, initialRoot: before.knowledgeRoot, automaticPreviewInsideDrawer: false, authorizedProjectsAfter: after.authorizedProjectIds.length, automationEnabledAfter: after.automation.enabled, endpointAfter: after.endpoint }));
	await window.screenshot({ path: testInfo.outputPath("aw-first-project-after-consent.png") });
});
