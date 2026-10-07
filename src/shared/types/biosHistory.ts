/** 历史项目本地只读提炼；路径/授权/候选身份均由主进程解析。 */
export type BiosHistoryRequest = { desktopProjectId: string; projectId: string; ref: string; limit: number; keyword: string };
export type BiosHistoryCommit = { sha: string; parents: string[]; date: string; subject: string; message: string };
export type BiosHistoryPreview = { token: string; projectId: string; desktopProjectId: string; workspacePath: string; ref: string; head: string; commits: BiosHistoryCommit[]; scanned: number; hasMore: boolean; expiresAt: number };
export type BiosHistoryEvidence = { token: string; projectId: string; desktopProjectId: string; commit: BiosHistoryCommit; diff: string; maySendToModel: boolean };
/** AI 提案不是事实；只允许人工编辑的正文，托管状态/权限/验证全部排除。 */
export type BiosHistoryProposal = { token: string; commit: string; problem: string; rootCause: string; solution: string; appliesWhen: string[]; doesNotApplyWhen: string[] };
