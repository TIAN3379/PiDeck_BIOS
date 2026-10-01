/**
 * 契约公共骨架：所有 BIOS 知识记录共用的字段、枚举与状态机。
 *
 * schema 是**唯一来源**：类型一律由 schema 推导（`Static<>`），桌面共享层只做
 * type-only 重导出，禁止复制第二套同名结构（见 mvp_development_plan.md §4 边界要求）。
 *
 * 纯数据层：只依赖 typebox，不 import Electron／React／Jotai／Pi Session，
 * 因此可在纯 Node 下测试。
 */
import { type Static, Type } from "typebox";

/**
 * 项目字段的确认程度三态。
 * - `unknown`：没有证据，保持未知——不允许"猜一个最可能的值"；
 * - `candidate`：有证据但未经人工确认；冲突候选都保留，不生成假的精确置信度；
 * - `confirmed`：人工确认的结果；重新检测不会自动改写，基线变化时标记待复核。
 */
export const FieldStatusSchema = Type.Union([Type.Literal("unknown"), Type.Literal("candidate"), Type.Literal("confirmed")]);
export type FieldStatus = Static<typeof FieldStatusSchema>;

/** 证据来源类型。 */
export const EvidenceSourceTypeSchema = Type.Union([Type.Literal("source-file"), Type.Literal("commit"), Type.Literal("document"), Type.Literal("session"), Type.Literal("human-note")]);
export type EvidenceSourceType = Static<typeof EvidenceSourceTypeSchema>;

/**
 * 证据有效性。
 * - `active`：采集时有效且未发现漂移；
 * - `stale`：文件移动／内容 hash 改变／行号失效——需要复核，不能用旧行号冒充当前实现；
 * - `unavailable`：来源当前不可达（目录离线、分支被删），保留引用不删除。
 */
export const EvidenceValiditySchema = Type.Union([Type.Literal("active"), Type.Literal("stale"), Type.Literal("unavailable")]);
export type EvidenceValidity = Static<typeof EvidenceValiditySchema>;

/**
 * 证据引用：把结论指回可复核的出处。
 * 路径一律用**相对路径**（相对项目工作区或知识根），不写入用户主目录等环境相关的绝对路径。
 */
export const EvidenceRefSchema = Type.Object({
	type: EvidenceSourceTypeSchema,
	/** 证据所属知识项目；跨项目引用时必须填写，便于按权限过滤。 */
	projectId: Type.Optional(Type.String()),
	/**
	 * 证据属于哪个工作区（`ProjectProfile.workspaces[].workspaceId`）。
	 * 一个项目可以有多个 worktree；不记工作区就无法判断这条证据的相对路径与行号
	 * 是相对哪个检出，过期复核也会张冠李戴。
	 */
	workspaceId: Type.Optional(Type.String()),
	relativePath: Type.Optional(Type.String()),
	/** 行号范围或文档位置，如 `"120-168"`、`"docs/spec.md#L20"`。 */
	location: Type.Optional(Type.String()),
	commit: Type.Optional(Type.String()),
	/** 未提交文件必须保存内容 hash，用内容而非行号锚定。 */
	contentHash: Type.Optional(Type.String()),
	/** 采集时间（epoch ms）。 */
	capturedAt: Type.Integer(),
	validity: EvidenceValiditySchema,
});
export type EvidenceRef = Static<typeof EvidenceRefSchema>;

/** 项目档案里的单个字段：值 + 确认程度 + 证据 + 更新时间。 */
export const ProjectFieldSchema = Type.Object({
	value: Type.Union([Type.String(), Type.Null()]),
	status: FieldStatusSchema,
	evidence: Type.Array(EvidenceRefSchema),
	updatedAt: Type.Integer(),
});
export type ProjectField = Static<typeof ProjectFieldSchema>;

/** 资料缺口：明确写出"不知道什么"，避免模型用常识填补。 */
export const FieldGapSchema = Type.Object({
	/** 缺失的字段名（如 `chipsetFamily`）。 */
	field: Type.String({ minLength: 1 }),
	/** 为什么缺失或为什么无法确认。 */
	reason: Type.String(),
	/** 用户可以提供什么材料来补齐（可执行建议，不是承诺）。 */
	hint: Type.Optional(Type.String()),
});
export type FieldGap = Static<typeof FieldGapSchema>;

/**
 * 验证记录：必须区分验证强度。
 * 有 commit 或编译通过**不能**升级为硬件 verified（mvp_development_plan.md §6）。
 */
export const ValidationKindSchema = Type.Union([Type.Literal("code-review"), Type.Literal("compile"), Type.Literal("board-boot"), Type.Literal("stress-loop"), Type.Literal("customer-acceptance")]);
export type ValidationKind = Static<typeof ValidationKindSchema>;

/** 验证结论。`inconclusive` 是合法结果：范围不足时不允许写"通过"。 */
export const ValidationResultSchema = Type.Union([Type.Literal("passed"), Type.Literal("failed"), Type.Literal("inconclusive")]);
export type ValidationResult = Static<typeof ValidationResultSchema>;

export const ValidationRecordSchema = Type.Object({
	kind: ValidationKindSchema,
	/** 验证覆盖的范围描述（哪块板、哪个目标、哪组用例）。每项验证单独展示。 */
	scope: Type.String(),
	result: ValidationResultSchema,
	/** 执行时间（epoch ms）。 */
	performedAt: Type.Integer(),
	/** 执行者标签（人工填写的标签，不是企业身份认证）。 */
	performedBy: Type.String(),
	evidence: Type.Array(EvidenceRefSchema),
});
export type ValidationRecord = Static<typeof ValidationRecordSchema>;

/** ExperienceCard 审核状态机（mvp_development_plan.md §6）。 */
export const ExperienceStatusSchema = Type.Union([Type.Literal("draft"), Type.Literal("reviewed"), Type.Literal("verified"), Type.Literal("deprecated")]);
export type ExperienceStatus = Static<typeof ExperienceStatusSchema>;

/** 任务状态机。完成任务**不等于**经验 verified。 */
export const TaskStatusSchema = Type.Union([Type.Literal("planned"), Type.Literal("in_progress"), Type.Literal("blocked"), Type.Literal("done"), Type.Literal("archived")]);
export type TaskStatus = Static<typeof TaskStatusSchema>;

/** 复用范围的最窄粒度。跨客户复用需要 `ReuseScope.authorization` 显式授权。 */
export const ReuseScopeLevelSchema = Type.Union([Type.Literal("current-project"), Type.Literal("customer"), Type.Literal("internal-general")]);
export type ReuseScopeLevel = Static<typeof ReuseScopeLevelSchema>;

export const ReuseScopeSchema = Type.Object({
	level: ReuseScopeLevelSchema,
	/** `level = "customer"` 时列出的客户标识；空数组表示未指定，按最窄范围处理。 */
	customers: Type.Array(Type.String()),
	/** 跨客户复用的显式授权说明。缺失即未授权：可以留档，不可以带进其他客户的任务。 */
	authorization: Type.Optional(Type.String()),
});
export type ReuseScope = Static<typeof ReuseScopeSchema>;

/**
 * 记录公共头：写入契约要求每条记录都带这四个字段（mvp_development_plan.md §5.3）。
 * 用 `properties` 展开而不是 `Type.Intersect`，让校验错误的路径保持扁平可读。
 */
export const RecordBaseSchema = Type.Object({
	schemaVersion: Type.Integer({ minimum: 1 }),
	/** 乐观并发控制：写入必须携带预期 revision，冲突返回结构化错误而不是覆盖他人修改。 */
	revision: Type.Integer({ minimum: 0 }),
	createdAt: Type.Integer(),
	updatedAt: Type.Integer(),
});
export type RecordBase = Static<typeof RecordBaseSchema>;
