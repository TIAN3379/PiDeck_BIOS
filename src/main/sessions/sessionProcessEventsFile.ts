import type { SessionProcessEvent } from "../../shared/types/trajectory";
// 显式 `.ts` 扩展名：Node 的 type-stripping 直跑测试时才能解析（与 bios-agent 侧同一约定）。
import { scanJsonlLines } from "./jsonlLineStream.ts";
import { MAX_EVENTS, parseSessionProcessEventLine } from "./sessionProcessEvents.ts";

/** 单次增量读取最多返回多少条事件（只针对**本次新增**区间，长会话不受历史条数影响）。 */
export const MAX_INCREMENTAL_EVENTS = 256;

/**
 * R35-2：**增量读**会话文件里自 `offset` 起新增的过程事件。
 *
 * 为什么不能复用"从头读到 MAX_EVENTS"：那是账本展示用的有界读取，长会话（>240 条事件）里
 * 新回执根本不在返回集合内，拿它当实时 ACK 查询会永远超时。
 * 这里只读**追加区间**：调用方先取当前文件长度当游标，之后每次只读游标之后的内容，
 * 因此读取量与"这段时间新增了多少"成正比，不读客户历史。
 *
 * 返回的 `nextOffset` 只推进到**最后一个完整行**之后：文件末尾可能有一条 pi 正在写的残行，
 * 下次轮询会从残行开头重新读到它。
 */
export async function readSessionProcessEventsSince(filePath: string, offset: number): Promise<{ readonly events: SessionProcessEvent[]; readonly nextOffset: number }> {
	const events: SessionProcessEvent[] = [];
	const start = Math.max(0, Math.floor(offset));
	let scanned = 0;
	let trailing = 0;
	try {
		const summary = await scanJsonlLines(
			filePath,
			(line, context) => {
				// 残行（还没写完）不消费：游标不会越过它，下一次轮询重新读。
				if (!context.complete) return;
				const event = parseSessionProcessEventLine(line, context.index);
				if (event === undefined) return;
				events.push(event);
				if (events.length >= MAX_INCREMENTAL_EVENTS) return "stop";
			},
			{ start },
		);
		scanned = summary.bytesScanned;
		trailing = summary.trailingBytes;
	} catch (error) {
		// 读失败但已读到部分新增事件：保留已读结果（调用方按"没看到目标回执"处理）。
		if (events.length === 0) throw error;
	}
	return { events, nextOffset: start + Math.max(0, scanned - trailing) };
}

/** 当前文件长度（增量游标的起点）。 */
export async function sessionFileSize(filePath: string): Promise<number> {
	const { stat } = await import("node:fs/promises");
	const info = await stat(filePath);
	return info.size;
}

/**
 * 直接从会话文件流式抽过程事件（历史会话的轨迹账本入口）。
 *
 * 为什么不做「读全文再 parseSessionProcessEvents」：会话文件可达数百 MB，
 * 整文件 readFile 会撞 V8 单字符串上限（ERR_STRING_TOO_LONG）或主进程 384MB 堆上限
 * （V8 `FatalProcessOutOfMemory` abort → 应用闪退），而账本只需要前 MAX_EVENTS 条事件
 * ——流式 + 收够即停让读取量与实际需要成正比，几百 MB 的会话只会读前几 KB~几 MB。
 * 见 jsonlLineStream 模块注释。
 */
export async function parseSessionProcessEventsFromFile(filePath: string): Promise<SessionProcessEvent[]> {
	const events: SessionProcessEvent[] = [];
	try {
		await scanJsonlLines(filePath, (line, context) => {
			const event = parseSessionProcessEventLine(line, context.index);
			if (!event) return;
			events.push(event);
			if (events.length >= MAX_EVENTS) return "stop";
		});
	} catch (error) {
		// 读盘中途失败但已收到部分事件：返回部分结果；一条都没读到才按失败处理
		// （与旧「整文件读失败」的对外表现一致，由 IPC 层转错误态）。
		if (events.length === 0) throw error;
	}
	return events;
}
