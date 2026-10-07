/**
 * 测试专用：通过 Node 的 loader hook **预加载**一个真实故障注入。
 *
 * 为什么需要它：R29-3 要求"真实预加载故障的业务 CLI"回归，而不是只测退出码映射函数。
 * 生产代码本身不携带任何测试钩子（`ioHooks` 只接受显式函数，且子进程无法传函数），
 * 因此这里用 `module.register` 在**子进程加载源码时**改写 `journal/writer.ts`：
 * `finalizeJournalEntry` 在 `state === "committed"` 时返回注入的 EBUSY 失败。
 * 于是"数据已提交、journal 终态未写"这一真实半完成状态可以在真实 CLI 子进程里复现。
 *
 * 只影响被显式以 `--import` 加载该预加载模块的进程；正常测试路径不受影响。
 */
import { register } from "node:module";

register("./journalFaultHook.mjs", import.meta.url);
