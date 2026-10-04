/**
 * 存储层记录读取与边界测试（BM-02A）。
 *
 * 覆盖：五类记录读取、ID/项目一致性、限额、损坏与未知版本、链接逃逸（含外部 sentinel）、
 * 取消、非文件路径、有界列表与单条问题区分、绑定边界。
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { BIOS_CONTRACTS_SCHEMA_VERSION } from "../core/contracts/version.ts";
import { StorageError, initializeKnowledgeStore, listRecords, readRecord, recordRelativeSegments, resolveProjectBinding } from "../core/storage/index.ts";

const SANDBOX = realpathSync(mkdtempSync(join(tmpdir(), "bios-store-records-")));
const NOW = 1_700_000_000_000;
const PROJECT_ID = "3f2504e0-4f89-4a1c-9a3d-1f0d3c9a4b7e";
const OTHER_PROJECT_ID = "8c1b2f44-6a5d-4b3e-9f7a-2d4c8e1b5a90";
const WORKSPACE_ID = "b7d1e9f2-3c4a-4d5e-8f9a-0b1c2d3e4f50";
const WORKSPACE_ID_TWO = "c8e2f0a3-4d5b-4e6f-9a0b-1c2d3e4f5061";

after(() => {
	rmSync(SANDBOX, { recursive: true, force: true });
});

let rootCounter = 0;
async function makeStoreRoot(name) {
	rootCounter += 1;
	const root = join(SANDBOX, `${name}-${rootCounter}`);
	mkdirSync(root, { recursive: true });
	const created = await initializeKnowledgeStore({ root });
	return created.layout.root;
}

function field(value, status = "candidate") {
	return { value, status, evidence: [], updatedAt: NOW };
}

function base(overrides = {}) {
	return { schemaVersion: BIOS_CONTRACTS_SCHEMA_VERSION, revision: 1, createdAt: NOW, updatedAt: NOW, ...overrides };
}

function makeProjectProfile(overrides = {}) {
	return {
		...base(),
		id: PROJECT_ID,
		identity: {
			ibv: field("Example IBV"),
			ibvVersion: field("1.2.3"),
			chipsetVendor: field("Example Vendor"),
			chipsetFamily: field("Example Family"),
			chipsetGeneration: field("Gen-1"),
			architecture: field("x86_64"),
			boardName: field("ExampleBoard"),
			boardRevision: field("A1"),
			customer: field("Example Customer"),
			productLine: field("Example Line"),
			crbBaseline: field("CRB-1.0"),
		},
		workspaces: [
			{
				workspaceId: WORKSPACE_ID,
				path: join(SANDBOX, "ws-main"),
				availability: "reachable",
				vcs: { kind: "git", branch: "main", head: "abc1234", remoteUrl: null },
				capturedAt: NOW,
			},
		],
		buildTargets: [field("ExampleBoardPkg")],
		keyEntryPoints: [field("PlatformPkg/Platform.dsc")],
		gaps: [],
		...overrides,
	};
}

function makeTaskRecord(overrides = {}) {
	return {
		...base(),
		id: "task-1",
		projectId: PROJECT_ID,
		workspace: { workspaceId: WORKSPACE_ID, path: join(SANDBOX, "ws-main"), branch: "feature/x", baseCommit: "abc1234" },
		requirement: "让 PXE 启动项在客户 OOB 菜单中可关闭",
		status: "in_progress",
		decisions: [],
		todos: [],
		blockers: [],
		relatedFiles: [],
		sourceExperienceIds: [],
		validations: [],
		...overrides,
	};
}

function makeFeatureRecord(overrides = {}) {
	return {
		...base(),
		id: "feature-1",
		originalRequirement: "客户要求 PXE 默认关闭",
		aliases: ["PXE", "网络启动"],
		customer: field("Example Customer"),
		productLine: field("Example Line"),
		acceptanceCriteria: ["Setup 中默认关闭"],
		relatedExperienceIds: [],
		...overrides,
	};
}

function makeExperienceCard(overrides = {}) {
	return {
		...base(),
		id: "exp-1",
		problem: "PXE 默认开启导致安装后仍尝试网络引导",
		rootCause: "Setup 默认值未随客户选项调整",
		solution: "在客户定制区覆盖默认值",
		appliesWhen: [],
		doesNotApplyWhen: [],
		sourceProjectId: OTHER_PROJECT_ID,
		evidence: [],
		validations: [],
		reuseScope: { level: "current-project", customers: [] },
		status: "reviewed",
		...overrides,
	};
}

function makeContextManifest(overrides = {}) {
	return {
		...base(),
		id: "ctx-1",
		targetProjectId: PROJECT_ID,
		taskId: "task-1",
		profileRevision: 1,
		sources: [],
		expiredSources: [],
		budget: { maxChars: 12_000, maxBytes: 24_576, usedChars: 0, truncated: false },
		generatedAt: NOW,
		...overrides,
	};
}

function writeRecord(root, kind, record, projectId) {
	const path = join(root, ...recordRelativeSegments(kind, record.id, projectId));
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(record, null, "\t")}\n`, "utf8");
	return path;
}

function hashFile(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

test("五类记录都能按 kind + ID 读取并校验通过", async () => {
	const root = await makeStoreRoot("records-roundtrip");
	writeRecord(root, "project-profile", makeProjectProfile(), PROJECT_ID);
	writeRecord(root, "task-record", makeTaskRecord(), PROJECT_ID);
	writeRecord(root, "feature-record", makeFeatureRecord());
	writeRecord(root, "experience-card", makeExperienceCard());
	writeRecord(root, "context-manifest", makeContextManifest(), PROJECT_ID);

	const profile = await readRecord({ root, kind: "project-profile", id: PROJECT_ID });
	assert.equal(profile.kind, "project-profile");
	assert.equal(profile.record.id, PROJECT_ID);
	assert.equal(profile.record.identity.boardName.value, "ExampleBoard");

	const task = await readRecord({ root, kind: "task-record", id: "task-1", projectId: PROJECT_ID });
	assert.equal(task.record.projectId, PROJECT_ID);

	const feature = await readRecord({ root, kind: "feature-record", id: "feature-1" });
	assert.equal(feature.record.id, "feature-1");

	const experience = await readRecord({ root, kind: "experience-card", id: "exp-1" });
	assert.equal(experience.record.status, "reviewed");

	const manifest = await readRecord({ root, kind: "context-manifest", id: "ctx-1", projectId: PROJECT_ID });
	assert.equal(manifest.record.targetProjectId, PROJECT_ID);

	// 每条结果都带实际路径与读取字节数（有界读取的证据）。
	for (const result of [profile, task, feature, experience, manifest]) {
		assert.ok(result.path.startsWith(root));
		assert.ok(result.bytes > 0);
	}
});

test("记录内容 ID 与请求 ID 不一致：拒绝（不凭合法 JSON 返回错记录）", async () => {
	const root = await makeStoreRoot("records-id-mismatch");
	// 文件路径是 exp-1.json，但内容写的是另一个 ID。
	const path = writeRecord(root, "experience-card", makeExperienceCard({ id: "exp-1" }));
	writeFileSync(path, `${JSON.stringify(makeExperienceCard({ id: "exp-999" }), null, "\t")}\n`, "utf8");

	await assert.rejects(
		() => readRecord({ root, kind: "experience-card", id: "exp-1" }),
		(error) => error instanceof StorageError && error.code === "record-id-mismatch",
	);
});

test("任务的 projectId 与所在项目不一致：拒绝", async () => {
	const root = await makeStoreRoot("records-project-mismatch");
	writeRecord(root, "task-record", makeTaskRecord({ projectId: OTHER_PROJECT_ID }), PROJECT_ID);

	await assert.rejects(
		() => readRecord({ root, kind: "task-record", id: "task-1", projectId: PROJECT_ID }),
		(error) => error instanceof StorageError && error.code === "record-id-mismatch",
	);
});

test("非法 ID 在派生路径前就被拒绝", async () => {
	const root = await makeStoreRoot("records-bad-id");
	for (const id of ["../escape", "con", "exp.", "Exp", "a/b"]) {
		await assert.rejects(
			() => readRecord({ root, kind: "experience-card", id }),
			(error) => error instanceof StorageError && error.code === "invalid-record",
			`应拒绝 ID：${id}`,
		);
	}
	// 缺少 projectId 的项目内记录同样拒绝。
	await assert.rejects(
		() => readRecord({ root, kind: "task-record", id: "task-1" }),
		(error) => error instanceof StorageError && error.code === "invalid-record",
	);
});

test("不存在的记录报 not-found，不伪装成空记录", async () => {
	const root = await makeStoreRoot("records-missing");
	await assert.rejects(
		() => readRecord({ root, kind: "experience-card", id: "exp-absent" }),
		(error) => error instanceof StorageError && error.code === "not-found",
	);
});

test("损坏 JSON 与未来版本分别报 invalid-json / unsupported-schema-version", async () => {
	const root = await makeStoreRoot("records-invalid");
	const brokenPath = writeRecord(root, "experience-card", makeExperienceCard({ id: "exp-broken" }));
	writeFileSync(brokenPath, "{ not json", "utf8");
	await assert.rejects(
		() => readRecord({ root, kind: "experience-card", id: "exp-broken" }),
		(error) => error instanceof StorageError && error.code === "invalid-json",
	);

	const futurePath = writeRecord(root, "experience-card", makeExperienceCard({ id: "exp-future" }));
	writeFileSync(futurePath, `${JSON.stringify(makeExperienceCard({ id: "exp-future", schemaVersion: BIOS_CONTRACTS_SCHEMA_VERSION + 5 }), null, "\t")}\n`, "utf8");
	const before = hashFile(futurePath);
	await assert.rejects(
		() => readRecord({ root, kind: "experience-card", id: "exp-future" }),
		(error) => error instanceof StorageError && error.code === "unsupported-schema-version",
	);
	assert.equal(hashFile(futurePath), before, "拒绝读取不得改动原文件");
});

test("超过单条限额的记录：拒绝且不物化正文", async () => {
	const root = await makeStoreRoot("records-too-large");
	writeRecord(root, "experience-card", makeExperienceCard({ id: "exp-big", solution: "x".repeat(4096) }));

	await assert.rejects(
		() => readRecord({ root, kind: "experience-card", id: "exp-big", limits: { maxRecordBytes: 512 } }),
		(error) => error instanceof StorageError && error.code === "too-large",
	);
});

test("记录路径是目录（非文件）：报 not-a-file", async () => {
	const root = await makeStoreRoot("records-not-a-file");
	const path = join(root, ...recordRelativeSegments("experience-card", "exp-dir"));
	mkdirSync(path, { recursive: true });

	await assert.rejects(
		() => readRecord({ root, kind: "experience-card", id: "exp-dir" }),
		(error) => error instanceof StorageError && error.code === "not-a-file",
	);
});

test("已取消的信号：操作在读取前就失败", async () => {
	const root = await makeStoreRoot("records-cancelled");
	writeRecord(root, "experience-card", makeExperienceCard({ id: "exp-1" }));
	const controller = new AbortController();
	controller.abort();

	await assert.rejects(
		() => readRecord({ root, kind: "experience-card", id: "exp-1", signal: controller.signal }),
		(error) => error instanceof StorageError && error.code === "cancelled",
	);
	await assert.rejects(
		() => listRecords({ root, kind: "experience-card", signal: controller.signal }),
		(error) => error instanceof StorageError && error.code === "cancelled",
	);
});

test("有界列表：按条数预算截断，损坏条目进入 problems 而不是整体失败", async () => {
	const root = await makeStoreRoot("records-list");
	for (let index = 0; index < 5; index += 1) {
		writeRecord(root, "experience-card", makeExperienceCard({ id: `exp-${index}` }));
	}
	// 一个损坏条目：应可区分，且不影响其他条目。
	writeFileSync(join(root, "experiences", "exp-broken.json"), "{ broken", "utf8");

	const full = await listRecords({ root, kind: "experience-card" });
	assert.equal(full.entries.length, 5);
	assert.equal(full.problems.length, 1);
	assert.equal(full.problems[0].code, "invalid-json");
	assert.equal(full.truncated, false);

	const limited = await listRecords({ root, kind: "experience-card", limits: { maxListEntries: 2 } });
	assert.equal(limited.entries.length, 2);
	assert.equal(limited.truncated, true);
	assert.ok(limited.truncatedBy.includes("entries"));

	const tiny = await listRecords({ root, kind: "experience-card", limits: { maxScanEntries: 3 } });
	assert.ok(tiny.truncatedBy.includes("scan"));
	assert.ok(tiny.scanned <= 4, `扫描条目应受上限约束，实际 ${tiny.scanned}`);
});

test("项目内记录的列表只扫描该项目目录", async () => {
	const root = await makeStoreRoot("records-list-project");
	writeRecord(root, "task-record", makeTaskRecord({ id: "task-a" }), PROJECT_ID);
	writeRecord(root, "task-record", makeTaskRecord({ id: "task-b" }), PROJECT_ID);
	writeRecord(root, "task-record", makeTaskRecord({ id: "task-other", projectId: OTHER_PROJECT_ID }), OTHER_PROJECT_ID);

	const page = await listRecords({ root, kind: "task-record", projectId: PROJECT_ID });
	assert.deepEqual(page.entries.map((entry) => entry.id).sort(), ["task-a", "task-b"]);
	assert.equal(page.problems.length, 0);
});

test("根内目录被替换为指向根外的链接：读取拒绝，且根外文件字节不变", async (t) => {
	const root = await makeStoreRoot("records-link-escape");
	const outside = join(SANDBOX, `outside-${rootCounter}`);
	mkdirSync(outside, { recursive: true });
	const sentinelPath = join(outside, "sentinel.json");
	writeFileSync(sentinelPath, `${JSON.stringify(makeExperienceCard({ id: "exp-outside" }), null, "\t")}\n`, "utf8");
	const sentinelHash = hashFile(sentinelPath);

	// 把根内 experiences 换成指向根外的 junction。
	rmSync(join(root, "experiences"), { recursive: true, force: true });
	try {
		symlinkSync(outside, join(root, "experiences"), "junction");
	} catch (error) {
		// 权限不足时**明确 skip 并说明原因**，不静默当作通过（验收要求）。
		t.skip(`无法创建目录链接（需要开发者模式/管理员权限）：${error instanceof Error ? error.message : String(error)}`);
		return;
	}

	await assert.rejects(
		() => readRecord({ root, kind: "experience-card", id: "exp-outside" }),
		(error) => error instanceof StorageError && error.code === "symlink-rejected",
	);
	assert.equal(hashFile(sentinelPath), sentinelHash, "拒绝路径不得触碰根外文件");
});

test("最终记录文件本身是链接：拒绝", async (t) => {
	const root = await makeStoreRoot("records-file-link");
	const outside = join(SANDBOX, `outside-file-${rootCounter}`);
	mkdirSync(outside, { recursive: true });
	const realPath = join(outside, "exp-real.json");
	writeFileSync(realPath, `${JSON.stringify(makeExperienceCard({ id: "exp-link" }), null, "\t")}\n`, "utf8");

	const linkPath = join(root, "experiences", "exp-link.json");
	try {
		symlinkSync(realPath, linkPath, "file");
	} catch (error) {
		t.skip(`无法创建文件链接（需要开发者权限）：${error instanceof Error ? error.message : String(error)}`);
		return;
	}

	await assert.rejects(
		() => readRecord({ root, kind: "experience-card", id: "exp-link" }),
		(error) => error instanceof StorageError && error.code === "symlink-rejected",
	);
});

test("绑定边界：同项目两工作区分别可解析，无桌面 ID 的项目按 biosProjectId 解析", () => {
	const workspaceMain = join(SANDBOX, "ws-main");
	const workspaceWorktree = join(SANDBOX, "ws-worktree");
	const registry = {
		schemaVersion: BIOS_CONTRACTS_SCHEMA_VERSION,
		revision: 2,
		createdAt: 1,
		updatedAt: 1,
		projects: [
			{
				biosProjectId: PROJECT_ID,
				workspaces: [
					{ workspaceId: WORKSPACE_ID, path: workspaceMain, boundAt: 1 },
					{ workspaceId: WORKSPACE_ID_TWO, path: workspaceWorktree, boundAt: 1 },
				],
				createdAt: 1,
				updatedAt: 1,
			},
		],
	};

	const main = resolveProjectBinding(registry, { workspacePath: workspaceMain });
	assert.equal(main.status, "resolved");
	assert.equal(main.workspace.workspaceId, WORKSPACE_ID);

	// 两个 worktree 属于同一项目但工作区不同：不能互相覆盖。
	const worktree = resolveProjectBinding(registry, { workspacePath: workspaceWorktree });
	assert.equal(worktree.status, "resolved");
	assert.equal(worktree.workspace.workspaceId, WORKSPACE_ID_TWO);
	assert.notEqual(main.workspace.workspaceId, worktree.workspace.workspaceId);

	// 多工作区只给项目 ID 时必须返回歧义（BM-02AR / S5）：不再用 workspaces[0] 猜一个。
	const byProject = resolveProjectBinding(registry, { biosProjectId: PROJECT_ID });
	assert.equal(byProject.status, "conflict");
	assert.equal(byProject.reason, "ambiguous-workspace");
	assert.deepEqual(byProject.candidates, [WORKSPACE_ID, WORKSPACE_ID_TWO].sort());

	// 缺失路径应报 no-match 而不是新建项目。
	assert.equal(resolveProjectBinding(registry, { workspacePath: join(SANDBOX, "never-bound") }).reason, "no-match");
});

test("初始化后再读取：布局目录与空 registry 都保持可用", async () => {
	const root = await makeStoreRoot("records-layout");
	assert.ok(existsSync(join(root, "registry.json")));
	assert.ok(existsSync(join(root, "projects")));
	assert.ok(existsSync(join(root, "experiences")));
	assert.ok(existsSync(join(root, "features")));
	assert.ok(existsSync(join(root, "audit")));
	assert.ok(existsSync(join(root, "cache")));
});
