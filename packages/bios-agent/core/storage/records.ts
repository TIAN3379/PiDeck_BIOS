/**
 * 记录读取与有界列表（BM-02A）。
 *
 * 三条规则：
 * 1. **路径只能从受控的 kind + ID 派生**：生产 API 不接受调用方给文件名或绝对路径，
 *    否则"根内读取"就变成提示词可以改变的东西；
 * 2. **文件路径里的 ID、记录内容里的 ID、任务所属项目必须三者一致**，
 *    否则一个"格式合法的 JSON"就能冒充别的项目记录（`record-id-mismatch`）；
 * 3. **单条异常与整体失败可区分**：列表里某条损坏不会让整个列表失败，也不会被当成"不存在"，
 *    而是进入 `problems`。
 */
import type { ContextManifest, ExperienceCard, FeatureRecord, ProjectProfile, TaskRecord } from "../contracts/records.ts";
import { RECORD_SCHEMAS, type RecordKind } from "../contracts/records.ts";
import { assertKnowledgeId, type KnowledgeIdKind } from "../contracts/ids.ts";
import { describeIssues, validateRecord } from "../contracts/validate.ts";
import { createStorageBoundary, type StorageBoundary } from "./boundary.ts";
import { StorageError, throwIfCancelled } from "./errors.ts";
import type { StorageLimits } from "./limits.ts";
import { knowledgeLayout } from "./registry.ts";

/** kind → 记录类型的映射（从 schema 推导，不另立一套分叉类型）。 */
export type RecordByKind = {
	"project-profile": ProjectProfile;
	"task-record": TaskRecord;
	"feature-record": FeatureRecord;
	"experience-card": ExperienceCard;
	"context-manifest": ContextManifest;
};

/** 需要 projectId 才能定位的 kind。 */
const PROJECT_SCOPED_KINDS: ReadonlySet<RecordKind> = new Set<RecordKind>(["task-record", "context-manifest"]);

/** 摘要里最多保留的标签字符数（列表不返回正文）。 */
const SUMMARY_LABEL_MAX_CHARS = 80;

function assertId(value: string, label: string, kind: KnowledgeIdKind = "generic"): string {
	try {
		return assertKnowledgeId(value, label, kind);
	} catch (error) {
		throw new StorageError("invalid-record", `${label} 不合法：${error instanceof Error ? error.message : String(error)}`, { cause: error });
	}
}

function requireProjectId(projectId: string | undefined, kind: RecordKind): string {
	if (projectId === undefined || projectId.length === 0) {
		throw new StorageError("invalid-record", `${kind} 必须指定 projectId 才能定位文件`);
	}
	return assertId(projectId, "projectId", "project");
}

/** kind + ID → 根内相对路径片段（受控派生，调用方无法注入文件名）。 */
export function recordRelativeSegments(kind: RecordKind, id: string, projectId?: string): string[] {
	switch (kind) {
		case "project-profile":
			// profile.json 位于项目目录下，路径里的项目 ID 就是记录 ID。
			return ["projects", assertId(id, "projectId", "project"), "profile.json"];
		case "task-record":
			return ["projects", requireProjectId(projectId, kind), "tasks", `${assertId(id, "taskId")}.json`];
		case "context-manifest":
			// 上下文清单属于项目（主线文档 §5.1 的 projects 子树；落点在 README 中记录）。
			return ["projects", requireProjectId(projectId, kind), "context", `${assertId(id, "manifestId")}.json`];
		case "experience-card":
			return ["experiences", `${assertId(id, "experienceId")}.json`];
		case "feature-record":
			return ["features", `${assertId(id, "featureId")}.json`];
	}
}

export type ReadRecordOptions = {
	root: string;
	kind: RecordKind;
	id: string;
	/** task-record 与 context-manifest 必填；其余 kind 忽略。 */
	projectId?: string;
	limits?: Partial<StorageLimits>;
	signal?: AbortSignal;
};

export type ReadRecordResult<K extends RecordKind = RecordKind> = {
	kind: K;
	id: string;
	record: RecordByKind[K];
	path: string;
	bytes: number;
};

export async function readRecord<K extends RecordKind>(options: ReadRecordOptions & { kind: K }): Promise<ReadRecordResult<K>> {
	const boundary = await createStorageBoundary({ root: options.root, limits: options.limits, signal: options.signal });
	return readRecordWithBoundary<K>(boundary, options);
}

export async function readRecordWithBoundary<K extends RecordKind>(boundary: StorageBoundary, options: { kind: K; id: string; projectId?: string; signal?: AbortSignal }): Promise<ReadRecordResult<K>> {
	throwIfCancelled(options.signal ?? boundary.signal);
	const absolute = boundary.resolve(...recordRelativeSegments(options.kind, options.id, options.projectId));
	const { value, bytes } = await boundary.readJson(absolute, boundary.limits.maxRecordBytes);

	const outcome = validateRecord(RECORD_SCHEMAS[options.kind], value);
	if (!outcome.ok) {
		const versionIssue = outcome.issues.find((issue) => issue.code === "unsupported-schema-version");
		if (versionIssue) {
			throw new StorageError("unsupported-schema-version", `${options.kind} 版本无法解释：${versionIssue.message}`, { path: absolute });
		}
		throw new StorageError("invalid-record", `${options.kind} 结构不合法：${describeIssues(outcome.issues)}`, { path: absolute });
	}

	// 类型收窄说明：`RECORD_SCHEMAS` 与 `RecordByKind` 是同一份映射的两种表达，
	// 上面已经用对应 schema 校验通过；这里是"表驱动"带来的类型损失，不是绕过校验。
	const record = outcome.value as RecordByKind[K];
	if (record.id !== options.id) {
		throw new StorageError("record-id-mismatch", `记录内容 ID（${record.id}）与请求 ID（${options.id}）不一致：${absolute}`, { path: absolute });
	}
	if (options.kind === "task-record") {
		const task = record as TaskRecord;
		if (task.projectId !== options.projectId) {
			throw new StorageError("record-id-mismatch", `任务记录的 projectId（${task.projectId}）与所在项目（${options.projectId ?? "(未指定)"}）不一致：${absolute}`, {
				path: absolute,
			});
		}
	}
	if (options.kind === "context-manifest") {
		const manifest = record as ContextManifest;
		if (manifest.targetProjectId !== options.projectId) {
			throw new StorageError("record-id-mismatch", `上下文清单的 targetProjectId（${manifest.targetProjectId}）与所在项目（${options.projectId ?? "(未指定)"}）不一致：${absolute}`, {
				path: absolute,
			});
		}
	}

	return { kind: options.kind, id: options.id, record, path: absolute, bytes };
}

export type RecordSummary = {
	id: string;
	revision: number;
	updatedAt: number;
	/** 截断后的短标签（仅供列表展示，不返回正文）。 */
	label: string;
	path: string;
};

export type ListRecordsResult = {
	kind: RecordKind;
	directory: string;
	entries: RecordSummary[];
	truncated: boolean;
	truncatedBy: Array<"entries" | "bytes" | "scan">;
	/** 单条无法读取/校验的条目（与整体失败区分，也不当成不存在）。 */
	problems: Array<{ path: string; code: string; message: string }>;
	/** 扫描到的候选条目数。 */
	scanned: number;
};

export type ListRecordsOptions = {
	root: string;
	kind: RecordKind;
	/** task-record 与 context-manifest 必填。 */
	projectId?: string;
	limits?: Partial<StorageLimits>;
	signal?: AbortSignal;
};

function truncateLabel(value: string): string {
	const singleLine = value.replace(/\s+/g, " ").trim();
	return singleLine.length <= SUMMARY_LABEL_MAX_CHARS ? singleLine : `${singleLine.slice(0, SUMMARY_LABEL_MAX_CHARS)}…`;
}

function summarize(kind: RecordKind, record: { id: string; revision: number; updatedAt: number } & Record<string, unknown>): string {
	switch (kind) {
		case "project-profile": {
			const profile = record as unknown as ProjectProfile;
			return truncateLabel(profile.identity.boardName.value ?? profile.identity.ibv.value ?? profile.id);
		}
		case "task-record": {
			const task = record as unknown as TaskRecord;
			return truncateLabel(task.requirement);
		}
		case "feature-record": {
			const feature = record as unknown as FeatureRecord;
			return truncateLabel(feature.originalRequirement);
		}
		case "experience-card": {
			const card = record as unknown as ExperienceCard;
			return truncateLabel(card.problem);
		}
		case "context-manifest": {
			const manifest = record as unknown as ContextManifest;
			return truncateLabel(`${manifest.sources.length} 个上下文来源`);
		}
	}
}

/** 列出候选条目（project-profile 需要先列出项目目录）。 */
async function listCandidates(boundary: StorageBoundary, options: ListRecordsOptions): Promise<{ directory: string; candidates: Array<{ id: string; projectId?: string }>; truncated: boolean; scanned: number }> {
	const layout = knowledgeLayout(boundary);
	const maxScanEntries = boundary.limits.maxScanEntries;

	if (options.kind === "project-profile") {
		const listing = await boundary.listEntries(layout.projectsDir, { filesOnly: false, maxEntries: maxScanEntries });
		const candidates = listing.names.filter((name) => !name.startsWith(".")).map((name) => ({ id: name }));
		return { directory: layout.projectsDir, candidates, truncated: listing.truncated, scanned: listing.scanned };
	}

	if (PROJECT_SCOPED_KINDS.has(options.kind)) {
		const projectId = requireProjectId(options.projectId, options.kind);
		const directory = options.kind === "task-record" ? boundary.resolve("projects", projectId, "tasks") : boundary.resolve("projects", projectId, "context");
		const listing = await boundary.listEntries(directory, { filesOnly: true, maxEntries: maxScanEntries });
		const candidates = listing.names.filter((name) => name.endsWith(".json") && !name.startsWith(".")).map((name) => ({ id: name.slice(0, -".json".length), projectId }));
		return { directory, candidates, truncated: listing.truncated, scanned: listing.scanned };
	}

	const directory = options.kind === "experience-card" ? layout.experiencesDir : layout.featuresDir;
	const listing = await boundary.listEntries(directory, { filesOnly: true, maxEntries: maxScanEntries });
	const candidates = listing.names.filter((name) => name.endsWith(".json") && !name.startsWith(".")).map((name) => ({ id: name.slice(0, -".json".length) }));
	return { directory, candidates, truncated: listing.truncated, scanned: listing.scanned };
}

export async function listRecords(options: ListRecordsOptions): Promise<ListRecordsResult> {
	const boundary = await createStorageBoundary({ root: options.root, limits: options.limits, signal: options.signal });
	return listRecordsWithBoundary(boundary, options);
}

export async function listRecordsWithBoundary(boundary: StorageBoundary, options: ListRecordsOptions): Promise<ListRecordsResult> {
	const { directory, candidates, truncated: scanTruncated, scanned } = await listCandidates(boundary, options);
	const truncatedBy: ListRecordsResult["truncatedBy"] = [];
	if (scanTruncated) truncatedBy.push("scan");

	const entries: RecordSummary[] = [];
	const problems: ListRecordsResult["problems"] = [];
	let usedBytes = 0;

	for (const candidate of candidates) {
		throwIfCancelled(options.signal ?? boundary.signal);
		if (entries.length >= boundary.limits.maxListEntries) {
			if (!truncatedBy.includes("entries")) truncatedBy.push("entries");
			break;
		}

		const absolute = boundary.resolve(...recordRelativeSegments(options.kind, candidate.id, candidate.projectId));
		let read;
		try {
			read = await boundary.readJson(absolute, boundary.limits.maxRecordBytes);
		} catch (error) {
			// 单条问题进入 problems（可区分），整体继续；绝不静默当成"不存在"。
			problems.push({
				path: absolute,
				code: error instanceof StorageError ? error.code : "invalid-record",
				message: error instanceof Error ? error.message : String(error),
			});
			continue;
		}

		const outcome = validateRecord(RECORD_SCHEMAS[options.kind], read.value);
		if (!outcome.ok) {
			const versionIssue = outcome.issues.find((issue) => issue.code === "unsupported-schema-version");
			problems.push({
				path: absolute,
				code: versionIssue ? "unsupported-schema-version" : "invalid-record",
				message: describeIssues(outcome.issues, 3),
			});
			continue;
		}

		const record = outcome.value as { id: string; revision: number; updatedAt: number };
		if (record.id !== candidate.id) {
			problems.push({ path: absolute, code: "record-id-mismatch", message: `记录内容 ID（${record.id}）与文件名（${candidate.id}）不一致` });
			continue;
		}

		const label = summarize(options.kind, outcome.value as never);
		const entryBytes = Buffer.byteLength(label) + Buffer.byteLength(candidate.id);
		if (usedBytes + entryBytes > boundary.limits.maxListBytes) {
			if (!truncatedBy.includes("bytes")) truncatedBy.push("bytes");
			break;
		}
		usedBytes += entryBytes;
		entries.push({ id: record.id, revision: record.revision, updatedAt: record.updatedAt, label, path: absolute });
	}

	return { kind: options.kind, directory, entries, truncated: truncatedBy.length > 0, truncatedBy, problems, scanned };
}
