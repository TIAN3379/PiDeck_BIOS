/**
 * 五类知识记录的 schema 与由 schema 推导的类型（mvp_development_plan.md §6）。
 *
 * 只做**结构**定义与类型推导；写入规则（revision 冲突、锁、原子替换）属于
 * BM-02 的 storage 层，不在契约里假装实现。
 *
 * R4 调整（round1_acceptance.md）：项目身份与**工作区快照**分开——
 * 一个项目可以有多个 worktree，每个工作区各自记录路径、branch、HEAD 与采集时间；
 * 只用一份 branch/HEAD 会让"HEAD 属于哪个检出"无法回答，证据过期检查随之失真。
 */
import { type Static, Type } from "typebox";
import { EvidenceRefSchema, ExperienceStatusSchema, FieldGapSchema, ProjectFieldSchema, RecordBaseSchema, ReuseScopeSchema, TaskStatusSchema, ValidationRecordSchema } from "./common.ts";
import { BiosProjectIdSchema, KnowledgeIdSchema, UuidSchema } from "./ids.ts";

/** ProjectProfile：项目身份 + 各工作区快照 + 资料缺口。 */
export const WorkspaceAvailabilitySchema = Type.Union([Type.Literal("reachable"), Type.Literal("missing"), Type.Literal("permission-denied"), Type.Literal("unknown")]);
export type WorkspaceAvailability = Static<typeof WorkspaceAvailabilitySchema>;

/**
 * 工作区的 VCS 快照。
 * 无 Git 的目录**省略** `vcs`：此时分支与提交来源显示为不可用，证据只能靠内容 hash 锚定；
 * 不要为了"字段好看"写一个空字符串分支名。
 */
export const WorkspaceVcsSchema = Type.Object({
	kind: Type.Literal("git"),
	branch: Type.Union([Type.String(), Type.Null()]),
	head: Type.Union([Type.String(), Type.Null()]),
	/** 远端 URL。相同远端**不**自动合并项目，合并只能由用户显式绑定。 */
	remoteUrl: Type.Union([Type.String(), Type.Null()]),
});
export type WorkspaceVcs = Static<typeof WorkspaceVcsSchema>;

/**
 * 每个工作区一条独立绑定。
 * 目录移动 = 更新 `path`（保持 `workspaceId`），不重建工作区身份；
 * 目录暂时不可达 = 改 `availability`，**不删除**绑定。
 */
export const WorkspaceBindingSchema = Type.Object({
	/** 工作区标识（UUID）：Task 与 Evidence 靠它关联到具体检出。 */
	workspaceId: UuidSchema,
	/** 工作区绝对路径（规范化）。 */
	path: Type.String(),
	availability: WorkspaceAvailabilitySchema,
	vcs: Type.Optional(WorkspaceVcsSchema),
	/** 快照采集时间（epoch ms）。 */
	capturedAt: Type.Integer(),
});
export type WorkspaceBinding = Static<typeof WorkspaceBindingSchema>;

export const ProjectIdentitySchema = Type.Object({
	ibv: ProjectFieldSchema,
	ibvVersion: ProjectFieldSchema,
	chipsetVendor: ProjectFieldSchema,
	chipsetFamily: ProjectFieldSchema,
	chipsetGeneration: ProjectFieldSchema,
	architecture: ProjectFieldSchema,
	boardName: ProjectFieldSchema,
	boardRevision: ProjectFieldSchema,
	customer: ProjectFieldSchema,
	productLine: ProjectFieldSchema,
	crbBaseline: ProjectFieldSchema,
});
export type ProjectIdentity = Static<typeof ProjectIdentitySchema>;

export const ProjectProfileSchema = Type.Object({
	...RecordBaseSchema.properties,
	id: BiosProjectIdSchema,
	identity: ProjectIdentitySchema,
	/** 绑定到本项目的全部工作区；空数组表示尚未绑定（身份可以先于工作区存在）。 */
	workspaces: Type.Array(WorkspaceBindingSchema),
	/** 构建目标（BIOS 目标名 / 平台包名），每项带确认程度与证据。 */
	buildTargets: Type.Array(ProjectFieldSchema),
	/** 关键入口（客户定制区、板级目录、构建脚本），供后续检索与交接定位。 */
	keyEntryPoints: Type.Array(ProjectFieldSchema),
	gaps: Type.Array(FieldGapSchema),
});
export type ProjectProfile = Static<typeof ProjectProfileSchema>;

/** TaskRecord：与 Session 无关的任务记录。 */
export const TaskWorkspaceSchema = Type.Object({
	/** 关联到 `ProjectProfile.workspaces[].workspaceId`：两个 worktree 必须能区分。 */
	workspaceId: UuidSchema,
	path: Type.String(),
	branch: Type.Optional(Type.String()),
	baseCommit: Type.Optional(Type.String()),
});
export type TaskWorkspace = Static<typeof TaskWorkspaceSchema>;

export const TaskRecordSchema = Type.Object({
	...RecordBaseSchema.properties,
	id: KnowledgeIdSchema,
	projectId: BiosProjectIdSchema,
	workspace: TaskWorkspaceSchema,
	requirement: Type.String(),
	status: TaskStatusSchema,
	decisions: Type.Array(Type.String()),
	todos: Type.Array(Type.String()),
	blockers: Type.Array(Type.String()),
	relatedFiles: Type.Array(Type.String()),
	/** 本任务参考过的经验；只存 ID，正文在 ExperienceCard 里按权限读取。 */
	sourceExperienceIds: Type.Array(KnowledgeIdSchema),
	validations: Type.Array(ValidationRecordSchema),
});
export type TaskRecord = Static<typeof TaskRecordSchema>;

/** FeatureRecord：需求本体，提供人工别名以便检索（首版不做语义理解）。 */
export const FeatureRecordSchema = Type.Object({
	...RecordBaseSchema.properties,
	id: KnowledgeIdSchema,
	originalRequirement: Type.String(),
	aliases: Type.Array(Type.String()),
	customer: ProjectFieldSchema,
	productLine: ProjectFieldSchema,
	acceptanceCriteria: Type.Array(Type.String()),
	relatedExperienceIds: Type.Array(KnowledgeIdSchema),
});
export type FeatureRecord = Static<typeof FeatureRecordSchema>;

/** ExperienceCard：可复用的经验卡，审核状态独立于任务状态。 */
export const ExperienceCardSchema = Type.Object({
	...RecordBaseSchema.properties,
	id: KnowledgeIdSchema,
	featureId: Type.Optional(KnowledgeIdSchema),
	problem: Type.String(),
	symptom: Type.Optional(Type.String()),
	rootCause: Type.String(),
	solution: Type.String(),
	appliesWhen: Type.Array(Type.String()),
	doesNotApplyWhen: Type.Array(Type.String()),
	sourceProjectId: BiosProjectIdSchema,
	evidence: Type.Array(EvidenceRefSchema),
	validations: Type.Array(ValidationRecordSchema),
	reuseScope: ReuseScopeSchema,
	status: ExperienceStatusSchema,
	/** 审核人标签（人工填写的标签，不是企业身份认证）。 */
	reviewer: Type.Optional(Type.String()),
});
export type ExperienceCard = Static<typeof ExperienceCardSchema>;

/** ContextManifest：本轮任务实际注入了什么、为什么选它、截断了多少。 */
export const ContextSourceSchema = Type.Object({
	recordId: KnowledgeIdSchema,
	recordKind: Type.String(),
	revision: Type.Integer({ minimum: 0 }),
	/** 选取原因：让"为什么这条经验出现在上下文里"可复核。 */
	reason: Type.String(),
});
export type ContextSource = Static<typeof ContextSourceSchema>;

export const ContextBudgetSchema = Type.Object({
	maxChars: Type.Integer({ minimum: 0 }),
	maxBytes: Type.Integer({ minimum: 0 }),
	usedChars: Type.Integer({ minimum: 0 }),
	truncated: Type.Boolean(),
});
export type ContextBudget = Static<typeof ContextBudgetSchema>;

export const ContextManifestSchema = Type.Object({
	...RecordBaseSchema.properties,
	id: KnowledgeIdSchema,
	targetProjectId: BiosProjectIdSchema,
	taskId: Type.Optional(KnowledgeIdSchema),
	/** 生成上下文时使用的档案 revision：档案变了要能看出上下文已过期。 */
	profileRevision: Type.Integer({ minimum: 0 }),
	sources: Type.Array(ContextSourceSchema),
	/** 已过期/待复核的来源 ID（保留可见，但不作为新修改的依据）。 */
	expiredSources: Type.Array(KnowledgeIdSchema),
	budget: ContextBudgetSchema,
	generatedAt: Type.Integer(),
});
export type ContextManifest = Static<typeof ContextManifestSchema>;

/** 记录类型 → schema 的唯一定位表（校验与后续存储层的路由依据）。 */
export const RECORD_SCHEMAS = {
	"project-profile": ProjectProfileSchema,
	"task-record": TaskRecordSchema,
	"feature-record": FeatureRecordSchema,
	"experience-card": ExperienceCardSchema,
	"context-manifest": ContextManifestSchema,
} as const;

export type RecordKind = keyof typeof RECORD_SCHEMAS;

export const RECORD_KIND_SCHEMA = Type.Union([Type.Literal("project-profile"), Type.Literal("task-record"), Type.Literal("feature-record"), Type.Literal("experience-card"), Type.Literal("context-manifest")]);
