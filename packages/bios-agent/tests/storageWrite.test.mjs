/**
 * BM-02B 写入能力的**永久回归**（对应 bm02b_development_plan.md §6 的 9 组要求）。
 *
 * 这一轮把知识库从"能初始化/读取"推进到"多进程能安全创建/更新记录"，
 * 因此本文件的重点是**真实多进程**下的时序，而不是单进程 happy path：
 *
 * - §6.1 五类记录 create/update：revision 0→1、ID/归属/createdAt 保持、新进程可读；
 * - §6.2 registry 单文件更新：绑定生效、重复绑定拒绝、不创建/改写任何档案；
 * - §6.3 乐观并发：旧 revision / 缺失 / 已存在 / 非法值 / 溢出全部明确，拒绝时原字节不变；
 * - §6.4 真实双子进程竞争：创建竞争与更新竞争都"恰好一方提交"；
 * - §6.5 可见性：提交前读者只见旧完整记录，提交后只见新完整记录，永不出现半 JSON；
 * - §6.6 跨进程锁：超时/取消/自释放/不删他人锁/遗留锁不抢占；
 * - §6.7 故障与取消：临时写/sync/rename 注入失败与提交前取消都保持原字节、无残留；
 * - §6.8 提交成功后迟到的取消不假称回滚；
 * - §6.9 安全与预算：非法 kind/ID/归属、超大写入、根内 junction 逃逸、未初始化。
 *
 * `StorageIoHooks` 注入只是**确定性复现特殊分支**的手段，不代表本机磁盘真的出过对应故障；
 * 真实子进程一律带超时与输出上限，避免测试挂死或吃掉内存。
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { link as fsLink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import test, { after } from "node:test";
import { acquireStorageLock, createRecord, createStorageBoundary, DEFAULT_STORAGE_LIMITS, initializeKnowledgeStore, readRecord, readRegistry, recordRelativeSegments, StorageError, updateRecord, updateRegistry } from "../core/storage/index.ts";

const STORAGE_MODULE_URL = new URL("../core/storage/index.ts", import.meta.url).href;
const SANDBOX = realpathSync(mkdtempSync(join(tmpdir(), "bios-store-write-")));
const NOW = 1_700_000_000_000;
const LATER = NOW + 60_000;
const PROJECT_ID = "3f2504e0-4f89-4a1c-9a3d-1f0d3c9a4b7e";
const OTHER_PROJECT_ID = "8c1b2f44-6a5d-4b3e-9f7a-2d4c8e1b5a90";
const WORKSPACE_ID = "b7d1e9f2-3c4a-4d5e-8f9a-0b1c2d3e4f50";
const WORKSPACE_ID_TWO = "c8e2f0a3-4d5b-4e6f-9a0b-1c2d3e4f5061";

after(() => {
	rmSync(SANDBOX, { recursive: true, force: true });
});

let rootCounter = 0;

/** 只建目录、**不**初始化知识库。 */
function makeRawRoot(name) {
	rootCounter += 1;
	const root = join(SANDBOX, `${name}-${rootCounter}`);
	mkdirSync(root, { recursive: true });
	return realpathSync(root);
}

async function makeStoreRoot(name) {
	const root = makeRawRoot(name);
	await initializeKnowledgeStore({ root });
	return root;
}

/* ------------------------------------------------------------------ fixture：只含调用方可写的业务字段 */

function field(value, status = "candidate") {
	return { value, status, evidence: [], updatedAt: NOW };
}

function profileBody(overrides = {}) {
	return {
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
		workspaces: [{ workspaceId: WORKSPACE_ID, path: join(SANDBOX, "ws-main"), availability: "reachable", vcs: { kind: "git", branch: "main", head: "abc1234", remoteUrl: null }, capturedAt: NOW }],
		buildTargets: [field("ExampleBoardPkg")],
		keyEntryPoints: [field("PlatformPkg/Platform.dsc")],
		gaps: [],
		...overrides,
	};
}

function taskBody(requirement, overrides = {}) {
	return {
		workspace: { workspaceId: WORKSPACE_ID, path: join(SANDBOX, "ws-main"), branch: "feature/x", baseCommit: "abc1234" },
		requirement,
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

function featureBody(originalRequirement, overrides = {}) {
	return { originalRequirement, aliases: [], customer: field("Example Customer"), productLine: field("Example Line"), acceptanceCriteria: [], relatedExperienceIds: [], ...overrides };
}

function experienceBody(solution, overrides = {}) {
	return {
		problem: "PXE 默认开启导致安装后仍尝试网络引导",
		rootCause: "Setup 默认值未随客户选项调整",
		solution,
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

function contextBody(overrides = {}) {
	return {
		taskId: "task-1",
		profileRevision: 0,
		sources: [],
		expiredSources: [],
		budget: { maxChars: 12_000, maxBytes: 24_576, usedChars: 0, truncated: false },
		generatedAt: NOW,
		...overrides,
	};
}

/* ------------------------------------------------------------------ 小工具 */

function recordPath(root, kind, id, projectId) {
	return join(root, ...recordRelativeSegments(kind, id, projectId));
}

function hashFile(path) {
	return existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : null;
}

/** 目录里还剩几个提交临时文件（`.<name>.<pid>.<hex>.tmp`）。 */
function tempLeftovers(dir) {
	if (!existsSync(dir)) return [];
	return readdirSync(dir).filter((name) => name.endsWith(".tmp"));
}

function lockEntries(root) {
	const locksDir = join(root, "locks");
	return existsSync(locksDir) ? readdirSync(locksDir) : [];
}

/**
 * BM-02C1 起，一次写入的 IO 操作里多了 journal 自己的提交（prepared + 终态），
 * 它们用**同一批**操作名（`write-temp` / `sync` / `close-temp` / `link` / `rename` / `unlink-temp`）。
 * 按操作名注入的既有用例必须再按路径把 journal 摘出去，否则注入会落在"记账"上而不是业务目标上，
 * 用例名与实际覆盖就脱钩了。
 */
function isJournalPath(target) {
	return typeof target === "string" && target.includes(`${sep}journal${sep}`);
}

/** 读一条 journal（用例断言记账内容用）。 */
function readJournalFile(root, operationId) {
	return JSON.parse(readFileSync(join(root, "journal", `${operationId}.json`), "utf8"));
}

/** journal 目录里的文件名（不存在则空）。 */
function journalEntries(root) {
	const dir = join(root, "journal");
	return existsSync(dir) ? readdirSync(dir) : [];
}

/** 断言错误的"可行动字段"，而不是整条中文文案。 */
function isStorageError(code, detailPart) {
	return (error) => {
		if (!(error instanceof StorageError)) return false;
		if (error.code !== code) return false;
		if (detailPart === undefined) return true;
		return String(error.detail ?? "").includes(detailPart);
	};
}

function runNode(script, timeout = 60_000) {
	const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout, maxBuffer: 1 << 20 });
	return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", error: result.error };
}

/** 异步子进程（竞争用例需要两个真正并行的进程，`spawnSync` 会串行化）。 */
function spawnNode(script, { timeoutMs = 60_000 } = {}) {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, timeoutMs);
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
			if (stdout.length > 1 << 20) child.kill("SIGKILL");
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
			if (stderr.length > 1 << 20) child.kill("SIGKILL");
		});
		child.on("error", (error) => {
			clearTimeout(timer);
			resolve({ code: null, stdout, stderr, timedOut, error });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code, stdout, stderr, timedOut, error: undefined });
		});
	});
}

/** 竞争用的会合点：两边各写 ready，等主进程放 go（避免"谁先跑到"决定结果）。 */
function makeBarrier(name) {
	rootCounter += 1;
	const dir = join(SANDBOX, `barrier-${name}-${rootCounter}`);
	mkdirSync(dir, { recursive: true });
	return { ready: (label) => join(dir, `ready-${label}`), go: join(dir, "go") };
}

async function waitForPath(path, timeoutMs = 30_000) {
	const deadline = Date.now() + timeoutMs;
	while (!existsSync(path)) {
		if (Date.now() > deadline) throw new Error(`等待 ${path} 出现超时`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

function parseChildOutcome(result) {
	assert.equal(result.timedOut, false, "子进程不得超时");
	assert.equal(result.error, undefined, `子进程启动失败：${result.error?.message ?? ""}`);
	assert.equal(result.code, 0, `子进程退出码非 0：${result.stderr}`);
	return JSON.parse(result.stdout);
}

const WAIT_FOR_HELPER = `
const waitFor = async (path, timeoutMs) => {
	const deadline = Date.now() + timeoutMs;
	while (!existsSync(path)) {
		if (Date.now() > deadline) throw new Error("barrier timeout: " + path);
		await new Promise((r) => setTimeout(r, 5));
	}
};
`;

/** 竞争写者：先报到，等 go，然后**真实**调用 create/update。 */
function writerScript({ mode, root, kind, id, projectId, data, expectedRevision, label, readyPath, goPath }) {
	const call =
		mode === "create"
			? `createRecord({ root: ${JSON.stringify(root)}, kind: ${JSON.stringify(kind)}, id: ${JSON.stringify(id)}, data: ${JSON.stringify(data)}, expectedRevision: null, now: ${LATER} })`
			: `updateRecord({ root: ${JSON.stringify(root)}, kind: ${JSON.stringify(kind)}, id: ${JSON.stringify(id)}, projectId: ${JSON.stringify(projectId)}, data: ${JSON.stringify(data)}, expectedRevision: ${JSON.stringify(expectedRevision)}, now: ${LATER} })`;
	return `
const { existsSync, writeFileSync } = await import("node:fs");
const { createRecord, updateRecord } = await import(${JSON.stringify(STORAGE_MODULE_URL)});
${WAIT_FOR_HELPER}
writeFileSync(${JSON.stringify(readyPath)}, "1");
await waitFor(${JSON.stringify(goPath)}, 30000);
let outcome;
try {
	const result = await ${call};
	outcome = { label: ${JSON.stringify(label)}, ok: true, status: result.status, revision: result.revision };
} catch (error) {
	outcome = { label: ${JSON.stringify(label)}, ok: false, code: error?.code ?? null, expected: error?.expected ?? null, actual: error?.actual ?? null };
}
process.stdout.write(JSON.stringify(outcome));
`;
}

/** 并发读者：等 go 后反复真实读取，记录每次 revision 与错误。 */
function readerLoopScript({ root, kind, id, projectId, readyPath, goPath, iterations, delayMs }) {
	return `
const { existsSync, writeFileSync } = await import("node:fs");
const { readRecord } = await import(${JSON.stringify(STORAGE_MODULE_URL)});
${WAIT_FOR_HELPER}
writeFileSync(${JSON.stringify(readyPath)}, "1");
await waitFor(${JSON.stringify(goPath)}, 30000);
const revisions = [];
const errors = [];
for (let index = 0; index < ${iterations}; index += 1) {
	try {
		const result = await readRecord({ root: ${JSON.stringify(root)}, kind: ${JSON.stringify(kind)}, id: ${JSON.stringify(id)}, projectId: ${JSON.stringify(projectId)} });
		revisions.push(result.record.revision);
	} catch (error) {
		errors.push({ code: error?.code ?? null, message: String(error?.message ?? error) });
	}
	await new Promise((r) => setTimeout(r, ${delayMs}));
}
process.stdout.write(JSON.stringify({ revisions, errors }));
`;
}

/* ------------------------------------------------------------------ §6.1 五类记录 create/update */

test("B1：五类记录 create→update 后 revision 0→1，ID/归属/createdAt 保持，新进程可读回", async (t) => {
	const root = await makeStoreRoot("write-five-kinds");
	const taskId = "task-five";
	const featureId = "feature-five";
	const experienceId = "exp-five";
	const manifestId = "ctx-five";

	const cases = [
		{ kind: "project-profile", id: PROJECT_ID, ownership: undefined, body: profileBody(), updated: profileBody({ buildTargets: [field("ChangedPkg")] }) },
		{ kind: "task-record", id: taskId, ownership: "projectId", body: taskBody("原始需求"), updated: taskBody("改过的需求") },
		{ kind: "feature-record", id: featureId, ownership: undefined, body: featureBody("原始需求"), updated: featureBody("改过的需求") },
		{ kind: "experience-card", id: experienceId, ownership: undefined, body: experienceBody("原始方案"), updated: experienceBody("改过的方案") },
		{ kind: "context-manifest", id: manifestId, ownership: "targetProjectId", body: contextBody(), updated: contextBody({ profileRevision: 1 }) },
	];

	for (const item of cases) {
		await t.test(`create→update ${item.kind}`, async () => {
			const projectId = item.ownership ? PROJECT_ID : undefined;
			const created = await createRecord({ root, kind: item.kind, id: item.id, projectId, data: item.body, expectedRevision: null, now: NOW });
			assert.equal(created.status, "created");
			assert.equal(created.revision, 0, "create 的 revision 必须是 0");
			assert.equal(created.record.createdAt, NOW);
			assert.equal(created.record.updatedAt, NOW);
			assert.equal(created.lockRelease, "released");
			assert.equal(created.cleanup, "ok");
			assert.equal(tempLeftovers(dirname(created.path)).length, 0, "提交后不得残留临时文件");

			const updated = await updateRecord({ root, kind: item.kind, id: item.id, projectId, data: item.updated, expectedRevision: 0, now: LATER });
			assert.equal(updated.status, "updated");
			assert.equal(updated.revision, 1, "update 的 revision 必须是旧值 + 1");
			assert.equal(updated.record.id, created.record.id, "update 不得改变 ID");
			assert.equal(updated.record.createdAt, created.record.createdAt, "update 不得改变 createdAt");
			assert.equal(updated.record.updatedAt, LATER);
			assert.equal(updated.path, created.path, "create/update 必须落在同一路径");
			// 归属字段由存储层按传入的 projectId 生成：调用方无法把记录写到别的项目目录下。
			if (item.ownership) assert.equal(updated.record[item.ownership], PROJECT_ID);

			// 不倒退：用比 createdAt 更早的 now 更新，updatedAt 保持原值。
			const stale = await updateRecord({ root, kind: item.kind, id: item.id, projectId, data: item.updated, expectedRevision: 1, now: NOW - 1_000 });
			assert.equal(stale.record.updatedAt, LATER, "updatedAt 不允许倒退");
			assert.equal(stale.revision, 2);
		});
	}

	// 新进程读取：证明内容真的落到了磁盘上，而不是只活在本次运行的内存里。
	const script = `
const { readRecord } = await import(${JSON.stringify(STORAGE_MODULE_URL)});
const read = async (kind, id, projectId) => (await readRecord({ root: ${JSON.stringify(root)}, kind, id, projectId })).record;
const out = {
	profile: await read("project-profile", ${JSON.stringify(PROJECT_ID)}),
	task: await read("task-record", ${JSON.stringify(taskId)}, ${JSON.stringify(PROJECT_ID)}),
	feature: await read("feature-record", ${JSON.stringify(featureId)}),
	experience: await read("experience-card", ${JSON.stringify(experienceId)}),
	manifest: await read("context-manifest", ${JSON.stringify(manifestId)}, ${JSON.stringify(PROJECT_ID)}),
};
process.stdout.write(JSON.stringify(out));
`;
	const result = runNode(script);
	assert.equal(result.status, 0, `子进程读取失败：${result.stderr}`);
	const records = JSON.parse(result.stdout);
	assert.equal(records.profile.revision, 2);
	assert.equal(records.task.revision, 2);
	assert.equal(records.task.projectId, PROJECT_ID);
	assert.equal(records.manifest.targetProjectId, PROJECT_ID);
	assert.equal(records.experience.solution, "改过的方案");
	assert.equal(records.feature.originalRequirement, "改过的需求");
	assert.equal(existsSync(recordPath(root, "task-record", taskId, PROJECT_ID)), true);
});

/* ------------------------------------------------------------------ §6.2 registry 单文件更新 */

test("B1：updateRegistry 0→1 生效，且不改写也不创建任何档案文件", async () => {
	const root = await makeStoreRoot("registry-update");
	const before = await readRegistry({ root });
	assert.equal(before.revision, 0);

	// 先放一份已有档案：更新 registry 不得顺带碰它。
	const profilePath = recordPath(root, "project-profile", PROJECT_ID);
	await createRecord({ root, kind: "project-profile", id: PROJECT_ID, data: profileBody(), expectedRevision: null, now: NOW });
	const profileHashBefore = hashFile(profilePath);

	const result = await updateRegistry({
		root,
		expectedRevision: 0,
		now: LATER,
		projects: [
			{ biosProjectId: PROJECT_ID, desktopProjectId: "desktop-1", displayName: "Example", workspaces: [{ workspaceId: WORKSPACE_ID, path: realpathSync(SANDBOX), boundAt: NOW }], createdAt: NOW, updatedAt: NOW },
			{ biosProjectId: OTHER_PROJECT_ID, workspaces: [{ workspaceId: WORKSPACE_ID_TWO, path: realpathSync(tmpdir()), boundAt: NOW }], createdAt: NOW, updatedAt: NOW },
		],
	});
	assert.equal(result.status, "updated");
	assert.equal(result.revision, 1);
	assert.equal(result.relativePath, "registry.json");
	assert.equal(result.cleanup, "ok");
	assert.equal(result.lockRelease, "released");

	const after = await readRegistry({ root });
	assert.equal(after.revision, 1);
	assert.equal(after.projects.length, 2);
	assert.equal(after.createdAt, before.createdAt, "registry 的 createdAt 不得改变");
	// 初始化用的是真实时钟，因此注入的 now 可能更早：`updatedAt` 只保证不倒退。
	assert.equal(after.updatedAt, Math.max(LATER, before.updatedAt));
	assert.equal(after.projects[0].desktopProjectId, "desktop-1");

	// 空的项目列表是合法状态（"删掉一个绑定"必须能表达），所以这里额外验证一次。
	const emptied = await updateRegistry({ root, expectedRevision: 1, projects: [] });
	assert.equal(emptied.revision, 2);
	assert.deepEqual((await readRegistry({ root })).projects, []);

	assert.equal(hashFile(profilePath), profileHashBefore, "更新 registry 不得改写档案");
	assert.equal(tempLeftovers(root).length, 0);
});

test("B1：updateRegistry 拒绝重复项目 ID / 重复路径 / 重复桌面 ID，且不落盘", async () => {
	const root = await makeStoreRoot("registry-dupes");
	const registryPath = join(root, "registry.json");
	const before = hashFile(registryPath);
	const shared = { workspaceId: WORKSPACE_ID, path: realpathSync(SANDBOX), boundAt: NOW };
	const project = (overrides) => ({ biosProjectId: PROJECT_ID, workspaces: [], createdAt: NOW, updatedAt: NOW, ...overrides });

	await assert.rejects(() => updateRegistry({ root, expectedRevision: 0, projects: [project(), project()] }), isStorageError("binding-conflict"), "重复 biosProjectId 必须在落盘前被拒绝");
	await assert.rejects(
		() =>
			updateRegistry({
				root,
				expectedRevision: 0,
				projects: [
					{ biosProjectId: PROJECT_ID, workspaces: [shared], createdAt: NOW, updatedAt: NOW },
					{ biosProjectId: OTHER_PROJECT_ID, workspaces: [{ ...shared, workspaceId: WORKSPACE_ID_TWO }], createdAt: NOW, updatedAt: NOW },
				],
			}),
		isStorageError("binding-conflict"),
		"同一路径归属两个项目必须在落盘前被拒绝",
	);
	await assert.rejects(
		() => updateRegistry({ root, expectedRevision: 0, projects: [project({ desktopProjectId: "desktop-1" }), { biosProjectId: OTHER_PROJECT_ID, desktopProjectId: "desktop-1", workspaces: [], createdAt: NOW, updatedAt: NOW }] }),
		isStorageError("binding-conflict"),
		"重复桌面项目 ID 必须在落盘前被拒绝",
	);

	assert.equal(hashFile(registryPath), before, "被拒绝的 registry 更新不得改动原字节");
	assert.equal(lockEntries(root).length, 0, "被拒绝的更新不得留下锁");
});

test("B1：registry 缺失或 expectedRevision 过期时明确冲突，原字节不变", async () => {
	const raw = makeRawRoot("registry-missing");
	await assert.rejects(
		() => updateRegistry({ root: raw, expectedRevision: 0, projects: [] }),
		(error) => isStorageError("revision-conflict")(error) && error.actual === null,
	);

	const root = await makeStoreRoot("registry-stale");
	await updateRegistry({ root, expectedRevision: 0, projects: [] });
	const registryPath = join(root, "registry.json");
	const before = hashFile(registryPath);
	await assert.rejects(
		() => updateRegistry({ root, expectedRevision: 0, projects: [] }),
		(error) => isStorageError("revision-conflict")(error) && error.expected === 0 && error.actual === 1,
	);
	await assert.rejects(() => updateRegistry({ root, expectedRevision: null, projects: [] }), isStorageError("revision-conflict", "unexpected-null-revision"));
	await assert.rejects(() => updateRegistry({ root, expectedRevision: -1, projects: [] }), isStorageError("revision-conflict", "invalid-expected-revision"));
	assert.equal(hashFile(registryPath), before);
});

/* ------------------------------------------------------------------ §6.3 乐观并发 */

test("B1：旧 revision / 缺失 / 已存在 / 非法 expectedRevision 一律明确拒绝且原地字节不变", async () => {
	const root = await makeStoreRoot("optimistic");
	const id = "exp-optimistic";
	const path = recordPath(root, "experience-card", id);
	await createRecord({ root, kind: "experience-card", id, data: experienceBody("v0"), expectedRevision: null, now: NOW });
	await updateRecord({ root, kind: "experience-card", id, data: experienceBody("v1"), expectedRevision: 0, now: LATER });
	const hash = hashFile(path);

	// 旧 revision：别人已经写到 1 了，拿着 0 提交必须失败，并如实报告实际值。
	await assert.rejects(
		() => updateRecord({ root, kind: "experience-card", id, data: experienceBody("stale"), expectedRevision: 0 }),
		(error) => isStorageError("revision-conflict")(error) && error.expected === 0 && error.actual === 1,
	);

	// 缺失：update 要求目标存在。
	await assert.rejects(
		() => updateRecord({ root, kind: "experience-card", id: "exp-does-not-exist", data: experienceBody("x"), expectedRevision: 0 }),
		(error) => isStorageError("revision-conflict")(error) && error.expected === 0 && error.actual === null,
	);

	// 已存在：create 要求目标不存在。
	await assert.rejects(
		() => createRecord({ root, kind: "experience-card", id, data: experienceBody("dup"), expectedRevision: null }),
		(error) => isStorageError("revision-conflict")(error) && error.expected === null && error.actual === 1,
	);

	// 非法 expectedRevision：不能被当成"随便写"。
	await assert.rejects(() => updateRecord({ root, kind: "experience-card", id, data: experienceBody("bad"), expectedRevision: -1 }), isStorageError("revision-conflict", "invalid-expected-revision"));
	await assert.rejects(() => updateRecord({ root, kind: "experience-card", id, data: experienceBody("bad"), expectedRevision: 1.5 }), isStorageError("revision-conflict", "invalid-expected-revision"));
	await assert.rejects(() => updateRecord({ root, kind: "experience-card", id, data: experienceBody("bad"), expectedRevision: null }), isStorageError("revision-conflict", "unexpected-null-revision"));
	// create 收数字会退化成"要求存在且相等"却仍报 created——混用必须被拒绝。
	await assert.rejects(() => createRecord({ root, kind: "experience-card", id, data: experienceBody("bad"), expectedRevision: 1 }), isStorageError("revision-conflict", "create-with-number-revision"));

	assert.equal(hashFile(path), hash, "所有被拒绝的提交都不得改动原字节");
	assert.equal(lockEntries(root).length, 0, "被拒绝的提交不得留下锁");
	assert.equal(tempLeftovers(dirname(path)).length, 0);
});

test("B1：revision 溢出与损坏/未来版本/错误归属记录都拒绝覆盖", async () => {
	const root = await makeStoreRoot("refuse-overwrite");
	const id = "task-refuse";
	const path = recordPath(root, "task-record", id, PROJECT_ID);
	const head = { schemaVersion: 1, revision: 0, createdAt: NOW, updatedAt: NOW, id, ...taskBody("head") };

	// 溢出：`revision + 1` 会等于自身，乐观并发控制就此失效，必须显式拒绝。
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify({ ...head, projectId: PROJECT_ID, revision: Number.MAX_SAFE_INTEGER }, null, "\t")}\n`, "utf8");
	const maxedHash = hashFile(path);
	await assert.rejects(() => updateRecord({ root, kind: "task-record", id, projectId: PROJECT_ID, data: taskBody("next"), expectedRevision: Number.MAX_SAFE_INTEGER }), isStorageError("revision-conflict", "revision-overflow"));
	assert.equal(hashFile(path), maxedHash);

	// 损坏 JSON：不能当成"不存在"去新建，那会把一次损坏谎报成新建成功。
	writeFileSync(path, "{ 这不是 JSON", "utf8");
	const brokenHash = hashFile(path);
	await assert.rejects(() => createRecord({ root, kind: "task-record", id, projectId: PROJECT_ID, data: taskBody("new"), expectedRevision: null }), isStorageError("invalid-json"));
	await assert.rejects(() => updateRecord({ root, kind: "task-record", id, projectId: PROJECT_ID, data: taskBody("new"), expectedRevision: 0 }), isStorageError("invalid-json"));
	assert.equal(hashFile(path), brokenHash);

	// 未来版本：不猜字段。
	writeFileSync(path, `${JSON.stringify({ ...head, projectId: PROJECT_ID, schemaVersion: 999 }, null, "\t")}\n`, "utf8");
	const futureHash = hashFile(path);
	await assert.rejects(() => updateRecord({ root, kind: "task-record", id, projectId: PROJECT_ID, data: taskBody("new"), expectedRevision: 0 }), isStorageError("unsupported-schema-version"));
	assert.equal(hashFile(path), futureHash);

	// 错误归属：路径上的项目与内容里的 projectId 不一致，拒绝覆盖（否则会把记录搬错项目）。
	writeFileSync(path, `${JSON.stringify({ ...head, projectId: OTHER_PROJECT_ID }, null, "\t")}\n`, "utf8");
	const mismatchHash = hashFile(path);
	await assert.rejects(() => updateRecord({ root, kind: "task-record", id, projectId: PROJECT_ID, data: taskBody("new"), expectedRevision: 0 }), isStorageError("record-id-mismatch"));
	assert.equal(hashFile(path), mismatchHash);
});

/* ------------------------------------------------------------------ §6.4 真实双子进程竞争 */

test("B4：两个真实子进程以同一 expectedRevision 更新同一记录：恰好一方提交，另一方冲突", async () => {
	const root = await makeStoreRoot("race-update");
	const id = "task-race";
	await createRecord({ root, kind: "task-record", id, projectId: PROJECT_ID, data: taskBody("base"), expectedRevision: null, now: NOW });
	const path = recordPath(root, "task-record", id, PROJECT_ID);

	const barrier = makeBarrier("update");
	const labels = ["A", "B"];
	const children = labels.map((label) => spawnNode(writerScript({ mode: "update", root, kind: "task-record", id, projectId: PROJECT_ID, data: taskBody(`race-${label}`), expectedRevision: 0, label, readyPath: barrier.ready(label), goPath: barrier.go })));
	await waitForPath(barrier.ready("A"));
	await waitForPath(barrier.ready("B"));
	writeFileSync(barrier.go, "1", "utf8");

	const outcomes = (await Promise.all(children)).map(parseChildOutcome);
	const winners = outcomes.filter((outcome) => outcome.ok);
	const losers = outcomes.filter((outcome) => !outcome.ok);

	assert.equal(winners.length, 1, `必须恰好一方提交，实际：${JSON.stringify(outcomes)}`);
	assert.equal(winners[0].revision, 1, "只允许一次递增");
	assert.equal(losers.length, 1);
	assert.equal(losers[0].code, "revision-conflict");
	assert.equal(losers[0].expected, 0);
	assert.equal(losers[0].actual, 1, "冲突方必须看到赢家写下的 revision");

	// 磁盘上的内容必须与赢家一致，不能是两次写的混合体。
	const final = await readRecord({ root, kind: "task-record", id, projectId: PROJECT_ID });
	assert.equal(final.record.revision, 1);
	assert.equal(final.record.requirement, `race-${winners[0].label}`);
	assert.equal(lockEntries(root).length, 0, "竞争结束后不得留下锁");
	assert.equal(tempLeftovers(dirname(path)).length, 0, "竞争结束后不得留下临时文件");
});

test("B4：两个真实子进程创建同一 ID：仅一方成功，另一方冲突且不覆盖赢家内容", async () => {
	const root = await makeStoreRoot("race-create");
	const id = "exp-race";

	const barrier = makeBarrier("create");
	const labels = ["A", "B"];
	const children = labels.map((label) => spawnNode(writerScript({ mode: "create", root, kind: "experience-card", id, data: experienceBody(`create-${label}`), label, readyPath: barrier.ready(label), goPath: barrier.go })));
	await waitForPath(barrier.ready("A"));
	await waitForPath(barrier.ready("B"));
	writeFileSync(barrier.go, "1", "utf8");

	const outcomes = (await Promise.all(children)).map(parseChildOutcome);
	const winners = outcomes.filter((outcome) => outcome.ok);
	const losers = outcomes.filter((outcome) => !outcome.ok);

	assert.equal(winners.length, 1, `必须恰好一方新建成功，实际：${JSON.stringify(outcomes)}`);
	assert.equal(winners[0].status, "created");
	assert.equal(winners[0].revision, 0);
	assert.equal(losers[0].code, "revision-conflict");
	assert.equal(losers[0].expected, null);
	assert.equal(losers[0].actual, 0);

	const final = await readRecord({ root, kind: "experience-card", id });
	assert.equal(final.record.revision, 0);
	assert.equal(final.record.solution, `create-${winners[0].label}`, "输家不得覆盖赢家的内容");
	assert.equal(lockEntries(root).length, 0);
});

/* ------------------------------------------------------------------ §6.5 可见性 */

test("B4：提交前读者只见旧完整记录（临时文件与目标同目录且不叫目标名），提交后只见新完整记录", async () => {
	const root = await makeStoreRoot("visibility");
	const id = "exp-visibility";
	const path = recordPath(root, "experience-card", id);
	await createRecord({ root, kind: "experience-card", id, data: experienceBody("旧方案"), expectedRevision: null, now: NOW });
	const hashBefore = hashFile(path);

	// 在"临时文件已写完、`rename` 尚未发生"的窗口里**真的读一次**：
	// 读者必须看到旧的完整记录，而不是空文件/半截 JSON。
	const observations = [];
	let tempPath;
	const result = await updateRecord({
		root,
		kind: "experience-card",
		id,
		data: experienceBody("新方案"),
		expectedRevision: 0,
		now: LATER,
		ioHooks: {
			beforeIo: async (operation, targetPath) => {
				// journal 自己的提交也用 rename（终态），本用例只观察**业务目标**的替换窗口。
				if (isJournalPath(targetPath)) return;
				if (operation === "write-temp") tempPath = targetPath;
				if (operation !== "rename") return;
				const during = await readRecord({ root, kind: "experience-card", id });
				observations.push({ revision: during.record.revision, solution: during.record.solution, siblings: readdirSync(dirname(path)), targetHash: hashFile(path) });
			},
		},
	});

	assert.equal(observations.length, 1, "提交窗口只应出现一次");
	const during = observations[0];
	assert.equal(during.revision, 0, "提交前读者看到的是旧 revision");
	assert.equal(during.solution, "旧方案");
	assert.equal(during.targetHash, hashBefore, "窗口期内目标字节必须仍是旧内容");
	assert.ok(tempPath?.endsWith(".tmp"), `提交必须经由同目录临时文件：${tempPath}`);
	assert.equal(dirname(tempPath), dirname(path), "临时文件必须与目标同目录（`rename` 才是原子的）");
	assert.equal(during.siblings.filter((name) => name.endsWith(".tmp")).length, 1, "窗口内应恰好有一个临时文件");
	assert.equal(during.siblings.includes(`${id}.json`), true, "窗口内目标仍必须是旧的完整文件");

	// 提交后：新内容完整可见。
	assert.equal(result.revision, 1);
	const after = await readRecord({ root, kind: "experience-card", id });
	assert.equal(after.record.revision, 1);
	assert.equal(after.record.solution, "新方案");
	assert.equal(tempLeftovers(dirname(path)).length, 0);
});

test("B4：真实并发反复读写：读者不出现半 JSON/空文件，revision 单调不减", async () => {
	const root = await makeStoreRoot("concurrent-read-write");
	const id = "task-loop";
	await createRecord({ root, kind: "task-record", id, projectId: PROJECT_ID, data: taskBody("loop-0"), expectedRevision: null, now: NOW });

	const barrier = makeBarrier("loop");
	const reader = spawnNode(readerLoopScript({ root, kind: "task-record", id, projectId: PROJECT_ID, readyPath: barrier.ready("reader"), goPath: barrier.go, iterations: 60, delayMs: 2 }));
	const readerDone = reader.then(parseChildOutcome);
	await waitForPath(barrier.ready("reader"));
	writeFileSync(barrier.go, "1", "utf8");

	for (let revision = 0; revision < 15; revision += 1) {
		await updateRecord({ root, kind: "task-record", id, projectId: PROJECT_ID, data: taskBody(`loop-${revision + 1}`), expectedRevision: revision, now: LATER + revision });
		await new Promise((resolve) => setTimeout(resolve, 4));
	}

	const observed = await readerDone;
	assert.deepEqual(observed.errors, [], `并发读取不得出现任何错误（含半 JSON / 空文件）：${JSON.stringify(observed.errors)}`);
	assert.ok(observed.revisions.length > 0, "读者必须至少成功读到一次");
	for (let index = 1; index < observed.revisions.length; index += 1) {
		assert.ok(observed.revisions[index] >= observed.revisions[index - 1], `revision 不得倒退：${JSON.stringify(observed.revisions)}`);
	}
	// 读到过 > 0 说明读者确实观察到了更新；否则这次并发没有实际重叠。
	assert.ok(Math.max(...observed.revisions) >= 1, `读者必须观察到至少一次更新：${JSON.stringify(observed.revisions)}`);

	const final = await readRecord({ root, kind: "task-record", id, projectId: PROJECT_ID });
	assert.equal(final.record.revision, 15);
	assert.equal(final.record.requirement, "loop-15");
});

/* ------------------------------------------------------------------ §6.6 跨进程锁 */

test("B2：锁等待超时 → lock-timeout，不写目标、不删除他人锁", async () => {
	const root = await makeStoreRoot("lock-timeout");
	const id = "exp-locked";
	const path = recordPath(root, "experience-card", id);
	await createRecord({ root, kind: "experience-card", id, data: experienceBody("held"), expectedRevision: null, now: NOW });
	const hashBefore = hashFile(path);

	// 用**另一个进程外**的持有者占住同一个目标：写入必须等待并最终超时，而不是抢占。
	const boundary = await createStorageBoundary({ root });
	const holder = await acquireStorageLock(boundary, { target: path, now: NOW });
	try {
		await assert.rejects(
			() => updateRecord({ root, kind: "experience-card", id, data: experienceBody("should-not-apply"), expectedRevision: 0, lockTimeoutMs: 120, lockPollMs: 15 }),
			(error) => isStorageError("lock-timeout")(error) && String(error.detail).includes("ownerId="),
		);

		assert.equal(hashFile(path), hashBefore, "锁超时不得改动目标");
		assert.equal(tempLeftovers(dirname(path)).length, 0, "锁超时不得留下临时文件");
		assert.deepEqual(lockEntries(root), [holder.key], "写入层不得删除/抢占他人的锁目录");
	} finally {
		assert.equal(await holder.release(), "released");
	}
	assert.equal(lockEntries(root).length, 0, "持有者释放后不得留下锁");
});

test("B2：锁等待期间取消 → cancelled，不写目标", async () => {
	const root = await makeStoreRoot("lock-cancel");
	const id = "exp-cancel-wait";
	const path = recordPath(root, "experience-card", id);
	await createRecord({ root, kind: "experience-card", id, data: experienceBody("held"), expectedRevision: null, now: NOW });
	const hashBefore = hashFile(path);

	const boundary = await createStorageBoundary({ root });
	const holder = await acquireStorageLock(boundary, { target: path, now: NOW });
	const controller = new AbortController();
	try {
		await assert.rejects(
			() =>
				updateRecord({
					root,
					kind: "experience-card",
					id,
					data: experienceBody("cancelled"),
					expectedRevision: 0,
					signal: controller.signal,
					lockTimeoutMs: 30_000,
					lockPollMs: 20,
					// 第一次尝试确认锁已被占用后立刻取消：等待循环必须在"下一次轮询前"退出，
					// 而不是把 30 秒等完再抛。
					ioHooks: {
						beforeIo: (operation) => {
							if (operation === "lock-mkdir") controller.abort();
						},
					},
				}),
			isStorageError("cancelled"),
		);
		assert.equal(hashFile(path), hashBefore, "等待期间取消不得改动目标");
		assert.deepEqual(lockEntries(root), [holder.key]);
	} finally {
		await holder.release();
	}
});

test("B2：写入因 revision 冲突失败时释放自有锁，不留锁目录也不留临时文件", async () => {
	const root = await makeStoreRoot("lock-release-on-failure");
	const id = "exp-release";
	const path = recordPath(root, "experience-card", id);
	await createRecord({ root, kind: "experience-card", id, data: experienceBody("v0"), expectedRevision: null, now: NOW });

	await assert.rejects(() => updateRecord({ root, kind: "experience-card", id, data: experienceBody("v1"), expectedRevision: 7 }), isStorageError("revision-conflict"));
	assert.equal(lockEntries(root).length, 0, "失败路径也必须释放自己的锁");
	assert.equal(tempLeftovers(dirname(path)).length, 0);
});

test("B2：只释放自己的锁：ownerId 不匹配时报 not-owner 且不删除锁目录", async () => {
	const root = await makeStoreRoot("lock-not-owner");
	const path = recordPath(root, "experience-card", "exp-not-owner");
	const boundary = await createStorageBoundary({ root });
	const holder = await acquireStorageLock(boundary, { target: path, now: NOW });

	// 模拟锁目录被别的持有者接管（例如上一次运行的残留被人工替换）。
	writeFileSync(join(holder.path, "owner.json"), `${JSON.stringify({ ownerId: "someone-else", pid: 1, createdAt: NOW, target: "x" }, null, "\t")}\n`, "utf8");
	assert.equal(await holder.release(), "not-owner", "ownerId 不匹配时不得删除");
	assert.equal(existsSync(holder.path), true);

	// 元数据整体缺失同样只报 missing。
	rmSync(join(holder.path, "owner.json"), { force: true });
	assert.equal(await holder.release(), "missing");
	assert.equal(existsSync(holder.path), true);
	rmSync(holder.path, { recursive: true, force: true });
});

test("B2：遗留/损坏锁不自动抢占，只按忙碌超时", async () => {
	const root = await makeStoreRoot("lock-legacy");
	const id = "exp-legacy";
	const path = recordPath(root, "experience-card", id);
	await createRecord({ root, kind: "experience-card", id, data: experienceBody("v0"), expectedRevision: null, now: NOW });
	const hashBefore = hashFile(path);

	const boundary = await createStorageBoundary({ root });
	const holder = await acquireStorageLock(boundary, { target: path, now: NOW });
	const metaPath = join(holder.path, "owner.json");
	try {
		// 损坏元数据：无法判断持有者是否存活，因此按忙碌处理。
		writeFileSync(metaPath, "{ 半个 JSON", "utf8");
		await assert.rejects(() => updateRecord({ root, kind: "experience-card", id, data: experienceBody("v1"), expectedRevision: 0, lockTimeoutMs: 100, lockPollMs: 15 }), isStorageError("lock-timeout"));
		assert.equal(existsSync(holder.path), true, "损坏锁不得被抢占或删除");

		// 元数据缺失：同样不抢占。
		rmSync(metaPath, { force: true });
		await assert.rejects(
			() => updateRecord({ root, kind: "experience-card", id, data: experienceBody("v1"), expectedRevision: 0, lockTimeoutMs: 100, lockPollMs: 15 }),
			(error) => isStorageError("lock-timeout")(error) && String(error.detail).includes("不可读"),
		);
		assert.equal(existsSync(holder.path), true, "缺失元数据的锁不得被抢占");

		assert.equal(hashFile(path), hashBefore, "整个过程中目标字节不得改变");
	} finally {
		rmSync(holder.path, { recursive: true, force: true });
	}
});

/* ------------------------------------------------------------------ §6.7 故障注入与提交前取消 */

test("B3：临时写 / sync / rename 注入失败：原字节不变、无残留、随后仍能正常写入", async (t) => {
	for (const operation of ["write-temp", "sync", "rename"]) {
		await t.test(`注入失败：${operation}`, async () => {
			const root = await makeStoreRoot(`fault-${operation}`);
			const id = "exp-fault";
			const path = recordPath(root, "experience-card", id);
			await createRecord({ root, kind: "experience-card", id, data: experienceBody("v0"), expectedRevision: null, now: NOW });
			const hashBefore = hashFile(path);

			const injected = Object.assign(new Error(`注入的磁盘故障：${operation}`), { code: "EIO" });
			await assert.rejects(
				// 只对**业务目标**的 IO 注入：journal 的记账失败是另一条边界（另有专门用例）。
				() => updateRecord({ root, kind: "experience-card", id, data: experienceBody("v1"), expectedRevision: 0, now: LATER, ioHooks: { beforeIo: (current, target) => (current === operation && !isJournalPath(target) ? Promise.reject(injected) : undefined) } }),
				// 注入的是 EIO：既不能被吞掉，也不能被伪装成取消。
				// `write-temp` / `sync` 走文件 IO 的错误映射；`rename` 的注入点在
				// 原子替换的提交块之前，按原样抛出（生产路径没有钩子，这里只验证清理）。
				(error) => (error instanceof StorageError && error.code === "permission-denied" && String(error.detail).includes("EIO")) || error === injected,
			);

			assert.equal(hashFile(path), hashBefore, `${operation} 失败后原字节必须不变（不能"改了一半"）`);
			assert.equal(tempLeftovers(dirname(path)).length, 0, `${operation} 失败后不得残留临时文件`);
			assert.equal(lockEntries(root).length, 0, `${operation} 失败后必须释放锁`);

			// 句柄都必须关闭：失败的提交之后同一路径仍能正常提交。
			const recovered = await updateRecord({ root, kind: "experience-card", id, data: experienceBody("v1"), expectedRevision: 0, now: LATER });
			assert.equal(recovered.revision, 1);
			assert.equal(recovered.cleanup, "ok");
		});
	}
});

test("B3：提交前（rename 之前）取消：原字节不变、无残留", async () => {
	const root = await makeStoreRoot("cancel-before-commit");
	const id = "exp-cancel";
	const path = recordPath(root, "experience-card", id);
	await createRecord({ root, kind: "experience-card", id, data: experienceBody("v0"), expectedRevision: null, now: NOW });
	const hashBefore = hashFile(path);

	const controller = new AbortController();
	await assert.rejects(
		() =>
			updateRecord({
				root,
				kind: "experience-card",
				id,
				data: experienceBody("v1"),
				expectedRevision: 0,
				now: LATER,
				signal: controller.signal,
				ioHooks: {
					beforeIo: (operation, target) => {
						// 数据提交点（业务目标的 rename）之前取消；journal 的终态 rename 不算提交点。
						if (operation === "rename" && !isJournalPath(target)) controller.abort();
					},
				},
			}),
		isStorageError("cancelled"),
	);

	assert.equal(hashFile(path), hashBefore, "提交前取消不得改动目标");
	assert.equal(tempLeftovers(dirname(path)).length, 0, "提交前取消必须清掉自己的临时文件");
	assert.equal(lockEntries(root).length, 0, "提交前取消必须释放锁");

	// 取消不损坏后续写入。
	const after = await updateRecord({ root, kind: "experience-card", id, data: experienceBody("v1"), expectedRevision: 0, now: LATER });
	assert.equal(after.revision, 1);
});

/* ------------------------------------------------------------------ §6.8 提交点之后的迟到取消 */

test("B3：提交成功后的迟到取消仍报告真实 updated（不假称回滚），锁释放失败如实上报", async () => {
	const root = await makeStoreRoot("late-cancel");
	const id = "exp-late";
	const path = recordPath(root, "experience-card", id);
	await createRecord({ root, kind: "experience-card", id, data: experienceBody("v0"), expectedRevision: null, now: NOW });

	const controller = new AbortController();
	// `rename` 之后、释放锁时才取消：内容已经生效，返回值必须反映真实状态。
	// 同时注入"锁目录删不掉"的故障，验证释放结果被如实上报而不是吞掉。
	const result = await updateRecord({
		root,
		kind: "experience-card",
		id,
		data: experienceBody("v1"),
		expectedRevision: 0,
		now: LATER,
		signal: controller.signal,
		ioHooks: {
			beforeIo: (operation) => {
				if (operation !== "lock-remove") return;
				controller.abort();
				return Promise.reject(Object.assign(new Error("注入的故障：锁目录无法删除"), { code: "EBUSY" }));
			},
		},
	});

	assert.equal(result.status, "updated", "已提交就不能因为迟到的取消改口");
	assert.equal(result.revision, 1);
	assert.equal(result.lockRelease, "failed", "释放失败必须如实上报，而不是吞掉");
	// 返回值与磁盘状态一致：不是"报了成功但其实没落盘"。
	const after = await readRecord({ root, kind: "experience-card", id });
	assert.equal(after.record.revision, 1);
	assert.equal(after.record.solution, "v1");

	// 残留锁是"释放失败"的可见后果，人工确认后清理，不能靠抢占自愈。
	assert.equal(lockEntries(root).length, 1);
	rmSync(join(root, "locks", lockEntries(root)[0]), { recursive: true, force: true });
	assert.equal(lockEntries(root).length, 0);
});

/* ------------------------------------------------------------------ §6.9 安全与预算 */

test("B4：非法 kind / 非法 ID / 归属参数错误在写文件前结构化拒绝，不取锁不落盘", async () => {
	const root = await makeStoreRoot("write-guards");

	await assert.rejects(() => createRecord({ root, kind: "not-a-kind", id: "exp-guard", data: experienceBody("x"), expectedRevision: null }), isStorageError("invalid-record", "unknown-record-kind"));
	await assert.rejects(() => createRecord({ root, kind: "experience-card", id: "Exp_Bad", data: experienceBody("x"), expectedRevision: null }), isStorageError("invalid-record"));
	await assert.rejects(() => createRecord({ root, kind: "task-record", id: "task-guard", data: taskBody("x"), expectedRevision: null }), isStorageError("invalid-record", "missing-project-id"));
	await assert.rejects(() => createRecord({ root, kind: "feature-record", id: "feature-guard", projectId: PROJECT_ID, data: featureBody("x"), expectedRevision: null }), isStorageError("invalid-record", "unexpected-project-id"));
	await assert.rejects(() => createRecord({ root, kind: "project-profile", id: PROJECT_ID, projectId: OTHER_PROJECT_ID, data: profileBody(), expectedRevision: null }), isStorageError("record-id-mismatch", "profile-project-mismatch"));
	// 存储层托管的字段不接受调用方覆盖：否则 ID/归属会与路径矛盾。
	await assert.rejects(() => createRecord({ root, kind: "experience-card", id: "exp-guard", data: { ...experienceBody("x"), revision: 99 }, expectedRevision: null }), isStorageError("invalid-record", "managed-key-in-body"));

	assert.deepEqual(lockEntries(root), [], "参数错误不得占用锁");
	assert.deepEqual(readdirSync(join(root, "experiences")), [], "参数错误不得留下任何记录文件");
	assert.deepEqual(readdirSync(join(root, "features")), []);
});

test("B4：超大写入被限额拒绝，目标不创建、不残留", async () => {
	const root = await makeStoreRoot("write-budget");
	const id = "exp-budget";
	const limits = { ...DEFAULT_STORAGE_LIMITS, maxRecordBytes: 4_096 };
	const huge = experienceBody("x".repeat(64 * 1024));
	const path = recordPath(root, "experience-card", id);

	await assert.rejects(() => createRecord({ root, kind: "experience-card", id, data: huge, expectedRevision: null, limits }), isStorageError("too-large"));
	assert.equal(existsSync(path), false, "超限写入不得创建目标");
	assert.equal(tempLeftovers(dirname(path)).length, 0);
	assert.deepEqual(lockEntries(root), []);

	// 同样的数据在小预算下被拒，但在默认预算下必须能正常落盘（证明拒绝来自预算而非数据结构）。
	const allowed = await createRecord({ root, kind: "experience-card", id, data: huge, expectedRevision: null });
	assert.ok(allowed.bytes > 64 * 1024);
});

test("B4：根内目录被换成 junction 时拒绝写入，根外内容不变", async (t) => {
	const root = await makeStoreRoot("write-junction");
	const outside = makeRawRoot("outside-target");
	const sentinel = join(outside, "sentinel.txt");
	writeFileSync(sentinel, "must-not-change", "utf8");

	const experiences = join(root, "experiences");
	rmSync(experiences, { recursive: true, force: true });
	try {
		symlinkSync(outside, experiences, "junction");
	} catch (error) {
		t.skip(`本机不支持创建 junction（${error.code ?? error.message}）`);
		return;
	}

	const id = "exp-escape";
	await assert.rejects(() => createRecord({ root, kind: "experience-card", id, data: experienceBody("escape"), expectedRevision: null }), isStorageError("symlink-rejected"));

	assert.equal(readFileSync(sentinel, "utf8"), "must-not-change", "根外内容不得被改写");
	assert.deepEqual(readdirSync(outside).sort(), ["sentinel.txt"], "根外不得多出任何文件");
	assert.deepEqual(lockEntries(root), []);
});

test("B4：知识库未初始化时拒绝写入，不留下半初始化的目录树", async () => {
	const raw = makeRawRoot("write-uninitialized");
	await assert.rejects(() => createRecord({ root: raw, kind: "experience-card", id: "exp-raw", data: experienceBody("x"), expectedRevision: null }), isStorageError("not-found", "store-not-initialized"));
	await assert.rejects(() => updateRecord({ root: raw, kind: "experience-card", id: "exp-raw", data: experienceBody("x"), expectedRevision: 0 }), isStorageError("not-found", "store-not-initialized"));
	assert.equal(existsSync(join(raw, "experiences")), false, "未初始化时不得创建记录目录");
});

/* ====================================================================================================
 * §W1–W4 补丁回归（BM-02BR：第一轮验收指出的 4 类漏洞）
 *
 * 这一节刻意都用**同一条产品路径**复现问题，而不是直接调内部函数：
 * 上一轮的问题恰恰是"单看某个函数是对的，合起来在多进程/异常路径下不对"。
 * ================================================================================================== */

/** 写一份结构合法的 registry，用于构造 revision 边界与损坏场景。 */
function writeRegistryFile(root, overrides = {}) {
	const path = join(root, "registry.json");
	const value = { schemaVersion: 1, revision: 0, createdAt: NOW, updatedAt: NOW, projects: [], ...overrides };
	writeFileSync(path, `${JSON.stringify(value, null, "\t")}\n`, "utf8");
	return path;
}

function projectFixture() {
	return { biosProjectId: PROJECT_ID, workspaces: [], createdAt: NOW, updatedAt: NOW };
}

/** 目录也可能是"路径"（例如被换成目录的 registry.json），因此不能直接 `readFileSync`。 */
function safeHash(path) {
	try {
		return createHash("sha256").update(readFileSync(path)).digest("hex");
	} catch {
		return null;
	}
}

/* ------------------------------------------------------------------ W1：统一安全 revision */

test("W1：expectedRevision 的非安全整数（NaN/Infinity/2^53）一律拒绝，不落盘不留锁", async () => {
	const root = await makeStoreRoot("w1-expected-shape");
	const id = "exp-w1-shape";
	const path = recordPath(root, "experience-card", id);
	await createRecord({ root, kind: "experience-card", id, data: experienceBody("v0"), expectedRevision: null, now: NOW });
	const pathHash = hashFile(path);
	const registryPath = join(root, "registry.json");
	const registryHash = hashFile(registryPath);

	// `Number.isInteger` 放过了 2^53——`x + 1 === x`，乐观并发控制就此失效。
	for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 2 ** 53, -(2 ** 53), 0.5]) {
		await assert.rejects(() => updateRecord({ root, kind: "experience-card", id, data: experienceBody("bad"), expectedRevision: bad }), isStorageError("revision-conflict", "invalid-expected-revision"), `expectedRevision=${String(bad)} 必须被拒绝`);
	}
	// registry 与记录必须共用同一套形态校验（否则就是从另一扇门放进同一个漏洞）。
	for (const bad of [Number.NaN, 2 ** 53]) {
		await assert.rejects(() => updateRegistry({ root, expectedRevision: bad, projects: [] }), isStorageError("revision-conflict", "invalid-expected-revision"));
	}

	assert.equal(hashFile(path), pathHash, "被拒绝的提交不得改动记录原字节");
	assert.equal(hashFile(registryPath), registryHash, "被拒绝的提交不得改动 registry");
	assert.deepEqual(lockEntries(root), []);
});

test("W1：已不安全 revision 的记录与 registry 都拒绝递增，先于冲突判定且原字节不变", async () => {
	const root = await makeStoreRoot("w1-unsafe-current");
	const id = "exp-unsafe";
	const path = recordPath(root, "experience-card", id);
	// 2^53：仍是"整数"，但 `+1` 不再改变它。
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify({ schemaVersion: 1, revision: 2 ** 53, createdAt: NOW, updatedAt: NOW, id, ...experienceBody("unsafe") }, null, "\t")}\n`, "utf8");
	const pathHash = hashFile(path);

	// 故意给"安全但不等"的 expectedRevision：如果实现只把不一致当普通冲突，
	// 就无法区分"别人抢先写了"和"这个文件本身已经坏到不能递增"。
	await assert.rejects(() => updateRecord({ root, kind: "experience-card", id, data: experienceBody("next"), expectedRevision: 0 }), isStorageError("revision-conflict", "unsafe-current-revision"));
	assert.equal(hashFile(path), pathHash, "拒绝时不得改写记录");

	const registryPath = writeRegistryFile(root, { revision: 2 ** 53 });
	const registryHash = hashFile(registryPath);
	await assert.rejects(() => updateRegistry({ root, expectedRevision: 0, projects: [] }), isStorageError("revision-conflict", "unsafe-current-revision"));
	assert.equal(hashFile(registryPath), registryHash, "拒绝时不得改写 registry");
	assert.deepEqual(lockEntries(root), []);
});

test("W1：registry 达到 MAX_SAFE_INTEGER 时拒绝递增（与记录共用同一套上限判断）", async () => {
	const root = await makeStoreRoot("w1-registry-overflow");
	const registryPath = writeRegistryFile(root, { revision: Number.MAX_SAFE_INTEGER });
	const before = hashFile(registryPath);

	await assert.rejects(() => updateRegistry({ root, expectedRevision: Number.MAX_SAFE_INTEGER, projects: [] }), isStorageError("revision-conflict", "revision-overflow"));
	assert.equal(hashFile(registryPath), before, "溢出拒绝不得改写 registry");
	assert.deepEqual(lockEntries(root), []);
});

test("W1：registry 更新沿用公共头（schemaVersion/createdAt 保持，updatedAt 不倒退）", async () => {
	const root = await makeStoreRoot("w1-header-reuse");
	const before = await readRegistry({ root });

	const result = await updateRegistry({ root, expectedRevision: 0, projects: [], now: 1 });
	const after = await readRegistry({ root });
	assert.equal(result.revision, 1);
	assert.equal(after.schemaVersion, before.schemaVersion, "写入不是升级结构的机会");
	assert.equal(after.createdAt, before.createdAt, "createdAt 表达'这条记录何时出现'，不因后续写入改变");
	assert.equal(after.updatedAt, Math.max(1, before.updatedAt), "注入更早的时钟也不得让 updatedAt 倒退");

	// 记录走同一份生成逻辑，行为必须一致。
	const id = "exp-w1-header";
	await createRecord({ root, kind: "experience-card", id, data: experienceBody("v0"), expectedRevision: null, now: LATER });
	const updated = await updateRecord({ root, kind: "experience-card", id, data: experienceBody("v1"), expectedRevision: 0, now: NOW });
	assert.equal(updated.record.createdAt, LATER);
	assert.equal(updated.record.updatedAt, LATER, "时钟回拨时 updatedAt 不倒退");
});

/* ------------------------------------------------------------------ W2：锁参数、诊断与取消 */

test("W2：非法锁时序参数在入口结构化拒绝，不取锁、不落盘、不等待", async () => {
	const root = await makeStoreRoot("w2-bad-timing");
	const id = "exp-w2";
	const path = recordPath(root, "experience-card", id);
	await createRecord({ root, kind: "experience-card", id, data: experienceBody("v0"), expectedRevision: null, now: NOW });
	const pathHash = hashFile(path);
	const update = (extra) => updateRecord({ root, kind: "experience-card", id, data: experienceBody("bad"), expectedRevision: 0, ...extra });

	// NaN 会让 `Date.now() + NaN >= deadline` 永远为假 → 无界自旋；Infinity 同理；
	// 负值/小数/超过定时器上界都是"调用方写错了"，必须立刻拒绝而不是猜。
	for (const lockTimeoutMs of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5, 2 ** 31, Number.MAX_SAFE_INTEGER]) {
		await assert.rejects(() => update({ lockTimeoutMs }), isStorageError("invalid-limits", "timeoutMs"), `lockTimeoutMs=${String(lockTimeoutMs)}`);
	}
	// pollMs 必须为正：0 等于忙等，会把这个进程的 CPU 全吃掉。
	for (const lockPollMs of [0, Number.NaN, Number.POSITIVE_INFINITY, -5, 1.5]) {
		await assert.rejects(() => update({ lockPollMs }), isStorageError("invalid-limits", "pollMs"), `lockPollMs=${String(lockPollMs)}`);
	}
	// now 超出 Date 可表示范围会在诊断格式化时炸出 RangeError。
	for (const now of [Number.NaN, -1, 1.5, 8_640_000_000_000_001]) {
		await assert.rejects(() => update({ now }), isStorageError("invalid-limits", "now"), `now=${String(now)}`);
	}

	// 三条写入路径共用同一份校验，不能只拦住其中一条。
	await assert.rejects(() => createRecord({ root, kind: "experience-card", id: "exp-w2b", data: experienceBody("x"), expectedRevision: null, lockTimeoutMs: Number.NaN }), isStorageError("invalid-limits"));
	await assert.rejects(() => updateRegistry({ root, expectedRevision: 0, projects: [], lockPollMs: 0 }), isStorageError("invalid-limits"));

	// 直接调公共锁入口也必须同样受保护（它是导出的 API，不只是写入路径的内部实现）。
	const boundary = await createStorageBoundary({ root });
	await assert.rejects(() => acquireStorageLock(boundary, { target: path, timeoutMs: Number.NaN }), isStorageError("invalid-limits"));
	await assert.rejects(() => acquireStorageLock(boundary, { target: path, timeoutMs: 0, pollMs: 0 }), isStorageError("invalid-limits"));

	assert.equal(hashFile(path), pathHash, "非法参数不得改动目标");
	assert.deepEqual(lockEntries(root), [], "非法参数不得产生任何锁");
});

test("W2：极端/损坏的锁元数据只按忙碌处理：有界超时、不抛 RangeError、不被抢占", async () => {
	const root = await makeStoreRoot("w2-meta-hostile");
	const id = "exp-w2-meta";
	const path = recordPath(root, "experience-card", id);
	await createRecord({ root, kind: "experience-card", id, data: experienceBody("v0"), expectedRevision: null, now: NOW });
	const pathHash = hashFile(path);

	const boundary = await createStorageBoundary({ root });
	const holder = await acquireStorageLock(boundary, { target: path, now: NOW, timeoutMs: 1_000 });
	const metaPath = join(holder.path, "owner.json");
	try {
		const hostileMetas = [
			// 1e100 是合法 number，但 `new Date(1e100).toISOString()` 抛 RangeError——旧实现会把它当成"内部错误"。
			{ ownerId: "holder", pid: 1, createdAt: 1e100, target: "x" },
			{ ownerId: "holder", pid: Number.NaN, createdAt: -1, target: "x" },
			{ ownerId: "x".repeat(4096), pid: 1, createdAt: NOW, target: "x" },
			// 元数据文件本身超过有界读取上限。
			{ ownerId: "holder", pid: 1, createdAt: NOW, target: "x".repeat(100_000) },
			{ ownerId: 42, pid: "1", createdAt: [NOW], target: null },
		];
		for (const meta of hostileMetas) {
			writeFileSync(metaPath, JSON.stringify(meta), "utf8");
			// timeout=0：只要元数据被当成"忙碌"，就必须给出一个有界的超时结论。
			const error = await updateRecord({ root, kind: "experience-card", id, data: experienceBody("v1"), expectedRevision: 0, lockTimeoutMs: 0 }).then(
				() => null,
				(thrown) => thrown,
			);
			assert.ok(error instanceof StorageError && error.code === "lock-timeout", `恶意元数据必须只按"忙碌"处理，实际：${error?.stack ?? String(error)}`);
			assert.ok(String(error.message).length < 2_000, `诊断消息必须有界，实际长度 ${String(error.message).length}`);
			assert.equal(existsSync(holder.path), true, "元数据不可读时绝不抢占/删除锁");
		}
		assert.equal(hashFile(path), pathHash, "等待锁失败不得改动目标");
	} finally {
		rmSync(holder.path, { recursive: true, force: true });
	}
});

test("W2：等待读锁诊断期间取消优先于超时（取消与截止同时成立仍报 cancelled）", async () => {
	const root = await makeStoreRoot("w2-cancel-read");
	const id = "exp-w2-cancel";
	const path = recordPath(root, "experience-card", id);
	await createRecord({ root, kind: "experience-card", id, data: experienceBody("v0"), expectedRevision: null, now: NOW });

	const boundary = await createStorageBoundary({ root });
	const holder = await acquireStorageLock(boundary, { target: path, now: NOW, timeoutMs: 1_000 });
	try {
		const controller = new AbortController();
		await assert.rejects(
			() =>
				updateRecord({
					root,
					kind: "experience-card",
					id,
					data: experienceBody("v1"),
					expectedRevision: 0,
					// 故意 timeout=0：若没有"读诊断之后、判定超时之前"的取消复查，
					// 这里会报 lock-timeout，把"用户已经取消"误导成"对方一直占着锁"。
					lockTimeoutMs: 0,
					signal: controller.signal,
					ioHooks: {
						beforeIo: (operation) => {
							if (operation === "lock-read") controller.abort();
						},
					},
				}),
			isStorageError("cancelled"),
		);
		assert.equal(existsSync(holder.path), true, "取消不得删除别人的锁");
	} finally {
		rmSync(holder.path, { recursive: true, force: true });
	}
});

test("W2：锁等待对 boundary 与调用方两个 signal 都敏感（任一方取消即生效）", async () => {
	const root = await makeStoreRoot("w2-two-signals");
	const id = "exp-w2-two";
	const path = recordPath(root, "experience-card", id);
	await createRecord({ root, kind: "experience-card", id, data: experienceBody("v0"), expectedRevision: null, now: NOW });

	const boundaryController = new AbortController();
	const boundary = await createStorageBoundary({ root, signal: boundaryController.signal });
	const holder = await acquireStorageLock(boundary, { target: path, now: NOW, timeoutMs: 1_000 });
	try {
		// 只动调用方 signal：boundary 自己的 signal 保持健康。
		const callController = new AbortController();
		const viaCall = acquireStorageLock(boundary, { target: path, signal: callController.signal, timeoutMs: 5_000, pollMs: 10 });
		setTimeout(() => callController.abort(), 20);
		await assert.rejects(() => viaCall, isStorageError("cancelled"), "调用方 signal 必须生效");

		// 只动 boundary signal：调用方 signal 保持健康。
		const viaBoundary = acquireStorageLock(boundary, { target: path, timeoutMs: 5_000, pollMs: 10 });
		setTimeout(() => boundaryController.abort(), 20);
		await assert.rejects(() => viaBoundary, isStorageError("cancelled"), "boundary signal 必须生效");
	} finally {
		rmSync(holder.path, { recursive: true, force: true });
	}
});

test("W2：合法但超长的 poll 不得让等待越过 timeout 预算", async () => {
	const root = await makeStoreRoot("w2-poll-over-deadline");
	const id = "exp-w2-poll";
	const path = recordPath(root, "experience-card", id);
	await createRecord({ root, kind: "experience-card", id, data: experienceBody("v0"), expectedRevision: null, now: NOW });

	const boundary = await createStorageBoundary({ root });
	const holder = await acquireStorageLock(boundary, { target: path, now: NOW, timeoutMs: 1_000 });
	// 有界 watchdog 只做兜底（防止实现真的无界等待把测试挂死），
	// **不能**让它成为测试结束的原因——否则"取消"会冒充"超时"通过。
	const controller = new AbortController();
	const watchdog = setTimeout(() => controller.abort(), 5_000);
	try {
		const startedAt = Date.now();
		const error = await updateRecord({
			root,
			kind: "experience-card",
			id,
			data: experienceBody("v1"),
			expectedRevision: 0,
			// 10ms 预算配 1000ms 轮询：两者都合法，但等待必须被裁到剩余预算。
			lockTimeoutMs: 10,
			lockPollMs: 1_000,
			signal: controller.signal,
		}).then(
			() => null,
			(thrown) => thrown,
		);
		const elapsed = Date.now() - startedAt;

		assert.ok(error instanceof StorageError && error.code === "lock-timeout", `必须以超时收场（既不是取消也不是成功），实际：${error?.stack ?? String(error)}`);
		assert.ok(elapsed < 500, `poll(1000ms) 不得把 10ms 预算拖成实等 ${elapsed}ms`);
		assert.equal(existsSync(holder.path), true, "超时不得删除/抢占别人的锁");
	} finally {
		clearTimeout(watchdog);
		rmSync(holder.path, { recursive: true, force: true });
	}
});

test("W2：timeout=0 只尝试一次并立刻给出超时结论（不进入等待）", async () => {
	const root = await makeStoreRoot("w2-zero-timeout");
	const id = "exp-w2-zero";
	const path = recordPath(root, "experience-card", id);
	await createRecord({ root, kind: "experience-card", id, data: experienceBody("v0"), expectedRevision: null, now: NOW });

	const boundary = await createStorageBoundary({ root });
	const holder = await acquireStorageLock(boundary, { target: path, now: NOW, timeoutMs: 1_000 });
	try {
		const startedAt = Date.now();
		const error = await acquireStorageLock(boundary, { target: path, timeoutMs: 0, pollMs: 1_000 }).then(
			() => null,
			(thrown) => thrown,
		);
		assert.ok(error instanceof StorageError && error.code === "lock-timeout", `timeout=0 必须只试一次就报超时，实际：${error?.stack ?? String(error)}`);
		assert.ok(String(error.message).includes("尝试 1 次"), `timeout=0 不得再次尝试，实际消息：${String(error.message)}`);
		assert.ok(Date.now() - startedAt < 500, "timeout=0 不得进入 wait 循环");
	} finally {
		rmSync(holder.path, { recursive: true, force: true });
	}
});

test("W2：托管字段/正文形态错误在取锁之前拒绝（不排队、不留锁）", async () => {
	const root = await makeStoreRoot("w2-prescreen");
	const badBodies = [[], null, "text", 42];
	for (const data of badBodies) {
		await assert.rejects(() => createRecord({ root, kind: "experience-card", id: "exp-w2-pre", data, expectedRevision: null }), isStorageError("invalid-record", "invalid-body"));
	}
	// 存储层管理的字段不允许由调用方塞进正文。
	await assert.rejects(() => createRecord({ root, kind: "experience-card", id: "exp-w2-pre", data: experienceBody("x", { revision: 9 }), expectedRevision: null }), isStorageError("invalid-record", "managed-key-in-body"));
	assert.equal(existsSync(recordPath(root, "experience-card", "exp-w2-pre")), false, "形态错误的提交不得落下记录");
	assert.deepEqual(lockEntries(root), [], "形态错误的提交不得留下锁");
});

/* ------------------------------------------------------------------ W3：准备/发布/清理闭环 */

test("W3：准备阶段 close 失败必须中止提交（原字节不变、无残留、错误码如实）", async () => {
	const root = await makeStoreRoot("w3-close-fail");
	const id = "exp-w3-close";
	const path = recordPath(root, "experience-card", id);
	await createRecord({ root, kind: "experience-card", id, data: experienceBody("v0"), expectedRevision: null, now: NOW });
	const pathHash = hashFile(path);

	let closeCalls = 0;
	await assert.rejects(
		() =>
			updateRecord({
				root,
				kind: "experience-card",
				id,
				data: experienceBody("v1"),
				expectedRevision: 0,
				now: LATER,
				ioHooks: {
					// "实际先关后抛"：句柄真的关掉了，close 仍然返回错误。
					// 只对**业务目标**的临时文件注入：journal 的记账另有专门用例。
					closeFile: async (handle, tempPath) => {
						await handle.close();
						if (isJournalPath(tempPath)) return;
						closeCalls += 1;
						throw Object.assign(new Error("注入的故障：close 失败"), { code: "EIO" });
					},
				},
			}),
		isStorageError("permission-denied", "EIO"),
	);

	assert.ok(closeCalls >= 1, "close 必须真的被调用过");
	assert.equal(hashFile(path), pathHash, "close 失败 = 提交尚未成立，目标不得改变");
	assert.equal(tempLeftovers(dirname(path)).length, 0, "close 失败后必须清掉临时文件");
	assert.deepEqual(lockEntries(root), [], "close 失败后必须释放锁");

	// 句柄生命周期正确的话，同一路径随后仍能正常提交。
	const recovered = await updateRecord({ root, kind: "experience-card", id, data: experienceBody("v1"), expectedRevision: 0, now: LATER });
	assert.equal(recovered.revision, 1);
});

test("W3：失败路径上的清理失败只作附加诊断，不覆盖原错误码，也不泄漏正文", async () => {
	const root = await makeStoreRoot("w3-cleanup-note");
	const secret = "SECRET-BODY-MUST-NOT-LEAK";
	const thrown = await createRecord({
		root,
		kind: "experience-card",
		id: "exp-w3-cleanup",
		data: experienceBody(secret),
		expectedRevision: null,
		ioHooks: {
			beforeIo: (operation, target) => {
				// 只对**业务目标**注入（journal 的记账失败另有专门用例）。
				if (isJournalPath(target)) return undefined;
				// 在 `sync` 上失败：此时临时文件**已经建好并写了内容**，才有"清理"这一步可谈。
				if (operation === "sync") return Promise.reject(Object.assign(new Error("注入：落盘失败"), { code: "EIO" }));
				if (operation === "unlink-temp") return Promise.reject(Object.assign(new Error("注入：删除失败"), { code: "EIO" }));
				return undefined;
			},
		},
	}).then(
		() => null,
		(error) => error,
	);

	assert.ok(thrown instanceof StorageError, `必须抛 StorageError，实际：${thrown}`);
	assert.equal(thrown.code, "permission-denied", "清理失败不得覆盖原错误码");
	assert.ok(String(thrown.detail ?? "").includes("EIO"), "原错误的可行动细节必须保留");
	assert.ok(String(thrown.message).includes("清理失败"), "清理失败必须如实附加为诊断");
	assert.ok(!String(thrown.message).includes(secret), "错误消息不得携带客户正文");

	const dir = dirname(recordPath(root, "experience-card", "exp-w3-cleanup"));
	const leftover = tempLeftovers(dir);
	assert.equal(leftover.length, 1, "清理失败会留下临时文件——这正是被如实报告的那件事");
	for (const name of leftover) rmSync(join(dir, name), { force: true });
	assert.deepEqual(lockEntries(root), []);
});

test("W3：失败路径上的自有锁释放失败必须作为附加诊断，不覆盖原错误", async () => {
	const root = await makeStoreRoot("w3-lock-release-fail");
	const secret = "SECRET-BODY-MUST-NOT-LEAK";
	const id = "exp-w3-lockrel";
	const path = recordPath(root, "experience-card", id);
	await createRecord({ root, kind: "experience-card", id, data: experienceBody("v0"), expectedRevision: null, now: NOW });
	const pathHash = hashFile(path);

	const thrown = await updateRecord({
		root,
		kind: "experience-card",
		id,
		data: experienceBody(secret),
		// revision 冲突是**原错误**：锁释放失败不能把它替换成"锁释放失败"。
		expectedRevision: 99,
		ioHooks: {
			beforeIo: (operation) => {
				if (operation === "lock-remove") return Promise.reject(Object.assign(new Error("注入：锁删除失败"), { code: "EIO" }));
				return undefined;
			},
		},
	}).then(
		() => null,
		(error) => error,
	);

	assert.ok(thrown instanceof StorageError, `必须抛 StorageError，实际：${thrown}`);
	assert.equal(thrown.code, "revision-conflict", "锁释放失败不得覆盖原错误码");
	assert.equal(thrown.expected, 99, "原错误的 expected 必须保留");
	assert.equal(thrown.actual, 0, "原错误的 actual 必须保留");
	assert.ok(String(thrown.message).includes("锁未正常释放"), `锁未释放必须如实附加为诊断，实际：${String(thrown.message)}`);
	assert.ok(!String(thrown.message).includes(secret), "错误消息不得携带客户正文");
	assert.ok(String(thrown.message).length < 2_000, "诊断消息必须有界");

	assert.equal(hashFile(path), pathHash, "失败提交不得改动目标字节");
	const leftovers = lockEntries(root);
	assert.equal(leftovers.length, 1, "释放失败会留下自有锁——这正是被如实报告的那件事");
	for (const name of leftovers) rmSync(join(root, "locks", name), { recursive: true, force: true });
});

test("W3：失败路径上锁释放命中 not-owner/missing 时同样给出有界诊断且不删锁", async () => {
	const root = await makeStoreRoot("w3-lock-release-status");
	const id = "exp-w3-lockrel-status";
	const path = recordPath(root, "experience-card", id);
	await createRecord({ root, kind: "experience-card", id, data: experienceBody("v0"), expectedRevision: null, now: NOW });

	const runConflictWithReleaseHook = (hook) =>
		updateRecord({
			root,
			kind: "experience-card",
			id,
			data: experienceBody("v1"),
			expectedRevision: 99,
			ioHooks: { beforeIo: hook },
		}).then(
			() => null,
			(error) => error,
		);

	// 场景一：释放前元数据被改写成别人的 ownerId ⇒ release 返回 not-owner（不是自己的锁，不删）。
	const notOwner = await runConflictWithReleaseHook(async (operation, target) => {
		if (operation !== "lock-read") return;
		await writeFileSync(target, `${JSON.stringify({ ownerId: "someone-else", pid: 1, createdAt: NOW, target: "x" }, null, "\t")}\n`, "utf8");
	});
	assert.equal(notOwner?.code, "revision-conflict", "原错误码必须保留");
	assert.ok(String(notOwner?.message).includes("锁未正常释放"), `not-owner 必须如实上报，实际：${String(notOwner?.message)}`);
	assert.equal(lockEntries(root).length, 1, "不是自己的锁绝不能被删除");
	// 场景一留下的锁会挡住场景二（那正是"残留锁导致后续超时"的真实后果），
	// 所以人工确认后清掉它，再验证下一种清理状态。
	for (const name of lockEntries(root)) rmSync(join(root, "locks", name), { recursive: true, force: true });

	// 场景二：元数据不可读 ⇒ release 返回 missing（无法证明归属 ⇒ 不删）。
	const missing = await runConflictWithReleaseHook(async (operation, target) => {
		if (operation !== "lock-read") return;
		rmSync(target, { force: true });
		mkdirSync(target);
	});
	assert.equal(missing?.code, "revision-conflict", "原错误码必须保留");
	assert.ok(String(missing?.message).includes("锁未正常释放"), `missing 必须如实上报，实际：${String(missing?.message)}`);

	for (const name of lockEntries(root)) rmSync(join(root, "locks", name), { recursive: true, force: true });
});

test("W3：发布窗口内目标已存在且临时清理失败时，冲突诊断不被吞掉", async () => {
	const root = await makeStoreRoot("w3-exists-cleanup");
	const id = "exp-w3-exists-cleanup";
	const path = recordPath(root, "experience-card", id);
	const competitor = { schemaVersion: 1, revision: 0, createdAt: NOW, updatedAt: NOW, id, ...experienceBody("competitor-wins") };

	const thrown = await createRecord({
		root,
		kind: "experience-card",
		id,
		data: experienceBody("loser"),
		expectedRevision: null,
		now: LATER,
		ioHooks: {
			beforeIo: (operation, target) => {
				// 只覆盖**业务目标**的发布窗口（journal 的 prepared 也用 link，但它不是业务目标）。
				if (isJournalPath(target)) return undefined;
				if (operation === "link") {
					// 发布窗口：另一个写者抢先发布成功。
					writeFileSync(target, `${JSON.stringify(competitor, null, "\t")}\n`, "utf8");
					return undefined;
				}
				// 同时让本次临时文件清理失败：exists 是"正常返回"分支，最容易把残留诊断丢掉。
				if (operation === "unlink-temp") return Promise.reject(Object.assign(new Error("注入：清理失败"), { code: "EBUSY" }));
				return undefined;
			},
		},
	}).then(
		() => null,
		(error) => error,
	);

	assert.ok(thrown instanceof StorageError && thrown.code === "revision-conflict", `目标已存在必须报冲突，实际：${thrown?.message ?? String(thrown)}`);
	assert.equal(thrown.expected, null);
	assert.equal(thrown.actual, 0, "冲突必须如实报告对方写下的 revision");
	assert.ok(String(thrown.message).includes("清理失败"), `临时残留必须如实附加为诊断，实际：${String(thrown.message)}`);
	assert.equal((await readRecord({ root, kind: "experience-card", id })).record.solution, "competitor-wins", "输家不得覆盖赢家内容");

	const dir = dirname(path);
	const leftover = tempLeftovers(dir);
	assert.equal(leftover.length, 1, "清理失败会留下临时文件——这正是被如实报告的那件事");
	for (const name of leftover) rmSync(join(dir, name), { force: true });
	assert.deepEqual(lockEntries(root), [], "目标已存在时自己的锁仍必须释放");
});

test("W3：create 是非覆盖发布——提交窗口内目标出现则冲突而非覆盖", async () => {
	const root = await makeStoreRoot("w3-publish-race");
	const id = "exp-w3-race";
	const path = recordPath(root, "experience-card", id);
	const competitor = { schemaVersion: 1, revision: 0, createdAt: NOW, updatedAt: NOW, id, ...experienceBody("competitor-wins") };
	let sawWindow = false;

	const thrown = await createRecord({
		root,
		kind: "experience-card",
		id,
		data: experienceBody("loser"),
		expectedRevision: null,
		now: LATER,
		ioHooks: {
			beforeIo: (operation, target) => {
				if (isJournalPath(target)) return undefined;
				if (operation !== "link") return undefined;
				// 发布窗口：目标此刻必须**还不存在**，而且本进程只准备了自己的临时文件。
				assert.equal(existsSync(target), false, "发布窗口内目标必须还不存在");
				assert.equal(tempLeftovers(dirname(target)).length, 1, "发布窗口内应当只有本进程的临时文件");
				// 模拟另一个写者在这个窗口里抢先发布成功。
				writeFileSync(target, `${JSON.stringify(competitor, null, "\t")}\n`, "utf8");
				sawWindow = true;
				return undefined;
			},
		},
	}).then(
		() => null,
		(error) => error,
	);

	assert.equal(sawWindow, true, "必须真的进入过发布窗口");
	assert.ok(thrown instanceof StorageError && thrown.code === "revision-conflict", `目标已出现必须报冲突，实际：${thrown?.message ?? String(thrown)}`);
	assert.equal(thrown.expected, null);
	assert.equal(thrown.actual, 0, "冲突必须如实报告对方写下的 revision");
	assert.equal((await readRecord({ root, kind: "experience-card", id })).record.solution, "competitor-wins", "输家不得覆盖赢家内容");
	assert.equal(tempLeftovers(dirname(path)).length, 0, "发布未成立时必须清掉自己的临时文件");
	assert.deepEqual(lockEntries(root), []);
});

test("W3：提交成功但有遗留时返回有界警告（清理失败/锁未释放都如实上报）", async () => {
	const root = await makeStoreRoot("w3-warnings");
	const id = "exp-w3-warn";
	const result = await createRecord({
		root,
		kind: "experience-card",
		id,
		data: experienceBody("v0"),
		expectedRevision: null,
		now: NOW,
		ioHooks: {
			beforeIo: (operation, target) => {
				// 只让**业务目标**的临时清理失败（journal 的清理失败有独立用例），锁删除失败照旧。
				if (operation === "unlink-temp" && isJournalPath(target)) return undefined;
				if (operation === "unlink-temp" || operation === "lock-remove") return Promise.reject(Object.assign(new Error(`注入：${operation} 失败`), { code: "EBUSY" }));
				return undefined;
			},
		},
	});

	assert.equal(result.status, "created", "提交已经成立，不能被降级成失败");
	assert.equal(result.cleanup, "failed");
	assert.equal(result.lockRelease, "failed");
	assert.ok(Array.isArray(result.warnings) && result.warnings.length === 2, `必须给出有界警告，实际：${JSON.stringify(result.warnings)}`);
	assert.ok(
		result.warnings.some((note) => note.includes("清理")),
		"清理失败必须出现在警告里",
	);
	assert.ok(
		result.warnings.some((note) => note.includes("锁")),
		"锁未释放必须出现在警告里",
	);
	assert.equal((await readRecord({ root, kind: "experience-card", id })).record.solution, "v0", "警告不等于失败，内容必须已经落盘");

	// 残留物是"警告"的可见后果：人工确认后清理掉，避免影响后续用例。
	const dir = dirname(recordPath(root, "experience-card", id));
	for (const name of tempLeftovers(dir)) rmSync(join(dir, name), { force: true });
	for (const name of lockEntries(root)) rmSync(join(root, "locks", name), { recursive: true, force: true });
});

/* ------------------------------------------------------------------ W4：有效知识库准入 */

test("W4：registry 损坏 / 未来版本 / 绑定冲突 / 目录时拒绝写入，且不产生锁与记录", async (t) => {
	const registryPath = (root) => join(root, "registry.json");
	const scenarios = [
		{ name: "坏 JSON", setup: (root) => writeFileSync(registryPath(root), "{ 这不是 JSON", "utf8"), expect: isStorageError("invalid-json") },
		{ name: "未来版本", setup: (root) => writeRegistryFile(root, { schemaVersion: 999 }), expect: isStorageError("unsupported-schema-version") },
		{ name: "绑定冲突", setup: (root) => writeRegistryFile(root, { projects: [projectFixture(), projectFixture()] }), expect: isStorageError("binding-conflict") },
		{
			name: "registry 是目录",
			setup: (root) => {
				rmSync(registryPath(root), { force: true });
				mkdirSync(registryPath(root));
			},
			expect: isStorageError("not-a-file"),
		},
	];

	for (const scenario of scenarios) {
		await t.test(scenario.name, async () => {
			const root = await makeStoreRoot(`w4-${scenario.name}`);
			scenario.setup(root);
			const before = safeHash(registryPath(root));
			const experiences = join(root, "experiences");
			const entriesBefore = existsSync(experiences) ? readdirSync(experiences).length : 0;

			// 只查"registry.json 是否存在"的实现会在这里放行，从而往一个已经不可读的库里继续写。
			await assert.rejects(() => createRecord({ root, kind: "experience-card", id: "exp-w4", data: experienceBody("x"), expectedRevision: null }), scenario.expect);
			await assert.rejects(() => updateRecord({ root, kind: "experience-card", id: "exp-w4", data: experienceBody("x"), expectedRevision: 0 }), scenario.expect);

			assert.equal(safeHash(registryPath(root)), before, "被拒绝的写入不得改动 registry 字节");
			assert.equal(existsSync(experiences) ? readdirSync(experiences).length : 0, entriesBefore, "被拒绝的写入不得落下记录");
			assert.deepEqual(lockEntries(root), [], "被拒绝的写入不得产生锁");
		});
	}
});

test("W4：先有合法记录，registry 随后损坏时 update 拒绝：既有记录与 registry 原 hash 都不变", async (t) => {
	const registryPath = (root) => join(root, "registry.json");
	const scenarios = [
		// 与上一组同样的四类"库已经废了"，但这次**目标记录是存在的**：
		// 只证明"准入错误早于目标缺失"不够，必须证明既有记录没有被写坏。
		{ name: "坏 JSON", setup: (root) => writeFileSync(registryPath(root), "{ 这不是 JSON", "utf8"), expect: isStorageError("invalid-json") },
		{ name: "未来版本", setup: (root) => writeRegistryFile(root, { schemaVersion: 999 }), expect: isStorageError("unsupported-schema-version") },
		{ name: "绑定冲突", setup: (root) => writeRegistryFile(root, { projects: [projectFixture(), projectFixture()] }), expect: isStorageError("binding-conflict") },
		{
			name: "registry 是目录",
			setup: (root) => {
				rmSync(registryPath(root), { force: true });
				mkdirSync(registryPath(root));
			},
			expect: isStorageError("not-a-file"),
		},
	];

	for (const scenario of scenarios) {
		await t.test(scenario.name, async () => {
			const root = await makeStoreRoot(`w4-existing-${scenario.name}`);
			const id = "exp-w4-existing";
			const path = recordPath(root, "experience-card", id);
			await createRecord({ root, kind: "experience-card", id, data: experienceBody("v0"), expectedRevision: null, now: NOW });
			const recordHash = hashFile(path);

			scenario.setup(root);
			const registryHash = safeHash(registryPath(root));

			await assert.rejects(() => updateRecord({ root, kind: "experience-card", id, data: experienceBody("v1"), expectedRevision: 0, now: LATER }), scenario.expect);

			assert.equal(hashFile(path), recordHash, "既有记录的字节不得被改写");
			assert.equal(safeHash(registryPath(root)), registryHash, "registry 原字节不得被改写");
			assert.deepEqual(lockEntries(root), [], "被拒绝的写入不得产生锁");
		});
	}
});

test("W4：registry 被换成链接/junction 时普通 create/update 拒绝，根外 sentinel 不变", async (t) => {
	const outside = makeRawRoot("w4-registry-link-outside");
	const sentinel = join(outside, "sentinel.txt");
	writeFileSync(sentinel, "must-not-change", "utf8");
	const sentinelHash = hashFile(sentinel);
	const registryPath = (root) => join(root, "registry.json");

	const expectRejected = async (root) => {
		await assert.rejects(() => createRecord({ root, kind: "experience-card", id: "exp-w4-link", data: experienceBody("escape"), expectedRevision: null }), isStorageError("symlink-rejected"));
		await assert.rejects(() => updateRecord({ root, kind: "experience-card", id: "exp-w4-link", data: experienceBody("escape"), expectedRevision: 0 }), isStorageError("symlink-rejected"));
		assert.equal(hashFile(sentinel), sentinelHash, "根外 sentinel 字节不得改变");
		assert.deepEqual(readdirSync(outside), ["sentinel.txt"], "根外目录不得多出任何文件");
		assert.deepEqual(lockEntries(root), [], "被拒绝的写入不得产生锁");
	};

	// 目录 junction：Windows 上通常可用（本机实跑），失败则明确 skip，不做假通过。
	await t.test("registry 是根外目录 junction", async (t) => {
		const root = await makeStoreRoot("w4-registry-junction");
		rmSync(registryPath(root), { force: true });
		try {
			symlinkSync(outside, registryPath(root), "junction");
		} catch (error) {
			t.skip(`本机不支持创建目录 junction（${error.code ?? error.message}）`);
			return;
		}
		await expectRejected(root);
	});

	// 文件型 symlink：当前 Windows 常因缺少开发者模式返回 EPERM，明确 skip 而不是假通过。
	await t.test("registry 是文件型 symlink", async (t) => {
		const root = await makeStoreRoot("w4-registry-symlink");
		rmSync(registryPath(root), { force: true });
		try {
			symlinkSync(sentinel, registryPath(root), "file");
		} catch (error) {
			t.skip(`本机无法创建文件 symlink（${error.code ?? error.message}）`);
			return;
		}
		await expectRejected(root);
	});
});

/* ====================================================================================================
 * §R3 补证据：句柄生命周期、create 发布故障面、替换重试预算
 *
 * 这些用例补的是"上一轮只证明了'随后还能写'/'构造了某个分支'，却没有证明
 * 真正关心的不变量"的部分：句柄是否真的关掉、create 的各个故障面是否都收口、
 * 替换重试是否真的有界且可取消。
 * ================================================================================================== */

/** 捕获真实 `FileHandle`：`fd === -1` 是 Node 关闭后的可观测事实，不依赖 GC。 */
function captureHandles() {
	const handles = [];
	return {
		handles,
		hooks: {
			closeFile: async (handle) => {
				handles.push(handle);
				await handle.close();
			},
		},
	};
}

function assertAllHandlesClosed(handles, label) {
	assert.ok(handles.length >= 1, `${label}：必须真的观测到临时文件句柄`);
	for (const handle of handles) assert.equal(handle.fd, -1, `${label}：不得留下未关闭的句柄`);
}

test("R3：临时文件句柄在正常/失败/取消路径都被显式关闭（不依赖 GC）", async (t) => {
	const root = await makeStoreRoot("r3-handle-lifecycle");

	await t.test("正常提交（create 发布路径）", async () => {
		const captured = captureHandles();
		const id = "exp-r3-handle-ok";
		const result = await createRecord({ root, kind: "experience-card", id, data: experienceBody("v0"), expectedRevision: null, now: NOW, ioHooks: captured.hooks });
		assert.equal(result.status, "created");
		assertAllHandlesClosed(captured.handles, "正常提交");
	});

	await t.test("sync 失败（句柄已打开后失败）", async () => {
		const captured = captureHandles();
		const id = "exp-r3-handle-sync";
		const path = recordPath(root, "experience-card", id);
		await assert.rejects(
			() =>
				createRecord({
					root,
					kind: "experience-card",
					id,
					data: experienceBody("v0"),
					expectedRevision: null,
					ioHooks: {
						...captured.hooks,
						beforeIo: (operation, target) => (operation === "sync" && !isJournalPath(target) ? Promise.reject(Object.assign(new Error("注入：sync 失败"), { code: "EIO" })) : undefined),
					},
				}),
			isStorageError("permission-denied", "EIO"),
		);
		assertAllHandlesClosed(captured.handles, "sync 失败");
		assert.equal(existsSync(path), false, "失败不得创建目标");
		assert.equal(tempLeftovers(dirname(path)).length, 0, "失败必须清掉临时文件");
	});

	await t.test("打开后取消", async () => {
		const captured = captureHandles();
		const id = "exp-r3-handle-cancel";
		const path = recordPath(root, "experience-card", id);
		const controller = new AbortController();
		await assert.rejects(
			() =>
				createRecord({
					root,
					kind: "experience-card",
					id,
					data: experienceBody("v0"),
					expectedRevision: null,
					signal: controller.signal,
					ioHooks: {
						...captured.hooks,
						beforeIo: (operation, target) => {
							if (operation === "sync" && !isJournalPath(target)) controller.abort();
						},
					},
				}),
			isStorageError("cancelled"),
		);
		assertAllHandlesClosed(captured.handles, "打开后取消");
		assert.equal(existsSync(path), false, "取消不得创建目标");
		assert.equal(tempLeftovers(dirname(path)).length, 0, "取消必须清掉临时文件");
	});

	await t.test("close 失败（实际先关后抛）", async () => {
		const id = "exp-r3-handle-closefail";
		const path = recordPath(root, "experience-card", id);
		const handles = [];
		await assert.rejects(
			() =>
				createRecord({
					root,
					kind: "experience-card",
					id,
					data: experienceBody("v0"),
					expectedRevision: null,
					ioHooks: {
						// 只对**业务目标**的临时文件注入 close 失败（journal 的记账另有专门用例）。
						closeFile: async (handle, tempPath) => {
							await handle.close();
							if (isJournalPath(tempPath)) return;
							handles.push(handle);
							throw Object.assign(new Error("注入：close 失败"), { code: "EIO" });
						},
					},
				}),
			isStorageError("permission-denied", "EIO"),
		);
		// close 失败会走两次注入（正常路径 + finally 的尽力关闭），两次都必须作用在同一个已关闭句柄上。
		assertAllHandlesClosed(handles, "close 失败");
		assert.equal(tempLeftovers(dirname(path)).length, 0, "close 失败后临时文件必须清掉");
		assert.deepEqual(lockEntries(root), [], "close 失败后必须释放锁");
	});

	await t.test("open 之前就失败（不得有任何句柄被创建）", async () => {
		const id = "exp-r3-handle-preopen";
		let closeFileCalls = 0;
		await assert.rejects(
			() =>
				createRecord({
					root,
					kind: "experience-card",
					id,
					data: experienceBody("v0"),
					expectedRevision: null,
					ioHooks: {
						closeFile: async (handle, tempPath) => {
							// journal 的临时文件是**另一份**提交：本用例只统计业务目标的句柄。
							if (!isJournalPath(tempPath)) closeFileCalls += 1;
							await handle.close();
						},
						beforeIo: (operation, target) => (operation === "write-temp" && !isJournalPath(target) ? Promise.reject(Object.assign(new Error("注入：open 失败"), { code: "EACCES" })) : undefined),
					},
				}),
			isStorageError("permission-denied"),
		);
		assert.equal(closeFileCalls, 0, "open 都没成功时不存在需要关闭的句柄");
	});
});

test("R3：create 记录时硬链接不被支持 → publish-unsupported，不回退直写", async () => {
	const root = await makeStoreRoot("r3-create-link-unsupported");
	const id = "exp-r3-link";
	const path = recordPath(root, "experience-card", id);
	let linkCalls = 0;

	await assert.rejects(
		() =>
			createRecord({
				root,
				kind: "experience-card",
				id,
				data: experienceBody("v0"),
				expectedRevision: null,
				ioHooks: {
					// journal 的 prepared 也用 link：它必须走真实实现，本用例只让业务目标失败。
					link: async (existingPath, newPath) => {
						if (isJournalPath(newPath)) return fsLink(existingPath, newPath);
						linkCalls += 1;
						throw Object.assign(new Error("注入：不支持硬链接"), { code: "ENOSYS" });
					},
				},
			}),
		isStorageError("publish-unsupported"),
	);

	assert.equal(linkCalls, 1, "发布只尝试一次硬链接，不因不支持而回退直写");
	assert.equal(existsSync(path), false, "不支持的发布不得创建目标文件");
	assert.equal(tempLeftovers(dirname(path)).length, 0, "失败后不得残留临时文件");
	assert.deepEqual(lockEntries(root), [], "失败后必须释放锁");
});

test("R3：create 在发布等待期间取消 → cancelled，不留目标/临时文件/锁", async () => {
	const root = await makeStoreRoot("r3-create-cancel");
	const id = "exp-r3-create-cancel";
	const path = recordPath(root, "experience-card", id);
	const controller = new AbortController();

	await assert.rejects(
		() =>
			createRecord({
				root,
				kind: "experience-card",
				id,
				data: experienceBody("v0"),
				expectedRevision: null,
				signal: controller.signal,
				ioHooks: {
					beforeIo: (operation, target) => {
						// 业务目标的临时文件已写好、`link` 尚未发起：此刻取消必须是干净失败。
						// journal 的 prepared link 不算"发布等待期间"。
						if (operation === "link" && !isJournalPath(target)) controller.abort();
					},
				},
			}),
		isStorageError("cancelled"),
	);

	assert.equal(existsSync(path), false, "取消不得创建目标");
	assert.equal(tempLeftovers(dirname(path)).length, 0, "取消必须清掉自己的临时文件");
	assert.deepEqual(lockEntries(root), [], "取消必须释放锁");

	// 取消不得损坏后续写入。
	const after = await createRecord({ root, kind: "experience-card", id, data: experienceBody("v0"), expectedRevision: null, now: NOW });
	assert.equal(after.status, "created");
});

test("R3：create 提交成功后的迟到取消仍报告真实 created（不假称回滚）", async () => {
	const root = await makeStoreRoot("r3-create-late-cancel");
	const id = "exp-r3-create-late";
	const path = recordPath(root, "experience-card", id);
	const controller = new AbortController();

	const result = await createRecord({
		root,
		kind: "experience-card",
		id,
		data: experienceBody("committed"),
		expectedRevision: null,
		now: NOW,
		signal: controller.signal,
		ioHooks: {
			beforeIo: (operation, target) => {
				// 业务目标的 `link` 已经返回（提交点已过），此时才取消：内容必须保留，状态必须如实。
				if (operation === "unlink-temp" && !isJournalPath(target)) controller.abort();
			},
		},
	});

	assert.equal(result.status, "created", "已提交就不能因为迟到的取消改口");
	assert.equal(result.revision, 0);
	const after = await readRecord({ root, kind: "experience-card", id });
	assert.equal(after.record.solution, "committed", "提交点之后的取消不得回滚已发布内容");
	assert.equal(existsSync(path), true);
	assert.deepEqual(lockEntries(root), [], "迟到取消不得阻止锁释放");
	// BM-02C1：提交点之后的取消会让 **journal 终态**写不进去——数据是真的，
	// 但记账没完成，必须如实报 needs-recovery 而不是装作一切正常。
	assert.equal(result.journal.state, "needs-recovery", "终态未写入必须如实上报");
	assert.ok(Array.isArray(result.warnings) && result.warnings.some((note) => note.includes(result.journal.operationId)), "警告必须带 operationId 便于核对");
	assert.equal(readJournalFile(root, result.journal.operationId).state, "prepared", "磁盘上仍是 prepared，等待 reconcile 收口");
});

test("R3：rename 可重试失败最终成功时 renameAttempts 如实反映尝试次数", async () => {
	const root = await makeStoreRoot("r3-rename-retry-ok");
	const id = "exp-r3-retry";
	const path = recordPath(root, "experience-card", id);
	await createRecord({ root, kind: "experience-card", id, data: experienceBody("v0"), expectedRevision: null, now: NOW });

	// 前 3 次替换按 Windows 共享冲突（EBUSY）失败，之后放行真实 `rename`。
	const FAILURES = 3;
	let renameCalls = 0;
	const result = await updateRecord({
		root,
		kind: "experience-card",
		id,
		data: experienceBody("v1"),
		expectedRevision: 0,
		now: LATER,
		ioHooks: {
			beforeIo: (operation, target) => {
				if (operation !== "rename" || isJournalPath(target)) return undefined;
				renameCalls += 1;
				return renameCalls <= FAILURES ? Promise.reject(Object.assign(new Error("注入：共享冲突"), { code: "EBUSY" })) : undefined;
			},
		},
	});

	assert.equal(result.status, "updated");
	assert.equal(result.revision, 1);
	assert.equal(result.renameAttempts, FAILURES + 1, "重试次数必须如实上报，不能把重试藏起来");
	assert.equal(result.cleanup, "ok");
	assert.equal((await readRecord({ root, kind: "experience-card", id })).record.solution, "v1");
	assert.deepEqual(lockEntries(root), [], "重试成功后必须释放锁");
});

test("R3：rename 始终失败时有界放弃（预算内、不在退避中挂死）", async () => {
	const root = await makeStoreRoot("r3-rename-exhausted");
	const id = "exp-r3-exhaust";
	const path = recordPath(root, "experience-card", id);
	await createRecord({ root, kind: "experience-card", id, data: experienceBody("v0"), expectedRevision: null, now: NOW });
	const pathHash = hashFile(path);

	let renameCalls = 0;
	const startedAt = Date.now();
	await assert.rejects(
		() =>
			updateRecord({
				root,
				kind: "experience-card",
				id,
				data: experienceBody("v1"),
				expectedRevision: 0,
				now: LATER,
				ioHooks: {
					beforeIo: (operation, target) => {
						if (operation !== "rename" || isJournalPath(target)) return undefined;
						renameCalls += 1;
						return Promise.reject(Object.assign(new Error("注入：共享冲突"), { code: "EBUSY" }));
					},
				},
			}),
		(error) => isStorageError("permission-denied")(error) && String(error.detail).includes("EBUSY"),
	);
	const elapsed = Date.now() - startedAt;

	assert.equal(renameCalls, 12, "重试次数必须有固定上限（指数退避 12 次）");
	assert.ok(elapsed < 6_000, `最终失败必须落在标称 4s 预算附近，实际 ${elapsed}ms`);
	assert.equal(hashFile(path), pathHash, "替换全部失败时原字节必须不变");
	assert.equal(tempLeftovers(dirname(path)).length, 0, "失败后不得残留临时文件");
	assert.deepEqual(lockEntries(root), [], "失败后必须释放锁");
});

test("R3：rename 退避等待期间取消立即生效（不等完这一轮退避）", async () => {
	const root = await makeStoreRoot("r3-rename-cancel");
	const id = "exp-r3-rename-cancel";
	const path = recordPath(root, "experience-card", id);
	await createRecord({ root, kind: "experience-card", id, data: experienceBody("v0"), expectedRevision: null, now: NOW });
	const pathHash = hashFile(path);
	const controller = new AbortController();

	const startedAt = Date.now();
	await assert.rejects(
		() =>
			updateRecord({
				root,
				kind: "experience-card",
				id,
				data: experienceBody("v1"),
				expectedRevision: 0,
				now: LATER,
				signal: controller.signal,
				ioHooks: {
					beforeIo: (operation, target) => {
						if (operation !== "rename" || isJournalPath(target)) return undefined;
						// 第一次替换就"失败 + 取消"：退避必须被取消打断，而不是先睡完。
						controller.abort();
						return Promise.reject(Object.assign(new Error("注入：共享冲突"), { code: "EBUSY" }));
					},
				},
			}),
		isStorageError("cancelled"),
	);
	const elapsed = Date.now() - startedAt;

	assert.ok(elapsed < 1_000, `取消必须立刻生效，实际 ${elapsed}ms`);
	assert.equal(hashFile(path), pathHash, "取消不得改动目标");
	assert.equal(tempLeftovers(dirname(path)).length, 0, "取消必须清掉临时文件");
	assert.deepEqual(lockEntries(root), [], "取消必须释放自己的锁");
});
