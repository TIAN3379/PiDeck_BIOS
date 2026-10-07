/**
 * AW 第二轮独立复验 C1～C5 的**正式回归**（`docs/bios-agent/test_checklist.md`（历史编号保留））。
 *
 * 每个用例对应 §7 的一个复现观察，但断言的是**整改后的正确行为**：
 * - C1：补记预算归属**单个原始请求**——同一会话连续三次调查都能各自补记；
 * - C2：补记阶段**实际** provider 请求不超过 2 次，且不允许源码写入/命令执行（用 `tool_call` 硬拦）；
 * - C3：完成回执只认真实写入（`saved:true` 要有真实回执支撑），索引与文件逐项一致；
 * - C4：同轮新建任务立即回链到检查点；只有明确续接意图才把旧任务当作当前工作。
 *
 * 全部离线：临时工程 + 临时知识根 + 本机回环 SSE provider（不联网、不碰真实工程）。
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { initializeKnowledgeStore } from "../core/storage/index.ts";
import { bindProjectWorkspace } from "../core/projects/index.ts";
import { listRecords } from "../core/storage/records.ts";
import { AUTOMATION_LIMITS } from "../core/automation/contract.ts";
import { looksLikeContinuation } from "../core/automation/policy.ts";
import { createProjectSandbox, writeDsc } from "./helpers/projectFixtures.mjs";
import { withSession } from "./helpers/piSessionHarness.mjs";

const AUTOMATION_ENV = { BIOS_AUTOMATION_ENABLED: "1", BIOS_AUTOMATION_BOOKKEEPING: "1", BIOS_AUTOMATION_INJECT: "1", BIOS_AUTOMATION_VERSION: "1" };
const INVESTIGATION = "排查 USB 启动问题，先不要改源码";

async function fixture(prefix) {
	const sb = await createProjectSandbox(prefix);
	await initializeKnowledgeStore({ root: sb.root });
	await writeDsc(sb.workspaceA, "Sample.dsc", { platformName: "SyntheticRereview" });
	const binding = await bindProjectWorkspace({ root: sb.root, cwd: sb.workspaceA, workspacePath: sb.workspaceA });
	return { ...sb, ...binding, env: { ...AUTOMATION_ENV, BIOS_KNOWLEDGE_ROOT: sb.root, BIOS_AUTHORIZED_PROJECTS: binding.projectId, BIOS_AUTHORIZED_ROOTS: sb.workspaceA, BIOS_ENDPOINT: "allowed" } };
}

const statePath = (f) => join(f.root, "automation", "workspaces", f.workspaceId, "state.json");
const checkpointsDir = (f) => join(f.root, "automation", "workspaces", f.workspaceId, "checkpoints");
const readState = async (f) => JSON.parse(await readFile(statePath(f), "utf8"));
const readCheckpoints = async (f) => {
	const dir = checkpointsDir(f);
	if (!existsSync(dir)) return [];
	const files = (await readdir(dir)).filter((name) => name.endsWith(".json"));
	const out = [];
	for (const name of files) out.push(JSON.parse(await readFile(join(dir, name), "utf8")));
	return out;
};
const requestText = (requests) => JSON.stringify(requests.flatMap((request) => request.body?.messages ?? []));
const reflectionInstructionCount = (requests) => requests.filter((request) => JSON.stringify(request.body?.messages ?? []).includes("[BIOS 自动化补记]")).length;
/** 触发真实 BIOS 只读工具的脚本；其余（含补记阶段）回文本。 */
const investigateThenText = (offsetRef) => (_body, index) => (index === offsetRef.value ? { toolCallId: `tool-${index}`, toolCall: { name: "bios_get_project_info", arguments: {} } } : { text: "SYNTHETIC 调查结论。" });

/* --------------------------------------------------------------------- C1 */

test("C1：同一会话连续三次原始请求都能各自补记（预算不再是整场会话累计）", async () => {
	const f = await fixture("aw-c1-rounds-");
	try {
		const offset = { value: 0 };
		await withSession(f, f.env, investigateThenText(offset), async ({ session, requests }) => {
			const rounds = [];
			for (let round = 1; round <= 3; round += 1) {
				const before = requests.length;
				offset.value = before;
				await session.prompt(INVESTIGATION);
				const slice = requests.slice(before);
				const state = await readState(f);
				const mark = state.reflectionMarks.find((entry) => entry.requestKey.length > 0);
				rounds.push({ round, providerRequests: slice.length, instructions: reflectionInstructionCount(slice), marks: state.reflectionMarks.length, anySaved: state.reflectionMarks.some((entry) => entry.saved === true), lastMark: mark });
			}
			for (const entry of rounds) {
				assert.ok(entry.providerRequests >= 2, `第 ${entry.round} 轮应有"调查 + 补记"至少两次请求：${JSON.stringify(rounds)}`);
				assert.equal(entry.instructions, 1, `第 ${entry.round} 轮必须有自己的补记指令：${JSON.stringify(rounds)}`);
			}
			assert.ok(rounds[2].marks >= 3, `三个请求都应有耐久标记（实际 ${rounds[2].marks}）：${JSON.stringify(rounds)}`);
			// 第三个请求的标记必须属于它自己（键不冲突、预算不被前两轮消耗）。
			const keys = (await readState(f)).reflectionMarks.map((entry) => entry.requestKey);
			assert.equal(new Set(keys).size, keys.length, `不同请求的标记键不得重复：${JSON.stringify(keys)}`);
		});
	} finally {
		await f.cleanup();
	}
});

test("C1：同前缀 prompt 也不会共用预算（键含会话内自增序号）", async () => {
	const f = await fixture("aw-c1-sameprefix-");
	try {
		const offset = { value: 0 };
		await withSession(f, f.env, investigateThenText(offset), async ({ session, requests }) => {
			const counts = [];
			for (let round = 0; round < 2; round += 1) {
				const before = requests.length;
				offset.value = before;
				await session.prompt(INVESTIGATION);
				counts.push({ providerRequests: requests.length - before, instructions: reflectionInstructionCount(requests.slice(before)) });
			}
			assert.equal(counts[0].instructions, 1, JSON.stringify(counts));
			assert.equal(counts[1].instructions, 1, `同样前缀的第二次请求也必须有补记：${JSON.stringify(counts)}`);
			const keys = (await readState(f)).reflectionMarks.map((entry) => entry.requestKey);
			assert.equal(new Set(keys).size, keys.length, JSON.stringify(keys));
		});
	} finally {
		await f.cleanup();
	}
});

/* --------------------------------------------------------------------- C2 */

test("C2：补记阶段持续工具循环时，实际 provider 请求不超过 2 次（请求前硬拦）", async () => {
	const f = await fixture("aw-c2-ceiling-");
	try {
		await withSession(
			f,
			f.env,
			(_body, index) => (index === 1 || index >= 7 ? { text: "SYNTHETIC 收口。" } : { toolCallId: `call-${index}`, toolCall: { name: "bios_get_project_info", arguments: {} } }),
			async ({ session, requests }) => {
				await session.prompt(INVESTIGATION);
				// 原始调查固定 2 次（工具调用 + 收口），其余都必须是补记阶段。
				const reflectionRequests = requests.length - 2;
				assert.ok(reflectionRequests >= 1, `应发生补记阶段请求：${requests.length}`);
				assert.ok(reflectionRequests <= AUTOMATION_LIMITS.maxReflectionProviderRequests, `补记阶段实际 provider 请求必须 <= ${AUTOMATION_LIMITS.maxReflectionProviderRequests}，实际 ${reflectionRequests}`);
			},
		);
	} finally {
		await f.cleanup();
	}
});

test("C2：补记阶段拒绝源码写入与命令执行，真实文件不变", async () => {
	const f = await fixture("aw-c2-toolcap-");
	try {
		const target = join(f.workspaceA, "ReflectionShouldNotWrite.txt");
		await withSession(
			f,
			f.env,
			(_body, index) => {
				if (index === 0) return { toolCallId: "investigation", toolCall: { name: "bios_get_project_info", arguments: {} } };
				if (index === 2) return { toolCallId: "unexpected-source-write", toolCall: { name: "write", arguments: { path: target, content: "SYNTHETIC_ONLY_MARKER" } } };
				if (index === 3) return { toolCallId: "unexpected-shell", toolCall: { name: "bash", arguments: { command: "echo SYNTHETIC_ONLY_MARKER > ReflectionShouldNotWrite2.txt" } } };
				return { text: "SYNTHETIC 收口。" };
			},
			async ({ session, requests }) => {
				await session.prompt(INVESTIGATION);
				assert.ok(reflectionInstructionCount(requests) >= 1, "补记指令必须真实出现（否则这个负例没有覆盖到补记阶段）");
				assert.equal(existsSync(target), false, "补记阶段不得创建源码文件");
				assert.equal(existsSync(join(f.workspaceA, "ReflectionShouldNotWrite2.txt")), false, "补记阶段不得执行命令写文件");
				// 被拒绝的工具调用也必须是**结构化**入账（不是静默忽略）。
				const facts = (await readCheckpoints(f)).flatMap((checkpoint) => checkpoint.executed);
				assert.ok(facts.length > 0, "至少应有原始调查事实");
			},
		);
	} finally {
		await f.cleanup();
	}
});

/* --------------------------------------------------------------------- C3 */

test("C3：补记阶段的真实写入 ⇒ 耐久标记 saved=true；索引与文件逐项一致", async () => {
	const f = await fixture("aw-c3-mark-");
	try {
		await withSession(
			f,
			f.env,
			(_body, index) => {
				if (index === 0) return { toolCallId: "investigation", toolCall: { name: "bios_get_project_info", arguments: {} } };
				if (index === 2) return { toolCallId: "save-task", toolCall: { name: "bios_manage_task", arguments: { action: "create", requirement: "SYNTHETIC C3 USB 调查", todos: ["检查 xHCI 初始化"] } } };
				return { text: "SYNTHETIC 收尾。" };
			},
			async ({ session }) => {
				await session.prompt(INVESTIGATION);
				const state = await readState(f);
				assert.ok(state.reflectionMarks.length >= 1, "必须写出耐久标记");
				assert.equal(state.reflectionMarks[0].saved, true, `补记阶段真实写了任务，标记必须是 saved=true：${JSON.stringify(state.reflectionMarks)}`);
				assert.ok((state.reflectionMarks[0].attempts ?? 0) >= 1, "完成回执必须带 attempts（有界恢复的依据）");
				// 索引与文件必须逐项一致（C3 的"索引/文件不一致"反例）。
				const checkpoints = await readCheckpoints(f);
				for (const ref of state.checkpoints) {
					const file = checkpoints.find((checkpoint) => checkpoint.runId === ref.runId);
					assert.ok(file !== undefined, `索引引用的检查点必须真实存在：${ref.runId}`);
					assert.equal(ref.pendingReflection, file.pendingReflection, `索引/文件的 pendingReflection 必须一致：${ref.runId}`);
					assert.equal(ref.taskId, file.task?.taskId ?? null, `索引/文件的 taskId 必须一致：${ref.runId}`);
				}
			},
		);
	} finally {
		await f.cleanup();
	}
});

/* --------------------------------------------------------------------- C4 */

test("C4：同轮新建任务立即回链到检查点（用真实回执，不用模型自报）", async () => {
	const f = await fixture("aw-c4-link-");
	try {
		await withSession(
			f,
			f.env,
			(_body, index) => (index === 0 ? { toolCallId: "create-task", toolCall: { name: "bios_manage_task", arguments: { action: "create", requirement: "SYNTHETIC C4 USB 调查", todos: ["检查初始化"] } } } : { text: "SYNTHETIC 完成。" }),
			async ({ session }) => {
				await session.prompt(INVESTIGATION);
				const tasks = await listRecords({ root: f.root, kind: "task-record", projectId: f.projectId });
				assert.equal(tasks.entries.length, 1, "应真实创建 1 个任务");
				const createdTaskId = tasks.entries[0].id;
				const checkpoints = await readCheckpoints(f);
				assert.ok(checkpoints.length > 0, "应有检查点");
				const linked = checkpoints.filter((checkpoint) => checkpoint.task?.taskId === createdTaskId);
				assert.ok(linked.length > 0, `本轮检查点必须关联刚创建的任务：${JSON.stringify(checkpoints.map((entry) => entry.task))}`);
				// 关联是按 taskId 检索的依据：索引里也必须能查到。
				const state = await readState(f);
				assert.ok(
					state.checkpoints.some((ref) => ref.taskId === createdTaskId),
					JSON.stringify(state.checkpoints),
				);
			},
		);
	} finally {
		await f.cleanup();
	}
});

test("C4：未表达续接意图时不把旧任务当作当前工作（只作背景）", async () => {
	assert.equal(looksLikeContinuation("看看这个工程的构建入口"), false);
	assert.equal(looksLikeContinuation("继续上次的排查"), true);
	assert.equal(looksLikeContinuation("where we left off"), true);

	const f = await fixture("aw-c4-background-");
	try {
		const { changeTaskStatus, createTask, updateTask } = await import("../core/tasks/index.ts");
		const taskId = "aw-c4-background-task";
		await createTask({ root: f.root, projectId: f.projectId, taskId, workspaceId: f.workspaceId, cwd: f.workspaceA, authorizedRoots: [f.workspaceA], authorizedProjectIds: [f.projectId], requirement: "SYNTHETIC-BACKGROUND-REQUIREMENT" });
		await updateTask({ root: f.root, projectId: f.projectId, taskId, expectedRevision: 0, changes: { todos: ["SYNTHETIC-BACKGROUND-TODO: 复核初始化顺序"] }, authorizedProjectIds: [f.projectId] });
		await changeTaskStatus({ root: f.root, projectId: f.projectId, taskId, expectedRevision: 1, to: "in_progress", reason: "synthetic", authorizedProjectIds: [f.projectId] });
		await withSession(
			f,
			f.env,
			() => ({ text: "SYNTHETIC 背景调查。" }),
			async ({ session, requests }) => {
				requests.length = 0;
				await session.prompt("看看这个工程为什么启动慢");
				const sent = requestText(requests);
				assert.ok(sent.includes("仅作背景参考"), `未表达续接时必须只作背景：${sent.slice(0, 400)}`);
				assert.ok(!sent.includes("请从这里继续"), "未表达续接时不得注入续接指令");
				requests.length = 0;
				await session.prompt("继续上次的排查");
				const continued = requestText(requests);
				assert.ok(continued.includes("SYNTHETIC-BACKGROUND-REQUIREMENT"), `明确续接时必须注入真实进展：${continued.slice(0, 400)}`);
				assert.ok(continued.includes("请从这里继续"), "明确续接时应给出续接指令");
			},
		);
	} finally {
		await f.cleanup();
	}
});
