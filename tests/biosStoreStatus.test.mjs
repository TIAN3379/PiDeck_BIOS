/**
 * BM-07B B-03 永久回归：**知识库状态探测**与「创建知识库」的安全性。
 *
 * 计划 §B-03 第 1 条要求界面能分开显示：未配置 / 未初始化 / 就绪 / 未来版本 / 损坏 / 不可达。
 * 这里用真实文件系统验证分类与"不覆盖坏库"的行为，而不是断言源码字符串。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createProjectSandbox, writeDsc } from "../packages/bios-agent/tests/helpers/projectFixtures.mjs";
import { initializeKnowledgeStore } from "../packages/bios-agent/core/storage/index.ts";
import { bindProjectWorkspace } from "../packages/bios-agent/core/projects/index.ts";
import { createBiosBusinessService } from "../src/main/bios/BiosBusinessService.ts";
import { inspectRootShape, readBiosStoreStatus } from "../src/main/bios/BiosStoreStatus.ts";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const NOW = 1_700_000_000_000;
const REGISTRY = "registry.json";

const handlers = new Map();
const { registerBiosBusinessIpc } = loadTsCommonJs("src/main/ipc/biosBusinessIpc.ts", {
	stubs: {
		electron: { ipcMain: { handle: (channel, fn) => handlers.set(channel, fn), removeHandler: (channel) => handlers.delete(channel) }, dialog: {} },
	},
});

function serviceOf(root) {
	const settings = { knowledgeRoot: root, authorizedProjectIds: [], allowedFeatureIds: [], approvedCustomers: [], authorizedRoots: [], endpoint: "unknown" };
	return createBiosBusinessService({ readSettings: () => settings, readConfigurationVersion: () => 1, now: () => NOW });
}

test("B-03：根形态判定是纯函数（存在/不存在/不是目录）", () => {
	assert.equal(
		inspectRootShape("C:/x", () => ({ exists: false, isDirectory: false })),
		"missing",
	);
	assert.equal(
		inspectRootShape("C:/x", () => ({ exists: true, isDirectory: false })),
		"not-a-directory",
	);
	assert.equal(
		inspectRootShape("C:/x", () => ({ exists: true, isDirectory: true })),
		"directory",
	);
});

test("B-03：未配置 / 目录不在 / 未初始化 三种状态必须分开", async () => {
	const sb = await createProjectSandbox("bm07-b03-status-");
	try {
		// 未配置：不推断默认目录。
		assert.deepEqual(await readBiosStoreStatus(null), { kind: "unconfigured" });
		assert.deepEqual(await readBiosStoreStatus("   "), { kind: "unconfigured" });

		// 目录不在。
		const missing = join(sb.root, "does-not-exist");
		assert.equal((await readBiosStoreStatus(missing)).kind, "directory-missing");

		// 目录在但缺 registry：未初始化（不是"坏库"）。
		const emptyDir = join(sb.root, "empty-store");
		await mkdir(emptyDir, { recursive: true });
		const status = await readBiosStoreStatus(emptyDir);
		assert.equal(status.kind, "not-initialized");
		assert.equal(status.root, emptyDir);
	} finally {
		await sb.cleanup();
	}
});

test("B-03：初始化后就绪，并如实报出 registry revision 与项目数", async () => {
	const sb = await createProjectSandbox("bm07-b03-ready-");
	try {
		await initializeKnowledgeStore({ root: sb.root, now: NOW });
		const status = await readBiosStoreStatus(sb.root);
		assert.equal(status.kind, "ready");
		assert.equal(typeof status.registryRevision, "number");
		assert.equal(status.schemaVersion, 1);
		assert.equal(status.projectCount, 0);

		// 绑定一个工作区后项目数必须跟着变（否则界面会给出错误的"已登记项目数"）。
		await bindProjectWorkspace({ root: sb.root, cwd: sb.workspaceA, authorizedRoots: [sb.workspaceA], workspacePath: sb.workspaceA, now: NOW });
		const after = await readBiosStoreStatus(sb.root);
		assert.equal(after.kind, "ready");
		assert.equal(after.projectCount, 1);

		// 已就绪的库再次"创建"是幂等的（existing），且不算新提交。
		const outcome = await serviceOf(sb.root).initialize({ knowledgeRoot: sb.root });
		assert.equal(outcome.result.status, "existing");
		assert.equal(outcome.committed, false);
	} finally {
		await sb.cleanup();
	}
});

test("B-03：损坏库与未来版本被分开报告，且创建动作不覆盖原始字节", async () => {
	const sb = await createProjectSandbox("bm07-b03-bad-");
	try {
		const corruptDir = join(sb.root, "corrupt-store");
		await mkdir(corruptDir, { recursive: true });
		const corruptPath = join(corruptDir, REGISTRY);
		const corruptBytes = Buffer.from('{"schemaVersion": 1, "projects": [ /**/', "utf8");
		await writeFile(corruptPath, corruptBytes);

		const corrupt = await readBiosStoreStatus(corruptDir);
		assert.equal(corrupt.kind, "corrupt", `坏 JSON 必须报 corrupt：${JSON.stringify(corrupt)}`);

		// 创建知识库必须先拒绝，且**原字节一字不改**（"不覆盖已有无效库、不自动迁移"）。
		await assert.rejects(() => serviceOf(corruptDir).initialize({ knowledgeRoot: corruptDir }), /损坏|不覆盖/);
		assert.deepEqual(await readFile(corruptPath), corruptBytes, "坏库的原字节必须保持不变");

		const futureDir = join(sb.root, "future-store");
		await mkdir(futureDir, { recursive: true });
		const futurePath = join(futureDir, REGISTRY);
		const futureBytes = Buffer.from(JSON.stringify({ schemaVersion: 999, revision: 0, createdAt: NOW, updatedAt: NOW, projects: [] }), "utf8");
		await writeFile(futurePath, futureBytes);

		const future = await readBiosStoreStatus(futureDir);
		assert.equal(future.kind, "future-version", `未知版本必须报未来版本而不是损坏：${JSON.stringify(future)}`);
		assert.equal(future.supportedVersion, 1);
		await assert.rejects(() => serviceOf(futureDir).initialize({ knowledgeRoot: futureDir }), /版本|不覆盖/);
		assert.deepEqual(await readFile(futurePath), futureBytes, "未来版本的原字节必须保持不变");
	} finally {
		await sb.cleanup();
	}
});

test("B-03：整条首次使用链路在服务层跑通（建库 → 授权 → 登记 → 检测 → 确认），第二份工作区不串档", async () => {
	const sb = await createProjectSandbox("bm07-b03-flow-");
	try {
		const pendingRoot = join(sb.root, "store");
		await mkdir(pendingRoot, { recursive: true });
		// 合成工作区里放一个 DSC：检测只提供有限的 EDK 线索，不依赖关键词猜 IBV/芯片。
		await writeDsc(sb.workspaceA, "Platform/SamplePkg/Sample.dsc", { platformName: "SamplePlatformA" });
		const projectA = randomUUID();
		const projectB = randomUUID();
		const state = { root: null, authorized: [projectA, projectB] };
		const business = createBiosBusinessService({
			readSettings: () => ({ knowledgeRoot: state.root, authorizedProjectIds: state.authorized, allowedFeatureIds: [], approvedCustomers: [], authorizedRoots: [sb.workspaceA, sb.workspaceB], endpoint: "unknown" }),
			resolveDesktopProjectPath: (id) => (id === "desktop-a" ? sb.workspaceA : id === "desktop-b" ? sb.workspaceB : null),
			readConfigurationVersion: () => 1,
			now: () => NOW,
		});

		// 1) 未配置 → 直接建库必须被拒（不猜目录）。
		assert.equal((await business.storeStatus()).kind, "unconfigured");
		await assert.rejects(() => business.initialize({ knowledgeRoot: pendingRoot }), /未配置知识根/);

		// 2) 选目录（只写配置）→ 未初始化 → 独立确认后创建。
		state.root = pendingRoot;
		assert.equal((await business.storeStatus()).kind, "not-initialized");
		const created = await business.initialize({ knowledgeRoot: pendingRoot });
		assert.equal(created.result.status, "created");
		assert.equal(created.committed, true);
		const ready = await business.storeStatus();
		assert.equal(ready.kind, "ready");
		assert.equal(ready.projectCount, 0);

		// 3) 登记两个项目（各绑自己的工作区）。
		const boundA = await business.bindProject({ desktopProjectId: "desktop-a", biosProjectId: projectA, displayName: "Synthetic A" });
		assert.equal(boundA.result.status, "bound");
		const boundB = await business.bindProject({ desktopProjectId: "desktop-b", biosProjectId: projectB, displayName: "Synthetic B" });
		assert.equal(boundB.result.status, "bound");

		// 4) 检测只读，且能给出 EDK/DSC 线索。
		const detected = await business.detectCandidates({ desktopProjectId: "desktop-a", biosProjectId: projectA, workspaceId: boundA.result.workspaceId ?? undefined });
		assert.equal(detected.result.wroteToProfile, false);
		assert.ok(detected.result.candidates.some((candidate) => candidate.value === "SamplePlatformA"));

		// 5) 人工确认：只改点名字段。
		const view = await business.readProjectView({ biosProjectId: projectA, desktopProjectId: "desktop-a" });
		const confirmed = await business.confirmProfile({ biosProjectId: projectA, expectedProfileRevision: view.result.revisions.profile ?? 0, values: [{ field: "boardName", value: "BoardA" }] });
		assert.equal(confirmed.result.status, "confirmed");
		assert.deepEqual([...confirmed.result.changedFields], ["boardName"]);

		// 6) 第二份工作区不串档：项目 B 的板卡名仍是未知。
		const viewB = await business.readProjectView({ biosProjectId: projectB, desktopProjectId: "desktop-b" });
		assert.notEqual(viewB.result.open.profile?.identity.boardName.value, "BoardA");
		assert.equal(viewB.result.open.profile?.identity.boardName.value ?? null, null);
	} finally {
		await sb.cleanup();
	}
});

test("B-03：状态通道经生产 IPC 暴露，且不需要会话身份", async () => {
	const sb = await createProjectSandbox("bm07-b03-ipc-");
	try {
		const pendingRoot = join(sb.root, "not-yet");
		await mkdir(pendingRoot, { recursive: true });
		const settings = { knowledgeRoot: pendingRoot, authorizedProjectIds: [], allowedFeatureIds: [], approvedCustomers: [], authorizedRoots: [], endpoint: "unknown" };
		const business = createBiosBusinessService({ readSettings: () => settings, readConfigurationVersion: () => 1, now: () => NOW });
		const unregister = registerBiosBusinessIpc({ business, appLogger: { info() {} } });
		const handler = handlers.get("bios:store-status");
		assert.ok(handler, "bios:store-status 必须注册");
		// 不带 sessionRef 也能读（它只读本机配置，不涉及知识库正文）。
		assert.equal((await handler(null)).kind, "not-initialized");
		// 初始化只接受已配置的知识根。
		await assert.rejects(() => handlers.get("bios:initialize-store")(null, { knowledgeRoot: sb.root }), /已配置的知识根/);
		unregister();
	} finally {
		await sb.cleanup();
	}
});
