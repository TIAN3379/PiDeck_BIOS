/**
 * AW 独立验收 R2 的正式回归：**接入卡上的自动化许可必须真的走完全链路**。
 *
 * 复现过的缺陷：渲染层送来 `automation`，IPC 边界只挑 `token`/`displayName`，
 * 于是"用户勾了自动记忆"实际什么都没发生（服务层单测直接调用，因此没暴露）。
 * 这里用**真实 IPC 注册函数**（只桩掉 electron 的 `ipcMain`）断言：
 * 1. 勾选的许可被逐字段校验后原样传给服务；
 * 2. 未勾选时服务拿到的是 `undefined`（保持旧行为）；
 * 3. 多余字段/非布尔值被拒绝（不能借接入通道塞别的授权）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

function register(onboarding) {
	const handlers = new Map();
	const changes = [];
	const { registerBiosOnboardingIpc } = loadTsCommonJs("src/main/ipc/biosOnboardingIpc.ts", {
		stubs: {
			electron: { ipcMain: { handle: (name, callback) => handlers.set(name, callback), removeHandler: (name) => handlers.delete(name) } },
			"../../shared/ipc": { ipcChannels: { biosPrepareOnboarding: "prepare", biosCompleteOnboarding: "complete" } },
		},
	});
	const dispose = registerBiosOnboardingIpc({ onboarding, appLogger: { info() {} }, onChanged: () => changes.push(1) });
	return { handlers, changes, dispose };
}

const emptyOutcome = { status: "partial", authorization: null, binding: null };

test("R2：接入确认把 automation 许可原样传给服务（不再静默丢弃）", async () => {
	const calls = [];
	const { handlers, changes, dispose } = register({ complete: async (request) => (calls.push(request), emptyOutcome) });
	try {
		await handlers.get("complete")({}, { token: "review", confirmed: true, displayName: "Board", automation: { localBookkeeping: true, injectProjectData: true } });
		assert.equal(calls.length, 1);
		// 跨 vm realm 的对象原型不同：先展开成宿主普通对象再比较。
		assert.deepEqual(JSON.parse(JSON.stringify(calls[0].automation)), { localBookkeeping: true, injectProjectData: true });
		assert.equal(calls[0].token, "review");
		assert.equal(calls[0].displayName, "Board");
		assert.equal(changes.length, 1, "保存后仍要通知渲染层刷新");
	} finally {
		dispose();
	}
});

test("R2：未勾选自动化时服务收到 undefined（保持旧行为）", async () => {
	const calls = [];
	const { handlers, dispose } = register({ complete: async (request) => (calls.push(request), emptyOutcome) });
	try {
		await handlers.get("complete")({}, { token: "review", confirmed: true });
		assert.equal(calls[0].automation, undefined);
	} finally {
		dispose();
	}
});

test("R2：automation 只接受两个布尔字段，未知字段/非布尔值一律拒绝", async () => {
	const calls = [];
	const { handlers, dispose } = register({ complete: async (request) => (calls.push(request), emptyOutcome) });
	try {
		await assert.rejects(() => handlers.get("complete")({}, { token: "review", confirmed: true, automation: { localBookkeeping: true, authorizedProjectIds: ["x"] } }), /不接受字段/);
		await assert.rejects(() => handlers.get("complete")({}, { token: "review", confirmed: true, automation: { localBookkeeping: "yes" } }), /必须是布尔值/);
		await assert.rejects(() => handlers.get("complete")({}, { token: "review", confirmed: true, automation: ["localBookkeeping"] }), /必须是对象/);
		await assert.rejects(() => handlers.get("complete")({}, { token: "review", confirmed: false }), /确认/);
		assert.equal(calls.length, 0, "被拒绝的请求不得到达服务");
	} finally {
		dispose();
	}
});
