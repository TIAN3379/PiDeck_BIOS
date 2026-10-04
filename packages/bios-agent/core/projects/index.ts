/**
 * BM-03 项目事实服务出口。
 *
 * 分层：
 * - `contract.ts` / `fields.ts`：受控错误码、资源预算、字段命名（无 IO）；
 * - `binding.ts`：显式绑定与只读打开（registry ↔ profile ↔ 目录一致性）；
 * - `detection.ts`：有限检测候选与资料缺口（只读，绝不写档案）；
 * - `confirm.ts`：人工确认 + CAS（独立写动作，只改被点名的字段）；
 * - `workspace.ts`：每工作区快照（Git）与证据复验（实际字节有界、按事实键归属）；
 * - `view.ts`：把档案/检测/证据喂进 M1 决策，输出受预算限制的读取视图；
 * - `writeNotes.ts`：把存储层"提交成功但有遗留"的事实搬进服务结果（不另建事务框架）。
 *
 * **信任边界**（R28-4）：`openProjectProfile` / `detectProjectCandidates` /
 * `verifyEvidenceRefs` / `refreshWorkspaceSnapshot` / `captureWorkspaceSnapshot` 都要求
 * 调用方给出本次会话的 `cwd`（+ 可选授权根），并在**每次访问工作区之前**重新判定授权——
 * 档案里保存的路径是过去的授权结果，不能当成长期通行证。
 * `readFileBounded` / `probeGitSnapshot` 这类不接收 cwd 的函数是**可信内部原语**，
 * 不能直接暴露给模型或外部输入；外部入口必须先过上面的授权判定。
 *
 * 仍然**不提供**：跨文件事务、自动回滚、通用项目合并、UI。
 */
export * from "./contract.ts";
export * from "./fields.ts";
export * from "./binding.ts";
export * from "./detection.ts";
export * from "./confirm.ts";
export * from "./workspace.ts";
export * from "./view.ts";
export * from "./writeNotes.ts";
export { authorizeWorkspacePath, resolveAuthorizedTargetDir, isWithinAuthorizedRoot, readAuthorizedRootsFromEnv, AuthorizedTargetError, BIOS_AUTHORIZED_ROOTS_ENV, type AuthorizedTarget, type BoundWorkspaceAuthorization, type ResolveAuthorizedTargetOptions } from "./authorization.ts";
export { probeProjectDirectory, totalHintCount, DEFAULT_SCAN_LIMITS, BIOS_HINT_EXTENSIONS, type ProjectProbeResult, type ScanLimits } from "./probe.ts";
