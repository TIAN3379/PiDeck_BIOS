/**
 * BM-07B B-02：**人工业务读写的桌面共享契约**（main / preload / renderer 共用）。
 *
 * 边界（`bm07b_batch_development_plan.md` §2、core/contracts/common.ts 顶部说明）：
 * - core 是类型**唯一来源**（schema 推导 → `Static<>`），这里只做 **type-only 重导出** +
 *   桌面侧请求/结果包装，**禁止复制第二套同名结构**；
 * - renderer 只能提交业务 ID / 正文 / `expectedRevision` / 人工标签；**不能**提交
 *   `root`、`cwd`、授权集合、workspace 路径——那些由主进程从可信配置与真实项目表解析；
 * - 结果必须保留 core 的判别式（`status` / `revision` / `actualRevision` / 分步结果 /
 *   `warnings` / `needsReview` / `problems`），**不允许**用一个 `ok: boolean` 吞掉部分完成状态。
 */
import type { AuditAction } from "../../../packages/bios-agent/core/contracts/audit.ts";
import type { ExperienceStatus, EvidenceRef, ProjectField, ReuseScope, TaskStatus, ValidationKind, ValidationResult } from "../../../packages/bios-agent/core/contracts/common.ts";
import type { EvidenceSourceType } from "../../../packages/bios-agent/core/contracts/common.ts";
import type { ExperienceCard, FeatureRecord, ProjectProfile, TaskRecord, TaskWorkspace, WorkspaceBinding } from "../../../packages/bios-agent/core/contracts/records.ts";
import type { TaskDraftSaveResult, TaskDraftStep, TaskExperiencePrefill, TaskExperiencePrefillResult } from "../../../packages/bios-agent/core/tasks/drafts.ts";
import type { TaskChanges, TaskDetailResult, TaskEvidenceInput, TaskExperienceRef, TaskStatusResult, TaskValidationInput, TaskWriteResult } from "../../../packages/bios-agent/core/tasks/tasks.ts";
import type { FeatureDetailResult, FeatureDraft, FeatureFieldInput, FeatureLinkResult, FeatureWriteResult } from "../../../packages/bios-agent/core/knowledge/features.ts";
import type { ExperienceDraft, ExperienceEvidenceInput, ExperienceReviewResult, ExperienceValidationInput, ExperienceWriteResult } from "../../../packages/bios-agent/core/knowledge/experiences.ts";
import type { ReferenceView, SearchHit, SearchResult } from "../../../packages/bios-agent/core/knowledge/search.ts";
import type { MemoryDecisionClass } from "../../../packages/bios-agent/core/memory/contract.ts";
import type { BindProjectResult, OpenProjectResult, ProjectOpenProblem, ProjectWriteStep } from "../../../packages/bios-agent/core/projects/binding.ts";
import type { ConfirmFieldInput, ConfirmProfileResult } from "../../../packages/bios-agent/core/projects/confirm.ts";
import type { DetectProjectResult, DetectionCandidate, DetectionGap } from "../../../packages/bios-agent/core/projects/detection.ts";
import type { ProjectDecisionView } from "../../../packages/bios-agent/core/projects/view.ts";
import type { EvidenceCheck } from "../../../packages/bios-agent/core/projects/workspace.ts";
import type { InitializeKnowledgeStoreResult } from "../../../packages/bios-agent/core/storage/registry.ts";
import type { BiosSessionRef } from "./bios";

/* ------------------------------------------------------------ core 类型重导出 */

export type {
	AuditAction,
	BindProjectResult,
	ConfirmFieldInput,
	ConfirmProfileResult,
	DetectProjectResult,
	DetectionCandidate,
	DetectionGap,
	EvidenceCheck,
	EvidenceRef,
	EvidenceSourceType,
	ExperienceCard,
	ExperienceDraft,
	ExperienceEvidenceInput,
	ExperienceReviewResult,
	ExperienceStatus,
	ExperienceValidationInput,
	ExperienceWriteResult,
	FeatureDetailResult,
	FeatureDraft,
	FeatureFieldInput,
	FeatureLinkResult,
	FeatureRecord,
	FeatureWriteResult,
	InitializeKnowledgeStoreResult,
	MemoryDecisionClass,
	OpenProjectResult,
	ProjectDecisionView,
	ProjectField,
	ProjectOpenProblem,
	ProjectProfile,
	ProjectWriteStep,
	ReferenceView,
	ReuseScope,
	SearchHit,
	SearchResult,
	TaskChanges,
	TaskDetailResult,
	TaskDraftSaveResult,
	TaskDraftStep,
	TaskEvidenceInput,
	TaskExperiencePrefill,
	TaskExperiencePrefillResult,
	TaskExperienceRef,
	TaskRecord,
	TaskStatus,
	TaskStatusResult,
	TaskValidationInput,
	TaskWorkspace,
	TaskWriteResult,
	ValidationKind,
	ValidationResult,
	WorkspaceBinding,
};

/**
 * 经验详情结果。
 *
 * core 的 `readExperienceDetail` 返回**内联**结构（未导出命名类型），这里按逐字对齐重建；
 * 若将来 core 导出该类型，应改为 type-only 重导出，不再复制。
 */
export type ExperienceDetailResult = {
	readonly status: "ok" | "not-found" | "not-authorized";
	readonly experienceId: string;
	readonly revision: number | null;
	readonly card: ExperienceCard | null;
	readonly problems: readonly string[];
};

/* ------------------------------------------------------------ 结果包装 */

/**
 * 可信配置/身份守卫（B-02）：读取或写入**期间**配置、授权、知识根、会话代次或选择发生变化时，
 * `stable=false` 且正文不得作为当前依据（服务会丢弃正文或标记 stale）。
 */
export type BiosBusinessGuard = {
	/** 动作发生时的可信配置版本（界面据此判断是否需要刷新）。 */
	readonly configurationVersion: number;
	readonly stable: boolean;
	/** `stable=false` 时的受控原因（不含商业正文）。 */
	readonly staleReason: string | null;
};

/**
 * 统一的业务结果信封。
 *
 * - `result`：core 的原始判别式结果（**不裁剪**状态与分步事实）；
 * - `committed`：本次动作是否已经产生落盘提交。部分完成 / 审计待核对 / 日志待核对
 *   都属于"已经提交"——UI 不得据此假称回滚；
 * - `guard`：见上。
 */
export type BiosBusinessEnvelope<T> = {
	readonly result: T;
	readonly committed: boolean;
	readonly guard: BiosBusinessGuard;
};

/** 人工声明标签：**只是标签**，不代表企业账户认证；本批不新增权限角色系统。 */
export type BiosOperatorMeta = {
	readonly operatorLabel?: string;
};

/** 会话绑定动作的公共部分（与既有 BIOS 会话命令同构：sessionRef + runtimeGeneration）。 */
export type BiosBusinessRequestBase = {
	readonly sessionRef: BiosSessionRef;
	readonly runtimeGeneration: number;
};

/* ------------------------------------------------------------ 任务 */

export type BiosTaskListRequest = BiosBusinessRequestBase & {
	readonly projectId: string;
};

export type BiosTaskDetailRequest = BiosBusinessRequestBase & {
	readonly projectId: string;
	readonly taskId: string;
};

export type BiosTaskCreateRequest = BiosBusinessRequestBase &
	BiosOperatorMeta & {
		readonly projectId: string;
		readonly taskId: string;
		readonly workspaceId: string;
		readonly requirement: string;
		readonly branch?: string;
		readonly baseCommit?: string;
		readonly decisions?: readonly string[];
		readonly todos?: readonly string[];
		readonly blockers?: readonly string[];
		readonly relatedFiles?: readonly string[];
		readonly sourceExperienceIds?: readonly string[];
		readonly validations?: readonly TaskValidationInput[];
	};

export type BiosTaskUpdateRequest = BiosBusinessRequestBase &
	BiosOperatorMeta & {
		readonly projectId: string;
		readonly taskId: string;
		readonly expectedRevision: number;
		readonly changes: TaskChanges;
	};

export type BiosTaskStatusRequest = BiosBusinessRequestBase &
	BiosOperatorMeta & {
		readonly projectId: string;
		readonly taskId: string;
		readonly expectedRevision: number;
		readonly to: TaskStatus;
		/** 状态变更的**理由**（重开必须显式给出理由，不能清空验证后假装新任务）。 */
		readonly reason: string;
	};

/* ------------------------------------------------------------ 客户需求 */

export type BiosFeatureCreateRequest = BiosBusinessRequestBase &
	BiosOperatorMeta & {
		readonly feature: FeatureDraft;
	};

export type BiosFeatureUpdateRequest = BiosBusinessRequestBase &
	BiosOperatorMeta & {
		readonly featureId: string;
		readonly expectedRevision: number;
		readonly changes: Partial<Omit<FeatureDraft, "featureId">>;
	};

export type BiosFeatureDetailRequest = BiosBusinessRequestBase & {
	readonly featureId: string;
};

/* ------------------------------------------------------------ 经验 */

export type BiosExperienceCreateRequest = BiosBusinessRequestBase &
	BiosOperatorMeta & {
		readonly experience: ExperienceDraft;
	};

export type BiosExperienceUpdateRequest = BiosBusinessRequestBase &
	BiosOperatorMeta & {
		readonly experienceId: string;
		readonly expectedRevision: number;
		readonly changes: Partial<Omit<ExperienceDraft, "experienceId" | "sourceProjectId">>;
	};

export type BiosExperienceDetailRequest = BiosBusinessRequestBase & {
	readonly experienceId: string;
};

export type BiosExperienceReviewRequest = BiosBusinessRequestBase &
	BiosOperatorMeta & {
		readonly experienceId: string;
		readonly expectedRevision: number;
		/** 只允许 `reviewExperience` 支持的合法动作（submit-review/request-changes/approve/deprecate/restore）。 */
		readonly action: AuditAction;
		readonly reason: string;
	};

/* ------------------------------------------------------------ 检索 / 跨项目参考 */

export type BiosSearchRequest = BiosBusinessRequestBase & {
	readonly query: string;
	/** 当前任务所属项目（决定 M1 的 `current` 判定）；缺省表示没有当前项目上下文。 */
	readonly projectId?: string;
	readonly workspaceId?: string;
	readonly customerId?: string | null;
	readonly boardName?: string;
	readonly boardRevision?: string;
	readonly buildTarget?: string;
	readonly commit?: string;
	readonly intent?: "current" | "history";
	readonly recordFamilies?: readonly ("experience-card" | "feature-record")[];
	readonly statuses?: readonly ExperienceStatus[];
};

export type BiosReferenceRequest = BiosBusinessRequestBase & {
	readonly experienceId: string;
	/** 目标项目（通常是当前项目）；缺省表示没有目标项目上下文。 */
	readonly targetProjectId?: string;
	readonly targetCustomerId?: string | null;
};

/* ------------------------------------------------------------ 任务沉淀经验草稿 */

export type BiosDraftPrefillRequest = BiosBusinessRequestBase & {
	readonly projectId: string;
	readonly taskId: string;
};

export type BiosDraftSaveRequest = BiosBusinessRequestBase &
	BiosOperatorMeta & {
		readonly projectId: string;
		readonly taskId: string;
		/** 回链任务时使用的 CAS 版本（缺省表示不校验任务版本）。 */
		readonly expectedTaskRevision?: number;
		readonly experience: Omit<ExperienceDraft, "sourceProjectId"> & { readonly sourceProjectId?: string };
	};

/* ------------------------------------------------------------ 上下文 Manifest */

export type BiosManifestSaveRequest = BiosBusinessRequestBase &
	BiosOperatorMeta & {
		readonly manifestId: string;
		readonly targetProjectId: string;
		readonly taskId?: string;
		readonly workspaceId?: string;
		readonly profileRevision: number;
		readonly sources: readonly { readonly recordKind: string; readonly recordId: string; readonly revision: number; readonly reason: string }[];
		readonly expiredSources?: readonly string[];
		readonly budget: { readonly maxChars: number; readonly maxBytes: number; readonly usedChars: number; readonly truncated: boolean };
		readonly generatedAt: number;
		readonly expectedRevision?: number | null;
	};

export type BiosManifestVerifyRequest = BiosBusinessRequestBase & {
	readonly manifestId: string;
	readonly projectId: string;
};

/* ------------------------------------------------------------ 显式管理入口（无会话） */

/**
 * 初始化知识库（显式管理动作）。
 *
 * `knowledgeRoot` 必须**已经**是本机设置里的知识根：本动作不会替用户写授权、不会自动追加
 * 全局许可，也不会覆盖已有无效库或自动迁移。
 */
export type BiosInitializeRequest = {
	readonly knowledgeRoot: string;
};

/**
 * 绑定/连接项目工作区（显式管理动作）。
 *
 * 路径由主进程按 `desktopProjectId` 从**真实桌面项目表**解析；`biosProjectId` 必须已在
 * 可信配置的授权集合内——初次授权要经 BIOS 设置显式办理，不能因点"新建"自动放行。
 */
export type BiosBindRequest = BiosOperatorMeta & {
	readonly desktopProjectId: string;
	readonly biosProjectId: string;
	readonly workspaceId?: string;
	readonly displayName?: string;
};

export type BiosDetectRequest = {
	readonly desktopProjectId: string;
	readonly biosProjectId: string;
	readonly workspaceId?: string;
};

export type BiosConfirmRequest = BiosOperatorMeta & {
	readonly biosProjectId: string;
	readonly workspaceId?: string;
	readonly expectedProfileRevision: number;
	readonly values: readonly ConfirmFieldInput[];
};

export type BiosProjectViewRequest = {
	readonly biosProjectId: string;
	/** 用于授权判定的桌面项目路径；缺省时回落到第一个授权目录根。 */
	readonly desktopProjectId?: string;
};

/* ------------------------------------------------------------ 离线备份 / 恢复（B-07） */

/**
 * 备份/恢复结果的 type-only 重导出。
 *
 * B-07 只做**薄入口**：清单结构、受控落点、限额、准入与失败映射全部由 core 决定，
 * 这里不复制第二套形状，也不新增格式。
 */
export type { BackupIssue, BackupLimits, BackupManifest, BackupManifestFile, ExportKnowledgeBackupResult, RestoreKnowledgeBackupResult, RestoreReviewReason } from "../../../packages/bios-agent/core/storage/backup/index.ts";

/**
 * 离线备份/恢复请求的公共部分。
 *
 * `parentDir` 来自系统选择器（**父目录**），`name` 是单段名字：最终目标是
 * `parentDir/name`，由主进程拼接并校验。刻意不让 renderer 直接提交整条目标路径——
 * 那样"逃出所选父目录"就只能靠事后比对，而 `..` / 绝对路径 / 保留设备名都可以靠
 * 单段校验在拼接前挡住。
 *
 * `offlineConfirmed` 必须由操作者在界面上显式勾选：主进程**不会**代填 `true`，
 * 没有它就是拒绝（`offline-copy` 是声明，不是本应用能证明的结论）。
 */
export type BiosBackupTargetRequest = BiosBusinessRequestBase &
	BiosOperatorMeta & {
		readonly parentDir: string;
		readonly name: string;
		readonly offlineConfirmed: boolean;
	};

/** 显式导出当前知识库到**尚不存在的**新目录。 */
export type BiosExportBackupRequest = BiosBackupTargetRequest;

/** 显式把一份**已完成的**备份容器恢复到**尚不存在的**新知识根。 */
export type BiosRestoreBackupRequest = BiosBusinessRequestBase &
	BiosOperatorMeta & {
		/** 已完成的备份容器目录（`manifest.json` + `data/`），由选择器给出。 */
		readonly backupRoot: string;
		readonly parentDir: string;
		readonly name: string;
		readonly offlineConfirmed: boolean;
	};

/** 目录选择器的用途：决定对话框标题与可选项，避免"拿选知识根的框去选备份目录"。 */
export type BiosBackupPickPurpose = "export-parent" | "restore-source" | "restore-target-parent";

/** 目录选择结果：只回路径字符串（renderer 拿不到任何读写能力）。 */
export type BiosBackupPickResult = { readonly canceled: boolean; readonly path: string | null };

/* ------------------------------------------------------------ 上下文清单（B-06） */

/**
 * 上下文清单保存/重验结果（core 的判别式，type-only 重导出）。
 *
 * 这两件事是**独立显式动作**：保存带 CAS（`expectedRevision`），重验按当前磁盘事实逐来源判定
 * （`current`/`changed`/`missing`/`deprecated`/`unauthorized`/`unproven`/`unreviewed`/`identity`）。
 * 历史清单**不是**"已经注入"的证明，因此界面必须展示逐来源状态而不是一个总勾。
 */
export type { ContextSourceInput, ManifestSourceState, SaveManifestResult, VerifyManifestResult } from "../../../packages/bios-agent/core/context/index.ts";

/* ------------------------------------------------------------ 结果别名（供 preload / renderer 使用） */

export type BiosWriteEnvelope<T> = BiosBusinessEnvelope<T>;
