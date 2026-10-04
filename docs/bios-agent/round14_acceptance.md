# 第十四轮独立验收：BM-02C2BR2

日期：2026-10-02。工作区 `D:\BIOS_Pi_Agent\PiDeck_BIOS`，分支 `BIOS_Agent`。

结论：**F1 关闭，F2 的三项主要失败路径通过；意图 exists 后复读被取消的清理诊断仍遗漏，尚未完全满足本轮完成标准。** 只剩下面的 I1，不重开 R1/R3、conflict 绑定或已通过的事件/终态传播。

下一轮不另开重复整改方案：继续 [C2BR2 文档 §6](bm02c2br2_development_plan.md#6-当前唯一接续任务i1)，只修这一条提前退出分支。修复并复验后，再排迁移/备份与管理 CLI；本轮不启动这些功能或 UI。

## 1. 独立执行结果

| 位置 | 命令 | 实际结果 |
|---|---|---|
| `packages/bios-agent` | `npm test` | 343 项：341 pass、0 fail、2 既有文件 symlink 权限 skip，约 26.1 秒 |
| 同上 | `node --test tests/auditContracts.test.mjs tests/auditAssociation.test.mjs tests/storageJournal.test.mjs tests/storageReviewWriter.test.mjs tests/storageReviewReconcile.test.mjs tests/storageReviewContracts.test.mjs` | 160 项全部通过，0 skip，约 24.8 秒 |
| 同上 | `npm run typecheck`、`npm run selfcheck`、`npm run check:format` | 全部通过；selfcheck 6 项，格式 56 文件，无自动修改 |
| 仓库根 | `npm run typecheck`、`npm run check:format` | 全部通过；格式 2014 文件，无自动修改 |
| 仓库根 | `node --test tests/processGuards.test.mjs` | 2 项通过 |
| 仓库根 | `git diff --check` | 通过；不覆盖未跟踪文件 |

343 = 上轮 326 + 本轮 17，原回归与两项权限 skip 保留。按 Node 含父测试/子测试的口径，新增 F1 为 10 项（负例父测试 + 8 子例 + 1 正例），F2 为 7 项（writer 3 + recovery 父测试/3 子例）；不是实施记录中的 9/8 分配，合计 17 不变。

## 2. 本次确认关闭的内容

- **F1 关闭**：源码已把完整意图绑定移至所有 prepared 收口之前。独立生产 API 合成诊断复测目标 revision=2 时的意图缺失、未来版本、坏 JSON、未同步 hash、target/before/after 错绑定，七项均 `inconsistent/changed=false`，journal 与业务字节不变。合法绑定正例仍 `conflict/changed=true`，业务不变；永久测试还覆盖 eventId 错绑定与二次核对幂等。
- **F2 原三项主复现通过**：writer 事件发布失败 + event unlink-temp 失败，返回 `applied-audit-pending`，业务 `cleanup=ok`，但工件单独报 event、warnings 含清理诊断且实际新增 `.tmp`；recovery 相同故障返回正确 pending 与 event 诊断；recovery 终态 rename + journal unlink-temp 失败，返回 pending、保留 recovery audit、正确报告 review-journal 残留。
- 本轮通过的永久回归覆盖意图发布失败时的首错保留、无清理失败对照、事件 exists 后复读取消的诊断。WeakSet 标记接通了 boundary 与审核工件的失败传播，没有为清理问题否认业务提交。
- 既有正常审核、只读巡检、时钟回拨认领、真实 recovery 二次中断、writer 崩溃检查点与双进程竞争在本轮完整/针对性复跑中保留。R1/R3 与之前局部通过结论不重开。

## 3. I1 [P2] 意图 exists 后取消仍直接抛出，丢失已取得的 cleanup

位置：`packages/bios-agent/core/storage/review/artifacts.ts:243`，`publishReviewIntentArtifact` 的撞名复读 catch：

```ts
if (isCancelledError(error)) throw error;
```

这里已经取得 `published.cleanup`，但取消分支没有像事件 writer/recovery 分支一样附加工件清理诊断。它不是新的功能要求：C2BR2 原标准 §3 已要求 exists 后读取/认领失败或取消时保留已发生的清理事实。

独立复现（直接调用低层生产工件 API）：

1. 用真实审核创建合法意图文件，读取这份意图，再用同 operationId、同字节调用 `publishReviewIntentArtifact`，走现有幂等撞名路径。
2. 仅在 `audit/intents/` 的 `beforeIo("unlink-temp", path)` 注入 EACCES，使新临时文件实际清理失败；此前的既有意图不改。
3. 清理尝试之后，在这份已有意图的 `beforeIo("read", path)` 调用正常 `AbortController.abort()`，取消复读。
4. 检查结构化错误、该调用新增 `.tmp` 数量和前后文件 hash。

| 对照 | 实际结果 |
|---|---|
| 清理成功 + 复读取消 | `StorageError/code=cancelled`，无清理诊断，新增 `.tmp`=0，正确 |
| 清理失败 + 不取消 | `exists-identical/cleanup=failed`，新增 `.tmp`=1，正确 |
| **清理失败 + 复读取消** | **`StorageError/code=cancelled/message="存储操作已取消"`，无清理诊断，新增 `.tmp`=1，不符合标准** |

三个对照的原意图、journal、业务 hash 均不变。这里只丢诊断，没有覆写记录/工件，也没有错误发布事件；不声称发生客户数据损坏。低层工件导出用于测试恢复窗口，并非鼓励产品调用方绕过领域审核入口。

本例的取消是正式 AbortSignal 路径产生的 `StorageError`，不是注入裸 Error 造成的假失败；实施记录 §11.4 的“原始 hook 错误不携带标记”限制不能解释它。当前事件路径的取消回归通过，不代表意图路径也已覆盖。

## 4. 下一轮与验证边界

只补 `publishReviewIntentArtifact` 此处：cleanup 已失败时，取消错误仍保留 `cancelled` 及原元数据，并附加有界、受控路径的 intent 清理诊断；cleanup 成功时不误报。加永久失败回归与上表对照，然后复跑 C2BR2 原指定门禁。具体步骤与简短提示词统一在 [C2BR2 §6](bm02c2br2_development_plan.md#6-当前唯一接续任务i1)。

额外 Node 诊断直接导入生产 `.ts`，不改永久测试，不计入 343 项；只用新建合成知识库，现场保留在：

- `%TEMP%/bios-c2br2-independent-f9lsgp`：F1 七个负例/正例、F2 recovery 两个主复现与 I1。
- `%TEMP%/bios-c2br2-intent-controls-v3yt0S`：F2 writer 主复现与 I1 三个对照、文件 hash 证据。

未执行根全量测试、生产构建/安装包、干净 clone、远端 CI、Linux/macOS、断电、真实客户 BIOS 试点。杀进程不等于断电；operatorLabel 不等于身份认证；不宣称所有异常组合都已通过。

本轮仅写验收/接续与状态文档，未改生产代码或永久测试，未 add/commit/push，未新增删除历史，未改 PiRuntime、未读客户资料。分阶段 MVP 技能把接续限定为这一处原标准遗漏；文档写作技能用于区分已经独立通过的改动、剩余分支和未测范围。
