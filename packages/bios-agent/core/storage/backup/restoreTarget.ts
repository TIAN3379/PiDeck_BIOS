/**
 * 恢复**目标**（新知识根）的期望布局与实际集合核对（BM-02D3）。
 *
 * 为什么不直接复用 `container.ts` 的 `assertContainerMatchesManifest`：那个判据描述的是
 * **备份容器**的形状（根恰好 `manifest.json` + `data/`，集合相对 `data/`）。恢复目标是一份
 * **知识库布局**——根下直接是 `registry.json`、业务目录，另外要有**空**的 `cache/` 与 `locks/`。
 * 拿容器包装去套目标会在两个方向都出错：多出的顶层 `data/` 会被当成未知，而 `cache/locks`
 * 又不在备份清单里。所以这里另写一份**目标集合**判据，但复用同一套
 * "逐项有界、拒绝链接、句柄成对关闭"的枚举原语。
 *
 * 纪律：
 * - `cache`/`locks` 必须存在且**为空**（旧锁/缓存不得随备份进入新库）；
 * - 实际集合必须与期望集合**全量相等**：多一个少一个都不算恢复成功（外部在复制期间写入
 *   或是我们漏建了空目录，都必须暴露而不是被"反正能读"掩盖）；
 * - 诊断只回受控计数/定位，不回显未知条目名。
 */
import { Buffer } from "node:buffer";
import { join } from "node:path";
import { StorageError } from "../errors.ts";
import type { BackupManifest } from "./contract.ts";
import { forEachDirectoryEntry, type ObservedEntry } from "./container.ts";
import type { BackupLimits } from "./limits.ts";
import { BACKUP_LAYOUT_SEGMENTS } from "./paths.ts";
import { assertAncestorsOwned, readBoundedFile, readOwnedFileBounded, targetAbsolute, type TargetRuntime, type TargetSession } from "./target.ts";
import { measureBackupPayload } from "./verify.ts";

/** 恢复目标必须另外创建的**空**目录（备份协议显式排除，恢复时不能为空缺）。 */
export const RESTORE_EMPTY_DIRECTORIES: readonly string[] = ["cache", "locks"];

/** 完成标记（registry）以非覆盖发布为完成点，因此目标集合核对时它**还不存在**。 */
export const RESTORE_REGISTRY_RELATIVE = BACKUP_LAYOUT_SEGMENTS.registryFile;

export type TargetLayout = {
	/** 相对知识根的目录（含空目录），已排序。 */
	readonly directories: readonly string[];
	/** 相对知识根的文件，已排序；不含尚未发布的 registry。 */
	readonly files: readonly string[];
};

function compare(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

/** 由清单派生的目标期望布局（顺序无关：统一排序后再比对）。 */
export function expectedTargetLayout(manifest: BackupManifest, options: { registryPublished?: boolean } = {}): TargetLayout {
	const directories = [...new Set([...manifest.directories, ...RESTORE_EMPTY_DIRECTORIES])].sort(compare);
	const files = manifest.files
		.map((file) => file.path)
		.filter((path) => path !== RESTORE_REGISTRY_RELATIVE || options.registryPublished === true)
		.sort(compare);
	return { directories, files };
}

export type DeclaredTargetEntries = {
	readonly directories: ReadonlySet<string>;
	readonly files: ReadonlySet<string>;
};

/**
 * 有界枚举目标实际集合。
 *
 * 预算口径与容器盘点同源（`maxFiles` + `maxDirectories`），另加 `cache`/`locks` 两个空目录
 * 与一次超限探测；观察到未声明的条目、链接或非常规类型**立即**受控失败，不递归未知子树。
 */
export async function enumerateTargetLayout(runtime: TargetRuntime, targetRoot: string, limits: BackupLimits, signal: AbortSignal | undefined, declared: DeclaredTargetEntries): Promise<TargetLayout> {
	const directories: string[] = [];
	const files: string[] = [];
	const budget = limits.maxFiles + limits.maxDirectories + 5;
	let observed = 0;
	const charge = (): void => {
		observed += 1;
		if (observed > budget) throw new StorageError("too-large", `恢复目标条目数超过扫描预算 ${budget}，拒绝据此判定完整`, { detail: "target-budget-exceeded" });
	};

	const pending: string[] = [""];
	while (pending.length > 0) {
		const current = pending.pop();
		if (current === undefined) break;
		const absolute = current === "" ? targetRoot : join(targetRoot, ...current.split("/"));
		await forEachDirectoryEntry(runtime, absolute, signal, (entry: ObservedEntry) => {
			charge();
			const relative = current === "" ? entry.name : `${current}/${entry.name}`;
			if (entry.isSymbolicLink) throw new StorageError("backup-target-exists", "恢复目标内出现链接或非常规条目，拒绝判定为已恢复", { detail: "target-link" });
			if (entry.isDirectory) {
				if (!declared.directories.has(relative)) throw new StorageError("backup-target-exists", "恢复目标内出现未声明的目录，拒绝继续", { detail: "target-undeclared-directory" });
				directories.push(relative);
				if (directories.length > limits.maxDirectories + RESTORE_EMPTY_DIRECTORIES.length) throw new StorageError("too-large", `恢复目标目录数超过预算 ${limits.maxDirectories}，拒绝据此判定完整`, { detail: "target-too-many-directories" });
				pending.push(relative);
				return;
			}
			if (!entry.isFile) throw new StorageError("backup-target-exists", "恢复目标内出现非常规条目，拒绝判定为已恢复", { detail: "target-entry-type" });
			if (!declared.files.has(relative)) throw new StorageError("backup-target-exists", "恢复目标内出现未声明的文件，拒绝判定为已恢复", { detail: "target-undeclared-file" });
			files.push(relative);
			if (files.length > limits.maxFiles) throw new StorageError("too-large", `恢复目标文件数超过预算 ${limits.maxFiles}，拒绝据此判定完整`, { detail: "target-too-many-files" });
		});
	}

	directories.sort(compare);
	files.sort(compare);
	return { directories, files };
}

/** 实际集合与期望集合全量相等，否则受控失败（不回显未知条目名）。 */
export function assertTargetLayoutMatches(actual: TargetLayout, expected: TargetLayout): void {
	if (actual.directories.length !== expected.directories.length || actual.directories.some((entry, index) => entry !== expected.directories[index])) {
		throw new StorageError("backup-target-exists", `恢复目标实际目录集合与清单不一致（实际 ${actual.directories.length} 条，期望 ${expected.directories.length} 条）`, { detail: "target-directories" });
	}
	if (actual.files.length !== expected.files.length || actual.files.some((entry, index) => entry !== expected.files[index])) {
		throw new StorageError("backup-target-exists", `恢复目标实际文件集合与清单不一致（实际 ${actual.files.length} 条，期望 ${expected.files.length} 条）`, { detail: "target-files" });
	}
}

/** 目标字节/布局与清单不再吻合 ⇒ 完成点后按"需复核"报告，不冒充原字节恢复成功。 */
function targetDrift(message: string, detail: string): StorageError {
	return new StorageError("backup-target-exists", message, { detail });
}

/**
 * 目标复核：**集合、归属与逐文件字节**都要与清单一致（第二十六轮 R26-2）。
 *
 * 为什么集合核对之外还必须有字节核对：集合只说"哪些文件在"，说不出"文件还是不是被抄下来的那些字节"。
 * 在完成点之前执行时，任何差异都拒绝发布；在完成点之后执行时，调用方把失败映射成
 * `committed-needs-review`（published 仍为 true，库保留），不用清理删掉可观察到的变化来"强行通过"。
 *
 * 次数是**有限**的：调用方在完成点前后各调用一次，不做"反复扫到磁盘不变为止"的循环。
 * `registryBytes` 给出时表示 registry 已发布：此时 registry 不在自有登记表里，
 * 因此先核对祖先归属、再按路径有界读取，并与清单声明的长度/hash 比较。
 */
export async function verifyTargetAgainstManifest(session: TargetSession, manifest: BackupManifest, limits: BackupLimits, signal: AbortSignal | undefined, options: { registryBytes?: Buffer } = {}): Promise<void> {
	const published = options.registryBytes !== undefined;
	const expected = expectedTargetLayout(manifest, { registryPublished: published });
	const runtime = session.runtime;
	const actual = await enumerateTargetLayout(runtime, runtime.targetRoot, limits, signal, { directories: new Set(expected.directories), files: new Set(expected.files) });
	assertTargetLayoutMatches(actual, expected);

	for (const file of manifest.files) {
		const isRegistry = file.path === RESTORE_REGISTRY_RELATIVE;
		if (isRegistry && !published) continue;
		let bytes: Buffer;
		if (isRegistry) {
			await assertAncestorsOwned(session, file.path, signal);
			bytes = await readBoundedFile(runtime, targetAbsolute(runtime, file.path), limits.maxFileBytes, signal);
		} else {
			bytes = await readOwnedFileBounded(session, file.path, limits.maxFileBytes, signal);
		}
		const measured = measureBackupPayload(bytes);
		if (measured === undefined || measured.byteLength !== file.bytes || measured.sha256 !== file.sha256) {
			throw targetDrift("恢复目标文件字节与备份清单不一致（目标已被改写或替换），拒绝继续", "target-payload-drift");
		}
	}
}
