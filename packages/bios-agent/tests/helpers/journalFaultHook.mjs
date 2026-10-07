/**
 * 测试用的 loader hook：把 `core/storage/journal/writer.ts` 的 `finalizeJournalEntry`
 * 在 `committed` 终态上改成返回受控 EBUSY 失败（不改动磁盘上的任何源码文件）。
 *
 * 注意：Node 的类型剥离 loader 返回的 `source` 是 **字节视图**（不是字符串），
 * 因此要显式解码/编码；只应通过 `journalFaultPreload.mjs` 注册。
 */
import { writeSync } from "node:fs";

const TARGET_SUFFIX = "/core/storage/journal/writer.ts";
const FUNCTION_MARKER = "export async function finalizeJournalEntry(";

/** 同步写 stderr：loader 线程的 console 输出在进程收尾时可能丢失。 */
function debug(message) {
	if (process.env.BIOS_JOURNAL_FAULT_DEBUG === "1") writeSync(2, `${message}\n`);
}

/** @param {unknown} source @returns {string} */
function sourceToString(source) {
	if (typeof source === "string") return source;
	if (source instanceof Uint8Array) return Buffer.from(source).toString("utf8");
	if (source instanceof ArrayBuffer) return Buffer.from(new Uint8Array(source)).toString("utf8");
	return String(source);
}

export async function load(url, context, nextLoad) {
	const result = await nextLoad(url, context);
	if (!url.endsWith(TARGET_SUFFIX)) return result;
	const source = sourceToString(result.source);
	const index = source.indexOf(FUNCTION_MARKER);
	if (index === -1) {
		debug(`[journal-fault] marker not found in ${url}`);
		return result;
	}
	const braceIndex = source.indexOf("{", index);
	if (braceIndex === -1) return result;
	const injected = '\n\tif (options.state === "committed") return { ok: false, error: new StorageError("io-error", "EBUSY: 注入的 journal 终态失败", { detail: "injected-journal-finalize-ebusy" }) };\n';
	debug(`[journal-fault] injected finalize fault into ${url}`);
	return { ...result, source: `${source.slice(0, braceIndex + 1)}${injected}${source.slice(braceIndex + 1)}` };
}
