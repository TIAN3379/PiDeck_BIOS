/**
 * BM-02D2：离线导出的真实 IO 行为。
 *
 * 全部使用**自建临时目录**与合成记录：不打开默认真实用户库，不读客户源码。
 * 备份容器的正确性一律用**独立 fs/crypto 重算**判定（遍历 `data/`、逐文件算长度与 SHA-256），
 * 不拿实现自己的字段互证。
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import test, { after } from "node:test";
import { createRecord, exportKnowledgeBackup, initializeKnowledgeStore, recordReviewDecision, updateRegistry } from "../core/storage/index.ts";

const SANDBOX = realpathSync(mkdtempSync(join(tmpdir(), "bios-backup-export-")));
after(() => {
	rmSync(SANDBOX, { recursive: true, force: true });
});

const NOW = 1_700_000_000_000;
const LATER = NOW + 60_000;
const PROJECT_ID = "3f2504e0-4f89-4a1c-9a3d-1f0d3c9a4b7e";
const WORKSPACE_ID = "b7d1e9f2-3c4a-4d5e-8f9a-0b1c2d3e4f50";

let counter = 0;
function sandboxPath(name) {
	counter += 1;
	return join(SANDBOX, `${name}-${counter}`);
}

async function makeStore(name) {
	const root = sandboxPath(name);
	await initializeKnowledgeStore({ root });
	return realpathSync(root);
}

/** 新建一个**尚不存在**的备份目标（父目录已存在，且不自动创建父链）。 */
function backupTarget(name) {
	const parent = sandboxPath(`${name}-parent`);
	mkdirSync(parent, { recursive: true });
	const target = join(parent, "backup");
	return { parent, target };
}

function field(value, status = "candidate") {
	return { value, status, evidence: [], updatedAt: NOW };
}

function experienceBody(overrides = {}) {
	return {
		problem: "PXE 默认开启",
		rootCause: "Setup 默认值未随客户选项调整",
		solution: "在 Setup 中关闭 PXE 引导项",
		appliesWhen: [],
		doesNotApplyWhen: [],
		sourceProjectId: PROJECT_ID,
		evidence: [],
		validations: [],
		reuseScope: { level: "current-project", customers: [] },
		status: "reviewed",
		...overrides,
	};
}

function featureBody(overrides = {}) {
	return { originalRequirement: "客户定制引导顺序", aliases: [], customer: field("示例客户"), productLine: field("示例产品线"), acceptanceCriteria: [], relatedExperienceIds: [], ...overrides };
}

function taskBody(overrides = {}) {
	return {
		workspace: { workspaceId: WORKSPACE_ID, path: join(SANDBOX, "ws-main"), branch: "feature/x", baseCommit: "abc1234" },
		requirement: "实现 PXE 开关",
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

/** 递归清单（目录 + 文件相对路径），供独立比对。 */
function walk(root) {
	const directories = [];
	const files = [];
	const visit = (absolute) => {
		for (const entry of readdirSync(absolute, { withFileTypes: true }).sort((left, right) => (left.name < right.name ? -1 : 1))) {
			const target = join(absolute, entry.name);
			const rel = relative(root, target).split(sep).join("/");
			if (entry.isDirectory()) {
				directories.push(rel);
				visit(target);
				continue;
			}
			files.push(rel);
		}
	};
	if (existsSync(root)) visit(root);
	return { directories: directories.sort(), files: files.sort() };
}

function sha256File(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function readManifest(target) {
	return JSON.parse(readFileSync(join(target, "manifest.json"), "utf8"));
}

/** 独立复核：`data/` 的实际集合、长度与 SHA-256 与清单逐项一致。 */
function assertContainerMatchesManifest(target) {
	const manifest = readManifest(target);
	const dataRoot = join(target, "data");
	const actual = walk(dataRoot);
	assert.deepEqual(
		actual.files,
		manifest.files.map((file) => file.path),
		"data/ 实际文件集合必须与清单完全一致",
	);
	assert.deepEqual(actual.directories, manifest.directories, "data/ 实际目录集合必须与清单完全一致（含空目录）");
	for (const file of manifest.files) {
		const absolute = join(dataRoot, ...file.path.split("/"));
		assert.equal(statSync(absolute).size, file.bytes, `${file.path} 长度必须与清单一致`);
		assert.equal(sha256File(absolute), file.sha256, `${file.path} SHA-256 必须与清单一致`);
	}
	return manifest;
}

/* ------------------------------------------------------------------ 1. 最小库与空目录 */

test("D2：最小库导出生成可独立复核的容器", async (t) => {
	await t.test("空库：manifest.json + data/（registry + 四个必需目录），清单与实际完全一致", async () => {
		const root = await makeStore("d2-minimal");
		const { parent, target } = backupTarget("d2-minimal");

		const result = await exportKnowledgeBackup({ root, backupRoot: target, offlineConfirmed: true, now: NOW, backupId: "backup-1" });

		assert.equal(result.status, "exported");
		assert.equal(result.published, true);
		assert.equal(result.cleanup, "ok");
		assert.equal(result.backupId, "backup-1");
		assert.equal(result.createdAt, NOW);
		assert.equal(result.consistency, "offline-copy");
		assert.equal(result.files, 1, "空库只有 registry.json");
		assert.equal(result.directories, 4);
		assert.ok(result.totalBytes > 0);

		const manifest = assertContainerMatchesManifest(target);
		assert.equal(manifest.backupVersion, 1);
		assert.deepEqual(manifest.exclusions, ["cache", "locks"]);
		assert.deepEqual(manifest.directories, ["audit", "experiences", "features", "projects"]);
		assert.equal(manifest.files[0].path, "registry.json");
		assert.equal(manifest.files[0].sha256, sha256File(join(root, "registry.json")), "hash 必须等于源文件字节的 hash");

		// cache/locks：协议排除项，既不在清单里，也没有在 data/ 下创建。
		assert.equal(existsSync(join(target, "data", "cache")), false);
		assert.equal(existsSync(join(target, "data", "locks")), false);
		assert.equal(result.backupRoot, realpathSync(parent) + sep + "backup");
	});

	await t.test("受控残留：目标父目录内容与源库在导出前后都不变", async () => {
		const root = await makeStore("d2-unchanged");
		await createRecord({ root, kind: "experience-card", id: "exp-a", expectedRevision: null, now: NOW, data: experienceBody() });
		const sourceBefore = walk(root);
		const { parent, target } = backupTarget("d2-unchanged");
		writeFileSync(join(parent, "sentinel.txt"), "不许动我", "utf8");

		await exportKnowledgeBackup({ root, backupRoot: target, offlineConfirmed: true, now: NOW, backupId: "backup-2" });

		assert.deepEqual(walk(root), sourceBefore, "导出不得修改源知识库");
		assert.equal(readFileSync(join(parent, "sentinel.txt"), "utf8"), "不许动我", "目标父目录内容不得被改写");
	});
});

/* ------------------------------------------------------------------ 2. 业务与工件共存 + 字节保真 */

test("D2：业务记录与审核工件共存，且原字节保真", async (t) => {
	await t.test("五类记录 + journal + 审核工件都进容器，字节逐字节保真", async () => {
		const root = await makeStore("d2-rich");
		// 先登记项目，否则预检会把"未登记项目目录"记为人工事项（那种库本来就不该导出）。
		await updateRegistry({
			root,
			expectedRevision: 0,
			projects: [{ biosProjectId: PROJECT_ID, workspaces: [{ workspaceId: WORKSPACE_ID, path: join(SANDBOX, "ws-main"), boundAt: 1 }], createdAt: 1, updatedAt: 1 }],
		});
		await createRecord({ root, kind: "project-profile", id: PROJECT_ID, expectedRevision: null, now: NOW, data: profileBody() });
		await createRecord({ root, kind: "experience-card", id: "exp-a", expectedRevision: null, now: NOW, data: experienceBody() });
		await createRecord({ root, kind: "feature-record", id: "feat-1", expectedRevision: null, now: NOW, data: featureBody() });
		await createRecord({ root, kind: "task-record", id: "task-1", projectId: PROJECT_ID, expectedRevision: null, now: NOW, data: taskBody() });
		await createRecord({ root, kind: "context-manifest", id: "ctx-1", projectId: PROJECT_ID, expectedRevision: null, now: NOW, data: contextBody() });
		await recordReviewDecision({ root, recordId: "exp-a", expectedRevision: 0, action: "approve", operatorLabel: "bob", reason: "证据充分", now: LATER });
		// 字节保真样本：把一条**合法**记录改写成 CRLF + 缩进 + 行尾/末尾空白的原始字节。
		// 只有仍然通过业务准入的内容才允许导出（坏 JSON 的拒绝对照另有用例），
		// 因此这里不伪造"不合法的字节也能通过"。
		await createRecord({ root, kind: "experience-card", id: "exp-raw", expectedRevision: null, now: NOW, data: experienceBody({ problem: "经验默认值" }) });
		const rawPath = join(root, "experiences", "exp-raw.json");
		const parsed = JSON.parse(readFileSync(rawPath, "utf8"));
		const raw = Buffer.from(`${JSON.stringify(parsed, null, 2).split("\n").join("\r\n")}  \r\n`, "utf8");
		writeFileSync(rawPath, raw);

		const { target } = backupTarget("d2-rich");
		const result = await exportKnowledgeBackup({ root, backupRoot: target, offlineConfirmed: true, now: NOW, backupId: "backup-3" });

		const manifest = assertContainerMatchesManifest(target);
		assert.equal(result.files, manifest.files.length);
		assert.equal(
			result.totalBytes,
			manifest.files.reduce((sum, file) => sum + file.bytes, 0),
		);

		const copiedRaw = readFileSync(join(target, "data", "experiences", "exp-raw.json"));
		assert.deepEqual(copiedRaw, raw, "原始字节必须逐字节相同（CRLF/缩进/尾部空白不得被改写）");
		assert.equal(sha256File(rawPath), manifest.files.find((file) => file.path === "experiences/exp-raw.json").sha256);

		// 空目录保留：journal 不存在（未创建）⇒ 不在清单；projects 下没有项目目录但 projects 本身在。
		assert.ok(manifest.directories.includes("projects"));
		assert.equal(manifest.directories.includes("journal"), existsSync(join(root, "journal")));
	});
});

/* ------------------------------------------------------------------ 3. 参数与目标拒绝 */

test("D2：参数与目标拒绝（任何输出创建之前）", async (t) => {
	await t.test("缺少显式离线确认 / 相对路径 / 未知限额", async () => {
		const root = await makeStore("d2-args");
		const { target } = backupTarget("d2-args");

		for (const [label, options, code] of [
			["未确认离线", { root, backupRoot: target, offlineConfirmed: false }, "backup-argument-invalid"],
			["确认值不是 true", { root, backupRoot: target, offlineConfirmed: "yes" }, "backup-argument-invalid"],
			["相对 root", { root: "relative/root", backupRoot: target, offlineConfirmed: true }, "backup-argument-invalid"],
			["相对 backupRoot", { root, backupRoot: "backup", offlineConfirmed: true }, "backup-argument-invalid"],
			["未知限额字段", { root, backupRoot: target, offlineConfirmed: true, limits: { maxFileSize: 1 } }, "invalid-limits"],
		]) {
			await assert.rejects(
				() => exportKnowledgeBackup(options),
				(error) => error?.code === code,
				label,
			);
			assert.equal(existsSync(target), false, `${label}：不得创建目标`);
		}
	});

	await t.test("目标已存在（空目录 / 旧备份 / 文件）一律拒绝，且不改动已有内容", async () => {
		const root = await makeStore("d2-exists");
		const { parent, target } = backupTarget("d2-exists");

		// 空目录
		await exportKnowledgeBackup({ root, backupRoot: target, offlineConfirmed: true, now: NOW, backupId: "backup-4" });
		const containerBefore = walk(target);
		await assert.rejects(
			() => exportKnowledgeBackup({ root, backupRoot: target, offlineConfirmed: true, now: NOW, backupId: "backup-5" }),
			(error) => error?.code === "backup-target-exists",
		);
		assert.deepEqual(walk(target), containerBefore, "已有备份的内容不得被改写或清理");

		// 文件占位
		const fileTarget = join(parent, "as-file");
		writeFileSync(fileTarget, "占位", "utf8");
		await assert.rejects(
			() => exportKnowledgeBackup({ root, backupRoot: fileTarget, offlineConfirmed: true }),
			(error) => error?.code === "backup-target-exists" || error?.code === "backup-argument-invalid",
		);
		assert.equal(readFileSync(fileTarget, "utf8"), "占位", "占位文件不得被改写");
	});

	await t.test("源目标重叠（相同 / 目标在源内 / 词法分离但解析后重叠）拒绝", async () => {
		const root = await makeStore("d2-overlap");
		const nested = join(root, "backup-inside");
		await assert.rejects(
			() => exportKnowledgeBackup({ root, backupRoot: root, offlineConfirmed: true }),
			(error) => error?.code === "backup-target-overlap",
		);
		await assert.rejects(
			() => exportKnowledgeBackup({ root, backupRoot: nested, offlineConfirmed: true }),
			(error) => error?.code === "backup-target-overlap",
		);
		assert.equal(existsSync(nested), false, "重叠时不得创建任何输出");

		// "词法分离但解析后重叠"：目标父目录是指向源根的链接 ⇒ canonical 后落在源内。
		// 链接建不出来（本机权限）时显式 skip，不用空通过占位。
		const linkParent = sandboxPath("d2-overlap-link");
		try {
			symlinkSync(root, linkParent, "junction");
		} catch {
			t.skip("本机无法创建 junction，跳过「词法分离但解析后重叠」对照");
			return;
		}
		await assert.rejects(
			() => exportKnowledgeBackup({ root, backupRoot: join(linkParent, "resolved-backup"), offlineConfirmed: true }),
			(error) => error?.code === "backup-target-overlap",
		);
	});

	await t.test("目标父目录不存在时拒绝，不自动创建父链", async () => {
		const root = await makeStore("d2-missing-parent");
		const parent = sandboxPath("d2-missing-parent");
		mkdirSync(parent, { recursive: true });
		const missing = join(parent, "deep", "backup");
		await assert.rejects(
			() => exportKnowledgeBackup({ root, backupRoot: missing, offlineConfirmed: true }),
			(error) => error?.code === "backup-argument-invalid",
		);
		assert.equal(existsSync(join(parent, "deep")), false, "不得顺手创建父目录");
	});
});
