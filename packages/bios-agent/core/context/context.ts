/**
 * BM-05 C1/C2 + R30-1/R30-2/R30-3/R30-4 + R32-3：**有界人工交接包**与 `ContextManifest` 创建/替换/重验。
 *
 * 这是"把当前有限观察交给新对话"的组装层，不是跨记录/Git 的原子快照：
 * - 输入必须明确 targetProjectId / taskId / workspaceId 与显式授权；不扫描聊天日志或未配置知识根；
 * - **task 与 workspace 必须严格一致**：显式选定的 workspace 必须等于任务入档的工作区，
 *   否则报 `task-workspace-mismatch` 且不输出该工作区事实；未选任务/工作区时明确缺口，不自动取第一个；
 * - **外发策略统一**（R30-1）：端点 deny 或未知时不输出任何商业正文（需求/待办/经验正文等），
 *   只给 ID、粗粒度状态与缺口；经验复用还须经 M1（internal-general/customer 未放行即不出正文）；
 * - chars 与 UTF-8 bytes **双预算**；核心章节都放不下时返回**空正文 + 有限诊断**，不留超额文本；
 * - 当前 HEAD 用**授权后实时快照**读取，读不到时明确标"已存快照 / 未知"，不把旧 profile.vcs.head 当当前；
 * - 完成前**重读所有实际来源**（档案、任务、每条经验、每个需求），任一处变化即 `stale` 且不输出旧正文；
 * - `ContextManifest` 是**来源清单**，不是"已注入 Pi"的证明；v1 没有耐久来源字节/HEAD 指纹，
 *   同 revision 的合法外改只能标 `unproven`。
 *
 * R32-3 结构拆分（**入口与行为不变**）：本文件从 829 行的单文件改为兼容入口，按内聚职责分到
 * - `policy.ts`：外发策略（端点 → 是否允许商业正文）；
 * - `sections.ts`：交接包的章节/预算/渲染与共享 IO 辅助；
 * - `handoff.ts`：交接包组装（`buildHandoff`）；
 * - `manifest.ts`：来源身份守卫与 `ContextManifest` 保存/重验。
 */
export * from "./policy.ts";
export * from "./serviceIdentity.ts";
export * from "./sections.ts";
export * from "./handoff.ts";
export * from "./manifest.ts";
