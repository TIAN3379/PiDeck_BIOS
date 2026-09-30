import { Fragment, memo, useLayoutEffect, useRef, useState } from "react";
import { t } from "../../i18n";
import type { AgentRuntimeState } from "../../../../shared/types";
import { formatDuration } from "./TimelineFormat";
import { formatTokens } from "./SessionContextMeter";

/**
 * 输入卡正下方的会话指标条。
 *
 * 轮次由 SessionView 用 countUserTurns 传入（发言权周期，与内部分页/缓存协议同口径），
 * 性能用「上次回复」组（TTFT / 总耗时 / tps）+ 累计 token。
 * 无任何可展示数字时整条卸载（含底距），有数字才占 12px 行高 + pt/pb。
 */
export function buildComposerStatsGroups(state: Pick<AgentRuntimeState, "inputTokens" | "outputTokens" | "cacheHitPercent" | "ttftMs" | "totalMs" | "tps"> | undefined, turnCount = 0): string[] {
	if (!state) return [];
	const groups: string[] = [];
	if (turnCount > 0) groups.push(t("composerStats.turns", { turns: turnCount }));
	// pi 无整段 sessionStats：用最近一条回复的性能组填同一条带，语义在文案里标清。
	const lastReply: string[] = [];
	if (state.ttftMs != null) {
		lastReply.push(t("composerStats.ttft", { duration: formatDuration(state.ttftMs) }));
	}
	if (state.totalMs != null) {
		lastReply.push(t("composerStats.reply", { duration: formatDuration(state.totalMs) }));
	}
	if (state.tps != null) {
		lastReply.push(t("composerStats.tps", { throughput: String(Math.round(state.tps)) }));
	}
	if (lastReply.length > 0) groups.push(lastReply.join(" · "));
	const input = state.inputTokens ?? 0;
	const output = state.outputTokens ?? 0;
	if (input > 0 || output > 0) {
		if (state.cacheHitPercent != null) {
			groups.push(t("composerStats.cacheHit", { percent: Math.round(state.cacheHitPercent) }));
		}
		groups.push(
			t("composerStats.tokens", {
				input: formatTokens(input),
				output: formatTokens(output),
			}),
		);
	}
	return groups;
}

export const ComposerStatsLine = memo(function ComposerStatsLine(props: { state?: AgentRuntimeState; turnCount?: number }) {
	const groups = buildComposerStatsGroups(props.state, props.turnCount);
	const rootRef = useRef<HTMLDivElement | null>(null);
	const [truncated, setTruncated] = useState(false);
	const line = groups.join(" | ");

	useLayoutEffect(() => {
		const el = rootRef.current;
		if (!el) return;
		const measure = () => {
			setTruncated(el.scrollWidth > el.clientWidth);
		};
		measure();
		if (typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(measure);
		observer.observe(el);
		return () => observer.disconnect();
	}, [line]);

	if (groups.length === 0) return null;
	return (
		<div ref={rootRef} className="w-full min-w-0 truncate px-1 pb-0 pt-1 text-center text-[12px] leading-5 text-text-tertiary" title={truncated ? line : undefined} data-testid="composer-stats-line">
			{groups.map((group, i) => (
				<Fragment key={group}>
					{i > 0 && (
						<>
							<span className="mx-2.5 text-border-strong" aria-hidden>
								|
							</span>{" "}
						</>
					)}
					<span>{group}</span>
				</Fragment>
			))}
		</div>
	);
});
