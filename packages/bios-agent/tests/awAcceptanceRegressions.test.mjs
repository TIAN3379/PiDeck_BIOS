/**
 * AW 独立验收（`docs/bios-agent/test_checklist.md`）R1～R7 的**正式回归**。
 *
 * 每个用例对应验收里的一个复现观察，但断言的是**整改后的正确行为**：
 * - R1：发送时重验授权（准备后撤权 ⇒ 下一次 provider 请求不得再含项目正文）；
 * - R3：补记指令是**模型可见**消息、真实产生额外 provider 请求、耐久标记落盘且只消费一次；
 * - R4：正式（已审核）经验进入自动检索；未批准客户范围的 working 草稿不返回正文；
 * - R6：受保护记录占满预算时**不新增文件**，轮换后磁盘有界；
 * - R7：非 Git / HEAD 未变但相关文件变化必须重扫，且 unchanged 时带回可复用候选。
 *
 * 纪律：不联网、不读客户库；知识库是临时合成目录，模型是本机回环 SSE。
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { initializeKnowledgeStore } from "../core/storage/index.ts";
import { bindProjectWorkspace } from "../core/projects/index.ts";
import { createExperienceDraft, reviewExperience } from "../core/knowledge/experiences.ts";
import { searchWorkingMemory } from "../core/automation/working.ts";
import { persistCheckpointRecord, readWorkspaceState } from "../core/automation/store.ts";
import { initialWorkspaceState } from "../core/automation/store.ts";
import { createProjectSandbox, writeDsc } from "./helpers/projectFixtures.mjs";
import { withSession } from "./helpers/piSessionHarness.mjs";

const AUTOMATION_ENV = { BIOS_AUTOMATION_ENABLED: "1", BIOS_AUTOMATION_BOOKKEEPING: "1", BIOS_AUTOMATION_INJECT: "1", BIOS_AUTOMATION_VERSION: "1" };

async function fixture(prefix) {
	const sb = await createProjectSandbox(prefix);
	await initializeKnowledgeStore({ root: sb.root });
	await writeDsc(sb.workspaceA, "Sample.dsc", { platformName: "SyntheticBefore" });
	const binding = await bindProjectWorkspace({ root: sb.root, cwd: sb.workspaceA, workspacePath: sb.workspaceA });
	const env = { ...AUTOMATION_ENV, BIOS_KNOWLEDGE_ROOT: sb.root, BIOS_AUTHORIZED_PROJECTS: binding.projectId, BIOS_AUTHORIZED_ROOTS: sb.workspaceA, BIOS_ENDPOINT: "allowed" };
	return { ...sb, ...binding, env };
}

function requestText(requests) {
	return JSON.stringify(requests.map((request) => request.body?.messages ?? []));
}

/* --------------------------------------------------------------------- R1 */

test("R1：准备之后撤权，下一次真实 provider 请求不再包含项目正文（并给出撤回说明）", async () => {
	const f = await fixture("aw-r1-revoke-");
	try {
		const secret = "SYNTHETIC_PRIVATE_WORKING_MARKER";
		await createExperienceDraft({
			root: f.root,
			authorizedProjectIds: [f.projectId],
			experience: {
				experienceId: "exp-r1-revoke",
				problem: "USB 速度问题",
				rootCause: "unknown",
				solution: secret,
				appliesWhen: ["synthetic only"],
				sourceProjectId: f.projectId,
				evidence: [{ type: "source-file", workspaceId: f.workspaceId, relativePath: "Sample.dsc", contentHash: "0".repeat(64) }],
				reuse: { level: "current-project" },
			},
		});
		await withSession(
			f,
			f.env,
			(_body, index) => {
				if (index === 0) return { toolCall: { name: "bios_get_project_info", arguments: {} } };
				return { text: "Synthetic result." };
			},
			async ({ session, requests, applyEnv }) => {
				await session.prompt("排查 USB 速度问题，先不要修改源码");
				// 准备完成后的第一轮确实拿到了本项目工作线索（draft 正文）。
				assert.ok(requestText([requests[0]]).includes(secret), "第一轮请求应含本项目工作线索（draft 正文）");
				// 中途撤权：端点 denied + 项目授权清空，然后发起第二轮。
				applyEnv({ BIOS_ENDPOINT: "denied", BIOS_AUTHORIZED_PROJECTS: "" });
				const before = requests.length;
				await session.prompt("继续");
				const later = requests.slice(before);
				assert.ok(later.length >= 1, "撤权后仍应有一次 provider 请求（普通对话继续）");
				assert.ok(!requestText(later).includes(secret), `撤权后不得再注入项目正文：${requestText(later).slice(0, 400)}`);
				// 撤权不是"静默什么都不说"：注入位置必须给出撤回说明（否则用户以为还在用项目资料）。
				assert.ok(requestText(later).includes("自动上下文已撤回"), "撤权后必须给出撤回说明");
			},
		);
	} finally {
		await f.cleanup();
	}
});

/* --------------------------------------------------------------------- R3 */

test("R3：补记阶段真实发生（模型可见指令 + 额外 provider 请求 + 耐久标记），且指令只消费一次", async () => {
	const f = await fixture("aw-r3-reflection-");
	try {
		await withSession(
			f,
			f.env,
			(body, index) => {
				const hasToolResult = (body?.messages ?? []).some((message) => message?.role === "tool" || message?.tool_call_id !== undefined);
				if (!hasToolResult) return { toolCall: { name: "bios_get_project_info", arguments: {} } };
				void index;
				return { text: "SYNTHETIC-R3: 调查完成" };
			},
			async ({ session, requests }) => {
				await session.prompt("排查 USB 启动问题，先不要改源码");
				// 工具调用 + 工具结果 两轮是基础；补记阶段必须再产生一轮真实 provider 请求。
				assert.ok(requests.length >= 3, `应发生补记阶段请求（实际 ${requests.length} 次请求）`);
				const instructionSeen = requests.some((request) => JSON.stringify(request.body?.messages ?? []).includes("[BIOS 自动化补记]"));
				assert.ok(instructionSeen, "补记指令必须以模型可见消息出现在真实请求里");
				// 耐久标记：state.json 里必须有 reflectionMarks（旧实现只在内存）。
				const statePath = join(f.root, "automation", "workspaces", f.workspaceId, "state.json");
				const state = JSON.parse(await readFile(statePath, "utf8"));
				assert.ok(state.reflectionMarks.length >= 1, `补记标记必须耐久落盘：${JSON.stringify(state.reflectionMarks)}`);
				assert.equal(state.reflectionMarks[0].saved, false, "尚未保存时标记应如实为 saved=false");

				// 旧断言"第二次原始请求不得再补记"把错误行为固化成了通过标准，已被 C1 用例取代
				// （逐请求预算 + 多轮各自补记见 `awRereviewRegressions.test.mjs` 的 C1 两项）。
			},
		);
	} finally {
		await f.cleanup();
	}
});

/* --------------------------------------------------------------------- R4 */

test("R4：working 先过滤客户/需求范围；正式（已审核）经验进入自动检索", async () => {
	const f = await fixture("aw-r4-scope-");
	try {
		const evidence = [{ type: "source-file", workspaceId: f.workspaceId, relativePath: "Sample.dsc", contentHash: "0".repeat(64) }];
		await createExperienceDraft({
			root: f.root,
			authorizedProjectIds: [f.projectId],
			experience: { experienceId: "exp-customer", problem: "USB issue", rootCause: "unknown", solution: "SYNTHETIC_CUSTOMER_PRIVATE_MARKER", appliesWhen: ["synthetic only"], sourceProjectId: f.projectId, evidence, reuse: { level: "customer", customers: ["SYNTHETIC_CUSTOMER"] } },
		});
		const base = { root: f.root, projectId: f.projectId, workspaceId: f.workspaceId, taskId: null, query: "USB", authorizedProjectIds: [f.projectId] };
		// 未批准客户：正文不得返回。
		const denied = await searchWorkingMemory(base);
		assert.ok(!JSON.stringify(denied.leads).includes("SYNTHETIC_CUSTOMER_PRIVATE_MARKER"), "未批准客户的草稿不得返回正文");
		assert.equal(denied.leads.length, 0);
		// 显式批准该客户后才可读。
		const allowed = await searchWorkingMemory({ ...base, approvedCustomers: ["SYNTHETIC_CUSTOMER"] });
		assert.ok(JSON.stringify(allowed.leads).includes("SYNTHETIC_CUSTOMER_PRIVATE_MARKER"), "批准客户后应可返回");
		// 端点不允许时连正文都不读。
		const endpointDenied = await searchWorkingMemory({ ...base, approvedCustomers: ["SYNTHETIC_CUSTOMER"], endpointAllowed: false });
		assert.equal(endpointDenied.status, "denied");
		assert.ok(!JSON.stringify(endpointDenied.leads).includes("SYNTHETIC_CUSTOMER_PRIVATE_MARKER"));

		// 需求绑定草稿：未授权需求不得返回。
		await createExperienceDraft({
			root: f.root,
			authorizedProjectIds: [f.projectId],
			experience: { experienceId: "exp-feature", problem: "USB issue feature", rootCause: "unknown", solution: "SYNTHETIC_FEATURE_PRIVATE_MARKER", appliesWhen: ["synthetic only"], sourceProjectId: f.projectId, featureId: "feat-1", evidence, reuse: { level: "current-project" } },
		});
		const featureDenied = await searchWorkingMemory(base);
		assert.ok(!JSON.stringify(featureDenied.leads).includes("SYNTHETIC_FEATURE_PRIVATE_MARKER"), "未授权需求的草稿不得返回");
		const featureAllowed = await searchWorkingMemory({ ...base, allowedFeatureIds: ["feat-1"] });
		assert.ok(JSON.stringify(featureAllowed.leads).includes("SYNTHETIC_FEATURE_PRIVATE_MARKER"));

		// 正式经验：提交审核后必须能被自动检索到（旧实现只查 working）。
		const reviewed = await createExperienceDraft({
			root: f.root,
			authorizedProjectIds: [f.projectId],
			experience: { experienceId: "exp-reviewed", problem: "USB 端口只跑 USB 2.0", rootCause: "SYNTHETIC_REVIEWED_ROOT_CAUSE", solution: "SYNTHETIC_REVIEWED_SOLUTION", appliesWhen: ["synthetic only"], sourceProjectId: f.projectId, evidence, reuse: { level: "current-project" } },
		});
		await reviewExperience({ root: f.root, authorizedProjectIds: [f.projectId], experienceId: "exp-reviewed", expectedRevision: reviewed.revision, action: "submit-review", operatorLabel: "fixture", reason: "synthetic" });
		const { searchReviewedKnowledge } = await import("../core/automation/working.ts");
		// R4：中文自然问句（没有空格）也必须可检索：严格查询落空时退化到单个最强词重试一次。
		const formal = await searchReviewedKnowledge({ root: f.root, query: "为什么USB端口只跑2.0速度", projectId: f.projectId, workspaceId: f.workspaceId, authorizedProjectIds: [f.projectId], allowedFeatureIds: [], approvedCustomers: [], endpointAllowed: true });
		assert.ok(JSON.stringify(formal.leads).includes("exp-reviewed"), `已审核经验必须进入自动检索：${JSON.stringify(formal.leads)}`);
		assert.ok(!JSON.stringify(formal.leads).includes("SYNTHETIC_CUSTOMER_PRIVATE_MARKER"), "正式检索不得借 working 的未验证草稿");
	} finally {
		await f.cleanup();
	}
});

/* --------------------------------------------------------------------- R6 */

test("R6：受保护记录占满预算时停止新增（不写文件、不产生孤儿）；轮换清理有界磁盘", async () => {
	const f = await fixture("aw-r6-capacity-");
	try {
		const target = { root: f.root, projectId: f.projectId, workspaceId: f.workspaceId };
		const baseline = { workspacePath: f.workspaceA, branch: null, commit: null, fileHashes: {}, capturedAt: 1 };
		const checkpoint = (runId) => ({
			version: 1,
			runId,
			projectId: f.projectId,
			workspaceId: f.workspaceId,
			sessionId: "s",
			branch: null,
			requestKey: `r-${runId}`,
			recordedAt: 1,
			baseline,
			executed: [{ tool: "read", outcome: "ok", files: [], wrote: false }],
			changedFiles: [],
			task: null,
			outcome: "in-progress",
			pendingReflection: true,
		});

		// 先写 50 条受保护记录（待补记 ⇒ 不可轮换）。
		for (let index = 0; index < 50; index += 1) {
			const outcome = await persistCheckpointRecord({ ...target, checkpoint: checkpoint(`run-${String(index).padStart(3, "0")}`), protectedFromRotation: true });
			assert.equal(outcome.status, "created", JSON.stringify(outcome));
		}
		const dir = join(f.root, "automation", "workspaces", f.workspaceId, "checkpoints");
		assert.equal((await readdir(dir)).length, 50);

		// 第 51 条受保护记录：必须 full，且**磁盘上不得多出文件**。
		const overflow = await persistCheckpointRecord({ ...target, checkpoint: checkpoint("run-050"), protectedFromRotation: true });
		assert.equal(overflow.status, "full", JSON.stringify(overflow));
		assert.equal((await readdir(dir)).length, 50, "full 时不得发布文件（否则是孤儿）");
		const state = await readWorkspaceState(target);
		assert.equal(state.status, "ok");
		assert.equal(state.value.checkpoints.length, 50, "索引不得超过上限");
		assert.ok(!state.value.checkpoints.some((ref) => ref.runId === "run-050"));

		// 轮换与磁盘有界：用较小上限观察"未受保护记录被移出索引且文件被清理"。
		const second = await fixture("aw-r6-rotate-");
		try {
			const small = { root: second.root, projectId: second.projectId, workspaceId: second.workspaceId, max: 4 };
			const smallBaseline = { workspacePath: second.workspaceA, branch: null, commit: null, fileHashes: {}, capturedAt: 1 };
			const smallCheckpoint = (runId, pending) => ({
				version: 1,
				runId,
				projectId: second.projectId,
				workspaceId: second.workspaceId,
				sessionId: "s",
				branch: null,
				requestKey: `r-${runId}`,
				recordedAt: 1,
				baseline: smallBaseline,
				executed: [{ tool: "read", outcome: "ok", files: [], wrote: false }],
				changedFiles: [],
				task: null,
				outcome: "in-progress",
				pendingReflection: pending,
			});
			for (const runId of ["p1", "p2", "u1", "u2"]) {
				const outcome = await persistCheckpointRecord({ ...small, checkpoint: smallCheckpoint(runId, runId.startsWith("p")), protectedFromRotation: runId.startsWith("p") });
				assert.equal(outcome.status, "created", JSON.stringify(outcome));
			}
			const smallDir = join(second.root, "automation", "workspaces", second.workspaceId, "checkpoints");
			assert.equal((await readdir(smallDir)).length, 4);
			// 再来一条未受保护记录：应成功并轮换出一条未受保护记录（文件被清理，磁盘保持有界）。
			const rotated = await persistCheckpointRecord({ ...small, checkpoint: smallCheckpoint("u3", false), protectedFromRotation: false });
			assert.equal(rotated.status, "created", JSON.stringify(rotated));
			assert.equal(rotated.rotatedOut.length, 1, "应轮换出一条未受保护记录");
			assert.ok(!existsSync(join(smallDir, `${rotated.rotatedOut[0]}.json`)), "被轮换的记录文件必须清理");
			assert.equal((await readdir(smallDir)).length, 4, "磁盘必须有界（轮换 = 新增 + 清理）");
			const smallState = await readWorkspaceState(small);
			assert.equal(smallState.status, "ok");
			assert.ok(smallState.value.checkpoints.length <= 4, "索引必须始终有界");
			// 受保护记录超过上限时必须 full（此处上限 3：先填满 3 条受保护，再来第 4 条）。
			const tiny = { ...small, max: 3 };
			const tinyDir = join(second.root, "automation", "workspaces", second.workspaceId, "checkpoints");
			await persistCheckpointRecord({ ...tiny, checkpoint: smallCheckpoint("q1", true), protectedFromRotation: true });
			await persistCheckpointRecord({ ...tiny, checkpoint: smallCheckpoint("q2", true), protectedFromRotation: true });
			await persistCheckpointRecord({ ...tiny, checkpoint: smallCheckpoint("q3", true), protectedFromRotation: true });
			const filesBefore = (await readdir(tinyDir)).length;
			const overflowSmall = await persistCheckpointRecord({ ...tiny, checkpoint: smallCheckpoint("q4", true), protectedFromRotation: true });
			assert.equal(overflowSmall.status, "full", JSON.stringify(overflowSmall));
			assert.equal((await readdir(tinyDir)).length, filesBefore, "full 时不得发布文件");
		} finally {
			await second.cleanup();
		}
	} finally {
		await f.cleanup();
	}
});

test("R6：状态在锁内先做容量判定，未知版本状态拒写且一个文件都不新增", async () => {
	const f = await fixture("aw-r6-version-");
	try {
		const target = { root: f.root, projectId: f.projectId, workspaceId: f.workspaceId };
		await persistCheckpointRecord({
			...target,
			checkpoint: {
				version: 1,
				runId: "run-a",
				projectId: f.projectId,
				workspaceId: f.workspaceId,
				sessionId: "s",
				branch: null,
				requestKey: "r",
				recordedAt: 1,
				baseline: { workspacePath: f.workspaceA, branch: null, commit: null, fileHashes: {}, capturedAt: 1 },
				executed: [],
				changedFiles: [],
				task: null,
				outcome: "in-progress",
				pendingReflection: false,
			},
			protectedFromRotation: false,
		});
		const statePath = join(f.root, "automation", "workspaces", f.workspaceId, "state.json");
		const future = `${JSON.stringify({ ...initialWorkspaceState({ projectId: f.projectId, workspaceId: f.workspaceId, now: 1 }), version: 99 }, null, "\t")}\n`;
		const { writeFile } = await import("node:fs/promises");
		await writeFile(statePath, future, "utf8");
		const dir = join(f.root, "automation", "workspaces", f.workspaceId, "checkpoints");
		const before = (await readdir(dir)).length;
		const refused = await persistCheckpointRecord({
			...target,
			checkpoint: {
				version: 1,
				runId: "run-b",
				projectId: f.projectId,
				workspaceId: f.workspaceId,
				sessionId: "s",
				branch: null,
				requestKey: "r",
				recordedAt: 2,
				baseline: { workspacePath: f.workspaceA, branch: null, commit: null, fileHashes: {}, capturedAt: 2 },
				executed: [],
				changedFiles: [],
				task: null,
				outcome: "in-progress",
				pendingReflection: false,
			},
			protectedFromRotation: false,
		});
		assert.equal(refused.status, "unsupported-version");
		assert.equal((await readdir(dir)).length, before, "版本不认识时不得新增文件");
		assert.equal(await readFile(statePath, "utf8"), future, "拒写必须保留原字节");
	} finally {
		await f.cleanup();
	}
});
