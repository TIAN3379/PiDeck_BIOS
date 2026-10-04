# 当前批次：R29 有限收尾＋BM-05 任务事实与人工交接闭环

日期：2026-10-04。基线：[第二十九轮验收](round29_acceptance.md)：732 项，727 通过、0 失败、5 skip；BM-04 正常业务已实施，但四组收尾阻塞整批通过。

## 1. 一次交回什么

交付“工程师开一个 BIOS 开发任务，保存决定/待办/阻塞与验证；换开发对话后按当前任务继续；旧任务重开或来源变化时旧交接包失效；完成后能显式提炼一张待审核经验草稿”。

这是 Package 内的领域服务与人工 CLI，**不是实际 Pi Session 注入或桌面 UI**。先打通可独立运行的任务闭环，再按 BM-06 接宿主。

同一开发批次按 A→B→C 连续推进，内部过闸即继续，不在几项修复后单独交回：

- A：R29-1～4 永久回归与最小修复，知识/memory/project/CLI targeted、类型、格式通过。
- B：v1 TaskRecord 领域服务、状态/CAS、引用/验证、显式经验草稿沉淀。
- C：有界人工交接包、ContextManifest 保存/重验、真实 CLI 与新进程演示、整批门禁与实施记录。

不重做已通过存储/journal/审核/备份，不升级磁盘格式。上下文不足在 `bm05_implementation.md` 准确留断点、失败用例和最后命令，不把未完成节点写成完成。

## 2. 节点 A：有限修复后继续业务

完整输入/错误输出见 [验收 §4](round29_acceptance.md#4-四组有限收尾)。每组先红后绿，保留正常对照与旧回归。

### A1：知识授权与来源存在性（R29-1）

- 明确公开服务和可信内部读写 helper；公开详情/列表/关联/检索均缺省拒绝内容，不能省略 visibility 就读取全部。实际 experience-show 支持并执行来源授权，不能用另一个 search 的过滤当作保障。
- 未授权记录的正文、标题、ID、状态、计数和路径诊断不可见；内部扫描成本可记本地诊断，但不能回显成业务可见计数。Feature 可以按显式授权 ID 或明确批准的客户范围读取，规则统一，不从未知客户推导公开。
- 创建/更新/审核经验前核对源项目存在、明确授权；来源工作区/EvidenceRef 归属正确。拒绝无新写入，既有无来源记录只返回待核对，不能自动补造项目。
- 授权是调用方声明，端点许可独立判断；不承诺限制 Pi 的其它普通文件工具，不扩建企业认证。

### A2：别名与经验业务完整性（R29-2）

- Feature 别名命中后，有界读取其真实 relatedExperienceIds，按来源授权、审核状态、当前 revision、复用范围与端点策略复验，形成关联参考。经验 featureId 反向引用亦须核对记录族/ID；不递归遍历整库。
- 补 symptom-only、其它单字段、同值/证据变更、CAS 冲突对照。正文保存与派生规范化区分；未知/拼错输入不静默忽略，不能把“不支持 evidence”默默落成空数组。
- 经验顶层 evidence、已有 validation evidence、sourceProject、Feature 原需求/验收条件可按 v1 引用保存与受控展示。来源 commit 若有合法 EvidenceRef 则展示；没有则明确未知，不拿当前 HEAD 追溯历史验证。
- 参考始终要求适用范围核对及目标验证。未知客户/产品线/关联、缺证据、未审核都给清楚原因；不给“可直接跨平台应用”的布尔保证。

### A3：真实额度、取消、CLI 提交事实（R29-3）

- cancelled 在所有 listing/read/detail/关联 catch 中穿透；await 后检查取消。空候选分支同样汇总读取/列举问题为 incomplete。
- 知识扫描额度计入 listRecords 本身读取的正文与再次详情读取，或使用有限列举路径避免重复全读。实际字节、打开/读取条目、输入词数/总长度、可见输出与诊断都有明确口径；不只统计第二轮读取。
- feature/experience 写 CLI 依据 needsReview/warnings/真实结果选择退出 8；保持已发布 revision，不提示重试同一 revision，不回滚、不自动修 journal。项目共享 notes 中 cleanup/锁释放警告也不能因文案已存在而丢掉需核对状态。
- `--status` 不依赖 `--family` 才生效；枚举、未知/重复选项、单对象 JSON、signal 与 nonzero 统一。永久回归含真实预加载故障的业务 CLI，不只 mapper 自测。

### A4：关系图只纳入有权且相关的边（R29-4）

- 授权和明确不适用 scope 过滤早于建图、节点预算与依赖排序；未知范围只对有权且可能适用的边降级。隐藏来源不能借 unknownScope 或预算影响可见候选。
- 补 BOARD-OTHER 的双向假环、隐藏来源未知 board、低节点预算、真正适用的环/分叉/撤回来源与排列对照。保持保守降级，不自动复活旧事实，不升级持久化关系格式。

A 内部 targeted/类型/格式通过后直接继续 B。

## 3. 节点 B：TaskRecord 与显式经验草稿沉淀

### B1：任务创建、读取、正文更新

- 复用 `TaskRecord` v1：id、projectId、workspace（workspaceId/path/可选 branch/baseCommit）、requirement、status、decisions、todos、blockers、relatedFiles、sourceExperienceIds、validations。
- projectId 必须真实绑定；workspaceId 必须属于该项目，路径按本次 cwd/授权根核对。相同裸 taskId 可存在不同项目，服务身份使用 projectId＋taskId，不跨项目/工作区互串。
- 首次创建默认 planned；输入数组/正文/文件路径/关联 ID/实际字节都有上限，守卫在 IO/写入前执行。路径用已核对工作区，不能以 arbitrary path 绕过绑定。
- 普通更新只改点名的正文/待办/阻塞/引用/验证，required expectedRevision。读取真实状态后 CAS；未触达字段保留，冲突无覆盖、同值不乱加 revision。
- 经验引用按授权与现时审核状态重读；草稿/废弃/不可读/越权可以提示缺口，但不能作为任务当前依据。任务记住的是引用，不复制整卡正文进 TaskRecord。

### B2：状态与重开

- 只使用既有 `planned/in_progress/blocked/done/archived`，写出有限合法转换表并测试；支持 done→in_progress 的显式重开。archived 的恢复如需支持须显式动作，不靠编辑正文悄悄恢复。
- 状态改变是具名 CAS 操作；重开后新 revision 是真相，旧交接的 done 不得覆盖。任务 done 只代表工程师声明任务结束，不代表硬件已验证、经验已审核或所有源码已提交。
- 验证按既有 ValidationRecord 保存，compile/board-boot 等原级别与范围展示；HEAD/板卡/构建目标变化时不能继承目标当前已验证保证。
- Task v1 不含通用语义历史，不另起任务审计状态机；通过现有 revision/journal 表达写入事实，历史任务转换账本另走 M2。

### B3：从任务显式保存经验草稿

- 提供人工“准备/保存经验草稿”入口：读取指定任务当前 revision 与授权来源，展示可预填的需求、决定、文件、引用与实际 validation。
- rootCause/solution/适用与不适用条件仍须人工提供或确认；任务没有这些字段时保留待填写，不从 todos 或 done 自动编造结论。
- 保存走 BM-04 草稿创建，status 恒 draft，不能自动 submit-review/approve，也不能把任务 done 转成 verified。
- 若还要把新经验 ID 关联回任务，使用两个已有 CAS 步骤，分别报告卡片是否已发布、任务是否已关联。第二步冲突/取消不撤销草稿，重试先读现状；不创建多文件事务。
- 这是显式经验积累入口，不是后台反思、自学习或 AutoDream。审核仍走已有 recordReviewDecision。

## 4. 节点 C：人工交接包与 ContextManifest 重验

### C1：有界上下文组装

- 输入明确 targetProjectId、taskId、workspaceId、用户选择/关键词和授权/端点策略。读取当前项目档案＋指定任务＋有限已授权经验/Feature，使用 M1 决策，不扫描聊天日志或未配置知识根。
- 输出可供人交给新对话的文本/结构：当前需求、任务状态/待办/阻塞、人工确认的项目身份、具体工作区/当前可观察 HEAD、参考经验与限制、缺口/冲突/过期/预算原因。检测候选、旧摘要、源板验证不混成目标当前事实。
- chars 与 UTF-8 bytes 双预算覆盖实际交接文本、标题/理由/来源与必要诊断；不截断成“已完成”或破坏状态说明。预算不足明确 incomplete，最小诊断例外定明；端点 deny 不输出知识正文，unknown 保守处理。
- 组装结果是当前有限观察，不是跨记录/Git 原子快照。完成前重读必要 revision/状态；发现变化返回 stale/incomplete，不输出看似一致的交接。

### C2：保存与重验 Manifest

- 复用 `ContextManifest` v1：targetProjectId、taskId、profileRevision、sources（recordKind/recordId/revision/reason）、expiredSources、budget、generatedAt。sources 必须包含所选当前任务的 revision，不能只写 profileRevision。
- 服务层限制 recordKind 为实际支持族；任务来源只能是当前项目的明确任务身份，v1 没有 sourceProjectId 的 sources 不能凭裸 ID解析另一项目任务。同 ID 的经验与 Feature 靠 recordKind 区分。
- Manifest 是来源清单，不是已注入 Pi 的证明；不把没有保存的正文/hash/HEAD 当作生成时耐久快照。交接正文可当次输出，新进程重建时以当前记录为准并明示旧 Manifest 是否 stale。
- 新进程重验：taskId/项目/授权/工作区一致性、task/profile/source revision、经验废弃/缺失/不可读/端点策略。任务重开、profile 变化、来源修改后旧 Manifest 不可用作当前依据；裸 expiredSources 不足时在临时详情返回具名族/ID/原因，不改 schema。
- 没有耐久来源字节/HEAD 指纹的同 revision 合法外改，v1 不能完整证明历史漂移；明确 legacy/unproven，不说“完全一致”。需要该保证时另交 M2 格式设计，不在本批悄悄加字段。
- 同一 manifest ID 的替换使用 expectedRevision，任务选择改变时不沿用旧任务包；显式不同 ID 可留档。读取不顺手改库，删除 Session 不删任务/Manifest。

### C3：人工 CLI 与真实新进程闭环

提供 task 创建/详情/正文更新/状态/重开、context 生成/保存/重验、任务经验草稿准备/保存等薄人工命令；复用参数白名单、写确认、授权、统一 JSON/退出码/取消。尚未注册模型可调用写工具。

交付 `cli/task-scenario.mjs`（名字可调整），全部临时合成数据、真实 CLI 子进程：

1. 同项目两个工作区＋另一个项目的同裸 taskId，明确创建独立任务并读取。
2. 更新决定/待办/阻塞、引用已 reviewed 的源经验，保存任务验证声明。
3. 生成并保存有界交接包来源清单，新进程重验同任务、revision 与工作区。
4. 工程师标 done 后显式重开；旧 Manifest 显示 stale，新交接是 in_progress，不续跑旧 done。
5. 废弃/修改经验、修改项目/HEAD、切另一个 task/workspace、缩小授权或 deny 端点；重验不会恢复旧结论。
6. 任务经验沉淀只得到 draft，新进程读回，未自动审核；关联回任务出现 CAS 冲突时保留真实半完成事实。
7. 数量/实际字节不足、取消、写后 journal 警告及双进程任务竞争都有受控结果，不改其它任务/工作区。

不要用预设 JSON 打印替代真实入口；不用真实客户库，不执行构建/源码移植/刷板。

## 5. 验证与文档交付

- R29 四组逐一旧红新绿；实际 CLI 详情授权、专有别名关联、symptom-only、最后一次读取取消、坏文件零命中、真实额度、发布后 exit 8、跨范围假环回归。
- Task 的字段/状态/CAS/非法输入、两项目同 ID/双工作区、关联授权、真实双子进程同 revision、一成一败无覆盖。
- Context 的 chars/bytes、源读取期间变化、重开/废弃/端点/权限/关联族、Manifest 新进程重验、只读不写与同 ID CAS 替换；不用无来源的摘要证明恢复成功。
- 任务→草稿→关联的正常/重复/第二步失败/取消与发布后警告；只声明实际 validation，不自动批准。
- 内部每日 targeted＋类型＋格式；整批 Package 全量（本次基线 732 项，按实际新增报告）、相关知识/memory/project/task/context/CLI、旧审核/存储/备份、selfcheck、根类型/格式/processGuards、git diff --check。已知权限码才 skip，不计作通过。
- 写 `bm05_implementation.md`：实际 API/CLI、有限修复证据、任务演示、来源/授权/预算/时态限制、运行数字/skip、未测与断点；同步导航/task/test/log，在 BM-04/M1 实施记录追加独立关闭证据，不覆盖历史快照。

## 6. 范围与后续

不升 schema/迁移，不扩建存储/journal/审核/备份，不接真实客户库、RAG/向量库、自动审核、自学习/AutoDream；不改 Pi 内核/Electron，不提前做 UI/Session 注入，不自动 add/commit/push；保留脏树与既有删除。

本批完成后 BM-06 接真实 Pi 工具与生命周期/上下文，BM-07 做桌面任务/知识/来源 UI。加速方式是四组收尾与完整任务业务合批，不取消门禁，也不把所有 M2 时态升级设为前置。

## 7. 新对话简短交接提示词

> 在 `D:\BIOS_Pi_Agent\PiDeck_BIOS` 的 `BIOS_Agent` 分支继续。先读 AGENTS.md、docs/bios-agent/README.md、round29_acceptance.md、bm05_development_plan.md 与现有 contracts/knowledge/memory/projects/storage。
> 按 A→B→C 完成同一整批：先修 R29 四组（知识授权/来源、别名与字段/证据、真实额度/取消/CLI 提交事实、关系范围过滤），内部过闸后直接完成 BM-05 TaskRecord、状态/重开/CAS、人工交接包与 ContextManifest 重验、任务经验草稿沉淀，不在小修复后结束。
> 复用 v1 和已有审核入口；任务 done 不等于板卡验证/经验批准，旧 Manifest 不能恢复重开前状态。无 UI/Pi Session 注入/向量库/迁移/自动批准，不重做历史底座。
> 补永久回归、真实 CLI/双进程/新进程任务闭环，整批门禁后写 bm05_implementation.md 并同步状态；保留脏树及既有删除，不自动提交推送，上下文不足准确留断点。
