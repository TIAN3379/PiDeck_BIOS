/**
 * R31-4 永久回归：**Manifest 存量重验的来源资格**与**真实双进程 CAS 竞争**。
 *
 * 覆盖 round31 §4 R31-4 的实际观察：
 * - 存量清单（schema 合法但语义不可信）里的跨项目档案 / 另一项目的未选任务 / 未授权需求，
 *   重验必须判 `identity` 而不是 `ok`（save 的守卫不能替代 verify 的守卫）；
 * - 未审核草稿来源判 `unreviewed`（"资格不合格"与"历史字节不可证明 unproven"分开）；
 * - 任务与 Manifest 的 CAS 用**两个真实子进程同时启动**再一起等待，断言一成一败且胜者磁盘完整。
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createRecord, initializeKnowledgeStore, readRecord } from "../core/storage/index.ts";
import { bindProjectWorkspace } from "../core/projects/index.ts";
import { createExperienceDraft, createFeature } from "../core/knowledge/index.ts";
import { createTask, updateTask } from "../core/tasks/index.ts";
import { saveContextManifest, verifyContextManifest } from "../core/context/index.ts";
import { createProjectSandbox, PACKAGE_ROOT, writeDsc } from "./helpers/projectFixtures.mjs";

const NOW = 1_700_000_000_000;
const WORKER = join(PACKAGE_ROOT, "tests", "helpers", "casWorker.mjs");

async function sandbox() {
	const sb = await createProjectSandbox("bm07-r31-manifest-");
	await initializeKnowledgeStore({ root: sb.root, now: NOW });
	await writeDsc(sb.workspaceA, "Platform/SamplePkg/Sample.dsc", { platformName: "SamplePlatformA" });
	await mkdir(sb.workspaceB, { recursive: true });
	await writeDsc(sb.workspaceB, "Platform/SamplePkg/Sample.dsc", { platformName: "SamplePlatformB" });
	const projectA = await bindProjectWorkspace({ root: sb.root, cwd: sb.workspaceA, authorizedRoots: [sb.workspaceA, sb.workspaceB], workspacePath: sb.workspaceA, now: NOW });
	const projectB = await bindProjectWorkspace({ root: sb.root, cwd: sb.workspaceB, authorizedRoots: [sb.workspaceA, sb.workspaceB], workspacePath: sb.workspaceB, now: NOW });
	return { ...sb, projectA, projectB };
}

const MANIFEST_DATA = (profileRevision, sources, extra = {}) => ({
	profileRevision,
	sources,
	expiredSources: [],
	budget: { maxChars: 12_000, maxBytes: 24 * 1024, usedChars: 100, truncated: false },
	generatedAt: NOW,
	...extra,
});

test("R31-4：存量清单的跨项目档案/未选任务/未授权需求一律判 identity，不返回 ok", async () => {
	const sb = await sandbox();
	try {
		// 项目 B 的档案（授权集合里只有 A）与项目 A 的**未选**任务：用可信 storage API 直接构造存量清单。
		await createTask({ root: sb.root, projectId: sb.projectA.projectId, taskId: "task-selected", workspaceId: sb.projectA.workspaceId, cwd: sb.workspaceA, authorizedRoots: [sb.workspaceA], requirement: "被选中的任务", authorizedProjectIds: [sb.projectA.projectId] });
		await createTask({ root: sb.root, projectId: sb.projectA.projectId, taskId: "task-other", workspaceId: sb.projectA.workspaceId, cwd: sb.workspaceA, authorizedRoots: [sb.workspaceA], requirement: "另一个任务", authorizedProjectIds: [sb.projectA.projectId] });
		await createFeature({ root: sb.root, feature: { featureId: "feat-hidden", originalRequirement: "未授权需求", aliases: ["h"], customer: { value: "customer-z", status: "confirmed" }, productLine: { value: "line-x", status: "confirmed" }, acceptanceCriteria: [], relatedExperienceIds: [] }, now: NOW });

		const profileARecord = await readRecord({ root: sb.root, kind: "project-profile", id: sb.projectA.projectId });
		const forged = await createRecord({
			kind: "context-manifest",
			id: "manifest-forged",
			projectId: sb.projectA.projectId,
			expectedRevision: null,
			root: sb.root,
			now: NOW + 1,
			data: MANIFEST_DATA(profileARecord.record.revision, [
				{ recordKind: "project-profile", recordId: sb.projectB.projectId, revision: 0, reason: "跨项目档案" },
				{ recordKind: "task-record", recordId: "task-other", revision: 0, reason: "未选任务" },
				{ recordKind: "feature-record", recordId: "feat-hidden", revision: 0, reason: "未授权需求" },
				{ recordKind: "project-profile", recordId: sb.projectA.projectId, revision: profileARecord.record.revision, reason: "目标档案" },
			]),
		});
		assert.ok(forged.revision >= 0);

		const verified = await verifyContextManifest({ root: sb.root, manifestId: "manifest-forged", projectId: sb.projectA.projectId, authorizedProjectIds: [sb.projectA.projectId], endpoint: { endpointAllowed: true, allowInternalGeneral: false, customers: [] } });
		assert.notEqual(verified.status, "ok", `存量清单不得因为 schema 合法就判 ok（实际 ${verified.status}）`);
		const states = new Map(verified.sources.map((source) => [`${source.recordKind}/${source.recordId}`, source.state]));
		assert.equal(states.get(`project-profile/${sb.projectB.projectId}`), "identity", "跨项目档案必须判 identity");
		assert.equal(states.get("task-record/task-other"), "identity", "未选任务必须判 identity");
		assert.equal(states.get("feature-record/feat-hidden"), "identity", "未授权需求必须判 identity");
		assert.equal(states.get(`project-profile/${sb.projectA.projectId}`), "unproven", "目标档案本身仍然只是 unproven");
	} finally {
		await sb.cleanup();
	}
});

test("R31-4：未审核草稿来源判 unreviewed（与 unproven 分开），且不返回 clean ok", async () => {
	const sb = await sandbox();
	try {
		await createTask({ root: sb.root, projectId: sb.projectA.projectId, taskId: "task-1", workspaceId: sb.projectA.workspaceId, cwd: sb.workspaceA, authorizedRoots: [sb.workspaceA], requirement: "任务", authorizedProjectIds: [sb.projectA.projectId] });
		const created = await createExperienceDraft({ root: sb.root, authorizedProjectIds: [sb.projectA.projectId], experience: { experienceId: "exp-draft", problem: "PXE", rootCause: "根因", solution: "方案", sourceProjectId: sb.projectA.projectId, reuse: { level: "current-project" } }, now: NOW });
		// 未审核草稿作为来源：save 允许（作为明确提示来源），但 verify 必须给出资格提示。
		const saved = await saveContextManifest({
			root: sb.root,
			manifestId: "manifest-draft",
			targetProjectId: sb.projectA.projectId,
			taskId: "task-1",
			profileRevision: (await readRecord({ root: sb.root, kind: "project-profile", id: sb.projectA.projectId })).record.revision,
			sources: [
				{ recordKind: "project-profile", recordId: sb.projectA.projectId, revision: 0, reason: "目标档案" },
				{ recordKind: "task-record", recordId: "task-1", revision: 0, reason: "所选任务" },
				{ recordKind: "experience-card", recordId: "exp-draft", revision: created.revision, reason: "待审核经验" },
			],
			budget: { maxChars: 12_000, maxBytes: 24 * 1024, usedChars: 10, truncated: false },
			generatedAt: NOW,
			authorizedProjectIds: [sb.projectA.projectId],
			now: NOW + 1,
		});
		assert.equal(saved.status, "saved");
		const verified = await verifyContextManifest({ root: sb.root, manifestId: "manifest-draft", projectId: sb.projectA.projectId, authorizedProjectIds: [sb.projectA.projectId], endpoint: { endpointAllowed: true, allowInternalGeneral: false, customers: [] } });
		assert.notEqual(verified.status, "ok", "未审核草稿不得获得 clean ok");
		const draft = verified.sources.find((source) => source.recordId === "exp-draft");
		assert.equal(draft?.state, "unreviewed", `草稿来源必须是 unreviewed（实际 ${draft?.state}）`);
		assert.match(draft?.reason ?? "", /未审核|草稿/, "必须说明是审核资格问题");
		assert.ok(verified.problems.some((problem) => /尚未审核/.test(problem)));
	} finally {
		await sb.cleanup();
	}
});

/** 同时启动两个真实子进程并等两者都结束。 */
function runBoth(argv) {
	return Promise.all(
		argv.map(
			(args) =>
				new Promise((resolve) => {
					const child = spawn(process.execPath, args, { cwd: PACKAGE_ROOT, stdio: ["ignore", "pipe", "pipe"] });
					let stdout = "";
					child.stdout.setEncoding("utf8");
					child.stdout.on("data", (chunk) => {
						stdout += chunk;
					});
					child.on("close", (code) => {
						const line =
							stdout
								.trim()
								.split("\n")
								.filter((value) => value !== "")
								.pop() ?? "";
						let json = null;
						try {
							json = JSON.parse(line);
						} catch {
							json = null;
						}
						resolve({ code, json, stdout });
					});
				}),
		),
	);
}

test("R31-4：任务与 Manifest 的真实双进程 CAS —— 一成一败且胜者磁盘事实完整", async () => {
	const sb = await sandbox();
	try {
		await createTask({ root: sb.root, projectId: sb.projectA.projectId, taskId: "task-race", workspaceId: sb.projectA.workspaceId, cwd: sb.workspaceA, authorizedRoots: [sb.workspaceA], requirement: "竞争任务", authorizedProjectIds: [sb.projectA.projectId] });
		await saveContextManifest({
			root: sb.root,
			manifestId: "manifest-race",
			targetProjectId: sb.projectA.projectId,
			taskId: "task-race",
			profileRevision: (await readRecord({ root: sb.root, kind: "project-profile", id: sb.projectA.projectId })).record.revision,
			sources: [
				{ recordKind: "project-profile", recordId: sb.projectA.projectId, revision: 0, reason: "目标档案" },
				{ recordKind: "task-record", recordId: "task-race", revision: 0, reason: "所选任务" },
			],
			budget: { maxChars: 12_000, maxBytes: 24 * 1024, usedChars: 10, truncated: false },
			generatedAt: NOW,
			authorizedProjectIds: [sb.projectA.projectId],
			now: NOW + 1,
		});

		// 两个子进程同时启动（不是先后 spawnSync），都拿着同一个 revision=0。
		const [taskA, taskB] = await runBoth([
			[WORKER, "task", sb.root, sb.projectA.projectId, "task-race", "0", "worker-1"],
			[WORKER, "task", sb.root, sb.projectA.projectId, "task-race", "0", "worker-2"],
		]);
		const taskResults = [taskA.json, taskB.json];
		const winners = taskResults.filter((result) => result?.status === "updated");
		const losers = taskResults.filter((result) => result?.status === "revision-conflict");
		assert.equal(winners.length, 1, `任务竞争必须一成一败（实际 ${JSON.stringify(taskResults)}）`);
		assert.equal(losers.length, 1, "另一个必须报 revision-conflict");
		const taskAfter = await readRecord({ root: sb.root, kind: "task-record", id: "task-race", projectId: sb.projectA.projectId });
		assert.equal(taskAfter.record.revision, 1, "胜者写入必须完整（revision 前进到 1）");
		assert.equal(taskAfter.record.todos.length, 1, "胜者的待办只剩自己的一条（败者不得部分写入）");

		const [manA, manB] = await runBoth([
			[WORKER, "manifest", sb.root, sb.projectA.projectId, "manifest-race", "0"],
			[WORKER, "manifest", sb.root, sb.projectA.projectId, "manifest-race", "0"],
		]);
		const manifestResults = [manA.json, manB.json];
		const manifestWinners = manifestResults.filter((result) => result?.status === "updated");
		const manifestLosers = manifestResults.filter((result) => result?.status === "revision-conflict");
		assert.equal(manifestWinners.length, 1, `Manifest 竞争必须一成一败（实际 ${JSON.stringify(manifestResults)}）`);
		assert.equal(manifestLosers.length, 1, "另一个必须报 revision-conflict");
		const manifestAfter = await readRecord({ root: sb.root, kind: "context-manifest", id: "manifest-race", projectId: sb.projectA.projectId });
		assert.equal(manifestAfter.record.revision, 1);
		assert.equal(manifestAfter.record.sources.length, 2, "胜者清单来源完整");
	} finally {
		await sb.cleanup();
	}
});

test("R31-4：同一 revision 的顺序重试仍受 CAS 保护（对照，不掩盖并发结论）", async () => {
	const sb = await sandbox();
	try {
		await createTask({ root: sb.root, projectId: sb.projectA.projectId, taskId: "task-seq", workspaceId: sb.projectA.workspaceId, cwd: sb.workspaceA, authorizedRoots: [sb.workspaceA], requirement: "顺序任务", authorizedProjectIds: [sb.projectA.projectId] });
		const first = await updateTask({ root: sb.root, projectId: sb.projectA.projectId, taskId: "task-seq", expectedRevision: 0, changes: { todos: ["first"] }, authorizedProjectIds: [sb.projectA.projectId], now: NOW + 1 });
		const second = await updateTask({ root: sb.root, projectId: sb.projectA.projectId, taskId: "task-seq", expectedRevision: 0, changes: { todos: ["second"] }, authorizedProjectIds: [sb.projectA.projectId], now: NOW + 2 });
		assert.equal(first.status, "updated");
		assert.equal(second.status, "revision-conflict");
		assert.deepEqual((await readRecord({ root: sb.root, kind: "task-record", id: "task-seq", projectId: sb.projectA.projectId })).record.todos, ["first"]);
	} finally {
		await sb.cleanup();
	}
});
