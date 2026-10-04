# 第十二轮独立验收：BM-02C2B

日期：2026-10-02。工作区 `D:\BIOS_Pi_Agent\PiDeck_BIOS`，分支 `BIOS_Agent`。

结论：**主体已落地，但本轮整体不通过。先关闭 R1～R4，不进入迁移、管理 CLI 或 UI。** C2A/C2AR 的协议与纯校验通过结论保持；这次的问题是新 IO 路径未完整执行该协议，不重开旧 A1～A3 任务。下一轮唯一执行文档为 [C2BR 有限整改](bm02c2b_remediation_plan.md)。

## 1. 独立执行结果

| 目录 | 命令 | 结果 |
|---|---|---|
| `packages/bios-agent` | `npm test -- --test-reporter=dot` | 295 项：293 pass、0 fail、2 既有文件 symlink 权限 skip，约 45.3 秒；本机该参数位置仍输出默认 reporter，不影响结果 |
| 同上 | `node --test --test-reporter=dot tests/auditContracts.test.mjs tests/auditAssociation.test.mjs tests/storageJournal.test.mjs tests/storageReviewWriter.test.mjs tests/storageReviewReconcile.test.mjs` | 五个文件合跑通过（原审核/journal 70 项 + 新审核 IO 42 项），退出码 0 |
| 同上 | `npm run typecheck` / `npm run check:format` / `npm run selfcheck` | 通过；格式 55 文件未修改，selfcheck 6 项 |
| 仓库根 | `npm run typecheck` / `npm run check:format` | 通过；格式 2014 文件未修改 |
| 仓库根 | `node --test tests/processGuards.test.mjs` | 2 项通过 |
| 仓库根 | `git diff --check` | 通过（不覆盖未跟踪文件） |

现有 42 项新测试确实包含正常三方工件、审核状态/reviewer 策略、提交前拒绝、writer pending、两个 writer 崩溃检查点、两组真实进程竞争，不能说“只有契约没有 IO”。但测试没有覆盖下列拒绝与诊断分支，全绿不等于完成标准全部达成。

## 2. 阻塞项及实际复现

以下为独立 Node 内联诊断，直接调用生产 TS API；只用 `%TEMP%` 下新建合成知识库，不改生产源码/永久测试，不计入 295 项。手工构造损坏工件用于测试“不可信磁盘输入”的拒绝行为，不代表产品可认证人工身份或抵御任意本机写者。

### R1 [P1] 完整 v2 校验与真实工件边界没有落实

`core/storage/review/contract.ts:133` 定义了 `ReviewJournalRecordSchema`，但 `validateReviewJournalRecord` 没有执行它，只手工检查部分字段，并在 243 行强转为完整类型。实测：

- `eventId="not-a-uuid"`、`target.id="../other"`、`target.id="con"`、`before.unexpected="secret"` **均返回 ok=true**；`target.extra` 被拒，说明问题是检查不完整，不是所有未知字段都放行。
- `before.revision=MAX_SAFE_INTEGER-1` / `after.revision=MAX_SAFE_INTEGER` 是合法的一次递增，但 257 行把 after 也当作还需递增而拒绝。审核该记录一次可以到达上限，再次更新才该拒绝。
- 意图读者复用可扩大的 `maxJournalBytes`。配置 65536，给合法意图前加 17000 字节空白，**实际读取 17612 字节仍返回 ok=true**，违反审核工件 16 KiB 硬上限/配置只能收紧的要求。
- 审核输入 `evidence:[null]` 先被 `normalizeEvidence` 强转，再由策略解引用，实际抛 **TypeError，无 StorageError code**，而非结构化拒绝。

没有据此宣称已经发生根外读写：既有路径边界仍有另一道防线。阻塞的是“完整已校验”的类型/元数据承诺和可复核输入边界。

### R2 [P1] 恢复发布之前只核对部分绑定，矛盾现场还会被收口

`reconcile.ts:321` 的 `loadBoundIntent` 只验证实际 intentHash、路径 operationId 和 eventId；`reconcile.ts:261` 创建新事件的分支没有调用 `compareAuditAssociation`。该比较只在已有事件或完成终态核对时执行。

复现：先用 writer 事件 link 故障生成真实 `applied-audit-pending`。修改意图的 target/before/after 之一，同时把 journal.intentHash 更新为修改后文件的真实 hash；其余元数据仍合法，目标保持原 after。三种场景均 **返回 committed、写入 committed journal**：

| 不一致字段 | 实际副作用 |
|---|---|
| 意图 target 改为 exp-b，journal/业务仍 exp-a | 生成 `audit/exp-b/<eventId>.json`，报告 exp-a 的恢复完成 |
| 意图 before.hash 改为另一合法 hash | 发布与 journal 决定不一致的事件并完成 |
| 意图 after.hash 改为另一合法 hash | 发布与实际 after 不一致的事件并完成 |

业务原 hash 均未改动，但这是错误审计和错误终态，不是可接受的恢复。

另用合法低层工件 API 构造 prepared + 目标=before + 已有合法事件：**第一次核对返回 aborted、changed=true，第二次才返回 inconsistent**。现有测试在 `storageReviewReconcile.test.mjs:518` 正好要求第一次 aborted，把错误行为写成预期。事件路径由 recordId/eventId 精确派生，首次检查不需要扫描整个目录；实施记录 §8 的“需额外扫描，所以不做”理由不成立。

持锁复读还在检查目标是否改变之前处理终态（`reconcile.ts:212`）；整改时统一先检查锁定身份/绑定，再判状态，避免绕过既有 J1 约束。

### R3 [P2] 认领依赖新候选事件，恢复结果与失败阶段表达不完整

`reconcile.ts:261` 总是先构造/校验/尝试发布新的 recovery 事件，撞名后才核对旧事件。复现：writer 已发布合法事件但终态 rename 失败，返回 `applied-journal-pending`；核对时注入一个仍合法但早于 decidedAt 的时钟，实际抛 **invalid-record**，不能认领已有 writer 事实。旧事件不需要新 publication/recordedAt，不应受新候选的时间或大小约束。

另在 recovery 新事件 link 注入 ENOSPC，API 抛底层映射后的 `permission-denied`，不提供结构化的“业务 after 已观察、审计待补”结果。该分支尚未发布事件，不认定它伪造了已发布事实；但与实施记录宣称的恢复失败/待收口表不匹配，需要按阶段明确契约与永久回归，不能让调用方仅凭异常推断业务未提交。

### R4 [P2] 审核工件清理失败被吞掉

在 `beforeIo("unlink-temp", path)` 分别注入意图、事件目录的 EACCES：两种情况下都完成审核并留下一个 `.tmp`，结果 **kind=applied、cleanup=ok、warnings=[]**。业务 cleanup=ok 可保留，但工件残留必须通过有界警告/单独字段可见。

`writer.ts:247` 只取意图 hash，未传播意图/prepared cleanup；`commitSteps.ts` 未传播事件发布 cleanup；`artifacts.ts:180` 的 exists 分支直接丢失底层 cleanup。journal 清理失败的正常终态分支有警告，这不覆盖其它工件/撞名/提交前失败/pending 分支。

## 3. 覆盖缺口与文档

- 原任务明确要求 **recovery 发布事件后、写终态前再次终止**，当前两个真实崩溃检查点均是 writer。不能用“纯函数二次认领”或普通两个恢复进程竞争代替这一项。
- 错绑定时缺失事件、新 v2 非法字段、审核硬限额、首次 before 与事件矛盾、工件清理失败、恢复时钟回拨/阶段失败尚未形成正确永久回归。
- Package README 同时保留“已实现审核 IO”和“无写入口/审计文件/恢复器”等旧句子；实施记录 §8 的矛盾处理理由和“完成终态”等描述也需按修复结果更正。状态不能只写“待复验”，应明确本轮未通过及当前整改任务。

## 4. 保留的成果与未测范围

保留本轮独立审核模块、普通 v1/C1 共存、非覆盖工件发布、真实 target hash、状态/reviewer 策略、已有测试和进程证据。不要重写整套存储或重新执行旧阶段。A1～A3 在旧声明范围的结论保持，新路径问题按 R1～R4 处理。

未执行根全量测试、生产构建/安装包、远端 CI、干净 clone、Linux/macOS、断电或客户 BIOS 项目。杀进程不是断电；人工标签不是身份认证；上板 verified 的真实性不在本轮。

本次只写验收/整改及状态文档，未修改生产代码或永久测试，未 add/commit/push，未新增历史删除，未改 PiRuntime，未读取客户资料。分阶段 MVP 技能将下一步限定为这四组有限收尾；文档写作技能用于区分既有实测、缺口和计划。
