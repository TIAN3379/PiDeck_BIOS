/** WM-01：AI 整理需求，实际人工确认后写入；不修改宿主授权。 */
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createFeature, updateFeature, readFeatureDetail } from "../core/knowledge/features.ts";
import { readRecord } from "../core/storage/records.ts";
import { confirmWorkflowAction, resolveWorkflowScope, recheckWorkflowScope, requireOnlyKeys, workflowResult, workflowFailure, workflowRecordId, WorkflowError } from "./workflowScope.ts";

export const biosProposeFeatureTool = defineTool({
	name: "bios_propose_feature",
	label: "BIOS 确认客户需求",
	description:
		"Propose a formal requirement and acceptance criteria, then obtain REAL engineer confirmation before CAS write. Create requires a confirmed project customer already approved by host; otherwise return needs-customer-authorization without writing. Existing feature must be explicitly authorized and customer must match current project. IDs generated; never grant access, infer customer from repository, invent acceptance results or silently replace requirements. Use bios_get_feature to read revision before update.",
	parameters: Type.Object(
		{
			featureId: Type.Optional(Type.String({ maxLength: 128 })),
			expectedRevision: Type.Optional(Type.Integer({ minimum: 0 })),
			originalRequirement: Type.String({ minLength: 1, maxLength: 6000 }),
			acceptanceCriteria: Type.Array(Type.String({ maxLength: 2000 }), { minItems: 1, maxItems: 16 }),
			aliases: Type.Optional(Type.Array(Type.String({ maxLength: 300 }), { maxItems: 16 })),
		},
		{ additionalProperties: false },
	),
	async execute(callId, input, signal, _update, ctx) {
		try {
			requireOnlyKeys(input, ["featureId", "expectedRevision", "originalRequirement", "acceptanceCriteria", "aliases"]);
			if (JSON.stringify(input).length > 10_000) throw new WorkflowError("invalid-argument", "需求提案过长，请分解为可逐项确认的需求（本次未写入）");
			const scope = await resolveWorkflowScope(ctx, signal);
			const profile = (await readRecord({ root: scope.root, kind: "project-profile", id: scope.projectId, signal })).record;
			const customer = profile.identity.customer;
			const approved = customer.status === "confirmed" && customer.value !== null && scope.call.config.approvedCustomers.includes(customer.value);
			const featureId = input.featureId ?? workflowRecordId(scope, "feature", callId);
			if (!input.featureId && !approved) throw new WorkflowError("needs-customer-authorization", "需求已可整理为提案；正式入库前，请确认当前项目客户，并在 BIOS 设置批准该客户范围。这是一次关键授权，不必手填需求 ID。未写入记录。");
			if (input.featureId) {
				const detail = await readFeatureDetail({ root: scope.root, featureId, visibility: { allowedFeatureIds: scope.call.config.allowedFeatureIds, approvedCustomers: scope.call.config.approvedCustomers }, signal });
				if (!detail.feature || customer.status !== "confirmed" || detail.feature.customer.value !== customer.value) throw new WorkflowError("not-authorized", "需求未授权或客户与当前项目不一致，不能改写");
				if (input.expectedRevision === undefined) throw new WorkflowError("invalid-argument", "更新需求必须提供刚读到的 revision");
			}
			await confirmWorkflowAction(scope, ctx, `客户：${customer.value}\n${input.featureId ? "修改" : "建立"}需求：${input.originalRequirement}\n验收条件（不是测试结果）：\n${input.acceptanceCriteria.join("\n")}\n别名：${(input.aliases ?? []).join("、")}\n确认后保存；不会扩大任何授权。`);
			await recheckWorkflowScope(scope, ctx);
			const latestProfile = (await readRecord({ root: scope.root, kind: "project-profile", id: scope.projectId, signal })).record;
			if (latestProfile.revision !== profile.revision) throw new WorkflowError("revision-conflict", "确认期间项目身份发生变化，先重读再确认需求");
			const changes = { originalRequirement: input.originalRequirement, acceptanceCriteria: input.acceptanceCriteria, ...(input.aliases === undefined ? {} : { aliases: input.aliases }) };
			const result = input.featureId ? await updateFeature({ root: scope.root, featureId, expectedRevision: input.expectedRevision!, changes, signal }) : await createFeature({ root: scope.root, feature: { featureId, ...changes, customer: { value: customer.value, status: "confirmed" } }, signal });
			return workflowResult(ctx, result.status, result, undefined, scope);
		} catch (error) {
			return workflowFailure(ctx, error);
		}
	},
});
