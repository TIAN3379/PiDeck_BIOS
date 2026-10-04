/**
 * BM-03 B2：**有限检测候选与资料缺口**。
 *
 * 只做三件事，且每件都真实（不是"给测试对象预填候选就声称检测完成"）：
 * 1. 复用既有的只读目录线索探测拿到**有限**的构建设描述文件样例；
 * 2. 真读文件内容并按明确格式解析：EDK II `.dsc` 的 `[Defines] PLATFORM_NAME`、
 *    `!include` 目标、`.dec` 的 `PACKAGE_NAME`；
 * 3. 把结果落成**候选**（`status = candidate`），并显式列出没有合法规则的身份字段缺口。
 *
 * 三条"不许猜"（设计 §3.2.2 + 本轮 B2 要求）：
 * - 平台名 **不等于** 客户板名：`PLATFORM_NAME` 只进 `buildTargets` 候选；
 * - 看到 `.dsc`/`.inf` **不能**推断 AMI/Insyde/百敖，更不能推断芯片代际；
 * - 没有合法规则的身份字段保持 `unknown`，只给"需要什么资料"的缺口。
 *
 * 本模块**只读**：不调用任何写入 API，也不修改传入的 profile。
 */
import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { isWithinAuthorizedRoot } from "./authorization.ts";
import { probeProjectDirectory, type ProjectProbeResult } from "./probe.ts";
import { assertSafeRelativePath, invalidArgument, optionalAbsolutePath, ProjectServiceError, requireBoundedText, resolveProjectLimits, toPosixRelative, type ProjectServiceLimits } from "./contract.ts";
import { assertWorkspaceAuthorized, readFileBounded } from "./workspace.ts";

/** 检测规则标识（每条候选都必须能说出"是谁算出来的"）。 */
export type DetectionRule = "edk2-dsc-platform-name" | "edk2-dsc-include" | "edk2-dec-package-name";
export const DETECTION_RULES: readonly DetectionRule[] = ["edk2-dsc-platform-name", "edk2-dsc-include", "edk2-dec-package-name"];

/** 候选的落点字段：**故意**只有这三个，避免"解析到什么就写什么"。 */
export type DetectionField = "buildTargets" | "keyEntryPoints";

export type DetectionEvidence = {
	readonly workspaceId: string;
	readonly relativePath: string;
	/** 实际采集时间（由适配层传入或记录当次时间，**不用** updatedAt 猜业务生效期）。 */
	readonly capturedAt: number;
	/** 被解析文件的 SHA-256（内容锚定，不用行号冒充当前实现）。 */
	readonly contentHash: string;
	readonly line: number;
};

export type DetectionCandidate = {
	readonly field: DetectionField;
	readonly value: string;
	readonly rule: DetectionRule;
	readonly evidence: DetectionEvidence;
};

export type DetectionGap = { readonly field: string; readonly reason: string; readonly hint?: string };

export type DetectProjectInput = {
	readonly workspacePath: string;
	readonly workspaceId: string;
	/** 本次会话的授权范围（必填）：读取工作区文件前先判定（R28-4）。 */
	readonly cwd: string;
	readonly authorizedRoots?: readonly string[];
	readonly limits?: Partial<ProjectServiceLimits>;
	readonly signal?: AbortSignal;
	/** 采集时间（epoch ms），默认 `Date.now()`。 */
	readonly now?: number;
};

export type DetectProjectResult = {
	readonly workspaceId: string;
	readonly workspacePath: string;
	readonly capturedAt: number;
	readonly candidates: readonly DetectionCandidate[];
	readonly gaps: readonly DetectionGap[];
	readonly scannedFiles: number;
	readonly totalBytes: number;
	/** true 表示命中任一预算：结果不完整，不能当成"没有更多候选"。 */
	readonly truncated: boolean;
	readonly truncatedBy: readonly ("files" | "bytes" | "candidates" | "scan")[];
	readonly problems: readonly string[];
	/** 检测是只读动作：这里如实声明没有写档案（人工确认是独立动作）。 */
	readonly wroteToProfile: false;
};

const DSC_EXTENSION = ".dsc";
const DEC_EXTENSION = ".dec";
const MAX_INCLUDE_CANDIDATES_PER_FILE = 8;
const MAX_VALUE_CHARS = 120;

function sha256(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function assertNotCancelled(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new ProjectServiceError("cancelled", "项目检测已取消");
}

/** 取值必须是有界的单行文本；超过上限的信号直接丢弃（不截断成"看起来可用"的值）。 */
function cleanValue(raw: string): string | null {
	const trimmed = raw.trim();
	if (trimmed === "" || trimmed.length > MAX_VALUE_CHARS) return null;
	// 换行/制表/控制字符说明这行不是"一个值"，宁可丢。
	if (/[\u0000-\u001f\u007f]/.test(trimmed)) return null;
	return trimmed;
}

type Section = "defines" | "other";

/**
 * 解析 EDK II `.dsc`：逐行状态机只识别 `[Defines]` 段里的 `KEY = VALUE` 与任意位置的 `!include`。
 *
 * 为什么限定在 `[Defines]`：其它段里的 `Name = Value` 是模块/库作用域，
 * 把它们当平台名会产生"看起来解析成功、实际指向别的东西"的候选。
 */
export function parseDsc(text: string): { platformName: { value: string; line: number } | null; includes: Array<{ value: string; line: number }> } {
	let section: Section = "other";
	let platformName: { value: string; line: number } | null = null;
	const includes: Array<{ value: string; line: number }> = [];
	const lines = text.split(/\r?\n/);
	for (let index = 0; index < lines.length; index += 1) {
		const raw = lines[index] ?? "";
		const line = raw.trim();
		if (line === "" || line.startsWith("#")) continue;
		const header = /^\[([A-Za-z0-9_.]+)\]$/.exec(line);
		if (header !== null) {
			section = header[1]?.toLowerCase() === "defines" ? "defines" : "other";
			continue;
		}
		const include = /^!include\s+(.+)$/.exec(line);
		if (include !== null) {
			const value = cleanValue((include[1] ?? "").split("#")[0] ?? "");
			if (value !== null && includes.length < MAX_INCLUDE_CANDIDATES_PER_FILE) includes.push({ value, line: index + 1 });
			continue;
		}
		if (section !== "defines") continue;
		const assignment = /^([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(line);
		if (assignment === null) continue;
		if (assignment[1] !== "PLATFORM_NAME") continue;
		if (platformName !== null) continue; // 同名重复：保留第一条，不猜"哪条更对"
		const value = cleanValue(assignment[2] ?? "");
		if (value !== null) platformName = { value, line: index + 1 };
	}
	return { platformName, includes };
}

/** 解析 `.dec` 的 `[Defines] PACKAGE_NAME`（包入口线索）。 */
export function parseDec(text: string): { packageName: { value: string; line: number } | null } {
	let section: Section = "other";
	let packageName: { value: string; line: number } | null = null;
	const lines = text.split(/\r?\n/);
	for (let index = 0; index < lines.length; index += 1) {
		const line = (lines[index] ?? "").trim();
		if (line === "" || line.startsWith("#")) continue;
		const header = /^\[([A-Za-z0-9_.]+)\]$/.exec(line);
		if (header !== null) {
			section = header[1]?.toLowerCase() === "defines" ? "defines" : "other";
			continue;
		}
		if (section !== "defines") continue;
		const assignment = /^PACKAGE_NAME\s*=\s*(.*)$/.exec(line);
		if (assignment === null || packageName !== null) continue;
		const value = cleanValue(assignment[1] ?? "");
		if (value !== null) packageName = { value, line: index + 1 };
	}
	return { packageName };
}

/**
 * 没有合法规则的身份字段：明确写出"为什么不知道"。
 *
 * 这张表是**产品行为**而不是文档：它保证"检测过一轮"不会让调用方以为身份已经齐了。
 */
export const UNSUPPORTED_IDENTITY_GAPS: readonly DetectionGap[] = [
	{ field: "boardName", reason: "DSC 里的 PLATFORM_NAME 是平台/包名，不能当成客户板名", hint: "提供板级目录、原理图或板卡丝印等资料后人工确认" },
	{ field: "boardRevision", reason: "构建描述文件不包含板卡版本", hint: "提供板卡版本信息（丝印/物料/BOM）后人工确认" },
	{ field: "ibv", reason: "源码目录里的 .dsc/.inf/.dec 不能推断 IBV 归属", hint: "由工程师按实际交付方确认" },
	{ field: "ibvVersion", reason: "构建描述文件不声明 IBV 版本", hint: "由工程师按实际交付方确认" },
	{ field: "chipsetVendor", reason: "看到 .inf/.dsc 不能推断芯片厂商", hint: "提供芯片组资料后人工确认" },
	{ field: "chipsetFamily", reason: "看到 .inf/.dsc 不能推断芯片家族", hint: "提供芯片组资料后人工确认" },
	{ field: "chipsetGeneration", reason: "看到 .inf/.dsc 不能推断芯片代际", hint: "提供芯片组资料后人工确认" },
	{ field: "architecture", reason: "本次规则不解析 SUPPORTED_ARCHITECTURES，避免把多架构列表当成单一架构", hint: "需要时人工确认" },
	{ field: "customer", reason: "源码目录名/平台名都不构成客户身份证据", hint: "由人工确认或由项目档案带入" },
	{ field: "productLine", reason: "源码里没有产品线语义", hint: "由人工确认" },
];

/**
 * 选择要解析的文件：只看构建设描述扩展名，按相对路径排序保证确定性。
 *
 * 返回 `sampleLimited` 而不是静默截断：目录探测对每种扩展名只保留有限样例
 * （`HINT_SAMPLE_LIMIT`），因此"选中 8 个"与"一共只有 8 个"是两件事，
 * 报告必须能区分（R28-2：选样/候选数量受限也必须可见）。
 */
function selectFiles(probe: ProjectProbeResult, extension: string, limit: number): { selected: string[]; discovered: number; sampleLimited: boolean } {
	const key = extension as keyof ProjectProbeResult["hintSamples"];
	const samples = probe.hintSamples[key] ?? [];
	const discovered = probe.hintCounts[key] ?? samples.length;
	const selected = [...samples].sort().slice(0, limit);
	return { selected, discovered, sampleLimited: discovered > selected.length };
}

export async function detectProjectCandidates(input: DetectProjectInput): Promise<DetectProjectResult> {
	if (typeof input !== "object" || input === null) throw invalidArgument("检测参数必须是对象");
	const workspacePath = optionalAbsolutePath(input.workspacePath, "工作区路径");
	if (workspacePath === undefined) throw invalidArgument("必须显式指定工作区路径");
	const workspaceId = input.workspaceId;
	if (typeof workspaceId !== "string" || workspaceId.trim() === "") throw invalidArgument("必须显式指定工作区 ID");
	const cwd = requireBoundedText(input.cwd, "会话工作目录", 4096);
	const limits: ProjectServiceLimits = resolveProjectLimits(input.limits);
	const capturedAt = input.now ?? Date.now();
	// 授权先于任何工作区访问：内部 helper 不能冒充已授权的公共入口。
	assertWorkspaceAuthorized({ cwd, authorizedRoots: input.authorizedRoots, workspacePath, context: "项目检测" });
	assertNotCancelled(input.signal);

	// 工作区根必须是真实目录：不可达时检测无从谈起（也不该"返回空候选"伪装成没有信号）。
	let workspaceReal: string;
	try {
		const stats = await stat(workspacePath);
		if (!stats.isDirectory()) throw invalidArgument("工作区路径不是目录");
		workspaceReal = await realpath(workspacePath);
	} catch (error) {
		if (error instanceof ProjectServiceError) throw error;
		throw new ProjectServiceError("not-found", `工作区目录不存在或不可访问：${workspacePath}`, { detail: "workspace-unavailable", cause: error });
	}

	assertNotCancelled(input.signal);
	// 复用既有只读探测：它已经保证"逐项有界、拒绝链接、句柄成对关闭"。
	const probe = await probeProjectDirectory(workspaceReal, {
		limits: { maxPaths: limits.maxDetectScanPaths, maxDepth: limits.maxDetectDepth },
		signal: input.signal,
	});

	const problems: string[] = probe.warnings.slice(0, 8).map((warning) => `${warning.path}: ${warning.message}`);
	if (probe.droppedWarnings > 0) problems.push(`另有 ${probe.droppedWarnings} 条目录告警因上限未列出`);

	const dscSelection = selectFiles(probe, DSC_EXTENSION, limits.maxDetectFiles);
	const decSelection = selectFiles(probe, DEC_EXTENSION, Math.max(1, Math.floor(limits.maxDetectFiles / 2)));

	const candidates: DetectionCandidate[] = [];
	const truncatedBy: Array<"files" | "bytes" | "candidates" | "scan"> = [];
	if (probe.truncated) truncatedBy.push("scan");
	// 选样受限（目录探测只保留有限样例）也算"文件预算受限"：不能只报告"看了 8 个"。
	if (dscSelection.sampleLimited || decSelection.sampleLimited) truncatedBy.push("files");

	let scannedFiles = 0;
	let totalBytes = 0;

	const pushCandidate = (field: DetectionField, value: string, rule: DetectionRule, relativePath: string, contentHash: string, line: number): void => {
		if (candidates.length >= limits.maxDetectionCandidates) {
			if (!truncatedBy.includes("candidates")) truncatedBy.push("candidates");
			return;
		}
		candidates.push({ field, value, rule, evidence: { workspaceId, relativePath, capturedAt, contentHash, line } });
	};

	const markBytes = (): void => {
		if (!truncatedBy.includes("bytes")) truncatedBy.push("bytes");
	};

	const readOne = async (relativePath: string): Promise<{ text: string; hash: string } | null> => {
		const safe = assertSafeRelativePath(relativePath);
		const absolute = join(workspaceReal, ...safe.split("/"));
		// 纵深防御：探测阶段已经跳过链接，这里再确认一次"真实位置仍在工作区内"。
		let realAbsolute: string;
		try {
			realAbsolute = await realpath(absolute);
		} catch (error) {
			assertNotCancelled(input.signal);
			problems.push(`${safe}: 读取前无法解析真实路径（${error instanceof Error ? error.message : String(error)}）`);
			return null;
		}
		assertNotCancelled(input.signal);
		if (!isWithinAuthorizedRoot(workspaceReal, realAbsolute)) {
			problems.push(`${safe}: 真实路径落在工作区之外，已跳过`);
			return null;
		}
		if (totalBytes >= limits.maxDetectTotalBytes) {
			problems.push(`${safe}: 已达总字节预算（${limits.maxDetectTotalBytes}），停止读取`);
			markBytes();
			return null;
		}
		// **实际字节**上限在这里执行：即使文件在探测之后长大，也不会越额读进内存。
		// 取消在 `readFileBounded` 内部的每个 await 之后复查，句柄由其 `finally` 关闭。
		const bounded = await readFileBounded(realAbsolute, limits.maxDetectFileBytes, input.signal, "项目检测已取消");
		if (!bounded.ok) {
			problems.push(bounded.code === "too-large" ? `${safe}: ${bounded.detail}，已跳过` : `${safe}: ${bounded.detail}`);
			if (bounded.code === "too-large") markBytes();
			return null;
		}
		if (totalBytes + bounded.bytes.byteLength > limits.maxDetectTotalBytes) {
			problems.push(`${safe}: 读取后会超过总字节预算（${limits.maxDetectTotalBytes}），已跳过`);
			markBytes();
			return null;
		}
		totalBytes += bounded.bytes.byteLength;
		scannedFiles += 1;
		return { text: bounded.bytes.toString("utf8"), hash: sha256(bounded.bytes) };
	};

	let fileBudget = limits.maxDetectFiles;
	for (const relativePath of dscSelection.selected) {
		assertNotCancelled(input.signal);
		if (fileBudget <= 0) {
			truncatedBy.push("files");
			break;
		}
		fileBudget -= 1;
		const read = await readOne(relativePath);
		if (read === null) continue;
		const parsed = parseDsc(read.text);
		const relativePosix = toPosixRelative(assertSafeRelativePath(relativePath));
		if (parsed.platformName !== null) {
			// 平台名 → buildTargets 候选；**不**映射到 boardName（本轮最容易被"顺手"做错的地方）。
			pushCandidate("buildTargets", parsed.platformName.value, "edk2-dsc-platform-name", relativePosix, read.hash, parsed.platformName.line);
		}
		for (const include of parsed.includes) {
			pushCandidate("keyEntryPoints", include.value, "edk2-dsc-include", relativePosix, read.hash, include.line);
		}
	}

	for (const relativePath of decSelection.selected) {
		assertNotCancelled(input.signal);
		if (fileBudget <= 0) {
			truncatedBy.push("files");
			break;
		}
		fileBudget -= 1;
		const read = await readOne(relativePath);
		if (read === null) continue;
		const parsed = parseDec(read.text);
		if (parsed.packageName !== null) {
			pushCandidate("keyEntryPoints", parsed.packageName.value, "edk2-dec-package-name", toPosixRelative(assertSafeRelativePath(relativePath)), read.hash, parsed.packageName.line);
		}
	}

	assertNotCancelled(input.signal);

	// 资料缺口：既有"没有合法规则的身份字段"，也有"本次检测到的信号不足以定身份"的说明。
	const gaps: DetectionGap[] = [...UNSUPPORTED_IDENTITY_GAPS];
	const scannedDsc = dscSelection.selected.length + decSelection.selected.length;
	if (scannedDsc === 0) {
		gaps.push({ field: "buildTargets", reason: "在工作区里没有找到 .dsc/.dec 构建描述文件", hint: "确认工作区路径是否指向 BIOS 源码根目录" });
	} else if (candidates.length === 0) {
		gaps.push({ field: "buildTargets", reason: "找到了构建描述文件，但没有解析出 PLATFORM_NAME/PACKAGE_NAME", hint: "确认描述文件是否为 EDK II 格式，或由工程师直接确认构建目标" });
	}
	// 选样/候选数量受限要能被看见：只报"解析了 8 个"会让人以为工作区里就 8 个描述文件。
	const discovered = dscSelection.discovered + decSelection.discovered;
	if (dscSelection.sampleLimited || decSelection.sampleLimited) {
		gaps.push({ field: "buildTargets", reason: `工作区里有 ${discovered} 个构建描述文件，本轮只选样解析了 ${scannedDsc} 个（选样/文件预算上限）`, hint: "缩小工作区范围，或由工程师直接确认构建目标" });
	}
	if (truncatedBy.length > 0) {
		gaps.push({ field: "buildTargets", reason: `本次检测命中预算（${truncatedBy.join("、")}），候选可能不完整`, hint: "缩小工作区范围或提高人工确认优先级" });
	}

	return {
		workspaceId,
		workspacePath: workspaceReal,
		capturedAt,
		candidates,
		gaps,
		scannedFiles,
		totalBytes,
		truncated: truncatedBy.length > 0,
		truncatedBy,
		problems,
		wroteToProfile: false,
	};
}
