/**
 * `registry.json` 契约：知识库的**索引**（项目 ↔ 工作区 ↔ 桌面项目 ID 的绑定关系）。
 *
 * 与 `ProjectProfile` 的分工（bm02a_development_plan.md §3.2）：
 * registry 只回答"这个工作区属于哪个知识项目"，**不维护第二份 branch/HEAD 真相**——
 * 分支与提交快照是 `ProjectProfile.workspaces[].vcs` 的职责，
 * 两边各存一份迟早互相矛盾。
 *
 * 路径一律是**规范化后的完全限定绝对路径**；路径暂时不可达不删除绑定，
 * 目录移动需要将来显式改绑（BM-02B），不能按文件夹名重新生成 ID。
 *
 * 跨条目的绑定约束（重复 workspaceId、一个路径归属两个项目等）需要平台相关的路径比较，
 * 因此放在 `core/storage/registry.ts` 里实现；本文件只定义结构与版本闸门。
 */
import { type Static, Type } from "typebox";
import { RecordBaseSchema } from "./common.ts";
import { BiosProjectIdSchema, UuidSchema } from "./ids.ts";
import { type ValidationOutcome, validateRecord } from "./validate.ts";

/** 一个工作区在 registry 里的绑定条目（不含 branch/HEAD，见文件头说明）。 */
export const RegistryWorkspaceEntrySchema = Type.Object({
	/** 与 `ProjectProfile.workspaces[].workspaceId` 同一标识。 */
	workspaceId: UuidSchema,
	/** 规范化后的完全限定绝对路径。 */
	path: Type.String(),
	/** 绑定时间（epoch ms）。 */
	boundAt: Type.Integer(),
});
export type RegistryWorkspaceEntry = Static<typeof RegistryWorkspaceEntrySchema>;

export const RegistryProjectEntrySchema = Type.Object({
	/** 稳定知识项目 ID（UUID），不能用目录名/远端 URL/Session ID 代替。 */
	biosProjectId: BiosProjectIdSchema,
	/** 桌面端的 projectId；独立 CLI 场景可以没有。 */
	desktopProjectId: Type.Optional(Type.String()),
	displayName: Type.Optional(Type.String()),
	workspaces: Type.Array(RegistryWorkspaceEntrySchema),
	createdAt: Type.Integer(),
	updatedAt: Type.Integer(),
});
export type RegistryProjectEntry = Static<typeof RegistryProjectEntrySchema>;

export const RegistrySchema = Type.Object({
	...RecordBaseSchema.properties,
	projects: Type.Array(RegistryProjectEntrySchema),
});
export type Registry = Static<typeof RegistrySchema>;

/**
 * 空 registry 工厂（初始化时发布的内容）。
 * schemaVersion 由调用方传入（与记录契约共用同一个常量），
 * 避免 registry 与记录各有一套版本语义。
 */
export function createEmptyRegistry(now: number, schemaVersion: number): Registry {
	return {
		schemaVersion,
		revision: 0,
		createdAt: now,
		updatedAt: now,
		projects: [],
	};
}

/** registry 的版本闸门 + 结构校验（与记录共用同一套校验实现）。 */
export function validateRegistry(value: unknown): ValidationOutcome<Registry> {
	return validateRecord(RegistrySchema, value);
}
