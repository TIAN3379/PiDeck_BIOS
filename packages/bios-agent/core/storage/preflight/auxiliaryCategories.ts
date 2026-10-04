/**
 * 预检的**辅助复核落点遍历**（BM-02C3）：协作锁、`cache/`、根布局外的条目。
 *
 * 为什么从 `categories.ts` 拆出来：这三类落点与"业务记录/审核工件"的读法无关
 * （锁与 cache 根本不读正文，根只列一层），而且 C3R 的根级错误出口让原文件越过
 * 400 行体量目标——按落点职责拆开比继续堆在同一个文件里更好维护。
 *
 * 与 `categories.ts` 同一套管道：诊断文案复用该文件的 `reportUnknownEntry` / `reportResidue`，
 * 不在这里另写一份（两处各写一遍迟早漂移）。
 */
import { addManual, addProblem, addSummary, boundMessage, listEntriesBounded, reportReadFailure, statusForCode, stopScan, type ScanState } from "./scan.ts";
import { reportResidue, reportUnknownEntry } from "./categories.ts";
import { probePath } from "./pathProbe.ts";

/** 知识根的固定落点；除此之外的条目只诊断、不进入。 */
const KNOWN_ROOT_ENTRIES: ReadonlySet<string> = new Set(["registry.json", "projects", "experiences", "features", "journal", "audit", "locks", "cache"]);

/** 锁目录名是受控形状（`lock-` + sha256 前 32 位）：只有它才允许出现在受控路径里。 */
const LOCK_ENTRY_PATTERN = /^lock-[0-9a-f]{32}$/;

/** `locks/`：只报告存在，不按 PID/年龄判断可否抢占、不删除、不清理。 */
export async function scanLocksDirectory(scan: ScanState): Promise<void> {
	const listing = await listEntriesBounded(scan, scan.boundary.resolve("locks"), false);
	if ("stopped" in listing || "absent" in listing) return;
	if ("error" in listing) {
		reportReadFailure(scan, { category: "lock", relativePath: "locks", family: "record", code: listing.error.code, message: listing.error.message });
		return;
	}
	for (const name of listing.entries) {
		if (scan.stopped) return;
		if (name.endsWith(".tmp")) {
			reportResidue(scan);
			continue;
		}
		if (!LOCK_ENTRY_PATTERN.test(name)) {
			reportUnknownEntry(scan, { category: "lock", parent: "locks", blocks: false, message: "locks/ 下存在不是受控锁名的条目（名称已省略），不进入扫描" });
			continue;
		}
		addManual(scan, {
			category: "lock",
			relativePath: `locks/${name}`,
			reason: "lock-present",
			message: boundMessage(scan, "存在协作锁：预检不按 PID/年龄判断可否抢占、不删除、不清理，请人工确认"),
		});
	}
}

/** `cache/`：只探测存在性，明确标成"未检查"（可重建、不是事实记录），不递归、不进版本统计。 */
export async function scanCacheDirectory(scan: ScanState): Promise<void> {
	const probe = await probePath(scan, scan.boundary.resolve("cache"));
	if (probe.kind === "absent" || probe.kind === "link") return;
	if (probe.kind === "failed") {
		// 连"缓存目录在不在"都探测不到也是事实缺口：按受控类别报出来，不静默当成正常缺席（PF-1）。
		const status = statusForCode(probe.code);
		addSummary(scan, { category: "cache", relativePath: "cache/", status, version: null, code: probe.code });
		addProblem(scan, { category: "cache", relativePath: "cache/", status, code: probe.code, message: boundMessage(scan, probe.message), blocks: true });
		return;
	}
	addSummary(scan, { category: "cache", relativePath: "cache/", status: "unchecked", version: null, code: null });
}

/**
 * 根布局外的条目（含根级 `.tmp` 残留）与**根自身列举失败**。
 *
 * 根是必需落点（BM-02C3R / PF-1）：列举被拒或根在扫描期间消失，都不能等价于
 * "可选目录未使用"——否则根布局外的文件与残留会被静默跳过，报告还宣称完整。
 * 这里明确报成阻断 + `root-listing` 截断：结论是 `incomplete`，绝不给通过。
 */
export async function scanRootExtras(scan: ScanState): Promise<void> {
	const listing = await listEntriesBounded(scan, scan.boundary.root, true);
	if ("stopped" in listing) return;
	if ("absent" in listing || "error" in listing) {
		const code = "error" in listing ? listing.error.code : "not-found";
		const status = statusForCode(code);
		// 根是复合落点，不对应单一版本族：这里刻意不计入版本统计（避免造出 record:unknown 这类假计数）。
		addSummary(scan, { category: "unknown", relativePath: ".", status, version: null, code });
		addProblem(scan, { category: "unknown", relativePath: ".", status, code, message: boundMessage(scan, `知识根无法列举：${code}；根布局外条目未被检查`), blocks: true });
		stopScan(scan, "root-listing");
		return;
	}
	for (const name of listing.entries) {
		if (scan.stopped) return;
		if (KNOWN_ROOT_ENTRIES.has(name)) continue;
		if (name.endsWith(".tmp")) {
			reportResidue(scan);
			continue;
		}
		reportUnknownEntry(scan, { category: "unknown", parent: ".", blocks: false, message: "知识根存在布局外的条目（名称已省略），不进入扫描" });
	}
}
