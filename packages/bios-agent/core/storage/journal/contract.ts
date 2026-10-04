/**
 * journal 的**纯契约**：类型、受控路径派生与不可信输入校验（BM-02C1）。
 *
 * 设计要点（对应 bm02c1_development_plan.md §2）：
 *
 * 1. journal 记录的是**写入意图**，不是数据副本：只有 operationId、受控目标描述、
 *    提交前后的 revision + 真实字节 SHA-256。因此它**不能**用来重建丢失的内容，
 *    也不能被当成业务审核审计。
 * 2. 目标只能由受控函数派生（`recordRelativeSegments` 或常量 `registry.json`）：
 *    journal 里**没有**绝对路径、临时文件名或锁路径，恢复侧因此无法被诱导去写任意位置。
 * 3. 本模块是纯函数，不做 IO：读取、写入与恢复分别在同目录的 `writer.ts` / `inspect.ts` /
 *    `reconcile.ts`，避免"校验规则"和"磁盘副作用"混在一个函数里。
 */
import { isValidKnowledgeId } from "../../contracts/ids.ts";
import { RECORD_SCHEMAS, type RecordKind } from "../../contracts/records.ts";
import { StorageError } from "../errors.ts";
import { MAX_DATE_MS } from "../lock.ts";
import { recordRelativeSegments } from "../records.ts";

/** journal 自己的版本号：与记录 schemaVersion 解耦（记录仍是 1）。 */
export const JOURNAL_SCHEMA_VERSION = 1;
/** journal 目录名（知识根内，惰性创建）。 */
export const JOURNAL_DIR_NAME = "journal";
/** journal 文件后缀。 */
export const JOURNAL_FILE_SUFFIX = ".json";
/** SHA-256 十六进制文本长度。 */
export const JOURNAL_HASH_LENGTH = 64;

const JOURNAL_HASH_PATTERN = /^[0-9a-f]{64}$/;
const JOURNAL_OPERATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type JournalOperation = "create" | "update";
export type JournalState = "prepared" | "committed" | "aborted" | "conflict";
/** 终态来源：写入方自己确认，还是恢复时观察到的。**不能互相冒充**。 */
export type JournalSource = "writer-confirmed" | "recovery-observed";

/**
 * 一次写入的记账结果（放在契约里而不是结果类型旁边，避免"结果类型 → 写入模块 → journal"的循环）。
 *
 * - `committed`：数据提交成功**且** journal 终态已落盘（写入方确认）；
 * - `needs-recovery`：数据提交成功，但 journal 终态没写成（IO 失败 / 迟到取消）。
 *   这**不是**失败：调用方拿到的是真实的 `created`/`updated`，只是需要后续
 *   `reconcileJournalOperation` 核对后收口，**不能**因此重复提交同一 revision。
 */
export type WriteJournalOutcome = {
	readonly operationId: string;
	readonly state: "committed" | "needs-recovery";
	/** 相对知识根的 journal 路径（`journal/<operationId>.json`）。 */
	readonly relativePath: string;
};

/**
 * 受控目标描述。
 *
 * 为什么不存路径：路径可以被"写 journal 的人"指定，而 journal 是**不可信输入**。
 * 只存 kind/id 之后，恢复侧走的是与写入侧同一套 `recordRelativeSegments` 派生规则。
 */
export type JournalTarget = { readonly kind: "registry" } | { readonly kind: RecordKind; readonly id: string; readonly projectId?: string };

/** 某一版内容的指纹：`{null, null}` 表示"不存在"。 */
export type JournalFingerprint = { readonly revision: number | null; readonly hash: string | null };

export type JournalRecord = {
	readonly journalVersion: number;
	readonly operationId: string;
	readonly operation: JournalOperation;
	readonly state: JournalState;
	readonly target: JournalTarget;
	readonly before: JournalFingerprint;
	readonly after: JournalFingerprint;
	readonly preparedAt: number;
	/** 终态必填；`prepared` 必须缺席（半截/伪造记录一律拒绝）。 */
	readonly finishedAt?: number;
	/** 终态必填；见 {@link JournalSource}。 */
	readonly source?: JournalSource;
};

/** "不存在"的规范指纹（create 的 before 就是它）。 */
export const ABSENT_JOURNAL_FINGERPRINT: JournalFingerprint = { revision: null, hash: null };

export type JournalIssueCode =
	/** 结构与契约不符（字段类型/枚举/前后关系/时间等）。 */
	| "invalid-journal"
	/** journalVersion 不是本实现支持的版本：不猜格式。 */
	| "unsupported-journal-version"
	/** operationId 与文件名不一致（或文件名根本不是 UUID）。 */
	| "journal-name-mismatch";

export type JournalIssue = { readonly code: JournalIssueCode; readonly path: string; readonly message: string };

export type JournalValidation = { ok: true; value: JournalRecord } | { ok: false; issues: JournalIssue[] };

const JOURNAL_STATES: ReadonlySet<string> = new Set<JournalState>(["prepared", "committed", "aborted", "conflict"]);
const JOURNAL_SOURCES: ReadonlySet<string> = new Set<JournalSource>(["writer-confirmed", "recovery-observed"]);
/** 允许出现在 journal 里的键；未知键一律报告（不猜格式）。 */
const JOURNAL_KNOWN_KEYS: ReadonlySet<string> = new Set(["journalVersion", "operationId", "operation", "state", "target", "before", "after", "preparedAt", "finishedAt", "source"]);

/** operationId 形态：小写 UUID（与 `crypto.randomUUID()` 的输出一致）。 */
export function isJournalOperationId(value: unknown): value is string {
	return typeof value === "string" && JOURNAL_OPERATION_ID_PATTERN.test(value);
}

export function journalFileName(operationId: string): string {
	return `${operationId}${JOURNAL_FILE_SUFFIX}`;
}

/** 根内相对片段（受控派生：调用方给不出文件名）。 */
export function journalRelativeSegments(operationId: string): string[] {
	return [JOURNAL_DIR_NAME, journalFileName(operationId)];
}

export function journalRelativePath(operationId: string): string {
	return journalRelativeSegments(operationId).join("/");
}

/** 是否为"值得尝试解析"的 journal 文件（`.tmp` 残留与非 `.json` 一律跳过、不删除）。 */
export function isJournalCandidateFile(name: string): boolean {
	return name.endsWith(JOURNAL_FILE_SUFFIX) && name.length > JOURNAL_FILE_SUFFIX.length;
}

/** 文件名 → operationId（不校验 UUID；由 `validateJournalRecord` 给出结论）。 */
export function journalFileNameToOperationId(name: string): string {
	return name.slice(0, name.length - JOURNAL_FILE_SUFFIX.length);
}

export function isTerminalJournalState(state: JournalState): boolean {
	return state !== "prepared";
}

/**
 * 目标 → 根内相对片段。**这是恢复侧唯一的路径来源**。
 *
 * 失败一律抛 `invalid-record`（而不是回退到某个默认路径）：一个说不清目标的 journal
 * 绝不能变成"往某处写一下试试"。
 */
export function journalTargetSegments(target: JournalTarget): string[] {
	if (target.kind === "registry") return ["registry.json"];
	return recordRelativeSegments(target.kind, target.id, target.projectId);
}

/**
 * 目标的**受控身份**：由 `journalTargetSegments` 派生，因此"两个 target 的 key 相同"
 * 与"它们指向同一把协作锁和同一个文件"是同一件事（BM-02C1R / J1）。
 *
 * 为什么不能只比 `id`：`task-record` 的项目归属在路径里，`{id: X, projectId: A}` 与
 * `{id: X, projectId: B}` 是两个不同的目标，锁也是两把。
 */
export function journalTargetKey(target: JournalTarget): string {
	return journalTargetSegments(target).join("/");
}

/** 受控的人类可读目标标识（用于诊断文案；不含任何正文）。 */
export function describeJournalTarget(target: JournalTarget): string {
	if (target.kind === "registry") return "registry";
	return target.projectId === undefined ? `${target.kind}/${target.id}` : `${target.kind}/${target.projectId}/${target.id}`;
}

export function fingerprintsEqual(left: JournalFingerprint, right: JournalFingerprint): boolean {
	return left.revision === right.revision && left.hash === right.hash;
}

export function describeJournalFingerprint(fingerprint: JournalFingerprint): string {
	return fingerprint.revision === null ? "不存在" : `revision=${fingerprint.revision}`;
}

type IssueSink = (path: string, message: string, code?: JournalIssueCode) => void;

function isBoundedInstant(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_DATE_MS;
}

/** 校验一个 fingerprint；不合法时报告并把该位置标记为"不可用"。 */
function readFingerprint(value: unknown, path: string, add: IssueSink): JournalFingerprint | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		add(path, "fingerprint 必须是对象（{ revision, hash }）");
		return undefined;
	}
	const raw = value as Record<string, unknown>;
	const revision = raw.revision;
	const hash = raw.hash;

	if (revision !== null && !(typeof revision === "number" && Number.isSafeInteger(revision) && revision >= 0)) {
		add(`${path}/revision`, "revision 必须是 null 或非负安全整数");
		return undefined;
	}
	if (hash !== null && !(typeof hash === "string" && JOURNAL_HASH_PATTERN.test(hash))) {
		add(`${path}/hash`, "hash 必须是 null 或 64 位小写十六进制 SHA-256");
		return undefined;
	}
	// "不存在"必须整体表达：只写一半会让恢复侧把"未知"当成"不存在"或反之。
	if ((revision === null) !== (hash === null)) {
		add(path, "revision 与 hash 必须同时为 null（不存在）或同时非 null");
		return undefined;
	}
	return { revision: revision as number | null, hash: hash as string | null };
}

function readTarget(value: unknown, add: IssueSink): JournalTarget | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		add("/target", "target 必须是对象");
		return undefined;
	}
	const raw = value as Record<string, unknown>;
	const kind = raw.kind;
	if (kind === "registry") {
		if (raw.id !== undefined || raw.projectId !== undefined) add("/target", "registry 目标不接受 id/projectId");
		return { kind: "registry" };
	}
	if (typeof kind !== "string" || !Object.prototype.hasOwnProperty.call(RECORD_SCHEMAS, kind)) {
		add("/target/kind", `target.kind 必须是 registry 或已知记录类型，收到：${typeof kind === "string" ? kind : typeof kind}`);
		return undefined;
	}
	const recordKind = kind as RecordKind;
	if (typeof raw.id !== "string" || !isValidKnowledgeId(raw.id)) {
		add("/target/id", "target.id 不符合知识记录 ID 规则");
		return undefined;
	}
	const projectScoped = recordKind === "task-record" || recordKind === "context-manifest";
	if (projectScoped) {
		if (typeof raw.projectId !== "string" || !isValidKnowledgeId(raw.projectId, "project")) {
			add("/target/projectId", `${recordKind} 必须带规范的小写 UUID projectId`);
			return undefined;
		}
		return { kind: recordKind, id: raw.id, projectId: raw.projectId };
	}
	if (raw.projectId !== undefined) {
		add("/target/projectId", `${recordKind} 不接受 projectId（它没有项目目录归属）`);
		return undefined;
	}
	return { kind: recordKind, id: raw.id };
}

/**
 * 校验 journal 记录（**不可信输入**：可能来自旧版本、被手工改过、或上次崩溃写了一半）。
 *
 * 任一项不满足都返回 issues，由调用方**保留原文件并报告**——绝不猜测格式、绝不当空文件覆盖。
 * 这里的每条规则都对应一个真实后果：ID 与文件名不符会让"恢复哪个操作"产生歧义；
 * 前后 revision 关系不成立会让"目标到底是新值还是旧值"无从判断。
 */
export function validateJournalRecord(value: unknown, fileName: string): JournalValidation {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return { ok: false, issues: [{ code: "invalid-journal", path: "", message: "journal 必须是 JSON 对象" }] };
	}
	const raw = value as Record<string, unknown>;
	const issues: JournalIssue[] = [];
	const add: IssueSink = (path, message, code = "invalid-journal") => {
		// 上限只用于防"坏文件刷屏"：一条 journal 至多 8 条问题够定位了。
		if (issues.length < 8) issues.push({ code, path, message });
	};

	for (const key of Object.keys(raw)) {
		if (!JOURNAL_KNOWN_KEYS.has(key)) add(`/${key}`, "包含未知字段，拒绝按当前版本解释");
	}

	const version = raw.journalVersion;
	if (version !== JOURNAL_SCHEMA_VERSION) {
		if (typeof version === "number" && Number.isInteger(version)) {
			add("/journalVersion", `journalVersion=${version} 不是本实现支持的 ${JOURNAL_SCHEMA_VERSION}，拒绝解释`, "unsupported-journal-version");
		} else {
			add("/journalVersion", `journalVersion 必须是整数 ${JOURNAL_SCHEMA_VERSION}`);
		}
	}

	let operationId: string | undefined;
	if (!isJournalOperationId(raw.operationId)) {
		add("/operationId", "operationId 必须是规范的小写 UUID");
	} else {
		operationId = raw.operationId;
		if (fileName !== journalFileName(operationId)) {
			add("/operationId", `operationId 与文件名不一致（文件名 ${fileName}）`, "journal-name-mismatch");
		}
	}

	const operation = raw.operation;
	if (operation !== "create" && operation !== "update") add("/operation", "operation 必须是 create 或 update");

	const state = raw.state;
	const stateValid = typeof state === "string" && JOURNAL_STATES.has(state);
	if (!stateValid) add("/state", "state 必须是 prepared / committed / aborted / conflict");

	const target = readTarget(raw.target, add);
	const before = readFingerprint(raw.before, "/before", add);
	const after = readFingerprint(raw.after, "/after", add);

	const preparedAt = raw.preparedAt;
	if (!isBoundedInstant(preparedAt)) add("/preparedAt", "preparedAt 必须是 Date 可表示范围内的非负安全整数");

	if (before !== undefined && after !== undefined && (operation === "create" || operation === "update")) {
		// 前后关系是**语义**约束：重建"目标应当是什么"完全依赖它，不能只当成两个独立字段。
		if (operation === "create") {
			if (!fingerprintsEqual(before, ABSENT_JOURNAL_FINGERPRINT)) add("/before", "create 的 before 必须表示“不存在”（revision/hash 皆为 null）");
			if (after.revision !== 0) add("/after/revision", "create 的 after.revision 必须为 0");
		} else {
			if (before.revision === null) add("/before/revision", "update 的 before 必须指向已存在的一版");
			else if (after.revision !== before.revision + 1) add("/after/revision", `update 的 after.revision 必须等于 before.revision + 1（收到 ${String(after.revision)}）`);
		}
	}

	if (stateValid && isTerminalJournalState(state as JournalState)) {
		const finishedAt = raw.finishedAt;
		if (!isBoundedInstant(finishedAt)) {
			add("/finishedAt", "终态必须带 Date 可表示范围内的 finishedAt");
		} else if (typeof preparedAt === "number" && finishedAt < preparedAt) {
			add("/finishedAt", "finishedAt 不得早于 preparedAt");
		}
		const source = raw.source;
		if (typeof source !== "string" || !JOURNAL_SOURCES.has(source)) {
			add("/source", "终态必须带 source（writer-confirmed / recovery-observed）");
		} else if (state === "conflict" && source !== "recovery-observed") {
			// 写入方从不写 conflict：允许它出现等于给"伪造一个冲突"开口子。
			add("/source", "conflict 只能由恢复观察产生（recovery-observed）");
		}
	} else if (raw.finishedAt !== undefined || raw.source !== undefined) {
		add("/finishedAt", "prepared 不得带 finishedAt/source（半截或伪造记录）");
	}

	if (issues.length > 0) return { ok: false, issues };
	if (operationId === undefined || target === undefined || before === undefined || after === undefined) {
		// 理论上不可达（issues 为空意味着各字段都通过了），保留兜底以免类型收窄说谎。
		return { ok: false, issues: [{ code: "invalid-journal", path: "", message: "journal 字段无法收窄" }] };
	}

	return {
		ok: true,
		value: {
			journalVersion: JOURNAL_SCHEMA_VERSION,
			operationId,
			operation: operation as JournalOperation,
			state: state as JournalState,
			target,
			before,
			after,
			preparedAt: preparedAt as number,
			...(raw.finishedAt === undefined ? {} : { finishedAt: raw.finishedAt as number }),
			...(raw.source === undefined ? {} : { source: raw.source as JournalSource }),
		},
	};
}

/** 构造 prepared 记录（写入侧的唯一生成点，字段顺序稳定便于人工查看）。 */
export function buildPreparedJournalRecord(input: { operationId: string; operation: JournalOperation; target: JournalTarget; before: JournalFingerprint; after: JournalFingerprint; preparedAt: number }): JournalRecord {
	return {
		journalVersion: JOURNAL_SCHEMA_VERSION,
		operationId: input.operationId,
		operation: input.operation,
		state: "prepared",
		target: input.target,
		before: input.before,
		after: input.after,
		preparedAt: input.preparedAt,
	};
}

/** 构造终态记录（保留 prepared 的意图字段，只补终态三要素）。 */
export function buildFinalJournalRecord(input: {
	prepared: JournalRecord;
	state: Exclude<JournalState, "prepared">;
	source: JournalSource;
	finishedAt: number;
	/** `committed` 时用实际提交返回的 fingerprint（真相优先于预测）。 */
	after?: JournalFingerprint;
}): JournalRecord {
	return {
		...input.prepared,
		state: input.state,
		source: input.source,
		finishedAt: input.finishedAt,
		...(input.after === undefined ? {} : { after: input.after }),
	};
}

/** 自检：写入前确认自己没造出违反契约的记录（否则恢复侧只会看到"invalid-journal"）。 */
export function assertJournalRecordValid(record: JournalRecord, fileName: string): void {
	const outcome = validateJournalRecord(record, fileName);
	if (outcome.ok) return;
	const first = outcome.issues[0];
	throw new StorageError("invalid-record", `journal 记录自检失败：${first?.path || "/"} ${first?.message ?? ""}`, { detail: first?.code ?? "invalid-journal" });
}
