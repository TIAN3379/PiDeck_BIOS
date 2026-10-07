import { Buffer } from "node:buffer";
import { decideMemory, projectV1ExperienceCard, type MemoryTargetContext } from "../memory/index.ts";
import type { ExperienceCard, FeatureRecord, ProjectProfile, TaskRecord } from "../contracts/records.ts";
import { isFeatureVisible } from "../knowledge/features.ts";
import { isStorageError, readRecord, type StorageIoHooks, type StorageLimits } from "../storage/index.ts";
import { authorizeWorkspacePath } from "../projects/authorization.ts";
import { captureWorkspaceSnapshot } from "../projects/workspace.ts";
import { readProjectView } from "../projects/view.ts";
import { invalidArgument, requireKnowledgeId, requireShortItem, resolveKnowledgeLimits, ProjectServiceError, type KnowledgeServiceLimits } from "../knowledge/contract.ts";
import { outboundPolicy, type EndpointPolicy } from "./policy.ts";
import { resolveModelBudget } from "./policy.ts";
import { DEFAULT_HANDOFF_BUDGET, assertRoot, fieldLine, fitSections, mapStorageError, measure, renderSections, rethrowIfCancelled, type HandoffBudget, type HandoffResult, type HandoffSection, type HandoffSource, type HandoffSourceKind } from "./sections.ts";
/* ------------------------------------------------------------------ C1：组装 */

export type BuildHandoffInput = {
	readonly root: string;
	readonly targetProjectId: string;
	readonly taskId?: string;
	readonly workspaceId?: string;
	readonly cwd: string;
	readonly authorizedRoots?: readonly string[];
	/** 被授权读取的项目（必须包含 targetProjectId；来源经验项目也须在内）。 */
	readonly authorizedProjectIds: readonly string[];
	readonly endpoint: EndpointPolicy;
	/** 用户选择的关键词（真正参与经验选择）。 */
	readonly query?: string;
	/** 显式授权的需求 ID（参与需求选择）。 */
	readonly allowedFeatureIds?: readonly string[];
	readonly budget?: Partial<HandoffBudget>;
	readonly limits?: Partial<KnowledgeServiceLimits>;
	readonly storageLimits?: Partial<StorageLimits>;
	readonly signal?: AbortSignal;
	readonly ioHooks?: StorageIoHooks;
	readonly now?: number;
};

function assertNotCancelled(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new ProjectServiceError("cancelled", "上下文组装已取消", { detail: "cancelled" });
}

export async function buildHandoff(input: BuildHandoffInput): Promise<HandoffResult> {
	if (typeof input !== "object" || input === null) throw invalidArgument("参数必须是对象");
	const root = assertRoot(input.root);
	const targetProjectId = requireKnowledgeId(input.targetProjectId, "目标项目 ID");
	// R33-4：领域入口与 IPC 共用**同一份硬上限**（12,000 字符 / 24 KiB）：参数只能收紧，
	// 超限夹紧（`clamped` 由解析器如实标记），任何入口都不能自己放宽宿主上限。
	const capped = resolveModelBudget({ maxChars: input.budget?.maxChars ?? DEFAULT_HANDOFF_BUDGET.maxChars, maxBytes: input.budget?.maxBytes ?? DEFAULT_HANDOFF_BUDGET.maxBytes });
	const budget: HandoffBudget = { maxChars: capped.maxChars, maxBytes: capped.maxBytes };
	if (!Number.isSafeInteger(budget.maxChars) || budget.maxChars <= 0) throw invalidArgument("预算 maxChars 必须是正整数");
	if (!Number.isSafeInteger(budget.maxBytes) || budget.maxBytes <= 0) throw invalidArgument("预算 maxBytes 必须是正整数");
	const now = input.now ?? Date.now();
	const outbound = outboundPolicy(input.endpoint);
	const base = {
		targetProjectId,
		taskId: input.taskId ?? null,
		workspaceId: input.workspaceId ?? null,
		text: "",
		sections: [] as readonly HandoffSection[],
		sources: [] as readonly HandoffSource[],
		inspectedSources: [] as readonly HandoffSource[],
		expiredSources: [] as readonly string[],
		outbound,
		head: { value: null, kind: "unknown" as const, capturedAt: null },
		budget: { ...budget, clamped: capped.clamped, usedChars: 0, usedBytes: 0, truncated: false },
		identityUsable: false,
		generatedAt: now,
		profileRevision: null as number | null,
		taskRevision: null as number | null,
		workspaceHead: null as string | null,
		problems: [] as readonly string[],
	};
	const fail = (status: HandoffResult["status"], problems: readonly string[]): HandoffResult => ({ ...base, status, problems: [...base.problems, ...problems] });

	if (!input.authorizedProjectIds.includes(targetProjectId)) return fail("not-authorized", ["目标项目不在本次授权范围内：不组装任何交接内容"]);
	assertNotCancelled(input.signal);

	const problems: string[] = [];
	/** 本次实际检查过的来源（含后来被预算删掉章节的），用于区分 inspected / retained（R32-2）。 */
	const inspected: { readonly source: HandoffSource; readonly section: string }[] = [];
	const sources: HandoffSource[] = [];
	const expiredSources: string[] = [];
	if (outbound.note !== null) problems.push(outbound.note);

	// ---- 项目档案：身份（人工确认程度） ----
	let profile: ProjectProfile;
	try {
		const read = await readRecord({ root, kind: "project-profile", id: targetProjectId, limits: input.storageLimits, signal: input.signal, ioHooks: input.ioHooks });
		profile = read.record;
	} catch (error) {
		rethrowIfCancelled(error);
		if (isStorageError(error) && (error.code === "not-found" || error.code === "invalid-root")) return fail("not-found", [`目标项目 ${targetProjectId} 不存在或不可读`]);
		throw mapStorageError(error, "读取项目档案失败");
	}
	const profileRevision = profile.revision;
	inspected.push({ source: { recordKind: "project-profile", recordId: targetProjectId, revision: profileRevision, reason: "目标项目身份与工作区快照" }, section: "目标项目" });

	// ---- 证据复验（R32-2）：复用既有决定视图，人工确认值一旦证据漂移就**不能**再当当前依据 ----
	const drifted = new Map<string, string>();
	try {
		const view = await readProjectView({ root, cwd: input.cwd, authorizedRoots: input.authorizedRoots, biosProjectId: targetProjectId, verifyEvidence: true, probeVcs: false, signal: input.signal, now });
		for (const item of view.decision?.items ?? []) {
			if (item.factKey === null) continue;
			if (item.class === "needs-review" || item.verification.status === "drifted" || item.reasons.includes("verification-drift")) {
				drifted.set(item.factKey, item.reasons.join("、") || "证据变化，需复核");
			}
		}
	} catch (error) {
		rethrowIfCancelled(error);
		// 复验不了就不假装"已确认"：本字段状态按需复核处理（保守方向）。
		problems.push("证据复验不可用：人工确认值本次不能作为当前依据");
	}
	const driftOf = (field: string): string | null => drifted.get(`project-profile.${field}`) ?? null;

	// ---- 任务（可选）：先读任务，才能核对 workspace 一致性 ----
	let task: TaskRecord | null = null;
	let taskRevision: number | null = null;
	if (input.taskId !== undefined) {
		const taskId = requireKnowledgeId(input.taskId, "任务 ID");
		try {
			const read = await readRecord({ root, kind: "task-record", id: taskId, projectId: targetProjectId, limits: input.storageLimits, signal: input.signal, ioHooks: input.ioHooks });
			task = read.record;
			taskRevision = read.record.revision;
			inspected.push({ source: { recordKind: "task-record", recordId: taskId, revision: taskRevision, reason: "当前任务事实（revision 是交接的依据）" }, section: "当前任务" });
		} catch (error) {
			rethrowIfCancelled(error);
			if (isStorageError(error) && (error.code === "not-found" || error.code === "invalid-root")) problems.push(`任务 ${taskId} 不在项目 ${targetProjectId} 里：交接只含项目事实`);
			else throw mapStorageError(error, "读取任务失败");
		}
	} else {
		problems.push("没有给出 taskId：交接不含任务事实（明确缺口，不用摘要代替）");
	}

	// ---- 工作区：task 与 workspace 必须严格一致；未选工作区时用任务的工作区（不猜第一个） ----
	const requestedWorkspaceId = input.workspaceId;
	let workspace = null as ProjectProfile["workspaces"][number] | null;
	if (task !== null && requestedWorkspaceId !== undefined && task.workspace.workspaceId !== requestedWorkspaceId) {
		// 严格一致：不一致就报缺口，**不输出**该工作区事实（也不退回任务的工作区）。
		problems.push(`task-workspace-mismatch：任务 ${task.id} 属于工作区 ${task.workspace.workspaceId}，而本次选择的是 ${requestedWorkspaceId}；不输出该工作区事实`);
	} else if (task !== null) {
		const wanted = requestedWorkspaceId ?? task.workspace.workspaceId;
		workspace = profile.workspaces.find((entry) => entry.workspaceId === wanted) ?? null;
		if (workspace === null) problems.push(`工作区 ${wanted} 不在项目 ${targetProjectId} 的已绑定工作区里`);
	} else if (requestedWorkspaceId !== undefined) {
		workspace = profile.workspaces.find((entry) => entry.workspaceId === requestedWorkspaceId) ?? null;
		if (workspace === null) problems.push(`工作区 ${requestedWorkspaceId} 不在项目 ${targetProjectId} 的已绑定工作区里`);
	} else {
		problems.push("没有给出 taskId/workspaceId：不自动挑选工作区（明确缺口）");
	}

	// ---- 身份闸门（R32-2）：工作区不在本次会话授权范围内（或没有会话目录）⇒ 不输出路径与当前续跑正文 ----
	const workspaceAuthorization = workspace === null ? null : authorizeWorkspacePath({ cwd: input.cwd, authorizedRoots: input.authorizedRoots, path: workspace.path });
	const identityUsable = workspace !== null && input.cwd !== "" && workspaceAuthorization?.authorized === true;
	if (workspace !== null && !identityUsable) {
		problems.push(`工作区 ${workspace.workspaceId} 不在本次会话的授权范围内：绑定保留，但不能据此交接（路径与当前任务正文已撤回）`);
	}

	// ---- 当前 HEAD：授权后**实时**快照；读不到时明确"已存快照/未知" ----
	let head: HandoffResult["head"] = { value: null, kind: "unknown", capturedAt: null };
	if (workspace !== null) {
		if (!identityUsable) {
			head = { value: workspace.vcs?.head ?? null, kind: workspace.vcs?.head === undefined || workspace.vcs?.head === null ? "unknown" : "stored-snapshot", capturedAt: null };
		} else {
			try {
				const snapshot = await captureWorkspaceSnapshot({ workspacePath: workspace.path, workspaceId: workspace.workspaceId, cwd: input.cwd, ...(input.authorizedRoots === undefined ? {} : { authorizedRoots: input.authorizedRoots }), now, signal: input.signal });
				if (snapshot.vcs !== null && snapshot.vcs.head !== null) head = { value: snapshot.vcs.head, kind: "live", capturedAt: snapshot.capturedAt };
				else head = { value: workspace.vcs?.head ?? null, kind: workspace.vcs?.head === undefined || workspace.vcs?.head === null ? "unknown" : "stored-snapshot", capturedAt: workspace.vcs?.head === undefined || workspace.vcs?.head === null ? null : workspace.capturedAt };
			} catch (error) {
				rethrowIfCancelled(error);
				head = { value: workspace.vcs?.head ?? null, kind: workspace.vcs?.head === undefined || workspace.vcs?.head === null ? "unknown" : "stored-snapshot", capturedAt: workspace.vcs?.head === undefined || workspace.vcs?.head === null ? null : workspace.capturedAt };
			}
		}
		if (head.kind !== "live") problems.push(`当前 HEAD 不是本次实时观察（${head.kind === "stored-snapshot" ? "已存快照，当前未知" : "不可用"}）：不把旧 profile.vcs.head 当作当前值`);
	}

	// ---- 参考经验：外发策略 + M1 + query 参与的有界选择 ----
	const referenceLines: string[] = [];
	const verifiedExperienceIds: string[] = [];
	if (task !== null) {
		const limits = resolveKnowledgeLimits(input.limits);
		// 先按上限**有界读取**任务引用的经验（读上限高于展示上限），让 query 能真正参与排序。
		const loaded: { readonly experienceId: string; readonly card: ExperienceCard; readonly revision: number }[] = [];
		for (const experienceId of task.sourceExperienceIds.slice(0, limits.maxDetailLinks)) {
			try {
				const read = await readRecord({ root, kind: "experience-card", id: experienceId, limits: input.storageLimits, signal: input.signal, ioHooks: input.ioHooks });
				loaded.push({ experienceId, card: read.record, revision: read.record.revision });
			} catch (error) {
				rethrowIfCancelled(error);
				expiredSources.push(experienceId);
				referenceLines.push(`- ${experienceId}（不可读：${isStorageError(error) ? error.code : "io-error"}）`);
			}
		}
		const query = (input.query ?? "").trim().toLowerCase();
		const ordered = query === "" ? loaded : [...loaded].sort((left, right) => scoreExperience(right.card, query) - scoreExperience(left.card, query));
		const displayCount = 8;
		const display = ordered.slice(0, displayCount);
		if (task.sourceExperienceIds.length > display.length) {
			problems.push(`任务引用了 ${task.sourceExperienceIds.length} 条经验，本次有界展示 ${display.length} 条（读取上限 ${limits.maxDetailLinks}，截断可见）`);
		}
		for (const { experienceId, card, revision } of display) {
			{
				verifiedExperienceIds.push(experienceId);
				if (!input.authorizedProjectIds.includes(card.sourceProjectId)) {
					expiredSources.push(experienceId);
					referenceLines.push(`- ${experienceId}（来源项目未授权：不展示内容）`);
					continue;
				}
				if (card.status === "deprecated") {
					expiredSources.push(experienceId);
					referenceLines.push(`- ${experienceId}（已废弃：不作为当前依据）`);
					continue;
				}
				// 复用范围经 M1 判定：customer/internal-general 未放行即不出正文。
				const decision = decideMemory({
					intent: "current",
					now,
					candidates: [projectV1ExperienceCard(card)],
					relations: [],
					authorization: { endpointAllowed: input.endpoint.endpointAllowed, allowInternalGeneral: input.endpoint.allowInternalGeneral, customers: [...(input.endpoint.customers ?? [])] },
					target: handoffTarget(input, targetProjectId, workspace?.workspaceId ?? null, profile, head.value, (factKey) => drifted.has(factKey)),
				});
				const item = decision.items[0];
				inspected.push({ source: { recordKind: "experience-card", recordId: experienceId, revision, reason: `任务引用的经验（状态 ${card.status}）` }, section: "参考经验与限制" });
				if (item === undefined) {
					expiredSources.push(experienceId);
					referenceLines.push(`- ${experienceId}（复用范围未放行：不展示内容）`);
					continue;
				}
				if (!outbound.allowCommercialBody) {
					referenceLines.push(`- ${experienceId}（状态 ${card.status}，revision ${revision}；原因 ${item.reasons.join("、") || "（无）"}；本次不输出正文）`);
					continue;
				}
				referenceLines.push(...describeExperienceBody(card, item.class, item.reasons));
			}
		}
	}

	// ---- 需求章节（R31-2）：显式授权的需求参与交接；正文同样受外发策略约束 ----
	// 身份闸门不可用时，当前需求也属于"当前续跑"内容：本次不读取、不展示（只留缺口）。
	const featureSection = identityUsable
		? await readFeatureSections({
				root,
				allowedFeatureIds: input.allowedFeatureIds ?? [],
				approvedCustomers: input.endpoint.customers ?? [],
				authorizedProjectIds: input.authorizedProjectIds,
				allowCommercialBody: outbound.allowCommercialBody,
				limits: resolveKnowledgeLimits(input.limits),
				...(input.storageLimits === undefined ? {} : { storageLimits: input.storageLimits }),
				...(input.signal === undefined ? {} : { signal: input.signal }),
				...(input.ioHooks === undefined ? {} : { ioHooks: input.ioHooks }),
			})
		: { lines: [] as readonly string[], sources: [] as readonly HandoffSource[], expired: [] as readonly string[], problems: ["会话目录不在任务工作区授权范围内：本次不输出当前需求章节"] };
	for (const source of featureSection.sources) inspected.push({ source, section: "当前需求" });
	const verifiedFeatureIds = featureSection.sources.map((source) => source.recordId);
	expiredSources.push(...featureSection.expired);
	problems.push(...featureSection.problems);

	// ---- 组装章节：外发策略**与身份闸门**共同决定正文是否出现 ----
	const identity = profile.identity;
	/** 人工确认值 + **证据漂移**提示：漂移的字段不能再被当成"已确认的当前依据"。 */
	const identityFieldLine = (label: string, field: keyof ProjectProfile["identity"]): string | null => {
		const entry = identity[field];
		const base = fieldLine(label, entry.value, entry.status);
		if (base === null) return null;
		const drift = driftOf(field as string);
		if (drift === null) return base;
		const statusText = entry.status === "confirmed" ? "人工确认" : entry.status === "candidate" ? "候选，未经确认" : "未知";
		return `${label}：${entry.value}（${statusText}；**需复核**：证据已变化（${drift}）——本次不作为当前依据）`;
	};
	const identityLines = [identityFieldLine("IBV", "ibv"), identityFieldLine("芯片组厂商", "chipsetVendor"), identityFieldLine("板卡", "boardName"), identityFieldLine("客户", "customer")].filter((line): line is string => line !== null);
	const projectLines = [`项目 ID：${targetProjectId}`, `档案 revision：${profileRevision}`];
	if (outbound.allowCommercialBody) projectLines.push(...identityLines);
	else projectLines.push(`项目身份字段：按外发策略撤回（${identityLines.length} 项）`);
	const workspaceLines =
		workspace === null
			? ["（没有可用工作区：见缺口）"]
			: identityUsable
				? [`工作区 ID：${workspace.workspaceId}`, `路径：${workspace.path}`, `分支：${workspace.vcs?.branch ?? "未知"}`, `当前 HEAD：${head.value ?? "未知"}（${head.kind === "live" ? "本次实时观察" : head.kind === "stored-snapshot" ? "已存快照，当前未知" : "不可用"}）`]
				: [`工作区 ID：${workspace.workspaceId}`, "路径/HEAD：按身份闸门撤回（该工作区不在本次会话授权范围内，或本次会话没有可用目录）：不能据此交接"];
	const taskLines =
		task === null
			? ["（本次没有可用的任务事实）"]
			: !identityUsable
				? [`任务 ID：${task.id}`, `revision：${taskRevision ?? "?"}`, `状态：${task.status}`, `商业正文：按身份闸门撤回（任务工作区不在本次会话授权范围内，或本次会话没有可用目录）：不能作为当前续跑依据（待办 ${task.todos.length} 项、阻塞 ${task.blockers.length} 项、决定 ${task.decisions.length} 项）`]
				: outbound.allowCommercialBody
					? [
							`任务 ID：${task.id}`,
							`revision：${taskRevision ?? "?"}`,
							`需求：${task.requirement}`,
							`状态：${task.status}（任务 done 只代表工程师声明任务结束，不代表硬件已验证/经验已审核/源码已提交）`,
							`待办：${task.todos.join("；") || "（无）"}`,
							`阻塞：${task.blockers.join("；") || "（无）"}`,
							`决定：${task.decisions.join("；") || "（无）"}`,
							`相关文件：${task.relatedFiles.join("；") || "（无）"}`,
							`声明验证：${task.validations.map((validation) => `${validation.kind}:${validation.result}@${validation.scope}`).join("；") || "（无）"}`,
						]
					: [`任务 ID：${task.id}`, `revision：${taskRevision ?? "?"}`, `状态：${task.status}`, `商业正文：按外发策略撤回（待办 ${task.todos.length} 项、阻塞 ${task.blockers.length} 项、决定 ${task.decisions.length} 项）`];
	const coreSections: HandoffSection[] = [
		{ title: "目标项目", lines: projectLines, optional: false },
		{ title: "当前工作区", lines: workspaceLines, optional: false },
		{ title: "当前任务", lines: taskLines, optional: false },
	];
	const optionalSections: HandoffSection[] = [];
	if (featureSection.lines.length > 0) optionalSections.push({ title: "当前需求", lines: [...featureSection.lines], optional: true });
	if (referenceLines.length > 0) optionalSections.push({ title: "参考经验与限制", lines: referenceLines, optional: true });
	if (expiredSources.length > 0 || problems.length > 0) optionalSections.push({ title: "缺口与限制", lines: [...expiredSources.map((id) => `- 过期/不可用来源：${id}`), ...problems.map((problem) => `- ${problem}`)], optional: true });

	const fitted = fitSections([...coreSections, ...optionalSections], budget);
	if (fitted.truncated && fitted.text === "") problems.push("核心章节超出双预算：本次不输出交接正文（只给有限诊断）");
	const incomplete = fitted.truncated || problems.length > 0 || expiredSources.length > 0 || !outbound.allowCommercialBody;

	// ---- 保留来源（R32-2）：预算删掉章节后，来源清单必须跟着收缩；"检查过"不等于"保留了" ----
	const retainedTitles = new Set(fitted.sections.map((section) => section.title));
	const inspectedSources: HandoffSource[] = inspected.map((entry) => entry.source);
	const retainedSources: HandoffSource[] = fitted.text === "" ? [] : inspected.filter((entry) => retainedTitles.has(entry.section)).map((entry) => entry.source);
	if (inspectedSources.length !== retainedSources.length) {
		problems.push(`来源清单：本次检查 ${inspectedSources.length} 个，实际保留 ${retainedSources.length} 个（预算/章节裁剪所致，不是"已注入"）`);
	}

	/** stale 早退：已保留/已检查来源都如实带上，正文一律丢弃。 */
	const staleOut = (status: HandoffResult["status"], extra: readonly string[]): HandoffResult => ({
		...fail(status, [...problems, ...extra]),
		sources: [],
		inspectedSources,
		expiredSources,
		profileRevision,
		taskRevision,
		head,
		workspaceHead: head.value,
	});

	// ---- 完成前重读**所有实际来源**（档案/任务/每条经验/**每个需求**）：任一变化 ⇒ stale，不输出旧正文 ----
	assertNotCancelled(input.signal);
	try {
		const profileAfter = await readRecord({ root, kind: "project-profile", id: targetProjectId, limits: input.storageLimits, signal: input.signal, ioHooks: input.ioHooks });
		if (profileAfter.record.revision !== profileRevision) return staleOut("stale", ["组装期间项目档案发生变化：旧交接不再有效（请重新组装）"]);
		if (task !== null && taskRevision !== null) {
			const taskAfter = await readRecord({ root, kind: "task-record", id: task.id, projectId: targetProjectId, limits: input.storageLimits, signal: input.signal, ioHooks: input.ioHooks });
			if (taskAfter.record.revision !== taskRevision) return staleOut("stale", ["组装期间任务发生变化：旧交接不再有效（请重新组装）"]);
		}
		for (const experienceId of verifiedExperienceIds) {
			const before = inspectedSources.find((source) => source.recordKind === "experience-card" && source.recordId === experienceId);
			const after = await readRecord({ root, kind: "experience-card", id: experienceId, limits: input.storageLimits, signal: input.signal, ioHooks: input.ioHooks });
			if (before !== undefined && after.record.revision !== before.revision) return staleOut("stale", [`组装期间经验 ${experienceId} 发生变化：旧交接不再有效`]);
			if (after.record.status === "deprecated" && task !== null) return staleOut("stale", [`组装期间经验 ${experienceId} 被废弃：旧交接不再有效`]);
		}
		// 需求来源同样末尾重验（R32-2）：revision 变化或授权被撤销 ⇒ 旧交接无效。
		for (const featureId of verifiedFeatureIds) {
			const before = inspectedSources.find((source) => source.recordKind === "feature-record" && source.recordId === featureId);
			const after = await readRecord({ root, kind: "feature-record", id: featureId, limits: input.storageLimits, signal: input.signal, ioHooks: input.ioHooks });
			if (before !== undefined && after.record.revision !== before.revision) return staleOut("stale", [`组装期间需求 ${featureId} 发生变化：旧交接不再有效`]);
			if (!isFeatureVisible(after.record, { allowedFeatureIds: input.allowedFeatureIds ?? [], approvedCustomers: input.endpoint.customers ?? [], authorizedProjectIds: input.authorizedProjectIds })) {
				return staleOut("stale", [`组装期间需求 ${featureId} 的授权已被撤销：旧交接不再有效`]);
			}
		}
	} catch (error) {
		rethrowIfCancelled(error);
		return staleOut("incomplete", ["重读时失败：无法证明交接与当前状态一致"]);
	}

	return {
		status: incomplete ? "incomplete" : "ok",
		targetProjectId,
		taskId: task?.id ?? null,
		workspaceId: workspace?.workspaceId ?? null,
		text: fitted.text,
		sections: fitted.sections,
		sources: retainedSources,
		inspectedSources,
		expiredSources,
		outbound,
		head,
		budget: { ...budget, clamped: capped.clamped, usedChars: fitted.usedChars, usedBytes: fitted.usedBytes, truncated: fitted.truncated },
		identityUsable,
		generatedAt: now,
		profileRevision,
		taskRevision,
		workspaceHead: head.value,
		problems,
	};
}

/** 关键词命中计数（用于让 `query` 真正参与参考经验的有界选择）。 */
function scoreExperience(card: ExperienceCard, query: string): number {
	const haystack = [card.id, card.problem, card.symptom ?? "", card.rootCause, card.solution, ...card.appliesWhen, ...card.doesNotApplyWhen].join("\n").toLowerCase();
	if (query === "") return 0;
	return query.split(/\s+/).filter((term) => term !== "" && haystack.includes(term)).length;
}

/**
 * M1 目标上下文（R31-2）：只用**人工确认**的板卡/版本/buildTarget 与本次实际观察到的 HEAD；
 * 未确认或未知一律保持 `null`（"未知就不作判断"，不拿候选值当目标）。
 */
export function handoffTarget(
	input: BuildHandoffInput,
	targetProjectId: string,
	workspaceId: string | null,
	profile: ProjectProfile | null,
	liveHead: string | null,
	/** 证据漂移判定（R32-2）：漂移/需复核的字段**不能**当目标依据（返回 true 即视为未知）。 */
	isDrifted?: (factKey: string) => boolean,
): MemoryTargetContext {
	const drifted = isDrifted ?? (() => false);
	const confirmed = (field: keyof ProjectProfile["identity"]): string | null => {
		if (profile === null) return null;
		if (drifted(`project-profile.${field}`)) return null;
		const entry = profile.identity[field];
		return entry.status === "confirmed" ? entry.value : null;
	};
	const confirmedBuildTarget =
		profile === null || drifted("project-profile.buildTargets") ? null : profile.buildTargets.filter((entry) => entry.status === "confirmed" && entry.value !== null).length === 1 ? (profile.buildTargets.find((entry) => entry.status === "confirmed" && entry.value !== null)?.value ?? null) : null;
	const boardName = confirmed("boardName");
	const boardRevision = confirmed("boardRevision");
	return {
		scope: { projectId: targetProjectId, workspaceId, customerId: confirmed("customer") ?? (input.endpoint.customers ?? [])[0] ?? null, boardName, boardRevision, buildTarget: confirmedBuildTarget },
		snapshot: { commit: liveHead, boardRevision, buildTarget: confirmedBuildTarget, contentHashes: [] },
	};
}

function describeExperienceBody(card: ExperienceCard, klass: string, reasons: readonly string[]): string[] {
	const lines = [`- ${card.id}（状态 ${card.status}；来源项目 ${card.sourceProjectId}；判定 ${klass}）`, `  根因：${card.rootCause}`, `  方案：${card.solution}`];
	if (card.appliesWhen.length > 0) lines.push(`  适用：${card.appliesWhen.join("；")}`);
	if (card.doesNotApplyWhen.length > 0) lines.push(`  不适用：${card.doesNotApplyWhen.join("；")}`);
	lines.push(`  声明验证：${card.validations.map((validation) => `${validation.kind}:${validation.result}@${validation.scope}`).join("；") || "（无）"}`);
	// 来源证据与 commit：v1 只存引用，没有合法 commit 证据时明确"未知"（不拿当前 HEAD 追溯历史）。
	const commitRefs = card.evidence.filter((entry) => entry.type === "commit" && typeof entry.commit === "string");
	const fileRefs = card.evidence.filter((entry) => entry.type === "source-file");
	lines.push(`  来源证据：${card.evidence.length === 0 ? "（没有声明）" : `${fileRefs.length} 个文件引用、${commitRefs.length} 个提交引用`}；来源 commit：${commitRefs[0]?.commit ?? "未知"}`);
	if (reasons.length > 0) lines.push(`  判定原因：${reasons.join("、")}`);
	if (card.status !== "reviewed" && card.status !== "verified") lines.push("  限制：该经验尚未审核，不能作为当前工程依据（只作提示）");
	if (card.reuseScope.level === "internal-general") lines.push("  限制：跨项目复用需显式授权说明，移植仍需在目标项目重新验证");
	return lines;
}

/** 需求章节（R31-2）：只读显式授权的需求 ID；正文同样受外发策略约束。 */
async function readFeatureSections(input: {
	root: string;
	allowedFeatureIds: readonly string[];
	approvedCustomers: readonly string[];
	authorizedProjectIds: readonly string[];
	allowCommercialBody: boolean;
	limits: KnowledgeServiceLimits;
	storageLimits?: Partial<StorageLimits>;
	signal?: AbortSignal;
	ioHooks?: StorageIoHooks;
}): Promise<{ readonly lines: readonly string[]; readonly sources: readonly HandoffSource[]; readonly expired: readonly string[]; readonly problems: readonly string[] }> {
	const lines: string[] = [];
	const sources: HandoffSource[] = [];
	const expired: string[] = [];
	const problems: string[] = [];
	for (const featureId of input.allowedFeatureIds.slice(0, input.limits.maxDetailLinks)) {
		try {
			const read = await readRecord({ root: input.root, kind: "feature-record", id: featureId, limits: input.storageLimits, signal: input.signal, ioHooks: input.ioHooks });
			const feature: FeatureRecord = read.record;
			// 需求没有项目字段：可见性只能来自显式 ID 或批准客户（与工具/检索同一口径）。
			if (!isFeatureVisible(feature, { allowedFeatureIds: input.allowedFeatureIds, approvedCustomers: input.approvedCustomers, authorizedProjectIds: input.authorizedProjectIds })) {
				expired.push(featureId);
				lines.push(`- ${featureId}（不在显式授权范围内：不展示内容）`);
				continue;
			}
			sources.push({ recordKind: "feature-record", recordId: featureId, revision: read.record.revision, reason: "显式授权的需求（参与交接的当前需求章节）" });
			if (!input.allowCommercialBody) {
				lines.push(`- ${featureId}（revision ${read.record.revision}；本次不输出需求正文）`);
				continue;
			}
			lines.push(`- ${featureId}（revision ${read.record.revision}）`, `  原文：${feature.originalRequirement}`, `  验收条件：${feature.acceptanceCriteria.join("；") || "（无）"}`);
		} catch (error) {
			rethrowIfCancelled(error);
			expired.push(featureId);
			problems.push(`需求 ${featureId} 不可读（${isStorageError(error) ? error.code : "io-error"}）`);
			lines.push(`- ${featureId}（不可读：${isStorageError(error) ? error.code : "io-error"}）`);
		}
	}
	return { lines, sources, expired, problems };
}
