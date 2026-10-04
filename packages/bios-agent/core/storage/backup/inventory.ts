/**
 * 源知识库的**受控 inventory**（BM-02D2）。
 *
 * 预检是**准入**工具，不是复制清单：它的明细可以按预算裁剪，`complete=true` 也不等于
 * "我拿到了每个要复制的文件"。因此这里另做一次固定深度的目录盘点，判据与 D1 落点表**同一份**
 * （`classifyBackupFilePath` / `classifyBackupDirectoryPath`），并遵守四条纪律：
 *
 * 1. **不递归未知子树**、不跟随内部链接（链接条目交给落点判据明确拒绝）；
 * 2. **列表截断即失败**：截断过的清单不能"抄一半还说完整"；
 * 3. **未知落点即失败**（含知识根布局外条目）：出现表外东西还宣称完整，等于把不可解释的内容
 *    留在原地却给出一份"正常备份"；
 * 4. **cache/locks 不进入清单**：它们是协议排除项；`data/` 下不复制、也不登记它们的子目录。
 *
 * 只读：不创建、不删除、不按 PID/年龄判断任何东西。
 */
import type { StorageBoundary } from "../boundary.ts";
import { isCancelledError, StorageError } from "../errors.ts";
import { knowledgeLayout } from "../registry.ts";
import { BACKUP_EXCLUDED_DIRECTORIES } from "./contract.ts";
import type { BackupLimits } from "./limits.ts";
import { BACKUP_LAYOUT_SEGMENTS, classifyBackupDirectoryPath, classifyBackupFilePath } from "./paths.ts";

export type SourceInventoryFile = {
	/** 相对 `data/` 的规范路径（`/` 分隔）。 */
	readonly path: string;
	/** 知识根内的绝对路径（已通过 boundary 的根内/链接判定）。 */
	readonly absolute: string;
};

export type SourceInventory = {
	/** 按规范路径稳定排序。 */
	readonly files: readonly SourceInventoryFile[];
	/** 相对 `data/` 的规范目录路径（含已知空目录），按路径稳定排序。 */
	readonly directories: readonly string[];
};

/** 知识根允许出现的直接子项：本次要复制的固定目录 + 协议排除项。 */
const KNOWN_ROOT_ENTRIES: ReadonlySet<string> = new Set([BACKUP_LAYOUT_SEGMENTS.registryFile, BACKUP_LAYOUT_SEGMENTS.projectsDir, BACKUP_LAYOUT_SEGMENTS.experiencesDir, BACKUP_LAYOUT_SEGMENTS.featuresDir, BACKUP_LAYOUT_SEGMENTS.auditDir, BACKUP_LAYOUT_SEGMENTS.journalDir, ...BACKUP_EXCLUDED_DIRECTORIES]);

/**
 * 盘点源知识库的受控落点。
 *
 * 任何未知落点、受控区内的链接、超限或截断都直接失败——不做"跳过继续"的降级。
 */
export async function collectSourceInventory(boundary: StorageBoundary, limits: BackupLimits, signal?: AbortSignal): Promise<SourceInventory> {
	const layout = knowledgeLayout(boundary);
	const files: SourceInventoryFile[] = [];
	const directories: string[] = [];
	const ineligible = (message: string, path: string): StorageError => new StorageError("backup-source-not-eligible", message, { path });

	const truncated = (relative: string): StorageError => new StorageError("too-large", `盘点被扫描预算截断，拒绝据此导出备份：${relative}`, { path: relative, detail: "inventory-truncated" });

	const list = async (absolute: string, relative: string, required: boolean): Promise<readonly string[] | undefined> => {
		try {
			// `includeSymlinks: true`：链接不静默消失，名字交回来由落点判据/读取前判定明确拒绝。
			const listing = await boundary.listEntries(absolute, { filesOnly: false, maxEntries: boundary.limits.maxScanEntries, signal, includeSymlinks: true });
			// 截断过就绝不继续：抄下来的东西不是"这份库的全部"。
			if (listing.truncated) throw truncated(relative);
			return listing.names;
		} catch (error) {
			if (isCancelledError(error)) throw error;
			if (error instanceof StorageError && error.detail === "inventory-truncated") throw error;
			if (error instanceof StorageError) {
				// 可选目录不存在是正常"未使用"，不是问题；其余失败一律如实上报。
				if (error.code === "not-found" && !required) return undefined;
				throw new StorageError(error.code, `无法盘点目录（${error.code}）：${relative}`, { path: relative });
			}
			// 未分类异常不透传原始正文（可能含客户路径）。
			throw new StorageError("backup-io-failed", `无法盘点目录：${relative}`, { path: relative, detail: "unclassified" });
		}
	};

	const addDirectory = (relative: string): void => {
		const classification = classifyBackupDirectoryPath(relative, limits);
		if (!classification.ok) throw ineligible(`受控目录判据不通过（${classification.reason.code}）：${relative}`, relative);
		directories.push(relative);
	};

	const addFile = (relative: string): void => {
		const classification = classifyBackupFilePath(relative, limits);
		if (!classification.ok) throw ineligible(`受控落点判据不通过（${classification.reason.code}）：${relative}`, relative);
		files.push({ path: relative, absolute: boundary.resolve(...relative.split("/")) });
	};

	/** 列出一个目录并把它登记为已知目录（含空目录）。 */
	const addDirectoryWithChildren = async (absolute: string, relative: string, required: boolean): Promise<readonly string[] | undefined> => {
		const names = await list(absolute, relative, required);
		if (names !== undefined) addDirectory(relative);
		return names;
	};

	// 知识根：只接受 registry.json 与已知目录名；布局外条目直接拒绝（不静默忽略后宣称完整）。
	for (const name of (await list(boundary.root, ".", true)) ?? []) {
		if (name === BACKUP_LAYOUT_SEGMENTS.registryFile) addFile(name);
		else if (!KNOWN_ROOT_ENTRIES.has(name)) throw ineligible("知识根存在布局外条目（名称已省略）：拒绝导出", ".");
	}

	// 四个必需固定目录。
	for (const [absolute, relative] of [
		[layout.projectsDir, BACKUP_LAYOUT_SEGMENTS.projectsDir],
		[layout.experiencesDir, BACKUP_LAYOUT_SEGMENTS.experiencesDir],
		[layout.featuresDir, BACKUP_LAYOUT_SEGMENTS.featuresDir],
		[layout.auditDir, BACKUP_LAYOUT_SEGMENTS.auditDir],
	] as const) {
		await addDirectoryWithChildren(absolute, relative, true);
	}

	// 记录目录：目录里只接受受控记录文件。
	for (const [directory, relative] of [
		[layout.experiencesDir, BACKUP_LAYOUT_SEGMENTS.experiencesDir],
		[layout.featuresDir, BACKUP_LAYOUT_SEGMENTS.featuresDir],
	] as const) {
		for (const name of (await list(directory, relative, true)) ?? []) addFile(`${relative}/${name}`);
	}

	// journal：可选（惰性创建），存在则保留目录本身。
	for (const name of (await addDirectoryWithChildren(layout.journalDir, BACKUP_LAYOUT_SEGMENTS.journalDir, false)) ?? []) addFile(`${BACKUP_LAYOUT_SEGMENTS.journalDir}/${name}`);

	// audit：`intents/` 与 `<recordId>/` 都是目录；子项一律按文件落点判定。
	for (const name of (await list(layout.auditDir, BACKUP_LAYOUT_SEGMENTS.auditDir, true)) ?? []) {
		const relative = `${BACKUP_LAYOUT_SEGMENTS.auditDir}/${name}`;
		const child = await addDirectoryWithChildren(boundary.resolve(BACKUP_LAYOUT_SEGMENTS.auditDir, name), relative, true);
		for (const childName of child ?? []) addFile(`${relative}/${childName}`);
	}

	// projects：项目目录 → profile.json + tasks/ + context/。
	for (const projectId of (await list(layout.projectsDir, BACKUP_LAYOUT_SEGMENTS.projectsDir, true)) ?? []) {
		const projectRelative = `${BACKUP_LAYOUT_SEGMENTS.projectsDir}/${projectId}`;
		const project = await addDirectoryWithChildren(boundary.resolve(BACKUP_LAYOUT_SEGMENTS.projectsDir, projectId), projectRelative, true);
		for (const name of project ?? []) {
			if (name === BACKUP_LAYOUT_SEGMENTS.profileFile) {
				addFile(`${projectRelative}/${name}`);
				continue;
			}
			const childRelative = `${projectRelative}/${name}`;
			const child = await addDirectoryWithChildren(boundary.resolve(BACKUP_LAYOUT_SEGMENTS.projectsDir, projectId, name), childRelative, true);
			for (const childName of child ?? []) addFile(`${childRelative}/${childName}`);
		}
	}

	// 稳定顺序：不是有效性前提，但让清单可复现、便于两次盘点比对。
	files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
	directories.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
	return { files, directories };
}

/** inventory 的路径集合指纹（用于"两次盘点是否一致"的快速比较）。 */
export function inventorySignature(inventory: SourceInventory): string {
	return [...inventory.directories, ...inventory.files.map((file) => file.path)].join("\n");
}
