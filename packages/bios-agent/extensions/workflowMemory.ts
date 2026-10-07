/** WM-02：AI 提出整理方案；整卡退出/恢复必须实际人工逐次确认，保留审计。 */
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { realpath } from "node:fs/promises";
import { readExperienceDetail, reviewExperience } from "../core/knowledge/experiences.ts";
import { workspaceExperienceCards, memoryMaintenanceCandidates, experienceAuditHistory } from "../core/knowledge/maintenance.ts";
import { readHistoryGit } from "../core/projects/historyGit.ts";
import { resolveWorkflowScope, recheckWorkflowScope, confirmWorkflowAction, workflowFailure, workflowResult, requireOnlyKeys, WorkflowError } from "./workflowScope.ts";

export const biosMaintainMemoryTool = defineTool({
	name: "bios_maintain_memory",
	label: "BIOS 记忆维护",
	description:
		"Inspect duplicates/possible conflicts/baseline-review candidates for current registered workspace; no automatic approve/delete/merge. history reads bounded persisted audit transitions. retire deprecates an already reviewed/verified card ONLY after real human confirmation. Optional replacement must be reviewed, same project/workspace/reuse/applicability and explicit revision; audit preserves ID/revision, does not auto-rewrite references. restore returns a retired card to DRAFT, never resurrects verified status. All writes need CAS and actual human dialog. No background/unattended actions.",
	parameters: Type.Object(
		{
			action: Type.Union([Type.Literal("inspect"), Type.Literal("history"), Type.Literal("retire"), Type.Literal("restore")]),
			experienceId: Type.Optional(Type.String({ maxLength: 128 })),
			expectedRevision: Type.Optional(Type.Integer({ minimum: 0 })),
			reason: Type.Optional(Type.String({ maxLength: 250 })),
			replacementId: Type.Optional(Type.String({ maxLength: 128 })),
			replacementRevision: Type.Optional(Type.Integer({ minimum: 0 })),
		},
		{ additionalProperties: false },
	),
	async execute(_id, input, signal, _update, ctx) {
		try {
			requireOnlyKeys(input, ["action", "experienceId", "expectedRevision", "reason", "replacementId", "replacementRevision"]);
			if (!["inspect", "history", "retire", "restore"].includes(input.action)) throw new WorkflowError("invalid-argument", "未知记忆维护动作");
			const scope = await resolveWorkflowScope(ctx, signal);
			if (input.action === "inspect") {
				const listed = await workspaceExperienceCards({ root: scope.root, projectId: scope.projectId, workspaceId: scope.workspaceId, signal });
				let head: string | null = null;
				try {
					const top = (await readHistoryGit(scope.cwd, ["rev-parse", "--show-toplevel"], { signal, maxBuffer: 4096 })).trim();
					if ((await realpath(top)) === scope.cwd) head = (await readHistoryGit(scope.cwd, ["rev-parse", "--verify", "HEAD"], { signal, maxBuffer: 4096 })).trim();
				} catch {
					if (signal?.aborted) throw new WorkflowError("cancelled", "已取消");
				}
				await recheckWorkflowScope(scope, ctx);
				const candidates = memoryMaintenanceCandidates(listed.cards, head);
				const result = { status: listed.incomplete || candidates.length >= 20 ? "incomplete" : "ok", inspected: listed.cards.length, candidates, message: "只发现有界候选，未修改或审核记录；不同 HEAD 不等于经验无效。" };
				return workflowResult(ctx, result.status, result, undefined, scope);
			}
			if (!input.experienceId) throw new WorkflowError("invalid-argument", "需要具名经验");
			const common = { root: scope.root, authorizedProjectIds: scope.call.config.authorizedProjectIds, signal };
			const card = (await readExperienceDetail({ ...common, experienceId: input.experienceId })).card;
			if (!card || card.sourceProjectId !== scope.projectId || !card.evidence.some((ref) => ref.workspaceId === scope.workspaceId)) throw new WorkflowError("not-current-workspace", "只能维护当前项目工作区经验");
			if (input.action === "history") {
				const history = await experienceAuditHistory({ root: scope.root, experienceId: card.id, signal });
				await recheckWorkflowScope(scope, ctx);
				return workflowResult(ctx, history.incomplete ? "incomplete" : "ok", { status: history.incomplete ? "incomplete" : "ok", experienceId: card.id, revision: card.revision, ...history }, undefined, scope);
			}
			if (input.expectedRevision === undefined || !input.reason?.trim()) throw new WorkflowError("invalid-argument", "维护需要当前 revision 和明确理由");
			if (card.revision !== input.expectedRevision) throw new WorkflowError("revision-conflict", "经验已改变，先重读，不强制覆盖");
			let replacement = null;
			if (input.replacementId) {
				replacement = (await readExperienceDetail({ ...common, experienceId: input.replacementId })).card;
				if (
					input.action !== "retire" ||
					!replacement ||
					replacement.id === card.id ||
					replacement.revision !== input.replacementRevision ||
					!["reviewed", "verified"].includes(replacement.status) ||
					replacement.sourceProjectId !== scope.projectId ||
					!replacement.evidence.some((ref) => ref.workspaceId === scope.workspaceId) ||
					JSON.stringify([replacement.reuseScope, [...replacement.appliesWhen].sort(), [...replacement.doesNotApplyWhen].sort()]) !== JSON.stringify([card.reuseScope, [...card.appliesWhen].sort(), [...card.doesNotApplyWhen].sort()])
				)
					throw new WorkflowError("invalid-replacement", "替代目标须为同工作区/同范围/同适用条件的已审核具名版本；不能跨板卡或未知版本自动合并");
			}
			await confirmWorkflowAction(
				scope,
				ctx,
				`${input.action === "retire" ? "退出当前推荐（保留历史）" : "恢复为待审核草稿"}\n${card.problem.slice(0, 600)}\n${card.id} rev${card.revision}\n理由：${input.reason}\n${replacement ? `替代参考：${replacement.id} rev${replacement.revision}\n旧引用不会自动改成新卡。` : "不删除经验、不添加测试结论。"}`,
			);
			await recheckWorkflowScope(scope, ctx);
			if (replacement) {
				const latest = (await readExperienceDetail({ ...common, experienceId: replacement.id })).card;
				if (!latest || latest.revision !== replacement.revision) throw new WorkflowError("revision-conflict", "确认期间替代目标变化，未退出旧卡");
			}
			const result = await reviewExperience({
				...common,
				experienceId: card.id,
				expectedRevision: input.expectedRevision,
				action: input.action === "retire" ? "deprecate" : "restore",
				operatorLabel: "Engineer confirmed via Pi dialog",
				reason: input.reason,
				...(replacement ? { evidence: [{ kind: "external-reference" as const, recordId: replacement.id, note: `replacement revision=${replacement.revision}; same declared scope; references not auto-rewritten` }] } : {}),
			});
			return workflowResult(ctx, result.status, result, undefined, scope);
		} catch (error) {
			return workflowFailure(ctx, error);
		}
	},
});
