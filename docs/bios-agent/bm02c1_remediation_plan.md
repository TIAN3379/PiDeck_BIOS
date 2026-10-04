# BM-02C1R：恢复核对的有限收尾

日期：2026-10-01。状态：**已由第九轮独立复验在声明的本机范围通过，J1～J4 关闭**；见 [第九轮验收](round9_acceptance.md)。当前只执行 [C2A](bm02c2a_development_plan.md)。
红绿证据、约定与实跑见 [C1 实施记录](bm02c1_implementation.md) 第 6 节。本文转为完成标准留档，第 3 节的提示词不要重跑。
问题证据见 [第八轮独立验收](round8_acceptance.md)。

工作区 `D:\BIOS_Pi_Agent\PiDeck_BIOS`，分支 `BIOS_Agent`。先完整阅读根 AGENTS.md、验收报告与本文，检查 git status，保留累积修改、未跟踪文件和既有历史文档删除。BM-02BR 已通过，C1 主流程已实现，不重建骨架、不重做 W1～W4。

## 1. 顺序与完成标准

每组先新增能在当前实现上失败的永久测试，记录红灯结果，再做最小修复。不要把独立诊断或未来工作写成已经通过。

| 顺序 | 对应问题 | 修改范围 | 完成标准 |
|---|---|---|---|
| C1R-1 | J1：目标与锁不一致 | reconcile 持锁复读 | 复读 journal 的受控目标与持锁目标一致才可观察/收口；变化则不改 journal/目标，不能拿 A 锁处理 B |
| C1R-2 | J2：目标未校验 | reconcile 的同源读取解释 | 记录/registry 版本、结构、身份/归属/绑定检查与真实字节 hash 同源；非法目标 unreadable 且原字节不变 |
| C1R-3 | J3：失败路径诊断丢失 | reconcile 清理与错误传播 | 原 cancelled/IO code 不被覆盖，自有锁释放失败有有界诊断；正常释放和成功路径警告保持 |
| C1R-4 | J4：字节预算失真 | inspect 输出计量 | 候选数组实际 UTF-8 字节满足预算，小正数/边界值/多条均真实截断；0 语义不退化 |

### C1R-1：绑定持锁身份

- 用相同的受控派生/规范化规则比较持锁目标与持锁后合法 journal 的目标。推荐目标变更直接返回 unreadable/changed=false，附固定有界诊断；若选择重新加锁，必须有严格次数上限，不能跨目标无界追逐。
- 永久用例：读 journal 后、lock-mkdir 前由 A 改 B；返回目标/observed 不能冒充 B 的实际观测。保存 A/B/改动后 journal 的 hash 与所有他人锁，恢复不得再修改这些字节。
- 补项目内目标的 projectId 变化用例，避免只比较 id；保持普通同目标两进程核对、已有终态幂等和 busy 行为。
- 不要求 C1 增加防篡改签名或对不合作的外部写者作强事务保证；这里修的是已复读到变化却继续持错锁收口的问题。

### C1R-2：验证目标但不引入二次读取竞态

- 记录可复用 `interpretRecord`，registry 复用现有版本/结构/绑定解释链；必要时提取小职责纯 helper，不复制一套较弱规则。
- 校验 value、revision 与 SHA-256 来自同一次有界读取。避免 readRecord 验证后再 readJson 取 hash；不改现有字节、链接、取消限额，不整库扫描其他记录。
- 永久用例至少覆盖记录与 registry 的未知 schemaVersion、仅有 revision 的非法结构、路径 ID/内容 ID 不符、项目归属不符、非法 registry 绑定；各自断言 unreadable/changed=false、目标与 prepared journal hash 不变。
- 至少一条非法目标的真实 hash 恰好等于 journal.after，仍必须 unreadable，防止“hash 相同就跳过校验”。合法 old/new/更高 revision/同 revision 不同 hash，以及 create 缺失与 update 缺失的原判定继续通过。

### C1R-3：先保留首错，再附加清理诊断

- 复用既有有界 cleanup note 机制；取消/IO 主错误仍是主错误，保留原 code/必要字段，不携带客户正文。不把释放失败伪装成正常取消、也不假称已经删除锁。
- 永久用例：持锁目标读取中途取消 + lock-remove EIO；普通异常 + release 失败（可选用复读 journal 时的 IO 注入）。断言首错、诊断、实际残留锁、目标与 journal 状态。
- 同时检查 journal 终态失败结果是否丢弃已有清理诊断，以及成功的 finalize.cleanup 是否被传递。若存在同源问题在本组最小修复并加用例，不扩展成全仓库清理重构。
- 测试只能清理自己的合成根或已确认退出的测试子进程锁；产品仍不得按 PID/年龄抢锁或增加 force。

### C1R-4：实际字节预算

- 明确 `maxJournalInspectBytes` 覆盖 pending 候选数组的 UTF-8 序列化字节，并计入数组分隔符。对于 0/极小预算，空候选的 `[]` 可作为固定返回信封开销，不能因此返回非空候选。
- 精确计量每条有界候选或使用可证明不低估的上界，不能先无界积累完整结果再截断。problems 继续独立数量/诊断长度限制；别把候选预算宣传为整个返回对象的硬上限。
- 永久用例：300 字节复现、恰好够/少一字节、多条合计触顶、较长合法 ID/项目目标、0 预算；非空结果实际 UTF-8 bytes 不得超限，遗漏候选则 truncatedBy 含 bytes，巡检不改任何文件。

## 2. 门禁与文档收口

先跑 journal 针对性测试；最终跑完整门禁，保留现有 206 测试基线，不删除/放宽断言或通过新增 skip 掩盖问题，不要求凑固定新增条数。

```powershell
# D:\BIOS_Pi_Agent\PiDeck_BIOS\packages\bios-agent
node --test tests/storageJournal.test.mjs
npm run typecheck
npm test
npm run selfcheck
npm run check:format

# D:\BIOS_Pi_Agent\PiDeck_BIOS
npm run typecheck
npm run check:format
node --test tests/processGuards.test.mjs
git diff --check
```

若新增单独回归文件，同样运行；最终报告真实 count/pass/fail/skip。目录 junction 实跑，文件 symlink EPERM 明示 skip，不改系统权限。真实崩溃和跨进程回归保留，故障注入不冒充断电实验。

在现有 `bm02c1_implementation.md` 追加 C1R-1～4 的红绿证据、API/预算约定、门禁与未测；同步导航、task/test/log、Package README。修正文档中“确认退出后 SIGKILL”的笔误，实际顺序为“checkpoint → 终止 → 等待 close → harness 清理自己的 fixture 锁”。不另造多份相同实施报告。

只改 Package 存储 core/必要契约/测试及文档。保留记录 schemaVersion=1、journalVersion=1、真实数据提交点、提交后 needs-recovery 语义，不重放/回滚/重增 revision。不做 C2 审计/多文件/迁移、D 备份 CLI、RAG、厂商适配、模型写工具、桌面 IPC/UI；不改 PiRuntime，不碰真实客户资料，不 git add/commit/push，不额外删除历史文档。

完成后交回独立复验，不自动开下一阶段；上下文不足时在实施记录写清已完成项和唯一下一项。

## 3. 简短提示词

```text
在 D:\BIOS_Pi_Agent\PiDeck_BIOS 的 BIOS_Agent 分支，先读 AGENTS.md、
docs/bios-agent/round8_acceptance.md 与 bm02c1_remediation_plan.md。
只完成 C1R-1～4：持锁目标一致性、目标同源完整校验、失败路径清理诊断、
巡检真实字节预算。先红后绿补永久回归，跑文档门禁并更新现有实施记录。
保留当前修改/未跟踪文件/既有删除；不重做 BR，不重放/偷锁，不做 C2/UI，
不改 PiRuntime、不碰客户资料、不 add/commit/push。完成交回验收。
```
