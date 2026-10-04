# 第六轮独立验收：BM-02B

日期：2026-10-01。工作区 `D:\BIOS_Pi_Agent\PiDeck_BIOS`，分支 `BIOS_Agent`，HEAD `36eb385a`；本轮开发仍包含工作树修改及未跟踪新文件，不对应已发布版本。

## 1. 结论

**BM-02B 主流程通过，但尚未完整验收通过。** 第五轮 B0 已关闭，五类记录写入、正常 revision 冲突、真实多进程竞争与读写可见性成立。补查发现 1 个 P1 与若干 P2 边界，按下述 W1～W4 做有限收尾；修复前不开放生产知识写入、不叠加 journal。

下一步任务和提示词统一放在 [next_development.md](next_development.md)。不是重做 Package、BM-02A 或整个写入架构。BM-02C 的具体实现需等这批写入不变量复验通过后启动。

## 2. 独立复跑

| 检查 | 本次结果 |
|---|---|
| Package `npm test` | 140 用例：139 通过、0 失败、1 文件符号链接 EPERM skip |
| 第五轮 B0 | 3 条回归通过，调用级与 boundary signal 生效，迟到取消不假称回滚 |
| 新增 `storageWrite.test.mjs` | 30 个用例通过（包含子用例） |
| Package `npm run typecheck` | 通过 |
| Package `npm run check:format` | 29 文件通过，无写入格式命令 |
| Package `npm run selfcheck` | 6 项通过 |
| 根 `npm run typecheck` | 通过 |
| 根 `npm run check:format` | 2014 文件通过，无写入格式命令 |
| 根 `node --test tests/processGuards.test.mjs` | 2 通过、0 跳过 |
| `git diff --check` | 通过；不覆盖未跟踪文件，新增文档另检查 |

环境：Windows、Node 24.14.1、Pi 开发宿主 0.87.1。未调用模型、未读取真实客户资料。

实际执行了真实子进程创建/更新竞争、非空记录新进程读取、并发读者 60 次与写者 15 次更新、目录 junction 拒绝。不能把上述结果扩大为 Linux/macOS、远端 CI、干净安装、生产打包或真实 BIOS 项目通过。

## 3. 已成立的能力

- 写入使用稳定 ID、受控落点与共享 schema；业务正文不能覆盖头字段和任务归属。
- 普通记录更新持锁后复读并比较 expectedRevision；同一 revision 的真实双进程更新只有一方提交，另一方报告 actual=1。
- registry 普通更新复用结构/绑定一致性校验，不暗中改写 profile；重复绑定被拒绝。
- 同目录完整临时文件、sync、rename 提交在正常路径成立；旧记录在提交窗口保持完整，更新后无半 JSON。
- 锁目录使用原子 mkdir，正常超时、取消、自有锁释放及拒绝抢占成立。提交后锁释放失败通过 `lockRelease` 上报，不改口为“未提交”。

## 4. 新发现的问题

以下诊断均运行在自建临时知识根，执行结束后清理；没有修改生产源码或永久测试。

### W1 / P1：registry revision 可溢出并停止递增

位置：`core/storage/write.ts` 的 `assertExpectedRevisionShape`（约 177 行）、`updateRegistry`（约 432～435 行）。

普通记录 `nextHeader` 检查溢出，但 registry 直接 `current.revision + 1`；expectedRevision 也只检查 Integer 而非 SafeInteger。

独立复现：把合成 registry 的 revision 设置为 `Number.MAX_SAFE_INTEGER`，连续更新两次：

```text
第一次提交 revision = 9007199254740992（不安全整数）
第二次提交 revision = 9007199254740992（未增加）
```

结果：相同 expectedRevision 可重复成功，乐观冲突保护失效。现有溢出用例只测 task-record，遗漏 registry。

要求：registry 和记录共用安全 revision/头字段生成链；非法/溢出拒绝且原字节不变，补两类入口的回归。

### W2 / P2：锁等待与诊断没有完整输入/取消边界

位置：`core/storage/lock.ts` 的 `acquireStorageLock`（约 156～216 行）、`readLockMetaWith`/`describeLockHolder`（约 108～143 行）；写入口也未校验锁选项。

独立复现：

| 输入/时序 | 当前结果 | 应有结果 |
|---|---|---|
| 已持有锁，`lockTimeoutMs: NaN` | 等待 151ms 后被诊断 watchdog abort，返回 cancelled；未拒绝非法配置，deadline 为 NaN | 入口结构化拒绝，不进入等待 |
| 锁元数据 `createdAt: 1e100` | 裸 `RangeError: Invalid time value` | 不可信/不可读诊断，正常有界 lock-timeout，不抢占 |
| `lockTimeoutMs:0`，`lock-read` 等待期间 abort | signal 已取消却返回 lock-timeout | cancelled 穿透，超时分支前复查 |

无取消且锁一直忙时，NaN deadline 永远不会满足超时条件。Infinity、负数、非整数、超出定时器范围等也没有公共守卫。now 同样没有完整安全/可表示时间校验。

要求：明确时间参数范围、入口校验、诊断降级；等待路径取消不能吞，释放清理继续免疫取消。

### W3 / P2：提交前 close 失败被吞掉

位置：`core/storage/boundary.ts` 的 `replaceJson`（约 574 行）。

`await handle.close().catch(() => undefined)` 后继续 rename。独立诊断包装真实打开的临时文件句柄：先实际关闭，再抛合成 EIO，避免遗留句柄；结果仍 `updated/revision=1/cleanup=ok`。

要求：正常提交路径 close 失败不得继续提交；清理的二次关闭错误不得覆盖首个错误。补真实句柄计数或等价确定性生命周期断言，不能只用“后来还能写”证明没有泄漏。失败后临时删除/锁释放失败也要留下有界诊断，而不是丢弃清理结果。

另有计划偏差：`createRecord` 当前也走可覆盖的 rename，原计划要求非覆盖发布。协作式锁下的双写者测试成立，但不是文件系统层“只新建”。下一轮按原计划恢复完整临时文件 + 非覆盖发布，保留锁和字节预算；不要恢复直写最终目标的 wx 回退。

### W4 / P2：只凭 registry 存在判断“已初始化”

位置：`core/storage/write.ts` 的 `assertStoreInitialized`（约 266 行）。

它只做 lstat 存在性，不校验 registry 的版本/结构。独立复现：registry 写成坏 JSON 后，`createRecord(feature-record)` 仍返回 created。

要求：普通记录写入入口在产生新写状态前校验有效 registry；损坏、未来版本、非文件、链接、非法绑定拒绝，不在不认识的库中继续添加记录。此校验是入口快照，不应宣称同时获得整库/多文件事务保证。

## 5. 文档核对与精简

- README 原先仍称普通 create/update 尚未实现，已改为 BM-02B 已实现但待 W1～W4 收尾。
- 实施记录中“整个 packages 和锁文件未跟踪”不符合当前 Git 状态，已更正为“既有文件修改 + 部分新文件未跟踪”。
- “全部参数在取锁之前校验”“任意 IO 失败不提交”“所有溢出都拒绝”等实施方表述不完全成立，以上复现优先；不抹除自测记录，增加最新验收提示。
- 当前 boundary.ts 为 659 行，超过 AGENTS 的评估阈值。后续为提交 IO/读取 IO 拆出内聚模块，避免再把 journal 塞进去；拆分不替代行为修复。

按用户要求删除 6 份被替代文档：第一至第四轮验收报告，以及第一/第二轮整改记录。关键问题、关闭情况和恢复方式合并到 [acceptance_history.md](acceptance_history.md)，并修复活动文档链接。删除文件在 `36eb385a` 中都有原文，可用 Git 历史恢复；没有删除代码、测试、客户数据或未跟踪实施文件。

## 6. 交回

本次仅验收、更新/清理文档；未修生产代码，未提交/推送。现有 140 用例通过不代表新增诊断通过。下一轮限定 BM-02BR 的 W1～W4；复验通过后再制定并实施 BM-02C 的最小 journal 子任务。
