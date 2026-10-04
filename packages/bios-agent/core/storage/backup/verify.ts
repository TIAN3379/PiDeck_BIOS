/**
 * 清单与**内存原始字节**的一致性核验（BM-02D1）。
 *
 * 为什么先做"内存字节"而不是直接读盘：D1 要先把"什么算同一次复制"写成可执行的判据。
 * 这一层刻意**没有** fs、没有根路径、没有 `await`——调用方（D2/D3）负责把磁盘上的
 * 有界字节交进来，于是"清单对不对"与"磁盘读得对不对"是两个可以分别验证的问题。
 *
 * 四条边界：
 * 1. **只比字节，不解析业务**：hash 相符不代表当前应用能解释文件内容，更不代表可以恢复；
 *    "坏 JSON 也能通过"是**刻意**的对照，防止把字节一致误当已支持版本。
 * 2. **顺序无关**：payload 与清单都不依赖数组顺序（不靠排序去消除重复，重复即失败）。
 * 3. **先边界后计算**：先校验清单与条目数量，再逐条算 hash；hash 只算一次。
 * 4. **不回显输入**：诊断只用受控定位（`entries[下标]` / `files[下标]`）+ 固定文案。
 */
import { createHash } from "node:crypto";
import { types } from "node:util";
import type { BackupManifestFile, BackupPayloadVerification } from "./contract.ts";
import { createIssueSink, isPlainObject, unknownFieldCount } from "./issues.ts";
import { resolveBackupLimits, type BackupLimits } from "./limits.ts";
import { validateBackupManifest } from "./manifest.ts";

/** 一条内存 payload：相对 `data/` 的规范路径 + 该文件的**原始字节**。 */
export type BackupPayloadEntry = {
	readonly path: string;
	readonly bytes: Uint8Array;
};

const ENTRY_FIELDS: ReadonlySet<string> = new Set(["path", "bytes"]);

/**
 * `%TypedArray%.prototype` 上的 `byteLength` getter（视图的**真实**长度来源）。
 *
 * 为什么不用 `value.byteLength`：真实 `Uint8Array`/`Buffer` 也允许定义同名自有属性，
 * 于是"实现读到的长度"与"crypto 实际 hash 的字节数"可能不是同一个数字，
 * 长度比较、单文件/总量预算与成功摘要会一起失真（第二十一轮 B1）。
 * 取原型上的 getter 直接调用，自有属性与 getter 都覆盖不了它。
 */
const TYPED_ARRAY_BYTE_LENGTH_GETTER: ((this: unknown) => unknown) | undefined = (() => {
	const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), "byteLength");
	return descriptor?.get;
})();

type TrustedByteView = { readonly view: Uint8Array; readonly byteLength: number };

/**
 * 受控字节视图：品牌与长度都不得来自调用方可自由覆盖的位置。
 *
 * - **品牌**用 Node 的 `util.types.isUint8Array`（不看原型链）：`Object.create(Uint8Array.prototype)`
 *   带个自有长度能骗过 `instanceof`，但不是真正的字节视图，交给 crypto 只会抛原始 `ERR_INVALID_ARG_TYPE`；
 * - **长度**由原型 getter 取实际视图口径（`instanceof` 在这一行只用于类型收窄）；
 * - 任一项拿不到就返回 `undefined`，由调用方转成受控的 `payload-entry` —— 不是 catch-all 吞异常，
 *   也不为任意对象/Proxy 造通用沙箱。
 */
function trustedByteView(value: unknown): TrustedByteView | undefined {
	if (!types.isUint8Array(value)) return undefined;
	if (!(value instanceof Uint8Array)) return undefined;
	const getter = TYPED_ARRAY_BYTE_LENGTH_GETTER;
	if (getter === undefined) return undefined;
	const length: unknown = getter.call(value);
	if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) return undefined;
	return { view: value, byteLength: length };
}

function sha256Hex(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

/**
 * 单份 payload 的**可信口径**摘要（品牌 + 实际视图长度 + SHA-256）。
 *
 * 导出（D2）逐文件复核目标字节时复用它：不能另造一套更宽松的判据，
 * 但也不该为了调用纯 API 把整个库装进内存。
 */
export function measureBackupPayload(bytes: unknown): { readonly byteLength: number; readonly sha256: string } | undefined {
	const trusted = trustedByteView(bytes);
	if (trusted === undefined) return undefined;
	return { byteLength: trusted.byteLength, sha256: sha256Hex(trusted.view) };
}

/**
 * 核验 payload 与清单一致。
 *
 * 成功只表示**清单协议合法且清单与所给字节一致**，不表示已导出、已落盘、
 * 支持业务版本或可以立即恢复——那些都是 D2/D3 的闸门。
 */
export function verifyBackupPayload(manifest: unknown, entries: unknown, overrides?: Partial<BackupLimits>): BackupPayloadVerification {
	const limits = resolveBackupLimits(overrides);
	const sink = createIssueSink(limits.maxIssues);
	const fail = (code: "invalid-backup-manifest" | "backup-payload-mismatch"): BackupPayloadVerification => ({ ok: false, code, issues: sink.issues(), droppedIssues: sink.dropped() });

	// 第一步：清单本身必须有效。无效清单连"该有哪些字节"都没定义，谈不上核对。
	const validated = validateBackupManifest(manifest, overrides);
	if (!validated.ok) return { ok: false, code: validated.code, issues: validated.issues, droppedIssues: validated.droppedIssues };

	if (!Array.isArray(entries)) {
		sink.add("payload-entry", "entries", "payload 必须是条目数组");
		return fail("backup-payload-mismatch");
	}
	// 条目数上界与清单同一预算：不为一个超大数组做无界工作。
	if (entries.length > limits.maxFiles) {
		sink.add("too-many-files", "entries", `payload 条目数超过上限 ${limits.maxFiles}`);
		return fail("backup-payload-mismatch");
	}

	// 清单已保证 files 内路径不重复，因此这张表是确定的一对一映射。
	const declared = new Map<string, BackupManifestFile>();
	for (const file of validated.manifest.files) declared.set(file.path, file);

	const seen = new Set<string>();
	let totalBytes = 0;

	for (let index = 0; index < entries.length; index += 1) {
		const where = `entries[${index}]`;
		const entry = entries[index];
		if (!isPlainObject(entry)) {
			sink.add("payload-entry", where, "条目必须是普通对象");
			continue;
		}
		if (unknownFieldCount(entry, ENTRY_FIELDS) > 0) sink.add("unknown-field", where, "条目存在未知字段（名称已省略）");

		const path = entry.path;
		if (typeof path !== "string") {
			sink.add("payload-entry", where, "条目的 path 必须是字符串");
			continue;
		}
		const trusted = trustedByteView(entry.bytes);
		// 只接受真实的字节视图：字符串/数字数组、原型伪装与"自有 byteLength"都在这里止住。
		if (trusted === undefined) {
			sink.add("payload-entry", where, "条目的 bytes 必须是真实 Uint8Array/Buffer 视图（原型伪装或自有长度属性一律拒绝）");
			continue;
		}
		if (seen.has(path)) {
			sink.add("payload-duplicate", where, "同一路径在 payload 中出现多次");
			continue;
		}
		seen.add(path);

		const expected = declared.get(path);
		if (expected === undefined) {
			sink.add("payload-unknown-path", where, "payload 含清单未声明的路径");
			continue;
		}
		// 长度比较、总量预算、安全累加与成功摘要全部只用这一个**可信长度**。
		if (trusted.byteLength !== expected.bytes) {
			sink.add("payload-size-mismatch", where, `payload 长度与清单声明不符（声明 ${expected.bytes} 字节）`);
			continue;
		}
		if (sha256Hex(trusted.view) !== expected.sha256) {
			sink.add("payload-hash-mismatch", where, "payload 的 SHA-256 与清单声明不符");
			continue;
		}
		if (totalBytes > Number.MAX_SAFE_INTEGER - trusted.byteLength) {
			sink.add("payload-too-large", where, "payload 总字节累加会在安全整数范围溢出");
			return fail("backup-payload-mismatch");
		}
		totalBytes += trusted.byteLength;
	}

	// 清单声明却在 payload 里缺席：这是"缺文件"，与"多文件"必须分别报出。
	for (const [index, file] of validated.manifest.files.entries()) {
		if (!seen.has(file.path)) sink.add("payload-missing", `files[${index}]`, "清单声明的文件在 payload 里缺席");
	}

	if (sink.count() > 0) return fail("backup-payload-mismatch");
	return { ok: true, files: validated.manifest.files.length, totalBytes };
}
