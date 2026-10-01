/**
 * bios-agent 的**唯一**自动加载入口（package.json 的 `pi.extensions` 只指向本文件）。
 *
 * 边界（mvp_development_plan.md §4）：
 * - 本文件只是薄适配层：把 Pi 的工具契约翻译成对 `core/` 的调用，不实现业务规则；
 * - 工厂函数里**不启动**进程／定时器／watcher／socket——Pi 会在部分调用中加载扩展
 *   但不启动会话，注册之外的副作用会让这些调用挂掉或泄漏；
 * - core 不依赖 Electron／React／Jotai／Pi Session，因此同一份逻辑可被桌面主进程复用。
 *
 * 访问面（round1 R6 + round2 F4）：目标目录必须先过授权检查。
 * 默认授权根是会话工作目录；额外根只能由适配层通过 `BIOS_AUTHORIZED_ROOTS` 注入
 * （且必须是完全限定的绝对路径），**模型无法用工具参数给自己扩权**。
 *
 * 本轮只注册唯一一个只读工具，且它不判定厂商／板卡／代际：
 * 厂商适配规则需要 BM-03 的真实样例验证，先猜等于造假。
 */
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { FieldGap } from "../core/contracts/index.ts";
import { BIOS_AGENT_PACKAGE_NAME, BIOS_AGENT_PACKAGE_VERSION, BIOS_CONTRACTS_SCHEMA_VERSION } from "../core/contracts/version.ts";
import { resolveKnowledgeRoot } from "../core/paths.ts";
import { readAuthorizedRootsFromEnv, resolveAuthorizedTargetDir } from "../core/projects/authorization.ts";
import { DEFAULT_SCAN_LIMITS, type ProjectProbeResult, probeProjectDirectory, totalHintCount } from "../core/projects/probe.ts";

export type BiosDetectProjectDetails = {
	/** 本轮固定 `unknown`：检测只给线索，身份结论必须由人工确认。 */
	status: "unknown";
	packageName: string;
	packageVersion: string;
	contractsSchemaVersion: number;
	/** 本次实际扫描的目录（真实路径）。 */
	targetDir: string;
	/** 命中的授权根、生效的授权根集合与配置但不可达的根：让"在哪个范围内扫描"可复核。 */
	authorization: { matchedRoot: string; effectiveRoots: string[]; unreachableRoots: string[] };
	scannedPaths: number;
	truncated: boolean;
	truncatedBy: ProjectProbeResult["truncatedBy"];
	maxDepthReached: number;
	hintCounts: ProjectProbeResult["hintCounts"];
	hintSamples: ProjectProbeResult["hintSamples"];
	gaps: FieldGap[];
	warnings: ProjectProbeResult["warnings"];
	/** 因 warnings 上限被丢弃的告警条数：避免把"最多 50 条样例"当成实际失败目录总数。 */
	droppedWarnings: number;
	skippedDirectories: number;
	/** 解析到的知识根，用于确认桌面端与 CLI 指向同一份数据。 */
	knowledgeRoot: { root: string; source: string };
};

/**
 * 资料缺口：把"这次没确定什么"写清楚。
 * 缺口是结果的一部分——只有线索计数而没有缺口说明，会让模型倾向于用常识补全结论。
 */
export function buildDetectGaps(probe: ProjectProbeResult): FieldGap[] {
	const gaps: FieldGap[] = [];

	if (totalHintCount(probe) === 0) {
		gaps.push({
			field: "biosProjectIdentity",
			reason: "在扫描预算内没有发现 BIOS 构建线索文件（.inf/.dec/.dsc/.fdf/.asl）。",
			hint: "确认 targetDir 指向 BIOS 源码根，或改用更精确的目标目录重新检测。",
		});
	}
	if (probe.truncated) {
		gaps.push({
			field: "scanCoverage",
			reason: `检测达到预算上限（${probe.truncatedBy.join("、") || "未知维度"}），结果不完整：预算内的结论只在预算内有效。`,
			hint: "指定更小的目标目录（例如板级或平台目录）重新检测。",
		});
	}
	if (probe.warnings.length > 0 || probe.droppedWarnings > 0) {
		gaps.push({
			field: "scanReadability",
			reason: `${probe.warnings.length} 个子目录不可读${probe.droppedWarnings > 0 ? `，另有 ${probe.droppedWarnings} 条告警因上限未记录` : ""}，未纳入检测。`,
			hint: "检查目录权限后重试。",
		});
	}
	gaps.push({
		field: "identity.ibv / identity.chipsetFamily / identity.boardName",
		reason: "身份字段需要真实样例规则（BM-03）与人工确认；本轮只返回线索，不做厂商或平台判定。",
		hint: "由人工在项目档案中确认，或补充厂商资料后再接入规则。",
	});

	return gaps;
}

/** 把结果压成模型可读文本；结构化数据同时放在 details 里供工具渲染与后续消费。 */
export function renderDetectSummary(details: BiosDetectProjectDetails): string {
	const lines: string[] = [];
	lines.push("BIOS 项目线索检测（只读）");
	lines.push(`目标目录：${details.targetDir}`);
	lines.push(`授权范围：命中 ${details.authorization.matchedRoot}（生效授权根 ${details.authorization.effectiveRoots.length} 个）`);
	if (details.authorization.unreachableRoots.length > 0) {
		lines.push(`配置但不可达的额外根：${details.authorization.unreachableRoots.join("、")}`);
	}
	lines.push(`扫描路径数：${details.scannedPaths}${details.truncated ? `（达到预算上限：${details.truncatedBy.join("、")}，结果不完整）` : "（未触达预算上限）"}`);
	lines.push("线索文件：");
	for (const [extension, count] of Object.entries(details.hintCounts)) {
		const samples = details.hintSamples[extension as keyof typeof details.hintSamples] ?? [];
		lines.push(`- ${extension}: ${count}${samples.length > 0 ? `（示例：${samples.slice(0, 3).join(", ")}）` : ""}`);
	}
	lines.push(`结论：${details.status} —— 未做厂商／平台判定，需要人工确认或后续规则支持。`);
	lines.push("资料缺口：");
	for (const gap of details.gaps) lines.push(`- ${gap.field}：${gap.reason}${gap.hint ? `（建议：${gap.hint}）` : ""}`);
	lines.push(`知识根：${details.knowledgeRoot.root}（来源：${details.knowledgeRoot.source}）`);
	if (details.warnings.length > 0) {
		lines.push(`不可读目录：${details.warnings.length} 个（示例：${details.warnings[0]?.path ?? ""}）`);
	}
	return lines.join("\n");
}

export const biosDetectProjectTool = defineTool({
	name: "bios_detect_project",
	label: "BIOS 项目检测",
	promptSnippet: "只读检测 BIOS 项目线索（.inf/.dec/.dsc/.fdf/.asl），不判定厂商与平台",
	description:
		"Read-only reconnaissance of a BIOS source tree. Returns bounded evidence: counts and sample relative paths of common BIOS build/description files (.inf/.dec/.dsc/.fdf/.asl), plus explicit data gaps. It only scans the session worktree (or an additionally authorized root configured by the user) and never confirms the IBV, chipset vendor/family/generation or board identity. It does not read file contents.",
	parameters: Type.Object({
		targetDir: Type.Optional(Type.String({ description: "要检测的目录；省略时使用当前会话工作目录。相对路径按会话工作目录解析，且必须位于已授权范围内。" })),
	}),
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		// 先授权、后扫描：被拒绝时不返回目标目录内的任何线索。
		const authorized = resolveAuthorizedTargetDir({
			requested: params.targetDir,
			cwd: ctx.cwd,
			authorizedRoots: readAuthorizedRootsFromEnv(),
		});

		// 取消信号直连探测循环的等待点；取消会抛出让 Pi 生成失败结果。
		const probe = await probeProjectDirectory(authorized.targetDir, { limits: DEFAULT_SCAN_LIMITS, signal: signal ?? undefined });
		const knowledgeRoot = resolveKnowledgeRoot();
		const gaps = buildDetectGaps(probe);

		const details: BiosDetectProjectDetails = {
			status: "unknown",
			packageName: BIOS_AGENT_PACKAGE_NAME,
			packageVersion: BIOS_AGENT_PACKAGE_VERSION,
			contractsSchemaVersion: BIOS_CONTRACTS_SCHEMA_VERSION,
			targetDir: authorized.targetDir,
			authorization: { matchedRoot: authorized.matchedRoot, effectiveRoots: authorized.effectiveRoots, unreachableRoots: authorized.unreachableRoots },
			scannedPaths: probe.scannedPaths,
			truncated: probe.truncated,
			truncatedBy: probe.truncatedBy,
			maxDepthReached: probe.maxDepthReached,
			hintCounts: probe.hintCounts,
			hintSamples: probe.hintSamples,
			gaps,
			warnings: probe.warnings,
			droppedWarnings: probe.droppedWarnings,
			skippedDirectories: probe.skippedDirectories,
			knowledgeRoot: { root: knowledgeRoot.root, source: knowledgeRoot.source },
		};

		return { content: [{ type: "text", text: renderDetectSummary(details) }], details };
	},
});

export default function registerBiosAgent(pi: ExtensionAPI): void {
	pi.registerTool(biosDetectProjectTool);
}
