/**
 * R33-1 永久回归：**自有历史工具结果不得随历史重放商业正文**。
 *
 * 验收复现：allowed 下让 provider 返回 `bios_get_task` 的真实 tool call（工具结果进入第二次请求），
 * 随后把 `BIOS_ENDPOINT` 改成 denied，再发普通问题 —— 第三个请求不得再含需求正文。
 * 同一文件还覆盖 allowed→unknown、项目/客户撤权与"什么都不改"的正对照。
 *
 * 另一半是 `historyGuard` 的**单元**回归：结构化归属（工具名 + 真实 tool-call 配对）、幂等、
 * 只按收窄撤回、以及"保留工具协议字段"。
 */
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import test from "node:test";
import { initializeKnowledgeStore } from "../core/storage/index.ts";
import { bindProjectWorkspace } from "../core/projects/index.ts";
import { createTask } from "../core/tasks/index.ts";
import { scopeOf, shortHash, withholdOwnToolResults, ownToolCallIds, isOwnToolResult, WITHHELD_TOOL_RESULT_TEXT } from "../extensions/historyGuard.ts";
import { readBiosHostConfig } from "../extensions/hostConfig.ts";
import { createProjectSandbox, writeDsc } from "./helpers/projectFixtures.mjs";
import { rootsOf, withSession } from "./helpers/piSessionHarness.mjs";

const NOW = 1_700_000_000_000;
const SECRET = "SECRET-R33-HISTORY-REQUIREMENT";
const CUSTOMER = "customer-r33";

for (const change of ["none", "model", "origin", "unknown", "revoked"]) {
	test(`F2: bound service historical tool replay (${change}) through actual Pi SDK requests`, async () => {
		const sb = await buildKnowledge();
		try {
			await withSession(
				sb,
				{ ...envFor(sb), BIOS_ENDPOINT_GRANT: "", BIOS_AUTOMATION_ENABLED: "0", BIOS_AUTOMATION_BOOKKEEPING: "0", BIOS_AUTOMATION_INJECT: "0", BIOS_CONTEXT_ENABLED: "0" },
				(_body, index) => (index === 0 ? { toolCall: { name: "bios_get_task", arguments: { projectId: sb.projectA.projectId, taskId: "task-hist" } } } : { text: "Neutral response, no customer information." }),
				async ({ session, requests, applyEnv }) => {
					const model = session.model;
					applyEnv({ BIOS_ENDPOINT_GRANT: JSON.stringify({ provider: model.provider, modelId: model.id, origin: new URL(model.baseUrl).origin, version: 1 }) });
					await session.prompt("只读获取任务");
					assert.ok(JSON.stringify(requests.at(-1).body).includes(SECRET), "approved service receives real tool result");
					if (change === "model") await session.setModel({ ...model, id: "unapproved-model" });
					// Same local server, distinct origin spelling: no external request or real data.
					if (change === "origin") await session.setModel({ ...model, baseUrl: model.baseUrl.replace("127.0.0.1", "localhost") });
					if (change === "unknown") applyEnv({ BIOS_ENDPOINT: "unknown" });
					if (change === "revoked") applyEnv({ BIOS_ENDPOINT: "denied" });
					await session.prompt("只需问候，不要检索");
					const last = JSON.stringify(requests.at(-1).body);
					assert.equal(last.includes(SECRET), change === "none", "only unchanged approved service may replay historical knowledge");
					if (change !== "none") assert.match(last, /已撤回/);
					assert.ok(!session.messages.filter((message) => message.role === "assistant").some((message) => JSON.stringify(message).includes(SECRET)), "sentinel comes from tool history, not assistant echo");
				},
				{ noTools: false },
			);
		} finally {
			await sb.cleanup();
		}
	});
}

async function buildKnowledge() {
	const sb = await createProjectSandbox("bm07-r33-hist-");
	await initializeKnowledgeStore({ root: sb.root, now: NOW });
	await writeDsc(sb.workspaceA, "Platform/SamplePkg/Sample.dsc", { platformName: "SamplePlatformA" });
	await mkdir(sb.workspaceB, { recursive: true });
	await writeDsc(sb.workspaceB, "Platform/SamplePkg/Sample.dsc", { platformName: "SamplePlatformB" });
	const projectA = await bindProjectWorkspace({ root: sb.root, cwd: sb.workspaceA, authorizedRoots: [sb.workspaceA, sb.workspaceB], workspacePath: sb.workspaceA, now: NOW });
	const projectB = await bindProjectWorkspace({ root: sb.root, cwd: sb.workspaceB, authorizedRoots: [sb.workspaceA, sb.workspaceB], workspacePath: sb.workspaceB, now: NOW });
	await createTask({ root: sb.root, projectId: projectA.projectId, taskId: "task-hist", workspaceId: projectA.workspaceId, cwd: sb.workspaceA, authorizedRoots: [sb.workspaceA], requirement: SECRET, todos: ["待办一"], authorizedProjectIds: [projectA.projectId] });
	// R34-1：另建一个**绑定工作区 B** 的任务：会话目录是 A，读到正文依赖"当时授权了 A+B"。
	await createTask({ root: sb.root, projectId: projectB.projectId, taskId: "task-hist-b", workspaceId: projectB.workspaceId, cwd: sb.workspaceB, authorizedRoots: [sb.workspaceB], requirement: SECRET, todos: ["待办一"], authorizedProjectIds: [projectB.projectId] });
	return { ...sb, projectA, projectB };
}

function envFor(sb) {
	return {
		BIOS_KNOWLEDGE_ROOT: sb.root,
		BIOS_AUTHORIZED_PROJECTS: sb.projectA.projectId,
		BIOS_APPROVED_CUSTOMERS: CUSTOMER,
		BIOS_ENDPOINT: "allowed",
		BIOS_AUTHORIZED_ROOTS: rootsOf(sb.workspaceA, sb.workspaceB),
	};
}

/** 走一遍"allowed 下真实工具调用 → 改配置 → 普通提问"，返回三次请求的可见文本。 */
async function runToolCallThenChange(sb, patch) {
	const respond = (_body, index) => (index === 0 ? { toolCall: { name: "bios_get_task", arguments: { projectId: sb.projectA.projectId, taskId: "task-hist" } } } : { text: "final answer" });
	return await withSession(
		sb,
		envFor(sb),
		respond,
		async ({ session, requests, applyEnv }) => {
			await session.prompt("请读取当前任务");
			const afterTool = JSON.stringify(requests.map((request) => request.body));
			assert.equal(requests.length >= 2, true, `工具循环应产生两次请求（实际 ${requests.length}）`);
			assert.ok(afterTool.includes(SECRET), `正对照：allowed 下工具结果应含需求正文：${afterTool.slice(0, 400)}`);
			if (patch !== null) applyEnv(patch);
			await session.prompt("再说明一次当前任务");
			const last = JSON.stringify(requests.at(-1).body);
			return { afterTool, last, requestCount: requests.length };
		},
		{ noTools: false },
	);
}

test("R33-1：allowed→denied 后，历史 BIOS 工具结果不再随请求重放正文", async () => {
	const sb = await buildKnowledge();
	try {
		const { last } = await runToolCallThenChange(sb, { BIOS_ENDPOINT: "denied" });
		assert.ok(!last.includes(SECRET), `denied 请求不得含旧需求正文：${last.slice(0, 500)}`);
		assert.match(last, /已撤回/, "必须留下可读的撤回说明（要求隔离/重读）");
	} finally {
		await sb.cleanup();
	}
});

test("R33-1：allowed→unknown 同样撤回；什么都不改的正对照仍保留正文", async () => {
	const sb = await buildKnowledge();
	try {
		const unknown = await runToolCallThenChange(sb, { BIOS_ENDPOINT: "unknown" });
		assert.ok(!unknown.last.includes(SECRET), `unknown 请求不得含旧需求正文：${unknown.last.slice(0, 500)}`);

		const control = await runToolCallThenChange(sb, null);
		assert.ok(control.last.includes(SECRET), `正对照：配置未收窄时必须保留（否则"全撤回"会被误当成安全）：${control.last.slice(0, 400)}`);
	} finally {
		await sb.cleanup();
	}
});

test("R34-1：只撤回必需目录授权（会话 cwd=ws-a、任务绑定 ws-b）也撤回旧结果；放宽保留", async () => {
	const sb = await buildKnowledge();
	try {
		// 任务绑定**工作区 B**，会话目录是 A：正文能读到，恰恰是因为当时授权了 A+B。
		const env = {
			BIOS_KNOWLEDGE_ROOT: sb.root,
			BIOS_AUTHORIZED_PROJECTS: sb.projectB.projectId,
			BIOS_APPROVED_CUSTOMERS: CUSTOMER,
			BIOS_ENDPOINT: "allowed",
			BIOS_AUTHORIZED_ROOTS: rootsOf(sb.workspaceA, sb.workspaceB),
		};
		const respond = (_body, index) => (index === 0 ? { toolCall: { name: "bios_get_task", arguments: { projectId: sb.projectB.projectId, taskId: "task-hist-b" } } } : { text: "final answer" });
		const { last, widened } = await withSession(
			sb,
			env,
			respond,
			async ({ session, requests, applyEnv }) => {
				await session.prompt("请读取当前任务");
				const afterTool = JSON.stringify(requests.map((request) => request.body));
				assert.ok(afterTool.includes(SECRET), `正对照：授权 A+B 时工具结果含任务正文：${afterTool.slice(0, 400)}`);

				// 放宽（多给一个目录根）：不是撤权，旧结果必须保留（避免"全撤回"被当成安全）。
				applyEnv({ BIOS_AUTHORIZED_ROOTS: rootsOf(sb.workspaceA, sb.workspaceB) });
				await session.prompt("放宽后再说明一次");
				const widenedText = JSON.stringify(requests.at(-1).body);
				assert.ok(widenedText.includes(SECRET), `放宽目录授权不得撤回旧结果：${widenedText.slice(0, 400)}`);

				// 只撤回 B（A 仍授权、端点仍 allowed、项目/客户不变）⇒ 旧结果必须失效。
				applyEnv({ BIOS_AUTHORIZED_ROOTS: sb.workspaceA });
				await session.prompt("撤回 B 之后再说一次");
				return { last: JSON.stringify(requests.at(-1).body), widened: widenedText };
			},
			{ noTools: false },
		);
		assert.ok(!last.includes(SECRET), `撤回必需目录后不得重放旧任务正文：${last.slice(0, 500)}`);
		assert.match(last, /已撤回/, "必须留下可读的撤回说明");
		assert.ok(widened.includes(SECRET));
	} finally {
		await sb.cleanup();
	}
});

test("R33-1：项目撤权（端点仍 allowed）也撤回旧结果", async () => {
	const sb = await buildKnowledge();
	try {
		const { last } = await runToolCallThenChange(sb, { BIOS_AUTHORIZED_PROJECTS: sb.projectB.projectId });
		assert.ok(!last.includes(SECRET), `撤权后不得含旧需求正文：${last.slice(0, 500)}`);
		assert.match(last, /已撤回/);
	} finally {
		await sb.cleanup();
	}
});

test("R33-1：客户范围撤权（端点仍 allowed）也撤回旧结果", async () => {
	const sb = await buildKnowledge();
	try {
		const { last } = await runToolCallThenChange(sb, { BIOS_APPROVED_CUSTOMERS: "" });
		assert.ok(!last.includes(SECRET), `客户撤权后不得含旧需求正文：${last.slice(0, 500)}`);
	} finally {
		await sb.cleanup();
	}
});

/* ------------------------------------------------------------ 单元：结构化归属 */

const assistantWithCall = (id, name) => ({ role: "assistant", content: [{ type: "toolCall", id, name, arguments: {} }] });
const toolResult = (id, name, overrides = {}) => ({
	role: "toolResult",
	toolCallId: id,
	toolName: name,
	content: [{ type: "text", text: `正文 ${SECRET}` }],
	// R34-1：真实结果都带目录授权 + 身份依据（这里是单元构造的等价形态）。
	details: { status: "ok", outbound: { allowCommercialBody: true }, scope: { endpoint: "allowed", projectIds: ["p1"], featureIds: ["f1"], customers: ["c1"], knowledgeRootHash: "aaaa1111", rootHashes: [shortHash("C:/ws-a"), shortHash("C:/ws-b")], cwdHash: "cwd-hash" } },
	isError: false,
	timestamp: 1,
	...overrides,
});
// R34-1：范围里必须带**目录授权与身份依据**（只记哈希），否则目录撤回判定不出来。
const rootA = shortHash("C:/ws-a");
const rootB = shortHash("C:/ws-b");
const narrow = { endpoint: "denied", projectIds: ["p1"], featureIds: ["f1"], customers: ["c1"], knowledgeRootHash: "aaaa1111", rootHashes: [rootA, rootB], cwdHash: "cwd-hash" };
const same = { endpoint: "allowed", projectIds: ["p1"], featureIds: ["f1"], customers: ["c1"], knowledgeRootHash: "aaaa1111", rootHashes: [rootA, rootB], cwdHash: "cwd-hash" };
/** 只撤回一个目录授权（其余不变）：R34-1 的主场景。 */
const rootsReduced = { ...same, rootHashes: [rootA] };

test("R33-1 单元：只认自己的工具 + 与真实 tool-call 配对（不靠文本子串）", () => {
	const messages = [
		assistantWithCall("c1", "bios_get_task"),
		toolResult("c1", "bios_get_task"),
		assistantWithCall("c2", "read"),
		toolResult("c2", "read"), // 别的工具
		toolResult("c3", "bios_get_task"), // 同名但没有对应 tool call（伪造 id）
		{ role: "user", content: `用户自己贴了 ${SECRET}` }, // 用户消息绝不改
	];
	const ownIds = ownToolCallIds(messages);
	assert.deepEqual([...ownIds], ["c1"]);
	assert.equal(isOwnToolResult(messages[1], ownIds), true);
	assert.equal(isOwnToolResult(messages[3], ownIds), false, "别的工具不归我们");
	assert.equal(isOwnToolResult(messages[4], ownIds), false, "没有对应 tool call 的同名结果不归我们");

	const outcome = withholdOwnToolResults(messages, narrow);
	assert.equal(outcome.withheld, 1, "只撤回应撤回的那一条");
	assert.ok(!JSON.stringify(outcome.messages[1]).includes(SECRET), "自有结果不得再含正文");
	assert.ok(!JSON.stringify(outcome.messages[4]).includes(SECRET) === false, "用户自己的消息保持原样");
	assert.ok(JSON.stringify(outcome.messages[3]).includes(SECRET), "别的工具的消息保持原样");
});

test("R33-1 单元：保留工具协议字段；幂等；只按收窄撤回", () => {
	const messages = [assistantWithCall("c1", "bios_get_task"), toolResult("c1", "bios_get_task")];
	const once = withholdOwnToolResults(messages, narrow);
	const after = once.messages[1];
	assert.equal(after.role, "toolResult");
	assert.equal(after.toolCallId, "c1", "toolCallId 必须保留（配对关系不变）");
	assert.equal(after.toolName, "bios_get_task");
	assert.equal(after.isError, false);
	assert.equal(after.timestamp, 1);
	assert.equal(after.content.length, 1, "恰好一条内容");
	assert.equal(after.content[0].type, "text");
	assert.equal(after.content[0].text, WITHHELD_TOOL_RESULT_TEXT);

	const twice = withholdOwnToolResults(once.messages, narrow);
	assert.equal(twice.withheld, 0, "已撤回的不得反复改写");
	assert.equal(twice.messages, once.messages, "无变化时应返回同一引用");

	// 端点 allowed + 授权未变 ⇒ 不动。
	const untouched = withholdOwnToolResults(messages, same);
	assert.equal(untouched.withheld, 0);
	assert.equal(untouched.messages, messages);
	// 放宽（新增项目）不撤回。
	const widened = withholdOwnToolResults(messages, { ...same, projectIds: ["p1", "p2"] });
	assert.equal(widened.withheld, 0, "放宽不是撤权");
	// 知识根变化 ⇒ 撤回（换库后旧结果不可比）。
	const otherRoot = withholdOwnToolResults(messages, { ...same, knowledgeRootHash: "bbbb2222" });
	assert.equal(otherRoot.withheld, 1);
});

test("R34-1 单元：缺少目录授权证据的旧结果一律不重放（无法证明仍获授权）", () => {
	const legacy = { role: "toolResult", toolCallId: "c1", toolName: "bios_get_task", content: [{ type: "text", text: SECRET }], details: {}, isError: false, timestamp: 1 };
	const messages = [assistantWithCall("c1", "bios_get_task"), legacy];
	// 旧元数据没有目录授权/身份依据 ⇒ 保守：即使端点仍 allowed 也不重放。
	const outcome = withholdOwnToolResults(messages, same);
	assert.equal(outcome.withheld, 1, "无法证明仍获授权的旧元数据必须保守撤回");
	assert.ok(!JSON.stringify(outcome.messages[1]).includes(SECRET));
	assert.match(String(outcome.messages[1].details.historyWithheldReason), /无法证明/);
	assert.equal(withholdOwnToolResults(messages, narrow).withheld, 1, "不允许外发时同样撤回");
});

test("R34-1 单元：只撤回必需目录即失效；新增目录（放宽）保留正常结果；身份基准变化也失效", () => {
	const messages = [assistantWithCall("c1", "bios_get_task"), toolResult("c1", "bios_get_task", same)];
	// 正对照：范围未变 ⇒ 不动。
	assert.equal(withholdOwnToolResults(messages, same).withheld, 0);
	// 放宽（新增目录根 / 新增项目）不是撤权。
	assert.equal(withholdOwnToolResults(messages, { ...same, rootHashes: [rootA, rootB, shortHash("C:/ws-c")] }).withheld, 0, "放宽不得撤回");
	assert.equal(withholdOwnToolResults(messages, { ...same, projectIds: ["p1", "p2"] }).withheld, 0, "放宽不得撤回");
	// 撤回必需目录（结果依赖 B）⇒ 失效。
	const dropped = withholdOwnToolResults(messages, rootsReduced);
	assert.equal(dropped.withheld, 1, "撤回必需目录必须让旧结果失效");
	assert.ok(!JSON.stringify(dropped.messages[1]).includes(SECRET));
	// 身份基准（会话目录）变了 ⇒ 不再属于当前续跑身份。
	assert.equal(withholdOwnToolResults(messages, { ...same, cwdHash: "other-cwd" }).withheld, 1, "身份基准变化必须撤回");
});

test("R34-1 单元：scopeOf 只记录 ID/策略/哈希（目录根与 cwd 也只记哈希，不含路径）", () => {
	const scope = scopeOf(readBiosHostConfig({ BIOS_KNOWLEDGE_ROOT: "C:/kb", BIOS_AUTHORIZED_PROJECTS: "p1", BIOS_ENDPOINT: "allowed" }), { cwd: "C:/ws-a", authorizedRoots: ["C:/ws-a", "C:/ws-b"] });
	assert.deepEqual(Object.keys(scope).sort(), ["customers", "cwdHash", "endpoint", "featureIds", "knowledgeRootHash", "projectIds", "rootHashes"]);
	const dump = JSON.stringify(scope);
	assert.ok(!dump.includes("C:/kb"), "不得记录知识根路径本身");
	assert.ok(!dump.includes("C:/ws-a") && !dump.includes("C:/ws-b"), "不得记录目录路径本身");
	assert.equal(scope.knowledgeRootHash.length, 8);
	assert.equal(scope.rootHashes.length, 2);
	assert.equal(scope.cwdHash.length, 8);
	// 没有会话目录时身份基准记为 none（不会被误判成"变了"）。
	assert.equal(scopeOf(readBiosHostConfig({ BIOS_KNOWLEDGE_ROOT: "C:/kb", BIOS_ENDPOINT: "allowed" }), { cwd: "", authorizedRoots: [] }).cwdHash, "none");
});
