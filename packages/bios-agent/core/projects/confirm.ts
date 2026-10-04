/**
 * BM-03 B3：**人工确认与 CAS 保存**。
 *
 * 人工确认是**独立写动作**，不是检测后的自动副作用：
 * - 检测只能产生 `candidate`，它永远不会调用这里；
 * - 确认必须显式给出目标项目、目标 revision 与要改的有限字段；
 * - 只改被点名的字段，未触达的字段、其它工作区、已有证据与资料缺口**原样保留**；
 * - 期望 revision 与实际不符时**不写**，如实返回冲突与当前 revision（调用方重读后再提交）。
 *
 * 不往 v1 添加任何新字段：确认动作本身用 schema 已有的 `ProjectField.evidence`
 * （`human-note` + 采集时间）记录。`operatorLabel` 只是**声明**，
 * 不构成企业身份认证，也不等于经验卡审核的审计记录。
 */
import type { EvidenceRef, ProjectField } from "../contracts/common.ts";
import type { ProjectIdentity } from "../contracts/records.ts";
import { isStorageError, readRecord, StorageError, updateRecord, type StorageIoHooks, type StorageLimits } from "../storage/index.ts";
import { assertSafeRelativePath, inconsistent, invalidArgument, optionalBoundedText, ProjectServiceError, requireBoundedText, requireProjectFieldName, resolveProjectLimits, type ProjectServiceErrorCode, type ProjectServiceLimits } from "./contract.ts";
import { isArrayFieldName, isIdentityFieldName, type ProjectFieldName } from "./fields.ts";
import { collectWriteNotes } from "./writeNotes.ts";

/** 人工确认所依据的**文件证据**（相对路径 + 采集时的内容 hash）。 */
export type ConfirmEvidenceInput = {
	/** 相对本工作区的路径（拒绝绝对路径与 `..`）。 */
	readonly relativePath: string;
	/** 采集时的 SHA-256（小写 64 位）：后续靠它判断"证据是否变过"。 */
	readonly contentHash: string;
};

export type ConfirmFieldInput = {
	/** 允许列表里的字段名（未知字段直接拒绝）。 */
	readonly field: string;
	/** 确认值；身份字段可为 `null`（显式回到 unknown）。数组型字段不接受 null。 */
	readonly value: string | null;
	/**
	 * 可选：这次确认依据的文件证据。
	 *
	 * 写进 schema 已有的 `ProjectField.evidence`（`source-file` + 相对路径 + 内容 hash），
	 * 让"证据变了"能在下次读取时被真的检出来；给出证据时必须同时给出 `workspaceId`
	 * （否则不知道相对路径属于哪个检出）。
	 */
	readonly evidence?: readonly ConfirmEvidenceInput[];
};

export type ConfirmProfileInput = {
	readonly root: string;
	readonly projectId: string;
	/** 证据归属的工作区（可选；给出时必须已绑定在档案里）。 */
	readonly workspaceId?: string;
	/** 期望的档案 revision（CAS 前置条件；不给就等于"我不在乎覆盖别人的修改"，因此必填）。 */
	readonly expectedProfileRevision: number;
	readonly values: readonly ConfirmFieldInput[];
	/** 执行者标签：只作为声明写进证据位置，不声称是身份认证。 */
	readonly operatorLabel?: string;
	readonly limits?: Partial<ProjectServiceLimits>;
	readonly storageLimits?: Partial<StorageLimits>;
	readonly signal?: AbortSignal;
	readonly ioHooks?: StorageIoHooks;
	readonly now?: number;
	readonly lockTimeoutMs?: number;
	readonly lockPollMs?: number;
};

export type ConfirmProfileResult = {
	readonly status: "confirmed" | "no-change" | "revision-conflict" | "not-found";
	/**
	 * 写入后的 revision；`no-change`/`revision-conflict` 时给出**当前读到**的 revision。
	 * `not-found` 时为 null。
	 */
	readonly revision: number | null;
	/** 冲突时实际读到的 revision（供调用方决定重读重试）。 */
	readonly actualRevision: number | null;
	/** 实际发生变化的字段（`no-change` 时为空）。 */
	readonly changedFields: readonly ProjectFieldName[];
	/** 本次被显式声明的执行者标签（回显给命令输出用）。 */
	readonly operatorLabel: string | null;
	readonly problems: readonly string[];
	/** 存储层报告的"提交成立但有遗留"诊断（透传，不吞）。 */
	readonly warnings: readonly string[];
	/** 需要人工/巡检核对的原因（已提交但记账/清理未完成）。 */
	readonly needsReview: readonly string[];
};

function mapStorageError(error: unknown, context: string): ProjectServiceError {
	if (isStorageError(error)) {
		const code: ProjectServiceErrorCode = error.code === "revision-conflict" ? "revision-conflict" : error.code === "cancelled" ? "cancelled" : error.code === "not-found" ? "not-found" : "io-error";
		return new ProjectServiceError(code, `${context}：${error.message}`, { detail: error.code, cause: error });
	}
	return new ProjectServiceError("io-error", `${context}：${error instanceof Error ? error.message : String(error)}`, { cause: error });
}

/** 人工确认值：受控长度、单行；空串不是"确认了空值"。 */
function requireConfirmValue(value: unknown, label: string, maxChars: number): string {
	if (typeof value !== "string") throw invalidArgument(`${label} 必须是字符串或 null`);
	const trimmed = value.trim();
	if (trimmed === "") throw invalidArgument(`${label} 不能为空字符串（要显式表达"未知"请用 null）`);
	if (trimmed.length > maxChars) throw invalidArgument(`${label} 超过 ${maxChars} 字符上限`);
	if (/[\u0000-\u001f\u007f]/.test(trimmed)) throw invalidArgument(`${label} 不能包含控制字符或换行`);
	return trimmed;
}

/** 文件证据的形态校验：相对路径 + 小写 64 位 hash；没有工作区就不知道路径属于哪个检出。 */
function requireEvidenceInput(value: unknown, label: string, workspaceId: string | undefined): readonly ConfirmEvidenceInput[] {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value)) throw invalidArgument(`${label} 必须是数组`);
	if (value.length === 0) return [];
	if (workspaceId === undefined) throw invalidArgument(`${label} 需要同时给出 workspaceId（相对路径属于哪个检出）`);
	const result: ConfirmEvidenceInput[] = [];
	for (const entry of value) {
		if (typeof entry !== "object" || entry === null) throw invalidArgument(`${label} 的每一项必须是对象`);
		const record = entry as { relativePath?: unknown; contentHash?: unknown };
		if (typeof record.relativePath !== "string") throw invalidArgument(`${label} 必须带 relativePath`);
		const relativePath = assertSafeRelativePath(record.relativePath);
		if (typeof record.contentHash !== "string" || !/^[0-9a-f]{64}$/.test(record.contentHash)) throw invalidArgument(`${label} 的 contentHash 必须是小写 64 位 SHA-256`);
		result.push({ relativePath, contentHash: record.contentHash });
	}
	return result;
}

function humanNoteEvidence(now: number, operatorLabel: string | undefined, workspaceId: string | undefined): EvidenceRef {
	return {
		type: "human-note",
		...(workspaceId === undefined ? {} : { workspaceId }),
		...(operatorLabel === undefined ? {} : { location: operatorLabel }),
		capturedAt: now,
		validity: "active",
	};
}

export async function confirmProfileFields(input: ConfirmProfileInput): Promise<ConfirmProfileResult> {
	if (typeof input !== "object" || input === null) throw invalidArgument("确认参数必须是对象");
	const root = requireBoundedText(input.root, "知识根", 4096);
	const projectId = requireBoundedText(input.projectId, "项目 ID", 64);
	const limits = resolveProjectLimits(input.limits);
	const operatorLabel = optionalBoundedText(input.operatorLabel, "执行者标签", 120);
	const workspaceId = optionalBoundedText(input.workspaceId, "工作区 ID", 64);
	const expected = input.expectedProfileRevision;
	if (typeof expected !== "number" || !Number.isSafeInteger(expected) || expected < 0) throw invalidArgument("expectedProfileRevision 必须是安全非负整数（CAS 前置条件必填）");
	if (!Array.isArray(input.values)) throw invalidArgument("values 必须是数组");
	if (input.values.length === 0) throw invalidArgument("values 不能为空（没有要确认的字段）");
	if (input.values.length > limits.maxConfirmFields) throw invalidArgument(`一次最多确认 ${limits.maxConfirmFields} 个字段`);

	// 字段名与值都在 IO 之前判定：非法输入不会读到档案、更不会写到磁盘。
	const seen = new Set<string>();
	const requested: Array<{ field: ProjectFieldName; value: string | null; evidence: readonly ConfirmEvidenceInput[] }> = [];
	for (const entry of input.values) {
		if (typeof entry !== "object" || entry === null) throw invalidArgument("values 的每一项必须是对象");
		const field = requireProjectFieldName(entry.field);
		if (seen.has(field)) throw invalidArgument(`字段 ${field} 在一次确认里出现了两次（不确定要用哪个值）`);
		seen.add(field);
		const evidence = requireEvidenceInput(entry.evidence, `字段 ${field} 的证据`, workspaceId);
		if (isArrayFieldName(field)) {
			// 数组字段的"未知"用"不提供该字段"表达，不用 null：null 无法区分"清空"和"不知道"。
			requested.push({ field, value: requireConfirmValue(entry.value, `字段 ${field} 的值`, limits.maxFieldValueChars), evidence });
		} else if (entry.value === null) {
			requested.push({ field, value: null, evidence });
		} else {
			requested.push({ field, value: requireConfirmValue(entry.value, `字段 ${field} 的值`, limits.maxFieldValueChars), evidence });
		}
	}

	const now = input.now ?? Date.now();
	const read = await readRecord({ root, kind: "project-profile", id: projectId, limits: input.storageLimits, signal: input.signal, ioHooks: input.ioHooks });
	const profile = read.record;

	if (workspaceId !== undefined && !profile.workspaces.some((workspace) => workspace.workspaceId === workspaceId)) {
		throw inconsistent(`工作区 ${workspaceId} 不在项目 ${projectId} 的已绑定工作区里，拒绝把确认证据挂到未知工作区`, "workspace-not-in-profile");
	}

	if (profile.revision !== expected) {
		// 冲突时不写：返回当前 revision，让调用方重读后再提交（不静默覆盖他人修改）。
		return { status: "revision-conflict", revision: profile.revision, actualRevision: profile.revision, changedFields: [], operatorLabel: operatorLabel ?? null, problems: [`期望 revision=${expected}，实际 revision=${profile.revision}；未写入任何内容。`], warnings: [], needsReview: [] };
	}

	const humanNote = humanNoteEvidence(now, operatorLabel, workspaceId);
	const identity: ProjectIdentity = { ...profile.identity };
	const buildTargets: ProjectField[] = profile.buildTargets.map((field) => ({ ...field, evidence: [...field.evidence] }));
	const keyEntryPoints: ProjectField[] = profile.keyEntryPoints.map((field) => ({ ...field, evidence: [...field.evidence] }));
	const changedFields: ProjectFieldName[] = [];

	for (const { field, value, evidence } of requested) {
		// 本次要追加的证据：可复核的文件证据 + 一条"谁在什么时候确认的"声明。
		const appended: EvidenceRef[] = [...evidence.map((entry) => ({ type: "source-file" as const, ...(workspaceId === undefined ? {} : { workspaceId }), relativePath: entry.relativePath, contentHash: entry.contentHash, capturedAt: now, validity: "active" as const })), humanNote];
		if (isIdentityFieldName(field)) {
			const current = identity[field];
			const nextStatus = value === null ? "unknown" : "confirmed";
			if (current.value === value && current.status === nextStatus) continue; // 已经是这个确认值：不制造无意义的 revision
			identity[field] = { value, status: nextStatus, evidence: [...current.evidence, ...appended], updatedAt: now };
			changedFields.push(field);
			continue;
		}
		// 数组字段：同值条目升级为 confirmed（保留其它条目），新值追加为 confirmed 条目。
		const target = field === "buildTargets" ? buildTargets : keyEntryPoints;
		const existing = target.find((candidate) => candidate.value === value);
		if (existing !== undefined) {
			if (existing.status === "confirmed") continue;
			existing.status = "confirmed";
			existing.evidence = [...existing.evidence, ...appended];
			existing.updatedAt = now;
		} else {
			target.push({ value, status: "confirmed", evidence: appended, updatedAt: now });
		}
		changedFields.push(field);
	}

	if (changedFields.length === 0) {
		// 确认值没变 ⇒ 不写。把"没有变化"当成成功而不是一次 revision 递增。
		return { status: "no-change", revision: profile.revision, actualRevision: profile.revision, changedFields: [], operatorLabel: operatorLabel ?? null, problems: [], warnings: [], needsReview: [] };
	}

	try {
		const written = await updateRecord({
			kind: "project-profile",
			id: projectId,
			data: { identity, workspaces: profile.workspaces, buildTargets, keyEntryPoints, gaps: profile.gaps },
			expectedRevision: profile.revision,
			root,
			now,
			signal: input.signal,
			ioHooks: input.ioHooks,
			limits: input.storageLimits,
			lockTimeoutMs: input.lockTimeoutMs,
			lockPollMs: input.lockPollMs,
		});
		// 底层"提交成立但有遗留"的事实（journal 终态未写 / 清理或锁释放异常）必须透传：
		// 吞掉它就会把"数据已提交、需要核对"报成一次干净的 confirmed（R28-1）。
		const notes = collectWriteNotes(written, "项目档案");
		return { status: "confirmed", revision: written.revision, actualRevision: written.revision, changedFields, operatorLabel: operatorLabel ?? null, problems: [], warnings: notes.warnings, needsReview: notes.needsReview };
	} catch (error) {
		if (isStorageError(error) && error.code === "revision-conflict") {
			// 双进程竞争：另一个写入者在我们读取之后提交了。原字节未被改动。
			const actual = typeof (error as StorageError & { actual?: unknown }).actual === "number" ? (error as StorageError & { actual: number }).actual : null;
			return { status: "revision-conflict", revision: actual, actualRevision: actual, changedFields: [], operatorLabel: operatorLabel ?? null, problems: [error.message], warnings: [], needsReview: [] };
		}
		throw mapStorageError(error, "写入人工确认失败");
	}
}
