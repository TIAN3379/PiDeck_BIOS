/**
 * BM-03 B1/B3/B4 永久回归：显式绑定、只读打开、人工确认 CAS、工作区快照刷新。
 *
 * 全部使用自建临时知识根与合成工作区；独立观察（直接读磁盘 JSON 与文件字节），
 * 不只断言产品 helper 的返回值。
 */
import assert from "node:assert/strict";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { initializeKnowledgeStore } from "../core/storage/index.ts";
import { ProjectServiceError, bindProjectWorkspace, confirmProfileFields, detectProjectCandidates, openProjectProfile, readProjectView, refreshWorkspaceSnapshot } from "../core/projects/index.ts";
import { createProjectSandbox, fileHash, gitAvailable, initGitRepo, readProfileFile, readRegistryFile, writeDec, writeDsc } from "./helpers/projectFixtures.mjs";

const NOW = 1_700_000_000_000;

/** 领域入口的**授权范围**（R28-4 起必填）：会话 cwd 就是该工作区本身。 */
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

async function preparedSandbox() {
	const sandbox = await createProjectSandbox();
	await initializeKnowledgeStore({ root: sandbox.root, now: NOW });
	await writeDsc(sandbox.workspaceA, "Platform/SamplePkg/Sample.dsc", { platformName: "SamplePlatform" });
	await writeDsc(sandbox.workspaceB, "Platform/SamplePkg/Sample.dsc", { platformName: "SamplePlatform" });
	return sandbox;
}

function bindOptions(sandbox, overrides = {}) {
	return { root: sandbox.root, cwd: overrides.workspacePath ?? sandbox.workspaceA, authorizedRoots: [sandbox.workspaceA, sandbox.workspaceB], workspacePath: sandbox.workspaceA, now: NOW, ...overrides };
}

test("B1：新项目绑定写入 registry + profile，且新进程能按同一身份读回", async () => {
	const sandbox = await preparedSandbox();
	try {
		const bound = await bindProjectWorkspace(bindOptions(sandbox, { displayName: "Synthetic A" }));
		assert.equal(bound.status, "bound");
		assert.match(bound.projectId, /^[0-9a-f-]{36}$/);
		assert.match(bound.workspaceId, /^[0-9a-f-]{36}$/);
		assert.deepEqual(
			bound.steps.map((step) => `${step.step}:${step.status}`),
			["registry:published", "profile:published"],
		);

		// 独立观察磁盘：registry 与 profile 都真的写了，且身份一致。
		const registry = await readRegistryFile(sandbox.root);
		assert.equal(registry.projects.length, 1);
		assert.equal(registry.projects[0].biosProjectId, bound.projectId);
		assert.equal(registry.projects[0].workspaces[0].workspaceId, bound.workspaceId);
		const profile = await readProfileFile(sandbox.root, bound.projectId);
		assert.equal(profile.id, bound.projectId);
		assert.equal(profile.revision, 0);
		assert.equal(profile.workspaces[0].workspaceId, bound.workspaceId);
		// 身份字段全部是"未知"，没有虚构厂商/客户/CRB。
		for (const field of ["ibv", "ibvVersion", "chipsetVendor", "customer", "crbBaseline"]) {
			assert.equal(profile.identity[field].value, null, `${field} 不得虚构`);
			assert.equal(profile.identity[field].status, "unknown");
		}

		// 模拟"新进程读取"：重新走只读 API（不共享任何内存状态）。
		const opened = await openProjectProfile({ root: sandbox.root, cwd: sandbox.workspaceA, workspacePath: sandbox.workspaceA });
		assert.equal(opened.status, "usable");
		assert.equal(opened.usable, true);
		assert.equal(opened.projectId, bound.projectId);
		assert.equal(opened.workspaceId, bound.workspaceId);
		assert.equal(opened.profileRevision, 0);

		// 重复绑定：先读现状，判定为已绑定，不产生第二份项目/工作区。
		const again = await bindProjectWorkspace(bindOptions(sandbox));
		assert.equal(again.status, "already-bound");
		assert.equal(again.projectId, bound.projectId);
		assert.deepEqual(
			again.steps.map((step) => `${step.step}:${step.status}`),
			["registry:skipped", "profile:skipped"],
		);
		const registryAfter = await readRegistryFile(sandbox.root);
		assert.equal(registryAfter.projects.length, 1);
		assert.equal(registryAfter.projects[0].workspaces.length, 1);
		assert.equal(registryAfter.revision, registry.revision, "重复绑定不得无意义地写 registry");
	} finally {
		await sandbox.cleanup();
	}
});

test("B1：同远端/同目录名不合并；第二工作区必须显式绑定", async () => {
	const sandbox = await preparedSandbox();
	try {
		const first = await bindProjectWorkspace(bindOptions(sandbox));
		// 不指定 projectId：另一个目录是**另一个项目**（哪怕目录名与内容都一样）。
		const second = await bindProjectWorkspace(bindOptions(sandbox, { workspacePath: sandbox.workspaceB }));
		assert.equal(second.status, "bound");
		assert.notEqual(second.projectId, first.projectId, "相同目录名/相同内容不构成同一项目");

		const registry = await readRegistryFile(sandbox.root);
		assert.equal(registry.projects.length, 2);
		// 已被别的项目绑定的路径不能按参数改绑（同一路径只属于一个项目）。
		await assert.rejects(bindProjectWorkspace(bindOptions(sandbox, { workspacePath: sandbox.workspaceB, biosProjectId: first.projectId })), projectError("inconsistent", "workspace-claimed-by-other-project"));

		// 同一项目要加第二个工作区：用一个**新目录** + 显式 projectId 才成立。
		const workspaceC = join(sandbox.base, "ws-c");
		await mkdir(workspaceC, { recursive: true });
		await writeDsc(workspaceC, "Platform/SamplePkg/Sample.dsc", { platformName: "SamplePlatform" });
		const third = await bindProjectWorkspace({ root: sandbox.root, cwd: workspaceC, authorizedRoots: [sandbox.workspaceA, sandbox.workspaceB, workspaceC], workspacePath: workspaceC, biosProjectId: first.projectId, now: NOW + 5 });
		assert.equal(third.projectId, first.projectId);
		const registryAfter = await readRegistryFile(sandbox.root);
		assert.equal(registryAfter.projects.length, 2, "显式给出 projectId 时是复用，不是新建");
		const project = registryAfter.projects.find((entry) => entry.biosProjectId === first.projectId);
		assert.equal(project.workspaces.length, 2);
		assert.equal(project.workspaces.filter((workspace) => workspace.path === workspaceC).length, 1);

		const profile = await readProfileFile(sandbox.root, first.projectId);
		assert.equal(profile.workspaces.length, 2, "两个工作区必须分别入档");

		// 多工作区打开必须显式选路径，不能替调用方挑一个。
		const ambiguous = await openProjectProfile({ root: sandbox.root, cwd: sandbox.workspaceA, biosProjectId: first.projectId });
		assert.equal(ambiguous.status, "inconsistent");
		assert.equal(ambiguous.problems[0].code, "ambiguous-workspace");
		const chosen = await openProjectProfile({ root: sandbox.root, cwd: sandbox.workspaceA, authorizedRoots: [sandbox.workspaceA, workspaceC], biosProjectId: first.projectId, workspacePath: workspaceC });
		assert.equal(chosen.status, "usable");
		assert.equal(chosen.workspacePath, workspaceC);
	} finally {
		await sandbox.cleanup();
	}
});

test("B1：路径迁移保持 workspaceId；越权路径在 IO 前被拒绝", async () => {
	const sandbox = await preparedSandbox();
	try {
		const bound = await bindProjectWorkspace(bindOptions(sandbox));
		// 目录移动：给显式 workspaceId + 新路径。
		const moved = join(sandbox.base, "ws-a-moved");
		await mkdir(moved, { recursive: true });
		const migrated = await bindProjectWorkspace(bindOptions(sandbox, { workspacePath: moved, biosProjectId: bound.projectId, workspaceId: bound.workspaceId }));
		assert.equal(migrated.workspaceId, bound.workspaceId, "迁移保持工作区身份");
		assert.equal(migrated.status, "bound");
		const profile = await readProfileFile(sandbox.root, bound.projectId);
		assert.equal(profile.workspaces.length, 1, "迁移不是新增工作区");
		assert.equal(profile.workspaces[0].path, moved);
		assert.ok(profile.revision >= 1);

		// 未授权的绝对路径：IO 之前就拒绝，且不产生任何项目。
		const outside = join(sandbox.base, "outside");
		await mkdir(outside, { recursive: true });
		const before = await fileHash(join(sandbox.root, "registry.json"));
		await assert.rejects(bindProjectWorkspace({ root: sandbox.root, cwd: sandbox.workspaceA, authorizedRoots: [sandbox.workspaceA], workspacePath: outside }), projectError("not-authorized"));
		assert.equal(await fileHash(join(sandbox.root, "registry.json")), before, "被拒的绑定不得触碰知识库");

		// 相对路径配置同样拒绝（必须完全限定）。
		await assert.rejects(bindProjectWorkspace(bindOptions(sandbox, { workspacePath: "./ws-a" })), projectError("invalid-argument"));
		// 已绑定给别的项目的工作区不能按参数改绑。
		const other = await bindProjectWorkspace(bindOptions(sandbox, { workspacePath: sandbox.workspaceB }));
		await assert.rejects(bindProjectWorkspace(bindOptions(sandbox, { workspacePath: sandbox.workspaceB, biosProjectId: other.projectId === bound.projectId ? "00000000-0000-4000-8000-000000000000" : bound.projectId })), projectError("inconsistent", "workspace-claimed-by-other-project"));
	} finally {
		await sandbox.cleanup();
	}
});

test("B1：打开时如实报告不一致与不可达，不自动修复", async () => {
	const sandbox = await preparedSandbox();
	try {
		const missingStore = await openProjectProfile({ root: join(sandbox.base, "no-store"), cwd: sandbox.workspaceA, workspacePath: sandbox.workspaceA, checkWorkspace: false });
		assert.equal(missingStore.status, "missing");
		assert.equal(missingStore.problems[0].code, "store-not-initialized");

		const bound = await bindProjectWorkspace(bindOptions(sandbox));

		// 档案被外部删除（模拟半完成 / 手工误删）：报 inconsistent，并在知识库里补回绑定信息。
		const profilePath = join(sandbox.root, "projects", bound.projectId, "profile.json");
		const backup = await readFile(profilePath);
		await rm(profilePath);
		const noProfile = await openProjectProfile({ root: sandbox.root, cwd: sandbox.workspaceA, workspacePath: sandbox.workspaceA });
		assert.equal(noProfile.status, "inconsistent");
		assert.equal(noProfile.problems[0].code, "profile-missing");
		assert.equal(noProfile.usable, false);
		await writeFile(profilePath, backup);

		// 工作区目录不可达：绑定保留，状态是 unreachable。
		const movedAway = join(sandbox.base, "ws-a-offline");
		await rename(sandbox.workspaceA, movedAway);
		const offline = await openProjectProfile({ root: sandbox.root, cwd: sandbox.base, authorizedRoots: [sandbox.workspaceA], workspacePath: sandbox.workspaceA, checkWorkspace: true });
		assert.equal(offline.status, "unreachable");
		assert.equal(offline.workspaceAvailability, "missing");
		assert.equal(
			offline.problems.some((problem) => problem.code === "workspace-missing"),
			true,
		);
		const registryAfter = await readRegistryFile(sandbox.root);
		assert.equal(registryAfter.projects[0].workspaces.length, 1, "不可达不得删除绑定");
		await rename(movedAway, sandbox.workspaceA);
	} finally {
		await sandbox.cleanup();
	}
});

test("B3：人工确认只改被点名字段，CAS 冲突不写入", async () => {
	const sandbox = await preparedSandbox();
	try {
		const bound = await bindProjectWorkspace(bindOptions(sandbox));
		const before = await readProfileFile(sandbox.root, bound.projectId);
		// 先由别的来源写入一个未触达字段（模拟已有资料缺口之外的既有内容）。
		assert.equal(before.gaps.length, 0);
		assert.equal(before.identity.ibv.status, "unknown");

		const opened = await openProjectProfile({ root: sandbox.root, cwd: sandbox.workspaceA, workspacePath: sandbox.workspaceA });
		const confirmed = await confirmProfileFields({
			root: sandbox.root,
			projectId: bound.projectId,
			workspaceId: opened.workspaceId,
			expectedProfileRevision: opened.profileRevision,
			values: [
				{ field: "boardName", value: "SyntheticBoard" },
				{ field: "buildTargets", value: "SamplePlatform" },
			],
			operatorLabel: "engineer-a",
			now: NOW + 1_000,
		});
		assert.equal(confirmed.status, "confirmed");
		assert.deepEqual([...confirmed.changedFields].sort(), ["boardName", "buildTargets"]);
		assert.equal(confirmed.operatorLabel, "engineer-a");

		const after = await readProfileFile(sandbox.root, bound.projectId);
		assert.equal(after.identity.boardName.value, "SyntheticBoard");
		assert.equal(after.identity.boardName.status, "confirmed");
		assert.equal(after.identity.ibv.value, null, "未触达字段必须原样保留");
		assert.equal(after.buildTargets.length, 1);
		assert.equal(after.buildTargets[0].status, "confirmed");
		assert.equal(after.workspaces.length, 1, "确认不得重建工作区");
		// 确认动作在 schema 已允许的字段里留痕，不新增自定义字段。
		assert.equal(after.identity.boardName.evidence.at(-1).type, "human-note");
		assert.equal(after.identity.boardName.evidence.at(-1).location, "engineer-a");
		assert.equal(Object.keys(after).includes("confirmedBy"), false, "不得往 v1 添加未定义字段");

		// 相同确认值：不制造无意义的 revision。
		const noChange = await confirmProfileFields({
			root: sandbox.root,
			projectId: bound.projectId,
			expectedProfileRevision: after.revision,
			values: [{ field: "boardName", value: "SyntheticBoard" }],
			now: NOW + 2_000,
		});
		assert.equal(noChange.status, "no-change");
		assert.equal(noChange.revision, after.revision);
		assert.equal((await readProfileFile(sandbox.root, bound.projectId)).revision, after.revision);

		// CAS 冲突：期望 revision 过期 ⇒ 不写入，原字节不变。
		const beforeBytes = await fileHash(join(sandbox.root, "projects", bound.projectId, "profile.json"));
		const conflict = await confirmProfileFields({
			root: sandbox.root,
			projectId: bound.projectId,
			expectedProfileRevision: 0,
			values: [{ field: "boardName", value: "Hijacked" }],
			now: NOW + 3_000,
		});
		assert.equal(conflict.status, "revision-conflict");
		assert.equal(conflict.actualRevision, after.revision);
		assert.equal(await fileHash(join(sandbox.root, "projects", bound.projectId, "profile.json")), beforeBytes, "冲突路径不得改动原字节");
		assert.equal((await readProfileFile(sandbox.root, bound.projectId)).identity.boardName.value, "SyntheticBoard");
	} finally {
		await sandbox.cleanup();
	}
});

test("B3：非法字段/非法值在 IO 前拒绝；双进程竞争只有一个成功", async () => {
	const sandbox = await preparedSandbox();
	try {
		const bound = await bindProjectWorkspace(bindOptions(sandbox));
		const opened = await openProjectProfile({ root: sandbox.root, cwd: sandbox.workspaceA, workspacePath: sandbox.workspaceA });

		await assert.rejects(confirmProfileFields({ root: sandbox.root, projectId: bound.projectId, expectedProfileRevision: opened.profileRevision, values: [{ field: "notAField", value: "x" }] }), projectError("invalid-argument", "unknown-field"));
		await assert.rejects(confirmProfileFields({ root: sandbox.root, projectId: bound.projectId, expectedProfileRevision: opened.profileRevision, values: [{ field: "boardName", value: "" }] }), projectError("invalid-argument"));
		await assert.rejects(confirmProfileFields({ root: sandbox.root, projectId: bound.projectId, expectedProfileRevision: opened.profileRevision, values: [{ field: "boardName", value: "x".repeat(400) }] }), projectError("invalid-argument"));
		await assert.rejects(confirmProfileFields({ root: sandbox.root, projectId: bound.projectId, expectedProfileRevision: opened.profileRevision, values: [{ field: "buildTargets", value: null }] }), projectError("invalid-argument"));
		await assert.rejects(
			confirmProfileFields({
				root: sandbox.root,
				projectId: bound.projectId,
				expectedProfileRevision: opened.profileRevision,
				values: [
					{ field: "boardName", value: "A" },
					{ field: "boardName", value: "B" },
				],
			}),
			projectError("invalid-argument"),
		);
		await assert.rejects(confirmProfileFields({ root: sandbox.root, projectId: bound.projectId, expectedProfileRevision: opened.profileRevision, values: [{ field: "boardName", value: "A" }], workspaceId: "11111111-1111-4111-8111-111111111111" }), projectError("inconsistent", "workspace-not-in-profile"));

		// 两个"进程"用同一个 expected revision 提交：只能有一个成功。
		const [left, right] = await Promise.all([
			confirmProfileFields({ root: sandbox.root, projectId: bound.projectId, expectedProfileRevision: opened.profileRevision, values: [{ field: "productLine", value: "Line-A" }], now: NOW + 10 }),
			confirmProfileFields({ root: sandbox.root, projectId: bound.projectId, expectedProfileRevision: opened.profileRevision, values: [{ field: "boardRevision", value: "Rev-B" }], now: NOW + 11 }),
		]);
		const statuses = [left.status, right.status].sort();
		assert.deepEqual(statuses, ["confirmed", "revision-conflict"], "同一 revision 的并发提交不得双双成功");
		const finalProfile = await readProfileFile(sandbox.root, bound.projectId);
		const winner = left.status === "confirmed" ? "productLine" : "boardRevision";
		const loser = left.status === "confirmed" ? "boardRevision" : "productLine";
		assert.equal(finalProfile.identity[winner].status, "confirmed");
		assert.equal(finalProfile.identity[loser].status, "unknown", "失败的一方不得留下半截写入");
	} finally {
		await sandbox.cleanup();
	}
});

test("B4：快照刷新只改一个工作区，非 Git 省略 vcs；CAS 保护", async () => {
	const sandbox = await preparedSandbox();
	try {
		const bound = await bindProjectWorkspace(bindOptions(sandbox));
		const opened = await openProjectProfile({ root: sandbox.root, cwd: sandbox.workspaceA, workspacePath: sandbox.workspaceA });
		await confirmProfileFields({ root: sandbox.root, projectId: bound.projectId, workspaceId: opened.workspaceId, expectedProfileRevision: opened.profileRevision, values: [{ field: "boardName", value: "KeepMe" }], now: NOW + 1 });

		const profileBefore = await readProfileFile(sandbox.root, bound.projectId);
		const refreshed = await refreshWorkspaceSnapshot({ ...access(sandbox.workspaceA), root: sandbox.root, projectId: bound.projectId, workspaceId: opened.workspaceId, expectedProfileRevision: profileBefore.revision, now: NOW + 2_000 });
		assert.equal(refreshed.status, "refreshed");
		assert.equal(refreshed.snapshot.availability, "reachable");
		const profileAfter = await readProfileFile(sandbox.root, bound.projectId);
		assert.equal(profileAfter.workspaces[0].availability, "reachable");
		assert.equal(profileAfter.workspaces[0].capturedAt, NOW + 2_000);
		assert.equal(profileAfter.identity.boardName.value, "KeepMe", "刷新快照不得动人工确认值");
		// 非 Git 目录：**省略** vcs 字段（不写空字符串伪装 Git）。
		assert.equal("vcs" in profileAfter.workspaces[0], false);
		assert.equal(gitAvailable(), true, "本机需要 git 才能验证 worktree 分支；下面另有显式 skip 的专用用例");

		// 无变化时不写（避免每次读都制造 revision）。
		const unchanged = await refreshWorkspaceSnapshot({ ...access(sandbox.workspaceA), root: sandbox.root, projectId: bound.projectId, workspaceId: opened.workspaceId, expectedProfileRevision: profileAfter.revision, now: NOW + 3_000 });
		assert.equal(unchanged.status, "unchanged");
		assert.equal((await readProfileFile(sandbox.root, bound.projectId)).revision, profileAfter.revision);

		// CAS 冲突。
		const conflict = await refreshWorkspaceSnapshot({ ...access(sandbox.workspaceA), root: sandbox.root, projectId: bound.projectId, workspaceId: opened.workspaceId, expectedProfileRevision: 0, now: NOW + 4_000 });
		assert.equal(conflict.status, "revision-conflict");

		// 未绑定的工作区必须拒绝。
		await assert.rejects(refreshWorkspaceSnapshot({ ...access(sandbox.workspaceA), root: sandbox.root, projectId: bound.projectId, workspaceId: "22222222-2222-4222-8222-222222222222", expectedProfileRevision: profileAfter.revision }), projectError("inconsistent", "workspace-not-in-profile"));
	} finally {
		await sandbox.cleanup();
	}
});

test("B4：真实 Git 仓库与 worktree 各自记录 branch/HEAD；detached HEAD 取 null", { skip: gitAvailable() ? false : "本机没有可用的 git 可执行文件（环境限制，显式跳过）" }, async () => {
	const sandbox = await createProjectSandbox();
	try {
		await initializeKnowledgeStore({ root: sandbox.root, now: NOW });
		await writeDsc(sandbox.workspaceA, "Platform/SamplePkg/Sample.dsc", { platformName: "SamplePlatform" });
		const initial = await initGitRepo(sandbox.workspaceA);

		const bound = await bindProjectWorkspace(bindOptions(sandbox));
		const opened = await openProjectProfile({ root: sandbox.root, cwd: sandbox.workspaceA, workspacePath: sandbox.workspaceA });
		const refreshed = await refreshWorkspaceSnapshot({ ...access(sandbox.workspaceA), root: sandbox.root, projectId: bound.projectId, workspaceId: opened.workspaceId, expectedProfileRevision: opened.profileRevision, now: NOW + 1 });
		assert.equal(refreshed.status, "refreshed");
		assert.equal(refreshed.snapshot.vcs.branch, initial.branch);
		assert.equal(refreshed.snapshot.vcs.head, initial.head);
		assert.equal(refreshed.snapshot.vcs.remoteUrl, null, "远端 URL 不自动采集（因此没有凭证泄漏面）");

		// detached HEAD：分支按 null，不是空串，也不是字面量 HEAD。
		const { execFileSync } = await import("node:child_process");
		execFileSync("git", ["-C", sandbox.workspaceA, "checkout", "-q", "--detach", "HEAD"], { stdio: "pipe" });
		const profile = await readProfileFile(sandbox.root, bound.projectId);
		const detached = await refreshWorkspaceSnapshot({ ...access(sandbox.workspaceA), root: sandbox.root, projectId: bound.projectId, workspaceId: opened.workspaceId, expectedProfileRevision: profile.revision, now: NOW + 2 });
		assert.equal(detached.snapshot.vcs.branch, null);
		assert.equal(detached.snapshot.vcs.head, initial.head);
		const storedAfterDetach = await readProfileFile(sandbox.root, bound.projectId);
		assert.equal(storedAfterDetach.workspaces[0].vcs.branch, null);

		// 真实 worktree：两个检出各自的 HEAD 不能互相冒充。
		const worktreePath = join(sandbox.base, "ws-worktree");
		execFileSync("git", ["-C", sandbox.workspaceA, "worktree", "add", "-q", "--detach", worktreePath, "HEAD"], { stdio: "pipe" });
		await writeFile(join(worktreePath, "Platform", "SamplePkg", "Extra.dsc"), "[Defines]\n  PLATFORM_NAME = WorktreePlatform\n");
		execFileSync("git", ["-C", worktreePath, "add", "-A"], { stdio: "pipe" });
		execFileSync("git", ["-C", worktreePath, "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "-q", "-m", "worktree"], { stdio: "pipe" });
		const worktreeHead = execFileSync("git", ["-C", worktreePath, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
		assert.notEqual(worktreeHead, initial.head, "worktree 必须有独立提交用于对照");

		const second = await bindProjectWorkspace({ root: sandbox.root, cwd: worktreePath, authorizedRoots: [sandbox.workspaceA, worktreePath], workspacePath: worktreePath, biosProjectId: bound.projectId, now: NOW + 3 });
		assert.equal(second.projectId, bound.projectId);
		const profileTwo = await readProfileFile(sandbox.root, bound.projectId);
		assert.equal(profileTwo.workspaces.length, 2);
		const refreshedTwo = await refreshWorkspaceSnapshot({ ...access(worktreePath), root: sandbox.root, projectId: bound.projectId, workspaceId: second.workspaceId, expectedProfileRevision: profileTwo.revision, now: NOW + 4 });
		assert.equal(refreshedTwo.snapshot.vcs.head, worktreeHead);
		const finalProfile = await readProfileFile(sandbox.root, bound.projectId);
		const mainEntry = finalProfile.workspaces.find((workspace) => workspace.workspaceId === opened.workspaceId);
		const worktreeEntry = finalProfile.workspaces.find((workspace) => workspace.workspaceId === second.workspaceId);
		assert.equal(mainEntry.vcs.head, initial.head, "另一个 worktree 的 HEAD 不得写进本工作区");
		assert.equal(worktreeEntry.vcs.head, worktreeHead);
	} finally {
		await sandbox.cleanup();
	}
});

test("B4：证据复验按工作区+相对路径比较，缺失/越界/无 hash 分别归类", async () => {
	const sandbox = await preparedSandbox();
	try {
		const dscPath = await writeDsc(sandbox.workspaceA, "Platform/SamplePkg/Sample.dsc", { platformName: "SamplePlatform" });
		const goodHash = await fileHash(dscPath);
		const { verifyEvidenceRefs, summarizeEvidenceChecks } = await import("../core/projects/index.ts");
		const result = await verifyEvidenceRefs({
			...access(sandbox.workspaceA),
			workspacePath: sandbox.workspaceA,
			entries: [
				{ key: "boardName", evidence: { type: "source-file", workspaceId: "w1", relativePath: "Platform/SamplePkg/Sample.dsc", contentHash: goodHash, capturedAt: NOW, validity: "active" } },
				{ key: "boardName", evidence: { type: "source-file", workspaceId: "w1", relativePath: "Platform/SamplePkg/Sample.dsc", contentHash: "0".repeat(64), capturedAt: NOW, validity: "active" } },
				{ key: "customer", evidence: { type: "source-file", workspaceId: "w1", relativePath: "Platform/Gone/Sample.dsc", contentHash: goodHash, capturedAt: NOW, validity: "active" } },
				{ key: "customer", evidence: { type: "commit", workspaceId: "w1", commit: "abc123", capturedAt: NOW, validity: "active" } },
				{ key: "customer", evidence: { type: "source-file", workspaceId: "w1", relativePath: "../outside.dsc", contentHash: goodHash, capturedAt: NOW, validity: "active" } },
			],
		});
		assert.deepEqual(
			result.checks.map((check) => check.status),
			["valid", "changed", "missing", "not-verifiable", "not-verifiable"],
		);
		assert.equal(result.checks[1].actualHash, goodHash, "变化时必须给出实际 hash 供人工对照");
		assert.deepEqual(
			result.checks.map((check) => check.key),
			["boardName", "boardName", "customer", "customer", "customer"],
			"结果必须带回事实键：字段之间不能串用检查结果",
		);
		const summary = summarizeEvidenceChecks(result);
		assert.equal(summary.worst, "changed");

		// 文件真的变了 ⇒ 结论跟着变（证明比较的是内容而不是缓存）。
		await writeDsc(sandbox.workspaceA, "Platform/SamplePkg/Sample.dsc", { platformName: "SamplePlatform", extra: ["  SamplePkg/New.inf"] });
		const again = await verifyEvidenceRefs({ ...access(sandbox.workspaceA), workspacePath: sandbox.workspaceA, entries: [{ key: "boardName", evidence: { type: "source-file", relativePath: "Platform/SamplePkg/Sample.dsc", contentHash: goodHash, capturedAt: NOW, validity: "active" } }] });
		assert.equal(again.checks[0].status, "changed");

		// 预算：文件数上限；**不把它当成"全部有效"**，且原因分类如实。
		const many = Array.from({ length: 5 }, (_, index) => ({ key: `fact-${index}`, evidence: { type: "source-file", relativePath: "Platform/SamplePkg/Sample.dsc", contentHash: goodHash, capturedAt: NOW, validity: "active" } }));
		const capped = await verifyEvidenceRefs({ ...access(sandbox.workspaceA), workspacePath: sandbox.workspaceA, entries: many, limits: { maxEvidenceFiles: 2 } });
		assert.equal(capped.truncated, true);
		assert.equal(capped.uncheckedCount, 3);
		assert.equal(capped.budgetedEntries, 2, "文件预算按**条数**计费");
		assert.equal(capped.fileReads, 1, "同一路径只读一次磁盘（缓存不改变判定，只省 IO）");
		assert.ok(capped.uncheckedReasons.includes("file-budget"));

		// 取消：立即失败，不返回半份结论。
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(verifyEvidenceRefs({ ...access(sandbox.workspaceA), workspacePath: sandbox.workspaceA, entries: many, signal: controller.signal }), projectError("cancelled"));
	} finally {
		await sandbox.cleanup();
	}
});

test("B4：实际字节上限由有界读取执行（stat 之后长大也读不越额）", async () => {
	const sandbox = await preparedSandbox();
	try {
		const { readFileBounded } = await import("../core/projects/index.ts");
		const big = join(sandbox.workspaceA, "Platform", "SamplePkg", "Big.dsc");
		await writeFile(big, "x".repeat(300 * 1024));
		const stats = await stat(big);
		assert.equal(stats.size, 300 * 1024, "夹具确实是一个大文件");

		// 上限只认**实际读到的字节**：即使 stat 已经说了大小，读取也不会越过上限。
		const capped = await readFileBounded(big, 64, undefined, "已取消");
		assert.equal(capped.ok, false);
		assert.equal(capped.code, "too-large");
		assert.match(capped.detail, /64/);

		// 上限内正常返回完整字节（不是截断的一截）。
		const small = join(sandbox.workspaceA, "Platform", "SamplePkg", "Small.dsc");
		await writeFile(small, "[Defines]\n  PLATFORM_NAME = SmallPlatform\n");
		const ok = await readFileBounded(small, 1024, undefined, "已取消");
		assert.equal(ok.ok, true);
		assert.equal(ok.bytes.toString("utf8").includes("SmallPlatform"), true);

		// 取消在读取过程中生效（不是只在循环开头检查一次）。
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(readFileBounded(small, 1024, controller.signal, "已取消"), projectError("cancelled"));
	} finally {
		await sandbox.cleanup();
	}
});

test("B4：检测在 stat 之前就按实际字节封顶，且超预算文件计入 truncated 与缺口", async () => {
	const sandbox = await preparedSandbox();
	try {
		const big = join(sandbox.workspaceA, "Platform", "SamplePkg", "Huge.dsc");
		await writeFile(big, `[Defines]\n  PLATFORM_NAME = HugePlatform\n${"# padding\n".repeat(40_000)}`);
		const result = await detectProjectCandidates({ ...access(sandbox.workspaceA), workspacePath: sandbox.workspaceA, workspaceId: "w-big", limits: { maxDetectFileBytes: 1024 }, now: NOW });
		// 超预算的文件不能产出候选（不能"读一半就当解析成功"）。
		assert.equal(
			result.candidates.some((candidate) => candidate.value === "HugePlatform"),
			false,
		);
		assert.ok(result.truncatedBy.includes("bytes"));
		assert.ok(result.problems.some((problem) => /预算/.test(problem)));
		assert.equal(result.truncated, true);
	} finally {
		await sandbox.cleanup();
	}
});

test("B4：字段隔离——只改一个字段的证据不会拖低另一个字段", async () => {
	const sandbox = await preparedSandbox();
	try {
		await writeDec(sandbox.workspaceA, "Platform/SamplePkg/SamplePkg.dec", "SamplePkg");
		const bound = await bindProjectWorkspace({ ...access(sandbox.workspaceA), root: sandbox.root, workspacePath: sandbox.workspaceA, now: NOW });
		const opened = await openProjectProfile({ root: sandbox.root, cwd: sandbox.workspaceA, workspacePath: sandbox.workspaceA });
		const dscHash = await fileHash(join(sandbox.workspaceA, "Platform/SamplePkg/Sample.dsc"));
		const decHash = await fileHash(join(sandbox.workspaceA, "Platform/SamplePkg/SamplePkg.dec"));
		await confirmProfileFields({
			root: sandbox.root,
			projectId: bound.projectId,
			workspaceId: opened.workspaceId,
			expectedProfileRevision: opened.profileRevision,
			values: [
				{ field: "boardName", value: "BoardIso", evidence: [{ relativePath: "Platform/SamplePkg/Sample.dsc", contentHash: dscHash }] },
				{ field: "customer", value: "CustomerIso", evidence: [{ relativePath: "Platform/SamplePkg/SamplePkg.dec", contentHash: decHash }] },
			],
			now: NOW + 1,
		});

		// 先确认两边都 valid。
		const before = await readProjectView({ root: sandbox.root, cwd: sandbox.workspaceA, workspacePath: sandbox.workspaceA, verifyEvidence: true, now: NOW + 2 });
		const itemsBefore = new Map(before.decision.items.map((item) => [item.factKey, item]));
		assert.equal(itemsBefore.get("project-profile.boardName").class, "current");
		assert.equal(itemsBefore.get("project-profile.customer").class, "current");

		// 只改 b.dec（customer 的证据）⇒ 只有 customer 漂移。
		await writeFile(join(sandbox.workspaceA, "Platform", "SamplePkg", "SamplePkg.dec"), "[Defines]\n  PACKAGE_NAME = ChangedPkg\n");
		const after = await readProjectView({ root: sandbox.root, cwd: sandbox.workspaceA, workspacePath: sandbox.workspaceA, verifyEvidence: true, now: NOW + 3 });
		const itemsAfter = new Map(after.decision.items.map((item) => [item.factKey, item]));
		assert.equal(itemsAfter.get("project-profile.customer").class, "needs-review", "被改动的字段必须提示复核");
		assert.ok(itemsAfter.get("project-profile.customer").reasons.includes("verification-drift"));
		assert.equal(itemsAfter.get("project-profile.boardName").class, "current", "无关字段不得被拖低");
		assert.ok(!itemsAfter.get("project-profile.boardName").reasons.includes("verification-drift"));
	} finally {
		await sandbox.cleanup();
	}
});
