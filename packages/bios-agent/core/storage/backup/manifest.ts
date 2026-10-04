/**
 * 备份清单的 `unknown → 类型化清单` 校验（BM-02D1）。
 *
 * 这一层是**纯元数据协议**：不读文件、不建目录、不解析业务 JSON，只看调用方交进来的对象。
 * 它存在的意义是把"将来能安全恢复什么 / 不能恢复什么"先变成可执行的判据，再接真实 IO（D2/D3）。
 *
 * 四条硬规则：
 *
 * 1. **严格对象、未知字段拒绝**：清单是**我们**产出的东西，多一个字段就意味着它来自另一个版本
 *    或另一个工具；"尽力解释"会让恢复依据一份自己都没定义过的清单。
 * 2. **先数量/资源边界，后逐条细节**：条数超限时立刻停手（不遍历一千万条路径），
 *    所有累加都在溢出前拒绝。
 * 3. **失败不返回半份清单**：预算耗尽（含 `maxIssues=0`）也只能是失败——
 *    "没地方写错误"永远不等于"没有问题"。
 * 4. **不回显输入**：诊断只用受控定位（字段名 / `数组[下标]`）+ 固定文案。
 */
import { Buffer } from "node:buffer";
import { isValidKnowledgeId } from "../../contracts/index.ts";
import { BACKUP_CONSISTENCY, BACKUP_EXCLUDED_DIRECTORIES, BACKUP_MANIFEST_FIELD_ORDER, BACKUP_MANIFEST_VERSION, BACKUP_MAX_DATE_MS, BACKUP_SHA256_PATTERN_SOURCE, type BackupExclusion, type BackupManifest, type BackupManifestFile, type BackupManifestValidation } from "./contract.ts";
import { createIssueSink, isPlainObject, unknownFieldCount, type IssueSink } from "./issues.ts";
import { resolveBackupLimits, type BackupLimits } from "./limits.ts";
import { BACKUP_REQUIRED_DIRECTORIES, classifyBackupDirectoryPath, classifyBackupFilePath } from "./paths.ts";

const SHA256_PATTERN = new RegExp(BACKUP_SHA256_PATTERN_SOURCE);
const MANIFEST_FIELDS: ReadonlySet<string> = new Set(BACKUP_MANIFEST_FIELD_ORDER);
const FILE_FIELDS: ReadonlySet<string> = new Set(["path", "bytes", "sha256"]);
const EXCLUSION_NAMES: ReadonlySet<string> = new Set(BACKUP_EXCLUDED_DIRECTORIES);

/** 已登记目录（保留祖先，供"每个文件/子目录的祖先都必须登记"复用）。 */
type CheckedDirectory = { readonly path: string; readonly ancestors: readonly string[] };
type CheckedFile = { readonly file: BackupManifestFile; readonly ancestors: readonly string[] };

/**
 * 规范化清单的序列化字节（**唯一**口径）。
 *
 * 顺序固定为 `BACKUP_MANIFEST_FIELD_ORDER`：同一份语义的清单必须得到同一个字节数，
 * 否则"清单字节预算"就成了不可复现的旋钮。
 */
export function measureBackupManifestBytes(manifest: BackupManifest): number {
	return Buffer.byteLength(JSON.stringify(manifest), "utf8");
}

/**
 * 校验清单并返回类型化结果。
 *
 * 非法限额在**处理任何数据之前**抛 `invalid-limits`（含未知限额字段）；
 * 其余失败一律收敛成 `{ ok: false, code: "invalid-backup-manifest", issues, droppedIssues }`。
 */
export function validateBackupManifest(value: unknown, overrides?: Partial<BackupLimits>): BackupManifestValidation {
	const limits = resolveBackupLimits(overrides);
	const sink = createIssueSink(limits.maxIssues);
	const fail = (): BackupManifestValidation => ({ ok: false, code: "invalid-backup-manifest", issues: sink.issues(), droppedIssues: sink.dropped() });

	if (!isPlainObject(value)) {
		sink.add("not-object", "/", "清单必须是普通对象（数组、类实例、null 与带自定义原型的对象一律拒绝）");
		return fail();
	}

	// ---- 顶层字段：存在性、版本、语义常量 ----
	if (!("backupVersion" in value)) sink.add("missing-field", "backupVersion", "缺少 backupVersion");
	else if (value.backupVersion !== BACKUP_MANIFEST_VERSION) sink.add("invalid-version", "backupVersion", `backupVersion 必须是 ${BACKUP_MANIFEST_VERSION}；未来版本不做尽力解释`);
	if (unknownFieldCount(value, MANIFEST_FIELDS) > 0) sink.add("unknown-field", "/", "清单存在未知字段（名称已省略）");

	// 逐字段收窄成局部变量：不在末尾用 `as` 抹掉 unknown（那正是"校验与使用脱钩"的写法）。
	let backupId: string | undefined;
	if (!("backupId" in value)) sink.add("missing-field", "backupId", "缺少 backupId");
	else if (typeof value.backupId !== "string" || !isValidKnowledgeId(value.backupId)) sink.add("invalid-backup-id", "backupId", "backupId 不符合既有知识 ID 判据");
	else backupId = value.backupId;

	let createdAt: number | undefined;
	if (!("createdAt" in value)) sink.add("missing-field", "createdAt", "缺少 createdAt");
	else if (typeof value.createdAt !== "number" || !Number.isSafeInteger(value.createdAt) || value.createdAt < 0 || value.createdAt > BACKUP_MAX_DATE_MS) sink.add("invalid-created-at", "createdAt", "createdAt 必须是合法时间戳范围内的安全非负整数");
	else createdAt = value.createdAt;

	if (!("consistency" in value)) sink.add("missing-field", "consistency", "缺少 consistency");
	else if (value.consistency !== BACKUP_CONSISTENCY) sink.add("invalid-consistency", "consistency", `consistency 必须是 ${BACKUP_CONSISTENCY}（不接受无法证明的更强标记）`);

	const exclusions = readExclusions(value, sink);

	// ---- 数组字段与数量边界（先于逐条细节：预算的意义就是不为超限清单做无界工作） ----
	const directories = boundArray(value, "directories", limits.maxDirectories, "too-many-directories", sink, "目录项数");
	const files = boundArray(value, "files", limits.maxFiles, "too-many-files", sink, "文件项数");

	const checkedDirectories = directories === undefined ? undefined : readDirectories(directories, limits, sink);
	const checkedFiles = files === undefined ? undefined : readFiles(files, limits, sink);

	// ---- 跨数组与布局一致性 ----
	if (checkedDirectories !== undefined && checkedFiles !== undefined) checkLayout(checkedDirectories, checkedFiles, limits, sink);

	if (sink.count() > 0 || checkedDirectories === undefined || checkedFiles === undefined || exclusions === undefined || backupId === undefined || createdAt === undefined) return fail();

	// 字段顺序必须与 `BACKUP_MANIFEST_FIELD_ORDER` 一致，`measureBackupManifestBytes` 才可复现。
	const manifest: BackupManifest = {
		backupVersion: BACKUP_MANIFEST_VERSION,
		backupId,
		createdAt,
		consistency: BACKUP_CONSISTENCY,
		exclusions,
		directories: checkedDirectories.map((entry) => entry.path),
		files: checkedFiles.map((entry) => entry.file),
	};

	if (measureBackupManifestBytes(manifest) > limits.maxManifestBytes) {
		sink.add("manifest-too-large", "/", `清单序列化字节超过上限 ${limits.maxManifestBytes}`);
		return fail();
	}

	return { ok: true, manifest };
}

/**
 * 取数组字段并先检查数量边界。
 *
 * 返回 `undefined` 表示"不能继续遍历"（缺字段 / 不是数组 / 超限）——超限时**不遍历**，
 * 因为预算的全部意义就是"不为一千万条路径做无界工作"。
 */
function boundArray(value: Record<string, unknown>, key: "directories" | "files", max: number, code: "too-many-directories" | "too-many-files", sink: IssueSink, label: string): readonly unknown[] | undefined {
	if (!(key in value)) {
		sink.add("missing-field", key, `缺少 ${key}`);
		return undefined;
	}
	const raw = value[key];
	if (!Array.isArray(raw)) {
		sink.add("not-array", key, `${key} 必须是数组`);
		return undefined;
	}
	if (raw.length > max) {
		sink.add(code, key, `${label}超过上限 ${max}`);
		return undefined;
	}
	return raw;
}

/** `exclusions` 必须**恰好**是 `cache` 与 `locks`：不缺、不多、不重复，与顺序无关。 */
function readExclusions(value: Record<string, unknown>, sink: IssueSink): BackupExclusion[] | undefined {
	const message = `exclusions 必须恰好是 ${BACKUP_EXCLUDED_DIRECTORIES.join(" 与 ")}（不缺、不多、不重复）`;
	if (!("exclusions" in value)) {
		sink.add("missing-field", "exclusions", "缺少 exclusions");
		return undefined;
	}
	const raw = value.exclusions;
	if (!Array.isArray(raw)) {
		sink.add("invalid-exclusions", "exclusions", message);
		return undefined;
	}
	// **数量边界先于元素访问**（第二十一轮 B2）：协议要求恰好两项，所以长度不符时直接拒绝。
	// 该数组不受 `maxFiles`/`maxDirectories` 约束，若先 `for...of` 再在末尾拒绝，
	// 一个 10 万项非法输入会先被完整遍历一遍（`maxManifestBytes` 也拦不住，它在成功构造清单之后才检查）。
	if (raw.length !== BACKUP_EXCLUDED_DIRECTORIES.length) {
		sink.add("invalid-exclusions", "exclusions", message);
		return undefined;
	}
	const seen = new Set<string>();
	let bad = false;
	for (const entry of raw) {
		if (typeof entry !== "string" || !EXCLUSION_NAMES.has(entry) || seen.has(entry)) bad = true;
		else seen.add(entry);
	}
	// 少一项意味着"某类东西偷偷进了备份"，多一项意味着未来语义被提前写进清单。
	if (bad || seen.size !== BACKUP_EXCLUDED_DIRECTORIES.length) {
		sink.add("invalid-exclusions", "exclusions", message);
		return undefined;
	}
	return BACKUP_EXCLUDED_DIRECTORIES.filter((name) => seen.has(name));
}

/** 逐条校验目录落点（只返回完全通过的条目；有问题的已计入 sink，整体必然失败）。 */
function readDirectories(raw: readonly unknown[], limits: BackupLimits, sink: IssueSink): CheckedDirectory[] | undefined {
	const valid: CheckedDirectory[] = [];
	for (const [index, entry] of raw.entries()) {
		const classification = classifyBackupDirectoryPath(entry, limits);
		if (!classification.ok) {
			sink.add(classification.reason.code, `directories[${index}]`, classification.reason.message);
			continue;
		}
		if (typeof entry === "string") valid.push({ path: entry, ancestors: classification.ancestors });
	}
	return valid;
}

/** 逐条校验文件项：严格字段、受控落点、`bytes` 与 `sha256` 形态。 */
function readFiles(raw: readonly unknown[], limits: BackupLimits, sink: IssueSink): CheckedFile[] | undefined {
	const valid: CheckedFile[] = [];
	for (const [index, entry] of raw.entries()) {
		const where = `files[${index}]`;
		if (!isPlainObject(entry)) {
			sink.add("not-object", where, "文件项必须是普通对象");
			continue;
		}
		let clean = unknownFieldCount(entry, FILE_FIELDS) === 0;
		if (!clean) sink.add("unknown-field", where, "文件项存在未知字段（名称已省略）");

		const path = entry.path;
		const classification = classifyBackupFilePath(path, limits);
		if (!classification.ok) {
			sink.add(classification.reason.code, where, classification.reason.message);
			clean = false;
		}

		const bytes = entry.bytes;
		if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 0) {
			sink.add("invalid-bytes", where, "bytes 必须是安全非负整数（NaN/Infinity/小数/负数一律拒绝）");
			clean = false;
		} else if (bytes > limits.maxFileBytes) {
			sink.add("file-too-large", where, `单文件字节数超过上限 ${limits.maxFileBytes}`);
			clean = false;
		}

		const sha256 = entry.sha256;
		if (typeof sha256 !== "string" || !SHA256_PATTERN.test(sha256)) {
			sink.add("invalid-hash", where, "sha256 必须是 64 位小写十六进制（不接受大小写宽松匹配）");
			clean = false;
		}

		// 这里的 `typeof` 复查既是收窄手段，也让"通过了检查"与"被采用"之间没有隐式强转。
		if (clean && classification.ok && typeof path === "string" && typeof bytes === "number" && typeof sha256 === "string") {
			valid.push({ file: { path, bytes, sha256 }, ancestors: classification.landing.ancestors });
		}
	}
	return valid;
}

/**
 * 跨数组与布局一致性：重复、文件/目录冲突、祖先登记、必需项、总量。
 *
 * 这些检查互相独立，因此**全部执行**再返回——只报第一条会让调用方"修一次、跑一次"。
 */
function checkLayout(directories: CheckedDirectory[], files: CheckedFile[], limits: BackupLimits, sink: IssueSink): void {
	const directorySet = new Set<string>();
	for (const [index, entry] of directories.entries()) {
		if (directorySet.has(entry.path)) sink.add("duplicate-path", `directories[${index}]`, "目录路径重复");
		else directorySet.add(entry.path);
	}

	const fileSet = new Set<string>();
	for (const [index, entry] of files.entries()) {
		const path = entry.file.path;
		if (fileSet.has(path)) sink.add("duplicate-path", `files[${index}]`, "文件路径重复");
		else fileSet.add(path);
		if (directorySet.has(path)) sink.add("path-conflict", `files[${index}]`, "同一路径既是文件又是目录");
	}

	// 祖先登记：每个文件与每个子目录的**每一级**父目录都必须登记（空目录因此可解释）。
	for (const [index, entry] of files.entries()) {
		if (entry.ancestors.some((ancestor) => !directorySet.has(ancestor))) sink.add("missing-ancestor", `files[${index}]`, "文件缺少已登记的祖先目录");
	}
	for (const [index, entry] of directories.entries()) {
		if (entry.ancestors.some((ancestor) => !directorySet.has(ancestor))) sink.add("missing-ancestor", `directories[${index}]`, "目录缺少已登记的祖先目录");
	}

	let registryCount = 0;
	for (const entry of files) if (entry.file.path === "registry.json") registryCount += 1;
	if (registryCount === 0) sink.add("missing-registry", "files", "缺少必需的 registry.json");
	for (const required of BACKUP_REQUIRED_DIRECTORIES) {
		if (!directorySet.has(required)) sink.add("missing-required-directory", "directories", `缺少必需固定目录（名称见受控落点表；当前缺：${required}）`);
	}

	// 总量：先判断"再加会不会溢出"，再相加；一旦超预算只报一次并停止累加。
	let total = 0;
	for (const entry of files) {
		if (total > Number.MAX_SAFE_INTEGER - entry.file.bytes) {
			sink.add("payload-too-large", "files", "payload 总字节累加会在安全整数范围溢出");
			return;
		}
		total += entry.file.bytes;
		if (total > limits.maxTotalPayloadBytes) {
			sink.add("payload-too-large", "files", `payload 总字节超过上限 ${limits.maxTotalPayloadBytes}`);
			return;
		}
	}
}
