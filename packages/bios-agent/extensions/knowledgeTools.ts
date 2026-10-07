/**
 * R31-1 / R31-2 / R31-3：**只读 BIOS 专业工具**（模型可调用）。
 *
 * 统一纪律：
 * - 模型参数**只允许**用户问题、所选 ID 与**收紧**预算；知识根、授权项目/客户、端点策略、
 *   目录授权根一律来自可信宿主配置（`hostConfig.ts`），模型无法给自己扩权；
 * - **调用上下文是真的**：cwd/signal/sessionManager 来自宿主 `ctx`，不用 `process.cwd()` 冒充；
 * - **外发守卫统一**（R31-1）：端点 deny/unknown 时 content 与 details 都**不出现**商业正文，
 *   只留 ID/状态/计数/受控缺口；有限诊断与来源元数据另有独立硬上限；
 * - **输出预算统一**（R31-3）：content 与正文型 details 共用 12,000 字符 / 24 KiB 硬上限，
 *   模型只能收紧；超限夹紧并如实说明；
 * - 全部只读：不写库、不保存 Manifest、不改任务、不审批；取消贯通到领域层。
 */
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { outboundPolicy, type OutboundPolicy } from "../core/context/index.ts";
import { readExperienceReference, readFeatureDetail, searchKnowledge } from "../core/knowledge/index.ts";
import { readProjectView } from "../core/projects/index.ts";
import { readTaskDetail } from "../core/tasks/index.ts";
import { buildHandoff } from "../core/context/index.ts";
import { buildCallContext, type BiosCallContext } from "./callContext.ts";
import { serviceIdentityOf } from "../core/context/serviceIdentity.ts";
import type { EndpointServiceIdentity } from "../core/context/index.ts";
import { hostReadiness } from "./hostConfig.ts";
import { boundDetails, boundText, projectDiagnostics, resolveModelBudget, type ModelBudget } from "./outbound.ts";
import { recheckBeforeOutput } from "./outputGuard.ts";
import { scopeOf } from "./historyGuard.ts";
import { lastAutoDisableReason, selectionFor, type BiosSelection } from "./selection.ts";

const PACKAGE_NAME = "bios-agent";

export type BiosToolDetails = {
	readonly status: "ok" | "incomplete" | "denied" | "not-found" | "stale" | "cancelled";
	readonly packageName: string;
	/** 知识根**来源**（`env`/`override`）：不回显本地绝对路径。 */
	readonly knowledgeRootSource: string;
	readonly outbound: { readonly allowCommercialBody: boolean; readonly note: string | null };
	readonly notes: readonly string[];
	readonly counts: Record<string, number>;
	readonly [key: string]: unknown;
};

type ToolOutcome = { readonly content: { readonly type: "text"; readonly text: string }[]; readonly details: BiosToolDetails };

type ToolDeps = {
	readonly currentService: () => EndpointServiceIdentity | null;
	readonly call: BiosCallContext;
	readonly outbound: OutboundPolicy;
	readonly selection: BiosSelection;
	/** 判定时的选择代次：输出前复查用（R32-1）。 */
	readonly selectionGeneration: number;
};

function depsOf(ctx: unknown, signal: AbortSignal | undefined): ToolDeps {
	const fromCtx = buildCallContext(ctx as Parameters<typeof buildCallContext>[0]);
	// execute 的第三个参数是本次调用的真实信号：优先用它（比 ctx.signal 更精确）。
	const call = signal === undefined ? fromCtx : { ...fromCtx, signal };
	const view = selectionFor(call.sessionId, call.configFingerprint);
	return { call, currentService: () => serviceIdentityOf((ctx as Parameters<typeof buildCallContext>[0])?.model), outbound: outboundPolicy(call.config.endpoint), selection: view.selection, selectionGeneration: view.generation };
}

/** 预先取消：不读任何记录、不返回任何正文（与"读取失败"分开）。 */
function cancelledIfAborted(deps: ToolDeps): ToolOutcome | null {
	if (deps.call.signal?.aborted !== true) return null;
	return respond({
		deps,
		status: "cancelled",
		text: "本次 BIOS 读取已取消：未读取任何记录，也未返回任何内容。",
		notes: ["cancelled"],
		details: {},
		fallback: { status: "cancelled", packageName: PACKAGE_NAME },
		budget: resolveModelBudget(),
	});
}

/** 统一收尾：正文与 details 都过同一份权限与预算。 */
function respond(input: {
	readonly deps: ToolDeps;
	readonly status: BiosToolDetails["status"];
	readonly text: string;
	readonly notes: readonly string[];
	readonly counts?: Record<string, number>;
	readonly details: Record<string, unknown>;
	readonly fallback: Record<string, unknown>;
	readonly budget: ModelBudget;
}): ToolOutcome {
	// R32-1：**输出前复查**。判定与输出之间隔着 await（真实文件/子进程读取），期间端点、授权、
	// 知识根、目录根或会话选择都可能变化；取消也可能已经发生。任一条不成立就丢弃正文，
	// 而不是"换个状态标签继续发"。
	const recheck = recheckBeforeOutput({
		configFingerprint: input.deps.call.configFingerprint,
		signal: input.deps.call.signal,
		sessionId: input.deps.call.sessionId,
		selectionGeneration: input.deps.selectionGeneration,
		// D4：把本次调用看到的实际模型服务并回复查（否则指纹里"实际服务"一侧永远是空的）。
		actual: input.deps.currentService(),
	});
	// 信封里的端点策略必须用**当前**配置：变化后仍报旧策略会误导调用方。
	const outbound = outboundPolicy(recheck.config.endpoint);
	if (!recheck.ok) {
		const dropped = boundText(`BIOS 读取结果已丢弃：${recheck.reason}`, input.budget);
		return {
			content: [{ type: "text", text: dropped.text }],
			details: {
				...input.fallback,
				status: recheck.status,
				packageName: PACKAGE_NAME,
				knowledgeRootSource: recheck.config.knowledgeRootSource,
				outbound: { allowCommercialBody: outbound.allowCommercialBody, note: outbound.note },
				// R34-1：范围里必须带**目录授权 + 身份依据**（只记哈希），否则目录撤回后无法判定。
				scope: scopeOf(recheck.config, { cwd: input.deps.call.cwd, authorizedRoots: input.deps.call.authorizedRoots }),
				notes: [recheck.reason],
				counts: input.counts ?? {},
				withheld: true,
				recheckReason: recheck.reason,
				budget: { maxChars: input.budget.maxChars, maxBytes: input.budget.maxBytes, usedChars: dropped.usedChars, usedBytes: dropped.usedBytes, truncated: dropped.truncated, clamped: input.budget.clamped },
			} as BiosToolDetails,
		};
	}
	const bounded = boundText(input.text, input.budget);
	// 信封字段（状态/策略/预算/计数/诊断）**永远**保留：只对工具特有的正文型 details 做降级，
	// 否则"截断正文 + 丢掉状态/预算说明"会让调用方无法判断发生了什么。
	const envelope: BiosToolDetails = {
		status: input.status,
		packageName: PACKAGE_NAME,
		knowledgeRootSource: recheck.config.knowledgeRootSource,
		outbound: { allowCommercialBody: outbound.allowCommercialBody, note: outbound.note },
		// R33-1/R34-1：记录产出时的**授权范围**（ID/策略/知识根哈希 + 目录授权与身份依据哈希），
		// 供历史重放守卫比对"是否已收窄"（端点/目录/知识根/授权集合/身份均参与）。
		scope: scopeOf(recheck.config, { cwd: input.deps.call.cwd, authorizedRoots: input.deps.call.authorizedRoots }),
		notes: [...input.notes],
		counts: input.counts ?? {},
		budget: { maxChars: input.budget.maxChars, maxBytes: input.budget.maxBytes, usedChars: bounded.usedChars, usedBytes: bounded.usedBytes, truncated: bounded.truncated, clamped: input.budget.clamped },
	};
	const merged = boundDetails(input.details, input.fallback);
	return { content: [{ type: "text", text: bounded.text }], details: { ...merged, ...envelope } as BiosToolDetails };
}

function deniedOutcome(deps: ToolDeps, reason: string, extra: Record<string, unknown> = {}): ToolOutcome {
	return respond({
		deps,
		status: "denied",
		text: `BIOS 知识访问被拒绝：${reason}`,
		notes: [reason],
		details: extra,
		fallback: { status: "denied", packageName: PACKAGE_NAME, knowledgeRootSource: deps.call.config.knowledgeRootSource },
		budget: resolveModelBudget(),
	});
}

function notFoundOutcome(deps: ToolDeps, text: string, extra: Record<string, unknown> = {}): ToolOutcome {
	return respond({ deps, status: "not-found", text, notes: [], details: extra, fallback: { status: "not-found", packageName: PACKAGE_NAME }, budget: resolveModelBudget() });
}

function projectAuthorized(deps: ToolDeps, projectId: string): string | null {
	if (deps.call.config.authorizedProjectIds.includes(projectId)) return null;
	return `项目 ${projectId} 不在宿主授权集合内`;
}

function readinessReason(deps: ToolDeps): string | null {
	return hostReadiness(deps.call.config).reason;
}

/* ------------------------------------------------------------------ 项目信息 */

export const biosGetProjectInfoTool = defineTool({
	name: "bios_get_project_info",
	label: "BIOS 项目信息",
	promptSnippet: "只读读取授权项目档案：人工确认值、证据漂移与下一步提示（复用既有证据视图）",
	description:
		"Read-only view of a BIOS project profile from the local knowledge store. It reuses the project decision view: human-confirmed identity values, evidence drift (a changed source file marks the fact as needing review), workspace binding, build targets and explicit gaps. Workspace paths and identity values are withheld when the host outbound policy is deny/unknown. It never binds a project or workspace.",
	parameters: Type.Object({
		projectId: Type.Optional(Type.String({ description: "要读取的项目 ID；省略时使用当前会话选择。必须在宿主授权集合内。" })),
		workspaceId: Type.Optional(Type.String({ description: "可选：只读取该项目下的这个工作区。" })),
	}),
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		const deps = depsOf(ctx, signal);
		const cancelled = cancelledIfAborted(deps);
		if (cancelled !== null) return cancelled;
		const reason = readinessReason(deps);
		if (reason !== null) return deniedOutcome(deps, reason);
		const projectId = params.projectId ?? deps.selection.projectId ?? null;
		if (projectId === null) return deniedOutcome(deps, "没有可用项目：请先用 /bios-task 选择任务，或显式给出已授权的 projectId");
		const unauthorized = projectAuthorized(deps, projectId);
		if (unauthorized !== null) return deniedOutcome(deps, unauthorized);
		if (deps.call.cwd === "") return deniedOutcome(deps, "本次调用没有可用的会话工作目录（ctx.cwd）：不能用进程 cwd 代替");

		let view: Awaited<ReturnType<typeof readProjectView>>;
		try {
			view = await readProjectView({ root: deps.call.config.knowledgeRoot as string, cwd: deps.call.cwd, authorizedRoots: deps.call.authorizedRoots, biosProjectId: projectId, verifyEvidence: true, probeVcs: true, signal: signal ?? deps.call.signal, now: Date.now() });
		} catch (error) {
			return notFoundOutcome(deps, `项目 ${projectId} 不可读（${messageOf(error)}）`);
		}
		const profile = view.open.profile;
		if (profile === null) return notFoundOutcome(deps, `项目 ${projectId} 不存在或不可用（${view.open.status}）`);
		const workspaces = params.workspaceId === undefined ? profile.workspaces : profile.workspaces.filter((workspace) => workspace.workspaceId === params.workspaceId);

		// 证据漂移来自**既有**决定视图（不新建历史库）：按事实键取 status/reasons。
		const drift = new Map<string, { readonly klass: string; readonly status: string; readonly reasons: readonly string[] }>();
		for (const item of view.decision?.items ?? []) {
			if (item.factKey === null) continue;
			drift.set(item.factKey, { klass: item.class, status: item.verification.status, reasons: item.reasons });
		}
		const identityRows = Object.entries(profile.identity).map(([field, value]) => {
			const fact = drift.get(`project-profile.${field}`);
			return { field, status: value.status, value: value.value, decision: fact?.klass ?? null, verification: fact?.status ?? null, reasons: fact?.reasons ?? [] };
		});
		const driftedCount = identityRows.filter((row) => row.reasons.includes("verification-drift") || row.decision === "needs-review").length;

		const lines: string[] = [`项目 ${projectId}｜视图 ${view.status}（档案 revision ${view.revisions.profile ?? "?"}）`];
		if (deps.outbound.allowCommercialBody) {
			for (const row of identityRows) lines.push(`- ${row.field}：${row.value ?? "（未知）"}（${statusLabel(row.status)}${row.decision === "needs-review" ? "；需复核" : ""}${row.reasons.includes("verification-drift") ? "；证据漂移" : ""}）`);
			for (const workspace of workspaces) lines.push(`- 工作区 ${workspace.workspaceId}：${workspace.path}（${workspace.availability}）`);
		} else {
			lines.push(`- 身份字段与工作区路径按外发策略撤回（身份 ${identityRows.length} 项；工作区 ${workspaces.length} 个）`);
			for (const workspace of workspaces) lines.push(`- 工作区 ID：${workspace.workspaceId}`);
		}
		lines.push(`- 证据漂移：${driftedCount} 个身份字段需要复核${view.evidenceUnchecked > 0 ? `（另有 ${view.evidenceUnchecked} 条证据未复验）` : ""}`);
		if (view.headChanged) lines.push("- 工作区 HEAD 与档案记录不同：依赖该检出的结论需要复核");
		for (const problem of view.problems.slice(0, 4)) lines.push(`- 诊断：${problem}`);

		const diagnostics = projectDiagnostics(view.problems, { identityFields: identityRows.length, needsReview: driftedCount, evidenceUnchecked: view.evidenceUnchecked });
		const withheld = !deps.outbound.allowCommercialBody;
		return respond({
			deps,
			status: view.status === "not-usable" ? "denied" : view.status !== "ok" || withheld ? "incomplete" : "ok",
			text: lines.join("\n"),
			notes: view.status === "ok" ? [] : [`项目视图 ${view.status}`],
			counts: diagnostics.counts,
			details: {
				revision: view.revisions.profile,
				workspaceIds: workspaces.map((workspace) => workspace.workspaceId),
				headChanged: view.headChanged,
				branchChanged: view.branchChanged,
				head: view.workspaceVcs?.head ?? null,
				withheld: !deps.outbound.allowCommercialBody,
				identity: deps.outbound.allowCommercialBody ? identityRows : identityRows.map((row) => ({ field: row.field, status: row.status, decision: row.decision, verification: row.verification, reasons: row.reasons })),
				problems: diagnostics.problems,
			},
			fallback: { revision: view.revisions.profile, counts: diagnostics.counts, problems: diagnostics.problems, detailsTruncated: true } as Record<string, unknown>,
			budget: resolveModelBudget(),
		});
	},
});

function statusLabel(status: string): string {
	return status === "confirmed" ? "人工确认" : status === "candidate" ? "候选，未经确认" : "未知";
}

function messageOf(error: unknown): string {
	if (error !== null && typeof error === "object" && "code" in error && typeof error.code === "string") return error.code;
	return error instanceof Error ? error.message : String(error);
}

/* ------------------------------------------------------------------ 任务 */

export const biosGetTaskTool = defineTool({
	name: "bios_get_task",
	label: "BIOS 任务",
	promptSnippet: "只读读取当前项目明确 taskId 的任务事实与引用核对；身份/路径不可用时不给当前续跑正文",
	description:
		"Read-only task record for an explicit projectId + taskId: status, requirement, decisions, todos, blockers, related files, declared validations (with scope) and per-reference experience checks. Identity gates the body: if the task's workspace path is outside the current session authorization (or the session cwd is unavailable), the requirement text is withheld and only identifiers, status and gaps are returned. It never creates, updates, reopens or archives tasks and never guesses which task to continue.",
	parameters: Type.Object({
		taskId: Type.Optional(Type.String({ description: "任务 ID；省略时使用当前会话选择的任务。" })),
		projectId: Type.Optional(Type.String({ description: "项目 ID；省略时使用当前会话选择。必须在宿主授权集合内。" })),
	}),
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		const deps = depsOf(ctx, signal);
		const cancelled = cancelledIfAborted(deps);
		if (cancelled !== null) return cancelled;
		const reason = readinessReason(deps);
		if (reason !== null) return deniedOutcome(deps, reason);
		const projectId = params.projectId ?? deps.selection.projectId ?? null;
		const taskId = params.taskId ?? deps.selection.taskId ?? null;
		if (projectId === null || taskId === null) return deniedOutcome(deps, "没有选定任务：请先用 /bios-task 选择，或显式给出已授权的 projectId 与 taskId；技能不会替你猜要续跑哪个任务");
		const unauthorized = projectAuthorized(deps, projectId);
		if (unauthorized !== null) return deniedOutcome(deps, unauthorized);

		const detail = await readTaskDetail({ root: deps.call.config.knowledgeRoot as string, projectId, taskId, cwd: deps.call.cwd, authorizedRoots: deps.call.authorizedRoots, authorizedProjectIds: deps.call.config.authorizedProjectIds, signal: signal ?? deps.call.signal });
		if (detail.status !== "ok" || detail.task === null) return notFoundOutcome(deps, `任务 ${taskId} 不可读（${detail.status}）：${projectDiagnostics(detail.problems).problems.join("；") || "不存在或未授权"}`, { notes: projectDiagnostics(detail.problems).problems });
		const task = detail.task;
		// 身份/路径不可用 ⇒ 当前任务正文的使用闸门（不能"以 incomplete 警告继续当前续跑"）。
		const identityUsable = detail.workspaceAuthorized && deps.call.cwd !== "";
		const showBody = deps.outbound.allowCommercialBody && identityUsable;
		const lines: string[] = [`任务 ${task.id}（revision ${detail.revision}，状态 ${task.status}）`];
		if (showBody) {
			lines.push(`需求：${task.requirement}`, `待办：${task.todos.join("；") || "（无）"}`, `阻塞：${task.blockers.join("；") || "（无）"}`);
		} else {
			lines.push(`商业正文按策略撤回（待办 ${task.todos.length} 项、阻塞 ${task.blockers.length} 项、决定 ${task.decisions.length} 项、相关文件 ${task.relatedFiles.length} 项）`, identityUsable ? "原因：端点策略" : "原因：任务工作区不在本次会话授权范围内（或没有会话工作目录）：不能作为当前续跑依据");
		}
		lines.push("引用核对：");
		for (const reference of detail.references) lines.push(`- ${reference.experienceId}：${reference.usableAsBasis ? "可作当前依据" : `不可作依据（${reference.reason ?? "未知"}）`}`);
		lines.push("注意：任务 done 只代表工程师声明任务结束，不代表硬件已验证或经验已审核。");

		const diagnostics = projectDiagnostics(detail.problems, { references: detail.references.length });
		return respond({
			deps,
			status: showBody ? "ok" : "incomplete",
			text: lines.join("\n"),
			notes: identityUsable ? [] : ["任务工作区不在本次会话授权范围内：只给标识与缺口"],
			counts: diagnostics.counts,
			details: {
				projectId,
				taskId,
				revision: detail.revision,
				taskStatus: task.status,
				workspaceAuthorized: detail.workspaceAuthorized,
				withheld: !showBody,
				references: detail.references.map((reference) => ({ experienceId: reference.experienceId, found: reference.found, status: reference.status, usableAsBasis: reference.usableAsBasis, reason: reference.reason })),
				validations: showBody ? task.validations.map((validation) => ({ kind: validation.kind, scope: validation.scope, result: validation.result })) : [],
				problems: diagnostics.problems,
			},
			fallback: { projectId, taskId, revision: detail.revision, taskStatus: task.status, counts: diagnostics.counts, problems: diagnostics.problems, detailsTruncated: true } as Record<string, unknown>,
			budget: resolveModelBudget(),
		});
	},
});

/* ------------------------------------------------------------------ 检索 */

export const biosSearchKnowledgeTool = defineTool({
	name: "bios_search_knowledge",
	label: "BIOS 知识检索",
	promptSnippet: "有界关键词/别名检索受授权的需求与经验；deny/unknown 只给分类与来源元数据",
	description:
		"Bounded keyword/alias search over authorized BIOS features and experience cards. Returns matched fields, recommendation class, reasons, declared validation strength and source project. Source projects, customers and the endpoint policy come from the host configuration, never from tool arguments; unauthorized records are not visible at all. When the outbound policy is deny/unknown, titles and snippets are withheld and only class/source identifiers/reasons are returned.",
	parameters: Type.Object({
		query: Type.String({ description: "关键词（空白分隔表示 AND）。" }),
		intent: Type.Optional(Type.Union([Type.Literal("current"), Type.Literal("history")], { description: "current（默认）只给当前结论；history 可看被替代/废弃记录。" })),
		limit: Type.Optional(Type.Number({ description: "最多返回条数（只能收紧宿主预算）。" })),
	}),
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		const deps = depsOf(ctx, signal);
		const cancelled = cancelledIfAborted(deps);
		if (cancelled !== null) return cancelled;
		const reason = readinessReason(deps);
		if (reason !== null) return deniedOutcome(deps, reason);
		if (deps.call.cwd === "") return deniedOutcome(deps, "本次调用没有可用的会话工作目录（ctx.cwd）");
		const result = await searchKnowledge({
			useIndex: true,
			root: deps.call.config.knowledgeRoot as string,
			query: params.query,
			visibility: { authorizedProjectIds: deps.call.config.authorizedProjectIds, allowedFeatureIds: deps.call.config.allowedFeatureIds, approvedCustomers: deps.call.config.approvedCustomers },
			target: { projectId: deps.selection.projectId, customerId: deps.call.config.endpoint.customers[0] ?? null },
			authorization: { endpointAllowed: deps.call.config.endpoint.endpointAllowed, allowInternalGeneral: deps.call.config.endpoint.allowInternalGeneral, customers: deps.call.config.endpoint.customers },
			...(params.intent === undefined ? {} : { intent: params.intent }),
			...(params.limit === undefined ? {} : { limits: { maxSearchResults: params.limit } }),
			signal: signal ?? deps.call.signal,
		});
		const showBody = deps.outbound.allowCommercialBody;
		const lines = [`检索结果：${result.status}（命中 ${result.hits.length}${result.matchedButDropped > 0 ? `，因预算丢弃 ${result.matchedButDropped}` : ""}）`];
		for (const hit of result.hits) {
			lines.push(`- ${hit.recommendation} ${hit.family}/${hit.recordId} rev${hit.revision}${showBody ? `：${hit.title ?? "（无标题）"}` : "（正文按外发策略撤回）"}${hit.reasons.length > 0 ? ` [${hit.reasons.join(",")}]` : ""}`);
		}
		const diagnostics = projectDiagnostics(result.problems, { hits: result.hits.length, matchedButDropped: result.matchedButDropped, unreadable: result.unreadable });
		for (const problem of diagnostics.problems) lines.push(`- 诊断：${problem}`);
		return respond({
			deps,
			status: result.status === "ok" && showBody ? "ok" : "incomplete",
			text: lines.join("\n"),
			notes: showBody ? [] : ["端点策略不允许外发：只给分类、来源标识与缺口"],
			counts: diagnostics.counts,
			details: {
				withheld: !showBody,
				hits: result.hits.map((hit) => ({ family: hit.family, recordId: hit.recordId, revision: hit.revision, recommendation: hit.recommendation, recordedStatus: hit.recordedStatus, reasons: hit.reasons, sourceProjectId: hit.sourceProjectId, ...(showBody ? { title: hit.title, snippet: hit.snippet } : {}) })),
				problems: diagnostics.problems,
			},
			fallback: { counts: diagnostics.counts, problems: diagnostics.problems, detailsTruncated: true } as Record<string, unknown>,
			budget: resolveModelBudget(),
		});
	},
});

/* ------------------------------------------------------------------ 需求 */

export const biosGetFeatureTool = defineTool({
	name: "bios_get_feature",
	label: "BIOS 需求详情",
	promptSnippet: "只读读取显式授权的需求详情（deny/unknown 撤回需求原文与验收条件）",
	description:
		"Read-only detail of an explicitly authorized feature (requirement + acceptance criteria + bounded experience links + whether it may be reused as a reference). Features carry no project field, so they must be authorized by explicit feature id or approved customer scope. When the outbound policy is deny/unknown the requirement text and acceptance criteria are withheld.",
	parameters: Type.Object({
		featureId: Type.String({ description: "需求 ID（必须在宿主显式授权集合内，或命中批准客户范围）。" }),
	}),
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		const deps = depsOf(ctx, signal);
		const cancelled = cancelledIfAborted(deps);
		if (cancelled !== null) return cancelled;
		const reason = readinessReason(deps);
		if (reason !== null) return deniedOutcome(deps, reason);
		const detail = await readFeatureDetail({
			root: deps.call.config.knowledgeRoot as string,
			featureId: params.featureId,
			visibility: { allowedFeatureIds: deps.call.config.allowedFeatureIds, approvedCustomers: deps.call.config.approvedCustomers, authorizedProjectIds: deps.call.config.authorizedProjectIds },
			customerId: deps.call.config.approvedCustomers[0] ?? null,
			signal: signal ?? deps.call.signal,
		});
		if (detail.status !== "ok" || detail.feature === null) {
			const diagnostics = projectDiagnostics(detail.problems);
			return deniedOutcome(deps, `需求 ${params.featureId} 不可读（${detail.status}）：${detail.referenceReasons.join("；") || "未授权或不存在"}`, { links: detail.links, problems: diagnostics.problems });
		}
		const showBody = deps.outbound.allowCommercialBody;
		const lines = [`需求 ${detail.featureId}（revision ${detail.revision}）`];
		if (showBody) lines.push(`原文：${detail.feature.originalRequirement}`, `验收条件：${detail.feature.acceptanceCriteria.join("；") || "（无）"}`);
		else lines.push(`需求原文与验收条件按外发策略撤回（原文 ${[...detail.feature.originalRequirement].length} 字符、验收条件 ${detail.feature.acceptanceCriteria.length} 条）`);
		lines.push(`可直接复用：${detail.usableAsReference}`);
		for (const reason of detail.referenceReasons) lines.push(`- 限制：${reason}`);
		for (const link of detail.links) lines.push(`- 关联 ${link.experienceId}：${link.found ? `已核对（${link.status}）` : `未核对（${link.reason}）`}`);
		const diagnostics = projectDiagnostics(detail.problems, { links: detail.links.length });
		return respond({
			deps,
			status: showBody ? "ok" : "incomplete",
			text: lines.join("\n"),
			notes: showBody ? [] : ["端点策略不允许外发：需求正文已撤回"],
			counts: diagnostics.counts,
			details: {
				revision: detail.revision,
				usableAsReference: detail.usableAsReference,
				referenceReasons: detail.referenceReasons,
				withheld: !showBody,
				links: detail.links.map((link) => ({ experienceId: link.experienceId, found: link.found, status: link.status, reason: link.reason })),
				problems: diagnostics.problems,
			},
			fallback: { revision: detail.revision, usableAsReference: detail.usableAsReference, counts: diagnostics.counts, problems: diagnostics.problems, detailsTruncated: true } as Record<string, unknown>,
			budget: resolveModelBudget(),
		});
	},
});

/* ------------------------------------------------------------------ 经验参考 */

export const biosGetExperienceTool = defineTool({
	name: "bios_get_experience",
	label: "BIOS 经验参考",
	promptSnippet: "只读读取受控经验参考；deny/unknown 撤回根因方案，只留来源/验证/缺口",
	description:
		"Read-only cross-project reference view of one experience card: problem/root cause/solution, applies/does-not-apply conditions, declared validation strength and scope, evidence refs, source commit when anchored, and explicit porting limits. Compile-level evidence is never reported as board validation, and a cross-project conclusion is only a porting reference. When the outbound policy is deny/unknown the root cause, solution and conditions are withheld.",
	parameters: Type.Object({
		experienceId: Type.String({ description: "经验卡 ID。" }),
	}),
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		const deps = depsOf(ctx, signal);
		const cancelled = cancelledIfAborted(deps);
		if (cancelled !== null) return cancelled;
		const reason = readinessReason(deps);
		if (reason !== null) return deniedOutcome(deps, reason);
		const view = await readExperienceReference({
			root: deps.call.config.knowledgeRoot as string,
			experienceId: params.experienceId,
			targetProjectId: deps.selection.projectId,
			targetCustomerId: deps.call.config.endpoint.customers[0] ?? null,
			authorization: { endpointAllowed: deps.call.config.endpoint.endpointAllowed, allowInternalGeneral: deps.call.config.endpoint.allowInternalGeneral, customers: deps.call.config.endpoint.customers, authorizedProjectIds: deps.call.config.authorizedProjectIds },
			allowedFeatureIds: deps.call.config.allowedFeatureIds,
			signal: signal ?? deps.call.signal,
		});
		if (view.status !== "ok" || view.reference === null) {
			const diagnostics = projectDiagnostics(view.problems);
			return deniedOutcome(deps, `经验 ${params.experienceId} 不可作为参考（${view.status}）：${view.porting.reasons.join("；") || "未授权或不存在"}`, { recommendation: view.recommendation, problems: diagnostics.problems });
		}
		const showBody = deps.outbound.allowCommercialBody;
		const reference = view.reference;
		const lines = [`经验 ${params.experienceId}（revision ${view.revision}，推荐 ${view.recommendation ?? "-"}，来源项目 ${reference.sourceProjectId}）`];
		if (showBody) {
			lines.push(`根因：${reference.rootCause}`, `方案：${reference.solution}`, `适用：${reference.appliesWhen.join("；") || "（未声明）"}`, `不适用：${reference.doesNotApplyWhen.join("；") || "（未声明）"}`);
		} else {
			lines.push(`根因/方案/适用条件按外发策略撤回（适用 ${reference.appliesWhen.length} 条、不适用 ${reference.doesNotApplyWhen.length} 条）`);
		}
		lines.push(
			`声明验证：${reference.declaredValidations.map((validation) => `${validation.kind}:${validation.result}@${validation.scope}`).join("；") || "（无）"}`,
			`来源 commit：${reference.sourceCommit ?? "未知（没有合法 EvidenceRef）"}`,
			`证据：${reference.evidence.map((entry) => `${entry.type}:${entry.relativePath ?? entry.commit ?? entry.location ?? "（无定位）"}`).join("；") || "（没有声明）"}`,
		);
		for (const reasonLine of view.porting.reasons) lines.push(`- 移植口径：${reasonLine}`);
		const diagnostics = projectDiagnostics(view.problems, { evidence: reference.evidence.length });
		return respond({
			deps,
			status: showBody ? "ok" : "incomplete",
			text: lines.join("\n"),
			notes: showBody ? [] : ["端点策略不允许外发：经验正文已撤回"],
			counts: diagnostics.counts,
			details: {
				revision: view.revision,
				recommendation: view.recommendation,
				reasons: view.reasons,
				declaredValidations: reference.declaredValidations,
				evidence: reference.evidence,
				sourceCommit: reference.sourceCommit,
				porting: view.porting,
				withheld: !showBody,
				problems: diagnostics.problems,
			},
			fallback: { revision: view.revision, recommendation: view.recommendation, counts: diagnostics.counts, problems: diagnostics.problems, detailsTruncated: true } as Record<string, unknown>,
			budget: resolveModelBudget(),
		});
	},
});

/* ------------------------------------------------------------------ 上下文预览 */

export const biosPreviewContextTool = defineTool({
	name: "bios_preview_context",
	label: "BIOS 上下文预览",
	promptSnippet: "只读预览本次有界上下文与来源清单；预算只能收紧，不保存 Manifest",
	description:
		"Read-only preview of the bounded BIOS context the host would hand to a new conversation: project identity, selected task facts, bounded references, gaps and the outbound policy in effect. Budget arguments can only tighten the host cap (12,000 characters / 24 KiB) and are clamped otherwise. It never saves a ContextManifest, never approves anything and never modifies tasks. Not a cross-record atomic snapshot.",
	parameters: Type.Object({
		budgetChars: Type.Optional(Type.Number({ description: "可选：收紧字符预算（只能变小；超过宿主上限会被夹紧）。" })),
		query: Type.Optional(Type.String({ description: "可选：用于挑选参考经验的关键词。" })),
	}),
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		const deps = depsOf(ctx, signal);
		const cancelled = cancelledIfAborted(deps);
		if (cancelled !== null) return cancelled;
		const reason = readinessReason(deps);
		if (reason !== null) return deniedOutcome(deps, reason);
		const projectId = deps.selection.projectId;
		if (projectId === null) return deniedOutcome(deps, "没有已授权的项目选择：请先用 /bios-task 选择任务");
		const unauthorized = projectAuthorized(deps, projectId);
		if (unauthorized !== null) return deniedOutcome(deps, unauthorized);
		if (deps.call.cwd === "") return deniedOutcome(deps, "本次调用没有可用的会话工作目录（ctx.cwd）：不能用进程 cwd 代替");

		const budget = resolveModelBudget(params.budgetChars === undefined ? undefined : { maxChars: params.budgetChars });
		const autoDisable = lastAutoDisableReason();
		const handoff = await buildHandoff({
			root: deps.call.config.knowledgeRoot as string,
			targetProjectId: projectId,
			...(deps.selection.taskId === null ? {} : { taskId: deps.selection.taskId }),
			...(deps.selection.workspaceId === null ? {} : { workspaceId: deps.selection.workspaceId }),
			cwd: deps.call.cwd,
			authorizedRoots: deps.call.authorizedRoots,
			authorizedProjectIds: deps.call.config.authorizedProjectIds,
			endpoint: deps.call.config.endpoint,
			allowedFeatureIds: deps.call.config.allowedFeatureIds,
			...(params.query === undefined ? {} : { query: params.query }),
			budget: { maxChars: budget.maxChars, maxBytes: budget.maxBytes },
			signal: signal ?? deps.call.signal,
		});
		// R32-2：**保留来源**与**检查来源**分开说明；来源清单不是"已注入 Pi"的证明。
		const sourceLine = `来源：本次检查 ${handoff.inspectedSources.length} 个，实际保留在正文 ${handoff.sources.length} 个（保留=进入本次正文；不是"已注入"）`;
		const text = (handoff.text === "" ? `（本次没有可输出的交接正文；缺口：${handoff.problems.join("；")}）` : handoff.text) + `\n${sourceLine}`;
		const diagnostics = projectDiagnostics(handoff.problems, { inspectedSources: handoff.inspectedSources.length, retainedSources: handoff.sources.length, expiredSources: handoff.expiredSources.length });
		return respond({
			deps,
			status: handoff.status === "stale" ? "stale" : handoff.status === "ok" ? "ok" : handoff.status === "not-found" ? "not-found" : handoff.status === "not-authorized" ? "denied" : "incomplete",
			text,
			notes: [handoff.outbound.note, autoDisable].filter((note): note is string => note !== null),
			counts: diagnostics.counts,
			details: {
				// `sources` = **实际保留**（进入正文）的来源；`inspectedSources` = 本次检查过的全部来源。
				sources: handoff.sources.map((source) => ({ recordKind: source.recordKind, recordId: source.recordId, revision: source.revision })),
				retainedSourceCount: handoff.sources.length,
				inspectedSourceCount: handoff.inspectedSources.length,
				inspectedSources: handoff.inspectedSources.map((source) => ({ recordKind: source.recordKind, recordId: source.recordId, revision: source.revision })),
				expiredSources: handoff.expiredSources,
				outbound: handoff.outbound,
				head: handoff.head,
				profileRevision: handoff.profileRevision,
				taskRevision: handoff.taskRevision,
				handoffStatus: handoff.status,
				problems: diagnostics.problems,
			},
			fallback: { handoffStatus: handoff.status, counts: diagnostics.counts, problems: diagnostics.problems, detailsTruncated: true } as Record<string, unknown>,
			budget,
		});
	},
});

/**
 * 领域层把"取消"表达成 `cancelled` 错误（`ProjectServiceError.code` / `AbortError`）：
 * 工具必须把它转成**取消结果**而不是抛给宿主（也不允许改写成 stale/unreadable 之类的业务结论）。
 */
function isCancellation(error: unknown): boolean {
	if (error === null || typeof error !== "object") return false;
	if ((error as { name?: unknown }).name === "AbortError") return true;
	return (error as { code?: unknown }).code === "cancelled";
}

/**
 * 统一包一层取消转换（R32-1/R32-3）：`await` 期间被取消的读取**穿透**成 `cancelled` 结果，
 * 不输出任何已读内容，也不吞成业务结论。其余错误照旧抛出。
 */
function withCancellationGuard<T>(tool: T): T {
	const call = tool as unknown as { readonly execute: (...args: unknown[]) => Promise<unknown> };
	const guarded = {
		...(tool as unknown as Record<string, unknown>),
		async execute(...args: unknown[]): Promise<unknown> {
			try {
				return await call.execute(...args);
			} catch (error) {
				if (!isCancellation(error)) throw error;
				const [toolCallId, , signal, , ctx] = args as [string, unknown, AbortSignal | undefined, unknown, unknown];
				const deps = depsOf(ctx, signal);
				return respond({
					deps,
					status: "cancelled",
					text: "本次 BIOS 读取已取消：未返回任何已读取内容。",
					notes: ["cancelled"],
					details: {},
					fallback: { status: "cancelled", packageName: PACKAGE_NAME, toolCallId },
					budget: resolveModelBudget(),
				});
			}
		},
	};
	return guarded as unknown as T;
}

/** 全部只读工具（供扩展入口装配）。 */
export const biosReadOnlyTools = [biosGetProjectInfoTool, biosGetTaskTool, biosSearchKnowledgeTool, biosGetFeatureTool, biosGetExperienceTool, biosPreviewContextTool].map(withCancellationGuard);
