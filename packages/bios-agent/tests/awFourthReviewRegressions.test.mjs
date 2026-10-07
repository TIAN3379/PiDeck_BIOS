/**
 * AW 第四轮独立验收（`docs/bios-agent/test_checklist.md`（历史编号保留））V1～V3 与（历史编号保留） D4 具名许可的**正式回归**。
 *
 * 断言的是**整改后的正确行为**（不是复现脚本的观察）：
 * - V1：回执与 `unrecoveredAt` 必须**同进同退**——近容量/写失败时不得只落盘一半，
 *   也不得把内存标成"已通知"（旧实现实测 `lastReceipt:null` + `markedNotified:10`）；
 * - V2：只有在**有可信终止依据**（所有者进程已不在，或同一会话已被新请求取代）时才确认未恢复；
 *   所有者未知的旧记录与其它会话的 pending 一律保守待核对；提交时必须在锁内重验，不能盖过迟到完成结果；
 * - V3：未恢复/待核对/明确失败/完成**同源**计数；后续成功检查点不得擦除仍未处理的失败事实；
 *   标记真正收口后才清掉那条未恢复回执；
 * - D4：具名端点许可（provider/model/API 源 + 版本）在**发送前**核对当前实际模型服务，
 *   换模型/改地址/旧许可一律拒绝外发；未绑定时保持既有全局策略语义。
 *
 * 纪律：全部离线。知识库/工程是临时合成目录，存储是**真实** JSON/CAS，
 * 「V1/V2 真实生命周期」一项用真实 Pi SDK 会话（本机回环 SSE）；不联网、不碰真实工程。
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { initializeKnowledgeStore } from "../core/storage/index.ts";
import { bindProjectWorkspace } from "../core/projects/index.ts";
import { AUTOMATION_LIMITS } from "../core/automation/contract.ts";
import { outboundPolicy, sameServiceIdentity } from "../core/context/policy.ts";
import { parseEndpointGrant, serviceIdentityOf } from "../core/context/serviceIdentity.ts";
import { readWorkspaceState, writeWorkspaceState } from "../core/automation/store.ts";
import { commitUnrecoveredReceipt, recordReflectionMark } from "../extensions/automationRuntime.ts";
import { buildCallContext } from "../extensions/callContext.ts";
import { readBiosHostConfig } from "../extensions/hostConfig.ts";
import { createProjectSandbox, writeDsc } from "./helpers/projectFixtures.mjs";
import { withSession } from "./helpers/piSessionHarness.mjs";

const AUTOMATION_ENV = { BIOS_AUTOMATION_ENABLED: "1", BIOS_AUTOMATION_BOOKKEEPING: "1", BIOS_AUTOMATION_INJECT: "1", BIOS_AUTOMATION_VERSION: "1" };
const INVESTIGATION = "排查 USB 启动问题，先不要改源码";

async function fixture(prefix) {
	const sb = await createProjectSandbox(prefix);
	await initializeKnowledgeStore({ root: sb.root });
	await writeDsc(sb.workspaceA, "Sample.dsc", { platformName: "SyntheticFourthReview" });
	const binding = await bindProjectWorkspace({ root: sb.root, cwd: sb.workspaceA, workspacePath: sb.workspaceA });
	return { ...sb, ...binding, env: { ...AUTOMATION_ENV, BIOS_KNOWLEDGE_ROOT: sb.root, BIOS_AUTHORIZED_PROJECTS: binding.projectId, BIOS_AUTHORIZED_ROOTS: sb.workspaceA, BIOS_ENDPOINT: "allowed" } };
}

const targetOf = (f) => ({ root: f.root, projectId: f.projectId, workspaceId: f.workspaceId });
const statePathOf = (f) => join(f.root, "automation", "workspaces", f.workspaceId, "state.json");
const readState = async (f) => JSON.parse(await readFile(statePathOf(f), "utf8"));
const unrecoveredMarks = (marks) => marks.filter((mark) => mark.unrecoveredAt !== undefined);

/** 用公开 CAS 写入把状态撑到接近硬上限（键是合成相对路径，不含任何真实源码内容）。 */
async function fillNearCapacity(f, headroomBytes) {
	const before = await readWorkspaceState(targetOf(f));
	assert.equal(before.status, "ok");
	const base = { ...before.value, summaryBaseline: { ...before.value.summaryBaseline, fileHashes: {} } };
	const ceiling = AUTOMATION_LIMITS.maxStateBytes - headroomBytes;
	for (let i = 0; ; i += 1) {
		const name = `Synthetic/${String(i).padStart(5, "0")}/${"p".repeat(130)}.c`;
		const next = { ...base.summaryBaseline.fileHashes, [name]: "a".repeat(64) };
		const candidate = { ...base, summaryBaseline: { ...base.summaryBaseline, fileHashes: next } };
		if (Buffer.byteLength(`${JSON.stringify(candidate, null, "\t")}\n`) > ceiling) break;
		base.summaryBaseline.fileHashes = next;
	}
	assert.equal((await writeWorkspaceState({ ...targetOf(f), state: base, expectedRevision: before.value.revision })).status, "updated");
}

/* --------------------------------------------------------------------- V1 */

test("F1: locked receipt rechecks ownership and excludes foreign owners from its detail", async () => {
	const f = await fixture("aw-f1-owner-recheck-");
	try {
		for (const [requestKey, ownerBootId] of [
			["same-owner", "observer"],
			["foreign-owner", "another-live-process"],
		]) {
			await recordReflectionMark({ ...targetOf(f), requestKey, runId: requestKey, saved: false, attempts: 1, finished: false, ownerBootId, ownerSessionId: "same-session" });
		}
		const committed = await commitUnrecoveredReceipt({
			...targetOf(f),
			receipt: { kind: "reflection-unrecovered", recordedAt: 10, detail: "same-owner;foreign-owner" },
			requestKeys: ["same-owner", "foreign-owner"],
			at: 10,
			terminationContext: { bootId: "observer", sessionId: "same-session", currentRequestKey: "new-request" },
		});
		assert.deepEqual(committed.noted, ["same-owner"]);
		const state = await readState(f);
		assert.equal(state.reflectionMarks.find((mark) => mark.requestKey === "foreign-owner").unrecoveredAt, undefined);
		assert.ok(!state.lastReceipt.detail.includes("foreign-owner"));
	} finally {
		await f.cleanup();
	}
});

test("V1：近容量写入失败时，回执与 unrecoveredAt 必须同进同退（不得只落盘一半）", async () => {
	const f = await fixture("aw-v1-atomic-");
	try {
		for (let i = 0; i < 10; i += 1) {
			assert.equal((await recordReflectionMark({ ...targetOf(f), requestKey: `old-request-${i}`, runId: `old-run-${i}`, saved: false, attempts: 1, finished: false, ownerBootId: "boot-previous", ownerSessionId: "old-session" })).status, "ok");
		}
		await fillNearCapacity(f, 300);
		const before = await readState(f);
		const committed = await commitUnrecoveredReceipt({
			...targetOf(f),
			receipt: { kind: "reflection-unrecovered", recordedAt: 1_700_000_100_000, detail: `未恢复：${Array.from({ length: 10 }, (_, i) => `old-request-${i}`).join("；")}` },
			requestKeys: Array.from({ length: 10 }, (_, i) => `old-request-${i}`),
			at: 1_700_000_100_000,
		});
		const after = await readState(f);
		// 核心断言：**一次 CAS 提交**——要么回执与标记一起落盘，要么一个都不落；
		// 旧实现分两次写，于是出现过"回执没落盘、标记却全部落盘"（lastReceipt:null + markedNotified:10）。
		const noted = unrecoveredMarks(after.reflectionMarks).length;
		const receiptWritten = after.lastReceipt?.kind === "reflection-unrecovered";
		assert.equal(noted > 0, receiptWritten, `回执与标记必须一致（noted=${noted}, receipt=${after.lastReceipt?.kind ?? "null"}）`);
		assert.equal(committed.noted.length, noted, "调用方拿到的 noted 必须就是实际落盘的条数");
		if (!receiptWritten) {
			assert.equal(committed.status, "failed", "写失败必须如实返回 failed（不能假装成功）");
			assert.deepEqual(after.reflectionMarks, before.reflectionMarks, "写失败时标记文件不得被改动一半");
		}
		assert.ok(Buffer.byteLength(`${JSON.stringify(after, null, "\t")}\n`) < AUTOMATION_LIMITS.maxStateBytes, "不得突破状态文件硬上限");
	} finally {
		await f.cleanup();
	}
});

test("V1：容量正常时回执与标记一起落盘，已回执过的不会重复写", async () => {
	const f = await fixture("aw-v1-normal-");
	try {
		for (let i = 0; i < 3; i += 1) {
			await recordReflectionMark({ ...targetOf(f), requestKey: `gone-${i}`, runId: `gone-run-${i}`, saved: false, attempts: 1, finished: false, ownerBootId: "boot-previous", ownerSessionId: "old-session" });
		}
		const first = await commitUnrecoveredReceipt({ ...targetOf(f), receipt: { kind: "reflection-unrecovered", recordedAt: 1_700_000_200_000, detail: "synthetic" }, requestKeys: ["gone-0", "gone-1", "gone-2"], at: 1_700_000_200_000 });
		assert.equal(first.status, "ok");
		assert.deepEqual([...first.noted].sort(), ["gone-0", "gone-1", "gone-2"]);
		const after = await readState(f);
		assert.equal(after.lastReceipt?.kind, "reflection-unrecovered");
		assert.equal(unrecoveredMarks(after.reflectionMarks).length, 3);
		// 第二次（同一进程的下一次 settle）不得把同一条再报一遍。
		const second = await commitUnrecoveredReceipt({ ...targetOf(f), receipt: { kind: "reflection-unrecovered", recordedAt: 1_700_000_900_000, detail: "second" }, requestKeys: ["gone-0", "gone-1", "gone-2"], at: 1_700_000_900_000 });
		assert.equal(second.status, "ok");
		assert.deepEqual([...second.noted], [], "已经回执过的标记不再重复写");
		assert.equal((await readState(f)).lastReceipt?.recordedAt, 1_700_000_200_000, "重复提交不得改写回执");
	} finally {
		await f.cleanup();
	}
});

/* --------------------------------------------------------------------- V2 */

test("V2：CAS 提交时锁内重验——已被原请求保存/终结的标记不得被打上未恢复", async () => {
	const f = await fixture("aw-v2-cas-");
	try {
		await recordReflectionMark({ ...targetOf(f), requestKey: "still-open", runId: "r-open", saved: false, attempts: 1, finished: false, ownerBootId: "boot-previous", ownerSessionId: "s" });
		// 迟到完成：这条在提交回执之前已经被它自己的请求收口。
		await recordReflectionMark({ ...targetOf(f), requestKey: "late-finished", runId: "r-done", saved: false, attempts: 2, finished: true, ownerBootId: "boot-previous", ownerSessionId: "s" });
		const committed = await commitUnrecoveredReceipt({ ...targetOf(f), receipt: { kind: "reflection-unrecovered", recordedAt: 1_700_000_300_000, detail: "synthetic" }, requestKeys: ["still-open", "late-finished"], at: 1_700_000_300_000 });
		assert.equal(committed.status, "ok");
		assert.deepEqual([...committed.noted], ["still-open"], "只应给仍未终结的那条打回执");
		const after = await readState(f);
		const byKey = Object.fromEntries(after.reflectionMarks.map((mark) => [mark.requestKey, mark]));
		assert.equal(byKey["still-open"].unrecoveredAt, 1_700_000_300_000);
		assert.equal(byKey["late-finished"].unrecoveredAt, undefined, "迟到完成结果不能被收尾判定盖过");
		assert.equal(byKey["late-finished"].finished, true, "原请求的终结事实必须保留");
	} finally {
		await f.cleanup();
	}
});

test("V2：没有任何可回执的标记时不写悬空回执", async () => {
	const f = await fixture("aw-v2-noop-");
	try {
		await recordReflectionMark({ ...targetOf(f), requestKey: "done", runId: "r", saved: false, attempts: 2, finished: true, ownerBootId: "boot-previous", ownerSessionId: "s" });
		const committed = await commitUnrecoveredReceipt({ ...targetOf(f), receipt: { kind: "reflection-unrecovered", recordedAt: 1, detail: "synthetic" }, requestKeys: ["done"], at: 1 });
		assert.equal(committed.status, "ok");
		assert.deepEqual([...committed.noted], []);
		assert.equal((await readState(f)).lastReceipt, null, "一条都没落到时不得写回执");
	} finally {
		await f.cleanup();
	}
});

/* --------------------------------------------------------------------- V3 */

test("V3：后续成功检查点不得擦除仍未处理的未恢复失败事实；标记收口后才清除", async () => {
	const f = await fixture("aw-v3-receipt-");
	try {
		await recordReflectionMark({ ...targetOf(f), requestKey: "open-unrecovered", runId: "r", saved: false, attempts: 1, finished: false, ownerBootId: "boot-previous", ownerSessionId: "s" });
		await commitUnrecoveredReceipt({ ...targetOf(f), receipt: { kind: "reflection-unrecovered", recordedAt: 1_700_000_400_000, detail: "synthetic" }, requestKeys: ["open-unrecovered"], at: 1_700_000_400_000 });
		// 后续一次**成功**的检查点写入：不得顺手擦掉这条仍未处理的失败事实。
		const { persistCheckpointRecord } = await import("../core/automation/store.ts");
		await persistCheckpointRecord({
			...targetOf(f),
			checkpoint: {
				version: 1,
				runId: "later-run",
				projectId: f.projectId,
				workspaceId: f.workspaceId,
				sessionId: "s",
				branch: null,
				requestKey: "later-request",
				recordedAt: 1_700_000_500_000,
				baseline: { workspacePath: f.workspaceA, branch: null, commit: null, fileHashes: {}, capturedAt: 1 },
				executed: [{ tool: "bios_get_project_info", outcome: "ok", files: [], wrote: false, businessStatus: null }],
				changedFiles: [],
				task: null,
				outcome: "in-progress",
				pendingReflection: false,
			},
			protectedFromRotation: false,
		});
		assert.equal((await readState(f)).lastReceipt?.kind, "reflection-unrecovered", "成功检查点不得擦除未处理的失败事实");
		// 真正收口（保存成功）后才清掉。
		await recordReflectionMark({ ...targetOf(f), requestKey: "open-unrecovered", runId: "r", saved: true, attempts: 2, finished: true, ownerBootId: "boot-previous", ownerSessionId: "s" });
		assert.equal((await readState(f)).lastReceipt, null, "标记收口后未恢复回执必须清除（不留悬空事实）");
	} finally {
		await f.cleanup();
	}
});

/* ------------------------------------------------- V1/V2 真实生命周期（真实 Pi） */

test("V1/V2：真实 Pi 会话边界对其它进程和未知所有者的补记保守待核对", async () => {
	const f = await fixture("aw-v12-lifecycle-");
	try {
		// A UUID alone says nothing about a different process being alive or gone.
		await recordReflectionMark({ ...targetOf(f), requestKey: "process-gone", runId: "r-gone", saved: false, attempts: 1, finished: false, ownerBootId: "boot-previous", ownerSessionId: "old-session" });
		await recordReflectionMark({ ...targetOf(f), requestKey: "owner-unknown", runId: "r-unknown", saved: false, attempts: 1, finished: false });
		await withSession(
			f,
			f.env,
			(_body, index) => (index % 3 === 0 ? { toolCallId: `lifecycle-investigate-${index}`, toolCall: { name: "bios_get_project_info", arguments: {} } } : { text: "SYNTHETIC 只读结果" }),
			async ({ session }) => {
				await session.prompt(INVESTIGATION);
				assert.equal(session.sessionManager.getLeafId() !== null, true, "必须是真实会话回合");
				const state = await readState(f);
				const byKey = Object.fromEntries(state.reflectionMarks.map((mark) => [mark.requestKey, mark]));
				assert.equal(byKey["process-gone"]?.unrecoveredAt, undefined, "不同进程没有可信终止证据，不得判死");
				assert.equal(byKey["owner-unknown"]?.unrecoveredAt, undefined, "所有者未知的历史记录必须保守待核对（不能凭请求不同判死）");
				assert.notEqual(state.lastReceipt?.kind, "reflection-unrecovered", "待核对不得冒充未恢复回执");
			},
		);
	} finally {
		await f.cleanup();
	}
});

/* --------------------------------------------------------------------- D4 */

test("D4：具名端点许可在发送前核对实际服务（换模型/改地址/旧许可一律拒绝外发）", () => {
	// 纯解析：实际身份只能来自 Pi 模型快照。
	assert.equal(serviceIdentityOf(undefined), null);
	assert.equal(serviceIdentityOf({ provider: "mock", id: "m" }), null, "没有 baseUrl 就不能冒充身份");
	assert.deepEqual(serviceIdentityOf({ provider: "mock", id: "m", baseUrl: "https://api.example.com/v1?api_key=secret" }), { provider: "mock", modelId: "m", origin: "https://api.example.com" }, "只取 HTTP(S) 源，不含路径与密钥");
	// 具名许可必须完整，且只接受"源"的写法。
	assert.equal(parseEndpointGrant(undefined), null);
	assert.equal(parseEndpointGrant("not json"), null);
	assert.equal(parseEndpointGrant(JSON.stringify({ provider: "mock", modelId: "m", origin: "", version: 1 })), null, "缺 origin 不能绑定");
	assert.equal(parseEndpointGrant(JSON.stringify({ provider: "mock", modelId: "m", origin: "https://api.example.com/v1", version: 1 })), null, "带路径的写法不能当许可（会掩盖配置内容）");
	assert.deepEqual(parseEndpointGrant(JSON.stringify({ provider: "mock", modelId: "m", origin: "https://api.example.com", version: 2 })), { provider: "mock", modelId: "m", origin: "https://api.example.com", version: 2 });

	// 未绑定：保持既有全局策略语义（旧配置不新增拦截）。
	assert.equal(outboundPolicy({ endpointAllowed: true, allowInternalGeneral: false }).allowCommercialBody, true);
	assert.equal(outboundPolicy({ endpointAllowed: null, allowInternalGeneral: false }).allowCommercialBody, false);
	assert.equal(outboundPolicy({ endpointAllowed: false, allowInternalGeneral: false }).allowCommercialBody, false);

	const grant = { provider: "mock", modelId: "m", origin: "https://api.example.com", version: 1 };
	const matched = { provider: "mock", modelId: "m", origin: "https://api.example.com" };
	assert.equal(outboundPolicy({ endpointAllowed: true, allowInternalGeneral: false, grant, actual: matched }).allowCommercialBody, true, "绑定且一致才放行");
	assert.equal(outboundPolicy({ endpointAllowed: true, allowInternalGeneral: false, grant, actual: { ...matched, modelId: "other" } }).allowCommercialBody, false, "换模型 ⇒ 旧许可");
	assert.equal(outboundPolicy({ endpointAllowed: true, allowInternalGeneral: false, grant, actual: { ...matched, origin: "https://evil.example.net" } }).allowCommercialBody, false, "改地址 ⇒ 旧许可");
	assert.equal(outboundPolicy({ endpointAllowed: true, allowInternalGeneral: false, grant, actual: null }).allowCommercialBody, false, "读不到实际服务 ⇒ 保守拒绝（不是默认放行）");
	assert.equal(outboundPolicy({ endpointAllowed: false, allowInternalGeneral: false, grant, actual: matched }).allowCommercialBody, false, "策略本身被拒绝时绑定不构成例外");
	assert.equal(sameServiceIdentity(matched, matched), true);
	assert.equal(sameServiceIdentity(matched, null), false);
});

test("D4：宿主注入的具名许可进入可信配置与指纹；当前模型变化即改变指纹", () => {
	const saved = { grant: process.env.BIOS_ENDPOINT_GRANT, endpoint: process.env.BIOS_ENDPOINT };
	try {
		process.env.BIOS_ENDPOINT = "allowed";
		process.env.BIOS_ENDPOINT_GRANT = JSON.stringify({ provider: "mock", modelId: "m", origin: "https://api.example.com", version: 3 });
		const config = readBiosHostConfig();
		assert.deepEqual(config.endpoint.grant, { provider: "mock", modelId: "m", origin: "https://api.example.com", version: 3 });
		assert.equal(config.endpoint.actual, null, "env 里没有实际模型事实，默认保守为 null");
		assert.equal(outboundPolicy(config.endpoint).allowCommercialBody, false, "无模型上下文 ⇒ 读不到实际服务 ⇒ 拒绝外发");

		const matching = buildCallContext({ cwd: "C:/ws", model: { provider: "mock", id: "m", baseUrl: "https://api.example.com/v1" } });
		assert.equal(outboundPolicy(matching.config.endpoint).allowCommercialBody, true, "供应商/模型/地址都一致才放行");
		const switched = buildCallContext({ cwd: "C:/ws", model: { provider: "mock", id: "other", baseUrl: "https://api.example.com/v1" } });
		assert.equal(outboundPolicy(switched.config.endpoint).allowCommercialBody, false, "会话中途换模型 ⇒ 旧许可立即失效");
		assert.notEqual(matching.configFingerprint, switched.configFingerprint, "当前模型变化必须改变可信配置指纹");
	} finally {
		if (saved.grant === undefined) delete process.env.BIOS_ENDPOINT_GRANT;
		else process.env.BIOS_ENDPOINT_GRANT = saved.grant;
		if (saved.endpoint === undefined) delete process.env.BIOS_ENDPOINT;
		else process.env.BIOS_ENDPOINT = saved.endpoint;
	}
});
