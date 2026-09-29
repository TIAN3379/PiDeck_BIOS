/**
 * 更新源（GitHub Release 镜像）配置 —— 主进程侧编排逻辑。
 *
 * 纯数据与拼接规则在 shared/updateSources.ts（主/渲染共用同一份清单，UI 展示与
 * feed URL 生成自动同步）；本文件只保留需要主进程侧的归一化与查询函数。
 */

import type { UpdateSourceId } from "../../shared/types/settings";
import { normalizeCustomMirrorHost } from "../../shared/updateSources";

export { normalizeCustomMirrorHost }; // 再导出，供调用点单一来源

/** BIOS Agent 只从自己的 GitHub Releases 更新；旧 AtomGit 设置回退到 GitHub。 */
export function normalizeUpdateSource(source: unknown): UpdateSourceId {
	void source;
	return "github";
}

/** 镜像展示信息（设置页下拉/列表用）：id + 显示名 labelKey + 完整 feed URL。 */
export type UpdateSourceOption = {
	id: UpdateSourceId;
	/** 渲染层 i18n label key 后缀（settings.updateSourceOption.<id>）。 */
	labelKey: string;
	host: string | null;
	feedUrl: string | null;
};

/**
 * 更新源下拉选项（atomgit 第一首选，github 官方次选）。
 */
export function updateSourceOptions(): UpdateSourceOption[] {
	return [{ id: "github", labelKey: "github", host: null, feedUrl: null }];
}

/**
 * 生成镜像源的 generic feed baseUrl。
 * github 源无 URL（返回 null → 走默认 app-update.yml/原生 GitHub provider）；
 * atomgit 源返回 AtomGit generic feed baseUrl。
 */
export function updateSourceFeedUrl(source: UpdateSourceId, _customHost?: string | null): string | null {
	void source;
	return null;
}

/**
 * macOS manual 检查的 latest-release 探测 URL：
 * atomgit 源返回 OpenAPI latest（网页是 SPA，不会 302 到 tag）；
 * github 源返回 null → 主进程走官方 GitHub `/releases/latest` 重定向。
 */
export function updateSourceLatestReleaseUrl(source: UpdateSourceId, _customHost?: string | null): string | null {
	void source;
	return null;
}
