# BIOS Agent 开发日志

最新结论见 [第二十九轮独立验收](round29_acceptance.md)：732 项（727 通过、0 失败、5 skip）及指定门禁通过；BM-04 正常业务已交付，但 R29 四组阻塞整批通过。当前 [R29 收尾＋BM-05 完整任务/上下文批次](bm05_development_plan.md)，内部过闸后直接继续任务/重开、人工交接包/Manifest 重验与经验草稿沉淀。

## 2026-10-04 · 第二十九轮独立验收与 BM-05 完整业务批次

- 独立 Package 732 项（727 通过、0 失败、5 skip）、targeted 309 项（307 通过、2 skip）、旧存储 249 项（246 通过、3 skip）及包/根指定门禁通过；业务/项目/memory 三套演示可运行。
- R28 核心整改及真实双确认进程测试通过，但关系范围/隐藏来源未知 scope 仍影响可见结论，R28-3 未完整关闭。BM-04 正常领域/人工 CLI 已交付，详情授权/来源、别名/字段/证据、真实预算/取消/CLI 提交状态及关系边界四组待收尾。
- 额外临时合成诊断不计永久用例；不以源码注释/正常 PXE 演示证明专有 Feature 别名能联动经验，不以干净 exit 0 掩盖已写入需核对。
- 新增 round29_acceptance.md、bm05_development_plan.md；同批内部收尾后直接交完整任务/人工交接/Manifest 重验/经验草稿，不拆成小修复轮次。
- 本次仅改文档，保留脏树、未跟踪文件及六项既有删除；未 add/commit/push，未接真实客户库/UI/Pi Session。下节是验收前实施方历史快照，完整关闭声称以独立结论为准。

## 2026-10-04 · BM-04 实施：R28 收尾＋需求/经验业务闭环（待独立验收）

- 节点 A 关闭 R28-1～4：
  - **R28-1**：新增 `core/projects/writeNotes.ts` 把存储层的 `cleanup`/`lockRelease`/`journal.state`/`warnings` 搬进服务结果（只搬运，不新建事务框架）；bind 在 registry 发布后档案读取失败不再抛错，而是返回 `partial` + 已发布身份/revision + 续办提示；出现"已提交但 journal 终态未写/清理或锁释放异常"时状态为 `needs-review`；confirm/refresh 同样透传；CLI 映射到退出码 8。
  - **R28-2**：证据复验改为**按调用方事实键分组**（结果带回 key，同路径只读一次磁盘但每字段各自判定）；新增两类独立预算 `maxEvidenceFiles` 与 `maxEvidenceEntries`（默认按文件预算 ×4 派生）；新增 `readFileBounded`（实际字节封顶、逐块复查取消、句柄 finally 关闭），检测侧不再依赖 stat；视图按事实键归属证据、未复验事实显式列出、检测/证据不完整 ⇒ `incomplete`；检测的选样受限变成可见事实；项目 symlink 分支改为**显式 skip**（EPERM），确认竞争改为**两个真实子进程**（退出码 `[0,4]`）。
  - **R28-3**：关系判定改为 `evaluateRelationStates` 全图求解（确定性排序 + Kahn 拓扑序 + 环保留矛盾 + 授权先于关系 + 撤回/不可读来源降级 + 节点与链长预算），输入排列不再影响结果。
  - **R28-4**：新增 `authorizeWorkspacePath`（真实路径优先、词法兜底；不可达≠未授权），open/detect/capture/verify/refresh 全部在访问工作区之前重新判定授权（新状态 `not-authorized`）；两个人工 CLI 共用 `cli/cliArgs.mjs`（参数白名单、重复规则、安全整数、受控输出与退出码表），未知/拼错/重复选项在任何 IO 之前拒绝；missing=6；`--max-output-bytes` 明确只约束 M1 条目数组，视图外壳独立有界。
- 节点 B 新增 `core/knowledge/`（contract/features/experiences/search/index）：需求录入/更新/详情（确认程度必须显式声明、不编造项目归属、关联逐条核对）、经验草稿 + 人工审核（status/reviewer 是托管字段，转发既有 `recordReviewDecision` 与审计）、有界关键词/别名检索（先授权后标题/片段/计数，端点策略显式，draft⇒needs-review、deprecated⇒excluded、history 可解释，无缓存）、跨项目参考详情（移植口径）。`legacy-unspecified` 扩展到经验族 + 需求族。
- 节点 C 新增 `cli/business.mjs`（feature/experience/review/search/reference）与 `cli/experience-scenario.mjs`（跨项目演示，七步，每步真实子进程）。
- 实跑：Package **732 项（727 通过、0 失败、5 显式 skip）**；targeted 309 项（307 通过、2 skip）；旧存储 249 项（246 通过、3 skip）；包类型/格式 132 文件、selfcheck 6 项、根类型/格式 2014 文件、processGuards 2 项、`git diff --check` 通过。732 = 711 + 21。
- 新增 [BM-04 实施记录](bm04_implementation.md)，同步导航/task/test/log/next/Package README，并在 BM-03 与 M1 实施记录追加本次修复事实。未升 schema、未迁移、未改 Electron/PiRuntime、未注册模型知识写工具、未读真实客户库；保留脏树、未跟踪文件与既有删除，未 add/commit/push。

## 2026-10-04 · 第二十八轮独立验收与 BM-04 完整业务批次

- 独立全量 711 项（707 通过、0 失败、4 skip）、targeted 288 项（287 通过、1 skip）、旧存储 249 项（246 通过、3 skip）及包/根指定门禁通过；真实项目子进程演示与 memory PXE 场景通过。
- R27-1/3 原场景独立关闭，R27-2 部分关闭。额外合成诊断归四组：领域发布事实、字段证据/真实读取/取消/部分状态、全分支关系、工作区授权/CLI 契约。未转永久回归，整批未通过。
- 纠正项目 symlink 分支未执行仍算通过、确认竞争仅同进程的覆盖声称；不继承为已验证权限/双进程结果。
- 新增 round28_acceptance.md、bm04_development_plan.md；下一批四组内部修复后直接交完整经验/Feature 业务，不拆成单条修复轮次。
- 本次只改验收/规划文档，保留脏树、未跟踪文件与六项既有删除；未 add/commit/push、未接真实客户库/模型知识写工具/UI。下节为实施方验收前历史快照，关闭声称以本节及独立验收为准。

## 2026-10-04 · BM-03 实施：R27 收口＋项目事实模块＋人工入口（待独立验收）

- 节点 A 关闭 R27-1～3：`core/memory` 契约显式区分**记录身份（族+ID+revision）/ 事实身份（+事实键）/ 关系端点（两端具名）**；按记录族与字段的当前准入；revision 集合只在已授权可见集合上算；关系两端复验（`unresolved-relation` / `relation-not-effective`）、多边共同判定（`relation-ambiguous`）、判定只看关系之前的信号快照（输入排列不改变结果）；入口闸门改为浅层→数量（不访问元素）→有界嵌套；输出按 JSON 数组精确 UTF-8 记账（`[]` = 2 字节，超限首条不再保留）。开发中真实踩到"就地改写基础原因导致环状用例随遍历顺序变化"，已有永久回归断言正反排列逐字节相同。
- `legacy-unspecified` 收窄到经验族：档案字段/任务状态不因"没有生效区间"被降级，经验卡既有回归不变。
- 节点 B 新增 `core/projects/` 七个文件：显式绑定与只读打开（授权先于 IO、不猜合并、重复执行先读现状、路径迁移保 workspaceId、无跨文件事务故如实报 partial）、有限检测（三条真实 EDK II 规则 + 十项身份缺口 + 证据 hash/行号）、人工确认 CAS（只改被点名字段、同值 no-change、冲突不写、双进程竞争恰一成功、留痕用 schema 已有 evidence）、每工作区 Git 快照（固定 argv/限时限输出/可取消/非 Git 省略 vcs/detached ⇒ branch null）与证据复验、M1 消费视图（确认值/检测候选共用业务事实键 ⇒ 自然形成 `needs-confirmation`；声明侧取档案记录的 HEAD、目标侧取本次读到的 HEAD ⇒ HEAD 变化变成 `verification-drift`）。
- 节点 C 新增薄人工 CLI `cli/project.mjs`（显式路径、离线、写确认、JSON 单对象 + `code`/`exitCode`、退出码 0/2/3/4/5/6/7、SIGINT→AbortSignal）与合成端到端演示 `cli/project-scenario.mjs`（每步真子进程，10 步全过）。
- 实跑：Package **711 项（707 通过、0 失败、4 文件型链接权限 skip）**；memory＋project＋backup＋CLI targeted 288 项（287 通过、1 skip）；旧存储 249 项（246 通过、3 skip）；包类型/格式 120 文件、selfcheck 6 项、根类型/格式 2014 文件、processGuards 2 项、`git diff --check` 通过。memory 22 → 28 项，新增 project 25 项。
- 新增 [BM-03 实施记录](bm03_implementation.md)，回写 [M1/M2 实施记录 §9](memory_foundation_implementation.md)，同步导航/task/test/README。未升 schema、未迁移、未改 Electron/PiRuntime、未接模型知识写工具、未读真实客户库；保留脏树、未跟踪文件与六项既有删除，未 add/commit/push。

## 2026-10-04 · 第二十七轮独立验收与 BM-03 完整业务批次

- 独立全量 680 项（676 通过、4 文件型链接权限 skip）、backup＋CLI＋memory 257 项（256 通过、1 skip）、旧存储 249 项（246 通过、3 skip）及指定包/根门禁通过。
- 正常 15 文件/9340 字节往返和五类新进程读取通过；R26-1～3 独立关闭，D3/D4 本机离线范围通过，不重做旧整改。
- M1 额外诊断发现三组有限缺口：当前准入/revision/授权集合、关系来源与确定性、公共输入/实际预算。既有 22 项绿不等于完整验收通过，证据见 round27_acceptance.md。
- 纠正 M2 差距表三处事实错误；认可 BM-03 使用 v1 的路线，不批准正式 schema/历史账本/迁移。下一批内部门禁后直接交完整项目事实模块与人工入口，一次验收，不拆成单条修复轮次。
- 新增验收与 bm03_development_plan.md，同步入口和实施状态。仅改文档，保留脏树、未跟踪文件和六项既有删除，未 add/commit/push；未接模型/读客户资料/做 UI。

## 2026-10-04 · R26-1～3 收尾＋M1 记忆决策模块＋M2 有限设计（实施方历史快照，独立结论见上节）

- **R26-1（源完成标记变化）**：完成标记读取改为"先判常规文件（链接/非常规类型即拒绝）→ 有界读原始字节 → 保留**原始字节指纹**"；完成点之前的源复核第一步重读同一路径并逐字节比较，任何差异（未来版本、**合法等长改写**、删除、替换成另一份同形状合法清单）收敛成受控 `backup-source-changed`、`published=false`、备份现场只读保留。
- **R26-2（目标晚期合法漂移）**：新增 `verifyTargetAgainstManifest`（集合 + 归属 + 逐文件长度/SHA-256）。完成点之前（`phase=verify-target`）发现漂移即拒绝发布；发布之后再复核一次，漂移只报 `committed-needs-review`（新固定枚举 `verify-restored-drift`）、`published=true`、**库保留**，不用清理删掉可观察变化来强行通过。次数有限（各一次），不声称消除 TOCTOU。
- **R26-3（CLI JSON 契约）**：`jsonRequested` 按取值规则做保守意图识别（`--root --json` 的 `--json` 是值，不算请求 JSON），解析失败也输出**一个**受控 `usage-error` 对象；`requestedCommand` 只接受已知命令；未知参数/命令正文走 `boundedToken` 有界省略。退出码与严格解析/双确认不变。
- **M1 纯决策模块**（`core/memory/contract|projection|policy|decide|index.ts`）：`decideMemory` 按"授权/端点 → 权威可读性 → 状态/revision 因果 → 范围与生效条件 → 替代/撤回/冲突 → 证据与验证快照 → 确定性排序与预算"的固定顺序判定，输出 `current/reference/needs-review/conflict/history/excluded` 与固定原因码；`projectV1Record` 走现有严格 schema 校验后只在内存加 legacy 标签。**不 import fs、不扫描 Git、不连模型、不读时钟、不写库、不升 schema**；未授权候选不返回 ID/标题也不进计数。
- **M1 永久测试与演示**：`tests/memoryDecisions.test.mjs` **19 项**（MT-01～05/07/08/10～12 纯策略部分 + 事实键范围要求 + 关系完整性 + 预算 0/精确/差一 + 确定性与标题截断 + v1 投影不修改输入）、`cli/memory-scenario.mjs` + `tests/memoryPxeScenario.test.mjs` **3 项**（合成 PXE 场景：目标 Board B、未来生效需求、Board A 旧经验、被撤回摘要、未授权客户资料、与确认值冲突的新检测候选；调用真实 M1 API，实测 current 1 / reference 1 / needs-review 3 / excluded 3，未授权材料零泄漏，两次运行逐字节一致）。
- **M2 只交设计**：逐记录族（ProjectProfile/ExperienceCard/FeatureRecord/TaskRecord/ContextManifest）列出 v1 可复用字段、不能表达的时态/撤回/范围信息、降级结果与业务影响、是否必须改格式；给出源/目标版本与未知值转换、历史上限拒写、单记录 CAS/审核/journal 影响、版本分层（记录格式 vs journal/audit/backup）与"未知未来版禁止自动纳入准入"的闸门；并给出 BM-03 下一批"不涉及 schema 变更可先做 / 须方案验收后才做"的划分。**未改 schema、未写迁移器、未动 C3 支持版本。**
- 实跑（实施方，修改后）：backup＋CLI **235 项**（234 通过、0 失败、1 显式 skip）、M1 **22 项**、Package **680 项（676 通过、0 失败、4 显式 skip）**、旧存储 targeted **249 项（246 通过、3 skip）**、selfcheck 6 项、包类型/格式 105 文件、根类型/格式 2014 文件、processGuards 2 项、`git diff --check` 通过。
- 未做/未测：真实 ACL/网络盘/断电/其它 OS/安装包/客户硬件；M1 未接真实检索索引、Session、磁盘读回或向量库；M2 未落任何持久化；未改 PiRuntime/Electron。保留脏树、未跟踪文件与六项既有历史删除；未 add/commit/push。

## 2026-10-04：第二十六轮独立验收与记忆底座加速批次

- 独立 backup＋CLI 218 项全绿，Package 641 项（638 通过、0 失败、3 权限 skip）、旧存储 249 项及类型/格式/selfcheck/根指定门禁通过。
- 合成 15 文件富库在 API 与真实 CLI 往返中原字节/集合一致，新进程现有 reader 读取五类记录全部成立；没有读真实客户资料。
- 独立诊断 R26-1/2：manifest 改为未来版本、目标 feature 晚期合法改写均仍无警告 restored；R26-3：CLI JSON 参数解析错误 stdout 为空。正常闭环通过，整批暂未通过。
- 新增一份验收与一份统一批次方案，同步入口/任务/测试/实施状态。下一轮不仅修三项，还交完整 M1 纯决策/v1 投影/场景演示及 M2 字段差距方案；格式持久化变更不提前。
- 分阶段开发技能用于保持 A→B→C 内部闸门与整模块交付，写作技能用于压缩当前交接入口并区分设计、自测与验收。仅改文档，未修运行代码、未 add/commit/push；原脏树与六项历史删除保持。自行创建的诊断沙箱已校验范围后清理。

以下保留历史记录。
已补 [分层记忆与时态设计](layered_memory_temporal_design.md)，只更新业务阶段路线；M1/M2 与记忆引擎尚未实施，不打断 C3、不推翻底座。
[实施记录 §12](bm02c2b_implementation.md) 与 C2BR2 §6 保留修复/完成标准，旧提示词不重跑。
[C2B 实施记录 §10](bm02c2b_implementation.md) 保留实施快照。C2AR 的修正协议、纯关联校验见 [C2A 实施记录](bm02c2a_implementation.md) §3/§6（协议范围第十一轮已通过，A1～A3 关闭）。
前四轮验收与两份整改记录已合并为 [历史摘要](acceptance_history.md)；BR/C1/C1R 及中断交接已关闭。下文旧文件名仅表示历史产物，不是当前执行入口。

## 2026-10-04 · D3＋D4 实施（本次交付，待统一独立验收）

- 新增 `core/storage/backup/restore.ts` / `restoreSource.ts` / `restoreTarget.ts` / `pathCompare.ts`，窄出口导出 `restoreKnowledgeBackup({ backupRoot, root, offlineConfirmed, limits?, preflightLimits?, signal?, ioHooks? })`：只恢复到**不存在**的新知识根、排他取得与身份复核、按清单建目录 + 空 `cache`/`locks`、除 registry 外逐文件复制回读、目标布局全量比对、备份变化复核、**原 registry 字节最后非覆盖发布**（完成点）、发布后只读复核，失败/取消按归属 `cleanupOwned` 并复用 D2R 脱敏与 `facts`（phase/published/cleanup/residuals）。发布后问题返回 `committed-needs-review`（`reviewReasons` 固定枚举），不删除已恢复的库、不伪称未写入。
- 备份侧准入是**只读**且不冒充自有写入会话：有界读原始 `manifest.json` → `validateBackupManifest` → `enumerateContainer`（显式传已验证集合）+ `assertContainerMatchesManifest(manifestPresent:true)` → 逐文件长度/SHA-256 → `inspectKnowledgeStore({root:<备份根>/data})`。恢复目标的集合是**知识库布局**，另写判据（不套容器包装）。容器形状常量移入契约层；`export.ts` 改为复用 `pathCompare` 的重叠判定；`container.ts` 导出可复用的逐项有界枚举。
- 新增 `cli/knowledge.mjs`（`npm run knowledge`）与 `cli/knowledgeOutput.mjs`：`--help`/`inspect`/`export`/`restore`；显式绝对路径、离线＋写入双确认（缺任一项在调用 API 前拒绝）、`--json` 单对象、退出码 0/1/2/3（已提交/残留/需复核必须非 0）、SIGINT 传 AbortSignal 并等待清理、listener 在 `finally` 移除。CLI 不是第二套存储实现，判据全在 `core/storage`。
- 红绿：上一轮保存的 3 项恢复红例全部转绿；其中“新进程 reader”脚本原本按错误的字段形状断言，已改为现有 `readRecord` 的真实返回形状（测试自身断言错误，非产品字段改动）。新增 47 项 D3 用例与 11 项 CLI 用例，全部真实执行（junction 对照本机实际执行，本机零 skip）。
- 实跑（实施方，修改后）：backup targeted **207 项**（既有 160 全部保留）、`knowledgeCli` **11 项**、Package **641 项（638 通过、0 失败、3 显式 skip）**、旧存储 targeted **249 项（246 通过、3 skip）**、selfcheck 6 项、包类型/格式 96 文件、根类型/格式 2014 文件、processGuards 2 项、`git diff --check` 通过。
- 端到端合成演示（可复现，14 文件逐字节不一致 0 个、cache/locks 为空、新进程 reader `exp-a revision=1`）：inspect 退出 0 → export `published=true` → restore `status=restored`；完整输出见实施记录 §14.5。
- 未做：在线快照、网络盘/断电原子恢复、ZIP/加密/增量备份、真实 ACL/其它 OS/安装包/客户硬件验证；D4 不带默认用户库回退、交互确认、删除/初始化/任意写入/审核命令与无限制开关。未升 schema、未改 PiRuntime/Electron、未读客户资料、未 add/commit/push；脏树、未跟踪文件与六项既有历史删除保留。低风险维护项（`target.ts` 596 行、安全测试 859 行）继续登记。

## 2026-10-04 · 用户节奏调整：D3＋D4 合并交付

- 用户要求每轮多完成开发工作；将当前知识库管理模块扩大为恢复 API＋原字节往返＋新进程读取＋inspect/export/restore 最小人工 CLI。D3 内部门禁通过后直接做 D4，最后统一独立验收，不要求中途人工转交。
- 原批次方案追加 §11，明确 CLI 参数、双确认、只读默认、JSON/退出码、取消收尾、子进程演示与整批门禁；旧“D4 不在本批”由该节取代。其它非覆盖/数据保护/兼容规则保持。
- 后续按项目、经验、任务模块的完整业务闭环交付；低风险技术债不单独阻塞，真实安全/数据缺陷仍必须关闭。上下文不足记录代码断点，不重新开启历史整改。
- 分阶段开发技能用于保持同模块顺序推进，写作技能用于明确旧指令替代和未实现状态。仅更新方案/状态/导航，不是新一轮功能验收；D3/D4 仍未实现。未改运行代码或提交推送。

## 2026-10-04 · 第二十五轮验收：R24 收口，直接接续 D3

- 本轮实际只交 R24-1/2 修复和 4 项新增测试计数；D3 无恢复 API/模块/专项测试，整批未完成。
- 独立 backup 160 项全绿、Package 583 项（580 通过、0 失败、3 skip）、旧读取 100 项（98 通过、2 skip）；包类型/selfcheck 6/格式 86、根类型/格式 2014/processGuards 2/diff 检查通过。
- 独立 EACCES/单路径 EIO/ENOENT、真实未知子树 opendir、未知文件、targetExists 分类和最小导出精确预算/原字节/hash 对照通过；源字节保持。没有新的阻塞发现，不继续加孤立小整改。
- 新增 round25_acceptance.md，原方案追加 §10（首个交付即最小恢复用例/API），实施记录追加 §12并消除重复 §10；同步入口。单路径 EIO 永久回归与窄拆文件放入 D3 同批。
- 按分阶段开发技能保持既有底座、有限 D3 范围与后续路线；写作技能区分修复通过和恢复尚未实现。仅改 Markdown，未修运行代码、读取客户库或提交推送；脏树/未跟踪文件/六项既有删除保持。

## 2026-10-04 · 第二十四轮验收：修复原复现通过，D3 未开始

- 本轮只新增 target/container 修复和 7 项回归；D3 无 API/恢复模块/恢复测试，不能标整批完成。
- 独立 backup 156 项全绿、Package 579 项（576 通过、0 失败、3 skip）、旧读取 100 项（98 通过、2 skip）；包类型/selfcheck 6/格式 86、根类型/格式 2014/processGuards 2/diff 检查通过。
- R23 原复现关闭；额外对照通过 mkdir 等待替换、manifest 登记失败、发布 tmp 同名替换、容器 Dir.close 故障与取消。正常导出独立重算长度/hash，源字节保持。
- R24-1：清理 lstat EACCES 时 target/data/registry 仍在却 cleanup=ok；R24-2：未知 data/unknown/nested 被递归后才拒绝。均在原批次 §9 窄修后，同一对话继续 D3，不再单独交回补丁。
- 新增 round24_acceptance.md，追加原方案 §9、实施记录 §11并整理重复编号，同步状态入口。仅改 Markdown，无运行代码修复、客户库读取、提交推送；保留脏树、未跟踪文件及六项既有删除。

## 2026-10-04 · 第二十三轮验收与同批接续

- 实际交付只有 D2R 节点 A 的实现；没有 restoreKnowledgeBackup、恢复模块或恢复测试，D3 尚未开始。
- 独立复跑 backup 五文件 149 项全绿、旧读取 100 项（98 通过、2 skip）、Package 572 项（569 通过、0 失败、3 skip）；包类型/selfcheck 6/格式 86、根类型/格式 2014/processGuards 2 及 diff 检查通过。
- 原 junction 清理、额外/缺空目录、取消/关闭/清理事实和脱敏复现已有改善；仍发现 R23-1 等待后目标外写入、R23-2 读取 close 吞错及登记失败漏关句柄、R23-3 全量目录装载先于预算。门禁全绿不等于这些额外实验通过。
- 新增 round23_acceptance.md，在原批次方案与实施记录追加当前接续；先补永久回归和最小修复，节点门禁通过后同一对话完成 D3，统一交回，不另拆孤立整改轮次。
- 本次仅改验收/指导/状态文档，未修运行代码或永久测试，未提交推送；保留脏树、未跟踪文件和六项既有删除。未验证真实客户库、远端 CI、安装包或硬件。

## 2026-10-04 · 第二十二轮验收与下一批安排

- 独立复跑 backup 128 项全绿、旧读取 100 项（98 通过、2 skip）、Package 551 项（548 通过、0 失败、3 skip）、包/根指定门禁通过。
- 独立 B1/B2 拒绝与零迭代对照确认 D1/D1R 通过纯校验范围。
- D2-1～4 新诊断：junction 清理误删目标外 sentinel；目标额外文件/缺空目录仍发布；取消/关闭/临时清理事实失真；原异常和完整源路径透传。D2 暂未通过，不能用于正式资料保护。
- 新增 round22_acceptance.md、bm02d3_development_plan.md；下一批 D2R＋D3，内部修复门禁通过后继续恢复往返，整批独立验收。没有修复运行时代码，不提交推送，脏树及既有删除保留。

## 2026-10-04 · D1R＋D2 实施（实施方历史快照，独立结论见上）

- 节点 A（D1R）：B1 改用 `util.types.isUint8Array` 确认品牌、由 `%TypedArray%.prototype` 的 `byteLength` getter 取**实际视图长度**，
  长度/预算/累加/摘要共用这一可信长度且**先于 hash**；原型伪装视图受控 `payload-entry`，不再抛原始 crypto 异常。
  B2 在 `readExclusions` 里**先要求长度恰好两项**再访问元素。旧红新绿：两字节视图覆盖 `byteLength=1` 由"错误成功 + hash 1 次"转为
  `payload-size-mismatch` + hash 0 次；100,001 项排除数组由"遍历全量"转为元素访问 0 次；反序/重复/未知/裁剪预算对照保持。
- 节点 B（D2）：新增 `exportKnowledgeBackup`（`core/storage/backup/export.ts`、`inventory.ts`、`target.ts`）与
  `core/storage/readBytes.ts`（Boundary 新增 `readRawBytes` 窄方法，`readJson` 未动）。流程：参数/限额 → canonical 重叠判定
  → 排他创建目标 → 预检准入 → 受控 inventory → 有界原字节复制（独占创建、短写循环、sync/close）→ 源变化检测
  （重新盘点 + 重跑准入 + 重读源字节比对 hash）→ 目标逐文件回读复核 → 最后非覆盖发布 `manifest.json`。
  失败/取消按所有权清理（文件先删、目录自深到浅、最后删目标根，不用递归删除），主失败码不被清理失败覆盖。
- 新增受控码：`backup-argument-invalid`/`backup-source-not-eligible`/`backup-target-exists`/`backup-target-overlap`/
  `backup-source-changed`/`backup-io-failed`；`StorageIoOperation` 增加 `backup-write`。
- 永久回归：D1R +10（103 项）、D2 +25（`storageBackupExport` 10 + `storageBackupExportFailure` 15，含真实双进程竞争同一目标）。
- 实跑（实施方）：backup 四文件 128 项全绿；records/registry/preflight 旧读取回归 100 项（98 通过、2 skip）；
  `npm test` 551 项（548 通过、0 失败、3 显式 skip）；包类型/selfcheck 6/格式 83 文件与根类型/格式 2014/processGuards 2/`git diff --check` 通过。
- 未做：D3 恢复、D4 CLI、UI/Pi 工具/记忆、ZIP/压缩/加密/增量/网络备份；短写/sync/close 失败注入、
  `cleanup:"failed"` 报告路径与 `publish-unsupported` 分支**有实现但无专门用例**（已记入 D2 实施记录 §6 技术债）。
  未升 schema、未改 PiRuntime/Electron、未读客户资料、未 add/commit/push；脏树与六项历史删除保留。状态：**D1R＋D2 已实施、待统一独立验收**。

## 2026-10-04 · 加速节奏：D1R＋D2 同模块批次

- 用户确认写加速开发文档。新增当前批次方案，交付目标改为实体离线备份：先修 B1/B2并通过节点回归，再在同一开发对话完成 D2，最后统一独立验收，不仅交付两处小修复。
- D2 明确显式离线确认/预检准入、根外全新目标、排他创建、受控有界原字节复制、源变化/目标回读核验、最后非覆盖发布 manifest；提交前后取消与所有权清理分别报告。采用目录加完成标记，不额外设计目录原子替换系统。
- 内部节点仅跑相关门禁，整批交回前完整复跑。按实际风险决定阻塞，数据保护/泄漏/虚假成功等必须修，低风险技术债不自动挡所有后续业务；既有 B1/B2 不豁免。
- 同步导航/MVP/task/test/入口/必要说明；旧 D1 单独交接提示词作废，保留历史验收事实。D3/D4、M1/M2、业务、Pi 工具和 BM-07 UI 顺序保持。
- 本次仅改 Markdown；D1R/D2 均未实施，不把第二十一轮测试数字当本次新结果。未跑代码测试，文档验证为链接/章节/状态与 `git diff --check`；未 add/commit/push，脏树与既有删除保留。

## 2026-10-04 · 第二十一轮独立验收与 D1R 接续

- 独立复跑 backup 93 项全绿、Package 516 项/513 通过/0 失败/3 权限 skip；包类型/selfcheck6/格式77、根类型/格式2014/processGuards2/`git diff --check` 均通过。
- B1：实际两字节视图覆盖 `byteLength=1` 后，在清单/单文件/总预算 1 时仍成功、hash 调用一次；正常长度不符对照失败且 hash 零次，非零偏移 Buffer 子视图正常。假 Uint8Array 原型还会抛原始 crypto 异常。
- B2：100,001 项排除数组在 manifest 预算1、问题预算0/1时均遍历全部条目才拒绝，缺少固定两项的前置数量判断。
- D1 整体暂未通过。当前只排 D1R 的 B1/B2；收尾规格和短提示词追加原 D1 方案 §8，避免重复方案。D2～D4、记忆与 UI 不提前开始；C3 已关闭结论保持。
- 本次仅更新验收/指导/状态文档，未修运行代码或永久测试；诊断用进程内合成数据，无客户资料或真实库读取，无临时文件，无 add/commit/push，脏树与六项既有删除保留。

## 2026-10-04 · BM-02D1 备份协议与纯校验（实施方历史快照）

- 只做 D1：新增 `core/storage/backup/`（`limits` 83 / `contract` 172 / `issues` 58 / `paths` 242 / `manifest` 264 / `verify` 118 / `index` 29 行），经存储层窄出口导出；`errors.ts` 新增 `invalid-backup-manifest` 与 `backup-payload-mismatch` 两个受控码。
- `backupVersion=1` 清单：严格对象、字段顺序固定、未知字段（含 symbol 键）拒绝；`consistency` 固定 `offline-copy`；`exclusions` 恰好 `cache`+`locks`（集合比较）；受控落点复用既有 ID/journal/审核意图判据，`projects`/`experiences`/`features`/`audit`/`profile.json` 与 `knowledgeLayout()` 由漂移守卫测试对照。
- 路径只接受规范形式：绝对/盘符/UNC/反斜杠/`.`/`..`/重复与首尾分隔符/NUL/冒号 ADS/尾点/尾空格/保留名/大小写变体/非 ASCII/未 URL 解码一律拒绝；诊断"名称已省略"，不回显恶意路径与客户正文。
- 独立 `BackupLimits`（清单 2 MiB/文件 10k/目录 2k/单文件 16 MiB/总量 256 MiB/路径 240 字符/问题 50）：未知字段与非法值在处理数据前抛 `invalid-limits`；数量边界先于逐条细节；总量在溢出前拒绝；`maxIssues=0` 不返回问题但如实计数且仍是失败。本轮明确**不声称**限制文件读取或 JSON 解析内存。
- `verifyBackupPayload`：内存原始字节（无 fs/根路径），校验清单 → 条目数与形态 → 长度 → SHA-256；缺失/多余/重复/长度错/hash 错分别报出，不解析业务 JSON；**字节一致不等于业务版本准入**（未来 schema 与损坏 JSON 可通过并由对照用例钉死）。
- 永久回归：`storageBackupManifest.test.mjs` 70 项 + `storageBackupPayload.test.mjs` 23 项（fixture `tests/helpers/backupFixtures.mjs`，hash/字节用 `node:crypto`/`Buffer` 独立重算）；含**原始字节保真**对照（BOM/CRLF/制表符/尾空格/非法 UTF-8 逐字节进 hash，只差一个尾空格字节即失败）。
- 实跑（实施方）：D1 针对性 93 项全绿、Package 516 项/513 通过/0 失败/3 显式 skip、包类型/selfcheck 6/格式 77 文件与根类型/格式 2014/processGuards 2/`git diff --check` 均通过。三个 skip 为既有本机链接权限限制，D1 新增用例无 skip。
- 未做：任何导出/恢复 IO、CLI/UI/模型工具、记忆实现；未升 schema、未改 PiRuntime/Electron、未改预检/写入/审核/journal 行为；未读客户资料，未 `git add`/`commit`/`push`；脏工作树与六项历史文档删除保留。状态：**实施完成、待独立验收**。

## 2026-10-04 · 第二十轮独立验收与 D1 开发指导

- 独立复跑423项/420通过/0失败/3skip、七文件240项/239通过/1skip、五文件194项/191通过/3skip，包/根指定门禁均通过。
- 原关闭故障独立计量16/16、1/1、2/2，错误可见，之后无新扫描IO，前后库清单/hash不变；宽预算实际关闭故障仍能继续后续类别。S3关闭，C3/C3R通过本机声明范围，不再排预检整改。
- 新增第二十轮报告及唯一下一任务D1方案；备份独立manifest/路径/资源与内存字节纯校验，暂不实现任何导出/恢复IO或CLI。按分阶段技能拆D1→D2→D3→D4，再接记忆M1/M2与业务，UI顺序不变；写作技能区分已实现与计划能力。
- 同步导航/状态/测试/实施回写，保留历史报告与快照。仅改文档，未改代码，未读客户资料，未提交推送；合成临时目录已清理，既有脏工作树与六项历史删除保留。

## 2026-10-04 · BM-02C3R-S3 接续实施（历史交付快照，后来由第二十轮复验通过）

- 只做 S3：唯一超限探测条目**已经交出**后，停止状态在**观察回调处就地锁存**（`truncatedBy` 记 `scan-entries`），不再依赖 `listEntries` 是否成功返回。新增唯一判据 `isScanStopped = stopped || truncatedBy.has("scan-entries")`，在 `listEntriesBounded` / `readJsonBounded` 入口与 `inspect.ts` 分类门控兑现"不再列举新目录、不再读新候选"；`complete` 同步改用该判据。为避免 `stopped` 挡掉明细记录，锁存不直接 `stopScan`，因此**导致停止的那条受控错误仍进问题列表**；取消照旧结构化穿透、句柄照旧配对关闭。
- 计量 helper 补齐：代理**完整转发原迭代器 `return()`/`throw()`**（旧代理只转发 `next()`，`break` 时关闭故障只会被 `finally` 的 `.catch()` 吞掉，红回归无从复现）；新增关闭故障注入（在 `Dir` 构造前包装 `fs.Dir.prototype.close`，先完成真实关闭再注入受控 `EIO`）、取消对照与目录轨迹。既有 S1/S2 用例的断言不减少、不放宽。
- 永久红回归：`storagePreflight.test.mjs` 66 → 75 项（1 父 + 8 子）。修前 A/B/C/D 四条断言失败（额度 15 实际/报告 17/17 应为 16/16；0/1 应为 1/1、2/2；嵌套应为 16/16 且只列举一个事件目录），修后全绿；宽预算不锁存、取消/句柄、关闭错误×读取预算停止、关闭错误×明细额度停止四条对照在修前修后都通过（成本不丢、不误锁存、其他预算停止不回退）。
- 实跑（实施方）：Package 423 项/420 通过/0 失败/3 显式 skip，七文件 240 项，五文件 194 项；包内类型/selfcheck 6/格式 67 与根类型/格式 2014/processGuards 2/`git diff --check` 均通过。`scan.ts` 409 行略超 400 目标（未超 600 拆分门槛），本轮未为凑行数删减说明性注释、未做无关重构。
- 未改写入原语、锁、journal/review 协议、根解析与 schema、`directoryListing.ts` 契约、PiRuntime/Electron；未读真实客户库、未做备份/CLI/UI/记忆，未 `git add`/`commit`/`push`。状态：**实施完成、待独立复验**。

## 2026-10-04 · 第十九轮独立验收与 S3 接续

- 独立复跑 Package 414 项/411 通过/0 失败/3 skip，七文件 231 项/230 通过/1 skip，列举调用者五文件 185 项/182 通过/3 skip；包内类型/selfcheck 6/格式 67，以及根类型/格式 2014/processGuards 2/diff 均通过。
- S2 原 `next()` 中途 EIO 漏计复现转为 16/16，关闭该问题，保留 PF-1～PF-3、S1/S2 已通过行为。
- 独立真实关闭后注入 EIO：额度 15/0/1 分别实际观察并报告 17/2/3，超限后仍列举 features；库清单/hash 不变、错误正文不泄漏。计数正确但停止锁存遗漏，只排 S3，不扩展新功能。
- 新增第十九轮报告，在现有 C3R 方案追加 §8 及新对话提示词，同步当前状态；历史验收和实施快照保留。按分阶段开发技能只排一个窄收尾，按写作技能区分实跑事实与未实现路线。
- 仅改文档，未改运行代码/永久测试/PiRuntime/Electron，未读真实客户库，未提交推送；临时合成诊断已清理，六项既有历史删除保留。D/UI/记忆实现未开始。

## 2026-10-02 · BM-02C3R-S1 接续实施（历史实施快照，后来由第十八轮确认原复现通过）

- 只做 S1：`listEntriesBounded` 改为**有界列举一返回就**把已观察条目计入共享预算（截断与否都一样），遍历侧去掉逐条 `chargeEntry`、只检查 `scan.stopped`——列举与候选处理职责分开，同一条目只扣一次账；这条同时覆盖项目/任务、experience/feature、journal、audit 父子目录、locks 与根落点，不是只修 audit。
- 新增"预算耗尽直接返回 `stopped`"的守卫（耗尽后不发起新列举 IO），以及 `chargeLogicalCheck`：登记项目缺目录属**逻辑核对**，共用条目预算但不计入 `scannedEntries`（两者不互相伪装）。
- 红/绿：A（嵌套 audit，额度 15）修复前 `observed=18/reported=16`（第十七轮独立实测；本轮在任何改动前用同一计量复现 18/16），修复后 `16/16`；B（输出额度 200）修复前 `10/1`，修复后 `10/10`。计量在**独立 Node 子进程**里包装真实 `fs.promises.opendir`/`open`，只计数、不改条目/内容/上限。
- 新增 7 个永久用例（预检 52 → 59）；junction 创建失败分支由空返回改为显式 `context.skip`；`pathProbe.ts` 从 `scan.ts` 拆出以维持 400 行红线（scan 379 行）。
- 实跑：包内 `npm test` 407 项（404 通过/0 失败/3 skip）、七文件 224 项（223 通过/1 skip）、类型/selfcheck 6 项/格式 66 文件；根类型/格式 2014 文件/守卫 2 项/diff 检查全部通过。
- 未改：写入协议、Boundary 语义、schema、模型工具/CLI/UI、PiRuntime/Electron；未读客户资料、未提交推送；临时探测脚本已删除。

## 2026-10-02 · 第十七轮独立验收与 S1 接续

- 独立复跑 400 项/397 通过/3 skip、七文件 217 项/216 通过/1 skip；包内类型/selfcheck 6 项/格式 65 文件和根类型/格式 2014 文件/守卫 2 项/diff 检查全部通过。
- 合成诊断确认 PF-1 根错误可见、PF-2 两类共享额度、PF-3 合并明细实际字节正确；三项收尾关闭。PF-4 的原始截断已修，但正常列举仍延迟计费：嵌套预算 15 实际观察 18/报告 16；输出触顶观察 10/报告 1。只剩 S1，不重做其它三项。
- 新增第十七轮报告，在既有 C3R 方案追加 §6，按分阶段开发技能仅排一个接续问题；文档写作区分独立结果与历史实施快照。同步导航/主方案/task/test/log/C3/Package/接入状态，分层记忆计划不改动。
- 本轮仅改文档，未改源码/PiRuntime/Electron，未读真实客户资料，未提交推送。临时合成诊断目录已清理；未测范围见报告。

## 2026-10-02 · BM-02C3R 收尾实施（历史交付快照，独立结论见上节）

- 只做 C3R：先给四项缺陷写永久红回归，再最小修复；红阶段同一批用例在旧实现上共 **16 项失败**，修复后 52 项全绿。
- PF-1：`scan.ts` 新增 `probePath`（探测失败变显式状态，取消仍穿透、未知异常不透传正文）；根级列举失败报成阻断问题 + 新截断原因 `root-listing`，`complete=false`，绝不再 `no-migration-needed`；`cache/` 探测失败同样按问题收集。
- PF-2：`problems` 与 `manual` 共享 `maxProblems`（`retainedIssues`，不含摘要），越额明细丢弃但 `blockingProblems`/`manualItems` 保留。
- PF-3：`chargeDetail` 定义唯一输出包络——三类明细合并 JSON 数组的真实 UTF-8 字节（含括号/逗号），空明细 0，固定报告信封不计入；修正了原"逐条累加"漏算 `n+1` 字节的口径与字段注释。
- PF-4：列举截断时把底层已观察条目（含唯一超限探测条目）计入 `scannedEntries` 并停止，名字不再逐个 `chargeEntry`（不重复扣账）。
- 环境证据：叶子文件链接由"空通过"改为显式 `context.skip`；两个既有权限 skip 保留；实跑 3 个 skip 全部如实标注。
- 体量红线：锁 / `cache/` / 根布局外落点拆到 `auxiliaryCategories.ts`（89 行），preflight 全部文件 ≤400 行。
- 未改：写入协议、Boundary 语义、schema/迁移、模型工具/CLI/UI、PiRuntime/Electron；未读客户资料，未提交推送。

## 2026-10-02 · 第十六轮独立验收与分层记忆规划

- 独立复跑包内 383 项/381 通过/0 失败/2 显式 skip、七文件 200 项、包内类型/selfcheck 6 项/格式 64 文件，以及根类型/格式 2014 文件/processGuards 2 项/diff 检查，全部通过。
- 合成临时库诊断复现 PF-1 根列举错误误报完整通过、PF-2 共同问题额度变两份、PF-3 输出字节漏算分隔符、PF-4 截断条目统计归零；整体暂未通过，下一轮仅 C3R。非根路径探测错误及未执行叶子链接的证据口径一并收尾。
- 新增第十六轮报告、C3R 有限方案、分层记忆与时态设计；同步导航/MVP/task/test/Package 与 C3 状态。M0 文档完成，M1 纯契约及 M2 兼容闸门在 C3/备份管理之后、BM-03～05 前排期。
- 按分阶段开发技能一次只排 C3R，不同时铺开记忆实现；按写作技能区分实跑事实、设计候选与未测范围。未改运行代码/底座/PiRuntime/Electron，未读客户资料，未提交推送。诊断仅使用临时合成库，诊断目录已清理。

## 2026-10-02 · BM-02C3（实施方交付快照，独立结论见上节）

- 新增 `core/storage/preflight/`（`limits` 87 / `contract` 147 / `scan` 325 / `verdicts` 109 / `categories` 393 / `inspect` 93 / `index` 25 行），
  由 `core/storage/index.ts` 窄出口导出 `inspectKnowledgeStore({ root, limits?, signal?, ioHooks? })`：只读、有界、可取消，不调用初始化 API。
- 结论只有三种：`no-migration-needed` / `blocked` / `incomplete`；**任何截断都不返回通过**，问题列表被截断时阻断计数仍然独立累加。
- 分类与既有校验器**同码**：记录 `interpretRecord`、journal 按 `journalVersion` 路由 v1(`validateJournalRecord`)/v2(`validateReviewJournalRecord`)、
  审核意图 `validateAuditIntent` + 路径身份、审计事件 `validateAuditEvent` + 路径身份；未知版本只报一条、绝不猜字段。
- 固定落点覆盖 registry/项目档案/任务/上下文/经验卡/特性/journal/意图/事件/锁/`.tmp` 残留/cache；不递归未知目录、不跟随链接、不扫 BIOS 源码。
- 预算三类共享：条目、读取（成功按实际字节、失败按单文件上限预留，分账报告）、输出（条数 + **真实 UTF-8 字节**）；
  `prepared`/`conflict`、锁与 `.tmp` 一律进"人工核对事项"，不重放、不偷锁、不清理。
- 新增 `tests/storagePreflight.test.mjs`（35 项，含子用例）：版本共存、缺档案/孤立项目、坏 JSON/归属/绑定/版本、人工事项、超大与增长文件、
  链接（根/中间目录/叶子）、预算与 0/undefined/非法限额、取消与并发消失、以及**只读证据**（前后清单与 SHA-256 相同、不建目录、不泄漏正文哨兵）。
- 验证（实施方实跑）：七文件 **200 项全绿**；`npm test` **383 用例：381 通过、0 失败、2 权限 skip**（348 基线未削弱、skip 未增加）；
  `typecheck`/`selfcheck` 6 项/`check:format` 64 文件通过；根 `typecheck`/`check:format` 2014 文件/`processGuards` 2 项/`git diff --check` 通过。
- 未做/未改：实际迁移与升版、备份、管理 CLI、UI、模型工具一律未做；未改 PiRuntime/Electron、未读客户资料、未 add/commit/push。状态：**实施完成、待独立验收**。

## 2026-10-02 · 第十五轮独立验收与 C3 开发指导

- 独立复跑 Package 348 项（346 pass、0 fail、2 既有权限 skip）、审核/journal 六文件 165 项，以及包内/根类型、格式、自检、processGuards 和 diff 门禁，均通过。
- 新合成库直接调用生产 API：正式取消三个对照的诊断与 `.tmp` 增量相符，原意图/journal/业务 hash 和事件清单不变；额外检查首错字段/cause 保持及不同合法意图不覆盖。I1 关闭，C2B 经两轮整改后完成标准收口。
- 新增一份第十五轮报告和一份 C3 方案，同步导航与状态。按分阶段开发技能限制为只读版本盘点/迁移预检；没有正式旧业务格式，不编造迁移或主动升 schema。C3 之后再排备份与 CLI，UI 留 BM-07。
- 本次只改文档，未改源码/永久测试/PiRuntime，未新增删除，未接触客户资料，未 add/commit/push。未跑生产打包、根全量、跨平台与远端 CI。

## 2026-10-02 · BM-02C2BR2 / I1（实施方历史交付记录，后续已由第十五轮复验通过）

- **先红后绿**：在 `storageReviewWriter.test.mjs` 的工件幂等组新增 `I1`（父测试 + 4 子例）。红的那一项按第十四轮复现步骤：
  同 operationId 同字节意图已存在（真实撞名）→ 仅在 `audit/intents/` 注入 `unlink-temp` 失败 → 在复读已有意图的
  IO 等待点用正式 `AbortSignal` 取消 ⇒ 修正前 `StorageError/code=cancelled` 且**无任何清理诊断**，磁盘上却有新增 `.tmp`。
- 修复（`core/storage/review/artifacts.ts` 撞名复读 catch）：`published.cleanup === "failed"` 时，用既有
  `attachArtifactCleanupNote` 把**本次**的 intent 清理说明附加到取消错误上再重抛——取消仍穿透、
  `cancelled` 码与 `detail`/`cause` 不变、只在本次真的清理失败时附加（不误报、不归因历史残留）。
- 同类分支审计：其余 5 处 `isCancelledError → throw` 都在"发布之前"（取锁/读指纹/纯读），无本次清理事实可丢，不做连带改动。
- 验证（实施方实跑）：六文件 **165 项全绿**；`npm test` **348 用例：346 通过、0 失败、2 权限 skip**（343 基线未削弱，审核持久化 90 → 95）；
  `typecheck`、`selfcheck` 6 项、`check:format` 56 文件通过；根 `typecheck`、根 `check:format` 2014 文件、`processGuards` 2 项、`git diff --check` 通过。
- 未改：普通写 v1/C1、五类 schemaVersion、共同目标锁、不重放/回滚、不自动抢锁；未做迁移/CLI/UI/模型工具，未改 PiRuntime，未读客户资料，未 `git add`/`commit`/`push`。
  状态：**I1 实施完成、待独立复验**；边界见实施记录 §12.5。

## 2026-10-02 · 第十四轮独立验收与 I1 接续

- 独立复跑完整 343 项（341 pass、0 fail、2 既有权限 skip），审核/journal 六文件 160 项全绿；包内 typecheck/selfcheck 6 项/格式 56 文件、根 typecheck/格式 2014 文件/processGuards 2 项、diff whitespace 门禁通过。
- 合成知识库直接调用生产 API 确认 F1 的七项负例与合法 conflict 正例；F2 writer/recovery 事件失败及 recovery 终态失败的残留与诊断相符。F1 关闭，已通过的 F2 主路径不重做。
- I1：同字节意图 exists 后先 unlink-temp 失败、再 AbortSignal 取消复读，实际新增一个 `.tmp`，但结构化 cancelled 无清理诊断；三个对照的 intent/journal/业务 hash 不变。属于原 F2 exists/取消要求，不扩展新功能。
- 新增第十四轮报告，在原 C2BR2 方案追加 §6 单一接续任务与提示词，同步状态；没有另建重复整改方案。仅改文档，未改生产/永久测试/PiRuntime、未新增历史删除、未读客户资料、未 add/commit/push，不启动迁移/CLI/UI。

## 2026-10-02 · BM-02C2BR2（实施方记录，独立结论见上节）

- **先红后绿**：先补永久回归（F1 8 个绑定负例全红、F2 writer 2 红 + recovery 3 红），再改实现；未删除/放宽任何既有用例。
- F1：`!matchesAfter && !matchesBefore` 原先在 `loadBoundIntent` **之前**写 `conflict`，于是"意图被删/坏/未来版本/错绑定"的现场
  会被一次终态掩盖。现在**完整绑定提前到所有终态之前**（持锁复读 → 锁定目标 → 状态 → 绑定 → 分支），
  失败一律 `inconsistent`（与目标=after 同口径，`unreadable` 留给读不懂的目标文件），`changed=false`、journal 原字节保持 prepared、
  不发事件、不改业务/意图；合法绑定 + 目标后续合法更新仍按协议记 `conflict`（二次核对幂等）。
- F2：`boundary` 失败路径附加的是业务清理文案，审核工件提取器只认审核专用文案 → 三种现场 `artifactCleanup=[]` 而磁盘确有 `.tmp`。
  新增 `attachCleanupFailureNote`/`hasCleanupFailureMark`（**WeakSet 结构标记**，不改错误外形、不比对文案），boundary 两个失败点改用它；
  `cleanupFailureFromError` 先看标记再兜底文案。`exists` 撞名后读取取消/失败、恢复发布前取消、提交前抛错都在 rethrow 前把清理说明附到**原错误**（错误码不变）。
- 验证（实施方实跑）：六文件 **160 项全绿**；`npm test` **343 用例：341 通过、0 失败、2 权限 skip**（基线 326 未削弱，审核持久化 73 → 90）；
  `typecheck`、`selfcheck` 6 项、`check:format` 56 文件通过；根 `typecheck`、根 `check:format` 2014 文件、`processGuards` 2 项、`git diff --check` 通过。
- 未改：普通写 v1/C1 行为、五类 schemaVersion、共同目标锁、不重放/回滚、不自动抢锁；未做迁移/CLI/UI/模型工具，未改 PiRuntime，未读客户资料，未 `git add`/`commit`/`push`。
  状态：**C2BR2 实施完成、待独立复验**；边界见实施记录 §11.4。

## 2026-10-02 · 第十三轮独立验收与 C2BR2 任务

- 独立复跑完整 326 项（324 pass、0 fail、2 既有权限 skip）；审核/journal 六文件 143 项全绿；包内 typecheck/selfcheck 6 项/格式 56 文件、根 typecheck/格式 2014 文件/processGuards 2 项、diff whitespace 门禁通过。
- 独立生产 API 合成诊断确认 R1 修复、after 错绑定首次拒绝、before+事件首次拒绝、时钟回拨认领有效；真实 recovery 二次中断回归实际执行通过。R1/R3 与覆盖缺口关闭，不重做。
- F1（原 R2 遗留）：合法高 revision 目标配缺失/未来/错绑定意图仍被写成 conflict 终态。F2（原 R4 遗留）：底层失败带普通清理文案，审核提取器只认专用文案，writer/recovery 事件失败与 recovery 终态失败时实际留 `.tmp` 而公开清理字段为空。
- 新增第十三轮验收与 C2BR2 唯一任务，同步状态；只写文档，保留用户改动与既有历史删除，未改生产代码/永久测试/PiRuntime、未读客户资料、未 add/commit/push。不启动迁移/CLI/UI。

## 2026-10-02 · BM-02C2BR（实施方记录，后续独立结论见上节）

- **先红后绿**：先补失败回归（新增 `tests/storageReviewContracts.test.mjs`，writer/reconcile 各加一组新用例），
  再改实现；原"第一次 aborted、第二次 inconsistent"的断言按 R2 **替换**为"第一次就 inconsistent"并写明旧断言错在哪。
- R1：`validateReviewJournalRecord` 改为**真正执行** `ReviewJournalRecordSchema`（诊断走 `collectSchemaIssues`
  脱敏管道、类型来自 `validateShape`），递增关系复用 `collectAuditRevisionIssues`；新增
  `REVIEW_ARTIFACT_MAX_BYTES = 16 KiB` + `reviewArtifactLimit()`（配置只能收紧）；`assertEvidenceList()`
  在取锁与解引用之前校验 `evidence` 的形态/条数/字节/互斥。
- R2：持锁复读**先比锁定目标身份再判状态**；`loadBoundIntent` 复用 `compareAuditAssociation` 做逐项绑定比较；
  目标=before 时先读绑定的事件路径，**第一次**就把矛盾报成 `inconsistent`（不再先写 `aborted`）。
- R3：新增 `inspectBoundEvent()`（writer/recovery 共用）——已有且一致的事件**直接认领**，不受本次时钟影响；
  只在事件缺失时生成 recovery 发布事实，`now < decidedAt` 时**拒绝发布**；新增结论 `pending` 表达
  "业务已到 after、事件或终态待补"，发布失败/终态失败/发布后取消都用它；未发布前取消仍穿透。
- R4：新增 `ArtifactCleanupFailure` 与结果字段 `artifactCleanup`（逐件、始终存在），覆盖意图/prepared/事件
  （含 exists 撞名分支）/终态；提交前抛错把残留附加到原错误（错误码不变）。
- 新增回归：**真实 recovery 二次中断**（子进程发布 recovery 事件后、写终态前被 SIGKILL；新进程认领第一次事件、
  不重打时间、业务字节不变、仅清理其合成锁）。
- 验证（实施方实跑）：六个审核/journal 文件 **143 项全绿**；`npm test` **326 用例：324 通过、0 失败、2 权限 skip**
  （基线 295 未削弱，审核持久化 42 → 73）；`typecheck`、`selfcheck` 6 项、`check:format` 56 文件通过；
  根 `typecheck`、根 `check:format` 2014 文件、`processGuards` 2 项、`git diff --check` 通过。
- 未改：普通写 v1/C1 行为、五类 schemaVersion、共同目标锁、不重放/回滚、不自动抢锁；未做迁移/CLI/UI/模型工具，
  未改 PiRuntime，未读客户资料，未 `git add`/`commit`/`push`。状态：**C2BR 实施完成、待独立复验**。
  已知边界见实施记录 §10.6（含 `replaceJson` 清理诊断的既有语义差异）。

## 2026-09-30 · v0.8.0 身份与启动体验

- 将应用外部身份改为 BIOS Agent。
- 保留原架构，通过 Electron Builder NSIS 输出普通 Windows 安装程序。
- 安装器创建桌面和开始菜单快捷方式。
- 更新、反馈和仓库链接切换到 `TIAN3379/PiDeck_BIOS`。
- 移除原作者 AtomGit pre-push 和自动镜像工作流。
- 保留内部 PiDeck 兼容标识与数据目录，降低首轮改造风险。
- 类型检查、格式检查、身份改造定向测试和 Windows 打包版启动冒烟均已通过。
- 已生成 `BIOS-Agent-0.8.0-setup.exe`，代码已推送到 `BIOS_Agent` 分支；真实安装由用户执行以验证桌面快捷方式。

## 2026-09-30 · DSH 后端裁剪

- 删除 DSH host、runtime、插件、凭据、配置、会话归档与沙箱 Node 相关主进程实现。
- 删除 DSH 配置页、运行时控制、模型/技能/子代理/目标工具及 Web 端入口。
- 删除 DSH 打包资源、依赖、发布脚本、工作流、测试和专项文档。
- 将运行时后端类型收敛为 Pi 与独立生图后端；普通 Agent 创建、发送、历史、目标和自动化统一走 Pi。
- 保留 Pi portable Node 安装所需的通用归档解压能力，避免与 DSH runtime 实现耦合。
- `npm run typecheck` 与 `npm run build` 均通过。

## 2026-10-01 · BM-00/BM-01 BIOS Package 基线与骨架

- BM-00：核对本机 Pi 宿主 `@earendil-works/pi-coding-agent@0.87.1`（PATH 上的 `pi` 指向 `D:\BIOS_Pi_Agent\PiRuntime\pi.ps1`，bin 为 `dist/bundle/cli.js`），确认 Package/Extension/Skills 的真实契约：`pi.extensions` / `pi.skills` 清单、peer 白名单（`pi-ai`、`pi-agent-core`、`pi-coding-agent`、`pi-tui`、`typebox`，范围 `"*"` 且不打包）、jiti 直接加载 TS 无需编译、工具用 `defineTool` + `execute(toolCallId, params, signal, onUpdate, ctx)`、`SKILL.md` frontmatter 的 `name`/`description` 规则。
- BM-00：确认加载判据——`-e` 加载失败会在 stderr 报 `Failed to load extension` 且退出码 1，成功时静默；`-t/--tools` 对未注册工具名静默，**不能**作为 CLI 层工具注册判据。工具注册的硬证据改用 Pi 导出的 `discoverAndLoadExtensions()`（离线，不启动会话、不连模型）。
- BM-00：实测 `pi -e <包目录>` 会**同时发现** Package 的 Skills（`skill:bios-project-onboarding` 出现在 RPC `get_commands` 响应中），回答 `mvp_development_plan.md` §10 的开放问题；`-e` 不做来源隔离，宿主已有技能仍会出现。
- BM-01：新建 `packages/bios-agent` 最小 Pi Package：清单（只有 `peerDependencies`，只有 `typecheck`/`test`/`selfcheck`，刻意不提供 `build` 因而不进入 Electron 构建链）、独立 `tsconfig.json`（paths 指向 PiRuntime 的 Pi 声明文件 + `allowImportingTsExtensions` + `checkJs`）、`core/contracts`（五类记录 schema/类型/状态机 + 版本闸门 + 结构化错误码）、`core/paths`（知识根解析与路径逃逸防护）、`core/projects/probe`（有界只读线索探测，不读文件内容）、唯一扩展入口 `extensions/index.ts` 注册 `bios_detect_project`、两个 Skill、包内测试与自检入口。
- BM-01：最小只读工具只返回线索计数、样例相对路径与**资料缺口**，身份字段一律保持 `unknown`——厂商适配规则需要 BM-03 的真实样例验证，本轮不猜。
- 验证：包内 `typecheck` / `test`（20 个用例，含 Pi SDK 装载与 CLI `-e` 加载两条链路）/ `selfcheck` 全绿；根 `npm run typecheck` 通过；`npm run check:format` 通过；`pi -e <包目录>` 实测加载成功且 Skills 可见；工作区未改动 `src/`、`resources/`、根配置。
- 新增 `docs/bios-agent/desktop-integration.md`：记录桌面端扩展／技能加载与禁用开关的真实位置，并列出白名单模式丢包、双加载、热更新覆盖层三个风险点及正式接入要求。
- 已知限制：本轮只有 `bios_detect_project` 一个工具且不判定身份；没有存储层（锁、原子替换、revision 冲突、迁移属 BM-02）；没有检索、上下文预算与任务交接，Skills 中相关能力当前不可用；`tests/fixtures` 尚无样例数据（用户暂无真实 BIOS 项目）。

## 2026-10-01 · BM-01R 基础整改（R1～R6）

- R1：`core/projects/probe.ts` 改为 `fs/promises.opendir` 流式迭代 + 定期让出事件循环，**让出点之后立刻检查取消**；新增待处理目录与 warnings 上限，截断维度写入 `truncatedBy`；取消抛 `ProbeCancelledError`（失败结果，不是普通成功结果）。
- R2：移除 `D:\BIOS_Knowledge` 硬编码默认值，改为用户级 `<用户目录>/BIOS_Knowledge`；**相对知识根一律拒绝**（桌面与 CLI 的 cwd 不同）；桌面端由适配层注入 `userData/bios-knowledge`；测试改用真实平台 path 与真实临时目录。
- R3：新增 `core/contracts/ids.ts` 作为 ID 规则唯一来源（schema 的 `pattern` 与运行时校验共享同一份正则）——只允许小写、拒绝尾随点与 Windows 设备保留名、拒绝路径分隔符；项目 ID 与工作区标识改用 UUID；`resolveInsideRoot` 明确为词法检查，真实 IO 的链接策略留给 BM-02A。
- R4：`bindings` → `workspaces[]`，每个工作区独立保存 `workspaceId` / `path` / `availability` / 可选 `vcs`(branch、head、remoteUrl) / `capturedAt`；Task 与 Evidence 关联到具体工作区；无 Git 目录省略 `vcs`；结构仍为 `schemaVersion = 1`（写入能力未上线，不存在需要迁移的数据）。
- R5：包内声明 `devDependencies`（Pi 宿主 0.87.1）并提交锁文件；`tsconfig` 去掉 `paths`，宿主类型由包内 `node_modules` 解析；测试宿主缺失时**失败而非 skip**；RPC 用例改为临时 cwd + `PI_CODING_AGENT_DIR` 隔离，断言两个 BIOS Skills 可见且宿主技能未混入；`biome.jsonc` 纳入本包并提供包内 `check:format`；CI 新增本包 `npm ci` 与门禁步骤。
- R6：新增 `core/projects/authorization.ts`——默认授权根为会话工作目录，额外根只由适配层经 `BIOS_AUTHORIZED_ROOTS` 注入（模型无法用参数扩权）；realpath 比较拒绝链接逃逸；先授权后扫描，拒绝时不返回任何线索样例。
- 验证：包内 `typecheck` / `test`（**45 通过、0 失败、0 跳过**）/ `selfcheck`（5 项）/ `check:format` 全绿；根 `typecheck` 与 `check:format` 通过；`git diff --check` 通过。
- 踩坑：RPC 集成用例曾整体 60s 超时，根因是测试封装漏了 `--mode rpc`（Pi 以默认模式启动、永不回响应）。
- 当时整改细节与证据现合并于 `docs/bios-agent/acceptance_history.md`；R3 的真实 IO 层校验与存储事务属 BM-02A。

## 2026-10-01 · BM-01R2 第二轮收尾（F1～F4）

- F1（P1）：消除 ID 校验两条链的裂缝——保留名负向断言改为 `(?!(?:con|…|lpt[1-9])(?:\.|$))`，
  覆盖 `con.json` / `nul.txt` 这类带点后缀形式；运行时改为"先由**同一正则**判定是否接受、再分类错误码"，
  使 schema、`inspectKnowledgeId` 与路径入口对同一组输入给出相同结论（错误码仍可更细）。
- F2：知识根统一要求**完全限定的绝对路径**。Windows 上 `\BIOS_Knowledge` 的 `isAbsolute` 为真却依赖进程盘符，
  现在与 `C:name`、普通相对路径一并拒绝（合法形式：盘符绝对或 UNC）；新增纯函数 `isFullyQualifiedPath(value, platform)`
  支撑跨平台判定；`resolveKnowledgePaths` 的**字符串入口**同样校验，取消"绕过 resolveKnowledgeRoot 拿相对根"的旁路；
  默认 `home` 也遵守同一契约。
- F3：`probeProjectDirectory` 补齐取消检查点——函数入口、`await opendir` 之后、**每个条目**、
  `for await` 正常结束之后与**最终 return 之前**。小目录（条目数少于 `yieldEvery`）与空目录在调用后立即取消
  现在会抛 `ProbeCancelledError`，不再返回"成功但空"的结果。
- F4：额外授权根只接受完全限定绝对路径，非法配置抛 `invalid-authorized-root`（不再按进程 cwd 补全 `.` / `..`）；
  完全限定但不可达的根标记为 `unreachableRoots`（离线，与非法区分）；生效根按 realpath **去重**。
- 第 4 节收口：`resolveInsideRoot` 与 `isWithinAuthorizedRoot` 的逃逸判定改为精确匹配 `..` / `..` + 分隔符，
  根内合法的 `..cache` 目录不再被误判；probe 新增 `droppedWarnings` / `skippedDirectories`，告警触顶也会标记 `truncated`；
  RPC 测试封装补 stderr 上限、改用 `close` 收尾、补 stdin 错误处理，并新增工具层真实 AbortSignal 取消回归；
  README 写清"先装根工程依赖、再装本包依赖"的安装前提，并修正上限语义描述。
- 验证：包内 `typecheck` / `test`（**60 通过、0 失败、0 跳过**）/ `selfcheck`（5 项）/ `check:format` 全绿；
  根 `typecheck`、根 `check:format`、`tests/processGuards.test.mjs` 通过；`git diff --check` 通过。
- 当时整改细节现合并于 `docs/bios-agent/acceptance_history.md`；存储事务、真实 IO 链接策略与 registry 绑定属 BM-02A。

## 2026-10-01 · G1 修复 + BM-02A 存储基础

- G1：`core/projects/probe.ts` 把"成功 `opendir` 之后"的取消检查移入 `try` 保护范围。修复前取消会绕过 `finally`，句柄只能等 GC 关闭。新增 4 个回归：句柄 open/close 计数（取消、正常完成、预算截断、迭代中取消都要求 `closed === opened`），以及子进程 `--expose-gc` 诊断（3 次取消后显式 GC 不再出现 "Closing directory handle on garbage collection"）。
- BM-02A 契约：新增 `core/contracts/registry.ts`（`RegistrySchema` + 推导类型 + 空库工厂 + 复用同一版本闸门）。registry 只保存项目↔工作区↔桌面 projectId 的绑定关系，**不复制 branch/HEAD**（那是 ProjectProfile 工作区快照的职责）。
- BM-02A 存储：新增 `core/storage/`——结构化错误码与 errno 映射、可注入限额、IO 边界（canonical 知识根、根内链接拒绝、有界读取、非覆盖发布、布局创建、有界列目录）、registry 读取与显式初始化、记录读取与有界列表、绑定解析。
- 初始化发布协议：同目录临时文件 + `link()` 非覆盖发布，文件系统不支持硬链接时回退 `O_EXCL`。重复初始化返回 `existing` 且 registry 原字节不变；真实两个子进程同时首建不产生半文件、不互相覆盖（落后方得到 existing 或可重试的 `init-race`）。
- 边界策略：根内符号链接／junction 一律拒绝（目录段与最终文件），因此"根内链接指向根外"被拒绝且不触碰根外内容；**硬链接不在覆盖范围**（`lstat` 无法区分，已在 README 写明）；不宣称操作系统级沙箱，并记录检查与操作的竞态与信任假设。
- 记录读取：路径只能由受控 kind + ID 派生；文件位置、记录内 `id`、任务的 `projectId`（清单的 `targetProjectId`）必须一致，否则 `record-id-mismatch`；损坏 JSON、未来版本、超大分别返回 `invalid-json` / `unsupported-schema-version` / `too-large`，且**原文件字节不变**。
- 列表：`maxListEntries` / `maxListBytes` / `maxScanEntries` 三档预算与截断维度；单条损坏进入 `problems`，不整体失败也不当成"不存在"。
- 自检：`cli/selfcheck.mjs` 增加存储离线演示（临时库初始化 → 写入自建 fixture → 读取 → 破坏后拒绝且 hash 不变），现 6 项。
- 验证：包内 `typecheck`、`test`（**89 用例：88 通过、0 失败、1 显式 skip**）、`selfcheck`（6 项）、`check:format`（25 文件）；根 `typecheck`、根 `check:format`、`tests/processGuards.test.mjs` 通过；`git diff --check` 通过。
- 未测：文件型符号链接（本机 EPERM，显式 skip 并注明原因）、真实权限失败、告警上限触顶；Linux/macOS、干净 clone 独立工具链、远端 CI、生产构建与安装包均未运行。
- 实施细节与验收矩阵对照见 `docs/bios-agent/bm02a_implementation.md`；写事务、锁与迁移属 BM-02B/C。

## 2026-10-01 · 第一轮独立验收

- 结论：BM-00 本机基线通过，BM-01 骨架有条件通过；不将尚未开发的存储/经验/上下文/桌面功能计为本轮缺陷，也不宣称真实厂商适配已通过。
- 复跑 Package 类型检查、20 个测试（0 失败/0 跳过）、4 项 selfcheck，以及根类型/格式检查，均通过。根格式命令不覆盖 packages，Package 独立格式/CI 门禁仍待补。
- 使用空临时配置与 cwd、离线 RPC get_commands 再次确认两个 BIOS Skills 可见，没有发送 prompt 或调用模型；该断言尚未进入仓库测试。
- 发现需要整改：同步目录扫描不能及时处理中途取消、readdirSync 不受单目录预算限制；默认知识根写死 D 盘；Windows 保留名/真实 IO 链接边界未覆盖；多个 workspace 共用 branch/HEAD；本机依赖布局和 RPC 测试隔离不足；检测目标缺少授权根限制。
- 校正桌面接入文档中的解析器路径、独立白名单、同路径去重、依赖分发与自动化覆盖描述。
- 新增 round1_acceptance.md，给出 R1～R6、BM-01R 提示词和 BM-02A～D 存储验收批次；同步主方案和任务状态。
- 本次只检查/测试/更新文档，不修复源码，不提交或推送；未运行根全量测试、生产构建、安装版或真实 BIOS 项目验证。

## 2026-10-01 · 第二轮独立验收（BM-01R）

- 独立复跑：Package typecheck、45 个测试（0 失败/0 跳过）、check:format（16 文件）、5 项 selfcheck；根 typecheck/check:format（2014 文件）与 processGuards 2 用例，均通过。
- 确认主体整改已落地：流式异步扫描、工作区独立 VCS 快照、包内 Pi 0.87.1 类型/宿主、隔离 RPC Skills、Package CI 步骤与真实路径授权；本机链接逃逸测试实际执行。
- 额外诊断发现：F1 保留主名带后缀被 schema 接受但运行时拒绝；F2 Windows 无盘符知识根随 cwd 盘符漂移且 resolveKnowledgePaths 仍接受相对根；F3 小目录异步等待期间取消后仍返回成功；F4 额外授权根接受按进程 cwd 解析的相对配置。
- 结论修正为 BM-01R 有条件通过，不重做架构；先完成 BM-01R2 小收尾，再进入 BM-02A。已更新主方案/任务状态，并保留第一轮验收与实施方自测为历史依据。
- 新增 round2_acceptance.md：记录实测结果、R1～R6 闭环矩阵、F1～F4 复现与回归标准、BM-02A 的具体范围，以及下一位开发 AI 的可复制提示词。
- 按分阶段开发工作流补充 test_checklist.md，单独记录功能、异常、数据、兼容/回归及未验证范围，避免把既有自动化全绿等同于全部验收通过。
- 未验证根全量测试、生产构建/安装包、真实 BIOS 项目、远端 CI 或完整干净 clone；隔离安装补验被执行策略拒绝，未执行，不记为代码失败。tsc/Biome 目前仍依赖根工具链。
- 本次只读取/测试/诊断并更新文档，没有修复源码，没有提交/推送，没有修改真实 BIOS 业务项目。

## 2026-10-01 · 第三轮独立验收（BM-01R2）

- 独立复跑 Package typecheck、60 测试（0 失败/0 跳过）、check:format（16 文件）、5 项 selfcheck；根 typecheck/check:format（2014 文件）、processGuards 2 用例和 git diff --check 均通过。
- F1～F4 功能闭环：保留名后缀一致拒绝、所有知识根入口要求完全限定路径、小/空目录与工具层取消失败、额外根拒绝相对配置。安装前提、合法 ..cache、计数输出及 RPC 封装也有落实。
- 测试出现目录句柄 GC 关闭警告；独立连续三次在 opendir 等待期间取消，再 GC，得到三次相同警告。新增取消检查在 try/finally 外面，成功打开的句柄未及时关闭，列为 G1（P2）。现有取消断言不能证明资源释放。
- 结论：BM-01R2 功能通过，资源清理待收尾；下一轮只需先小修 G1 并补回归，门禁通过后在同一轮进入 BM-02A，不重做架构或再次铺开大整改。
- 新增 round3_acceptance.md 和 bm02a_development_plan.md，明确 registry、显式初始化、真实 IO 根/链接边界、有界读取、损坏保护和两进程首次初始化验收；普通记录/绑定更新仍留 BM-02B，journal/迁移留 BM-02C。
- 更新主方案、任务表、测试清单、桌面接入状态和历史文档导向；Package/锁文件仍未跟踪，远端 CI/干净 clone/根全量测试/生产安装版/真实 BIOS 平台未验证。
- 本次仅验收和更新文档，没有修复源码、提交或推送，没有修改真实 BIOS 业务项目。

## 2026-10-01 · 第四轮独立验收（G1 + BM-02A）

- 独立复跑 Package typecheck、89 测试（88 通过/0 失败/1 文件链接权限 skip）、格式 25 文件、自检 6 项；根 typecheck、格式 2014 文件、processGuards 2 用例及 git diff --check 均通过。
- G1 确定性资源回归和 GC 诊断通过；registry、初始化、读取、列表主体已经落地，未越界开发桌面 UI 或模型写工具。
- 用合成临时数据与受控 IO 故障注入复现：S1 wx 回退发布空 registry；S2 单条拒绝错项目任务但列表返回摘要；S3 读取增长文件只解析合法前缀、最后 IO 点取消仍成功；S4 非法候选文件名导致整体失败、problems 不计列表预算；S5 矛盾查询/多工作区任取首个及重复项目 ID 未拒绝。
- 结论：BM-01/G1 通过；BM-02A 主体有条件通过，先 BM-02AR 关闭 S1～S5，独立复验后再 BM-02B。不将普通记录更新、journal、迁移等尚未实施功能列成本轮缺陷。
- 新增 round4_acceptance.md 与 bm02a_remediation_plan.md（AR-1～3、9 组回归、提示词和 BM-02B 后续方向）；同步主方案、任务、README、测试清单与历史文档导向。
- 非空数据新进程读取、初始化逃逸、最终文件符号链接/真实 EACCES、跨平台/干净安装/远端 CI/生产安装版/真实 BIOS 平台未充分验证。Package/锁文件仍未跟踪。
- 本次只验收和更新文档；临时诊断脚本/合成数据已清理，没有修改生产源码/永久测试，没有提交或推送，没有修改 PiRuntime 或客户 BIOS 项目。

## 2026-10-01 · BM-02AR 存储边界收尾（AR-1～AR-3，关闭 S1～S5）

- S1（AR-1）：`publishJson` 删除直写最终目标的 `wx` 回退，固定"同目录完整临时文件 → `link()` → 删临时文件"，`finally` 保证临时文件不残留；链接失败经 `classifyLinkFailure` 分派为 `exists` / `publish-unsupported` / `permission-denied`，都不创建目标文件；初始化竞争重试改为白名单（仅 `not-found`/`init-race`），`sleepWithCancellation` 前后检查取消，不再把取消/权限/永久错误写成 `init-race`。
- S2/S3（AR-2）：抽出共享校验链 `interpretRecord`（版本 → kind schema → 文件/记录 ID → `projectId`/`targetProjectId`），单条与列表复用，kind→解析器改为类型化映射（无 `any`/`as never`）；`readJson` 改为分块读到 EOF 或上限 +1，`stat` 仅作预检，未到 EOF 不解析前缀，每个 IO 等待点后及**循环后/返回前**都检查取消，`finally` 关闭句柄；新增 `throwIfAnyCancelled` 作为取消检查单一出口；列表 `catch` 用 `rethrowIfCancelled` 让整体取消穿透，不混入 `problems`。
- S4（AR-3）：新增 `maxListProblems`；`resolveStorageLimits` 忽略显式 `undefined` 并拒绝 `NaN`/`Infinity`/负数/非整数（`invalid-limits`），返回新对象不污染默认值；条目与 `problems` 共用 `maxListBytes`，按实际输出字段计量，超限返回 `truncatedBy` 与 `droppedProblems`/`skippedEntries`；`listEntries` 新增 `includeSymlinks`，链接既不静默消失（交回 `assertNoSymlinks` 明确拒绝）也不读取目标正文。
- S5（AR-3）：`inspectBindingIssues` 新增 `duplicate-bios-project`，`biosProjectId` 唯一性先于解析；`resolveProjectBinding` 区分 `contradictory-filters`、`missing/no-match`、`ambiguous-workspace`，路径属于 A 而显式项目为 B 时不返回 A 的 resolved，多工作区仅给项目 ID 不再取首个。
- 新增 `tests/storageRemediation.test.mjs`（18 条永久回归，故障注入 `StorageIoHooks` 确定性复现特殊分支）；两处既有用例期望按新契约更新：同路径跨项目 → `inconsistent-registry`、多工作区仅项目 ID → `ambiguous-workspace`（预期行为变更，非缺陷）。
- 验证：包内 `typecheck` / `test`（**107 用例：106 通过、0 失败、1 文件符号链接权限 skip**）/ `selfcheck`（6 项）/ `check:format`（26 文件）全绿；根 `typecheck`、根 `check:format`（2014 文件）、`tests/processGuards.test.mjs`（2 用例）、`git diff --check` 通过。
- 未测：跨平台（Linux/macOS）、干净 clone 独立工具链、远端 CI、生产构建与安装包、真实多进程首发竞争与真实权限失败；文件型符号链接在本机仍 skip，目录 junction 逃逸用例本轮实际执行。
- 实施细节、S1～S5 实现/回归证据与未测项见 `docs/bios-agent/bm02a_remediation.md`；本轮未 `git add`/`commit`/`push`，交回独立验收；写事务/锁/迁移属 BM-02B/C。

## 2026-10-01 · 第五轮独立验收与 BM-02B 排期

- 独立复跑 Package 107 用例（106 通过、1 文件符号链接 EPERM skip）；新增 18 条均通过；类型/格式/selfcheck 与根类型/格式/processGuards 通过，`git diff --check` 通过。既有真实双进程初始化用例此次实际复跑通过。
- S1/S2/S4/S5 关闭；S3 增长读取及读取/列表/竞争等待取消通过。另以独立临时根诊断确认 `publishJson` 忽略 callSignal、提交钩子等待返回后漏查取消，两种情况仍 created；列为 P2/B0，不把 S3 写成全部关闭。
- 验收结论：BM-02AR 主体有条件通过，进入 BM-02B，先 B0 小修再新增单记录跨进程安全写入；不再重做整轮整改。
- 新增 `round5_acceptance.md` 与 `bm02b_development_plan.md`（含可复制开发提示词），同步主计划/任务/测试/接入说明/README；修正文档默认问题数 64→50，澄清列表字节预算语义。
- 本次只更新文档，未修改生产代码、未提交/推送；未执行远端 CI、构建/安装包或真实 BIOS 试点。前述实施方日志保留为历史记录，以第五轮独立报告为最新结论。

## 2026-10-01 · BM-02B 跨进程写入协议（实施方自测）

- B0：`publishJson` 接受 `callSignal`，在**入口 / 临时文件写完后 / 提交钩子返回后 / 提交 IO 发起前**四个点检查取消（第三个点正是第五轮漏掉的那个：钩子是一次真实 `await`，等待期间取消必须生效）；取消错误经 `isCancelledError` 穿透 `catch`，不再被归成"链接失败"。**提交点语义**：`link` 成功即已创建，此后到达的取消不改口、不回滚。补 3 条永久回归（两 signal 任一取消、`beforeIo(link)` 等待期间取消、link 成功后迟到取消仍返回真实 `created`）。
- B1：新增 `core/storage/write.ts`（`createRecord` / `updateRecord` / `updateRegistry`）。`expectedRevision: null` = "要求不存在"（只用于 create），数字 = "要求存在且相等"（只用于 update）；成功返回的 `revision` 是提交后的值（create=0，update=旧值+1）。八种不匹配全部 `revision-conflict` 且带 `expected`/`actual`：旧 revision、update 目标缺失、create 目标已存在、负数/小数/字符串、update 传 `null`、**create 传数字**（会退化成"要求存在且相等"却仍报 `created`）、**`revision+1` 溢出**（乐观并发会静默失效）。`schemaVersion`/`revision`/`createdAt`/`updatedAt`/`id`/归属字段由存储层生成，业务正文携带即 `invalid-record`；`updatedAt = max(now, 旧值)` 不倒退；写前跑与读取**完全相同**的 `RECORD_SCHEMAS` 校验，避免"写成功但读不出来"。
- B1：损坏记录**不当作"不存在"**（旧行为会把一次损坏谎报成新建成功）；错误归属记录拒绝覆盖（否则会把记录搬到错项目）。
- B1：`updateRegistry` 复用初始化校验 + `inspectBindingIssues`，重复 `biosProjectId` / 同一路径归属两项目 / 重复 `desktopProjectId` 一律 `binding-conflict` 且不落盘；空 `projects` 合法；**不改写、也不创建任何档案文件**（已存在档案 hash 断言不变）。
- B2：新增 `core/storage/lock.ts`。锁是知识根内 `locks/` 下的**目录**（`mkdir` 原子性判定归属，不用"先 exists 再创建"，不用 `O_EXCL` 文件锁）；锁名 = 受控相对目标的 SHA-256 前 32 位（Windows 先小写归一，避免同一文件两个锁名）；`owner.json` 只放 `ownerId`/`pid`/`createdAt`/目标相对路径；元数据缺失或损坏按**忙碌**处理，**绝不抢占**（没有原子 compare-and-swap，判活与删除之间持有者可能刚好写完，因此只做有界等待 + 诊断，把人类决策留给人）；等待有界且可取消（`lockTimeoutMs`/`lockPollMs` + `delayWithCancellation`），超时错误带持有者诊断但不含正文；释放前校验 `ownerId`，不是自己的锁只报告（`not-owner`/`missing`）。
- B2：**释放锁忽略取消信号**（新增 `boundary.readJsonForCleanup`，只给释放用）。锁没有回收器：若"用户取消写入"能阻止清理，一次取消就会把锁永久留在磁盘上、此后所有写者都超时。写入/读取路径的取消语义不受影响；`lockRelease` 结果在写入结果里如实上报（`released`/`not-owner`/`missing`/`failed`），释放失败不会把已提交的写入改口成失败。
- B3：新增 `boundary.replaceJson`，`createRecord`/`updateRecord`/`updateRegistry` **共用同一条提交路径**：`ensureDirectory` → `assertNoSymlinks` → 同目录 `.<name>.<pid>.<8hex>.tmp`（`wx`，非覆盖）→ 写完整 → `sync()` → `close()` → **再次** `assertNoSymlinks`（写入期间路径可能被换成链接，`rename` 会跟随它写到根外）→ `rename`（**提交点**）→ 清理临时文件。限额按**实际 UTF-8 字节数**与字符数拦截；Windows `EBUSY`/`EPERM`/`EACCES` 有界可取消重试（最多 6 次尝试、25ms×次数线性退避，其它错误码立即失败，绝不回退成"先删后写"）；失败路径保证临时文件被删、句柄被关、目标原字节不变；提交后只报告真实状态（清理失败体现在 `cleanup` 标记里）。
- B4：新增 `tests/storageWrite.test.mjs`（**30 条**）覆盖五类 create/update（含一次真实 `spawn` 读回）、registry 更新与重复绑定、revision 冲突 8 态、**真实双子进程创建/更新竞争**（`spawn` ×2 + 会合点：恰好一方提交、另一方 `revision-conflict` 且内容与赢家一致）、提交窗口可见性（在 `rename` 之前真的读一次，临时文件同目录且不叫目标名）、真实并发反复读写（子进程读 60 次 / 主进程更新 15 次，0 错误、revision 单调不减）、锁超时/取消/失败释放/`ownerId` 不匹配/坏元数据不抢占、`write-temp`/`sync`/`rename` 三类故障注入、提交前取消与提交后迟到取消、非法 kind（运行时守卫）/托管字段/跨项目档案、超限写入、未初始化、根内 junction 写入逃逸。前两者用 `spawnSync`，竞争必须用异步 `spawn`（`spawnSync` 会串行化），子进程一律带超时与输出上限。
- 验证：包内 `typecheck` / `test`（**140 用例：139 通过、0 失败、1 文件符号链接权限 skip** = 第五轮 107 + B0 回归 3 + 新增 30）/ `selfcheck`（6 项）/ `check:format`（29 文件）全绿；根 `typecheck`、根 `check:format`（2014 文件）、`tests/processGuards.test.mjs`（2 用例）、`git diff --check` 通过。
- 未测：真实 EACCES 与真实 `EBUSY` 重命名竞争（本轮注入 `EIO`/`EBUSY` 只覆盖分支）、跨平台（Linux/macOS）、干净 clone 独立工具链、远端 CI、生产构建与安装包；文件符号链接在本机仍 skip（目录 junction 用例本轮实际执行）。
- 明确不做：删除记录、自动绑定/档案联动、journal/迁移（BM-02C）、备份 CLI（BM-02D）、UI、RAG、模型写工具、Pi 内核改造；"registry 更新成功"不写成事务成功。
- 实施细节、验收矩阵对照与未测边界见 `docs/bios-agent/bm02b_implementation.md`；本轮未 `git add`/`commit`/`push`，交回独立验收，**不自动继续 BM-02C**。

## 2026-10-01 · 第六轮独立验收与文档精简

- 实际复跑 Package 140 用例：139 通过、1 文件符号链接 EPERM skip；B0、30 个写入用例及真实多进程竞争通过。包内类型/格式（29 文件）/selfcheck（6 项），根类型/格式（2014 文件）/processGuards（2 项）通过。
- 独立合成库诊断：registry 在 MAX_SAFE_INTEGER 后连续更新得到相同 unsafe revision；NaN 锁超时失去 deadline；极端锁日期抛 RangeError；lock-read 中 abort 被超时覆盖；close EIO 被吞后仍提交；坏 registry 下仍可创建记录。判定主流程通过但 W1～W4 未闭环，新增 `round6_acceptance.md` 与唯一当前任务 `next_development.md`。
- 下一轮限定 BM-02BR 四组收尾，不重做已通过能力；收尾复验后再制定 BM-02C1 journal，暂不叠加恢复协议/迁移/UI。
- 按用户要求删除 6 份已被替代文档：第一至第四轮验收、第一/第二轮整改；它们没有未提交修改且原文在 Git `36eb385a` 可恢复。合并关键历史结论到 `acceptance_history.md`，新增导航 `README.md`，更新活动链接与旧计划状态。
- 纠正 Package README“写能力尚未实现”、实施记录“整个 packages 未跟踪”等陈旧表述；历史实施方自测不改成独立通过。
- 本次没有修改生产代码或测试，不 commit/push；未执行真实客户试点、跨平台、远端 CI、生产构建/安装包。诊断临时库与独立进程 IO 包装均已清理/还原。

## 2026-10-01 · BM-02BR 中断交接检查（未完成验收）

- 用户确认按原路线开发，不提前做 UI；上一开发对话上下文中断，当前只检查进度、整理接续文档，不代替实现方完成修复。
- 磁盘已新增 revision.ts / commit.ts，并有安全 revision、锁参数/诊断取消、正常 close、create link 非覆盖发布、有效 registry 准入及 W1～W4 回归；原始任务不要从头重做。
- 本次实跑：Package 158 测试（157 pass、0 fail、1 文件 symlink EPERM skip）、typecheck、selfcheck 6 项通过；Package 格式检查 31 文件、revision.ts 失败。根类型、格式 2014 文件、processGuards 2 项、git diff --check 通过。
- 独立合成库诊断确认：timeout=10/poll=1000 的锁请求未在预算附近超时，由 120ms watchdog 取消后约 121ms 返回 cancelled；revision 冲突 + lock-remove EIO 保留原错误却遗漏残留自有锁诊断。目标原 hash 不变，诊断临时库已清理。两项尚待永久回归与最小修复。
- 新增 bm02br_handoff.md，列出剩余 R1～R4、生命周期/create/W4 补证据、格式/文档收口与自包含接续提示词；同步导航、当前阶段入口和任务状态。没有新增实施完成报告，没有改动生产代码或永久测试，没有提交/推送，没有继续 journal/UI。

## 2026-10-01 · BM-02BR 接续收尾（W1～W4 + 交接 R1～R4，实施完成待独立复验）

- R1（先红后绿）：`lock.ts` 的失败等待分支仍直接用 `timing.pollMs`，导致"合法 poll 远大于 timeout"时把 10ms 预算拖成约 1.2s（交接时的独立诊断是 120ms watchdog 取消收场）。改为 `Math.min(pollMs, deadline - Date.now())`（进入该行时剩余预算至少 1ms，不会退化成零间隔忙等）。新增「W2：合法但超长的 poll 不得让等待越过 timeout 预算」（watchdog 只兜底、必须以超时收场、`< 500ms`、不抢占）与「W2：timeout=0 只尝试一次…」；修复前实测 1192ms 红。
- R2（先红后绿）：`runUnderLock` 的 catch 原来 `catch(() => undefined)` 吞掉释放结果。抽出 `lockReleaseNote()` / `releaseOwnLock()`（释放抛错收敛为 `failed`、**仍忽略取消**），失败路径用 `attachCleanupNote` 附加固定文案且保留原 `code`/`path`/`detail`/`expected`/`actual`；`commitRecord` 的 `exists` 分支按 `published.cleanup` 决定是否附加清理诊断。新增 3 条回归（释放抛错、`not-owner`/`missing`、`exists` + 清理失败）。
- R3（补证据，不加功能）：句柄生命周期改为捕获真实 `FileHandle` 并断言 `fd === -1`，覆盖正常/`sync` 失败/打开后取消/`close` 先关后抛/`open` 前失败（后者要求 `closeFile` 调用 0 次）；create 公开路径补硬链接不支持、发布等待期间取消、提交后迟到取消；补 `rename` 重试预算三条（3 次失败后成功、始终失败恰好 12 次约 2.2s、退避期间取消 `< 1s`）；W4 补"先有合法记录再损坏 registry"四场景与"registry 换成目录 junction / 文件 symlink"（junction 实跑、文件 symlink EPERM 显式 skip）。
- R3：`commit.ts` 中"本机实测…"的注释无实施记录支持，已改为标称预算说明（延迟序列理论总和约 2.05s、先触达次数上限），并声明不以此作为"共享冲突已消除"的依据。
- R4：定向 `biome format --write core/storage/revision.ts`（此前 CRLF，包内格式门禁唯一失败项），未改配置、未全仓库改写；`index.ts` 中"本轮只读"的过期头注释改为当前范围并显式声明 journal/迁移未实现；README 修正 create（`link` 非覆盖发布）/update+registry（`rename`）的提交路径、锁参数范围与 poll 预算裁剪、失败路径释放诊断、W4 准入、真实统计与已知限制（删除"已知 W1/W3"与"create/update 都走 rename"等过时表述）。
- 验证（实施方实跑，2026-10-01）：包内 `typecheck` 通过；`npm test` **183 用例：181 通过、0 失败、2 显式 skip**（均为文件型 symlink EPERM）；`selfcheck` 6 项通过；`check:format` 31 文件通过；根 `typecheck`、根 `check:format`（2014 文件）、`tests/processGuards.test.mjs`（2 项）、`git diff --check` 通过。
- 未测：根全量测试、生产构建/安装包、干净 clone 独立工具链、远端 CI、Linux/macOS、真实客户试点；真实 EACCES 与真实 `EBUSY` 竞争仍未造出。故障注入只复现分支，不代表本机磁盘真的出过故障。
- 新增 `docs/bios-agent/bm02br_implementation.md`（唯一实施记录：W1～W4 对照、R1～R4 改动、实跑命令、skip 与未测、体量取舍），并把 `bm02br_handoff.md` 标为"已接续完成"保留为历史快照；同步任务/测试/导航。状态为**实施完成、待独立复验**，不把 BM-02B/BR 标为完整独立通过；未 `git add`/`commit`/`push`，未读真实客户资料，未继续 journal/迁移/备份/UI。

## 2026-10-01 · 第七轮独立验收与 BM-02C1 排期

- 独立读取源码/回归/实施记录，Package 测试复跑 183 用例（181 通过、0 失败、2 文件 symlink EPERM skip）；包内类型/格式 31 文件/selfcheck 6 项，根类型/格式 2014 文件/processGuards 2 项、git diff --check 均通过。真实双子进程竞争、新进程读回、并发读取、目录 junction 实际执行。
- 独立合成临时库再验证安全 registry revision、超长 poll 的 deadline（10ms 配置约 31ms lock-timeout）、极端锁日期、冲突与锁释放 EIO 的有界诊断、真实句柄关闭、定时器在实际 rename 退避中取消、坏 registry 保护既有记录；原 hash 不变，临时诊断库/锁已清理。
- 结论：BM-02BR 在声明的本机协作式文件系统范围通过，W1～W4/R1～R4 关闭；不把文件权限 skip、跨平台、生产安装/远端 CI、真实客户试点记为通过。
- 新增 round7_acceptance.md 与 bm02c1_development_plan.md；C1 限定有界单文件意图、真实字节 fingerprint、提交后记账失败真实上报、持锁核对结果/幂等收口。恢复不重放旧业务内容、不按 PID/年龄偷锁，锁无法确认仍需人工处理；C2/D/UI 不提前实施。
- 同步导航/任务/测试/主计划/Package README/接入说明，旧 BR 完成标准和交接保留历史入口，未再删文档。本次只有验收与文档编辑，没有改生产源码/永久测试，没有实现 journal，没有 add/commit/push。

## 2026-10-01 · BM-02C1 单文件 journal 与崩溃后结果核对（实施完成待独立复验）

- 协议先行：先把状态机/数据提交点/错误结果/API/预算/锁边界写进 `docs/bios-agent/bm02c1_implementation.md`，再编码；C1 明确**保守**——只记录意图与核对结果，**不重放、不回滚、不自动回收遗留锁**。
- C1-1：新增 `core/storage/journal/contract.ts`（类型 + 受控路径派生 + 不可信输入校验：journalVersion/枚举/小写 UUID/前后 revision 关系/时间范围/目标 kind 与归属/未知字段）；`boundary.ts` 的 `readJson`/`publishJsonMeasured`/`replaceJson` 增加 **fingerprint**（实际读到/写下的字节 SHA-256，未新增无上限 readFile）；`registry.ts` 新增 `readRegistryWithFingerprint`（校验与指纹同源）；`limits.ts` 增加 5 个 journal 限额（含 0 语义）；`commit.ts` 增加 `payloadFingerprint`，`closeFile` 注入点补 `tempPath` 便于按路径区分。
- C1-2：新增 `journal/writer.ts`（prepared 用 link 非覆盖发布、终态用 rename，均走低层原语不递归）+ `journal/wiring.ts`（`commitUnderJournal`）；`write.ts` 三类入口在**预算与 schema 校验后、数据提交前**发布 prepared，成功结果新增 `journal` 字段。**数据提交点仍是 `link`/`rename` 成功**：终态写失败或迟到取消只返回 `needs-recovery` + 含 operationId 的警告，绝不改成"未提交"、绝不重复递增 revision；提交前失败尽力记 `aborted`，写不进去则保留 `prepared` + 有界诊断。
- C1-3：新增 `journal/inspect.ts`（只读、有界、目录不存在=空结果、候选/问题/扫描/字节四维预算、`.tmp` 与非 `.json` 只跳过不删除、取消穿透）与 `journal/reconcile.ts`（只对终态免锁幂等；`prepared` 必须先取目标原有协作锁、持锁复读 journal 与目标指纹；committed/aborted/conflict/unreadable/busy 判定；`busy` 一个字节都不改，不按 PID/年龄抢锁）。
- C1-4：新增 `tests/storageJournal.test.mjs`（23 条）。真实退出用 `spawn` + 检查点标记 + 父进程确认退出后 `SIGKILL`，覆盖 `prepared`/`temp-ready`/`committed`/`final` 四个检查点 ×（create/update），registry 额外覆盖"已提交但终态未写"；每个检查点都断言"未清锁前核对不改任何文件"，且**遗留锁只由 harness 在确认子进程退出后清理**（产品不自动抢锁）。
- 体量红线：`write.ts` 一度到 676 行、`boundary.ts` 612 行，因此抽出 `journal/wiring.ts`（105 行）与 `pathBoundary.ts`（54 行，纯路径判定，`boundary.ts` 仍转发导出 `describeJsonParseFailure`），两者都是移动+转发，行为与公共 API 不变；最终 `boundary.ts` 578 行、`write.ts` 576 行。
- 既有回归的机械化收窄：journal 接入后一次写入多了 journal 自身的提交，按操作名注入的既有用例补 `isJournalPath(target)` 过滤（**未删改任何断言**），并给 `closeFile` 注入点加路径参数以便区分。
- 验证（实施方实跑，2026-10-01）：包内 `typecheck` 通过；`npm test` **206 用例：204 通过、0 失败、2 显式 skip**（均为文件型 symlink EPERM）；`selfcheck` 6 项、`check:format` 39 文件通过；根 `typecheck`、根 `check:format`（2014 文件）、`processGuards`（2 项）、`git diff --check` 通过。
- 未测：仓库根全量测试、生产构建/安装包、干净 clone 独立工具链、远端 CI、Linux/macOS、真实客户试点、断电（`SIGKILL` ≠ 掉电）、无人值守遗留锁回收（明确未实现）。故障注入只复现分支，不代表本机磁盘真的出过故障。
- 本次未 `git add`/`commit`/`push`，未读真实客户资料，未做 C2 审计/多文件/迁移、未做 D 备份 CLI、未提前做 UI。状态：**实施完成、待独立复验**。

## 2026-10-01 · BM-02C1R（第八轮 J1～J4 收尾：先红后绿 + 最小修复）

- 第八轮独立验收在 C1 主流程通过的前提下指出 4 项已复现问题（J1 持锁期间换目标仍按旧锁收口、J2 目标只校验 revision、
  J3 抛错路径丢掉锁残留诊断、J4 用估算字符数冒充字节预算）。本轮只做这 4 项：先写 14 条永久回归（13 红 1 绿）再最小修复。
- C1R-1（J1）：新增 `journalTargetKey()`（由 `journalTargetSegments` 派生，覆盖 kind/id/**projectId**，因此"key 相同"等价于
  "同一把锁 + 同一个文件"）；`reconcileJournalOperation` 持锁复读 journal 后比对锁目标与 journal 目标，不一致 →
  `unreadable` + `changed=false` + `observed=null`（不冒充观测过新目标），**不追新目标重新加锁**（否则是无界追逐）。
- C1R-2（J2）：`readTargetFingerprint` 改为"**同一次有界读取** → 同源解释 → 再取该份字节的哈希"：记录复用 `interpretRecord`，
  registry 复用新抽出的 `interpretRegistryValue`（`readRegistryWithFingerprint` 改为调用它，避免两条链漂移）。
  于是 `schemaVersion: 999`、结构残缺、路径 ID 与内容 ID 不符、项目归属不符、registry 绑定冲突都变成 `unreadable` 且原字节不变——
  即使这些非法目标的真实 hash 恰好等于 journal 的 `after`（用例专门构造了这条）。
- C1R-3（J3）：抛错路径改为"**首错优先** + `attachCleanupNote` 附加固定诊断"（原来先 `throw failure` 导致"磁盘上多了一把锁"这件事完全不可见）；
  同时转发终态写入失败时已附带的清理诊断，并在**成功**收口时传递 `finalized.cleanup === "failed"`。
- C1R-4（J4）：`inspectPendingJournal` 的输出预算改为覆盖 `pending` 数组的**实际 UTF-8 序列化字节**
  （信封 `[]` + 逗号 + 每条 `JSON.stringify` 计量），逐条判定、不预先攒齐；估算函数删除。
  `limits.ts` 注释同时写清"该预算只约束候选数组，不是整个返回对象的硬上限"。
- 验证（实施方实跑，2026-10-01）：`node --test tests/storageJournal.test.mjs` **37 项全绿**（原 23 + 14）；
  包内 `npm test` **220 用例：218 通过、0 失败、2 显式 skip**（206 基线未削弱、未新增 skip）、`typecheck`、`check:format`（39 文件）、
  `selfcheck`（6 项）；根 `typecheck`、根 `check:format`（2014 文件）、`processGuards`（2 项）、`git diff --check` 通过。
- 未测不变：断电实验（`SIGKILL` ≠ 掉电）、Linux/macOS、干净 clone、远端 CI、生产构建/安装包、真实客户试点；
  仍**没有**自动抢锁/按 PID 或年龄回收锁的路径，也不新增 `force`。
- 文档：`bm02c1_implementation.md` 追加 §6（J1～J4 对照、约定、实跑、未测）并修正"确认退出后 SIGKILL"的笔误
  （实际顺序：checkpoint → 终止 → 等待 close → harness 清理自己 fixture 的锁）；同步导航/任务/测试。
  未 `git add`/`commit`/`push`，未做 C2/D/UI。状态：**C1+C1R 实施完成、待再次独立复验**。

## 2026-10-01 · 第八轮独立验收与 C1R 排期

- 独立复跑 Package 全套：206 项/204 pass/0 fail/2 文件 symlink 权限 skip；类型、格式 39 文件、selfcheck 6 项通过。根类型、格式 2014 文件、processGuards 2 项、diff 检查通过。首次守卫命令误写文件名后已纠正重跑，不作为产品问题。
- 新建临时合成库，通过公开 API 和受控 IO 检查点复现 4 项：J1 持 A 锁将 B journal 错记 committed（B hash 实际不匹配）；J2 schemaVersion=999 目标仍改终态 conflict；J3 中途取消+释放 EIO 留锁但没有诊断；J4 300 字节预算返回 363 字节 pending 数组且未标截断。诊断不计入永久测试数量，全部临时根已安全清理。
- 结论：C1 主流程通过但未完整通过，下一轮只做 C1R-1～4，先红后绿补回归，不重做 BR，不进入 C2/D/UI。新增 round8_acceptance.md 与 bm02c1_remediation_plan.md，并同步当前导航/任务/测试/主方案/Package 状态。
- 分阶段 MVP 技能用于限定本轮收尾范围；文档写作技能用于将实测结论与开发任务分开，保留真实 skip/未测，不把门禁全绿写成完整验收通过。
- 本次只更新文档，没有修改生产源码/永久测试，没有增加历史文档删除；保留用户所有累积修改/未跟踪文件/既有删除，没有 git add/commit/push，未碰客户资料或 PiRuntime。根全量、安装包、远端 CI、跨平台、断电与真实 BIOS 试点未测。

## 2026-10-01 · 第九轮独立验收与 C2A 排期

- 独立复跑 Package 220 项：218 pass、0 fail、2 文件 symlink 权限 skip；journal 针对性 37 项全部通过。包内类型、格式 39 文件、selfcheck 6 项及根类型、格式 2014 文件、processGuards 2 项、diff 检查通过。
- 通过公开 API 独立重跑 J1～J4：换目标保留 journal 与 A/B 原字节，未来版本/非法结构不写终态，取消或普通 IO 后释放失败的诊断保留，实际字节预算准确。额外复查非法目标 revision/hash 同时匹配、非法 registry 精确匹配和 0/1/2/300/精确边界。临时合成根已安全清理，诊断不计入永久测试数。
- 结论：C1/C1R 在声明的本机范围通过，J1～J4 关闭；不冒充断电、跨平台、远端 CI、安装包或真实 BIOS 试点完成。
- 新增 round9_acceptance.md 和唯一当前任务 bm02c2a_development_plan.md，同步导航、task/test/log、MVP、Package 与旧计划状态。按分阶段 MVP 技能将 C2 拆为纯审计契约/校验及协议（C2A）、后续最小审核持久化一致性（C2B）；迁移/备份/UI 另排。文档写作技能用于区分实测结论、历史实施证据与未来任务。
- 本次仅改文档，没有修改生产源码/永久测试，没有新增文档删除，没有 git add/commit/push；保留用户累积修改、未跟踪文件及既有历史删除。未改 PiRuntime，未读取客户资料。

## 2026-10-01 · BM-02C2A（审核审计契约与一致性协议，纯契约无 IO）

- 协议先行：先写 `docs/bios-agent/bm02c2a_implementation.md`，把提交点、顺序、落点、四类窗口的恢复判定、
  人工决定与恢复观察的区分、锁、journal v1 兼容、权限边界、未来最小 API 与 C2B 的 IO checkpoint 清单定成**唯一推荐**，
  再编码。核心取舍是**审计事件后于数据提交点**（意图先于数据）：反过来会出现"审计说状态变了、业务没变"，
  而排在后面最坏只是"记录已提交、审计暂缺"，可由已落盘的审核意图补发（`publication: "recovery"`）。
- C2A-2：新增 `core/contracts/audit.ts`（200 行）——独立 `AUDIT_SCHEMA_VERSION = 1`、`AuditEventSchema`
  （eventId/operationId 规范 UUID、只接受 `experience-card` + `recordId` 的受控目标、5 个动作与状态对的唯一表、
  声明式 `operatorLabel`/`reason`/`decidedAt`、`before`/`after` 指纹（`after = before + 1`）、≤32 条只存引用与短说明的证据、
  `publication`/`recordedAt`），全部上限常量与 `readAuditVersion`/`isLegalAuditTransition` 等纯 helper。
  五类记录、`schemaVersion = 1`、`journalVersion = 1` 与 storage API 均未改动。
- C2A-3：新增 `core/contracts/auditValidation.ts`（349 行）——`validateAuditEvent(unknown)` 纯函数，
  分层：版本闸门（未知版本只报一条、不猜格式）→ schema（类型/枚举/必填/长度/条数/格式/数值范围）→
  语义（动作↔状态对、`after = before + 1` 与溢出、`recordedAt ≥ decidedAt`、标签/理由字符与 UTF-8 字节双预算、
  证据形态互斥与总字节、单条事件总量）。issue 为 `{ code, path, message }`，最多 20 条 + `droppedIssues`；
  未声明字段只报"名称已省略"，路径白名单化（未知片段 → `<unknown>`），长度/格式错误不回显字段值；校验不修改输入。
- 取值纪律（写进注释与文档，防止后来者改回"装饰性规则"）：`字节上限 < 3 × 字符上限`，否则在 UTF-16 计数下
  该规则永远不触发（理由因此从 1536 改为 1024）；总量 16 KiB 是兜底闸门，用"分项之和 ≤ 总量"的不变式测试守住。
  另一条：越界数值由 schema 拒绝、关系与溢出由语义层拒绝，语义层里的安全整数确认是防御性代码，不算被覆盖的规则。
- C2A-4：新增 `tests/auditContracts.test.mjs`（15 条）：合法样例（冻结实例、不改输入）、未知版本只报一条、
  未知字段脱敏、UUID/recordId、动作-状态表逐条对照、revision 关系与溢出、时间先后、文本双预算（85/86 汉字、341/342 汉字）、
  证据形态与总字节、最大合法事件不被总量误报、序列化口径与循环引用、路径脱敏、恶意大输入的诊断有界（64→20 丢弃计数精确）、
  既有契约不变；15 项全绿。
- 验证（实施方实跑，2026-10-01）：包内 `node --test tests/auditContracts.test.mjs` 15 项全绿；`typecheck` 通过；
  `npm test` **235 用例：233 通过、0 失败、2 显式 skip**（220 基线未削弱）；`selfcheck` 6 项；
  `check:format` 42 文件通过；根 `typecheck`、根 `check:format`（2014 文件）、`processGuards`（2 项）、`git diff --check` 通过。
- 未做（明确不声称）：没有审计目录/写入口/恢复器（协议只是设计）；没有身份认证与权限模型；
  没有 `verified` 的领域证据规则；没有 journal v2/迁移；未执行根全量测试、生产构建/安装包、干净 clone、远端 CI、
  Linux/macOS、断电与真实客户试点。本次未 `git add`/`commit`/`push`，未改 PiRuntime，未读客户资料。
  当时状态：**C2A 实施完成、待独立复验**；独立结论见下方第十轮，不以实施方结果替代验收。

## 2026-10-01 · 第十轮独立验收与 C2AR 排期

- 独立复跑 Package 235 项：233 pass、0 fail、2 文件 symlink 权限 skip，约 29.5 秒；审核契约针对性 15 项全部通过。包内类型、格式 42 文件、selfcheck 6 项及根类型、格式 2014 文件、processGuards 2 项、diff 检查通过。
- 额外内联纯数据诊断 97 个断言：全部 80 个动作/状态组合、前后 hash 14 个非法格式、中文字节边界和控制字符转义样例；最后一个合法事件实际 12,593 字节，说明“分项≈9.6 KiB”不是序列化上界。64 个语义问题输出 20、丢弃 44。诊断不计入永久测试数，不涉及审核 IO。
- 协议检查发现 A1：恢复先收 journal 终态，再补事件，二次中断会永久漏审计；A2：字节相同比对与变化的 publication/recordedAt 矛盾，已有 writer/recovery 事件会被误判；A3：缺失 intent 被当普通 v1，且缺少意图与提交的可执行关联校验。不是已发生的客户故障，当前审核持久化尚未实现。
- 结论：C2A 契约/校验主体通过，整体未通过；BR、C1/C1R 通过结论保持。新增 round10_acceptance.md 与唯一当前任务 bm02c2a_remediation_plan.md；下一轮只修协议与纯关联/永久回归，future 审核 v2 本轮仅设计，不改实际 v1/storage，不进入 C2B/D/UI。
- 同步当前文档入口、任务、测试、MVP、Package 和桌面边界状态。按分阶段 MVP 技能限制收尾范围，用文档写作技能分清实测代码、设计反例和未实施的 IO。未改生产代码/永久测试，未增历史文档删除，保留用户全部累积改动；无 add/commit/push、无 PiRuntime 修改、无客户资料读取。

## 2026-10-01 · BM-02C2B（一次经验卡审核的最小持久化闭环）

- C2B-1：新增 `core/storage/review/{contract,artifacts}.ts`。v2 契约 = v1 通用字段 + 审核判别位与绑定
  （`journalPurpose`/`eventId`/受控 `intentName`/`intentHash`），并明确"操作=update、目标仅 experience-card、
  `after = before + 1`、终态必须带 finishedAt/source、conflict 只能由恢复观察产生"。
  意图/事件是**不可变工件**（`audit/intents/<operationId>.json`、`audit/<recordId>/<eventId>.json`），
  非覆盖发布、有界读取、损坏保护；`intentHash` 取同一次读取返回的**真实字节**指纹。
- C2B-2：新增 `review/{decisions,writer,commitSteps}.ts` 与 `recordReviewDecision`。
  顺序固定为 意图 → v2 prepared → 记录 rename（唯一提交点）→ 事件发布/认领 → 完成终态；
  与 `updateRecord` 共用同一把目标锁；`reviewer` 规则写成表（approve 设置、打回/恢复提交清除、废弃保留）；
  证据下标回查业务内容；提交点之后的失败一律走判别联合结果（applied / applied-audit-pending /
  applied-journal-pending），不抛异常、不假称未提交、审计未发布时 `audit = null`。
- C2B-3：新增 `review/{inspect,reconcile}.ts`。巡检只读、有界，把合法 v1 计数、v2 分桶、未知版本与坏文件
  作为问题保留；恢复走"锁前只读定位 → 持锁复读 → 先验证关联 → 目标=after 时先发布/认领事件再写终态"，
  目标=before ⇒ aborted 且不发事件，既非前后 ⇒ conflict；完成终态缺事件/意图被替换/aborted 却有事件
  一律报不一致，不无条件成功。
- 新增错误码 `audit-conflict`（同身份已有不同字节的意图，或 journal 撞名）：它需要人工判断，
  与可重试的 `revision-conflict` 语义不同。
- C2B-4：新增 `tests/storageReviewWriter.test.mjs`（25 项）与 `tests/storageReviewReconcile.test.mjs`（17 项），
  含 **2 个真实子进程崩溃检查点**（提交后未发事件、事件发布后未写终态）与 **2 组真实双进程竞争**
  （同 expectedRevision 的写入竞争、恢复竞争）。新增 `docs/bios-agent/bm02c2b_implementation.md`。
- 验证（实施方实跑）：`node --test tests/auditContracts.test.mjs tests/auditAssociation.test.mjs tests/storageJournal.test.mjs`
  **70 项全绿**；两个审核持久化文件 **42 项全绿**；`npm test` **295 用例：293 通过、0 失败、2 显式 skip**
  （C2AR 基线 253 未削弱）；`typecheck`、`selfcheck`（6 项）、`check:format`（55 文件）通过；
  根 `typecheck`、根 `check:format`（2014 文件）、`processGuards`（2 项）、`git diff --check` 通过。
- 未做：通用事务、批量/跨项目审核、后台自动恢复、模型工具入口、CLI/UI、迁移与备份；普通写（v1）与 C1
  行为一行未改。未改 PiRuntime，未读客户资料，未 `git add`/`commit`/`push`。
  已知限制：v2 发布失败留下的**孤立意图不在巡检候选里**（巡检只扫 `journal/`）；
  "aborted 却有事件"只在再次核对时被发现。状态：**C2B 实施完成、待独立复验**。

## 2026-10-01 · BM-02C2AR（审核协议与纯关联收尾，仍无 IO）

- C2AR-1（A1/A3）：重写 `bm02c2a_implementation.md` §3（原 §3.1～§3.9 全部替换，并删除残留旧节）：
  提交顺序改为 **意图 → 审核 journal → 业务 rename（唯一提交点）→ 事件发布/认领 → 完成终态 → 释放锁**；
  明确**完成终态永远在事件之后**（旧顺序会让恢复先写终态、二次中断后审计永久缺失），
  并写清"恢复器在事件发布前后再次中断""终态已完成但事件缺失属异常"等窗口；
  审核写改用**专用 journal v2**（discriminator + 绑定 operationId/eventId/受控意图名/意图字节指纹/target/before/after），
  v1 与普通写**一行未改**，旧恢复器必须对 v2 按未知版本拒绝；不再用"intent 是否存在"判断普通写。
- C2AR-2（A2/A3）：新增 `core/contracts/auditIntent.ts`（184 行，意图=稳定决定字段，**不含** publication/recordedAt）
  与 `core/contracts/auditAssociation.ts`（237 行，v2 关联投影校验 + `compareAuditAssociation` 纯判定）；
  `auditValidation.ts` 抽出可复用的 `collectSchemaIssues` / `collectAuditRevisionIssues` / `collectAuditTextIssues` /
  `collectAuditEvidenceIssues`，事件、意图、投影共用同一份规则与脱敏管道。
  幂等规则改为：**不存在事件 ⇒ publish（不预支发布事实）；已有事件 ⇒ 逐项比较决定字段后 claim，
  保留其原始 publication/recordedAt**；不一致 ⇒ `audit-decision-conflict`；决定字段比对**不含**发布事实。
- C2AR-3：理由上限统一 1024 字节；未知枚举改述为"结构层 `invalid-audit`"；
  删除"分项之和 ≈9.6 KiB 即总上界"的错误论证，改为**保守上界 13,056 B < 16,384 B** 的推导；
  `Value.Errors` 的 eager 行为与"200 条只限诊断后处理"写清；前后 hash 的 14 种非法格式纳入永久测试。
- C2AR-4：新增 `tests/auditAssociation.test.mjs`（16 条），`tests/auditContracts.test.mjs` 由 15 → 17 条。
  写用例时发现并修掉**6 处用例自身的假通过风险**（`??` 覆盖 null 指纹、投影名长度先被结构层拦住、
  只改 after 导致先失败在事件校验、`expectFailure` 读错结果形状字段、`intent` 误判为契约字段名、
  手算字符串长度差 1），已在实施记录 §6.1 逐条写明。
- 验证（实施方实跑，2026-10-01）：`node --test tests/auditContracts.test.mjs tests/auditAssociation.test.mjs` **33 项全绿**；
  包内 `npm test` **253 用例：251 通过、0 失败、2 显式 skip**（235 基线未削弱）；`typecheck`、`selfcheck`（6 项）、
  `check:format`（45 文件）通过；根 `typecheck`、根 `check:format`（2014 文件）、`processGuards`（2 项）、`git diff --check` 通过。
- 未做：任何审核 IO（无 audit 目录/写入口/恢复器）、journal v2 实现、迁移、C2B/D/UI；
  未改 PiRuntime，未读客户资料，未 `git add`/`commit`/`push`，保留全部既有改动与未跟踪文件。
  当时状态：**C2AR 实施完成、待再次独立复验**（后续结论见下面第十一轮记录）。

## 2026-10-01：第十一轮独立验收与 C2B 接续任务

- 独立复跑 Package 全量 253 项：251 通过、0 失败、2 既有文件 symlink 权限 skip；审核契约/关联针对性 33 项全绿。
- 包内 typecheck、check:format（45 文件）、selfcheck（6 项）及根 typecheck、check:format（2014 文件）、processGuards（2 项）、git diff --check 通过。
- 核对修正后的提交/恢复窗口、稳定决定认领与意图真实 hash 绑定；额外 29 个关联场景、两项 v1 兼容断言通过，压力样例事件 12,979 字节。额外诊断不计入永久用例数。
- 结论：C2A/C2AR 在协议与纯校验范围通过，A1～A3 关闭；未实施或实测审核 IO、审核恢复、跨文件进程竞争、断电或客户 BIOS 项目。
- 新增 [第十一轮验收](round11_acceptance.md) 与 [C2B 开发方案](bm02c2b_development_plan.md)，同步当前导航与状态。下一轮只做一次经验卡审核的真实持久化、专用 v2、审计发布/认领、显式巡检恢复和故障/多进程回归。
- 本次仅改文档，未改生产代码/永久测试，未新增删除，未操作 Git 提交/推送，保留全部既有累积改动；不提前做 UI、迁移或模型审核工具。

## 2026-10-02：第十二轮独立验收与 C2BR 有限整改

- C2B 主体已落地：新增审核 review 模块、意图/事件工件、完整 v2 的声明、领域入口、只读巡检与恢复；新增 42 项永久测试。实施方记录见 `bm02c2b_implementation.md`，不是独立通过结论。
- 独立复跑 Package 295 项：293 通过、0 失败、2 既有 symlink 权限 skip；审核/journal/审核 IO 五个针对性文件合跑通过。包内类型、格式 55 文件、selfcheck 6 项及根类型、格式 2014 文件、processGuards 2 项、diff 检查通过。
- 独立合成知识库诊断复现 R1～R4：不完整 v2/输入校验与可扩大的审核字节限额；恢复在错绑定时发布并完成、首次矛盾现场收口；已有事实认领依赖新时间/恢复阶段结果不足；意图/事件清理残留无警告。原任务要求的 recovery 二次中断回归缺失。
- 结论：**C2B 主体已落地但整体未通过**。第十一轮 C2A/C2AR、第九轮 C1/C1R 和第七轮 BR 的声明范围通过结论保持，不重做旧任务。
- 新增 [第十二轮验收](round12_acceptance.md) 和 [C2BR 收尾方案](bm02c2b_remediation_plan.md)，同步导航/task/test/MVP/实施记录/Package README。下一轮只关闭 R1～R4、补红绿与真实恢复二次中断证据。
- 本次仅更新文档，没有修生产代码或改永久测试，没有 add/commit/push 或新增历史删除，未改 PiRuntime，未读客户资料；不提前进入迁移/CLI/UI。

## 2026-10-04：第十八轮独立验收与 S2 接续

- 独立复跑 Package 407 项（404 通过、0 失败、3 文件 symlink 权限 skip）、七文件 224 项（223 通过、1 skip）；包内类型、格式 66 文件、selfcheck 6 项及根类型、格式 2014 文件、processGuards 2 项、diff 检查通过。
- S1 原两种独立计量诊断关闭：audit 额度 15 为观察/报告 16/16；experience 输出触顶为 10/10。成功列举、其他预算停止及逻辑核对范围通过；junction 条件失败显式 skip 口径保持。
- 新增确定性诊断 S2：experiences 交出四条后迭代 `EIO`，features 继续；额度 15 实际观察 20、报告 16。错误被报告，但失败前观察成本未进入共享预算，PF-4/C3 整体暂未收口。
- 新增 [第十八轮验收](round18_acceptance.md)，在 [C3R 方案 §7](bm02c3_remediation_plan.md#7-第十八轮后的唯一接续任务s2) 明确唯一下一任务，并同步导航/task/test/MVP/实施记录/Package README。保留原方案，不另造重复主方案。
- 本轮仅改文档，未修运行代码或永久测试；合成临时诊断已清理，原修改、未跟踪文件与六项历史删除均保留。未读真实客户数据，未改 PiRuntime，未提交推送；不提前进入备份、CLI、UI 或记忆/自动学习。

## 2026-10-04 · BM-02C3R-S2 接续实施（迭代中途失败的观察成本，待独立复验）

- 只做 S2：`Boundary.listEntries` 新增**受控观察计量**可选回调 `observe(observed)`，每实际观察到一个目录条目就交回累计数（在判定截断/跳过之前，含超限探测条目与被跳过的链接/子目录）；预检以它为**唯一计费来源**（`scan.scannedEntries = baseline + observed`），成功后不再叠加 `listing.scanned`——成功/截断/迭代失败共用一个出口，成功不双计、失败不丢成本。
- 失败出口与取消语义不变：原始异常仍收敛成受控 `unreadable` 问题（不回显原始正文），取消继续结构化穿透；目录句柄在成功/截断/失败/取消四条路径统一由 `finally` 关闭且不覆盖首错；零观察失败不制造虚假成本。
- 红/绿（独立子进程包装真实 `opendir`/`open` 并注入"交出 N 条后抛 `EIO`"）：A（额度 15）20/16 → 16/16；宽预算 31/27 → 31/31；嵌套 audit 19/16 → 16/16；与读取预算组合 24/20 → 24/24；零观察失败与取消对照保持。
- 新增 7 个永久用例（预检 59 → 66）；`directoryListing.ts` 抽出有界列举的输入/输出契约，`boundary.ts` 609 → 576 行（未越过 600 行拆分门槛）。
- 实跑：包内 `npm test` 414 项（411 通过/0 失败/3 skip）、七文件 231 项、列举契约相关 185 项、类型/selfcheck 6 项/格式 67 文件；根类型/格式 2014 文件/守卫 2 项/diff 检查全部通过。
- 未改：写入原语、锁、journal/review 协议、根解析与 schema、模型工具/CLI/UI、PiRuntime/Electron；未读客户资料、未提交推送。
