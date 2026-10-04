# BM-02C2BR：审核持久化有限收尾

日期：2026-10-02。状态：**经 C2BR2 收尾，第十五轮独立复验关闭 I1，R1～R4/F1/F2 已收口**。
唯一下一轮任务为 [C3 只读预检](bm02c3_development_plan.md)，证据见 [第十五轮验收](round15_acceptance.md)；[实施记录](bm02c2b_implementation.md) 保留快照，不重跑本文整轮提示词。
前置：[第十二轮验收](round12_acceptance.md)。C2B 主体与现有门禁通过，但整体未通过；只关闭 R1～R4 并补齐本轮缺失的恢复检查点。
实施结果、红绿证据与未测边界见 [C2B 实施记录 §10](bm02c2b_implementation.md)；本节以下内容保留为整改要求原文。

## 1. 范围与顺序

限定 `packages/bios-agent/core/storage/review/`、必要同域契约/小 helper、永久测试与文档。先红后绿，保留全部 295 项基线，两个既有权限 skip 不增加。保持普通写 v1/C1、五类 schemaVersion、共同目标锁、不重放/回滚、不自动抢锁。

不做迁移/备份、CLI/UI、RAG、平台适配、模型审核工具、后台恢复或企业权限；不改 PiRuntime/Electron，不读客户资料，不删除历史，不 add/commit/push。保留现有脏工作树及未跟踪文件。按 R1 → R2 → R3 → R4 实施，不重做旧 C2A/C2AR。

## 2. R1：真实完整校验与审核工件限额

- `validateReviewJournalRecord` 必须真正执行已定义的完整 TypeBox schema，再补关系/状态规则；返回类型来自通过的 schema 校验，不用手工字段子集 + as 冒充完整结构。
- 版本闸门优先；UUID、KnowledgeId（包括 Windows 保留名）、nested additionalProperties、指纹形态/长度/数值、文件名、purpose、状态/时间/source 全覆盖。未知字段诊断脱敏且有界，不把用户字段名/值复制进输出。
- before 要可递增；after 允许恰好 MAX_SAFE_INTEGER，before=MAX_SAFE_INTEGER 不允许再审核；最终目标读取与 schema 不变。
- 审核意图/事件的**实际读取/写入字节**独立硬限 16 KiB；可配置值只能收紧，可选择拒绝扩大或截到硬上限并文档化。不要因此改变普通 v1 的可配置预算。JSON 空白/转义计实际字节，不按解析后大小猜；增长/取消仍沿用 boundary。
- `evidence` 在任何解引用/遍历策略前验证 unknown 的元素形态、数量和字节；null、稀疏/非法数组、未来 kind、非法下标均结构化拒绝，不 TypeError、不取锁写工件、不用强转绕过校验。保留合法 record-evidence/validation 下标回查。
- 永久测试：验收 R1 的六个 v2 变体；schema/运行时一致；16 KiB 精确边界与空白放大；evidence:[null]；bad inputs 原字节不变、无新事件。

## 3. R2：所有收口分支先验证完整绑定与矛盾现场

- 持锁复读后先比锁定目标身份/绑定，再判 journal.state；换目标或需锁定的关联在等待窗口变化时拒绝。不能在旧 A 锁下核对/发布 B。
- before/after 的核对仍来自同一次完整目标读取与 hash。意图 actual hash + operationId/eventId/target/before/after **逐项**与已验证完整 v2 比较；复用 `compareAuditAssociation`，不存在事件用 null，不绕过纯比较。任何不一致不能发布或写成功终态。
- 无事件且 target=after：关联 publish 判断通过后才发布；实际路径由已确认的同一目标派生。不得“先发布再校验”；不得改绑定来让错误现场看起来一致。
- prepared 且 target=before：先精确读取绑定的 event 路径。已有合法/冲突/坏事件或意图不可解释时，按明确的 inconsistent/unreadable 规则保留现场；**第一次**就报警，不写 aborted 然后等下一次才发现。合法一致且事件确实缺失才允许 aborted。无需目录全扫描。
- higher revision/不匹配保持保守 conflict，非法目标保持 unreadable；不因坏意图假装完整决定已经成功。终态核对保留当前业务后续合法更新的历史语义。
- 永久红回归：改意图 target/before/after 且 journal 绑定真实新 hash，每项都拒绝，无新事件/journal终态/业务修改；第一次 before+事件冲突不写终态；持锁等待期间改变目标（含变终态）；缺失/坏/未来意图与事件。
- 更正现有 `storageReviewReconcile.test.mjs` 的“第一次 aborted、第二次 inconsistent”断言：记录旧断言为何错误，替换为首次拒绝。不是删失败测试或放宽预期。

## 4. R3：先认领已有事实，按恢复阶段返回真相

- 恢复先有界读取已有事件并完整比较。存在且决定相同：直接认领原 publication/recordedAt，不构造新候选、不尝试发布、不受本次时钟回拨或新候选序列化预算影响。不存在才生成 recovery 发布事实；坏/冲突事件拒绝，不覆盖。
- 校验恢复时钟的类型/范围；新事件 recordedAt 与 decidedAt 的关系有明确策略（拒绝或有限归一化），与 writer 规则一致。不冒充精确落盘时间。认领本身不需要新 recordedAt。
- 明确恢复事件发布失败/取消/终态失败的结果形状。未发布前取消可穿透；目标已观察为 after 的 IO 失败应带 operationId、observed、audit=null、prepared 与可重试说明，不让一个普通异常暗示业务未提交。参数/根准入错误仍可结构化抛出。
- 事件发布后不能因取消/复读/清理失败丢掉已知事实；终态失败如实返回 audit 和 journal pending，不能把未写 journal 说成已完成。首错 + 有界清理诊断，不覆盖、不重打时间、不改业务 revision。
- 永久测试：已有 writer/recovery 事件在时钟回拨时认领；非法/不同决定事件拒绝；新发布失败/终态失败/取消前后；**真实 recovery 子进程已发布事件、未写终态时终止，确认退出后仅清理其合成锁，新进程认领第一次 recovery 事件并收口**。原事件 hash/时间/来源与业务 revision/hash 均不变。

## 5. R4：传递全部工件清理诊断

- 意图、prepared journal、事件（created/exists）、终态、业务、锁的清理结果分别保留。`cleanup` 若只表示业务就保持该定义，工件失败必须有单独字段/有界 warnings，不能报“没有残留”。
- 正常/pending/提交前抛错/认领冲突均传播已经发生的临时清理失败；保留原错误码。事件 exists 分支不丢底层 cleanup。避免把附加错误上升为“业务未提交”。
- 永久测试逐个注入 `unlink-temp` 失败，检查实际 `.tmp` 与公开诊断对应；加事件 exists、prepared 后失败、事件失败+业务清理失败、锁释放失败组合。不自动删除未知文件/锁，不靠 GC。

## 6. 门禁与文档收口

```powershell
# packages/bios-agent
node --test tests/auditContracts.test.mjs tests/auditAssociation.test.mjs tests/storageJournal.test.mjs tests/storageReviewWriter.test.mjs tests/storageReviewReconcile.test.mjs
# 有拆出的新回归文件时一并跑；完整测试不得遗漏新文件
npm run typecheck
npm test
npm run selfcheck
npm run check:format

# 仓库根
npm run typecheck
npm run check:format
node --test tests/processGuards.test.mjs
git diff --check
```

在原 `bm02c2b_implementation.md` 追加唯一 C2BR 记录：逐项红绿证据、修正后的完整 schema/API/恢复状态与清理表、真实二次中断证据、未测边界。同步导航/task/test/log/MVP/Package README；删除或限定旧“没有审核 IO”句子，不能同时写已实现与未实现。四组任务全部完成后交回复验，不自动开始 D/UI，也不把新增测试全绿直接写成独立验收通过。

## 7. 给开发 AI 的简短提示词

```text
在 D:\BIOS_Pi_Agent\PiDeck_BIOS 的 BIOS_Agent 分支，读 AGENTS.md、
docs/bios-agent/round12_acceptance.md 与 bm02c2b_remediation_plan.md。
C2B 主体已落地但独立验收未通过；只做 C2BR 的 R1～R4：完整 v2/输入/硬限额，
恢复发布前的三方绑定与首次矛盾拒绝，已有事件直接认领与阶段结果，全部工件清理诊断。
先红后绿，补真实 recovery 二次中断回归，保留 295 项基线与普通 v1/C1 行为。
不做迁移/CLI/UI/模型工具，不改 PiRuntime、不碰客户资料、不 add/commit/push。
跑指定门禁、更新原实施记录和状态，完成交回独立验收。
```
