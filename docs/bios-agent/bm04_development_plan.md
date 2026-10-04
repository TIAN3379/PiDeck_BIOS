# BM-04 原批次标准留档：R28 收尾＋经验与 Feature 业务闭环

本批已实施并完成 [第二十九轮独立验收](round29_acceptance.md)：正常业务可运行，四组有限问题仍阻塞整批通过。当前执行 [R29 收尾＋BM-05 完整任务/人工交接批次](bm05_development_plan.md)；下文标准与旧提示词留作验收依据，不重新开发已交付的知识模块。

日期：2026-10-04。基线：[第二十八轮验收](round28_acceptance.md)：Package 711 项，707 通过、0 失败、4 skip；BM-03 正常项目闭环通过，但四组异常路径尚未收口。

## 1. 一次交回什么

这批交付“把已做过的客户需求和开发经验录入、人工审核，在另一个项目中按关键词找回，明确能参考什么、不能直接照搬什么”。不只修几项异常，也不重建存储引擎。

按 A→B→C 在同一开发对话连续推进，内部节点通过即继续，整批一次性交回：

- A：关闭 R28-1～4，补永久回归，memory/project/CLI targeted＋类型＋格式通过。
- B：交付 v1 Feature 与经验领域服务、审核入口、关键词/别名检索、详情及 M1 参考决策。
- C：薄人工 CLI、真实临时库/新进程/跨项目演示、整批回归与实施文档。

若上下文不足，在 `bm04_implementation.md` 写真实断点、失败用例、已发布状态与下一条命令，不能把计划写成完成。不要在 A 刚通过时结束这一业务批次。

## 2. 节点 A：四组有限修复

具体输入与错误输出见 [验收 §4](round28_acceptance.md#4-四组有限收尾)。先加失败回归，再做最小修复。

### A1：R28-1，保留领域写入的完整发布事实

- bind 的 registry 已发布后，profile 读取、验证、写入和取消失败全部保留 projectId/workspaceId/revision、steps、续办信息。重新执行先读现状，不重复建项目，不回滚已发布 registry。
- bind/confirm/refresh 透传并汇总底层 warnings、journal、cleanup、lock release 与需人工核对状态；真实已提交但 journal 记账失败不能报干净成功，CLI 退出码同步。
- 永久回归：registry 发布后 profile 读取 EACCES；journal 终态 rename EBUSY；正常、重复执行、未发布失败及新进程读回对照。只包装现有结果，不另建事务/恢复框架。

### A2：R28-2，字段级证据与实际有界 IO

- 建立事实键/字段→来源证据→对应检查的明确映射；一个字段的 valid/changed 不转移给另一个字段。检测候选与人工确认各自携带自己的证据。
- 未复验、超单文件/总量/检查条目额度、选样省略、检测失败或截断均汇总 incomplete 及有界原因；不把未经检查的字段升为 current，也不把检查失败悄悄算通过。
- 文件大小预检之后仍用实际有界读取；文件增长也不越额读取。取消在异步边界传播、finally 关闭句柄；全部来源类型、诊断和输出有上限。
- 永久回归覆盖两个字段不同来源、部分复验、超大文件、20 条 note、14 个 DSC、stat 后增长、await 后取消、detect/view 部分状态。
- 文件型 symlink 仅对已知本机权限错误显式 skip，其它失败必须失败。确认并发改为两个真实 Node 子进程竞争同一 revision，一成一败且无覆盖；修正实施记录的覆盖声称。

### A3：R28-3，M1 全分支关系与授权一致性

- 授权集合先于关系参与，隐藏来源及其断言不能改变可见事实。
- 不能沿 `.find` 第一条边判整个图；所有相关分支的环、矛盾、来源有效性与链长截断都要有界且输入排列无关。避免无界递归和指数重复遍历。
- 撤回/冲突/不可读来源不足以支持当前替代。无法证明时 needs-review/incomplete，不用 v1 不具备的时间线推导自动复活旧值。
- 新增分叉环正反/多种排列、撤回声明方、隐藏来源、有效简单链、链长触顶对照。保留 R27-1/3 已通过范围，不升级磁盘格式。

### A4：R28-4，公共入口授权与 CLI 契约

- open/detect/read/refresh 的公开工作区访问路径统一执行 cwd/授权根限制；访问档案保存的路径时同样校验，不能仅靠 bind。公开服务与可信内部 helper 的边界写清并测试。
- 每命令允许的参数、重复与冲突规则明确；未知参数、拼写错误、安全整数溢出在读取正文/写入前拒绝。统一 JSON 单对象与 code/exitCode，missing 不误报成功。
- 明确 `maxOutputBytes` 是 M1 条目还是完整视图预算；检测、档案、诊断与 JSON 外壳独立有界。极小额度采用约定的最小错误/空结果例外，不能声称 1 字节容纳合法对象。
- 实际 CLI 子进程回归：越权 detect/refresh/open；错拼复验；写命令未知/重复参数不写；missing；极小额度与正常对照。

A 全部内部过闸后继续 B，不等另一轮独立验收。

## 3. 节点 B：完整 BM-04 领域服务

### B1：Feature 录入、更新与详情

- 复用 `FeatureRecord` v1：`originalRequirement`、`aliases`、customer/productLine 的字段确认与 evidence、`acceptanceCriteria`、`relatedExperienceIds`。人工显式创建/读取/按 revision 更新，不自动判客户身份。
- 需求正文和别名保持原始人工含义，规范化检索键不能改写原文；长度、数组数量、总输入字节与 JSON 形态先行守卫。字段不能借任意文本自动成为 confirmed。
- `relatedExperienceIds` 只指经验卡，不代表 Feature 的替代沿革。读取关联按记录族、ID、revision 和授权核对；缺失/不可读显式显示，不补造来源。
- v1 Feature 没有可靠的项目归属/独立审核状态，不能猜一个 sourceProjectId，也不能把客户未知当成公开。服务接收显式授权的 Feature 选择/可见范围，结合已确认的客户/产品线筛选；未确认身份不进入“可直接复用”结论。
- 创建关联若涉及两个记录，使用现有两个 CAS 步骤并报各自发布结果，或先单向显式关联；不承诺双文件原子事务。

### B2：经验草稿、人工审核与废弃

- 复用 `ExperienceCard` v1：问题/症状/根因/解决办法、适用与不适用条件、sourceProjectId、可选 featureId、evidence、validations、reuseScope。sourceProjectId 与工作区必须存在且显式授权，未知平台不由模型补全。
- 普通入口只创建/编辑 draft 与非托管正文，采用 expectedRevision。reviewer/status 等审核字段不能通过普通 updateRecord 或通用 JSON 绕过审核。
- 审核唯一使用现有 `recordReviewDecision` 和既有 audit/journal：`submit-review` draft→reviewed，`request-changes` reviewed→draft，`approve` reviewed→verified，`deprecate` reviewed/verified→deprecated，`restore` deprecated→draft。不新增状态机或篡改旧协议。
- 人工 operatorLabel 是标签，不是企业认证。审核前展示实际卡片 revision、证据、验证级别和适用限制，调用方显式确认；无自动批准、无模型自填“工程师已验证”。
- reviewed/verified 是审核状态，不能把 compile 的 validation 说成板卡启动/压力验证。只有真实声明的 validation 与证据能支撑相应级别；允许“没有目标板验证”的经验作为受限参考。
- 草稿重写、审核、废弃/恢复皆沿合法状态和 CAS；返回真实审计/发布/待核对结果，不能把失败隐藏成已生效。

### B3：有界关键词/别名检索与详情复验

- 首版关键词/别名＋显式项目/客户/记录族/状态过滤，先授权后形成标题、正文片段、数量与排序；不扫描未配置的知识根或源码目录。
- 输入（查询长度/词数/筛选数）、目录扫描、记录数量/实际读取字节、关联深度、摘要和输出全部有界，可取消。预算耗尽返回部分结果与 incomplete，不能借“只返回十条”掩盖无限扫描。
- v1 JSON 没有分离元数据索引，可先实现有界扫描，不强制再建数据库。缓存/派生索引若使用，不能成为真相源；详情及推荐前重读当前 revision/审核状态/可见范围。源已变、卡已废弃或不可读时不得仍推荐旧命中。
- 所选记录调用 M1 并保留 family/recordId/revision、sourceProject、证据与不确定原因。端点策略显式 allow/deny/unknown；业务服务不能像人工 CLI 演示一样硬编码 modelEndpointAllowed=true。CLI 人工允许仅适用于该本地人工入口。
- 经验卡 v1 没有直接的客户/平台字段。投影若读取源项目档案，必须先授权、只使用明确确认的字段，并标出本次读取的档案 revision；客户范围无法证明时降级。源项目“现在的身份”不能伪装成经验验证时的历史身份，临时计算的 hash 不能冒充过去持久化的指纹。
- current 与 history 分开：deprecated 不进入当前推荐；显式授权历史查询可以显示废弃记录及原因，但不能升为 current。更新时间排序不代替生效时间；v1 无法证明的语义时间/关系只给 reference/needs-review。
- 跨项目/跨 IBV/芯片命中用于“移植参考”，不是补丁可直接应用的判定。customer/platform/workspace 未知或范围不匹配要可见；审核通过不等于目标项目已经验证。

建议按职责放在 `core/features/`、`core/experiences/`、`core/search/`，具体拆分可调整。复用已有 contracts/storage/memory/projects，不引入 Electron/主进程依赖；单模块规模遵守 AGENTS.md，不扩建通用知识服务框架。

## 4. 节点 C：人工入口与跨项目真实闭环

CLI 保持薄层，提供 Feature 创建/更新/详情、经验草稿/编辑/详情、人工审核、关键词检索和历史查询；命令布局可选一个业务 CLI 或两个聚焦 CLI，实际能力必须齐全。写命令要求显式写确认和 revision，JSON 与退出码一致，取消传播，拒绝未知参数。此批不是 LLM 可调用的知识写工具。

交付 `cli/experience-scenario.mjs`（名称可调整），只用合成库、临时 Git 仓库与真实子进程：

1. 显式绑定项目 A/B；由人工确认的合成 profile 表达 A=Insyde/Intel、B=AMI/AMD，不能冒称检测器自动识别这些平台。
2. 录入客户 PXE Feature、别名/原始验收条件，以及 A 的经验草稿；关联指向真实记录。
3. 新进程读回；draft 不作为当前可信推荐；经人工 submit-review/必要 approve 保存审计后再次检索。
4. 在 B 按别名找回 A 的经验：展示原需求、根因/方案、适用与不适用条件、源项目/commit、声明的验证级别，并明确跨平台需要移植评审，B 尚未验证。
5. 同客户授权参考可见；未授权客户/项目/Feature 的标题、计数、片段及关系影响不可见。端点 deny/unknown 有明确降级。
6. 废弃卡片后，新进程当前检索不再推荐；显式授权 history 能解释其废弃。source 变化、revision 冲突、关联缺失/不可读和旧缓存均不能恢复旧推荐。
7. 验证预算不足/取消/发布后警告，原有项目确认与其它工作区数据不被经验操作改写。

演示输出中的“源板卡验证”仅来自合成记录，不算实际硬件验收。不执行目标源码移植、构建或板卡刷写。

## 5. 永久测试、门禁与交付文档

- A 四组逐一旧红新绿及正常对照，真实两个确认子进程；不得删旧测试、把未运行链接分支算通过。
- Feature/经验：创建、draft 更新、CAS 冲突无覆盖、非法托管字段不写、真实审核审计往返、合法/非法废弃与恢复、部分发布/取消/新进程读回。
- 检索：授权先于标题/计数/排序/关系、客户与未知身份、别名匹配、draft/废弃/history、端点策略、源变化/缓存失效、关联族/ID/版本、数量与实际字节、取消与部分结果。
- 实际人工 CLI 子进程及合成跨项目端到端测试；不要只测 mapper 或打印预设结果。
- 日常按改动跑 targeted、类型、格式；最后 Package 全量 `npm test`（本次基线 711 项，增量按真实结果报告）、相关 storage/review/backup/knowledge CLI 旧回归、selfcheck、根类型/格式/processGuards、`git diff --check`。不要把增长用例数当业务完成标准。
- 写 `bm04_implementation.md`：实际 API/CLI、A 的永久关闭证据、业务演示、授权与预算口径、运行数字、skip 的准确分支、未测与断点；同步 README/task/test/log，并在 BM-03/M1 实施记录追加本次修复事实，不覆盖历史验收证据。

## 6. 范围与后续路线

不升 schema、不写迁移器、不重做已验收存储/journal/审核/备份、不接真实客户库；不做 UI、模型知识写工具、Session 注入、RAG/向量库、后台扫描/AutoDream、自动学习或自动批准；不改 Pi 内核/Electron；不自动 add/commit/push，保留脏树及既有删除。

v1 的字段历史、Feature 正式替代沿革、精细生效/失效时间、耐久来源指纹仍需 M2 独立格式方案；本批用明确的受限参考/待复验输出，不能假装已实现这些能力，也不把全部存储升级设为 BM-04 前置。

路线保持：本批经验/Feature（BM-04）→任务事实与经验沉淀入口（BM-05）→Pi 专业工具与上下文接入（BM-06）→桌面知识 UI（BM-07）。当前加速方式是合并为完整业务交付，而不是取消验证。

## 7. 新对话简短交接提示词

> 在 `D:\BIOS_Pi_Agent\PiDeck_BIOS` 的 `BIOS_Agent` 分支继续开发。先读 AGENTS.md、docs/bios-agent/README.md、round28_acceptance.md、bm04_development_plan.md 及现有 contracts/storage/memory/projects。
> 按 A→B→C 完成同一整批：先修 R28-1～4（发布事实、字段证据/真实 IO 预算、全分支关系、授权与 CLI），内部 targeted/类型/格式过闸后直接完成 BM-04 Feature/经验录入、人工审核、关键词/别名检索和跨项目 PXE 参考闭环，不在几个修复后结束。
> 复用 v1 与 recordReviewDecision；无 UI/向量库/自动批准/迁移/模型知识写工具，不重做历史底座。跨平台经验只作有证据的移植参考，不能冒称目标板验证。
> 补永久回归与真实 CLI/双进程/新进程场景，整批门禁后写 bm04_implementation.md 并同步状态文档。保留脏树及既有删除，不自动提交推送；上下文不足准确留断点。
