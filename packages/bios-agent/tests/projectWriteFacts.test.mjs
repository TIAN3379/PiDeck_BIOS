/**
 * R28-1 / R28-4 永久回归：**领域写入的发布事实**与**公共入口的授权边界**。
 *
 * R28-1：registry 已发布之后，档案读取失败、journal 终态写不进去时，
 * 调用方必须拿到"已经发布了什么、还差什么、要人工核对什么"，不能只得到一句 io-error，
 * 更不能把"已提交但记账失败"报成干净成功。
 *
 * R28-4：每个会访问工作区的公开入口都必须按本次会话的 cwd/授权根执行判定——
 * 绑定记录里保存的路径不是长期通行证。
 */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { initializeKnowledgeStore } from "../core/storage/index.ts";
import { ProjectServiceError, bindProjectWorkspace, captureWorkspaceSnapshot, confirmProfileFields, detectProjectCandidates, openProjectProfile, readProjectView, refreshWorkspaceSnapshot, verifyEvidenceRefs } from "../core/projects/index.ts";
import { createProjectSandbox, writeDsc } from "./helpers/projectFixtures.mjs";

const NOW = 1_700_000_000_000;

function projectError(code, detail) {
	return (error) => {
		assert.ok(error instanceof ProjectServiceError, `期望 ProjectServiceError，实际：${error?.constructor?.name}`);
		assert.equal(error.code, code);
		if (detail !== undefined) assert.equal(error.detail, detail);
		return true;
	};
}

function access(workspacePath) {
	return { cwd: workspacePath, authorizedRoots: [workspacePath] };
}

async function sandbox() {
	const sandboxValue = await createProjectSandbox("bm03-facts-");
	await initializeKnowledgeStore({ root: sandboxValue.root, now: NOW });
	await writeDsc(sandboxValue.workspaceA, "Platform/SamplePkg/Sample.dsc", { platformName: "SamplePlatform" });
	return sandboxValue;
}

/**
 * 在指定操作 + 目标子串上注入真实 fs 形态的错误（不需要真实磁盘故障）。
 *
 * 用子串匹配而不是后缀：journal 的路径是 `journal/<uuid>.json`，
 * 只按后缀匹配会永远匹配不上（那会让"故障注入成功"变成假象）。
 */
function injectOn(operation, targetIncludes, error) {
	return {
		beforeIo: (observedOperation, target) => {
			if (observedOperation === operation && target.includes(targetIncludes)) throw error;
		},
	};
}

function fsError(code) {
	return Object.assign(new Error(`${code}: injected`), { code });
}

test("R28-1：registry 已发布后档案读取失败，仍保留已发布事实与续办信息", async () => {
	const sb = await sandbox();
	try {
		const result = await bindProjectWorkspace({
			...access(sb.workspaceA),
			root: sb.root,
			workspacePath: sb.workspaceA,
			now: NOW,
			ioHooks: injectOn("open", "profile.json", fsError("EACCES")),
		});

		assert.equal(result.status, "partial", "已发布 registry 但档案没读完 ⇒ 不能报 failed/bound");
		assert.match(result.projectId, /^[0-9a-f-]{36}$/, "必须保留已发布的 projectId");
		assert.match(result.workspaceId, /^[0-9a-f-]{36}$/, "必须保留 workspaceId");
		assert.equal(result.registryRevision, 1, "必须保留已发布的 registry revision");
		assert.deepEqual(
			result.steps.map((step) => `${step.step}:${step.status}`),
			["registry:published", "profile:failed"],
		);
		assert.ok(
			result.resume.some((hint) => /registry 绑定已发布/.test(hint)),
			"必须给出可执行的接续方法",
		);
		assert.ok(result.problems.some((problem) => /档案/.test(problem)));

		// 磁盘上 registry 真的已经有这个项目：调用方拿到的事实与磁盘一致。
		const registry = JSON.parse(await readFile(join(sb.root, "registry.json"), "utf8"));
		assert.equal(registry.revision, 1);
		assert.equal(registry.projects.length, 1);
		assert.equal(registry.projects[0].biosProjectId, result.projectId);

		// 重新执行同一条 bind（不再注入故障）：先读现状，不重复建项目。
		const retried = await bindProjectWorkspace({ ...access(sb.workspaceA), root: sb.root, workspacePath: sb.workspaceA, now: NOW + 1 });
		assert.equal(retried.projectId, result.projectId);
		assert.equal(retried.workspaceId, result.workspaceId);
		const registryAfter = JSON.parse(await readFile(join(sb.root, "registry.json"), "utf8"));
		assert.equal(registryAfter.projects.length, 1, "重试不得新建第二个项目");
	} finally {
		await sb.cleanup();
	}
});

test("R28-1：journal 终态未写入时报 needs-review 并保留 published 事实", async () => {
	const sb = await sandbox();
	try {
		// 终态通过 `replaceJson`（rename）写 journal：注入一次 EBUSY。
		const result = await bindProjectWorkspace({
			...access(sb.workspaceA),
			root: sb.root,
			workspacePath: sb.workspaceA,
			now: NOW,
			ioHooks: injectOn("rename", "journal", fsError("EBUSY")),
		});

		assert.equal(result.status, "needs-review", "已提交但 journal 终态没写 ⇒ 不是干净成功");
		assert.ok(result.needsReview.length > 0, "必须给出需要人工核对的原因");
		assert.ok(result.needsReview.some((reason) => /journal 终态未写入/.test(reason)));
		assert.ok(result.needsReview.some((reason) => /reconcileJournalOperation|巡检|核对/.test(reason)));
		assert.equal(result.warnings.length > 0, true, "存储层的遗留诊断必须透传");
		assert.deepEqual(
			result.steps.map((step) => `${step.step}:${step.status}`),
			["registry:published", "profile:published"],
		);
		assert.equal(result.profileRevision, 0);

		// 内容确实写下去了（"已提交"不是"未写"）。
		const profile = JSON.parse(await readFile(join(sb.root, "projects", result.projectId, "profile.json"), "utf8"));
		assert.equal(profile.id, result.projectId);

		// journal 留在 prepared（本批不自动修复，必须由巡检/核对收口）。
		const { readdir } = await import("node:fs/promises");
		const journalFiles = await readdir(join(sb.root, "journal"));
		assert.ok(journalFiles.length > 0, "终态未写入时 prepared 必须留在磁盘上（可核对）");
	} finally {
		await sb.cleanup();
	}
});

test("R28-1：确认与刷新同样透传 journal/清理事实", async () => {
	const sb = await sandbox();
	try {
		const bound = await bindProjectWorkspace({ ...access(sb.workspaceA), root: sb.root, workspacePath: sb.workspaceA, now: NOW });
		const opened = await openProjectProfile({ root: sb.root, cwd: sb.workspaceA, workspacePath: sb.workspaceA });

		const confirmed = await confirmProfileFields({
			root: sb.root,
			projectId: bound.projectId,
			workspaceId: bound.workspaceId,
			expectedProfileRevision: opened.profileRevision,
			values: [{ field: "boardName", value: "BoardWarn" }],
			now: NOW + 1,
			ioHooks: injectOn("rename", "journal", fsError("EBUSY")),
		});
		assert.equal(confirmed.status, "confirmed", "数据已提交 ⇒ 状态仍是 confirmed");
		assert.ok(confirmed.needsReview.length > 0, "但必须同时报告需要人工核对的事实");
		const stored = JSON.parse(await readFile(join(sb.root, "projects", bound.projectId, "profile.json"), "utf8"));
		assert.equal(stored.identity.boardName.value, "BoardWarn", "确认值确实写入了");

		const refreshed = await refreshWorkspaceSnapshot({
			...access(sb.workspaceA),
			root: sb.root,
			projectId: bound.projectId,
			workspaceId: bound.workspaceId,
			expectedProfileRevision: confirmed.revision,
			now: NOW + 2,
			ioHooks: injectOn("rename", "journal", fsError("EBUSY")),
		});
		assert.equal(refreshed.status, "refreshed");
		assert.ok(refreshed.needsReview.length > 0);
		assert.equal(refreshed.revision, confirmed.revision + 1);
	} finally {
		await sb.cleanup();
	}
});

test("R28-4：打开/检测/读取/刷新/复验都对**档案里的工作区路径**重新执行授权", async () => {
	const sb = await sandbox();
	try {
		const outside = join(sb.base, "outside-root");
		await mkdir(outside, { recursive: true });
		const bound = await bindProjectWorkspace({ ...access(sb.workspaceA), root: sb.root, workspacePath: sb.workspaceA, now: NOW });
		const opened = await openProjectProfile({ root: sb.root, cwd: sb.workspaceA, workspacePath: sb.workspaceA });
		assert.equal(opened.usable, true, "授权范围内必须可用");

		// 会话 cwd 换成别处、且不把工作区加入授权根 ⇒ 打开是**拒绝**，不是"不可达"。
		const narrowed = await openProjectProfile({ root: sb.root, cwd: outside, workspacePath: sb.workspaceA });
		assert.equal(narrowed.status, "not-authorized");
		assert.equal(narrowed.usable, false);
		assert.equal(narrowed.projectId, bound.projectId, "拒绝时仍如实给出绑定身份，便于人工改授权根");
		assert.equal(narrowed.profile, null, "未授权不得返回档案内容");
		assert.equal(narrowed.problems[0].code, "workspace-not-authorized");

		// 其它入口同样拒绝（不能靠 bind 的检查代表全部入口）。
		await assert.rejects(detectProjectCandidates({ workspacePath: sb.workspaceA, workspaceId: bound.workspaceId, cwd: outside }), projectError("not-authorized"));
		await assert.rejects(captureWorkspaceSnapshot({ workspacePath: sb.workspaceA, workspaceId: bound.workspaceId, cwd: outside }), projectError("not-authorized"));
		await assert.rejects(verifyEvidenceRefs({ workspacePath: sb.workspaceA, cwd: outside, entries: [{ key: "boardName", evidence: { type: "source-file", relativePath: "Platform/SamplePkg/Sample.dsc", contentHash: "0".repeat(64), capturedAt: NOW, validity: "active" } }] }), projectError("not-authorized"));
		await assert.rejects(refreshWorkspaceSnapshot({ root: sb.root, cwd: outside, projectId: bound.projectId, workspaceId: bound.workspaceId, expectedProfileRevision: opened.profileRevision }), projectError("not-authorized"));

		// read 视图：不可用 + 明确原因（不是"空结论"）。
		const view = await readProjectView({ root: sb.root, cwd: outside, workspacePath: sb.workspaceA, detect: true });
		assert.equal(view.status, "not-usable");
		assert.equal(view.decision, null);
		assert.equal(view.open.status, "not-authorized");

		// 显式把工作区加入授权根 ⇒ 立刻可用（限制是被执行的，不是被忽略的）。
		const authorized = await openProjectProfile({ root: sb.root, cwd: outside, authorizedRoots: [sb.workspaceA], workspacePath: sb.workspaceA });
		assert.equal(authorized.usable, true);
	} finally {
		await sb.cleanup();
	}
});

test("R28-4：不可达与未授权是两件事（目录离线不等于授权失败）", async () => {
	const sb = await sandbox();
	try {
		const bound = await bindProjectWorkspace({ ...access(sb.workspaceA), root: sb.root, workspacePath: sb.workspaceA, now: NOW });
		// 授权根里包含一个当前不存在的目录：词法上仍能判定授权，可达性如实报 missing。
		const missingRoot = join(sb.base, "offline-workspace");
		const result = await openProjectProfile({ root: sb.root, cwd: sb.base, authorizedRoots: [missingRoot], workspacePath: missingRoot });
		// 这个路径没有绑定 ⇒ 先报绑定缺失（授权判定只在解析出绑定之后才需要执行）。
		assert.equal(result.status, "missing");

		const registry = JSON.parse(await readFile(join(sb.root, "registry.json"), "utf8"));
		assert.equal(registry.projects[0].biosProjectId, bound.projectId, "被拒/缺失的读取不得改动 registry");
	} finally {
		await sb.cleanup();
	}
});
