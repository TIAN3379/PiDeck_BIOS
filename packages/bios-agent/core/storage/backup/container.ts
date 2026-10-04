/**
 * 备份容器的**实际唯一集合**盘点与清单比对（BM-02D2 / D2R，D3 复用）。
 *
 * round22 §3（D2-2）证明：只逐个打开清单里声明的文件是不够的——额外文件、缺掉的空目录、
 * 被换成链接的目录、容器根上的未知条目，都能在"每个声明文件的 hash 都对"的情况下溜过去，
 * 于是完成标记照发，实际却是一份**不可解释的容器**。
 *
 * 因此这里做三件事，都是只读、有界、拒绝链接：
 * 1. 从容器根起按预算枚举真实条目，区分常规文件 / 目录 / 链接；
 * 2. 与清单的目录、文件集合做**全量**比对（多一个少一个都不通过）；
 * 3. 比对结果只回**计数与受控定位**，不回显未知条目名（那是调用方之外的内容）。
 */
import { opendir } from "node:fs/promises";
import { fsErrorCode, isNotFoundError, StorageError, throwIfAnyCancelled } from "../errors.ts";
import type { BackupLimits } from "./limits.ts";
import type { TargetRuntime } from "./target.ts";

/** 容器盘点结果：`directories` / `files` 相对 `data/`，`rootEntries` 是容器根的直接子项名。 */
export type ContainerInventory = {
	readonly rootEntries: readonly string[];
	readonly directories: readonly string[];
	readonly files: readonly string[];
	/** 任何位置出现的链接或非常规条目（相对容器根）；非空即拒绝。 */
	readonly links: readonly string[];
};

/** 容器根只允许这两个条目（`manifest.json` 是完成标记）。 */
export const CONTAINER_ROOT_ENTRIES: readonly string[] = ["data", "manifest.json"];

function compare(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

/** 一次观察到的目录条目（`Dirent` 的最小投影，避免在内存里留下整批条目）。 */
export type ObservedEntry = { readonly name: string; readonly isDirectory: boolean; readonly isSymbolicLink: boolean; readonly isFile: boolean };

/**
 * 逐项列举一个目录：`opendir` 惰性产出，每条交给 `visit` 后即刻丢弃；提前退出/抛错时目录句柄
 * 由 `for await` 的 `return()` 与 `finally` 的 `close()` 双重保证关闭（R23-3）。
 *
 * 对 D3 恢复目标复用同一份原语：目标的真实集合是**知识库布局**（没有 `data/` 前缀），
 * 但"逐项有界、拒绝链接、句柄成对关闭"的纪律不能各写一遍。
 */
export async function forEachDirectoryEntry(runtime: TargetRuntime, absolute: string, callSignal: AbortSignal | undefined, visit: (entry: ObservedEntry) => void): Promise<void> {
	let dir;
	try {
		dir = await opendir(absolute);
	} catch (error) {
		if (isNotFoundError(error)) throw new StorageError("not-found", "容器内目录缺失", { detail: "container-missing-directory" });
		throw new StorageError("permission-denied", "无法盘点容器目录", { detail: fsErrorCode(error) });
	}
	try {
		for await (const entry of dir) {
			throwIfAnyCancelled([callSignal, runtime.signal]);
			visit({ name: String(entry.name), isDirectory: entry.isDirectory(), isSymbolicLink: entry.isSymbolicLink(), isFile: entry.isFile() });
		}
	} finally {
		await dir.close().catch(() => undefined);
	}
}

/**
 * 枚举容器真实集合（只读、**逐项有界**）。
 *
 * R23-3 的修正点：旧版先 `readdir` 整目录、再 `map` 全部条目、最后才判预算——1000 个未知文件会
 * 被完整装载与转换（实测访问 1005 次 name）之后才失败，等于"失败结论正确但工作量无界"。
 * 现在改成 `opendir` 逐项观察，**每观察到一条就计费**，超预算立刻停手并受控失败。
 *
 * **预算口径（对外披露）**：允许观察条数 = payload 文件上限 `maxFiles` ＋ payload 目录上限
 * `maxDirectories` ＋ 固定容器根条目 2（`data`、`manifest.json`）＋ 一次超限探测 1。
 * 根/data 的容器元目录**不计入** payload 目录口径；`maxFiles`/`maxDirectories` 仍是清单侧同一套 D1 限额。
 * 链接一律只登记、不跟随（Windows junction 在 dirent 上同样报告为链接）；未知根条目与未知类型
 * **立即**受控失败，不递归未知子树。
 */
export type DeclaredContainerEntries = {
	readonly directories: ReadonlySet<string>;
	readonly files: ReadonlySet<string>;
};

export async function enumerateContainer(runtime: TargetRuntime, containerRoot: string, limits: BackupLimits, callSignal?: AbortSignal, declared?: DeclaredContainerEntries): Promise<ContainerInventory> {
	const rootEntries: string[] = [];
	const directories: string[] = [];
	const files: string[] = [];
	const links: string[] = [];
	const budget = limits.maxFiles + limits.maxDirectories + 3;
	let observed = 0;
	const charge = (): void => {
		observed += 1;
		if (observed > budget) throw new StorageError("too-large", `容器条目数超过扫描预算 ${budget}，拒绝据此判定完整`, { detail: "container-budget-exceeded" });
	};

	// 根：只允许固定条目；出现别的名字立即失败，不继续观察、不递归未知子树。
	let hasData = false;
	await forEachDirectoryEntry(runtime, containerRoot, callSignal, (entry) => {
		charge();
		if (entry.name !== "data" && entry.name !== "manifest.json") throw new StorageError("backup-payload-mismatch", "备份容器根出现未声明的条目，拒绝判定为完整备份", { detail: "container-root-entries" });
		rootEntries.push(entry.name);
		if (entry.name !== "data") return;
		if (entry.isSymbolicLink || !entry.isDirectory) throw new StorageError("backup-payload-mismatch", "备份容器的 data 不是常规目录，拒绝跟随", { detail: "container-link" });
		hasData = true;
	});

	if (hasData) {
		const pending: string[] = ["data"];
		while (pending.length > 0) {
			const current = pending.pop();
			if (current === undefined) break;
			await forEachDirectoryEntry(runtime, `${containerRoot}/${current}`, callSignal, (entry) => {
				charge();
				const relative = `${current}/${entry.name}`;
				// 清单里的 `directories` / `files` 都以 `data/` 为根，因此报告时剥掉前缀。
				const relativeToData = relative.slice("data/".length);
				if (entry.isSymbolicLink) throw new StorageError("backup-payload-mismatch", "容器内存在链接或非常规条目，拒绝判定为完整备份", { detail: "container-link" });
				if (entry.isDirectory) {
					// R24-2：**入队前**按清单集合判定；未声明的目录立即拒绝，绝不 opendir 未知子树。
					if (declared !== undefined && !declared.directories.has(relativeToData)) {
						throw new StorageError("backup-payload-mismatch", "容器内出现清单未声明的目录，拒绝进入该子树", { detail: "container-undeclared-directory" });
					}
					directories.push(relativeToData);
					if (directories.length > limits.maxDirectories) throw new StorageError("too-large", `容器目录数超过预算 ${limits.maxDirectories}，拒绝据此判定完整`, { detail: "container-too-many-directories" });
					pending.push(relative);
					return;
				}
				if (!entry.isFile) throw new StorageError("backup-payload-mismatch", "容器内存在非常规条目，拒绝判定为完整备份", { detail: "container-entry-type" });
				if (declared !== undefined && !declared.files.has(relativeToData)) {
					throw new StorageError("backup-payload-mismatch", "容器内出现清单未声明的文件，拒绝判定为完整备份", { detail: "container-undeclared-file" });
				}
				files.push(relativeToData);
				if (files.length > limits.maxFiles) throw new StorageError("too-large", `容器文件数超过预算 ${limits.maxFiles}，拒绝据此判定完整`, { detail: "container-too-many-files" });
			});
		}
	}

	rootEntries.sort(compare);
	directories.sort(compare);
	files.sort(compare);
	links.sort(compare);
	return { rootEntries, directories, files, links };
}

/** 清单声明的一侧：目录与文件都以 `data/` 为根。 */
export type ManifestCollection = {
	readonly directories: readonly string[];
	readonly files: readonly { readonly path: string }[];
};

/**
 * 与清单做全量比对；任何差异都是受控失败，且不回显未知条目名。
 *
 * `manifestPresent` 区分两个时点：导出时完成标记**最后**发布，所以核对发生在它出现之前
 * （根只应有 `data`；此时已存在 `manifest.json` 反而是冲突）；恢复时读的是已完成容器
 * （根必须恰好 `data` + `manifest.json`）。两个时点都不接受任何其它条目。
 */
export function assertContainerMatchesManifest(inventory: ContainerInventory, manifest: ManifestCollection, options: { readonly manifestPresent: boolean }): void {
	if (inventory.links.length > 0) throw new StorageError("backup-payload-mismatch", "容器内存在链接或非常规条目，拒绝判定为完整备份", { detail: "container-link" });
	const expectedRoot = options.manifestPresent ? [...CONTAINER_ROOT_ENTRIES].sort(compare) : ["data"];
	if (inventory.rootEntries.join("\n") !== expectedRoot.join("\n")) {
		throw new StorageError("backup-payload-mismatch", options.manifestPresent ? "备份容器根条目不是恰好 manifest.json 与 data" : "备份容器根条目不是恰好 data（完成标记尚未发布）", { detail: "container-root-entries" });
	}
	const expectedDirectories = [...manifest.directories].sort(compare);
	const expectedFiles = manifest.files.map((file) => file.path).sort(compare);
	if (differs(inventory.directories, expectedDirectories)) {
		throw new StorageError("backup-payload-mismatch", `data/ 实际目录集合与清单不一致（实际 ${inventory.directories.length} 条，清单 ${expectedDirectories.length} 条）`, { detail: "container-directories" });
	}
	if (differs(inventory.files, expectedFiles)) {
		throw new StorageError("backup-payload-mismatch", `data/ 实际文件集合与清单不一致（实际 ${inventory.files.length} 条，清单 ${expectedFiles.length} 条）`, { detail: "container-files" });
	}
}

function differs(actual: readonly string[], expected: readonly string[]): boolean {
	if (actual.length !== expected.length) return true;
	for (let index = 0; index < actual.length; index += 1) if (actual[index] !== expected[index]) return true;
	return false;
}
