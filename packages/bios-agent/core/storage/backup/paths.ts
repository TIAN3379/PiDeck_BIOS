/**
 * 备份清单的**受控落点与路径规范**（BM-02D1）。
 *
 * 这一层只回答两个问题，不碰任何 IO：
 * 1. 这条相对路径**语法上是否规范**（能安全地拼到一个 `data/` 目录下面）；
 * 2. 它在知识库的**受控落点表**里落在哪一类、需要哪些祖先目录。
 *
 * 三条纪律：
 *
 * 1. **ID 与文件名规则只复用既有判据**（`contracts/ids.ts`、`journal/contract.ts`、
 *    `contracts/auditIntent.ts`、审核层的意图目录名）：清单里的每条路径将来都要对应磁盘上的
 *    真实工件；在这里另写一套宽松正则，等于给"清单合法但恢复时找不到"埋一条不可见的缝。
 * 2. **只接受规范形式，不替调用方 normalize**：绝对路径、盘符、UNC、反斜杠、
 *    `.`/`..`、重复/首尾分隔符、NUL、冒号/ADS、尾点、保留名、大小写变体一律**明确拒绝**，
 *    不"先修补再判断"——对一个危险输入做 normalize 之后再说它安全，判断的就是另一个字符串了。
 * 3. **诊断不回显路径原文**：错误只给码与固定文案（名称已省略）。清单可能被贴进工单，
 *    路径里可能含有客户目录名。
 */
import { auditIntentFileName, isReservedDeviceName, isValidKnowledgeId } from "../../contracts/index.ts";
import { isJournalOperationId, journalFileName, JOURNAL_DIR_NAME, JOURNAL_FILE_SUFFIX } from "../journal/contract.ts";
import { REVIEW_INTENT_DIR_NAME } from "../review/artifacts.ts";
import type { BackupLimits } from "./limits.ts";

/**
 * 受控落点使用的固定段名（本模块内唯一一份）。
 *
 * `projects`/`experiences`/…/`profile.json` 这些字面量在存储层没有集中导出，
 * 因此这里自成一张表，并由 `storageBackupManifest.test.mjs` 用 `knowledgeLayout()`
 * 的**同名对照断言**兜住漂移——改了布局却没有同步这里，测试会红。
 */
export const BACKUP_LAYOUT_SEGMENTS = {
	registryFile: "registry.json",
	projectsDir: "projects",
	profileFile: "profile.json",
	tasksDir: "tasks",
	contextDir: "context",
	experiencesDir: "experiences",
	featuresDir: "features",
	auditDir: "audit",
	/** 与 journal 契约同源（`journal/<operationId>.json`）。 */
	journalDir: JOURNAL_DIR_NAME,
	/** 与审核契约同源（`audit/intents/<operationId>.json`）。 */
	intentDir: REVIEW_INTENT_DIR_NAME,
} as const;

/** 备份清单里必须登记的固定目录（即使为空）。 */
export const BACKUP_REQUIRED_DIRECTORIES: readonly string[] = [BACKUP_LAYOUT_SEGMENTS.projectsDir, BACKUP_LAYOUT_SEGMENTS.experiencesDir, BACKUP_LAYOUT_SEGMENTS.featuresDir, BACKUP_LAYOUT_SEGMENTS.auditDir];

/** 文件落在哪一类受控落点。 */
export type BackupLandingKind = "registry" | "project-profile" | "task-record" | "context-manifest" | "experience-card" | "feature-record" | "journal" | "audit-intent" | "audit-event";

export type BackupPathRejection = {
	readonly code: "invalid-path" | "unknown-landing" | "invalid-file-name";
	readonly message: string;
};

export type BackupFileLanding = {
	readonly kind: BackupLandingKind;
	/** 该路径必须登记的祖先目录（从浅到深，不含自身）。 */
	readonly ancestors: readonly string[];
};

export type BackupFileClassification = { readonly ok: true; readonly landing: BackupFileLanding } | { readonly ok: false; readonly reason: BackupPathRejection };
export type BackupDirectoryClassification = { readonly ok: true; readonly ancestors: readonly string[] } | { readonly ok: false; readonly reason: BackupPathRejection };

/** 规范相对路径允许的字符集：受控 ASCII 段 + 分隔符（大写/空白/非 ASCII/反斜杠/冒号都不在这里）。 */
const CANONICAL_PATH_CHARSET = /^[a-z0-9._/-]+$/;

const NAME_RULE_MESSAGE = "文件名中的受控 ID 不符合既有规则（名称已省略）";
const PROJECT_DIR_MESSAGE = "项目目录名必须是规范小写 UUID（名称已省略）";
const UNKNOWN_LANDING_MESSAGE = "不在受控落点表内（名称已省略）";

function reject(code: BackupPathRejection["code"], message: string): { ok: false; reason: BackupPathRejection } {
	return { ok: false, reason: { code, message } };
}

/**
 * 语法层校验：把一条路径切成规范段，或给出拒绝理由。
 *
 * 这里**不做**任何"修正"（不 trim、不转小写、不折叠分隔符、不 URL 解码）：
 * 能被修正的输入说明它本来就不是规范形式，而"修正后再判断"得到的是另一个字符串的结论。
 */
function splitCanonicalRelativePath(value: unknown, limits: BackupLimits): { ok: true; segments: string[] } | { ok: false; reason: BackupPathRejection } {
	if (typeof value !== "string") return reject("invalid-path", "路径必须是字符串");
	if (value.length === 0) return reject("invalid-path", "路径不能为空");
	if (value.length > limits.maxRelativePathChars) return reject("invalid-path", `路径字符数超过上限 ${limits.maxRelativePathChars}`);
	if (!CANONICAL_PATH_CHARSET.test(value)) return reject("invalid-path", "路径含受控字符集之外的字符（大写、空白、反斜杠、冒号、NUL、控制字符与非 ASCII 一律拒绝；不做 URL 解码）");
	if (value.startsWith("/") || value.endsWith("/")) return reject("invalid-path", "路径不能以分隔符开头或结尾（绝对路径/尾分隔符）");

	const segments = value.split("/");
	for (const segment of segments) {
		if (segment.length === 0) return reject("invalid-path", "路径存在空段（重复分隔符）");
		if (segment === "." || segment === "..") return reject("invalid-path", "路径不允许 `.` 或 `..` 段");
		if (segment.endsWith(".")) return reject("invalid-path", "路径段不能以 `.` 结尾（Windows 会静默去掉尾点，两个名字会命中同一文件）");
		if (isReservedDeviceName(segment)) return reject("invalid-path", "路径段是 Windows 设备保留名（带点后缀也是保留名）");
	}
	return { ok: true, segments };
}

/** 祖先目录（由浅到深，不含自身）。 */
function ancestorsOf(segments: readonly string[]): string[] {
	const out: string[] = [];
	for (let depth = 1; depth < segments.length; depth += 1) out.push(segments.slice(0, depth).join("/"));
	return out;
}

/** `name.json` → `name`；没有 `.json` 后缀或后缀前为空则 `undefined`。 */
function stripJsonSuffix(name: string): string | undefined {
	if (!name.endsWith(JOURNAL_FILE_SUFFIX)) return undefined;
	const id = name.slice(0, name.length - JOURNAL_FILE_SUFFIX.length);
	return id.length === 0 ? undefined : id;
}

function isProjectId(value: string): boolean {
	return isValidKnowledgeId(value, "project");
}

function accept(kind: BackupLandingKind, ancestors: string[]): BackupFileClassification {
	return { ok: true, landing: { kind, ancestors } };
}

/**
 * 把清单里的**文件**路径分类到受控落点。
 *
 * 三类拒绝必须分开：`invalid-path`（语法/逃逸）、`unknown-landing`（形态合法但不在表里）、
 * `invalid-file-name`（落在表里但 ID/文件名不符既有规则）。混成一个码就无法区分
 * "有人在试探路径边界"与"我们的生成器写出了坏名字"。
 *
 * 各形态由**首段**互斥区分（`registry.json` / `projects` / `experiences` / `features` /
 * `journal` / `audit`），因此不存在"靠分支顺序碰巧对"的歧义。
 */
export function classifyBackupFilePath(value: unknown, limits: BackupLimits): BackupFileClassification {
	const parsed = splitCanonicalRelativePath(value, limits);
	if (!parsed.ok) return parsed;
	const segments = parsed.segments;
	const ancestors = ancestorsOf(segments);
	const { registryFile, projectsDir, profileFile, tasksDir, contextDir, experiencesDir, featuresDir, auditDir, journalDir, intentDir } = BACKUP_LAYOUT_SEGMENTS;
	const first = segments[0] ?? "";

	if (segments.length === 1) {
		return first === registryFile ? accept("registry", ancestors) : reject("unknown-landing", UNKNOWN_LANDING_MESSAGE);
	}

	if (segments.length === 2) {
		const name = segments[1] ?? "";
		if (first === experiencesDir || first === featuresDir) {
			const id = stripJsonSuffix(name);
			if (id === undefined || !isValidKnowledgeId(id)) return reject("invalid-file-name", NAME_RULE_MESSAGE);
			return accept(first === experiencesDir ? "experience-card" : "feature-record", ancestors);
		}
		if (first === journalDir) {
			const operationId = stripJsonSuffix(name);
			// 额外对照一次 `journalFileName`：`isJournalOperationId` 只判 UUID 形态，
			// 文件名规则（含后缀）必须由契约函数给出，避免这里放宽成"以 .json 结尾就行"。
			if (operationId === undefined || !isJournalOperationId(operationId) || journalFileName(operationId) !== name) return reject("invalid-file-name", "journal 文件名必须是受控 `operationId.json`（名称已省略）");
			return accept("journal", ancestors);
		}
		return reject("unknown-landing", UNKNOWN_LANDING_MESSAGE);
	}

	if (segments.length === 3) {
		const second = segments[1] ?? "";
		const third = segments[2] ?? "";
		if (first === projectsDir) {
			if (third !== profileFile) return reject("unknown-landing", UNKNOWN_LANDING_MESSAGE);
			if (!isProjectId(second)) return reject("invalid-file-name", PROJECT_DIR_MESSAGE);
			return accept("project-profile", ancestors);
		}
		if (first === auditDir) {
			if (second === intentDir) {
				const operationId = stripJsonSuffix(third);
				if (operationId === undefined || !isJournalOperationId(operationId) || auditIntentFileName(operationId) !== third) return reject("invalid-file-name", "审核意图文件名必须是受控 `operationId.json`（名称已省略）");
				return accept("audit-intent", ancestors);
			}
			if (!isValidKnowledgeId(second)) return reject("invalid-file-name", NAME_RULE_MESSAGE);
			const eventId = stripJsonSuffix(third);
			if (eventId === undefined || !isJournalOperationId(eventId)) return reject("invalid-file-name", "审计事件文件名必须是受控事件 ID（名称已省略）");
			return accept("audit-event", ancestors);
		}
		return reject("unknown-landing", UNKNOWN_LANDING_MESSAGE);
	}

	if (segments.length === 4) {
		const projectId = segments[1] ?? "";
		const collection = segments[2] ?? "";
		const name = segments[3] ?? "";
		if (first !== projectsDir) return reject("unknown-landing", UNKNOWN_LANDING_MESSAGE);
		if (!isProjectId(projectId)) return reject("invalid-file-name", PROJECT_DIR_MESSAGE);
		if (collection !== tasksDir && collection !== contextDir) return reject("unknown-landing", UNKNOWN_LANDING_MESSAGE);
		const id = stripJsonSuffix(name);
		if (id === undefined || !isValidKnowledgeId(id)) return reject("invalid-file-name", NAME_RULE_MESSAGE);
		return accept(collection === tasksDir ? "task-record" : "context-manifest", ancestors);
	}

	return reject("unknown-landing", UNKNOWN_LANDING_MESSAGE);
}

/**
 * 把清单里的**目录**路径分类。
 *
 * 允许集合就是"受控落点的祖先目录"（含 `journal` 与 `audit/intents` 这两个可选空目录）：
 * 任何不在其中的目录都是未知落点——备份不得悄悄多带一份没人认识的子树。
 * `audit/intents` 是特殊落点，**不是**普通事件目录；这里按名字先判，避免它被当成记录目录。
 */
export function classifyBackupDirectoryPath(value: unknown, limits: BackupLimits): BackupDirectoryClassification {
	const parsed = splitCanonicalRelativePath(value, limits);
	if (!parsed.ok) return parsed;
	const segments = parsed.segments;
	const ancestors = ancestorsOf(segments);
	const { projectsDir, experiencesDir, featuresDir, auditDir, journalDir, intentDir, tasksDir, contextDir } = BACKUP_LAYOUT_SEGMENTS;
	const first = segments[0] ?? "";

	if (segments.length === 1) {
		if (first === projectsDir || first === experiencesDir || first === featuresDir || first === auditDir || first === journalDir) return { ok: true, ancestors };
		return reject("unknown-landing", UNKNOWN_LANDING_MESSAGE);
	}

	if (segments.length === 2) {
		const second = segments[1] ?? "";
		if (first === projectsDir) {
			if (!isProjectId(second)) return reject("invalid-file-name", PROJECT_DIR_MESSAGE);
			return { ok: true, ancestors };
		}
		if (first === auditDir) {
			if (second === intentDir) return { ok: true, ancestors };
			if (!isValidKnowledgeId(second)) return reject("invalid-file-name", NAME_RULE_MESSAGE);
			return { ok: true, ancestors };
		}
		return reject("unknown-landing", UNKNOWN_LANDING_MESSAGE);
	}

	if (segments.length === 3) {
		const second = segments[1] ?? "";
		const third = segments[2] ?? "";
		if (first !== projectsDir) return reject("unknown-landing", UNKNOWN_LANDING_MESSAGE);
		if (!isProjectId(second)) return reject("invalid-file-name", PROJECT_DIR_MESSAGE);
		if (third !== tasksDir && third !== contextDir) return reject("unknown-landing", UNKNOWN_LANDING_MESSAGE);
		return { ok: true, ancestors };
	}

	return reject("unknown-landing", UNKNOWN_LANDING_MESSAGE);
}
