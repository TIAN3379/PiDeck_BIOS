/**
 * BM-07B B-05：M1 决策分类的**可视区分**（current / reference / needs-review / conflict / history / excluded）。
 *
 * 为什么单独一个组件：这六类的**可行动作完全不同**（可直接依据 / 仅供参考 / 需人工复核 /
 * 冲突待判 / 显式历史 / 已排除）。用同一套样式会把它们糊成"一条经验"，这正是计划要禁止的。
 * 只用语义 token，不写内联颜色，主题切换自然跟随。
 */
import { memo } from "react";
import { t, type TranslationKey } from "../../../i18n";
import type { MemoryDecisionClass } from "../../../../../shared/types/biosBusiness";

const TONE: Record<MemoryDecisionClass | "unknown", string> = {
	current: "border-border bg-surface-muted text-foreground",
	reference: "border-border text-text-muted",
	"needs-review": "border-destructive/60 text-destructive",
	conflict: "border-destructive/60 text-destructive",
	history: "border-border text-text-muted",
	excluded: "border-border text-text-muted line-through",
	unknown: "border-border text-text-muted",
};

/** 静态映射（而不是拼字符串）：拼错的 key 由类型检查挡住，而不是留到运行期显示原文）。 */
const LABEL_KEY: Record<MemoryDecisionClass | "unknown", TranslationKey> = {
	current: "bios.workbench.knowledge.class.current",
	reference: "bios.workbench.knowledge.class.reference",
	"needs-review": "bios.workbench.knowledge.class.needsReview",
	conflict: "bios.workbench.knowledge.class.conflict",
	history: "bios.workbench.knowledge.class.history",
	excluded: "bios.workbench.knowledge.class.excluded",
	unknown: "bios.workbench.knowledge.class.unknown",
};

export const BiosClassBadge = memo(function BiosClassBadge(props: { value: MemoryDecisionClass | "unknown"; reasons?: readonly string[] }) {
	const label = t(LABEL_KEY[props.value]);
	if (props.value === "unknown") return <span className="rounded border border-border px-1 text-[10px] text-text-muted">{label}</span>;
	return (
		<span className={`rounded border px-1 text-[10px] ${TONE[props.value]}`} title={props.reasons?.join("；") ?? undefined}>
			{label}
		</span>
	);
});
