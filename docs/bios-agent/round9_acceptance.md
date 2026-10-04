# 第九轮独立验收：BM-02C1R

日期：2026-10-01。工作区 `D:\BIOS_Pi_Agent\PiDeck_BIOS`，分支 `BIOS_Agent`。

结论：**C1/C1R 在本轮声明的本机范围内通过，J1～J4 关闭。** 未发现阻塞本轮交付的新问题。下一轮只做 [BM-02C2A：审核审计契约与一致性协议](bm02c2a_development_plan.md)，不继续反复开发 C1，也不一次实现整个 C2/D/UI。

## 1. 独立复跑

| 工作目录 | 命令 | 结果 |
|---|---|---|
| `packages/bios-agent` | `npm test` | 220 项：218 pass、0 fail、2 skip；约 41.9 秒 |
| 同上 | `node --test tests/storageJournal.test.mjs` | 37 项全部通过、0 skip；约 28.6 秒 |
| 同上 | `npm run typecheck` | 通过 |
| 同上 | `npm run check:format` | 39 文件通过，未修改文件 |
| 同上 | `npm run selfcheck` | 6 项通过 |
| 仓库根 | `npm run typecheck` | 通过 |
| 仓库根 | `npm run check:format` | 2014 文件通过，未修改文件 |
| 仓库根 | `node --test tests/processGuards.test.mjs` | 2 项通过 |
| 仓库根 | `git diff --check` | 通过；不覆盖未跟踪内容 |

两个 skip 仍为文件型 symlink EPERM，没有新增 skip；目录 junction 实跑。全套包括既有真实跨进程竞争、checkpoint 终止/新进程核对和句柄生命周期回归。

实施方在 [C1 实施记录](bm02c1_implementation.md) §6 记录了新增测试先红后绿的过程。本轮独立执行的是修复后的复跑，不把其历史红灯记录冒充本轮亲自执行的证据；新增 14 项包括子用例。

## 2. J1～J4 闭环证据

| 问题 | 源码核对 | 永久回归及独立诊断 | 结论 |
|---|---|---|---|
| J1 错目标收口 | `journalTargetKey` 由受控目标片段派生，涵盖 kind/id/projectId；持锁复读目标改变即 unreadable，不追新目标加锁 | 永久用例含 A→B 与仅 projectId 改变；独立重跑 A→B，返回 observed=null、changed=false，A/B 与改变后的 journal hash 不再被修改，自有锁释放 | 关闭 |
| J2 目标缺完整校验 | 单次 `readJson` 同时返回 value/hash，记录用 `interpretRecord`，registry 用 `interpretRegistryValue`；解释失败不参与 hash 判定 | 永久用例覆盖未来版本、残缺结构、ID/归属/绑定错误；独立重跑 schemaVersion=999，并令非法目标 revision 和 after hash **同时精确匹配**，仍 unreadable 且 prepared 原字节保留；非法 registry 同样拒绝 | 关闭 |
| J3 清理诊断丢失 | 抛错分支保留首错再附 cleanup note；返回值分支保留锁警告；终态失败/成功均传递已有临时清理事实 | 永久回归覆盖取消+释放失败、普通 IO+释放失败、终态失败+临时清理失败和终态成功+cleanup failed；独立重跑取消/普通 IO 的锁释放 EIO，原 cancelled 或 unreadable 保留且残留锁诊断可见 | 关闭 |
| J4 字节预算失真 | 逐候选计算实际 UTF-8 JSON bytes，计入数组括号与逗号；不先积累无界结果 | 永久回归覆盖 300 字节、精确边界、多条、长 ID；独立复查 0/1/2/299/300/363±1/363 的预算，一条候选恰为 363 字节，少一字节不返回并标 bytes 截断 | 关闭 |

这些独立诊断使用系统 temp 中的合成根，结束前校验确切清理路径并删除；不计入 220 项永久测试数量。注入 IO/竞态是分支复验，不是实际磁盘故障或恶意进程攻防验证。

预算只覆盖 `pending` 候选数组的 UTF-8 序列化字节；空数组的 2 字节是固定信封成本。problems 使用独立数量与单条长度限制，整个返回对象不能宣传为落在候选预算内。

## 3. 仍然保留的边界

- C1 只核对结果并收口 journal，不重放/回滚业务内容、不重复加 revision。只有 hash/元数据，不能恢复丢失正文。
- journal 来源区分 writer-confirmed 与 recovery-observed；后者不是业务审核人身份或行为的证明。
- 遗留锁仍需人工确认，不按 PID/时间回收，不提供 force。终态幂等返回不会顺手删除遗留锁。
- 普通 storage 写入口是底层能力，不等于已实现人工审核权限；后续审核须有专用领域入口，不能将通用 update 的 status 字段当作完整审批流程。
- 未测：根全量测试、生产构建/安装包、远端 CI、干净 clone、Linux/macOS、断电、真实 BIOS 项目。通过本机合成测试不表示支持具体 IBV/芯片，也不表示生产知识系统已就绪。

## 4. 下一步

按分阶段 MVP 技能，把 C2 拆小。C2A 先实现纯审核审计契约与校验，并写清“业务记录 + 审计”的提交/恢复协议；C2B 再据验收后的协议实现持久化一致性。迁移/备份随后单独排期，不建设通用分布式事务框架，不提前做 UI。

本次验收只改文档，没有修改生产代码或永久测试，没有新增历史文档删除，没有 git add/commit/push。现有累积修改、未跟踪源码/文档和前轮 6 份历史文档删除全部保留。
