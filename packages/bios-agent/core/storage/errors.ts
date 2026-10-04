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
	| "binding-conflict"
	/**
	 * 平台/文件系统无法在不暴露半成品的前提下发布文件（BM-02AR / S1）。
	 *
	 * 为什么单独一个码而不是回退直写：非覆盖发布依赖"同目录完整临时文件 + 硬链接"，
	 * 硬链接不可用时**没有任何**已知手段能保证"目标要么不存在、要么内容完整"。
	 * 此时唯一诚实的做法是明确失败，让调用方去选择别的知识根，
	 * 而不是把 0 字节/半截 JSON 暴露给并发读者、甚至永久留在知识库里。
	 */
	| "publish-unsupported"
	/** 限额配置本身不合法（NaN/Infinity/负数/非整数等）。 */
	| "invalid-limits"
	/**
	 * 乐观并发冲突（BM-02B / B1）：`expectedRevision` 与实际状态不符。
	 *
	 * 覆盖四种"不是冲突但同样不该继续写"的情况，避免调用方把它们误当成别的类别：
	 * 旧 revision（有人在读之后改过）、create 时目标已存在、update 时目标缺失、
	 * `expectedRevision` 本身不合法（负数/非整数）、以及 revision 计数溢出。
	 * 错误里带 `expected` / `actual`（缺失为 `null`），不含记录正文。
	 */
	| "revision-conflict"
	/**
	 * 跨进程锁在超时内没拿到（BM-02B / B2）。
	 *
	 * 为什么单独一个码而不是复用 `permission-denied`：语义完全不同——
	 * 权限问题是"你没资格"，锁超时是"别人正在写，可以稍后重试"，
	 * 调用方对这两种情况的处理（提示用户 vs 退避重试）必须能区分。
	 */
	| "lock-timeout"
	/**
	 * 审核工件冲突（BM-02C2B / C2B-1）：同一身份已存在**内容不同**的意图或事件。
	 *
	 * 为什么不复用 `revision-conflict`：两者的可行动作完全不同——revision 冲突是并发写，
	 * 重读后可以重试；审核工件冲突意味着"这次决定"的落盘依据被人换过（或同一个
	 * operationId/eventId 被用于另一个决定），**不可自动重试**，必须交人工判断。
	 * 也刻意不复用 `binding-conflict`：那一个专指 registry 的项目/工作区绑定。
	 */
	| "audit-conflict"
	/**
	 * 备份清单协议非法（BM-02D1 / D1）：结构、版本、受控落点或资源预算不通过。
	 *
	 * 为什么单独一个码：备份是"另一份表示"，它的失败要么是清单本身不可信、
	 * 要么是清单与磁盘字节不一致——两种情况调用方的动作完全不同（人工修清单 vs 重新导出）。
	 * 更细的定位在结果对象的 `issues[].code` 里，不把粗码拆成一堆调用方都得认识的枚举。
	 */
	| "invalid-backup-manifest"
	/**
	 * 备份清单与所给原始字节不一致（BM-02D1 / D1）：缺失、多余、重复、长度或 SHA-256 不符。
	 *
	 * 刻意不复用 `invalid-record`：字节不一致**不代表**任何一侧格式错误，
	 * 只代表"这不是同一次复制"，把它说成"记录不合法"会误导恢复动作。
	 */
	| "backup-payload-mismatch"
	/**
	 * 备份导出参数非法（BM-02D2）：缺少显式离线确认、路径不是完全限定形式、
	 * 目标父目录不存在或不是目录等**在任何输出创建之前**就能确定的问题。
	 *
	 * 与 `invalid-limits` 分开：一个是"调用方式不对"，一个是"预算配置不对"，
	 * 调用方的修复动作不同（改参数 vs 改预算）。
	 */
	| "backup-argument-invalid"
	/**
	 * 源知识库不满足备份准入（BM-02D2）：预检 blocked/incomplete、有诊断裁剪、
	 * 存在阻断问题或人工核对事项（锁/残留/prepared journal…），或受控 inventory 发现
	 * 未知落点/链接/`.tmp`。**不允许**用"先导出再让用户自己看"替代准入。
	 */
	| "backup-source-not-eligible"
	/**
	 * 目标目录已存在（BM-02D2）：空目录、旧备份、半成品、文件或链接一律拒绝。
	 *
	 * 为什么不能只看 `exists` 再决定：那句承诺是"我看到它不存在"，而真正需要的是
	 * "**我**独占创建了它"——排他创建失败即冲突，绝不复用/覆盖别人的目录。
	 */
	| "backup-target-exists"
	/**
	 * 源与目标路径重叠（BM-02D2）：相同、目标在源内、目标包含源，或词法分离但 canonical 后重叠。
	 *
	 * 按**路径段**比较而不是字符串前缀：`C:\know` 与 `C:\knowledge` 是两棵不同的树。
	 */
	| "backup-target-overlap"
	/**
	 * 复制期间源发生变化（BM-02D2）：目录/文件集合、必要元信息或准入结论改变，
	 * 或源文件字节在两次读取之间不同。此时已经抄下来的东西**不是**一次一致复制。
	 */
	| "backup-source-changed"
	/**
	 * 导出过程中出现**未分类**失败（BM-02D2）。
	 *
	 * 为什么需要它：公共失败必须落在受控类别里，而原始 fs/系统异常的正文可能携带客户路径，
	 * 不能直接透传。未知失败因此收敛成这一个码 + 阶段说明，具体原因留在本机日志而不是返回值里。
	 */
	| "backup-io-failed";

/**
 * 备份/恢复类操作的结构化失败事实（BM-02D2 / D2R）。
 *
 * 为什么必须有结构化字段而不是拼进 message：round22 §3（D2-3）证明"是否已提交、清理成不成功、
 * 还有多少残留"是调用方要据以决策的事实，藏在字符串里既不可断言、也容易被下一次改写抹掉。
 * 它们是**受控枚举与计数**，不含路径、正文或未知条目名。
 */
export type OperationFailureFacts = {
	/** 受控阶段标签（如 `copy`、`publish`），不是路径。 */
	readonly phase: string;
	/** 完成标记是否已发布（提交点是否已过）。 */
	readonly published: boolean;
	/** 本次调用自有内容的清理结果。 */
	readonly cleanup: "ok" | "failed";
	/** 未能清理的有界残留样本（受控相对路径，最多 5 条）。 */
	readonly residuals?: readonly string[];
};

export type StorageErrorOptions = {
	path?: string;
	detail?: string;
	/** 备份/恢复等长流程的结构化收尾事实；其他调用方不传即为 undefined。 */
	facts?: OperationFailureFacts;
	/** 结构化补充信息（如冲突候选列表）；不放正文。 */
	conflicts?: string[];
	/** 乐观冲突的预期版本；`null` 表示"要求不存在"。 */
	expected?: number | null;
	/** 乐观冲突时实际读到的版本；`null` 表示目标不存在。 */
	actual?: number | null;
	cause?: unknown;
};

export class StorageError extends Error {
	readonly code: StorageErrorCode;
	readonly path?: string;
	readonly detail?: string;
	readonly conflicts?: string[];
	readonly expected?: number | null;
	readonly actual?: number | null;
	readonly facts?: OperationFailureFacts;

	constructor(code: StorageErrorCode, message: string, options: StorageErrorOptions = {}) {
		super(message, options.cause === undefined ? undefined : { cause: options.cause });
		this.name = "StorageError";
		this.code = code;
		this.path = options.path;
		this.detail = options.detail;
		this.conflicts = options.conflicts;
		this.expected = options.expected;
		this.actual = options.actual;
		this.facts = options.facts;
	}
}

export function isStorageError(error: unknown): error is StorageError {
	return error instanceof StorageError;
}

export function isStorageErrorCode(error: unknown, code: StorageErrorCode): boolean {
	return isStorageError(error) && error.code === code;
}

/**
 * 读取 errno 字符串（`ENOENT` 等）。
 *
 * 对外暴露是因为发布失败分类需要把**原始 errno** 放进 `detail`——
 * 否则"文件系统不支持硬链接"和"权限不足"在日志里长得一模一样。
 */
export function fsErrorCode(error: unknown): string | undefined {
	if (typeof error === "object" && error !== null && "code" in error) {
		const code = (error as { code?: unknown }).code;
		if (typeof code === "string") return code;
	}
	return undefined;
}

export function isNotFoundError(error: unknown): boolean {
	return fsErrorCode(error) === "ENOENT";
}

export function isAlreadyExistsError(error: unknown): boolean {
	return fsErrorCode(error) === "EEXIST";
}

/** 硬链接发布失败的分类（BM-02AR / S1）。 */
export type LinkFailureKind = "exists" | "unsupported" | "permission" | "other";

/**
 * 区分"目标已存在""平台不支持硬链接""权限不足"。
 *
 * 为什么必须区分：第四轮验收的 S1 指出，原来的实现把 EPERM/EACCES 也当成"不支持链接"
 * 从而回退直写。回退写法（`writeFile(target, { flag: "wx" })`）只保证**不覆盖**，
 * 不保证目标在写完整之前不可见——并发读者会读到 0 字节或半截 JSON。
 * 现在不再回退，所以分类只影响"错误码与说明是否准确"：
 * 不支持链接报 `publish-unsupported`，权限问题报 `permission-denied`，两者都不创建目标文件。
 *
 * EPERM 的歧义：Windows 上它既可能是权限不足，也是非 NTFS（FAT/exFAT）不支持硬链接的返回值。
 * 取"更可能"的归类，并把原始 errno 保留在 detail 里，不做过度断言。
 */
export function classifyLinkFailure(error: unknown, platform: NodeJS.Platform = process.platform): LinkFailureKind {
	if (isAlreadyExistsError(error)) return "exists";
	switch (fsErrorCode(error)) {
		case "ENOSYS":
		case "ENOTSUP":
		case "EOPNOTSUPP":
		case "EXDEV":
		case "EINVAL":
			return "unsupported";
		case "EACCES":
			return "permission";
		case "EPERM":
			return platform === "win32" ? "unsupported" : "permission";
		default:
			return "other";
	}
}

/** 把 Node 的文件系统错误映射成稳定的存储错误码。 */
export function mapFsError(error: unknown, fallback: StorageErrorCode, message: string, path?: string): StorageError {
	if (isStorageError(error)) return error;
	const code = fsErrorCode(error);
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

/**
 * 取消检查的"单一来源"包装（BM-02AR / S3）。
 *
 * 为什么单独一个函数：调用方（工具层）可以显式传入自己的 signal，
 * 而 boundary 自身还带着创建时的 signal。第四轮验收指出"入口检查了、等待之后没检查"——
 * 统一走这里可以保证**每一个 IO 等待点之后**都用同一优先级检查，
 * 而不是各处手写 `if (a?.aborted || b?.aborted)` 慢慢漂移。
 * 显式传入的 signal 优先（调用方更接近用户意图），但两者任一取消都立即失败。
 */
export function resolveSignal(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
	return signals.find((candidate) => candidate !== undefined);
}

/** 任一 signal 已取消即抛 `cancelled`（整体失败，不并入单条问题）。 */
export function throwIfAnyCancelled(signals: Array<AbortSignal | undefined>, message = "存储操作已取消"): void {
	for (const signal of signals) {
		if (signal?.aborted) throw new StorageError("cancelled", message);
	}
}

/**
 * 取消错误判定（B0）：用于"取消不得被普通 FS catch 改写成 permission-denied"的穿透检查。
 *
 * 为什么单独一个判定：`mapFsError` 对 `StorageError` 是**原样返回**，
 * 所以取消通常能穿过 catch；但这一保证依赖"没人先把它降级成裸 Error"，
 * 把意图写成显式判定，改动 catch 结构时不会被无声破坏。
 */
export function isCancelledError(error: unknown): boolean {
	return isStorageErrorCode(error, "cancelled");
}
