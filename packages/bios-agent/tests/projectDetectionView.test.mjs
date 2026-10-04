/**
 * BM-03 B2/B4 永久回归：有限检测候选、资料缺口、M1 消费视图。
 *
 * 关键纪律（对应 bm03_development_plan.md §5）：
 * - 检测结果必须**来自真实文件内容**（这里用合成 EDK II 形状的文件，独立算 hash 对照）；
 * - 平台名不能自动变成板名，看到 .dsc/.inf 不能推断 IBV/芯片；
 * - 检测**不写档案**（用文件字节对照证明）；
 * - 视图能区分档案确认值 / 新检测候选 / 证据有效性，并在证据或 HEAD 变化时提示待复核，
 *   同时**不覆盖**人工确认值；
 * - 预算/取消/根外链接都有正反例。
 */
import assert from "node:assert/strict";
import { symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { initializeKnowledgeStore } from "../core/storage/index.ts";
import { ProjectServiceError, bindProjectWorkspace, confirmProfileFields, detectProjectCandidates, openProjectProfile, parseDec, parseDsc, readProjectView, refreshWorkspaceSnapshot, verifyEvidenceRefs } from "../core/projects/index.ts";
import { createProjectSandbox, fileHash, gitAvailable, git, initGitRepo, readProfileFile, writeDec, writeDsc } from "./helpers/projectFixtures.mjs";

const NOW = 1_700_000_000_000;

/**
 * 领域入口的**授权范围**（R28-4 起必填）：会话 cwd 就是该工作区本身。
 * 不显式给授权范围时，服务不会去访问任何工作区。
 */
function access(workspacePath) {
	return { cwd: workspacePath, authorizedRoots: [workspacePath] };
}

function projectError(code, detail) {
	return (error) => {
		assert.ok(error instanceof ProjectServiceError, `期望 ProjectServiceError，实际：${error?.constructor?.name}`);
		assert.equal(error.code, code);
		if (detail !== undefined) assert.equal(error.detail, detail);
		return true;
	};
}

async function sandboxWithWorkspace() {
	const sandbox = await createProjectSandbox();
	await initializeKnowledgeStore({ root: sandbox.root, now: NOW });
	await writeDsc(sandbox.workspaceA, "Platform/SamplePkg/Sample.dsc", { platformName: "SamplePlatform" });
	await writeDec(sandbox.workspaceA, "Platform/SamplePkg/SamplePkg.dec", "SamplePkg");
	return sandbox;
}

/* ------------------------------------------------------------------ §1 纯解析 */

test("B2：DSC/DEC 解析限定在 [Defines]，注释与其它段不产生候选", () => {
	const parsed = parseDsc(
		[
			"# PLATFORM_NAME = CommentedOut",
			"[Defines]",
			"  PLATFORM_NAME = RealPlatform",
			"  PLATFORM_NAME = DuplicateIgnored",
			"  DSC_SPECIFICATION = 0x00010005",
			"",
			"!include OtherPkg/Other.dec",
			"[Components]",
			"  PLATFORM_NAME = NotADefine",
			"  SamplePkg/Sample.inf",
			"!include MdePkg/MdePkg.dec # trailing comment",
		].join("\n"),
	);
	assert.equal(parsed.platformName.value, "RealPlatform", "只认第一条，且必须来自 [Defines]");
	assert.equal(parsed.platformName.line, 3);
	assert.deepEqual(
		parsed.includes.map((entry) => entry.value),
		["OtherPkg/Other.dec", "MdePkg/MdePkg.dec"],
	);

	// 没有 [Defines] 段 ⇒ 不产生平台名（宁缺勿错）。
	assert.equal(parseDsc("[Components]\n  PLATFORM_NAME = Nope\n").platformName, null);
	// 换行/控制字符的值不当作可用值。
	assert.equal(parseDsc("[Defines]\n  PLATFORM_NAME = A\tB\n").platformName, null);
	assert.equal(parseDec("[Defines]\n  PACKAGE_NAME = MyPkg\n").packageName.value, "MyPkg");
	assert.equal(parseDec("[PcdsFixedAtBuild]\n  PACKAGE_NAME = Nope\n").packageName, null);
});

/* ------------------------------------------------------------------ §2 真实文件检测 */

test("B2：检测候选来自真实文件内容，落点与证据可独立核对；检测不写档案", async () => {
	const sandbox = await sandboxWithWorkspace();
	try {
		const bound = await bindProjectWorkspace({ root: sandbox.root, cwd: sandbox.workspaceA, authorizedRoots: [sandbox.workspaceA], workspacePath: sandbox.workspaceA, now: NOW });
		const opened = await openProjectProfile({ root: sandbox.root, cwd: sandbox.workspaceA, workspacePath: sandbox.workspaceA });
		const profilePath = join(sandbox.root, "projects", bound.projectId, "profile.json");
		const before = await fileHash(profilePath);

		const result = await detectProjectCandidates({ ...access(opened.workspacePath), workspacePath: opened.workspacePath, workspaceId: opened.workspaceId, now: NOW + 1_000 });
		assert.equal(result.wroteToProfile, false);
		assert.equal(await fileHash(profilePath), before, "检测不得写档案");

		// 平台名 → buildTargets（**不是** boardName）；包名 → keyEntryPoints。
		const platform = result.candidates.find((candidate) => candidate.rule === "edk2-dsc-platform-name");
		assert.equal(platform.field, "buildTargets");
		assert.equal(platform.value, "SamplePlatform");
		assert.equal(platform.evidence.relativePath, "Platform/SamplePkg/Sample.dsc");
		assert.equal(platform.evidence.capturedAt, NOW + 1_000, "证据带实际采集时间");
		assert.equal(platform.evidence.contentHash, await fileHash(join(sandbox.workspaceA, "Platform/SamplePkg/Sample.dsc")), "证据 hash 必须等于独立计算的文件 hash");
		assert.equal(platform.evidence.workspaceId, opened.workspaceId);
		assert.equal(
			result.candidates.some((candidate) => candidate.field === "boardName"),
			false,
			"平台名不得冒充板名",
		);
		assert.equal(result.candidates.find((candidate) => candidate.rule === "edk2-dec-package-name").value, "SamplePkg");
		assert.equal(
			result.candidates.every((candidate) => candidate.evidence.line > 0),
			true,
		);

		// 资料缺口：明确写出"没有合法规则"的身份字段，并给出所需资料。
		const boardGap = result.gaps.find((gap) => gap.field === "boardName");
		assert.ok(boardGap, "必须显式声明板名没有合法检测规则");
		assert.match(boardGap.reason, /PLATFORM_NAME/);
		for (const field of ["ibv", "chipsetVendor", "chipsetGeneration"]) {
			assert.ok(
				result.gaps.some((gap) => gap.field === field),
				`${field} 必须留在缺口里而不是被猜出来`,
			);
		}

		// 文件内容变了 ⇒ 候选跟着变（证明是读文件而不是预填）。
		await writeDsc(sandbox.workspaceA, "Platform/SamplePkg/Sample.dsc", { platformName: "RenamedPlatform" });
		const again = await detectProjectCandidates({ ...access(opened.workspacePath), workspacePath: opened.workspacePath, workspaceId: opened.workspaceId, now: NOW + 2_000 });
		assert.equal(again.candidates.find((candidate) => candidate.rule === "edk2-dsc-platform-name").value, "RenamedPlatform");
	} finally {
		await sandbox.cleanup();
	}
});

test("B2：文件数/字节/候选数预算与取消都有对照", async () => {
	const sandbox = await sandboxWithWorkspace();
	try {
		await writeDsc(sandbox.workspaceA, "Platform/SecondPkg/Second.dsc", { platformName: "SecondPlatform" });
		const opened = { ...access(sandbox.workspaceA), workspacePath: sandbox.workspaceA, workspaceId: "11111111-1111-4111-8111-111111111111" };

		// 文件数预算：截断要如实标记，并体现在资料缺口里。
		const limited = await detectProjectCandidates({ ...opened, limits: { maxDetectFiles: 1 }, now: NOW });
		assert.equal(limited.truncated, true);
		assert.ok(limited.truncatedBy.includes("files"));
		assert.ok(limited.gaps.some((gap) => /预算/.test(gap.reason)));

		// 单文件字节预算：文件被跳过并说明原因（不是"没有信号"）。
		const byteLimited = await detectProjectCandidates({ ...opened, limits: { maxDetectFileBytes: 16 }, now: NOW });
		assert.equal(byteLimited.candidates.length, 0);
		assert.ok(byteLimited.truncatedBy.includes("bytes"));
		assert.ok(byteLimited.problems.some((problem) => /预算/.test(problem)));

		// 候选数预算。
		const candidateLimited = await detectProjectCandidates({ ...opened, limits: { maxDetectionCandidates: 1 }, now: NOW });
		assert.equal(candidateLimited.candidates.length, 1);
		assert.ok(candidateLimited.truncatedBy.includes("candidates"));

		// 预算只能收紧，不能放宽；未知项与非法值都拒绝。
		await assert.rejects(detectProjectCandidates({ ...opened, limits: { maxDetectFiles: 10_000 } }), projectError("invalid-argument"));
		await assert.rejects(detectProjectCandidates({ ...opened, limits: { maxDetectFilesTypo: 1 } }), projectError("invalid-argument"));

		// 取消：开始前取消必须失败，不能返回"空候选"伪装成功。
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(detectProjectCandidates({ ...opened, signal: controller.signal }), projectError("cancelled"));

		// 工作区不存在：受控错误，不是空结果。
		await assert.rejects(detectProjectCandidates({ ...access(sandbox.base), workspacePath: join(sandbox.base, "nope"), workspaceId: opened.workspaceId }), projectError("not-found", "workspace-unavailable"));
	} finally {
		await sandbox.cleanup();
	}
});

test("B2：根外链接不产生候选；检测不读工作区外的文件", async (t) => {
	const sandbox = await sandboxWithWorkspace();
	try {
		const outside = join(sandbox.base, "outside.dsc");
		await writeFile(outside, "[Defines]\n  PLATFORM_NAME = OutsidePlatform\n");
		try {
			await symlink(outside, join(sandbox.workspaceA, "Platform", "escaped.dsc"), "file");
		} catch (error) {
			const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "unknown";
			// 只对**已知的权限形态**显式跳过；其它失败必须失败（不能把"没跑"记成"通过"）。
			if (code === "EPERM" || code === "EACCES" || code === "ENOTSUP") {
				t.skip(`本机不允许创建文件型 symlink（${code}）：该分支按已知权限限制显式跳过`);
				return;
			}
			throw error;
		}
		const result = await detectProjectCandidates({ ...access(sandbox.workspaceA), workspacePath: sandbox.workspaceA, workspaceId: "11111111-1111-4111-8111-111111111111", now: NOW });
		assert.equal(
			result.candidates.some((candidate) => candidate.value === "OutsidePlatform"),
			false,
			"根外链接不得被读取",
		);
	} finally {
		await sandbox.cleanup();
	}
});

/* ------------------------------------------------------------------ §3 消费视图 */

async function preparedProject() {
	const sandbox = await sandboxWithWorkspace();
	const bound = await bindProjectWorkspace({ root: sandbox.root, cwd: sandbox.workspaceA, authorizedRoots: [sandbox.workspaceA], workspacePath: sandbox.workspaceA, now: NOW });
	const opened = await openProjectProfile({ root: sandbox.root, cwd: sandbox.workspaceA, workspacePath: sandbox.workspaceA });
	return { sandbox, bound, opened };
}

test("B4：视图区分确认值/检测候选，检测不覆盖确认；确认值不被重建", async () => {
	const { sandbox, bound, opened } = await preparedProject();
	try {
		const dscPath = join(sandbox.workspaceA, "Platform/SamplePkg/Sample.dsc");
		const hash = await fileHash(dscPath);
		const confirmed = await confirmProfileFields({
			root: sandbox.root,
			projectId: bound.projectId,
			workspaceId: opened.workspaceId,
			expectedProfileRevision: opened.profileRevision,
			values: [
				{ field: "boardName", value: "SyntheticBoard", evidence: [{ relativePath: "Platform/SamplePkg/Sample.dsc", contentHash: hash }] },
				{ field: "buildTargets", value: "SamplePlatform" },
			],
			operatorLabel: "engineer-a",
			now: NOW + 1_000,
		});
		assert.equal(confirmed.status, "confirmed");

		const view = await readProjectView({ root: sandbox.root, cwd: sandbox.workspaceA, workspacePath: sandbox.workspaceA, detect: true, verifyEvidence: true, now: NOW + 2_000 });
		assert.equal(view.status, "ok");
		assert.ok(view.decision !== null);
		// 取值必须**同时**看记录族与事实键：人工确认值与检测候选故意共用同一个业务事实键。
		const items = new Map(view.decision.items.map((item) => [`${item.family}|${item.factKey}`, item]));

		// 人工确认的板名是当前事实，且带事实键（供调用方对应回字段）。
		assert.equal(items.get("project-profile|project-profile.boardName").class, "current");
		// 检测到的平台名与确认的构建目标一致 ⇒ 不制造假冲突；但它本身只是候选。
		const detected = items.get("detected-candidate|project-profile.buildTargets");
		assert.equal(detected.class, "needs-review");
		assert.ok(detected.reasons.includes("field-unconfirmed"));
		// 证据复验：文件没变 ⇒ 没有漂移。
		assert.equal(
			view.evidenceChecks.every((check) => check.status === "valid" || check.status === "not-verifiable"),
			true,
		);

		// 检测到**不同**的平台名：确认值仍是 current，检测候选变成待确认差异。
		await writeDsc(sandbox.workspaceA, "Platform/SamplePkg/Sample.dsc", { platformName: "RenamedPlatform" });
		const changed = await readProjectView({ root: sandbox.root, cwd: sandbox.workspaceA, workspacePath: sandbox.workspaceA, detect: true, verifyEvidence: true, now: NOW + 3_000 });
		assert.ok(changed.decision !== null);
		const changedItems = new Map(changed.decision.items.map((item) => [`${item.family}|${item.factKey}`, item]));
		const changedTarget = changedItems.get("project-profile|project-profile.buildTargets");
		assert.equal(changedTarget.class, "needs-review");
		assert.ok(changedTarget.reasons.includes("needs-confirmation"), "确认值与新候选的差异必须交人工");
		const changedBoard = changedItems.get("project-profile|project-profile.boardName");
		assert.equal(changedBoard.class, "needs-review", "证据变了要提示复核");
		assert.ok(changedBoard.reasons.includes("verification-drift"));

		// 档案里的确认值没有被检测结果改写。
		const stored = await readProfileFile(sandbox.root, bound.projectId);
		assert.equal(stored.identity.boardName.value, "SyntheticBoard");
		assert.equal(stored.identity.boardName.status, "confirmed");
		assert.equal(stored.buildTargets.length, 1, "检测结果不得写进档案");
	} finally {
		await sandbox.cleanup();
	}
});

test("B4：Git HEAD 变化会让结论退回待复核，但不动人工确认值", { skip: gitAvailable() ? false : "本机没有可用的 git 可执行文件（环境限制，显式跳过）" }, async () => {
	const sandbox = await sandboxWithWorkspace();
	try {
		const bound = await bindProjectWorkspace({ root: sandbox.root, cwd: sandbox.workspaceA, authorizedRoots: [sandbox.workspaceA], workspacePath: sandbox.workspaceA, now: NOW });
		const initial = await initGitRepo(sandbox.workspaceA);
		// 采集一次快照 → 档案里记下当时的 HEAD。
		const opened = await openProjectProfile({ root: sandbox.root, cwd: sandbox.workspaceA, workspacePath: sandbox.workspaceA });
		await refreshWorkspaceSnapshot({ ...access(sandbox.workspaceA), root: sandbox.root, projectId: bound.projectId, workspaceId: opened.workspaceId, expectedProfileRevision: opened.profileRevision, now: NOW + 1 });
		const afterSnapshot = await openProjectProfile({ root: sandbox.root, cwd: sandbox.workspaceA, workspacePath: sandbox.workspaceA });
		await confirmProfileFields({ root: sandbox.root, projectId: bound.projectId, workspaceId: opened.workspaceId, expectedProfileRevision: afterSnapshot.profileRevision, values: [{ field: "boardName", value: "SyntheticBoard" }], operatorLabel: "engineer-a", now: NOW + 2 });

		const same = await readProjectView({ root: sandbox.root, cwd: sandbox.workspaceA, workspacePath: sandbox.workspaceA, probeVcs: true, now: NOW + 3 });
		assert.equal(same.headChanged, false);
		assert.equal(same.workspaceVcs.head, initial.head);
		assert.equal(same.decision.items.find((item) => item.factKey === "project-profile.boardName").class, "current", "HEAD 未变时不应报漂移");

		// 换一次提交（HEAD 变化）⇒ 依赖该检出的结论变成待复核。
		await writeDsc(sandbox.workspaceA, "Platform/SamplePkg/Extra.dsc", { platformName: "ExtraPlatform" });
		git(sandbox.workspaceA, ["add", "-A"]);
		git(sandbox.workspaceA, ["commit", "-q", "-m", "move head"]);
		const movedHead = git(sandbox.workspaceA, ["rev-parse", "HEAD"]).trim();
		assert.notEqual(movedHead, initial.head);

		const drifted = await readProjectView({ root: sandbox.root, cwd: sandbox.workspaceA, workspacePath: sandbox.workspaceA, probeVcs: true, now: NOW + 4 });
		assert.equal(drifted.headChanged, true);
		assert.equal(drifted.workspaceVcs.head, movedHead);
		const driftedItem = drifted.decision.items.find((item) => item.factKey === "project-profile.boardName");
		assert.equal(driftedItem.class, "needs-review");
		assert.ok(driftedItem.reasons.includes("verification-drift"));

		// 人工确认值仍在档案里（漂移不等于改写）。
		const stored = await readProfileFile(sandbox.root, bound.projectId);
		assert.equal(stored.identity.boardName.value, "SyntheticBoard");
		assert.equal(stored.identity.boardName.status, "confirmed");

		// 刷新快照后再读：漂移消失（显式动作，不是自动修复）。
		const current = await openProjectProfile({ root: sandbox.root, cwd: sandbox.workspaceA, workspacePath: sandbox.workspaceA });
		const refreshed = await refreshWorkspaceSnapshot({ ...access(sandbox.workspaceA), root: sandbox.root, projectId: bound.projectId, workspaceId: opened.workspaceId, expectedProfileRevision: current.profileRevision, now: NOW + 5 });
		assert.equal(refreshed.status, "refreshed");
		const afterRefresh = await readProjectView({ root: sandbox.root, cwd: sandbox.workspaceA, workspacePath: sandbox.workspaceA, probeVcs: true, now: NOW + 6 });
		assert.equal(afterRefresh.headChanged, false);
		assert.equal(afterRefresh.decision.items.find((item) => item.factKey === "project-profile.boardName").class, "current");
	} finally {
		await sandbox.cleanup();
	}
});

test("B4：视图在知识库/档案不可用时如实报不可用，不假装有结论", async () => {
	const sandbox = await createProjectSandbox();
	try {
		const missing = await readProjectView({ root: sandbox.root, cwd: sandbox.workspaceA, workspacePath: sandbox.workspaceA, checkWorkspace: false });
		assert.equal(missing.status, "not-usable");
		assert.equal(missing.decision, null);
		assert.equal(missing.open.status, "missing");

		await initializeKnowledgeStore({ root: sandbox.root, now: NOW });
		const noBinding = await readProjectView({ root: sandbox.root, cwd: sandbox.workspaceA, workspacePath: sandbox.workspaceA, checkWorkspace: false });
		assert.equal(noBinding.status, "not-usable");
		assert.equal(noBinding.decision, null);
		assert.equal(noBinding.problems.length > 0, true);
	} finally {
		await sandbox.cleanup();
	}
});

test("B4：视图顺序稳定（排列不变）且受输出预算约束", async () => {
	const { sandbox, bound, opened } = await preparedProject();
	try {
		await confirmProfileFields({
			root: sandbox.root,
			projectId: bound.projectId,
			workspaceId: opened.workspaceId,
			expectedProfileRevision: opened.profileRevision,
			values: [
				{ field: "boardName", value: "BoardQ" },
				{ field: "chipsetFamily", value: "FamilyQ" },
				{ field: "architecture", value: "X64" },
			],
			now: NOW + 1,
		});
		const first = await readProjectView({ root: sandbox.root, cwd: sandbox.workspaceA, workspacePath: sandbox.workspaceA, now: NOW + 2 });
		const second = await readProjectView({ root: sandbox.root, cwd: sandbox.workspaceA, workspacePath: sandbox.workspaceA, now: NOW + 2 });
		assert.equal(JSON.stringify(first.decision.items), JSON.stringify(second.decision.items), "相同输入必须得到逐字节相同的结果");
		assert.deepEqual(
			first.decision.items.map((item) => item.factKey),
			[...first.decision.items.map((item) => item.factKey)].sort(),
			"同分类内的事实键必须有确定顺序",
		);
		assert.equal(first.decision.items.length, 3);

		const tiny = await readProjectView({ root: sandbox.root, cwd: sandbox.workspaceA, workspacePath: sandbox.workspaceA, now: NOW + 2, maxOutputBytes: 8 });
		assert.deepEqual(tiny.decision.items, []);
		assert.equal(tiny.decision.dropped, 3);
		assert.equal(tiny.status, "incomplete", "预算不足必须如实报告不完整");
	} finally {
		await sandbox.cleanup();
	}
});

test("B4：证据条数预算与未复验计数如实上报", async () => {
	const { sandbox, bound, opened } = await preparedProject();
	try {
		const hash = await fileHash(join(sandbox.workspaceA, "Platform/SamplePkg/Sample.dsc"));
		await confirmProfileFields({
			root: sandbox.root,
			projectId: bound.projectId,
			workspaceId: opened.workspaceId,
			expectedProfileRevision: opened.profileRevision,
			values: [
				{ field: "boardName", value: "BoardZ", evidence: [{ relativePath: "Platform/SamplePkg/Sample.dsc", contentHash: hash }] },
				{ field: "architecture", value: "X64", evidence: [{ relativePath: "Platform/SamplePkg/SamplePkg.dec", contentHash: hash }] },
			],
			now: NOW + 1,
		});
		const capped = await readProjectView({ root: sandbox.root, cwd: sandbox.workspaceA, workspacePath: sandbox.workspaceA, verifyEvidence: true, limits: { maxEvidenceFiles: 1, maxEvidenceEntries: 1 }, now: NOW + 2 });
		assert.equal(capped.evidenceUnchecked > 0, true);
		assert.ok(capped.problems.some((problem) => /未复验/.test(problem)));
		assert.equal(capped.status, "incomplete", "证据没复验完 ⇒ 视图不能报 ok");
		assert.ok(capped.evidenceUnverifiedFacts.length > 0, "未复验的事实必须显式列出");

		// **条目上限**独立于文件上限：不可复验的声明（human-note）也要有界。
		const notes = Array.from({ length: 20 }, (_, index) => ({ key: `note-${index}`, evidence: { type: "human-note", capturedAt: NOW, validity: "active" } }));
		const noteResult = await verifyEvidenceRefs({ ...access(sandbox.workspaceA), workspacePath: sandbox.workspaceA, entries: notes, limits: { maxEvidenceFiles: 1 } });
		assert.equal(noteResult.checks.length <= 4, true, `条目上限必须跟着文件预算收紧（实际 ${noteResult.checks.length}）`);
		assert.equal(noteResult.uncheckedCount, 20 - noteResult.checks.length);
		assert.equal(noteResult.truncated, true);
		assert.ok(noteResult.uncheckedReasons.includes("entry-budget"));

		// 越界与绝对路径证据在复验阶段被拒绝（不是当作有效）。
		const rejected = await verifyEvidenceRefs({
			...access(sandbox.workspaceA),
			workspacePath: sandbox.workspaceA,
			entries: [
				{ key: "f1", evidence: { type: "source-file", relativePath: "/etc/passwd", contentHash: hash, capturedAt: NOW, validity: "active" } },
				{ key: "f2", evidence: { type: "source-file", relativePath: "Platform/../Platform/SamplePkg/Sample.dsc", contentHash: hash, capturedAt: NOW, validity: "active" } },
			],
		});
		assert.deepEqual(
			rejected.checks.map((check) => check.status),
			["not-verifiable", "not-verifiable"],
		);
		assert.deepEqual(
			rejected.checks.map((check) => check.key),
			["f1", "f2"],
			"复验结果必须带回调用方的事实键（字段之间不能串用）",
		);
	} finally {
		await sandbox.cleanup();
	}
});
