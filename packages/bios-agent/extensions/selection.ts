/**
 * R31-2：**人工任务选择与上下文开关**的会话状态（按会话身份隔离）。
 *
 * 只保存**知识 ID 与非敏感开关**（不把知识正文放 Session）。三条边界：
 * 1. **会话身份**：选择记录它属于哪个 `sessionId`；别的会话读到时视为"未选择"，
 *    不把上一个会话的任务沿用成当前续跑；
 * 2. **代次**：每次变化推进 `generation`，迟到结果据此丢弃；
 * 3. **可信配置指纹**：端点/授权/知识根/目录根变化时，**自动关闭**商业上下文注入并说明原因
 *    （不把旧的 `allowed` 许可当新模型端点的永久许可）。
 *
 * 恢复策略是保守的：不持久化选择，恢复后需要重新选择（UI/命令都会给回执）；
 * 不假装"换会话自动恢复任务"。
 */
export type BiosSelection = {
	/** 选定的项目（必须来自宿主授权集合）。 */
	readonly projectId: string | null;
	/** 选定的任务 ID（项目内唯一）。 */
	readonly taskId: string | null;
	/** 选定的工作区（必须属于该项目；换项目/任务且未指定时清除）。 */
	readonly workspaceId: string | null;
	/** 是否允许把受控 BIOS 上下文注入模型请求（默认关闭）。 */
	readonly contextEnabled: boolean;
};

export type SelectionView = {
	/** 本次调用可用的选择（跨会话读取时为"未选择"）。 */
	readonly selection: BiosSelection;
	readonly generation: number;
	/** 选择是否属于本次会话（false 表示已按"未选择"处理，需要重新选择）。 */
	readonly belongsToSession: boolean;
	/** 本次调用是否因可信配置变化而自动关闭了注入。 */
	readonly autoDisabledReason: string | null;
};

const EMPTY: BiosSelection = { projectId: null, taskId: null, workspaceId: null, contextEnabled: false };

type Stored = { readonly sessionId: string | null; readonly selection: BiosSelection; readonly configFingerprint: string | null };

let stored: Stored = { sessionId: null, selection: EMPTY, configFingerprint: null };
let generation = 0;
let lastAutoDisable: string | null = null;

export function currentGeneration(): number {
	return generation;
}

/**
 * 读取本次调用可用的选择。
 *
 * `sessionId` 不匹配 ⇒ 返回"未选择"（安全方向）；可信配置指纹变化 ⇒ 把 `contextEnabled`
 * 落成 false 并记录原因（幂等，只提示一次）。
 */
export function selectionFor(sessionId: string | null, configFingerprint: string | null): SelectionView {
	const belongsToSession = stored.sessionId === sessionId;
	if (!belongsToSession) return { selection: EMPTY, generation, belongsToSession: false, autoDisabledReason: null };
	if (stored.selection.contextEnabled && configFingerprint !== null && stored.configFingerprint !== null && stored.configFingerprint !== configFingerprint) {
		lastAutoDisable = "可信配置（端点/授权/知识根/目录根）已变化：上下文注入已自动关闭，请重新确认";
		stored = { ...stored, selection: { ...stored.selection, contextEnabled: false }, configFingerprint };
		generation += 1;
	}
	return { selection: stored.selection, generation, belongsToSession: true, autoDisabledReason: lastAutoDisable };
}

/** 上一次自动关闭的原因（命令回执用；读取后不清空，便于状态命令重复展示）。 */
export function lastAutoDisableReason(): string | null {
	return lastAutoDisable;
}

/** 更新选择：只允许同一会话内更新（不同会话要先 select）。 */
export function updateSelection(patch: Partial<BiosSelection>, context: { readonly sessionId: string | null; readonly configFingerprint: string | null }): BiosSelection {
	const sameSession = stored.sessionId === context.sessionId;
	const base = sameSession ? stored.selection : EMPTY;
	stored = { sessionId: context.sessionId, selection: { ...base, ...patch }, configFingerprint: context.configFingerprint };
	generation += 1;
	return stored.selection;
}

export function clearSelection(): void {
	stored = { sessionId: null, selection: EMPTY, configFingerprint: null };
	generation += 1;
}

/** 命令回执用的可读描述（不含知识正文）。 */
export function describeSelection(view: SelectionView, sessionId: string | null): string {
	const lines: string[] = [];
	if (view.selection.projectId === null && view.selection.taskId === null) {
		lines.push("BIOS 选择：未选择任务（上下文注入默认关闭）");
		if (!view.belongsToSession && stored.sessionId !== null) lines.push("说明：检测到另一个会话/分支留下过选择，已按“未选择”处理；请重新选择。");
	} else {
		lines.push(`BIOS 选择：项目 ${view.selection.projectId ?? "?"}｜任务 ${view.selection.taskId ?? "?"}｜工作区 ${view.selection.workspaceId ?? "未指定"}`);
		lines.push(`上下文注入：${view.selection.contextEnabled ? "开" : "关"}（默认关闭；打开不等于端点允许）`);
	}
	if (view.autoDisabledReason !== null) lines.push(`提示：${view.autoDisabledReason}`);
	lines.push(`会话：${sessionId ?? "（无会话上下文）"}`);
	return lines.join("\n");
}

/** 当前保存的会话身份（诊断用）。 */
export function storedSessionId(): string | null {
	return stored.sessionId;
}

/**
 * 适配层注入的**初始选择**只采纳一次（幂等）：工程师随后手动选择的会覆盖它，
 * 重复注入不会把用户的选择改回去。`reason` 为 null 表示采纳成功。
 */
let initialAdoption: { readonly done: boolean; readonly sessionId: string | null; readonly reason: string | null } = { done: false, sessionId: null, reason: null };

export function initialAdoptionState(): { readonly done: boolean; readonly sessionId: string | null; readonly reason: string | null } {
	return initialAdoption;
}

export function markInitialAdoption(reason: string | null, sessionId: string | null = null): void {
	initialAdoption = { done: true, sessionId, reason };
}
