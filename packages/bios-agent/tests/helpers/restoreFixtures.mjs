/**
 * D3 恢复用例的**合成知识库 fixture**（测试用）。
 *
 * 三条纪律（与 `storageBackupExport.test.mjs` 同一口径，这里抽出来给多个恢复用例复用）：
 * - 只建**自建临时沙箱**里的库，不读默认真实用户库或客户资料；
 * - 富库一律用**现有写入/审核 API** 合成，不手写不合法工件冒充通过；
 * - 字节与集合的判定一律用 `node:fs` / `node:crypto` **独立重算**，
 *   不拿实现自己的字段互证。
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { createRecord, initializeKnowledgeStore, recordReviewDecision, updateRegistry } from "../../core/storage/index.ts";

export const NOW = 1_700_000_000_000;
export const LATER = NOW + 60_000;
export const PROJECT_ID = "3f2504e0-4f89-4a1c-9a3d-1f0d3c9a4b7e";
export const WORKSPACE_ID = "b7d1e9f2-3c4a-4d5e-8f9a-0b1c2d3e4f50";
export const TASK_ID = "task-1";
export const CONTEXT_ID = "ctx-1";
export const EXPERIENCE_ID = "exp-a";
export const FEATURE_ID = "feat-1";

export function field(value, status = "candidate") {
	return { value, status, evidence: [], updatedAt: NOW };
}

export function experienceBody(overrides = {}) {
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

export function featureBody(overrides = {}) {
	return { originalRequirement: "客户定制引导顺序", aliases: [], customer: field("示例客户"), productLine: field("示例产品线"), acceptanceCriteria: [], relatedExperienceIds: [], ...overrides };
}

export function taskBody(workspacePath, overrides = {}) {
	return {
		workspace: { workspaceId: WORKSPACE_ID, path: workspacePath, branch: "feature/x", baseCommit: "abc1234" },
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

export function profileBody(workspacePath, overrides = {}) {
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
		workspaces: [{ workspaceId: WORKSPACE_ID, path: workspacePath, availability: "reachable", vcs: { kind: "git", branch: "main", head: "abc1234", remoteUrl: null }, capturedAt: NOW }],
		buildTargets: [field("ExampleBoardPkg")],
		keyEntryPoints: [field("PlatformPkg/Platform.dsc")],
		gaps: [],
		...overrides,
	};
}

export function contextBody(overrides = {}) {
	return {
		taskId: TASK_ID,
		profileRevision: 0,
		sources: [],
		expiredSources: [],
		budget: { maxChars: 12_000, maxBytes: 24_576, usedChars: 0, truncated: false },
		generatedAt: NOW,
		...overrides,
	};
}

/** 最小库：只初始化（registry + 四个必需目录）。 */
export async function makeEmptyStore(root) {
	await initializeKnowledgeStore({ root });
	return root;
}

/**
 * 富库：五类记录 + 普通 journal v1（`createRecord` 自带）+ 审核 journal v2/意图/事件。
 *
 * 最后删掉 task 文件，留下一个**清单里登记过、但没有文件**的空目录 `projects/<id>/tasks`，
 * 用来验证"已知空目录也必须被恢复"。
 */
export async function makeRichStore(root, workspacePath, { emptyTasks = true } = {}) {
	await initializeKnowledgeStore({ root });
	await updateRegistry({
		root,
		expectedRevision: 0,
		projects: [{ biosProjectId: PROJECT_ID, workspaces: [{ workspaceId: WORKSPACE_ID, path: workspacePath, boundAt: 1 }], createdAt: 1, updatedAt: 1 }],
	});
	await createRecord({ root, kind: "project-profile", id: PROJECT_ID, expectedRevision: null, now: NOW, data: profileBody(workspacePath) });
	await createRecord({ root, kind: "experience-card", id: EXPERIENCE_ID, expectedRevision: null, now: NOW, data: experienceBody() });
	await createRecord({ root, kind: "feature-record", id: FEATURE_ID, expectedRevision: null, now: NOW, data: featureBody() });
	await createRecord({ root, kind: "task-record", id: TASK_ID, projectId: PROJECT_ID, expectedRevision: null, now: NOW, data: taskBody(workspacePath) });
	await createRecord({ root, kind: "context-manifest", id: CONTEXT_ID, projectId: PROJECT_ID, expectedRevision: null, now: NOW, data: contextBody() });
	await recordReviewDecision({ root, recordId: EXPERIENCE_ID, expectedRevision: 0, action: "approve", operatorLabel: "bob", reason: "证据充分", now: LATER });
	// 已知空目录：文件删掉，目录保留（清单必须登记它，恢复必须把它建回来）。
	if (emptyTasks) rmSync(join(root, "projects", PROJECT_ID, "tasks", `${TASK_ID}.json`));
	return root;
}

/** 递归清单（目录 + 文件相对路径），供与恢复目标做集合对照。 */
export function walk(root) {
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

export function sha256File(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * 目录树快照（`d:<相对路径>` / `f:<相对路径>:<base64>`）：用于"只读"断言。
 *
 * 用 base64 而不是长度/hash：长度相同但内容被改写的失败模式（D3 的源变化用例）
 * 必须能被这条断言抓到。
 */
export function snapshotTree(root) {
	const out = [];
	const visit = (absolute) => {
		for (const entry of readdirSync(absolute, { withFileTypes: true }).sort((left, right) => (left.name < right.name ? -1 : 1))) {
			const target = join(absolute, entry.name);
			const rel = relative(root, target).split(sep).join("/");
			if (entry.isDirectory()) {
				out.push(`d:${rel}`);
				visit(target);
				continue;
			}
			out.push(`f:${rel}:${readFileSync(target).toString("base64")}`);
		}
	};
	if (existsSync(root)) visit(root);
	return out;
}

export function readManifest(backupRoot) {
	return JSON.parse(readFileSync(join(backupRoot, "manifest.json"), "utf8"));
}

/** 独立复核备份容器：集合、长度与 SHA-256 全部用 fs/crypto 重算（不用实现自己的字段）。 */
export function assertBackupContainerIntact(backupRoot) {
	const manifest = readManifest(backupRoot);
	const dataRoot = join(backupRoot, "data");
	const actual = walk(dataRoot);
	if (JSON.stringify(actual.files) !== JSON.stringify(manifest.files.map((file) => file.path))) throw new Error("备份 data/ 文件集合与清单不一致");
	if (JSON.stringify(actual.directories) !== JSON.stringify(manifest.directories)) throw new Error("备份 data/ 目录集合与清单不一致");
	for (const file of manifest.files) {
		const absolute = join(dataRoot, ...file.path.split("/"));
		if (statSync(absolute).size !== file.bytes) throw new Error(`${file.path} 长度与清单不一致`);
		if (sha256File(absolute) !== file.sha256) throw new Error(`${file.path} SHA-256 与清单不一致`);
	}
	return manifest;
}

/** 恢复目标与源库必须**逐字节**一致（除 registry 之外的文件集合也要一致）。 */
export function assertRestoredByteIdentical(sourceRoot, restoredRoot, { skipRegistry = false } = {}) {
	const source = walk(sourceRoot);
	const restored = walk(restoredRoot);
	const expectedFiles = source.files.filter((file) => !(skipRegistry && file === "registry.json"));
	if (JSON.stringify(restored.files) !== JSON.stringify(expectedFiles)) throw new Error(`恢复文件集合不一致：${JSON.stringify(restored.files)} vs ${JSON.stringify(expectedFiles)}`);
	for (const file of expectedFiles) {
		const left = readFileSync(join(sourceRoot, ...file.split("/")));
		const right = readFileSync(join(restoredRoot, ...file.split("/")));
		if (!left.equals(right)) throw new Error(`${file} 字节不一致`);
	}
	return { source, restored };
}
