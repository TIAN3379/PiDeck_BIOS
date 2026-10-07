/**
 * BM-07B B-04：任务**新建/编辑**表单（正文与验证记录）。
 *
 * 约定：
 * - 字段严格对齐 `core/tasks` v1：requirement / decisions / todos / blockers / relatedFiles /
 *   sourceExperienceIds / validations（kind/scope/result/performedAt/performedBy/evidence）；
 *   **不为"表单更完整"新增字段**；
 * - 验收/验证强度不升级：结果只有 passed/failed/inconclusive，"有 commit/编译过"不会被写成 verified；
 * - 状态**不在这里改**（状态变更与正文保存分开）；
 * - 时间用本地时间填写并转 epoch ms；空证据不写入（不编造 hash/行号）；
 * - 验证记录编辑器与 B-05 的经验卡**共用同一个组件**（同一套 schema 与口径）。
 */
import { memo, useEffect, useMemo, useState } from "react";
import { Button } from "../../ui-shadcn/button";
import { Input } from "../../ui-shadcn/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../ui-shadcn/select";
import { Textarea } from "../../ui-shadcn/textarea";
import { t } from "../../../i18n";
import type { TaskValidationInput } from "../../../../../shared/types/biosBusiness";
import type { BiosTaskBodyDraft, BiosTaskCreateDraft } from "../../../hooks/useBiosTasks";
import { BiosValidationEditor } from "../BiosValidationEditor";
import { formatList, parseList, toValidationInput, validationDraftFrom, validationDraftMatchesRecord, validationHasExtraEvidence, type BiosValidationDraft } from "./biosTaskDrafts";

const INPUT_CLASS = "h-7 w-full text-[12px]";

export type BiosTaskFormBaseline = {
	requirement: string;
	decisions: readonly string[];
	todos: readonly string[];
	blockers: readonly string[];
	relatedFiles: readonly string[];
	sourceExperienceIds: readonly string[];
	validations: readonly TaskValidationInput[];
};

export type BiosTaskFormProps = {
	mode: "create" | "edit";
	workspaces: readonly { workspaceId: string; path: string }[];
	/** 编辑模式的既有正文；新建模式传 null。 */
	baseline: BiosTaskFormBaseline | null;
	busy: boolean;
	onCancel: () => void;
	onDirtyChange: (dirty: boolean) => void;
	/** 新建模式使用；编辑模式忽略。 */
	onCreate?: (draft: BiosTaskCreateDraft) => void;
	/** 编辑模式使用；新建模式忽略。 */
	onSave?: (changes: BiosTaskBodyDraft) => void;
};

function Labeled(props: { label: string; children: React.ReactNode }) {
	return (
		<label className="flex flex-col gap-1 text-[11px] text-text-muted">
			{props.label}
			{props.children}
		</label>
	);
}

export const BiosTaskForm = memo(function BiosTaskForm(props: BiosTaskFormProps) {
	const create = props.mode === "create";
	const [taskId, setTaskId] = useState("");
	const [workspaceId, setWorkspaceId] = useState(props.workspaces[0]?.workspaceId ?? "");
	const [branch, setBranch] = useState("");
	const [baseCommit, setBaseCommit] = useState("");
	const [requirement, setRequirement] = useState(props.baseline?.requirement ?? "");
	const [decisions, setDecisions] = useState(formatList(props.baseline?.decisions ?? []));
	const [todos, setTodos] = useState(formatList(props.baseline?.todos ?? []));
	const [blockers, setBlockers] = useState(formatList(props.baseline?.blockers ?? []));
	const [relatedFiles, setRelatedFiles] = useState(formatList(props.baseline?.relatedFiles ?? []));
	const [experienceIds, setExperienceIds] = useState(formatList(props.baseline?.sourceExperienceIds ?? []));
	const [validations, setValidations] = useState<BiosValidationDraft[]>(() => (props.baseline?.validations ?? []).map(validationDraftFrom));
	const [formError, setFormError] = useState<string | null>(null);

	// 未保存检测：与基线逐字段比较（含验证记录），供关闭编辑页前的提示。
	const dirty = useMemo(() => {
		const base = props.baseline;
		if (base === null) {
			return taskId !== "" || workspaceId !== "" || requirement !== "" || decisions !== "" || todos !== "" || blockers !== "" || relatedFiles !== "" || experienceIds !== "" || validations.length > 0;
		}
		return (
			requirement !== base.requirement ||
			decisions !== formatList(base.decisions) ||
			todos !== formatList(base.todos) ||
			blockers !== formatList(base.blockers) ||
			relatedFiles !== formatList(base.relatedFiles) ||
			experienceIds !== formatList(base.sourceExperienceIds) ||
			validations.length !== base.validations.length ||
			validations.some((draft, index) => !validationDraftMatchesRecord(draft, base.validations[index]))
		);
	}, [props.baseline, taskId, workspaceId, requirement, decisions, todos, blockers, relatedFiles, experienceIds, validations]);

	useEffect(() => {
		props.onDirtyChange(dirty);
	}, [dirty, props]);

	function submit() {
		setFormError(null);
		if (create) {
			if (taskId.trim() === "") return setFormError(t("bios.workbench.task.errorTaskId"));
			if (workspaceId.trim() === "") return setFormError(t("bios.workbench.task.errorWorkspace"));
			if (requirement.trim() === "") return setFormError(t("bios.workbench.task.errorRequirement"));
		} else if (requirement.trim() === "") {
			return setFormError(t("bios.workbench.task.errorRequirement"));
		}
		const converted: TaskValidationInput[] = [];
		for (const [index, draft] of validations.entries()) {
			const outcome = toValidationInput(draft);
			if (!outcome.ok) {
				return setFormError(t("bios.workbench.task.errorValidation", { index: index + 1, field: outcome.error }));
			}
			// 本表单只编辑第一条证据；已保存记录里的其余证据**原样保留**，不静默丢弃。
			const extra = (props.baseline?.validations[index]?.evidence ?? []).slice(1);
			converted.push(extra.length === 0 ? (outcome.value as TaskValidationInput) : { ...outcome.value, evidence: [...(outcome.value.evidence ?? []), ...extra] });
		}
		const body = { requirement: requirement.trim(), decisions: parseList(decisions), todos: parseList(todos), blockers: parseList(blockers), relatedFiles: parseList(relatedFiles), sourceExperienceIds: parseList(experienceIds), validations: converted };
		if (create) {
			props.onCreate?.({ taskId: taskId.trim(), workspaceId, branch, baseCommit, ...body });
			return;
		}
		props.onSave?.(body);
	}

	return (
		<section className="flex flex-col gap-2 rounded-md border border-border p-3">
			<div className="font-medium">{create ? t("bios.workbench.task.createTitle") : t("bios.workbench.task.editTitle")}</div>

			{create ? (
				<div className="flex flex-wrap gap-2">
					<Labeled label={t("bios.workbench.task.taskId")}>
						<Input aria-label={t("bios.workbench.task.taskId")} className={INPUT_CLASS} value={taskId} onChange={(event) => setTaskId(event.target.value)} />
					</Labeled>
					<Labeled label={t("bios.workbench.task.workspace")}>
						<Select value={workspaceId} onValueChange={setWorkspaceId}>
							<SelectTrigger aria-label={t("bios.workbench.task.workspace")} className={INPUT_CLASS}>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{props.workspaces.map((workspace) => (
									<SelectItem key={workspace.workspaceId} value={workspace.workspaceId}>
										{workspace.path}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</Labeled>
					<Labeled label={t("bios.workbench.task.branch")}>
						<Input aria-label={t("bios.workbench.task.branch")} className={INPUT_CLASS} value={branch} onChange={(event) => setBranch(event.target.value)} />
					</Labeled>
					<Labeled label={t("bios.workbench.task.baseCommit")}>
						<Input aria-label={t("bios.workbench.task.baseCommit")} className={INPUT_CLASS} value={baseCommit} onChange={(event) => setBaseCommit(event.target.value)} />
					</Labeled>
				</div>
			) : null}

			<Labeled label={t("bios.workbench.task.requirement")}>
				<Textarea aria-label={t("bios.workbench.task.requirement")} className="min-h-16 text-[12px]" value={requirement} onChange={(event) => setRequirement(event.target.value)} />
			</Labeled>
			<div className="grid grid-cols-1 gap-2 md:grid-cols-2">
				<Labeled label={t("bios.workbench.task.todos")}>
					<Textarea className="min-h-14 text-[12px]" value={todos} onChange={(event) => setTodos(event.target.value)} />
				</Labeled>
				<Labeled label={t("bios.workbench.task.blockers")}>
					<Textarea className="min-h-14 text-[12px]" value={blockers} onChange={(event) => setBlockers(event.target.value)} />
				</Labeled>
				<Labeled label={t("bios.workbench.task.decisions")}>
					<Textarea className="min-h-14 text-[12px]" value={decisions} onChange={(event) => setDecisions(event.target.value)} />
				</Labeled>
				<Labeled label={t("bios.workbench.task.relatedFiles")}>
					<Textarea className="min-h-14 text-[12px]" value={relatedFiles} onChange={(event) => setRelatedFiles(event.target.value)} />
				</Labeled>
			</div>
			<Labeled label={t("bios.workbench.task.sourceExperiences")}>
				<Textarea aria-label={t("bios.workbench.task.sourceExperiences")} className="min-h-10 text-[12px]" value={experienceIds} onChange={(event) => setExperienceIds(event.target.value)} />
			</Labeled>

			<BiosValidationEditor validations={validations} busy={props.busy} hasExtraEvidence={validationHasExtraEvidence(props.baseline?.validations ?? [])} onChange={setValidations} />

			{formError !== null ? <div className="break-all text-destructive">{formError}</div> : null}
			<div className="flex flex-wrap gap-2">
				<Button size="sm" disabled={props.busy} onClick={submit}>
					{create ? t("bios.workbench.task.create") : t("bios.workbench.task.save")}
				</Button>
				<Button size="sm" variant="ghost" disabled={props.busy} onClick={props.onCancel}>
					{t("bios.workbench.task.cancelEdit")}
				</Button>
			</div>
		</section>
	);
});
