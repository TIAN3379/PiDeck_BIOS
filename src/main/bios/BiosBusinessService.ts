/**
 * BM-07B B-02：**人工业务主进程适配**（复用 core，不另造数据层）。
 *
 * 三条硬边界（`bm07b_batch_development_plan.md` §2 / §B-02）：
 * 1. renderer 只能提交**业务 ID、正文、expectedRevision、人工标签**；`root`/`cwd`/授权集合/
 *    工作区路径一律由主进程从可信配置与**真实桌面项目表**解析，请求里的同名字段不予采信；
 * 2. 写动作在调用 core 前补齐授权与工作区核对（core 的部分入口没有授权形参），
 *    初次授权必须显式办理：**不会因为 UI 点了"新建"就自动追加全局许可**；
 * 3. 结果保留 core 的判别式（status/revision/actualRevision/分步/warnings/needsReview/problems），
 *    并按「是否已提交」给出 `committed`——部分完成/审计待核对属于已提交，不假称回滚。
 *
 * 本模块只做适配：不复制 Pi 的模型/工具/会话循环，也不注册为 LLM 工具。
 */
import { join } from "node:path";
import { saveContextManifest, verifyContextManifest } from "../../../packages/bios-agent/core/context/index.ts";
import { isFullyQualifiedPath } from "../../../packages/bios-agent/core/paths.ts";
import { exportKnowledgeBackup, restoreKnowledgeBackup } from "../../../packages/bios-agent/core/storage/backup/index.ts";
import { initializeKnowledgeStore } from "../../../packages/bios-agent/core/storage/index.ts";
import { bindProjectWorkspace, openProjectProfile } from "../../../packages/bios-agent/core/projects/index.ts";
import { detectProjectCandidates } from "../../../packages/bios-agent/core/projects/detection.ts";
import { confirmProfileFields } from "../../../packages/bios-agent/core/projects/confirm.ts";
import { readProjectView } from "../../../packages/bios-agent/core/projects/index.ts";
import { createTask, readTaskDetail, updateTask, changeTaskStatus } from "../../../packages/bios-agent/core/tasks/index.ts";
import { prepareExperienceDraftFromTask, saveExperienceDraftFromTask } from "../../../packages/bios-agent/core/tasks/index.ts";
import { createFeature, updateFeature, readFeatureDetail } from "../../../packages/bios-agent/core/knowledge/index.ts";
import { createExperienceDraft, updateExperienceDraft, readExperienceDetail, reviewExperience } from "../../../packages/bios-agent/core/knowledge/index.ts";
import { searchKnowledge, readExperienceReference } from "../../../packages/bios-agent/core/knowledge/index.ts";
import type { BiosHostSettings, BiosStoreStatus } from "../../shared/types/bios";
import { readBiosStoreStatus } from "./BiosStoreStatus.ts";
import type {
	BiosBindRequest,
	BiosBusinessEnvelope,
	BiosBusinessGuard,
	BiosBusinessRequestBase,
	BiosConfirmRequest,
	BiosDetectRequest,
	BiosDraftPrefillRequest,
	BiosDraftSaveRequest,
	BiosExportBackupRequest,
	BiosRestoreBackupRequest,
	BiosExperienceCreateRequest,
	BiosExperienceDetailRequest,
	BiosExperienceReviewRequest,
	BiosExperienceUpdateRequest,
	BiosFeatureCreateRequest,
	BiosFeatureDetailRequest,
	BiosFeatureUpdateRequest,
	BiosInitializeRequest,
	BiosManifestSaveRequest,
	BiosManifestVerifyRequest,
	BiosProjectViewRequest,
	BiosReferenceRequest,
	BiosSearchRequest,
	BiosTaskCreateRequest,
	BiosTaskDetailRequest,
	BiosTaskStatusRequest,
	BiosTaskUpdateRequest,
} from "../../shared/types/biosBusiness";
// 显式 .ts 扩展名：既满足 Node 22 type-stripping 直跑测试，也让打包工具的解析路径固定。
import { normalizeBiosHostSettings } from "./biosProcessEnv.ts";
import { BiosStoreWriteGate } from "./BiosStoreWriteGate.ts";
import type { BiosSessionPort, BiosSessionResolution } from "./BiosKnowledgeService";

/** 桌面项目表解析器：把 `desktopProjectId` 映射到**真实**工作目录（主进程注入）。 */
export type BiosDesktopProjectResolver = (desktopProjectId: string) => string | null;

export type BiosBusinessServiceOptions = {
	/** Shared with the human library so offline backup excludes every local writer. */
	writeGate?: BiosStoreWriteGate;
	/** 读取可信配置（由 main 注入）。 */
	readSettings: () => Partial<BiosHostSettings> | null;
	/** 会话身份/代次（与 BIOS 只读服务共用同一个实例）。 */
	session?: BiosSessionPort;
	/** 真实桌面项目路径解析（缺省时管理类动作无法定位工作区，只读业务仍可用）。 */
	resolveDesktopProjectPath?: BiosDesktopProjectResolver;
	/** 可信配置版本（由 `BiosKnowledgeService` 提供，用于结果守卫）。 */
	readConfigurationVersion?: () => number;
	now?: () => number;
};

/** 守卫基准：配置 + 会话身份（业务写入不依赖"选择"，故不必纳入）。 */
type GuardToken = {
	readonly config: string;
	readonly identity: string;
};

/**
 * 判断一次 core 写入结果是否**已经产生落盘提交**。
 *
 * 部分完成（`partial` / `needs-review` / 草稿已建但回链失败 / 审计待核对）都属于已提交：
 * UI 只能如实说明分步事实，不得据此假称回滚或自动重试。
 */
export function isCommittedWrite(status: string): boolean {
	return (
		status === "created" ||
		status === "updated" ||
		status === "changed" ||
		status === "applied" ||
		status === "audit-pending" ||
		status === "journal-pending" ||
		status === "saved" ||
		status === "replaced" ||
		status === "restored" ||
		status === "committed-needs-review" ||
		status === "bound" ||
		status === "needs-review" ||
		status === "partial" ||
		status === "confirmed" ||
		status === "draft-saved" ||
		status === "link-conflict" ||
		status === "link-failed"
	);
}

export class BiosBusinessService {
	private readonly options: BiosBusinessServiceOptions;
	private readonly writeGate: BiosStoreWriteGate;

	constructor(options: BiosBusinessServiceOptions) {
		this.options = options;
		this.writeGate = options.writeGate ?? new BiosStoreWriteGate();
	}

	private now(): number {
		return this.options.now?.() ?? Date.now();
	}

	private settings(): BiosHostSettings {
		return normalizeBiosHostSettings(this.options.readSettings() ?? undefined);
	}

	private configVersion(): number {
		return this.options.readConfigurationVersion?.() ?? 0;
	}

	/** 未配置知识根即拒绝（不猜目录）。 */
	private requireRoot(settings: BiosHostSettings): string {
		if (settings.knowledgeRoot === null) throw new Error("未配置知识根：请先在设置里选择知识库目录");
		return settings.knowledgeRoot;
	}

	/** 会话身份解析（假身份/迟到一律拒绝）。 */
	private resolveClaim(request: BiosBusinessRequestBase): BiosSessionResolution {
		const port = this.options.session;
		if (port === undefined) throw new Error("当前环境没有可用的会话解析（缺少 AgentManager 装配）");
		const identified = port.resolve(request);
		if ("error" in identified) throw new Error(identified.error);
		return identified.resolution;
	}

	private guardToken(settings: BiosHostSettings, resolution: BiosSessionResolution): GuardToken {
		return {
			config: this.configurationKey(settings),
			identity: [resolution.agentId, resolution.sessionId ?? "-", resolution.cwd, resolution.generation].join("|"),
		};
	}

	private configurationKey(settings: BiosHostSettings): string {
		return JSON.stringify([this.configVersion(), settings.knowledgeRoot, [...settings.authorizedProjectIds].sort(), [...settings.allowedFeatureIds].sort(), [...settings.approvedCustomers].sort(), [...settings.authorizedRoots].sort(), settings.endpoint]);
	}

	/** 读取/写入期间配置或身份变化 ⇒ 结果不得作为当前依据（正文由调用方丢弃或标记 stale）。 */
	private staleReason(request: BiosBusinessRequestBase, before: GuardToken, resolution: BiosSessionResolution): string | null {
		const again = ((): BiosSessionResolution | null => {
			try {
				return this.resolveClaim(request);
			} catch {
				return null;
			}
		})();
		if (again === null) return "动作期间会话已不可用：本次结果作废";
		if (again.generation !== resolution.generation) return `动作期间会话运行时代次已变化（${resolution.generation} → ${again.generation}）：本次结果作废`;
		if (again.cwd !== resolution.cwd) return "动作期间会话工作目录已变化：本次结果作废";
		if (again.sessionId !== resolution.sessionId) return "动作期间会话身份已变化：本次结果作废";
		const after = this.guardToken(this.settings(), again);
		if (after.config !== before.config) return "动作期间可信配置（知识根/授权/端点/目录根）已变化：本次结果作废（请按新配置重做）";
		if (after.identity !== before.identity) return "动作期间会话身份已变化：本次结果作废";
		return null;
	}

	/**
	 * 会话绑定动作的入口：解析身份 + 检查就绪 + 记录守卫基准。
	 *
	 * 前置拒绝（假会话/未就绪）以结构化 Error 抛出——这些是"请求本不该发生"的领域拒绝，
	 * 不是"部分完成"的业务结果。
	 */
	private open(request: BiosBusinessRequestBase): { settings: BiosHostSettings; root: string; resolution: BiosSessionResolution; before: GuardToken } {
		const resolution = this.resolveClaim(request);
		const settings = this.settings();
		const root = this.requireRoot(settings);
		if (settings.authorizedProjectIds.length === 0 && settings.allowedFeatureIds.length === 0 && settings.approvedCustomers.length === 0) {
			throw new Error("未授权任何项目/需求/客户：请先在设置里明确授权范围");
		}
		return { settings, root, resolution, before: this.guardToken(settings, resolution) };
	}

	private envelope<T>(request: BiosBusinessRequestBase, before: GuardToken, resolution: BiosSessionResolution, result: T, committed: boolean): BiosBusinessEnvelope<T> {
		const reason = this.staleReason(request, before, resolution);
		const guard: BiosBusinessGuard = { configurationVersion: this.configVersion(), stable: reason === null, staleReason: reason };
		return { result, committed, guard };
	}

	/** 无会话管理入口的守卫（只用配置版本：没有 runtime 身份可核对）。 */
	private manageGuard<T>(before: string, result: T, committed: boolean): BiosBusinessEnvelope<T> {
		const stable = before === this.configurationKey(this.settings());
		return { result, committed, guard: { configurationVersion: this.configVersion(), stable, staleReason: stable ? null : "动作期间可信配置已变化：本次结果不能作为当前依据，请刷新后核对已提交事实" } };
	}

	/* ------------------------------------------------------------ 任务 */

	async createTask(request: BiosTaskCreateRequest): Promise<BiosBusinessEnvelope<import("../../shared/types/biosBusiness").TaskWriteResult>> {
		const { settings, root, resolution, before } = this.open(request);
		if (!settings.authorizedProjectIds.includes(request.projectId)) throw new Error("项目不在授权集合内：请先在设置里授权该项目");
		const result = await this.writeGate.write(root, () =>
			createTask({
				root,
				projectId: request.projectId,
				taskId: request.taskId,
				workspaceId: request.workspaceId,
				cwd: resolution.cwd,
				authorizedRoots: settings.authorizedRoots,
				authorizedProjectIds: settings.authorizedProjectIds,
				requirement: request.requirement,
				...(request.branch === undefined ? {} : { branch: request.branch }),
				...(request.baseCommit === undefined ? {} : { baseCommit: request.baseCommit }),
				...(request.decisions === undefined ? {} : { decisions: request.decisions }),
				...(request.todos === undefined ? {} : { todos: request.todos }),
				...(request.blockers === undefined ? {} : { blockers: request.blockers }),
				...(request.relatedFiles === undefined ? {} : { relatedFiles: request.relatedFiles }),
				...(request.sourceExperienceIds === undefined ? {} : { sourceExperienceIds: request.sourceExperienceIds }),
				...(request.validations === undefined ? {} : { validations: request.validations }),
				now: this.now(),
			}),
		);
		return this.envelope(request, before, resolution, result, isCommittedWrite(result.status));
	}

	async readTaskDetail(request: BiosTaskDetailRequest): Promise<BiosBusinessEnvelope<import("../../shared/types/biosBusiness").TaskDetailResult>> {
		const { settings, root, resolution, before } = this.open(request);
		const result = await readTaskDetail({ root, projectId: request.projectId, taskId: request.taskId, cwd: resolution.cwd, authorizedRoots: settings.authorizedRoots, authorizedProjectIds: settings.authorizedProjectIds });
		return this.envelope(request, before, resolution, result, false);
	}

	async updateTask(request: BiosTaskUpdateRequest): Promise<BiosBusinessEnvelope<import("../../shared/types/biosBusiness").TaskWriteResult>> {
		const { settings, root, resolution, before } = this.open(request);
		const result = await this.writeGate.write(root, () => updateTask({ root, projectId: request.projectId, taskId: request.taskId, authorizedProjectIds: settings.authorizedProjectIds, expectedRevision: request.expectedRevision, changes: request.changes, now: this.now() }));
		return this.envelope(request, before, resolution, result, isCommittedWrite(result.status));
	}

	async changeTaskStatus(request: BiosTaskStatusRequest): Promise<BiosBusinessEnvelope<import("../../shared/types/biosBusiness").TaskStatusResult>> {
		const { settings, root, resolution, before } = this.open(request);
		const result = await this.writeGate.write(root, () => changeTaskStatus({ root, projectId: request.projectId, taskId: request.taskId, authorizedProjectIds: settings.authorizedProjectIds, expectedRevision: request.expectedRevision, to: request.to, reason: request.reason, now: this.now() }));
		return this.envelope(request, before, resolution, result, isCommittedWrite(result.status));
	}

	/* ------------------------------------------------------------ 客户需求 */

	/** 需求写入的显式授权：ID 在 `allowedFeatureIds` 内，或客户已确认且在 `approvedCustomers` 内。 */
	private requireFeatureWritable(settings: BiosHostSettings, featureId: string, customer: { readonly value: string | null; readonly status: string } | undefined): void {
		if (settings.allowedFeatureIds.includes(featureId)) return;
		const customerValue = customer?.status === "confirmed" ? customer.value : null;
		if (customerValue !== null && settings.approvedCustomers.includes(customerValue)) return;
		throw new Error("该需求的初次授权尚未办理：请先在设置里登记需求 ID（或确认客户并加入批准客户）后再写入");
	}

	async createFeature(request: BiosFeatureCreateRequest): Promise<BiosBusinessEnvelope<import("../../shared/types/biosBusiness").FeatureWriteResult>> {
		const { settings, root, resolution, before } = this.open(request);
		this.requireFeatureWritable(settings, request.feature.featureId, request.feature.customer);
		const result = await this.writeGate.write(root, () => createFeature({ root, feature: request.feature, now: this.now() }));
		return this.envelope(request, before, resolution, result, isCommittedWrite(result.status));
	}

	async updateFeature(request: BiosFeatureUpdateRequest): Promise<BiosBusinessEnvelope<import("../../shared/types/biosBusiness").FeatureWriteResult>> {
		const { settings, root, resolution, before } = this.open(request);
		// 更新：先读现状核对归属与授权（不采信请求里的客户/授权字段）。
		const current = await readFeatureDetail({ root, featureId: request.featureId, visibility: { allowedFeatureIds: settings.allowedFeatureIds, authorizedProjectIds: settings.authorizedProjectIds, approvedCustomers: settings.approvedCustomers } });
		if (current.status !== "ok" || current.feature === null) throw new Error(`需求不可读或未授权（${current.status}）：拒绝写入`);
		this.requireFeatureWritable(settings, request.featureId, current.feature.customer);
		if (request.changes.customer !== undefined) {
			const next = request.changes.customer;
			const nextCustomer = next?.status === "confirmed" ? next.value : null;
			if (!settings.allowedFeatureIds.includes(request.featureId) && (nextCustomer === null || !settings.approvedCustomers.includes(nextCustomer))) {
				throw new Error("改动后的客户范围不在批准集合内：拒绝写入（不接受请求里的授权字段）");
			}
		}
		const result = await this.writeGate.write(root, () => updateFeature({ root, featureId: request.featureId, expectedRevision: request.expectedRevision, changes: request.changes, now: this.now() }));
		return this.envelope(request, before, resolution, result, isCommittedWrite(result.status));
	}

	async readFeatureDetail(request: BiosFeatureDetailRequest): Promise<BiosBusinessEnvelope<import("../../shared/types/biosBusiness").FeatureDetailResult>> {
		const { settings, root, resolution, before } = this.open(request);
		const result = await readFeatureDetail({ root, featureId: request.featureId, visibility: { allowedFeatureIds: settings.allowedFeatureIds, authorizedProjectIds: settings.authorizedProjectIds, approvedCustomers: settings.approvedCustomers } });
		return this.envelope(request, before, resolution, result, false);
	}

	/* ------------------------------------------------------------ 经验 */

	async createExperienceDraft(request: BiosExperienceCreateRequest): Promise<BiosBusinessEnvelope<import("../../shared/types/biosBusiness").ExperienceWriteResult>> {
		const { settings, root, resolution, before } = this.open(request);
		if (!settings.authorizedProjectIds.includes(request.experience.sourceProjectId)) throw new Error("来源项目不在授权集合内：请先授权该来源项目再写经验");
		const result = await this.writeGate.write(root, () => createExperienceDraft({ root, authorizedProjectIds: settings.authorizedProjectIds, experience: request.experience, now: this.now() }));
		return this.envelope(request, before, resolution, result, isCommittedWrite(result.status));
	}

	async updateExperienceDraft(request: BiosExperienceUpdateRequest): Promise<BiosBusinessEnvelope<import("../../shared/types/biosBusiness").ExperienceWriteResult>> {
		const { settings, root, resolution, before } = this.open(request);
		const current = await readExperienceDetail({ root, experienceId: request.experienceId, authorizedProjectIds: settings.authorizedProjectIds });
		if (current.status !== "ok" || current.card === null) throw new Error(`经验不可读或未授权（${current.status}）：拒绝写入`);
		const result = await this.writeGate.write(root, () => updateExperienceDraft({ root, authorizedProjectIds: settings.authorizedProjectIds, experienceId: request.experienceId, expectedRevision: request.expectedRevision, changes: request.changes, now: this.now() }));
		return this.envelope(request, before, resolution, result, isCommittedWrite(result.status));
	}

	async readExperienceDetail(request: BiosExperienceDetailRequest): Promise<BiosBusinessEnvelope<import("../../shared/types/biosBusiness").ExperienceDetailResult>> {
		const { settings, root, resolution, before } = this.open(request);
		const result = await readExperienceDetail({ root, experienceId: request.experienceId, authorizedProjectIds: settings.authorizedProjectIds });
		return this.envelope(request, before, resolution, result, false);
	}

	async reviewExperience(request: BiosExperienceReviewRequest): Promise<BiosBusinessEnvelope<import("../../shared/types/biosBusiness").ExperienceReviewResult>> {
		const { settings, root, resolution, before } = this.open(request);
		if (settings.authorizedProjectIds.length === 0) throw new Error("审核需要至少一个已授权来源项目（经验卡的归属依据）");
		const result = await this.writeGate.write(root, () =>
			reviewExperience({ root, experienceId: request.experienceId, expectedRevision: request.expectedRevision, action: request.action, operatorLabel: request.operatorLabel ?? "manual-ui", reason: request.reason, authorizedProjectIds: settings.authorizedProjectIds, now: this.now() }),
		);
		return this.envelope(request, before, resolution, result, isCommittedWrite(result.status));
	}

	/* ------------------------------------------------------------ 检索 / 参考 */

	async search(request: BiosSearchRequest): Promise<BiosBusinessEnvelope<import("../../shared/types/biosBusiness").SearchResult>> {
		const { settings, root, resolution, before } = this.open(request);
		const result = await searchKnowledge({
			useIndex: true,
			root,
			query: request.query,
			visibility: { authorizedProjectIds: settings.authorizedProjectIds, allowedFeatureIds: settings.allowedFeatureIds, approvedCustomers: settings.approvedCustomers },
			target: {
				projectId: request.projectId ?? null,
				...(request.workspaceId === undefined ? {} : { workspaceId: request.workspaceId }),
				customerId: request.customerId ?? null,
				...(request.boardName === undefined ? {} : { boardName: request.boardName }),
				...(request.boardRevision === undefined ? {} : { boardRevision: request.boardRevision }),
				...(request.buildTarget === undefined ? {} : { buildTarget: request.buildTarget }),
				...(request.commit === undefined ? {} : { commit: request.commit }),
			},
			authorization: { endpointAllowed: settings.endpoint === "allowed" ? true : settings.endpoint === "denied" ? false : null, allowInternalGeneral: false, customers: settings.approvedCustomers, authorizedProjectIds: settings.authorizedProjectIds },
			...(request.intent === undefined ? {} : { intent: request.intent }),
			...(request.recordFamilies === undefined && request.statuses === undefined ? {} : { filters: { ...(request.recordFamilies === undefined ? {} : { recordFamilies: request.recordFamilies }), ...(request.statuses === undefined ? {} : { statuses: request.statuses }) } }),
			now: this.now(),
		});
		return this.envelope(request, before, resolution, result, false);
	}

	async readReference(request: BiosReferenceRequest): Promise<BiosBusinessEnvelope<import("../../shared/types/biosBusiness").ReferenceView>> {
		const { settings, root, resolution, before } = this.open(request);
		const result = await readExperienceReference({
			root,
			experienceId: request.experienceId,
			targetProjectId: request.targetProjectId ?? null,
			...(request.targetCustomerId === undefined ? {} : { targetCustomerId: request.targetCustomerId }),
			authorization: { endpointAllowed: settings.endpoint === "allowed" ? true : settings.endpoint === "denied" ? false : null, allowInternalGeneral: false, customers: settings.approvedCustomers, authorizedProjectIds: settings.authorizedProjectIds },
			allowedFeatureIds: settings.allowedFeatureIds,
			now: this.now(),
		});
		return this.envelope(request, before, resolution, result, false);
	}

	/* ------------------------------------------------------------ 任务沉淀草稿 */

	async prepareDraft(request: BiosDraftPrefillRequest): Promise<BiosBusinessEnvelope<import("../../shared/types/biosBusiness").TaskExperiencePrefillResult>> {
		const { settings, root, resolution, before } = this.open(request);
		const result = await prepareExperienceDraftFromTask({ root, projectId: request.projectId, taskId: request.taskId, cwd: resolution.cwd, authorizedRoots: settings.authorizedRoots, authorizedProjectIds: settings.authorizedProjectIds });
		return this.envelope(request, before, resolution, result, false);
	}

	async saveDraft(request: BiosDraftSaveRequest): Promise<BiosBusinessEnvelope<import("../../shared/types/biosBusiness").TaskDraftSaveResult>> {
		const { settings, root, resolution, before } = this.open(request);
		if (!settings.authorizedProjectIds.includes(request.projectId)) throw new Error("项目不在授权集合内：请先授权该项目");
		const sourceProjectId = request.experience.sourceProjectId ?? request.projectId;
		if (!settings.authorizedProjectIds.includes(sourceProjectId)) throw new Error("来源项目不在授权集合内：拒绝写入经验草稿");
		const result = await this.writeGate.write(root, () =>
			saveExperienceDraftFromTask({
				root,
				projectId: request.projectId,
				taskId: request.taskId,
				experience: { ...request.experience, sourceProjectId },
				...(request.expectedTaskRevision === undefined ? {} : { expectedTaskRevision: request.expectedTaskRevision }),
				authorizedProjectIds: settings.authorizedProjectIds,
				now: this.now(),
			}),
		);
		return this.envelope(request, before, resolution, result, isCommittedWrite(result.status));
	}

	/* ------------------------------------------------------------ 离线备份 / 恢复（B-07） */

	/**
	 * 把"父目录 + 单段名字"拼成目标路径。
	 *
	 * 只做两件本层能确定的事：父目录必须是完全限定路径、名字必须是**单段安全名字**。
	 * 而"目标是否已存在 / 是否与源重叠 / 父链有没有链接 / 清单是否合法"一律交给 core——
	 * 那些判据（canonical 路径按段比较、排他创建、父链链接拒绝）重复实现必然漂移。
	 */
	private resolveBackupTarget(parentDir: string, name: string): string {
		if (!isFullyQualifiedPath(parentDir)) throw new Error("备份目录必须是完全限定路径：请用选择器选择目录");
		const segment = name.trim();
		if (segment === "" || segment === "." || segment === "..") throw new Error("备份目录名不能为空或 . / ..");
		if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(segment)) throw new Error("备份目录名只能是字母/数字/._- 且以字母或数字开头（不含分隔符）");
		if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(segment)) throw new Error("备份目录名不能是 Windows 保留设备名");
		return join(parentDir, segment);
	}

	/**
	 * 离线导出（BM-02D2）：**薄入口**，不新增格式、不做热一致快照。
	 *
	 * 顺序上本层只补两件 core 无法知道的事：
	 * 1. 源知识库当前必须是 `ready`（未配置/未初始化/损坏/未来版本都拒绝，且拒绝发生在建任何目录之前）；
	 * 2. `offlineConfirmed` 必须是**操作者在界面上显式勾选**的结果——本应用不代填、不推荐、
	 *    不用它冒充"已证明一致"。core 的清单契约本身就把 `offline-copy` 写成声明而不是证明。
	 */
	async exportBackup(request: BiosExportBackupRequest): Promise<BiosBusinessEnvelope<import("../../shared/types/biosBusiness").ExportKnowledgeBackupResult>> {
		const { settings, root, resolution, before } = this.open(request);
		if (request.offlineConfirmed !== true) {
			throw new Error("必须由操作者确认「本应用写入口已停止、外部 CLI/其它进程写入者已关闭」后才能导出：本应用不会替你确认，也不提供热一致快照");
		}
		return this.writeGate.export(root, async () => {
			const status = await readBiosStoreStatus(root);
			if (status.kind !== "ready") throw new Error(`知识库当前不是可导出的状态（${status.kind}）：请先修复或初始化后再备份`);
			const backupRoot = this.resolveBackupTarget(request.parentDir, request.name);
			const result = await exportKnowledgeBackup({ root, backupRoot, offlineConfirmed: true, now: this.now() });
			void settings;
			return this.envelope(request, before, resolution, result, result.published);
		});
	}

	/**
	 * 离线恢复（BM-02D3）：只恢复到**尚不存在的新目录**。
	 *
	 * 恢复完成**不**切知识根、不改授权：本方法不调用任何配置写入入口。
	 * 用户检查恢复结果后，必须在设置里手动选择新根（那条路径会触发 B-01 的旧运行时失效）。
	 */
	async restoreBackup(request: BiosRestoreBackupRequest): Promise<BiosBusinessEnvelope<import("../../shared/types/biosBusiness").RestoreKnowledgeBackupResult>> {
		const { resolution, before } = this.open(request);
		if (request.offlineConfirmed !== true) {
			throw new Error("必须由操作者确认「备份容器不再被修改、目标目录无人使用」后才能恢复：本应用不会替你确认");
		}
		if (!isFullyQualifiedPath(request.backupRoot)) throw new Error("备份容器必须是完全限定路径：请用选择器选择目录");
		const root = this.resolveBackupTarget(request.parentDir, request.name);
		const result = await restoreKnowledgeBackup({ backupRoot: request.backupRoot, root, offlineConfirmed: true });
		return this.envelope(request, before, resolution, result, result.published);
	}

	/* ------------------------------------------------------------ 上下文清单（B-06） */

	/** 端点外发策略：与搜索/预览同源（unknown ⇒ 不允许商业正文外发）。 */
	private endpointPolicy(settings: BiosHostSettings): { endpointAllowed: boolean | null; allowInternalGeneral: boolean; customers: readonly string[] } {
		return { endpointAllowed: settings.endpoint === "allowed" ? true : settings.endpoint === "denied" ? false : null, allowInternalGeneral: false, customers: settings.approvedCustomers };
	}

	/**
	 * 保存上下文清单（B-06）：**独立显式动作**，带 CAS。
	 *
	 * 关键：renderer 提交的 `sources`/`budget`/`profileRevision` 只作为"待核对声明"——
	 * core 会重新读取目标档案、任务身份/工作区与每个来源的族/ID/授权/revision，
	 * 不一致就拒绝（`invalid-sources`），不会把请求里的内容当成事实落盘。
	 */
	async saveManifest(request: BiosManifestSaveRequest): Promise<BiosBusinessEnvelope<import("../../shared/types/biosBusiness").SaveManifestResult>> {
		const { settings, root, resolution, before } = this.open(request);
		const result = await this.writeGate.write(root, () =>
			saveContextManifest({
				root,
				manifestId: request.manifestId,
				targetProjectId: request.targetProjectId,
				...(request.taskId === undefined ? {} : { taskId: request.taskId }),
				...(request.workspaceId === undefined ? {} : { workspaceId: request.workspaceId }),
				cwd: resolution.cwd,
				authorizedRoots: settings.authorizedRoots,
				profileRevision: request.profileRevision,
				sources: request.sources,
				...(request.expiredSources === undefined ? {} : { expiredSources: request.expiredSources }),
				budget: request.budget,
				generatedAt: request.generatedAt,
				authorizedProjectIds: settings.authorizedProjectIds,
				expectedRevision: request.expectedRevision ?? null,
				allowedFeatureIds: settings.allowedFeatureIds,
				endpoint: this.endpointPolicy(settings),
				now: this.now(),
			}),
		);
		return this.envelope(request, before, resolution, result, result.status === "saved" || result.status === "replaced");
	}

	/**
	 * 重验已有上下文清单（B-06）：按**当前**磁盘事实逐来源判定。
	 *
	 * 历史清单不是"已注入"的证明：`stale`/`incomplete` 必须原样呈现（含每个来源的状态与原因）。
	 */
	async verifyManifest(request: BiosManifestVerifyRequest): Promise<BiosBusinessEnvelope<import("../../shared/types/biosBusiness").VerifyManifestResult>> {
		const { settings, root, resolution, before } = this.open(request);
		const result = await verifyContextManifest({
			root,
			manifestId: request.manifestId,
			projectId: request.projectId,
			authorizedProjectIds: settings.authorizedProjectIds,
			endpoint: this.endpointPolicy(settings),
			cwd: resolution.cwd,
			authorizedRoots: settings.authorizedRoots,
			allowedFeatureIds: settings.allowedFeatureIds,
		});
		return this.envelope(request, before, resolution, result, false);
	}

	/* ------------------------------------------------------------ 管理入口（无会话） */

	/** 知识库状态（只读）：未配置/目录不在/未初始化/就绪/未来版本/损坏/不可达。 */
	async storeStatus(): Promise<BiosStoreStatus> {
		return readBiosStoreStatus(this.settings().knowledgeRoot);
	}

	/**
	 * 显式初始化知识库：只在**已配置的知识根**上初始化。
	 *
	 * 先做只读状态核对，把三类"不该动"的情形挡在写之前：损坏库、未来版本、不可达。
	 * 不写授权、不覆盖无效库、不自动迁移；已就绪的库返回 `existing`（幂等）。
	 */
	async initialize(request: BiosInitializeRequest): Promise<BiosBusinessEnvelope<import("../../shared/types/biosBusiness").InitializeKnowledgeStoreResult>> {
		const settings = this.settings();
		const before = this.configurationKey(settings);
		const root = this.requireRoot(settings);
		if (request.knowledgeRoot !== root) throw new Error("只能初始化本机设置里已配置的知识根：请先在设置里保存该目录");
		const status = await readBiosStoreStatus(root);
		if (status.kind === "corrupt") throw new Error(`该目录已有损坏的知识库（${status.detail}）：不覆盖、不自动迁移；请换目录或人工核对后重试`);
		if (status.kind === "future-version") throw new Error(`该目录的知识库版本本机不支持（${status.detail}）：不覆盖、不自动迁移；请换目录或用匹配版本的知识库工具核对`);
		if (status.kind === "unreachable") throw new Error(`知识根不可用（${status.detail}）：请检查权限/目录形态后重试`);
		const result = await this.writeGate.write(root, () => initializeKnowledgeStore({ root, now: this.now() }));
		return this.manageGuard(before, result, result.status === "created");
	}

	private desktopPath(desktopProjectId: string): string {
		if (desktopProjectId === "builtin-chat") throw new Error("普通聊天不能接入 BIOS 工程");
		const resolved = this.options.resolveDesktopProjectPath?.(desktopProjectId) ?? null;
		if (resolved === null || resolved.trim() === "") throw new Error("找不到对应的桌面项目路径：请从当前项目工作区发起该操作");
		return resolved;
	}

	/** 绑定/连接项目工作区；`biosProjectId` 必须已在可信配置内授权。 */
	async bindProject(request: BiosBindRequest): Promise<BiosBusinessEnvelope<import("../../shared/types/biosBusiness").BindProjectResult>> {
		const settings = this.settings();
		const before = this.configurationKey(settings);
		const root = this.requireRoot(settings);
		if (!settings.authorizedProjectIds.includes(request.biosProjectId)) {
			throw new Error("该 BIOS 项目的初次授权尚未办理：请先在设置里登记项目 ID 并明确授权，再回来绑定（不会因点新建自动放行）");
		}
		const workspacePath = this.desktopPath(request.desktopProjectId);
		const result = await this.writeGate.write(root, () =>
			bindProjectWorkspace({
				root,
				cwd: workspacePath,
				authorizedRoots: settings.authorizedRoots,
				workspacePath,
				biosProjectId: request.biosProjectId,
				desktopProjectId: request.desktopProjectId,
				...(request.displayName === undefined ? {} : { displayName: request.displayName }),
				...(request.workspaceId === undefined ? {} : { workspaceId: request.workspaceId }),
				now: this.now(),
			}),
		);
		return this.manageGuard(before, result, isCommittedWrite(result.status));
	}

	/** 候选检测（只读）：不自动写档案；工作区未绑定时先绑定。 */
	async detectCandidates(request: BiosDetectRequest): Promise<BiosBusinessEnvelope<import("../../shared/types/biosBusiness").DetectProjectResult>> {
		const settings = this.settings();
		const before = this.configurationKey(settings);
		const root = this.requireRoot(settings);
		if (!settings.authorizedProjectIds.includes(request.biosProjectId)) throw new Error("项目不在授权集合内：请先授权该项目");
		const workspacePath = this.desktopPath(request.desktopProjectId);
		const opened = await openProjectProfile({ root, cwd: workspacePath, workspacePath, authorizedRoots: settings.authorizedRoots, biosProjectId: request.biosProjectId });
		if (!opened.usable || opened.workspaceId === null || (request.workspaceId !== undefined && request.workspaceId !== opened.workspaceId)) throw new Error("该桌面目录与项目工作区绑定不一致：请先绑定正确工作区后再检测");
		const workspaceId = opened.workspaceId;
		const result = await detectProjectCandidates({ workspacePath, workspaceId, cwd: workspacePath, authorizedRoots: settings.authorizedRoots, now: this.now() });
		return this.manageGuard(before, result, false);
	}

	/** 人工确认已有 schema 支持的字段（带 expectedRevision；只改点名字段）。 */
	async confirmProfile(request: BiosConfirmRequest): Promise<BiosBusinessEnvelope<import("../../shared/types/biosBusiness").ConfirmProfileResult>> {
		const settings = this.settings();
		const before = this.configurationKey(settings);
		const root = this.requireRoot(settings);
		if (!settings.authorizedProjectIds.includes(request.biosProjectId)) throw new Error("项目不在授权集合内：请先授权该项目");
		const result = await this.writeGate.write(root, () =>
			confirmProfileFields({
				root,
				projectId: request.biosProjectId,
				...(request.workspaceId === undefined ? {} : { workspaceId: request.workspaceId }),
				expectedProfileRevision: request.expectedProfileRevision,
				values: request.values,
				...(request.operatorLabel === undefined ? {} : { operatorLabel: request.operatorLabel }),
				now: this.now(),
			}),
		);
		return this.manageGuard(before, result, isCommittedWrite(result.status));
	}

	/** 项目视图 + 证据复验（只读）：不自动写档案。 */
	async readProjectView(request: BiosProjectViewRequest): Promise<BiosBusinessEnvelope<import("../../shared/types/biosBusiness").ProjectDecisionView>> {
		const settings = this.settings();
		const before = this.configurationKey(settings);
		const root = this.requireRoot(settings);
		if (!settings.authorizedProjectIds.includes(request.biosProjectId)) throw new Error("项目不在授权集合内：请先授权该项目");
		// cwd 只用于授权判定：优先用桌面项目真实路径，否则回落到第一个授权目录根。
		const cwd = request.desktopProjectId === undefined ? (settings.authorizedRoots[0] ?? root) : this.desktopPath(request.desktopProjectId);
		const result = await readProjectView({ root, cwd, authorizedRoots: settings.authorizedRoots, biosProjectId: request.biosProjectId, verifyEvidence: true, probeVcs: true, now: this.now() });
		return this.manageGuard(before, result, false);
	}
}

export function createBiosBusinessService(options: BiosBusinessServiceOptions): BiosBusinessService {
	return new BiosBusinessService(options);
}
