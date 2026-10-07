/**
 * B-01 永久回归：**撤权必须核对真正的运行时退出**。
 *
 * 背景（`bm07b_batch_development_plan.md` §B-01）：列表消失、`stop()` 返回、
 * context off ACK 都不能单独证明旧进程与旧工具许可已消失。本测试覆盖：
 *
 * 1. `PiProcess.stopAndConfirm`：只有真实 `exit` 才算确认；超时/未退出时保留句柄、如实报未完成；
 * 2. `AgentManager`：确认式停止、残留句柄登记与重试、退出路径兜底、撤权立即阻断发送；
 * 3. `BiosSessionPort`：停止结果按确认结论上报，撤权在标记时立即生效；
 * 4. `BiosKnowledgeService`：收窄时先撤权，失败原因如实进入 runtimeState（不得显示"安全已生效"）。
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { PassThrough } from "node:stream";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";
import { createProjectSandbox, writeDsc } from "../packages/bios-agent/tests/helpers/projectFixtures.mjs";
import { initializeKnowledgeStore } from "../packages/bios-agent/core/storage/index.ts";
import { bindProjectWorkspace } from "../packages/bios-agent/core/projects/index.ts";
import { createTask } from "../packages/bios-agent/core/tasks/index.ts";
import { createBiosSessionPort, createBiosSessionPortFromAgentManager } from "../src/main/bios/BiosSessionPort.ts";
import { BiosKnowledgeService } from "../src/main/bios/BiosKnowledgeService.ts";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const require = createRequire(import.meta.url);
const NOW = 1_700_000_000_000;
const AGENT = "agent-b01";
const DECK = "deck-b01";

/* ------------------------------------------------------------------ PiProcess */

function transpile(filePath) {
	return ts.transpileModule(readFileSync(filePath, "utf8"), {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
	}).outputText;
}

function createChildProcess(pid = 4242) {
	const child = new EventEmitter();
	child.pid = pid;
	child.stdin = new PassThrough();
	child.stdout = new PassThrough();
	child.stderr = new PassThrough();
	child.kill = () => true;
	return child;
}

/**
 * 在 vm 沙箱里加载 PiProcess（沿用 `piProcessErrorSafety.test.mjs` 的登记方式）。
 * `killProcessTree` 被替换为计数器：绝不真的去 taskkill 一个合成 pid。
 */
function loadPiProcess(spawnImpl, counters = {}) {
	const loadSandboxed = (filePath, name) => {
		const sandbox = { exports: {}, require };
		vm.runInNewContext(transpile(filePath), sandbox, { filename: name });
		return sandbox.exports;
	};
	const paths = loadSandboxed("src/main/wsl/WslPaths.ts", "WslPaths.ts");
	const extensionFilter = loadSandboxed("src/main/pi/piExtensionFilter.ts", "piExtensionFilter.ts");

	class FakeRpcClient extends EventEmitter {
		close() {}
	}
	class FakePiLocator {}

	const sandbox = {
		Buffer,
		console: { log() {}, warn() {}, error() {} },
		exports: {},
		process,
		setTimeout,
		clearTimeout,
		setInterval,
		clearInterval,
		require: (id) => {
			if (id === "node:child_process") {
				return {
					execFile: (_command, _args, _options, callback) => {
						callback(null, "0.87.1\n", "");
						return new EventEmitter();
					},
					spawn: spawnImpl,
				};
			}
			if (id === "./PiRpcClient") return { PiRpcClient: FakeRpcClient };
			if (id === "./PiLocator") return { PiLocator: FakePiLocator };
			if (id === "./piSpawnFailure") return require("../src/main/pi/piSpawnFailure.ts");
			if (id === "../wsl/WslPaths") return paths;
			if (id === "../bios/biosProcessEnv") return require("../src/main/bios/biosProcessEnv.ts");
			if (id === "./piExtensionFilter") return extensionFilter;
			if (id === "../extensions/builtInExtensions") return { appendBuiltInExtensionArgs: (args) => [...args] };
			if (id === "../extensions/extensionVersionGate") return require("../src/main/extensions/extensionVersionGate.ts");
			if (id === "../logging/sharedLogger") return { getAppLogger: () => null };
			if (id === "../sessions/sessionProxyPolicy") return { applyPiProxyMode: (env) => env };
			if (id === "../git/gitProcess") {
				return {
					killProcessTree: () => {
						counters.treeKills = (counters.treeKills ?? 0) + 1;
					},
				};
			}
			return require(id);
		},
	};
	vm.runInNewContext(transpile("src/main/pi/PiProcess.ts"), sandbox, { filename: "PiProcess.ts" });
	return sandbox.exports;
}

function createLocator(command = "/missing/pi") {
	return {
		resolveCommand: () => command,
		createInvocation: (_command, args) => ({ command, args: [...args], shell: false }),
		createProcessEnv: () => ({}),
	};
}

test("B-01：stopAndConfirm 只在真实 exit 后报确认（stop 返回不算）", async () => {
	const child = createChildProcess(1001);
	const counters = {};
	const { PiProcess } = loadPiProcess(() => child, counters);
	const pi = new PiProcess("/tmp/project", {}, createLocator());
	await pi.start();
	assert.equal(pi.isRunning(), true);
	assert.equal(pi.pid, 1001);

	const pending = pi.stopAndConfirm({ timeoutMs: 500 });
	// 未收到 exit 之前不得提前报"已确认"。
	const early = await Promise.race([pending.then(() => "done"), new Promise((resolve) => setTimeout(() => resolve("pending"), 20))]);
	assert.equal(early, "pending", "stop 返回 / 信号发出都不算确认退出");
	child.emit("exit", 0, null);
	const outcome = await pending;
	assert.equal(outcome.exited, true);
	assert.equal(outcome.reason, null);
	assert.equal(pi.pid, undefined, "确认退出后句柄清空");
});

test("B-01：退出确认超时 -> 如实报未完成并保留句柄（可重试），并做强制终止退路", async () => {
	const child = createChildProcess(2002);
	const counters = {};
	let killCalls = 0;
	const originalKill = child.kill;
	child.kill = () => {
		killCalls += 1;
		return originalKill();
	};
	const { PiProcess } = loadPiProcess(() => child, counters);
	const pi = new PiProcess("/tmp/project", {}, createLocator());
	await pi.start();

	const exitListeners = child.listenerCount("exit");
	const outcome = await pi.stopAndConfirm({ timeoutMs: 30 });
	assert.equal(outcome.exited, false, "没有真实 exit 就不能报已停止");
	assert.match(outcome.reason ?? "", /超时|仍.*运行/);
	assert.equal(pi.pid, 2002, "确认不了退出时必须保留句柄，供诊断/重试/退出兜底");
	assert.ok(killCalls >= 2, `应做强制终止退路（实际 kill ${killCalls} 次）`);
	assert.ok((counters.treeKills ?? 0) >= 1, "Windows 走本应用拥有的 pid 树杀");

	// 幂等重试：仍然确认不了就继续如实报未完成。
	const retry = await pi.stopAndConfirm({ timeoutMs: 20 });
	assert.equal(retry.exited, false);
	assert.equal(child.listenerCount("exit"), exitListeners, "超时重试不应泄漏 exit 监听");
	// 真的退出后，重试能确认并清空句柄。
	const late = pi.stopAndConfirm({ timeoutMs: 300 });
	child.emit("exit", 0, null);
	assert.equal((await late).exited, true);
	assert.equal(pi.pid, undefined);
});

test("B-01：kill 抛错不得让停止本身崩溃，退出仍以 exit 为准", async () => {
	const child = createChildProcess(3003);
	child.kill = () => {
		throw new Error("kill failed");
	};
	const { PiProcess } = loadPiProcess(() => child, {});
	const pi = new PiProcess("/tmp/project", {}, createLocator());
	await pi.start();

	const pending = pi.stopAndConfirm({ timeoutMs: 300 });
	child.emit("exit", 0, null);
	const outcome = await pending;
	assert.equal(outcome.exited, true, "kill 抛错不影响 exit 确认");
});

/* ------------------------------------------------------------------ AgentManager */

const { AgentManager } = loadTsCommonJs("src/main/pi/AgentManager.ts");

function createManager() {
	return new AgentManager(
		() => ({ id: "project-1", name: "Project", path: "C:/project" }),
		() => null,
		{ get: () => ({}) },
		{},
	);
}

/** 合成运行时：`stopAndConfirm` 由用例脚本化返回，模拟"进程是否真的退出"。 */
function attachRuntime(manager, agentId, { generation = 3, stopAndConfirm } = {}) {
	const calls = { stop: 0, stopAndConfirm: 0 };
	const process = {
		isRunning: () => true,
		getDiagnostics: () => null,
		stop: () => {
			calls.stop += 1;
		},
		stopAndConfirm: async () => {
			calls.stopAndConfirm += 1;
			return stopAndConfirm === undefined ? { exited: true, reason: null } : stopAndConfirm();
		},
	};
	const runtime = {
		tab: {
			id: agentId,
			projectId: "project-1",
			cwd: "C:/project",
			title: "Session",
			status: "running",
			sessionPath: "C:/project/.pi/sessions/x.jsonl",
			sessionEnvironment: "native",
			sessionSource: "pi",
			createdAt: 1,
			runtimeGeneration: generation,
		},
		process,
	};
	manager.agents.set(agentId, runtime);
	return { runtime, calls };
}

test("B-01：AgentManager.stopAndConfirm 只在进程确认退出后报 stopped，失败时保留残留句柄", async () => {
	const manager = createManager();
	let exited = false;
	const { calls } = attachRuntime(manager, "agent-live", {
		stopAndConfirm: () => (exited ? { exited: true, reason: null } : { exited: false, reason: "旧进程仍在运行" }),
	});

	const failed = await manager.stopAndConfirm("agent-live");
	assert.equal(failed.stopped, false);
	assert.match(failed.error ?? "", /仍在运行/);
	assert.equal(calls.stopAndConfirm, 1);
	assert.deepEqual(
		[...manager.listResidualStops()].map((entry) => entry.agentId),
		["agent-live"],
		"确认不了退出必须登记残留句柄，不能只删 Map",
	);

	// 重试：先清理残留句柄（幂等），这次进程已退出 -> 确认成功并清空残留。
	exited = true;
	const retry = await manager.stopAndConfirm("agent-live");
	assert.equal(retry.stopped, true);
	assert.deepEqual([...manager.listResidualStops()], []);

	// 已不在运行表的 agent：视为无旧进程可停（不误停别的东西）。
	assert.equal((await manager.stopAndConfirm("agent-unknown")).stopped, true);
});

test("B-01：撤权立即阻断该代次的新业务发送；换代次后恢复", async () => {
	const manager = createManager();
	attachRuntime(manager, "agent-live", { generation: 3 });
	manager.revokeRuntimeAuthority("agent-live", 3);

	const blocked = await manager.sendPrompt({ agentId: "agent-live", message: "继续读取项目" });
	assert.equal(blocked.accepted, false);
	assert.match(blocked.error ?? "", /授权已撤销/);

	// 新一代次（重开）不再算旧许可：不能把新 runtime 也一起挡掉。
	manager.agents.get("agent-live").tab.runtimeGeneration = 4;
	const allowed = await manager.sendPrompt({ agentId: "agent-live", message: "hello" });
	// 门禁已放行（后续因合成 runtime 缺 RPC 客户端而失败，但绝不是被撤权挡的）。
	assert.doesNotMatch(String(allowed.error ?? ""), /授权已撤销/);
});

test("B-01：确认等待期间保留句柄，并发停止不能把列表消失当成已退出", async () => {
	const manager = createManager();
	let finish;
	const waiting = new Promise((resolve) => {
		finish = resolve;
	});
	attachRuntime(manager, "agent-pending", { stopAndConfirm: () => waiting });
	const first = manager.stopAndConfirm("agent-pending");
	assert.deepEqual(
		[...manager.listResidualStops()].map((entry) => entry.agentId),
		["agent-pending"],
	);
	const second = manager.stopAndConfirm("agent-pending");
	const early = await Promise.race([second.then(() => "done"), new Promise((resolve) => setTimeout(() => resolve("pending"), 15))]);
	assert.equal(early, "pending");
	finish({ exited: true, reason: null });
	assert.equal((await first).stopped, true);
	assert.equal((await second).stopped, true);
	assert.deepEqual([...manager.listResidualStops()], []);
});

test("B-01：应用退出（stopAll）覆盖残留旧进程句柄", () => {
	const manager = createManager();
	let stopCalls = 0;
	attachRuntime(manager, "agent-residual", {
		stopAndConfirm: () => ({ exited: false, reason: "still alive" }),
	});
	// 直接构造残留状态：等价于先经历一次确认失败的撤权停止。
	manager.residualStops.set("agent-residual", {
		agentId: "agent-residual",
		generation: 3,
		process: {
			stop: () => {
				stopCalls += 1;
			},
		},
		reason: "still alive",
	});
	manager.stopAll();
	assert.equal(stopCalls, 1, "退出路径必须兜底停止仍活着的残留旧进程");
	assert.deepEqual([...manager.listResidualStops()], []);
});

/* ------------------------------------------------------------------ BiosSessionPort */

const tabs = (generation, overrides = {}) => [{ id: AGENT, agentId: AGENT, sessionId: "pi-1", deckSessionId: DECK, cwd: "C:/ws", runtimeGeneration: generation, sessionPath: "placeholder", ...overrides }];

function silentPort(extra = {}) {
	return createBiosSessionPort({
		listTabs: () => tabs(3),
		sendPrompt: async () => undefined,
		stopRuntime: async () => undefined,
		fileSize: async () => 0,
		readSince: async () => ({ events: [], nextOffset: 0 }),
		...extra,
	});
}

test("B-01：端口按确认结论上报停止结果，并在停止前撤权", async () => {
	const revoked = [];
	const port = silentPort({
		stopRuntimeConfirmed: async () => ({ stopped: false, error: "进程 4242 仍在运行" }),
		revokeRuntime: ({ agentId, generation }) => revoked.push(`${agentId}@${generation}`),
	});
	const outcome = await port.stopRuntime({ agentId: AGENT, sessionId: DECK, cwd: "C:/ws", generation: 3 });
	assert.equal(outcome.stopped, false, "确认失败不得报已停止");
	assert.match(outcome.error ?? "", /仍在运行/);
	assert.deepEqual(revoked, [`${AGENT}@3`], "停止前必须先撤权（立即阻断发送）");

	// 独立撤权入口（service 在标记旧许可时调用）。
	port.revokeAuthority?.({ agentId: AGENT, sessionId: DECK, cwd: "C:/ws", generation: 3 });
	assert.deepEqual(revoked, [`${AGENT}@3`, `${AGENT}@3`]);

	// 确认成功才算 stopped。
	const okPort = silentPort({ stopRuntimeConfirmed: async () => ({ stopped: true, error: null }) });
	assert.equal((await okPort.stopRuntime({ agentId: AGENT, sessionId: DECK, cwd: "C:/ws", generation: 3 })).stopped, true);
});

test("B-01：已换代的旧请求不去停新 runtime（仍按 replaced 收口，且不触发撤权误伤）", async () => {
	const revoked = [];
	const stopped = [];
	const port = createBiosSessionPort({
		listTabs: () => tabs(4),
		sendPrompt: async () => undefined,
		stopRuntime: async (agentId) => {
			stopped.push(agentId);
		},
		stopRuntimeConfirmed: async (agentId) => {
			stopped.push(agentId);
			return { stopped: true, error: null };
		},
		revokeRuntime: (input) => revoked.push(input.agentId),
		fileSize: async () => 0,
		readSince: async () => ({ events: [], nextOffset: 0 }),
	});
	const outcome = await port.stopRuntime({ agentId: AGENT, sessionId: DECK, cwd: "C:/ws", generation: 3 });
	assert.equal(outcome.stopped, true);
	assert.equal(outcome.replaced, true);
	assert.deepEqual(stopped, [], "绝不能去停后来重开的新 runtime");
	assert.deepEqual(revoked, [], "旧代次已不存在，不需要（也不应）撤权新代次");
});

test("B-01：生产工厂把 stopAndConfirm / revokeRuntimeAuthority 接进端口", async () => {
	const revoked = [];
	const manager = {
		list: () => tabs(3),
		sendPrompt: async () => undefined,
		stop: async () => undefined,
		stopAndConfirm: async () => ({ stopped: true, error: null }),
		revokeRuntimeAuthority: (agentId, generation) => revoked.push(`${agentId}@${generation}`),
	};
	const port = createBiosSessionPortFromAgentManager(manager, {
		fileSize: async () => 0,
		readSince: async () => ({ events: [], nextOffset: 0 }),
	});
	assert.equal((await port.stopRuntime({ agentId: AGENT, sessionId: DECK, cwd: "C:/ws", generation: 3 })).stopped, true);
	assert.deepEqual(revoked, [`${AGENT}@3`], "生产装配必须接上撤权，否则发送入口不会被即时阻断");
});

/* ------------------------------------------------------------------ BiosKnowledgeService */

async function knowledge() {
	const sb = await createProjectSandbox("bm07-b01-");
	await initializeKnowledgeStore({ root: sb.root, now: NOW });
	await writeDsc(sb.workspaceA, "Platform/SamplePkg/Sample.dsc", { platformName: "SamplePlatformA" });
	await mkdir(sb.workspaceB, { recursive: true });
	await writeDsc(sb.workspaceB, "Platform/SamplePkg/Sample.dsc", { platformName: "SamplePlatformB" });
	const projectA = await bindProjectWorkspace({ root: sb.root, cwd: sb.workspaceA, authorizedRoots: [sb.workspaceA], workspacePath: sb.workspaceA, now: NOW });
	await createTask({ root: sb.root, projectId: projectA.projectId, taskId: "task-b01", workspaceId: projectA.workspaceId, cwd: sb.workspaceA, authorizedRoots: [sb.workspaceA], requirement: "SECRET-B01", authorizedProjectIds: [projectA.projectId] });
	return { ...sb, projectA };
}

const settingsOf = (sb, overrides = {}) => ({ knowledgeRoot: sb.root, authorizedProjectIds: [sb.projectA.projectId], allowedFeatureIds: [], approvedCustomers: [], authorizedRoots: [sb.workspaceA], endpoint: "allowed", ...overrides });

test("B-01：收窄时先撤权；停止失败保留原因并显示「撤权未完成」而不是「安全已生效」", async () => {
	const sb = await knowledge();
	try {
		const state = { settings: settingsOf(sb) };
		const revoked = [];
		let stopSucceeds = false;
		const port = {
			resolve: () => ({ resolution: { agentId: AGENT, sessionId: DECK, cwd: sb.workspaceA, generation: 3 } }),
			listSessions: () => [{ agentId: AGENT, sessionId: DECK, cwd: sb.workspaceA, generation: 3 }],
			pushContextOff: async () => ({ receipt: "已关闭" }),
			stopRuntime: async () => (stopSucceeds ? { stopped: true, error: null } : { stopped: false, error: "进程 4242 仍在运行" }),
			revokeAuthority: (resolution) => revoked.push(`${resolution.agentId}@${resolution.generation}`),
			syncSelection: async () => ({ error: "未使用" }),
		};
		const service = new BiosKnowledgeService({ readSettings: () => state.settings, session: port, now: () => NOW });

		const failed = await service.updateSettings({ ...settingsOf(sb), endpoint: "denied" });
		assert.deepEqual(revoked, [`${AGENT}@3`], "标记旧许可的同时必须立即撤权（阻断发送入口）");
		assert.deepEqual([...failed.stopped], []);
		assert.deepEqual([...failed.stopFailed], [AGENT]);
		assert.deepEqual([...failed.stopFailureDetails], [{ agentId: AGENT, reason: "进程 4242 仍在运行" }], "失败原因必须如实保留");
		assert.match(failed.runtime.note ?? "", /撤权未完成/);
		assert.match(failed.runtime.note ?? "", /旧许可/);
		assert.doesNotMatch(failed.runtime.note ?? "", /安全已生效/);
		assert.match(failed.runtime.note ?? "", /手动结束|重试停止/);
		assert.deepEqual(
			failed.runtime.stopFailures.map((entry) => entry.agentId),
			[AGENT],
		);
		assert.match(failed.runtime.stopFailures[0].reason, /仍在运行/);

		// 成功停止：清掉失败记录，显示"已停止待重开"。
		stopSucceeds = true;
		state.settings = settingsOf(sb);
		const ok = await service.updateSettings({ ...settingsOf(sb), endpoint: "denied" });
		assert.deepEqual([...ok.stopped], [AGENT]);
		assert.deepEqual([...ok.stopFailureDetails], []);
		assert.deepEqual(ok.runtime.stopFailures, []);
		assert.match(ok.runtime.note ?? "", /已停止/);
	} finally {
		await sb.cleanup();
	}
});
