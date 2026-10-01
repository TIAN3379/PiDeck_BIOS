/**
 * 存储层的结构化错误。
 *
 * 为什么不用裸 Error + 字符串判断：调用方（工具层、将来的 CLI）需要按**类别**决定行为——
 * "不存在"可以提示创建，"版本过高"必须拒绝写入，"权限不足"要提示用户，
 * 而"把 IO 失败当成空结果"是最危险的降级方式（bm02a_development_plan.md §3.5）。
 *
 * 错误信息里只放路径与规则说明，**不夹带记录正文**（客户资料泄漏面）。
 */
export type StorageErrorCode =
	/** 目标不存在（文件或目录）。 */
	| "not-found"
	/** 知识根本身不合法（不存在、不是目录、形态异常）。 */
	| "invalid-root"
	/** 目标路径落在知识根之外。 */
	| "path-escape"
	/** 根内出现符号链接／junction（本策略一律拒绝，见 boundary.ts）。 */
	| "symlink-rejected"
	/** 目标存在但不是常规文件。 */
	| "not-a-file"
	/** 权限不足。 */
	| "permission-denied"
	/** JSON 解析失败。 */
	| "invalid-json"
	/** 结构不符合契约 schema。 */
	| "invalid-record"
	/** schemaVersion 高于/低于本实现支持范围：拒绝解释，更拒绝写入。 */
	| "unsupported-schema-version"
	/** 文件路径里的 ID 与记录内容里的 ID 不一致。 */
	| "record-id-mismatch"
	/** 超过配置的字节/条数限额。 */
	| "too-large"
	/** 调用方取消。 */
	| "cancelled"
	/** 初始化竞争（另一个进程正在创建）。 */
	| "init-race"
	/** registry 绑定冲突（同一工作区被绑到不同项目、同项目重复绑定等）。 */
	| "binding-conflict";

export type StorageErrorOptions = {
	path?: string;
	detail?: string;
	/** 结构化补充信息（如冲突候选列表）；不放正文。 */
	conflicts?: string[];
	cause?: unknown;
};

export class StorageError extends Error {
	readonly code: StorageErrorCode;
	readonly path?: string;
	readonly detail?: string;
	readonly conflicts?: string[];

	constructor(code: StorageErrorCode, message: string, options: StorageErrorOptions = {}) {
		super(message, options.cause === undefined ? undefined : { cause: options.cause });
		this.name = "StorageError";
		this.code = code;
		this.path = options.path;
		this.detail = options.detail;
		this.conflicts = options.conflicts;
	}
}

export function isStorageError(error: unknown): error is StorageError {
	return error instanceof StorageError;
}

function errnoOf(error: unknown): string | undefined {
	if (typeof error === "object" && error !== null && "code" in error) {
		const code = (error as { code?: unknown }).code;
		if (typeof code === "string") return code;
	}
	return undefined;
}

export function isNotFoundError(error: unknown): boolean {
	return errnoOf(error) === "ENOENT";
}

export function isAlreadyExistsError(error: unknown): boolean {
	return errnoOf(error) === "EEXIST";
}

/** 硬链接不可用的信号：回退到 O_EXCL 直接创建（见 boundary.publishExclusive）。 */
export function isLinkUnsupportedError(error: unknown): boolean {
	const code = errnoOf(error);
	return code === "EPERM" || code === "EXDEV" || code === "ENOSYS" || code === "EACCES" || code === "EINVAL";
}

/** 把 Node 的文件系统错误映射成稳定的存储错误码。 */
export function mapFsError(error: unknown, fallback: StorageErrorCode, message: string, path?: string): StorageError {
	if (isStorageError(error)) return error;
	const code = errnoOf(error);
	switch (code) {
		case "ENOENT":
			return new StorageError("not-found", message, { path, cause: error });
		case "EACCES":
		case "EPERM":
			return new StorageError("permission-denied", message, { path, detail: code, cause: error });
		case "EISDIR":
			return new StorageError("not-a-file", message, { path, detail: code, cause: error });
		case "ENOTDIR":
			return new StorageError("not-found", message, { path, detail: code, cause: error });
		default:
			return new StorageError(fallback, message, { path, detail: code, cause: error });
	}
}

/** 取消检查的统一出口：所有长时间/多步操作都应该在关键点调用它。 */
export function throwIfCancelled(signal: AbortSignal | undefined, message = "存储操作已取消"): void {
	if (signal?.aborted) throw new StorageError("cancelled", message);
}
