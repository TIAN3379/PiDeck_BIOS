import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { seedBiosGui } from "./biosGuiSeed.mjs";
import { startTestProvider } from "../packages/bios-agent/tests/helpers/piSessionHarness.mjs";
import { armStartupOverlayDismissal } from "./startupOverlays.ts";
import { confirmProfileFields } from "../packages/bios-agent/core/projects/index.ts";
import { createExperienceDraft, reviewExperience } from "../packages/bios-agent/core/knowledge/experiences.ts";

/** 真 Electron + 真 Pi RPC + 本地脚本 SSE：验证工具/人工确认/UI，而非模型推理质量。 */
test("CW GUI 对话建任务 → 一次许可 → 自动草稿 → 摘要/高级切换/草稿保护", async ({}, testInfo) => {
	test.setTimeout(180_000);
	let createSent = false;
	let draftSent = false;
	let featureDeclineSent = false,
		featureSent = false,
		retireSent = false,
		resumeSent = false;
	let createdTaskId = "";
	let historySent = false;
	const realWorkspace = process.env.WM_GUI_REAL_PROJECT;
	const gitSnapshot = () => (realWorkspace ? execFileSync("git", ["status", "--porcelain=v1"], { cwd: realWorkspace, encoding: "utf8", windowsHide: true }) + execFileSync("git", ["rev-parse", "HEAD"], { cwd: realWorkspace, encoding: "utf8", windowsHide: true }) : "");
	const sourceBefore = gitSnapshot();
	const provider = await startTestProvider((body) => {
		const isAgent = body?.tools?.some((entry: { function: { name: string } }) => entry.function.name === "bios_manage_task");
		const messages = JSON.stringify(body?.messages);
		if (isAgent && messages.includes("WM-REAL-HISTORY") && !historySent) {
			historySent = true;
			return { toolCallId: "wm-real-history", toolCall: { name: "bios_read_history", arguments: { limit: 3 } } };
		}
		if (isAgent && messages.includes("WM-FEATURE-DECLINE") && !featureDeclineSent) {
			featureDeclineSent = true;
			return { toolCallId: "wm-feature-decline", toolCall: { name: "bios_propose_feature", arguments: { originalRequirement: "SYNTHETIC-WM declined requirement", acceptanceCriteria: ["No board verification"] } } };
		}
		if (isAgent && messages.includes("WM-FEATURE-ACCEPT") && !featureSent) {
			featureSent = true;
			return { toolCallId: "wm-feature-accept", toolCall: { name: "bios_propose_feature", arguments: { originalRequirement: "SYNTHETIC-WM confirmed requirement", acceptanceCriteria: ["No board verification"] } } };
		}
		if (isAgent && messages.includes("WM-RETIRE") && !retireSent) {
			retireSent = true;
			return { toolCallId: "wm-retire", toolCall: { name: "bios_maintain_memory", arguments: { action: "retire", experienceId: "gui-retire-card", expectedRevision: 1, reason: "Synthetic engineer retirement; retain audit" } } };
		}
		if (isAgent && messages.includes("WM-RESUME") && !resumeSent) {
			resumeSent = true;
			return { toolCallId: "wm-resume", toolCall: { name: "bios_manage_task", arguments: { action: "resume", taskId: createdTaskId } } };
		}
		if (isAgent && messages.includes("CW-CREATE") && !createSent) {
			createSent = true;
			return { toolCallId: "cw-gui-create", toolCall: { name: "bios_manage_task", arguments: { action: "create", requirement: "SYNTHETIC-CW: investigate resume only", todos: ["No board test performed"] } } };
		}
		if (isAgent && messages.includes("CW-DRAFT") && !draftSent) {
			draftSent = true;
			return { toolCallId: "cw-gui-draft", toolCall: { name: "bios_save_experience_draft", arguments: { problem: "SYNTHETIC-CW: candidate lesson, not verified" } } };
		}
		return { text: "SYNTHETIC-CW-ACK" };
	});
	const base = join(mkdtempSync(join(tmpdir(), "bios-cw-gui-")), "isolated");
	let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
	try {
		const seed = await seedBiosGui(base, provider.port, { desktopProjectId: "synthetic-gui", ...(realWorkspace ? { existingWorkspace: realWorkspace } : {}) });
		await confirmProfileFields({ root: seed.root, projectId: seed.projectId, workspaceId: seed.workspaceId, expectedProfileRevision: 1, values: [{ field: "customer", value: "Synthetic-GUI-Customer" }], operatorLabel: "Synthetic fixture" });
		const settingsFile = join(seed.profile, "settings.json");
		const settings = JSON.parse(await readFile(settingsFile, "utf8"));
		settings.biosHost.approvedCustomers = ["Synthetic-GUI-Customer"];
		await writeFile(settingsFile, JSON.stringify(settings));
		await createExperienceDraft({
			root: seed.root,
			authorizedProjectIds: [seed.projectId],
			experience: {
				experienceId: "gui-retire-card",
				sourceProjectId: seed.projectId,
				problem: "Synthetic retirement candidate",
				rootCause: "Not board verified",
				solution: "Synthetic test only",
				evidence: [{ type: "session", workspaceId: seed.workspaceId, location: "GUI fixture" }],
				reuse: { level: "current-project" },
			},
		});
		await reviewExperience({ root: seed.root, authorizedProjectIds: [seed.projectId], experienceId: "gui-retire-card", expectedRevision: 0, action: "submit-review", operatorLabel: "Synthetic fixture", reason: "Synthetic fixture only" });
		await writeFile(join(seed.agentDir, "trust.json"), JSON.stringify({ [seed.workspace]: true }));
		const env = { ...process.env, CI: "1", PIDECK_E2E: "1", PIDECK_E2E_USER_DATA_DIR: seed.profile, PI_CODING_AGENT_DIR: seed.agentDir, USERPROFILE: base, HOME: base, APPDATA: join(base, "AppData", "Roaming"), LOCALAPPDATA: join(base, "AppData", "Local") };
		delete env.ELECTRON_RUN_AS_NODE;
		delete env.ELECTRON_RENDERER_URL;
		// 开发态 appPath 必须是仓库根，内置专业 Package 按 appPath/packages 定位。
		const executable = process.env.PIDEK_E2E_EXECUTABLE_PATH;
		app = await electron.launch({ ...(executable ? { executablePath: resolve(executable) } : {}), args: [...(executable ? [] : [resolve(".")]), `--user-data-dir=${seed.profile}`], env });
		const window = await app.firstWindow();
		const errors: string[] = [];
		window.on("pageerror", (error) => errors.push(error.message));
		await window.waitForLoadState("domcontentloaded");
		await armStartupOverlayDismissal(window);
		await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 30_000 });
		await window.getByRole("tab", { name: "项目", exact: true }).click();
		const project = window.locator(".conversation", { hasText: "Synthetic BIOS GUI" }).first();
		await project.click();
		await expect(async () => {
			await project.hover();
			await project.getByRole("button", { name: "普通会话", exact: true }).first().click({ timeout: 2_000 });
		}).toPass({ timeout: 15_000 });
		const composer = window.locator(".composer .rich-input");
		await expect(composer).toHaveAttribute("contenteditable", "true", { timeout: 30_000 });
		const typePrompt = async (text: string) => {
			await window.bringToFront();
			await expect(async () => {
				await composer.fill(text);
				await expect(composer).toHaveText(text);
				await expect(window.locator(".composer").getByRole("button", { name: "发送", exact: true })).toBeEnabled();
			}).toPass({ timeout: 15_000 });
		};
		await typePrompt("CW-CREATE: save a synthetic engineering task");
		await window.locator(".composer").getByRole("button", { name: "发送", exact: true }).click();
		await expect(window.getByText("允许 AI 管理本会话的 BIOS 草稿？", { exact: true })).toBeVisible({ timeout: 45_000 });
		await window.locator(".ask-inline-bar-option-yes").click();
		await expect(window.locator(".message-timeline")).toContainText("SYNTHETIC-CW-ACK", { timeout: 30_000 });
		const taskDir = join(seed.root, "projects", seed.projectId, "tasks");
		expect((await readdir(taskDir)).filter((name) => name.startsWith("task-"))).toHaveLength(1);
		createdTaskId = (await readdir(taskDir)).find((name) => name.startsWith("task-"))!.slice(0, -5);
		await window.locator(".header-drawer-toggle").first().click();
		await window.getByTestId("drawer-rail-bios").click();
		const overview = window.getByTestId("bios-compact-status");
		await expect(overview).toBeVisible();
		await expect(overview.getByTestId("bios-compact-connection")).toContainText("已接入");
		expect(JSON.parse(await readFile(join(taskDir, `${createdTaskId}.json`), "utf8")).requirement).toBe("SYNTHETIC-CW: investigate resume only");
		await expect(window.getByTestId("bios-task-section")).not.toBeVisible();
		await typePrompt("Do not overwrite my input");
		await overview.getByTestId("bios-manage-open").click();
		await expect(composer).toHaveText("Do not overwrite my input");
		await window.keyboard.press("Escape");
		// ProseMirror clearing must dispatch an editing transaction, not only mutate contenteditable DOM.
		await composer.press("ControlOrMeta+A");
		await composer.press("Backspace");
		await expect(composer).toHaveText("");
		await expect(overview.getByRole("button", { name: "继续上次任务", exact: true })).toHaveCount(0, "development goes through chat, not sidebar prompt buttons");
		await typePrompt("CW-DRAFT: save a synthetic lesson draft");
		await window.locator(".composer").getByRole("button", { name: "发送", exact: true }).click();
		await expect.poll(async () => (await readdir(join(seed.root, "experiences"))).filter((name) => name.startsWith("exp-")).length, { timeout: 30_000 }).toBe(1);
		await expect(window.locator(".ask-inline-bar-option-yes")).toHaveCount(0);
		const expFile = (await readdir(join(seed.root, "experiences"))).find((name) => name.startsWith("exp-"));
		const card = JSON.parse(await readFile(join(seed.root, "experiences", expFile!), "utf8"));
		expect(card.status).toBe("draft");
		expect(card.validations).toEqual([]);
		expect(card.reuseScope.level).toBe("current-project");
		const send = async (text: string) => {
			await typePrompt(text);
			await expect(window.locator(".composer").getByRole("button", { name: "发送", exact: true })).toBeEnabled();
			await window.locator(".composer").getByRole("button", { name: "发送", exact: true }).click();
		};
		if (realWorkspace) {
			await send("WM-REAL-HISTORY");
			const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: realWorkspace, encoding: "utf8", windowsHide: true }).trim();
			await expect.poll(() => provider.requests.some((request) => JSON.stringify(request.body.messages).includes(head)), { timeout: 30_000 }).toBe(true);
			expect(gitSnapshot()).toBe(sourceBefore);
		}
		await send("WM-FEATURE-DECLINE");
		await expect(window.getByText("确认 BIOS 关键操作", { exact: true })).toBeVisible();
		await window.locator(".ask-inline-bar-option-no").click();
		await expect.poll(async () => (await readdir(join(seed.root, "features"))).filter((name) => name.endsWith(".json")).length).toBe(0);
		await expect(window.locator(".ask-inline-bar-option-no")).toHaveCount(0);
		await send("WM-FEATURE-ACCEPT");
		await expect(window.getByText("确认 BIOS 关键操作", { exact: true })).toBeVisible();
		await window.locator(".ask-inline-bar-option-yes").click();
		await expect.poll(async () => (await readdir(join(seed.root, "features"))).filter((name) => name.endsWith(".json")).length).toBe(1);
		await expect(window.locator(".ask-inline-bar-option-yes")).toHaveCount(0);
		await send("WM-RETIRE");
		await expect(window.getByText("确认 BIOS 关键操作", { exact: true })).toBeVisible();
		await window.locator(".ask-inline-bar-option-yes").click();
		await expect.poll(async () => JSON.parse(await readFile(join(seed.root, "experiences", "gui-retire-card.json"), "utf8")).status).toBe("deprecated");
		await expect.poll(async () => (await readdir(join(seed.root, "audit", "gui-retire-card"))).filter((name) => name.endsWith(".json")).length).toBe(2);
		await expect(window.locator(".ask-inline-bar-option-yes")).toHaveCount(0);
		await expect.poll(() => window.evaluate(async () => (await window.piDesktop.sessions.listRuntimes()).every((runtime) => runtime.status === "idle"))).toBe(true);
		await expect(async () => {
			await project.hover();
			await project.getByRole("button", { name: "普通会话", exact: true }).first().click({ timeout: 2_000 });
		}).toPass({ timeout: 15_000 });
		await send("WM-RESUME");
		await expect(window.getByText("允许 AI 管理本会话的 BIOS 草稿？", { exact: true })).toBeVisible();
		await window.locator(".ask-inline-bar-option-yes").click();
		expect((await readdir(taskDir)).filter((name) => name.startsWith("task-"))).toHaveLength(1, "resuming must not create another task");
		await expect(window.locator(".message-timeline")).toContainText("SYNTHETIC-CW-ACK", { timeout: 30_000 });
		await window.screenshot({ path: testInfo.outputPath("cw-overview-light.png") });
		await window.getByTestId("bios-manage-open").click();
		await window.getByTestId("bios-workbench-section-tasks").click();
		const tasks = window.getByTestId("bios-task-section");
		await tasks.getByRole("button", { name: /SYNTHETIC-GUI-gui-task-a/ }).click();
		await tasks.getByRole("button", { name: "编辑正文", exact: true }).click();
		await tasks.getByRole("textbox", { name: "需求", exact: true }).fill("Keep this unsaved edit");
		await window.keyboard.press("Escape");
		await window.getByRole("button", { name: "取消", exact: true }).click();
		await expect(tasks.getByRole("textbox", { name: "需求", exact: true })).toHaveValue("Keep this unsaved edit");
		expect(errors).toEqual([]);
	} finally {
		if (app) await app.close();
		await provider.close();
		if (realWorkspace) expect(gitSnapshot()).toBe(sourceBefore);
	}
});
