/**
 * BM-07B B-02：**人工业务 IPC 域**（`bios:*` 的业务读写部分）。
 *
 * 与 `biosIpc.ts`（只读预览/配置）分开，避免单个 IPC 文件过长；两者共用同一套
 * 会话引用校验与可信配置来源。
 *
 * 三条边界：
 * - renderer 只提交业务 ID / 正文 / expectedRevision / 人工标签；**不接受** root、cwd、
 *   授权集合、workspace 路径、revision/status 等托管字段（主进程装配时解析）；
 * - 嵌套草稿对象**逐字段挑选**：只放行 schema 里允许的字段，杜绝"多塞一个 revision";
 * - 所有写入都带 `expectedRevision`（CAS），结果保留 core 判别式，不用 `ok` 布尔吞掉分步事实。
 */
import { dialog, ipcMain } from "electron";
import { ipcChannels } from "../../shared/ipc";
import type {
	BiosBackupPickPurpose,
	BiosBindRequest,
	BiosBusinessRequestBase,
	BiosConfirmRequest,
	BiosDetectRequest,
	BiosDraftPrefillRequest,
	BiosDraftSaveRequest,
	BiosExportBackupRequest,
	BiosRestoreBackupRequest,
	BiosExperienceCreateRequest,
	BiosExperienceDetailRequest,
	BiosExperienceReviewRequest,
	BiosExperienceUpdateRequest,
	BiosFeatureCreateRequest,
	BiosFeatureDetailRequest,
	BiosFeatureUpdateRequest,
	BiosInitializeRequest,
	BiosManifestSaveRequest,
	BiosManifestVerifyRequest,
	BiosProjectViewRequest,
	BiosReferenceRequest,
	BiosSearchRequest,
	BiosTaskCreateRequest,
	BiosTaskDetailRequest,
	BiosTaskStatusRequest,
	BiosTaskUpdateRequest,
} from "../../shared/types/biosBusiness";
import type { AuditAction, ExperienceDraft, ExperienceEvidenceInput, ExperienceStatus, ExperienceValidationInput, FeatureDraft, FeatureFieldInput, TaskChanges, TaskEvidenceInput, TaskStatus, TaskValidationInput } from "../../shared/types/biosBusiness";
import type { BiosBusinessService } from "../bios/BiosBusinessService";
import type { AppLogger } from "../logging/AppLogger";

/** 单条短文本上限（正文类字段另有各自的领域上限，由 core 校验）。 */
const MAX_TEXT = 20_000;
const MAX_LIST = 200;
const MAX_SHORT = 400;

/** 对话框缺省标题（按用途区分：备份/恢复各自的目标语义不同，不能共用一个"选择目录"）。 */
const BACKUP_PICK_TITLES: Record<BiosBackupPickPurpose, string> = {
	"export-parent": "选择备份的父目录（将在其下新建一个备份文件夹）",
	"restore-source": "选择已完成的备份文件夹（含 manifest.json 与 data）",
	"restore-target-parent": "选择恢复目标的父目录（将在其下新建一个知识库目录）",
};

export type BiosBusinessIpcDeps = {
	business: BiosBusinessService;
	appLogger: AppLogger;
};

/* ------------------------------------------------------------ 基础校验 */

function requireObject(input: unknown, label: string): Record<string, unknown> {
	if (input === null || typeof input !== "object" || Array.isArray(input)) throw new Error(`${label} 必须是对象`);
	return input as Record<string, unknown>;
}

function requireText(value: unknown, label: string, max = MAX_TEXT): string {
	if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} 必须是非空字符串`);
	if (value.length > max) throw new Error(`${label} 超过长度上限（${max}）`);
	return value;
}

function optionalText(value: unknown, label: string, max = MAX_TEXT): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") throw new Error(`${label} 必须是字符串`);
	if (value.length > max) throw new Error(`${label} 超过长度上限（${max}）`);
	return value;
}

function optionalShort(value: unknown, label: string): string | undefined {
	return optionalText(value, label, MAX_SHORT);
}

function requireInt(value: unknown, label: string, minimum = 0): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) throw new Error(`${label} 必须是不小于 ${minimum} 的整数`);
	return value;
}

function optionalInt(value: unknown, label: string, minimum = 0): number | undefined {
	if (value === undefined || value === null) return undefined;
	return requireInt(value, label, minimum);
}

function stringList(value: unknown, label: string): string[] | undefined {
	if (value === undefined || value === null) return undefined;
	if (!Array.isArray(value)) throw new Error(`${label} 必须是字符串数组`);
	if (value.length > MAX_LIST) throw new Error(`${label} 超过条目上限（${MAX_LIST}）`);
	return value.map((entry, index) => requireText(entry, `${label}[${index}]`, MAX_SHORT));
}

function requireStringList(value: unknown, label: string): string[] {
	const list = stringList(value, label);
	if (list === undefined) throw new Error(`${label} 必须是字符串数组`);
	return list;
}

function requireSessionPart(input: Record<string, unknown>): BiosBusinessRequestBase {
	const ref = requireObject(input.sessionRef, "sessionRef");
	const sessionRef = { agentId: requireText(ref.agentId, "sessionRef.agentId", 200), sessionId: typeof ref.sessionId === "string" && ref.sessionId.trim() !== "" ? ref.sessionId.trim() : null };
	return { sessionRef, runtimeGeneration: requireInt(input.runtimeGeneration, "runtimeGeneration") };
}

function operatorLabel(input: Record<string, unknown>): { operatorLabel?: string } {
	const label = optionalShort(input.operatorLabel, "operatorLabel");
	return label === undefined ? {} : { operatorLabel: label };
}

/* ------------------------------------------------------------ 嵌套草稿挑选 */

const VALIDATION_KINDS = new Set(["code-review", "compile", "board-boot", "stress-loop", "customer-acceptance"]);
const VALIDATION_RESULTS = new Set(["passed", "failed", "inconclusive"]);
const EVIDENCE_TYPES = new Set(["source-file", "commit", "document", "session", "human-note"]);
const TASK_STATUSES = new Set(["planned", "in_progress", "blocked", "done", "archived"]);
const AUDIT_ACTIONS = new Set(["submit-review", "request-changes", "approve", "deprecate", "restore"]);
const EXPERIENCE_STATUSES = new Set(["draft", "reviewed", "verified", "deprecated"]);

function pickEnum<T extends string>(value: unknown, label: string, allowed: Set<string>): T {
	if (typeof value !== "string" || !allowed.has(value)) throw new Error(`${label} 不在允许的取值内（${[...allowed].join("/")}）`);
	return value as T;
}

function pickEvidence(value: unknown, label: string): ExperienceEvidenceInput {
	const raw = requireObject(value, label);
	return {
		type: pickEnum(raw.type, `${label}.type`, EVIDENCE_TYPES),
		...(optionalShort(raw.workspaceId, `${label}.workspaceId`) === undefined ? {} : { workspaceId: optionalShort(raw.workspaceId, `${label}.workspaceId`) }),
		...(optionalShort(raw.relativePath, `${label}.relativePath`) === undefined ? {} : { relativePath: optionalShort(raw.relativePath, `${label}.relativePath`) }),
		...(optionalShort(raw.location, `${label}.location`) === undefined ? {} : { location: optionalShort(raw.location, `${label}.location`) }),
		...(optionalShort(raw.commit, `${label}.commit`) === undefined ? {} : { commit: optionalShort(raw.commit, `${label}.commit`) }),
		...(optionalShort(raw.contentHash, `${label}.contentHash`) === undefined ? {} : { contentHash: optionalShort(raw.contentHash, `${label}.contentHash`) }),
	};
}

function pickEvidenceList(value: unknown, label: string): ExperienceEvidenceInput[] | undefined {
	if (value === undefined || value === null) return undefined;
	if (!Array.isArray(value)) throw new Error(`${label} 必须是数组`);
	if (value.length > MAX_LIST) throw new Error(`${label} 超过条目上限`);
	return value.map((entry, index) => pickEvidence(entry, `${label}[${index}]`));
}

function pickValidation(value: unknown, label: string): ExperienceValidationInput {
	const raw = requireObject(value, label);
	const evidence = pickEvidenceList(raw.evidence, `${label}.evidence`);
	return {
		kind: pickEnum(raw.kind, `${label}.kind`, VALIDATION_KINDS),
		scope: requireText(raw.scope, `${label}.scope`, MAX_SHORT),
		result: pickEnum(raw.result, `${label}.result`, VALIDATION_RESULTS),
		performedAt: requireInt(raw.performedAt, `${label}.performedAt`),
		performedBy: requireText(raw.performedBy, `${label}.performedBy`, MAX_SHORT),
		...(evidence === undefined ? {} : { evidence }),
	};
}

function pickValidationList(value: unknown, label: string): ExperienceValidationInput[] | undefined {
	if (value === undefined || value === null) return undefined;
	if (!Array.isArray(value)) throw new Error(`${label} 必须是数组`);
	if (value.length > MAX_LIST) throw new Error(`${label} 超过条目上限`);
	return value.map((entry, index) => pickValidation(entry, `${label}[${index}]`));
}

function pickFeatureFieldInput(value: unknown, label: string): FeatureFieldInput {
	const raw = requireObject(value, label);
	const status = pickEnum<FeatureFieldInput["status"]>(raw.status, `${label}.status`, new Set(["candidate", "confirmed"]));
	const fieldValue = raw.value === null || raw.value === undefined ? null : requireText(raw.value, `${label}.value`, MAX_SHORT);
	return {
		value: fieldValue,
		status,
		...(optionalShort(raw.relativePath, `${label}.relativePath`) === undefined ? {} : { relativePath: optionalShort(raw.relativePath, `${label}.relativePath`) }),
		...(optionalShort(raw.contentHash, `${label}.contentHash`) === undefined ? {} : { contentHash: optionalShort(raw.contentHash, `${label}.contentHash`) }),
		...(optionalShort(raw.workspaceId, `${label}.workspaceId`) === undefined ? {} : { workspaceId: optionalShort(raw.workspaceId, `${label}.workspaceId`) }),
	};
}

function pickFeatureDraft(value: unknown, label: string): FeatureDraft {
	const raw = requireObject(value, label);
	const aliases = stringList(raw.aliases, `${label}.aliases`);
	const acceptanceCriteria = stringList(raw.acceptanceCriteria, `${label}.acceptanceCriteria`);
	const relatedExperienceIds = stringList(raw.relatedExperienceIds, `${label}.relatedExperienceIds`);
	return {
		featureId: requireText(raw.featureId, `${label}.featureId`, MAX_SHORT),
		originalRequirement: requireText(raw.originalRequirement, `${label}.originalRequirement`),
		...(aliases === undefined ? {} : { aliases }),
		...(raw.customer === undefined || raw.customer === null ? {} : { customer: pickFeatureFieldInput(raw.customer, `${label}.customer`) }),
		...(raw.productLine === undefined || raw.productLine === null ? {} : { productLine: pickFeatureFieldInput(raw.productLine, `${label}.productLine`) }),
		...(acceptanceCriteria === undefined ? {} : { acceptanceCriteria }),
		...(relatedExperienceIds === undefined ? {} : { relatedExperienceIds }),
	};
}

/** 需求**部分更新**：只挑选请求里实际出现的字段（不出现的不校验、不改动）。 */
export function pickFeatureChanges(value: unknown, label: string): Partial<Omit<FeatureDraft, "featureId">> {
	const raw = requireObject(value, label);
	const aliases = stringList(raw.aliases, `${label}.aliases`);
	const acceptanceCriteria = stringList(raw.acceptanceCriteria, `${label}.acceptanceCriteria`);
	const relatedExperienceIds = stringList(raw.relatedExperienceIds, `${label}.relatedExperienceIds`);
	return {
		...(raw.originalRequirement === undefined ? {} : { originalRequirement: requireText(raw.originalRequirement, `${label}.originalRequirement`) }),
		...(aliases === undefined ? {} : { aliases }),
		...(raw.customer === undefined ? {} : { customer: pickFeatureFieldInput(raw.customer, `${label}.customer`) }),
		...(raw.productLine === undefined ? {} : { productLine: pickFeatureFieldInput(raw.productLine, `${label}.productLine`) }),
		...(acceptanceCriteria === undefined ? {} : { acceptanceCriteria }),
		...(relatedExperienceIds === undefined ? {} : { relatedExperienceIds }),
	};
}

/** 复用范围（新建/更新共用）。 */
function pickReuse(value: unknown, label: string): ExperienceDraft["reuse"] {
	if (value === undefined || value === null) return undefined;
	const raw = requireObject(value, label);
	const customers = stringList(raw.customers, `${label}.customers`);
	const authorization = optionalShort(raw.authorization, `${label}.authorization`);
	return { level: pickEnum<"current-project" | "customer" | "internal-general">(raw.level, `${label}.level`, new Set(["current-project", "customer", "internal-general"])), ...(customers === undefined ? {} : { customers }), ...(authorization === undefined ? {} : { authorization }) };
}

function pickExperienceDraft(value: unknown, label: string): ExperienceDraft {
	const raw = requireObject(value, label);
	const applies = stringList(raw.appliesWhen, `${label}.appliesWhen`);
	const notApplies = stringList(raw.doesNotApplyWhen, `${label}.doesNotApplyWhen`);
	const validations = pickValidationList(raw.validations, `${label}.validations`);
	const evidence = pickEvidenceList(raw.evidence, `${label}.evidence`);
	const reuse = pickReuse(raw.reuse, `${label}.reuse`);
	return {
		experienceId: requireText(raw.experienceId, `${label}.experienceId`, MAX_SHORT),
		problem: requireText(raw.problem, `${label}.problem`),
		...(optionalText(raw.symptom, `${label}.symptom`) === undefined ? {} : { symptom: optionalText(raw.symptom, `${label}.symptom`) }),
		rootCause: requireText(raw.rootCause, `${label}.rootCause`),
		solution: requireText(raw.solution, `${label}.solution`),
		...(applies === undefined ? {} : { appliesWhen: applies }),
		...(notApplies === undefined ? {} : { doesNotApplyWhen: notApplies }),
		// 来源项目必须显式给出，且随后由服务核对授权；更新路径不接受改动（见 pickExperienceChanges）。
		sourceProjectId: requireText(raw.sourceProjectId, `${label}.sourceProjectId`, MAX_SHORT),
		...(optionalShort(raw.featureId, `${label}.featureId`) === undefined ? {} : { featureId: optionalShort(raw.featureId, `${label}.featureId`) }),
		...(validations === undefined ? {} : { validations }),
		...(evidence === undefined ? {} : { evidence }),
		...(reuse === undefined ? {} : { reuse }),
	};
}

/**
 * 任务沉淀草稿：来源项目由**任务所属项目**决定（不采纳请求里的 sourceProjectId），
 * 因此这里不要求该字段，返回的表单体也不带它。
 */
function pickDraftExperience(value: unknown, label: string): Omit<ExperienceDraft, "sourceProjectId"> {
	const raw = requireObject(value, label);
	const applies = stringList(raw.appliesWhen, `${label}.appliesWhen`);
	const notApplies = stringList(raw.doesNotApplyWhen, `${label}.doesNotApplyWhen`);
	const validations = pickValidationList(raw.validations, `${label}.validations`);
	const evidence = pickEvidenceList(raw.evidence, `${label}.evidence`);
	const reuse = pickReuse(raw.reuse, `${label}.reuse`);
	const featureId = optionalShort(raw.featureId, `${label}.featureId`);
	return {
		experienceId: requireText(raw.experienceId, `${label}.experienceId`, MAX_SHORT),
		problem: requireText(raw.problem, `${label}.problem`),
		...(optionalText(raw.symptom, `${label}.symptom`) === undefined ? {} : { symptom: optionalText(raw.symptom, `${label}.symptom`) }),
		rootCause: requireText(raw.rootCause, `${label}.rootCause`),
		solution: requireText(raw.solution, `${label}.solution`),
		...(applies === undefined ? {} : { appliesWhen: applies }),
		...(notApplies === undefined ? {} : { doesNotApplyWhen: notApplies }),
		...(featureId === undefined ? {} : { featureId }),
		...(validations === undefined ? {} : { validations }),
		...(evidence === undefined ? {} : { evidence }),
		...(reuse === undefined ? {} : { reuse }),
	};
}

/** 经验**部分更新**：只挑选请求里实际出现的字段；不接受 `experienceId`/`sourceProjectId` 改动。 */
export function pickExperienceChanges(value: unknown, label: string): Partial<Omit<ExperienceDraft, "experienceId" | "sourceProjectId">> {
	const raw = requireObject(value, label);
	const applies = stringList(raw.appliesWhen, `${label}.appliesWhen`);
	const notApplies = stringList(raw.doesNotApplyWhen, `${label}.doesNotApplyWhen`);
	const validations = pickValidationList(raw.validations, `${label}.validations`);
	const evidence = pickEvidenceList(raw.evidence, `${label}.evidence`);
	const reuse = pickReuse(raw.reuse, `${label}.reuse`);
	return {
		...(raw.problem === undefined ? {} : { problem: requireText(raw.problem, `${label}.problem`) }),
		...(raw.symptom === undefined ? {} : { symptom: optionalText(raw.symptom, `${label}.symptom`) }),
		...(raw.rootCause === undefined ? {} : { rootCause: requireText(raw.rootCause, `${label}.rootCause`) }),
		...(raw.solution === undefined ? {} : { solution: requireText(raw.solution, `${label}.solution`) }),
		...(applies === undefined ? {} : { appliesWhen: applies }),
		...(notApplies === undefined ? {} : { doesNotApplyWhen: notApplies }),
		...(raw.featureId === undefined ? {} : { featureId: optionalShort(raw.featureId, `${label}.featureId`) }),
		...(validations === undefined ? {} : { validations }),
		...(evidence === undefined ? {} : { evidence }),
		...(reuse === undefined ? {} : { reuse }),
	};
}

function pickTaskEvidence(value: unknown, label: string): TaskEvidenceInput {
	const raw = requireObject(value, label);
	return {
		type: pickEnum(raw.type, `${label}.type`, EVIDENCE_TYPES),
		...(optionalShort(raw.relativePath, `${label}.relativePath`) === undefined ? {} : { relativePath: optionalShort(raw.relativePath, `${label}.relativePath`) }),
		...(optionalShort(raw.contentHash, `${label}.contentHash`) === undefined ? {} : { contentHash: optionalShort(raw.contentHash, `${label}.contentHash`) }),
		...(optionalShort(raw.workspaceId, `${label}.workspaceId`) === undefined ? {} : { workspaceId: optionalShort(raw.workspaceId, `${label}.workspaceId`) }),
		...(optionalShort(raw.commit, `${label}.commit`) === undefined ? {} : { commit: optionalShort(raw.commit, `${label}.commit`) }),
		...(optionalShort(raw.location, `${label}.location`) === undefined ? {} : { location: optionalShort(raw.location, `${label}.location`) }),
	};
}

function pickTaskValidations(value: unknown, label: string): TaskValidationInput[] | undefined {
	if (value === undefined || value === null) return undefined;
	if (!Array.isArray(value)) throw new Error(`${label} 必须是数组`);
	if (value.length > MAX_LIST) throw new Error(`${label} 超过条目上限`);
	return value.map((entry, index) => {
		const raw = requireObject(entry, `${label}[${index}]`);
		const evidence =
			raw.evidence === undefined || raw.evidence === null
				? undefined
				: Array.isArray(raw.evidence)
					? raw.evidence.map((item, i) => pickTaskEvidence(item, `${label}[${index}].evidence[${i}]`))
					: (() => {
							throw new Error(`${label}[${index}].evidence 必须是数组`);
						})();
		return {
			kind: pickEnum(raw.kind, `${label}[${index}].kind`, VALIDATION_KINDS),
			scope: requireText(raw.scope, `${label}[${index}].scope`, MAX_SHORT),
			result: pickEnum(raw.result, `${label}[${index}].result`, VALIDATION_RESULTS),
			performedAt: requireInt(raw.performedAt, `${label}[${index}].performedAt`),
			performedBy: requireText(raw.performedBy, `${label}[${index}].performedBy`, MAX_SHORT),
			...(evidence === undefined ? {} : { evidence }),
		};
	});
}

function pickTaskChanges(value: unknown, label: string): TaskChanges {
	const raw = requireObject(value, label);
	const validations = pickTaskValidations(raw.validations, `${label}.validations`);
	return {
		...(optionalText(raw.requirement, `${label}.requirement`) === undefined ? {} : { requirement: optionalText(raw.requirement, `${label}.requirement`) as string }),
		...(stringList(raw.decisions, `${label}.decisions`) === undefined ? {} : { decisions: stringList(raw.decisions, `${label}.decisions`) }),
		...(stringList(raw.todos, `${label}.todos`) === undefined ? {} : { todos: stringList(raw.todos, `${label}.todos`) }),
		...(stringList(raw.blockers, `${label}.blockers`) === undefined ? {} : { blockers: stringList(raw.blockers, `${label}.blockers`) }),
		...(stringList(raw.relatedFiles, `${label}.relatedFiles`) === undefined ? {} : { relatedFiles: stringList(raw.relatedFiles, `${label}.relatedFiles`) }),
		...(stringList(raw.sourceExperienceIds, `${label}.sourceExperienceIds`) === undefined ? {} : { sourceExperienceIds: stringList(raw.sourceExperienceIds, `${label}.sourceExperienceIds`) }),
		...(validations === undefined ? {} : { validations }),
	};
}

/* ------------------------------------------------------------ 注册 */

export function registerBiosBusinessIpc(deps: BiosBusinessIpcDeps): () => void {
	const { business, appLogger } = deps;

	ipcMain.handle(ipcChannels.biosStoreStatus, async () => business.storeStatus());

	ipcMain.handle(ipcChannels.biosInitializeStore, async (_event, raw: unknown) => {
		const input = requireObject(raw, "初始化请求") as unknown as BiosInitializeRequest;
		const request: BiosInitializeRequest = { knowledgeRoot: requireText(input.knowledgeRoot, "knowledgeRoot") };
		return business.initialize(request);
	});

	ipcMain.handle(ipcChannels.biosBindProject, async (_event, raw: unknown) => {
		const input = requireObject(raw, "绑定请求");
		const request: BiosBindRequest = {
			desktopProjectId: requireText(input.desktopProjectId, "desktopProjectId", MAX_SHORT),
			biosProjectId: requireText(input.biosProjectId, "biosProjectId", MAX_SHORT),
			...(optionalShort(input.workspaceId, "workspaceId") === undefined ? {} : { workspaceId: optionalShort(input.workspaceId, "workspaceId") }),
			...(optionalShort(input.displayName, "displayName") === undefined ? {} : { displayName: optionalShort(input.displayName, "displayName") }),
			...operatorLabel(input),
		};
		const outcome = await business.bindProject(request);
		appLogger.info("bios", `项目绑定：${outcome.result.status}（提交=${outcome.committed}）`);
		return outcome;
	});

	ipcMain.handle(ipcChannels.biosDetectProject, async (_event, raw: unknown) => {
		const input = requireObject(raw, "检测请求");
		const request: BiosDetectRequest = {
			desktopProjectId: requireText(input.desktopProjectId, "desktopProjectId", MAX_SHORT),
			biosProjectId: requireText(input.biosProjectId, "biosProjectId", MAX_SHORT),
			...(optionalShort(input.workspaceId, "workspaceId") === undefined ? {} : { workspaceId: optionalShort(input.workspaceId, "workspaceId") }),
		};
		return business.detectCandidates(request);
	});

	ipcMain.handle(ipcChannels.biosConfirmProfile, async (_event, raw: unknown) => {
		const input = requireObject(raw, "确认请求");
		const valuesRaw = input.values;
		if (!Array.isArray(valuesRaw) || valuesRaw.length === 0) throw new Error("values 必须是非空数组");
		if (valuesRaw.length > MAX_LIST) throw new Error("values 超过条目上限");
		const request: BiosConfirmRequest = {
			biosProjectId: requireText(input.biosProjectId, "biosProjectId", MAX_SHORT),
			...(optionalShort(input.workspaceId, "workspaceId") === undefined ? {} : { workspaceId: optionalShort(input.workspaceId, "workspaceId") }),
			expectedProfileRevision: requireInt(input.expectedProfileRevision, "expectedProfileRevision"),
			values: valuesRaw.map((entry, index) => {
				const item = requireObject(entry, `values[${index}]`);
				const evidenceRaw = item.evidence;
				const evidence =
					evidenceRaw === undefined || evidenceRaw === null
						? undefined
						: Array.isArray(evidenceRaw)
							? evidenceRaw.map((e, i) => {
									const rawEvidence = requireObject(e, `values[${index}].evidence[${i}]`);
									return { relativePath: requireText(rawEvidence.relativePath, `values[${index}].evidence[${i}].relativePath`, MAX_SHORT), contentHash: requireText(rawEvidence.contentHash, `values[${index}].evidence[${i}].contentHash`, 200) };
								})
							: (() => {
									throw new Error(`values[${index}].evidence 必须是数组`);
								})();
				return { field: requireText(item.field, `values[${index}].field`, MAX_SHORT), value: item.value === null || item.value === undefined ? null : requireText(item.value, `values[${index}].value`, MAX_SHORT), ...(evidence === undefined ? {} : { evidence }) };
			}),
			...operatorLabel(input),
		};
		const outcome = await business.confirmProfile(request);
		appLogger.info("bios", `项目字段确认：${outcome.result.status}（提交=${outcome.committed}）`);
		return outcome;
	});

	ipcMain.handle(ipcChannels.biosReadProjectView, async (_event, raw: unknown) => {
		const input = requireObject(raw, "项目视图请求");
		const request: BiosProjectViewRequest = { biosProjectId: requireText(input.biosProjectId, "biosProjectId", MAX_SHORT), ...(optionalShort(input.desktopProjectId, "desktopProjectId") === undefined ? {} : { desktopProjectId: optionalShort(input.desktopProjectId, "desktopProjectId") }) };
		return business.readProjectView(request);
	});

	ipcMain.handle(ipcChannels.biosReadTaskDetail, async (_event, raw: unknown) => {
		const input = requireObject(raw, "任务详情请求");
		const request: BiosTaskDetailRequest = { ...requireSessionPart(input), projectId: requireText(input.projectId, "projectId", MAX_SHORT), taskId: requireText(input.taskId, "taskId", MAX_SHORT) };
		return business.readTaskDetail(request);
	});

	ipcMain.handle(ipcChannels.biosCreateTask, async (_event, raw: unknown) => {
		const input = requireObject(raw, "新建任务请求");
		const request: BiosTaskCreateRequest = {
			...requireSessionPart(input),
			...operatorLabel(input),
			projectId: requireText(input.projectId, "projectId", MAX_SHORT),
			taskId: requireText(input.taskId, "taskId", MAX_SHORT),
			workspaceId: requireText(input.workspaceId, "workspaceId", MAX_SHORT),
			requirement: requireText(input.requirement, "requirement"),
			...(optionalShort(input.branch, "branch") === undefined ? {} : { branch: optionalShort(input.branch, "branch") }),
			...(optionalShort(input.baseCommit, "baseCommit") === undefined ? {} : { baseCommit: optionalShort(input.baseCommit, "baseCommit") }),
			...(stringList(input.decisions, "decisions") === undefined ? {} : { decisions: stringList(input.decisions, "decisions") }),
			...(stringList(input.todos, "todos") === undefined ? {} : { todos: stringList(input.todos, "todos") }),
			...(stringList(input.blockers, "blockers") === undefined ? {} : { blockers: stringList(input.blockers, "blockers") }),
			...(stringList(input.relatedFiles, "relatedFiles") === undefined ? {} : { relatedFiles: stringList(input.relatedFiles, "relatedFiles") }),
			...(stringList(input.sourceExperienceIds, "sourceExperienceIds") === undefined ? {} : { sourceExperienceIds: stringList(input.sourceExperienceIds, "sourceExperienceIds") }),
			...(pickTaskValidations(input.validations, "validations") === undefined ? {} : { validations: pickTaskValidations(input.validations, "validations") }),
		};
		const outcome = await business.createTask(request);
		appLogger.info("bios", `新建任务：${outcome.result.status}（提交=${outcome.committed}）`);
		return outcome;
	});

	ipcMain.handle(ipcChannels.biosUpdateTask, async (_event, raw: unknown) => {
		const input = requireObject(raw, "更新任务请求");
		const request: BiosTaskUpdateRequest = {
			...requireSessionPart(input),
			...operatorLabel(input),
			projectId: requireText(input.projectId, "projectId", MAX_SHORT),
			taskId: requireText(input.taskId, "taskId", MAX_SHORT),
			expectedRevision: requireInt(input.expectedRevision, "expectedRevision"),
			changes: pickTaskChanges(input.changes, "changes"),
		};
		const outcome = await business.updateTask(request);
		appLogger.info("bios", `更新任务：${outcome.result.status}（提交=${outcome.committed}）`);
		return outcome;
	});

	ipcMain.handle(ipcChannels.biosChangeTaskStatus, async (_event, raw: unknown) => {
		const input = requireObject(raw, "任务状态请求");
		const request: BiosTaskStatusRequest = {
			...requireSessionPart(input),
			...operatorLabel(input),
			projectId: requireText(input.projectId, "projectId", MAX_SHORT),
			taskId: requireText(input.taskId, "taskId", MAX_SHORT),
			expectedRevision: requireInt(input.expectedRevision, "expectedRevision"),
			to: pickEnum<TaskStatus>(input.to, "to", TASK_STATUSES),
			reason: requireText(input.reason, "reason", MAX_SHORT),
		};
		const outcome = await business.changeTaskStatus(request);
		appLogger.info("bios", `任务状态：${outcome.result.status}（提交=${outcome.committed}）`);
		return outcome;
	});

	ipcMain.handle(ipcChannels.biosCreateFeature, async (_event, raw: unknown) => {
		const input = requireObject(raw, "新建需求请求");
		const request: BiosFeatureCreateRequest = { ...requireSessionPart(input), ...operatorLabel(input), feature: pickFeatureDraft(input.feature, "feature") };

		const outcome = await business.createFeature(request);
		appLogger.info("bios", `新建需求：${outcome.result.status}（提交=${outcome.committed}）`);
		return outcome;
	});

	ipcMain.handle(ipcChannels.biosUpdateFeature, async (_event, raw: unknown) => {
		const input = requireObject(raw, "更新需求请求");
		const request: BiosFeatureUpdateRequest = {
			...requireSessionPart(input),
			...operatorLabel(input),
			// featureId 只取路径参数：请求体里的同名/其它托管字段不参与更新。
			featureId: requireText(input.featureId, "featureId", MAX_SHORT),
			expectedRevision: requireInt(input.expectedRevision, "expectedRevision"),
			changes: pickFeatureChanges(input.changes, "changes"),
		};
		const outcome = await business.updateFeature(request);
		appLogger.info("bios", `更新需求：${outcome.result.status}（提交=${outcome.committed}）`);
		return outcome;
	});

	ipcMain.handle(ipcChannels.biosReadFeatureDetail, async (_event, raw: unknown) => {
		const input = requireObject(raw, "需求详情请求");
		const request: BiosFeatureDetailRequest = { ...requireSessionPart(input), featureId: requireText(input.featureId, "featureId", MAX_SHORT) };
		return business.readFeatureDetail(request);
	});

	ipcMain.handle(ipcChannels.biosCreateExperience, async (_event, raw: unknown) => {
		const input = requireObject(raw, "新建经验请求");
		const request: BiosExperienceCreateRequest = { ...requireSessionPart(input), ...operatorLabel(input), experience: pickExperienceDraft(input.experience, "experience") };
		const outcome = await business.createExperienceDraft(request);
		appLogger.info("bios", `新建经验草稿：${outcome.result.status}（提交=${outcome.committed}）`);
		return outcome;
	});

	ipcMain.handle(ipcChannels.biosUpdateExperience, async (_event, raw: unknown) => {
		const input = requireObject(raw, "更新经验请求");
		const request: BiosExperienceUpdateRequest = {
			...requireSessionPart(input),
			...operatorLabel(input),
			experienceId: requireText(input.experienceId, "experienceId", MAX_SHORT),
			expectedRevision: requireInt(input.expectedRevision, "expectedRevision"),
			changes: pickExperienceChanges(input.changes, "changes"),
		};
		const outcome = await business.updateExperienceDraft(request);
		appLogger.info("bios", `更新经验：${outcome.result.status}（提交=${outcome.committed}）`);
		return outcome;
	});

	ipcMain.handle(ipcChannels.biosReadExperienceDetail, async (_event, raw: unknown) => {
		const input = requireObject(raw, "经验详情请求");
		const request: BiosExperienceDetailRequest = { ...requireSessionPart(input), experienceId: requireText(input.experienceId, "experienceId", MAX_SHORT) };
		return business.readExperienceDetail(request);
	});

	ipcMain.handle(ipcChannels.biosReviewExperience, async (_event, raw: unknown) => {
		const input = requireObject(raw, "审核请求");
		const request: BiosExperienceReviewRequest = {
			...requireSessionPart(input),
			...operatorLabel(input),
			experienceId: requireText(input.experienceId, "experienceId", MAX_SHORT),
			expectedRevision: requireInt(input.expectedRevision, "expectedRevision"),
			action: pickEnum<AuditAction>(input.action, "action", AUDIT_ACTIONS),
			reason: requireText(input.reason, "reason", MAX_SHORT),
		};
		const outcome = await business.reviewExperience(request);
		appLogger.info("bios", `经验审核：${input.action as string} -> ${outcome.result.status}（提交=${outcome.committed}）`);
		return outcome;
	});

	ipcMain.handle(ipcChannels.biosSearchKnowledge, async (_event, raw: unknown) => {
		const input = requireObject(raw, "检索请求");
		const statusesRaw = input.statuses;
		const request: BiosSearchRequest = {
			...requireSessionPart(input),
			query: requireText(input.query, "query", MAX_SHORT),
			...(optionalShort(input.projectId, "projectId") === undefined ? {} : { projectId: optionalShort(input.projectId, "projectId") }),
			...(optionalShort(input.workspaceId, "workspaceId") === undefined ? {} : { workspaceId: optionalShort(input.workspaceId, "workspaceId") }),
			...(input.customerId === undefined ? {} : { customerId: input.customerId === null ? null : requireText(input.customerId, "customerId", MAX_SHORT) }),
			...(optionalShort(input.boardName, "boardName") === undefined ? {} : { boardName: optionalShort(input.boardName, "boardName") }),
			...(optionalShort(input.boardRevision, "boardRevision") === undefined ? {} : { boardRevision: optionalShort(input.boardRevision, "boardRevision") }),
			...(optionalShort(input.buildTarget, "buildTarget") === undefined ? {} : { buildTarget: optionalShort(input.buildTarget, "buildTarget") }),
			...(optionalShort(input.commit, "commit") === undefined ? {} : { commit: optionalShort(input.commit, "commit") }),
			...(input.intent === undefined ? {} : { intent: pickEnum<"current" | "history">(input.intent, "intent", new Set(["current", "history"])) }),
			...(input.recordFamilies === undefined
				? {}
				: {
						recordFamilies: (Array.isArray(input.recordFamilies)
							? input.recordFamilies
							: (() => {
									throw new Error("recordFamilies 必须是数组");
								})()
						).map((entry, index) => pickEnum<"experience-card" | "feature-record">(entry, `recordFamilies[${index}]`, new Set(["experience-card", "feature-record"]))),
					}),
			...(statusesRaw === undefined
				? {}
				: {
						statuses: (Array.isArray(statusesRaw)
							? statusesRaw
							: (() => {
									throw new Error("statuses 必须是数组");
								})()
						).map((entry, index) => pickEnum<ExperienceStatus>(entry, `statuses[${index}]`, EXPERIENCE_STATUSES)),
					}),
		};
		if (request.query.length > 200) throw new Error("query 超过长度上限（200）");
		return business.search(request);
	});

	ipcMain.handle(ipcChannels.biosReadExperienceReference, async (_event, raw: unknown) => {
		const input = requireObject(raw, "跨项目参考请求");
		const request: BiosReferenceRequest = {
			...requireSessionPart(input),
			experienceId: requireText(input.experienceId, "experienceId", MAX_SHORT),
			...(optionalShort(input.targetProjectId, "targetProjectId") === undefined ? {} : { targetProjectId: optionalShort(input.targetProjectId, "targetProjectId") }),
			...(input.targetCustomerId === undefined ? {} : { targetCustomerId: input.targetCustomerId === null ? null : requireText(input.targetCustomerId, "targetCustomerId", MAX_SHORT) }),
		};
		return business.readReference(request);
	});

	/* ------------------------------------------------------------ 离线备份 / 恢复（B-07） */

	ipcMain.handle(ipcChannels.biosBackupPickDir, async (_event, raw: unknown): Promise<{ canceled: boolean; path: string | null }> => {
		const input = requireObject(raw, "选择目录请求");
		const purpose = pickEnum<BiosBackupPickPurpose>(input.purpose, "purpose", new Set(["export-parent", "restore-source", "restore-target-parent"]));
		// 标题可由 renderer 传（它已经本地化），但**有界**且缺省时用固定文案：
		// 标题只是提示，真正决定动作的是 purpose 与服务层校验，渲染层给不出"更危险的动作"。
		const title = optionalText(input.title, "title", 120) ?? BACKUP_PICK_TITLES[purpose];
		const result = await dialog.showOpenDialog({ properties: ["openDirectory"], title });
		if (result.canceled || result.filePaths.length === 0) return { canceled: true, path: null };
		return { canceled: false, path: result.filePaths[0] ?? null };
	});

	ipcMain.handle(ipcChannels.biosExportBackup, async (_event, raw: unknown) => {
		const input = requireObject(raw, "导出备份请求");
		const request: BiosExportBackupRequest = {
			...requireSessionPart(input),
			...operatorLabel(input),
			parentDir: requireText(input.parentDir, "parentDir", MAX_SHORT),
			name: requireText(input.name, "name", MAX_SHORT),
			// 只认**布尔 true**：缺失/false/其它值一律当成"尚未确认"，由服务层拒绝。
			// 这里不是"代填"——是"不把任何非 true 当成确认"。
			offlineConfirmed: input.offlineConfirmed === true,
		};
		const outcome = await business.exportBackup(request);
		appLogger.info("bios", `离线导出：${outcome.result.status}（提交=${outcome.committed}，文件 ${outcome.result.files} 个，清理=${outcome.result.cleanup}）`);
		return outcome;
	});

	ipcMain.handle(ipcChannels.biosRestoreBackup, async (_event, raw: unknown) => {
		const input = requireObject(raw, "恢复备份请求");
		const request: BiosRestoreBackupRequest = {
			...requireSessionPart(input),
			...operatorLabel(input),
			backupRoot: requireText(input.backupRoot, "backupRoot", MAX_SHORT),
			parentDir: requireText(input.parentDir, "parentDir", MAX_SHORT),
			name: requireText(input.name, "name", MAX_SHORT),
			offlineConfirmed: input.offlineConfirmed === true,
		};
		const outcome = await business.restoreBackup(request);
		appLogger.info("bios", `离线恢复：${outcome.result.status}（提交=${outcome.committed}，需复核 ${outcome.result.reviewReasons.length} 项，清理=${outcome.result.cleanup}）`);
		return outcome;
	});

	ipcMain.handle(ipcChannels.biosPrepareDraft, async (_event, raw: unknown) => {
		const input = requireObject(raw, "经验预填请求");
		const request: BiosDraftPrefillRequest = { ...requireSessionPart(input), projectId: requireText(input.projectId, "projectId", MAX_SHORT), taskId: requireText(input.taskId, "taskId", MAX_SHORT) };
		return business.prepareDraft(request);
	});

	ipcMain.handle(ipcChannels.biosSaveDraft, async (_event, raw: unknown) => {
		const input = requireObject(raw, "保存经验草稿请求");
		// 沉淀来源不采纳请求里的 sourceProjectId：服务的既有契约按**任务所属项目**回链。
		const draftBody = pickDraftExperience(input.experience, "experience");
		const expectedTaskRevision = optionalInt(input.expectedTaskRevision, "expectedTaskRevision");
		const request: BiosDraftSaveRequest = { ...requireSessionPart(input), ...operatorLabel(input), projectId: requireText(input.projectId, "projectId", MAX_SHORT), taskId: requireText(input.taskId, "taskId", MAX_SHORT), ...(expectedTaskRevision === undefined ? {} : { expectedTaskRevision }), experience: draftBody };
		const outcome = await business.saveDraft(request);
		appLogger.info("bios", `任务沉淀草稿：${outcome.result.status}（提交=${outcome.committed}）`);
		return outcome;
	});

	// B-06：Manifest 保存/重验是独立显式动作。这里只**挑选**允许字段；
	// `sources`/`budget`/`profileRevision` 到了服务层仍会被 core 按真实磁盘事实复核，
	// 因此本层不做"看起来合理就放行"的宽松判断，只挡住结构错误。
	ipcMain.handle(ipcChannels.biosSaveManifest, async (_event, raw: unknown) => {
		const input = requireObject(raw, "Manifest 保存请求");
		const sourcesRaw = input.sources;
		if (!Array.isArray(sourcesRaw)) throw new Error("sources 必须是数组");
		if (sourcesRaw.length > MAX_LIST) throw new Error(`sources 超过条目上限（${MAX_LIST}）`);
		const budgetRaw = requireObject(input.budget, "budget");
		const expectedRevision = input.expectedRevision === undefined || input.expectedRevision === null ? null : requireInt(input.expectedRevision, "expectedRevision");
		const request: BiosManifestSaveRequest = {
			...requireSessionPart(input),
			...operatorLabel(input),
			manifestId: requireText(input.manifestId, "manifestId", MAX_SHORT),
			targetProjectId: requireText(input.targetProjectId, "targetProjectId", MAX_SHORT),
			...(optionalShort(input.taskId, "taskId") === undefined ? {} : { taskId: optionalShort(input.taskId, "taskId") }),
			...(optionalShort(input.workspaceId, "workspaceId") === undefined ? {} : { workspaceId: optionalShort(input.workspaceId, "workspaceId") }),
			profileRevision: requireInt(input.profileRevision, "profileRevision"),
			generatedAt: requireInt(input.generatedAt, "generatedAt"),
			sources: sourcesRaw.map((entry, index) => {
				const item = requireObject(entry, `sources[${index}]`);
				return {
					recordKind: requireText(item.recordKind, `sources[${index}].recordKind`, MAX_SHORT),
					recordId: requireText(item.recordId, `sources[${index}].recordId`, MAX_SHORT),
					revision: requireInt(item.revision, `sources[${index}].revision`),
					reason: requireText(item.reason, `sources[${index}].reason`, MAX_SHORT),
				};
			}),
			...(stringList(input.expiredSources, "expiredSources") === undefined ? {} : { expiredSources: stringList(input.expiredSources, "expiredSources") }),
			budget: { maxChars: requireInt(budgetRaw.maxChars, "budget.maxChars"), maxBytes: requireInt(budgetRaw.maxBytes, "budget.maxBytes"), usedChars: requireInt(budgetRaw.usedChars, "budget.usedChars"), truncated: budgetRaw.truncated === true },
			expectedRevision,
		};
		const outcome = await business.saveManifest(request);
		appLogger.info("bios", `保存上下文清单：${outcome.result.status}（提交=${outcome.committed}）`);
		return outcome;
	});

	ipcMain.handle(ipcChannels.biosVerifyManifest, async (_event, raw: unknown) => {
		const input = requireObject(raw, "Manifest 重验请求");
		const request: BiosManifestVerifyRequest = { ...requireSessionPart(input), manifestId: requireText(input.manifestId, "manifestId", MAX_SHORT), projectId: requireText(input.projectId, "projectId", MAX_SHORT) };
		return business.verifyManifest(request);
	});

	return () => {
		for (const channel of [
			ipcChannels.biosStoreStatus,
			ipcChannels.biosInitializeStore,
			ipcChannels.biosBindProject,
			ipcChannels.biosDetectProject,
			ipcChannels.biosConfirmProfile,
			ipcChannels.biosReadProjectView,
			ipcChannels.biosReadTaskDetail,
			ipcChannels.biosCreateTask,
			ipcChannels.biosUpdateTask,
			ipcChannels.biosChangeTaskStatus,
			ipcChannels.biosCreateFeature,
			ipcChannels.biosUpdateFeature,
			ipcChannels.biosReadFeatureDetail,
			ipcChannels.biosCreateExperience,
			ipcChannels.biosUpdateExperience,
			ipcChannels.biosReadExperienceDetail,
			ipcChannels.biosReviewExperience,
			ipcChannels.biosSearchKnowledge,
			ipcChannels.biosReadExperienceReference,
			ipcChannels.biosPrepareDraft,
			ipcChannels.biosSaveDraft,
			ipcChannels.biosSaveManifest,
			ipcChannels.biosVerifyManifest,
			ipcChannels.biosBackupPickDir,
			ipcChannels.biosExportBackup,
			ipcChannels.biosRestoreBackup,
		]) {
			ipcMain.removeHandler(channel);
		}
	};
}
