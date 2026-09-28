import type { SessionEnvironment, SessionSource, SessionSummary } from "./types";

export type SessionOriginInput = {
	source: SessionSource;
	environment: SessionEnvironment;
	filePath: string;
	wslDistro?: string;
	wslUser?: string;
	importedSourceId?: string;
};

/**
 * pi 未 set_session_name 时，sessionName 默认是 JSONL 文件名。
 * 文件名把 ISO 的 `:` / `.` 换成 `-`（如 `2026-08-08T10-47-19-239Z_abc`），
 * 不能当侧栏标题，否则全是日期，且占位名被盖掉后无法用首条消息自动改名。
 */
export function looksLikePiSessionFileStem(title: string): boolean {
	const trimmed = title.replace(/\s+/g, " ").trim();
	// 秒后的毫秒在文件名里是 `-239`，不是 ISO 的 `.239`。
	return /^\d{4}-\d{2}-\d{2}T\d{2}[-:]\d{2}[-:]\d{2}(?:[.,-]\d+)?Z(?:_[A-Za-z0-9-]+)?$/.test(trimmed);
}

/**
 * Codex 会话源文件名 stem（rollout-<ISO 时间戳>-<UUID>）。
 *
 * Codex jsonl 本身不带会话名，早期导入器拿不到名字时把文件名当标题写进导入产物，
 * 侧栏显示成 `rollout-2026-07-13T18-44-48-019f5b14-…`（截断后就是一串 ID 样文本）。
 * 这类标题是占位名：允许后续扫描/重导入用真实标题（Codex 状态库会话名或首条用户消息）覆盖。
 */
export function looksLikeCodexSessionFileStem(title: string): boolean {
	const trimmed = title.replace(/\s+/g, " ").trim();
	// 完整文件名（含 .jsonl）与 cleanTitle 截断形态（40 字符 + "..."，末段可能被切短）都要命中。
	return /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-[0-9a-f]{8}(?:-[0-9a-f]+)*(?:\.jsonl)?(?:\.{3})?$/i.test(trimmed);
}

/** pi-subagents 产物目录名：artifactDir="session"（默认）把子代理输入/输出/转储写进父会话同级目录。 */
export const SUBAGENT_ARTIFACTS_DIR_NAME = "subagent-artifacts";

/**
 * 校验 JSONL 文件头部是否为有效 Pi 会话：跳过旧版私有 sessionName 行后，
 * 首条可解析记录必须带 type 字段（pi 会话头 type:"session"；session_info /
 * *_import 等元数据行亦带 type）。
 *
 * 用于扫描索引前过滤掉非会话 JSONL——pi-subagents 的 transcript 转储首条记录
 * 用 recordType 而非 type（无 type 头），会被本校验拒绝，防止其在侧栏出现无法
 * 打开的条目（#168）。旧版 PiDeck 私有 sessionName 头行（#114 存量损坏）会被
 * 跳过——这类文件由 repairCorruptSessionHeader 在打开时修复，扫描期不应隐藏。
 *
 * 与 pi 严格的「首条记录 type==="session" && typeof id==="string"」相比略宽容：
 * 接受 session_info / *_import 等带 type 的元数据行作为首条，兼容历史格式与导入
 * 会话；但足以拒绝无 type 头的产物转储。只检查首条记录（而非前 N 行任一），
 * 避免 transcript 后续行中偶然出现的 type 字段导致误判。
 */
export function isValidPiSessionFileHead(raw: string): boolean {
	for (const line of raw.split(/\r?\n/).filter(Boolean).slice(0, 12)) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			// 截断半行/损坏行跳过，不影响后续记录判定
			continue;
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
		const record = parsed as Record<string, unknown>;
		// 跳过旧版私有 sessionName 行（有 sessionName 无 type）——存量损坏，打开时修复
		if (typeof record.sessionName === "string" && typeof record.type !== "string") continue;
		// 首条有效记录必须带 type 字段；transcript 用 recordType 而无 type → 拒绝
		return typeof record.type === "string";
	}
	return false;
}

/**
 * 判断文件是否位于 pi-subagents 产物目录内。
 *
 * 这些 JSONL（如 `<runId>_<agent>_0_transcript.jsonl`）是扩展私有的 transcript
 * 转储而非会话文件（无 type:session 头）。扫描与 catalog 若不排除，每个子代理会在
 * 侧栏出现两条：真子会话嵌套在父会话下 + 产物转储平铺顶层（侧栏重复显示）。
 * 该规则是 pi-subagents 三种 artifactDir 配置中唯一会落进 sessions 根的布局。
 */
export function isInSubagentArtifactsDir(filePath: string): boolean {
	return filePath.replace(/\\/g, "/").split("/").includes(SUBAGENT_ARTIFACTS_DIR_NAME);
}

export function canonicalizeSessionPath(filePath: string, environment: SessionEnvironment): string {
	const normalized = filePath.replace(/\\/g, "/").replace(/\/+$/, "");
	return environment === "native" ? normalized.toLowerCase() : normalized;
}

export function getSessionEnvironment(summary: Pick<SessionSummary, "wsl">): SessionEnvironment {
	return summary.wsl ? "wsl" : "native";
}

export function getImportedSessionSourceId(summary: Pick<SessionSummary, "source" | "codexSessionId">): string | undefined {
	return summary.source === "codex" ? summary.codexSessionId : undefined;
}

export function buildSessionOriginKey(input: SessionOriginInput): string {
	const environmentKey = input.environment === "wsl" ? `wsl:${input.wslDistro ?? "unknown"}:${input.wslUser ?? "unknown"}` : "native";
	const importedKey = input.importedSourceId ? `:${encodeURIComponent(input.importedSourceId)}` : "";
	return [input.source, environmentKey, canonicalizeSessionPath(input.filePath, input.environment)].join(":") + importedKey;
}

export function buildSummaryOriginKey(summary: SessionSummary, options?: { wslDistro?: string; wslUser?: string }): string {
	return buildSessionOriginKey({
		source: summary.source ?? "pi",
		environment: getSessionEnvironment(summary),
		filePath: summary.filePath,
		wslDistro: options?.wslDistro,
		wslUser: options?.wslUser,
		importedSourceId: getImportedSessionSourceId(summary),
	});
}

/** 判断路径是否为该环境下的绝对路径（纯字符串判断，不依赖 node:path）。 */
function isAbsolutePath(filePath: string, environment: SessionEnvironment): boolean {
	if (environment === "wsl") return filePath.startsWith("/");
	// native：盘符开头、根前缀（如 \\server\share 或 /rooted）。
	return /^[A-Za-z]:[\\/]/.test(filePath) || filePath.startsWith("/") || filePath.startsWith("\\");
}

/**
 * Windows 盘符路径 → WSL /mnt/<drive>/… 基址（仅覆盖 WslPaths.toWslLinuxPath 的盘符分支；
 * 已以 / 开头的路径原样返回，无法识别的路径原样返回由调用方兜底）。
 * 与 `src/main/wsl/WslPaths.ts` 保持同一换算语义。
 */
function windowsPathToWslBase(path: string): string {
	const drive = path.match(/^([A-Za-z]):(?:[\\/](.*))?$/);
	if (drive) {
		const suffix = drive[2]?.replace(/[\\/]+/g, "/") ?? "";
		return `/mnt/${drive[1].toLowerCase()}/${suffix}`;
	}
	return path.startsWith("/") ? path.replace(/[\\/]+/g, "/") : path;
}

/**
 * 将会话文件路径归一化为绝对路径（纯字符串实现，可在渲染层安全调用）。
 *
 * pi 的 sessionDir 可配置为相对 cwd 的路径（如项目 `.pi/settings.json` 中
 * `"sessionDir": ".pi/sessions"`），此时 get_state 返回的 sessionFile 也是相对路径。
 * 若原样写入 catalog，会与扫描器发现的绝对路径构成「同一文件两条记录」
 * （侧栏重复显示两个会话），且 rename/delete/read 等文件操作会落到错误位置。
 * 所有会话路径在进入 catalog / Agent 状态前都应经过本函数。
 *
 * WSL 环境按 Linux 路径语义处理：相对路径解析到 /mnt/<drive>/… 基址。
 */
export function toAbsoluteSessionPath(filePath: string, projectPath: string, environment: SessionEnvironment): string {
	if (isAbsolutePath(filePath, environment)) return filePath;
	const base = environment === "wsl" ? windowsPathToWslBase(projectPath) : projectPath;
	const joined = `${base.replace(/[\\/]+$/, "")}/${filePath.replace(/^[\\/]+/, "")}`;
	// native 统一反斜杠风格，与 node:path resolve 输出一致；WSL 保持正斜杠。
	return environment === "wsl" ? joined : joined.replace(/\//g, "\\");
}

/** 归档/删除子树识别用的最小会话节点（catalog 条目与渲染层 record 都满足）。 */
export type SessionTreeNode = {
	id: string;
	filePath?: string;
	parentSessionPath?: string;
	environment?: SessionEnvironment;
};

/**
 * 父会话 `<stem>.jsonl` 旁边的子会话目录 `<stem>/`。
 * pi-subagents / Claude 式子会话都落在这个 sibling-dir 里；扫描器归档/删除父文件时
 * 会把整个目录一起搬走，但 catalog.remove(id) 以前只摘父条目，目录里的子条目会变成幽灵行。
 */
function sessionSiblingDirPrefix(filePath: string, environment: SessionEnvironment): string | undefined {
	const canonical = canonicalizeSessionPath(filePath, environment);
	const jsonl = canonical.match(/\.jsonl$/i);
	if (!jsonl) return undefined;
	return `${canonical.slice(0, -jsonl[0].length)}/`;
}

/**
 * 判断 candidate 是否属于 ancestor 的子树。
 *
 * 两条独立规则（满足任一即为后代，且不含自身）：
 * 1. parentSessionPath 指向 ancestor 的会话文件（显式父子链接，大小写/分隔符已规范化）；
 * 2. candidate 文件落在 ancestor 的 sibling-dir `<stem>/` 下（含多层嵌套）。
 *
 * 匿名会话/草稿没有 filePath，不能仅凭同项目就当成子会话，否则归档父会话会误伤它们。
 */
export function isSessionDescendantOf(candidate: SessionTreeNode, ancestor: SessionTreeNode): boolean {
	if (candidate.id === ancestor.id) return false;
	if (!ancestor.filePath) return false;
	const environment = ancestor.environment ?? candidate.environment ?? "native";
	const ancestorPath = canonicalizeSessionPath(ancestor.filePath, environment);
	if (candidate.parentSessionPath && canonicalizeSessionPath(candidate.parentSessionPath, environment) === ancestorPath) {
		return true;
	}
	if (!candidate.filePath) return false;
	const siblingPrefix = sessionSiblingDirPrefix(ancestor.filePath, environment);
	if (!siblingPrefix) return false;
	return canonicalizeSessionPath(candidate.filePath, environment).startsWith(siblingPrefix);
}

/**
 * 收集 parent 及其全部后代 id（含 parent 自身）。
 * 闭包迭代：parentSessionPath 链接的孙会话即使不在 sibling-dir 里也能被收进来。
 */
export function collectSessionSubtreeIds(sessions: SessionTreeNode[], parent: SessionTreeNode): string[] {
	const byId = new Map<string, SessionTreeNode>();
	for (const session of sessions) {
		if (session.id) byId.set(session.id, session);
	}
	byId.set(parent.id, parent);

	const collected = new Set<string>([parent.id]);
	let grew = true;
	while (grew) {
		grew = false;
		for (const session of byId.values()) {
			if (collected.has(session.id)) continue;
			for (const ancestorId of collected) {
				const ancestor = byId.get(ancestorId);
				if (ancestor && isSessionDescendantOf(session, ancestor)) {
					collected.add(session.id);
					grew = true;
					break;
				}
			}
		}
	}
	return [...collected];
}
