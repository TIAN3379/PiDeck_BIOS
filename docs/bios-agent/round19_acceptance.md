# 第十九轮独立验收：BM-02C3R-S2

日期：2026-10-04。仓库 `D:\BIOS_Pi_Agent\PiDeck_BIOS`，分支 `BIOS_Agent`。

结论：**S2 的中途迭代失败成本保留通过，原 20/16 复现关闭；截断后的迭代器关闭错误仍能放行下一目录，PF-4/C3 整体暂未收口。** 下一轮只做 [C3R §8 的 S3](bm02c3_remediation_plan.md#8-第十九轮后的唯一接续任务s3)。PF-1～PF-3、S1 和 S2 已通过行为不重做。

## 1. 独立复跑

| 门禁 | 实际结果 |
|---|---|
| Package `npm test` | 414 项：411 通过、0 失败、3 显式 skip |
| 预检 + 审核/journal 七文件 | 231 项：230 通过、0 失败、1 显式 skip |
| records/registry/remediation/write + preflight 五文件 | 185 项：182 通过、0 失败、3 显式 skip |
| Package 类型 / selfcheck / 格式 | 通过；selfcheck 6 项；格式 67 文件 |
| 根类型 / 格式 | 通过；格式 2014 文件 |
| 根 `tests/processGuards.test.mjs` | 2 项全部通过 |
| `git diff --check` | 通过 |

三个 skip 是本机文件型 symlink 权限限制，不计为行为通过；junction 正常路径实际执行。额外诊断不计入上述永久测试数量。

本轮只改验收与交接文档，没有修改运行代码或永久测试，没有 add/commit/push。合成诊断仅使用新建临时库，目录已清理；未读取真实知识库或客户源码。原有修改、未跟踪文件及六项历史文档删除均保留。

## 2. S2 通过范围

`Boundary.listEntries` 每实际交出一个条目就调用 `observe`，预检以该累计数为唯一计费来源；成功后不再叠加 `listing.scanned`。成功、截断及 `next()` 中途失败的观察成本不丢失，成功路径不双计。

独立进程包装真实 `opendir`：experiences/features 各二十个 `{}` JSON，experiences 正常交出四条后下一次 `next()` 抛受控 `EIO`，额度 15。实跑 **observed=16 / scannedEntries=16**；错误仍作为受控 `unreadable` 问题可见，结果 `incomplete`，含 `scan-entries`，没有回显注入正文。第十八轮的 20/16 复现关闭。

永久回归中的零观察失败、宽预算 31/31、嵌套失败 16/16、读取预算组合 24/24 与取消对照均通过。既有 S1、PF-1～PF-3、审核/journal 及列举调用者回归保持。通过这些场景不能推导所有异常出口都满足全局停止条件。

## 3. S3 · P2：截断后关闭错误绕过全局停止

位置：`core/storage/preflight/scan.ts`，`listEntriesBounded` 的观察回调（359 行起）、成功后的截断判断（363 行起）及 catch（371 行起）；相关 Boundary 列举见 `core/storage/boundary.ts`，524 行起。

### 3.1 独立复现

1. 在合成初始化库的 experiences/features 各放二十个 `{}` JSON。所有候选形状相同，不依赖文件名排序。
2. 独立 Node 进程中包装真实 `fs.promises.opendir` 的迭代器，只计数真实交出的非 done 条目，并**转发 `return()`**，保留原迭代器的关闭路径。
3. 在创建 `Dir` 之前包装 `fs.Dir.prototype.close(callback)`。仅 experiences 首次关闭：先调用原方法完成真实关闭，再把回调结果改为受控 `EIO`；不改变条目、读取次序或上限。最后恢复原方法；已加载命名导出用 `syncBuiltinESMExports()` 同步。
4. 分别用条目额度 15、0、1 调用生产 API。比较扫描前后目录清单及全部文件 SHA-256；`finally` 恢复包装并清理确切临时目录。

| `maxScanEntries` | 允许真实观察上限 | 实际观察 | 报告 `scannedEntries` | 截断后仍列举 |
|---:|---:|---:|---:|---|
| 15 | 16 | 17 | 17 | features |
| 0 | 1 | 2 | 2 | features |
| 1 | 2 | 3 | 3 | features |

三组均只注入一次关闭错误；结果为 `incomplete`、`truncatedBy=["scan-entries"]`，有 experience-card/unreadable 问题，无注入正文泄漏。库清单及 hash 不变。**没有再次低报计数，也没有误报通过；缺陷是已消耗唯一超限探测后仍继续新列举。**

这是确定性故障注入，不是真实磁盘故障。此路径与本机 Node 24.14.1 的实现一致：`Dir.entries()` 在 `finally` 等待构造时绑定的 close promise；该 promise 拒绝可使 `break` 触发的 `return()` 拒绝。仅在 `opendir` 返回后替换实例 `close` 不能覆盖这个绑定，不能拿“注入未触发”当通过证据。

### 3.2 根因与影响

观察回调已记录唯一超限探测，但未设置全局停止；`stopScan("scan-entries")` 只在 `await listEntries(...)` 成功返回且 `listing.truncated` 为真时执行。

Boundary 检测到超限后 `break`。若异步迭代器关闭拒绝，函数没有返回 listing，而是进入预检 catch。catch 正确保留计数并收敛错误，却没有保留预算触顶状态。下一类别见 `scan.stopped=false`，以剩余额度 0 再列举并观察一条，产生第二次超限探测。

这是 PF-4/S2 原“任何出口真实观察不得超过 `maxScanEntries+1`、触顶后不继续新 IO”要求的遗漏，不是新功能。修复应锁存预算停止，同时保留受控错误与取消语义；不能吞掉关闭错误、改成成功空目录或放宽上限。

现有 `observePreflight` helper 仅转发 `next()`，没有转发 `return()`，所以正常 break 的原迭代器关闭出口未被这些计量用例覆盖。S3 需补完整代理及永久回归，不削弱已通过断言。

## 4. 下一轮与后续路线

唯一编码任务为 **S3：预算超限探测已消耗后，即使列举因关闭错误失败，也不再列举新目录或读取新候选**。先红回归，再最小修复；具体对照、门禁与新对话提示词见 [C3R §8](bm02c3_remediation_plan.md#8-第十九轮后的唯一接续任务s3)。

C3 收口后才拆备份恢复与最小管理入口；然后补 M1 纯记忆策略及 M2 兼容闸门，再进 BM-03～05。M0 已有设计，经验积累、反思归档、动态注入及后台整合不是已实现能力；UI 保持 BM-07，不在 S3 中提前实现。

未测：根全量单测、生产打包/安装、远端 CI、干净 clone、其他 OS、真实 Windows ACL、断电与真实 BIOS/硬件。通过范围仍是观察式格式盘点，不是原子快照、全库一致性证明或备份恢复许可。
