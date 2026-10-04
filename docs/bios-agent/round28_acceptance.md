# 第二十八轮验收：BM-03 已交付主流程，四组收尾后继续 BM-04

日期：2026-10-04。独立核对工作区 `D:\BIOS_Pi_Agent\PiDeck_BIOS`、分支 `BIOS_Agent`，Windows / Node 24.14.1。
依据：[BM-03 批次方案](bm03_development_plan.md)、[实施记录](bm03_implementation.md)与源码、永久测试、真实 CLI 子进程和额外合成诊断。

## 1. 结论

BM-03 的项目绑定、档案、有限检测、人工确认、工作区 Git 快照、消费视图和人工 CLI **已经实施，正常端到端流程通过**。现在确实能在新进程中读回项目与确认值，不再只有纯内存记忆演示。

**本批未完整通过验收**：额外诊断发现四组有限问题，见 §4。测试全绿不能替代这些异常路径的结果。

- R27-1 的当前准入/revision/记录族隔离、R27-3 的入口闸门与 M1 条目预算，独立原场景复验关闭。
- R27-2 的缺源处理和正常替代关系已修复，但分叉图、被撤回的声明方及未授权关系影响尚未收口；归入 R28-3，不再写“三组全部关闭”。
- R26-1～3、D3/D4 以及更早已验收的存储、审核、journal、备份范围保持，不重新开发。
- M2 仍只认可复用 v1 的业务路线；正式时态字段、语义历史、耐久来源指纹及迁移没有获批，也没有完成。

下一批采用 [BM-04 完整业务方案](bm04_development_plan.md)：四组问题内部过闸后，直接继续经验/Feature 录入、审核、关键词检索和跨项目参考闭环，最后一次性交回。

## 2. 本次独立门禁

| 核对项 | 独立结果 |
|---|---|
| Package `npm test` | 711 项：707 通过、0 失败、4 skip |
| memory＋project＋backup＋knowledge CLI targeted | 288 项：287 通过、0 失败、1 skip |
| 旧存储六文件：records/registry/preflight/journal/reviewWriter/write | 249 项：246 通过、0 失败、3 skip |
| Package 类型 / 格式 / selfcheck | 通过；格式 120 文件，selfcheck 6 项 |
| 根项目类型 / 格式 / processGuards | 通过；格式 2014 文件，processGuards 2 项 |
| `git diff --check` | 通过 |
| `node cli/project-scenario.mjs` | `status=ok`，`failures=[]`，真实临时 Git 仓库与逐步新 CLI 子进程 |
| `node cli/memory-scenario.mjs` | current 2、reference 1、needs-review 3、excluded 3；family conflicts 为空 |

Package targeted 命令：

```powershell
node --test tests/storageBackup*.test.mjs tests/knowledgeCli.test.mjs tests/memory*.test.mjs tests/project*.test.mjs
node --test tests/storageRecords.test.mjs tests/storageRegistry.test.mjs tests/storagePreflight.test.mjs tests/storageJournal.test.mjs tests/storageReviewWriter.test.mjs tests/storageWrite.test.mjs
npm run typecheck
npm run check:format
npm run selfcheck
```

4 个已有 skip 是文件型 symlink 权限限制，不计为通过。另有本轮项目 symlink 分支在创建失败后只输出 diagnostic、仍算通过，**并非显式 skip，也未实际验证该分支**。应按已知权限错误显式跳过，其它失败仍报错。

实施记录称“双进程竞争确认”的用例实际上是同一 Node 进程中的 `Promise.all`。项目演示确实逐步启动新 CLI 子进程，但这不等于两个进程同时确认；下一批补真实双子进程竞争，不能借用通用存储测试替代领域入口证明。

## 3. 已验证的业务与原整改

项目演示验证了：未确认写入被拒；绑定发布 registry/profile；真实 DSC 检测只产生候选而不猜身份；人工确认后新进程读回同一项目、工作区、revision 与字段值；源码及 HEAD 变化被提示、不覆写确认值；显式刷新后重读；第二工作区快照独立；bind 的越权路径被拒。

M1 额外独立复验：draft 经验不成为 current；未来事实不拖入当前冲突；同族旧 revision 不与新 revision 冲突；未授权高版本不淘汰可见旧版本；同裸 ID 的不同记录族不互串；缺源关系降级，正常有效来源可以替代目标；非法输入受控；数量闸门不访问被截断元素。`maxOutputBytes=1` 时条目为 `[]`，实际 2 字节，明确 incomplete，不保留超限首条。这是 M1 **条目数组**的口径，不代表整个业务 JSON 外壳小于 1 字节。

以上只证明声明的本机合成范围，不证明真实 AMI/Insyde/百敖代码、客户库、硬件验证或生产权限隔离。

## 4. 四组有限收尾

以下为本次独立额外诊断，**尚未加入永久测试，也不计入 711 项**。均使用自行创建、校验位于系统临时目录下的合成库/源码，结束后清理，没有接触真实客户数据。

### R28-1（P1）：领域写入口丢失已发布与待核对事实

位置：`core/projects/binding.ts` 的 registry 发布后 profile 读取与结果包装；`confirm.ts`、`workspace.ts` 的存储写结果包装。

- bind 中 registry 已发布后，在 profile 读取处注入 `EACCES`：磁盘 registry revision=1 且已有项目；调用方却只得到 `io-error/permission-denied`，没有 steps、已发布 ID 或续办信息。第二步读取在局部写入 catch 之外。
- 在真实 journal 终态 rename 注入 `EBUSY`：bind 仍报 `bound`、steps 全 published、problems/resume 为空，而两份 journal 留在 prepared；confirm 仍报 `confirmed`、problems 为空，新增 journal 同样 prepared。底层返回的 warnings、journal/cleanup/lock-release 结果被领域包装丢弃。

要求：完整保留已发布目标、revision、阶段及需要人工核对的原因；发布后异常不能误报“未写入”或“干净成功”。CLI 同步非成功退出码及结构化事实。复用现有存储结果，不新增多文件事务，不回滚 registry，不自动修复 journal。

### R28-2（P1）：字段证据互串，截断/真实读取/晚期取消不可信

位置：`core/projects/view.ts` 的 `applyEvidenceChecks`；`workspace.ts` 的 `verifyEvidenceRefs`；`detection.ts` 的选样、读取和截断汇总。

| 独立输入 | 实际结果 | 必须修到 |
|---|---|---|
| boardName 使用 a.dsc，customer 使用 b.dec；只改 b.dec | 两个字段均 verification-drift | 证据按事实键及具体来源对应；不拖低无关字段 |
| 上述场景 `maxEvidenceFiles=1`，b.dec 未检查 | evidenceUnchecked=1，但整体 ok，两个字段均 current | 未复验的字段不能借其它字段 valid 升为 current；整体 incomplete |
| 单证据文件超过 `maxEvidenceFileBytes=8` | not-checked，uncheckedCount=0、truncated=false | 超预算计为未完成，传播原因和 incomplete |
| 20 条 human-note，`maxEvidenceFiles=1` | 输出 20 条检查、无截断 | 明确文件数与检查条目数的独立上限，所有类型有界 |
| 项目 view 中检测超单文件额度 | detection.truncated=true，view.status=ok | 汇总实际检测/复验的部分结果，不能只取 M1 状态 |
| 14 个真实 DSC，默认最多检测 8 个 | scanned=8、candidates=8，truncated=false | 选样/候选数量受限也必须可见，不能只在循环末记截断 |

另独立制造真实文件在 `stat` 后由 32 字节增长为 8225 字节：设置单文件 64、总量 128，检测仍完整读入 8225 字节并产出候选、truncated=false。当前 stat 预检后直接 `readFile`，不是实际字节硬上限。

在证据 stat 完成时触发 AbortSignal，复验仍返回 valid。应检查 await 边界、使用有界实际读取与取消传播，并确保句柄 finally 关闭；不能只靠循环开头检查。新增增长、晚期取消、字段隔离与部分结果永久回归，同时补 §2 的显式 skip 和真实双进程确认。

### R28-3（P1）：R27-2 的关系图仍受输入顺序与无效来源影响

位置：`core/memory/policy.ts` 的链式 `.find` 与 `decide.ts` 的关系来源解析/授权集合。

- 图 `b→a supersedes`、`c→a supersedes`、`a→c supersedes`，正序输出 a/c excluded，反序输出 a/c needs-review/relation-ambiguous。简单环回归已绿，但分叉上的环仍依赖第一条边。
- 只含可见 a 时 a=current；加入未授权项目的 b 及 `b→a` 后，b 虽被隐藏，a 却降为 unresolved-relation/incomplete。未授权材料仍影响可见结论。
- `b supersedes a`、`c retracts b` 同时存在：b 已 retracted，a 仍被它判 superseded，整体 ok。只看关系前基础信号不能证明来源最终有效。

要求：所有相关分支有界、顺序无关；授权过滤先于关系参与；来源被撤回/冲突/无法证明时显式降级。v1 没有完整语义时间线，**不要反向自动复活 a 为 current**，也不要改成排序后挑一条边。补排列、分叉、循环、撤回来源及隐藏来源对照，不升级持久化格式。

### R28-4（授权边界 P1；CLI 契约 P2）：部分入口没有执行声明的限制

位置：`binding.ts` 的 `openProjectProfile`；`cli/project.mjs` 的 open/detect/refresh、参数解析与预算说明。

- 两个工作区 a/b：`openProjectProfile` 提供 cwd=b、workspacePath=a、authorizedRoots=[]，仍返回 usable=true 和完整档案。真实 detect CLI 相同配置、空授权环境，退出 0 并读出 a 的两个候选。bind 的边界检查不能代表其它入口也受保护。
- refresh CLI 解析了 cwd/roots，却没有传到读取档案中工作区路径与 Git 的领域入口；这是源码缺口，本轮没有把它列为独立运行复现。
- 拼错 `--verify-evidnce` 被静默忽略，read 退出 0；confirm 带 `--unknown-option` 仍实际确认并退出 0。
- open 一个未绑定目录返回 missing、exit 0，JSON 没有 code/exitCode，偏离声明的 not-found/退出码契约。
- CLI read 的 `--max-output-bytes=1`：M1 items 为 2 字节空数组，但 stdout 为 492 字节。帮助把 M1 条目额度说成整个视图 JSON 额度，且外壳/检测/诊断需独立有界。

要求：明确公开服务的信任边界；凡输入 cwd/授权根并访问工作区的路径，必须真正执行该授权，必要内部 helper 不能冒充已授权公共入口。每个命令采用参数白名单、重复/错参数及安全整数校验，写前拒绝。统一单对象 JSON/退出码；预算明确条目与外壳口径及最小诊断例外。

这属于本地配置的范围契约，不是企业身份认证；人工可以显式配置授权，但服务不能静默忽略已提供的限制。

## 5. 下一步与未测范围

按 [BM-04 方案](bm04_development_plan.md) 的 A→B→C 连续推进：A 修四组并过内部回归；B 完整经验/Feature 服务与关键词检索；C 人工 CLI、真实多进程与跨项目 PXE 参考演示、整批门禁和实施记录。不在 A 后单独交回验收，不新增通用底座工程。

本轮未跑根项目全量测试/构建/安装包、远端 CI、其它 OS、网络盘、断电、真实 ACL、客户库或板卡。没有接 UI、模型知识写工具、Session 注入、RAG、向量库或 AutoDream；也没有修改运行时代码、提交或推送。脏树、未跟踪文件及六项既有删除保留。
