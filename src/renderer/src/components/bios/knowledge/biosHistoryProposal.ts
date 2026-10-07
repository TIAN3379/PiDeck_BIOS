import type { BiosHistoryProposal } from "../../../../../shared/types/biosHistory";

/** JSON 转义聊天的文件/会话/命令触发字符，防止 diff 的 @@ 被编辑器解析成引用。 */
export function encodeBiosHistoryEvidence(value: unknown): string {
	return JSON.stringify(value).replace(/[@&/]/g, (character) => (character === "@" ? "\\u0040" : character === "&" ? "\\u0026" : "\\u002f"));
}

/** 模型只能建议事实字段，不能指定授权、验证状态、来源项目或写操作。 */
export function parseBiosHistoryProposal(text: string, expected: { token: string; commit: string }): BiosHistoryProposal {
	if (text.length > 40_000) throw new Error("Candidate response exceeds budget");
	const raw = text.trim().replace(/^```(?:json)?\s*\n([\s\S]*)\n```$/, "$1");
	const value: unknown = JSON.parse(raw);
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected one JSON object");
	const fields = Object.fromEntries(Object.entries(value));
	const allowed = ["token", "commit", "problem", "rootCause", "solution", "appliesWhen", "doesNotApplyWhen"];
	if (Object.keys(fields).some((key) => !allowed.includes(key))) throw new Error("Unexpected managed fields");
	if (fields.token !== expected.token || fields.commit !== expected.commit) throw new Error("Candidate belongs to a different analysis/commit");
	function string(key: string): string {
		const result = fields[key];
		if (typeof result !== "string" || result.length > 8_000) throw new Error(`Invalid ${key}`);
		return result.trim();
	}
	function list(key: string): string[] {
		const result = fields[key];
		if (!Array.isArray(result) || result.length > 20) throw new Error(`Invalid ${key}`);
		return result.map((item: unknown) => {
			if (typeof item !== "string" || item.length > 512) throw new Error(`Invalid ${key} entry`);
			return item.trim();
		});
	}
	return { token: expected.token, commit: expected.commit, problem: string("problem"), rootCause: string("rootCause"), solution: string("solution"), appliesWhen: list("appliesWhen"), doesNotApplyWhen: list("doesNotApplyWhen") };
}
