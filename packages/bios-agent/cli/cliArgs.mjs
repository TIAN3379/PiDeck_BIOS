/**
 * 人工 CLI 的**共用骨架**（`cli/project.mjs` 与 `cli/business.mjs` 都用这一份）。
 *
 * 为什么必须是同一份：R28-4 要求"每命令参数白名单、重复/错参数与安全整数校验、
 * 统一单对象 JSON 与 code/exitCode"。两个 CLI 各写一遍解析器，迟早一处漏掉白名单、
 * 另一处把 `1e30` 当整数——那正是"看起来受限、实际没有"的缺口。
 *
 * 这里**不包含任何领域规则**：只做参数解析、退出码映射与受控输出。
 */

/** 回显前截断：未知/超长参数不能把 stdout 刷满。 @param {unknown} value @returns {string} */
export function short(value) {
	const text = typeof value === "string" ? value : String(value);
	return text.length > MAX_ECHO_CHARS ? `${text.slice(0, MAX_ECHO_CHARS)}…` : text;
}

export const MAX_ECHO_CHARS = 80;

/** 统一退出码：所有人工 CLI 共用同一张表。 */
export const EXIT = {
	ok: 0,
	usage: 2,
	refused: 3,
	conflict: 4,
	inconsistent: 5,
	notFound: 6,
	failed: 7,
	/** 已经写入/部分完成，但仍有需要人工核对的事实（journal 终态未写、清理/锁释放异常…）。 */
	needsReview: 8,
};

const CODE_TO_EXIT = {
	"invalid-argument": EXIT.usage,
	"not-authorized": EXIT.refused,
	"revision-conflict": EXIT.conflict,
	inconsistent: EXIT.inconsistent,
	"not-found": EXIT.notFound,
	cancelled: EXIT.failed,
	"io-error": EXIT.failed,
	unsupported: EXIT.failed,
};

/** @param {string} code @returns {number} */
export function exitCodeFor(code) {
	const table = /** @type {Record<string, number | undefined>} */ (CODE_TO_EXIT);
	return table[code] ?? EXIT.failed;
}

export class UsageError extends Error {
	/** @param {string} message */
	constructor(message) {
		super(message);
		this.name = "UsageError";
	}
}

/**
 * @typedef {{ flags: Map<string, string | true>, repeated: Map<string, Array<string | true>>, positionals: string[] }} ParsedArgs
 * @typedef {{ value: boolean, repeatable: boolean }} OptionSpec
 * @typedef {Record<string, OptionSpec>} OptionTable
 */

/**
 * 从 argv 里挑出子命令并返回去掉命令后的参数。
 *
 * 判定规则与解析器同源：`--flag=value` 自带值；已知的无值选项不带值；
 * 其它 `--flag` 的下一个 token 是它的值（因此不会被误当成命令）。
 * @param {string[]} argv @param {OptionTable} table @returns {{ command: string | undefined, rest: string[] }}
 */
export function resolveCommand(argv, table) {
	for (let index = 0; index < argv.length; index += 1) {
		const token = argv[index] ?? "";
		if (token === "") continue;
		if (!token.startsWith("--")) return { command: token, rest: [...argv.slice(0, index), ...argv.slice(index + 1)] };
		if (token.includes("=")) continue;
		const spec = table[token.slice(2)];
		// 未知选项：不假设它带值（可能它就是那个拼错的选项），直接继续往后找命令。
		if (spec === undefined) continue;
		if (spec.value === false) continue;
		index += 1;
	}
	return { command: undefined, rest: [...argv] };
}

/**
 * 严格解析：白名单、重复规则、缺值都在这里判定（全部发生在任何 IO 之前）。
 * @param {string[]} argv @param {string[]} allowed @param {OptionTable} table @returns {ParsedArgs}
 */
export function parseArgv(argv, allowed, table) {
	/** @type {Map<string, string | true>} */
	const flags = new Map();
	/** @type {Map<string, Array<string | true>>} */
	const repeated = new Map();
	/** @type {string[]} */
	const positionals = [];
	const seen = new Set();
	for (let index = 0; index < argv.length; index += 1) {
		const token = argv[index] ?? "";
		if (!token.startsWith("--")) {
			positionals.push(token);
			continue;
		}
		const eq = token.indexOf("=");
		const name = eq === -1 ? token.slice(2) : token.slice(2, eq);
		const spec = table[name];
		if (spec === undefined) throw new UsageError(`未知选项 --${short(name)}（用 help 查看支持的选项）`);
		if (!allowed.includes(name)) throw new UsageError(`选项 --${name} 不适用于本命令`);
		/** @type {string | true | undefined} */
		let value = eq === -1 ? undefined : token.slice(eq + 1);
		if (value === undefined && spec.value === true) {
			const next = argv[index + 1];
			if (next !== undefined && !next.startsWith("--")) {
				value = next;
				index += 1;
			}
		}
		if (spec.value === true && value === undefined) throw new UsageError(`选项 --${name} 需要一个值`);
		if (value === undefined) value = true;
		if (spec.repeatable !== true && seen.has(name)) throw new UsageError(`选项 --${name} 只能出现一次`);
		seen.add(name);
		const list = repeated.get(name);
		if (list === undefined) repeated.set(name, [value]);
		else list.push(value);
		if (!flags.has(name)) flags.set(name, value);
	}
	return { flags, repeated, positionals };
}

/**
 * 取一个字符串选项（必填时返回类型收窄为 `string`，调用方不必到处断言）。
 * @overload
 * @param {ParsedArgs} args
 * @param {string} name
 * @param {{ required: true }} options
 * @returns {string}
 */
/**
 * @overload
 * @param {ParsedArgs} args
 * @param {string} name
 * @param {{ required?: boolean }} [options]
 * @returns {string | undefined}
 */
/**
 * @param {ParsedArgs} args
 * @param {string} name
 * @param {{ required?: boolean }} [options]
 */
export function takeString(args, name, { required = false } = {}) {
	const value = args.flags.get(name);
	if (value === undefined) {
		if (required) throw new UsageError(`缺少必填选项 --${name}`);
		return undefined;
	}
	if (typeof value !== "string" || value.trim() === "") throw new UsageError(`--${name} 需要一个非空字符串值`);
	return value;
}

/** @param {ParsedArgs} args @param {string} name @returns {boolean} */
export function takeBool(args, name) {
	return args.flags.get(name) === true;
}

/** 安全非负整数：`1e30`、`0x10`、`-1`、小数都在这里被拒绝。 @param {string} raw @param {string} name @returns {number} */
export function parseSafeInt(raw, name) {
	if (!/^\d+$/.test(raw)) throw new UsageError(`--${name} 需要非负十进制整数`);
	const value = Number(raw);
	if (!Number.isSafeInteger(value)) throw new UsageError(`--${name} 超出安全整数范围`);
	return value;
}

/**
 * 取一个非负整数选项（必填时返回类型收窄为 `number`）。
 * @overload
 * @param {ParsedArgs} args
 * @param {string} name
 * @param {{ required: true }} options
 * @returns {number}
 */
/**
 * @overload
 * @param {ParsedArgs} args
 * @param {string} name
 * @param {{ required?: boolean }} [options]
 * @returns {number | undefined}
 */
/**
 * @param {ParsedArgs} args
 * @param {string} name
 * @param {{ required?: boolean }} [options]
 */
export function takeInt(args, name, { required = false } = {}) {
	const raw = takeString(args, name, { required });
	return raw === undefined ? undefined : parseSafeInt(raw, name);
}

/** @param {ParsedArgs} args @param {string} name @returns {string[]} */
export function takeList(args, name) {
	return /** @type {string[]} */ ((args.repeated.get(name) ?? []).filter((value) => typeof value === "string"));
}

/** @param {unknown} payload */
export function writeJson(payload) {
	process.stdout.write(`${JSON.stringify(payload)}\n`);
}

/**
 * 统一错误出口：`--json` 时 stdout 恰好一个可解析对象，退出码由受控错误码映射。
 * @param {unknown} error @param {boolean} asJson @param {Record<string, unknown>} [extra]
 */
export function reportError(error, asJson, extra = {}) {
	const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : error instanceof UsageError ? "invalid-argument" : "io-error";
	const exitCode = exitCodeFor(code);
	const message = error instanceof Error ? error.message : String(error);
	const detail = typeof error === "object" && error !== null && "detail" in error && typeof error.detail === "string" ? error.detail : undefined;
	const payload = { status: "error", code, exitCode, message, ...(detail === undefined ? {} : { detail }), ...extra };
	if (asJson) writeJson(payload);
	else process.stderr.write(`错误[${code}]：${message}\n`);
	process.exitCode = exitCode;
}

/**
 * 未确认写入时：明确列出"本来会做什么"，但不执行任何写入。
 * @param {string} command @param {boolean} asJson @param {string[]} wouldDo
 */
export function refuseWrite(command, asJson, wouldDo) {
	const payload = { status: "refused", code: "write-not-confirmed", exitCode: EXIT.refused, command, wouldDo, message: `${command} 是写操作：确认后加 --write 重新执行` };
	if (asJson) writeJson(payload);
	else {
		process.stderr.write(`拒绝执行：${command} 会写知识库。确认后加 --write 重新执行。\n`);
		for (const line of wouldDo) process.stderr.write(`  本会执行：${line}\n`);
	}
	process.exitCode = EXIT.refused;
}

/**
 * 统一的成功/部分完成出口：**每个**命令的结果都带 `code` 与 `exitCode`。
 * @param {string} code @param {number} exitCode
 */
export function outcome(code, exitCode) {
	return { code, exitCode };
}

/** @param {number} exitCode */
export function setExit(exitCode) {
	if (exitCode !== EXIT.ok) process.exitCode = exitCode;
}
