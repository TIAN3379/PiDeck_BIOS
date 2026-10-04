/**
 * 预检的**固定落点遍历**（BM-02C3）。
 *
 * 只走 §3 布局表里的落点，固定深度、不递归未知目录、不跟随链接、不进 cache。
 * 每个类别都走同一套"读一个候选 → 记摘要 → 必要时记问题/人工事项"的管道
 * （`scan.ts` 的预算与报告原语），所以"预算用完了还继续读"这类错误不会只在某个类别里出现。
 */
import { auditIntentFileName, isValidKnowledgeId } from "../../contracts/index.ts";
import { isJournalOperationId, journalFileName, JOURNAL_FILE_SUFFIX } from "../journal/index.ts";
import { interpretRegistryValue } from "../registry.ts";
import { REVIEW_INTENT_DIR_NAME } from "../review/artifacts.ts";
import { reviewArtifactLimit } from "../review/contract.ts";
import type { PreflightCategory } from "./contract.ts";
import { addManual, addProblem, addSummary, boundMessage, chargeLogicalCheck, countVersion, listEntriesBounded, placeholderPath, readJsonBounded, recordVerdict, reportReadFailure, type ScanState } from "./scan.ts";
import { verdictForEvent, verdictForIntent, verdictForJournal, verdictForRecord, versionOf } from "./verdicts.ts";
import type { RecordKind } from "../../contracts/records.ts";

const RECORD_CATEGORY: { readonly [K in RecordKind]: PreflightCategory } = {
	"project-profile": "project-profile",
	"task-record": "project-task",
	"context-manifest": "project-context",
	"experience-card": "experience-card",
	"feature-record": "feature-record",
};

/**
 * 未知条目：名称一律省略（诊断不能变成泄漏通道），只给位置占位与受控说明。
 *
 * 导出给 `auxiliaryCategories.ts` 的根级落点复用（同一句诊断，避免两处各写一遍文案）。
 */
export function reportUnknownEntry(scan: ScanState, args: { category: PreflightCategory; parent: string; blocks: boolean; message?: string }): void {
	const relativePath = placeholderPath(args.parent);
	const status = "invalid";
	addSummary(scan, { category: args.category, relativePath, status, version: null, code: "unknown-entry" });
	addProblem(scan, {
		category: args.category,
		relativePath,
		status,
		code: "unknown-entry",
		message: boundMessage(scan, args.message ?? "存在无法按当前布局解释的条目（名称已省略），不进入扫描、不删除"),
		blocks: args.blocks,
	});
}

/** `.tmp` 残留：只报告存在，不判断可抢、不删除、不清理（同样导出给根级落点复用）。 */
export function reportResidue(scan: ScanState): void {
	addManual(scan, { category: "residue", relativePath: placeholderPath("."), reason: "temp-residue", message: "存在 .tmp 残留（名称已省略）：请人工清理，预检不删除" });
}

/** 受控相对路径 → 绝对路径绝对片段（只由已校验的 ID 与固定目录名拼出）。 */
function segmentsFor(collection: string, id: string): string[] {
	return [...collection.split("/"), `${id}${JOURNAL_FILE_SUFFIX}`];
}

/** 读一个记录候选（含"读失败"与"读到了但解释失败"两条报告路径）。 */
async function scanRecordCandidate(scan: ScanState, args: { kind: RecordKind; id: string; expected: { id: string; projectId?: string }; relativePath: string; absolute: string }): Promise<void> {
	const read = await readJsonBounded(scan, args.absolute);
	if (read.kind === "stopped") return;
	const category = RECORD_CATEGORY[args.kind];
	if (read.kind === "failed") {
		reportReadFailure(scan, { category, relativePath: args.relativePath, family: "record", code: read.code, message: read.message });
		return;
	}
	recordVerdict(scan, { category, relativePath: args.relativePath, family: "record", verdict: verdictForRecord(args.kind, read.value, args.expected) });
}

export async function scanRegistry(scan: ScanState): Promise<ReadonlySet<string> | null> {
	const relativePath = "registry.json";
	const read = await readJsonBounded(scan, scan.boundary.resolve("registry.json"));
	if (read.kind === "stopped") return null;
	if (read.kind === "failed") {
		reportReadFailure(scan, {
			category: "registry",
			relativePath,
			family: "registry",
			code: read.code,
			message: read.code === "not-found" ? "registry.json 不存在：知识库可能尚未初始化（预检不会创建空库）" : read.message,
		});
		return null;
	}
	const version = versionOf(read.value);
	const interpreted = interpretRegistryValue(read.value);
	if (!interpreted.ok) {
		const status = interpreted.code === "unsupported-schema-version" ? "unsupported-version" : "invalid";
		countVersion(scan, "registry", version);
		addSummary(scan, { category: "registry", relativePath, status, version, code: interpreted.code });
		addProblem(scan, { category: "registry", relativePath, status, code: interpreted.code, message: boundMessage(scan, interpreted.message), blocks: true });
		return null;
	}
	recordVerdict(scan, { category: "registry", relativePath, family: "registry", verdict: { ok: true, status: "ok", version, code: null } });
	return new Set(interpreted.registry.projects.map((project) => project.biosProjectId));
}

/** 常规记录目录（`experiences/`、`features/`、`projects/<id>/tasks|context`）。 */
export async function scanRecordDirectory(scan: ScanState, args: { directory: string; kind: RecordKind; collection: string; projectId?: string }): Promise<void> {
	const listing = await listEntriesBounded(scan, args.directory, false);
	if ("stopped" in listing) return;
	if ("absent" in listing) return;
	if ("error" in listing) {
		reportReadFailure(scan, { category: RECORD_CATEGORY[args.kind], relativePath: args.collection, family: "record", code: listing.error.code, message: listing.error.message });
		return;
	}
	for (const name of listing.entries) {
		if (scan.stopped) return;
		if (name.endsWith(".tmp")) {
			reportResidue(scan);
			continue;
		}
		if (!name.endsWith(JOURNAL_FILE_SUFFIX) || name.startsWith(".")) {
			reportUnknownEntry(scan, { category: RECORD_CATEGORY[args.kind], parent: args.collection, blocks: true, message: "记录目录内存在非 JSON 或隐藏条目（名称已省略）：可能是无法解释的数据" });
			continue;
		}
		const id = name.slice(0, -JOURNAL_FILE_SUFFIX.length);
		if (!isValidKnowledgeId(id)) {
			reportUnknownEntry(scan, { category: RECORD_CATEGORY[args.kind], parent: args.collection, blocks: true, message: "文件名无法按受控知识 ID 解释（名称已省略）" });
			continue;
		}
		await scanRecordCandidate(scan, {
			kind: args.kind,
			id,
			expected: { id, ...(args.projectId === undefined ? {} : { projectId: args.projectId }) },
			relativePath: `${args.collection}/${id}${JOURNAL_FILE_SUFFIX}`,
			absolute: scan.boundary.resolve(...segmentsFor(args.collection, id)),
		});
		if (scan.stopped) return;
	}
}

async function scanProjectDirectory(scan: ScanState, projectId: string): Promise<void> {
	const base = `projects/${projectId}`;
	await scanRecordCandidate(scan, {
		kind: "project-profile",
		id: projectId,
		expected: { id: projectId },
		relativePath: `${base}/profile.json`,
		absolute: scan.boundary.resolve("projects", projectId, "profile.json"),
	});
	if (scan.stopped) return;

	// 项目目录内的其它条目：这里"辅助文件也可能存在"，只诊断、不阻断。
	const listing = await listEntriesBounded(scan, scan.boundary.resolve("projects", projectId), true);
	if ("entries" in listing) {
		for (const name of listing.entries) {
			if (scan.stopped) return;
			if (name === "profile.json" || name === "tasks" || name === "context") continue;
			if (name.endsWith(".tmp")) {
				reportResidue(scan);
				continue;
			}
			reportUnknownEntry(scan, { category: "project-profile", parent: base, blocks: false, message: "项目目录内存在布局外的条目（名称已省略），不进入扫描" });
		}
	} else if ("error" in listing) {
		reportReadFailure(scan, { category: "project-profile", relativePath: base, family: "record", code: listing.error.code, message: listing.error.message });
	}
	if (scan.stopped) return;

	await scanRecordDirectory(scan, { directory: scan.boundary.resolve("projects", projectId, "tasks"), kind: "task-record", collection: `${base}/tasks`, projectId });
	if (scan.stopped) return;
	await scanRecordDirectory(scan, { directory: scan.boundary.resolve("projects", projectId, "context"), kind: "context-manifest", collection: `${base}/context`, projectId });
}

export async function scanProjects(scan: ScanState, registered: ReadonlySet<string> | null): Promise<void> {
	const listing = await listEntriesBounded(scan, scan.boundary.resolve("projects"), true);
	if ("stopped" in listing) return;
	if ("absent" in listing) {
		addProblem(scan, { category: "project-profile", relativePath: "projects", status: "missing", code: "not-found", message: boundMessage(scan, "projects/ 不存在：知识库布局不完整（预检不会创建它）"), blocks: true });
		return;
	}
	if ("error" in listing) {
		reportReadFailure(scan, { category: "project-profile", relativePath: "projects", family: "record", code: listing.error.code, message: listing.error.message });
		return;
	}

	const directories: string[] = [];
	for (const name of listing.entries) {
		if (scan.stopped) return;
		if (name.endsWith(".tmp")) {
			reportResidue(scan);
			continue;
		}
		if (!isValidKnowledgeId(name, "project")) {
			reportUnknownEntry(scan, { category: "project-profile", parent: "projects", blocks: false, message: "projects/ 下存在无法按项目 ID 解释的条目（名称已省略），不进入扫描" });
			continue;
		}
		directories.push(name);
	}

	// 已登记但磁盘上没有对应目录：注册表说它存在，事实却没有 —— 必须报出来。
	if (registered !== null) {
		for (const projectId of registered) {
			if (directories.includes(projectId)) continue;
			// 这是**逻辑核对**（registry 与目录清单对照），不是物理目录观察：不得计入 `scannedEntries`。
			if (!chargeLogicalCheck(scan)) return;
			reportReadFailure(scan, {
				category: "project-profile",
				relativePath: `projects/${projectId}/profile.json`,
				family: "record",
				code: "not-found",
				message: "registry 已登记该项目，但磁盘上没有对应项目目录/档案",
			});
		}
	}

	for (const projectId of directories) {
		if (scan.stopped) return;
		if (registered !== null && !registered.has(projectId)) {
			addManual(scan, {
				category: "project-profile",
				relativePath: `projects/${projectId}`,
				reason: "unregistered-project",
				message: boundMessage(scan, "存在未登记项目目录：可能是孤立候选，需要人工确认（预检不自动关联、不删除）"),
			});
		}
		await scanProjectDirectory(scan, projectId);
	}
}

export async function scanJournalDirectory(scan: ScanState): Promise<void> {
	const listing = await listEntriesBounded(scan, scan.boundary.resolve("journal"), false);
	if ("stopped" in listing || "absent" in listing) return;
	if ("error" in listing) {
		reportReadFailure(scan, { category: "journal", relativePath: "journal", family: "journal", code: listing.error.code, message: listing.error.message });
		return;
	}
	for (const name of listing.entries) {
		if (scan.stopped) return;
		if (name.endsWith(".tmp")) {
			reportResidue(scan);
			continue;
		}
		if (!name.endsWith(JOURNAL_FILE_SUFFIX) || name.startsWith(".")) {
			reportUnknownEntry(scan, { category: "journal", parent: "journal", blocks: true, message: "journal 目录内存在非 journal 条目（名称已省略）" });
			continue;
		}
		const operationId = name.slice(0, -JOURNAL_FILE_SUFFIX.length);
		if (!isJournalOperationId(operationId) || journalFileName(operationId) !== name) {
			reportUnknownEntry(scan, { category: "journal", parent: "journal", blocks: true, message: "journal 文件名不是受控的 operationId.json（名称已省略）" });
			continue;
		}
		const relativePath = `journal/${name}`;
		const read = await readJsonBounded(scan, scan.boundary.resolve("journal", name));
		if (read.kind === "stopped") return;
		if (read.kind === "failed") {
			reportReadFailure(scan, { category: "journal", relativePath, family: "journal", code: read.code, message: read.message });
			continue;
		}
		recordVerdict(scan, { category: "journal", relativePath, family: "journal", verdict: verdictForJournal(read.value, name) });
	}
}

async function scanIntentDirectory(scan: ScanState): Promise<void> {
	const collection = `audit/${REVIEW_INTENT_DIR_NAME}`;
	const listing = await listEntriesBounded(scan, scan.boundary.resolve("audit", REVIEW_INTENT_DIR_NAME), false);
	if ("stopped" in listing || "absent" in listing) return;
	if ("error" in listing) {
		reportReadFailure(scan, { category: "audit-intent", relativePath: collection, family: "audit-intent", code: listing.error.code, message: listing.error.message });
		return;
	}
	for (const name of listing.entries) {
		if (scan.stopped) return;
		if (name.endsWith(".tmp")) {
			reportResidue(scan);
			continue;
		}
		if (!name.endsWith(JOURNAL_FILE_SUFFIX) || name.startsWith(".")) {
			reportUnknownEntry(scan, { category: "audit-intent", parent: collection, blocks: true, message: "意图目录内存在非 JSON 条目（名称已省略）" });
			continue;
		}
		const operationId = name.slice(0, -JOURNAL_FILE_SUFFIX.length);
		if (!isJournalOperationId(operationId) || auditIntentFileName(operationId) !== name) {
			reportUnknownEntry(scan, { category: "audit-intent", parent: collection, blocks: true, message: "意图文件名不是受控的 operationId.json（名称已省略）" });
			continue;
		}
		const relativePath = `${collection}/${name}`;
		const read = await readJsonBounded(scan, scan.boundary.resolve("audit", REVIEW_INTENT_DIR_NAME, name), reviewArtifactLimit(scan.boundary.limits));
		if (read.kind === "stopped") return;
		if (read.kind === "failed") {
			reportReadFailure(scan, { category: "audit-intent", relativePath, family: "audit-intent", code: read.code, message: read.message });
			continue;
		}
		recordVerdict(scan, { category: "audit-intent", relativePath, family: "audit-intent", verdict: verdictForIntent(read.value, operationId) });
	}
}

async function scanEventDirectory(scan: ScanState, recordId: string): Promise<void> {
	const collection = `audit/${recordId}`;
	const listing = await listEntriesBounded(scan, scan.boundary.resolve("audit", recordId), false);
	if ("stopped" in listing || "absent" in listing) return;
	if ("error" in listing) {
		reportReadFailure(scan, { category: "audit-event", relativePath: collection, family: "audit-event", code: listing.error.code, message: listing.error.message });
		return;
	}
	for (const name of listing.entries) {
		if (scan.stopped) return;
		if (name.endsWith(".tmp")) {
			reportResidue(scan);
			continue;
		}
		if (!name.endsWith(JOURNAL_FILE_SUFFIX) || name.startsWith(".")) {
			reportUnknownEntry(scan, { category: "audit-event", parent: collection, blocks: true, message: "事件目录内存在非 JSON 条目（名称已省略）" });
			continue;
		}
		const eventId = name.slice(0, -JOURNAL_FILE_SUFFIX.length);
		if (!isJournalOperationId(eventId)) {
			reportUnknownEntry(scan, { category: "audit-event", parent: collection, blocks: true, message: "事件文件名不是受控的事件 ID（名称已省略）" });
			continue;
		}
		const relativePath = `${collection}/${name}`;
		const read = await readJsonBounded(scan, scan.boundary.resolve("audit", recordId, name), reviewArtifactLimit(scan.boundary.limits));
		if (read.kind === "stopped") return;
		if (read.kind === "failed") {
			reportReadFailure(scan, { category: "audit-event", relativePath, family: "audit-event", code: read.code, message: read.message });
			continue;
		}
		recordVerdict(scan, { category: "audit-event", relativePath, family: "audit-event", verdict: verdictForEvent(read.value, recordId, eventId) });
	}
}

export async function scanAuditDirectory(scan: ScanState): Promise<void> {
	const listing = await listEntriesBounded(scan, scan.boundary.resolve("audit"), false);
	if ("stopped" in listing || "absent" in listing) return;
	if ("error" in listing) {
		reportReadFailure(scan, { category: "audit-event", relativePath: "audit", family: "audit-event", code: listing.error.code, message: listing.error.message });
		return;
	}
	for (const name of listing.entries) {
		if (scan.stopped) return;
		if (name.endsWith(".tmp")) {
			reportResidue(scan);
			continue;
		}
		if (name === REVIEW_INTENT_DIR_NAME) {
			await scanIntentDirectory(scan);
			if (scan.stopped) return;
			continue;
		}
		if (name.startsWith(".") || !isValidKnowledgeId(name)) {
			reportUnknownEntry(scan, { category: "audit-event", parent: "audit", blocks: true, message: "audit/ 下存在无法按记录 ID 解释的条目（名称已省略），不进入扫描" });
			continue;
		}
		await scanEventDirectory(scan, name);
		if (scan.stopped) return;
	}
}

/* 锁 / cache / 根布局外条目三个落点见 `auxiliaryCategories.ts`（BM-02C3R：文件体量红线拆分）。 */
