/**
 * BM-02AR 存储边界收尾的**永久回归**（对应收尾文档 §3 的 9 组要求）。
 *
 * 这些用例把第四轮验收用临时脚本"碰"出来的窗口变成有确定时序的永久断言：
 *
 * - §3.1 硬链接不支持 / 权限失败 / 发布窗口：不创建目标、不暴露空/半文件、原数据 hash 不变；
 * - §3.2 A 目录内的 B 项目记录：单条拒绝、列表只进 problems；
 * - §3.3 stat 过期后文件增长：拒绝解析合法前缀；正常读取确实到达 EOF；
 * - §3.4 读取/空目录/列表末条/初始化竞争的取消时序：整体 cancelled，不混入 problems/init-race；
 * - §3.5 混入大写/非法 ID 文件名、坏项目目录名、损坏记录：合法记录仍可列；
 * - §3.6 小字节预算 + 多条损坏记录：problems 也受限、丢弃计数可见；非法限额结构化拒绝；
 * - §3.7 重复 biosProjectId、矛盾组合查询、多工作区歧义：不任意选择；
 * - §3.8 初始化时根内目录 junction 逃逸：拒绝且不写根外；
 * - §3.9 非空 fixture 新进程读取：项目/工作区 ID、记录 ID 与 revision 一致。
 *
 * 故障注入（`StorageIoHooks`）只是**确定性复现特殊分支**的手段，不代表本机磁盘真的发生过
 * 对应故障；真实子进程都带 error/超时/输出上限。
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { link as realLink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { BIOS_CONTRACTS_SCHEMA_VERSION } from "../core/contracts/version.ts";
import { createStorageBoundary, DEFAULT_STORAGE_LIMITS, StorageError, initializeKnowledgeStore, listRecords, readRecord, readRegistry, recordRelativeSegments, resolveProjectBinding, resolveStorageLimits } from "../core/storage/index.ts";

const STORAGE_MODULE_URL = new URL("../core/storage/index.ts", import.meta.url).href;
const SANDBOX = realpathSync(mkdtempSync(join(tmpdir(), "bios-store-remediation-")));
const NOW = 1_700_000_000_000;
const PROJECT_ID = "3f2504e0-4f89-4a1c-9a3d-1f0d3c9a4b7e";
const OTHER_PROJECT_ID = "8c1b2f44-6a5d-4b3e-9f7a-2d4c8e1b5a90";
const WORKSPACE_ID = "b7d1e9f2-3c4a-4d5e-8f9a-0b1c2d3e4f50";
const WORKSPACE_ID_TWO = "c8e2f0a3-4d5b-4e6f-9a0b-1c2d3e4f5061";

after(() => {
	rmSync(SANDBOX, { recursive: true, force: true });
});

let rootCounter = 0;

/** 只建目录、**不**初始化知识库（用于发布失败/窗口场景）。 */
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

function runNode(script) {
	// 真实子进程必须带超时与输出上限，避免测试挂死或吃掉内存。
	const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 60_000, maxBuffer: 1 << 20 });
	return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", error: result.error };
}

function fsError(code) {
	const error = new Error(`injected ${code}`);
	error.code = code;
	return error;
}

/* ------------------------------------------------------------------ §3.1 初始化发布 */

test("AR-1：硬链接不被支持时初始化明确失败，不创建 registry 也不留半文件", async () => {
	const root = makeRawRoot("ar1-unsupported");
	let linkCalls = 0;

	await assert.rejects(
		() =>
			initializeKnowledgeStore({
				root,
				ioHooks: {
					link: async () => {
						linkCalls += 1;
						throw fsError("ENOSYS");
					},
				},
			}),
		(error) => error instanceof StorageError && error.code === "publish-unsupported",
	);

	assert.equal(linkCalls, 1, "发布应尝试且只尝试一次硬链接（不回退直写）");
	assert.equal(existsSync(join(root, "registry.json")), false, "不支持的发布不得创建目标文件");
	assert.deepEqual(
		readdirSync(root).filter((name) => name.endsWith(".tmp")),
		[],
		"失败后不得留下临时文件",
	);
	assert.equal(existsSync(join(root, "projects")), true, "目录布局可以已建（幂等可重复执行）");
});

test("AR-1：发布权限不足时报 permission-denied，不创建 registry", async () => {
	const root = makeRawRoot("ar1-permission");

	await assert.rejects(
		() => initializeKnowledgeStore({ root, ioHooks: { link: async () => Promise.reject(fsError("EACCES")) } }),
		(error) => error instanceof StorageError && error.code === "permission-denied",
	);
	assert.equal(existsSync(join(root, "registry.json")), false);
	assert.deepEqual(
		readdirSync(root).filter((name) => name.endsWith(".tmp")),
		[],
	);
});

test("AR-1：发布窗口内目标不存在，读者看不到空/半 registry", async () => {
	const root = makeRawRoot("ar1-window");
	const observed = { sawRegistry: null, sawTemps: [], registryBytes: null };

	const result = await initializeKnowledgeStore({
		root,
		now: NOW,
		ioHooks: {
			beforeIo: (operation) => {
				if (operation !== "link") return;
				// 此刻同目录临时文件已完整写好、目标尚未出现——这就是"发布窗口"。
				observed.sawRegistry = existsSync(join(root, "registry.json"));
				observed.sawTemps = readdirSync(root).filter((name) => name.endsWith(".tmp"));
				if (observed.sawRegistry) observed.registryBytes = readFileSync(join(root, "registry.json"), "utf8");
			},
		},
	});

	assert.equal(result.status, "created");
	assert.equal(observed.sawRegistry, false, "硬链接发布前目标必须不存在，读者只能看到 ENOENT");
	assert.equal(observed.registryBytes, null);
	assert.equal(observed.sawTemps.length, 1, "窗口内应恰好有一个同目录完整临时文件");

	// 发布后是完整合法内容，且临时文件被清理。
	const published = readRegistry({ root });
	await published;
	assert.equal(existsSync(join(root, "registry.json")), true);
	assert.deepEqual(
		readdirSync(root).filter((name) => name.endsWith(".tmp")),
		[],
	);
});

test("AR-1：既有 registry 的字节在失败/重复发布尝试下原样保留", async () => {
	const root = await makeStoreRoot("ar1-existing");
	const registryPath = join(root, "registry.json");
	const before = hashFile(registryPath);
	let linkCalls = 0;

	// registry 已存在时初始化只做只读校验，绝不进入发布路径。
	const again = await initializeKnowledgeStore({
		root,
		ioHooks: {
			link: async () => {
				linkCalls += 1;
				throw fsError("ENOSYS");
			},
		},
	});
	assert.equal(again.status, "existing");
	assert.equal(linkCalls, 0, "已存在的 registry 不应触发任何发布尝试");
	assert.equal(hashFile(registryPath), before, "既有数据原 hash 必须不变");
});

/* ------------------------------------------------------------------ §3.2 跨项目归属 */

test("AR-2：A 目录内的 B 项目任务/上下文清单：单条拒绝、列表只进 problems", async () => {
	const root = await makeStoreRoot("ar2-ownership");
	writeRecord(root, "task-record", makeTaskRecord({ id: "task-a" }), PROJECT_ID);
	writeRecord(root, "task-record", makeTaskRecord({ id: "task-b", projectId: OTHER_PROJECT_ID }), PROJECT_ID);
	writeRecord(root, "context-manifest", makeContextManifest({ id: "ctx-b", targetProjectId: OTHER_PROJECT_ID }), PROJECT_ID);

	await assert.rejects(
		() => readRecord({ root, kind: "task-record", id: "task-b", projectId: PROJECT_ID }),
		(error) => error instanceof StorageError && error.code === "record-id-mismatch",
	);
	await assert.rejects(
		() => readRecord({ root, kind: "context-manifest", id: "ctx-b", projectId: PROJECT_ID }),
		(error) => error instanceof StorageError && error.code === "record-id-mismatch",
	);

	const tasks = await listRecords({ root, kind: "task-record", projectId: PROJECT_ID });
	assert.deepEqual(
		tasks.entries.map((entry) => entry.id),
		["task-a"],
		"错归属任务不得进入 entries",
	);
	assert.equal(tasks.problems.length, 1);
	assert.equal(tasks.problems[0].code, "record-id-mismatch");

	const contexts = await listRecords({ root, kind: "context-manifest", projectId: PROJECT_ID });
	assert.equal(contexts.entries.length, 0);
	assert.equal(contexts.problems.length, 1);
	assert.equal(contexts.problems[0].code, "record-id-mismatch");
});

/* ------------------------------------------------------------------ §3.3 增长文件 */

test("AR-2：stat 报告过小后文件增长：拒绝解析合法前缀，正常读取确实到达 EOF", async () => {
	const root = await makeStoreRoot("ar2-grow");
	const path = writeRecord(root, "experience-card", makeExperienceCard({ id: "exp-grow" }));
	const valid = JSON.stringify(makeExperienceCard({ id: "exp-grow" }));
	const staleStat = async () => ({ isFile: () => true, size: 2 });

	// 1) 文件 = 合法 JSON 前缀 + 超上限的尾部垃圾：stat 却报 2 字节。
	writeFileSync(path, `${valid}${"x".repeat(2048)}`, "utf8");
	const totalBytes = readFileSync(path).length;
	await assert.rejects(
		() => readRecord({ root, kind: "experience-card", id: "exp-grow", limits: { maxRecordBytes: Buffer.byteLength(valid) + 16 }, ioHooks: { stat: staleStat } }),
		(error) => error instanceof StorageError && error.code === "too-large",
		"超过上限必须按实际读取字节判定，而不是 stat 报告的长度",
	);

	// 2) 增长后整体仍是"合法前缀 + 少量垃圾"，但预算足够：不能按前缀解析成功。
	writeFileSync(path, `${valid}garbage-tail`, "utf8");
	await assert.rejects(
		() => readRecord({ root, kind: "experience-card", id: "exp-grow", ioHooks: { stat: staleStat } }),
		(error) => error instanceof StorageError && error.code === "invalid-json",
		"未到 EOF 的合法前缀不得被解析成功",
	);

	// 3) 正常文件：确实读到 EOF，bytes 等于真实文件字节数。
	writeFileSync(path, `${JSON.stringify(makeExperienceCard({ id: "exp-grow" }), null, "\t")}\n`, "utf8");
	const freshBytes = readFileSync(path).length;
	const read = await readRecord({ root, kind: "experience-card", id: "exp-grow" });
	assert.equal(read.bytes, freshBytes, "正常读取应报告真实字节数（读到 EOF）");
	assert.equal(read.record.id, "exp-grow");
	assert.ok(totalBytes > freshBytes);
});

/* ------------------------------------------------------------------ §3.4 取消时序 */

test("AR-2：最后一次 read 返回 EOF 时取消：整体 cancelled，而非成功或 invalid-json", async () => {
	const root = await makeStoreRoot("ar2-cancel-eof");
	const controller = new AbortController();
	// 空文件：第一次 read 直接返回 EOF（bytesRead === 0），复现"没有下一次迭代"的窗口。
	const path = join(root, ...recordRelativeSegments("experience-card", "exp-empty"));
	writeFileSync(path, "", "utf8");

	await assert.rejects(
		() =>
			readRecord({
				root,
				kind: "experience-card",
				id: "exp-empty",
				signal: controller.signal,
				ioHooks: { beforeIo: (operation) => (operation === "read" ? controller.abort() : undefined) },
			}),
		(error) => error instanceof StorageError && error.code === "cancelled",
	);
});

test("AR-2：空目录打开期间取消：整体 cancelled，不返回成功空列表", async () => {
	const root = await makeStoreRoot("ar2-cancel-opendir");
	const controller = new AbortController();

	await assert.rejects(
		() =>
			listRecords({
				root,
				kind: "experience-card",
				signal: controller.signal,
				ioHooks: { beforeIo: (operation) => (operation === "opendir" ? controller.abort() : undefined) },
			}),
		(error) => error instanceof StorageError && error.code === "cancelled",
	);
});

test("AR-2：列表处理最后一条时取消：整体 cancelled，不混入 problems", async () => {
	const root = await makeStoreRoot("ar2-cancel-last");
	writeRecord(root, "experience-card", makeExperienceCard({ id: "exp-a" }));
	writeRecord(root, "experience-card", makeExperienceCard({ id: "exp-b" }));
	const controller = new AbortController();
	// 只统计候选记录的 open（初始化布局早已存在，列表扫描不会再 open 目录）。
	let opens = 0;

	await assert.rejects(
		() =>
			listRecords({
				root,
				kind: "experience-card",
				signal: controller.signal,
				ioHooks: {
					beforeIo: (operation) => {
						if (operation !== "open") return;
						opens += 1;
						// 第二条（最后一条）记录打开前取消。
						if (opens === 2) controller.abort();
					},
				},
			}),
		(error) => error instanceof StorageError && error.code === "cancelled",
	);
	assert.equal(opens, 2);
});

test("AR-2：初始化竞争等待期间取消：整体 cancelled，不改写成 init-race", async () => {
	const root = makeRawRoot("ar2-cancel-race");
	const controller = new AbortController();

	await assert.rejects(
		() =>
			initializeKnowledgeStore({
				root,
				now: NOW,
				signal: controller.signal,
				ioHooks: {
					// 目标是"另一个进程刚发布"：EEXIST 让发布返回 exists，进入竞争重试等待。
					link: async () => {
						setTimeout(() => controller.abort(), 5);
						throw fsError("EEXIST");
					},
				},
			}),
		(error) => error instanceof StorageError && error.code === "cancelled",
	);
	// 竞争取消不得留下半文件（目标从未被本进程创建）。
	const registryPath = join(root, "registry.json");
	assert.equal(existsSync(registryPath), false);
});

/* ------------------------------------------------------------------ §3.5 混合条目 */

test("AR-3：混入大写/非法 ID 文件名、非 .json 与损坏记录：合法记录仍可列", async () => {
	const root = await makeStoreRoot("ar3-mixed");
	writeRecord(root, "experience-card", makeExperienceCard({ id: "exp-ok-1" }));
	writeRecord(root, "experience-card", makeExperienceCard({ id: "exp-ok-2" }));
	const experiences = join(root, "experiences");

	// 大写文件名（非法 ID 形态）：可派生失败，应进 problems 而不是拖垮列表。
	writeFileSync(join(experiences, "Exp-Bad.json"), `${JSON.stringify(makeExperienceCard({ id: "Exp-Bad" }))}\n`, "utf8");
	// 损坏记录：invalid-json。
	writeFileSync(join(experiences, "exp-broken.json"), "{ not json", "utf8");
	// 非 .json 文件：跳过策略明确，计入 skippedEntries，不算问题。
	writeFileSync(join(experiences, "notes.txt"), "hello", "utf8");
	// 点开头文件：同样是跳过项。
	writeFileSync(join(experiences, ".hidden.json"), "{}", "utf8");

	const page = await listRecords({ root, kind: "experience-card" });
	assert.deepEqual(page.entries.map((entry) => entry.id).sort(), ["exp-ok-1", "exp-ok-2"]);
	const codes = page.problems.map((problem) => problem.code).sort();
	assert.ok(codes.includes("invalid-record"), `大写 ID 应进 problems：${JSON.stringify(codes)}`);
	assert.ok(codes.includes("invalid-json"), `损坏记录应进 problems：${JSON.stringify(codes)}`);
	assert.equal(page.problems.length, 2);
	assert.ok(page.skippedEntries >= 2, `非 .json 与点开头文件应计入 skippedEntries，实际 ${page.skippedEntries}`);
});

test("AR-3：project-profile 列表遇到非法项目目录名：进 problems，其余项目继续可列", async () => {
	const root = await makeStoreRoot("ar3-bad-project-dir");
	writeRecord(root, "project-profile", makeProjectProfile(), PROJECT_ID);
	// 不是 UUID 的目录名：不能冒充项目档案。
	mkdirSync(join(root, "projects", "Not-A-Uuid"), { recursive: true });
	writeFileSync(join(root, "projects", "Not-A-Uuid", "profile.json"), `${JSON.stringify(makeProjectProfile({ id: "Not-A-Uuid" }))}\n`, "utf8");

	const page = await listRecords({ root, kind: "project-profile" });
	assert.deepEqual(
		page.entries.map((entry) => entry.id),
		[PROJECT_ID],
	);
	assert.equal(page.problems.length, 1);
	assert.equal(page.problems[0].code, "invalid-record");
});

/* ------------------------------------------------------------------ §3.6 预算与限额 */

test("AR-3：小字节预算下 problems 也受限，截断原因与丢弃计数可见", async () => {
	const root = await makeStoreRoot("ar3-budget");
	const experiences = join(root, "experiences");
	for (let index = 0; index < 6; index += 1) {
		writeFileSync(join(experiences, `exp-bad-${index}.json`), "{ bad", "utf8");
	}

	const byProblems = await listRecords({ root, kind: "experience-card", limits: { maxListProblems: 1 } });
	assert.equal(byProblems.problems.length, 1);
	assert.ok(byProblems.truncatedBy.includes("problems"));
	assert.ok(byProblems.droppedProblems > 0, "被丢弃的候选数必须可见");

	// 字节预算：只放得下少量问题，其余进入 droppedProblems。
	const byBytes = await listRecords({ root, kind: "experience-card", limits: { maxListBytes: 300 } });
	assert.ok(byBytes.problems.length >= 1, "至少应报告一个（未超出 300 字节预算的）问题");
	assert.ok(byBytes.problems.length < 6, "problems 不得无限增长");
	assert.ok(byBytes.truncatedBy.includes("bytes"));
	assert.ok(byBytes.droppedProblems > 0);
	assert.equal(byBytes.truncated, true);
});

test("AR-3：非法限额被结构化拒绝，undefined 保留默认，默认对象不被调用污染", async () => {
	for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5]) {
		assert.throws(
			() => resolveStorageLimits({ maxListBytes: bad }),
			(error) => error instanceof StorageError && error.code === "invalid-limits",
			`非法限额应被拒绝：${String(bad)}`,
		);
	}

	const overridden = resolveStorageLimits({ maxListBytes: undefined, maxListEntries: 7 });
	assert.equal(overridden.maxListBytes, DEFAULT_STORAGE_LIMITS.maxListBytes, "显式 undefined 应保留默认");
	assert.equal(overridden.maxListEntries, 7);
	assert.equal(DEFAULT_STORAGE_LIMITS.maxListEntries, 200, "默认对象不得被一次调用修改");

	// 公共入口同样拒绝非法限额，而不是带着假预算继续跑。
	const root = await makeStoreRoot("ar3-bad-limits");
	await assert.rejects(
		() => listRecords({ root, kind: "experience-card", limits: { maxListBytes: Number.NaN } }),
		(error) => error instanceof StorageError && error.code === "invalid-limits",
	);
});

/* ------------------------------------------------------------------ §3.7 绑定解析 */

test("AR-3：重复 biosProjectId 的 registry 被拒绝，不靠 find 选首条", async () => {
	const duplicateProjects = {
		schemaVersion: BIOS_CONTRACTS_SCHEMA_VERSION,
		revision: 0,
		createdAt: 1,
		updatedAt: 1,
		projects: [
			{ biosProjectId: PROJECT_ID, workspaces: [], createdAt: 1, updatedAt: 1 },
			{ biosProjectId: PROJECT_ID, workspaces: [], createdAt: 1, updatedAt: 1 },
		],
	};

	const resolution = resolveProjectBinding(duplicateProjects, { biosProjectId: PROJECT_ID });
	assert.equal(resolution.status, "conflict");
	assert.equal(resolution.reason, "inconsistent-registry");
	assert.deepEqual(resolution.candidates, [PROJECT_ID]);

	// 落到文件上同样在 readRegistry 阶段就被拒绝。
	const root = await makeStoreRoot("ar3-dup-project");
	writeFileSync(join(root, "registry.json"), `${JSON.stringify(duplicateProjects, null, "\t")}\n`, "utf8");
	await assert.rejects(
		() => readRegistry({ root }),
		(error) => error instanceof StorageError && error.code === "binding-conflict",
	);
});

test("AR-3：矛盾组合查询不静默忽略，多工作区不任取首个", () => {
	const workspaceA = join(SANDBOX, "ar3-ws-a");
	const workspaceB = join(SANDBOX, "ar3-ws-b");
	const registry = {
		schemaVersion: BIOS_CONTRACTS_SCHEMA_VERSION,
		revision: 2,
		createdAt: 1,
		updatedAt: 1,
		projects: [
			{
				biosProjectId: PROJECT_ID,
				desktopProjectId: "desk-a",
				workspaces: [{ workspaceId: WORKSPACE_ID, path: workspaceA, boundAt: 1 }],
				createdAt: 1,
				updatedAt: 1,
			},
			{
				biosProjectId: OTHER_PROJECT_ID,
				desktopProjectId: "desk-b",
				workspaces: [{ workspaceId: WORKSPACE_ID_TWO, path: workspaceB, boundAt: 1 }],
				createdAt: 1,
				updatedAt: 1,
			},
		],
	};

	// 路径属于 A、显式项目却是 B：绝不返回 A 的 resolved（也不得静默忽略某个条件）。
	const mismatch = resolveProjectBinding(registry, { workspacePath: workspaceA, biosProjectId: OTHER_PROJECT_ID });
	assert.notEqual(mismatch.status, "resolved", "矛盾条件不得返回确定绑定");
	assert.equal(mismatch.status, "missing");
	assert.equal(mismatch.reason, "no-match");

	// 项目与桌面 ID 指向不同项目：显式矛盾。
	const contradictory = resolveProjectBinding(registry, { biosProjectId: PROJECT_ID, desktopProjectId: "desk-b" });
	assert.equal(contradictory.status, "conflict");
	assert.equal(contradictory.reason, "contradictory-filters");

	// 一致组合仍然可解析（不把正确用法一起拒掉）。
	const consistent = resolveProjectBinding(registry, { biosProjectId: PROJECT_ID, desktopProjectId: "desk-a" });
	assert.equal(consistent.status, "resolved");
	assert.equal(consistent.workspace.workspaceId, WORKSPACE_ID);
	assert.equal(resolveProjectBinding(registry, { workspacePath: workspaceA, biosProjectId: PROJECT_ID }).status, "resolved");

	// 多工作区只给项目 ID：必须歧义，不能取 workspaces[0]。
	const multi = {
		...registry,
		projects: [
			{
				biosProjectId: PROJECT_ID,
				workspaces: [
					{ workspaceId: WORKSPACE_ID, path: workspaceA, boundAt: 1 },
					{ workspaceId: WORKSPACE_ID_TWO, path: workspaceB, boundAt: 1 },
				],
				createdAt: 1,
				updatedAt: 1,
			},
		],
	};
	const ambiguous = resolveProjectBinding(multi, { biosProjectId: PROJECT_ID });
	assert.equal(ambiguous.status, "conflict");
	assert.equal(ambiguous.reason, "ambiguous-workspace");
	assert.deepEqual(ambiguous.candidates, [WORKSPACE_ID, WORKSPACE_ID_TWO].sort());
});

/* ------------------------------------------------------------------ §3.8 初始化逃逸 */

test("AR-3：初始化时根内目录是逃逸 junction：拒绝且不写根外", async (t) => {
	const root = makeRawRoot("ar3-junction");
	const outside = join(SANDBOX, `ar3-outside-${rootCounter}`);
	mkdirSync(outside, { recursive: true });
	const sentinel = join(outside, "sentinel.txt");
	writeFileSync(sentinel, "keep-me", "utf8");
	const before = hashFile(sentinel);

	mkdirSync(join(root, "experiences"), { recursive: true });
	rmSync(join(root, "experiences"), { recursive: true, force: true });
	try {
		symlinkSync(outside, join(root, "experiences"), "junction");
	} catch (error) {
		t.skip(`无法创建目录 junction（需要开发者模式/管理员权限）：${error instanceof Error ? error.message : String(error)}`);
		return;
	}

	await assert.rejects(
		() => initializeKnowledgeStore({ root }),
		(error) => error instanceof StorageError && error.code === "symlink-rejected",
	);
	assert.equal(existsSync(join(root, "registry.json")), false, "逃逸被拒时不得创建 registry");
	assert.deepEqual(readdirSync(outside), ["sentinel.txt"], "根外目录不得被写入任何文件");
	assert.equal(hashFile(sentinel), before);
});

/* ------------------------------------------------------------------ §3.9 非空 fixture 新进程 */

test("AR-3：非空 fixture 新进程读取：项目/工作区 ID、记录 ID 与 revision 一致", async () => {
	const root = await makeStoreRoot("ar3-nonempty");
	const registry = {
		schemaVersion: BIOS_CONTRACTS_SCHEMA_VERSION,
		revision: 3,
		createdAt: NOW,
		updatedAt: NOW,
		projects: [
			{
				biosProjectId: PROJECT_ID,
				desktopProjectId: "desk-1",
				workspaces: [{ workspaceId: WORKSPACE_ID, path: join(root, "ws"), boundAt: NOW }],
				createdAt: NOW,
				updatedAt: NOW,
			},
		],
	};
	writeFileSync(join(root, "registry.json"), `${JSON.stringify(registry, null, "\t")}\n`, "utf8");
	writeRecord(root, "project-profile", makeProjectProfile(), PROJECT_ID);
	writeRecord(root, "task-record", makeTaskRecord({ id: "task-1" }), PROJECT_ID);

	const script = `
		import { readRegistry, readRecord } from ${JSON.stringify(STORAGE_MODULE_URL)};
		const registry = await readRegistry({ root: ${JSON.stringify(root)} });
		const profile = await readRecord({ root: ${JSON.stringify(root)}, kind: "project-profile", id: ${JSON.stringify(PROJECT_ID)} });
		const task = await readRecord({ root: ${JSON.stringify(root)}, kind: "task-record", id: "task-1", projectId: ${JSON.stringify(PROJECT_ID)} });
		process.stdout.write(JSON.stringify({
			revision: registry.revision,
			biosProjectId: registry.projects[0].biosProjectId,
			workspaceId: registry.projects[0].workspaces[0].workspaceId,
			profileId: profile.record.id,
			profileRevision: profile.record.revision,
			taskId: task.record.id,
			taskProjectId: task.record.projectId,
		}));
	`;

	const result = runNode(script);
	assert.equal(result.error, undefined, `子进程启动失败：${String(result.error)}`);
	assert.equal(result.status, 0, `子进程失败：${result.stderr}`);
	const payload = JSON.parse(result.stdout);
	assert.equal(payload.revision, 3, "非空 registry 的 revision 应被真实读回");
	assert.equal(payload.biosProjectId, PROJECT_ID);
	assert.equal(payload.workspaceId, WORKSPACE_ID);
	assert.equal(payload.profileId, PROJECT_ID);
	assert.equal(payload.profileRevision, 1);
	assert.equal(payload.taskId, "task-1");
	assert.equal(payload.taskProjectId, PROJECT_ID);
});

/* ------------------------------------------------------------------ B0 发布取消（第五轮 §4） */

test("B0：两个 signal 的任一取消都在提交前生效（分别只取消其一）", async () => {
	// 第五轮验收 §4 的原始场景：boundary 自身没有 signal，只有调用级 signal 被取消。
	// 旧实现 `publishJson` 只接收两个参数，callSignal 被整个忽略 → status="created"。
	const onlyCall = makeRawRoot("b0-call-only");
	const callController = new AbortController();
	const boundaryA = await createStorageBoundary({ root: onlyCall, createIfMissing: true });
	const targetA = boundaryA.resolve("registry.json");
	callController.abort();
	await assert.rejects(
		() => boundaryA.publishJson(targetA, { schemaVersion: BIOS_CONTRACTS_SCHEMA_VERSION }, callController.signal),
		(error) => error instanceof StorageError && error.code === "cancelled",
		"只取消调用级 signal 也必须失败，不能用 boundary signal 掩盖它",
	);
	assert.equal(existsSync(targetA), false, "提交 IO 未发起，目标不得被创建");
	assert.deepEqual(
		readdirSync(onlyCall).filter((name) => name.endsWith(".tmp")),
		[],
		"取消后不得留下自己的临时文件",
	);

	// 反向：只取消 boundary signal，调用级 signal 不取消，同样必须失败。
	const onlyBoundary = makeRawRoot("b0-boundary-only");
	const boundaryController = new AbortController();
	const boundaryB = await createStorageBoundary({ root: onlyBoundary, createIfMissing: true, signal: boundaryController.signal });
	const targetB = boundaryB.resolve("registry.json");
	boundaryController.abort();
	await assert.rejects(
		() => boundaryB.publishJson(targetB, { schemaVersion: BIOS_CONTRACTS_SCHEMA_VERSION }, new AbortController().signal),
		(error) => error instanceof StorageError && error.code === "cancelled",
		"只取消 boundary signal 也必须失败，不会被未取消的 callSignal 放行",
	);
	assert.equal(existsSync(targetB), false);
});

test("B0：提交等待（beforeIo link）期间取消被拦在提交 IO 之前，且不被改写成 permission-denied", async () => {
	const root = makeRawRoot("b0-wait-cancel");
	const controller = new AbortController();

	await assert.rejects(
		() =>
			initializeKnowledgeStore({
				root,
				now: NOW,
				signal: controller.signal,
				ioHooks: {
					// 恰好在提交 IO 发起之前的等待点取消：这是旧实现漏查的那个窗口。
					beforeIo: (operation) => {
						if (operation === "link") controller.abort();
					},
				},
			}),
		(error) => error instanceof StorageError && error.code === "cancelled",
	);

	assert.equal(existsSync(join(root, "registry.json")), false, "等待期间取消不得创建目标");
	assert.deepEqual(
		readdirSync(root).filter((name) => name.endsWith(".tmp")),
		[],
		"等待期间取消必须清理本次临时文件",
	);
});

test("B0：提交 IO 成功后的迟到取消仍报告真实 created，不假称回滚", async () => {
	const root = makeRawRoot("b0-late-abort");
	const controller = new AbortController();
	let targetExistedAfterLink = null;

	// 注入的 link 完成真实提交后再取消：提交点已过，返回值必须是真实的提交状态。
	const result = await initializeKnowledgeStore({
		root,
		now: NOW,
		signal: controller.signal,
		ioHooks: {
			link: async (existingPath, newPath) => {
				await realLink(existingPath, newPath);
				targetExistedAfterLink = existsSync(join(root, "registry.json"));
				controller.abort();
			},
		},
	});

	assert.equal(result.status, "created", "提交点之后取消不得把真实提交改写成未写入");
	assert.equal(targetExistedAfterLink, true);
	assert.equal(existsSync(join(root, "registry.json")), true, "已提交文件不得被删除");
	const reread = await readRegistry({ root });
	assert.equal(reread.revision, result.registry.revision);
});
