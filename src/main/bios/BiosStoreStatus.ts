/**
 * BM-07B B-03：**知识库状态探测**（首次使用流程的第 1 步）。
 *
 * 为什么需要它：`listProjects` 会吞掉单项目读取失败（`catch` 后继续），因此
 * "未初始化 / 损坏 / 未来版本"在列表里都表现为"没有内容"，界面无法区分，
 * 用户会以为"库是空的"。本模块只做**只读分类**，把四种状态如实分开。
 *
 * 边界：
 * - 复用 core 的 `readRegistry`（唯一解释链），**不**自己写一套更弱的版本/结构判定；
 * - 不修复、不覆盖、不自动迁移：坏库保持原字节，只是"报出来"；
 * - 返回值只含状态、版本号、revision 与计数，**不含**任何记录正文。
 */
import { existsSync, statSync } from "node:fs";
import { BIOS_CONTRACTS_SCHEMA_VERSION } from "../../../packages/bios-agent/core/contracts/version.ts";
import { isStorageError, readRegistry } from "../../../packages/bios-agent/core/storage/index.ts";
import type { BiosStoreStatus } from "../../shared/types/bios";

/** 知识根形态检查结果：目录不存在 / 不是目录 / 是目录。 */
export type RootShape = "missing" | "not-a-directory" | "directory";

/** 纯函数：只看路径形态，不接触知识库内容（便于单测）。 */
export function inspectRootShape(root: string, probe: (path: string) => { exists: boolean; isDirectory: boolean }): RootShape {
	const outcome = probe(root);
	if (!outcome.exists) return "missing";
	return outcome.isDirectory ? "directory" : "not-a-directory";
}

function defaultProbe(path: string): { exists: boolean; isDirectory: boolean } {
	try {
		return { exists: existsSync(path), isDirectory: existsSync(path) && statSync(path).isDirectory() };
	} catch {
		return { exists: false, isDirectory: false };
	}
}

/**
 * 把 core 抛出的存储错误分类成界面状态。
 *
 * - `not-found` ⇒ 目录在、registry 不在 ⇒ **未初始化**（不是坏库）；
 * - `unsupported-schema-version` ⇒ **未来/不认识的版本**（含低于支持范围，core 一并拒绝解释）；
 * - `invalid-json` / `invalid-record` ⇒ **损坏**（结构或 JSON 不合法）；
 * - 其余（权限、不是文件、超限、取消……）⇒ **不可达**，只带受限说明。
 */
export function classifyStoreError(root: string, error: unknown): BiosStoreStatus {
	if (isStorageError(error)) {
		switch (error.code) {
			case "not-found":
				return { kind: "not-initialized", root };
			case "unsupported-schema-version":
				return { kind: "future-version", root, supportedVersion: BIOS_CONTRACTS_SCHEMA_VERSION, detail: error.message };
			case "invalid-json":
			case "invalid-record":
				return { kind: "corrupt", root, detail: error.message };
			default:
				return { kind: "unreachable", root, detail: `${error.code}：${error.message}` };
		}
	}
	return { kind: "unreachable", root, detail: error instanceof Error ? error.message : String(error) };
}

/**
 * 读取知识库状态（只读）。
 *
 * `knowledgeRoot === null` 即"未配置"：此路径**不**推断默认目录，也不创建任何东西。
 */
export async function readBiosStoreStatus(knowledgeRoot: string | null, probe: (path: string) => { exists: boolean; isDirectory: boolean } = defaultProbe): Promise<BiosStoreStatus> {
	if (knowledgeRoot === null || knowledgeRoot.trim() === "") return { kind: "unconfigured" };
	const shape = inspectRootShape(knowledgeRoot, probe);
	if (shape === "missing") return { kind: "directory-missing", root: knowledgeRoot };
	if (shape === "not-a-directory") return { kind: "unreachable", root: knowledgeRoot, detail: "知识根存在但不是目录：请重新选择目录" };
	try {
		const registry = await readRegistry({ root: knowledgeRoot });
		return {
			kind: "ready",
			root: knowledgeRoot,
			registryRevision: registry.revision,
			schemaVersion: registry.schemaVersion,
			projectCount: registry.projects.length,
		};
	} catch (error) {
		return classifyStoreError(knowledgeRoot, error);
	}
}
