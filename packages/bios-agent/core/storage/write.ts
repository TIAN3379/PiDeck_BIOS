/**
 * 存储写入入口（BM-02B / B1）。
 *
 * 三个公开入口，**共用同一条管线**：
 *
 * ```
 * 取锁 → 重新读取当前字节 → 乐观 revision 校验 → 组装完整值
 *      → 写同目录临时文件 + sync + close → 原子替换 → 释放锁
 * ```
 *
 * 为什么"重新读取"不可省：锁只保证互斥，不保证"我进入之前读到的值是当前值"。
 * 旧值可能在**取锁之前**就被别的进程改过（这是最容易被漏掉的窗口），
 * 因此 revision 校验必须发生在**持锁之后**的读取结果上。
 *
 * 为什么没有"强制覆盖"：`expectedRevision` 是必填项，没有"跳过校验"的分支。
 * 一旦提供这种分支，调用方迟早会为了"先跑通"而用它，乐观并发控制就形同虚设。
 *
 * 明确不做的事（避免夸大）：
 * - 不做"相同内容重复写入即幂等"的特判：第二次提交必然 revision 冲突，
 *   想避免冲突的调用方应先读再决定，而不是让写入层替它猜。
 * - 不做跨文件事务：一次调用只提交**一个**文件；registry 与 profile 的一致性
 *   由调用顺序与 `expectedRevision` 共同保证，不存在"两个文件一起成功/回滚"。
 * - 不宣称崩溃一致性：`rename` 保证读者不会看到半成品，
 *   但"掉电后目录项与数据块谁先落盘"依赖文件系统，未经验证。
 */
import { dirname } from "node:path";
import type { RecordBase } from "../contracts/common.ts";
import { type Registry, type RegistryProjectEntry, validateRegistry } from "../contracts/registry.ts";
import { RECORD_SCHEMAS, type RecordKind } from "../contracts/records.ts";
import { describeIssues, validateRecord } from "../contracts/validate.ts";
import { createStorageBoundary, type StorageBoundary, type StorageIoHooks } from "./boundary.ts";
import { assertPayloadWithinLimits, attachCleanupNote, CLEANUP_FAILED_NOTE, payloadFingerprint, serializeJsonPayload } from "./commit.ts";
import { isStorageErrorCode, StorageError, throwIfAnyCancelled } from "./errors.ts";
import { ABSENT_JOURNAL_FINGERPRINT, commitUnderJournal, lockReleaseNote, prepareJournalEntry, releaseOwnLock, type JournalFingerprint, type JournalTarget, type WriteJournalOutcome } from "./journal/index.ts";
import { DEFAULT_LOCK_POLL_MS, DEFAULT_LOCK_TIMEOUT_MS, acquireStorageLock, resolveLockTiming, type LockDiagnostics, type LockReleaseOutcome } from "./lock.ts";
import type { StorageLimits } from "./limits.ts";
import { type InterpretedRecord, type RecordByKind, interpretRecord, recordRelativeSegments } from "./records.ts";
import { inspectBindingIssues, knowledgeLayout, readRegistryWithBoundary, readRegistryWithFingerprint } from "./registry.ts";
import { type ExpectedRevision, assertExpectedRevisionShape, assertSafeRevision, describeValue, nextRecordHeader } from "./revision.ts";

export type { ExpectedRevision };

/** 三个写入入口共用的选项。 */
export type StorageWriteOptions = {
	root: string;
	limits?: Partial<StorageLimits>;
	signal?: AbortSignal;
	/** 受控 IO 故障注入（仅测试；见 boundary.ts 的 StorageIoHooks）。 */
	ioHooks?: StorageIoHooks;
	/** 可注入时钟（测试用），默认 `Date.now()`。 */
	now?: number;
	/** 锁等待上限（毫秒），默认 {@link DEFAULT_LOCK_TIMEOUT_MS}。 */
	lockTimeoutMs?: number;
	/** 锁轮询间隔（毫秒），默认 {@link DEFAULT_LOCK_POLL_MS}。 */
	lockPollMs?: number;
};

/**
 * 归属字段：由存储层从 `projectId` 参数生成，业务数据**不得**自带。
 *
 * 让调用方同时提供"参数里的 projectId"与"正文里的 projectId"是一种已知的错误来源：
 * 两者不一致时，路径指向 A、正文声称 B，最终要么静默写进 A（正文说谎），
 * 要么到读取时才发现 `record-id-mismatch`（写入时本可拦住）。
 */
type OwnershipFieldOf<K extends RecordKind> = K extends "task-record" ? "projectId" : K extends "context-manifest" ? "targetProjectId" : never;

/** 由存储层管理的字段：公共头 + `id` + 归属字段。 */
type ManagedRecordKeys<K extends RecordKind> = keyof RecordBase | "id" | OwnershipFieldOf<K>;

/**
 * 业务数据：**排除**公共头、`id` 与归属字段。
 *
 * 排除是双向的——类型层拒绝编译，运行期再把漏网的键当 `invalid-record` 拒绝，
 * 而不是静默丢掉（静默丢弃会让调用方以为"我写的 projectId 生效了"）。
 */
export type RecordWriteBody<K extends RecordKind> = Omit<RecordByKind[K], ManagedRecordKeys<K>>;

const MANAGED_KEYS: { [K in RecordKind]: readonly string[] } = {
	"project-profile": ["schemaVersion", "revision", "createdAt", "updatedAt", "id"],
	"task-record": ["schemaVersion", "revision", "createdAt", "updatedAt", "id", "projectId"],
	"feature-record": ["schemaVersion", "revision", "createdAt", "updatedAt", "id"],
	"experience-card": ["schemaVersion", "revision", "createdAt", "updatedAt", "id"],
	"context-manifest": ["schemaVersion", "revision", "createdAt", "updatedAt", "id", "targetProjectId"],
};

const OWNERSHIP_FIELD: { [K in RecordKind]: "projectId" | "targetProjectId" | undefined } = {
	"project-profile": undefined,
	"task-record": "projectId",
	"feature-record": undefined,
	"experience-card": undefined,
	"context-manifest": "targetProjectId",
};

// 锁释放结果与 journal 记账结果的定义分别在 `lock.ts` 与 `journal/contract.ts`：
// 结果类型引用它们即可，不在本文件重复定义（同一份规则写两处迟早漂移）。

export type WriteRecordResult<K extends RecordKind> = {
	status: "created" | "updated";
	kind: K;
	id: string;
	/** 本次提交后**新内容**的 revision（create = 0，update = 旧值 + 1）。 */
	revision: number;
	record: RecordByKind[K];
	path: string;
	/** 相对知识根的受控路径（POSIX 分隔符，便于日志与错误信息）。 */
	relativePath: string;
	/** 实际写入的 UTF-8 字节数。 */
	bytes: number;
	/** 临时文件清理结果；`failed` 不影响已提交内容。 */
	cleanup: "ok" | "failed";
	/** `rename` 重试次数（> 1 说明遇到过 Windows 共享冲突）。 */
	renameAttempts: number;
	lockAttempts: number;
	lockRelease: LockReleaseOutcome;
	/** 本次写入的 journal 记账结果（BM-02C1）。 */
	journal: WriteJournalOutcome;
	/**
	 * 有界的"提交成功但有遗留"诊断（清理失败 / 锁未正常释放 / journal 终态未写入）。
	 *
	 * 它不是错误：提交确实成立了。但"锁目录没删掉"或".tmp 没删掉"是**需要人看**的信号，
	 * 吞掉它会让下一次写入以"莫名等待超时"的形式暴露同一个问题。
	 * 无遗留时该字段缺席（而不是空数组），方便调用方 `if (result.warnings)` 判空。
	 */
	warnings?: readonly string[];
};

export type UpdateRegistryResult = {
	status: "updated";
	revision: number;
	registry: Registry;
	path: string;
	relativePath: string;
	bytes: number;
	cleanup: "ok" | "failed";
	renameAttempts: number;
	lockAttempts: number;
	lockRelease: LockReleaseOutcome;
	/** 见 `WriteRecordResult.journal`。 */
	journal: WriteJournalOutcome;
	/** 见 `WriteRecordResult.warnings`。 */
	warnings?: readonly string[];
};

export type CreateRecordOptions<K extends RecordKind> = StorageWriteOptions & {
	kind: K;
	id: string;
	/** project-profile 可省略（等于 `id`）；task-record / context-manifest 必填。 */
	projectId?: string;
	data: RecordWriteBody<K>;
	/** 新建必须显式声明"要求目标不存在"。 */
	expectedRevision: null;
};

export type UpdateRecordOptions<K extends RecordKind> = StorageWriteOptions & {
	kind: K;
	id: string;
	projectId?: string;
	data: RecordWriteBody<K>;
	/** 更新必须给出读到的 revision。 */
	expectedRevision: number;
};

export type UpdateRegistryOptions = StorageWriteOptions & {
	expectedRevision: number;
	/** 新的项目绑定列表；**完整替换**，不做增量合并（增量合并无法表达"删掉一个绑定"）。 */
	projects: readonly RegistryProjectEntry[];
};

/* ------------------------------------------------------------------ 参数与语义守卫 */

/**
 * `kind` 的运行时守卫。
 *
 * TypeScript 只能约束**源码**里的调用；工具层/将来 CLI 的数据来自 JSON，
 * 编译期类型不成立。没有这道守卫时，非法 kind 会一路走到
 * `recordRelativeSegments` 的 `switch` 之外，以裸 `TypeError` 形式炸出来——
 * 调用方看到的是"某个 undefined 没有 join"，而不是"kind 不合法"。
 */
function assertRecordKind(kind: unknown): asserts kind is RecordKind {
	if (typeof kind !== "string" || !Object.prototype.hasOwnProperty.call(RECORD_SCHEMAS, kind)) {
		throw new StorageError("invalid-record", `不支持的记录类型：${describeValue(kind)}（允许：${Object.keys(RECORD_SCHEMAS).join("、")}）`, { detail: "unknown-record-kind" });
	}
}

function revisionConflict(label: string, relativePath: string, expected: ExpectedRevision, actual: number | null, hint: string): StorageError {
	const expectedText = expected === null ? "不存在" : `revision=${expected}`;
	const actualText = actual === null ? "不存在" : `revision=${actual}`;
	return new StorageError("revision-conflict", `${label} 并发冲突：期望 ${expectedText}，实际 ${actualText}（${relativePath}）。${hint}`, { path: relativePath, expected, actual });
}

/** 归属字段由参数决定：kind 不接受的组合明确报错，而不是静默忽略。 */
function resolveProjectIdForWrite(kind: RecordKind, id: string, projectId: string | undefined): string | undefined {
	const ownershipField = OWNERSHIP_FIELD[kind];

	if (kind === "project-profile") {
		// profile 的路径 ID 就是项目 ID：给了不同的值说明调用方混用了两种 ID。
		if (projectId !== undefined && projectId !== id) {
			throw new StorageError("record-id-mismatch", `project-profile 的 projectId（${projectId}）必须等于其 id（${id}），否则不是同一个项目`, { detail: "profile-project-mismatch" });
		}
		return undefined;
	}

	if (ownershipField === undefined) {
		// feature-record / experience-card 不受项目目录约束：给 projectId 只会让人以为它生效了。
		if (projectId !== undefined) {
			throw new StorageError("invalid-record", `${kind} 不接受 projectId（它没有项目目录归属）；如需记录来源项目请写业务字段（如 sourceProjectId）`, { detail: "unexpected-project-id" });
		}
		return undefined;
	}

	if (projectId === undefined || projectId.length === 0) {
		throw new StorageError("invalid-record", `${kind} 必须提供 projectId 才能确定写入位置`, { detail: "missing-project-id" });
	}
	return projectId;
}

/**
 * 正文**形态**检查（不依赖任何已读到的状态，因此放在取锁之前）。
 *
 * 为什么提前：这类错误只由调用方入参决定。放到锁内检查意味着"参数写错了也要先排队等锁"，
 * 并且会白白产生一次锁目录/业务目录的副作用。需要"已读到的当前值"的检查
 * （完整记录 schema、revision 上限）相反——它们必须留在锁内，见 `assembleRecord`。
 */
function assertRecordBodyShape(kind: RecordKind, body: unknown): Record<string, unknown> {
	if (typeof body !== "object" || body === null || Array.isArray(body)) {
		throw new StorageError("invalid-record", `${kind} 的 data 必须是普通对象（收到 ${Array.isArray(body) ? "数组" : typeof body}）`, { detail: "invalid-body" });
	}
	const source = body as Record<string, unknown>;
	const offending = MANAGED_KEYS[kind].filter((key) => Object.prototype.hasOwnProperty.call(source, key));
	if (offending.length > 0) {
		throw new StorageError("invalid-record", `${kind} 的 data 不能包含由存储层管理的字段：${offending.join("、")}（这些字段由存储层生成，不接受调用方覆盖）`, { conflicts: offending, detail: "managed-key-in-body" });
	}
	return source;
}

/**
 * 组装完整记录并跑与读取**完全相同**的 schema 校验。
 *
 * 为什么写前还要校验一次：写完才发现读不出来（缺必填、枚举越界）会让调用方
 * 拿到一个"写成功但读失败"的文件。这里的校验与 `readRecord` 共用 `RECORD_SCHEMAS`。
 * 它依赖 `header`（由锁内读到的当前值推出），所以必须留在锁内执行。
 */
function assembleRecord<K extends RecordKind>(kind: K, id: string, projectId: string | undefined, source: Record<string, unknown>, header: RecordBase): RecordByKind[K] {
	const ownershipField = OWNERSHIP_FIELD[kind];
	const assembled: Record<string, unknown> = { ...header, id, ...source };
	if (ownershipField !== undefined && projectId !== undefined) assembled[ownershipField] = projectId;

	const outcome = validateRecord(RECORD_SCHEMAS[kind], assembled);
	if (!outcome.ok) {
		const versionIssue = outcome.issues.find((issue) => issue.code === "unsupported-schema-version");
		throw new StorageError(versionIssue ? "unsupported-schema-version" : "invalid-record", `${kind} 写入被拒绝（结构校验）：${describeIssues(outcome.issues, 3)}`, { detail: "invalid-record-body" });
	}

	// 类型收窄说明：`RECORD_SCHEMAS` 与 `RecordByKind` 是同一份映射的两种表达，
	// 上面已用对应 schema 校验通过；这是表驱动带来的类型损失，不是绕过校验。
	return outcome.value as RecordByKind[K];
}

/**
 * 写入必须发生在**有效**的知识库里，否则会造出一个"没有 registry / registry 已经废了"的目录树。
 *
 * 为什么不能只查 `registry.json` 是否存在（本轮 W4 的入口）：
 * 存在一个被截断的 JSON、一个被人手改成未来版本的文件、或一个内部绑定自相矛盾的 registry，
 * 都会让后续写入在"库其实已经不可读"的前提下继续累积数据——等到读取时才爆，
 * 而那时已经分不清哪些记录是坏库之后写的。
 *
 * 因此这里复用读路径的**有界读取 + 版本闸门 + 结构校验 + 绑定一致性**：
 * 凡是读会被拒绝的库，写也拒绝；并且这个判定发生在任何锁、目录、记录产生**之前**。
 * 与 `updateRegistry` 的"读不到 registry 就报冲突"不同——那是刻意保留的独立语义
 * （registry 更新本身要能报告"目标不存在"），不走这里。
 */
async function assertStoreInitialized(boundary: StorageBoundary): Promise<void> {
	const layout = knowledgeLayout(boundary);
	try {
		await readRegistryWithBoundary(boundary);
	} catch (error) {
		if (isStorageErrorCode(error, "not-found")) {
			throw new StorageError("not-found", `知识库尚未初始化（缺少 registry.json），拒绝写入：${layout.registryPath}`, { path: layout.registryPath, detail: "store-not-initialized" });
		}
		// 坏 JSON / 未来版本 / 目录或链接 / 绑定冲突：原样抛出，带着它们各自的错误码，
		// 不做"降级成未初始化"的模糊化处理。
		throw error;
	}
}

/**
 * 持锁后读取当前记录；不存在返回 `undefined`（"不存在"是新建路径的正常输入，不是错误）。
 *
 * 额外返回 `fingerprint`：它是**实际读到字节**的 SHA-256，也是 journal 的 `before.hash`。
 * 不能用"解析后再 `stringify`"代替——旧文件可能带不同空白，那样算出的哈希与磁盘内容无关。
 */
async function readExistingRecord<K extends RecordKind>(boundary: StorageBoundary, kind: K, id: string, projectId: string | undefined, callSignal: AbortSignal | undefined): Promise<{ record: RecordByKind[K]; fingerprint: string } | undefined> {
	const absolute = boundary.resolve(...recordRelativeSegments(kind, id, projectId));
	let value: unknown;
	let fingerprint = "";
	try {
		({ value, fingerprint } = await boundary.readJson(absolute, boundary.limits.maxRecordBytes, callSignal));
	} catch (error) {
		if (isStorageErrorCode(error, "not-found")) return undefined;
		throw error;
	}

	const interpreted: InterpretedRecord<K> = interpretRecord(kind, value, { id, projectId });
	if (!interpreted.ok) {
		// 目标存在但无法解释：**不能**当成"不存在"去新建。
		// 那会把一次损坏谎报成"新建成功"，并覆盖掉需要人工介入的原文件。
		throw new StorageError(interpreted.problem.code, `${kind} 已存在但无法解释，拒绝覆盖：${interpreted.problem.message}`, { path: absolute });
	}
	return { record: interpreted.record, fingerprint };
}

/**
 * 取锁 → 执行 → 释放。
 *
 * 释放结果**如实上报**而不是吞掉：
 * - 成功路径：`not-owner` / `missing` 说明锁目录被人动过，需要人看，进 `warnings`；
 * - 失败路径：释放失败/异常清理状态**附加**为诊断，但绝不掩盖原始错误——
 *   否则调用方看到的失败原因会被替换成"锁释放失败"，真正的问题（比如 revision 冲突）就消失了。
 */
async function runUnderLock<T extends { cleanup: "ok" | "failed"; renameAttempts: number }>(boundary: StorageBoundary, absoluteTarget: string, options: StorageWriteOptions, now: number, commit: () => Promise<T>): Promise<T & { lockAttempts: number; lockRelease: LockReleaseOutcome; warnings?: readonly string[] }> {
	const lock = await acquireStorageLock(boundary, { target: absoluteTarget, timeoutMs: options.lockTimeoutMs, pollMs: options.lockPollMs, signal: options.signal, now });
	try {
		const outcome = await commit();
		const lockRelease = await releaseOwnLock(lock);
		// 提交已经成立，所以这里**不抛错**，但要把"有遗留"如实说出来：
		// 临时文件没删干净、锁目录没删掉，都会在下一步变成更难定位的故障。
		const warnings: string[] = [];
		if (outcome.cleanup === "failed") warnings.push(CLEANUP_FAILED_NOTE);
		if (lockRelease !== "released") warnings.push(lockReleaseNote(lockRelease));
		return { ...outcome, lockAttempts: lock.attempts, lockRelease, ...(warnings.length > 0 ? { warnings } : {}) };
	} catch (error) {
		// 失败路径同样释放自有锁：吞掉释放结果会留下一个只能靠"后续莫名超时"暴露的残留锁。
		// `attachCleanupNote` 逐一搬运 code/path/detail/expected/actual/cause，只追加一句固定文案。
		const lockRelease = await releaseOwnLock(lock);
		throw lockRelease === "released" ? error : attachCleanupNote(error, lockReleaseNote(lockRelease));
	}
}

/* ------------------------------------------------------------------ 意图日志（journal）接线 */

// 「prepared → 数据提交 → 终态记账」的接线在 `journal/wiring.ts`：它是另一套时序与错误语义，
// 与"入口 + 校验 + 持锁提交"分开，避免同一文件承担两种提交语义。

/** 锁的诊断信息（仅超时错误用；不暴露给成功路径，避免调用方依赖易变字段）。 */
export type { LockDiagnostics };

/* ------------------------------------------------------------------ 记录写入 */

async function commitRecord<K extends RecordKind>(options: CreateRecordOptions<K> | UpdateRecordOptions<K>, mode: "created" | "updated"): Promise<WriteRecordResult<K>> {
	// 参数校验全部发生在**取锁之前**：参数错误不该占用别人的锁，也不该产生一次无谓等待。
	assertRecordKind(options.kind);
	const label = `${options.kind}/${options.id}`;
	// 时序参数与入参正文形态都是"纯输入判定"，在这里一次做完；
	// 需要当前值才能判定的（revision、完整 schema）仍留在锁内。
	const timing = resolveLockTiming({ timeoutMs: options.lockTimeoutMs, pollMs: options.lockPollMs, now: options.now });
	const now = timing.now;
	const body = assertRecordBodyShape(options.kind, options.data);
	const expected = assertExpectedRevisionShape(options.expectedRevision, label, mode === "created");
	if (mode === "created" && expected !== null) {
		// `createRecord` 收数字会退化成"要求存在且相等"的语义，却仍报告 `status: "created"`——
		// 调用方会以为"我新建了一条"，实际可能覆盖了别人已有的记录。直接拒绝这种混用。
		throw new StorageError("revision-conflict", `${label} 的 createRecord 必须传 expectedRevision: null（数字只用于 updateRecord）`, { detail: "create-with-number-revision" });
	}
	const projectId = resolveProjectIdForWrite(options.kind, options.id, options.projectId);
	const segments = recordRelativeSegments(options.kind, options.id, projectId);
	const relativePath = segments.join("/");

	const boundary = await createStorageBoundary({ root: options.root, limits: options.limits, signal: options.signal, ioHooks: options.ioHooks });
	const absolute = boundary.resolve(...segments);

	await assertStoreInitialized(boundary);

	// journal 的"提交已成立但有遗留"警告由闭包带出，与清理/释放警告在返回前合并
	// （`runUnderLock` 的职责仍然只有"取锁 → 执行 → 释放"，不认识 journal）。
	let journalWarnings: readonly string[] = [];
	const result = await runUnderLock(boundary, absolute, options, now, async () => {
		// 持锁后**重新读取**：锁只保证互斥，不保证这里看到的还是"取锁前"那一版。
		const current = await readExistingRecord(boundary, options.kind, options.id, projectId, options.signal);
		// 读到的那一版先验"可否安全递增"：不可安全递增时**先于**冲突判定报错，
		// 否则 `expectedRevision: 0` 撞上 `revision: 2^53` 只会报一句"并发冲突"，
		// 掩盖了"这个文件本身已经坏了、继续递增也永远不会相等"的事实。
		if (current !== undefined) assertSafeRevision(current.record.revision, label, relativePath);

		if (expected === null) {
			if (current !== undefined) {
				throw revisionConflict(label, relativePath, null, current.record.revision, "新建要求目标不存在；如需更新请改用 updateRecord 并给出读到的 revision。");
			}
		} else {
			if (current === undefined) {
				throw revisionConflict(label, relativePath, expected, null, "更新要求目标存在；如需新建请改用 createRecord 并传 expectedRevision: null。");
			}
			if (current.record.revision !== expected) {
				throw revisionConflict(label, relativePath, expected, current.record.revision, "目标已被其他写入者改过，请重新读取后再提交。");
			}
		}

		const header = nextRecordHeader(current?.record, now, label, relativePath);
		const record = assembleRecord(options.kind, options.id, projectId, body, header);

		// 序列化一次拿两样东西：字节预算与 journal 的 after 哈希。
		// 预算判定放在**发布 prepared 之前**：超限属于"参数层面就不该发生"，
		// 不该在 journal 里留下一条注定 aborted 的记录。
		const payload = serializeJsonPayload(record);
		assertPayloadWithinLimits(absolute, payload, boundary.limits.maxRecordBytes, boundary.limits.maxJsonChars);
		const after: JournalFingerprint = { revision: header.revision, hash: payloadFingerprint(payload) };
		const before: JournalFingerprint = current === undefined ? ABSENT_JOURNAL_FINGERPRINT : { revision: current.record.revision, hash: current.fingerprint };
		const journalTarget: JournalTarget = projectId === undefined ? { kind: options.kind, id: options.id } : { kind: options.kind, id: options.id, projectId };

		// 项目子目录（如 `projects/<id>/tasks/`）按需创建。放在锁内做，
		// 免得两个写者同时创建同一个目录时出现"各自以为自己是第一个"的判定分叉。
		await boundary.ensureDirectory(dirname(absolute), options.signal);

		// 意图先落盘（prepared），再提交数据：崩溃后才有可核对的依据。
		const prepared = await prepareJournalEntry(boundary, { operation: mode === "created" ? "create" : "update", target: journalTarget, before, after, now, signal: options.signal });

		// 发布（create）与替换（update）都返回"实际写下去字节"的哈希；rename 重试次数由闭包带回。
		let renameAttempts = 0;
		const committed = await commitUnderJournal(boundary, prepared, { signal: options.signal, now }, async () => {
			if (mode === "created") {
				// **新建走非覆盖发布**（同目录临时文件 + sync + close + link），而不是原子替换。
				// 理由：`replaceJson` 的语义是"替换已存在的目标"，用它做 create 会把
				// "目标在取锁之后、提交之前被别人抢先建好"这件事**静默覆盖掉**——
				// 那正是乐观并发控制要防的情况（对方已经写成功，我们却把它抹掉还报 created）。
				const published = await boundary.publishJsonMeasured(absolute, record, { callSignal: options.signal, maxBytes: boundary.limits.maxRecordBytes });
				if (published.status === "exists") {
					// 只在提交窗口内才会出现：尝试读出对方的 revision 如实上报；
					// 读不出来（对方正写到一半 / 内容不是合法记录）就报 null，不猜测。
					const appeared = await readExistingRecord(boundary, options.kind, options.id, projectId, options.signal).catch(() => undefined);
					const conflict = revisionConflict(label, relativePath, null, appeared?.record.revision ?? null, "目标在本次提交期间已由其他写入者创建；请重新读取后再决定 create 还是 update。");
					// `exists` 是**正常返回**（不是抛错）的分支，最容易漏掉 `cleanup: "failed"` 这一路：
					// 临时文件残留的诊断必须附加到冲突上，否则它就成了一个没人知道的垃圾文件。
					throw published.cleanup === "ok" ? conflict : attachCleanupNote(conflict, CLEANUP_FAILED_NOTE);
				}
				return { bytes: published.bytes, cleanup: published.cleanup, fingerprint: published.fingerprint };
			}

			const write = await boundary.replaceJson(absolute, record, { maxBytes: boundary.limits.maxRecordBytes, callSignal: options.signal });
			renameAttempts = write.renameAttempts;
			return { bytes: write.bytes, cleanup: write.cleanup, fingerprint: write.fingerprint };
		});

		journalWarnings = committed.journalWarnings ?? [];
		return {
			status: mode,
			kind: options.kind,
			id: options.id,
			revision: header.revision,
			record,
			path: absolute,
			relativePath,
			bytes: committed.bytes,
			cleanup: committed.cleanup,
			renameAttempts,
			journal: committed.journal,
		};
	});

	return journalWarnings.length === 0 ? result : { ...result, warnings: [...(result.warnings ?? []), ...journalWarnings] };
}

/** 新建一条记录：要求目标**不存在**（`expectedRevision: null`）。 */
export async function createRecord<K extends RecordKind>(options: CreateRecordOptions<K>): Promise<WriteRecordResult<K>> {
	return commitRecord(options, "created");
}

/** 更新一条已存在记录：ID 与项目归属不变，`revision` 递增。 */
export async function updateRecord<K extends RecordKind>(options: UpdateRecordOptions<K>): Promise<WriteRecordResult<K>> {
	return commitRecord(options, "updated");
}

/* ------------------------------------------------------------------ registry 写入 */

/**
 * 更新 registry 的项目绑定。
 *
 * 与记录写入的两点不同：
 * - 空 registry（`projects: []`）是**合法**状态，因此这里没有"必须有内容"的检查；
 * - 写入前复用**初始化**那份 `validateRegistry` + `inspectBindingIssues`，
 *   所以"重复 biosProjectId / 重复工作区 / 一个路径归属两个项目"在落盘前就被拒绝，
 *   而不是等下一次读取时才发现库已经自相矛盾。
 */
export async function updateRegistry(options: UpdateRegistryOptions): Promise<UpdateRegistryResult> {
	// 同 commitRecord：时序参数是纯输入判定，先于任何 IO 完成。
	const timing = resolveLockTiming({ timeoutMs: options.lockTimeoutMs, pollMs: options.lockPollMs, now: options.now });
	const now = timing.now;
	const expected = assertExpectedRevisionShape(options.expectedRevision, "registry", false);
	if (expected === null) {
		// `allowNull: false` 已经排除了 null，这里只是让类型收窄显式化。
		throw new StorageError("revision-conflict", "registry 的 expectedRevision 不能为 null", { detail: "unexpected-null-revision" });
	}
	if (!Array.isArray(options.projects)) {
		throw new StorageError("invalid-record", "updateRegistry 的 projects 必须是数组（完整替换，不做增量合并）", { detail: "invalid-projects" });
	}

	const boundary = await createStorageBoundary({ root: options.root, limits: options.limits, signal: options.signal, ioHooks: options.ioHooks });
	const layout = knowledgeLayout(boundary);
	const absolute = layout.registryPath;
	const relativePath = "registry.json";

	let journalWarnings: readonly string[] = [];
	const result = await runUnderLock(boundary, absolute, options, now, async () => {
		let current: Registry;
		let currentFingerprint: string;
		try {
			// 与校验同源地取出"实际读到字节"的哈希，作为 journal 的 before（BM-02C1）。
			({ registry: current, fingerprint: currentFingerprint } = await readRegistryWithFingerprint(boundary));
		} catch (error) {
			// "registry 不存在"对更新来说同样是并发/前置条件问题，统一成 revision-conflict
			// （actual = null），调用方只需处理一种冲突语义。
			if (isStorageErrorCode(error, "not-found")) {
				throw revisionConflict("registry", relativePath, expected, null, "registry 不存在；请先调用 initializeKnowledgeStore。");
			}
			throw error;
		}

		// 同记录路径：先验"当前值可否安全递增"，再做冲突判定（理由见 commitRecord 里的注释）。
		assertSafeRevision(current.revision, "registry", relativePath);
		if (current.revision !== expected) {
			throw revisionConflict("registry", relativePath, expected, current.revision, "registry 已被其他写入者改过，请重新读取后再提交。");
		}

		const next: Registry = {
			// 公共头（schemaVersion/revision/createdAt/updatedAt）与记录共用同一份生成逻辑：
			// 版本沿用当前值、revision 递增带上限判断、updatedAt 不倒退。
			...nextRecordHeader(current, now, "registry", relativePath),
			projects: options.projects.map((project) => ({ ...project })),
		};

		const outcome = validateRegistry(next);
		if (!outcome.ok) {
			throw new StorageError("invalid-record", `registry 写入被拒绝（结构校验）：${describeIssues(outcome.issues, 5)}`, { detail: "invalid-registry-body" });
		}

		const issues = inspectBindingIssues(outcome.value);
		if (issues.length > 0) {
			throw new StorageError(
				"binding-conflict",
				`registry 写入被拒绝（绑定不一致）：${issues
					.slice(0, 3)
					.map((issue) => `${issue.code}(${issue.message})`)
					.join("；")}`,
				{ conflicts: issues.map((issue) => issue.code), detail: "binding-issues" },
			);
		}

		// 与记录写入同一套顺序：预算与 after 哈希 → prepared 意图 → 数据替换 → 终态记账。
		const payload = serializeJsonPayload(outcome.value);
		assertPayloadWithinLimits(absolute, payload, boundary.limits.maxRegistryBytes, boundary.limits.maxJsonChars);
		const after: JournalFingerprint = { revision: next.revision, hash: payloadFingerprint(payload) };
		const before: JournalFingerprint = { revision: current.revision, hash: currentFingerprint };
		const prepared = await prepareJournalEntry(boundary, { operation: "update", target: { kind: "registry" }, before, after, now, signal: options.signal });

		let renameAttempts = 0;
		const committed = await commitUnderJournal(boundary, prepared, { signal: options.signal, now }, async () => {
			const write = await boundary.replaceJson(absolute, outcome.value, { maxBytes: boundary.limits.maxRegistryBytes, callSignal: options.signal });
			renameAttempts = write.renameAttempts;
			return { bytes: write.bytes, cleanup: write.cleanup, fingerprint: write.fingerprint };
		});

		journalWarnings = committed.journalWarnings ?? [];
		return {
			status: "updated" as const,
			revision: next.revision,
			registry: outcome.value,
			path: absolute,
			relativePath,
			bytes: committed.bytes,
			cleanup: committed.cleanup,
			renameAttempts,
			journal: committed.journal,
		};
	});

	return journalWarnings.length === 0 ? result : { ...result, warnings: [...(result.warnings ?? []), ...journalWarnings] };
}
