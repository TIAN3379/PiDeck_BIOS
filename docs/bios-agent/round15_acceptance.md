# 第十五轮验收：I1 关闭，审核持久化整改收口

日期：2026-10-02。范围：`BIOS_Agent` 分支的本机工作树，独立复验 [C2BR2 §6](bm02c2br2_development_plan.md#6-当前唯一接续任务i1)。

## 1. 结论

本轮通过声明范围的独立验收，I1 关闭。C2B 经 C2BR/C2BR2 的审核持久化完成标准已收口；R1～R4、F1/F2 不再是当前整改任务。没有发现本轮范围内需要继续阻断的实现问题。

这不是整个 BM-02 或生产知识系统验收通过。版本迁移、备份恢复、管理 CLI、项目记忆/检索/交接和 BIOS 专业 UI 尚未实现；`operatorLabel` 不代表身份认证。下一轮仅执行 [BM-02C3：知识库版本盘点与迁移预检](bm02c3_development_plan.md)。

## 2. 独立复跑

以下为验收方本轮实际执行，不是复制实施方自测。环境：Windows、Node 24.14.1、本机 Pi 0.87.1；测试使用合成数据。

| 门禁 | 结果 |
|---|---|
| Package `npm test` | 348 用例：346 通过、0 失败、2 个既有文件符号链接权限 skip；约 33.2 秒 |
| 审核/journal 六文件针对性测试 | 165 通过、0 失败、0 skip；约 31.5 秒 |
| Package `npm run typecheck` | 通过 |
| Package `npm run selfcheck` | 6 项通过 |
| Package `npm run check:format` | 56 文件通过，无改写 |
| 根 `npm run typecheck` | 通过 |
| 根 `npm run check:format` | 2014 文件通过，无改写 |
| 根 `node --test tests/processGuards.test.mjs` | 2 项通过 |
| `git diff --check` | 通过 |

针对性六文件：`auditContracts`、`auditAssociation`、`storageJournal`、`storageReviewWriter`、`storageReviewReconcile`、`storageReviewContracts`，均为 `tests/*.test.mjs`。

相比第十四轮增加 5 项（I1 父测试 + 4 个子用例），审核持久化总数 90 → 95；既有 343 项基线与两个权限 skip 保持。红绿过程由实施方记录在 [实施记录 §12](bm02c2b_implementation.md)，验收方没有回退源码重跑旧红阶段。

## 3. I1 的独立诊断

除永久测试外，验收方直接加载生产 TS API，创建新临时知识库；先通过领域入口得到真实 `applied-audit-pending` 现场（有业务记录、意图和 prepared journal），再重发同 operationId、同字节意图。仅注入 intent unlink-temp 失败，并在撞名后的复读等待点触发正式 AbortSignal。

| 现场 | 实测结果 | 本次新增 `.tmp` |
|---|---|---|
| 清理成功 + 复读取消 | `StorageError/code=cancelled`，无清理警告 | 0 |
| 清理失败 + 不取消 | `exists-identical`、`cleanup=failed` | 1 |
| 清理失败 + 复读取消 | `StorageError/code=cancelled`，含 intent/受控相对路径的清理说明 | 1 |

三个对照均断言原意图、journal、业务记录 SHA-256 不变，事件目录内容不变。对已有历史残留采用调用前后增量，未把历史文件计作本次失败，也未删除未知残留。

另用独立工件现场检查两项：

- 注入结构化 cancelled 首错，重抛后 `code/path/detail/conflicts/expected/actual/cause` 保持，消息追加清理说明，原意图 hash 不变。此项验证元数据传播，不替代上面的正式 AbortSignal 取消实验。
- 同 operationId、合法但不同决定字节仍为 `audit-conflict`，不覆盖原意图。坏文件对照由永久回归覆盖。

修复只在本次 `published.cleanup=failed` 时调用既有 `attachArtifactCleanupNote`，没有引入第二套异常体系，没有将取消改写为冲突或未提交。

本机诊断证据目录：`%TEMP%/bios-i1-independent-ePIxsp`、`%TEMP%/bios-i1-extra-2sJ0G1`。它们仅含合成数据，不是交付依赖；额外诊断不计入 348 项永久测试数。诊断脚本初次把结果字段误写为 `status`，断言阶段退出；改为实际契约字段 `kind` 后完成上述检查，不属于产品缺陷。

## 4. 未测与边界

- 未执行根工程全量测试、生产构建/安装包、干净 clone、远端 CI、Linux/macOS 或断电实验。
- 真实子进程崩溃与竞争的既有永久回归已随 Package 测试复跑；不能由此宣称断电一致性、所有时序或网络盘安全。
- 仍不自动重放/回滚、不自动回收遗留锁，不按 PID、年龄或 `force` 抢锁；不开放模型写知识工具。
- 本次验收只编辑文档；未改生产源码/永久测试/PiRuntime，未接触客户资料，未新增历史删除，未 add/commit/push。工作树原有变更保留。

## 5. 下一步

先做 BM-02C3 的只读版本盘点与迁移预检，复用现有路径、限额和契约校验；当前只有业务 schema v1，不编造旧格式迁移或主动升版。该模块通过后再排备份快照与最小管理 CLI，恢复演练另设完成标准；UI 仍按 MVP 路线留在 BM-07。

交接提示词见 [下一轮方案 §7](bm02c3_development_plan.md#7-简短交接提示词)。
