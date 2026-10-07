/**
 * BM-07A C1 + R33-2/R33-4：**BIOS 只读主进程适配服务**。
 *
 * 边界（AGENTS.md）：
 * - 复用 `packages/bios-agent` 的 core（storage/项目视图/任务/交接预览），**不复刻** Pi 的模型、
 *   工具与会话循环，也不引入第二条与 pi 通信的通道；
 * - 本服务是**唯一读知识库**的地方；IPC handler 只做校验与字段挑选；
 * - **桌面展示（人工可见）与模型可发送视图分开**：`maySendToModel` 为 false 的正文不会被任何
 *   IPC 回合喂给 Pi（含历史工具结果的重放守卫）；
 * - 可信配置只来自桌面设置；renderer 只能提交**会话引用 + ID + 收紧预算**。
 *
 * R33-2 三条硬要求：
 * 1. 会话身份：`cwd` 由主进程按 `BiosSessionRef` 从真实会话表解析，并核对 `runtimeGeneration`；
 * 2. 目录授权：用既有**标准化 + 包含关系**判定（不用原始 `startsWith`）；
 * 3. 末尾撤权门禁：列表与预览返回前重新检查配置/选择，撤权或切换只给有限缺口。
 */
import { buildHandoff } from "../../../packages/bios-agent/core/context/index.ts";
import { MODEL_DIAGNOSTIC_MAX_ITEMS, resolveModelBudget } from "../../../packages/bios-agent/core/context/policy.ts";
import { isWithinAuthorizedRoot } from "../../../packages/bios-agent/core/projects/authorization.ts";
import { requireFullyQualifiedRoot } from "../../../packages/bios-agent/core/paths.ts";
import { readProjectView } from "../../../packages/bios-agent/core/projects/index.ts";
import { listRecords, readRecord, readRegistry } from "../../../packages/bios-agent/core/storage/index.ts";
import { BIOS_TASK_LIST_LIMIT } from "../../shared/biosLimits.ts";
import type { BiosHostSettings, BiosListResult, BiosPreviewRequest, BiosPreviewResult, BiosProjectSummary, BiosReadiness, BiosRuntimeState, BiosSelectionMap, BiosSelectionRequest, BiosSessionClaim, BiosSessionSelection, BiosTaskSummary } from "../../shared/types/bios";
import { BIOS_SETTINGS_DEFAULTS } from "../../shared/types/bios.ts";
import { currentBiosBootId, normalizeBiosHostSettings, resolveSessionSelection } from "./biosProcessEnv.ts";

// 让"权威 env 构造"只有一份实现：需要它的调用方（IPC / main 装配）从这里取，
// 但 `PiProcess` 必须直接 import `./biosProcessEnv`（纯模块），别再绕回来。
export { applyBiosEnv, biosProcessEnv, currentBiosBootId, normalizeBiosHostSettings, resolveSessionSelection } from "./biosProcessEnv.ts";

/** 单次列表最多返回多少条（避免一次刷新把整个库读穿）；与渲染层的截断提示同源。 */
const MAX_LISTED_TASKS = BIOS_TASK_LIST_LIMIT;

export type BiosSessionResolution = {
	readonly agentId: string;
	readonly sessionId: string | null;
	/** 真实会话工作目录（不是 renderer 给的）。 */
	readonly cwd: string;
	/** 主进程看到的运行时代次。 */
	readonly generation: number;
};

/**
 * 真实会话端口：由 main 用既有 `AgentManager`（`list()` / `sendPrompt()`）装配，
 * 让本服务不依赖 Electron，也能在测试里换成合成实现。
 */
/** 同步的**期望**（R34-3）：两个动作都要核对，而不是"发过命令就算同步"。 */
export type BiosSelectionExpectation = {
	readonly projectId: string;
	readonly taskId: string;
	readonly workspaceId: string | null;
	readonly contextEnabled: boolean;
};

export type BiosSyncRequest = {
	readonly resolution: BiosSessionResolution;
	readonly sessionKey: string;
	/** 复用已有命令语法：`/bios-task select …` 与 `/bios-context on|off`。 */
	readonly commands: { readonly select: string; readonly context: string };
	readonly expectation: BiosSelectionExpectation;
	/** 原始请求：等待回执期间主进程必须重新解析确认绑定没变。 */
	readonly claim: BiosSessionClaim;
};

/** 运行中的会话（R35-1：策略收窄时要能枚举并失效）。 */
export type BiosSessionRuntimeInfo = {
	readonly agentId: string;
	readonly sessionId: string | null;
	/** 真实会话工作目录（R36-2：撤权要用可信 resolution，不能塞 `cwd: ""`）。 */
	readonly cwd: string;
	readonly generation: number;
};

/**
 * 会话端口（R35-1：**四个能力全部必填**）。
 *
 * 之前 `listSessions`/`pushContextOff` 是可选方法，生产 factory 没接 → 服务看到的是"没有旧 runtime"，
 * 收窄静默失效。改成必填后，缺能力就是编译错误，而不是运行期假象。
 */
export type BiosSessionPort = {
	/** 解析会话引用；找不到/代次不符返回错误。 */
	resolve(claim: BiosSessionClaim): { readonly resolution: BiosSessionResolution } | { readonly error: string };
	/** 当前运行中的会话（用于"配置收窄后按 runtime 失效旧许可"）。 */
	listSessions(): readonly BiosSessionRuntimeInfo[];
	/** 把"关闭上下文"推到某个运行中的会话并核对结构化回执（可信链更新）。 */
	pushContextOff(resolution: BiosSessionResolution): Promise<{ readonly receipt: string } | { readonly error: string }>;
	/**
	 * 停止旧 runtime（R35-1：旧进程不得继续用旧许可调用知识工具；会话记录保留，用户手动重开）。
	 *
	 * `replaced: true` 表示该代次已经被重开的新 runtime 取代（旧的本来就没了，不能去停新的那个）。
	 */
	stopRuntime(resolution: BiosSessionResolution): Promise<{ readonly stopped: boolean; readonly error: string | null; readonly replaced?: boolean }>;
	/**
	 * B-01：标记该 runtime 的授权已撤，**立即**阻断其业务发送（不等停止返回）。
	 *
	 * 缺省表示没有接撤权能力，读取侧门禁仍会挡住，但发送入口不会被即时阻断——生产装配必须提供。
	 */
	revokeAuthority?(resolution: BiosSessionResolution): void;
	/**
	 * 用**既有命令通道**把选择同步到当前会话（R34-3/R35-3）。
	 *
	 * 只有 `select` 与 `context on|off` **两个动作都拿到结构化成功回执**、且每个动作前后会话绑定
	 * （agentId/sessionId/generation/cwd/存活）都未变，才允许返回 `receipt`；否则返回 `error`
	 * 且**不得**继续向过期 runtime 发送后续命令。
	 */
	syncSelection(request: BiosSyncRequest): Promise<{ readonly receipt: string } | { readonly error: string }>;
};

export type BiosKnowledgeServiceOptions = {
	/** 读取当前桌面设置（由 main 注入）。 */
	readSettings: () => Partial<BiosHostSettings> | null;
	/** 读取按会话保存的选择。 */
	readSelections?: () => BiosSelectionMap | null;
	/** 写入按会话保存的选择。 */
	writeSelections?: (next: BiosSelectionMap) => Promise<void>;
	/** 真实会话解析（缺省即拒绝所有会话相关请求）。 */
	session?: BiosSessionPort;
	now?: () => number;
};

/** 末尾门禁的比较基准（配置 + 选择 + 本会话代次）。 */
type GateToken = {
	readonly config: string;
	readonly selection: string;
	readonly generation: number | null;
};

function tokenOf(settings: BiosHostSettings, sessionId: string | null, selection: BiosSessionSelection | null, generation: number | null): GateToken {
	return {
		config: [settings.knowledgeRoot ?? "none", [...settings.authorizedProjectIds].sort().join(","), [...settings.allowedFeatureIds].sort().join(","), [...settings.approvedCustomers].sort().join(","), [...settings.authorizedRoots].sort().join(","), settings.endpoint].join("|"),
		selection: selection === null ? "none" : `${selection.projectId ?? "-"}/${selection.taskId ?? "-"}/${selection.workspaceId ?? "-"}/${selection.contextEnabled ? "on" : "off"}`,
		generation,
	};
}

/**
 * cwd 是否落在已授权目录根内：**先规范化再按包含关系判定**。
 *
 * 原始 `startsWith` 会让 `D:\allowed-evil`（同前缀）与 `D:\allowed\..\outside` 通过。
 */
export function isCwdAuthorized(candidate: string, roots: readonly string[]): boolean {
	let target: string;
	try {
		target = requireFullyQualifiedRoot(candidate, "会话工作目录");
	} catch {
		return false;
	}
	for (const root of roots) {
		try {
			if (isWithinAuthorizedRoot(requireFullyQualifiedRoot(root, "授权目录根"), target)) return true;
		} catch {
			// 非法的授权根不参与判定（配置写入时会被过滤，这里是防御）。
		}
	}
	return false;
}

/**
 * 配置是否**收窄**（R34-4）：端点不再 allowed、知识根变化，或目录根/项目/需求/客户集合被收缩。
 *
 * 只描述授权收窄；运行时刷新另按有效配置变化判断，放宽也需要更新环境快照。
 */
export function isNarrowing(previous: BiosHostSettings, next: BiosHostSettings): boolean {
	const narrower = (before: readonly string[], after: readonly string[]): boolean => !before.every((entry) => after.includes(entry));
	if (previous.endpoint === "allowed" && next.endpoint !== "allowed") return true;
	// D4：具名许可变化（换模型/地址、重新确认、撤权）也是收窄——旧代次 runtime 的外发许可不再对得上，
	// 必须按"旧许可失效"处理，而不是让旧进程继续用旧绑定。
	if (grantKey(previous) !== grantKey(next) && previous.endpointGrant != null) return true;
	if (previous.knowledgeRoot !== null && previous.knowledgeRoot !== next.knowledgeRoot) return true;
	if (next.knowledgeRoot === null && previous.knowledgeRoot !== null) return true;
	return narrower(previous.authorizedRoots, next.authorizedRoots) || narrower(previous.authorizedProjectIds, next.authorizedProjectIds) || narrower(previous.allowedFeatureIds, next.allowedFeatureIds) || narrower(previous.approvedCustomers, next.approvedCustomers);
}

/** D4：具名许可的规范化比较键（provider/model/地址/版本）。 */
function grantKey(settings: BiosHostSettings): string {
	const grant = settings.endpointGrant;
	return grant == null ? "none" : `${grant.provider}/${grant.modelId}@${grant.origin}#${grant.version}`;
}

/** Pi 环境是启动快照：首次设置及放宽也必须失效旧代次；集合重排不算变更。 */
export function hasBiosConfigChanged(previous: BiosHostSettings, next: BiosHostSettings): boolean {
	const canonical = (settings: BiosHostSettings): string => JSON.stringify([settings.knowledgeRoot, settings.endpoint, grantKey(settings), ...[settings.authorizedProjectIds, settings.allowedFeatureIds, settings.approvedCustomers, settings.authorizedRoots].map((values) => [...new Set(values)].sort())]);
	return canonical(previous) !== canonical(next);
}

/** 过滤非法目录根（保留完全限定的绝对路径，返回被丢弃的条目以便如实说明）。 */
export function splitValidAuthorizedRoots(roots: readonly string[]): { readonly valid: string[]; readonly dropped: string[] } {
	const valid: string[] = [];
	const dropped: string[] = [];
	for (const root of roots) {
		try {
			valid.push(requireFullyQualifiedRoot(root, "授权目录根"));
		} catch {
			dropped.push(root);
		}
	}
	return { valid, dropped };
}

export class BiosKnowledgeService {
	private readonly options: BiosKnowledgeServiceOptions;
	/** 可信配置版本（每次成功写配置 +1；供界面显示）。 */
	private configVersion = 0;
	/**
	 * R34-4：**按 runtime 记录"旧许可"**。
	 *
	 * key = agentId，value = 有效配置变化时该会话的运行时代次。
	 * 只要它*仍然是那个代次*，这个子进程就还在用启动时的旧配置（env 不会变），
	 * 因此后续读取一律拒绝，直到它被隔离重开（重启会换代次 ⇒ 条目自动失效）。
	 */
	private readonly staleRuntimes = new Map<string, number>();
	/** 已确认**停止**的旧 runtime（UI 据此显示"已停止待重开"而不是"已尽力关闭"）。 */
	private readonly stoppedRuntimes = new Set<string>();
	/**
	 * B-01：停止**未确认退出**的旧 runtime 及其原因（UI 要显示"撤权未完成，旧进程可能仍有旧许可"）。
	 * key = agentId，value = 最近一次失败原因。
	 */
	private readonly stopFailures = new Map<string, string>();
	/** 按 runtime 记录的配置版本（写入失效时的 configVersion）。 */
	private readonly runtimeVersions = new Map<string, number>();
	/** 枚举运行中会话失败时的受控原因（不能让"枚举不到"静默等于"没有旧 runtime"）。 */
	private enumerationError: string | null = null;

	constructor(options: BiosKnowledgeServiceOptions) {
		this.options = options;
	}

	/**
	 * 运行中 runtime 的失效门禁（R34-4）：返回缺口原因表示"该会话仍是旧许可，必须隔离重开"。
	 *
	 * 代次已变（重开过）⇒ 顺手清掉记录，按新配置继续。
	 */
	private runtimeGate(resolution: BiosSessionResolution): string | null {
		const staleGeneration = this.staleRuntimes.get(resolution.agentId);
		if (staleGeneration === undefined) return null;
		if (staleGeneration !== resolution.generation) {
			this.staleRuntimes.delete(resolution.agentId);
			this.stoppedRuntimes.delete(resolution.agentId);
			this.stopFailures.delete(resolution.agentId);
			return null;
		}
		return `可信配置已更新，而该会话仍运行在旧 runtime（代次 ${resolution.generation}）上：旧环境快照不可继续使用。请隔离重开该会话（重开会重新注入可信配置），再继续读取。`;
	}

	private now(): number {
		return this.options.now?.() ?? Date.now();
	}

	private settings(): BiosHostSettings {
		return normalizeBiosHostSettings(this.options.readSettings() ?? BIOS_SETTINGS_DEFAULTS);
	}

	private bootId(): string {
		return currentBiosBootId();
	}

	private selections(): BiosSelectionMap {
		const stored = this.options.readSelections?.() ?? null;
		return stored ?? { bySession: {}, bootId: this.bootId() };
	}

	/** 本会话的选择（**不含**代次校验；调用方负责先解析身份）。 */
	private selectionFor(sessionId: string | null): BiosSessionSelection | null {
		const resolved = resolveSessionSelection(this.selections(), this.bootId(), sessionId);
		if (resolved === undefined) return null;
		return { ...resolved, updatedAt: 0 };
	}

	/** 当前可信配置版本（供人工业务适配在结果守卫里回显；每次成功写配置 +1）。 */
	currentConfigurationVersion(): number {
		return this.configVersion;
	}

	/** 就绪判定：缺知识根或没有任何授权即"未就绪"（拒绝读取，不猜目录）。 */
	readiness(): BiosReadiness {
		const settings = this.settings();
		if (settings.knowledgeRoot === null) return { ready: false, reason: "未配置知识根：请在设置里选择知识库目录（未配置时拒绝读取）", knowledgeRootConfigured: false };
		if (settings.authorizedProjectIds.length === 0 && settings.allowedFeatureIds.length === 0 && settings.approvedCustomers.length === 0) {
			return { ready: false, reason: "未授权任何项目/需求/客户：请在设置里明确授权范围", knowledgeRootConfigured: true };
		}
		return { ready: true, reason: null, knowledgeRootConfigured: true };
	}

	/**
	 * 运行中会话的同步状态（R33-3）：配置改了以后**已有 Pi 子进程仍在用旧配置**，
	 * 界面必须说明"当前会话未生效"，不能让"下次启动生效"被读成"当前已撤权"。
	 */
	runtimeState(): BiosRuntimeState {
		const staleCount = this.staleRuntimes.size;
		const stopped = [...this.stoppedRuntimes];
		// B-01：失败原因按 agentId 保留（含已不在 stale 集合里的，供 UI 如实展示恢复步骤）。
		const stopFailures = [...this.stopFailures.entries()].map(([agentId, reason]) => ({ agentId, reason }));
		const note = ((): string | null => {
			if (this.enumerationError !== null) return `无法确认运行中会话（${this.enumerationError}）：请手动结束相关会话进程后重开，不要按"当前没有旧 runtime"理解。`;
			if (staleCount === 0) return null;
			const failed = [...this.staleRuntimes.keys()].filter((agentId) => !this.stoppedRuntimes.has(agentId));
			if (failed.length > 0) {
				// B-01：停止不能确认退出 ⇒ 不得显示「安全已生效」，必须明确"撤权未完成"并给出恢复步骤。
				const reasons = failed.map((agentId) => `${agentId}：${this.stopFailures.get(agentId) ?? "未确认退出"}`).join("；");
				return `撤权未完成：${stopped.length} 个会话已停止待重开，另有 ${failed.length} 个会话停止失败，旧进程可能仍有旧许可（${reasons}）。请重试停止，或手动结束这些会话进程后重开；撤权是否收口以「停止确认退出」为准。`;
			}
			return `配置已更新：${stopped.length} 个运行中的会话已停止（保留会话记录）。请手动重开新代次后继续；重开会重新注入可信配置。`;
		})();
		return {
			configVersion: this.configVersion,
			pendingRestart: staleCount > 0 || this.enumerationError !== null,
			stoppedRuntimes: stopped,
			stopFailures,
			note,
		};
	}

	/** 会话身份 + 代次校验（假身份/迟到一律拒绝）。 */
	private resolveClaim(claim: BiosSessionClaim): { readonly resolution: BiosSessionResolution } | { readonly error: string } {
		const port = this.options.session;
		if (port === undefined) return { error: "当前环境没有可用的会话解析（缺少 AgentManager 装配）" };
		return port.resolve(claim);
	}

	/** 只有**已授权**项目可见（未授权项目连 ID 都不出现在列表里）。 */
	async listProjects(claim: BiosSessionClaim): Promise<BiosListResult<BiosProjectSummary>> {
		const identified = this.resolveClaim(claim);
		if ("error" in identified) return { items: [], gap: identified.error };
		// UX-02/R34-4：配置变化后仍跑在旧 runtime 上的会话一律拒绝。
		const gate = this.runtimeGate(identified.resolution);
		if (gate !== null) return { items: [], gap: gate };
		const settings = this.settings();
		if (!this.readiness().ready || settings.knowledgeRoot === null) return { items: [], gap: this.readiness().reason };
		const sessionId = identified.resolution.sessionId;
		const before = tokenOf(settings, sessionId, this.selectionFor(sessionId), identified.resolution.generation);
		const items: BiosProjectSummary[] = [];
		const names = new Map<string, string>();
		const desktopOwners = new Map<string, string>();
		try {
			const registry = await readRegistry({ root: settings.knowledgeRoot });
			for (const project of registry.projects) {
				if (!settings.authorizedProjectIds.includes(project.biosProjectId)) continue;
				if (project.displayName !== undefined) names.set(project.biosProjectId, project.displayName);
				if (project.desktopProjectId !== undefined) desktopOwners.set(project.biosProjectId, project.desktopProjectId);
			}
		} catch {
			// 旧/损坏条目的具体缺口由原项目读取链报告，不为名字另造 IO 或猜测事实。
		}
		for (const projectId of settings.authorizedProjectIds) {
			try {
				const view = await readProjectView({
					root: settings.knowledgeRoot,
					cwd: identified.resolution.cwd,
					authorizedRoots: settings.authorizedRoots,
					biosProjectId: projectId,
					verifyEvidence: true,
					probeVcs: false,
					now: this.now(),
				});
				const profile = view.open.profile;
				if (profile === null) continue;
				const drift = new Map<string, { readonly klass: string; readonly reasons: readonly string[] }>();
				for (const item of view.decision?.items ?? []) {
					if (item.factKey !== null) drift.set(item.factKey, { klass: item.class, reasons: item.reasons });
				}
				const identity = Object.entries(profile.identity).map(([field, entry]) => {
					const fact = drift.get(`project-profile.${field}`);
					return { field, value: entry.value, status: entry.status, needsReview: fact?.klass === "needs-review", reasons: [...(fact?.reasons ?? [])] };
				});
				items.push({
					projectId,
					...(desktopOwners.has(projectId) ? { desktopProjectId: desktopOwners.get(projectId) } : {}),
					...(names.has(projectId) ? { displayName: names.get(projectId) } : {}),
					profileRevision: view.revisions.profile,
					identity,
					workspaces: profile.workspaces.map((workspace) => ({ workspaceId: workspace.workspaceId, path: workspace.path, availability: workspace.availability })),
					needsReviewCount: identity.filter((entry) => entry.needsReview).length,
					problems: view.problems.slice(0, 5),
				});
			} catch {
				// 单个项目读不出来不影响其它项目；缺口由 readiness/problems 体现。
			}
		}
		// 末尾门禁：读完再比一次（读取期间撤权/换根/切会话 ⇒ 只给有限缺口）。
		const after = this.recheck(claim, before, identified.resolution);
		return after === null ? { items, gap: null } : { items: [], gap: after };
	}

	/** 只列出**已授权项目**下的任务（不跨项目猜测，不自动选第一个）。 */
	async listTasks(claim: BiosSessionClaim & { readonly projectId: string }): Promise<BiosListResult<BiosTaskSummary>> {
		const identified = this.resolveClaim(claim);
		if ("error" in identified) return { items: [], gap: identified.error };
		// UX-02/R34-4：配置变化后仍跑在旧 runtime 上的会话一律拒绝。
		const gate = this.runtimeGate(identified.resolution);
		if (gate !== null) return { items: [], gap: gate };
		const settings = this.settings();
		if (settings.knowledgeRoot === null) return { items: [], gap: "未配置知识根" };
		if (!settings.authorizedProjectIds.includes(claim.projectId)) return { items: [], gap: "项目不在授权集合内" };
		const sessionId = identified.resolution.sessionId;
		const before = tokenOf(settings, sessionId, this.selectionFor(sessionId), identified.resolution.generation);
		const listed = await listRecords({ root: settings.knowledgeRoot, kind: "task-record", projectId: claim.projectId });
		const items: BiosTaskSummary[] = [];
		for (const entry of listed.entries.slice(0, MAX_LISTED_TASKS)) {
			const summary = await this.readTaskSummary(claim.projectId, entry.id);
			if (summary !== null) items.push(summary);
		}
		const after = this.recheck(claim, before, identified.resolution);
		return after === null ? { items, gap: null } : { items: [], gap: after };
	}

	private async readTaskSummary(projectId: string, taskId: string): Promise<BiosTaskSummary | null> {
		const settings = this.settings();
		if (settings.knowledgeRoot === null) return null;
		try {
			const read = await readRecord({ root: settings.knowledgeRoot, kind: "task-record", id: taskId, projectId });
			const record = read.record;
			return { projectId, taskId, revision: record.revision, status: record.status, requirement: record.requirement, workspaceId: record.workspace.workspaceId, updatedAt: record.updatedAt, blockerCount: record.blockers.length, todoCount: record.todos.length };
		} catch {
			return null;
		}
	}

	/**
	 * 末尾门禁（R34-2）：返回 null 表示"没变"，否则返回可读缺口原因（正文一律丢弃）。
	 *
	 * 三件事都要重验，**不能拿调用方传入的旧 generation 自比**：
	 * 1. 真实 runtime 身份：重新调 session port 解析（会话是否还存在、agentId/sessionId/generation/cwd 是否一致）；
	 * 2. 可信配置（端点/授权/知识根/目录根）；
	 * 3. 本会话选择。
	 */
	private recheck(claim: BiosSessionClaim, before: GateToken, resolution: BiosSessionResolution): string | null {
		const settings = this.settings();
		const again = this.resolveClaim(claim);
		if ("error" in again) return `读取期间会话已不可用（${again.error}）：本次结果作废`;
		const current = again.resolution;
		if (current.generation !== resolution.generation) return `读取期间会话运行时代次已变化（${resolution.generation} → ${current.generation}）：本次结果作废（不把旧结果算到新 runtime）`;
		if (current.cwd !== resolution.cwd) return "读取期间会话工作目录已变化：本次结果作废（身份依据不成立）";
		if (current.sessionId !== resolution.sessionId) return "读取期间会话身份已变化：本次结果作废";
		const after = tokenOf(settings, current.sessionId, this.selectionFor(current.sessionId), current.generation);
		if (after.config !== before.config) return "读取期间可信配置（端点/授权项目/需求/客户/知识根/目录根）已变化：本次结果作废（请按新配置重新读取）";
		if (after.selection !== before.selection) return "读取期间本会话的选择已变化：本次结果作废（请重新读取）";
		return null;
	}

	/**
	 * 预览交接内容（**本地人工可见**）。
	 *
	 * `maySendToModel` = 端点允许外发 **且** 身份可用（R33-2/R33-3 的共享契约）；
	 * 配置在读取期间收窄 ⇒ 只给缺口（`stable=false`、`maySendToModel=false`），不返回旧正文。
	 */
	async preview(request: BiosPreviewRequest): Promise<BiosPreviewResult> {
		const identified = this.resolveClaim(request);
		if ("error" in identified) throw new Error(identified.error);
		const gate = this.runtimeGate(identified.resolution);
		if (gate !== null) throw new Error(gate);
		const settings = this.settings();
		if (settings.knowledgeRoot === null) throw new Error("未配置知识根");
		if (!settings.authorizedProjectIds.includes(request.projectId)) throw new Error("项目不在授权集合内");
		// R33-2：目录授权用标准化 + 包含关系（会话目录必须落在已授权目录根内）。
		if (!isCwdAuthorized(identified.resolution.cwd, settings.authorizedRoots)) {
			throw new Error("会话工作目录不在已授权的目录根内：请先在设置里授权该目录");
		}
		// R33-4：与工具/注入**共用**同一份硬上限；参数只能收紧（超限夹紧并标记 clamped）。
		const budget = resolveModelBudget(request.budgetChars === undefined ? undefined : { maxChars: request.budgetChars });
		const sessionId = identified.resolution.sessionId;
		const before = tokenOf(settings, sessionId, this.selectionFor(sessionId), identified.resolution.generation);
		const handoff = await buildHandoff({
			root: settings.knowledgeRoot,
			targetProjectId: request.projectId,
			taskId: request.taskId,
			...(request.workspaceId === null ? {} : { workspaceId: request.workspaceId }),
			cwd: identified.resolution.cwd,
			authorizedRoots: settings.authorizedRoots,
			authorizedProjectIds: settings.authorizedProjectIds,
			endpoint: { endpointAllowed: settings.endpoint === "allowed" ? true : settings.endpoint === "denied" ? false : null, allowInternalGeneral: false, customers: settings.approvedCustomers },
			allowedFeatureIds: settings.allowedFeatureIds,
			budget: { maxChars: budget.maxChars, maxBytes: budget.maxBytes },
			...(request.query === undefined ? {} : { query: request.query }),
		});
		const gap = this.recheck(request, before, identified.resolution);
		const maySend = handoff.outbound.allowCommercialBody && handoff.identityUsable && gap === null;
		// R33-4：**元数据另设限额**——来源清单属于结构化元数据，不能随记录条数无限增长。
		const sourceItems = handoff.sources.slice(0, MODEL_DIAGNOSTIC_MAX_ITEMS).map((source) => ({ recordKind: source.recordKind, recordId: source.recordId, revision: source.revision }));
		const inspectedItems = handoff.inspectedSources.slice(0, MODEL_DIAGNOSTIC_MAX_ITEMS).map((source) => ({ recordKind: source.recordKind, recordId: source.recordId, revision: source.revision }));
		const sourcesTruncated = handoff.sources.length > sourceItems.length || handoff.inspectedSources.length > inspectedItems.length;
		return {
			status: gap === null ? handoff.status : "stale",
			text: gap === null ? handoff.text : `本次预览已作废：${gap}`,
			maySendToModel: maySend,
			identityUsable: handoff.identityUsable,
			stable: gap === null,
			outboundNote: gap === null ? handoff.outbound.note : "配置已变化：旧正文不再作为可发送内容",
			budget: { maxChars: budget.maxChars, maxBytes: budget.maxBytes, usedChars: handoff.budget.usedChars, usedBytes: handoff.budget.usedBytes, truncated: handoff.budget.truncated, clamped: budget.clamped },
			retainedSources: sourceItems,
			inspectedSources: inspectedItems,
			retainedSourceCount: handoff.sources.length,
			inspectedSourceCount: handoff.inspectedSources.length,
			sourcesTruncated,
			expiredSources: handoff.expiredSources.slice(0, MODEL_DIAGNOSTIC_MAX_ITEMS),
			problems: [...handoff.problems.slice(0, MODEL_DIAGNOSTIC_MAX_ITEMS), ...(gap === null ? [] : [gap])],
		};
	}

	/**
	 * 写可信配置（由 IPC 调用）：规范化 + 过滤非法目录根 + **按 runtime 失效旧许可**（R34-4）。
	 *
	 * 任何有效配置变化都使旧环境快照失效（包括首次配置与放宽；相同集合重排除外）。
	 * 失效时还会尽力用既有命令通道把"关闭上下文"推到这些会话并核对回执，
	 * 拿不到回执也不影响"已被门禁挡住"这件事——**不以文案代替执行门禁**。
	 */
	async updateSettings(patch: Partial<BiosHostSettings>): Promise<{
		readonly settings: BiosHostSettings;
		readonly droppedRoots: readonly string[];
		readonly runtime: BiosRuntimeState;
		readonly invalidated: readonly string[];
		readonly pushedOff: readonly string[];
		readonly stopped: readonly string[];
		readonly stopFailed: readonly string[];
		readonly stopFailureDetails: readonly { readonly agentId: string; readonly reason: string }[];
	}> {
		const previous = this.settings();
		const normalized = normalizeBiosHostSettings({ ...previous, ...patch });
		const { valid, dropped } = splitValidAuthorizedRoots(normalized.authorizedRoots);
		const settings: BiosHostSettings = { ...normalized, authorizedRoots: valid };
		this.configVersion += 1;
		const invalidated: string[] = [];
		const pushedOff: string[] = [];
		const stopped: string[] = [];
		const stopFailed: string[] = [];
		const stopFailureDetails: { readonly agentId: string; readonly reason: string }[] = [];
		if (hasBiosConfigChanged(previous, settings)) {
			let sessions: readonly BiosSessionRuntimeInfo[];
			try {
				sessions = this.options.session?.listSessions() ?? [];
			} catch (error) {
				// R35-1：**枚举失败不等于"没有旧 runtime"**：保守地保留已知旧许可并如实报缺口。
				this.enumerationError = error instanceof Error ? error.message : "枚举运行中会话失败";
				sessions = [];
			}
			if (this.options.session === undefined) {
				this.enumerationError = "没有接入会话端口：无法确认是否存在旧 runtime";
			} else if (typeof this.options.session.listSessions !== "function") {
				// 类型上必填，运行期仍防御：缺能力要报"无法确认"，不能静默等于"没有旧 runtime"。
				this.enumerationError = "会话端口没有接入 listSessions：无法确认是否存在旧 runtime";
			}
			for (const session of sessions) {
				// R36-2：用**可信实际 resolution**（真实 cwd）；假 cwd 会让发送前绑定核对直接失败。
				const resolution: BiosSessionResolution = { agentId: session.agentId, sessionId: session.sessionId, cwd: session.cwd, generation: session.generation };
				// 先标记旧许可：桌面侧门禁立即生效，不必等命令往返。
				this.staleRuntimes.set(session.agentId, session.generation);
				this.runtimeVersions.set(session.agentId, this.configVersion);
				// B-01：标记的同时**立即撤权**——阻断该 runtime 的新业务发送，不等停止返回；
				// 同时清理上一轮的失败记录（本次重新尝试，不能沿用旧原因）。
				this.stopFailures.delete(session.agentId);
				try {
					this.options.session?.revokeAuthority?.(resolution);
				} catch {
					/* 撤权失败不阻塞流程：读取侧与停止仍会收口 */
				}
				invalidated.push(`${session.agentId}@${session.generation}`);
				// R36-2：**优先落实停止**——不在等待 off 回执期间保留可外发的旧许可。
				let stop: { readonly stopped: boolean; readonly error: string | null; readonly replaced?: boolean } = { stopped: false, error: "未接入停止运行时" };
				try {
					const outcome = await this.options.session?.stopRuntime?.(resolution);
					if (outcome !== undefined) stop = outcome;
				} catch (error) {
					stop = { stopped: false, error: error instanceof Error ? error.message : "停止失败" };
				}
				if (stop.stopped) {
					stopped.push(session.agentId);
					this.stoppedRuntimes.add(session.agentId);
					this.stopFailures.delete(session.agentId);
					continue;
				}
				// 停止没成功：再尽力用命令通道推"关闭上下文"（进程还在），并如实记录是否拿到回执。
				let push: { readonly receipt: string } | { readonly error: string } = { error: "未接入关闭推送" };
				try {
					const outcome = await this.options.session?.pushContextOff?.(resolution);
					if (outcome !== undefined) push = outcome;
				} catch (error) {
					push = { error: error instanceof Error ? error.message : "推送失败" };
				}
				if ("receipt" in push) pushedOff.push(session.agentId);
				stopFailed.push(session.agentId);
				// B-01：保留失败原因，UI 必须显示"撤权未完成"而不是"安全已生效"。
				const reason = stop.error ?? "未能确认旧进程退出";
				this.stopFailures.set(session.agentId, reason);
				stopFailureDetails.push({ agentId: session.agentId, reason });
				this.stoppedRuntimes.delete(session.agentId);
			}
		}
		return { settings, droppedRoots: dropped, runtime: this.runtimeState(), invalidated, pushedOff, stopped, stopFailed, stopFailureDetails };
	}

	/**
	 * 人工选择同步：**按会话**登记（只存 ID 与非敏感开关），并尽量用既有命令通道取回执。
	 *
	 * 拿不到回执时如实返回 `mode: "env"` / `currentSessionSynced: false`，
	 * 不把"待启动生效"冒充"当前会话已生效"。
	 */
	async applySelection(request: BiosSelectionRequest): Promise<{ readonly mode: "env" | "rpc" | "none"; readonly applied: boolean; readonly receipt: string; readonly reason: string | null; readonly currentSessionSynced: boolean }> {
		const identified = this.resolveClaim(request);
		if ("error" in identified) return { mode: "none", applied: false, receipt: `选择未采纳：${identified.error}`, reason: "session-unverified", currentSessionSynced: false };
		const gate = this.runtimeGate(identified.resolution);
		if (gate !== null) return { mode: "none", applied: false, receipt: `选择未采纳：${gate}`, reason: "runtime-stale", currentSessionSynced: false };
		const settings = this.settings();
		if (!settings.authorizedProjectIds.includes(request.projectId)) return { mode: "none", applied: false, receipt: "选择未采纳：项目不在授权集合内（先在设置里授权）", reason: "project-unauthorized", currentSessionSynced: false };
		const resolution = identified.resolution;
		const sessionKey = resolution.sessionId ?? resolution.agentId;
		const stored = this.selections();
		const next: BiosSelectionMap = { bySession: { ...stored.bySession, [sessionKey]: { projectId: request.projectId, taskId: request.taskId, workspaceId: request.workspaceId, contextEnabled: request.contextEnabled, updatedAt: this.now() } }, bootId: this.bootId() };
		await this.options.writeSelections?.(next);
		// R34-3：两个动作分开表达——select 只负责选任务，开关走 `/bios-context on|off`；
		// `--off` 这种"猜的参数"不存在，拼进去只会被当成 workspace（命令直接失败）。
		const expectation: BiosSelectionExpectation = { projectId: request.projectId, taskId: request.taskId, workspaceId: request.workspaceId, contextEnabled: request.contextEnabled };
		const commands = {
			select: `/bios-task select ${request.projectId} ${request.taskId}${request.workspaceId === null ? "" : ` ${request.workspaceId}`}`,
			context: `/bios-context ${request.contextEnabled ? "on" : "off"}`,
		};
		const synced = this.options.session?.syncSelection === undefined ? { error: "没有可用的命令通道" } : await this.options.session.syncSelection({ resolution, sessionKey, commands, expectation, claim: request });
		if ("receipt" in synced) {
			return { mode: "rpc", applied: true, receipt: `已同步到当前会话：${synced.receipt}`, reason: null, currentSessionSynced: true };
		}
		return {
			mode: "env",
			applied: true,
			receipt: `已登记选择意图：项目 ${request.projectId}｜任务 ${request.taskId}｜工作区 ${request.workspaceId ?? "未指定"}｜上下文注入 ${request.contextEnabled ? "开" : "关"}（仅对**新建/重启后**的 Pi 会话生效；当前会话未同步：${synced.error}）`,
			reason: "not-synced-to-current-session",
			currentSessionSynced: false,
		};
	}
}

/** 主进程装配入口。 */
export function createBiosKnowledgeService(options: BiosKnowledgeServiceOptions): BiosKnowledgeService {
	return new BiosKnowledgeService(options);
}
