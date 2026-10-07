/**
 * AW-00：**自动化附属记录的契约**（AW 私有工作记录，不是业务 schema v2）。
 *
 * 三条边界：
 * 1. 这里只定义**纯类型与常量**，无 IO、无 Electron/Pi 依赖，便于单测与复用；
 * 2. 记录落在知识根 `automation/workspaces/<workspaceId>/`，与五类业务记录**不混放**，
 *    也不往严格 schema 强塞 `autoApproved`/新时间字段；
 * 3. 时间是"观察/记录时间"（`recordedAt`），不伪造需求生效时间或上板测试时间。
 */
import { createHash } from "node:crypto";

/** 状态文件格式版本（不认识就拒写、保留原字节）。 */
export const AUTOMATION_STATE_VERSION = 1;
/** 检查点文件格式版本。 */
export const AUTOMATION_CHECKPOINT_VERSION = 1;

/** 知识根下的附属目录名。 */
export const AUTOMATION_ROOT_SEGMENT = "automation";
export const AUTOMATION_WORKSPACES_SEGMENT = "workspaces";
export const AUTOMATION_CHECKPOINTS_SEGMENT = "checkpoints";
export const AUTOMATION_STATE_FILE = "state.json";

/**
 * 初始预算（AW §5.4/§9）。这些是**硬上限**，只能收紧不能放宽。
 * 字符/字节预算仍是实际强闸门；token 数只作为阶段目标。
 */
export const AUTOMATION_LIMITS = {
	/** 单检查点初始上限 24 KiB。 */
	maxCheckpointBytes: 24 * 1024,
	/** 单工作区状态文件上限。 */
	maxStateBytes: 64 * 1024,
	/** 最多 50 个可查询近期检查点/工作区。 */
	maxRecentCheckpoints: 50,
	/** 补记标记上限（防重启重复，同时防止无界增长）。 */
	maxReflectionMarks: 50,
	/** 每个原始请求默认一次自动检索准备。 */
	maxAutoRetrievalPerRequest: 1,
	/** 默认最多 5 个摘要候选。 */
	maxWorkingLeads: 5,
	/** 其中最多 2 个本项目未验证线索。 */
	maxProjectLeads: 2,
	/** 按需读最多 3 个详情。 */
	maxDetailReads: 3,
	/** 自动相关 Git 取证默认最多 10 个本地提交的一批。 */
	maxGitCommitsPerBatch: 10,
	/** 每个原始用户工程请求最多 1 次专用补记阶段。 */
	maxReflectionStagesPerRequest: 1,
	/** 补记阶段最多 2 次 provider 请求。 */
	maxReflectionProviderRequests: 2,
	/** 补记阶段最多 2 次写工具调用。 */
	maxReflectionWriteCalls: 2,
	/**
	 * D1：**中断恢复次数上限**（按请求）。
	 *
	 * 阶段"开始"与"恢复"是两件事：开始即在耐久标记里记 `attempts=1, finished=false`，
	 * 但那时**还没有**任何完成回执。旧实现把"有标记"当成"已处理"，于是重启后既不补记
	 * 也从不真正恢复。这里把恢复次数单独限死（最多 1 次），由耐久回执驱动：
	 * 未终结 + 恢复次数未用尽 ⇒ 允许一次；再中断或完成即终结，不再无限重试。
	 */
	maxReflectionRecoveryAttempts: 1,
	/** 补记阶段输出预算目标（tokens）。 */
	reflectionTokenBudget: 1500,
	/** 初始本地准备软耗时预算（ms）。IO/扫描另有硬数量/字节上限。 */
	prepareSoftBudgetMs: 2000,
} as const;

/** 自动化能力视图。**只读**投影，不代表任何业务事实状态。 */
export type AutomationCapability = {
	/** 总开关；false 时与 0.9.1 行为一致。 */
	readonly enabled: boolean;
	/** 允许本地普通记账（任务进度/检查点/本项目草稿）。 */
	readonly localBookkeeping: boolean;
	/** 允许把本项目资料注入当前模型请求。 */
	readonly injectProjectData: boolean;
	/** 许可版本；变化即要求重新复验。 */
	readonly version: number;
};

/** 缺省即拒绝：与旧行为等价（没有任何自动化）。 */
export const AUTOMATION_DISABLED: AutomationCapability = { enabled: false, localBookkeeping: false, injectProjectData: false, version: 0 };

/** 代码基线：记录观察时的代码事实，不猜构建条件。 */
export type CodeBaseline = {
	/** 工作区路径（规范化后的真实路径）。 */
	readonly workspacePath: string;
	/** Git 分支名；非 Git 为 null（不拿"同远端"当身份）。 */
	readonly branch: string | null;
	/** HEAD commit；非 Git/读取失败为 null。 */
	readonly commit: string | null;
	/** 关联文件的相对路径 → 内容 SHA-256（未提交改动也锚定内容）。 */
	readonly fileHashes: Readonly<Record<string, string>>;
	readonly capturedAt: number;
};

/** 一条已发生的执行事实（只记录真实结果，不含隐藏思维链/完整终端输出/密钥/整段源码）。 */
export type ExecutedFact = {
	readonly tool: string;
	/** 受支持工具的执行结果：成功/失败/被拒。 */
	readonly outcome: "ok" | "error" | "blocked";
	/** 被定位/修改的文件相对路径（有界、去重）。 */
	readonly files: readonly string[];
	/** 该工具是否为写工具（edit/write 类）。 */
	readonly wrote: boolean;
	/**
	 * R6：业务工具返回的**结构化状态**（`details.status`）。
	 *
	 * 为什么需要：`isError=false` 只说明"工具没抛异常"，它可能返回 `declined`/`stale`/`endpoint-denied`
	 * 这类**没写成功**的结构化失败。保存回执必须按这个字段判断，不能按"工具名出现过"推断。
	 */
	readonly businessStatus?: string | null;
	/** R6：经验草稿已保存但任务回链失败（独立事实，不撤销"已保存"）。 */
	readonly linkFailed?: boolean;
};

/** 检查点关联的任务链接（回链是独立事实，失败不撤销已保存进度）。 */
export type CheckpointTaskLink = { readonly taskId: string; readonly revision: number };

/** 检查点结果：只描述**本次执行事实**，不宣称根因正确或工程完成。 */
export type CheckpointOutcome = "in-progress" | "interrupted" | "error";

export type AutomationCheckpoint = {
	readonly version: number;
	/** 稳定运行标识（文件名的来源）。 */
	readonly runId: string;
	readonly projectId: string;
	readonly workspaceId: string;
	readonly sessionId: string | null;
	readonly branch: string | null;
	/** 原始用户请求的稳定标识（内部补记不被识别为新请求）。 */
	readonly requestKey: string;
	readonly recordedAt: number;
	readonly baseline: CodeBaseline;
	readonly executed: readonly ExecutedFact[];
	readonly changedFiles: readonly string[];
	readonly task: CheckpointTaskLink | null;
	readonly outcome: CheckpointOutcome;
	/** true 表示有重要进展尚未保存，需要在 settle 前请求一次受控补记。 */
	readonly pendingReflection: boolean;
};

/** 状态文件里的检查点索引（近期集合；正文在独立文件）。 */
export type CheckpointRef = {
	readonly runId: string;
	readonly recordedAt: number;
	readonly taskId: string | null;
	/** true 表示仍有唯一证据/未归并，保留策略不得轮换它。 */
	readonly protectedFromRotation: boolean;
	readonly pendingReflection: boolean;
	/**
	 * D2：该检查点属于哪个原始请求（增量字段）。
	 *
	 * 用途：同一请求后续出现**更权威**的检查点（包含全部事实、`pendingReflection=false`）时，
	 * 可以把该请求更早的待补记记录按"有证据的覆盖关系"收口（原子移出索引并清理副本），
	 * 否则待补记标记会永久占住容量。旧 state.json 没有该字段时按"无法归并"保守处理。
	 */
	readonly requestKey?: string;
};

/**
 * D2：**宿主可见的耐久回执**（容量满/保存失败/部分成功）。
 *
 * 为什么落盘：保存状态原先只存在扩展的私有变量（`lastSaveNote`）里，
 * 用户既看不到也无法在重启后复核。这里把"最近一次真实受限/失败"记进工作区状态，
 * 由宿主投影到默认面板，而不是靠推断。
 */
export type AutomationReceipt = {
	/**
	 * - `checkpoint-full`：受保护记录占满预算；
	 * - `checkpoint-failed`：检查点写入失败；
	 * - `reflection-partial`：补记只完成了一部分；
	 * - `reflection-unrecovered`：有补记阶段开始后中断，且**没有恢复路径**（请求身份已变或恢复次数用尽）。
	 */
	readonly kind: "checkpoint-full" | "checkpoint-failed" | "reflection-partial" | "reflection-unrecovered";
	readonly recordedAt: number;
	/** 受控说明（不含商业正文）。 */
	readonly detail: string;
};

/**
 * 摘要候选的可持久化引用（R7）：只带证据，不带"已确认"含义。
 *
 * 目的是让**下一个新对话**不必重扫整仓也能复用上一轮识别到的有证据候选；
 * 它不是项目档案，也不得覆盖人工确认字段。
 */
export type SummaryCandidateRef = {
	readonly field: string;
	readonly value: string;
	readonly relativePath: string;
	readonly contentHash: string;
};

/** 弱线索的可持久化引用（证据强度永远是 `clue`）。 */
export type SummaryClueRef = SummaryCandidateRef & { readonly keyword: string };

/**
 * 摘要基线：以后优先检查关键文件与实际变化，不每次重新扫全仓。
 *
 * R7：`candidates`/`clues`/`gaps` 是可复用的**有界候选摘要**；`evidenceFiles` 是参与哈希重验的
 * 相关文件集合。三个字段是**增量添加**的（旧 state.json 没有它们时按"没有可复用候选"处理并要求重扫）。
 */
export type SummaryBaseline = {
	readonly capturedAt: number;
	readonly branch: string | null;
	readonly commit: string | null;
	/** 摘要所依赖的关键文件 → 内容 hash。 */
	readonly fileHashes: Readonly<Record<string, string>>;
	/** 上次扫描是否受限（受限时不得声称"识别完成"）。 */
	readonly partial: boolean;
	/** 上一轮的候选（有界）。缺省表示旧格式：没有可复用候选，必须重扫。 */
	readonly candidates?: readonly SummaryCandidateRef[];
	/** 上一轮的弱线索（有界）。 */
	readonly clues?: readonly SummaryClueRef[];
	/** 上一轮的资料缺口（字段: 原因）。 */
	readonly gaps?: readonly string[];
	/** 参与哈希重验的相关文件（含未进入候选的检测文件）。 */
	readonly evidenceFiles?: readonly string[];
};

/** 补记标记：防重启后重复创建补记阶段（有界）。 */
export type ReflectionMark = {
	readonly requestKey: string;
	readonly runId: string;
	readonly recordedAt: number;
	/** 是否已经成功落盘语义进度；false 表示仍待补记。 */
	readonly saved: boolean;
	/**
	 * C3：这个请求已经**开始**过多少次补记阶段。未完成（`saved=false`）时用它把**恢复**限制成有界
	 * （最多再试 `maxReflectionRecoveryAttempts` 次），而不是无限重试。
	 * 旧记录没有该字段时按 `saved ? 1 : 0` 推断。
	 */
	readonly attempts?: number;
	/**
	 * D1：这个请求的补记阶段是否已经**终结**（拿到真实完成回执，或明确判定无法保存）。
	 *
	 * `finished=false` + `attempts>=1` 表示"阶段开始后中断"——它**不是**已处理，
	 * 必须允许一次有界恢复。旧记录没有该字段时按 `saved === true` 推断（保守：未保存的旧标记
	 * 允许一次恢复）。
	 */
	readonly finished?: boolean;
	/**
	 * D1：这条"未终结"标记已经发出过**未恢复**回执的时间（没有则为未回执）。
	 *
	 * 为什么需要：恢复只可能发生在"同一个用户 entry 重新成为当前请求"时（Pi 自动重试/同 entry 重放）。
	 * 如果请求身份已经变（新 entry），这条未终结标记**没有恢复路径**；旧实现让它永远停在
	 * `finished:false` 上，既不恢复也不说明，对用户等于无声消失。这里记下"已如实告知过一次"，
	 * 让回执只发一次、不每轮重复刷屏；同时**不改** `saved`/`attempts`（证据仍受保护）。
	 *
	 * V1：它必须与同一次 `lastReceipt` **在同一次 CAS 内**写入——只落盘一半（标记有、回执没有
	 * 或反之）会让重启后的状态自相矛盾。
	 */
	readonly unrecoveredAt?: number;
	/**
	 * V2：写下这条标记的**进程启动标识**（扩展所在 pi 进程；`currentAutomationBootId()`）。
	 *
	 * 为什么需要：状态按工作区共享，**另一个会话**的 settle 不能证明本请求已中断。
	 * 只有在"所有者进程已经不在"（boot 不同）或"同一会话已被新请求取代"时才有可信终止依据；
	 * 拿不到所有者的旧记录一律保守按"待核对"处理，不能凭 requestKey 不同就判死。
	 */
	readonly ownerBootId?: string;
	/** V2：标记所属会话 ID（同一进程内区分并发会话）。缺失 = 所有者未知（保守待核对）。 */
	readonly ownerSessionId?: string;
};

/** 单工作区的自动化状态（`state.json`）。 */
export type WorkspaceAutomationState = {
	readonly version: number;
	/** CAS 版本号：每次整文件更新 +1。 */
	readonly revision: number;
	readonly projectId: string;
	readonly workspaceId: string;
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly summaryBaseline: SummaryBaseline | null;
	readonly checkpoints: readonly CheckpointRef[];
	readonly reflectionMarks: readonly ReflectionMark[];
	/** D2：最近一次受限/失败/部分成功的耐久回执（增量字段；旧状态没有时按"无"处理）。 */
	readonly lastReceipt?: AutomationReceipt | null;
};

/** 派生 `stableRunId`：session + branch + 原始请求标识的组合哈希（前 32 位十六进制）。 */
export function stableRunId(parts: readonly (string | null)[]): string {
	return createHash("sha256")
		.update(JSON.stringify(parts.map((part) => part ?? "")))
		.digest("hex")
		.slice(0, 32);
}

/** 读取结果：把"文件不存在/版本不认识/损坏"三种情况分开，避免回退旧正文。 */
export type AutomationReadOutcome<T> =
	| { readonly status: "ok"; readonly value: T; readonly bytes: number }
	| { readonly status: "missing" }
	| { readonly status: "unsupported-version"; readonly detail: string }
	| { readonly status: "corrupt"; readonly detail: string }
	| { readonly status: "denied"; readonly detail: string };

/** 写入结果：与既有存储错误语义对齐（CAS 冲突不会被伪装成成功）。 */
export type AutomationWriteOutcome =
	| { readonly status: "created"; readonly revision: number; readonly bytes: number }
	| { readonly status: "updated"; readonly revision: number; readonly bytes: number }
	| { readonly status: "unchanged"; readonly revision: number }
	| { readonly status: "revision-conflict"; readonly expected: number; readonly actual: number }
	| { readonly status: "unsupported-version"; readonly detail: string }
	| { readonly status: "too-large"; readonly detail: string }
	| { readonly status: "failed"; readonly detail: string };
