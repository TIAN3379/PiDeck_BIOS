/**
 * C5 正式回归（GUI）：**右栏始终关闭**时的首次接入。
 *
 * 复现的问题：接入卡只在 BIOS 右抽屉里，右栏关闭时一次接入根本不存在；
 * 且确认后端点仍可能是 unknown 而没有明确回执。
 *
 * 这里用隔离配置 + 合成工程 + mock Pi，全程**不打开 BIOS 右栏**：
 * 1. 项目打开后根级接入卡必须出现，并显示实际目录、知识根与**当前**端点策略；
 * 2. 一次确认后核对磁盘配置（授权项目、自动化许可）与端点是否被悄悄改写；
 * 3. 必须给出运行时回执（已生效 or 待重开 + 一键重开）。
 */
import { expect, test } from "./mock-pi-fixture";
import { makeSeedProject } from "./open-session";
import { armStartupOverlayDismissal } from "./startupOverlays";

const workspace = makeSeedProject("AwFirstRunSynthetic");
test.use({
	mockSessionInProject: true,
	seedProjects: [workspace],
	seedSettings: { biosHost: { knowledgeRoot: null, authorizedProjectIds: [], authorizedRoots: [], approvedCustomers: [], allowedFeatureIds: [], endpoint: "unknown" } },
});

test("C5：右栏关闭时根级接入卡完成一次确认，端点不被静默放行", async ({ window }, testInfo) => {
	test.setTimeout(120_000);
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	await window.getByRole("tab", { name: "项目", exact: true }).click();
	const project = window.locator(".conversation", { hasText: workspace.name }).first();
	await project.click();
	await expect(window.locator(".composer .rich-input")).toHaveAttribute("contenteditable", "true", { timeout: 30_000 });

	// 1) 右栏**不打开**，根级接入卡必须自己出现。
	const card = window.getByTestId("bios-first-run");
	await expect(card).toBeVisible({ timeout: 20_000 });
	await expect(card).toContainText(workspace.path);
	await expect(card).toContainText("尚未配置知识库");
	const endpointRow = card.getByTestId("bios-first-run-endpoint");
	await expect(endpointRow).toContainText("unknown");
	// 自动化默认勾选（一次合并授权），但不是隐含行为。
	await expect(card.getByTestId("bios-first-run-automation")).toHaveAttribute("data-state", "checked");
	await expect(window.getByTestId("bios-onboarding")).toHaveCount(0, "右栏关闭时不应出现右栏内的接入卡");
	await window.screenshot({ path: testInfo.outputPath("c5-gate-drawer-closed.png") });

	// 2) 一次确认：自动提议不等于放行——授权必须由人勾选。
	await expect(card.getByTestId("bios-first-run-consent")).toHaveAttribute("data-state", "unchecked");
	await expect(card.getByRole("button", { name: "确认授权并接入", exact: true })).toBeDisabled();
	await card.getByTestId("bios-first-run-consent").click();
	await card.getByRole("button", { name: "确认授权并接入", exact: true }).click();
	await expect(card).toContainText("项目已接入", { timeout: 30_000 });

	// 3) 核对宿主事实：授权 + 自动化许可已写入，端点**仍是 unknown**（没有静默放行）。
	const settings = await window.evaluate(() => window.piDesktop.bios.getSettings());
	expect(settings.authorizedProjectIds).toHaveLength(1);
	expect(settings.authorizedRoots).toEqual([workspace.path]);
	expect(settings.automation.enabled).toBe(true);
	expect(settings.endpoint).toBe("unknown");
	// 4) 运行时回执：要么已生效，要么明确说明需要重开并提供入口。
	const receipt = await card.textContent();
	const pending = receipt?.includes("配置已保存") === true;
	const applied = receipt?.includes("配置已生效") === true;
	expect(pending || applied, `必须有明确的运行时回执：${receipt}`).toBe(true);
	// 待重开 ⇒ 必须同时给出一键重开入口（不能让用户自己去设置页手工重开）。
	await expect(card.getByTestId("bios-first-run-restart")).toHaveCount(pending ? 1 : 0);
	await window.screenshot({ path: testInfo.outputPath("c5-gate-after-consent.png") });
});

/**
 * D4 正例：**显式勾选**端点外发授权时，一次确认就把 `endpoint` 写成 `allowed`。
 *
 * 与上一个用例互补：不勾选 ⇒ 保持 unknown（不放行）；勾选 ⇒ 明确授权生效。
 * 卡上还要能看到当前实际模型端点事实（mock Pi 下可能读不到会话模型 ⇒ 如实显示"读不到"）。
 */
test("D4：勾选端点外发授权后一次确认写入 allowed；未授权时说明能力边界", async ({ window }, testInfo) => {
	test.setTimeout(120_000);
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	// 激活项目前阻止无关引导的定时调度，避免截图被迟到浮层遮挡。
	await armStartupOverlayDismissal(window);
	await window.getByRole("tab", { name: "项目", exact: true }).click();
	const project = window.locator(".conversation", { hasText: workspace.name }).first();
	await project.click();
	await expect(window.locator(".composer .rich-input")).toHaveAttribute("contenteditable", "true", { timeout: 30_000 });

	const card = window.getByTestId("bios-first-run");
	await expect(card).toBeVisible({ timeout: 20_000 });
	// 实际模型端点事实行必须存在（读不到也要如实显示，不拿策略枚举冒充）。
	await expect(card.getByTestId("bios-first-run-model")).toBeVisible();
	const background = await card.evaluate((element) => getComputedStyle(element).backgroundColor);
	expect(background).not.toBe("rgba(0, 0, 0, 0)");
	await window.setViewportSize({ width: 1280, height: 600 });
	// Radix opening/viewport transitions are asynchronous; inspect the settled layout.
	await expect.poll(() => card.evaluate((element) => element.getBoundingClientRect().top)).toBeGreaterThanOrEqual(0);
	const bounds = await card.evaluate((element) => ({ top: element.getBoundingClientRect().top, bottom: element.getBoundingClientRect().bottom, viewport: window.innerHeight }));
	expect(bounds.top).toBeGreaterThanOrEqual(0);
	expect(bounds.bottom).toBeLessThanOrEqual(bounds.viewport);
	// Project welcome uses a virtual draft. Cancel is read-only, then create an actual
	// session normally before activating its runtime; the modal itself does not spawn.
	await card.getByRole("button", { name: "取消接入", exact: true }).click();
	await project.hover();
	await project.getByRole("button", { name: "普通会话", exact: true }).first().click();
	if (await card.isVisible()) await card.getByRole("button", { name: "取消接入", exact: true }).click();
	const composer = window.locator(".composer .rich-input");
	// Creating a real session replaces the virtual-draft composer asynchronously.
	// Wait for its ready state before sending instead of typing into a retiring editor.
	await expect(composer).toHaveAttribute("contenteditable", "true", { timeout: 20_000 });
	await expect(window.locator(".history-loading")).toHaveCount(0, { timeout: 20_000 });
	await composer.fill("你好");
	await expect(window.locator(".composer").getByRole("button", { name: "发送", exact: true })).toBeEnabled();
	await composer.press("Enter");
	await expect(card.getByTestId("bios-first-run-endpoint-origin")).toContainText("https://mock-api.invalid", { timeout: 20_000 });
	await expect(card).not.toContainText("synthetic-secret");
	await expect(card).not.toContainText("private-path");
	// D4（§13.4.2）：授权已从"全局开关"改成**绑定当前实际模型服务**，文案必须如实说明
	// "切换模型或地址后需要重新确认"，不能沿用旧的"全局策略、切换模型后仍有效"。
	await expect(card).toContainText("当前实际模型服务");
	await expect(card).toContainText("重新确认");
	await expect(window.getByRole("dialog").filter({ hasText: "用命令面板直达任何设置" })).toBeHidden();
	await window.screenshot({ path: testInfo.outputPath("d4-gate-endpoint-origin-before-consent.png") });
	// 未授权外发时，确认前就要说清"知识能力暂不可用、普通开发继续"。
	await expect(card.getByTestId("bios-first-run-endpoint-not-allowed")).toContainText("普通开发继续可用");
	await expect(card.getByTestId("bios-first-run-endpoint-consent")).toHaveAttribute("data-state", "unchecked");

	await card.getByTestId("bios-first-run-consent").click();
	await card.getByTestId("bios-first-run-endpoint-consent").click();
	await card.getByRole("button", { name: "确认授权并接入", exact: true }).click();
	await expect(card).toContainText("项目已接入", { timeout: 30_000 });
	const settings = await window.evaluate(() => window.piDesktop.bios.getSettings());
	expect(settings.endpoint).toBe("allowed");
	expect(settings.automation.enabled).toBe(true);
	// D4：许可必须绑定**核对过的真实身份**（provider / modelId / API 源 + 正版本号），
	// 而不是只写一个全局 allowed —— 否则"换模型后旧许可仍有效"的缺口就还在。
	expect(settings.endpointGrant).toMatchObject({ provider: "mock", modelId: "mock-model", origin: "https://mock-api.invalid" });
	expect(settings.endpointGrant.version).toBeGreaterThan(0);
	await window.screenshot({ path: testInfo.outputPath("d4-gate-endpoint-consent.png") });
});

test.describe("F3 existing-project service consent", () => {
	test.use({ mockSessionInProject: true });
	test("F3: connected project can re-confirm changed service outside and inside the BIOS drawer", async ({ window }, testInfo) => {
		test.setTimeout(120_000);
		await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
		await armStartupOverlayDismissal(window);
		await window.getByRole("tab", { name: "项目", exact: true }).click();
		const project = window.locator(".conversation", { hasText: workspace.name }).first();
		await project.click();
		const composer = window.locator(".composer .rich-input");
		await expect(composer).toHaveAttribute("contenteditable", "true", { timeout: 30_000 });
		await window.getByTestId("bios-first-run").getByRole("button", { name: "取消接入", exact: true }).click();
		await project.hover();
		await project.getByRole("button", { name: "普通会话", exact: true }).first().click();
		const root = window.getByTestId("bios-first-run");
		if (await root.isVisible()) await root.getByRole("button", { name: "取消接入", exact: true }).click();
		await expect(composer).toHaveAttribute("contenteditable", "true", { timeout: 20_000 });
		await expect(window.locator(".history-loading")).toHaveCount(0, { timeout: 20_000 });
		await composer.fill("你好");
		await expect(window.locator(".composer").getByRole("button", { name: "发送", exact: true })).toBeEnabled();
		await composer.press("Enter");
		await expect(root.getByTestId("bios-first-run-endpoint-consent")).toBeEnabled({ timeout: 20_000 });
		await root.getByTestId("bios-first-run-consent").click();
		await root.getByTestId("bios-first-run-endpoint-consent").click();
		await root.getByRole("button", { name: "确认授权并接入", exact: true }).click();
		await expect(root).toContainText("项目已接入", { timeout: 30_000 });
		const first = await window.evaluate(() => window.piDesktop.bios.getSettings());
		await root.getByTestId("bios-first-run-restart").click();
		await expect.poll(async () => (await window.evaluate(() => window.piDesktop.sessions.listRuntimes())).length).toBeGreaterThan(0);
		const modelButton = window.locator(".composer-bar-btn.model-thinking");
		// The composer shows a saved model preference, not runtime defaults; verify actual service through IPC.
		const resumed = await window.evaluate(async () => {
			const runtime = (await window.piDesktop.sessions.listRuntimes())[0];
			return window.piDesktop.sessions.getRuntimeState(runtime);
		});
		expect(resumed.ok && resumed.value.value.modelId).toBe("mock-model");
		await expect(root).toBeHidden({ timeout: 20_000 });
		// 首次发送用于启动许可核对，不保证已产生磁盘历史；接入后完成一轮对话。
		await composer.fill("你好");
		await composer.press("Enter");
		await expect(window.getByText("Mock 回复：「你好」流式渲染验证完成。", { exact: true }).first()).toBeVisible({ timeout: 20_000 });
		// runtime 已启动不代表旧会话历史已恢复；恢复会重挂 composer，过早打开的弹层会丢失。
		await expect(window.locator(".history-loading")).toHaveCount(0, { timeout: 20_000 });
		await modelButton.click();
		await window.getByRole("button", { name: /^模型 / }).click();
		const palette = window.locator("[data-slot='dialog-content'].model-picker");
		await palette.locator("[data-slot='command-item']", { hasText: "Mock Model Pro" }).click();
		await expect(modelButton).toContainText("Mock Model Pro", { timeout: 15_000 });
		await expect(root).toBeVisible({ timeout: 20_000 });
		await expect(root).toContainText("确认当前模型服务");
		await expect(root).toContainText("https://mock-api-pro.invalid");
		await expect(root).not.toContainText("当前已绑定上面的模型服务");
		await expect(root.getByTestId("bios-first-run-consent")).toHaveCount(0);
		await expect(root.getByTestId("bios-first-run-automation")).toHaveCount(0);
		await expect(root.getByTestId("bios-first-run-endpoint-consent")).not.toBeChecked();
		await window.screenshot({ path: testInfo.outputPath("f3-changed-service-root.png") });
		// Dismiss and retry through the drawer: still the same single modal, no inline copy.
		await root.getByRole("button", { name: "取消接入", exact: true }).click();
		await window.locator(".header-drawer-toggle").first().click();
		await window.getByTestId("drawer-rail-bios").click();
		await expect(root).toBeHidden();
		await window.getByTestId("bios-service-consent-open").click();
		const inline = root;
		await expect(window.getByTestId("bios-service-consent-inline")).toHaveCount(0);
		await expect(inline).toBeVisible({ timeout: 20_000 });
		await expect(inline.getByTestId("bios-first-run-endpoint-consent")).not.toBeChecked();
		await expect(inline).toContainText("mock-model-pro");
		const unchanged = await window.evaluate(() => window.piDesktop.bios.getSettings());
		expect(unchanged.endpointGrant).toEqual(first.endpointGrant);
		await inline.getByTestId("bios-first-run-endpoint-consent").click();
		await inline.getByRole("button", { name: "确认此模型服务", exact: true }).click();
		await expect(inline).toContainText("模型服务许可已保存", { timeout: 30_000 });
		const next = await window.evaluate(() => window.piDesktop.bios.getSettings());
		expect(next.endpointGrant).toMatchObject({ provider: "mock", modelId: "mock-model-pro", origin: "https://mock-api-pro.invalid", version: first.endpointGrant!.version + 1 });
		expect(next.authorizedProjectIds).toEqual(first.authorizedProjectIds);
		expect(next.authorizedRoots).toEqual(first.authorizedRoots);
		expect(next.automation).toEqual(first.automation);
		await expect(inline.getByTestId("bios-first-run-restart")).toBeEnabled();
		await window.screenshot({ path: testInfo.outputPath("f3-service-only-saved.png") });
		await inline.getByTestId("bios-first-run-restart").click();
		await expect
			.poll(async () => {
				return window.evaluate(async () => {
					const runtime = (await window.piDesktop.sessions.listRuntimes())[0];
					if (!runtime) return null;
					const state = await window.piDesktop.sessions.getRuntimeState(runtime);
					return state.ok ? state.value.value.modelId : null;
				});
			})
			.toBe("mock-model-pro");
		await expect(inline).toBeHidden({ timeout: 20_000 });
	});
});
