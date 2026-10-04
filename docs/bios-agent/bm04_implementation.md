# BM-04 实施记录：R28 四组收尾＋需求/经验业务闭环

日期：2026-10-04。工作区 `D:\BIOS_Pi_Agent\PiDeck_BIOS`，分支 `BIOS_Agent`（Windows / Node 24.14.1）。
依据：[第二十八轮验收](round28_acceptance.md)、[当前批次方案](bm04_development_plan.md)、[分层记忆与时态设计](layered_memory_temporal_design.md)。
状态：**第二十九轮独立验收完成：正常业务已交付，整批未通过**，R29-1～4 待收尾，R28-3 未完整关闭。最新见 §7 与 [验收](round29_acceptance.md)，§1～6 为实施方快照，不用其完整关闭声称替代独立结论。未升 schema、未迁移、未改 Electron/PiRuntime、未注册模型知识写工具、未读客户资料、未 add/commit/push。

## 1. 节点 A：R28-1～4 旧红新绿

### 1.1 R28-1（P1）领域写入丢失已发布与待核对事实

**旧红**：registry 已发布后档案读取失败 ⇒ 调用方只得到 `io-error/permission-denied`，没有 steps、已发布 ID 或续办信息；journal 终态 rename 失败 ⇒ 仍报 `bound`/`confirmed` 且 `problems` 为空，两份 journal 留在 prepared。

**修后（绿）**：

- 新增 `core/projects/writeNotes.ts`：把存储层的 `cleanup` / `lockRelease` / `journal.state` / `warnings` 折叠成受控事实
  （`warnings` 透传 + `needsReview` 生成），**只搬运不新建事务框架**；收口仍走既有 journal 巡检与 reconcile；
- `bindProjectWorkspace`：
  - registry 发布后**档案读取失败**不再抛错，而是返回 `partial` + 已发布的 projectId/workspaceId/registryRevision + steps（`profile:failed`）+ 可执行续办提示；
  - registry 步骤失败仍是 `failed`（本次没有任何写入），同样带上已聚合的 notes；
  - 出现 `needsReview` 时状态为 **`needs-review`**（既不是 bound 也不是 failed）；
- `confirmProfileFields` / `refreshWorkspaceSnapshot` 的结果新增 `warnings` + `needsReview`：
  "已提交但 journal 终态未写 / 清理或锁释放异常"不会再被报成干净成功；
- CLI：bind 的 `partial`/`needs-review`、confirm/refresh 的 needs-review 都映射到**退出码 8**；
  `confirm`/`refresh` 的 payload 增加 `code`/`exitCode`（脚本只按码分流）。

**永久回归**（`projectWriteFacts.test.mjs`）：registry 发布后档案读取注入 `EACCES` ⇒ `partial` + 保留三样事实 + 磁盘 registry 确实有该项目 + 重试不新建项目；journal 终态 rename 注入 `EBUSY` ⇒ `needs-review` + 原因含"journal 终态未写入 / 需要核对" + 内容确实写入 + prepared 仍在磁盘；confirm/refresh 同样透传。

### 1.2 R28-2（P1）字段证据互串、实际读取与取消

**旧红**：`boardName` 用 a.dsc、`customer` 用 b.dec，只改 b.dec ⇒ 两个字段都 drift；`maxEvidenceFiles=1` 时未复验的字段仍 `current` 且整体 `ok`；单文件超预算报 `not-checked` 但 `uncheckedCount=0`、`truncated=false`；20 条 human-note 全量输出；检测选样受限不可见；stat 之后长大的文件被完整读入；证据 stat 后取消仍返回 valid。

**修后（绿）**：

- `verifyEvidenceRefs` 改为**按调用方的事实键分组**：入参 `entries: [{ key, evidence }]`，结果带回 `key`；
  同一路径只读一次磁盘（缓存的是"观察到的事实"而不是判定结果，所以两个字段用同一文件、期望 hash 不同时各自算出 valid/changed）；
- **两类独立预算**：`maxEvidenceFiles`（按条计费的文件预算）与 `maxEvidenceEntries`
  （检查条目上限，含不可复验的声明；默认按 `maxEvidenceFiles × 4` 派生，可独立覆盖）；
  命中即计入 `uncheckedCount` 与 `uncheckedReasons`（`entry-budget` / `file-budget` / `file-too-large`）；
- **实际字节上限**：新增 `readFileBounded`（逐块读取、每块之后复查取消、超限立刻停止、句柄 `finally` 关闭）；
  检测与复验都不再依赖 `stat` 的大小（检测侧干脆不再 stat）；
- `view.ts`：证据按事实键归属（缺少结果的按"待复核"处理）、未复验的事实列入
  `evidenceUnverifiedFacts`、检测/证据/诊断任一不完整 ⇒ 视图 `incomplete`；
- `detection.ts`：把目录探测的"选样受限"变成可见事实（`hintCounts` 与选中数比较 ⇒ `truncatedBy: files` + 缺口说明）；
- CLI 与测试的显式 skip：项目 symlink 分支只对 `EPERM/EACCES/ENOTSUP` 显式 skip，其它失败照常失败。

**永久回归**：`projectBinding.test.mjs` 新增"实际字节上限（含超大文件）+ 检测按实际字节封顶 + 字段隔离（只改一个字段不拖低另一个）"三组；`projectDetectionView.test.mjs` 断言键归属、条目上限、未复验事实；**真实双进程确认竞争**在 `projectCli.test.mjs` 用两个 `spawn` 子进程提交同一 revision ⇒ 退出码 `[0,4]`、revision 只增 1、失败方不留半截写入。

### 1.3 R28-3（P1）关系图仍受输入顺序与无效来源影响

**旧红**：分叉上的环随输入排列给出不同结果；未授权来源的边仍把可见记录降级；来源已被撤回仍能判出"确定替代"。

**修后（绿）**：`policy.ts` 的 `relationVerdict` 改为 `evaluateRelationStates`（**全图**求解）：

- 建图时按（目标 → 声明方 → 类型）**确定性排序**，结果与输入排列无关；
- 依赖排序用 Kahn 拓扑序（目标依赖声明方）；走不出拓扑序的节点（环及环下游）一律 `ambiguous`
  —— 保留矛盾，不挑一条边；
- 声明方五态：`readable`（继续解析它自己是否被别的关系作废）/ `blocked` / `unreadable` / `unauthorized` / `absent`；
  **`unauthorized` 的整条边被忽略**（隐藏来源不能改变可见事实），`absent`/`unreadable` ⇒ `unresolved`，
  `blocked` 或"声明方自己已被替代/撤回/无法证明" ⇒ `not-effective`（不反向复活旧值）；
- 节点预算（`maxRelationNodes`）与链长预算（`maxRelationChain`）都有界；被节点预算丢掉的目标按
  `unresolved` + `relation-chain-truncated` 处理，不能"看起来没有任何关系"；
- `decide.ts` 用可见集合 / 输入集合区分"给了但未授权"与"根本没给"，并把关系结论接到候选上。

**永久回归**（`memoryDecisions.test.mjs`）：分叉环正反排列输出逐字节相同（a/c `relation-ambiguous`，环外 b 仍 current）；撤回来源（`b supersedes a` + `c retracts b`）⇒ a `relation-not-effective` 且整体 incomplete、**不**改判 superseded/retracted；未授权声明方 ⇒ 目标保持 `current` 且整体 `ok`；节点预算触顶 ⇒ incomplete；链长触顶 ⇒ `relation-chain-truncated`。

### 1.4 R28-4（P1 授权 / P2 CLI 契约）

**旧红**：`openProjectProfile` 收下 cwd/授权根却不执行；detect CLI 用同一配置仍能读出候选；refresh 没把授权传下去；拼错 `--verify-evidnce` 被静默忽略；`confirm --unknown-option` 仍写入；open 未绑定返回 missing 却 exit 0 且没有 code/exitCode；`--max-output-bytes` 的口径含糊。

**修后（绿）**：

- `authorization.ts` 新增 `authorizeWorkspacePath`（根与目标"真实路径优先、词法兜底"，不可达≠未授权）；
- `openProjectProfile` 在解析出绑定后、读档案之前重新判定工作区授权 ⇒ 新状态 **`not-authorized`**
  （保留绑定身份与原因，不返回档案内容）；
- `detectProjectCandidates` / `captureWorkspaceSnapshot` / `verifyEvidenceRefs` / `refreshWorkspaceSnapshot`
  都把 `cwd`（+ 可选授权根）作为**必填**输入并在访问工作区之前判定；`readProjectView` 把授权透传给它们；
- `cli/cliArgs.mjs`：**两个人工 CLI 共用**同一份参数解析（白名单、重复规则、安全整数、超长回显截断）、
  退出码表与受控输出；`cli/project.mjs` 的本地副本已删除并改为 import；
- 命令级参数白名单：未知/拼错/不适用/重复的单值选项在**任何 IO 之前**拒绝（退出 2）；
- `--max-output-bytes` 明确只是 **M1 条目数组**的预算；视图外壳（problems/gaps/evidenceChecks）由
  `maxViewProblems` / `maxViewGaps` / `maxEvidenceEntries` 独立设限，极小额度下条目为空但外壳仍是合法对象；
- missing 用退出码 6 表达，每个成功/失败 payload 都带 `code` 与 `exitCode`。

**永久回归**：`projectWriteFacts.test.mjs` 断言五个入口（open/detect/capture/verify/refresh）在 cwd 收窄时全部拒绝、显式加入授权根后立刻可用、被拒时 registry 不变；`projectCli.test.mjs` 断言白名单/重复/越界整数/写前后不写、missing=6、越权 detect/open=3、`--max-output-bytes` 口径。

## 2. 节点 B：BM-04 需求与经验业务闭环（`core/knowledge/`）

新增 5 个文件、窄出口 `core/knowledge/index.ts`；复用 v1 记录、`core/storage`、`core/memory`、`core/projects`，不依赖 Electron/主进程。

| 文件 | 职责 | 关键纪律 |
|---|---|---|
| `contract.ts` | 受控预算（`KnowledgeServiceLimits` + 解析器）、纯输入判定、派生检索键 | 未知限额报错；正文只进不改；确认程度必须显式声明 |
| `features.ts` | 需求录入/更新/详情/清单 | v1 Feature 没有项目归属：不编造 `sourceProjectId`，可见范围由调用方显式给出；关联只是引用，读取时按记录族/ID/授权核对 |
| `experiences.ts` | 经验草稿 + 人工审核 | `status`/`reviewer` 是托管字段，普通写入带它们直接拒绝；审核转发既有 `recordReviewDecision` |
| `search.ts` | 有界关键词/别名检索 + 跨项目参考详情 | 授权先于标题/片段/计数；端点策略显式；无缓存（每次重读当前记录） |
| `index.ts` | 出口 | 不导出占位实现 |

要点：

- **需求（Feature）**：`originalRequirement`/`aliases`/`acceptanceCriteria` 原样保存（顺序保持）；客户/产品线的确认程度由调用方**显式声明**（`candidate`/`confirmed`），服务不从文本推断；创建/更新走 CAS，同值 `unchanged`，未触达字段保留；详情给出 `links`（逐条核对关联经验，缺失/不可读显式说明）与 `usableAsReference` + 原因（未确认客户/产品线、关联不可核对都不进"可直接复用"）。
- **经验**：`createExperienceDraft` 强制 `status = "draft"`，带 `status`/`reviewer` 一律拒绝；`updateExperienceDraft` 只在 `draft` 状态可改（reviewed/verified 必须先 `request-changes`）；验证记录只按**实际声明**保存（`compile` 不会被说成板卡启动）；`internal-general` 复用必须有显式授权说明；审核转发 `recordReviewDecision`（状态机 + 审计事件 + 审核专用 journal），并把 `applied-audit-pending` / `applied-journal-pending` 如实报成 `needsReview`；非法状态迁移映射成受控 `inconsistent`（不是 `io-error`）。
- **检索**：先按 `visibility.authorizedProjectIds` / `allowedFeatureIds` 过闸，再关键词/别名匹配（全词 AND、字段权重、确定性排序），最后把候选项交给 `decideMemory`；命中只从 **M1 的可见条目**生成（未授权记录没有 ID/标题/片段/计数）；`draft` ⇒ `needs-review`（`not-reviewed`），`reviewed/verified` ⇒ `reference`（v1 无生效区间/依赖快照 ⇒ `legacy-unspecified`），`deprecated` ⇒ `excluded`，`--intent history` ⇒ `history`；端点 `false` ⇒ 不可见，`null` ⇒ 最高 `reference`；扫描条目、实际读取条数、返回条数、片段长度、诊断条数都有上限。
- **跨项目参考**：`readExperienceReference` 展示根因/方案/适用与不适用条件/来源项目/声明的验证级别/复用范围，并给出移植口径（**始终**只作参考；跨项目或缺少板级验证时明确要求重新验证）。
- 一个新判定：`legacy-unspecified`（v1 没有生效区间与依赖快照 ⇒ 只作参考）从"仅经验族"扩展到**经验族 + 需求族**——需求本体同样没有语义时间，不能冒充"当前已验证事实"；档案字段/任务状态不受影响（BM-03 的档案字段仍需保持 `current`）。

## 3. 节点 C：人工入口与跨项目演示

- `cli/business.mjs`：薄业务 CLI（`feature-create/update/show`、`experience-create/update/show`、`review`、`search`、`reference`），
  写命令要求 `--write`，读取经验必须给 `--authorized-project`、读取需求必须给 `--allowed-feature-id`，
  `--endpoint allowed|denied|unknown` 默认 `unknown`（不放行到 current）。
- `cli/experience-scenario.mjs`：跨项目经验参考演示，**每一步都是真实 CLI 子进程**（绑定/确认走 `cli/project.mjs`，
  录入/审核/检索走 `cli/business.mjs`）。七步：绑定并人工确认 A=Insyde/Intel、B=AMI/AMD → 录入 PXE 需求（含别名与验收条件）与 A 的经验草稿 →
  新进程读回并人工审核（写入审计事件）→ 在 B 按别名找回 A 的经验并展示移植口径 → 未授权客户/项目不可见、端点 deny/unknown 降级 →
  废弃后当前检索不再推荐而 history 可解释 → 预算不足如实不完整且经验操作不改动项目确认（用档案文件指纹对照）。

## 4. 整批门禁（实施方实跑）

```powershell
# packages/bios-agent
npm test                       # 732 项：727 通过、0 失败、5 显式 skip
node --test tests/storageBackup*.test.mjs tests/knowledgeCli.test.mjs tests/memory*.test.mjs tests/project*.test.mjs tests/knowledge*.test.mjs tests/experience*.test.mjs
                               # 309 项：307 通过、0 失败、2 skip
node --test tests/storageRecords.test.mjs tests/storageRegistry.test.mjs tests/storagePreflight.test.mjs `
  tests/storageJournal.test.mjs tests/storageReviewWriter.test.mjs tests/storageWrite.test.mjs
                               # 249 项：246 通过、0 失败、3 skip
npm run typecheck              # 通过
npm run selfcheck              # 6 项通过
npm run check:format           # 132 文件通过
node cli/experience-scenario.mjs   # status=ok，failures=[]
node cli/project-scenario.mjs      # status=ok，failures=[]

# 仓库根
npm run typecheck              # 通过
npm run check:format           # 2014 文件通过
node --test tests/processGuards.test.mjs   # 2 项通过
git --no-pager diff --check    # 通过
```

本轮相关用例分布：`knowledgeService.test.mjs` 7、`experienceScenario.test.mjs` 3（BM-04 新增 10）；
`projectWriteFacts.test.mjs` 5（新增）、`projectBinding.test.mjs` 12（+3）、`projectCli.test.mjs` 7（+2）、
`memoryDecisions.test.mjs` 26（+1）。732 = 第二十八轮基线 711 + 21。

5 个 skip：4 个是既有文件型 symlink 权限所限；1 个是本轮**显式改口径**的项目 symlink 分支
（`EPERM` ⇒ 显式 skip，不再"输出 diagnostic 仍算通过"）。演示与合成诊断不计入永久用例数。

## 5. 未测与边界

- **未测**：真实 ACL/网络盘/断电/其它 OS/远端 CI/生产安装包；真实 AMI/Insyde/百敖代码与客户库；迁移、字段历史、语义检索、向量库、UI。
- **检索能力**：首版只有关键词/别名（全词 AND）与显式过滤，**没有**语义理解、同义词表或向量服务；不扫描未配置的知识根或源码目录。
- **授权边界**：`authorization`/`audience` 都是**调用方声明**，不构成企业身份认证；`internal-general` 复用需要显式授权说明；未确认客户不进"可直接复用"结论。
- **v1 限制**：需求没有项目归属与独立审核状态，经验没有项目/平台字段——因此跨平台经验只作"移植参考"，不声称目标板已验证；v1 无生效区间/依赖快照的记录一律 `legacy-unspecified`（只作参考），不补造时态。
- **写入事实**：journal 终态未写只如实上报 `needs-review`，**不**自动修复（收口走既有巡检/reconcile）。
- **未改范围**：schema 未升级、无迁移器、无通用多记录事务；未改 Electron/PiRuntime；未注册模型知识写工具；保留脏树、未跟踪文件与既有删除；未 add/commit/push。

## 6. 断点（如后续接续）

- 下一批按 [当前批次 §6](bm04_development_plan.md) 路线：BM-05 任务事实与经验沉淀入口 → BM-06 Pi 专业工具与上下文接入 → BM-07 桌面知识 UI。
- 已知可改进但本批**未做**（不属当前验收范围）：
  1. 检索是线性有界扫描（`maxScanRecords` 默认 500）；记录规模上来后需要派生索引，但索引只能是缓存、不能成为真相源。
  2. 需求与经验的"客户/产品线"确认值来自人工声明；若要自动带入项目档案，必须先授权并标出所读档案的 revision。
  3. 跨项目参考只给出移植口径文本，没有真正的工作区/平台比对（v1 没有平台字段），需要 BM-05/M2 之后再看。

## 7. 第二十九轮独立验收回写

- 独立 Package 732 项（727 通过、0 失败、5 skip）、targeted 309 项（307 通过、2 skip）、旧存储 249 项（246 通过、3 skip）及指定门禁通过；业务/项目/memory 三套演示可运行。
- R28 核心项目整改及真实双确认子进程回归通过。R28-3 原核心场景通过，但不适用板卡范围形成假环、隐藏来源未知 scope 仍改变可见目标，未完整关闭；详见 R29-4。
- BM-04 正常领域/人工 CLI 已交付，整批未通过：R29-1 知识详情/诊断授权和源项目存在性；R29-2 专有别名联动、单字段更新和引用证据；R29-3 真正读取预算、最后一次读取取消/坏文件零候选状态及业务 CLI 提交后 exit 8；R29-4 关系图范围/授权过滤。
- 更正文案：ExperienceCard v1 **有 sourceProjectId**，没有可靠的平台/验证时工程快照。Feature 没有独立项目归属。不能把两者都说成“没有项目字段”。
- 正常 PXE 演示同时命中需求与经验正文，不能替代“只有 Feature 别名含查询词”的关联回归；trim/CRLF 规范化也不等于正文逐字原样保存。
- 当前 [BM-05 批次](bm05_development_plan.md) 内部收尾后直接交完整任务/人工交接/Manifest 重验/经验草稿，不升 schema、不提前 UI/Pi Session、不重做历史底座。前文修复声称是实施方快照，以本节与 [验收](round29_acceptance.md) 为准。
