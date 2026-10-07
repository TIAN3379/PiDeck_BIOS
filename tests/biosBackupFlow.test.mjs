/**
 * BM-07B B-07 永久回归：**离线备份/恢复薄入口**经生产 IPC 的链路。
 *
 * 断言边界行为（全部在操作系统临时目录里合成）：
 * 1. `offlineConfirmed` 必须来自操作者：缺失/非 true 一律拒绝，且**不在任何位置创建东西**；
 * 2. 导出成功后**源库字节不变**，容器里有 `manifest.json` + `data/`；
 * 3. 恢复只能进**尚不存在的新目录**：已存在目录、当前知识根、被篡改的 payload、损坏清单
 *    都给出各自的受控结论，且失败时不留下目标目录；
 * 4. 成功恢复后**不改配置**（知识根/授权原样），恢复出的库能被独立读取且记录一致。
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createProjectSandbox, fileHash } from "../packages/bios-agent/tests/helpers/projectFixtures.mjs";
import { initializeKnowledgeStore } from "../packages/bios-agent/core/storage/index.ts";
import { bindProjectWorkspace } from "../packages/bios-agent/core/projects/index.ts";
import { createBiosBusinessService } from "../src/main/bios/BiosBusinessService.ts";
import { createBiosKnowledgeService } from "../src/main/bios/BiosKnowledgeService.ts";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const NOW = 1_700_000_000_000;
const AGENT = "agent-b07";
const SESSION = "deck-b07";

const handlers = new Map();
const ipcStubs = { electron: { ipcMain: { handle: (channel, fn) => handlers.set(channel, fn), removeHandler: (channel) => handlers.delete(channel) }, dialog: {} } };
const { registerBiosBusinessIpc } = loadTsCommonJs("src/main/ipc/biosBusinessIpc.ts", { stubs: ipcStubs });
const { registerBiosIpc } = loadTsCommonJs("src/main/ipc/biosIpc.ts", { stubs: { ...ipcStubs, "../bios/BiosKnowledgeService": { normalizeBiosHostSettings: (value) => value } } });

const call = (channel, payload) => {
	const handler = handlers.get(channel);
	assert.ok(handler, `channel 未注册：${channel}`);
	return handler(null, payload);
};
const claim = () => ({ sessionRef: { agentId: AGENT, sessionId: SESSION }, runtimeGeneration: 3 });

/** 会话端口替身：备份/恢复只需要会话身份，不碰运行时。 */
function sessionPort(cwd) {
	return {
		resolve: () => ({ resolution: { agentId: AGENT, sessionId: SESSION, cwd, generation: 3 } }),
		listSessions: () => [],
		pushContextOff: async () => ({ receipt: "ok" }),
		stopRuntime: async () => ({ stopped: true, error: null }),
		syncSelection: async () => ({ receipt: "synthetic ACK" }),
	};
}

/**
 * 建一份合成库：初始化 + 绑定一个项目 + 一条任务。
 * 备份准入要求预检 `complete`，所以内容必须是产品自己写出来的正常状态。
 */
async function setup() {
	const sb = await createProjectSandbox("bm07-b07-");
	await initializeKnowledgeStore({ root: sb.root, now: NOW });
	const bound = await bindProjectWorkspace({ root: sb.root, cwd: sb.workspaceA, authorizedRoots: [sb.workspaceA], workspacePath: sb.workspaceA, now: NOW });
	assert.equal(bound.status, "bound");
	const state = { settings: { knowledgeRoot: sb.root, authorizedProjectIds: [bound.projectId], allowedFeatureIds: [], approvedCustomers: [], authorizedRoots: [sb.workspaceA], endpoint: "allowed" } };
	const business = createBiosBusinessService({ readSettings: () => state.settings, session: sessionPort(sb.workspaceA), now: () => NOW });
	const knowledge = createBiosKnowledgeService({ readSettings: () => state.settings, readSelections: () => null, writeSelections: async () => undefined, session: sessionPort(sb.workspaceA), now: () => NOW });
	const unregisterBusiness = registerBiosBusinessIpc({ business, appLogger: { info() {} } });
	const unregisterRead = registerBiosIpc({ biosService: knowledge, readBiosSettings: () => state.settings, updateBiosSettings: async () => undefined, readBiosSelections: () => null, updateBiosSelections: async () => undefined, appLogger: { info() {} }, onChanged: () => undefined });

	const created = await call("bios:create-task", { ...claim(), projectId: bound.projectId, taskId: "task-b07", workspaceId: bound.workspaceId, requirement: "离线备份前的合成任务", todos: ["备份", "恢复"] });
	assert.equal(created.result.status, "created");

	return {
		sb,
		bound,
		state,
		unregister: () => {
			unregisterBusiness();
			unregisterRead();
		},
	};
}

test("B-07：没有操作者确认就拒绝导出，且不创建任何东西", async () => {
	const { sb, unregister } = await setup();
	try {
		const backupRoot = join(sb.base, "backup-no-consent");
		// 未勾选（false）与字段缺失都必须拒绝：不允许主进程代填 true。
		await assert.rejects(() => call("bios:export-backup", { ...claim(), parentDir: sb.base, name: "backup-no-consent", offlineConfirmed: false }), /确认/);
		await assert.rejects(() => call("bios:export-backup", { ...claim(), parentDir: sb.base, name: "backup-no-consent" }), /确认/);
		// "看起来像 true"的非布尔值同样不算确认。
		await assert.rejects(() => call("bios:export-backup", { ...claim(), parentDir: sb.base, name: "backup-no-consent", offlineConfirmed: "true" }), /确认/);
		assert.equal(existsSync(backupRoot), false, "被拒时不得留下目标目录");
	} finally {
		unregister();
		await sb.cleanup();
	}
});

test("B-07：导出期间暂停本应用写入；未结束的写入阻止导出；失败释放闸门", async () => {
	const { sb, bound, unregister } = await setup();
	try {
		const create = (id) => call("bios:create-task", { ...claim(), projectId: bound.projectId, workspaceId: bound.workspaceId, taskId: id, requirement: "SYNTHETIC write gate" });
		const writing = create("gate-writing");
		await assert.rejects(() => call("bios:export-backup", { ...claim(), parentDir: sb.base, name: "gate-busy", offlineConfirmed: true }), /写入/);
		await writing;
		const exporting = call("bios:export-backup", { ...claim(), parentDir: sb.base, name: "gate-export", offlineConfirmed: true });
		await assert.rejects(() => create("gate-during-export"), /备份|写入/);
		const result = await exporting;
		assert.equal(result.result.status, "exported");
		assert.equal((await create("gate-after-export")).result.status, "created");
		// 参数拒绝也必须解锁，不能留下一个永久的维护态。
		await assert.rejects(() => call("bios:export-backup", { ...claim(), parentDir: sb.base, name: "../bad", offlineConfirmed: true }));
		assert.equal((await create("gate-after-failure")).result.status, "created");
	} finally {
		unregister();
		await sb.cleanup();
	}
});

test("B-07：导出成功但不改动源库；目标已存在与非法目录名各有受控结论", async () => {
	const { sb, unregister, state } = await setup();
	try {
		const registryBefore = await fileHash(join(sb.root, "registry.json"));
		const backupRoot = join(sb.base, "backup-ok");
		const exported = await call("bios:export-backup", { ...claim(), parentDir: sb.base, name: "backup-ok", offlineConfirmed: true });
		assert.equal(exported.result.status, "exported");
		assert.equal(exported.result.published, true);
		assert.equal(exported.result.consistency, "offline-copy");
		assert.equal(exported.result.cleanup, "ok");
		assert.deepEqual([...exported.result.residuals], []);
		assert.ok(exported.result.files > 0);
		assert.equal(exported.committed, true);

		// 容器形状：manifest.json + data/（导出/恢复共用的唯一形状）。
		assert.equal(existsSync(join(backupRoot, "manifest.json")), true);
		assert.equal(existsSync(join(backupRoot, "data")), true);
		const manifest = JSON.parse(await readFile(join(backupRoot, "manifest.json"), "utf8"));
		assert.equal(manifest.backupVersion, 1);
		assert.equal(manifest.consistency, "offline-copy");
		assert.deepEqual(manifest.exclusions, ["cache", "locks"]);
		assert.equal(manifest.backupId, exported.result.backupId);

		// 源库字节不变（导出是只读复制）。
		assert.equal(await fileHash(join(sb.root, "registry.json")), registryBefore, "导出不得改动源库");
		// 也没有偷偷改配置。
		assert.equal(state.settings.knowledgeRoot, sb.root);

		// 目标已存在 ⇒ 受控拒绝（不覆盖）。
		await assert.rejects(
			() => call("bios:export-backup", { ...claim(), parentDir: sb.base, name: "backup-ok", offlineConfirmed: true }),
			(error) => {
				assert.equal(error.code, "backup-target-exists");
				assert.match(error.message, /目标不可用/);
				return true;
			},
		);

		// 目录名不能逃出所选父目录：分隔符 / `..` / 保留设备名 / 空名都在拼接前被拒。
		for (const name of ["..", "a/b", "a\\b", ".hidden-name", "con", ""]) {
			await assert.rejects(
				() => call("bios:export-backup", { ...claim(), parentDir: sb.base, name, offlineConfirmed: true }),
				(error) => /目录名|完全限定路径|非空字符串/.test(error.message),
				`目录名 ${JSON.stringify(name)} 应被拒`,
			);
		}
		// 父目录必须来自"完全限定路径"（相对路径不接受）。
		await assert.rejects(() => call("bios:export-backup", { ...claim(), parentDir: "relative-dir", name: "x", offlineConfirmed: true }), /完全限定路径/);
	} finally {
		unregister();
		await sb.cleanup();
	}
});

test("B-07：恢复到新目录后记录一致，且不自动切换知识根", async () => {
	const { sb, bound, state, unregister } = await setup();
	try {
		const exported = await call("bios:export-backup", { ...claim(), parentDir: sb.base, name: "backup-r", offlineConfirmed: true });
		assert.equal(exported.result.status, "exported");

		const restored = await call("bios:restore-backup", { ...claim(), backupRoot: join(sb.base, "backup-r"), parentDir: sb.base, name: "restored", offlineConfirmed: true });
		assert.equal(restored.result.status, "restored", `恢复应干净完成：${JSON.stringify(restored.result.reviewReasons)}`);
		assert.equal(restored.result.published, true);
		assert.deepEqual([...restored.result.reviewReasons], []);
		assert.equal(restored.result.cleanup, "ok");
		assert.equal(restored.result.backupId, exported.result.backupId, "恢复必须来自同一份备份");

		// 关键：恢复不改配置（不自动切根、不暗改授权）。
		assert.equal(state.settings.knowledgeRoot, sb.root, "恢复不得自动把知识根切到恢复库");
		assert.deepEqual([...state.settings.authorizedProjectIds], [bound.projectId]);

		// 用**另一次装配**指向恢复出的库：记录必须与备份时一致（独立读取，不走缓存）。
		const restoredRoot = join(sb.base, "restored");
		const restoredSettings = { ...state.settings, knowledgeRoot: restoredRoot };
		const restoredKnowledge = createBiosKnowledgeService({ readSettings: () => restoredSettings, readSelections: () => null, writeSelections: async () => undefined, session: sessionPort(sb.workspaceA), now: () => NOW });
		const projects = await restoredKnowledge.listProjects({ sessionRef: claim().sessionRef, runtimeGeneration: 3 });
		assert.equal(projects.gap, null);
		assert.deepEqual(
			[...projects.items].map((project) => project.projectId),
			[bound.projectId],
		);

		const registryBytes = await readFile(join(restoredRoot, "registry.json"));
		const originalBytes = await readFile(join(sb.root, "registry.json"));
		assert.deepEqual(registryBytes, originalBytes, "registry 必须按原字节恢复");
	} finally {
		unregister();
		await sb.cleanup();
	}
});

test("B-07：目标已存在 / 覆盖当前知识根 / 篡改 payload / 损坏清单都被拒，且不留目标目录", async () => {
	const { sb, unregister } = await setup();
	try {
		const exported = await call("bios:export-backup", { ...claim(), parentDir: sb.base, name: "backup-x", offlineConfirmed: true });
		assert.equal(exported.result.status, "exported");
		const backupRoot = join(sb.base, "backup-x");

		// 未确认恢复同样拒绝。
		await assert.rejects(() => call("bios:restore-backup", { ...claim(), backupRoot, parentDir: sb.base, name: "restored-x", offlineConfirmed: false }), /确认/);

		// 目标已存在（父目录 base 里的 knowledge 就是已有目录）⇒ 冲突。
		await assert.rejects(
			() => call("bios:restore-backup", { ...claim(), backupRoot, parentDir: sb.base, name: "knowledge", offlineConfirmed: true }),
			(error) => {
				assert.equal(error.code, "backup-target-exists");
				return true;
			},
		);

		// 目标与源（备份容器之外）重叠：把恢复目标指到备份容器所在目录内部。
		await assert.rejects(
			() => call("bios:restore-backup", { ...claim(), backupRoot, parentDir: backupRoot, name: "nested", offlineConfirmed: true }),
			(error) => {
				// 重叠判定按 canonical 路径段：备份容器的子目录与"容器本身"重叠。
				assert.ok(["backup-target-overlap", "backup-target-exists"].includes(error.code), `实际 ${error.code}`);
				return true;
			},
		);

		// 篡改 payload：改写 data/registry.json ⇒ 字节与清单不一致。
		const tampered = join(backupRoot, "data", "registry.json");
		const before = await readFile(tampered, "utf8");
		await writeFile(tampered, `${before} `);
		await assert.rejects(
			() => call("bios:restore-backup", { ...claim(), backupRoot, parentDir: sb.base, name: "restored-tampered", offlineConfirmed: true }),
			(error) => {
				assert.equal(error.code, "backup-payload-mismatch");
				assert.match(error.message, /清单/);
				return true;
			},
		);
		assert.equal(existsSync(join(sb.base, "restored-tampered")), false, "失败时不得留下目标目录");
		await writeFile(tampered, before);

		// 损坏清单：新容器里放一份非法 JSON。
		const brokenRoot = join(sb.base, "backup-broken");
		await mkdir(join(brokenRoot, "data"), { recursive: true });
		await writeFile(join(brokenRoot, "manifest.json"), "{ not json");
		await assert.rejects(
			() => call("bios:restore-backup", { ...claim(), backupRoot: brokenRoot, parentDir: sb.base, name: "restored-broken", offlineConfirmed: true }),
			(error) => {
				assert.equal(error.code, "invalid-backup-manifest");
				return true;
			},
		);
		assert.equal(existsSync(join(sb.base, "restored-broken")), false, "清单非法时不得创建目标");

		// 恢复目标必须是完全限定路径（不能靠相对路径蒙混）。
		await assert.rejects(() => call("bios:restore-backup", { ...claim(), backupRoot: "backup-x", parentDir: sb.base, name: "n", offlineConfirmed: true }), /完全限定路径/);
	} finally {
		unregister();
		await sb.cleanup();
	}
});

test("B-07：目录选择通道只回路径字符串；用途受限、取消即取消", async () => {
	const sb = await createProjectSandbox("bm07-b07-pick-");
	const picked = new Map();
	let lastOptions = null;
	const module = loadTsCommonJs("src/main/ipc/biosBusinessIpc.ts", {
		stubs: {
			electron: {
				ipcMain: { handle: (channel, fn) => picked.set(channel, fn), removeHandler: (channel) => picked.delete(channel) },
				dialog: {
					showOpenDialog: async (options) => {
						lastOptions = options;
						return options.title === "CANCEL" ? { canceled: true, filePaths: [] } : { canceled: false, filePaths: [sb.base] };
					},
				},
			},
		},
	});
	const business = createBiosBusinessService({ readSettings: () => ({ knowledgeRoot: sb.root, authorizedProjectIds: [], allowedFeatureIds: [], approvedCustomers: [], authorizedRoots: [], endpoint: "unknown" }), session: sessionPort(sb.workspaceA), now: () => NOW });
	const unregister = module.registerBiosBusinessIpc({ business, appLogger: { info() {} } });
	try {
		const pick = (payload) => picked.get("bios:backup-pick-dir")(null, payload);
		const ok = await pick({ purpose: "export-parent", title: "选备份父目录" });
		// 跨 realm：只比字段（这里也顺带保证"只回路径字符串"，不回句柄/列表）。
		assert.deepEqual(Object.keys(ok).sort(), ["canceled", "path"]);
		assert.equal(ok.canceled, false);
		assert.equal(ok.path, sb.base);
		assert.deepEqual([...(lastOptions?.properties ?? [])], ["openDirectory"], "只能是目录选择");
		assert.equal(lastOptions?.title, "选备份父目录", "标题由调用方本地化，主进程照用");

		// 取消必须是"取消"，不能变成空路径。
		const canceled = await pick({ purpose: "restore-source", title: "CANCEL" });
		assert.equal(canceled.canceled, true);
		assert.equal(canceled.path, null);

		// 用途与标题都有界。
		await assert.rejects(() => pick({ purpose: "delete-everything" }), /不在允许的取值内/);
		await assert.rejects(() => pick({ purpose: "restore-target-parent", title: "x".repeat(200) }), /长度上限/);
	} finally {
		unregister();
		await sb.cleanup();
	}
});
