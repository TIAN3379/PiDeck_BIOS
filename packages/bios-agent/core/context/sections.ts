import { Buffer } from "node:buffer";
import { isStorageError } from "../storage/index.ts";
import { invalidArgument, ProjectServiceError } from "../knowledge/contract.ts";
import type { OutboundPolicy } from "./policy.ts";

export type HandoffSourceKind = "project-profile" | "task-record" | "experience-card" | "feature-record";
export type HandoffSource = { readonly recordKind: HandoffSourceKind; readonly recordId: string; readonly revision: number; readonly reason: string };

export type HandoffBudget = { readonly maxChars: number; readonly maxBytes: number };

export type HandoffSection = { readonly title: string; readonly lines: readonly string[]; readonly optional: boolean };

export type HandoffResult = {
	readonly status: "ok" | "incomplete" | "stale" | "not-authorized" | "not-found";
	readonly targetProjectId: string;
	readonly taskId: string | null;
	readonly workspaceId: string | null;
	readonly text: string;
	readonly sections: readonly HandoffSection[];
	/**
	 * **实际保留**（进入正文）的来源（R32-2）：预算删掉章节后，这里同步收缩。
	 * 不要把"检查过"当成"保留了"，也不要把"来源清单"当成"已注入 Pi"。
	 */
	readonly sources: readonly HandoffSource[];
	/** 本次**实际检查过**的来源（含被预算删掉章节的来源）：用于区分 inspected / retained。 */
	readonly inspectedSources: readonly HandoffSource[];
	readonly expiredSources: readonly string[];
	readonly outbound: OutboundPolicy;
	/**
	 * 身份是否可用（R33-2）：工作区属于本项目、会话目录存在且该目录在本次授权范围内。
	 *
	 * 为 false 时正文/路径已按身份闸门撤回，适配层必须把"可发送给模型"标成 false
	 * （但不能把 incomplete 一刀切成不可用：漂移/缺口仍可能是正常可用的参考）。
	 */
	readonly identityUsable: boolean;
	readonly head: { readonly value: string | null; readonly kind: "live" | "stored-snapshot" | "unknown"; readonly capturedAt: number | null };
	readonly budget: { readonly maxChars: number; readonly maxBytes: number; readonly usedChars: number; readonly usedBytes: number; readonly truncated: boolean /** 请求被宿主硬上限夹紧（R33-4）。 */; readonly clamped: boolean };
	readonly generatedAt: number;
	readonly profileRevision: number | null;
	readonly taskRevision: number | null;
	readonly workspaceHead: string | null;
	readonly problems: readonly string[];
};

export const DEFAULT_HANDOFF_BUDGET: HandoffBudget = { maxChars: 12_000, maxBytes: 24 * 1024 };

export function assertRoot(value: unknown): string {
	if (typeof value !== "string" || value.trim() === "") throw invalidArgument("必须显式指定知识根");
	return value;
}

export function mapStorageError(error: unknown, context: string): ProjectServiceError {
	if (isStorageError(error)) {
		const code = error.code === "cancelled" ? "cancelled" : error.code === "not-found" ? "not-found" : error.code === "invalid-record" || error.code === "unsupported-schema-version" ? "inconsistent" : "io-error";
		return new ProjectServiceError(code, `${context}：${error.message}`, { detail: error.code, cause: error });
	}
	return new ProjectServiceError("io-error", `${context}：${error instanceof Error ? error.message : String(error)}`, { cause: error });
}

/** 取消必须结构化穿透：不能变成 `stale`/`unreadable` 之类的业务结论（R30-3）。 */
export function rethrowIfCancelled(error: unknown): void {
	if (isStorageError(error) && error.code === "cancelled") throw new ProjectServiceError("cancelled", "上下文操作已取消", { detail: "cancelled", cause: error });
	if (error instanceof ProjectServiceError && error.code === "cancelled") throw error;
}

export function renderSections(sections: readonly HandoffSection[]): string {
	return sections.map((section) => [`## ${section.title}`, ...section.lines].join("\n")).join("\n\n");
}

export function measure(sections: readonly HandoffSection[]): { readonly usedChars: number; readonly usedBytes: number } {
	const text = renderSections(sections);
	return { usedChars: [...text].length, usedBytes: Buffer.byteLength(text, "utf8") };
}

/** 预算内取尽量完整的章节：先丢可选章节；核心章节放不下时**不返回**任何正文（R30-3）。 */
export function fitSections(sections: readonly HandoffSection[], budget: HandoffBudget): { readonly sections: HandoffSection[]; readonly text: string; readonly truncated: boolean; readonly usedChars: number; readonly usedBytes: number } {
	let kept = [...sections];
	let truncated = false;
	for (;;) {
		const measured = measure(kept);
		if (measured.usedChars <= budget.maxChars && measured.usedBytes <= budget.maxBytes) return { sections: kept, text: renderSections(kept), truncated, ...measured };
		const optionalIndex = kept
			.map((section, index) => ({ section, index }))
			.filter((entry) => entry.section.optional)
			.map((entry) => entry.index)
			.pop();
		if (optionalIndex === undefined) {
			// 核心也放不下：空正文 + 触顶标记，绝不留一份超额文本。
			return { sections: [], text: "", truncated: true, usedChars: 0, usedBytes: 0 };
		}
		kept = kept.filter((_, index) => index !== optionalIndex);
		truncated = true;
	}
}

export function fieldLine(label: string, value: string | null, status: string): string | null {
	if (value === null) return null;
	return `${label}：${value}（${status === "confirmed" ? "人工确认" : status === "candidate" ? "候选，未经确认" : "未知"}）`;
}
