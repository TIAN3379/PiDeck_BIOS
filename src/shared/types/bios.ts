/**
 * BM-07A C1：**BIOS 知识/任务面板的跨进程契约**。
 *
 * 约定（与 AGENTS.md 的跨层规则一致）：
 * - 这里只放**纯类型**：renderer 不 import Node/Pi SDK，也不获得任意路径读取接口；
 * - 主进程是唯一读知识库的地方，IPC 只做输入校验与适配；
 * - 桌面展示（人工可见）与**模型可发送视图**分开：本地展示可以包含人工可见的商业内容，
 *   但 `maySendToModel` 标记为假的正文绝不允许经由任何 IPC 再喂回 Pi。
 */

/** 端点外发策略：与 Package 的 `BIOS_ENDPOINT` 同义（缺省 unknown = 不自动外发）。 */
export type BiosEndpointPolicy = "allowed" | "denied" | "unknown";

/**
 * D4（§13.4.2）：**具名端点许可**——把外发授权绑定到**具体的模型服务身份**，而不是一个全局开关。
 *
 * 为什么需要：`endpoint: "allowed"` 只能表达"允许外发"，无法表达"只允许发给这个 provider/model/
 * API 服务"。用户切换模型或把 baseUrl 改到别处后，旧许可仍然有效——这正是 §13.3 指出的缺口。
 *
 * 三条性质：
 * - **身份只取事实**：provider / modelId 来自 Pi 报告的当前模型，`origin` 只保留 HTTP(S) 源
 *   （不含凭据、路径、query、fragment），不读取密钥；
 * - **版本只增不减**：每次重新确认 +1，旧版本一律视为旧许可；
 * - **绑定不是连通性承诺**：它只说明"资料可以发给这个服务"，不保证网络可达。
 */
export type BiosEndpointGrant = {
	readonly provider: string;
	readonly modelId: string;
	/** API 服务源（`https://host:port`）；读不到实际地址时为空串（空串不匹配任何事实）。 */
	readonly origin: string;
	/** 许可版本（每次重新确认 +1）。 */
	readonly version: number;
};

/**
 * AW-00：**宿主自动化许可**（向后兼容的可选配置块；缺省全关 = 与 0.9.1 行为等价）。
 *
 * 它是持久宿主事实，不是模型结论：
 * - `localBookkeeping` 只授予普通记账（任务进度/检查点/本项目草稿），不授予审核、验证、授权扩大；
 * - `injectProjectData` 只控制"能否把本项目资料注入当前模型请求"；
 * - `version` 变化即要求重新复验（撤权/换端点后不会沿用旧许可）。
 */
export type BiosAutomationSettings = {
	enabled: boolean;
	localBookkeeping: boolean;
	injectProjectData: boolean;
	version: number;
};

/** 自动化许可默认值：全关（未配置即拒绝）。 */
export const BIOS_AUTOMATION_DEFAULTS: BiosAutomationSettings = { enabled: false, localBookkeeping: false, injectProjectData: false, version: 0 };

/**
 * C5：**宿主投影**的自动记忆状态（默认面板只读显示；渲染层不能提交路径/授权）。
 *
 * `available:false` 时必须给出 `reason`：不能让用户看到一个"看起来正常的空状态"。
 */
export type BiosAutomationReceipt = {
	/**
	 * `checkpoint-full` 容量满；`checkpoint-failed` 检查点写入失败；
	 * `reflection-partial` 补记只完成一部分；`reflection-unrecovered` 补记中断且**没有恢复路径**。
	 */
	readonly kind: "checkpoint-full" | "checkpoint-failed" | "reflection-partial" | "reflection-unrecovered";
	readonly recordedAt: number;
	readonly detail: string;
};

export type BiosAutomationStatus = {
	readonly available: boolean;
	readonly reason: "ok" | "no-knowledge-root" | "automation-disabled" | "not-bound" | "unavailable";
	/** 近期检查点条数（真实索引，不是估算）。 */
	readonly checkpoints: number;
	/** 仍待补记的检查点条数。 */
	readonly pendingReflection: number;
	/** 最近一条检查点的记录时间（epoch ms；没有则 null）。 */
	readonly lastRecordedAt: number | null;
	/** 已完成补记的请求数（耐久标记 `saved=true`）。 */
	readonly durableSaved: number;
	/**
	 * **未终结且没有可信终止依据**的补记请求数（口径：待核对，可能仍在别的会话里跑）。
	 *
	 * V3 起与 `durableUnrecovered` 分开：旧实现把所有未终结项都算成"待恢复"，
	 * 于是界面一边说"未恢复"一边说"待恢复 N 项"，自相矛盾。
	 */
	readonly durablePending: number;
	/** D1：已**终结但没有保存成功**的补记请求数（明确失败，需要用户关注而不是等待恢复）。 */
	readonly durableFailed: number;
	/** V3：已确认**未恢复**（有可信终止依据、已发过未恢复回执）的补记请求数。 */
	readonly durableUnrecovered: number;
	/** D2：最近一次受限/失败/部分成功的耐久回执（没有则 null）。 */
	readonly receipt: BiosAutomationReceipt | null;
};

/** 桌面保存的可信配置（唯一来源；模型无法修改）。 */
export type BiosHostSettings = {
	/** 知识根（显式选择；未配置即拒绝读取）。 */
	knowledgeRoot: string | null;
	/** 允许读取/引用的项目 ID。 */
	authorizedProjectIds: string[];
	/** 显式授权的需求 ID（需求没有项目归属）。 */
	allowedFeatureIds: string[];
	/** 明确批准的客户范围。 */
	approvedCustomers: string[];
	/** 允许本次会话额外访问的目录根（绝对路径）。 */
	authorizedRoots: string[];
	endpoint: BiosEndpointPolicy;
	/**
	 * D4：具名端点许可（把 `endpoint: "allowed"` 绑到具体 provider/model/API 服务）。
	 *
	 * `null` = 没有具名绑定（兼容旧配置：沿用全局策略，不新增拦截）；一旦有值，
	 * Package 会在**发送前**核对当前实际服务身份，不一致就拒绝外发并给出可读原因。
	 * 增量字段：旧设置读不到时按 `null` 处理。
	 */
	endpointGrant?: BiosEndpointGrant | null;
	/** AW：默认自主工作流的宿主许可（缺省全关）。 */
	automation: BiosAutomationSettings;
};

/** 默认设置：**未配置即拒绝**（空知识根 + 空授权 = 不读取任何记录）。 */
export const BIOS_SETTINGS_DEFAULTS: BiosHostSettings = {
	knowledgeRoot: null,
	authorizedProjectIds: [],
	allowedFeatureIds: [],
	approvedCustomers: [],
	authorizedRoots: [],
	endpoint: "unknown",
	endpointGrant: null,
	automation: { ...BIOS_AUTOMATION_DEFAULTS },
};

export type BiosReadiness = {
	/** 是否具备读取条件（缺知识根或没有任何授权即 false）。 */
	ready: boolean;
	/** 不可读的受控原因（不含商业正文）。 */
	reason: string | null;
	/** 知识根是否已配置（只回显"来源"，不回显绝对路径以外的信息）。 */
	knowledgeRootConfigured: boolean;
};

/**
 * BM-07B B-03：**知识库状态**（首次使用流程第 1 步）。
 *
 * 刻意分成判别式而不是 `{ok, message}`：未配置 / 目录不在 / 未初始化 / 就绪 / 未来版本 /
 * 损坏 / 不可达的**下一步动作完全不同**（选目录、创建、去设置授权、换目录、人工核对）。
 * 只含状态、版本、revision 与计数，不含任何记录正文。
 */
export type BiosStoreStatus =
	/** 还没在设置里选知识根。 */
	| { readonly kind: "unconfigured" }
	/** 已配置但该目录当前不在（可能被移动/删除/所在盘未挂载）。 */
	| { readonly kind: "directory-missing"; readonly root: string }
	/** 目录在，但缺少 registry（没有初始化）：可以显式创建。 */
	| { readonly kind: "not-initialized"; readonly root: string }
	/** 已初始化且结构合法。 */
	| { readonly kind: "ready"; readonly root: string; readonly registryRevision: number; readonly schemaVersion: number; readonly projectCount: number }
	/** registry 的 schemaVersion 不在本实现支持范围内：只读/拒绝写入，**不猜字段**。 */
	| { readonly kind: "future-version"; readonly root: string; readonly supportedVersion: number; readonly detail: string }
	/** registry 存在但 JSON/结构不合法：保持原字节，交人工判断。 */
	| { readonly kind: "corrupt"; readonly root: string; readonly detail: string }
	/** 读不动又无法进一步分类（权限、不是目录、超限……）。 */
	| { readonly kind: "unreachable"; readonly root: string; readonly detail: string };

export type BiosWorkspaceSummary = {
	workspaceId: string;
	/** 本地人工可见的绝对路径（模型侧视图会另行撤回）。 */
	path: string;
	availability: string;
};

export type BiosProjectSummary = {
	projectId: string;
	/** 已授权登记的桌面归属，仅用于当前项目的唯一自动匹配。 */
	desktopProjectId?: string;
	/** 仅本地显示的项目名称；旧条目缺失时由界面回退短 ID。 */
	displayName?: string;
	profileRevision: number | null;
	/** 人工确认/候选/未知的身份字段（仅本地展示）。 */
	identity: Array<{ field: string; value: string | null; status: string; needsReview: boolean; reasons: string[] }>;
	workspaces: BiosWorkspaceSummary[];
	needsReviewCount: number;
	problems: string[];
};

export type BiosTaskSummary = {
	projectId: string;
	taskId: string;
	revision: number;
	status: string;
	/** 仅本地展示；模型侧是否可见由预览/工具另行判定。 */
	requirement: string;
	workspaceId: string;
	updatedAt: number;
	blockerCount: number;
	todoCount: number;
};

/**
 * **会话身份**（R33-2）：renderer 只能提交会话引用，**不能**提交目录。
 *
 * `agentId` 是运行进程句柄，`sessionId` 是 PiDeck 会话身份；主进程用它们在真实会话表里
 * 找到 `cwd` 与 `runtimeGeneration`，找不到或代次不符即拒绝（假身份/迟到请求）。
 */
export type BiosSessionRef = {
	readonly agentId: string;
	readonly sessionId: string | null;
};

/** 会话身份 + 代次：随每次读写一起提交，用于拒绝迟到/伪造的渲染层请求。 */
export type BiosSessionClaim = {
	readonly sessionRef: BiosSessionRef;
	/** renderer 看到的运行时代次（`AgentTab.runtimeGeneration`）。 */
	readonly runtimeGeneration: number;
};

export type BiosListProjectsRequest = BiosSessionClaim;

export type BiosListTasksRequest = BiosSessionClaim & { readonly projectId: string };

export type BiosPreviewRequest = BiosSessionClaim & {
	projectId: string;
	taskId: string;
	workspaceId: string | null;
	/** 只允许**收紧** Package 的 12,000 字符 / 24 KiB 硬上限；超限夹紧并如实标记 clamped。 */
	budgetChars?: number;
	query?: string;
};

/** 列表类结果：`gap` 说明为什么本次没有内容（撤权/切换/身份不符），不是"空库"。 */
export type BiosListResult<T> = {
	readonly items: T[];
	readonly gap: string | null;
};

export type BiosPreviewResult = {
	status: string;
	/** 本地人工可见的预览正文。 */
	text: string;
	/** 该正文是否允许发送给模型（deny/unknown/身份不可用时为 false）。 */
	maySendToModel: boolean;
	/** 身份是否可用（工作区属于本项目 + 会话目录在授权范围内）。 */
	identityUsable: boolean;
	/** 尾部复查结论（配置/选择在读取期间变化时为 false，正文已按缺口处理）。 */
	stable: boolean;
	outboundNote: string | null;
	/** 本次生效的硬上限与用量（`clamped=true` 表示请求被夹紧到 12,000/24 KiB）。 */
	budget: { maxChars: number; maxBytes: number; usedChars: number; usedBytes: number; truncated: boolean; clamped: boolean };
	/** 结构化元数据另设限额（只保留前 N 条；完整条数见 count 字段）。 */
	retainedSources: Array<{ recordKind: string; recordId: string; revision: number }>;
	inspectedSources: Array<{ recordKind: string; recordId: string; revision: number }>;
	retainedSourceCount: number;
	inspectedSourceCount: number;
	sourcesTruncated: boolean;
	expiredSources: string[];
	problems: string[];
};

/**
 * 选择同步请求：**只带会话引用、ID 与非敏感开关**（不把知识正文放进 Session/设置）。
 *
 * 选择按稳定 sessionId 归属：同一会话才复用，重启后保守关闭并由扩展重新验证。
 */
export type BiosSelectionRequest = BiosSessionClaim & {
	projectId: string;
	taskId: string;
	workspaceId: string | null;
	contextEnabled: boolean;
};

/** 配置收窄必须立即失效；选择回执通知不能吞掉本窗口正在等待的同一选择。 */
export type BiosChangedEvent = { kind: "settings" } | { kind: "selection"; selection: BiosSelectionRequest };

export type BiosSelectionResult = {
	/** 同步方式：rpc 表示"已用既有命令通道同步并拿到回执"，env 表示"仅登记，待 Pi 启动生效"。 */
	mode: "env" | "rpc" | "none";
	applied: boolean;
	/** 可读回执（成功与失败都有）。 */
	receipt: string;
	reason: string | null;
	/** 当前会话是否已经用上新配置（无回执时不得声称"当前已生效"）。 */
	currentSessionSynced: boolean;
};

/** 文件选择（设置知识根）：主进程弹目录选择器，renderer 不提供任意路径。 */
export type BiosKnowledgeRootPickResult = { canceled: boolean; path: string | null };

/**
 * **待同步的会话选择**（只存 ID 与非敏感开关，不存知识正文）。
 *
 * 注入给 Pi 子进程后仍由扩展**重新验证**（任务存在/工作区属于任务/项目已授权），
 * 因此这里只是"意图"，不是"已生效的许可"。
 */
export type BiosSessionSelection = {
	projectId: string | null;
	taskId: string | null;
	workspaceId: string | null;
	contextEnabled: boolean;
	updatedAt: number;
};

/**
 * **按会话**保存的选择（R33-2/R33-3）。
 *
 * 之前把选择放在一个全局字段里，所有 Pi 子进程读同一个值，两个会话会互相串任务。
 * 现在按稳定 `sessionId` 归属；`bootId` 记录写入时的进程启动标识——
 * 重启后不匹配即**保守关闭**（保留意图，但不沿用"已打开"），必须由扩展重新验证。
 */
export type BiosSelectionMap = {
	readonly bySession: Record<string, BiosSessionSelection>;
	readonly bootId: string | null;
};

/** 写配置的结果：规范化后的设置 + 被丢弃的非法目录根 + 运行中会话的同步状态。 */
export type BiosSettingsUpdateResult = {
	readonly settings: BiosHostSettings;
	/** 不是完全限定绝对路径、已被丢弃的目录根（界面必须如实显示，不能默默吞掉）。 */
	readonly droppedRoots: string[];
	readonly runtime: BiosRuntimeState;
	/** 本次因**收窄**被判定为旧许可的运行时（`agentId@generation`）。 */
	readonly invalidated: string[];
	/** 其中已用命令通道确认关闭上下文的运行时（没有回执的不会出现在这里）。 */
	readonly pushedOff: string[];
	/** 已确认**停止**、等待用户手动重开的会话（R35-1 的最小撤权方案）。 */
	readonly stopped: string[];
	/** 停止失败的会话：这些旧进程可能仍在用旧许可，界面必须如实提示。 */
	readonly stopFailed: string[];
	/** B-01：停止失败时的**具体原因**（撤权未完成的可诊断依据；与 stopFailed 一一对应）。 */
	readonly stopFailureDetails: { readonly agentId: string; readonly reason: string }[];
};

/** 运行中会话与最新可信配置的同步状态（UI 据此说明"当前会话未生效"）。 */
export type BiosRuntimeState = {
	/** 可信配置版本（每次改配置 +1；仅供界面显示"已更新"）。 */
	readonly configVersion: number;
	/** 是否有运行中的会话仍在用旧配置（true ⇒ 必须重开或经命令同步，不得当作已撤权）。 */
	readonly pendingRestart: boolean;
	/** 已确认**停止**、等待用户手动重开的会话（R35-1 的最小方案）。 */
	readonly stoppedRuntimes: string[];
	/**
	 * B-01：停止未能确认退出的会话及原因（旧进程可能仍有旧许可）。
	 * 非空时 UI 必须显示"撤权未完成"，不得显示"安全已生效"。
	 */
	readonly stopFailures: { readonly agentId: string; readonly reason: string }[];
	/** 受控说明（不含商业正文）。 */
	readonly note: string | null;
};
