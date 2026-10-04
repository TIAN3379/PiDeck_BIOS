# 第二十九轮验收：BM-04 主流程已交付，有限收尾后进入 BM-05

日期：2026-10-04。工作区 `D:\BIOS_Pi_Agent\PiDeck_BIOS`，分支 `BIOS_Agent`，Windows / Node 24.14.1。
依据：[BM-04 原批次标准](bm04_development_plan.md)、[实施记录](bm04_implementation.md)、实际源码与本次独立运行。

## 1. 结论

BM-04 已交付真实的 Feature/经验创建、更新、详情、人工审核、关键词检索、跨项目参考与人工 CLI。正常录入→审核→参考→废弃→历史查询的合成流程可以运行，功能进度推进到经验业务层。

**整批尚未通过**。现有测试全绿，但额外诊断发现 §4 的四组有限问题。尤其“详情必须授权”“按 Feature 别名找回关联经验”和“取消/发布后警告的非成功状态”还没有完整实现。

- R28-1 的项目半发布与 journal 警告、R28-2 的字段证据/有界读取、R28-4 的工作区授权/项目 CLI 核心整改和永久回归通过本次复跑。真实双确认子进程测试已执行；项目文件型 symlink 权限失败已改成显式 skip。
- R28-3 的原分叉环排列、撤回声明方与简单隐藏来源场景已有回归通过；**完整关闭仍不成立**，不适用范围及隐藏来源的未知范围还会影响关系图，归 R29-4。
- R27-1/3、R26-1～3、D3/D4 及更早通过范围保持，不重做历史底座。
- M2 仍只认可 v1 路线；没有正式字段历史、需求替代沿革、耐久来源指纹或迁移。不因新增业务服务宣称分层记忆全部完成。

下一批执行 [R29 收尾＋BM-05 完整任务/上下文批次](bm05_development_plan.md)：先内部修复四组，再直接交任务事实、人工交接包、Manifest 重验与经验草稿沉淀，一次交回。

## 2. 独立门禁

| 核对项 | 结果 |
|---|---|
| Package `npm test` | 732 项：727 通过、0 失败、5 skip；约 93.5 秒 |
| backup＋knowledge CLI＋memory＋project＋业务 targeted | 309 项：307 通过、0 失败、2 skip |
| 旧存储六文件 | 249 项：246 通过、0 失败、3 skip |
| Package 类型 / 格式 / selfcheck | 通过；格式 132 文件，selfcheck 6 项 |
| 根项目类型 / 格式 / processGuards | 通过；格式 2014 文件，processGuards 2 项 |
| `git diff --check` | 通过 |
| experience/project/memory 三套演示 | 命令完成；业务与项目 status=ok、failures=[]；memory current 2/reference 1/needs-review 3/excluded 3 |

Package targeted：

```powershell
node --test tests/storageBackup*.test.mjs tests/knowledgeCli.test.mjs tests/memory*.test.mjs tests/project*.test.mjs tests/knowledge*.test.mjs tests/experience*.test.mjs
node --test tests/storageRecords.test.mjs tests/storageRegistry.test.mjs tests/storagePreflight.test.mjs tests/storageJournal.test.mjs tests/storageReviewWriter.test.mjs tests/storageWrite.test.mjs
npm run typecheck
npm run check:format
npm run selfcheck
node cli/experience-scenario.mjs
node cli/project-scenario.mjs
node cli/memory-scenario.mjs
```

732 = 上轮 711 + 21。5 个 skip 是既有 4 个文件型 symlink 权限分支与纠正后的项目文件链接分支，不计为通过。memory 为 29 项（decisions 26＋PXE 3），不要把 decisions 的 26 当成 memory 总数。

本次额外诊断使用自建临时知识库、合成内容与真实 CLI 子进程，临时目录归属验证后清理；不读取真实客户资料。额外诊断未转永久回归，不计入 732 项。

## 3. 已交付能力及证据边界

`core/knowledge/` 五个模块与 `cli/business.mjs` 已有实际实现，不是占位 API。审核走现有 `recordReviewDecision`，不通过普通编辑绕过审核。v1 reviewed/verified 经验只作 reference，deprecated 退出当前推荐；不把 compile 声称为目标板验证。

项目端原闭环仍能新进程读回、提示 HEAD/证据变化、保留人工确认、区分双工作区。BM-04 演示也是逐步真实 CLI 子进程，但其关键词 PXE 同时出现在需求与经验正文中，**不能单凭它证明 Feature 专有别名会联动关联经验**。

没有实际跨 IBV 代码分析、源码移植、构建或刷板。A=Insyde/Intel、B=AMI/AMD 是合成档案的人工确认，验证级别也是合成声明，不是厂商适配或硬件验收。

## 4. 四组有限收尾

### R29-1（P1）：知识公共入口授权与来源存在性不一致

位置：`core/knowledge/features.ts` 的 detail/list、`experiences.ts` 的 detail/create；`cli/business.mjs` 的 experience-show；`search.ts` 的扫描诊断。

- 实际 `experience-show --root … --experience-id exp-network --json`，不提供任何来源项目授权，退出 0，返回完整 problem/sourceProjectId/card。命令白名单甚至不允许传 `--authorized-project`，与帮助中的读取授权纪律冲突。
- `readFeatureDetail({root, featureId})` 省略 visibility 时返回原需求、关联卡 reviewed 状态，且 `usableAsReference=true`；`listFeatureIds({root})` 同样枚举全部 ID。默认缺少范围不是显式授权。
- 使用不存在于 registry/profile 的合法 UUID 作 sourceProjectId 创建经验，仍成功持久化并可读。只校验 ID 字符/记录 schema，没有核对来源项目存在与授权。
- 空授权集合检索返回 hits=[]，但 scanned 暴露 experiences=2/features=1/recordsRead=3；未授权 Feature 损坏时，problems 暴露其完整绝对路径与 ID。

要求：区分可信内部存储 helper 与可供 CLI/后续 Pi 接入的公开知识服务；公开入口缺省拒绝内容，授权覆盖详情、关联、计数与诊断。来源项目须存在且显式授权，工作区引用须归属正确；拒绝写入不留卡片。授权是本地调用方声明，不是企业身份认证。

### R29-2（P1 业务闭环；字段更新 P2）：别名、编辑和引用详情未闭环

位置：`search.ts` 的独立记录匹配/ReferenceView；`experiences.ts` 的 changedFields；`features.ts` 的更新比较。

- Feature 的唯一别名为 `RapidBootOnlyAlias`，关联一张已 reviewed 的经验，经验正文不含该词；授权均有效。检索只返回 Feature，关联经验没有出现。当前搜索分别匹配两族文本，没有有界的关联扩展。
- 仅更新经验 `symptom: New symptom`，返回 unchanged，revision 保持 0，磁盘仍为 Old symptom。next.symptom 被赋值但没有进入 changedFields，因此直接提前返回。
- 参考详情没有返回原始 Feature 需求/验收条件、完整 EvidenceRef 或来源 commit；创建经验没有顶层 evidence 输入，直接写 evidence=[]。不能以“源项目 ID＋根因/方案”代替完整来源证据闭环。
- 源码补充：Feature 同值同确认程度时，新 evidence 不触发变更；正文校验还会 trim/改 CRLF，和“原文原样保存”表述不一致。须明确正文保存与检索规范化口径，并补行为测试，不靠注释保证。

要求：别名命中经授权、真实关联和当前审核/版本重读后找回经验；缺失/不可读/越权关联不能补造结果。单字段更新必须正确保存，来源/验证/适用限制作为受限参考完整展示；v1 无法保存的历史身份不要推断。跨平台始终需移植评审，不升级目标板验证。

### R29-3（P1）：检索与业务 CLI 的错误/额度/提交状态不可信

位置：`searchKnowledge` 的 listing、catch、空候选返回；业务 CLI 的写命令退出码映射。

| 独立诊断 | 实际结果 | 应有结果 |
|---|---|---|
| 唯一经验卡第二次 open（列举后正式读取）触发 abort | signal 已 aborted；返回 status=ok、unreadable=1、problems 含 cancelled | 取消穿透，不能吞成单条不可读或成功 |
| 唯一 Feature 坏 JSON，未产生候选 | status=ok，problems 含 invalid-json | 无命中不等于完整；读取/列举问题也汇总 incomplete |
| 3 张卡，maxScanRecords=1 | reported recordsRead=1，实际记录 open 4 次 | 预算包含 listing 的完整正文读取；实际读取次数/字节如实记账 |
| 真实业务 CLI feature-create，journal 终态 rename 注入 EBUSY | status=created、code=ok、exitCode=0，同时 needsReview 非空、revision=0 | 保留已提交事实，但退出 8/需核对；不得干净成功 |

列举和读取均复用现有存储能力，没有无界文件读取的证据；问题是业务预算未覆盖前置列举的实际工作量。调整有限业务扫描，不要求重写通用存储或新建索引数据库。

源码还显示：`search --status` 仅在同时给 `--family` 时传到领域过滤；未知状态没有完整枚举校验。下一批补实际 CLI 对照，避免选项被静默忽略。读详情的 signal 也要真正传下去。

### R29-4（P1，R28-3 剩余项）：关系范围/授权过滤晚于图构建

位置：`core/memory/policy.ts` 的 evaluateRelationStates 建图、依赖排序及 unknownScope 判定。

- a/b 的两条相互替代边都明确只作用于 BOARD-OTHER，当前目标是 BOARD-TARGET；仍把 a/b 都变成 needs-review/relation-ambiguous，整体 ok。拓扑判环先纳入全部边，再检查 scope，已无法排除该假环。
- 未授权 hidden 来源的边声明一个目标尚未知的 boardName：hidden 被隐藏，但可见 a 从 current 降为 needs-review/unresolved-relation、整体 incomplete。unknownScope 在 unauthorized 判断之前生效。

要求：授权与明确不适用范围在建图、节点额度、拓扑依赖前过滤；未知范围只对有权且相关的断言保留不确定。补跨板卡假环、隐藏来源未知范围与低节点预算对照，保持原分叉环/撤回来源/排列确定性回归。不用“排序更稳定”代替语义过滤。

## 5. 下一轮安排与未测

按 [BM-05 方案](bm05_development_plan.md) 连续完成：A 收尾 R29；B 任务创建/状态/CAS/显式经验草稿沉淀；C 有界交接包、Manifest 重验、人工 CLI、新进程与任务重开闭环，整批一次验收。

BM-06 再接 Pi 专业工具/生命周期与上下文，BM-07 再接桌面 UI。此批不提前接模型知识写工具、向量库、AutoDream 或格式迁移。

本次未跑根项目全量测试/构建/安装包、其它 OS、远端 CI、网络盘/断电/真实 ACL、真实客户库或硬件。本次只改验收与规划文档，保留 dirty tree、未跟踪文件及六项既有删除，未 add/commit/push。
