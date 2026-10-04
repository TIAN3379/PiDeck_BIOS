# BM-02C2AR：审核协议与纯关联校验有限收尾

日期：2026-10-01。状态：**第十一轮独立通过（协议与纯校验范围），A1～A3 关闭**；见 [最新验收](round11_acceptance.md) 与 [C2A 实施记录](bm02c2a_implementation.md) §3/§6。当前任务为 [C2B](bm02c2b_development_plan.md)。
本文转为完成标准留档，第 6 节提示词不要重跑。
前置：[第十轮验收](round10_acceptance.md)。C2A 事件契约/校验主体已通过本机复跑，A1～A3 已按本轮收口；BR、C1/C1R 未重做。

## 1. 本轮交付与边界

交付：修正后的唯一审核持久化协议、可执行的纯意图/事件关联校验、永久回归、准确的实施记录与导航。

只改 `packages/bios-agent/core/contracts/`、相关测试与文档。**不做任何审核 IO**，不创建真实 audit/intents/journal 文件，不修改现有 storage API、journal v1 或五类记录版本。没有 CLI/UI/权限系统、通用事务、迁移/备份、RAG、厂商适配、模型审核工具；不改 PiRuntime，不碰客户资料，不 add/commit/push，不删历史文档。保留当前工作区全部累积修改与未跟踪文件。

沿用 TypeBox 与 schema 推导类型；契约不得 import storage/Electron/Pi/IO。新纯 helper 按职责拆分，目标 ≤400 行，超过 600 行评估拆分；不新增 any 或用强转绕过校验。修 helper 缺陷先红后绿，不放松原断言，不增 skip 掩盖问题。

## 2. C2AR-1：修正唯一协议（A1、A3）

修改既有 `bm02c2a_implementation.md` §3，不再另写互相竞争的协议文档。原实施记录的自测证据保留，新增 C2AR 章节区分本次实测和设计。

明确以下唯一顺序：

```text
目标协作锁 → 同源读取/校验当前版本 → 持久意图 → 审核 prepared journal
→ 业务 rename（唯一业务提交点）→ 审计事件发布或认领 → 完成终态 → 释放自有锁
```

- writer 与 recovery 都不能先写完成终态再发事件。恢复先持锁、复读目标与关联，不能调用现有 C1 收口函数后“追加审计”。只发布审计和收口，不重放业务、不加 revision、不抢锁。
- 事件发布/认领失败：业务已提交仍如实报告 applied + audit pending + needs-recovery；留下可解释的恢复依据。再次中断后可以重试补齐，而不是业务盲重试。
- 未来审核使用**专用 journal v2**（本轮仅定义协议，不能改现有 `JOURNAL_SCHEMA_VERSION=1` 或实现 v2 IO）：含必填审核 discriminator、eventId、受控 intent 标识和真实 intent 字节指纹，绑定 operationId/target/before/after。普通写保留 v1，v1 不推断审核，不自动升级；旧 C1 恢复器必须对 v2 保持未知版本拒绝。
- 不能再以“intent 不存在”判断审核操作是普通写。审核 v2 的 intent 缺失/不可读/超限/链接/坏 JSON/未来版本/关联错误均拒绝发布和终态成功，保留证据给人工判断。
- intent 无 journal 时不发事件；已有正常一致终态不新增事件。审核完成终态却缺事件/事件冲突属于异常，不冒充成功，不从猜测补出人工决定。明确终态检查范围和保守结果。
- intent 被换、目标变动、较高 revision、hash 不匹配、busy、取消、清理失败都列进恢复表；真实指纹取自有界读取原字节，声明值不是认证。
- 完成终态只在发布成功后写，不等于断电级多文件事务；目录 fsync/电源故障、外部进程绕过协议仍列未验证，不作额外承诺。

补失败窗口表：首次提交中断、恢复器在事件发布前/后再次中断、终态失败、已有 writer 事件、已有 recovery 事件、缺失/错误 intent、终态缺事件、两个恢复者。同步未来 IO checkpoint 清单，**只列计划，不伪称 IO 实测**。

## 3. C2AR-2：纯意图与幂等关联（A2、A3）

仅靠改文字不够：在契约层增加最小纯 helper 和必要 schema，供未来 C2B 复用。可拆 `auditIntent.ts` / `auditAssociation.ts`，不建立通用 journal 框架。

- 意图拥有独立 intentVersion 与 purpose，包含一次审核的稳定决定字段。复用现有 audit 字段/schema/动作规则，不重复造另一套事件类型；publication/recordedAt 属于实际发布事实，不是尚未发布的人工意图。
- 意图校验接受 unknown、拒绝未知版本/路径/结构，预算和 issue 脱敏有界，不复制业务正文，不修改输入。若通过现有事件校验复用逻辑，必须说明临时验证值不代表已经发布，也不返回伪造发布事实。
- 设计一个最小**审核关联投影**，明确它如何由未来已校验 journal v2 提供：operationId、eventId、target、before/after、intent 字节指纹等。该投影不是完整 journal v2，也不能拿它绕过未来 journal 结构校验。
- 纯比较入口校验 intent/关联投影/已有 event，不直接接收磁盘路径；逐项核对 operationId、eventId、受控 target、前后 revision+hash、全部稳定决定字段与 evidence。实际读取的 intent hash 由将来 IO 层传入，纯函数仅比较，不把声明 hash 当实际字节证明。
- **不存在事件**：未来 IO 才生成 publication/recordedAt。**已有事件**：完整验证事件，再比较稳定决定；匹配即认领其实际 publication/recordedAt，不重新生成、不覆盖、不以当前恢复时间替换。writer/recovery 都可认领。
- 同 ID 的 target/动作/状态/理由/操作者/决定时间/证据/前后指纹等任一不同 ⇒ 明确 association/conflict，不能只比 eventId 或只忽略所有差异。非法发布事实也拒绝。
- 对象键顺序不应制造决定冲突；证据数组顺序是否有意义明确固定（建议保留顺序逐项匹配）。任意输入字段/正文不进入错误消息。

永久用例必须证明：writer 已发布后 recovery 认领仍返回 writer 原时间；第一次 recovery 后再次认领保留第一次时间；相同 ID 不同决定拒绝；intent/journal 投影错 operationId、eventId、target、before/after 或真实 intent hash 均拒绝；未来 intent 版本、额外路径字段、超限与大诊断拒绝；冻结输入不变。测试的是纯比较，不是崩溃恢复。

## 4. C2AR-3：结果真相、限额说明与漏测收口

- 修正未来 API 结果为判别联合或同等清晰结构：未提交、已提交且审计已存在、已提交但审计待补、journal 待收口；认领已有事件返回其真实 publication/recordedAt，而非一律 recovery。事件未发布时不能返回仿佛已成功的 writer 事件描述。
- 统一理由 **1024 UTF-8 字节**，统一未知枚举由结构层拒绝的 code；主文、常量、README、测试不得冲突。
- 保留现有 16 KiB 总闸门，去掉“约9.6 KiB就是总上界”的错误论证。用真实 JSON 转义、缩进、最长 ID/安全数值构造边界；若声明全域上界，给保守计算，否则只称已测样例，不能把一个样例称最大合法事件。
- 将第十轮前后 hash 14 个非法格式及控制字符/长 ID/大数字样例纳入永久测试。保持既有字符与 UTF-8 字节独立限制，不为凑预算放宽限制。
- 对 `Value.Errors` 的 eager 返回与 200 条后处理预算表述准确：只保证诊断输出及后处理上限，不能宣称整体未知对象验证耗时恒定。未来 IO 先限读取字节，本轮不引新框架。

## 5. C2AR-4：门禁与完成判据

在 Package 运行：

```powershell
node --test tests/auditContracts.test.mjs
# 若新建关联测试文件，再运行对应文件；下述 npm test 必须包括它
npm run typecheck
npm test
npm run selfcheck
npm run check:format
```

在仓库根运行：

```powershell
npm run typecheck
npm run check:format
node --test tests/processGuards.test.mjs
git diff --check
```

235 项现有基线不能削弱；永久新用例数量按实际统计，不凑固定数。两个既有文件 symlink 权限 skip 明确保留；不把独立临时诊断计入永久数量。

完成判据：A1～A3 各有协议条款和适用的纯函数行为测试；结果/预算文案一致；未来 journal v2 的标识、绑定与 v1 兼容写清但**实际 v1 storage 完全不变**；无审核 IO；全门禁通过。更新实施记录、Package README、导航/task/test/log/MVP/桌面边界状态，完成交回验收，不自动进入 C2B。后续 C2B 才实现该审核专用协议与真实 IO checkpoint/跨进程验证。

## 6. 简短提示词

```text
在 D:\BIOS_Pi_Agent\PiDeck_BIOS 的 BIOS_Agent 分支，读 AGENTS.md、
docs/bios-agent/round10_acceptance.md 和 bm02c2a_remediation_plan.md。
只做 C2AR-1～4：关闭 A1～A3，修审核提交/恢复协议、纯意图关联与幂等比较，
补永久测试和结果/预算文案。保持现有 journal v1/storage 不变；未来审核 v2
本轮只写协议，不落 IO。不做 C2B/迁移/UI，不改 PiRuntime，不碰客户资料，
保留全部已有改动、不 add/commit/push。跑全部指定门禁，完成交回验收。
```
