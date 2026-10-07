/**
 * AW-06：**新对话"继续"的纯决策**（不猜最后修改的任务）。
 *
 * 与"恢复背景"分开：本模块只回答"要不要自动续接哪个任务"，不负责组装上下文。
 * 规则表见 AW §8；本模块是纯函数，任务数据由调用方按当前工作区读取。
 */
import type { TaskStatus } from "../contracts/common.ts";

/**
 * 决策所需的**真实**任务视图。
 *
 * R5：除了身份与状态，还必须带上真实进展（决策/待办/阻塞/验证/经验引用），
 * 否则"新对话续接"只剩一句"检测到任务"，模型拿不到上次做到哪里。
 */
export type ContinuationTask = {
	readonly taskId: string;
	readonly revision: number;
	readonly status: TaskStatus;
	readonly requirement: string;
	/** 已记录的决定（按记录顺序，调用方自行做有界截断）。 */
	readonly decisions?: readonly string[];
	readonly todos?: readonly string[];
	readonly blockers?: readonly string[];
	readonly relatedFiles?: readonly string[];
	/** 本任务引用过的经验 ID（正文按权限另行读取）。 */
	readonly sourceExperienceIds?: readonly string[];
	/** 已声明的验证（只按声明报告，不做升级）。 */
	readonly validations?: readonly { readonly kind: string; readonly result: string }[];
};

export type ContinuationDecision =
	/** 唯一相关 in_progress 任务：直接恢复（不要求用户选 ID）。 */
	| { readonly kind: "resume"; readonly taskId: string; readonly revision: number; readonly reason: string }
	/** 没有 in_progress、仅一个 planned：简短询问是否继续这个计划。 */
	| { readonly kind: "ask-planned"; readonly taskId: string; readonly revision: number; readonly reason: string }
	/** 多个候选或语义不确定：在对话中给名称/问题摘要供选择。 */
	| { readonly kind: "choose"; readonly candidates: readonly ContinuationTask[]; readonly reason: string }
	/** 只有 done/archived：仅作历史参考，重开需逐次确认。 */
	| { readonly kind: "history"; readonly candidates: readonly ContinuationTask[]; readonly reason: string }
	| { readonly kind: "none"; readonly reason: string }
	/** 列表不完整（预算/不可读）：不猜，先让用户确认。 */
	| { readonly kind: "incomplete"; readonly reason: string };

const ACTIVE: readonly TaskStatus[] = ["in_progress", "blocked"];

/**
 * 依据当前工作区的任务决定续接行为。
 *
 * `completedCandidates` 为 done/archived 的任务：只作历史参考，不再自动续跑。
 */
export function decideContinuation(input: { readonly tasks: readonly ContinuationTask[]; readonly incomplete: boolean }): ContinuationDecision {
	if (input.incomplete) return { kind: "incomplete", reason: "任务列表读取不完整（预算或不可读记录）：不猜续接对象" };
	const active = input.tasks.filter((task) => ACTIVE.includes(task.status));
	const planned = input.tasks.filter((task) => task.status === "planned");
	const history = input.tasks.filter((task) => task.status === "done" || task.status === "archived");
	if (active.length === 1) {
		const task = active[0]!;
		// blocked 也视为"未完成工作"，但恢复时必须说明当前阻塞，不宣称已在执行。
		return { kind: "resume", taskId: task.taskId, revision: task.revision, reason: task.status === "blocked" ? "唯一未完成任务（当前 blocked）：恢复记录并说明阻塞" : "唯一进行中任务：恢复记录与基线" };
	}
	if (active.length > 1) return { kind: "choose", candidates: active, reason: "存在多个未完成任务：由用户在对话中选择，不猜最后修改的任务" };
	if (planned.length === 1) return { kind: "ask-planned", taskId: planned[0]!.taskId, revision: planned[0]!.revision, reason: "没有进行中任务，仅有一个计划任务：询问是否继续该计划" };
	if (planned.length > 1) return { kind: "choose", candidates: planned, reason: "有多个计划任务：由用户选择" };
	if (history.length > 0) return { kind: "history", candidates: history, reason: "只有已完成/已归档任务：仅作历史参考，重开需逐次确认" };
	return { kind: "none", reason: "当前工作区没有可续接的任务" };
}

/** 渲染一句可读的状态说明（不含内部 ID 作为前置要求）。 */
export function describeContinuation(decision: ContinuationDecision): string {
	switch (decision.kind) {
		case "resume":
			return `检测到唯一未完成任务，已重读其记录与基线（${decision.reason}）。`;
		case "ask-planned":
			return "没有进行中的任务，只有一个计划任务：需要你确认是否继续。";
		case "choose":
			return `有 ${decision.candidates.length} 个候选任务，需要你确认要续接哪一个。`;
		case "history":
			return "只有已完成/已归档的任务，仅作历史参考。";
		case "incomplete":
			return "任务列表读取不完整，暂不自动续接。";
		default:
			return "当前工作区没有可续接的任务。";
	}
}

/** R5：注入时的有界截断（字符预算由上层 `boundText` 再兜一次）。 */
const MAX_ITEMS = 6;
const MAX_ITEM_CHARS = 200;

function bullet(label: string, items: readonly string[] | undefined): string | null {
	if (items === undefined || items.length === 0) return null;
	const shown = items.slice(-MAX_ITEMS).map((item) => item.replace(/\s+/g, " ").trim().slice(0, MAX_ITEM_CHARS));
	const more = items.length > shown.length ? `（另有 ${items.length - shown.length} 条较早记录未列出）` : "";
	return `${label}：${shown.join("；")}${more}`;
}

/** 一个候选任务的可读摘要：有真实需求与状态，不是只有编号。 */
export function describeTask(task: ContinuationTask): string {
	const parts = [`${task.requirement.replace(/\s+/g, " ").trim().slice(0, MAX_ITEM_CHARS)}（状态 ${task.status}`];
	if (task.blockers !== undefined && task.blockers.length > 0) parts.push(`，阻塞 ${task.blockers.length} 项`);
	if (task.todos !== undefined && task.todos.length > 0) parts.push(`，待办 ${task.todos.length} 项`);
	parts.push("）");
	return parts.join("");
}

/**
 * R5：把续接决策渲染成**带真实进展**的上下文块。
 *
 * 只有 `resume` 会给出完整进展（唯一未完成任务 ⇒ 有明确续接对象）；
 * `choose`/`history` 只列可辨别的候选（名称/需求摘要 + 状态），让模型用自然语言问一句。
 */
export function renderContinuationContext(decision: ContinuationDecision, tasks: readonly ContinuationTask[]): string {
	const byId = new Map(tasks.map((task) => [task.taskId, task]));
	if (decision.kind === "resume") {
		const task = byId.get(decision.taskId);
		if (task === undefined) return `任务续接：${describeContinuation(decision)}`;
		const lines = [`任务续接：本工作区唯一未完成任务，已按授权重读其记录（状态 ${task.status}，revision ${task.revision}）。`, `原需求：${task.requirement.replace(/\s+/g, " ").trim().slice(0, 600)}`];
		for (const [label, items] of [
			["已记录决定", task.decisions],
			["待办", task.todos],
			["阻塞", task.blockers],
			["相关文件", task.relatedFiles],
		] as const) {
			const line = bullet(label, items);
			if (line !== null) lines.push(line);
		}
		if (task.sourceExperienceIds !== undefined && task.sourceExperienceIds.length > 0) lines.push(`引用经验：${task.sourceExperienceIds.slice(0, MAX_ITEMS).join("、")}（正文按授权另行读取）`);
		if (task.validations !== undefined && task.validations.length > 0)
			lines.push(
				`已声明验证：${task.validations
					.slice(-MAX_ITEMS)
					.map((entry) => `${entry.kind}=${entry.result}`)
					.join("；")}（只是声明，不升级为已通过）`,
			);
		lines.push("请从这里继续，不要重复已经完成的步骤；若上述记录与当前代码不符，先核对再继续。");
		return lines.join("\n");
	}
	if (decision.kind === "choose") {
		const lines = decision.candidates.slice(0, 5).map((candidate, index) => `${index + 1}. ${describeTask(candidate)}`);
		return [`任务续接：有 ${decision.candidates.length} 个未完成任务，需要用户确认继续哪一个（用自然语言问，不要要求用户填 ID）：`, ...lines].join("\n");
	}
	if (decision.kind === "history") {
		const lines = decision.candidates.slice(0, 5).map((candidate, index) => `${index + 1}. ${describeTask(candidate)}`);
		return [`任务续接：只有已完成/已归档任务（仅作历史参考，重开需逐次确认）：`, ...lines].join("\n");
	}
	if (decision.kind === "ask-planned") {
		const task = byId.get(decision.taskId);
		const name = task === undefined ? "" : `「${describeTask(task)}」`;
		return `任务续接：没有进行中的任务，只有一个计划任务${name}：请询问用户是否继续该计划。`;
	}
	return `任务续接：${describeContinuation(decision)}`;
}

/**
 * D3：这个**显式选中**的任务是否允许"从这里继续"（并关联检查点）。
 *
 * 只有仍未完成（in_progress/blocked）的任务才是"接着做"的对象；
 * done/archived 只能查看与讨论，planned 需要用户先确认开始。
 */
export function selectedTaskResumable(task: ContinuationTask): boolean {
	return ACTIVE.includes(task.status);
}

/** 渲染一个选中任务的**真实进展**（不含"请从这里继续"；由调用方按状态决定是否追加该句）。 */
function renderTaskDetail(task: ContinuationTask): string[] {
	const lines = [`原需求：${task.requirement.replace(/\s+/g, " ").trim().slice(0, 600)}`, `状态：${task.status}（revision ${task.revision}）`];
	for (const [label, items] of [
		["已记录决定", task.decisions],
		["待办", task.todos],
		["阻塞", task.blockers],
		["相关文件", task.relatedFiles],
	] as const) {
		const line = bullet(label, items);
		if (line !== null) lines.push(line);
	}
	if (task.sourceExperienceIds !== undefined && task.sourceExperienceIds.length > 0) lines.push(`引用经验：${task.sourceExperienceIds.slice(0, MAX_ITEMS).join("、")}（正文按授权另行读取）`);
	if (task.validations !== undefined && task.validations.length > 0)
		lines.push(
			`已声明验证：${task.validations
				.slice(-MAX_ITEMS)
				.map((entry) => `${entry.kind}=${entry.result}`)
				.join("；")}（只是声明，不升级为已通过）`,
		);
	return lines;
}

/**
 * D3：**显式选中任务**的上下文块。
 *
 * 旧实现先对所有候选做自动决策、之后才看显式选择，于是"选中 A（已完成）、B 在进行中"时
 * 注入的是 **B** 的需求与"请从这里继续"——正文与关联身份双双错位。
 * 现在显式选择是**第一判定**：正文与关联身份都来自选中的那一个任务。
 */
export function renderSelectedTaskContext(task: ContinuationTask): string {
	if (selectedTaskResumable(task)) {
		return [`任务续接：这是用户**明确选中**的任务，已按授权重读其记录与基线。`, ...renderTaskDetail(task), "请从这里继续，不要重复已经完成的步骤；若上述记录与当前代码不符，先核对再继续。"].join("\n");
	}
	if (task.status === "planned") {
		return [`任务续接：用户选中的任务仍是**计划**状态（未开始）：只提供其记录作参考。`, ...renderTaskDetail(task), "请先询问用户是否要开始这个计划，不要自动续接或改写其它任务。"].join("\n");
	}
	return [`任务续接：用户选中的任务已**完成/归档**：以下记录用于查看与讨论。`, ...renderTaskDetail(task), "不要静默重开这个任务，也不要把它替换成另一个未完成任务来续接。"].join("\n");
}

/**
 * D3：显式选中但**读不到**该任务时的如实说明。
 *
 * 不能默默跳过后把别的候选当成"唯一可信对象"（那会让用户以为在继续选中的任务）。
 */
export function renderSelectionUnavailable(selectedTaskId: string, incomplete: boolean): string {
	return [`任务续接：你选中的任务（${selectedTaskId.slice(0, 40)}）本次**读不到**${incomplete ? "（任务列表读取不完整或记录不可读）" : "（可能已撤权/被删除）"}。`, "本次不自动换成其它候选任务，也不指向任何“唯一可信”的续接对象；请确认后再继续。"].join("\n");
}

/**
 * C4：**背景参考**（不改当前工作）的任务说明。
 *
 * 用户没有说"继续上次"，也没有显式选中任务时，旧任务只能作为背景列出，
 * 不得注入"请从这里继续"，也不得自动把它当成当前工作。
 */
export function renderBackgroundTaskNote(decision: ContinuationDecision, tasks: readonly ContinuationTask[]): string {
	const byId = new Map(tasks.map((task) => [task.taskId, task]));
	if (decision.kind === "resume") {
		const task = byId.get(decision.taskId);
		const name = task === undefined ? "" : `「${describeTask(task)}」`;
		return `本项目还有 1 个未完成任务${name}：仅作背景参考；只有用户明确要求继续时才续接，不要把它当作本次任务。`;
	}
	if (decision.kind === "choose") {
		const lines = decision.candidates.slice(0, 5).map((candidate, index) => `${index + 1}. ${describeTask(candidate)}`);
		return [`本项目有 ${decision.candidates.length} 个未完成任务（仅作背景参考，不要自动续接）：`, ...lines].join("\n");
	}
	if (decision.kind === "ask-planned") {
		const task = byId.get(decision.taskId);
		const name = task === undefined ? "" : `「${describeTask(task)}」`;
		return `本项目有 1 个计划中任务${name}：仅作背景参考；只有用户明确要求继续时才续接，不要当作本次任务。`;
	}
	if (decision.kind === "history") return "本项目只有已完成/已归档任务：仅作历史参考，重开需用户明确确认。";
	if (decision.kind === "incomplete") return "任务列表读取不完整：只作背景提示，不自动续接。";
	return "本项目当前没有可参考的任务记录（仅作背景参考，不要自动续接）。";
}
