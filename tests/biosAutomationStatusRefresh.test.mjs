/**
 * D4 正式回归：**默认面板的自动记忆状态必须按真实项目与真实终结回执刷新**。
 *
 * 复现的问题（§9.3 D4）：
 * 1. `useBiosWorkbench.loadShell` 捕获了 `input.desktopProjectId` 却只依赖 `[patch]`，
 *    项目 A→B 切换后仍按 A 读宿主投影，B 的界面一直显示 A 的条数；
 * 2. 补记/检查点在 pi 子进程 settle 边界写盘，界面却要用户手动点刷新才更新。
 *
 * 这里用真实 hook 源码 + 桩化 IPC（`tests/helpers/biosHookHarness.mjs`）断言行为，不依赖 DOM。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { biosHookHarness, deferred } from "./helpers/biosHookHarness.mjs";

const statusOf = (checkpoints) => ({ available: true, reason: "ok", checkpoints, pendingReflection: 0, lastRecordedAt: null, durableSaved: 0, durablePending: 0, durableFailed: 0, receipt: null });

function harness(bios) {
	return biosHookHarness(
		"src/renderer/src/hooks/useBiosWorkbench.ts",
		"useBiosWorkbench",
		{ desktopProjectId: "project-a" },
		{
			getSettings: async () => ({}),
			readiness: async () => ({}),
			runtimeState: async () => ({}),
			storeStatus: async () => ({}),
			listProjects: async () => ({ items: [], gap: null }),
			...bios,
		},
	);
}

test("D4：切换桌面项目后必须按**新项目**读宿主自动记忆状态（不能沿用 A 的条数）", async () => {
	const calls = [];
	const h = harness({
		automationStatus: async ({ desktopProjectId }) => {
			calls.push(desktopProjectId);
			return statusOf(desktopProjectId === "project-a" ? 7 : 2);
		},
	});
	try {
		await h.flush();
		assert.equal(h.current.automationStatus?.checkpoints, 7, "首次必须显示 A 的真实条数");
		h.setProps({ desktopProjectId: "project-b" });
		await h.flush();
		assert.deepEqual(calls, ["project-a", "project-b"], `切换项目后必须按新项目重新读取（实际 ${JSON.stringify(calls)}）`);
		assert.equal(h.current.automationStatus?.checkpoints, 2, `B 的界面必须显示 B 的条数（实际 ${h.current.automationStatus?.checkpoints}）`);
	} finally {
		h.unmount();
	}
});

test("D4：会话终结（agents:state → idle）后自动刷新自动记忆状态，无需手动刷新", async () => {
	let checkpoints = 1;
	const h = harness({ automationStatus: async () => statusOf(checkpoints) });
	try {
		await h.flush();
		assert.equal(h.current.automationStatus?.checkpoints, 1);
		// 补记阶段真实落盘：宿主投影随之变化；终结事件到达后界面必须自己更新。
		checkpoints = 4;
		h.runtimeEvent({
			sourceChannel: "agents:state",
			sessionId: "session-a",
			agentId: "agent-a",
			runtimeGeneration: 1,
			payload: [
				{ id: "agent-a", status: "idle" },
				{ id: "other", status: "running" },
			],
		});
		await h.flush();
		assert.equal(h.current.automationStatus?.checkpoints, 4, "会话终结回执必须驱动默认状态刷新（不要求用户点刷新）");
	} finally {
		h.unmount();
	}
});

test("D4：非本会话 / 非终结事件不得触发状态刷新（不打扰运行中的一轮）", async () => {
	let reads = 0;
	const h = harness({
		automationStatus: async () => {
			reads += 1;
			return statusOf(reads);
		},
	});
	try {
		await h.flush();
		const afterInitial = reads;
		h.runtimeEvent({ sourceChannel: "agents:state", sessionId: "session-a", agentId: "agent-a", runtimeGeneration: 1, payload: [{ id: "agent-a", status: "running" }] });
		h.runtimeEvent({ sourceChannel: "agents:message", sessionId: "session-a", agentId: "agent-a", runtimeGeneration: 1, payload: { messages: [] } });
		h.runtimeEvent({ sourceChannel: "agents:state", sessionId: "session-a", agentId: "agent-a", runtimeGeneration: 1, payload: [{ id: "someone-else", status: "idle" }] });
		await h.flush();
		assert.equal(reads, afterInitial, "运行中/其它 agent/其它通道的事件都不该重读宿主投影");
	} finally {
		h.unmount();
	}
});

test("D4：旧项目终结统计迟到时不得覆盖新项目", async () => {
	const pending = deferred();
	let settled = false;
	const h = harness({ automationStatus: async ({ desktopProjectId }) => (desktopProjectId === "project-a" && settled ? pending.promise : statusOf(desktopProjectId === "project-a" ? 7 : 2)) });
	try {
		await h.flush();
		settled = true;
		h.runtimeEvent({ sourceChannel: "agents:state", sessionId: "session-a", agentId: "agent-a", runtimeGeneration: 1, payload: [{ id: "agent-a", status: "idle" }] });
		h.setProps({ desktopProjectId: "project-b" });
		await h.flush();
		assert.equal(h.current.automationStatus.checkpoints, 2);
		pending.resolve(statusOf(99));
		await h.flush();
		assert.equal(h.current.automationStatus.checkpoints, 2, "A 的迟到终结回执不能覆盖 B");
	} finally {
		h.unmount();
	}
});

test("D4：旧 runtime generation 的 idle 不触发刷新", async () => {
	let reads = 0;
	const h = harness({ automationStatus: async () => statusOf(++reads) });
	try {
		await h.flush();
		const initial = reads;
		h.runtimeEvent({ sourceChannel: "agents:state", sessionId: "session-a", agentId: "agent-a", runtimeGeneration: 0, payload: [{ id: "agent-a", status: "idle" }] });
		await h.flush();
		assert.equal(reads, initial, "runtime 身份必须逐字段校验");
	} finally {
		h.unmount();
	}
});
