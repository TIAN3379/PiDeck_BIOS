/**
 * 审核审计事件的**纯**语义校验（BM-02C2A）。
 *
 * 分成两层的理由：
 * - schema（`audit.ts`）表达**结构**：类型、枚举、必填、长度、条数、格式——由它推类型，也由它抓掉
 *   绝大多数畸形输入（报 `invalid-audit`）；
 * - 本模块表达 schema 表达不了的**策略与跨字段规则**：UTF-8 字节预算、安全整数与 `after = before + 1`、
 *   时间范围与先后、证据引用形态互斥、单条事件总预算——这些各给一个更具体的 code。
 *
 * 三条硬约束：
 * 1. **纯函数、不修改输入**：校验不"顺手修一下"，调用方能继续拿原文做哈希与落盘；
 * 2. **不回显输入**：未声明字段只报"存在未声明的字段（名称已省略）"，路径里的未知片段替换成 `<unknown>`，
 *    长度/格式类错误只报字段与上限——否则校验本身就是一条泄漏客户资料的通道；
 * 3. **输出有界**：issue 条数、单条消息长度、扫描的结构错误数都有上限，并如实给出 `droppedIssues`。
 */
import { type TSchema } from "typebox";
import { Value } from "typebox/value";
import {
	AUDIT_ACTION_TRANSITIONS,
	AUDIT_EVIDENCE_MAX_BYTES,
	AUDIT_MAX_EVENT_BYTES,
	AUDIT_ISSUE_MESSAGE_MAX_CHARS,
	AUDIT_ISSUE_SCAN_LIMIT,
	AUDIT_LABEL_MAX_BYTES,
	AUDIT_LABEL_MAX_CHARS,
	AUDIT_MAX_DATE_MS,
	AUDIT_MAX_ISSUES,
	AUDIT_REASON_MAX_BYTES,
	AUDIT_REASON_MAX_CHARS,
	AUDIT_SCHEMA_VERSION,
	AuditEventSchema,
	isLegalAuditTransition,
	readAuditVersion,
	type AuditEvent,
	type AuditEvidenceRef,
	type AuditFingerprint,
} from "./audit.ts";

/**
 * 结构化 issue code。
 *
 * 为什么单独一套而不是复用记录的 `ContractIssueCode`：审计是**独立类别**（自己的版本号、
 * 自己的失败语义）。借用记录的 code 会让调用方以为"审计走的是记录那套 schemaVersion 闸门"。
 */
export type AuditIssueCode =
	/** 结构与 schema 不符（类型/枚举/必填/长度/条数/格式）。 */
	| "invalid-audit"
	/** `auditVersion` 缺失或不是正整数。 */
	| "invalid-audit-version"
	/** `auditVersion` 不是本实现支持的版本：拒绝解释，不猜格式。 */
	| "unsupported-audit-version"
	/** 存在未声明的字段（字段名已从诊断中隐去）。 */
	| "unknown-field"
	/** `action` 与 `(fromStatus, toStatus)` 不成对合法。 */
	| "audit-action-mismatch"
	/** before/after 的 revision 不安全、溢出，或不满足 `after = before + 1`。 */
	| "audit-revision-invalid"
	/** 时间不是可用时间戳，或发布早于决定。 */
	| "audit-time-invalid"
	/** 证据关联的形态/字节预算不合法。 */
	| "audit-evidence-invalid"
	/** 标签或理由的 UTF-8 字节超限（字符数已由 schema 检查）。 */
	| "audit-text-invalid"
	/** 单条事件/意图序列化字节超限：**拒绝**，不截断后假称原决策完整。 */
	| "audit-too-large"
	/** 审核意图结构与契约不符（与事件分开，便于区分是哪一侧坏）。 */
	| "invalid-audit-intent"
	/** `intentVersion` 缺失或不是正整数。 */
	| "invalid-audit-intent-version"
	/** `intentVersion` 不是本实现支持的版本：拒绝解释。 */
	| "unsupported-audit-intent-version"
	/** journal v2 关联投影结构与契约不符。 */
	| "invalid-audit-projection"
	/** 投影声明的 journal 版本不是受支持的审核版本（旧恢复器必须拒绝 v2）。 */
	| "unsupported-journal-version"
	/** 传入的 intent 真实字节指纹格式非法。 */
	| "invalid-intent-hash"
	/** 意图 / 投影 / 事件之间的关联不一致（三方身份对不上）。 */
	| "audit-association-mismatch"
	/** 同一次决定但稳定决定字段不同：属于冲突，不能认领也不能覆盖。 */
	| "audit-decision-conflict"
	/**
	 * 审核 journal v2 的结构与契约不符（存储层 `storage/review/contract.ts`）。
	 *
	 * 放在这里而不是另起一套：v2 的结构诊断必须复用同一份脱敏/有界管道
	 * （`collectSchemaIssues`），否则"哪些字段名可以出现在诊断里"会立刻分成两套规则。
	 */
	| "invalid-review-journal";

export type AuditIssue = {
	readonly code: AuditIssueCode;
	/** JSON Pointer 风格路径；未知片段被替换成 `<unknown>`。 */
	readonly path: string;
	readonly message: string;
};

export type AuditValidation = { ok: true; value: AuditEvent } | { ok: false; issues: AuditIssue[]; droppedIssues: number };

const UTF8_ENCODER = new TextEncoder();

/** UTF-8 字节数（字符数与字节数必须分别校验：中文标签按字节更容易触顶）。 */
export function utf8ByteLength(text: string): number {
	return UTF8_ENCODER.encode(text).length;
}

/**
 * 按**存储层同一份序列化形式**测量字节数（制表符缩进 + 结尾换行）。
 *
 * 为什么不是"估算"：BM-02C1R / J4 已经吃过一次亏——估算漏算字段名与分隔符，
 * 把 363 字节报成"低于 300 字节预算"。这里的预算必须与真实落盘字节一致。
 * 无法序列化（循环引用等）时返回 `undefined`，由调用方按"结构不合法"处理。
 */
export function measureAuditEventBytes(value: unknown): number | undefined {
	try {
		return utf8ByteLength(`${JSON.stringify(value, null, "\t")}\n`);
	} catch {
		return undefined;
	}
}

/**
 * 契约内允许出现的字段名：路径脱敏的白名单（不含任何用户数据）。
 *
 * 同时覆盖审核事件、审核意图与 journal v2 关联投影三者的字段名——它们共用同一套脱敏规则，
 * 各写一份迟早出现"某一边漏了字段名，诊断里又回显了外部输入"的裂缝。
 */
const KNOWN_PATH_SEGMENTS: ReadonlySet<string> = new Set([
	"auditVersion",
	"intentVersion",
	"purpose",
	"journalVersion",
	"journalPurpose",
	"eventId",
	"operationId",
	"intentName",
	"intentHash",
	"target",
	"kind",
	"recordId",
	"id",
	"operation",
	"state",
	"preparedAt",
	"finishedAt",
	"source",
	"action",
	"fromStatus",
	"toStatus",
	"operatorLabel",
	"decidedAt",
	"reason",
	"before",
	"after",
	"revision",
	"hash",
	"evidence",
	"index",
	"note",
	"publication",
	"recordedAt",
]);

/**
 * 路径脱敏：只保留契约内的字段名与数组下标，其余一律替换成 `<unknown>`。
 *
 * 为什么必须做：未声明字段的**名字**是外部输入的一部分，`Value.Errors` 会把它写进
 * `instancePath`（例如 `/evilCustomerKey`）。原样返回等于让校验器回显数据。
 */
export function sanitizeAuditPath(instancePath: unknown): string {
	if (typeof instancePath !== "string" || instancePath.length === 0) return "";
	const segments = instancePath.split("/").slice(1);
	const safe = segments.map((segment) => (/^[0-9]+$/.test(segment) ? segment : KNOWN_PATH_SEGMENTS.has(segment) ? segment : "<unknown>"));
	const path = `/${safe.join("/")}`;
	return path.length > 160 ? `${path.slice(0, 160)}…` : path;
}

function clampMessage(message: string): string {
	return message.length > AUDIT_ISSUE_MESSAGE_MAX_CHARS ? `${message.slice(0, AUDIT_ISSUE_MESSAGE_MAX_CHARS)}…` : message;
}

/** 构造一条有界、脱敏的 issue（供本模块与意图/关联校验共用）。 */
export function auditIssue(code: AuditIssueCode, path: string, message: string): AuditIssue {
	return { code, path, message: clampMessage(message) };
}

/** 模块内短别名：让下面几十处调用不必写长名字（对外导出的是 `auditIssue`）。 */
const issue = auditIssue;

/** 结构错误 → 固定文案：**不**回显字段内容，也**不**回显未知字段名。 */
function shapeIssueMessage(keyword: unknown): string {
	switch (keyword) {
		case "required":
			return "缺少必填字段";
		case "type":
			return "字段类型不合法";
		case "enum":
		case "const":
			return "取值不在允许集合内";
		case "pattern":
			return "字段格式不合法";
		case "minLength":
			return "字段长度低于下限";
		case "maxLength":
			return "字段长度超出上限";
		case "minimum":
		case "maximum":
			return "数值超出允许范围";
		case "minItems":
			return "数组条数低于下限";
		case "maxItems":
			return "数组条数超出上限";
		default:
			return "字段结构与审计契约不符";
	}
}

/**
 * 收集结构错误（有界），对任意 schema 复用。
 *
 * 未知字段由 `additionalProperties: false` 触发，TypeBox 会同时给出两条错误：一条把未知字段名
 * 放进 `instancePath`，一条放在 `params` 里。这里把两条**合并**成一条固定文案并在路径里隐去名字，
 * 避免"同一件事报两遍、其中一遍还回显字段名"。
 *
 * **关于"扫描上限"的准确表述**（C2AR-3 收口）：`Value.Errors` 是**先急切实体化整个错误数组**
 * 再交给本函数遍历的（实测 `Array.isArray(Value.Errors(...)) === true`）。所以
 * `AUDIT_ISSUE_SCAN_LIMIT` 限制的是**错误后处理与诊断输出**，不是 TypeBox 对未知对象的遍历耗时，
 * 更不能据此宣称"任意未知输入的校验成本恒定"。真正的输入规模约束必须由未来 IO 层的**读取字节
 * 上限**提供；本轮不为此引入新的沙箱或验证框架。
 */
/**
 * 结构问题的码由调用方指定（事件 / 意图 / 投影 / 审核 journal v2 各用各的码），
 * 但它们必须走**同一套**脱敏与有界管道——这正是"校验器本身不能成为泄漏通道"的实现点。
 */
export function collectSchemaIssues(schema: TSchema, value: unknown, shapeCode: AuditIssueCode = "invalid-audit"): { ok: boolean; issues: AuditIssue[]; dropped: number } {
	const issues: AuditIssue[] = [];
	const seen = new Set<string>();
	let dropped = 0;
	let scanned = 0;
	try {
		for (const error of Value.Errors(schema, value)) {
			scanned += 1;
			// 后处理上限：畸形大对象会产生海量错误条目，这里停止继续加工（TypeBox 已先返回数组）。
			if (scanned > AUDIT_ISSUE_SCAN_LIMIT) {
				dropped += 1;
				break;
			}
			const schemaPath = typeof error.schemaPath === "string" ? error.schemaPath : "";
			const instancePath = typeof error.instancePath === "string" ? error.instancePath : "";
			const isAdditional = error.keyword === "additionalProperties" || (error.keyword === "boolean" && schemaPath.endsWith("/additionalProperties"));
			// `boolean` 形态的路径带着未知字段名，取它的父路径（对象本身）作为报告位置。
			const parentPath = error.keyword === "boolean" ? instancePath.split("/").slice(0, -1).join("/") : instancePath;
			const candidate = isAdditional ? issue("unknown-field", sanitizeAuditPath(parentPath), "存在未声明的字段（名称已省略）") : issue(shapeCode, sanitizeAuditPath(instancePath), shapeIssueMessage(error.keyword));
			const key = `${candidate.code}|${candidate.path}`;
			if (seen.has(key)) continue;
			seen.add(key);
			if (issues.length >= AUDIT_MAX_ISSUES) {
				dropped += 1;
				continue;
			}
			issues.push(candidate);
		}
	} catch {
		// 极端输入（循环引用、巨型代理对象）下 TypeBox 自身可能抛错：按"结构不合法"处理，不穿透异常。
		return { ok: false, issues: [issue("invalid-audit", "", "结构无法校验（输入不是可枚举的普通 JSON 结构）")], dropped: 0 };
	}
	// 关键：**没有错误**就是结构合法。不能把"空错误列表"当成"结构不符"，
	// 否则合法输入会被假阳性拒绝（这里必须与 `Value.Check` 的语义一致）。
	if (issues.length === 0 && dropped === 0) return { ok: true, issues: [], dropped: 0 };
	if (issues.length === 0) issues.push(issue(shapeCode, "", "结构与契约不符"));
	return { ok: false, issues, dropped };
}

function collectShapeIssues(value: unknown): { ok: boolean; issues: AuditIssue[]; dropped: number } {
	return collectSchemaIssues(AuditEventSchema, value);
}

function isSafeNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function collectRevisionIssues(event: AuditEvent): AuditIssue[] {
	return collectAuditRevisionIssues(event.before, event.after);
}

/** revision 关系校验：审核事件与审核意图共用同一份规则（各自复制一份迟早漂移）。 */
export function collectAuditRevisionIssues(beforeFingerprint: AuditFingerprint, afterFingerprint: AuditFingerprint): AuditIssue[] {
	const issues: AuditIssue[] = [];
	const before = beforeFingerprint.revision;
	const after = afterFingerprint.revision;
	// 越界数值（负数/小数/2^53/1e100）已经在 schema 的 Integer 边界处被拒绝（报 `invalid-audit`）。
	// 这里再确认一次，是因为**下面的算术**（before + 1、溢出判定）只在安全整数上成立：
	// 若将来有人放松 schema 的数值边界，这段会立刻生效并给出更具体的 audit-revision-invalid。
	// 它因此不算"已由公开输入覆盖的规则"，测试也不为此伪造输入。
	if (!isSafeNonNegativeInteger(before)) issues.push(issue("audit-revision-invalid", "/before/revision", "before.revision 必须是 >= 0 的安全整数（2^53 之上无法作为并发依据）"));
	if (!isSafeNonNegativeInteger(after)) issues.push(issue("audit-revision-invalid", "/after/revision", "after.revision 必须是 >= 0 的安全整数"));
	if (issues.length > 0) return issues;

	if (before > Number.MAX_SAFE_INTEGER - 1) {
		issues.push(issue("audit-revision-invalid", "/before/revision", "before.revision 已到安全整数上限，无法再安全递增；审核必须改变版本"));
	} else if (after !== before + 1) {
		issues.push(issue("audit-revision-invalid", "/after/revision", "审核是 update 关系：after.revision 必须等于 before.revision + 1，不接受跳跃或倒退"));
	}
	return issues;
}

function collectTimeIssues(event: AuditEvent): AuditIssue[] {
	const issues: AuditIssue[] = [];
	// 范围由 schema 的 Integer 边界负责（报 `invalid-audit`）；这里同样只做防御性确认，
	// 真正在本层生效的是下面的**先后关系**（报 `audit-time-invalid`）。
	for (const [field, value] of [
		["decidedAt", event.decidedAt],
		["recordedAt", event.recordedAt],
	] as const) {
		if (!isSafeNonNegativeInteger(value) || value > AUDIT_MAX_DATE_MS) {
			issues.push(issue("audit-time-invalid", `/${field}`, `${field} 必须是 Date 可表示范围内的安全整数（epoch ms）`));
		}
	}
	if (issues.length === 0 && event.recordedAt < event.decidedAt) {
		issues.push(issue("audit-time-invalid", "/recordedAt", "recordedAt 不能早于 decidedAt：发布不能先于决定"));
	}
	return issues;
}

function collectTextIssues(event: AuditEvent): AuditIssue[] {
	return collectAuditTextIssues(event.operatorLabel, event.reason);
}

/** 标签/理由的 UTF-8 字节预算：事件与意图共用（字符数由各自 schema 的 `maxLength` 负责）。 */
export function collectAuditTextIssues(operatorLabel: string, reason: string): AuditIssue[] {
	const issues: AuditIssue[] = [];
	if (utf8ByteLength(operatorLabel) > AUDIT_LABEL_MAX_BYTES) {
		issues.push(issue("audit-text-invalid", "/operatorLabel", `operatorLabel 的 UTF-8 字节数超过 ${AUDIT_LABEL_MAX_BYTES}（字符上限 ${AUDIT_LABEL_MAX_CHARS}）`));
	}
	if (utf8ByteLength(reason) > AUDIT_REASON_MAX_BYTES) {
		issues.push(issue("audit-text-invalid", "/reason", `reason 的 UTF-8 字节数超过 ${AUDIT_REASON_MAX_BYTES}（字符上限 ${AUDIT_REASON_MAX_CHARS}）`));
	}
	return issues;
}

/**
 * 证据关联：形态互斥 + 总字节预算。
 *
 * 互斥规则不是"风格问题"：`record-evidence` 带 `recordId` 会同时声称"指向本记录的下标"与
 * "指向另一条记录"，恢复/展示时无法判断该读哪一个；`external-reference` 带 `index` 同理会
 * 让人以为它指向本记录。这类矛盾必须在校验层拒绝，而不是留给消费者猜。
 */
function collectEvidenceIssues(event: AuditEvent): AuditIssue[] {
	return collectAuditEvidenceIssues(event.evidence);
}

/** 证据形态互斥 + 总字节预算：事件与意图共用同一份规则与同一套 code。 */
export function collectAuditEvidenceIssues(evidence: readonly AuditEvidenceRef[]): AuditIssue[] {
	const issues: AuditIssue[] = [];
	evidence.forEach((ref, index) => {
		const path = `/evidence/${index}`;
		const pointsIntoRecord = ref.kind === "record-evidence" || ref.kind === "record-validation";
		if (pointsIntoRecord) {
			if (ref.index === undefined) issues.push(issue("audit-evidence-invalid", path, `${ref.kind} 必须给出 index（指向目标记录里的下标）`));
			if (ref.recordId !== undefined) issues.push(issue("audit-evidence-invalid", path, `${ref.kind} 不接受 recordId（它指向目标记录自身，不是别的记录）`));
			return;
		}
		if (ref.index !== undefined) issues.push(issue("audit-evidence-invalid", path, "external-reference 不接受 index"));
		if (ref.recordId === undefined && ref.note === undefined) issues.push(issue("audit-evidence-invalid", path, "external-reference 必须至少给出 recordId 或 note"));
	});
	if (issues.length > 0) return issues;

	const bytes = measureAuditEventBytes(evidence);
	if (bytes === undefined) return [issue("audit-evidence-invalid", "/evidence", "证据关联无法序列化")];
	if (bytes > AUDIT_EVIDENCE_MAX_BYTES) {
		return [issue("audit-evidence-invalid", "/evidence", `证据关联的序列化字节超过 ${AUDIT_EVIDENCE_MAX_BYTES} 上限，请减少引用或说明长度`)];
	}
	return issues;
}

/** 全部跨字段/预算规则；顺序固定，调用方可依赖"先报什么"。 */
function collectSemanticIssues(event: AuditEvent): AuditIssue[] {
	const issues: AuditIssue[] = [];
	if (!isLegalAuditTransition(event.action, event.fromStatus, event.toStatus)) {
		const legal = AUDIT_ACTION_TRANSITIONS[event.action].map((transition) => `${transition.from}→${transition.to}`).join("/");
		issues.push(issue("audit-action-mismatch", "/action", `${event.action} 只允许 ${legal}，收到 ${event.fromStatus}→${event.toStatus}`));
	}
	issues.push(...collectRevisionIssues(event));
	issues.push(...collectTimeIssues(event));
	issues.push(...collectTextIssues(event));
	issues.push(...collectEvidenceIssues(event));
	if (issues.length > 0) return issues;

	// 总预算放在最后：先让小问题可见，再谈"太大"（否则一条超长理由会把更具体的问题盖掉）。
	const bytes = measureAuditEventBytes(event);
	if (bytes === undefined) return [issue("invalid-audit", "", "事件无法序列化")];
	if (bytes > AUDIT_MAX_EVENT_BYTES) {
		return [issue("audit-too-large", "", `单条审计事件的序列化字节超过 ${AUDIT_MAX_EVENT_BYTES} 上限，拒绝写入（不截断后假称原决策完整）`)];
	}
	return issues;
}

/**
 * 校验一条审计事件（**纯函数**，接受 `unknown`）。
 *
 * 顺序：根形态 → 版本闸门 → 结构 → 语义/预算。
 * 版本未知时**只报版本问题**：不按当前版本猜测字段，否则"未来版本"会被误报成"缺字段"，
 * 调用方据此修数据反而会把未知格式改写成 v1。
 */
export function validateAuditEvent(input: unknown): AuditValidation {
	if (typeof input !== "object" || input === null || Array.isArray(input)) {
		return { ok: false, issues: [issue("invalid-audit", "", "审计事件必须是普通对象（不是数组/null/标量）")], droppedIssues: 0 };
	}

	const version = readAuditVersion(input);
	if (version === undefined) {
		return { ok: false, issues: [issue("invalid-audit-version", "/auditVersion", "auditVersion 必须是 >= 1 的整数")], droppedIssues: 0 };
	}
	if (version !== AUDIT_SCHEMA_VERSION) {
		return {
			ok: false,
			issues: [issue("unsupported-audit-version", "/auditVersion", `auditVersion=${version} 不是本实现支持的 ${AUDIT_SCHEMA_VERSION}，拒绝解释（不按当前版本猜测字段）`)],
			droppedIssues: 0,
		};
	}

	const shape = collectShapeIssues(input);
	if (!shape.ok) return { ok: false, issues: shape.issues, droppedIssues: shape.dropped };

	// 类型收窄说明：上面已用同一份 schema 枚举错误、结果为空即"结构合法"；
	// 这是 typebox 表驱动校验的类型损失，不是绕过校验（与 records.ts 的 assembleRecord 同一处理）。
	const event = input as AuditEvent;
	const semantic = collectSemanticIssues(event);
	if (semantic.length > 0) {
		// 语义层的条数同样必须有界：32 条证据各有两个矛盾时会产生 64 条诊断，
		// 直接回传等于把"输出有界"交给调用方兜底。
		const kept = semantic.slice(0, AUDIT_MAX_ISSUES);
		return { ok: false, issues: kept, droppedIssues: semantic.length - kept.length };
	}
	return { ok: true, value: event };
}

export function isValidAuditEvent(input: unknown): boolean {
	return validateAuditEvent(input).ok;
}

/** 把 issue 列表压成有界文本（诊断展示用；不含任何用户数据）。 */
export function describeAuditIssues(issues: readonly AuditIssue[], limit = 8): string {
	const shown = issues.slice(0, limit).map((entry) => `- [${entry.code}] ${entry.path || "/"} ${entry.message}`);
	if (issues.length > limit) shown.push(`- … 另有 ${issues.length - limit} 条问题`);
	return shown.join("\n");
}
