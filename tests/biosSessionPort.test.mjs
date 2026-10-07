/**
 * R35-1 / R35-2 / R35-3 永久回归（根项目，无需 Electron）。
 *
 * - **R35-1**：生产装配工厂必须接全三件能力（`listSessions` / `pushContextOff` / `stopRuntime`），
 *   收窄时**真的停掉旧 runtime**，并把"已停止待重开"如实回报；枚举失败不得静默等于"没有旧 runtime"。
 * - **R35-2**：真实 Pi 0.87.1 写的是 `type: "custom_message"`（带 `customType` / `details`）；
 *   回执读取要认这种条目，并且**增量读**（不整读历史、不受 MAX_EVENTS=240 影响）。
 * - **R35-3**：每个动作**发送前**复核绑定；绑定已变的请求**一条命令都不能发出**。
 */
import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createProjectSandbox, writeDsc } from "../packages/bios-agent/tests/helpers/projectFixtures.mjs";
import { initializeKnowledgeStore } from "../packages/bios-agent/core/storage/index.ts";
import { bindProjectWorkspace } from "../packages/bios-agent/core/projects/index.ts";
import { createTask } from "../packages/bios-agent/core/tasks/index.ts";
import { parseSessionProcessEventsFromFile, readSessionProcessEventsSince, sessionFileSize } from "../src/main/sessions/sessionProcessEventsFile.ts";
import { parseSessionProcessEvents } from "../src/main/sessions/sessionProcessEvents.ts";
import { createBiosSessionPort, createBiosSessionPortFromAgentManager } from "../src/main/bios/BiosSessionPort.ts";
import { BiosKnowledgeService } from "../src/main/bios/BiosKnowledgeService.ts";

const NOW = 1_700_000_000_000;
const AGENT = "agent-r35";
const DECK = "deck-session-r35";

/** 真实 Pi 0.87.1 的回执条目形态（`SessionManager.appendCustomMessageEntry`）。 */
function receiptLine(details, content = "BIOS 回执") {
	return `${JSON.stringify({ type: "custom_message", customType: "bios-receipt", content, details, timestamp: NOW })}\n`;
}

/** 普通过程事件行（用于把回执挤到 MAX_EVENTS=240 之后）。 */
function fillerLine(index) {
	return `${JSON.stringify({ type: "model_change", provider: "test", modelId: `m${index}`, timestamp: NOW })}\n`;
}

async function tempSessionFile(prefix = "") {
	const dir = await mkdtemp(join(tmpdir(), "bios-r35-"));
	const file = join(dir, "session.jsonl");
	await writeFile(file, prefix, "utf8");
	return { dir, file, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("R35-2：真实 custom_message 条目被读取器识别（含 details），账本与增量读都能看到", async () => {
	const session = await tempSessionFile();
	try {
		await appendFile(session.file, receiptLine({ ok: true, action: "off", opened: false }), "utf8");
		const ledger = await parseSessionProcessEventsFromFile(session.file);
		assert.equal(ledger.length, 1, `账本必须读到真实回执：${JSON.stringify(ledger)}`);
		assert.equal(ledger[0].kind, "custom");
		assert.equal(ledger[0].customType, "bios-receipt");
		assert.deepEqual(ledger[0].customDetails, { ok: true, action: "off", opened: false }, "结构化 details 必须带出");

		// 纯解析入口同样认（含没有 details 的旧条目）。
		const parsed = parseSessionProcessEvents(`${receiptLine({ ok: false, action: "select" })}${JSON.stringify({ type: "custom_message", customType: "other", content: "x" })}\n`);
		assert.equal(parsed.length, 2);
		assert.equal(parsed[0].customDetails?.ok, false);
		assert.equal(parsed[1].customDetails, undefined, "非对象 details 不得当成结构化回执");
	} finally {
		await session.cleanup();
	}
});

test("R35-2：长会话（>240 条事件）里追加的回执，用增量读仍能拿到；账本读取不冒充实时 ACK", async () => {
	const prefix = Array.from({ length: 300 }, (_, index) => fillerLine(index)).join("");
	const session = await tempSessionFile(prefix);
	try {
		// 账本读取有 MAX_EVENTS 上限：它看不到最末尾刚追加的回执（这正是不能拿它当 ACK 查询的原因）。
		await appendFile(session.file, receiptLine({ ok: true, action: "on", opened: true }), "utf8");
		const ledger = await parseSessionProcessEventsFromFile(session.file);
		assert.equal(ledger.length, 240, "账本读取保持有界（MAX_EVENTS）");
		assert.equal(
			ledger.some((event) => event.customType === "bios-receipt"),
			false,
			"长会话末尾的回执不在账本前 240 条内",
		);

		// 增量读：从"发送前的文件长度"开始，只读新增区间 ⇒ 立刻拿到回执。
		const cursor = await sessionFileSize(session.file);
		await appendFile(session.file, receiptLine({ ok: true, action: "on", opened: true }), "utf8");
		const chunk = await readSessionProcessEventsSince(session.file, cursor);
		assert.equal(chunk.events.length, 1, `增量读必须读到新增回执：${JSON.stringify(chunk.events)}`);
		assert.equal(chunk.events[0].customDetails?.action, "on");
		assert.ok(chunk.nextOffset > cursor, "游标必须前进");

		// 再读一次：没有新增内容时不得重复返回旧回执（不能把旧 ACK 当本次成功）。
		const again = await readSessionProcessEventsSince(session.file, chunk.nextOffset);
		assert.equal(again.events.length, 0);
	} finally {
		await session.cleanup();
	}
});

/* ------------------------------------------------------------ R35-3 */

function portWithFakePi(tabsRef, { receiptsFor, onSend } = {}) {
	const sent = [];
	const receipts = [];
	const state = { file: null };
	const port = createBiosSessionPort({
		listTabs: () => tabsRef.current,
		sendPrompt: async ({ message }) => {
			sent.push(message);
			if (onSend !== undefined) onSend(message);
			const scripted = receiptsFor === undefined ? undefined : receiptsFor(message);
			if (scripted !== undefined && state.file !== null) {
				await appendFile(state.file, receiptLine(scripted.details, scripted.content ?? "回执"), "utf8");
			}
		},
		stopRuntime: async () => undefined,
		fileSize: (filePath) => sessionFileSize(filePath),
		readSince: (filePath, offset) => readSessionProcessEventsSince(filePath, offset),
		receiptTimeoutMs: 120,
		pollIntervalMs: 5,
	});
	return { port, sent, state, attach: (file) => (state.file = file), receipts };
}

/**
 * 会话 tab：同时给 `agentId`（端口形状）与 `id`（`AgentManager.list()` / `AgentTab` 形状），
 * 这样同一个 fixture 既能喂 `createBiosSessionPort`，也能喂 `createBiosSessionPortFromAgentManager`。
 */
const tabs = (generation, overrides = {}) => [{ id: AGENT, agentId: AGENT, sessionId: "pi-1", deckSessionId: DECK, cwd: "C:/ws", runtimeGeneration: generation, sessionPath: "placeholder", ...overrides }];

const syncRequest = (generation) => ({
	resolution: { agentId: AGENT, sessionId: DECK, cwd: "C:/ws", generation },
	sessionKey: DECK,
	commands: { select: "/bios-task select p1 t1", context: "/bios-context on" },
	expectation: { projectId: "p1", taskId: "t1", workspaceId: null, contextEnabled: true },
	claim: { sessionRef: { agentId: AGENT, sessionId: "pi-1" }, runtimeGeneration: generation },
});

test("R35-3：绑定在第一条命令之前就已变化 ⇒ 一条命令都不发（不只末尾报错）", async () => {
	const session = await tempSessionFile();
	try {
		const ref = { current: tabs(3, { sessionPath: session.file }) };
		const { port, sent, attach } = portWithFakePi(ref, { receiptsFor: () => ({ details: { ok: true, action: "select", projectId: "p1", taskId: "t1" } }) });
		attach(session.file);
		// 请求拿到的是 generation=3，但真实的 tab 已经是 4（迟到请求）。
		ref.current = tabs(4, { sessionPath: session.file });
		const outcome = await port.syncSelection(syncRequest(3));
		assert.ok("error" in outcome, `应拒绝迟到请求：${JSON.stringify(outcome)}`);
		assert.deepEqual(sent, [], `过期请求不得向新 runtime 发送任何命令：${JSON.stringify(sent)}`);
	} finally {
		await session.cleanup();
	}
});

test("R35-3：两条命令之间换代 ⇒ 只发 select，不向新 runtime 打开上下文", async () => {
	const session = await tempSessionFile();
	try {
		const ref = { current: tabs(3, { sessionPath: session.file }) };
		const { port, sent, attach } = portWithFakePi(ref, {
			receiptsFor: (message) => {
				if (!message.startsWith("/bios-task select")) return undefined;
				// select 被确认的瞬间换代（模拟"命令执行期间会话被重启"）。
				ref.current = tabs(4, { sessionPath: session.file });
				return { details: { ok: true, action: "select", projectId: "p1", taskId: "t1" } };
			},
		});
		attach(session.file);
		const outcome = await port.syncSelection(syncRequest(3));
		assert.ok("error" in outcome, `绑定变化必须报未同步：${JSON.stringify(outcome)}`);
		assert.deepEqual(sent, ["/bios-task select p1 t1"], `只应发出 select，不得向新 runtime 发开关命令：${JSON.stringify(sent)}`);
	} finally {
		await session.cleanup();
	}
});

test("R35-3：串行隔离 —— 会话里已有的同动作旧回执不算本次 ACK；失败回执立即失败", async () => {
	const session = await tempSessionFile();
	try {
		// 会话里先有一条"同动作、同选择"的旧回执（上一轮留下的）。
		await appendFile(session.file, receiptLine({ ok: true, action: "select", projectId: "p1", taskId: "t1" }), "utf8");
		const ref = { current: tabs(3, { sessionPath: session.file }) };
		// 本次命令**不产生**新回执 ⇒ 必须超时失败，而不是命中旧回执。
		const silent = portWithFakePi(ref, { receiptsFor: () => undefined });
		silent.attach(session.file);
		const timedOut = await silent.port.syncSelection(syncRequest(3));
		assert.ok("error" in timedOut && /超时|没有本动作/.test(timedOut.error), `旧回执不得算本次成功：${JSON.stringify(timedOut)}`);

		// 失败回执（真实格式）⇒ 立即失败，且不再发第二条命令。
		const failing = portWithFakePi(ref, { receiptsFor: () => ({ details: { ok: false, action: "select" }, content: "拒绝选择" }) });
		failing.attach(session.file);
		const failed = await failing.port.syncSelection(syncRequest(3));
		assert.ok("error" in failed && /未同步/.test(failed.error), `失败回执必须算未同步：${JSON.stringify(failed)}`);
		assert.deepEqual(failing.sent, ["/bios-task select p1 t1"], "失败后不得继续发开关命令");
	} finally {
		await session.cleanup();
	}
});

test("R35-2/3：真实格式回执贯通两个动作（select + context on/off）", async () => {
	const session = await tempSessionFile();
	try {
		const ref = { current: tabs(3, { sessionPath: session.file }) };
		const { port, sent, attach } = portWithFakePi(ref, {
			receiptsFor: (message) => (message.startsWith("/bios-task select") ? { details: { ok: true, action: "select", projectId: "p1", taskId: "t1" } } : { details: { ok: true, action: "on", opened: true } }),
		});
		attach(session.file);
		const ok = await port.syncSelection(syncRequest(3));
		assert.ok("receipt" in ok, `两个动作都确认才报同步：${JSON.stringify(ok)}`);
		assert.deepEqual(sent, ["/bios-task select p1 t1", "/bios-context on"]);

		// 关闭：同样的两条链路，动作换成 off/open=false。
		const closeSent = [];
		const closing = createBiosSessionPort({
			listTabs: () => tabs(3, { sessionPath: session.file }),
			sendPrompt: async ({ message }) => {
				closeSent.push(message);
				await appendFile(session.file, receiptLine(message.startsWith("/bios-task select") ? { ok: true, action: "select", projectId: "p1", taskId: "t1" } : { ok: true, action: "off", opened: false }), "utf8");
			},
			stopRuntime: async () => undefined,
			fileSize: (filePath) => sessionFileSize(filePath),
			readSince: (filePath, offset) => readSessionProcessEventsSince(filePath, offset),
			receiptTimeoutMs: 120,
			pollIntervalMs: 5,
		});
		const off = await closing.syncSelection({ ...syncRequest(3), commands: { select: "/bios-task select p1 t1", context: "/bios-context off" }, expectation: { projectId: "p1", taskId: "t1", workspaceId: null, contextEnabled: false } });
		assert.ok("receipt" in off, `关闭也必须核对成功回执：${JSON.stringify(off)}`);
		assert.deepEqual(closeSent, ["/bios-task select p1 t1", "/bios-context off"]);
	} finally {
		await session.cleanup();
	}
});

/* ------------------------------------------------------------ R36-2 */

/** 显式工作区的同步请求（命令文本也带工作区，与 service 的拼法一致）。 */
const explicitWorkspaceRequest = () => ({
	...syncRequest(3),
	commands: { select: "/bios-task select p1 t1 workspace-b", context: "/bios-context on" },
	expectation: { projectId: "p1", taskId: "t1", workspaceId: "workspace-b", contextEnabled: true },
});

test("R36-2：显式工作区的 select 回执必须带同一工作区，缺失/不同都不算已同步（且不发开关命令）", async () => {
	const session = await tempSessionFile();
	try {
		for (const [label, workspaceId] of [
			["回执缺工作区", undefined],
			["回执工作区不同", "workspace-a"],
		]) {
			const ref = { current: tabs(3, { sessionPath: session.file }) };
			const sent = [];
			const port = createBiosSessionPort({
				listTabs: () => ref.current,
				sendPrompt: async ({ message }) => {
					sent.push(message);
					await appendFile(session.file, receiptLine(message.startsWith("/bios-task select") ? { ok: true, action: "select", projectId: "p1", taskId: "t1", ...(workspaceId === undefined ? {} : { workspaceId }) } : { ok: true, action: "on", opened: true }), "utf8");
				},
				stopRuntime: async () => undefined,
				fileSize: (filePath) => sessionFileSize(filePath),
				readSince: (filePath, offset) => readSessionProcessEventsSince(filePath, offset),
				receiptTimeoutMs: 120,
				pollIntervalMs: 5,
			});
			const outcome = await port.syncSelection(explicitWorkspaceRequest());
			assert.ok("error" in outcome, `${label}：不得标为已同步：${JSON.stringify(outcome)}`);
			assert.deepEqual(sent, ["/bios-task select p1 t1 workspace-b"], `${label}：不得继续发开关命令：${JSON.stringify(sent)}`);
		}
		// 正对照：回执带同一工作区 ⇒ 成功。
		const ref = { current: tabs(3, { sessionPath: session.file }) };
		const port = createBiosSessionPort({
			listTabs: () => ref.current,
			sendPrompt: async ({ message }) => {
				await appendFile(session.file, receiptLine(message.startsWith("/bios-task select") ? { ok: true, action: "select", projectId: "p1", taskId: "t1", workspaceId: "workspace-b" } : { ok: true, action: "on", opened: true }), "utf8");
			},
			stopRuntime: async () => undefined,
			fileSize: (filePath) => sessionFileSize(filePath),
			readSince: (filePath, offset) => readSessionProcessEventsSince(filePath, offset),
			receiptTimeoutMs: 120,
			pollIntervalMs: 5,
		});
		const ok = await port.syncSelection(explicitWorkspaceRequest());
		assert.ok("receipt" in ok, `回执带同一工作区必须算成功：${JSON.stringify(ok)}`);
	} finally {
		await session.cleanup();
	}
});

test("R36-2：同一 runtime 的命令串行化（两次同步不交叉，本次新增等价本次请求）", async () => {
	const session = await tempSessionFile();
	try {
		const ref = { current: tabs(3, { sessionPath: session.file }) };
		const timeline = [];
		const port = createBiosSessionPort({
			listTabs: () => ref.current,
			sendPrompt: async ({ message }) => {
				timeline.push(`send:${message}`);
				// 让"命令 → 回执"之间有明显间隔，交叉执行就会被看见。
				await new Promise((resolve) => setTimeout(resolve, 30));
				await appendFile(session.file, receiptLine(message.startsWith("/bios-task select") ? { ok: true, action: "select", projectId: "p1", taskId: "t1" } : { ok: true, action: "on", opened: true }), "utf8");
				timeline.push(`done:${message}`);
			},
			stopRuntime: async () => undefined,
			fileSize: (filePath) => sessionFileSize(filePath),
			readSince: (filePath, offset) => readSessionProcessEventsSince(filePath, offset),
			receiptTimeoutMs: 300,
			pollIntervalMs: 5,
		});
		const first = port.syncSelection(syncRequest(3));
		const second = port.syncSelection(syncRequest(3));
		const [a, b] = await Promise.all([first, second]);
		assert.ok("receipt" in a && "receipt" in b, `两次都必须成功：${JSON.stringify([a, b])}`);
		assert.deepEqual(
			timeline,
			["send:/bios-task select p1 t1", "done:/bios-task select p1 t1", "send:/bios-context on", "done:/bios-context on", "send:/bios-task select p1 t1", "done:/bios-task select p1 t1", "send:/bios-context on", "done:/bios-context on"],
			`同一 runtime 的命令必须串行（不能交叉）：${timeline.join(" -> ")}`,
		);
	} finally {
		await session.cleanup();
	}
});

test("R36-2：停止核对原 runtime —— 已换代的旧请求不去停新 runtime", async () => {
	const session = await tempSessionFile();
	try {
		const stopped = [];
		const port = createBiosSessionPort({
			listTabs: () => tabs(4, { sessionPath: session.file }),
			sendPrompt: async () => undefined,
			stopRuntime: async (agentId) => {
				stopped.push(agentId);
			},
			fileSize: (filePath) => sessionFileSize(filePath),
			readSince: (filePath, offset) => readSessionProcessEventsSince(filePath, offset),
		});
		const outcome = await port.stopRuntime({ agentId: AGENT, sessionId: DECK, cwd: "C:/ws", generation: 3 });
		assert.equal(outcome.stopped, true, "旧代次已不存在 ⇒ 视为已收口");
		assert.equal(outcome.replaced, true, "必须标明是「被新代次取代」而不是「停成功了」");
		assert.deepEqual(stopped, [], "绝不能去停后来重开的新 runtime");
	} finally {
		await session.cleanup();
	}
});

/* ------------------------------------------------------------ R35-1 */

test("R35-1：生产工厂接全三件能力（listSessions / pushContextOff / stopRuntime）", async () => {
	const session = await tempSessionFile();
	try {
		const stopped = [];
		const manager = {
			list: () => tabs(3, { sessionPath: session.file }),
			sendPrompt: async ({ message }) => {
				await appendFile(session.file, receiptLine(message.startsWith("/bios-task select") ? { ok: true, action: "select", projectId: "p1", taskId: "t1" } : { ok: true, action: "off", opened: false }), "utf8");
			},
			stop: async (agentId) => {
				stopped.push(agentId);
			},
		};
		const port = createBiosSessionPortFromAgentManager(manager, {
			fileSize: (filePath) => sessionFileSize(filePath),
			readSince: (filePath, offset) => readSessionProcessEventsSince(filePath, offset),
			receiptTimeoutMs: 120,
			pollIntervalMs: 5,
		});
		// 验收诊断里的 {"listSessions":"undefined","pushContextOff":"undefined"} 必须不再复现。
		assert.equal(typeof port.listSessions, "function");
		assert.equal(typeof port.pushContextOff, "function");
		assert.equal(typeof port.stopRuntime, "function");
		// 选择键用 PiDeck 会话身份；cwd 必须是**真实会话目录**（R36-2 的 `cwd: ""` 缺陷）。
		assert.deepEqual(port.listSessions(), [{ agentId: AGENT, sessionId: DECK, cwd: "C:/ws", generation: 3 }]);

		const resolution = { agentId: AGENT, sessionId: DECK, cwd: "C:/ws", generation: 3 };
		const pushed = await port.pushContextOff(resolution);
		assert.ok("receipt" in pushed, `关闭推送必须核对到真实格式回执：${JSON.stringify(pushed)}`);
		assert.deepEqual(stopped, []);
		const stop = await port.stopRuntime(resolution);
		assert.equal(stop.stopped, true);
		assert.deepEqual(stopped, [AGENT], "stopRuntime 必须落到 AgentManager.stop");
	} finally {
		await session.cleanup();
	}
});

/* ------------------------------------------------------------ R35-1：service 收窄流程 */

async function knowledge() {
	const sb = await createProjectSandbox("bm07-r35-");
	await initializeKnowledgeStore({ root: sb.root, now: NOW });
	await writeDsc(sb.workspaceA, "Platform/SamplePkg/Sample.dsc", { platformName: "SamplePlatformA" });
	await mkdir(sb.workspaceB, { recursive: true });
	await writeDsc(sb.workspaceB, "Platform/SamplePkg/Sample.dsc", { platformName: "SamplePlatformB" });
	const projectA = await bindProjectWorkspace({ root: sb.root, cwd: sb.workspaceA, authorizedRoots: [sb.workspaceA], workspacePath: sb.workspaceA, now: NOW });
	await createTask({ root: sb.root, projectId: projectA.projectId, taskId: "task-r35", workspaceId: projectA.workspaceId, cwd: sb.workspaceA, authorizedRoots: [sb.workspaceA], requirement: "SECRET-R35", authorizedProjectIds: [projectA.projectId] });
	return { ...sb, projectA };
}

const settingsOf = (sb, overrides = {}) => ({ knowledgeRoot: sb.root, authorizedProjectIds: [sb.projectA.projectId], allowedFeatureIds: [], approvedCustomers: [], authorizedRoots: [sb.workspaceA], endpoint: "allowed", ...overrides });

test("R35-1：收窄时停掉旧 runtime 并如实回报；枚举失败不得静默等于“没有旧 runtime”", async () => {
	const sb = await knowledge();
	try {
		const state = { settings: settingsOf(sb) };
		const calls = { stopped: [], pushed: 0 };
		const port = {
			resolve: () => ({ resolution: { agentId: AGENT, sessionId: DECK, cwd: sb.workspaceA, generation: 3 } }),
			listSessions: () => [{ agentId: AGENT, sessionId: DECK, cwd: sb.workspaceA, generation: 3 }],
			pushContextOff: async () => {
				calls.pushed += 1;
				return { receipt: "已关闭" };
			},
			stopRuntime: async () => {
				calls.stopped.push(AGENT);
				return { stopped: true, error: null };
			},
			syncSelection: async () => ({ error: "未使用" }),
		};
		const service = new BiosKnowledgeService({ readSettings: () => state.settings, session: port, now: () => NOW });
		const narrowed = await service.updateSettings({ ...settingsOf(sb), endpoint: "denied" });
		assert.deepEqual([...narrowed.invalidated], [`${AGENT}@3`]);
		assert.deepEqual([...narrowed.stopped], [AGENT], "收窄必须真的停掉旧 runtime（不是只推关闭上下文）");
		assert.deepEqual([...narrowed.stopFailed], []);
		// R36-2：**优先落实停止**——停成功后不再花时间等 off 回执。
		assert.equal(calls.pushed, 0, "停止已生效时不必再推关闭上下文");
		assert.ok([...narrowed.runtime.stoppedRuntimes].includes(AGENT), "UI 要能显示「已停止待重开」");
		assert.match(narrowed.runtime.note ?? "", /已停止/);
		assert.equal(narrowed.runtime.pendingRestart, true);

		// 停止失败的会话要如实报（旧进程可能还在用旧许可）。
		const failingBaseline = { settings: settingsOf(sb) };
		const failing = new BiosKnowledgeService({
			readSettings: () => failingBaseline.settings,
			session: { ...port, stopRuntime: async () => ({ stopped: false, error: "stop failed" }) },
			now: () => NOW,
		});
		const failed = await failing.updateSettings({ endpoint: "denied" });
		assert.deepEqual([...failed.stopped], []);
		assert.deepEqual([...failed.stopFailed], [AGENT]);
		assert.match(failed.runtime.note ?? "", /停止失败|手动结束/);
		assert.equal([...failed.runtime.stoppedRuntimes].length, 0, "没停成不能显示成已停止");
		// 停止失败时仍尽力推"关闭上下文"（进程还活着），并把回执如实记下。
		assert.deepEqual([...failed.pushedOff], [AGENT], "停止失败要退化为推关闭上下文并核对回执");

		// 枚举失败 ⇒ 明确报"无法确认"，不得当成"没有旧 runtime"。
		const brokenBaseline = { settings: settingsOf(sb) };
		const broken = new BiosKnowledgeService({
			readSettings: () => brokenBaseline.settings,
			session: {
				...port,
				listSessions: () => {
					throw new Error("enumeration failed");
				},
			},
			now: () => NOW,
		});
		const unknown = await broken.updateSettings({ endpoint: "denied" });
		assert.equal(unknown.runtime.pendingRestart, true, "枚举失败必须保持 pendingRestart（不能静默放过）");
		assert.match(unknown.runtime.note ?? "", /无法确认运行中会话/);
	} finally {
		await sb.cleanup();
	}
});
