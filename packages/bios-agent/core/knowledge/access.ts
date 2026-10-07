/**
 * 知识公共入口的**来源授权**判定（R29-1）。
 *
 * 为什么单独一个模块：`core/knowledge` 的公开服务（详情/列表/关联/检索/创建/审核）
 * 都要"先核对来源、再读写内容"，但每一步各自读 registry 会写出多份口径，
 * 迟早出现"某条路径忘了核对来源项目"。这里的两个函数是**唯一**的来源存在性/
 * 授权/工作区归属判定，公开入口必须调用它们。
 *
 * 边界：授权是**本地调用方声明**（CLI 参数 / 后续 Pi 适配层），不是企业身份认证；
 * 本模块只回答"这次调用声称允许访问哪些来源"，不做任何身份证明。
 */
import type { RegistryProjectEntry } from "../contracts/registry.ts";
import { isStorageError, readRegistry, type StorageIoHooks, type StorageLimits } from "../storage/index.ts";
import { invalidArgument, notAuthorized } from "./contract.ts";

/** 读 registry 并把"库还不存在"映射成受控的服务错误（不是 io-error）。 */
async function loadRegistry(input: { root: string; storageLimits?: Partial<StorageLimits>; signal?: AbortSignal; ioHooks?: StorageIoHooks }): Promise<{ projects: RegistryProjectEntry[] }> {
	try {
		const registry = await readRegistry({ root: input.root, limits: input.storageLimits, signal: input.signal, ioHooks: input.ioHooks });
		return { projects: registry.projects };
	} catch (error) {
		if (isStorageError(error) && (error.code === "not-found" || error.code === "invalid-root")) {
			throw invalidArgument(`知识库尚未初始化或知识根不可用（缺少 registry.json）：${input.root}`);
		}
		throw error;
	}
}

/**
 * 核对来源项目**存在**且（调用方给出授权集合时）在授权范围内。
 *
 * R29-1 的实际缺口：只校验了 `sourceProjectId` 的 UUID 形态，于是"不存在的项目 ID"
 * 也能把经验卡写进库里——卡片带着一个永远无法核对来源项目的引用。
 *
 * 返回 registry 里的项目条目，供调用方继续核对工作区归属（不重复读 registry）。
 */
export async function requireSourceProject(input: { root: string; sourceProjectId: string; authorizedProjectIds?: readonly string[]; storageLimits?: Partial<StorageLimits>; signal?: AbortSignal; ioHooks?: StorageIoHooks }): Promise<RegistryProjectEntry> {
	const { projects } = await loadRegistry(input);
	const project = projects.find((entry) => entry.biosProjectId === input.sourceProjectId);
	if (project === undefined) {
		// 不存在 ⇒ 拒绝写入，且不留卡片（判定发生在任何 createRecord 之前）。
		throw invalidArgument(`来源项目 ${input.sourceProjectId} 不在知识库 registry 里：不能把来源不明的经验/需求写进库`, "source-project-not-found");
	}
	const authorized = input.authorizedProjectIds;
	if (authorized !== undefined && !authorized.includes(input.sourceProjectId)) {
		throw notAuthorized(`来源项目 ${input.sourceProjectId} 不在本次授权范围内（已授权：${authorized.join("、") || "（无）"}）`, "source-project-not-authorized");
	}
	return project;
}

/**
 * 公开入口的**显式授权**闸门（R30-1）。
 *
 * 省略或空集合都按未授权处理：调用方必须明确列出允许访问的项目。必须在返回
 * 冲突/状态/revision 之前调用，避免用 `revision-conflict` 之类响应泄漏未授权记录的状态。
 */
export function requireExplicitProjectAuthorization(authorizedProjectIds: readonly string[] | undefined, projectId: string, label = "项目"): void {
	if (authorizedProjectIds === undefined || authorizedProjectIds.length === 0) throw notAuthorized(`必须显式给出 ${label}授权（authorizedProjectIds）；缺省即拒绝`, "project-not-authorized");
	if (!authorizedProjectIds.includes(projectId)) throw notAuthorized(`${label} ${projectId} 不在本次授权范围内`, "project-not-authorized");
}

/** 证据引用里的 `workspaceId` 必须真实属于来源项目（否则相对路径/行号无法归属到检出）。 */
export function assertWorkspaceBelongsToProject(project: RegistryProjectEntry, workspaceId: string | undefined, label: string): void {
	if (workspaceId === undefined) return;
	if (!project.workspaces.some((workspace) => workspace.workspaceId === workspaceId)) {
		throw invalidArgument(`${label} 的 workspaceId（${workspaceId}）不属于来源项目 ${project.biosProjectId}`, "workspace-not-in-project");
	}
}
