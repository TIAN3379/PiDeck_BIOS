/**
 * BM-03 B4：把项目事实**喂进 M1**，输出结构化、受预算限制的读取视图。
 *
 * 这个模块的存在意义是"不要造完 MemoryCandidate 就丢掉"：
 * - 档案确认值 → `project-profile` 族的字段级事实（`status = confirmed` 才算确认）；
 * - 本次检测结果 → `detected-candidate` 族的字段级事实（**永远**只是候选）；
 * - 证据复验结果 → `evidence[].validity`（变化 → stale，缺失/不可读 → unavailable）；
 * - 工作区 HEAD → `dependencySnapshot`（切分支/换检出会自然变成 `verification-drift`）。
 *
 * R28-2 后的三条硬要求：
 * 1. **按事实键归属证据**：`boardName` 用的是 a.dsc，就不能因为 b.dec 变了而漂移；
 *    未复验的事实不能借别的字段的 valid 升为 `current`；
 * 2. **部分结果必须可见**：证据未复验、文件超预算、检测被截断都要让整体 `incomplete`，
 *    不能只取 M1 的状态；
 * 3. **所有数组都有界**：problems / gaps / checks 都有独立上限，JSON 外壳不会无限增长。
 *
 * 三条不假装的事：
 * 1. **不是原子快照**：registry/profile/源码/Git 是分别读的，视图里带各自的 revision，
 *    变化后必须重新判定（本模块不承诺跨文件一致性）；
 * 2. **不改档案**：证据变 stale/unavailable 只体现在视图里，不自动删证据、不覆盖人工确认；
 * 3. **v1 没有时态/依赖的**经验仍按 legacy/reference，不为凑 `current` 数量补造时态。
 */
import type { EvidenceRef, FieldGap } from "../contracts/common.ts";
import type { ProjectProfile } from "../contracts/records.ts";
import { decideMemory, type MemoryCandidate, type MemoryConfirmedField, type MemoryDecisionResult, type MemoryEvidenceRef, type MemoryQuery, type MemoryScopeDeclaration } from "../memory/index.ts";
import type { DetectProjectResult } from "./detection.ts";
import { detectProjectCandidates } from "./detection.ts";
import { openProjectProfile, type OpenProjectInput, type OpenProjectResult } from "./binding.ts";
import { resolveProjectLimits, type ProjectServiceLimits } from "./contract.ts";
import { IDENTITY_FIELD_NAMES, type IdentityFieldName } from "./fields.ts";
import { captureWorkspaceSnapshot, checksForKey, summarizeEvidenceChecks, verifyEvidenceRefs, type EvidenceCheck, type EvidenceVerificationEntry, type VerifyEvidenceResult } from "./workspace.ts";

/** 事实键前缀：让"档案字段"与"经验卡文本"不会意外撞到同一个业务键。 */
const FACT_PREFIX = "project-profile";

/** 单条事实最多带入 M1 的证据条数（与 `evidenceToMemory` 的上限一致，保证计数对齐）。 */
const MAX_EVIDENCE_PER_FACT = 32;

export type ProjectDecisionView = {
	readonly status: "ok" | "incomplete" | "not-usable";
	/** 打开结果（含一致性状态）；`not-usable` 时仍然是完整对象，便于 CLI 给出可操作的错误。 */
	readonly open: OpenProjectResult;
	readonly decision: MemoryDecisionResult | null;
	readonly detection: DetectProjectResult | null;
	readonly evidenceChecks: readonly EvidenceCheck[];
	/** 证据复验因预算/超限未比较的条数（> 0 时视图不完整）。 */
	readonly evidenceUnchecked: number;
	/** 未复验的原因分类（有界）。 */
	readonly evidenceUncheckedReasons: readonly string[];
	/** 哪些事实的证据**没有被复验**（这些字段不得凭别的字段的 valid 升为当前）。 */
	readonly evidenceUnverifiedFacts: readonly string[];
	readonly gaps: readonly FieldGap[];
	readonly problems: readonly string[];
	/** 因上限被截断的维度（`problems`/`gaps` 等；空数组表示没有截断）。 */
	readonly shellTruncated: readonly string[];
	/** 视图依据的版本（分别列出：不是一次原子快照）。 */
	readonly revisions: { readonly registry: number | null; readonly profile: number | null };
	/** 本次**实际读到**的工作区 VCS 状态（`null` = 非 Git 或未采集）。 */
	readonly workspaceVcs: { readonly branch: string | null; readonly head: string | null } | null;
	/** 当前 HEAD 与档案记录不同（依赖该检出的结论需要复核）。 */
	readonly headChanged: boolean;
	readonly branchChanged: boolean;
};

export type ReadProjectViewInput = OpenProjectInput & {
	/** 是否调用检测（默认 false：读取档案不应隐式扫源码）。 */
	readonly detect?: boolean;
	/** 是否复验证据（默认 false：需要读工作区文件，必须显式开启）。 */
	readonly verifyEvidence?: boolean;
	/** 是否现场采集 Git 快照（默认 false：不隐式启动子进程）。 */
	readonly probeVcs?: boolean;
	readonly limits?: Partial<ProjectServiceLimits>;
	readonly now?: number;
	/**
	 * **M1 条目数组**的 UTF-8 字节预算（不是整个视图 JSON 的预算）。
	 *
	 * 视图外壳（problems/gaps/evidenceChecks）另有独立上限：极小额度只保证
	 * `decision.items` 为空，外壳仍然是一个合法、受控的 JSON 对象。
	 */
	readonly maxOutputBytes?: number;
};

/** 有界数组：超过上限时截断并记录维度名（不静默丢弃）。 */
function boundArray<T>(items: readonly T[], limit: number, name: string, truncated: string[]): T[] {
	if (items.length <= limit) return [...items];
	truncated.push(`${name}:${items.length}>${limit}`);
	return items.slice(0, limit);
}

function identityValue(profile: ProjectProfile, field: IdentityFieldName): string | null {
	return profile.identity[field].value;
}

function confirmedOrCandidate(profile: ProjectProfile, field: IdentityFieldName): "confirmed" | "candidate" | "unknown" {
	return profile.identity[field].status;
}

function factKeyOf(field: IdentityFieldName | "buildTargets" | "keyEntryPoints"): string {
	return `${FACT_PREFIX}.${field}`;
}

/** 一条档案字段事实（`project-profile` 族的字段粒度）。 */
function profileFieldCandidate(input: { profile: ProjectProfile; workspaceId: string; field: IdentityFieldName; target: MemoryScopeDeclaration }): MemoryCandidate | null {
	const value = identityValue(input.profile, input.field);
	if (value === null) return null; // 明确"未知"的字段不产生事实：没有值就没有可比较的候选
	const status = confirmedOrCandidate(input.profile, input.field);
	const factKey = factKeyOf(input.field);
	const confirmedFields: MemoryConfirmedField[] = [{ field: factKey, value, status: status === "confirmed" ? "confirmed" : "candidate" }];
	return {
		family: "project-profile",
		recordId: input.profile.id,
		revision: input.profile.revision,
		authority: "authoritative-read",
		sourceFingerprint: null,
		status: "unknown",
		scope: input.target,
		reuse: { level: "current-project", customers: [], authorization: null },
		time: { occurredAt: null, recordedAt: input.profile.updatedAt, effectiveFrom: null, effectiveTo: null },
		confirmedFields,
		validations: [],
		evidence: evidenceToMemory(input.profile.identity[input.field].evidence, input.workspaceId),
		dependencySnapshot: null,
		derivedFromSummaryOf: null,
		factKey,
		value,
		title: null,
	};
}

/** 数组型字段（buildTargets / keyEntryPoints）：同字段的多条目合成**一条**事实，避免互相假冲突。 */
function profileArrayCandidate(input: { profile: ProjectProfile; workspaceId: string; field: "buildTargets" | "keyEntryPoints"; target: MemoryScopeDeclaration }): MemoryCandidate | null {
	const entries = input.field === "buildTargets" ? input.profile.buildTargets : input.profile.keyEntryPoints;
	const valued = entries.filter((entry) => entry.value !== null);
	if (valued.length === 0) return null;
	const values = [...new Set(valued.map((entry) => entry.value as string))].sort();
	const allConfirmed = valued.every((entry) => entry.status === "confirmed");
	const factKey = factKeyOf(input.field);
	return {
		family: "project-profile",
		recordId: input.profile.id,
		revision: input.profile.revision,
		authority: "authoritative-read",
		sourceFingerprint: null,
		status: "unknown",
		scope: input.target,
		reuse: { level: "current-project", customers: [], authorization: null },
		time: { occurredAt: null, recordedAt: input.profile.updatedAt, effectiveFrom: null, effectiveTo: null },
		confirmedFields: [{ field: factKey, value: values.join(","), status: allConfirmed ? "confirmed" : "candidate" }],
		validations: [],
		evidence: evidenceToMemory(
			valued.flatMap((entry) => entry.evidence),
			input.workspaceId,
		),
		dependencySnapshot: null,
		derivedFromSummaryOf: null,
		factKey,
		value: values.join(","),
		title: null,
	};
}

/**
 * 证据引用 → M1 证据视图。
 *
 * 只带上"属于本工作区或未标注工作区"的证据：别的 worktree 的路径与 hash 不能冒充本工作区的当前状态。
 */
function evidenceToMemory(evidence: readonly EvidenceRef[], workspaceId: string): MemoryEvidenceRef[] {
	return evidence
		.filter((entry) => entry.workspaceId === undefined || entry.workspaceId === workspaceId)
		.slice(0, MAX_EVIDENCE_PER_FACT)
		.map((entry) => ({ validity: entry.validity === "active" ? ("active" as const) : entry.validity === "stale" ? ("stale" as const) : ("unavailable" as const), contentHash: entry.contentHash ?? null }));
}

/** 属于本工作区、且会被带去复验的那部分证据（与 `evidenceToMemory` 同一过滤口径）。 */
function ownEvidence(evidence: readonly EvidenceRef[], workspaceId: string): EvidenceRef[] {
	return evidence.filter((entry) => entry.workspaceId === undefined || entry.workspaceId === workspaceId).slice(0, MAX_EVIDENCE_PER_FACT);
}

/** 复验状态 → M1 证据有效性。`not-verifiable` 保持原声明（没有可比较的字节，不额外判漂移）。 */
function statusToValidity(status: EvidenceCheck["status"], fallback: MemoryEvidenceRef["validity"]): MemoryEvidenceRef["validity"] | null {
	if (status === "valid") return "active";
	if (status === "changed") return "stale";
	if (status === "missing" || status === "unreadable") return "unavailable";
	// 没看过（预算/超限）按"待复核"处理：没看过不等于没变化。
	if (status === "not-checked") return "stale";
	if (status === "not-verifiable") return fallback;
	return null;
}

/**
 * 用**属于该事实**的复验结果覆盖它的证据列表。
 *
 * 旧实现把整份检查结果套到每条候选上，于是"b.dec 变了"会让 boardName 也漂移（R28-2）。
 * 这里按**下标**对齐（同一个事实键的条目与检查同序产出），缺少结果的按"待复核"处理：
 * 预算上限会让尾部条目没有结果，但那不等于"没变化"。
 */
function applyEvidenceChecksForFact(base: readonly MemoryEvidenceRef[], checks: readonly EvidenceCheck[]): MemoryEvidenceRef[] {
	if (base.length === 0) return [];
	const mapped = base.map((entry, index) => {
		const check = checks[index];
		if (check === undefined) return "stale" as const;
		return statusToValidity(check.status, entry.validity);
	});
	return mapped.filter((validity): validity is MemoryEvidenceRef["validity"] => validity !== null).map((validity) => ({ validity, contentHash: null }));
}

function detectionCandidates(detection: DetectProjectResult, scope: MemoryScopeDeclaration): MemoryCandidate[] {
	const byField = new Map<"buildTargets" | "keyEntryPoints", DetectProjectResult["candidates"][number][]>();
	for (const candidate of detection.candidates) {
		const bucket = byField.get(candidate.field);
		if (bucket === undefined) byField.set(candidate.field, [candidate]);
		else bucket.push(candidate);
	}
	const result: MemoryCandidate[] = [];
	for (const [field, candidates] of byField) {
		const values = [...new Set(candidates.map((candidate) => candidate.value))].sort();
		const factKey = factKeyOf(field);
		result.push({
			// 检测结果的记录身份是**检测本身**（工作区 + 采集时间），不是某条磁盘记录。
			family: "detected-candidate",
			recordId: `${detection.workspaceId}-${detection.capturedAt}`,
			revision: 0,
			authority: "authoritative-read",
			sourceFingerprint: null,
			status: "unknown",
			scope,
			reuse: { level: "current-project", customers: [], authorization: null },
			time: { occurredAt: null, recordedAt: detection.capturedAt, effectiveFrom: null, effectiveTo: null },
			confirmedFields: [{ field: factKey, value: values.join(","), status: "candidate" }],
			validations: [],
			evidence: candidates.slice(0, 8).map((candidate) => ({ validity: "active" as const, contentHash: candidate.evidence.contentHash })),
			dependencySnapshot: null,
			derivedFromSummaryOf: null,
			factKey,
			value: values.join(","),
			title: null,
		});
	}
	return result;
}

/** 检测候选携带的可复核证据（相对路径 + 采集 hash）→ 通用证据引用。 */
function detectionEvidenceRefs(detection: DetectProjectResult, field: "buildTargets" | "keyEntryPoints", workspaceId: string): EvidenceVerificationEntry[] {
	return detection.candidates
		.filter((candidate) => candidate.field === field)
		.slice(0, 8)
		.map((candidate) => ({
			key: factKeyOf(candidate.field),
			evidence: {
				type: "source-file" as const,
				workspaceId,
				relativePath: candidate.evidence.relativePath,
				contentHash: candidate.evidence.contentHash,
				capturedAt: candidate.evidence.capturedAt,
				validity: "active" as const,
			},
		}));
}

/** 只有一个确认值时才敢把它当"当前目标"；多个/未确认 ⇒ 不猜。 */
function singleConfirmed(profile: ProjectProfile, field: "buildTargets"): string | null {
	const confirmed = profile.buildTargets.filter((entry) => entry.status === "confirmed" && entry.value !== null);
	return confirmed.length === 1 ? (confirmed[0]?.value ?? null) : null;
}

function targetScope(profile: ProjectProfile, workspaceId: string): MemoryScopeDeclaration {
	const board = identityValue(profile, "boardName");
	return {
		projectId: profile.id,
		workspaceId,
		customerId: identityValue(profile, "customer"),
		// 板名没有合法规则确认时保持 null：目标侧不知道就不作判断。
		boardName: confirmedOrCandidate(profile, "boardName") === "confirmed" ? board : null,
		boardRevision: confirmedOrCandidate(profile, "boardRevision") === "confirmed" ? identityValue(profile, "boardRevision") : null,
		buildTarget: singleConfirmed(profile, "buildTargets"),
	};
}

export async function readProjectView(input: ReadProjectViewInput): Promise<ProjectDecisionView> {
	const limits = resolveProjectLimits(input.limits);
	const now = input.now ?? Date.now();
	const open = await openProjectProfile(input);

	const base: ProjectDecisionView = {
		status: "not-usable",
		open,
		decision: null,
		detection: null,
		evidenceChecks: [],
		evidenceUnchecked: 0,
		evidenceUncheckedReasons: [],
		evidenceUnverifiedFacts: [],
		gaps: open.profile?.gaps ?? [],
		problems: open.problems.map((problem) => `${problem.code}: ${problem.detail}`),
		shellTruncated: [],
		revisions: { registry: open.registryRevision, profile: open.profileRevision },
		workspaceVcs: open.workspace?.vcs === undefined ? null : { branch: open.workspace.vcs.branch, head: open.workspace.vcs.head },
		headChanged: false,
		branchChanged: false,
	};
	if (!open.usable || open.profile === null || open.workspaceId === null || open.workspacePath === null) return base;

	const profile = open.profile;
	const workspaceId = open.workspaceId;
	const problems: string[] = [];
	const gapList: FieldGap[] = [...profile.gaps];

	// 现场采集：只有显式要求时才启子进程（库默认不做隐式 IO）。
	let currentVcs: { branch: string | null; head: string | null } | null = null;
	if (input.probeVcs === true) {
		const snapshot = await captureWorkspaceSnapshot({ workspacePath: open.workspacePath, workspaceId, cwd: input.cwd, authorizedRoots: input.authorizedRoots, now, signal: input.signal, limits: input.limits });
		problems.push(...snapshot.problems);
		if (snapshot.vcs !== null) currentVcs = { branch: snapshot.vcs.branch, head: snapshot.vcs.head };
	}

	let detection: DetectProjectResult | null = null;
	if (input.detect === true) {
		detection = await detectProjectCandidates({ workspacePath: open.workspacePath, workspaceId, cwd: input.cwd, authorizedRoots: input.authorizedRoots, limits: input.limits, signal: input.signal, now });
		for (const gap of detection.gaps) {
			if (!gapList.some((existing) => existing.field === gap.field)) gapList.push(gap);
		}
		problems.push(...detection.problems);
	}

	// 证据复验：**按事实键分组**下发，结果也按事实键收回。
	let evidenceResult: VerifyEvidenceResult | null = null;
	/** 每个事实键下发了多少条证据：用于判断"哪些事实的证据没有被真正比较过"。 */
	const entriesPerFact = new Map<string, number>();
	if (input.verifyEvidence === true) {
		const entries: EvidenceVerificationEntry[] = [];
		for (const field of IDENTITY_FIELD_NAMES) {
			const key = factKeyOf(field);
			for (const evidence of ownEvidence(profile.identity[field].evidence, workspaceId)) entries.push({ key, evidence });
		}
		for (const field of ["buildTargets", "keyEntryPoints"] as const) {
			const key = factKeyOf(field);
			const source = field === "buildTargets" ? profile.buildTargets : profile.keyEntryPoints;
			for (const entry of source) {
				for (const evidence of ownEvidence(entry.evidence, workspaceId)) entries.push({ key, evidence });
			}
		}
		if (detection !== null) {
			entries.push(...detectionEvidenceRefs(detection, "buildTargets", workspaceId));
			entries.push(...detectionEvidenceRefs(detection, "keyEntryPoints", workspaceId));
		}
		for (const entry of entries) entriesPerFact.set(entry.key, (entriesPerFact.get(entry.key) ?? 0) + 1);
		evidenceResult = await verifyEvidenceRefs({ workspacePath: open.workspacePath, cwd: input.cwd, authorizedRoots: input.authorizedRoots, entries, signal: input.signal, limits: input.limits });
		for (const check of evidenceResult.checks) {
			if (check.status === "changed" || check.status === "missing" || check.status === "unreadable" || check.status === "not-checked") problems.push(`证据 [${check.key}] ${check.relativePath ?? "?"}：${check.detail}`);
		}
		if (evidenceResult.truncated) problems.push(`${evidenceResult.uncheckedCount} 条证据因预算/超限未复验，视图不完整（${evidenceResult.uncheckedReasons.join("、")}）`);
	}
	const evidenceChecks = evidenceResult?.checks ?? [];

	const scope = targetScope(profile, workspaceId);
	const candidates: MemoryCandidate[] = [];
	for (const field of IDENTITY_FIELD_NAMES) {
		const candidate = profileFieldCandidate({ profile, workspaceId, field, target: scope });
		if (candidate !== null) candidates.push(candidate);
	}
	for (const field of ["buildTargets", "keyEntryPoints"] as const) {
		const candidate = profileArrayCandidate({ profile, workspaceId, field, target: scope });
		if (candidate !== null) candidates.push(candidate);
	}
	if (detection !== null) candidates.push(...detectionCandidates(detection, scope));

	// 证据复验结果**只覆盖它所属的那个事实**（不改档案，只影响本次视图）。
	const withChecks = evidenceResult === null ? candidates : candidates.map((candidate) => ({ ...candidate, evidence: candidate.factKey === null ? candidate.evidence : applyEvidenceChecksForFact(candidate.evidence, checksForKey(evidenceChecks, candidate.factKey)) }));

	// 依赖快照：**声明侧 = 档案里记录的采集时刻快照**（上次绑定/刷新时的 HEAD），
	// **目标侧 = 本次读到的当前状态**。两边都取当前值就永远不会漂移，等于没做这件事。
	const declaredSnapshot = {
		commit: open.workspace?.vcs?.head ?? null,
		boardRevision: scope.boardRevision,
		buildTarget: scope.buildTarget,
		contentHashes: [] as string[],
	};
	const currentSnapshot = {
		commit: currentVcs?.head ?? declaredSnapshot.commit,
		boardRevision: scope.boardRevision,
		buildTarget: scope.buildTarget,
		contentHashes: [] as string[],
	};
	const headChanged = declaredSnapshot.commit !== null && currentSnapshot.commit !== null && declaredSnapshot.commit !== currentSnapshot.commit;
	const declaredBranch = open.workspace?.vcs?.branch ?? null;
	const currentBranch = currentVcs?.branch ?? declaredBranch;
	const branchChanged = declaredBranch !== currentBranch;
	if (headChanged) problems.push("工作区 HEAD 与档案记录的采集时刻不同，依赖该检出的结论需要复核");
	if (branchChanged) problems.push("工作区分支与档案记录不同，结论需要复核");

	const decorated = withChecks.map((candidate) => ({ ...candidate, dependencySnapshot: declaredSnapshot }));

	const query: MemoryQuery = {
		intent: "current",
		now,
		candidates: decorated,
		relations: [],
		// 本项目自己的知识：端点允许；不启用跨项目复用，因此不需要 internal-general 授权。
		authorization: { endpointAllowed: true, allowInternalGeneral: false, customers: [] },
		target: { scope, snapshot: currentSnapshot },
	};
	const decision = decideMemory(input.maxOutputBytes === undefined ? query : { ...query, limits: { maxOutputBytes: input.maxOutputBytes } });

	// 部分结果必须可见：证据/检测没跑完时，不能因为 M1 自己说 ok 就报 ok。
	const incomplete = decision.status === "incomplete" || evidenceResult?.truncated === true || detection?.truncated === true;
	// 只有"真正比较过"的状态才算复验过；没拿到结果的（预算截断）也算未复验。
	// 未复验的事实不能借别的字段的 valid 升为当前（R28-2）。
	const comparedStatuses = new Set(["valid", "changed", "missing", "unreadable"]);
	const unverifiedFacts = [...entriesPerFact.keys()].filter((key) => checksForKey(evidenceChecks, key).filter((check) => comparedStatuses.has(check.status)).length < (entriesPerFact.get(key) ?? 0));
	const shellTruncated: string[] = [];
	const boundedProblems = boundArray(problems, limits.maxViewProblems, "problems", shellTruncated);
	const boundedGaps = boundArray(gapList, limits.maxViewGaps, "gaps", shellTruncated);
	const boundedChecks = boundArray(evidenceChecks, limits.maxEvidenceEntries, "evidenceChecks", shellTruncated);

	return {
		status: incomplete ? "incomplete" : "ok",
		open,
		decision,
		detection,
		evidenceChecks: boundedChecks,
		evidenceUnchecked: evidenceResult?.uncheckedCount ?? 0,
		evidenceUncheckedReasons: evidenceResult?.uncheckedReasons ?? [],
		evidenceUnverifiedFacts: unverifiedFacts,
		gaps: boundedGaps,
		problems: boundedProblems,
		shellTruncated,
		revisions: { registry: open.registryRevision, profile: open.profileRevision },
		workspaceVcs: currentVcs ?? (open.workspace?.vcs === undefined ? null : { branch: open.workspace.vcs.branch, head: open.workspace.vcs.head }),
		headChanged,
		branchChanged,
	};
}

/** 汇总证据复验的"最差状态"（供 CLI 一行提示）。 */
export function describeEvidence(result: VerifyEvidenceResult): string {
	const summary = summarizeEvidenceChecks(result);
	return `evidence=${summary.worst}（变化 ${summary.changedCount}、缺失/不可读 ${summary.missingCount}${result.truncated ? `、未复验 ${result.uncheckedCount}` : ""}）`;
}
