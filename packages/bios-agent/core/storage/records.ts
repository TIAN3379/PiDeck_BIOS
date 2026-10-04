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
import { sep } from "node:path";
import type { ContextManifest, ExperienceCard, FeatureRecord, ProjectProfile, TaskRecord } from "../contracts/records.ts";
import { RECORD_SCHEMAS, type RecordKind } from "../contracts/records.ts";
import { assertKnowledgeId, type KnowledgeIdKind } from "../contracts/ids.ts";
import { describeIssues, validateRecord } from "../contracts/validate.ts";
import { createStorageBoundary, type StorageBoundary, type StorageIoHooks } from "./boundary.ts";
import { StorageError, type StorageErrorCode, throwIfAnyCancelled } from "./errors.ts";
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
	/** 受控 IO 故障注入（仅测试；见 boundary.ts 的 StorageIoHooks）。 */
	ioHooks?: StorageIoHooks;
};

export type ReadRecordResult<K extends RecordKind = RecordKind> = {
	kind: K;
	id: string;
	record: RecordByKind[K];
	path: string;
	bytes: number;
};

export async function readRecord<K extends RecordKind>(options: ReadRecordOptions & { kind: K }): Promise<ReadRecordResult<K>> {
	const boundary = await createStorageBoundary({ root: options.root, limits: options.limits, signal: options.signal, ioHooks: options.ioHooks });
	return readRecordWithBoundary<K>(boundary, options);
}

export async function readRecordWithBoundary<K extends RecordKind>(boundary: StorageBoundary, options: { kind: K; id: string; projectId?: string; signal?: AbortSignal }): Promise<ReadRecordResult<K>> {
	// 显式传入的信号与 boundary 自身信号**任一取消**都立即失败（BM-02AR / S3）。
	throwIfAnyCancelled([options.signal, boundary.signal]);

	const absolute = boundary.resolve(...recordRelativeSegments(options.kind, options.id, options.projectId));
	// 调用方信号透传进 IO 层：读取循环与 return 之前的取消检查都在那里，
	// 而不是在入口检查一次、IO 返回后直接当成功。
	const { value, bytes } = await boundary.readJson(absolute, boundary.limits.maxRecordBytes, options.signal);

	// 与列表共用同一条校验链（BM-02AR / S2）：结构 → 版本 → ID 一致 → 归属一致。
	const interpreted = interpretRecord(options.kind, value, { id: options.id, projectId: options.projectId });
	if (!interpreted.ok) {
		throw new StorageError(interpreted.problem.code, `${options.kind} 读取被拒绝：${interpreted.problem.message}`, { path: absolute });
	}

	return { kind: options.kind, id: options.id, record: interpreted.record, path: absolute, bytes };
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
	/**
	 * 截断维度（可同时出现多个）：
	 * - `scan`：达到目录扫描条目上限，**还没看完目录**；
	 * - `entries`：达到返回条目上限，好条目可能还有；
	 * - `problems`：达到问题报告上限，坏条目还有；
	 * - `bytes`：达到输出字节预算（条目与问题共用），后续内容未纳入。
	 */
	truncatedBy: Array<"entries" | "bytes" | "scan" | "problems">;
	/** 单条无法读取/校验的条目（与整体失败区分，也不当成不存在）。 */
	problems: RecordProblem[];
	/**
	 * 因预算（`problems` / `bytes` / `entries`）而**未被检查**的候选条目数。
	 *
	 * 这些条目未经验证，所以不能假定它们没问题；`scan` 截断时该值是**下界**
	 * （目录还没看完，剩余候选数未知）。用途是避免"没返回的问题被说成没有问题"。
	 */
	droppedProblems: number;
	/**
	 * 被扫描到但未成为候选的条目数：符号链接、子目录、非 `.json` 文件、点开头文件。
	 *
	 * 跳过策略是**明确**的：这些条目不读取内容、不计入 `problems`
	 * （尤其不为了"列问题"去读符号链接指向的正文），但会在这里计数，
	 * 让"条目消失了"这件事可解释（BM-02AR / AR-3）。
	 */
	skippedEntries: number;
	/** 扫描到的候选条目数（在 `entries`/`bytes` 截断时是"已扫描数"）。 */
	scanned: number;
};

export type ListRecordsOptions = {
	root: string;
	kind: RecordKind;
	/** task-record 与 context-manifest 必填。 */
	projectId?: string;
	limits?: Partial<StorageLimits>;
	signal?: AbortSignal;
	/** 受控 IO 故障注入（仅测试；见 boundary.ts 的 StorageIoHooks）。 */
	ioHooks?: StorageIoHooks;
};

function truncateLabel(value: string): string {
	const singleLine = value.replace(/\s+/g, " ").trim();
	return singleLine.length <= SUMMARY_LABEL_MAX_CHARS ? singleLine : `${singleLine.slice(0, SUMMARY_LABEL_MAX_CHARS)}…`;
}

/**
 * 列表输出的字节计量（BM-02AR / S4）。
 *
 * 计的是**实际会返回给调用方的字段**：
 * - 条目：`id` + `label` + `path`（`revision` / `updatedAt` 是数字，不计入）；
 * - 问题：`path` + `code` + `message`。
 *
 * 旧实现只算了 `id + label`，且 problems 完全不计——于是"路径很长的条目"或
 * "大量坏条目"都能突破 `maxListBytes`，"有界列表"实际上没有界。
 */
function measureEntry(entry: RecordSummary): number {
	return Buffer.byteLength(entry.id) + Buffer.byteLength(entry.label) + Buffer.byteLength(entry.path);
}

function measureProblem(problem: RecordProblem): number {
	return Buffer.byteLength(problem.path) + Buffer.byteLength(problem.code) + Buffer.byteLength(problem.message);
}

/**
 * 每种 kind 的摘要器。
 *
 * 用映射类型声明（而不是 `switch` + `as unknown as`）：签名**只接受**该 kind 自己的记录类型，
 * 于是"给任务记录用了经验卡字段"是编译期错误，而不是运行期读到 `undefined`
 * 后悄悄把摘要变成空串（BM-02AR / S2 要求类型化 kind→record 映射，不再靠 `as never`）。
 */
const SUMMARIZERS: { [K in RecordKind]: (record: RecordByKind[K]) => string } = {
	"project-profile": (profile) => truncateLabel(profile.identity.boardName.value ?? profile.identity.ibv.value ?? profile.id),
	"task-record": (task) => truncateLabel(task.requirement),
	"feature-record": (feature) => truncateLabel(feature.originalRequirement),
	"experience-card": (card) => truncateLabel(card.problem),
	"context-manifest": (manifest) => truncateLabel(`${manifest.sources.length} 个上下文来源`),
};

function summarize<K extends RecordKind>(kind: K, record: RecordByKind[K]): string {
	return SUMMARIZERS[kind](record);
}

/**
 * 归属校验规则，每条以 kind 为键。
 *
 * 返回 `undefined` = 通过，字符串 = 拒绝原因。同样用映射类型保证
 * "每个规则只拿到自己 kind 的记录"，避免"声称检查了归属、实际只检查了 id"。
 */
const OWNERSHIP_CHECKS: { [K in RecordKind]: (record: RecordByKind[K], expectedProjectId: string | undefined) => string | undefined } = {
	"project-profile": (profile, expectedProjectId) =>
		// profile.json 的路径 ID 就是项目 ID，且上游已与请求 ID 比对过：此处无额外规则。
		expectedProjectId === undefined || profile.id === expectedProjectId ? undefined : `项目档案 ID（${profile.id}）与所在项目（${expectedProjectId}）不一致`,
	"task-record": (task, expectedProjectId) => (task.projectId === expectedProjectId ? undefined : `任务记录的 projectId（${task.projectId}）与所在项目（${expectedProjectId ?? "(未指定)"}）不一致`),
	"feature-record": () => undefined,
	"experience-card": () => undefined,
	"context-manifest": (manifest, expectedProjectId) => (manifest.targetProjectId === expectedProjectId ? undefined : `上下文清单的 targetProjectId（${manifest.targetProjectId}）与所在项目（${expectedProjectId ?? "(未指定)"}）不一致`),
};

/** 单条问题（列表用）。`code` 与 `StorageError.code` 同域，便于调用方统一分类。 */
export type RecordProblem = { path: string; code: StorageErrorCode; message: string };

export type InterpretedRecord<K extends RecordKind> = { ok: true; record: RecordByKind[K] } | { ok: false; problem: { code: StorageErrorCode; message: string } };

/**
 * 唯一的"结构校验 → 版本闸门 → ID 一致 → 归属一致"链（BM-02AR / S2）。
 *
 * 为什么必须共用一份：第四轮验收指出列表只比对了 `id`，跳过了单条读取对
 * `projectId` / `targetProjectId` 的归属校验——同一个文件"直接读会被拒、列出来却会被接受"。
 * 两处各写一遍必然再次漂移，所以单条与列表都只调用这里。
 */
export function interpretRecord<K extends RecordKind>(kind: K, raw: unknown, expected: { id: string; projectId?: string }): InterpretedRecord<K> {
	const outcome = validateRecord(RECORD_SCHEMAS[kind], raw);
	if (!outcome.ok) {
		// 版本问题与结构问题必须分开：前者"不要猜字段"，后者"结构写错了"。
		const versionIssue = outcome.issues.find((issue) => issue.code === "unsupported-schema-version");
		return { ok: false, problem: { code: versionIssue ? "unsupported-schema-version" : "invalid-record", message: describeIssues(outcome.issues, 3) } };
	}

	// 类型收窄说明：`RECORD_SCHEMAS` 与 `RecordByKind` 是同一份映射的两种表达，
	// 上面已用对应 schema 校验通过；这是表驱动带来的类型损失，不是绕过校验。
	const record = outcome.value as RecordByKind[K];

	if (record.id !== expected.id) {
		return { ok: false, problem: { code: "record-id-mismatch", message: `记录内容 ID（${record.id}）与请求 ID（${expected.id}）不一致` } };
	}

	const ownershipMismatch = OWNERSHIP_CHECKS[kind](record, expected.projectId);
	if (ownershipMismatch !== undefined) {
		return { ok: false, problem: { code: "record-id-mismatch", message: ownershipMismatch } };
	}

	return { ok: true, record };
}

/** 列出候选条目（project-profile 需要先列出项目目录）。 */
async function listCandidates(boundary: StorageBoundary, options: ListRecordsOptions): Promise<{ directory: string; candidates: Array<{ id: string; projectId?: string }>; truncated: boolean; scanned: number }> {
	const layout = knowledgeLayout(boundary);
	const maxScanEntries = boundary.limits.maxScanEntries;

	if (options.kind === "project-profile") {
		const listing = await boundary.listEntries(layout.projectsDir, { filesOnly: false, maxEntries: maxScanEntries, signal: options.signal, includeSymlinks: true });
		const candidates = listing.names.filter((name) => !name.startsWith(".")).map((name) => ({ id: name }));
		return { directory: layout.projectsDir, candidates, truncated: listing.truncated, scanned: listing.scanned };
	}

	if (PROJECT_SCOPED_KINDS.has(options.kind)) {
		const projectId = requireProjectId(options.projectId, options.kind);
		const directory = options.kind === "task-record" ? boundary.resolve("projects", projectId, "tasks") : boundary.resolve("projects", projectId, "context");
		const listing = await boundary.listEntries(directory, { filesOnly: true, maxEntries: maxScanEntries, signal: options.signal, includeSymlinks: true });
		const candidates = listing.names.filter((name) => name.endsWith(".json") && !name.startsWith(".")).map((name) => ({ id: name.slice(0, -".json".length), projectId }));
		return { directory, candidates, truncated: listing.truncated, scanned: listing.scanned };
	}

	const directory = options.kind === "experience-card" ? layout.experiencesDir : layout.featuresDir;
	// 三处目录扫描都传 `includeSymlinks: true`：链接不静默消失，而是作为候选交给
	// `readJson` → `assertNoSymlinks` 明确拒绝（`symlink-rejected` 进入 problems），
	// 且**绝不读取链接目标正文**（BM-02AR / AR-3 的"跳过策略明确"）。
	const listing = await boundary.listEntries(directory, { filesOnly: true, maxEntries: maxScanEntries, signal: options.signal, includeSymlinks: true });
	const candidates = listing.names.filter((name) => name.endsWith(".json") && !name.startsWith(".")).map((name) => ({ id: name.slice(0, -".json".length) }));
	return { directory, candidates, truncated: listing.truncated, scanned: listing.scanned };
}

export async function listRecords(options: ListRecordsOptions): Promise<ListRecordsResult> {
	const boundary = await createStorageBoundary({ root: options.root, limits: options.limits, signal: options.signal, ioHooks: options.ioHooks });
	return listRecordsWithBoundary(boundary, options);
}

export async function listRecordsWithBoundary(boundary: StorageBoundary, options: ListRecordsOptions): Promise<ListRecordsResult> {
	const { directory, candidates, truncated: scanTruncated, scanned } = await listCandidates(boundary, options);
	const truncatedBy: ListRecordsResult["truncatedBy"] = [];
	if (scanTruncated) truncatedBy.push("scan");

	const entries: RecordSummary[] = [];
	const problems: RecordProblem[] = [];
	let usedBytes = 0;

	const addTruncation = (reason: ListRecordsResult["truncatedBy"][number]): void => {
		if (!truncatedBy.includes(reason)) truncatedBy.push(reason);
	};

	/**
	 * 记录一条单条问题，返回 `false` 表示**必须停止扫描**（BM-02AR / S4）。
	 *
	 * `problems` 与条目共用同一个字节预算：旧实现里 problems 不在任何预算内，
	 * 一个装满坏文件的目录可以让"有界列表"返回无限多的错误对象。
	 * 达到上限即停止并标记截断——继续扫描只会把同一批坏文件重复报告一遍。
	 */
	const addProblem = (problem: RecordProblem): boolean => {
		if (problems.length >= boundary.limits.maxListProblems) {
			addTruncation("problems");
			return false;
		}
		const problemBytes = measureProblem(problem);
		if (usedBytes + problemBytes > boundary.limits.maxListBytes) {
			addTruncation("bytes");
			return false;
		}
		usedBytes += problemBytes;
		problems.push(problem);
		return true;
	};

	// 被扫描到但未成为候选的条目：跳过策略明确、且数量可见（BM-02AR / AR-3）。
	const skippedEntries = Math.max(0, scanned - candidates.length);
	let droppedProblems = 0;

	/**
	 * 整体取消必须**穿透**单条问题的 catch（BM-02AR / S3）。
	 *
	 * 取消（用户 abort）发生在 `readJson`/`resolve` 内部时，若被下面的 catch 收成一条
	 * `problems` 条目，调用方会看到一个"成功但少了几条"的列表——这正是第四轮 S3 指出的
	 * "列表 catch 把 cancelled 收为单条问题"。这里显式重抛，让整体失败语义不被稀释。
	 */
	const rethrowIfCancelled = (error: unknown): void => {
		if (error instanceof StorageError && error.code === "cancelled") throw error;
	};

	for (let index = 0; index < candidates.length; index += 1) {
		const candidate = candidates[index];
		// 循环条件已保证 index 在范围内；这里只为类型收窄。
		if (candidate === undefined) break;

		// 每个候选都是一次 IO 等待点：取消是**整体失败**，不是"少列几条"。
		throwIfAnyCancelled([options.signal, boundary.signal]);
		if (entries.length >= boundary.limits.maxListEntries) {
			addTruncation("entries");
			droppedProblems = candidates.length - index;
			break;
		}

		// 路径派生本身也可能失败（非法 ID、越界）：它是**单条问题**，
		// 不能让整个列表调用失败，也不能静默跳过（BM-02AR / S4）。
		let absolute: string;
		try {
			absolute = boundary.resolve(...recordRelativeSegments(options.kind, candidate.id, candidate.projectId));
		} catch (error) {
			rethrowIfCancelled(error);
			const stop = addProblem({
				path: `${directory}${sep}${candidate.id}`,
				code: error instanceof StorageError ? error.code : "invalid-record",
				message: error instanceof Error ? error.message : String(error),
			});
			if (!stop) {
				droppedProblems = candidates.length - index;
				break;
			}
			continue;
		}

		let read;
		try {
			read = await boundary.readJson(absolute, boundary.limits.maxRecordBytes, options.signal);
		} catch (error) {
			rethrowIfCancelled(error);
			const stop = addProblem({
				path: absolute,
				code: error instanceof StorageError ? error.code : "invalid-record",
				message: error instanceof Error ? error.message : String(error),
			});
			if (!stop) {
				droppedProblems = candidates.length - index;
				break;
			}
			continue;
		}

		// 与单条读取共用同一条校验链：结构 → 版本 → ID 一致 → **归属一致**（BM-02AR / S2）。
		const interpreted = interpretRecord(options.kind, read.value, { id: candidate.id, projectId: candidate.projectId });
		if (!interpreted.ok) {
			const stop = addProblem({ path: absolute, code: interpreted.problem.code, message: interpreted.problem.message });
			if (!stop) {
				droppedProblems = candidates.length - index;
				break;
			}
			continue;
		}

		const label = summarize(options.kind, interpreted.record);
		const entry: RecordSummary = { id: candidate.id, revision: interpreted.record.revision, updatedAt: interpreted.record.updatedAt, label, path: absolute };
		const entryBytes = measureEntry(entry);
		if (usedBytes + entryBytes > boundary.limits.maxListBytes) {
			addTruncation("bytes");
			droppedProblems = candidates.length - index;
			break;
		}
		usedBytes += entryBytes;
		entries.push(entry);
	}

	return { kind: options.kind, directory, entries, truncated: truncatedBy.length > 0, truncatedBy, problems, droppedProblems, skippedEntries, scanned };
}
