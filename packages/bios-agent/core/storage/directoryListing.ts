/**
 * 有界目录列举的**对外形状**（BM-02AR / BM-02C3R-S2）。
 *
 * 为什么单独一个文件：它被 `boundary.ts`（实现）与预检（消费）共用，且 S2 给选项加了
 * "受控观察计量"后 `boundary.ts` 越过了 600 行的拆分门槛——把"列举的输入/输出契约"
 * 与"怎么有界地读写"分开，是这一步最小且不改变任何行为的拆分。
 *
 * `boundary.ts` 仍然原样再导出这两个类型，既有调用方的 import 不需要改。
 */

/** 一次有界目录列举的结果。 */
export type DirectoryEntryListing = {
	names: string[];
	/** true 表示达到条目上限，结果不完整。 */
	truncated: boolean;
	/**
	 * 本次实际观察的条目数（含被跳过的链接/未知条目与超限探测条目）。
	 *
	 * 这是**成功出口**的计数；迭代中途失败时不会走到这里，失败前已观察的条目数
	 * 由 `ListEntriesOptions.observe` 实时交回（S2）。
	 */
	scanned: number;
};

/** 有界目录列举的选项（BM-02AR / S2）。 */
export type ListEntriesOptions = {
	/** 只要常规文件（链接与子目录按 `includeSymlinks` 规则处理）。 */
	filesOnly?: boolean;
	/** 最多**观察**的条目数（含被跳过的链接/未知条目）：超过即截断。 */
	maxEntries?: number;
	signal?: AbortSignal;
	/** 是否把链接名字交回调用方（由调用方在打开前用 `assertNoSymlinks` 拒绝）。 */
	includeSymlinks?: boolean;
	/**
	 * **受控观察计量**（BM-02C3R / S2）：每实际观察到一个目录条目就回调一次，
	 * 参数是**本次列举的累计**观察数（不是增量）。
	 *
	 * 为什么需要它：`scanned` 只在**成功结束**时随结果返回，迭代中途失败时已经交出的条目数
	 * 会随异常一起丢掉；调用方（预检）拿不到"失败前已观察多少"，就无法把这段成本计入
	 * 共享预算，后续目录会拿到虚高的剩余额度、真实观察因此超上限。
	 * 有了它，"成功 / 截断 / 迭代失败"三种出口共用**同一个**计量来源：调用方不需要
	 * 从原始异常正文猜计数，成功路径也不会把它与结果里的 `scanned` 重复相加。
	 * 不传时行为与以前完全一致（既有调用者的结果与错误语义不变）。
	 */
	observe?: (observed: number) => void;
};
