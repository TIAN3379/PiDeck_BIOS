/**
 * BM-02C3：知识库版本盘点与迁移预检（只读、有界、可取消）。
 *
 * 这一组测试要钉死的不是"能列出几个文件"，而是七件最容易写错、也最危险的事：
 *
 * 1. **只读**：扫描前后完整文件清单与 SHA-256 必须逐字节相同，且不创建原本不存在的目录；
 * 2. **不误报通过**：任何截断（条目/读取/摘要/问题/输出字节）都只能是 `incomplete`；
 * 3. **分类一致**：坏 JSON、路径/归属不符、绑定冲突、版本缺失/非法/未来版本都用**已有校验器的码**；
 * 4. **不越界**：只走固定落点，不跟随链接、不递归未知目录、不进 cache；
 * 5. **人工事项如实列出**：prepared/conflict journal、锁、`.tmp` 残留只报告，不重放、不偷锁、不清理；
 * 6. **预算真的生效**：条目/读取/输出三类预算共享且可复现，读取预算把失败尝试也计进去；
 * 7. **取消结构化**：取消穿透、不吞成功、不留打开目录的句柄；候选并发消失只报一次不重试。
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BIOS_CONTRACTS_SCHEMA_VERSION } from "../core/contracts/version.ts";
import { createRecord, createStorageBoundary, DEFAULT_PREFLIGHT_LIMITS, initializeKnowledgeStore, inspectKnowledgeStore, recordRelativeSegments, recordReviewDecision, StorageError } from "../core/storage/index.ts";

const SANDBOX = realpathSync(mkdtempSync(join(tmpdir(), "bios-preflight-")));

after(() => {
	rmSync(SANDBOX, { recursive: true, force: true });
});

const NOW = 1_700_000_000_000;
const LATER = NOW + 60_000;
const PROJECT_ID = "3f2504e0-4f89-4a1c-9a3d-1f0d3c9a4b7e";
const OTHER_PROJECT_ID = "8c1b2f44-6a5d-4b3e-9f7a-2d4c8e1b5a90";
const WORKSPACE_ID = "b7d1e9f2-3c4a-4d5e-8f9a-0b1c2d3e4f50";
/** 注入正文哨兵：它**绝不能**出现在公开报告里。 */
const SENTINEL = "SENTINEL-PREFLIGHT-9f13";

/** 本机是否支持**文件**符号链接（Windows 上需要开发者模式/管理员）。不支持时用例改写为"不适用"。 */
const FILE_SYMLINK_SUPPORTED = (() => {
	const probe = join(SANDBOX, "symlink-probe");
	try {
		mkdirSync(probe, { recursive: true });
		writeFileSync(join(probe, "target.txt"), "x", "utf8");
		symlinkSync(join(probe, "target.txt"), join(probe, "link.txt"), "file");
		return true;
	} catch {
		return false;
	}
})();

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

/* ------------------------------------------------------------------ fixture */

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

function experienceBody(overrides = {}) {
	return {
		problem: `PXE 默认开启 ${SENTINEL}`,
		rootCause: "Setup 默认值未随客户选项调整",
		solution: "在 Setup 中关闭 PXE 引导项",
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

function writeJson(path, value) {
	writeFileSync(path, `${JSON.stringify(value, null, "\t")}\n`, "utf8");
}

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

function hashFile(path) {
	return existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : null;
}

/** 递归清单（目录 + 文件哈希）：只读性判据的"同一份事实"。 */
function snapshot(root) {
	const dirs = [];
	const files = [];
	const walk = (absolute) => {
		for (const entry of readdirSync(absolute, { withFileTypes: true }).sort((left, right) => (left.name < right.name ? -1 : 1))) {
			const target = join(absolute, entry.name);
			const rel = relative(root, target).split(sep).join("/");
			if (entry.isDirectory()) {
				dirs.push(rel);
				walk(target);
				continue;
			}
			files.push(`${rel}:${hashFile(target)}`);
		}
	};
	walk(root);
	return { dirs: dirs.sort(), files: files.sort() };
}

function problemsWith(report, code) {
	return report.problems.filter((problem) => problem.code === code);
}

function summaryFor(report, relativePath) {
	return report.summaries.find((summary) => summary.relativePath === relativePath);
}

function manualWith(report, reason) {
	return report.manual.filter((item) => item.reason === reason);
}

/**
 * `outputBytes` 的**唯一可复现口径**（BM-02C3R / PF-3）：三类可变明细按
 * 「摘要 → 问题 → 人工事项」合并成一个 JSON 数组后，整体 UTF-8 字节数（含 `[`/`]` 与 `,`）。
 *
 * 关键点：这里**不**复用报告自己的 `outputBytes` 去证明 `outputBytes` 正确，
 * 而是独立按规范序列化重算一遍。
 */
function detailEnvelope(report) {
	return Buffer.byteLength(JSON.stringify([...report.summaries, ...report.problems, ...report.manual]), "utf8");
}

/**
 * 预检**实际会列举**的目录条目总数（独立于实现重算，用于"统计 == 真实观察次数"）。
 *
 * 只覆盖固定落点：`cache/` 只探测不列举，因此不计入；根目录按布局外条目逐个观察。
 */
function listedEntryCount(root) {
	const dirs = ["projects", "experiences", "features", "journal", "audit", "locks"];
	for (const projectId of existsSync(join(root, "projects")) ? readdirSync(join(root, "projects")) : []) {
		dirs.push(`projects/${projectId}`, `projects/${projectId}/tasks`, `projects/${projectId}/context`);
	}
	for (const name of existsSync(join(root, "audit")) ? readdirSync(join(root, "audit")) : []) {
		dirs.push(name === "intents" ? "audit/intents" : `audit/${name}`);
	}
	let total = readdirSync(root).length;
	for (const rel of dirs) {
		const absolute = join(root, rel);
		if (existsSync(absolute)) total += readdirSync(absolute).length;
	}
	return total;
}

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * 在**独立 Node 进程**里包装真实的 `fs.promises.opendir` / `open` 迭代器，统计底层实际观察到的目录条目数。
 *
 * 为什么必须另起进程、另数一遍（S1）：被验的缺陷正是"报告里的观察数与真实观察数不一致"，
 * 拿报告自己的字段去证明自己正确没有意义。包装只**计数**——不改返回条目、不读内容、不改上限，
 * 并且只在子进程里生效（生产代码在子进程中被 `import` 时才解析到被包装的 `opendir`）。
 *
 * 代理**完整转发**原迭代器的 `next()` / `return()` / `throw()`（S3）：生产代码用 `for await` 遍历，
 * 达到条目上限时 `break`，语言会调用迭代器的 `return()` 去关闭目录。旧代理只转发 `next()`，
 * 于是"关闭"只发生在 `finally` 的 `close()` 上，而那里调用方 `.catch()` 吞掉了错误 ——
 * 关闭故障根本进不了可见出口，红回归无从复现。转发后 `break` 走的是原关闭路径。
 *
 * 传入 `fail` 时可让**指定目录**的迭代在交出 `afterEntries` 条之后抛受控 `EIO`
 * （不额外读取下一条，用于 S2：迭代中途失败时已观察成本是否仍进预算）。
 *
 * 传入 `closeError` 时可让**指定目录**的**首次真实关闭**先完成、再把结果改成受控 `EIO`
 * （用于 S3：超限探测已消耗后，关闭/收尾失败是否被预算停止锁存挡回）。
 * 包装点在 `Dir` **构造之前**（`fs.Dir.prototype.close`）：Node 在构造异步迭代器时就绑定了
 * close promise，只替换 `opendir` 返回后的实例方法覆盖不到这条绑定（round19 §3.1）。
 *
 * 传入 `abort` 时在**指定目录**的 `opendir` 返回后立刻取消扫描，用于"取消仍结构化穿透、
 * 不被预算/关闭故障覆盖"的对照；子进程把结构化错误码原样交回（`cancelled` / `errorCode`）。
 *
 * 返回：`observed`（真实观察条目数）、`listed`（发起过 `opendir` 的目录轨迹）、
 * `opened`（打开过的文件路径）、以及报告里的
 * `scannedEntries` / `readFiles` / `complete` / `outcome` / `truncatedBy` / `problems`；
 * 取消时改为 `cancelled: true` + `errorCode`。
 */
function observePreflight({ root, limits, fail, closeError, abort }) {
	const script = `
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const fs = require("node:fs");
const fsPromises = require("node:fs/promises");
const realOpendir = fsPromises.opendir;
const realOpen = fsPromises.open;
const config = JSON.parse(process.env.PREFLIGHT_OBSERVE_OPTIONS);
const fail = config.fail ?? null;
const closeError = config.closeError ?? null;
const abort = config.abort ?? null;
const controller = abort === null ? null : new AbortController();
let aborted = false;
let abortTarget = null;
let observed = 0;
const listed = [];
const opened = [];
// 关闭故障注入必须在任何 Dir 构造前生效：Node 在迭代器构造时就绑定了 close promise，
// 构造之后再替换实例方法无法覆盖它（round19 §3.1）。这里改的是原型方法，对所有实例生效。
if (closeError !== null) {
	const realClose = fs.Dir.prototype.close;
	const injected = new WeakSet();
	fs.Dir.prototype.close = function patchedClose(callback) {
		const target = this.__pideckTarget;
		const matched = typeof target === "string" && target.includes(closeError.pathIncludes);
		// 只对**指定目录的首次关闭**注入：先让真实关闭完成，再把结果改成受控错误。
		const inject = matched && !injected.has(this);
		if (inject) injected.add(this);
		const finish = (error) => {
			if (!inject) return error;
			const injectedError = new Error(closeError.message);
			injectedError.code = closeError.code;
			return injectedError;
		};
		if (typeof callback === "function") return realClose.call(this, (error) => callback(finish(error)));
		return realClose.call(this).then(
			() => {
				if (inject) return Promise.reject(finish(new Error(closeError.message)));
			},
			(error) => {
				throw finish(error);
			},
		);
	};
}
fsPromises.opendir = async (target, openOptions) => {
	const dir = await realOpendir(target, openOptions);
	if (typeof target === "string") {
		listed.push(target);
		dir.__pideckTarget = target;
	}
	// 取消对照：目录已真实打开后再取消，句柄仍必须被配对关闭（下面会在同一进程内尝试删除目录）。
	if (controller !== null && !aborted && typeof target === "string" && target.includes(abort.pathIncludes)) {
		aborted = true;
		abortTarget = target;
		controller.abort();
	}
	const failing = fail !== null && typeof target === "string" && target.includes(fail.pathIncludes);
	let yielded = 0;
	return {
		close: () => dir.close(),
		[Symbol.asyncIterator]() {
			const inner = dir[Symbol.asyncIterator]();
			return {
				async next() {
					// 受控注入：交出 fail.afterEntries 条之后下一次 next() 抛指定 errno（不读取下一条）。
					if (failing && yielded >= fail.afterEntries) {
						const error = new Error(fail.message);
						error.code = fail.code;
						throw error;
					}
					const result = await inner.next();
					if (!result.done) {
						observed += 1;
						yielded += 1;
					}
					return result;
				},
				// break / 提前退出触发的关闭路径必须原样转发（S3），否则关闭故障永远不触发。
				async return(value) {
					const result = inner.return ? await inner.return(value) : { value, done: true };
					return result;
				},
				async throw(error) {
					if (inner.throw) return inner.throw(error);
					throw error;
				},
			};
		},
	};
};
fsPromises.open = async (target, flags, mode) => {
	opened.push(String(target));
	return realOpen(target, flags, mode);
};
const { inspectKnowledgeStore } = await import(config.entryUrl);
try {
	const report = await inspectKnowledgeStore({ root: config.root, limits: config.limits, ...(controller === null ? {} : { signal: controller.signal }) });
	process.stdout.write(JSON.stringify({
		cancelled: false,
		observed,
		listed,
		opened,
		scannedEntries: report.scannedEntries,
		readFiles: report.readFiles,
		complete: report.complete,
		outcome: report.outcome,
		truncatedBy: report.truncatedBy,
		droppedProblems: report.droppedProblems,
		blockingProblems: report.blockingProblems,
		problems: report.problems.map((problem) => ({ code: problem.code, message: problem.message, relativePath: problem.relativePath })),
	}));
} catch (error) {
	// 取消必须结构化穿透：子进程只交回错误码，不把原始正文带进报告。
	// 句柄配对：取消后**在同一个进程里**立刻删除刚打开的目录（Windows 上未关闭的句柄会挡住删除），
	// 不依赖 GC 或子进程退出。
	let removedAfterCancel = null;
	if (abortTarget !== null) {
		try {
			fs.rmSync(abortTarget, { recursive: true, force: true });
			removedAfterCancel = true;
		} catch {
			removedAfterCancel = false;
		}
	}
	process.stdout.write(JSON.stringify({ cancelled: true, errorCode: typeof error === "object" && error !== null ? (error.code ?? null) : null, removedAfterCancel, observed, listed }));
}
`;
	const stdout = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
		cwd: PACKAGE_ROOT,
		env: {
			...process.env,
			PREFLIGHT_OBSERVE_OPTIONS: JSON.stringify({ root, limits, fail, closeError, abort, entryUrl: pathToFileURL(join(PACKAGE_ROOT, "core/storage/index.ts")).href }),
		},
		encoding: "utf8",
		maxBuffer: 16 * 1024 * 1024,
	});
	return JSON.parse(stdout);
}

function expectStorageError(code, detailPart) {
	return (error) => {
		assert.ok(error instanceof StorageError, `必须是 StorageError，实际：${String(error)}`);
		assert.equal(error.code, code);
		if (detailPart !== undefined) assert.ok(typeof error.detail === "string" && error.detail.includes(detailPart), `detail 应包含 ${detailPart}：${String(error.detail)}`);
		return true;
	};
}

/** 记录文件是**扁平**的 `{...header, ...body}`（与 createRecord 写出的字节同构）。 */
function recordValue(id, body, overrides = {}) {
	return { schemaVersion: BIOS_CONTRACTS_SCHEMA_VERSION, revision: 0, createdAt: NOW, updatedAt: NOW, id, ...body, ...overrides };
}

function registryValue(projects) {
	return { schemaVersion: BIOS_CONTRACTS_SCHEMA_VERSION, revision: 1, createdAt: 1, updatedAt: 1, projects };
}

function projectEntry(biosProjectId, path) {
	return { biosProjectId, workspaces: [{ workspaceId: WORKSPACE_ID, path, boundAt: 1 }], createdAt: 1, updatedAt: 1 };
}

/** 登记一个项目（与 storageRegistry 的测试同一份 registry 形状）。 */
function registerProject(root, projectId) {
	writeJson(join(root, "registry.json"), registryValue([projectEntry(projectId, join(SANDBOX, "ws-main"))]));
}

/** 五类记录 + 一次真实审核（v1 与 v2 journal、意图、事件共存）。 */
async function createRichStore(name) {
	const root = await makeStoreRoot(name);
	registerProject(root, PROJECT_ID);
	await createRecord({ root, kind: "project-profile", id: PROJECT_ID, expectedRevision: null, now: NOW, data: profileBody() });
	await createRecord({ root, kind: "task-record", id: "task-1", projectId: PROJECT_ID, expectedRevision: null, now: NOW, data: taskBody("实现 PXE 开关") });
	await createRecord({ root, kind: "context-manifest", id: "ctx-1", projectId: PROJECT_ID, expectedRevision: null, now: NOW, data: contextBody() });
	await createRecord({ root, kind: "feature-record", id: "feat-1", expectedRevision: null, now: NOW, data: featureBody("支持客户定制引导顺序") });
	await createRecord({ root, kind: "experience-card", id: "exp-a", expectedRevision: null, now: NOW, data: experienceBody() });
	const review = await recordReviewDecision({ root, recordId: "exp-a", expectedRevision: 0, action: "approve", operatorLabel: "bob", reason: "证据充分", now: LATER });
	return { root, review };
}

/* ------------------------------------------------------------------ 1. 合法库与版本盘点 */

test("C3：初始化库与五类记录、v1/v2 journal、意图/事件共存 → 无需格式迁移", async (t) => {
	await t.test("空初始化库：结论为 no-migration-needed，可选目录缺席不误报", async () => {
		const root = await makeStoreRoot("preflight-empty");
		const report = await inspectKnowledgeStore({ root });

		assert.equal(report.outcome, "no-migration-needed");
		assert.equal(report.complete, true);
		assert.deepEqual(report.truncatedBy, []);
		assert.deepEqual(report.problems, []);
		assert.deepEqual(report.manual, []);
		assert.equal(report.blockingProblems, 0);
		assert.equal(report.scanSemantics, "observed-not-snapshot");
		assert.deepEqual(summaryFor(report, "registry.json")?.status, "ok");
		// journal/ 是惰性目录：缺席 = 未使用，不是"布局不完整"。
		assert.equal(existsSync(join(root, "journal")), false);
		assert.deepEqual(report.versions, [{ family: "registry", version: BIOS_CONTRACTS_SCHEMA_VERSION, files: 1 }]);
	});

	await t.test("富库：v1（普通写）与 v2（审核）都是支持的版本，v2 不被当成未来业务格式", async () => {
		const { root } = await createRichStore("preflight-rich");
		const report = await inspectKnowledgeStore({ root });

		assert.equal(report.outcome, "no-migration-needed", JSON.stringify({ problems: report.problems, manual: report.manual }));
		assert.equal(report.complete, true);
		assert.deepEqual(report.problems, []);
		assert.deepEqual(report.manual, []);

		// 版本分布：五类记录 + registry + journal v1/v2 + 意图/事件。
		const versions = new Map(report.versions.map((entry) => [`${entry.family}:${entry.version}`, entry.files]));
		assert.equal(versions.get("registry:1"), 1);
		assert.equal(versions.get("record:1"), 5);
		assert.equal(versions.get("journal:1"), 5, "五次普通创建各写一条 v1 journal");
		assert.equal(versions.get("journal:2"), 1, "一次审核写一条审核专用 v2 journal");
		assert.equal(versions.get("audit-intent:1"), 1);
		assert.equal(versions.get("audit-event:1"), 1);
		assert.equal(problemsWith(report, "unsupported-journal-version").length, 0, "v2 是受支持的审核 journal，不是未知版本");

		// 受支持版本表把 journal 1/2 都列出来（唯一来源是契约常量）。
		const supportedJournal = report.supportedVersions.filter((entry) => entry.family === "journal").map((entry) => entry.version);
		assert.deepEqual([...supportedJournal].sort(), [1, 2]);
		// 事件与意图都在版本统计内，且 summary 给出受控路径。
		assert.ok(report.summaries.some((summary) => summary.category === "audit-intent" && summary.status === "ok"));
		assert.ok(report.summaries.some((summary) => summary.category === "audit-event" && summary.status === "ok"));
		assert.ok(report.summaries.some((summary) => summary.category === "journal" && summary.version === 2));
		// cache 明确"未检查"，不进入版本统计。
		assert.equal(summaryFor(report, "cache/")?.status, "unchecked");
		assert.equal(
			report.versions.some((entry) => entry.family === "journal" && entry.version === null),
			false,
		);
	});
});

/* ------------------------------------------------------------------ 2. 缺档案 / 孤立项目 */

test("C3：登记项目缺档案、未登记项目候选（不自动合并、不创建空库）", async (t) => {
	await t.test("registry.json 不存在：明确阻断，且不创建任何目录", async () => {
		const root = makeRawRoot("preflight-no-registry");
		const report = await inspectKnowledgeStore({ root });

		assert.equal(report.outcome, "blocked");
		assert.equal(report.complete, true, "看不完才算 incomplete；缺 registry 是确定的阻断");
		const registryProblem = problemsWith(report, "not-found").find((problem) => problem.relativePath === "registry.json");
		assert.ok(registryProblem, JSON.stringify(report.problems));
		assert.equal(registryProblem.category, "registry");
		assert.equal(registryProblem.blocks, true);
		// 不初始化、不建目录：raw root 保持原样。
		assert.deepEqual(readdirSync(root), []);
	});

	await t.test("已登记项目缺 profile.json：报问题但仍扫描该项目下的任务/上下文", async () => {
		const root = await makeStoreRoot("preflight-missing-profile");
		registerProject(root, PROJECT_ID);
		await createRecord({ root, kind: "task-record", id: "task-1", projectId: PROJECT_ID, expectedRevision: null, now: NOW, data: taskBody("实现 PXE 开关") });
		rmSync(recordPath(root, "project-profile", PROJECT_ID), { force: true });

		const report = await inspectKnowledgeStore({ root });
		assert.equal(report.outcome, "blocked");
		const problem = problemsWith(report, "not-found").find((entry) => entry.relativePath === `projects/${PROJECT_ID}/profile.json`);
		assert.ok(problem, JSON.stringify(report.problems));
		assert.equal(problem.category, "project-profile");
		// 缺档案不影响同一项目下受控候选的盘点。
		assert.equal(summaryFor(report, `projects/${PROJECT_ID}/tasks/task-1.json`)?.status, "ok");
	});

	await t.test("未登记项目目录：列为孤立候选（人工事项），不自动关联、不删除", async () => {
		const root = await makeStoreRoot("preflight-orphan");
		registerProject(root, PROJECT_ID);
		const orphanId = "5c2f4a31-7b6d-4f92-8e1a-3d5b7c9e2f40";
		mkdirSync(join(root, "projects", orphanId), { recursive: true });
		writeJson(recordPath(root, "project-profile", orphanId), recordValue(orphanId, profileBody()));

		const report = await inspectKnowledgeStore({ root });
		assert.equal(report.outcome, "blocked");
		const orphan = manualWith(report, "unregistered-project");
		assert.equal(orphan.length, 1, JSON.stringify(report.manual));
		assert.equal(orphan[0].relativePath, `projects/${orphanId}`);
		// 孤立候选仍然被扫描（不遗漏它下面的受控候选），也不被写进 registry。
		assert.equal(summaryFor(report, `projects/${orphanId}/profile.json`)?.status, "ok");
		assert.deepEqual(
			readJson(join(root, "registry.json")).projects.map((project) => project.biosProjectId),
			[PROJECT_ID],
		);
	});
});

/* ------------------------------------------------------------------ 3. 分类与已知校验器一致 */

test("C3：坏 JSON、路径/归属不符、绑定冲突、版本缺失/非法/未来版本都用已知校验器的码", async (t) => {
	await t.test("坏 JSON / 归属不符 / 同名目录：invalid-json、record-id-mismatch、not-a-file", async () => {
		const root = await makeStoreRoot("preflight-bad-inputs");
		registerProject(root, PROJECT_ID);
		// 坏 JSON（原字节保留）。
		writeFileSync(join(root, "experiences", "exp-b.json"), "{ 不是 json\n", "utf8");
		const brokenBytes = hashFile(join(root, "experiences", "exp-b.json"));
		// 合法结构但内容 ID 与文件名不符。
		writeJson(join(root, "experiences", "exp-c.json"), recordValue("exp-other", experienceBody()));
		// 任务记录的 projectId 与所在项目不符。
		mkdirSync(join(root, "projects", PROJECT_ID, "tasks"), { recursive: true });
		writeJson(recordPath(root, "task-record", "task-9", PROJECT_ID), recordValue("task-9", taskBody("错归属"), { projectId: OTHER_PROJECT_ID }));
		// 覆盖在受控文件名上的目录（非普通文件）。
		mkdirSync(join(root, "experiences", "exp-dir.json"), { recursive: true });

		const report = await inspectKnowledgeStore({ root });
		assert.equal(report.outcome, "blocked");
		assert.equal(problemsWith(report, "invalid-json").length, 1, JSON.stringify(report.problems));
		assert.equal(problemsWith(report, "record-id-mismatch").length, 2, JSON.stringify(report.problems.map((problem) => [problem.relativePath, problem.code])));
		assert.equal(problemsWith(report, "not-a-file").length, 1);
		assert.equal(hashFile(join(root, "experiences", "exp-b.json")), brokenBytes, "坏文件原字节必须保留");
	});

	await t.test("registry 绑定冲突（同一路径归属两个项目）→ binding-conflict", async () => {
		const root = await makeStoreRoot("preflight-binding");
		writeJson(join(root, "registry.json"), registryValue([projectEntry(PROJECT_ID, join(SANDBOX, "ws-main")), projectEntry(OTHER_PROJECT_ID, join(SANDBOX, "ws-main"))]));

		const report = await inspectKnowledgeStore({ root });
		assert.equal(report.outcome, "blocked");
		const conflict = problemsWith(report, "binding-conflict");
		assert.equal(conflict.length, 1, JSON.stringify(report.problems));
		assert.equal(conflict[0].category, "registry");
	});

	await t.test("版本：记录 schemaVersion 未来 / journal 未来版本 / 意图未来版本", async () => {
		const root = await makeStoreRoot("preflight-versions");
		registerProject(root, PROJECT_ID);
		writeJson(join(root, "experiences", "exp-future.json"), recordValue("exp-future", experienceBody(), { schemaVersion: 99 }));
		// 合法的 v1 journal 改成未来版本（目录与文件名保持受控形状）。
		await createRecord({ root, kind: "experience-card", id: "exp-a", expectedRevision: null, now: NOW, data: experienceBody() });
		const journalName = readdirSync(join(root, "journal")).find((name) => name.endsWith(".json"));
		const journalValue = readJson(join(root, "journal", journalName));
		writeJson(join(root, "journal", journalName), { ...journalValue, journalVersion: 99 });
		// 意图未来版本：先发布一份合法意图，再改版本。
		const review = await recordReviewDecision({ root, recordId: "exp-a", expectedRevision: 0, action: "approve", operatorLabel: "bob", reason: "ok", now: LATER });
		const intentName = readdirSync(join(root, "audit", "intents"))[0];
		const intentValue = readJson(join(root, "audit", "intents", intentName));
		writeJson(join(root, "audit", "intents", intentName), { ...intentValue, intentVersion: 99 });

		const report = await inspectKnowledgeStore({ root });
		assert.equal(report.outcome, "blocked");
		const record = summaryFor(report, "experiences/exp-future.json");
		assert.equal(record?.status, "unsupported-version");
		assert.equal(record?.code, "unsupported-schema-version");
		assert.equal(record?.version, 99, "未来版本号要如实报告，不猜结构");

		const journal = summaryFor(report, `journal/${journalName}`);
		assert.equal(journal?.status, "unsupported-version");
		assert.equal(journal?.code, "unsupported-journal-version");
		assert.equal(journal?.version, 99);

		const intent = summaryFor(report, `audit/intents/${intentName}`);
		assert.equal(intent?.status, "unsupported-version");
		assert.equal(intent?.code, "unsupported-audit-intent-version");
		assert.equal(intent?.version, 99);
		assert.equal(
			report.versions.some((entry) => entry.family === "audit-intent" && entry.version === 99),
			true,
		);
		assert.equal(
			report.versions.some((entry) => entry.family === "journal" && entry.version === 99),
			true,
		);
		void review;
	});

	await t.test("journal 版本字段缺失 / 非法 → 不猜字段", async () => {
		const root = await makeStoreRoot("preflight-journal-version");
		registerProject(root, PROJECT_ID);
		await createRecord({ root, kind: "experience-card", id: "exp-a", expectedRevision: null, now: NOW, data: experienceBody() });
		const journalName = readdirSync(join(root, "journal")).find((name) => name.endsWith(".json"));
		const value = readJson(join(root, "journal", journalName));
		writeJson(join(root, "journal", journalName), { ...value, journalVersion: "1" });

		const report = await inspectKnowledgeStore({ root });
		const summary = summaryFor(report, `journal/${journalName}`);
		assert.equal(summary?.status, "invalid");
		assert.equal(summary?.code, "invalid-journal");
		assert.equal(summary?.version, null);
	});
});

/* ------------------------------------------------------------------ 4. 人工事项（只报告） */

test("C3：prepared/conflict journal、锁与 .tmp 残留只列人工事项，不重放、不偷锁、不清理", async (t) => {
	await t.test("prepared v2（审核已提交但事件未发布）→ prepared-journal，journal 字节不变、不抢锁", async () => {
		const root = await makeStoreRoot("preflight-prepared");
		registerProject(root, PROJECT_ID);
		await createRecord({ root, kind: "experience-card", id: "exp-a", expectedRevision: null, now: NOW, data: experienceBody() });
		// 让事件发布失败：业务已提交 + v2 prepared + 意图已落盘。
		const pending = await recordReviewDecision({
			root,
			recordId: "exp-a",
			expectedRevision: 0,
			action: "approve",
			operatorLabel: "bob",
			reason: "ok",
			now: LATER,
			ioHooks: {
				link: async (existingPath, newPath) => {
					if (newPath.includes(`${sep}audit${sep}exp-a${sep}`)) throw Object.assign(new Error("注入：事件发布失败"), { code: "ENOSPC" });
					const { link } = await import("node:fs/promises");
					return await link(existingPath, newPath);
				},
			},
		});
		assert.equal(pending.kind, "applied-audit-pending");

		const journalPath = join(root, "journal", `${pending.operationId}.json`);
		const journalBytes = hashFile(journalPath);
		const locksBefore = existsSync(join(root, "locks")) ? readdirSync(join(root, "locks")).sort() : [];

		const report = await inspectKnowledgeStore({ root });
		assert.equal(report.outcome, "blocked");
		const prepared = manualWith(report, "prepared-journal");
		assert.equal(prepared.length, 1, JSON.stringify(report.manual));
		assert.equal(prepared[0].relativePath, `journal/${pending.operationId}.json`);
		assert.equal(summaryFor(report, `journal/${pending.operationId}.json`)?.version, 2, "prepared 的审核 v2 仍然是受支持版本");
		// 只报告：字节不变、锁不变（不偷锁、不回收）。
		assert.equal(hashFile(journalPath), journalBytes);
		assert.deepEqual(existsSync(join(root, "locks")) ? readdirSync(join(root, "locks")).sort() : [], locksBefore);
	});

	await t.test("conflict v1 journal → conflict-journal 人工事项", async () => {
		const root = await makeStoreRoot("preflight-conflict");
		registerProject(root, PROJECT_ID);
		await createRecord({ root, kind: "experience-card", id: "exp-a", expectedRevision: null, now: NOW, data: experienceBody() });
		const journalName = readdirSync(join(root, "journal")).find((name) => name.endsWith(".json"));
		const journalPath = join(root, "journal", journalName);
		const value = readJson(journalPath);
		// 合法的 conflict 只能由恢复观察产生（这与 v1 契约一致）。
		writeJson(journalPath, { ...value, state: "conflict", source: "recovery-observed" });

		const report = await inspectKnowledgeStore({ root });
		const conflict = manualWith(report, "conflict-journal");
		assert.equal(conflict.length, 1, JSON.stringify(report.manual));
		assert.equal(conflict[0].relativePath, `journal/${journalName}`);
		assert.equal(problemsWith(report, "invalid-journal").length, 0, "合法的 conflict journal 不是'坏文件'");
	});

	await t.test("锁目录与 .tmp 残留：只报告存在，不按 PID/年龄判断、不删除", async () => {
		const root = await makeStoreRoot("preflight-locks");
		const lockName = "lock-0123456789abcdef0123456789abcdef";
		mkdirSync(join(root, "locks", lockName), { recursive: true });
		writeJson(join(root, "locks", lockName, "owner.json"), { ownerId: "11111111-2222-4333-8444-555555555555", pid: 4242, createdAt: NOW, target: "experiences/exp-a.json" });
		const residueName = ".exp-a.json.4242.deadbeef.tmp";
		writeFileSync(join(root, "experiences", residueName), "{}", "utf8");
		const junkName = "notes.txt";
		writeFileSync(join(root, "experiences", junkName), `记录外的说明 ${SENTINEL}`, "utf8");

		const report = await inspectKnowledgeStore({ root });
		assert.equal(report.outcome, "blocked");
		assert.equal(manualWith(report, "lock-present").length, 1);
		assert.equal(manualWith(report, "lock-present")[0].relativePath, `locks/${lockName}`);
		assert.equal(manualWith(report, "temp-residue").length, 1);
		assert.equal(problemsWith(report, "unknown-entry").length, 1, "记录目录里的非 JSON 条目要诊断（阻断）");
		assert.equal(problemsWith(report, "unknown-entry")[0].blocks, true);
		// 只报告：锁与残留都还在，正文哨兵没进报告。
		assert.equal(existsSync(join(root, "locks", lockName, "owner.json")), true);
		assert.equal(existsSync(join(root, "experiences", residueName)), true);
		assert.equal(existsSync(join(root, "experiences", junkName)), true);
		assert.equal(JSON.stringify(report).includes(SENTINEL), false, "报告不得包含记录正文/注释正文");
	});
});

/* ------------------------------------------------------------------ 5. 大小与链接 */

test("C3：超大/增长文件、非普通文件与链接（根/中间目录/叶子）都保守拒绝", async (t) => {
	await t.test("超出单文件上限 → too-large，并按预留额度计入读取预算", async () => {
		const root = await makeStoreRoot("preflight-too-large");
		registerProject(root, PROJECT_ID);
		await createRecord({ root, kind: "experience-card", id: "exp-a", expectedRevision: null, now: NOW, data: experienceBody() });

		const report = await inspectKnowledgeStore({ root, limits: { maxFileBytes: 32 } });
		const summary = summaryFor(report, "experiences/exp-a.json");
		assert.equal(summary?.status, "invalid");
		assert.equal(summary?.code, "too-large");
		// 失败尝试没有"实际字节"，按预留额度 32 计入（与 readBytes 分开报告）。
		assert.equal(report.reservedBytes > 0, true);
		assert.equal(report.limits.maxFileBytes, 32);
	});

	await t.test("文件在读取期间增长（stat 报小值）→ 仍然有界，不无限读", async () => {
		const root = await makeStoreRoot("preflight-growing");
		registerProject(root, PROJECT_ID);
		await createRecord({ root, kind: "experience-card", id: "exp-a", expectedRevision: null, now: NOW, data: experienceBody() });

		const report = await inspectKnowledgeStore({
			root,
			limits: { maxFileBytes: 64 },
			ioHooks: { stat: async () => ({ isFile: () => true, size: 1 }) },
		});
		assert.equal(summaryFor(report, "experiences/exp-a.json")?.code, "too-large");
		assert.equal(report.readBytes <= 64 * 8, true, "读取必须停在预算附近，不能把整库读完");
	});

	await t.test("中间目录是 junction → symlink-rejected，且不读取链接目标内容", async (context) => {
		const root = await makeStoreRoot("preflight-dir-link");
		const outside = makeRawRoot("preflight-outside");
		writeJson(join(outside, "exp-outside.json"), { schemaVersion: BIOS_CONTRACTS_SCHEMA_VERSION, revision: 0, createdAt: NOW, updatedAt: NOW, id: "exp-outside", data: experienceBody() });
		const outsideBytes = hashFile(join(outside, "exp-outside.json"));
		rmSync(join(root, "experiences"), { recursive: true, force: true });
		try {
			symlinkSync(outside, join(root, "experiences"), "junction");
		} catch (error) {
			// 本机无法建立 junction（需要开发者模式/管理员权限）：与叶子链接同一口径，
			// **显式 skip 并说明原因**，不用空返回占位冒充通过。
			context.skip(`本机无法创建目录 junction：${String(error)}`);
			return;
		}

		const report = await inspectKnowledgeStore({ root });
		assert.equal(report.outcome, "blocked");
		const link = problemsWith(report, "symlink-rejected");
		assert.equal(link.length, 1, JSON.stringify(report.problems));
		assert.equal(link[0].relativePath, "experiences");
		// 链接目标里的记录**不得**被读成候选。
		assert.equal(
			report.summaries.some((summary) => summary.relativePath.includes("exp-outside")),
			false,
		);
		assert.equal(hashFile(join(outside, "exp-outside.json")), outsideBytes);
	});

	await t.test("叶子文件链接（本机支持时）→ symlink-rejected，且目标未被读取", async (context) => {
		if (!FILE_SYMLINK_SUPPORTED) {
			// 本机 `symlinkSync(..., "file")` 因缺开发者模式/管理员权限返回 EPERM（Windows 常见）：
			// **显式 skip 并说明原因**，不用空的"不适用"子测试冒充通过（BM-02C3R 环境证据修正）。
			context.skip("本机无法建立文件符号链接（Windows 需要开发者模式/管理员权限）：叶子链接行为未验证");
			return;
		}
		const root = await makeStoreRoot("preflight-leaf-link");
		const outside = makeRawRoot("preflight-leaf-outside");
		const outsideFile = join(outside, "exp-outside.json");
		writeJson(outsideFile, { schemaVersion: BIOS_CONTRACTS_SCHEMA_VERSION, revision: 0, createdAt: NOW, updatedAt: NOW, id: "exp-x", data: experienceBody() });
		const outsideBytes = hashFile(outsideFile);
		symlinkSync(outsideFile, join(root, "experiences", "exp-x.json"), "file");

		const report = await inspectKnowledgeStore({ root });
		assert.equal(problemsWith(report, "symlink-rejected").length, 1, JSON.stringify(report.problems));
		assert.equal(hashFile(outsideFile), outsideBytes);
	});

	await t.test("根不是目录 / 根不存在 / 相对根 → 结构化拒绝，不降级为空库", async () => {
		const fileRoot = join(SANDBOX, "preflight-root-file.txt");
		writeFileSync(fileRoot, "not a dir", "utf8");
		await assert.rejects(inspectKnowledgeStore({ root: fileRoot }), expectStorageError("invalid-root"));
		await assert.rejects(inspectKnowledgeStore({ root: join(SANDBOX, "preflight-missing-root") }), expectStorageError("invalid-root"));
		await assert.rejects(inspectKnowledgeStore({ root: "relative-root" }), (error) => {
			assert.ok(error instanceof Error);
			assert.match(error.message, /完全限定|absolute|relative/i);
			return true;
		});
	});
});

/* ------------------------------------------------------------------ 6. 预算与限额 */

test("C3：共享条目预算、摘要/问题/输出字节预算、非法限额与 0/undefined 语义", async (t) => {
	await t.test("条目预算共享：截断 ⇒ incomplete，永远不给通过", async () => {
		const root = await makeStoreRoot("preflight-scan-budget");
		registerProject(root, PROJECT_ID);
		for (const id of ["exp-a", "exp-b", "exp-c", "exp-d"]) {
			await createRecord({ root, kind: "experience-card", id, expectedRevision: null, now: NOW, data: experienceBody() });
		}
		const report = await inspectKnowledgeStore({ root, limits: { maxScanEntries: 4 } });

		assert.equal(report.complete, false);
		assert.equal(report.outcome, "incomplete");
		assert.ok(report.truncatedBy.includes("scan-entries"));
		assert.ok(report.scannedEntries <= 4 + 1, `条目预算必须生效：${report.scannedEntries}`);
	});

	await t.test("摘要与问题预算：截断仍保留阻断结论（列表可截断、结论不可）", async () => {
		const root = await makeStoreRoot("preflight-output-budget");
		registerProject(root, PROJECT_ID);
		for (const id of ["exp-a", "exp-b", "exp-c"]) {
			await createRecord({ root, kind: "experience-card", id, expectedRevision: null, now: NOW, data: experienceBody() });
		}
		writeFileSync(join(root, "experiences", "exp-bad.json"), "{ 坏\n", "utf8");

		const summaries = await inspectKnowledgeStore({ root, limits: { maxFileSummaries: 1 } });
		assert.equal(summaries.complete, false);
		assert.equal(summaries.outcome, "incomplete");
		assert.ok(summaries.truncatedBy.includes("file-summaries"));
		assert.equal(summaries.droppedSummaries > 0, true);
		assert.equal(summaries.summaries.length, 1);

		const problems = await inspectKnowledgeStore({ root, limits: { maxProblems: 0 } });
		assert.deepEqual(problems.problems, []);
		assert.equal(problems.droppedProblems > 0, true);
		assert.ok(problems.truncatedBy.includes("problems"));
		assert.equal(problems.blockingProblems > 0, true, "阻断计数不被问题预算裁剪");
		assert.equal(problems.outcome, "incomplete", "看不完不能算通过");
	});

	await t.test("输出字节预算按真实 UTF-8 字节计量（不是字符数）", async () => {
		const root = await makeStoreRoot("preflight-bytes");
		for (const id of ["exp-a", "exp-b", "exp-c"]) {
			await createRecord({ root, kind: "experience-card", id, expectedRevision: null, now: NOW, data: experienceBody() });
		}
		writeFileSync(join(root, "experiences", "exp-bad.json"), "{ 坏\n", "utf8");

		const wide = await inspectKnowledgeStore({ root, limits: { maxOutputBytes: 1_000_000 } });
		// 口径（BM-02C3R / PF-3）：三类明细合并数组的实际序列化字节（含数组括号与逗号分隔符），
		// 人工事项同样计入——旧断言只累加逐条字节，漏掉括号/分隔符，等于用自身计数证明自身。
		assert.equal(wide.outputBytes, detailEnvelope(wide), "outputBytes 必须等于明细合并数组的真实 UTF-8 字节");
		assert.ok(wide.outputBytes > wide.summaries.length + wide.problems.length, "中文诊断下字节数明显大于条目数（字符数会低估）");

		// 预算卡在"字符数够、字节数不够"之间：必须按字节截断。
		const narrow = await inspectKnowledgeStore({ root, limits: { maxOutputBytes: Math.max(1, wide.outputBytes - 1) } });
		assert.equal(narrow.complete, false);
		assert.ok(narrow.truncatedBy.includes("output-bytes"));
		assert.equal(narrow.outcome, "incomplete");
	});

	await t.test("0 与 undefined 语义：0 = 明确不做，undefined 保持默认", async () => {
		const root = await makeStoreRoot("preflight-zero");
		registerProject(root, PROJECT_ID);
		await createRecord({ root, kind: "experience-card", id: "exp-a", expectedRevision: null, now: NOW, data: experienceBody() });

		const noRead = await inspectKnowledgeStore({ root, limits: { maxReadBytes: 0 } });
		assert.equal(noRead.complete, false);
		assert.equal(noRead.outcome, "incomplete");
		assert.ok(noRead.truncatedBy.includes("read-bytes"));
		assert.equal(noRead.readBytes, 0);
		assert.equal(noRead.reservedBytes, 0);

		const noScan = await inspectKnowledgeStore({ root, limits: { maxScanEntries: 0 } });
		assert.equal(noScan.complete, false);
		assert.ok(noScan.truncatedBy.includes("scan-entries"));
		// 条目预算从第一条起就生效（"已登记项目在磁盘上缺席"这一检查同样消耗条目）。
		assert.ok(noScan.scannedEntries <= 1);
		assert.equal(
			noScan.problems.some((problem) => problem.relativePath.startsWith("experiences/")),
			false,
			"预算耗尽后不得继续盘点记录",
		);

		const noMessage = await inspectKnowledgeStore({ root, limits: { maxIssueChars: 0, maxFileBytes: 1 } });
		assert.ok(noMessage.problems.length > 0);
		assert.equal(
			noMessage.problems.every((problem) => problem.message === ""),
			true,
		);

		const withUndefined = await inspectKnowledgeStore({ root, limits: { maxScanEntries: undefined } });
		assert.equal(withUndefined.limits.maxScanEntries, DEFAULT_PREFLIGHT_LIMITS.maxScanEntries);
	});

	await t.test("非法限额：NaN / 负数 / 小数 / Infinity 一律 invalid-limits", async () => {
		const root = await makeStoreRoot("preflight-invalid-limits");
		for (const value of [Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY]) {
			await assert.rejects(inspectKnowledgeStore({ root, limits: { maxReadBytes: value } }), expectStorageError("invalid-limits", "preflight-maxReadBytes"));
		}
	});
});

/* ------------------------------------------------------------------ 7. 取消与并发 */

test("C3：取消穿透、无句柄泄漏、并发候选消失只报一次", async (t) => {
	await t.test("读取等待点取消 → cancelled（不吞成成功）", async () => {
		const root = await makeStoreRoot("preflight-cancel-read");
		registerProject(root, PROJECT_ID);
		await createRecord({ root, kind: "experience-card", id: "exp-a", expectedRevision: null, now: NOW, data: experienceBody() });
		const controller = new AbortController();

		await assert.rejects(
			inspectKnowledgeStore({
				root,
				signal: controller.signal,
				ioHooks: {
					beforeIo: (operation, target) => {
						if (operation === "read" && typeof target === "string" && target.includes(`${sep}experiences${sep}`)) controller.abort();
						return undefined;
					},
				},
			}),
			expectStorageError("cancelled"),
		);
	});

	await t.test("列目录等待点取消 → cancelled，且不留下打开目录的句柄（根可立即删除）", async () => {
		const root = await makeStoreRoot("preflight-cancel-opendir");
		const controller = new AbortController();
		await assert.rejects(
			inspectKnowledgeStore({
				root,
				signal: controller.signal,
				ioHooks: {
					beforeIo: (operation) => {
						if (operation === "opendir") controller.abort();
						return undefined;
					},
				},
			}),
			expectStorageError("cancelled"),
		);
		// Windows 上未关闭的目录句柄会挡住删除；能删掉说明句柄已配对清理。
		rmSync(root, { recursive: true, force: true });
		assert.equal(existsSync(root), false);
	});

	await t.test("候选在读取前消失 → not-found 诊断一次，不重试、不无限循环", async () => {
		const root = await makeStoreRoot("preflight-vanished");
		registerProject(root, PROJECT_ID);
		await createRecord({ root, kind: "experience-card", id: "exp-a", expectedRevision: null, now: NOW, data: experienceBody() });
		await createRecord({ root, kind: "experience-card", id: "exp-b", expectedRevision: null, now: NOW, data: experienceBody() });
		const target = join(root, "experiences", "exp-b.json");
		let openAttempts = 0;

		const report = await inspectKnowledgeStore({
			root,
			ioHooks: {
				beforeIo: (operation, path) => {
					if (operation !== "open" || typeof path !== "string" || path !== target) return undefined;
					openAttempts += 1;
					rmSync(target, { force: true });
					return undefined;
				},
			},
		});

		assert.equal(openAttempts, 1, "并发消失的候选只读一次，不重试");
		const vanished = report.problems.filter((problem) => problem.relativePath === "experiences/exp-b.json");
		assert.equal(vanished.length, 1, JSON.stringify(report.problems));
		assert.equal(vanished[0].code, "not-found");
		assert.equal(report.complete, true, "单个候选消失是确定结论，不是截断");
		assert.equal(report.outcome, "blocked");
	});
});

/* ------------------------------------------------------------------ 8. 只读与不泄漏 */

test("C3：只读（清单与 SHA-256 不变、不建目录、不泄漏正文）", async () => {
	const { root } = await createRichStore("preflight-readonly");
	// 现场里再加锁、残留与 cache 内容，确认它们都在"不变"的范围内。
	mkdirSync(join(root, "locks", "lock-0123456789abcdef0123456789abcdef"), { recursive: true });
	writeJson(join(root, "locks", "lock-0123456789abcdef0123456789abcdef", "owner.json"), { ownerId: "11111111-2222-4333-8444-555555555555", pid: 4242, createdAt: NOW, target: "experiences/exp-a.json" });
	writeFileSync(join(root, "experiences", ".exp-a.json.4242.deadbeef.tmp"), "{}", "utf8");
	writeFileSync(join(root, "cache", "scratch.json"), `{"note":"${SENTINEL}"}`, "utf8");
	writeFileSync(join(root, "notes.md"), `根目录说明 ${SENTINEL}`, "utf8");

	const before = snapshot(root);
	const report = await inspectKnowledgeStore({ root });
	const after = snapshot(root);

	assert.deepEqual(after, before, "扫描前后目录清单与逐文件 SHA-256 必须完全相同");
	assert.equal(JSON.stringify(report).includes(SENTINEL), false, "公开报告不得出现正文/说明哨兵");
	assert.equal(report.root, root);
	assert.deepEqual(report.limits, DEFAULT_PREFLIGHT_LIMITS);
	// 根目录布局外的条目只报告、不阻断（与"记录目录内的未知条目"区分）；
	// `.tmp` 残留走人工事项而不是问题列表。
	const unknown = problemsWith(report, "unknown-entry");
	assert.equal(unknown.length, 1, JSON.stringify(report.problems.map((problem) => [problem.relativePath, problem.code, problem.blocks])));
	assert.equal(unknown[0].relativePath, "./#unknown-name");
	assert.equal(unknown[0].blocks, false);
	assert.equal(manualWith(report, "temp-residue").length, 1);
	assert.equal(manualWith(report, "lock-present").length, 1);
	// 预检没有产生任何新的 `.tmp`（只读的另一种表现）。
	assert.deepEqual(
		readdirSync(join(root, "experiences")).filter((name) => name.endsWith(".tmp")),
		[".exp-a.json.4242.deadbeef.tmp"],
	);
});

test("C3：不创建原本不存在的目录（journal 与 audit/intents 保持缺席）", async () => {
	const root = await makeStoreRoot("preflight-no-create");
	assert.equal(existsSync(join(root, "journal")), false);
	assert.equal(existsSync(join(root, "audit")), true, "初始化会创建 audit/");
	assert.equal(existsSync(join(root, "audit", "intents")), false);

	await inspectKnowledgeStore({ root });

	assert.equal(existsSync(join(root, "journal")), false);
	assert.equal(existsSync(join(root, "audit", "intents")), false);
	assert.deepEqual(readdirSync(join(root, "audit")), [], "audit/ 不得被填入任何东西");
	assert.deepEqual(readdirSync(join(root, "locks")), [], "锁目录必须保持为空（预检不加锁）");
	// 边界复用：boundary 存在且只是读取原语（防回归：预检不得直接构造写入口）。
	const boundary = await createStorageBoundary({ root });
	assert.equal(typeof boundary.readJson, "function");
	assert.equal(typeof boundary.listEntries, "function");
});

/* ------------------------------------------------------------------ 9. BM-02C3R 收尾：PF-1～PF-4 */

test("C3R/PF-1：根与非根目录的 IO 错误出口统一（不吞错、不误报通过、取消仍穿透）", async (t) => {
	await t.test("根目录列举被拒（EACCES）→ 明确不完整 + 错误码，绝不 complete/no-migration-needed", async () => {
		const root = await makeStoreRoot("c3r-root-eacces");
		let injected = 0;
		const report = await inspectKnowledgeStore({
			root,
			ioHooks: {
				beforeIo: (operation, target) => {
					if (operation === "opendir" && target === root) {
						injected += 1;
						throw Object.assign(new Error("注入：根列举被拒"), { code: "EACCES" });
					}
					return undefined;
				},
			},
		});

		assert.equal(injected, 1, "故障注入必须真的命中根列举，否则这条用例什么都没验证");
		assert.notEqual(report.outcome, "no-migration-needed", "根没列完绝不能给通过结论");
		assert.equal(report.complete, false, "根布局外条目没检查完就不能声称完整");
		assert.ok(report.truncatedBy.includes("root-listing"), JSON.stringify(report.truncatedBy));
		const rootProblem = report.problems.find((problem) => problem.relativePath === ".");
		assert.ok(rootProblem, JSON.stringify(report.problems));
		assert.equal(rootProblem.code, "permission-denied");
		assert.equal(rootProblem.blocks, true);
	});

	await t.test("非根目录探测被拒（permission-denied）→ 按问题收集后继续检查后续类别", async () => {
		const root = await makeStoreRoot("c3r-nonroot-probe");
		registerProject(root, PROJECT_ID);
		await createRecord({ root, kind: "experience-card", id: "exp-a", expectedRevision: null, now: NOW, data: experienceBody() });
		writeJson(join(root, "features", "feat-1.json"), recordValue("feat-1", featureBody("支持客户定制引导顺序")));
		const featuresDir = join(root, "features");
		let injected = 0;

		const report = await inspectKnowledgeStore({
			root,
			ioHooks: {
				beforeIo: (operation, target) => {
					if (operation === "stat" && target === featuresDir) {
						injected += 1;
						throw new StorageError("permission-denied", "注入：无法探测 features");
					}
					return undefined;
				},
			},
		});

		assert.equal(injected, 1, "故障注入必须真的命中 features 探测");
		assert.equal(report.complete, true, "单目录探测失败是确定的阻断，不是截断");
		assert.equal(report.outcome, "blocked");
		const problem = report.problems.find((entry) => entry.relativePath === "features");
		assert.ok(problem, JSON.stringify(report.problems));
		assert.equal(problem.code, "permission-denied");
		assert.equal(problem.status, "unreadable", "读不动 ≠ 不存在");
		assert.equal(problem.blocks, true);
		// 同批的其它记录目录与后续类别继续盘点（不是一遇到失败就整体放弃）。
		assert.equal(summaryFor(report, "experiences/exp-a.json")?.status, "ok");
		assert.ok(report.summaries.some((summary) => summary.relativePath === "cache/"));
	});

	await t.test("取消发生在非根探测点 → 仍然结构化穿透，不被收集成普通问题", async () => {
		const root = await makeStoreRoot("c3r-cancel-probe");
		const controller = new AbortController();
		const experiencesDir = join(root, "experiences");
		await assert.rejects(
			inspectKnowledgeStore({
				root,
				signal: controller.signal,
				ioHooks: {
					beforeIo: (operation, target) => {
						if (operation === "stat" && target === experiencesDir) controller.abort();
						return undefined;
					},
				},
			}),
			expectStorageError("cancelled"),
		);
	});
});

test("C3R/PF-2：问题与人工事项共享同一条数额度（0 / 1 / 恰好够 / 差一 / 单类 / 顺序无关）", async (t) => {
	await t.test("坏记录与锁混合：额度 1 时两类明细合计不超过 1，且阻断与人工总计不被裁剪", async () => {
		const root = await makeStoreRoot("c3r-quota-mixed");
		writeFileSync(join(root, "experiences", "bad.json"), "{ 坏\n", "utf8");
		mkdirSync(join(root, "locks", "lock-0123456789abcdef0123456789abcdef"), { recursive: true });

		const enough = await inspectKnowledgeStore({ root, limits: { maxProblems: 2 } });
		assert.equal(enough.problems.length, 1, JSON.stringify(enough.problems));
		assert.equal(enough.manual.length, 1, JSON.stringify(enough.manual));
		assert.equal(enough.complete, true, "额度恰好够时不得标记截断");
		assert.equal(enough.truncatedBy.includes("problems"), false);

		const tight = await inspectKnowledgeStore({ root, limits: { maxProblems: 1 } });
		assert.equal(tight.problems.length + tight.manual.length, 1, JSON.stringify({ problems: tight.problems, manual: tight.manual }));
		assert.equal(tight.complete, false);
		assert.equal(tight.outcome, "incomplete");
		assert.ok(tight.truncatedBy.includes("problems"));
		assert.ok(tight.droppedProblems > 0);
		// 明细被裁剪，但"已知阻断"与"人工总计"保留：不能因为没地方写就当成没有问题。
		assert.equal(tight.manualItems, 1);
		assert.ok(tight.blockingProblems >= 2, JSON.stringify(tight.blockingProblems));

		const zero = await inspectKnowledgeStore({ root, limits: { maxProblems: 0 } });
		assert.deepEqual(zero.problems, []);
		assert.deepEqual(zero.manual, []);
		assert.equal(zero.manualItems, 1);
		assert.ok(zero.blockingProblems >= 2);
		assert.equal(zero.outcome, "incomplete");
	});

	await t.test("顺序无关：人工事项先到（未登记项目）时同样只保留额度内的明细", async () => {
		const root = await makeStoreRoot("c3r-quota-reverse");
		const orphanId = "5c2f4a31-7b6d-4f92-8e1a-3d5b7c9e2f40";
		mkdirSync(join(root, "projects", orphanId), { recursive: true });
		writeJson(recordPath(root, "project-profile", orphanId), recordValue(orphanId, profileBody()));
		writeFileSync(join(root, "experiences", "bad.json"), "{ 坏\n", "utf8");

		const report = await inspectKnowledgeStore({ root, limits: { maxProblems: 1 } });
		assert.equal(report.manual.length, 1, JSON.stringify(report.manual));
		assert.equal(report.problems.length, 0, JSON.stringify(report.problems));
		assert.equal(report.problems.length + report.manual.length, 1);
		assert.ok(report.blockingProblems >= 2);
		assert.equal(report.outcome, "incomplete");
	});

	await t.test("只含单类的对照：问题先到且超出额度时只裁剪问题", async () => {
		const root = await makeStoreRoot("c3r-quota-single");
		for (const id of ["bad-a", "bad-b", "bad-c"]) writeFileSync(join(root, "experiences", `${id}.json`), "{ 坏\n", "utf8");

		const report = await inspectKnowledgeStore({ root, limits: { maxProblems: 2 } });
		assert.equal(report.problems.length, 2, JSON.stringify(report.problems));
		assert.deepEqual(report.manual, []);
		assert.equal(report.droppedProblems, 1);
		assert.ok(report.truncatedBy.includes("problems"));
		assert.equal(report.outcome, "incomplete");
	});
});

test("C3R/PF-3：outputBytes = 三类明细合并数组的真实 UTF-8 字节（含括号与分隔符）", async (t) => {
	await t.test("摘要 / 问题 / 人工事项共同计入，中文与 JSON 转义按字节计", async () => {
		const root = await makeStoreRoot("c3r-output-envelope");
		writeFileSync(join(root, "experiences", "bad.json"), '{ "引号": "未闭合\n', "utf8");
		mkdirSync(join(root, "locks", "lock-0123456789abcdef0123456789abcdef"), { recursive: true });

		const report = await inspectKnowledgeStore({ root });
		const entries = [...report.summaries, ...report.problems, ...report.manual];
		assert.ok(report.summaries.length > 0 && report.problems.length > 0 && report.manual.length > 0, JSON.stringify({ summaries: report.summaries.length, problems: report.problems.length, manual: report.manual.length }));
		assert.equal(report.outputBytes, detailEnvelope(report), "不得漏算数组括号/逗号，也不得漏算人工事项");

		// 反证旧口径（逐条字节之和）漏算：差值必须正好是 2 个括号 + (n-1) 个逗号。
		const perEntry = entries.reduce((total, entry) => total + Buffer.byteLength(JSON.stringify(entry), "utf8"), 0);
		assert.equal(report.outputBytes - perEntry, entries.length + 1, "包络 = `[` + `]` + (n-1) 个逗号");
	});

	await t.test("空明细计 0 字节；输出预算为 0 时返回空明细 + incomplete，不误报完整", async () => {
		const root = await makeStoreRoot("c3r-output-empty");
		const noSummaries = await inspectKnowledgeStore({ root, limits: { maxFileSummaries: 0 } });
		assert.deepEqual(noSummaries.summaries, []);
		assert.deepEqual(noSummaries.problems, []);
		assert.deepEqual(noSummaries.manual, []);
		assert.equal(noSummaries.outputBytes, 0, "空载荷不预留空数组括号");

		const zero = await inspectKnowledgeStore({ root, limits: { maxOutputBytes: 0 } });
		assert.equal(zero.outputBytes, 0);
		assert.deepEqual(zero.summaries, []);
		assert.deepEqual(zero.problems, []);
		assert.ok(zero.truncatedBy.includes("output-bytes"));
		assert.equal(zero.complete, false);
		assert.equal(zero.outcome, "incomplete");
	});

	await t.test("额度差一：按字节截断，且截断后的 outputBytes 仍等于实际保留明细的包络（不低报）", async () => {
		const root = await makeStoreRoot("c3r-output-tight");
		for (const id of ["exp-a", "exp-b", "exp-c"]) await createRecord({ root, kind: "experience-card", id, expectedRevision: null, now: NOW, data: experienceBody() });
		writeFileSync(join(root, "experiences", "bad.json"), "{ 坏\n", "utf8");
		writeFileSync(join(root, "notes.md"), "根目录说明\n", "utf8");

		const wide = await inspectKnowledgeStore({ root });
		const envelope = detailEnvelope(wide);
		const wideCount = wide.summaries.length + wide.problems.length + wide.manual.length;

		const tight = await inspectKnowledgeStore({ root, limits: { maxOutputBytes: envelope - 1 } });
		assert.equal(tight.complete, false);
		assert.ok(tight.truncatedBy.includes("output-bytes"));
		assert.equal(tight.outputBytes, detailEnvelope(tight), "截断后也必须与实际保留明细逐字节一致");
		assert.ok(tight.outputBytes < envelope);
		assert.ok(tight.outputBytes <= envelope - 1);
		assert.ok(tight.summaries.length + tight.problems.length + tight.manual.length < wideCount, "必须真的丢掉了明细，而不是换个算法继续全量返回");
	});
});

test("C3R/PF-4：截断时已观察条目计入统计，且不重复扣账、耗尽后不再新 IO", async (t) => {
	await t.test("根列举触顶：scannedEntries 含唯一的超限探测条目", async () => {
		const root = await makeStoreRoot("c3r-count-root");
		const report = await inspectKnowledgeStore({ root, limits: { maxScanEntries: 1 } });

		assert.equal(report.complete, false);
		assert.ok(report.truncatedBy.includes("scan-entries"));
		assert.equal(report.scannedEntries, 2, "根列举观察到 2 条（1 条 + 超限探测）");
	});

	await t.test("第一层目录触顶：计入已观察条目，且不再打开任何候选", async () => {
		const root = await makeStoreRoot("c3r-count-first-level");
		for (const id of ["exp-a", "exp-b", "exp-c"]) await createRecord({ root, kind: "experience-card", id, expectedRevision: null, now: NOW, data: experienceBody() });
		const opened = [];
		const report = await inspectKnowledgeStore({
			root,
			limits: { maxScanEntries: 2 },
			ioHooks: {
				beforeIo: (operation, target) => {
					if (operation === "open") opened.push(target);
					return undefined;
				},
			},
		});

		assert.equal(report.scannedEntries, 3, "已消耗预算却报告零扫描（PF-4 的原始缺陷）");
		assert.ok(report.truncatedBy.includes("scan-entries"));
		assert.deepEqual(
			opened.filter((path) => path.includes(`${sep}experiences${sep}`)),
			[],
			"列举被截断后不得继续打开候选（不继续新 IO）",
		);
	});

	await t.test("多目录累计触顶：跨目录共用同一份总预算", async () => {
		const root = await makeStoreRoot("c3r-count-multi");
		await createRecord({ root, kind: "experience-card", id: "exp-a", expectedRevision: null, now: NOW, data: experienceBody() });
		writeJson(join(root, "features", "feat-1.json"), recordValue("feat-1", featureBody("甲")));
		writeJson(join(root, "features", "feat-2.json"), recordValue("feat-2", featureBody("乙")));

		const report = await inspectKnowledgeStore({ root, limits: { maxScanEntries: 2 } });
		// experiences 观察 1 条 → features 观察 2 条并触顶 ⇒ 累计 3 = 预算 2 + 探测 1。
		assert.equal(report.scannedEntries, 3);
		assert.ok(report.truncatedBy.includes("scan-entries"));
	});

	await t.test("0 边界与无截断对照：统计等于真实观察次数", async () => {
		const zeroRoot = await makeStoreRoot("c3r-count-zero");
		const zero = await inspectKnowledgeStore({ root: zeroRoot, limits: { maxScanEntries: 0 } });
		assert.equal(zero.scannedEntries, 1, "预算 0 也只观察 1 条（唯一的超限探测条目）");
		assert.ok(zero.truncatedBy.includes("scan-entries"));

		const wideRoot = await makeStoreRoot("c3r-count-wide");
		for (const id of ["exp-a", "exp-b", "exp-c"]) await createRecord({ root: wideRoot, kind: "experience-card", id, expectedRevision: null, now: NOW, data: experienceBody() });
		const wide = await inspectKnowledgeStore({ root: wideRoot });
		assert.equal(wide.truncatedBy.includes("scan-entries"), false);
		assert.equal(wide.scannedEntries, listedEntryCount(wideRoot), "统计必须等于真实观察次数");
	});

	await t.test("零值语义：maxFileBytes=0 立即停读（read-bytes），如实标记不完整", async () => {
		const root = await makeStoreRoot("c3r-zero-filebytes");
		const report = await inspectKnowledgeStore({ root, limits: { maxFileBytes: 0 } });

		assert.equal(report.readBytes, 0);
		assert.equal(report.readFiles, 0);
		assert.ok(report.truncatedBy.includes("read-bytes"));
		assert.equal(report.complete, false);
		assert.equal(report.outcome, "incomplete");
	});
});

/* ------------------------------------------------------------------ 10. BM-02C3R/S1：目录列举即时计费 */

test("C3R/S1：正常列举也即时计入观察成本，统计与真实观察一致且不超全局预算", async (t) => {
	await t.test("嵌套 audit（额度 15、四目录各十条事件）→ 真实观察 ≤ 16、统计一致、耗尽后不再开候选", async () => {
		const root = await makeStoreRoot("s1-nested-audit");
		for (const index of [0, 1, 2, 3]) {
			mkdirSync(join(root, "audit", `record-${index}`), { recursive: true });
			for (let n = 0; n < 10; n += 1) writeFileSync(join(root, "audit", `record-${index}`, `event-${n}.json`), "{}", "utf8");
		}

		const measured = observePreflight({ root, limits: { maxScanEntries: 15 } });
		assert.ok(measured.observed <= 15 + 1, `真实观察不得超过 maxScanEntries+1：${measured.observed}`);
		assert.equal(measured.observed, measured.scannedEntries, "统计必须等于独立计量的真实观察次数");
		assert.equal(measured.scannedEntries, 16, "父目录 4 条 + 第一个子目录 10 条 + 唯一的超限探测条目");
		assert.equal(measured.complete, false);
		assert.ok(measured.truncatedBy.includes("scan-entries"));
		// 耗尽后不得再进入新目录/打开新候选：record-1 的列举被截断（名字不返回），record-2/3 从未列举。
		assert.equal(
			measured.opened.some((path) => /record-[123]/.test(path)),
			false,
			JSON.stringify(measured.opened),
		);
	});

	await t.test("输出先触顶 → 此前已观察的十条仍然入账，且不再继续读候选", async () => {
		const root = await makeStoreRoot("s1-output-stop");
		for (let n = 0; n < 10; n += 1) writeFileSync(join(root, "experiences", `exp-${String.fromCharCode(97 + n)}.json`), "{}", "utf8");

		const measured = observePreflight({ root, limits: { maxOutputBytes: 200 } });
		assert.equal(measured.observed, 10, "目录早已观察十条");
		assert.equal(measured.scannedEntries, measured.observed, "输出触顶不得抹掉此前的观察成本");
		assert.equal(measured.complete, false);
		assert.ok(measured.truncatedBy.includes("output-bytes"), JSON.stringify(measured.truncatedBy));
		assert.ok(measured.readFiles < 10, `输出触顶后不再继续读候选：readFiles=${measured.readFiles}`);
	});

	await t.test("父目录恰好用完额度 → 进入子目录前成本已入账，不再多观察也不开候选", async () => {
		const root = await makeStoreRoot("s1-parent-exhausted");
		for (const index of [0, 1, 2, 3]) {
			mkdirSync(join(root, "audit", `record-${index}`), { recursive: true });
			for (let n = 0; n < 3; n += 1) writeFileSync(join(root, "audit", `record-${index}`, `event-${n}.json`), "{}", "utf8");
		}
		const opened = [];

		const report = await inspectKnowledgeStore({
			root,
			limits: { maxScanEntries: 4 },
			ioHooks: {
				beforeIo: (operation, target) => {
					if (operation === "open") opened.push(target);
					return undefined;
				},
			},
		});

		// 父目录 4 条整批入账 ⇒ 进入子目录时额度已为 0，只允许唯一的超限探测条目。
		assert.equal(report.scannedEntries, 5, JSON.stringify({ truncatedBy: report.truncatedBy }));
		assert.ok(report.truncatedBy.includes("scan-entries"));
		assert.equal(report.complete, false);
		assert.equal(
			opened.some((path) => path.includes(`${sep}audit${sep}`)),
			false,
			"预算已满，不得再打开任何事件候选",
		);
	});

	await t.test("0/1 边界与正常完成对照：统计等于独立重算的观察次数", async () => {
		const root = await makeStoreRoot("s1-boundary");
		await createRecord({ root, kind: "experience-card", id: "exp-a", expectedRevision: null, now: NOW, data: experienceBody() });

		const one = await inspectKnowledgeStore({ root, limits: { maxScanEntries: 1 } });
		// experiences 观察 1 条 → 轮到根列举时额度为 0，仍允许唯一的超限探测条目。
		assert.equal(one.scannedEntries, 2);
		assert.ok(one.truncatedBy.includes("scan-entries"));

		const zero = await inspectKnowledgeStore({ root, limits: { maxScanEntries: 0 } });
		assert.equal(zero.scannedEntries, 1, "额度 0 仍会观察一次用于判定截断");

		const wide = await inspectKnowledgeStore({ root });
		assert.equal(wide.complete, true, JSON.stringify({ problems: wide.problems }));
		assert.equal(wide.scannedEntries, listedEntryCount(root), "正常完成时统计等于独立重算的观察次数");
	});

	await t.test("其它预算（读取）先停 → 目录观察成本保留，且不再继续读候选", async () => {
		const root = await makeStoreRoot("s1-read-stop");
		for (let n = 0; n < 10; n += 1) writeFileSync(join(root, "experiences", `exp-${String.fromCharCode(97 + n)}.json`), JSON.stringify({ filler: "x".repeat(300) }), "utf8");

		const report = await inspectKnowledgeStore({ root, limits: { maxReadBytes: 1_200 } });
		assert.ok(report.truncatedBy.includes("read-bytes"), JSON.stringify(report.truncatedBy));
		assert.equal(report.scannedEntries, 10, "读取触顶不得抹掉此前的观察成本");
		assert.ok(report.readFiles < 10, `读取预算耗尽后不再继续读候选：readFiles=${report.readFiles}`);
		assert.equal(report.complete, false);
	});

	await t.test("逻辑核对不冒充物理观察：登记项目缺目录只消耗额度，不进 scannedEntries", async () => {
		const root = await makeStoreRoot("s1-logical");
		// 两个已登记项目都要有各自的 workspaceId，否则会先撞上 registry 绑定冲突（那是另一条用例）。
		writeJson(
			join(root, "registry.json"),
			registryValue([
				{ biosProjectId: PROJECT_ID, workspaces: [{ workspaceId: WORKSPACE_ID, path: join(SANDBOX, "ws-main"), boundAt: 1 }], createdAt: 1, updatedAt: 1 },
				{ biosProjectId: OTHER_PROJECT_ID, workspaces: [{ workspaceId: "c8e2f0a3-4d5b-4e6f-9a0b-1c2d3e4f5a61", path: join(SANDBOX, "ws-other"), boundAt: 1 }], createdAt: 1, updatedAt: 1 },
			]),
		);

		const wide = await inspectKnowledgeStore({ root });
		assert.equal(problemsWith(wide, "not-found").length, 2, JSON.stringify(wide.problems));
		assert.equal(wide.scannedEntries, listedEntryCount(root), "只统计物理观察到的目录条目");
		assert.equal(wide.complete, true);

		const tight = await inspectKnowledgeStore({ root, limits: { maxScanEntries: 1 } });
		assert.equal(tight.scannedEntries, 0, "逻辑核对不得伪装成目录观察");
		assert.equal(problemsWith(tight, "not-found").length, 1, "额度 1 只够一次核对");
		assert.ok(tight.truncatedBy.includes("scan-entries"));
		assert.equal(tight.complete, false);
	});
});

/* ------------------------------------------------------------------ 11. BM-02C3R/S2：迭代中途失败也保留已观察成本 */

/** S2 的通用 fixture：某个受控目录里放二十个形状相同的候选（内容 `{}`）。 */
function writeTwenty(root, directory, prefix) {
	for (let n = 0; n < 20; n += 1) writeFileSync(join(root, directory, `${prefix}-${n}.json`), "{}", "utf8");
}

test("C3R/S2：目录迭代中途失败也保留已观察成本，成功路径不双计", async (t) => {
	/** 注入的原始正文哨兵：报告只允许出现受控诊断，不得回显它。 */
	const S2_SENTINEL = "SENTINEL-S2-ITER";

	await t.test("experiences 交出 4 条后 EIO：统计=真实观察=16，后续类别只能用真实剩余额度", async () => {
		const root = await makeStoreRoot("s2-iter-fail");
		writeTwenty(root, "experiences", "exp");
		writeTwenty(root, "features", "feat");

		const measured = observePreflight({
			root,
			limits: { maxScanEntries: 15 },
			fail: { pathIncludes: `${sep}experiences`, afterEntries: 4, code: "EIO", message: `注入：目录迭代中途失败 ${S2_SENTINEL}` },
		});

		assert.ok(measured.observed <= 15 + 1, `真实观察不得超过 maxScanEntries+1：${measured.observed}`);
		assert.equal(measured.observed, measured.scannedEntries, "失败前已观察的条目必须进入统计");
		assert.equal(measured.scannedEntries, 16, "experiences 失败前 4 条 + features 真实剩余额度 11 条 + 唯一探测条目");
		assert.equal(measured.complete, false);
		assert.equal(measured.outcome, "incomplete");
		assert.ok(measured.truncatedBy.includes("scan-entries"));
		// 原错误仍作为受控问题可见，且诊断不回显注入的原始正文。
		assert.ok(
			measured.problems.some((problem) => problem.code === "unreadable"),
			JSON.stringify(measured.problems),
		);
		assert.equal(JSON.stringify(measured.problems).includes(S2_SENTINEL), false, "报告不得回显原始异常正文");
		// 触顶后不再打开新候选（features 的列举已截断，名字不返回）。
		assert.deepEqual(
			measured.opened.filter((path) => path.includes(`${sep}features${sep}`)),
			[],
		);
	});

	await t.test("未交出条目就失败：计数保持 0，后续类别用满额度（零观察不制造虚假成本）", async () => {
		const root = await makeStoreRoot("s2-zero-observed");
		writeTwenty(root, "experiences", "exp");
		writeTwenty(root, "features", "feat");

		const measured = observePreflight({
			root,
			limits: { maxScanEntries: 15 },
			fail: { pathIncludes: `${sep}experiences`, afterEntries: 0, code: "EIO", message: `注入：零观察失败 ${S2_SENTINEL}` },
		});

		assert.equal(measured.observed, 16, "experiences 0 条 + features 16 条（含唯一探测条目）");
		assert.equal(measured.scannedEntries, measured.observed);
		assert.ok(measured.problems.some((problem) => problem.code === "unreadable"));
	});

	await t.test("宽预算：失败前观察成本不丢，且与独立计量逐条相等", async () => {
		const root = await makeStoreRoot("s2-wide");
		writeTwenty(root, "experiences", "exp");
		writeTwenty(root, "features", "feat");

		const measured = observePreflight({
			root,
			limits: { maxScanEntries: 5_000 },
			fail: { pathIncludes: `${sep}experiences`, afterEntries: 4, code: "EIO", message: `注入：宽预算失败 ${S2_SENTINEL}` },
		});

		assert.equal(measured.observed, measured.scannedEntries);
		assert.equal(measured.scannedEntries, 4 + 20 + 7, "experiences 4 条 + features 20 条 + 根布局外 7 条");
		assert.equal(measured.complete, true, "单目录迭代失败是确定的阻断，不是截断");
		assert.equal(measured.outcome, "blocked");
	});

	await t.test("嵌套 audit：子目录迭代失败同样计入，且不再打开任何事件候选", async () => {
		const root = await makeStoreRoot("s2-nested-audit");
		for (const index of [0, 1, 2, 3]) {
			mkdirSync(join(root, "audit", `record-${index}`), { recursive: true });
			for (let n = 0; n < 10; n += 1) writeFileSync(join(root, "audit", `record-${index}`, `event-${n}.json`), "{}", "utf8");
		}

		const measured = observePreflight({
			root,
			limits: { maxScanEntries: 15 },
			fail: { pathIncludes: `${sep}audit${sep}record-0`, afterEntries: 3, code: "EIO", message: `注入：嵌套失败 ${S2_SENTINEL}` },
		});

		assert.equal(measured.observed, measured.scannedEntries);
		assert.equal(measured.scannedEntries, 16, "父目录 4 条 + record-0 已观察 3 条 + record-1 真实剩余 8 条 + 探测 1 条");
		assert.ok(measured.truncatedBy.includes("scan-entries"));
		assert.ok(measured.problems.some((problem) => problem.code === "unreadable"));
		assert.deepEqual(
			measured.opened.filter((path) => path.includes(`${sep}audit${sep}`)),
			[],
			"失败目录与截断目录都不得打开候选",
		);
	});

	await t.test("与读取预算提前停止组合：失败成本与已观察目录成本都不低报", async () => {
		const root = await makeStoreRoot("s2-with-read-stop");
		writeTwenty(root, "experiences", "exp");
		for (let n = 0; n < 20; n += 1) writeFileSync(join(root, "features", `feat-${n}.json`), JSON.stringify({ filler: "x".repeat(300) }), "utf8");

		const measured = observePreflight({
			root,
			limits: { maxReadBytes: 1_200 },
			fail: { pathIncludes: `${sep}experiences`, afterEntries: 4, code: "EIO", message: `注入：组合场景失败 ${S2_SENTINEL}` },
		});

		assert.equal(measured.observed, measured.scannedEntries);
		assert.equal(measured.scannedEntries, 24, "experiences 4 条 + features 已观察整批 20 条");
		assert.ok(measured.truncatedBy.includes("read-bytes"), JSON.stringify(measured.truncatedBy));
		assert.ok(measured.problems.some((problem) => problem.code === "unreadable"));
		assert.ok(measured.readFiles < 21, `读取触顶后不再继续读候选：readFiles=${measured.readFiles}`);
	});

	await t.test("取消对照：不吞取消、结构化穿透，且目录句柄已配对关闭", async () => {
		const root = await makeStoreRoot("s2-cancel");
		writeTwenty(root, "experiences", "exp");
		const controller = new AbortController();
		const experiencesDir = join(root, "experiences");

		await assert.rejects(
			inspectKnowledgeStore({
				root,
				signal: controller.signal,
				ioHooks: {
					beforeIo: (operation, target) => {
						if (operation === "opendir" && target === experiencesDir) controller.abort();
						return undefined;
					},
				},
			}),
			expectStorageError("cancelled"),
		);
		// Windows 上未关闭的目录句柄会挡住删除；能删掉说明取消路径的关闭已配对。
		rmSync(experiencesDir, { recursive: true, force: true });
		assert.equal(existsSync(experiencesDir), false);
	});
});

/* ------------------------------------------------------------------ 12. BM-02C3R/S3：超限探测后锁存停止 */

/**
 * 缺陷（round19 §3）：唯一超限探测条目**已经交出**之后，若异步迭代器在收尾
 * （`break` 触发的 `return()`）或关闭时抛错，`listEntries` 不会返回截断结果，而是走 catch；
 * 预检在错误出口丢掉了"条目预算已触顶"的事实 —— 下一个类别拿剩余 0 额度再列举一次，
 * 于是产生第二次真实超限探测（额度 15 实测并报告 17/17）。
 *
 * 修复要求：就地锁存预算停止，使任何成功/截断/错误出口之后都不再发起新列举或新候选读取，
 * 同时**不吞错**（受控错误仍进问题列表、取消仍结构化穿透）。
 */
test("C3R/S3：超限探测已消耗后，关闭/收尾失败也不能绕过全局停止", async (t) => {
	/** 注入的原始正文哨兵：报告只允许出现受控诊断，不得回显它。 */
	const S3_SENTINEL = "SENTINEL-S3-CLOSE";
	const closeOnExperiences = { pathIncludes: `${sep}experiences`, code: "EIO", message: `注入：目录关闭失败 ${S3_SENTINEL}` };

	await t.test("额度 15：真实关闭后注入 EIO → 观察/报告 16/16，错误可见，不再列举 features", async () => {
		const root = await makeStoreRoot("s3-close-15");
		writeTwenty(root, "experiences", "exp");
		writeTwenty(root, "features", "feat");
		const before = snapshot(root);

		const measured = observePreflight({ root, limits: { maxScanEntries: 15 }, closeError: closeOnExperiences });

		assert.equal(measured.observed, measured.scannedEntries, "统计必须等于独立计量的真实观察次数");
		assert.equal(measured.scannedEntries, 16, "experiences 15 条 + 唯一的超限探测条目；不得再观察 features");
		assert.ok(measured.observed <= 15 + 1, `真实观察不得超过 maxScanEntries+1：${measured.observed}`);
		assert.equal(measured.complete, false);
		assert.equal(measured.outcome, "incomplete");
		assert.ok(measured.truncatedBy.includes("scan-entries"), JSON.stringify(measured.truncatedBy));
		// 关闭失败的受控错误仍可见，且不回显注入的原始正文。
		assert.ok(
			measured.problems.some((problem) => problem.code === "unreadable"),
			JSON.stringify(measured.problems),
		);
		assert.equal(JSON.stringify(measured.problems).includes(S3_SENTINEL), false, "报告不得回显原始异常正文");
		// 触顶后不得再列举新目录，也不得打开任何候选。
		assert.deepEqual(
			measured.listed.filter((path) => path.includes(`${sep}features`)),
			[],
			JSON.stringify(measured.listed),
		);
		assert.deepEqual(
			measured.opened.filter((path) => path.includes(`${sep}experiences${sep}`) || path.includes(`${sep}features${sep}`)),
			[],
		);
		// 只读：扫描前后完整清单与哈希逐字节相同。
		assert.deepEqual(snapshot(root), before);
	});

	await t.test("额度 0：只交出唯一探测条目 → 1/1，不再列举 features", async () => {
		const root = await makeStoreRoot("s3-close-0");
		writeTwenty(root, "experiences", "exp");
		writeTwenty(root, "features", "feat");

		const measured = observePreflight({ root, limits: { maxScanEntries: 0 }, closeError: closeOnExperiences });

		assert.equal(measured.scannedEntries, 1, "额度 0 也只允许一次超限探测");
		assert.equal(measured.observed, measured.scannedEntries);
		assert.ok(measured.truncatedBy.includes("scan-entries"), JSON.stringify(measured.truncatedBy));
		assert.ok(
			measured.problems.some((problem) => problem.code === "unreadable"),
			JSON.stringify(measured.problems),
		);
		assert.deepEqual(
			measured.listed.filter((path) => path.includes(`${sep}features`)),
			[],
			JSON.stringify(measured.listed),
		);
	});

	await t.test("额度 1：额度内 1 条 + 唯一探测 → 2/2，不再列举 features", async () => {
		const root = await makeStoreRoot("s3-close-1");
		writeTwenty(root, "experiences", "exp");
		writeTwenty(root, "features", "feat");

		const measured = observePreflight({ root, limits: { maxScanEntries: 1 }, closeError: closeOnExperiences });

		assert.equal(measured.scannedEntries, 2, "额度内 1 条 + 唯一超限探测");
		assert.equal(measured.observed, measured.scannedEntries);
		assert.ok(measured.truncatedBy.includes("scan-entries"), JSON.stringify(measured.truncatedBy));
		assert.deepEqual(
			measured.listed.filter((path) => path.includes(`${sep}features`)),
			[],
			JSON.stringify(measured.listed),
		);
	});

	await t.test("嵌套 audit：子目录截断后关闭失败 → 只列举一个事件目录，观察 16", async () => {
		const root = await makeStoreRoot("s3-nested-audit");
		for (const index of [0, 1, 2, 3]) {
			mkdirSync(join(root, "audit", `record-${index}`), { recursive: true });
			for (let n = 0; n < 20; n += 1) writeFileSync(join(root, "audit", `record-${index}`, `event-${n}.json`), "{}", "utf8");
		}

		// 注入点匹配 audit 的**子目录**（`\audit\`），父目录本身不含该片段；
		// 首个被列举的事件目录由 OS 顺序决定，因此不按 record-0 推断。
		const measured = observePreflight({
			root,
			limits: { maxScanEntries: 15 },
			closeError: { pathIncludes: `${sep}audit${sep}`, code: "EIO", message: `注入：嵌套关闭失败 ${S3_SENTINEL}` },
		});

		assert.equal(measured.observed, measured.scannedEntries, "嵌套目录与父目录共用同一份预算");
		assert.equal(measured.scannedEntries, 16, "audit 父目录 4 条 + 首个事件目录 11 条 + 唯一探测");
		assert.ok(measured.truncatedBy.includes("scan-entries"), JSON.stringify(measured.truncatedBy));
		assert.ok(
			measured.problems.some((problem) => problem.code === "unreadable"),
			JSON.stringify(measured.problems),
		);
		// 超限后不得进入第二个子目录，也不得打开任何事件候选。
		const eventDirs = measured.listed.filter((path) => path.includes(`${sep}audit${sep}record-`));
		assert.equal(eventDirs.length, 1, JSON.stringify(measured.listed));
		assert.deepEqual(
			measured.opened.filter((path) => path.includes(`${sep}audit${sep}`)),
			[],
		);
	});

	await t.test("关闭错误与其他预算停止对照：此前观察成本不丢、读取预算停止不回退、也不误锁存", async () => {
		const root = await makeStoreRoot("s3-close-with-read-stop");
		writeTwenty(root, "experiences", "exp");
		for (let n = 0; n < 20; n += 1) writeFileSync(join(root, "features", `feat-${n}.json`), JSON.stringify({ filler: "x".repeat(300) }), "utf8");

		// 这里**没有**条目触顶：`next()` 中途抛错触发的收尾同样会走关闭路径，于是关闭故障与读取预算停止
		// 同时出现。此时不得误锁存（features 仍必须被列举），也不得让关闭错误抹掉已观察成本或回退读取停止。
		const measured = observePreflight({
			root,
			limits: { maxReadBytes: 1_200 },
			closeError: closeOnExperiences,
			fail: { pathIncludes: `${sep}experiences`, afterEntries: 4, code: "EIO", message: `注入：关闭与读取组合 ${S3_SENTINEL}` },
		});

		assert.equal(measured.observed, measured.scannedEntries, "关闭错误不得丢掉失败前已观察的成本");
		assert.equal(measured.scannedEntries, 24, "experiences 4 条 + features 已观察整批 20 条");
		assert.ok(measured.truncatedBy.includes("read-bytes"), JSON.stringify(measured.truncatedBy));
		assert.equal(measured.truncatedBy.includes("scan-entries"), false, "条目预算没触顶，不得因关闭错误而锁存");
		assert.equal(measured.complete, false);
		assert.ok(
			measured.problems.some((problem) => problem.code === "unreadable"),
			JSON.stringify(measured.problems),
		);
		assert.equal(JSON.stringify(measured.problems).includes(S3_SENTINEL), false, "报告不得回显原始异常正文");
		// 真实预算停止不回退：读取触顶后不再继续读候选；features 仍然被列举（未被误停止）。
		assert.ok(measured.readFiles < 21, `读取触顶后不再继续读候选：readFiles=${measured.readFiles}`);
		assert.ok(
			measured.listed.some((path) => path.includes(`${sep}features`)),
			JSON.stringify(measured.listed),
		);
	});

	await t.test("关闭错误与明细额度停止对照：观察成本不丢、预算停止不回退且阻断计数不被裁剪", async () => {
		const root = await makeStoreRoot("s3-close-with-problem-quota");
		writeTwenty(root, "experiences", "exp");
		writeTwenty(root, "features", "feat");

		// `maxProblems: 0` 让"问题 + 人工事项"共同额度立即触顶（PF-2）。关闭失败的受控问题此时
		// **明细被丢弃**并记 `problems` 截断，但阻断计数不受裁剪 —— 与条目预算锁存同时成立、互不覆盖。
		const measured = observePreflight({ root, limits: { maxScanEntries: 15, maxProblems: 0 }, closeError: closeOnExperiences });

		assert.equal(measured.observed, measured.scannedEntries, "关闭错误不得丢掉此前观察成本");
		assert.equal(measured.scannedEntries, 16, "明细被裁剪不得抹掉条目触顶成本，也不得回退成可继续列举");
		assert.ok(measured.truncatedBy.includes("scan-entries"), JSON.stringify(measured.truncatedBy));
		assert.ok(measured.truncatedBy.includes("problems"), JSON.stringify(measured.truncatedBy));
		assert.equal(measured.complete, false);
		assert.equal(measured.outcome, "incomplete");
		assert.ok(measured.blockingProblems >= 1, "已知阻断不得因为明细没地方写而被当成通过");
		assert.ok(measured.droppedProblems >= 1, "被丢弃的问题数必须如实报告");
		assert.deepEqual(
			measured.listed.filter((path) => path.includes(`${sep}features`)),
			[],
			JSON.stringify(measured.listed),
		);
	});

	await t.test("未超限：宽预算下设置关闭故障也不锁存，后续类别照常继续", async () => {
		const root = await makeStoreRoot("s3-under-budget");
		writeTwenty(root, "experiences", "exp");
		writeTwenty(root, "features", "feat");

		// 宽预算下 experiences 正常列完 20 条（没有 break ⇒ 不触发迭代器 return/关闭注入）。
		// 锁存必须以"是否真的消耗了超限探测"为判据，不能一看到"配置了关闭故障"就停。
		const measured = observePreflight({ root, limits: { maxScanEntries: 5_000 }, closeError: closeOnExperiences });

		assert.equal(measured.observed, measured.scannedEntries);
		assert.equal(measured.truncatedBy.includes("scan-entries"), false, JSON.stringify(measured.truncatedBy));
		assert.equal(measured.complete, true, JSON.stringify(measured.problems));
		assert.equal(measured.outcome, "blocked");
		assert.ok(
			measured.listed.some((path) => path.includes(`${sep}features`)),
			JSON.stringify(measured.listed),
		);
	});

	await t.test("取消对照：关闭故障配置不吞取消，句柄在同一进程内已配对关闭", async () => {
		const root = await makeStoreRoot("s3-cancel");
		writeTwenty(root, "experiences", "exp");
		const experiencesDir = join(root, "experiences");

		const measured = observePreflight({ root, abort: { pathIncludes: `${sep}experiences` }, closeError: closeOnExperiences });

		assert.equal(measured.cancelled, true, JSON.stringify(measured));
		assert.equal(measured.errorCode, "cancelled", "取消必须结构化穿透，不被关闭故障或预算结果覆盖");
		assert.equal(measured.removedAfterCancel, true, "取消后目录句柄必须已真实关闭（同进程内可删除）");
		assert.equal(existsSync(experiencesDir), false);
	});
});
