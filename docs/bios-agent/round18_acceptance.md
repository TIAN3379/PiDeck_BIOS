# 第十八轮独立验收：BM-02C3R-S1

日期：2026-10-04。工作区 `D:\BIOS_Pi_Agent\PiDeck_BIOS`，分支 `BIOS_Agent`。

结论：**S1 的成功列举、嵌套预算及其他预算提前停止场景通过，原两种复现关闭；目录迭代中途失败仍会丢失已观察成本，PF-4/C3 整体暂未收口。** 下一轮只做 S2，见 [C3R 方案 §7](bm02c3_remediation_plan.md#7-第十八轮后的唯一接续任务s2)。PF-1～PF-3 与已通过的 S1 行为不重做。

## 1. 独立复跑

| 门禁 | 实际结果 |
|---|---|
| Package `npm test` | 407 项：404 通过、0 失败、3 显式 skip |
| 预检 + 审核/journal 七文件 | 224 项：223 通过、0 失败、1 显式 skip |
| Package 类型 / selfcheck / 格式 | 通过；selfcheck 6 项；格式 66 文件 |
| 根类型 / 格式 | 通过；格式 2014 文件 |
| 根 `tests/processGuards.test.mjs` | 2 项全部通过 |
| `git diff --check` | 通过 |

三个 skip 是本机文件型 symlink 权限限制，不计为行为验证通过。中间目录 junction 的正常路径实际执行；条件缺失时已改为显式 skip。

本轮只修改验收与交接文档，不修改运行代码或永久测试，不 add/commit/push。额外诊断只使用新建合成临时库；诊断目录已清理，不读取真实知识库或客户源码。工作树原有修改、未跟踪文件和六项历史文档删除均保留。

## 2. S1 通过范围

- 成功列举无论是否截断，返回后立即计入实际观察条目；候选处理不重复扣账。
- audit 父目录成本在进入子目录前入账，额度 15 时不再出现实际 18/报告 16。
- 输出或读取预算先停止，不抹掉成功列举已观察的条目。
- registry 登记但磁盘缺目录的逻辑核对单独计数，不冒充物理目录观察，仍共用有限预算。
- 0/1、正常完成、父目录恰好耗尽等永久回归，以及只读清单/hash、取消与既有审核/journal 回归通过。

额外独立进程包装真实 `fs.promises.opendir` 的异步迭代器，只计量实际交出的非 done 条目，不改变目录顺序、条目或上限。原两种诊断得到：

| 场景 | 真实观察 | 报告 `scannedEntries` | 结论 |
|---|---:|---:|---|
| 四个 audit 目录各十个 `{}` JSON，`maxScanEntries=15` | 16 | 16 | `incomplete`，含 `scan-entries`；原复现关闭 |
| experiences 十个 `{}` JSON，`maxOutputBytes=200` | 10 | 10 | `incomplete`，含 `output-bytes`；原复现关闭 |

不是原子快照或全库一致性证明；也不由这些通过项推导已具备备份恢复能力。

## 3. S2 · P2：迭代中途失败丢失已观察成本

位置：`core/storage/boundary.ts` 的 `listEntries`（524 行起）与 `core/storage/preflight/scan.ts` 的 `listEntriesBounded`（339 行起）。

### 3.1 独立复现

1. 初始化合成知识根。在 `experiences/` 和 `features/` 各建二十个受控 `*.json`，内容均为 `{}`。
2. 设置 `maxScanEntries=15`，其余限额默认。
3. 在独立 Node 进程中包装真实 `opendir`，所有正常迭代都交回真实条目并独立计数。仅 experiences 迭代器：正常交出四个条目后，下一次 `next()` 抛受控 `EIO`；不额外读取第五条。
4. 包装在调用 `inspectKnowledgeStore` 前生效；若生产模块已加载，用 `syncBuiltinESMExports()` 同步命名导出。`finally` 恢复包装并清理临时 fixture。

实跑：

```json
{
  "maxScanEntries": 15,
  "observed": 20,
  "reported": 16,
  "complete": false,
  "outcome": "incomplete",
  "truncatedBy": ["scan-entries"],
  "problems": [{ "category": "experience-card", "code": "unreadable" }]
}
```

experiences 已观察四条后失败；features 随后仍获完整额度 15，实际又观察十六条（含唯一超限探测）。总观察为 `4+16=20`，超过共享上限 `15+1=16`，报告只计 features 的十六条。两个目录内所有条目形状相同，复现不依赖哪条先出现。

### 3.2 根因与影响

Boundary 把 `scanned` 留在函数局部，只有成功结束才返回 `{ names, truncated, scanned }`。迭代器抛错后虽经 `finally` 关闭目录，局部观察数没有交回预检。

预检只在 `await boundary.listEntries(...)` 成功之后加 `listing.scanned`。其 catch 将非取消错误转换为受控问题并继续扫描后续类别，已消耗的四条因此没有进入预算。

错误被报告、总体不完整的行为是正确的；缺陷是成本丢失及实际超预算。修复不能简单删除错误问题，也不能把未知异常当成成功空目录。此处不是要求重写根策略或新增全库一致性检查，而是补完 PF-4 原来的真实观察计量。

## 4. 下一轮与未测边界

唯一任务：**S2，补齐成功、截断和中途非取消失败的统一观察计费**。先永久红回归，再最小修复；成功路径不双计，错误/取消与目录关闭语义保持。具体范围、对照与提示词见 [C3R §7](bm02c3_remediation_plan.md#7-第十八轮后的唯一接续任务s2)。

S2 收口后才拆备份恢复与最小管理入口；M0 已有设计，M1/M2、BM-03～05 与 UI/BM-07 仍未实现，不把上次讨论的自动复盘或后台记忆整合塞入本轮。

未测：根全量单测、生产打包/安装、远端 CI、干净 clone、其他 OS、真实 Windows ACL、断电与真实 BIOS/硬件。迭代失败是确定性故障注入，不冒充真实磁盘故障。
