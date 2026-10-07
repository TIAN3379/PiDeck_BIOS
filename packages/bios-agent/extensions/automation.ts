/**
 * AW：**Pi 生命周期协调层**（自动准备、自动检索、执行事实检查点、受控补记、状态投影）。
 *
 * 与既有模块的分工：
 * - `contextInjection.ts` 仍负责"用户显式打开"的项目上下文（`BIOS_CONTEXT_ENABLED`）；
 * - 本模块负责**默认自主**部分：打开工程后自动准备背景、工程问题前自动检索、把真实执行事实
 *   落成检查点、必要时请求一次受控补记。
 *
 * 硬边界（R1～R7 加固后的现状）：
 * - 只有一个模型循环（Pi）；补记只返回边界消息与 `continue`，不新建模型客户端、不追加业务 entries；
 * - **发送时重验授权**：注入前逐项比对准备快照（配置指纹/会话/目录/范围），任一变化即丢弃正文；
 * - 不修改别的扩展的 boundary entries；不把"工具成功"当根因正确；
 * - 任何失败只降级本次记忆能力，不阻塞普通编码。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { openProjectProfile } from "../core/projects/binding.ts";
import { renderReviewedLeads, renderWorkingLeads, searchReviewedKnowledge, searchWorkingMemory } from "../core/automation/working.ts";
import {
	classifyReflectionMark,
	classifyRequestIntent,
	confirmedCustomerOf,
	createRetrievalLedger,
	executedFact,
	hasUnsavedProgress,
	isSavedFact,
	looksLikeContinuation,
	projectSaveStatus,
	receiptTaskIdOf,
	reflectionInstruction,
	renderAwaitingCheckNote,
	resolveRetrievalPlan,
	saveStatusInputs,
	renderUnrecoveredNote,
	shouldPrepareBackground,
	shouldRequestReflection,
	unrecoveredReflections,
	type RequestIntent,
} from "../core/automation/policy.ts";
import { captureBaseline, scanProjectSummary, toSummaryBaseline } from "../core/automation/summary.ts";
import { decideContinuation, renderBackgroundTaskNote, renderContinuationContext, renderSelectedTaskContext, renderSelectionUnavailable, selectedTaskResumable, type ContinuationTask } from "../core/automation/resume.ts";
import type { ExecutedFact } from "../core/automation/contract.ts";
import { listRecords } from "../core/storage/records.ts";
import { readTaskDetail } from "../core/tasks/tasks.ts";
import { outboundPolicy } from "../core/context/policy.ts";
import { buildCallContext, type BiosCallContext, type BiosCallLike } from "./callContext.ts";
import { hostReadiness } from "./hostConfig.ts";
import { boundText, resolveModelBudget } from "./outbound.ts";
import { selectionFor } from "./selection.ts";
import { resolveWorkflowScope, WorkflowError, type WorkflowContext, type WorkflowScope } from "./workflowScope.ts";
import {
	alreadyRetrieved,
	automationActive,
	beginOriginalRequest,
	bindPersistedRequestEntry,
	bookkeepingAllowed,
	capabilityOf,
	clearPreparedContext,
	clearRequestFacts,
	consumeReflectionInstruction,
	currentAutomationBootId,
	currentPreparedContext,
	currentReflectionStage,
	durableMarkList,
	durableMarkOf,
	endReflectionStage,
	hydrateDurableMarks,
	injectionAllowed,
	noteDurableMark,
	markPending,
	markRetrieved,
	markedDurably,
	noteOutcome,
	noteBiosWriteReceipt,
	notePreparedContext,
	noteReflectionProviderRequest,
	noteRunProviderRequest,
	noteSessionIdentity,
	noteUnrecoveredLocally,
	recordFact,
	reflectionShortfallOf,
	reflectionStageActive,
	reflectionToolDecision,
	resetAutomationSession,
	revokeAutomation,
	settleReflectionStage,
	snapshotRun,
	startReflectionStage,
	takeFinishedStage,
} from "./automationState.ts";
import { commitUnrecoveredReceipt, persistCheckpoint, readReflectionMarks, readSummaryBaseline, recordAutomationReceipt, recordReflectionMark, storeSummaryBaseline } from "./automationRuntime.ts";

/** 本模块注入的上下文消息类型（与 `bios-context` 分开，便于结构化过滤）。 */
export const BIOS_AUTOMATION_CONTEXT_TYPE = "bios-automation-context";

/** 补记指令的消息类型（模型可见；消费一次后由 `context` 钩子撤下）。 */
export const BIOS_PENDING_REFLECTION_TYPE = "bios-pending-reflection";

/** 补记指令文本的首句标记：`before_agent_start` 据此认出"这是我们自己的补记阶段"。 */
export const BIOS_REFLECTION_MARKER = "[BIOS 自动化补记]";

/** 自动化上下文自身的分预算（整块 BIOS 上下文仍共享 12,000 字符 / 24 KiB 上限）。 */
const AUTOMATION_CONTEXT_BUDGET = { maxChars: 4000, maxBytes: 8000 };

/** 本会话待注入的自动化上下文块（每个请求重建，不累积旧摘要）。 */
let pendingBlocks: string[] = [];
/** 最近一次保存状态投影（供状态行使用，不铺内部参数）。 */
let lastSaveNote: string | null = null;
/** 本轮检查点的真实写入结果（R6：保存状态必须来自回执，不能靠推断）。 */
let lastCheckpointResult: "none" | "ok" | "failed" | "limited" = "none";
/** 本会话是否已经把磁盘上的耐久补记标记读进内存（只读一次）。 */
let marksHydrated = false;
/** D1：上一次 settle 发现的"未恢复补记"说明，注入到下一个请求的自动化上下文里（消费一次）。 */
let unrecoveredNotice: string | null = null;
/** C2：按 toolCallId 暂存工具参数，供 `tool_execution_end` 提取真实文件路径（有界）。 */
const toolArgs = new Map<string, unknown>();

function resetPending(): void {
	pendingBlocks = [];
	lastSaveNote = null;
	lastCheckpointResult = "none";
	marksHydrated = false;
	toolArgs.clear();
}

/** C3：把磁盘上的耐久标记读进内存（每个会话只读一次）。 */
async function hydrateMarks(scope: WorkflowScope, signal: AbortSignal | undefined): Promise<void> {
	if (marksHydrated) return;
	if (!bookkeepingAllowed(scope.call.config.automation)) return;
	marksHydrated = true;
	const marks = await readReflectionMarks({ root: scope.root, projectId: scope.projectId, workspaceId: scope.workspaceId, signal }).catch(() => []);
	hydrateDurableMarks(marks);
}

/**
 * 宽容地解析自动化范围。
 *
 * 与工作流工具不同：这里**不抛**——未就绪/未绑定/未授权时返回 null，自动化静默降级，
 * 普通 Agent 照常工作（AW §4：失败只能降级本次记忆能力）。
 */
async function resolveAutomationScope(ctx: WorkflowContext, signal?: AbortSignal): Promise<WorkflowScope | null> {
	try {
		return await resolveWorkflowScope(ctx, signal);
	} catch (error) {
		if (error instanceof WorkflowError) return null;
		if (error instanceof Error && error.name === "AbortError") return null;
		return null;
	}
}

function describeScopeForModel(projectId: string, workspaceId: string, cwd: string): string {
	return `当前工程：项目 ${projectId}｜工作区 ${workspaceId}｜目录 ${cwd}`;
}

/** 组装工程背景块（项目身份候选 + 摘要状态；不写 confirmed，也不伪造识别完成）。 */
async function prepareBackground(scope: WorkflowScope, signal: AbortSignal | undefined): Promise<string[]> {
	const blocks: string[] = [];
	const opened = await openProjectProfile({ root: scope.root, cwd: scope.cwd, authorizedRoots: scope.call.authorizedRoots, workspacePath: scope.cwd, biosProjectId: scope.projectId, signal });
	const candidateLines: string[] = [];
	for (const [field, entry] of Object.entries(opened.profile?.identity ?? {})) {
		if (entry.value === null || entry.value === "") continue;
		candidateLines.push(`${field}=${entry.value}（${entry.status === "confirmed" ? "已确认" : "候选，未确认"}）`);
	}
	blocks.push([describeScopeForModel(scope.projectId, scope.workspaceId, scope.cwd), candidateLines.length > 0 ? `身份字段：${candidateLines.slice(0, 12).join("；")}` : "身份字段：尚未识别出可用值（不猜 IBV/芯片/客户）"].join("\n"));

	// 摘要增量：分支/HEAD 与相关文件都没变才跳过；否则重扫并刷新候选。
	const previous = await readSummaryBaseline({ root: scope.root, projectId: scope.projectId, workspaceId: scope.workspaceId, signal });
	const scan = await scanProjectSummary({ workspacePath: scope.cwd, workspaceId: scope.workspaceId, cwd: scope.cwd, authorizedRoots: scope.call.authorizedRoots, previous, signal });
	if (scan.status === "unchanged") {
		// R7：unchanged 时把上一轮的**有界候选**一并复用，下一对话不需要重扫也有有证据背景。
		const reused = scan.reused;
		const lines = [`项目摘要：分支/HEAD 与相关文件均未变化（${scan.baseline.branch ?? "非 Git"}@${scan.baseline.commit?.slice(0, 12) ?? "-"}），未重新扫描。`];
		if (reused === null || reused.candidates.length === 0) lines.push("上一轮未记录可复用候选：本次跳过重扫，也不声称识别完成。");
		else {
			lines.push(
				`沿用上一轮构建入口候选：${reused.candidates
					.slice(0, 8)
					.map((candidate) => `${candidate.field}=${candidate.value}`)
					.join("；")}`,
			);
			if (reused.clues.length > 0)
				lines.push(
					`沿用上一轮平台弱线索：${reused.clues
						.slice(0, 6)
						.map((clue) => `${clue.field}≈${clue.value}（弱线索）`)
						.join("；")}`,
				);
		}
		if (reused !== null && reused.gaps.length > 0) lines.push(`仍存在的资料缺口：${reused.gaps.slice(0, 4).join("；")}`);
		blocks.push(lines.join("\n"));
	} else if (scan.status === "unreachable") {
		blocks.push(`项目摘要：本次不可用（${scan.reason ?? "工作区不可达"}），不声称识别完成。`);
	} else {
		const candidates = scan.candidates.slice(0, 8).map((candidate) => `${candidate.field}=${candidate.value}`);
		const clues = scan.clues.slice(0, 6).map((clue) => `${clue.field}≈${clue.value}（弱线索）`);
		blocks.push(
			[
				`项目摘要（${scan.status === "partial" ? "部分准备：命中预算" : "已准备"}）：基线 ${scan.baseline.branch ?? "非 Git"}@${scan.baseline.commit?.slice(0, 12) ?? "-"}`,
				candidates.length > 0 ? `构建入口候选：${candidates.join("；")}` : "构建入口候选：本次未解析到（不是确认结论）",
				clues.length > 0 ? `平台弱线索：${clues.join("；")}` : "平台弱线索：无（技术名匹配不等于已确认 IBV/芯片）",
			].join("\n"),
		);
		// R1：关闭本地普通记账时**不得**写摘要基线（只读准备不应产生落盘副作用）。
		if (bookkeepingAllowed(scope.call.config.automation)) {
			await storeSummaryBaseline({ root: scope.root, projectId: scope.projectId, workspaceId: scope.workspaceId, baseline: toSummaryBaseline({ baseline: scan.baseline, candidates: scan.candidates, truncated: scan.truncated, clues: scan.clues, gaps: scan.gaps }), signal });
		}
	}
	return blocks;
}

/**
 * §7.4 R4：读项目档案里**人工确认**过的目标客户（读不到/未确认 ⇒ null，按未授权处理）。
 *
 * 失败不阻塞检索：拿不到客户就按"客户未知"处理，不推导公开。
 */
async function confirmedCustomerOfScope(scope: WorkflowScope, signal: AbortSignal | undefined): Promise<string | null> {
	try {
		const opened = await openProjectProfile({ root: scope.root, cwd: scope.cwd, authorizedRoots: scope.call.authorizedRoots, workspacePath: scope.cwd, biosProjectId: scope.projectId, signal });
		return confirmedCustomerOf(opened.profile);
	} catch {
		return null;
	}
}

/**
 * 自动检索（R4）：**两个用途**都接入，且共享同一份预算。
 *
 * - 正式（已审核）经验：复用既有 `searchKnowledge`（授权/时态/复用范围/需求边界都在里面）；
 * - 本项目 working：只读本工作区 draft 与目标任务的执行事实，客户/需求范围先过滤。
 */
async function prepareRetrieval(scope: WorkflowScope, query: string, taskId: string | null, signal: AbortSignal | undefined): Promise<void> {
	const plan = resolveRetrievalPlan();
	// §9.4 R4：正式与 working 花**同一份**合并预算（旧实现各自截断 ⇒ 实际可取 2×maxLeads）。
	const ledger = createRetrievalLedger(plan);
	const authorizedProjectIds = scope.call.config.authorizedProjectIds;
	const endpointAllowed = outboundPolicy(scope.call.config.endpoint).allowCommercialBody;
	// §7.4 R4：客户级正式经验的可见性依赖"目标客户"。只取档案里**人工确认**过的客户
	// （候选/未识别一律 null ⇒ 按未授权处理），不拿厂商名/板名/需求文本猜客户。
	const reviewed = await searchReviewedKnowledge({
		root: scope.root,
		query,
		projectId: scope.projectId,
		workspaceId: scope.workspaceId,
		targetCustomerId: await confirmedCustomerOfScope(scope, signal),
		authorizedProjectIds,
		allowedFeatureIds: scope.call.config.allowedFeatureIds,
		approvedCustomers: scope.call.config.approvedCustomers,
		endpointAllowed,
		plan,
		ledger,
		signal,
	});
	pendingBlocks.push(renderReviewedLeads(reviewed));
	const working = await searchWorkingMemory({ root: scope.root, projectId: scope.projectId, workspaceId: scope.workspaceId, taskId, query, authorizedProjectIds, approvedCustomers: scope.call.config.approvedCustomers, allowedFeatureIds: scope.call.config.allowedFeatureIds, endpointAllowed, plan, ledger, signal });
	pendingBlocks.push(renderWorkingLeads(working));
	// 合并预算的**实际用量与截断量**如实进入上下文（不能被读成"没有历史经验"）。
	const budget = ledger.snapshot();
	if (budget.leadsTruncated > 0 || budget.detailReadsTruncated > 0 || budget.exhausted)
		pendingBlocks.push(`检索合并预算（正式 + working 共享）：取回 ${budget.leads}/${budget.maxLeads} 条、详情读取 ${budget.detailReads}/${budget.maxDetailReads} 次；因预算未取回 ${budget.leadsTruncated} 条。这里只说明"没轮到读"，不等于没有相关记录。`);
}

/**
 * D1（§11.3）/V1/V2（§13.2）：**有可信终止依据**的未终结补记必须给出明确回执，不能无声消失。
 *
 * V2 修正了旧论证：状态按工作区共享，"别的 settle 到来"**不能**证明那条请求已经中断——
 * 另一个会话可能仍在跑。当前可信依据是同一进程、同一会话已被新请求取代
 * （同一会话一次只处理一个请求）。不同启动 UUID 本身不能证明进程退出。
 * 所有者未知的旧记录与其它会话的 pending 一律保守按"待核对"处理，不判死。
 *
 * V1：回执与 `unrecoveredAt` 在**同一次 CAS** 内提交；只有耐久写入成功才同步内存"已通知"
 * （旧实现分两次写，出现过"回执没落盘、标记却全部落盘"，重启后用户再也看不到）。
 *
 * 不自动重放：`branch`/`createBranchedSession` 只改叶子指针，任何新的一轮都会追加**新的**用户 entry
 * （身份因此不同），扩展也没有公共入口去重放旧请求；自行续跑还会违反"取消后不得自动重发"的既有约束。
 *
 * @returns 给下一次请求注入的说明（无未恢复项时为 null）。
 */
async function reportUnrecoveredReflections(scope: WorkflowScope, signal: AbortSignal | undefined, settledRequestKey: string | null, currentRequestKey: string | null): Promise<string | null> {
	const context = { currentRequestKey, settledRequestKey, bootId: currentAutomationBootId(), sessionId: scope.call.sessionId };
	const items = unrecoveredReflections({ marks: durableMarkList(), ...context });
	// V3：没有可信终止依据的未终结项如实说明"待核对"，不混进"未恢复"。
	const awaiting = durableMarkList().filter((mark) => classifyReflectionMark(mark, context).state === "awaiting-check");
	if (items.length === 0) return awaiting.length === 0 ? null : renderAwaitingCheckNote(awaiting);
	const at = Date.now();
	const requestKeys = items.map((item) => item.requestKey);
	const committed = await commitUnrecoveredReceipt({
		root: scope.root,
		projectId: scope.projectId,
		workspaceId: scope.workspaceId,
		receipt: { kind: "reflection-unrecovered", recordedAt: at, detail: items.map((item) => `${item.requestKey.slice(0, 24)}（已开始 ${item.attempts} 次，${item.reason === "recovery-exhausted" ? "恢复次数用尽" : "缺少恢复路径"}）`).join("；") },
		requestKeys,
		terminationContext: context,
		at,
		signal,
	}).catch(() => ({ status: "failed" as const, detail: "写入异常", noted: [] as readonly string[] }));
	// V1：内存"已通知"只跟随**耐久成功**；写失败不得确认（否则重启后回执与标记都不在，等于静默丢失）。
	if (committed.status === "ok") noteUnrecoveredLocally(committed.noted, at);
	return renderUnrecoveredNote(committed.status === "ok" ? items.filter((item) => committed.noted.includes(item.requestKey)) : items);
}

/**
 * 续接（R5）：读**真实**任务进展并渲染。
 *
 * 返回本轮应关联到检查点的任务 ID（只有唯一可续接的未完成任务才会自动关联；
 * 多候选时返回 null，因为"还没确定要续接哪一个"）。
 */
async function prepareContinuation(scope: WorkflowScope, selectedTaskId: string | null, prompt: string, signal: AbortSignal | undefined): Promise<string | null> {
	const listed = await listRecords({ root: scope.root, kind: "task-record", projectId: scope.projectId, signal, limits: { maxListEntries: 40, maxScanEntries: 200 } });
	const tasks: ContinuationTask[] = [];
	// D3：**读取失败**不能静默跳过——跳过后剩下的候选会被当成"唯一可信对象"而错误续接。
	let unreadable = 0;
	for (const entry of listed.entries) {
		let detail: Awaited<ReturnType<typeof readTaskDetail>>;
		try {
			detail = await readTaskDetail({ root: scope.root, projectId: scope.projectId, taskId: entry.id, authorizedProjectIds: scope.call.config.authorizedProjectIds, cwd: scope.cwd, authorizedRoots: scope.call.authorizedRoots, signal });
		} catch {
			unreadable += 1;
			continue;
		}
		if (detail.status !== "ok" || !detail.task) {
			unreadable += 1;
			continue;
		}
		if (!detail.workspaceAuthorized || detail.task.workspace.workspaceId !== scope.workspaceId) continue;
		tasks.push({
			taskId: detail.task.id,
			revision: detail.task.revision,
			status: detail.task.status,
			requirement: detail.task.requirement.slice(0, 600),
			decisions: detail.task.decisions,
			todos: detail.task.todos,
			blockers: detail.task.blockers,
			relatedFiles: detail.task.relatedFiles,
			sourceExperienceIds: detail.task.sourceExperienceIds,
			validations: detail.task.validations.map((validation) => ({ kind: validation.kind, result: validation.result })),
		});
	}
	const incomplete = listed.truncated || listed.problems.length > 0 || unreadable > 0;
	// D3：**显式选中是第一判定**。旧实现先对所有候选做自动决策、之后才看显式选择，
	// 于是"选中 A、B 在进行中"会注入 B 的需求与"请从这里继续"（正文与关联身份都错位）。
	if (selectedTaskId !== null) {
		const selected = tasks.find((task) => task.taskId === selectedTaskId);
		if (selected === undefined) {
			pendingBlocks.push(renderSelectionUnavailable(selectedTaskId, incomplete));
			return null;
		}
		pendingBlocks.push(renderSelectedTaskContext(selected));
		// 关联身份：只有仍未完成的任务才关联检查点；done/archived 允许查看/讨论但不静默重开。
		return selectedTaskResumable(selected) ? selected.taskId : null;
	}
	const decision = decideContinuation({ tasks, incomplete });
	// C4：**背景参考**与**明确续接**分开。只有用户说"继续上次"时，
	// 才把旧任务进展当成"当前工作"注入并关联检查点；否则只列背景，不自动续接、不改当前任务。
	if (!looksLikeContinuation(prompt)) {
		pendingBlocks.push(renderBackgroundTaskNote(decision, tasks));
		return null;
	}
	pendingBlocks.push(renderContinuationContext(decision, tasks));
	if (decision.kind === "resume") return decision.taskId;
	return null;
}

/** 供 `context` 钩子读取：把自动化上下文渲染成有界文本。 */
export function renderAutomationContext(): string {
	if (pendingBlocks.length === 0 && lastSaveNote === null) return "";
	const parts = [...pendingBlocks];
	if (lastSaveNote !== null) parts.push(`保存状态：${lastSaveNote}`);
	return parts.join("\n\n");
}

export function clearAutomationPending(): void {
	resetPending();
}

/** 结构化判断：是否本模块注入的**上下文**消息（不用文本子串）。 */
export function isOwnAutomationMessage(message: unknown): boolean {
	if (message === null || typeof message !== "object") return false;
	const candidate = message as { readonly role?: unknown; readonly customType?: unknown };
	return candidate.role === "custom" && candidate.customType === BIOS_AUTOMATION_CONTEXT_TYPE;
}

/** 结构化判断：是否本模块的**补记指令**消息。 */
export function isReflectionInstructionMessage(message: unknown): boolean {
	if (message === null || typeof message !== "object") return false;
	const candidate = message as { readonly role?: unknown; readonly customType?: unknown };
	return candidate.role === "custom" && candidate.customType === BIOS_PENDING_REFLECTION_TYPE;
}

/**
 * R1：发送前的**授权复验**。
 *
 * 一致性必须按结构逐项比对，不能用字符串包含（Windows 路径转义会让 JSON 子串判断失效）。
 * 任一项不同 ⇒ 丢弃本次准备，不注入任何项目正文。
 */
async function verifyPreparedContext(snapshot: ReturnType<typeof currentPreparedContext>, ctx: WorkflowContext, call: BiosCallContext): Promise<{ readonly ok: boolean; readonly reason: string | null }> {
	if (snapshot === null) return { ok: false, reason: "没有可复验的准备快照" };
	const current = buildCallContext(ctx);
	if (current.configFingerprint !== snapshot.configFingerprint) return { ok: false, reason: "可信配置已变化" };
	if (current.sessionId !== snapshot.sessionId) return { ok: false, reason: "会话身份已变化" };
	if (current.cwd !== snapshot.cwd) return { ok: false, reason: "工作目录已变化" };
	if (hostReadiness(current.config).reason !== null) return { ok: false, reason: hostReadiness(current.config).reason ?? "宿主配置不可用" };
	if (!outboundPolicy(current.config.endpoint).allowCommercialBody) return { ok: false, reason: "当前端点策略不允许外发项目资料" };
	if (!current.config.authorizedProjectIds.includes(snapshot.projectId)) return { ok: false, reason: "项目授权已撤回" };
	if (call.signal?.aborted === true) return { ok: false, reason: "请求已取消" };
	// 真正重解析范围：绑定、档案版本、工作区可用性都要与准备时一致。
	const scope = await resolveAutomationScope(ctx, call.signal);
	if (scope === null) return { ok: false, reason: "项目绑定或授权不再可用" };
	if (scope.key !== snapshot.scopeKey) return { ok: false, reason: "项目绑定/档案/可信配置在准备之后发生变化" };
	return { ok: true, reason: null };
}

/**
 * C3：轮次身份。
 *
 * 补记 continuation 的 `turnIndex` 会**重新从 0 开始**，直接用 `turn-0` 会与原始阶段碰撞
 * （已发布的文件不替换，索引却按后来事实重算 ⇒ 索引与文件不一致）。
 * 这里把阶段 id 一起编进键：同一请求内原始阶段与补记阶段的每个 turn 都唯一。
 */
function roundTurnKey(base: string): string {
	const stage = currentReflectionStage();
	return stage === null ? base : `${stage.id}|${base}`;
}

/** 落盘本轮执行事实检查点；失败只更新状态，不抛穿到普通 Agent。 */
async function persistRunCheckpoint(ctx: WorkflowContext, signal: AbortSignal | undefined, turnKey: string, facts: readonly ExecutedFact[], taskId: string | null): Promise<void> {
	const scope = await resolveAutomationScope(ctx, signal);
	if (scope === null) return;
	const snapshot = snapshotRun();
	const requestKey = snapshot.requestKey;
	if (requestKey === null) return;
	turnKey = roundTurnKey(turnKey);
	const baseline = await captureBaseline({ workspacePath: scope.cwd, signal });
	// C4：任务关联优先用**本轮真实回执**得到的任务（中途新建/更新也能当轮回链）。
	const effectiveTaskId = snapshot.runTaskId ?? taskId;
	const task = effectiveTaskId === null ? null : await taskLinkOf(scope, effectiveTaskId, signal);
	const result = await persistCheckpoint({
		root: scope.root,
		projectId: scope.projectId,
		workspaceId: scope.workspaceId,
		sessionId: scope.call.sessionId,
		branch: baseline.branch,
		// 请求键本身已含自增序号，这里再带 turnKey，保证同一请求内每轮都可幂等恢复。
		requestKey: `${requestKey}:${turnKey}`,
		turnKey,
		baseline,
		facts,
		task,
		outcome: snapshot.outcome,
		pendingReflection: snapshot.pending,
		signal,
	});
	if (result.status === "failed") {
		lastCheckpointResult = "failed";
		lastSaveNote = "检查点保存失败：普通开发继续，可按提示重试";
	} else if (result.status === "full") {
		lastCheckpointResult = "limited";
		lastSaveNote = result.detail;
	} else {
		lastCheckpointResult = "ok";
	}
}

/** 读取任务链接的当前 revision（回链失败不影响检查点写入）。 */
async function taskLinkOf(scope: WorkflowScope, taskId: string, signal: AbortSignal | undefined): Promise<{ readonly taskId: string; readonly revision: number } | null> {
	try {
		const detail = await readTaskDetail({ root: scope.root, projectId: scope.projectId, taskId, authorizedProjectIds: scope.call.config.authorizedProjectIds, cwd: scope.cwd, authorizedRoots: scope.call.authorizedRoots, signal });
		if (detail.status !== "ok" || detail.task === null || detail.revision === null) return null;
		return { taskId: detail.task.id, revision: detail.revision };
	} catch {
		return null;
	}
}

/**
 * C3：耐久完成回执。
 *
 * `saved:true` 才表示"这个请求的补记真的写完了"；未完成时记录 `attempts`，
 * 使恢复**有界**（最多再试一次），而不是把 `saved:false` 当成已处理。
 */
async function writeDurableMark(scope: WorkflowScope, signal: AbortSignal | undefined, stage: ReturnType<typeof takeFinishedStage>, finished: boolean): Promise<void> {
	const requestKey = stage?.requestKey;
	if (requestKey == null) return;
	if (!bookkeepingAllowed(scope.call.config.automation)) return;
	// D1：终结回执。`attempts` 保持"已开始过几次阶段"（阶段开始时已记），
	// `finished:true` 才是"这个请求的补记已经收口"（成功或明确失败），此后不再恢复。
	const attempts = Math.max(durableMarkOf(requestKey)?.attempts ?? 0, 1);
	const saved = stage?.saved === true;
	noteDurableMark(requestKey, saved, attempts, finished);
	// V2：所有者身份随标记落盘——它决定"这条未终结标记能否被别的会话判成未恢复"。
	await recordReflectionMark({ root: scope.root, projectId: scope.projectId, workspaceId: scope.workspaceId, requestKey, runId: stage?.id ?? requestKey, saved, attempts, finished, ownerBootId: currentAutomationBootId(), ownerSessionId: scope.call.sessionId, signal }).catch(() => undefined);
}

/**
 * D1：开启补记阶段（阶段尝试与恢复尝试分开计数）。
 *
 * `attempts` 记录"这个请求已经**开始**过几次补记阶段"：第一次开始写 `attempts=1, finished=false`；
 * 中断后重启再开一次就是恢复（`attempts=2`），那也是最后一次（上限见
 * `AUTOMATION_LIMITS.maxReflectionRecoveryAttempts`）。`finished` 只在拿到终结回执时置 true。
 */
async function beginReflectionStageMark(scope: WorkflowScope, signal: AbortSignal | undefined, requestKey: string, runId: string): Promise<void> {
	const attempts = (durableMarkOf(requestKey)?.attempts ?? 0) + 1;
	noteDurableMark(requestKey, false, attempts, false);
	await recordReflectionMark({ root: scope.root, projectId: scope.projectId, workspaceId: scope.workspaceId, requestKey, runId, saved: false, attempts, finished: false, ownerBootId: currentAutomationBootId(), ownerSessionId: scope.call.sessionId, signal }).catch(() => undefined);
}

/** 自动化指导文本（追加到既有 systemPrompt；不替换 `workflow.ts` 的内容）。 */
function automationGuidance(): string {
	return [
		"\nBIOS 默认自主工作流（宿主已授权时生效）：",
		"- 普通开发不需要用户说“建任务/记住/保存/查经验”：工程请求前扩展已准备背景与本项目线索，请直接调查。",
		"- 有意义进度用 bios_manage_task 保存，经验用 bios_save_experience_draft（永远 draft，不自动审核）。",
		"- 本项目未验证线索只作假设，不能当作已审核结论、客户要求或测试通过依据。",
		"- 用户说“先不要改代码”时只做只读调查；自动记忆许可不授予额外源码修改权限。",
		"- 不要要求用户填写 ID/JSON；续接有歧义时用自然语言问一句。",
	].join("\n");
}

/** 装配：注册全部自动化生命周期钩子（factory 里不启动任何常驻资源）。 */
export function registerBiosAutomation(pi: ExtensionAPI): void {
	pi.on("session_start", () => {
		resetAutomationSession();
		resetPending();
		// D1：换会话不把上一个会话留下的"未恢复"说明带进来（磁盘上的证据仍然保留）。
		unrecoveredNotice = null;
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const call = buildCallContext(ctx as unknown as BiosCallLike);
		const capability = capabilityOf(call.config);
		if (!automationActive(capability) || hostReadiness(call.config).reason !== null) return undefined;
		// C1：补记阶段用**结构状态**识别，不靠"prompt 里出现内部 marker"（用户输入里恰好有该字样就会误判）。
		const isReflection = reflectionStageActive();
		const scope = await resolveAutomationScope(ctx as unknown as WorkflowContext, call.signal);
		// 身份先记录、请求键后派生：反序会让身份重置把刚写下的请求键清成 null（R3）。
		if (scope !== null) {
			noteSessionIdentity({ sessionId: call.sessionId, scopeKey: scope.key, projectId: scope.projectId, workspaceId: scope.workspaceId, cwd: scope.cwd });
		}
		// 内部补记阶段：不派生新请求键、不做意图分类/自动检索、**不重置预算**（否则硬上限失效）。
		if (isReflection) return { systemPrompt: event.systemPrompt + automationGuidance() };
		// C1/D1：新原始请求 ⇒ 新请求键 + **独立预算**（旧实现按整场会话累计，第二三轮不再补记）。
		// 身份最终带上真实用户 entry：重启后自增序号会重来，不能拿进程序号当持久身份。
		// Pi 此时尚未持久化新 user entry：临时键只用于准备，首个 context 再绑定真实 entry。
		const requestKey = beginOriginalRequest(call.sessionId, call.cwd, event.prompt.slice(0, 64));
		if (scope === null) {
			notePreparedContext({ requestKey, scopeKey: "", configFingerprint: call.configFingerprint, sessionId: call.sessionId, cwd: call.cwd, projectId: "", workspaceId: "", taskId: null, preparedAt: Date.now(), carriesProjectData: false });
			return { systemPrompt: event.systemPrompt + automationGuidance() };
		}
		await hydrateMarks(scope, call.signal);
		const selection = selectionFor(call.sessionId, call.configFingerprint).selection;
		const selectedTaskId = selection.projectId === scope.projectId ? selection.taskId : null;
		const intent: RequestIntent = classifyRequestIntent(event.prompt).intent;
		const willPrepare = shouldPrepareBackground(intent);
		notePreparedContext({ requestKey, scopeKey: scope.key, configFingerprint: call.configFingerprint, sessionId: call.sessionId, cwd: call.cwd, projectId: scope.projectId, workspaceId: scope.workspaceId, taskId: selectedTaskId, preparedAt: Date.now(), carriesProjectData: willPrepare });
		resetPending();
		// D1：把"未恢复补记"如实带进本次上下文（一次），避免模型误以为那些事实已经补记完成。
		if (unrecoveredNotice !== null) {
			pendingBlocks.push(unrecoveredNotice);
			unrecoveredNotice = null;
		}
		if (willPrepare) {
			try {
				pendingBlocks.push(...(await prepareBackground(scope, call.signal)));
				const linkedTaskId = await prepareContinuation(scope, selectedTaskId, event.prompt, call.signal);
				const snapshot = currentPreparedContext();
				if (snapshot !== null) notePreparedContext({ ...snapshot, taskId: linkedTaskId ?? selectedTaskId });
				if (!alreadyRetrieved(requestKey)) {
					await prepareRetrieval(scope, event.prompt, linkedTaskId ?? selectedTaskId, call.signal);
					markRetrieved(requestKey);
				}
			} catch (error) {
				// 准备失败只降级本次背景，不阻塞请求。
				pendingBlocks.push(`背景准备未完成（${error instanceof Error ? error.name : "error"}）：本次不注入额外资料，普通调查继续。`);
			}
		}
		return { systemPrompt: event.systemPrompt + automationGuidance() };
	});

	/**
	 * 注入自动化上下文（独立消息类型；与 `bios-context` 不互相覆盖）。
	 *
	 * R1/R3 的三个关键点：
	 * 1. 每次都**重新核验**准备快照（配置指纹/会话/目录/范围/端点/授权），失效即丢弃并说明；
	 * 2. 历史上注入过的自动上下文一律结构化剥离（撤权后不残留）；
	 * 3. 补记指令只保留到被消费一次，之后撤下（避免永久污染上下文）。
	 */
	pi.on("context", async (event, ctx) => {
		const call = buildCallContext(ctx as unknown as BiosCallLike);
		const capability = capabilityOf(call.config);
		bindPersistedRequestEntry(call.sessionId, call.cwd, call.userEntryId);
		// C2：每次真实 provider 请求都计数（补记阶段计入阶段预算，原始调查计入请求预算总账）。
		if (reflectionStageActive()) noteReflectionProviderRequest();
		else noteRunProviderRequest();
		const stage = currentReflectionStage();
		const keepInstruction = stage?.instructionPending === true;
		const kept: Array<(typeof event.messages)[number]> = [];
		let removed = false;
		for (const message of event.messages) {
			if (isOwnAutomationMessage(message)) {
				removed = true;
				continue;
			}
			if (isReflectionInstructionMessage(message)) {
				if (keepInstruction) kept.push(message);
				else removed = true;
				continue;
			}
			kept.push(message);
		}
		if (keepInstruction) consumeReflectionInstruction();
		const passThrough = () => (removed ? { messages: kept } : undefined);
		if (!injectionAllowed(capability)) return passThrough();
		// 用户显式打开了 `bios-context` 时由既有模块负责大块正文，这里不再叠加第二份（共享总预算）。
		if (selectionFor(call.sessionId, call.configFingerprint).selection.contextEnabled) return passThrough();
		const text = renderAutomationContext();
		if (text === "") return passThrough();
		const snapshot = currentPreparedContext();
		const verdict = await verifyPreparedContext(snapshot, ctx as unknown as WorkflowContext, call);
		if (!verdict.ok) {
			clearPreparedContext();
			resetPending();
			const notice = `[BIOS 自动上下文已撤回] ${verdict.reason ?? "准备结果已失效"}：本次不注入任何项目资料。`;
			const boundedNotice = boundText(notice, resolveModelBudget(AUTOMATION_CONTEXT_BUDGET));
			return { messages: [{ role: "custom", customType: BIOS_AUTOMATION_CONTEXT_TYPE, content: [{ type: "text", text: boundedNotice.text }], display: false, details: { kind: "automation-context", retracted: true, reason: verdict.reason }, timestamp: Date.now() }, ...kept] as typeof event.messages };
		}
		const bounded = boundText(text, resolveModelBudget(AUTOMATION_CONTEXT_BUDGET));
		const message = { role: "custom", customType: BIOS_AUTOMATION_CONTEXT_TYPE, content: [{ type: "text", text: bounded.text }], display: false, details: { kind: "automation-context", truncated: bounded.truncated, usedChars: bounded.usedChars }, timestamp: Date.now() };
		return { messages: [message, ...kept] as typeof event.messages };
	});

	/** C2：暂存工具参数（`tool_execution_end` 没有 args，而真实文件路径只能来自参数）。 */
	pi.on("tool_execution_start", (event) => {
		if (toolArgs.size >= 64) toolArgs.clear();
		toolArgs.set(event.toolCallId, event.args);
	});

	/**
	 * C2：补记阶段的**工具硬权限**（在工具真正执行之前生效）。
	 *
	 * 三件事一次做完：
	 * 1. provider 请求预算用尽 ⇒ 拒绝整批工具并要求提前结束（这是"下一次 provider 请求前"的硬闸门，
	 *    旧实现只在 `agent_before_settle` 事后检查，模型可以连续工具循环刷到 6 次）；
	 * 2. 拒绝命令执行工具（防止用 shell 绕过只读限制）；
	 * 3. 拒绝源码写入工具；其余非白名单工具一律拒绝。
	 */
	pi.on("tool_call", (event) => {
		const decision = reflectionToolDecision(event.toolName);
		if (!decision.blocked) return undefined;
		return { block: true, reason: decision.reason ?? "补记阶段不允许该工具。", terminate: decision.terminate };
	});

	/** 真实工具事实：只记录受支持工具的真实结果，不按结束时间推导因果。 */
	pi.on("tool_execution_end", (event, ctx) => {
		if (!automationActive(capabilityOf(buildCallContext(ctx as unknown as BiosCallLike).config))) return;
		const args = toolArgs.get(event.toolCallId);
		toolArgs.delete(event.toolCallId);
		const details = (event.result as { readonly details?: { readonly status?: unknown; readonly link?: { readonly status?: unknown }; readonly taskId?: unknown } } | undefined)?.details;
		const businessStatus = typeof details?.status === "string" ? details.status : null;
		const linkFailed = details?.link !== undefined && details.link.status === "link-failed";
		// C4：任务的关联只认真实回执（`details.taskId` 优先，否则解析回执正文），不相信模型自报成功。
		const contentTaskId = receiptTaskIdOf((event.result as { readonly content?: unknown } | undefined)?.content);
		const receiptTaskId = typeof details?.taskId === "string" && details.taskId !== "" ? details.taskId : contentTaskId;
		const fact = executedFact({ tool: event.toolName, outcome: event.isError ? "error" : "ok", args, businessStatus, linkFailed });
		recordFact({ ...fact, callId: event.toolCallId });
		if (event.toolName === "bios_manage_task" || event.toolName === "bios_save_experience_draft") {
			// C3：只有**真实落盘**的业务状态才算"已保存"；declined/stale 等结构化失败不算。
			noteBiosWriteReceipt({ saved: isSavedFact(fact), taskId: receiptTaskId });
		}
	});

	pi.on("turn_end", async (event, ctx) => {
		const call = buildCallContext(ctx as unknown as BiosCallLike);
		const capability = capabilityOf(call.config);
		if (!automationActive(capability)) return undefined;
		// 结局映射：aborted → interrupted（不写成"完成"）；error 如实保留。
		noteOutcome(event.outcome === "completed" ? "in-progress" : event.outcome === "aborted" ? "interrupted" : "error");
		const facts = snapshotRun().facts;
		markPending(hasUnsavedProgress(facts));
		// 没有真实工具事实时不落盘：避免产出一堆空检查点噪声（与 `agent_settled` 同一判据）。
		if (bookkeepingAllowed(capability) && facts.length > 0) await persistRunCheckpoint(ctx as unknown as WorkflowContext, call.signal, `turn-${event.turnIndex}`, facts, currentPreparedContext()?.taskId ?? null);
		return undefined;
	});

	/**
	 * 最终可操作边界：只在"有未保存进展 + 本轮正常完成 + 仍在预算内"时请求一次受控补记。
	 *
	 * R3：补记指令必须是**模型可见**的边界消息（`custom_message`），并且阶段一旦开启就按
	 * provider/写入预算硬停止，不无限续跑。
	 */
	pi.on("agent_before_settle", async (event, ctx) => {
		const call = buildCallContext(ctx as unknown as BiosCallLike);
		const capability = capabilityOf(call.config);
		if (reflectionStageActive()) {
			// 补记阶段内的下一次 settle：只终结阶段（不再开第二个），硬上限由 `tool_call` 在请求前拦住。
			settleReflectionStage();
			return undefined;
		}
		if (!automationActive(capability) || !bookkeepingAllowed(capability)) return undefined;
		const scope = await resolveAutomationScope(ctx as unknown as WorkflowContext, call.signal);
		if (scope === null) return undefined;
		await hydrateMarks(scope, call.signal);
		const snapshot = snapshotRun();
		const requestKey = snapshot.requestKey;
		const prepared = currentPreparedContext();
		if (requestKey === null || prepared === null) return undefined;
		// 范围必须与**准备时**逐字一致（结构化比较，不做字符串包含）。
		const scopeStable = prepared.scopeKey === scope.key;
		const decision = shouldRequestReflection({
			// C1：**阶段数**按当前原始请求算（每个请求各一份），而 provider/写入上限属于**补记阶段**：
			// 原始调查自己的 2 次请求不能把补记阶段的预算提前用掉（旧实现的预算口径就错在这里）。
			budget: { requestKey: snapshot.budget.requestKey, stagesRequested: snapshot.budget.stagesRequested, providerRequests: 0, writeCalls: 0 },
			pending: snapshot.pending,
			aborted: call.signal?.aborted === true,
			scopeStable,
			alreadyMarked: markedDurably(requestKey),
			outcome: event.outcome === "aborted" ? "aborted" : event.outcome === "error" ? "error" : "completed",
		});
		if (!decision.request) return undefined;
		if (!startReflectionStage()) return undefined;
		// R3/C3/D1：耐久"待补记"标记（`saved=false, finished=false`）：这是阶段**开始**，
		// 还不是完成回执；若此刻中断，重启后允许**一次**有界恢复（由 attempts 计数限制）。
		await beginReflectionStageMark(scope, call.signal, requestKey, `${requestKey}#1`);
		// 模型可见的补记指令（`custom_message` 会被转换成真实的 user 消息，并由 `context` 消费一次后撤下）。
		return { entries: [{ type: "custom_message" as const, customType: BIOS_PENDING_REFLECTION_TYPE, content: [{ type: "text" as const, text: reflectionInstruction() }], display: false }], continue: true };
	});

	pi.on("agent_settled", async (_event, ctx) => {
		const call = buildCallContext(ctx as unknown as BiosCallLike);
		const capability = capabilityOf(call.config);
		if (!automationActive(capability)) return;
		const snapshot = snapshotRun();
		const facts = snapshot.facts;
		if (bookkeepingAllowed(capability) && facts.length > 0) {
			await persistRunCheckpoint(ctx as unknown as WorkflowContext, call.signal, "settle", facts, currentPreparedContext()?.taskId ?? null);
		}
		// R6：保存状态按真实回执投影（业务状态 + 回链 + 本轮检查点写入结果 + 待补记 + 预算受限）。
		const shortfall = reflectionShortfallOf();
		const status = projectSaveStatus(saveStatusInputs({ automationEnabled: true, facts, checkpoint: lastCheckpointResult, pendingReflection: snapshot.pending, shortfall }));
		lastSaveNote = status.note;
		// C3：完成回执以**真实写入结果**为准（阶段里的 saved 只由业务成功回执置位）。
		const finished = endReflectionStage();
		const settledStage = finished === null ? null : takeFinishedStage();
		if (finished !== null) {
			const scope = await resolveAutomationScope(ctx as unknown as WorkflowContext, call.signal);
			if (scope !== null) {
				// agent_settled 本身没有 outcome；使用 turn_end 的真实结局。
				// 普通取消/错误保留未终结标记；明确的预算拒绝则终结，不借恢复突破硬限额。
				await writeDurableMark(scope, call.signal, settledStage, shortfall !== null || (snapshot.outcome === "in-progress" && call.signal?.aborted !== true));
				// D2：部分成功/受限必须**耐久化**，宿主默认面板据真实回执显示，而不是只看扩展的私有变量。
				if (shortfall !== null && status.status === "partial") {
					await recordAutomationReceipt({ root: scope.root, projectId: scope.projectId, workspaceId: scope.workspaceId, receipt: { kind: "reflection-partial", recordedAt: Date.now(), detail: status.note }, signal: call.signal }).catch(() => undefined);
				}
			}
		}
		// D1：`settledStage` 之外仍有未终结标记 ⇒ 它的 settle 边界早已过去（进程中断），没有恢复路径。
		if (bookkeepingAllowed(capability)) {
			const scope = await resolveAutomationScope(ctx as unknown as WorkflowContext, call.signal);
			if (scope !== null) unrecoveredNotice = await reportUnrecoveredReflections(scope, call.signal, settledStage?.requestKey ?? null, snapshot.requestKey);
		}
		clearRequestFacts();
	});

	pi.on("session_shutdown", () => {
		resetAutomationSession();
		resetPending();
		unrecoveredNotice = null;
	});
}

/** 供 `/bios-workflow off` 使用：撤回本会话自动化许可（不删磁盘记录）。 */
export function stopBiosAutomation(): void {
	revokeAutomation();
	resetPending();
	clearPreparedContext();
	endReflectionStage();
}
