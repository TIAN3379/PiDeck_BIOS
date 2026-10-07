/**
 * bios-agent 的**唯一**自动加载入口（package.json 的 `pi.extensions` 只指向本文件）。
 *
 * 本文件只做**装配**：注册工具/命令与生命周期钩子；每个职责各自的实现放在独立模块里
 * （`detectTool`、`knowledgeTools`、`commands`、`contextInjection`、`hostConfig`、`selection`）。
 *
 * 边界（mvp_development_plan.md §4 + bm06_development_plan.md §3）：
 * - 工厂函数里**不启动**进程／定时器／watcher／socket——Pi 会在部分调用中加载扩展但不启动会话；
 * - 授权一律来自**可信宿主配置**（环境变量/桌面注入）；模型参数只能传用户问题、所选 ID 与预算；
 * - CW 普通草稿工具须经会话级人工许可；正式审核/验证/授权仍不交给模型；
 * - core 不依赖 Electron／React／Jotai／Pi Session，因此同一份逻辑可被桌面主进程复用。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { biosDetectProjectTool } from "./detectTool.ts";
import { biosReadOnlyTools } from "./knowledgeTools.ts";
import { adoptInitialSelection, registerBiosCommands, BIOS_RECEIPT_CUSTOM_TYPE } from "./commands.ts";
import { registerContextInjection } from "./contextInjection.ts";
import { clearSelection } from "./selection.ts";
import { registerBiosAutomation } from "./automation.ts";
import { resetAutomationSession } from "./automationState.ts";
import { biosWorkflowTools, registerBiosWorkflow } from "./workflow.ts";
import { clearWorkflowPermission } from "./workflowScope.ts";

// 兼容既有导入路径（历史测试与外部引用 `../extensions/index.ts` 的 detect 工具）。
export { BIOS_AGENT_PACKAGE_NAME, BIOS_AGENT_PACKAGE_VERSION, BIOS_CONTRACTS_SCHEMA_VERSION } from "../core/contracts/version.ts";
export { biosDetectProjectTool, buildDetectGaps, renderDetectSummary, type BiosDetectProjectDetails } from "./detectTool.ts";
export { readBiosHostConfig, hostReadiness, configFingerprint, BIOS_CONFIG_ENV, type BiosHostConfig, type BiosEndpointPolicy } from "./hostConfig.ts";
export { selectionFor, describeSelection, lastAutoDisableReason, type BiosSelection } from "./selection.ts";
export { biosReadOnlyTools, type BiosToolDetails } from "./knowledgeTools.ts";
export { buildCallContext, assertNotAborted, type BiosCallContext, type BiosCallLike } from "./callContext.ts";
export { resolveModelBudget, boundText, boundDetails, projectDiagnostics, MODEL_CONTENT_MAX_CHARS, MODEL_CONTENT_MAX_BYTES } from "./outbound.ts";
export { decideContextMessages, isOwnInjection, BIOS_CONTEXT_CUSTOM_TYPE } from "./contextInjection.ts";
export { handleBiosTaskCommand, handleBiosContextCommand, adoptInitialSelection, BIOS_RECEIPT_CUSTOM_TYPE } from "./commands.ts";
export { initialAdoptionState } from "./selection.ts";
export { readInitialSelection, readAutomationCapability } from "./hostConfig.ts";
export { registerBiosAutomation, BIOS_AUTOMATION_CONTEXT_TYPE, BIOS_PENDING_REFLECTION_TYPE, renderAutomationContext, stopBiosAutomation, isOwnAutomationMessage } from "./automation.ts";
export { resetAutomationSession, revokeAutomation, isRevoked, automationActive, bookkeepingAllowed, injectionAllowed, projectBookkeepingGranted, snapshotRun, requestKeyOf, AUTOMATION_CEILINGS } from "./automationState.ts";
export { classifyRequestIntent, resolveRetrievalPlan, shouldRequestReflection, projectSaveStatus, hasUnsavedProgress, reflectionInstruction } from "../core/automation/policy.ts";
export { planCheckpointIndex } from "../core/automation/store.ts";
export { decideContinuation, describeContinuation } from "../core/automation/resume.ts";
export { persistCheckpoint, recordReflectionMark, storeSummaryBaseline, readSummaryBaseline } from "./automationRuntime.ts";

/** 本包注册的全部工具名（测试与文档共用一份清单）。 */
export const BIOS_TOOL_NAMES = ["bios_detect_project", ...biosReadOnlyTools.map((tool) => tool.name), ...biosWorkflowTools.map((tool) => tool.name)] as const;

/** 本包注册的全部人工命令名。 */
export const BIOS_COMMAND_NAMES = ["bios-task", "bios-context", "bios-workflow"] as const;

export default function registerBiosAgent(pi: ExtensionAPI): void {
	// 只读工具：线索检测 + 项目/任务/检索/需求/经验/上下文预览。
	pi.registerTool(biosDetectProjectTool);
	for (const tool of biosReadOnlyTools) pi.registerTool(tool);

	// 人工选择与开关（选择状态只保存知识 ID 与开关）。
	registerBiosCommands(pi);
	registerBiosWorkflow(pi);

	// 请求级受控上下文注入（默认关闭；端点策略仍由宿主配置决定）。
	registerContextInjection(pi);

	// AW：默认自主工作流（宿主许可开启时才生效；未开启等价于 0.9.1 行为）。
	registerBiosAutomation(pi);

	// 生命周期：新会话重建选择（并采纳适配层注入的初始选择）；关闭时清理（幂等）。
	// factory 本身只注册，不启动任何常驻资源。
	pi.on("session_start", async (_event, ctx) => {
		clearSelection();
		clearWorkflowPermission();
		resetAutomationSession();
		await adoptInitialSelection(ctx, (text) => pi.sendMessage({ customType: BIOS_RECEIPT_CUSTOM_TYPE, content: text, display: true, details: { kind: "initial-selection" } }));
	});
	pi.on("session_shutdown", () => {
		clearSelection();
		clearWorkflowPermission();
		resetAutomationSession();
	});
}
