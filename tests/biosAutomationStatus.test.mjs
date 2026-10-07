/**
 * C5 正式回归：**宿主投影的自动记忆状态**（默认面板只读显示的真实来源）。
 *
 * 复现的问题：保存状态只存在于扩展的私有变量（`lastSaveNote`），界面拿不到，
 * 于是"保存了/受限了/失败了"对用户不可见。这里断言宿主读**真实附属记录**后的投影：
 * - 已配置 + 已开启 + 已绑定 ⇒ 给出真实条数与耐久补记计数；
 * - 未配置/未开启/未绑定/版本不认识 ⇒ 给出**明确原因**的不可用，而不是伪空状态。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { initializeKnowledgeStore } from "../packages/bios-agent/core/storage/index.ts";
import { bindProjectWorkspace } from "../packages/bios-agent/core/projects/index.ts";
import { recordAutomationReceipt, recordReflectionMark } from "../packages/bios-agent/extensions/automationRuntime.ts";
import { persistCheckpointRecord } from "../packages/bios-agent/core/automation/store.ts";
import { createProjectSandbox, writeDsc } from "../packages/bios-agent/tests/helpers/projectFixtures.mjs";
import { BiosAutomationStatusService } from "../src/main/bios/BiosAutomationStatusService.ts";

async function fixture() {
	const sb = await createProjectSandbox("bios-c5-status-");
	await initializeKnowledgeStore({ root: sb.root });
	await writeDsc(sb.workspaceA, "Sample.dsc", { platformName: "SyntheticStatus" });
	const binding = await bindProjectWorkspace({ root: sb.root, cwd: sb.workspaceA, workspacePath: sb.workspaceA });
	const checkpoint = (runId, pending) => ({
		version: 1,
		runId,
		projectId: binding.projectId,
		workspaceId: binding.workspaceId,
		sessionId: "s",
		branch: null,
		requestKey: `r-${runId}`,
		recordedAt: 1_700_000_000_000,
		baseline: { workspacePath: sb.workspaceA, branch: null, commit: null, fileHashes: {}, capturedAt: 1 },
		executed: [{ tool: "bios_get_project_info", outcome: "ok", files: [], wrote: false, businessStatus: null }],
		changedFiles: [],
		task: null,
		outcome: "in-progress",
		pendingReflection: pending,
	});
	await persistCheckpointRecord({ root: sb.root, projectId: binding.projectId, workspaceId: binding.workspaceId, checkpoint: checkpoint("run-a", true), protectedFromRotation: true });
	await persistCheckpointRecord({ root: sb.root, projectId: binding.projectId, workspaceId: binding.workspaceId, checkpoint: checkpoint("run-b", false), protectedFromRotation: false });
	await recordReflectionMark({ root: sb.root, projectId: binding.projectId, workspaceId: binding.workspaceId, requestKey: "req-1", runId: "run-a", saved: true, attempts: 1 });
	await recordReflectionMark({ root: sb.root, projectId: binding.projectId, workspaceId: binding.workspaceId, requestKey: "req-2", runId: "run-b", saved: false, attempts: 1 });
	return { ...sb, ...binding, cleanup: sb.cleanup };
}

const settingsWith = (knowledgeRoot, extra = {}) => ({
	knowledgeRoot,
	automation: { enabled: true, localBookkeeping: true, injectProjectData: true, version: 1 },
	authorizedProjectIds: [],
	allowedFeatureIds: [],
	approvedCustomers: [],
	authorizedRoots: [],
	endpoint: "allowed",
	...extra,
});

test("C5：已绑定工作区时宿主投影真实条数与耐久补记计数", async () => {
	const f = await fixture();
	try {
		const service = new BiosAutomationStatusService({ readSettings: () => settingsWith(f.root), resolveProject: () => ({ path: f.workspaceA }) });
		const status = await service.read("desktop-1");
		assert.equal(status.available, true, JSON.stringify(status));
		assert.equal(status.reason, "ok");
		assert.equal(status.checkpoints, 2, "必须给出真实检查点条数");
		assert.equal(status.pendingReflection, 1, "待补记条数必须来自真实索引");
		assert.equal(status.durableSaved, 1);
		assert.equal(status.durablePending, 1, "未终结的补记才算待恢复");
		assert.equal(status.durableFailed, 0);
		assert.equal(status.receipt, null, "没有受限回执时必须是 null，不能编造");
		assert.equal(status.lastRecordedAt, 1_700_000_000_000, "最近记录时间必须来自真实记录");
	} finally {
		await f.cleanup();
	}
});

test("D1/D2：受限期数与部分成功回执必须由宿主投影（默认面板据此显示真实状态）", async () => {
	const f = await fixture();
	try {
		const service = new BiosAutomationStatusService({ readSettings: () => settingsWith(f.root), resolveProject: () => ({ path: f.workspaceA }) });
		// 已终结但没保存成功 ⇒ 明确失败（不是"待恢复"，不能让人一直等）。
		await recordReflectionMark({ root: f.root, projectId: f.projectId, workspaceId: f.workspaceId, requestKey: "req-3", runId: "run-c", saved: false, attempts: 2, finished: true });
		// D2：容量满/部分成功的耐久回执。
		await recordAutomationReceipt({ root: f.root, projectId: f.projectId, workspaceId: f.workspaceId, receipt: { kind: "checkpoint-full", recordedAt: 1_700_000_100_000, detail: "受保护记录已占满近期集合预算：停止新增检查点（不丢唯一证据），普通开发继续" } });
		const status = await service.read("desktop-1");
		assert.equal(status.durableFailed, 1, "明确失败的补记必须单独计数");
		assert.equal(status.durablePending, 1, "只有未终结的才计入待恢复");
		assert.equal(status.receipt?.kind, "checkpoint-full");
		assert.match(status.receipt.detail, /受保护记录已占满/, "回执正文必须来自真实记录");
		assert.equal(status.receipt.recordedAt, 1_700_000_100_000);
		// 清掉回执后必须回到 null（不残留旧受限提示）。
		await recordAutomationReceipt({ root: f.root, projectId: f.projectId, workspaceId: f.workspaceId, receipt: null });
		assert.equal((await service.read("desktop-1")).receipt, null);
	} finally {
		await f.cleanup();
	}
});

test("D4：同一知识根下两个项目各自投影，工作区之间不串条数", async () => {
	const f = await fixture();
	try {
		// 第二个项目绑定到**同一个知识根**的另一个工作区：宿主投影必须按工作区维度隔离。
		await writeDsc(f.workspaceB, "Sample.dsc", { platformName: "SyntheticStatusB" });
		const b = await bindProjectWorkspace({ root: f.root, cwd: f.workspaceB, workspacePath: f.workspaceB });
		await persistCheckpointRecord({
			root: f.root,
			projectId: b.projectId,
			workspaceId: b.workspaceId,
			checkpoint: {
				version: 1,
				runId: "b-run-a",
				projectId: b.projectId,
				workspaceId: b.workspaceId,
				sessionId: "s",
				branch: null,
				requestKey: "r-b-run-a",
				recordedAt: 1_600_000_000_000,
				baseline: { workspacePath: f.workspaceB, branch: null, commit: null, fileHashes: {}, capturedAt: 1 },
				executed: [{ tool: "bios_get_project_info", outcome: "ok", files: [], wrote: false, businessStatus: null }],
				changedFiles: [],
				task: null,
				outcome: "in-progress",
				pendingReflection: false,
			},
			protectedFromRotation: false,
		});
		const statusOf = (path) => new BiosAutomationStatusService({ readSettings: () => settingsWith(f.root), resolveProject: () => ({ path }) }).read("d");
		const a = await statusOf(f.workspaceA);
		const other = await statusOf(f.workspaceB);
		assert.equal(a.checkpoints, 2, `A 只应看到自己的工作区（实际 ${a.checkpoints}）`);
		assert.equal(other.checkpoints, 1, `B 只应看到自己的工作区（实际 ${other.checkpoints}）`);
		assert.equal(other.pendingReflection, 0, "B 的工作区没有待补记记录");
		assert.equal(other.durableSaved, 0, "B 不得继承 A 的耐久补记计数");
		assert.equal(other.lastRecordedAt, 1_600_000_000_000, "B 的最近记录时间必须来自自己的工作区");
	} finally {
		await f.cleanup();
	}
});

test("C5：未配置/未开启/未绑定/版本不认识 ⇒ 明确不可用原因（不显示伪空状态）", async () => {
	const f = await fixture();
	try {
		const read = (input) => new BiosAutomationStatusService(input);
		// D1/D2：不可用时也必须给全字段（含新增的"明确失败"与受限回执），不能少字段让别人去猜。
		assert.deepEqual(await read({ readSettings: () => settingsWith(null), resolveProject: () => ({ path: f.workspaceA }) }).read("d"), {
			available: false,
			reason: "no-knowledge-root",
			checkpoints: 0,
			pendingReflection: 0,
			lastRecordedAt: null,
			durableSaved: 0,
			durablePending: 0,
			durableFailed: 0,
			durableUnrecovered: 0,
			receipt: null,
		});
		const disabled = settingsWith(f.root, { automation: { enabled: false, localBookkeeping: false, injectProjectData: false, version: 0 } });
		assert.equal((await read({ readSettings: () => disabled, resolveProject: () => ({ path: f.workspaceA }) }).read("d")).reason, "automation-disabled");
		assert.equal((await read({ readSettings: () => settingsWith(f.root), resolveProject: () => null }).read("d")).reason, "not-bound");
		// 未绑定的目录（不在注册表里）同样是 not-bound。
		const other = join(f.base, "not-registered");
		await mkdir(other, { recursive: true });
		assert.equal((await read({ readSettings: () => settingsWith(f.root), resolveProject: () => ({ path: other }) }).read("d")).reason, "not-bound");

		// 未来版本的状态文件：拒读 ⇒ 明确"不可用"，且原字节不变。
		const statePath = join(f.root, "automation", "workspaces", f.workspaceId, "state.json");
		const future = `${JSON.stringify({ version: 99, revision: 0, workspaceId: f.workspaceId }, null, "\t")}\n`;
		await writeFile(statePath, future, "utf8");
		const status = await read({ readSettings: () => settingsWith(f.root), resolveProject: () => ({ path: f.workspaceA }) }).read("d");
		assert.equal(status.available, false);
		assert.equal(status.reason, "unavailable");
		assert.equal(await (await import("node:fs/promises")).readFile(statePath, "utf8"), future, "宿主投影不得改写状态文件");
	} finally {
		await f.cleanup();
	}
});
