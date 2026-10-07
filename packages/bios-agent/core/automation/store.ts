/**
 * AW-00/03：**自动化附属记录的存储**（`automation/workspaces/<workspaceId>/`）。
 *
 * 为什么单独一个模块：附属记录不能走五类业务记录的 `createRecord/updateRecord`（那是固定 schema），
 * 但也**不能**退化成裸 `writeFile`——那会绕过路径边界、协作锁与原子发布。这里统一复用：
 * - `createStorageBoundary`：根内路径解析 + 拒绝链接 + 有界读取；
 * - `acquireStorageLock`：跨进程协作锁（带超时与持锁者诊断）；
 * - `publishJson`（不覆盖创建）/ `replaceJson`（rename 原子替换）。
 *
 * CAS 语义：`state.json` 自带 `revision`，调用方必须给出 `expectedRevision`；冲突如实返回，
 * 不覆盖另一个会话刚写的状态。检查点文件名为 `stableRunId`，重复回调命中同一文件即幂等。
 */
import { acquireStorageLock, type StorageLockHandle } from "../storage/lock.ts";
import { createStorageBoundary, type StorageBoundary, type StorageIoHooks } from "../storage/boundary.ts";
import { resolveStorageLimits, type StorageLimits } from "../storage/limits.ts";
import { StorageError, isStorageErrorCode } from "../storage/errors.ts";
import { assertKnowledgeId } from "../contracts/ids.ts";
import { checkpointCovers } from "./checkpointCoverage.ts";
import { classifyReflectionMark, type ReflectionMarkContext } from "./policy.ts";
import {
	AUTOMATION_CHECKPOINTS_SEGMENT,
	AUTOMATION_CHECKPOINT_VERSION,
	AUTOMATION_LIMITS,
	AUTOMATION_ROOT_SEGMENT,
	AUTOMATION_STATE_FILE,
	AUTOMATION_STATE_VERSION,
	AUTOMATION_WORKSPACES_SEGMENT,
	type AutomationCheckpoint,
	type AutomationReadOutcome,
	type AutomationReceipt,
	type AutomationWriteOutcome,
	type CheckpointRef,
	type WorkspaceAutomationState,
} from "./contract.ts";

export type AutomationStoreOptions = {
	/** 知识根（完全限定绝对路径；调用方保证已初始化）。 */
	readonly root: string;
	readonly projectId: string;
	readonly workspaceId: string;
	readonly limits?: Partial<StorageLimits>;
	readonly signal?: AbortSignal;
	/** 受控 IO 故障注入（仅测试）。 */
	readonly ioHooks?: StorageIoHooks;
	readonly now?: number;
	readonly lockTimeoutMs?: number;
	readonly lockPollMs?: number;
};

type StoreContext = {
	readonly boundary: StorageBoundary;
	readonly limits: StorageLimits;
	readonly projectId: string;
	readonly workspaceId: string;
	readonly signal: AbortSignal | undefined;
	readonly now: number;
	readonly lockTimeoutMs: number | undefined;
	readonly lockPollMs: number | undefined;
};

/** 工作区附属目录的相对段。`workspaceId` 先过知识 ID 校验，杜绝路径拼接注入。 */
export function automationRelativeSegments(workspaceId: string): string[] {
	assertKnowledgeId(workspaceId, "工作区 ID");
	return [AUTOMATION_ROOT_SEGMENT, AUTOMATION_WORKSPACES_SEGMENT, workspaceId];
}

/** 检查点的相对段（runId 必须是受限字符集，避免调用方传入任意字符串）。 */
export function checkpointRelativeSegments(workspaceId: string, runId: string): string[] {
	if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(runId)) throw new StorageError("invalid-record", `非法检查点 ID：${runId}`);
	return [...automationRelativeSegments(workspaceId), AUTOMATION_CHECKPOINTS_SEGMENT, `${runId}.json`];
}

async function openStore(options: AutomationStoreOptions): Promise<StoreContext> {
	const limits = resolveStorageLimits(options.limits);
	const boundary = await createStorageBoundary({ root: options.root, limits, signal: options.signal, ioHooks: options.ioHooks });
	return { boundary, limits, projectId: options.projectId, workspaceId: options.workspaceId, signal: options.signal, now: options.now ?? Date.now(), lockTimeoutMs: options.lockTimeoutMs, lockPollMs: options.lockPollMs };
}

/** 以共享锁串行化"读-改-写"；释放失败不吞成"没有锁"，但也不让它盖过业务结果。 */
async function withLock<T>(context: StoreContext, target: string, action: (handle: StorageLockHandle) => Promise<T>): Promise<T> {
	const handle = await acquireStorageLock(context.boundary, { target, timeoutMs: context.lockTimeoutMs, pollMs: context.lockPollMs, signal: context.signal, now: context.now });
	try {
		return await action(handle);
	} finally {
		await handle.release().catch(() => undefined);
	}
}

/** 首次创建时的空状态（避免调用方各自复制字段，也保证版本常量只有一处）。 */
export function initialWorkspaceState(input: { readonly projectId: string; readonly workspaceId: string; readonly now: number }): WorkspaceAutomationState {
	return {
		version: AUTOMATION_STATE_VERSION,
		revision: 0,
		projectId: input.projectId,
		workspaceId: input.workspaceId,
		createdAt: input.now,
		updatedAt: input.now,
		summaryBaseline: null,
		checkpoints: [],
		reflectionMarks: [],
		lastReceipt: null,
	};
}

function interpretState(context: StoreContext, raw: unknown, bytes: number): AutomationReadOutcome<WorkspaceAutomationState> {
	if (raw === null || typeof raw !== "object") return { status: "corrupt", detail: "state.json 不是对象" };
	const value = raw as Record<string, unknown>;
	if (typeof value.version !== "number") return { status: "corrupt", detail: "state.json 缺少版本字段" };
	if (value.version !== AUTOMATION_STATE_VERSION) return { status: "unsupported-version", detail: `state.json 版本 ${value.version}，本实现只支持 ${AUTOMATION_STATE_VERSION}` };
	if (typeof value.revision !== "number" || value.revision < 0) return { status: "corrupt", detail: "state.json revision 非法" };
	if (value.workspaceId !== context.workspaceId) return { status: "corrupt", detail: "state.json 的工作区 ID 与目录不一致" };
	return { status: "ok", value: value as unknown as WorkspaceAutomationState, bytes };
}

/** 读取工作区状态；缺失返回 `missing`（调用方决定是否创建），不猜默认值。 */
export async function readWorkspaceState(options: AutomationStoreOptions): Promise<AutomationReadOutcome<WorkspaceAutomationState>> {
	const context = await openStore(options);
	const path = context.boundary.resolve(...automationRelativeSegments(context.workspaceId), AUTOMATION_STATE_FILE);
	try {
		const read = await context.boundary.readJson(path, context.limits.maxRecordBytes, context.signal);
		return interpretState(context, read.value, read.bytes);
	} catch (error) {
		if (isStorageErrorCode(error, "not-found")) return { status: "missing" };
		if (isStorageErrorCode(error, "permission-denied")) return { status: "denied", detail: "无法读取自动化状态（权限）" };
		if (isStorageErrorCode(error, "invalid-json")) return { status: "corrupt", detail: "state.json 不是合法 JSON" };
		throw error;
	}
}

/**
 * 以 CAS 写入状态。`expectedRevision = null` 表示"必须不存在"（首次创建）。
 *
 * 冲突返回 `revision-conflict`；调用方最多重读一次后重试，不强行覆盖另一个会话的结果。
 */
export async function writeWorkspaceState(options: AutomationStoreOptions & { readonly state: WorkspaceAutomationState; readonly expectedRevision: number | null }): Promise<AutomationWriteOutcome> {
	const context = await openStore(options);
	const dir = context.boundary.resolve(...automationRelativeSegments(context.workspaceId));
	await context.boundary.ensureDirectory(dir, context.signal);
	const path = context.boundary.resolve(...automationRelativeSegments(context.workspaceId), AUTOMATION_STATE_FILE);
	return withLock(context, path, () => writeWorkspaceStateUnderLock(context, options.state, options.expectedRevision));
}

/**
 * 已持锁时的状态写入（`persistCheckpointRecord` 用）。
 *
 * 为什么必须分开：协作锁不可重入。组合操作已经在锁内做容量判定，若再调用带锁版本
 * 会在同一把锁上自我等待并超时，把"已判定通过"的写入变成失败。
 */
async function writeWorkspaceStateUnderLock(context: StoreContext, state: WorkspaceAutomationState, expectedRevision: number | null): Promise<AutomationWriteOutcome> {
	const path = context.boundary.resolve(...automationRelativeSegments(context.workspaceId), AUTOMATION_STATE_FILE);
	let currentRevision: number | null = null;
	try {
		const read = await context.boundary.readJson(path, context.limits.maxRecordBytes, context.signal);
		const current = interpretState(context, read.value, read.bytes);
		if (current.status === "unsupported-version") return { status: "unsupported-version", detail: current.detail };
		if (current.status !== "ok") return { status: "failed", detail: `现有状态不可用：${current.status}` };
		currentRevision = current.value.revision;
	} catch (error) {
		if (!isStorageErrorCode(error, "not-found")) throw error;
	}
	// `null` = 要求不存在；数字 = 要求等于当前 revision。二者不等即冲突。
	if (expectedRevision === null ? currentRevision !== null : expectedRevision !== currentRevision) {
		return { status: "revision-conflict", expected: expectedRevision ?? -1, actual: currentRevision ?? -1 };
	}
	const next: WorkspaceAutomationState = { ...state, version: AUTOMATION_STATE_VERSION, projectId: context.projectId, workspaceId: context.workspaceId, revision: (currentRevision ?? -1) + 1, updatedAt: context.now };
	const maxBytes = Math.min(context.limits.maxRecordBytes, AUTOMATION_LIMITS.maxStateBytes);
	try {
		if (currentRevision === null) {
			const published = await context.boundary.publishJsonMeasured(path, next, { callSignal: context.signal, maxBytes });
			// 竞态：另一个进程在我们检查之后创建了文件。
			if (published.status === "exists") return { status: "revision-conflict", expected: -1, actual: -1 };
			return { status: "created", revision: next.revision, bytes: published.bytes };
		}
		const replaced = await context.boundary.replaceJson(path, next, { maxBytes, callSignal: context.signal });
		return { status: "updated", revision: next.revision, bytes: replaced.bytes };
	} catch (error) {
		if (isStorageErrorCode(error, "too-large")) return { status: "too-large", detail: "自动化状态超过 64 KiB 上限" };
		throw error;
	}
}

/** 读取单个检查点；缺失/版本不认识/损坏分开报告，不回退缓存正文。 */
export async function readCheckpoint(options: AutomationStoreOptions & { readonly runId: string }): Promise<AutomationReadOutcome<AutomationCheckpoint>> {
	const context = await openStore(options);
	const path = context.boundary.resolve(...checkpointRelativeSegments(context.workspaceId, options.runId));
	try {
		const read = await context.boundary.readJson(path, Math.min(context.limits.maxRecordBytes, AUTOMATION_LIMITS.maxCheckpointBytes), context.signal);
		const value = read.value;
		if (value === null || typeof value !== "object") return { status: "corrupt", detail: "检查点不是对象" };
		const record = value as Record<string, unknown>;
		if (record.version !== AUTOMATION_CHECKPOINT_VERSION) return { status: "unsupported-version", detail: `检查点版本 ${String(record.version)}，本实现只支持 ${AUTOMATION_CHECKPOINT_VERSION}` };
		return { status: "ok", value: value as unknown as AutomationCheckpoint, bytes: read.bytes };
	} catch (error) {
		if (isStorageErrorCode(error, "not-found")) return { status: "missing" };
		if (isStorageErrorCode(error, "permission-denied")) return { status: "denied", detail: "无法读取检查点（权限）" };
		if (isStorageErrorCode(error, "invalid-json")) return { status: "corrupt", detail: "检查点不是合法 JSON" };
		throw error;
	}
}

/**
 * 发布检查点（**不覆盖**）：文件已存在（重复回调/重启后重放）时返回 `unchanged`，即幂等成立。
 */
export async function publishCheckpoint(options: AutomationStoreOptions & { readonly checkpoint: AutomationCheckpoint }): Promise<AutomationWriteOutcome> {
	const context = await openStore(options);
	const dir = context.boundary.resolve(...automationRelativeSegments(context.workspaceId), AUTOMATION_CHECKPOINTS_SEGMENT);
	const path = context.boundary.resolve(...checkpointRelativeSegments(context.workspaceId, options.checkpoint.runId));
	await context.boundary.ensureDirectory(dir, context.signal);
	try {
		const published = await context.boundary.publishJsonMeasured(path, { ...options.checkpoint, version: AUTOMATION_CHECKPOINT_VERSION }, { callSignal: context.signal, maxBytes: Math.min(context.limits.maxRecordBytes, AUTOMATION_LIMITS.maxCheckpointBytes) });
		if (published.status === "exists") {
			const existing = await readCheckpoint({ ...options, runId: options.checkpoint.runId });
			if (existing.status === "ok") return { status: "unchanged", revision: AUTOMATION_CHECKPOINT_VERSION };
			// 同名但不可读：保留原字节，交人工核对，绝不当成"写成功"。
			return { status: "failed", detail: "检查点已存在但不可读（保留原字节，等待人工核对）" };
		}
		return { status: "created", revision: AUTOMATION_CHECKPOINT_VERSION, bytes: published.bytes };
	} catch (error) {
		if (isStorageErrorCode(error, "too-large")) return { status: "too-large", detail: "检查点超过 24 KiB 上限" };
		throw error;
	}
}

/**
 * D2：**受保护记录**的判定（动态，不只看持久标志）。
 *
 * - `pendingReflection`：仍有未保存的唯一证据 ⇒ 必须保留；
 * - `protectedFromRotation`：调用方显式保护（例如"这是本轮唯一证据"）；
 * - 任务关联：**不等于永久保护**。只有该任务**最新**的一条检查点作为"按 taskId 检索"的
 *   权威依据保留，同任务的旧记录可以被轮换——否则正常使用几十轮就会把 50 条预算全部占满
 *   （§9.3 D2 的实测反例：18 轮任务保存后 50 条全部 protected）。
 */
export function protectedRunIds(refs: readonly CheckpointRef[]): ReadonlySet<string> {
	const newestByTask = new Map<string, CheckpointRef>();
	for (const ref of refs) {
		if (ref.taskId === null) continue;
		const current = newestByTask.get(ref.taskId);
		if (current === undefined || ref.recordedAt > current.recordedAt || (ref.recordedAt === current.recordedAt && ref.runId > current.runId)) newestByTask.set(ref.taskId, ref);
	}
	const ids = new Set<string>();
	for (const ref of refs) {
		if (ref.protectedFromRotation || ref.pendingReflection) ids.add(ref.runId);
		else if (ref.taskId !== null && newestByTask.get(ref.taskId)?.runId === ref.runId) ids.add(ref.runId);
	}
	return ids;
}

/**
 * 同请求旧记录收口只接受锁内正文验证得到的覆盖集合。
 * 移出已完全覆盖的旧副本，不篡改不可变文件对应的 pending 标志。
 */
export function integrateSupersededRefs(input: { readonly existing: readonly CheckpointRef[]; readonly next: CheckpointRef; readonly supersededRunIds?: ReadonlySet<string> }): readonly CheckpointRef[] {
	if (input.next.pendingReflection || input.next.requestKey === undefined || input.supersededRunIds === undefined) return input.existing;
	return input.existing.filter((ref) => !(ref.runId !== input.next.runId && ref.pendingReflection && ref.requestKey === input.next.requestKey && input.supersededRunIds?.has(ref.runId)));
}

/**
 * 纯保留策略：把新检查点并入近期集合，并按"受保护记录优先"的规则控制在 `max` 条内。
 *
 * 规则（AW §7.2 / R6）：
 * - 待补记、`protectedFromRotation` 的记录**永远保留**，绝不因容量丢唯一证据；
 * - 只有未受保护的旧记录可以被移出**近期集合**；
 * - 受保护记录本身就超过 `max` 时返回 `full` 且**不纳入新记录**（调用方必须在发布文件之前看到 `full`，
 *   否则会留下"索引里没有、磁盘上却有"的孤儿文件）。
 *
 * 成功时 `refs <= max`。full 时保留原集合；收紧预算不能裁掉既存唯一证据。
 */
export function planCheckpointIndex(input: { readonly existing: readonly CheckpointRef[]; readonly next: CheckpointRef; readonly max?: number; readonly supersededRunIds?: ReadonlySet<string> }): { readonly status: "ok" | "full"; readonly refs: readonly CheckpointRef[]; readonly rotatedOut: readonly string[] } {
	const max = typeof input.max === "number" && Number.isFinite(input.max) && input.max > 0 ? Math.min(Math.floor(input.max), AUTOMATION_LIMITS.maxRecentCheckpoints) : AUTOMATION_LIMITS.maxRecentCheckpoints;
	const integrated = integrateSupersededRefs(input);
	const merged = [input.next, ...integrated.filter((ref) => ref.runId !== input.next.runId)];
	const protectedIds = protectedRunIds(merged);
	const protectedRefs = merged.filter((ref) => protectedIds.has(ref.runId));
	// 受保护记录已经装不下（> max）：如实返回 full，且保留原有集合，不纳入新记录。
	if (protectedRefs.length > max) return { status: "full", refs: [...input.existing], rotatedOut: [] };
	const remaining = max - protectedRefs.length;
	const keptUnprotected = merged.filter((ref) => !protectedIds.has(ref.runId)).slice(0, remaining);
	const refs = [...protectedRefs, ...keptUnprotected];
	// 新记录必须真的进集合：否则文件已发布、索引里却没有它 ⇒ 孤儿文件 + "写了却查不到"。
	if (!refs.some((ref) => ref.runId === input.next.runId)) return { status: "full", refs: [...input.existing], rotatedOut: [] };
	const keptIds = new Set(refs.map((ref) => ref.runId));
	const rotatedOut = input.existing.filter((ref) => !keptIds.has(ref.runId)).map((ref) => ref.runId);
	return { status: "ok", refs, rotatedOut };
}

/** 一次"容量判定 → 发布文件 → CAS 索引 → 轮换清理"的完整结果。 */
export type PersistCheckpointOutcome = {
	readonly status: "created" | "unchanged" | "full" | "revision-conflict" | "unsupported-version" | "too-large" | "failed";
	readonly runId: string;
	readonly detail: string;
	/** 被移出近期集合并已清理的检查点 runId（有界磁盘）。 */
	readonly rotatedOut: readonly string[];
	/** 写完后的状态 revision（失败时为 null）。 */
	readonly revision: number | null;
	/** 索引中当前检查点条数（失败/受限时如实给出）。 */
	readonly indexed: number;
};

/**
 * R6：**原子**发布一条检查点并更新索引。
 *
 * 顺序是这次修复的核心：
 * 1. **先**在锁内读状态并做容量/保护判定 —— 满了就直接返回 `full`，**一个文件都不写**；
 * 2. 再发布检查点文件（同名即幂等，返回 `unchanged`，不覆盖已有字节）；
 * 3. 再以 CAS 写索引；CAS 冲突最多重读一次重试（重试会重新做容量判定）；
 * 4. 最后清理被轮换出近期集合的检查点文件，限定磁盘增长。
 */
export async function persistCheckpointRecord(
	options: AutomationStoreOptions & {
		readonly checkpoint: AutomationCheckpoint;
		/** 该检查点是否需要防止被轮换（仍有唯一证据/待补记）。 */
		readonly protectedFromRotation: boolean;
		/** 最大近期集合（只能收紧）。 */
		readonly max?: number;
		/** 是否清理被轮换出的文件（缺省 true）。 */
		readonly pruneRotated?: boolean;
	},
): Promise<PersistCheckpointOutcome> {
	const context = await openStore(options);
	const runId = options.checkpoint.runId;
	const stateDir = context.boundary.resolve(...automationRelativeSegments(context.workspaceId));
	const statePath = context.boundary.resolve(...automationRelativeSegments(context.workspaceId), AUTOMATION_STATE_FILE);
	const checkpointDir = context.boundary.resolve(...automationRelativeSegments(context.workspaceId), AUTOMATION_CHECKPOINTS_SEGMENT);
	await context.boundary.ensureDirectory(stateDir, context.signal);
	await context.boundary.ensureDirectory(checkpointDir, context.signal);
	const nextRef: CheckpointRef = { runId, recordedAt: options.checkpoint.recordedAt, taskId: options.checkpoint.task?.taskId ?? null, pendingReflection: options.checkpoint.pendingReflection, protectedFromRotation: options.protectedFromRotation, requestKey: options.checkpoint.requestKey };
	const fail = (status: PersistCheckpointOutcome["status"], detail: string, indexed = 0): PersistCheckpointOutcome => ({ status, runId, detail, rotatedOut: [], revision: null, indexed });
	/**
	 * D2：容量满/写入失败必须**耐久记录**（宿主默认面板可读），不能只留在扩展的私有变量里。
	 * 尽力而为：回执写失败不影响本次业务的如实返回。
	 */
	const recordReceipt = async (input: { readonly base: WorkspaceAutomationState; readonly checkpoints: readonly CheckpointRef[]; readonly revision: number | null; readonly receipt: AutomationReceipt }): Promise<void> => {
		const next: WorkspaceAutomationState = { ...input.base, checkpoints: input.checkpoints, lastReceipt: input.receipt, updatedAt: context.now, revision: input.revision ?? -1 };
		await writeWorkspaceStateUnderLock(context, next, input.revision).catch(() => undefined);
	};
	const FULL_DETAIL = "受保护记录已占满近期集合预算：停止新增检查点（不丢唯一证据），普通开发继续";
	const coveredIds = async (refs: readonly CheckpointRef[], checkpoint: AutomationCheckpoint): Promise<ReadonlySet<string>> => {
		const covered = new Set<string>();
		if (checkpoint.pendingReflection) return covered;
		for (const ref of refs.slice(0, AUTOMATION_LIMITS.maxRecentCheckpoints)) {
			if (!ref.pendingReflection || ref.requestKey !== checkpoint.requestKey || ref.runId === checkpoint.runId) continue;
			try {
				const old = await readCheckpoint({ ...options, runId: ref.runId });
				if (old.status === "ok" && old.value.runId === ref.runId && checkpointCovers(old.value, checkpoint)) covered.add(ref.runId);
			} catch (error) {
				if (isStorageErrorCode(error, "cancelled")) throw error;
				// 缺失、损坏或拒读的旧正文不能作为删除依据。
			}
		}
		return covered;
	};
	return withLock(context, statePath, async () => {
		for (let attempt = 0; attempt < 2; attempt += 1) {
			let base: WorkspaceAutomationState = initialWorkspaceState({ projectId: context.projectId, workspaceId: context.workspaceId, now: context.now });
			let existingRevision: number | null = null;
			try {
				const read = await context.boundary.readJson(statePath, context.limits.maxRecordBytes, context.signal);
				const interpreted = interpretState(context, read.value, read.bytes);
				if (interpreted.status === "unsupported-version") return fail("unsupported-version", interpreted.detail);
				if (interpreted.status !== "ok") return fail("failed", `现有状态不可用（${interpreted.status}）：保留原字节等待人工核对`);
				base = interpreted.value;
				existingRevision = interpreted.value.revision;
			} catch (error) {
				if (!isStorageErrorCode(error, "not-found")) throw error;
			}
			const refs = base.checkpoints ?? [];
			// 1) 容量判定**在发布之前**：满了就一个文件都不写。
			const plan = planCheckpointIndex({ existing: refs, next: nextRef, max: options.max, supersededRunIds: await coveredIds(refs, options.checkpoint) });
			if (plan.status === "full") {
				await recordReceipt({ base, checkpoints: plan.refs, revision: existingRevision, receipt: { kind: "checkpoint-full", recordedAt: context.now, detail: FULL_DETAIL } });
				return { status: "full", runId, detail: FULL_DETAIL, rotatedOut: [], revision: existingRevision, indexed: plan.refs.length };
			}
			// 2) 发布文件（不覆盖；同名即幂等）。
			let published: AutomationWriteOutcome;
			try {
				published = await publishCheckpoint({ ...options, checkpoint: options.checkpoint });
			} catch (error) {
				if (isStorageErrorCode(error, "too-large")) {
					await recordReceipt({ base, checkpoints: refs, revision: existingRevision, receipt: { kind: "checkpoint-failed", recordedAt: context.now, detail: "检查点超过 24 KiB 上限：未落盘" } });
					return fail("too-large", "检查点超过 24 KiB 上限");
				}
				await recordReceipt({ base, checkpoints: refs, revision: existingRevision, receipt: { kind: "checkpoint-failed", recordedAt: context.now, detail: "检查点发布失败：索引未改动" } });
				return fail("failed", `检查点发布失败（${error instanceof Error ? error.message.slice(0, 120) : "unknown"}）：索引未改动`);
			}
			if (published.status === "failed" || published.status === "too-large") {
				await recordReceipt({ base, checkpoints: refs, revision: existingRevision, receipt: { kind: "checkpoint-failed", recordedAt: context.now, detail: published.detail } });
				return fail(published.status, published.detail);
			}
			const unchanged = published.status === "unchanged";
			// 2b) C3：同名文件已存在时，**索引必须引用磁盘上的权威事实**（同一个 runId 的旧文件可能
			//     与本次调用携带的事实不同；直接按本次入参写索引会造成"索引与文件不一致"）。
			let authoritativeRef = nextRef;
			let authoritativeCheckpoint = options.checkpoint;
			if (unchanged) {
				const existing = await readCheckpoint({ ...options, runId }).catch(() => null);
				if (existing === null || existing.status !== "ok" || existing.value.runId !== runId) return fail("failed", "同名检查点无法复验：保留索引，不使用本次入参冒充旧事实", refs.length);
				authoritativeCheckpoint = existing.value;
				authoritativeRef = { runId, recordedAt: existing.value.recordedAt, taskId: existing.value.task?.taskId ?? null, pendingReflection: existing.value.pendingReflection, protectedFromRotation: nextRef.protectedFromRotation || existing.value.pendingReflection, requestKey: existing.value.requestKey };
			}
			// 新文件在同一锁中发布，复用发布前的覆盖证明，避免迟到取消后二次读取导致孤儿。
			// 同名重放则必须按旧文件的真实正文重新判定，不能借本次入参清除旧证据。
			const finalPlan = unchanged ? planCheckpointIndex({ existing: refs, next: authoritativeRef, max: options.max, supersededRunIds: await coveredIds(refs, authoritativeCheckpoint) }) : plan;
			if (finalPlan.status === "full") {
				await recordReceipt({ base, checkpoints: finalPlan.refs, revision: existingRevision, receipt: { kind: "checkpoint-full", recordedAt: context.now, detail: FULL_DETAIL } });
				return { status: "full", runId, detail: FULL_DETAIL, rotatedOut: [], revision: existingRevision, indexed: finalPlan.refs.length };
			}
			// 3) CAS 写索引（保留其它字段；只替换检查点集合）。写入成功 ⇒ 清掉上一条**已解决**的受限回执。
			//    V3：`reflection-unrecovered` 描述的是"仍未处理的失败事实"，后续成功检查点不得擦掉它
			//    （否则跨会话/重启后用户再也看不到这条事实）；它只在标记真正收口时才被清（见 `recordReflectionMark`）。
			const next: WorkspaceAutomationState = { ...base, checkpoints: finalPlan.refs, lastReceipt: isUnresolvedReceipt(base.lastReceipt) ? base.lastReceipt : null, updatedAt: context.now, revision: existingRevision ?? -1 };
			const written = await writeWorkspaceStateUnderLock(context, next, existingRevision);
			if (written.status === "created" || written.status === "updated") {
				// 4) 轮换清理（尽力而为；失败不影响"已保存"结论，只影响磁盘大小）。
				if ((options.pruneRotated ?? true) && finalPlan.rotatedOut.length > 0) {
					for (const rotated of finalPlan.rotatedOut.slice(0, 64)) {
						const path = context.boundary.resolve(...checkpointRelativeSegments(context.workspaceId, rotated));
						await context.boundary.removeFile(path).catch(() => undefined);
					}
				}
				return { status: unchanged ? "unchanged" : "created", runId, detail: unchanged ? "同名检查点已存在（幂等）" : `已写入检查点 ${runId}`, rotatedOut: finalPlan.rotatedOut, revision: written.revision, indexed: finalPlan.refs.length };
			}
			if (written.status === "revision-conflict") continue;
			return fail(written.status, `状态写入失败：${written.status}`);
		}
		return fail("revision-conflict", "状态并发冲突（已重读一次仍冲突）：本次不覆盖其它会话的结果");
	});
}

/** 从状态里取近期检查点索引（不扫目录，避免与业务记录争预算）。 */
export function recentCheckpoints(state: WorkspaceAutomationState | null): readonly CheckpointRef[] {
	return state?.checkpoints ?? [];
}

/**
 * D2：写入/清除**耐久回执**（补记部分成功等由扩展侧的判定）。
 *
 * 只改 `lastReceipt` 一个字段，检查点集合原样保留；CAS 冲突如实返回（不覆盖别的会话）。
 */
export async function recordAutomationReceipt(options: AutomationStoreOptions & { readonly receipt: AutomationReceipt | null }): Promise<{ readonly status: "ok" | "failed"; readonly detail: string }> {
	const context = await openStore(options);
	const statePath = context.boundary.resolve(...automationRelativeSegments(context.workspaceId), AUTOMATION_STATE_FILE);
	const dir = context.boundary.resolve(...automationRelativeSegments(context.workspaceId));
	await context.boundary.ensureDirectory(dir, context.signal);
	return withLock(context, statePath, async () => {
		let base: WorkspaceAutomationState | null = null;
		let revision: number | null = null;
		try {
			const read = await context.boundary.readJson(statePath, context.limits.maxRecordBytes, context.signal);
			const interpreted = interpretState(context, read.value, read.bytes);
			if (interpreted.status !== "ok") return { status: "failed" as const, detail: `现有状态不可用（${interpreted.status}）：不写入回执` };
			base = interpreted.value;
			revision = interpreted.value.revision;
		} catch (error) {
			if (!isStorageErrorCode(error, "not-found")) throw error;
		}
		const seed = base ?? initialWorkspaceState({ projectId: context.projectId, workspaceId: context.workspaceId, now: context.now });
		const next: WorkspaceAutomationState = { ...seed, lastReceipt: options.receipt, updatedAt: context.now, revision: revision ?? -1 };
		const written = await writeWorkspaceStateUnderLock(context, next, revision);
		return written.status === "created" || written.status === "updated" ? { status: "ok" as const, detail: `revision ${written.revision}` } : { status: "failed" as const, detail: `状态写入失败：${written.status}` };
	});
}

/**
 * V3：这条回执描述的是**仍未处理**的失败事实（不能被后续成功检查点顺手擦掉）。
 *
 * 只有"补记没有恢复路径"属于已确认且仍未解决的失败；其余（容量满/写失败/部分成功）
 * 会在下一次成功写入时自然被新的真实状态取代。
 */
export function isUnresolvedReceipt(receipt: AutomationReceipt | null | undefined): boolean {
	return receipt !== null && receipt !== undefined && receipt.kind === "reflection-unrecovered";
}

/**
 * V1：**一次 CAS 内**同时写"未恢复回执"与对应标记的 `unrecoveredAt`。
 *
 * 为什么必须原子：旧实现先写回执、再单独写标记，两次写入各自可能失败——实测出现过
 * "回执没落盘、较小标记却全部落盘"（`lastReceipt:null` + `markedNotified:10`），
 * 重启后标记排除这些记录、回执又不存在，用户彻底看不到这条失败事实。
 *
 * 同时在锁内**重验**：如果某条标记已经被它自己的请求保存/终结（迟到完成结果），
 * 就不再给它打 `unrecoveredAt`，也不把它算进本次回执——不能让收尾的失败判定盖过真实完成。
 * 一条都没落到时**不写回执**（不制造悬空事实）。
 */
export async function recordUnrecoveredReceipt(
	options: AutomationStoreOptions & { readonly receipt: AutomationReceipt; readonly requestKeys: readonly string[]; readonly at: number; readonly terminationContext?: ReflectionMarkContext },
): Promise<{ readonly status: "ok" | "failed"; readonly detail: string; readonly noted: readonly string[] }> {
	if (options.requestKeys.length === 0) return { status: "ok", detail: "nothing-to-note", noted: [] };
	const context = await openStore(options);
	const statePath = context.boundary.resolve(...automationRelativeSegments(context.workspaceId), AUTOMATION_STATE_FILE);
	const dir = context.boundary.resolve(...automationRelativeSegments(context.workspaceId));
	await context.boundary.ensureDirectory(dir, context.signal);
	return withLock(context, statePath, async () => {
		let base: WorkspaceAutomationState | null = null;
		let revision: number | null = null;
		try {
			const read = await context.boundary.readJson(statePath, context.limits.maxRecordBytes, context.signal);
			const interpreted = interpretState(context, read.value, read.bytes);
			if (interpreted.status !== "ok") return { status: "failed" as const, detail: `现有状态不可用（${interpreted.status}）：不写入回执`, noted: [] };
			base = interpreted.value;
			revision = interpreted.value.revision;
		} catch (error) {
			if (!isStorageErrorCode(error, "not-found")) throw error;
		}
		const seed = base ?? initialWorkspaceState({ projectId: context.projectId, workspaceId: context.workspaceId, now: context.now });
		const wanted = new Set(options.requestKeys);
		const noted: string[] = [];
		const marks = seed.reflectionMarks.map((mark) => {
			// 锁内重验：只有"仍未终结、仍未保存、仍未回执过"的才打标记（迟到完成结果优先）。
			if (!wanted.has(mark.requestKey)) return mark;
			if (mark.saved === true || mark.finished === true || mark.unrecoveredAt !== undefined) return mark;
			// Ownership can change while waiting for the lock. Re-evaluate the proof against durable data.
			if (options.terminationContext !== undefined && classifyReflectionMark(mark, options.terminationContext).state !== "unrecovered") return mark;
			noted.push(mark.requestKey);
			return { ...mark, unrecoveredAt: options.at };
		});
		if (noted.length === 0) return { status: "ok" as const, detail: "nothing-to-note", noted: [] };
		// The durable receipt must describe only owners still covered by the termination proof.
		const receipt =
			options.terminationContext === undefined
				? options.receipt
				: {
						...options.receipt,
						detail: marks
							.filter((mark) => noted.includes(mark.requestKey))
							.map((mark) => `${mark.requestKey.slice(0, 24)}（已开始 ${mark.attempts} 次，未恢复）`)
							.join("；"),
					};
		const next: WorkspaceAutomationState = { ...seed, reflectionMarks: marks, lastReceipt: receipt, updatedAt: context.now, revision: revision ?? -1 };
		const written = await writeWorkspaceStateUnderLock(context, next, revision);
		return written.status === "created" || written.status === "updated" ? { status: "ok" as const, detail: `revision ${written.revision}`, noted } : { status: "failed" as const, detail: `状态写入失败：${written.status}`, noted: [] };
	});
}
