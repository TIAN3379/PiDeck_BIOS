/**
 * 备份/恢复两侧共用的**路径段比较**（BM-02D2 / D3）。
 *
 * 为什么单独一份而不是各自 `startsWith`：导出与恢复都要判断"两个目标是否重叠"
 * （源在目标内、目标在源内、或词法分离但 canonical 后重叠）。字符串前缀比较会把
 * `C:\know` 与 `C:\knowledge` 判成同一条链，于是要么误拒合法布局，要么放过真正的重叠。
 * 按**路径段**比较才能同时避免这两个方向。
 *
 * 同时把"重叠即抛什么错"收在一处：两类入口（导出/恢复）必须给出同一个受控类别
 * `backup-target-overlap`，否则调用方要按入口分别识别"重叠"这件事。
 */
import { normalize } from "node:path";
import { StorageError } from "../errors.ts";

/** 路径段（忽略空段与 `.`；Windows 不区分大小写，与 boundary/registry 同一口径）。 */
function keySegments(value: string): string[] {
	return normalize(value)
		.split(/[\\/]+/)
		.filter((segment) => segment.length > 0 && segment !== ".")
		.map((segment) => (process.platform === "win32" ? segment.toLowerCase() : segment));
}

/** `child` 是否就是 `parent` 或位于其下（按路径段，不用字符串前缀）。 */
export function isSameOrInsidePath(child: string, parent: string): boolean {
	const target = keySegments(parent);
	const candidate = keySegments(child);
	if (candidate.length < target.length) return false;
	return target.every((segment, index) => candidate[index] === segment);
}

/**
 * 两个路径必须互不包含（相同也算重叠）。
 *
 * 失败固定收敛成 `backup-target-overlap`：调用方只需要知道"这两个位置不能这样组合"，
 * 不需要按入口识别两套措辞。
 */
export function assertPathsDisjoint(left: string, right: string, message: string): void {
	if (isSameOrInsidePath(left, right) || isSameOrInsidePath(right, left)) {
		throw new StorageError("backup-target-overlap", message, { detail: "overlap" });
	}
}
