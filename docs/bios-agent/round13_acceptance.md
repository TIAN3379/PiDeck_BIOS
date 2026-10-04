# 第十三轮独立验收：BM-02C2BR

日期：2026-10-02。工作区 `D:\BIOS_Pi_Agent\PiDeck_BIOS`，分支 `BIOS_Agent`。

结论：**整改大部分有效，但整体仍未通过。R1、R3 及恢复二次中断覆盖关闭；R2、R4 各留一处遗漏。** 下一轮仅执行 [C2BR2 两处收尾](bm02c2br2_development_plan.md)，不重做已通过部分，不进入迁移、管理 CLI 或 UI。

## 1. 本次独立执行

| 位置 | 命令 | 实际结果 |
|---|---|---|
| `packages/bios-agent` | `npm test` | 326 项：324 pass、0 fail、2 既有文件 symlink 权限 skip，约 28.4 秒 |
| 同上 | `node --test tests/auditContracts.test.mjs tests/auditAssociation.test.mjs tests/storageJournal.test.mjs tests/storageReviewWriter.test.mjs tests/storageReviewReconcile.test.mjs tests/storageReviewContracts.test.mjs` | 143 项全部通过，0 skip，约 30.5 秒 |
| 同上 | `npm run typecheck`、`npm run selfcheck`、`npm run check:format` | 全部通过；selfcheck 6 项，格式 56 文件，无自动修改 |
| 仓库根 | `npm run typecheck`、`npm run check:format` | 全部通过；格式 2014 文件，无自动修改 |
| 仓库根 | `node --test tests/processGuards.test.mjs` | 2 项通过 |
| 仓库根 | `git diff --check` | 通过；该命令不覆盖未跟踪文件 |

完整回归比上轮增加 31 项，两个既有权限 skip 未增加。本轮六文件合跑确实执行了真实 recovery 在事件已发布、终态未写时被终止的测试：确认退出后只清理合成锁，新恢复者保留第一次 recovery 的事件 hash、时间、来源及业务 revision/hash。杀进程不等于断电测试。

## 2. 已通过部分

- **R1 关闭**：完整 v2 schema 真正执行，诊断脱敏、revision 边界和输入拒绝回归通过。独立直接调用确认非法 eventId、路径 ID、Windows 保留名、before 嵌套额外字段均被拒绝，after 达到 `MAX_SAFE_INTEGER` 可接受；`evidence:[null]` 返回 `StorageError/invalid-record/invalid-evidence-shape`，不再抛裸 TypeError。
- 审核硬限额有效：独立给合法意图前加 17000 字节空白，实际 17609 字节，即使 `maxJournalBytes=65536`，仍返回 `too-large`。永久测试中的 16384/16385 精确边界通过。
- **R2 主路径修复有效**：独立复测 target=after 时分别篡改意图 target/before/after 并更新 journal 为真实新 hash，三项均 `inconsistent/changed=false`，journal 与业务原字节不变；prepared + before + 已有合法事件，第一次即 `inconsistent`，不写 aborted。换锁目标的永久回归通过。
- **R3 关闭**：已有事件优先认领、新发布时拒绝回拨时钟、阶段结果及前后取消回归通过。独立复测已有 writer 事件、终态待补且核对时钟早于决定时间，正常收口并保留原 `publication=writer`、`recordedAt=1700000060000`，事件与业务 hash 不变。真实 recovery 二次中断的覆盖缺口关闭。
- **R4 正常/撞名分支已有改善**：成功发布的 intent/event/journal 清理失败能进入独立 `artifactCleanup`；正常 exists 撞名及提交前已有残留的回归通过。但底层失败转成结果时仍漏诊断，见下文。

以上结论限定本机合成数据与声明范围，不等于整个知识系统生产可用。

## 3. 仍阻塞的两处

### F1 [P2，原 R2 遗留] conflict 提前写终态，跳过完整意图绑定

位置：`packages/bios-agent/core/storage/review/reconcile.ts:281`。`!matchesAfter && !matchesBefore` 直接调用 `finalizeReview(...,"conflict",...)`；完整 `loadBoundIntent` 到 286 行才执行。注释宣称“无论走哪条分支先验证完整三方绑定”，实际 conflict 没有经过它。

复现步骤（均调用生产 TS API，合成知识库）：

1. 初始化、创建 reviewed 经验卡 revision=0；审核时对事件 link 注入 ENOSPC，得到真实 `applied-audit-pending`、业务 revision=1、v2 prepared。
2. 将业务换成完整合法的 revision=2，形成正常的“不再等于 before/after”现场。
3. 分别：删除意图；改 `intentVersion=99`；改意图 target 为 exp-b 并把 journal.intentHash 改为文件真实新 hash。
4. 调用 `reconcileReviewOperation`，比较调用前后真实字节。

三项实际均 **`outcome=conflict、changed=true、journalState=conflict`**，journal hash 改变，业务 hash 不变。不声称这里发布了错误事件或返回 committed；问题是不可解释/错绑定现场被写成可幂等返回的终态，后续 conflict 核对不再检查意图，掩盖了第一层绑定问题。

上轮标准 §3 明确要求“所有收口分支先验证完整绑定”，不是新增功能。预期：意图缺失、未知版本、坏结构或绑定不符时不写任何终态，返回明确 inconsistent/unreadable；**合法意图且目标后续更新**仍可按原协议记 conflict，不能把所有高 revision 都改成 unreadable。

### F2 [P2，原 R4 遗留] 底层失败的清理文案与提取器不一致

位置：`review/artifacts.ts:170` 的 `cleanupFailureFromError` 仅识别 `ARTIFACT_CLEANUP_NOTE`。但 `storage/boundary.ts:453、515` 在发布/替换失败时附加的是普通 `CLEANUP_FAILED_NOTE`（定义于 `commit.ts:233`）。直接从 boundary 抛出的失败不会自动转换成审核专用文案。

独立复现：用真实 pending fixture，然后分别注入如下故障；只阻断审核工件目录的 `unlink-temp`，没有伪造业务 cleanup。

| 场景 | 返回 | 实际磁盘 |
|---|---|---|
| writer 事件 link ENOSPC + 事件 unlink-temp EACCES | `applied-audit-pending`，业务 `cleanup=ok`，`artifactCleanup=[]`；warnings 只说事件待补，无清理诊断 | `audit/exp-a/` 留一个 `.tmp` |
| recovery 事件 link ENOSPC + 事件 unlink-temp EACCES | `pending`，`artifactCleanup=[]、warnings=[]` | 同目录留一个 `.tmp` |
| recovery 终态 rename EIO + journal unlink-temp EIO | `pending`，返回已发布 recovery 的 audit；`artifactCleanup=[]`，warnings 只说终态待补 | `journal/` 留一个 `.tmp` |

阶段语义已正确：未错误否认业务提交，也未丢失第三项的 audit；但“全部工件清理诊断”尚未达成。修复应在审核工件调用的明确上下文里保留底层清理事实与原错误码，不靠改业务 `cleanup`、放宽测试或全面重写 C1。取消/exists 二次读取路径也应确认已取得的 cleanup 不会因提前 throw 丢失。

## 4. 证据与未测范围

独立诊断使用 Node 24 直接导入生产 `.ts`，不改永久测试，额外诊断不计入 326 项；用 `beforeIo`/`link` 注入实际故障，再检查文件与 SHA-256。合成现场保留在：

- `%TEMP%/bios-c2br-independent-gCjtcx`：F1 三项、F2 writer/recovery 事件失败。
- `%TEMP%/bios-c2br-positive-40zu0w`：R1 与 R3 直接复测。
- `%TEMP%/bios-c2br-bindings-qysGHM`：after 错绑定首次拒绝、before+事件首次拒绝、F2 终态失败。

这些都是新建临时测试数据，不是客户知识库。永久回归自带合成现场清理；上述额外诊断现场未自动删除。

未执行根全量测试、生产构建/安装包、干净 clone、远端 CI、Linux/macOS、断电、真实客户 BIOS 试点。selfcheck 中显示默认知识根仅是路径展示，其离线存储测试用临时 fixture，不构成读取客户资料。

本轮只修改验收/下一轮与状态文档；未改生产代码或永久测试，未 add/commit/push，未新增历史删除，未改 PiRuntime。分阶段 MVP 技能把下一轮限定为原 R2/R4 的两处遗漏；文档写作技能用于区分已经通过的整改、实际阻塞与计划。
