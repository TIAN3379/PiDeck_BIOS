# BM-02C2BR2：只补 conflict 绑定与失败清理两处遗漏

日期：2026-10-02。状态：**第十五轮独立验收通过声明范围，I1 关闭，F1/F2 与审核持久化整改收口**（348 用例/346 通过/0 失败/2 权限 skip，六文件 165 项全绿）。
证据见 [第十五轮验收](round15_acceptance.md)，红绿记录见 [C2B 实施记录 §12](bm02c2b_implementation.md)。本文 §1～§6 转为完成标准留档，两个旧提示词均不要重跑；唯一下一轮任务为 [C3 只读预检](bm02c3_development_plan.md)。
前置：[第十三轮独立验收](round13_acceptance.md)。

本轮只有 F1、F2 两项，分别是原 C2BR 的 R2、R4 未覆盖分支。R1、R3 和真实 recovery 二次中断已通过，保留其实现与回归，不重新实现整套审核协议。

## 1. 范围

修改 `packages/bios-agent/core/storage/review/`、必要的同域小 helper、永久测试与状态文档。保留现有脏工作树、未跟踪文件和 326 项基线；两个既有权限 skip 不增加。普通写 v1/C1、五类 schemaVersion、共同目标锁、人工确认遗留锁、审核工件 16 KiB 硬限额保持。

不做迁移/备份、CLI/UI、RAG、平台适配、模型写工具、后台恢复或身份认证；不改 PiRuntime/Electron、不碰客户资料、不删除历史、不 add/commit/push。不要启动第三个功能模块。

## 2. F1：完整绑定在任何 prepared 收口之前

先写能失败的永久回归，再改分支顺序：

- 持锁复读、锁定目标一致性与完整目标读取保持；在写 committed、aborted **或 conflict** 之前，验证意图真实字节指纹、operationId/eventId/target/before/after 与完整 v2 的关联。
- 复用已有 `loadBoundIntent`/`compareAuditAssociation`，不要再手写子集校验；不要改绑定让现场对上。
- 目标合法但已更新至更高 revision，同时意图缺失、坏 JSON、未来版本、hash 不符或 target/before/after 不符：明确拒绝收口，`changed=false`，journal 原字节保持 prepared，业务/意图/已有事件均不改，不发布新事件。具体 inconsistent/unreadable 分类与现有 API 口径一致并文档化。
- 正例：合法完整绑定 + 目标后续合法更新仍可记 conflict；再次核对幂等，不改业务 revision/hash。不要为通过负例而取消所有 conflict 收口。
- 不扩大为普通写 C1 重构或任意磁盘编辑器认证。已落盘历史终态不自动迁移、回滚或篡改。

永久测试至少覆盖上述缺失/坏/未来/错 hash/三种错绑定与合法正例；复用 fixture 与子用例即可。负例断言返回值、调用前后 journal hash、业务 hash、事件数量，而不只断言“不抛异常”。

## 3. F2：失败路径也保留清理事实

先写红回归，复现第十三轮 F2 的三项，再选择最小修复：

- boundary 附加普通 `CLEANUP_FAILED_NOTE`，提取器却只认审核专用 note，二者必须在**审核工件调用上下文**里接通。可用可靠的结构化标记或窄范围兼容转换；不要求全面重构异常体系。不能以业务 cleanup 推断工件残留，也不能把别的工件诊断归到当前工件。
- writer 与 recovery 的事件发布失败 + 该事件 unlink-temp 失败：返回正确 pending 阶段，并在 `artifactCleanup` 中带 event/受控相对路径，在 warnings 中带有界清理诊断。磁盘 `.tmp` 必须实际存在。
- recovery 终态 rename 失败 + journal unlink-temp 失败：保持 prepared，返回原 audit、observed、pending 与 review-journal 清理诊断；原事件/业务字节不变。
- 意图/prepared 发布失败及提交前 aborted 记账失败也使用同一失败传播规则：原 code/detail/cause 优先，附加清理说明不掩盖首错。检查已有临时文件与公开诊断相对应。
- 检查 `exists` 后读取/认领失败或取消的提前退出：已取得 cleanup 不能丢；允许未发布前结构化 cancelled 穿透，但须保留已经发生的清理诊断。已发布后仍保留已知事实，不假称未提交。
- 无清理失败时保持空数组，不凭目录历史残留捏造本次失败，不自动删除未知文件、不靠 GC。不更改 `replaceJson` 成功 rename 后“不一定存在额外 .tmp”的既有语义。

除了三项主复现，补提交前故障、exists/取消与无清理失败对照；可以共享测试 helper。不要删除或放宽现有 R4 用例，也不要只改字符串令旧测试绿而不查实际磁盘。

## 4. 门禁与交付

在 `packages/bios-agent`：

```powershell
node --test tests/auditContracts.test.mjs tests/auditAssociation.test.mjs tests/storageJournal.test.mjs tests/storageReviewWriter.test.mjs tests/storageReviewReconcile.test.mjs tests/storageReviewContracts.test.mjs
npm run typecheck
npm test
npm run selfcheck
npm run check:format
```

在仓库根：

```powershell
npm run typecheck
npm run check:format
node --test tests/processGuards.test.mjs
git diff --check
```

新拆出的回归文件也须纳入针对性与完整测试。326 项基线/既有真实进程测试不削弱、skip 不增加；报告真实数量与新增数，不预填通过。

在原 `bm02c2b_implementation.md` 追加 §11：F1/F2 红绿记录、修正后的分支顺序与错误/清理传播、实跑命令、未测边界；修正 §10 的过度陈述或注明历史快照。不要另建多份实施总结。同步 README 导航/task/test/log/MVP/Package README，当前状态应为“C2BR2 实施完成，待独立复验”，不能自行写成独立验收通过。

本轮复验通过后再按 MVP 依赖排存储迁移/备份与最小管理 CLI，之后推进项目记忆、检索/交接，再到桌面 UI；这些不是本轮授权的实现任务。

## 5. 简短交接提示词

```text
在 D:\BIOS_Pi_Agent\PiDeck_BIOS 的 BIOS_Agent 分支，先读 AGENTS.md、
docs/bios-agent/round13_acceptance.md 与 bm02c2br2_development_plan.md。
只完成 F1/F2：prepared 的 conflict 收口前验证完整意图绑定；审核工件失败路径
正确传播底层清理事实，保留首错、pending、audit 与真实 .tmp 诊断。
先红后绿，保留 326 项基线、已通过 R1/R3 和真实 recovery 二次中断回归。
不做迁移/CLI/UI/模型工具，不改 PiRuntime、不读客户资料、不 add/commit/push。
运行指定门禁，在原实施记录追加 §11 并同步状态，完成后交回独立验收。
```

<a id="6-当前唯一接续任务i1"></a>

## 6. I1 接续标准（已由第十五轮关闭）

依据：[第十四轮验收 §3](round14_acceptance.md)。F1、R1/R3、真实恢复二次中断与 F2 原三项主复现均不重做。
**实施结果**：I1 已按本节 §6.1～§6.5 完成（红回归 + 最小修复 + 三个对照 + 门禁 + 实施记录 §12），
实施方实跑 **348 用例/346 通过/0 失败/2 权限 skip（审核持久化 95 项）**；第十五轮验收方已独立复跑并关闭 I1。
本节以下内容保留为要求原文，提示词不再执行。

目标：补齐 `core/storage/review/artifacts.ts` 的 `publishReviewIntentArtifact` 在 `published.status=exists` 后复读被取消的清理传播。此次新增临时文件已清理失败时，不能只抛无诊断的 cancelled。

1. 先在现有 `storageReviewWriter.test.mjs` 的意图工件组补红回归：同 operationId 的合法同字节意图已存在，真实撞名，intent unlink-temp 注入失败，再在已有意图复读的 IO 等待点触发 AbortSignal 取消。断言 `StorageError/code=cancelled`、有 intent/受控路径的有界清理说明、本次新增一个 `.tmp`，原意图/journal/业务 hash 不变，不发布新事件。
2. 最小修复该 catch 的提前 throw，复用现有清理 helper，不另起异常体系；只在 **本次 `published.cleanup=failed`** 时附加 intent 诊断，保留取消码、detail/cause/其它首错元数据。不要把别的错误或历史残留归到本次工件。
3. 加对照：cleanup=ok + 取消不误报/不新增 `.tmp`；cleanup=failed + 不取消仍返回 exists-identical；原意图字节不同/坏文件仍按既有 audit-conflict 保留且不覆盖。保留既有事件 exists/取消及正常幂等回归。
4. 跑 §4 全部门禁，343 项基线不削弱、两个既有 skip 不增加。无需再开发迁移、CLI/UI、模型写工具，不改 PiRuntime、不接触客户资料、不 add/commit/push。
5. 在原 `bm02c2b_implementation.md` 追加 **§12（I1）**，写红绿、三个对照、首错/清理传播与实跑结果；同步本文件、导航/task/test/log/MVP/Package README。状态先写“实施完成，待独立复验”，不要自行宣布独立通过，不再生成重复方案/实施总结。

I1 修复并复验通过后，再按依赖进入存储迁移/备份和最小管理 CLI。它们不是本次接续任务。

简短提示词：

```text
在 D:\BIOS_Pi_Agent\PiDeck_BIOS 的 BIOS_Agent 分支，读 AGENTS.md、
docs/bios-agent/round14_acceptance.md 和 bm02c2br2_development_plan.md §6。
只修 I1：publishReviewIntentArtifact 的 exists 后复读取消分支，保留已发生的
intent 临时文件清理诊断与原 cancelled 元数据；先红后绿，补三个对照与文件 hash 断言。
保留 343 项基线和已关闭 F1/R1/R3，不重做审核协议，不做迁移/CLI/UI，
不改 PiRuntime、不读客户资料、不 add/commit/push。跑原门禁，追加实施记录 §12，交回复验。
```
