# BM-02C2A：审核审计契约与一致性协议

日期：2026-10-01。状态：原协议经 [第十轮验收](round10_acceptance.md) 指出 A1～A3，随后 C2AR 收尾已经 [第十一轮验收](round11_acceptance.md) 通过（协议与纯校验范围）。
本文为原完成标准留档，第 6 节旧提示词不再执行；当前任务是 [C2B](bm02c2b_development_plan.md)，不能照本文旧协议直接实现 IO。前置 [第九轮独立验收](round9_acceptance.md)：C1/C1R 本机范围通过，J1～J4 已关闭，220 项中 218 pass、2 文件 symlink 权限 skip。

## 1. 这轮要解决什么

目前 journal 能回答“字节是否与写入意图一致”，不能回答“谁在何时审核了哪条经验、基于哪个版本、作了什么决定”。不能从 recovery-observed 伪造一条人工审核审计。

本轮交付两个东西：

1. 可运行、可单测的**纯审核审计契约与语义校验**，首版只覆盖 ExperienceCard。
2. 一份唯一推荐的持久化一致性协议，说明未来业务状态与审计如何关联、在各失败窗口下如何恢复。协议通过验收后再实现 IO。

这是 C2 的第一小步，不是只写说明书，也不是提前落地多文件事务。当前不开放真正的审核写入口。

## 2. 顺序与落点

| 编号 | 任务 | 建议落点 | 完成判据 |
|---|---|---|---|
| C2A-1 | 协议先行 | `docs/bios-agent/bm02c2a_implementation.md` | 提交点、失败/取消、关联、恢复来源与兼容策略唯一且明确，不能只列几个备选 |
| C2A-2 | 审计元数据 schema/types | `core/contracts/audit.ts`、契约出口 | 类型由 schema 推导，独立 auditVersion；不更改现有五类记录/journal 版本 |
| C2A-3 | 纯语义解释/校验 | 同域小 helper，必要时独立 `auditValidation.ts` | 不可信输入结构化拒绝，跨字段一致性、安全 revision/时间、限额与脱敏闭环；不做 IO |
| C2A-4 | 永久测试与收口 | `tests/auditContracts.test.mjs`、README/任务/测试/日志 | 正常/异常/预算/未知版本可复跑，原 220 基线继续通过，交回验收 |

沿用 TypeScript strict/typebox 和现有契约模式；契约层不 import storage、Electron、Pi 或其他运行时层。复用纯 ID/枚举/证据规则；确需抽公共纯 helper 时保持旧出口兼容，不进行跨层大重构。模块目标 400 行内，超过 600 行须评估拆分。

## 3. 最小审计契约

先在实施记录确定字段名、上限与语义，再编码。至少包含：

- 独立 `auditVersion: 1`，事件 eventId 与关联 operationId 为规范小写 UUID；本轮校验不负责生成随机值。
- 受控目标只为 experience-card + 合法 recordId，不接受绝对/相对 target/temp/lock 路径。
- action、fromStatus、toStatus，复用 draft/reviewed/verified/deprecated。列出 action 与状态对的合法关系；拒绝未知动作、互相矛盾的组合。审核领域完整业务规则仍在后续 experiences 模块实现，本轮不能声称 verified 的硬件证据已由此契约保证。
- 操作者标签、动作时间、简短理由；标签是调用方声明的人工标签，**不是企业身份认证**。origin/channel 若有同样只是声明，不因字段为 human 就获得权限。
- before/after 的安全 revision 与真实字节 SHA-256，用于将审计绑定到明确版本；审核动作按 update 关系 after=before+1，不接受 null/unsafe/溢出。
- 有界的证据关联元数据（已有引用或引用 ID），不复制整条经验、源码、补丁、对话或日志；引用关系与数量上限写清楚。

建议单条审计元数据不超过 16 KiB，标签不超过 128 字符、理由不超过 512 字符、证据关联不超过 32 条；最终上限可调整但须说明理由，字符与 UTF-8 字节分别校验。输入超限就拒绝，不能静默截断后假称原决策完整。

纯校验接受 unknown，返回明确 issue code/path/message；未知 auditVersion 拒绝，不猜格式。错误数量、单条诊断和总诊断输出有界，不能通过 echo 输入正文/未知字段名/巨大标签泄漏客户资料。拒绝对象/数组/数值字段异常及未知路径字段，不新增 any，不用强转跳过校验。

现有 ExperienceCard/schemaVersion=1、journalVersion=1、RECORD_SCHEMAS 的五类集合与 storage API 均保持不变；审计契约是独立类别，不把它硬塞成第六类业务记录以绕过设计。

## 4. 一致性协议必须回答的问题

这节先设计，不实现磁盘修改。实施记录要给出明确推荐及状态表，至少回答：

1. “审核状态改了但审计没写成”与“审计有了但业务未提交”各如何表示？唯一业务提交点是什么？提交后的失败如何避免盲重试？
2. 现有 C1 journal 只有 hash，不含操作者/理由，无法凭空重建审核事实。审核意图需要哪些有界元数据、在目标提交前存在哪里？如何与 operationId/eventId 和前后 fingerprint 绑定？
3. 首版只保护一次经验审核及其审计，不建设任意 N 文件事务。是否复用目标锁、是否另有审计锁，锁顺序/等待上限/取消/清理/并发恢复如何确定？
4. 审计按事件非覆盖发布，如何避免同记录后续动作覆盖历史？稳定事件 ID 如何使重试幂等，已有同 ID 不同内容如何报冲突？路径只由受控 ID 派生。主方案的 `audit/<recordId>.json` 是示意，若改为每事件独立文件，说明如何按记录关联/有界查询，不在本轮实际创建目录。
5. prepared/业务提交/审计发布/收口四类窗口，对缺失、坏 JSON、版本未知、更高 revision、hash 不匹配、busy 和两个恢复者分别如何处理？已经有一致终态则不增加 revision/事件；不能从伪造或不可解释的意图重写业务内容。
6. 审计里的“人工决定”与恢复器观察到的“内容一致”如何区分？复读/完成派生审计不代表恢复器亲自批准；元数据不能作为认证凭据。
7. 如果将来需扩展 journal 版本，如何仍识别 v1、拒绝未知版本、区分不带审核事实的普通写操作？不得在本轮偷偷改 v1 解释或实现迁移。
8. 真正的审核入口只由人工 CLI/UI 调用，不注册 LLM 批准工具；当前通用 storage API 的直接调用无法据此获得完整权限保证，应用层限制不冒充 OS 防护。

协议应落实到未来最小 API/结果类型、恢复表、IO checkpoint 测试清单及未覆盖边界。不要把“实现第二个 JSON 写入”说成原子事务，也不要因为 C1 通过就假称审核审计已经完成。

## 5. 测试与门禁

永久测试至少有：合法审计样例；未知版本/缺字段/额外路径字段；UUID/recordId；状态动作不一致；safe revision 边界/溢出；hash 格式；非法时间；标签/理由/证据数量与单条真实 UTF-8 预算；恶意大字段/巨大 issue 的脱敏有界输出。现有实例传入校验后不得被修改。不删旧断言，不增加 skip 掩盖缺陷，不凑固定条数。

```powershell
# D:\BIOS_Pi_Agent\PiDeck_BIOS\packages\bios-agent
node --test tests/auditContracts.test.mjs
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

新建唯一 `bm02c2a_implementation.md`，记录协议、实际改动、测试与未测；同步导航/task/test/log/Package README。不要将纯数据校验测试称为 IO 恢复或人工身份认证验证。

只改 Package 的纯契约/必要 helper/测试与文档。不做审核持久化、通用多文件事务、迁移/备份/CLI/UI/RAG/厂商适配/模型写工具，不改 PiRuntime，不碰客户资料，不 add/commit/push，不额外删除历史文档。保留当前所有修改/未跟踪文件/既有删除。完成 C2A-1～4 后交回验收，不自动开 C2B。

## 6. 简短提示词

```text
在 D:\BIOS_Pi_Agent\PiDeck_BIOS 的 BIOS_Agent 分支，先读 AGENTS.md、
docs/bios-agent/round9_acceptance.md 和 bm02c2a_development_plan.md。
C1/C1R 已在本机范围通过，只做 C2A-1～4：审核审计纯契约/校验/永久测试，
并写清一次经验审核与审计的提交及恢复协议；本轮不实现审核 IO 或改变 journal v1。
跑文档门禁、更新实施记录与导航。保留已有改动，不做 C2B/迁移/UI，不改
PiRuntime、不碰客户资料、不 add/commit/push。完成交回验收。
```
