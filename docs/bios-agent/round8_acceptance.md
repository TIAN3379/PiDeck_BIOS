# 第八轮独立验收：BM-02C1

日期：2026-10-01。工作区：`D:\BIOS_Pi_Agent\PiDeck_BIOS`，分支 `BIOS_Agent`。

结论：单文件 journal 的写入主流程、现有崩溃测试与门禁通过，但恢复核对及预算有 4 项已复现问题，**C1 尚未完整通过**。下一轮只执行 [BM-02C1R 收尾任务](bm02c1_remediation_plan.md)，不进入 C2/D/UI，不重做 BR。

## 1. 独立执行的门禁

| 工作目录 | 命令 | 结果 |
|---|---|---|
| `packages/bios-agent` | `npm test` | 206 项：204 pass、0 fail、2 skip；约 36.3 秒 |
| 同上 | `npm run typecheck` | 通过 |
| 同上 | `npm run check:format` | 39 文件，通过；未自动修改 |
| 同上 | `npm run selfcheck` | 6 项通过 |
| 仓库根 | `npm run typecheck` | 通过 |
| 仓库根 | `npm run check:format` | 2014 文件，通过；未自动修改 |
| 仓库根 | `node --test tests/processGuards.test.mjs` | 2 项通过 |
| 仓库根 | `git diff --check` | 通过；不代表未跟踪文件也被该命令检查 |

两个 skip 仍是文件型符号链接权限限制，不算通过。目录 junction 用例实际执行。
首次误写守卫测试文件名后，已按上表正确命令重跑通过，不把首次失败算成产品缺陷。

现有测试覆盖 prepared 在目标提交前落盘、真实字节 fingerprint、提交后终态失败的真实成功/needs-recovery、只读 inspect、busy 不偷锁、幂等核对及后续更新不被重放。崩溃 harness 使用真实子进程 checkpoint，先终止、等待 close，再由 harness 清理自己的 fixture 锁；四个检查点各有 create/update，registry 另有提交后终态前检查点。上述测试通过不等于所有恢复边界均正确。

## 2. 未通过项

下面 4 项均从公开 API 运行独立合成库诊断，不只是源码推测；诊断未加入永久测试，**不计入上述 206 项**。所有业务目标都是临时合成记录，没有读取客户资料。

### J1 · P1：journal 换目标后仍持旧目标的锁进行收口

位置：`packages/bios-agent/core/storage/journal/reconcile.ts:126`、`:196`、`:206`。

复现：创建合法经验 A、B（revision 均为 0，字节不同），放置针对 A 的合法 prepared journal，after 为 A 的真实 hash。在 `beforeIo("lock-mkdir")` 检查点，将该 journal 的 target 改为 B，其他字段仍合法。恢复方锁住 A，持锁复读却使用 B 的 journal 和 A 的 fingerprint。

实测：返回 `outcome=committed, changed=true, target=A`，磁盘 journal 却为 `target=B, state=committed`，**B 的实际 hash 不等于该 after hash**。业务目标没有被覆盖，但恢复记账结论是假的，也没有持 B 的锁。

要求：持锁复读后确认 journal 的受控目标与实际持有的锁一致。目标变化时保守报告无法判定且不写终态；不能只把 targetPath 改为 B 而继续使用 A 的锁。已有终态的免目标读取幂等规则保持。

### J2 · P2：未知版本/非法结构的目标被当作可判定记录

位置：`packages/bios-agent/core/storage/journal/reconcile.ts:76`～`:94`。

`readTargetFingerprint` 只校验 revision，没有执行目标的版本、完整结构、ID/项目归属或 registry 绑定校验，与原 C1 方案 §2.3 和该模块头注释不符。

复现：合法经验 A 与其 prepared journal，将 A 的 `schemaVersion` 改为 999，revision 保持 0，再核对。

实测：`outcome=conflict, changed=true`，prepared 被改成终态，journal hash 改变。要求应为 `unreadable, changed=false`，保留目标和 journal 原字节。仅有 revision 的坏结构也不能参与 before/after 判定。

要求：复用现有目标解释规则，校验和 hash 必须来自**同一次有界读取**，不是先验证一份再读另一份算 hash；合法但不同的版本才可记 conflict。不存在仍按 C1 的 create/update 缺失规则处理，不需要对其他业务文件进行整库扫描。

### J3 · P2：取消后自有锁释放失败的诊断被丢弃

位置：`packages/bios-agent/core/storage/journal/reconcile.ts:165`～`:175`。

复现：prepared 指向合法 A；在持锁读取 A 的 `beforeIo("read")` 中 abort，在 `beforeIo("lock-remove")` 中注入 EIO。

实测：抛出原 `cancelled`，message 只有“存储操作已取消”、detail 缺失，但 `locks/` 留下 1 个锁目录，journal 仍 prepared。代码在附加锁释放警告前先 `throw failure`，导致错误路径无法提示残留锁。

要求：保留原错误 code/关键字段，并附加有界、不含正文的锁清理诊断；不以清理错误覆盖取消，不自动抢占/删除他人的锁。成功路径已有释放警告也不得退化。

### J4 · P2：巡检“字节预算”低估真实输出

位置：`packages/bios-agent/core/storage/journal/inspect.ts:123`、`:208`～`:214`。

`estimateEntryChars` 漏算 before hash、字段名、完整结构等，用估算字符数冒充 UTF-8 字节预算。

复现：一条合法 prepared 经验 journal，调用 `inspectPendingJournal({ root, limits: { maxJournalInspectBytes: 300 } })`。

实测：返回 1 条候选，`Buffer.byteLength(JSON.stringify(result.pending), "utf8")=363`，却 `truncated=false, truncatedBy=[]`。这不是无界内存问题，但违反可注入的小预算契约，原“0 预算”测试不能发现它。

要求：定义预算覆盖候选数组的实际 UTF-8 序列化字节（含必要分隔符），使用准确计量或可证明不低估的上界；超限不返回该候选并报告 bytes 截断。问题列表/返回信封若采用独立预算须在文档说清，不得称整个返回值都落在候选预算内。

## 3. 验收边界与下一步

- J1～J4 的 IO 故障/竞态注入是确定性分支诊断，不冒充真实磁盘损坏或恶意进程攻防验证。临时目录已校验在系统 temp 下并清理；J3 的合成残留锁随该临时根删除。
- 未执行根全量测试、生产构建/安装包、远端 CI、干净 clone、Linux/macOS、断电实验或真实 BIOS 试点。没有自动遗留锁回收能力，也不要求本轮增加。
- 当前工作树有累积修改、未跟踪源码/文档，以及前轮 6 份历史文档删除；均保留。本次只修改交接文档，没有改生产代码/永久测试，没有新增历史文档删除，没有 git add/commit/push。
- 按分阶段 MVP 收口：下一轮 C1R 先将这 4 项做成永久红灯回归，再修绿并复跑门禁。完整复验通过后再排 C2 的独立小任务，不同时展开审计、多文件事务、迁移和 UI。

协议和实施历史分别保留在 [C1 原方案](bm02c1_development_plan.md) 与 [C1 实施记录](bm02c1_implementation.md)，不重复执行旧提示词。
