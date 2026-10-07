/**
 * AW-02：**项目摘要/证据候选的自动准备**（只写候选与来源，不写 confirmed）。
 *
 * 三件事，每件都必须是真实读取的结果：
 * 1. **代码基线**：Git 分支 + HEAD（用既有 `probeGitSnapshot`，不 fetch/pull）；
 * 2. **构建入口候选**：复用既有 `detectProjectCandidates`（真读 `.dsc`/`.dec` 并解析，
 *    不执行源码树里的任何脚本）；
 * 3. **IBV/芯片线索**：对**已选中的构建描述文件**再做一次有界读取，只扫描明确的厂商关键词，
 *    结果标成 `clue`（弱证据），**不**当成身份字段。
 *
 * 增量：基线（分支 + HEAD）未变时返回 `unchanged`，不重新扫描整仓。
 * 冲突：新候选与已确认字段的差异由调用方呈现为"待复核"，本模块不覆盖确认值。
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { isWithinAuthorizedRoot } from "../projects/authorization.ts";
import { detectProjectCandidates, type DetectionCandidate, type DetectionGap } from "../projects/detection.ts";
import { assertSafeRelativePath, resolveProjectLimits, toPosixRelative, type ProjectServiceLimits } from "../projects/contract.ts";
import { probeGitSnapshot, readFileBounded } from "../projects/workspace.ts";
import type { CodeBaseline, SummaryBaseline, SummaryCandidateRef, SummaryClueRef } from "./contract.ts";

/** 弱线索：只说明"在这些字节里出现过这个关键词"，不能当身份确认。 */
export type SummaryClue = {
	readonly field: "ibv" | "chipsetVendor" | "architecture";
	readonly value: string;
	readonly keyword: string;
	readonly relativePath: string;
	readonly contentHash: string;
	/** 固定的证据强度标记：`clue` 永远不等于 `confirmed`。 */
	readonly strength: "clue";
};

export type SummaryScanResult = {
	/** `unchanged` = 基线未变，本次没有重新扫描；`partial` = 命中预算，候选可能不完整。 */
	readonly status: "ok" | "unchanged" | "partial" | "unreachable";
	readonly baseline: CodeBaseline;
	readonly candidates: readonly DetectionCandidate[];
	readonly clues: readonly SummaryClue[];
	readonly gaps: readonly DetectionGap[];
	readonly scannedFiles: number;
	readonly totalBytes: number;
	readonly truncated: boolean;
	readonly problems: readonly string[];
	readonly reason: string | null;
	/**
	 * `unchanged` 时从上一轮基线复用的有界候选（R7：**不为空**，因此下一对话仍能拿到有证据背景）。
	 * 其它状态为 null（本次是真实扫描结果，见 `candidates`/`clues`）。
	 */
	readonly reused: { readonly candidates: readonly SummaryCandidateRef[]; readonly clues: readonly SummaryClueRef[]; readonly gaps: readonly string[] } | null;
};

export type SummaryScanInput = {
	readonly workspacePath: string;
	readonly workspaceId: string;
	/** 本次会话目录（授权判定的依据之一）。 */
	readonly cwd: string;
	readonly authorizedRoots?: readonly string[];
	/** 上一次的摘要基线；给出且与当前一致时跳过重扫。 */
	readonly previous?: SummaryBaseline | null;
	/** 强制重扫（例如工程师显式要求复核）。 */
	readonly force?: boolean;
	readonly limits?: Partial<ProjectServiceLimits>;
	readonly signal?: AbortSignal;
	readonly now?: number;
};

/** 厂商关键词表：只用来产生弱线索，命中即记录，**不**据此确认 IBV。 */
const VENDOR_KEYWORDS: readonly { readonly field: SummaryClue["field"]; readonly value: string; readonly pattern: RegExp }[] = [
	{ field: "ibv", value: "AMI", pattern: /\baptio\b|\bami\b/i },
	{ field: "ibv", value: "Insyde", pattern: /\binsyde\b|\bh2o\b/i },
	{ field: "ibv", value: "Byosoft", pattern: /\bbyosoft\b|百敖/i },
	{ field: "ibv", value: "EDK2/UEFI", pattern: /\bedk2\b|\buefi\b/i },
	{ field: "chipsetVendor", value: "Intel", pattern: /\bintel\b/i },
	{ field: "chipsetVendor", value: "AMD", pattern: /\bamd\b/i },
	{ field: "chipsetVendor", value: "Qualcomm", pattern: /\bqualcomm\b|\bqcom\b/i },
	{ field: "architecture", value: "X64", pattern: /\bX64\b/ },
	{ field: "architecture", value: "AARCH64", pattern: /\bAARCH64\b/i },
];

const MAX_CLUE_FILES = 4;

/** 采集代码基线（Git 分支 + HEAD）。非 Git/不可达时不猜，如实给 null 与原因。 */
export async function captureBaseline(input: { readonly workspacePath: string; readonly signal?: AbortSignal; readonly now?: number; readonly fileHashes?: Readonly<Record<string, string>> }): Promise<CodeBaseline> {
	const snapshot = await probeGitSnapshot({ cwd: input.workspacePath, signal: input.signal });
	return {
		workspacePath: input.workspacePath,
		branch: snapshot.branch,
		commit: snapshot.head,
		fileHashes: input.fileHashes ?? {},
		capturedAt: input.now ?? Date.now(),
	};
}

/**
 * 基线的**廉价**判定：只看分支与 HEAD。
 *
 * 这**不充分**（R7：HEAD 不变但相关脏文件改变也必须重验），所以只用于快速短路；
 * `scanProjectSummary` 用的是 `summaryBaselineChanged`（含相关文件哈希重验）。
 */
export function baselineChanged(previous: SummaryBaseline | null | undefined, current: CodeBaseline): boolean {
	if (previous === null || previous === undefined) return true;
	return previous.branch !== current.branch || previous.commit !== current.commit;
}

/** 参与哈希重验的相关文件上限（P2：只重验少量关键文件，不重扫全仓）。 */
const MAX_EVIDENCE_FILES = 24;

/** 有界读取单个相对路径并算内容 SHA-256；不可读时返回 null（如实降级，不猜）。 */
async function hashRelativeFile(workspacePath: string, relativePath: string, limits: ProjectServiceLimits, signal?: AbortSignal): Promise<string | null> {
	try {
		const safe = assertSafeRelativePath(relativePath);
		const absolute = join(workspacePath, ...safe.split("/"));
		if (!isWithinAuthorizedRoot(workspacePath, absolute)) return null;
		const read = await readFileBounded(absolute, limits.maxDetectFileBytes, signal, "摘要重验已取消");
		if (!read.ok) return null;
		return createHash("sha256").update(read.bytes).digest("hex");
	} catch {
		return null;
	}
}

/**
 * R7：**完整**的增量判定。
 *
 * 需要重扫（`true`）的情况：
 * - 没有上一轮基线，或上一轮是旧格式（没有可复用候选）；
 * - 分支/HEAD 变化；
 * - 上一轮记录的相关文件**内容哈希变化**（Git HEAD 不变但脏文件改了、或非 Git 工程直接改了文件）；
 * - 上次扫描受限（`partial`）而这次可能取得更多信息；
 * - 上一轮没有记录任何相关文件（无法用哈希判定 ⇒ 保守重扫）。
 */
export async function summaryBaselineChanged(input: { readonly workspacePath: string; readonly previous: SummaryBaseline | null | undefined; readonly current: CodeBaseline; readonly limits: ProjectServiceLimits; readonly signal?: AbortSignal }): Promise<{ readonly changed: boolean; readonly reason: string | null }> {
	const previous = input.previous;
	if (previous === null || previous === undefined) return { changed: true, reason: "没有上一轮基线" };
	if (previous.candidates === undefined) return { changed: true, reason: "上一轮基线是旧格式（没有可复用候选）：必须重扫" };
	if (previous.branch !== input.current.branch || previous.commit !== input.current.commit) return { changed: true, reason: "分支或 HEAD 变化" };
	if (previous.partial === true) return { changed: true, reason: "上一轮扫描受限：重扫以补齐候选" };
	const recorded = previous.evidenceFiles ?? Object.keys(previous.fileHashes ?? {});
	if (recorded.length === 0) return { changed: true, reason: "上一轮没有记录相关文件：无法用哈希判定" };
	for (const relativePath of recorded.slice(0, MAX_EVIDENCE_FILES)) {
		const actual = await hashRelativeFile(input.workspacePath, relativePath, input.limits, input.signal);
		const expected = (previous.fileHashes ?? {})[relativePath];
		if (actual === null) return { changed: true, reason: `相关文件当前不可读：${relativePath}` };
		if (expected !== undefined && actual !== expected) return { changed: true, reason: `相关文件内容变化：${relativePath}` };
	}
	return { changed: false, reason: null };
}

/** 把扫描结果收敛成可持久化的基线（含关键文件 hash、有界候选与线索引用）。 */
export function toSummaryBaseline(result: { readonly baseline: CodeBaseline; readonly candidates: readonly DetectionCandidate[]; readonly truncated: boolean; readonly clues?: readonly SummaryClue[]; readonly gaps?: readonly { readonly field: string; readonly reason: string }[] }): SummaryBaseline {
	const fileHashes: Record<string, string> = {};
	const evidence = new Set<string>();
	for (const candidate of result.candidates) {
		fileHashes[candidate.evidence.relativePath] = candidate.evidence.contentHash;
		evidence.add(candidate.evidence.relativePath);
	}
	for (const clue of result.clues ?? []) {
		if (fileHashes[clue.relativePath] === undefined) fileHashes[clue.relativePath] = clue.contentHash;
		evidence.add(clue.relativePath);
	}
	return {
		capturedAt: result.baseline.capturedAt,
		branch: result.baseline.branch,
		commit: result.baseline.commit,
		fileHashes,
		partial: result.truncated,
		candidates: result.candidates.slice(0, 64).map((candidate) => ({ field: candidate.field, value: candidate.value, relativePath: candidate.evidence.relativePath, contentHash: candidate.evidence.contentHash })),
		clues: (result.clues ?? []).slice(0, 32).map((clue) => ({ field: clue.field, value: clue.value, keyword: clue.keyword, relativePath: clue.relativePath, contentHash: clue.contentHash })),
		gaps: (result.gaps ?? []).slice(0, 32).map((gap) => `${gap.field}: ${gap.reason}`),
		evidenceFiles: [...evidence].slice(0, MAX_EVIDENCE_FILES),
	};
}

/** 从上一轮基线里取回可复用的有界候选（R7：next 对话不必重扫）。 */
export function reusableSummary(input: SummaryBaseline | null | undefined): { readonly candidates: readonly SummaryCandidateRef[]; readonly clues: readonly SummaryClueRef[]; readonly gaps: readonly string[] } | null {
	if (input === null || input === undefined || input.candidates === undefined) return null;
	return { candidates: input.candidates, clues: input.clues ?? [], gaps: input.gaps ?? [] };
}

async function collectClues(input: { readonly workspacePath: string; readonly candidates: readonly DetectionCandidate[]; readonly signal?: AbortSignal; readonly limits: ProjectServiceLimits }): Promise<{ clues: SummaryClue[]; problems: string[]; bytes: number }> {
	const clues: SummaryClue[] = [];
	const problems: string[] = [];
	let bytes = 0;
	const seen = new Set<string>();
	for (const candidate of input.candidates) {
		if (clues.length > 0 && seen.size >= MAX_CLUE_FILES) break;
		const relativePath = candidate.evidence.relativePath;
		if (seen.has(relativePath)) continue;
		seen.add(relativePath);
		if (seen.size > MAX_CLUE_FILES) break;
		const safe = assertSafeRelativePath(relativePath);
		const absolute = join(input.workspacePath, ...safe.split("/"));
		// 纵深防御：路径必须是工作区内的真实相对路径（detection 已经验证过一次）。
		if (!isWithinAuthorizedRoot(input.workspacePath, absolute)) continue;
		const read = await readFileBounded(absolute, input.limits.maxDetectFileBytes, input.signal, "摘要线索扫描已取消");
		if (!read.ok) {
			problems.push(`${relativePath}: ${read.detail}`);
			continue;
		}
		bytes += read.bytes.byteLength;
		const text = read.bytes.toString("utf8");
		for (const keyword of VENDOR_KEYWORDS) {
			if (!keyword.pattern.test(text)) continue;
			clues.push({ field: keyword.field, value: keyword.value, keyword: keyword.value, relativePath: toPosixRelative(safe), contentHash: candidate.evidence.contentHash, strength: "clue" });
		}
	}
	// 同一字段同一值只留一条（来源路径取第一条）。
	const unique = new Map<string, SummaryClue>();
	for (const clue of clues) {
		const key = `${clue.field}:${clue.value}`;
		if (!unique.has(key)) unique.set(key, clue);
	}
	return { clues: [...unique.values()], problems, bytes };
}

/**
 * 扫描项目摘要候选。
 *
 * 顺序：基线 → 增量判定 → 有界检测 → 弱线索。任何一步失败都如实降级（`partial`/`unreachable`），
 * 不假装"识别完成"。
 */
export async function scanProjectSummary(input: SummaryScanInput): Promise<SummaryScanResult> {
	const limits = resolveProjectLimits(input.limits);
	const now = input.now ?? Date.now();
	const baselineProbe = await probeGitSnapshot({ cwd: input.workspacePath, signal: input.signal });
	const baseline: CodeBaseline = { workspacePath: input.workspacePath, branch: baselineProbe.branch, commit: baselineProbe.head, fileHashes: {}, capturedAt: now };
	if (input.force !== true) {
		const verdict = await summaryBaselineChanged({ workspacePath: input.workspacePath, previous: input.previous, current: baseline, limits, signal: input.signal });
		if (!verdict.changed) {
			// R7：unchanged 时把上一轮的**有界候选**一起交回，下一对话不需要重扫也能拿到有证据背景。
			return { status: "unchanged", baseline, candidates: [], clues: [], gaps: [], scannedFiles: 0, totalBytes: 0, truncated: false, problems: [], reason: "分支/HEAD 与相关文件均未变化：未重新扫描", reused: reusableSummary(input.previous) };
		}
	}
	if (!baselineProbe.isGit && baselineProbe.problems.length > 0) {
		// 非 Git 不是失败：仍然可以检测构建描述文件，但必须说明"没有 Git 基线"。
	}
	let detection: Awaited<ReturnType<typeof detectProjectCandidates>>;
	try {
		detection = await detectProjectCandidates({ workspacePath: input.workspacePath, workspaceId: input.workspaceId, cwd: input.cwd, authorizedRoots: input.authorizedRoots, limits: input.limits, signal: input.signal, now });
	} catch (error) {
		const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code) : "unknown";
		return {
			status: "unreachable",
			baseline,
			candidates: [],
			clues: [],
			gaps: [],
			scannedFiles: 0,
			totalBytes: 0,
			truncated: true,
			problems: [...baselineProbe.problems.slice(0, 4), `项目检测不可用（${code}）`],
			reason: "工作区不可达或未授权：不声称识别完成",
			reused: null,
		};
	}
	const clueResult = await collectClues({ workspacePath: input.workspacePath, candidates: detection.candidates, signal: input.signal, limits });
	const fileHashes: Record<string, string> = {};
	for (const candidate of detection.candidates) fileHashes[candidate.evidence.relativePath] = candidate.evidence.contentHash;
	const problems = [...detection.problems.slice(0, 6), ...clueResult.problems.slice(0, 4), ...baselineProbe.problems.slice(0, 2)];
	const partial = detection.truncated || problems.length > 0;
	return {
		status: partial ? "partial" : "ok",
		baseline: { ...baseline, fileHashes },
		candidates: detection.candidates,
		clues: clueResult.clues,
		gaps: detection.gaps,
		scannedFiles: detection.scannedFiles,
		totalBytes: detection.totalBytes + clueResult.bytes,
		truncated: detection.truncated,
		problems,
		reason: detection.truncated ? `本次检测命中预算（${detection.truncatedBy.join("、")}），候选可能不完整` : null,
		reused: null,
	};
}
