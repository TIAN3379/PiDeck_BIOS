/**
 * C5：**自动记忆的真实状态**（宿主投影给默认面板，不用扩展里的私有变量当界面交付）。
 *
 * 三条边界：
 * - 只读**附属记录**（`automation/workspaces/<workspaceId>/state.json`），不碰业务记录；
 * - 目录一律从**桌面项目表 + 注册表绑定**解析，renderer 不能提交路径；
 * - 未配置/未开启/未绑定时如实给出"不可用原因"，不显示一个看起来正常的空状态。
 */
import { realpath } from "node:fs/promises";
import { readWorkspaceState } from "../../../packages/bios-agent/core/automation/store.ts";
import { requireFullyQualifiedRoot } from "../../../packages/bios-agent/core/paths.ts";
import { readRegistry, resolveProjectBinding } from "../../../packages/bios-agent/core/storage/registry.ts";
import type { BiosAutomationStatus, BiosHostSettings } from "../../shared/types/bios";
import { normalizeBiosHostSettings } from "./biosProcessEnv.ts";

export type BiosAutomationStatusOptions = {
	readSettings: () => Partial<BiosHostSettings> | null;
	/** 桌面项目表解析（只解析真实登记的路径，不采信请求参数）。 */
	resolveProject: (desktopProjectId: string) => { readonly path: string } | null;
};

export class BiosAutomationStatusService {
	private readonly options: BiosAutomationStatusOptions;
	constructor(options: BiosAutomationStatusOptions) {
		this.options = options;
	}

	async read(desktopProjectId: string): Promise<BiosAutomationStatus> {
		const settings = normalizeBiosHostSettings(this.options.readSettings());
		if (settings.knowledgeRoot === null) return unavailable("no-knowledge-root");
		if (!settings.automation.enabled) return unavailable("automation-disabled");
		const project = this.options.resolveProject(desktopProjectId);
		if (project === null) return unavailable("not-bound");
		let workspacePath: string;
		try {
			workspacePath = await realpath(requireFullyQualifiedRoot(project.path, "项目目录"));
		} catch {
			return unavailable("not-bound");
		}
		let workspaceId: string | null = null;
		try {
			const registry = await readRegistry({ root: settings.knowledgeRoot });
			const binding = resolveProjectBinding(registry, { workspacePath });
			if (binding.status !== "resolved") return unavailable("not-bound");
			// 同一路径可能存在于多个项目条目：只接受与绑定项目一致的那一条。
			workspaceId = binding.project.workspaces.find((entry) => entry.path === workspacePath)?.workspaceId ?? null;
			if (workspaceId === null) return unavailable("not-bound");
			const state = await readWorkspaceState({ root: settings.knowledgeRoot, projectId: binding.project.biosProjectId, workspaceId });
			if (state.status !== "ok") return unavailable("unavailable");
			const marks = state.value.reflectionMarks;
			const newest = state.value.checkpoints.reduce<number | null>((latest, ref) => (latest === null || ref.recordedAt > latest ? ref.recordedAt : latest), null);
			const receipt = state.value.lastReceipt ?? null;
			return {
				available: true,
				reason: "ok",
				checkpoints: state.value.checkpoints.length,
				pendingReflection: state.value.checkpoints.filter((ref) => ref.pendingReflection).length,
				lastRecordedAt: newest,
				durableSaved: marks.filter((mark) => mark.saved).length,
				// V3：四类状态**同源**、互斥，不再让"未恢复"和"待恢复"同时出现在界面上。
				// 只依据**耐久事实**判定（宿主读的是磁盘，不能猜测当前会话身份）：
				// - `unrecoveredAt` 已写入 ⇒ 扩展已确认未恢复并回执（就是"未恢复"这一事实的耐久形态）；
				// - `finished` ⇒ 已终结（saved 区分成功/明确失败）；
				// - 其余未终结项 ⇒ 待核对（可能仍在别的会话里跑，也可能只是还没轮到它的回合）。
				durableUnrecovered: marks.filter((mark) => !mark.saved && mark.finished !== true && mark.unrecoveredAt !== undefined).length,
				durablePending: marks.filter((mark) => !mark.saved && mark.finished !== true && mark.unrecoveredAt === undefined).length,
				durableFailed: marks.filter((mark) => !mark.saved && mark.finished === true).length,
				receipt: receipt === null ? null : { kind: receipt.kind, recordedAt: receipt.recordedAt, detail: receipt.detail },
			};
		} catch {
			// 注册表不可读/未建库/版本不认识：如实报不可用，不猜一个空状态。
			return unavailable("unavailable");
		}
	}
}

function unavailable(reason: BiosAutomationStatus["reason"]): BiosAutomationStatus {
	return { available: false, reason, checkpoints: 0, pendingReflection: 0, lastRecordedAt: null, durableSaved: 0, durablePending: 0, durableFailed: 0, durableUnrecovered: 0, receipt: null };
}
