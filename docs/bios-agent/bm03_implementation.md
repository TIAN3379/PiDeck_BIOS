# BM-03 实施记录：M1 三组收口＋项目事实模块＋人工入口

日期：2026-10-04。工作区 `D:\BIOS_Pi_Agent\PiDeck_BIOS`，分支 `BIOS_Agent`（Windows / Node 24.14.1）。
依据：[第二十七轮验收](round27_acceptance.md)、[当前批次方案](bm03_development_plan.md)、[分层记忆与时态设计](layered_memory_temporal_design.md)。
状态：**第二十九轮独立复验：正常项目闭环和 R28 核心项目回归通过**；真实双确认子进程已执行、链接权限分支显式 skip。R28-3 的关系范围/授权剩余项归 R29-4，整体业务仍待 R29 收尾。最新见 §9 与 [验收](round29_acceptance.md)，历史实施与独立快照保留。未升 schema、未改 Electron/PiRuntime、未读客户资料、未 add/commit/push。

## 1. 节点 A：R27-1～3 旧红新绿

三组修复都在**未发布的纯内存契约**里完成（`core/memory/`），磁盘 v1 记录格式一字未改。

### 1.1 契约层：把"三种身份"写清楚（R27-1 的根因）

旧红全部来自同一处：把**裸 ID** 当成记录身份、事实身份与关系端点的通用键。

| 概念 | 现在的定义 | 用在哪里 |
|---|---|---|
| 记录身份 | `family` + `recordId` + `revision`（`MemoryRecordRef`） | revision 淘汰集合、关系端点解析 |
| 事实身份 | 记录身份 + `factKey`（`candidateFactKey`） | 候选去重、冲突分组 |
| 字段粒度 | 一条记录可承载多个 `factKey` 事实 | 同一个 `ProjectProfile` 的 boardName / chipsetFamily … |

- `MemoryCandidate.kind: string` → `family: MemoryRecordFamily`（固定联合：`project-profile` / `experience-card` / `feature-record` / `task-record` / `session-summary` / `detected-candidate`）；
- `MemoryRelation` 从 `fromRecordId/toRecordId/toRevision` 扁平字段改为**两端具名**的 `source`/`target: MemoryRecordRef`；
- `MemoryDecision` 新增 `factKey` 与 `family`：一条档案记录承载多个事实时，没有这两项就无法把条目对应回字段，排序也失去稳定的决胜字段（稳定排序会退化成"输入顺序"）。

### 1.2 R27-1（P1）当前准入、授权优先与 revision 隔离

| 旧红（验收 §4 的复现） | 根因 | 修后（绿） |
|---|---|---|
| draft/unknown 经验卡成为 `current` | 准入完全没看审核状态 | `eligibilityVerdict` **按记录族**判定：经验卡要 `reviewed/verified`（否则 `not-reviewed`）；档案/Feature 看**字段**是否人工确认（否则 `field-unconfirmed`）；任务状态不参与可信度 |
| 当前 PXE=off 与"未来才生效"的 on 双双 `conflict` | 所有候选都参加冲突 | `NON_CURRENT_BLOCKERS` 是唯一口径：未生效/已过期/旧版本/未审核/不可读的事实**不参加**当前冲突 |
| 同记录 rev1=off、rev2=on 时 rev2 仍被拖进 conflict | 同上 | 旧版本带 `older-revision` ⇒ 不参加；新版本干净地 `current` |
| 未授权项目的同 ID rev2 让可见 rev1 被标 `older-revision` | revision 集合建立在**全部输入**上 | 集合只在**已授权可见集合**上计算（`family + recordId`） |
| 可授权最高版本不可读时旧版本复活 | 只按 revision 排序 | 最高可读版本不可读 ⇒ 旧版本额外带 `higher-revision-unreadable`，仍为 `excluded` |
| `experience-card` 与 `feature-record` 同 ID/rev 被当成重复输入 | 去重键是裸 `recordId+revision` | 去重键改为**事实身份**（记录身份 + 事实键） |
| 确认值与新检测候选的差异被当成两条普通候选的冲突 | 无字段确认概念 | `detected-candidate` 族恒为 `field-unconfirmed`，且**故意**参加当前冲突 ⇒ 与确认值的差异变成 `needs-confirmation`（保留确认值、不覆盖） |

`field-unconfirmed` **不在** `NON_CURRENT_BLOCKERS` 里是刻意的：否则"确认值 vs 新候选"永远无法形成待确认差异。

### 1.3 R27-2（P1）关系两端复验、多边共同判定与确定性

旧红：关系只按"目标 ID"匹配，声明方根本不参与判定；多条适用边则"排序后第一条赢"。

修后（`policy.ts` 的 `relationVerdict` + `decide.ts` 的解析器）：

- **端点解析**：`resolveSource(ref)` 只认"记录身份在已授权集合里、`authority = authoritative-read`"的声明方；
  - 缺失 / 未授权 / 不可读 / 族或版本对不上 ⇒ `unresolved`（目标 `needs-review` + `unresolved-relation` + 整体 `incomplete`）；
  - 可解析但自身不是当前有效事实（未审核 / 未生效 / 已过期 / 旧版本 / 未确认字段 / 被撤回）⇒ `not-effective`（`relation-not-effective` + `incomplete`）；
  - 声明方的**每一个**事实条目都要可读且当期有效，才算一条可用断言。
- **多边共同判定**：把指向同一目标的所有适用边收成一个集合；`superseded` 与 `retracted` 同时出现 ⇒ `relation-ambiguous`（保留矛盾，不挑赢家）；同向多边只是同一条结论；成环同样 `relation-ambiguous`。
- **顺序无关**：判定只看"关系之前"的信号快照（`preRelationReasons`），关系结论不会回头改变别的候选的可信度。这一条在开发中真实踩到过：先写的实现就地改写基础原因，导致 A 的关系结论影响 B 的声明方可信度、环状用例结果随遍历顺序变化；已有永久回归（`R27-2：多条适用关系共同判定…` 断言正反两种排列输出逐字节相同）。
- **范围**：关系声明了某维度而目标未知 ⇒ 不能确认（`unresolved`）；声明与目标不同 ⇒ 这条边不作用于本次上下文（不影响结论，也不会泄漏）。
- **链长/预算**：链式行走只用于查环与 `maxRelationChain` 上限，触顶记 `relation-chain-truncated` 并报 `incomplete`。

修正了原有缺源 fixture：`cli/memory-scenario.mjs` 增加真实存在的撤回声明方 `exp-board-b-retract`（当期经验卡），关系两端都写成具名记录身份 —— 不再用"不存在的来源"证明替代成功。

### 1.4 R27-3（P2）公共入口闸门与实际输出预算

闸门顺序改为**浅层 → 数量 → 嵌套**，每一步都不做多余工作：

1. 顶层形态（对象 / `intent` 枚举 / `now` 安全非负整数 / `candidates`、`relations` 是数组 / `authorization`、`target` 是对象 / `endpointAllowed` 三态 / `allowInternalGeneral` 布尔）；
2. **数量闸门**：超限直接 `incomplete` 且 **不访问任何元素字段**（永久回归用 getter 计数候选对象的字段读取次数，断言为 0 —— 旧实现进入 incomplete 前已读了 3 次）；
3. **有界嵌套校验**：枚举 / 字符串 / 布尔 / 时间 / 数组长度（`maxNestedItems`）；文案不回显被拒材料，长度有界。

输出预算改为**精确 UTF-8 记账**：`items` 按 JSON 数组序列化，含 `[`、`]` 与逗号；空数组固定 2 字节，因此预算 0/1 一条都放不下；某条放不下就从该条起全部丢弃（前缀语义），**不再**为了"至少给一个解释"保留超限首条。永久回归用独立 `Buffer.byteLength(JSON.stringify(items))` 对照 2/单条/两条/差一四个边界。

`resolveMemoryLimits` 现在拒绝未知键与非法值（拼错的限额不再被静默忽略），`decideMemory(null)` 抛受控 `MemoryInputError` 而不是裸 `TypeError`。

### 1.5 一处必要的规则收窄

`legacy-unspecified`（v1 没有生效区间也没有依赖快照 ⇒ 只作参考）**限定在经验族**。
理由：这条规则原本是给"说不清什么时候适用、依赖哪份代码"的经验卡用的；对档案字段/任务状态套用会把"已人工确认的板名"降级成参考，而 BM-03 的消费视图正需要它保持可用。经验卡的既有永久回归（MT-12）不变。

## 2. 节点 B：BM-03 项目事实模块（`core/projects/`）

新增 7 个文件、窄出口 `core/projects/index.ts`，全部不依赖桌面 main 层，不重写存储/锁/journal/审核协议。

| 文件 | 职责 | 行数级别 |
|---|---|---|
| `contract.ts` | 受控错误码、资源预算（只能收紧不能放宽）、纯输入判定 | ~200 |
| `fields.ts` | 档案字段的**单一命名来源**（编译期与 `ProjectIdentity` 对齐）、初始"未知"形态 | ~110 |
| `binding.ts` | B1：显式绑定 + 只读打开（registry ↔ profile ↔ 目录一致性） | ~430 |
| `detection.ts` | B2：有限检测候选与资料缺口（只读，绝不写档案） | ~330 |
| `confirm.ts` | B3：人工确认 + CAS（独立写动作） | ~280 |
| `workspace.ts` | B4：每工作区快照（Git）+ 证据复验 | ~330 |
| `view.ts` | B4：把档案/检测/证据喂进 M1，输出受预算限制的视图 | ~340 |

### 2.1 B1 显式绑定与档案打开

- **授权先于 IO**：目标目录必须能由 `cwd` + 适配层注入的授权根解析出来（复用 `resolveAuthorizedTargetDir` 的真实路径判定）；模型参数无法扩大范围。被拒时**不触碰知识库**（永久回归比对 registry 文件 hash 不变）。
- **不猜合并**：同目录名、同内容、同远端都不构成"同一项目"。不带 `projectId` 绑第二个目录 ⇒ 两个项目；要挂到已有项目必须显式给 `--project-id`。新项目/工作区用 `randomUUID()`（稳定 UUID，非目录名派生）。
- **重复执行先读现状**：已绑定的目录再次 bind 会得到 `registry:skipped / profile:skipped`，不会产生第二份项目或工作区，也不会无意义地递增 registry revision。
- **路径迁移**：显式给出 `workspaceId` + 新路径 ⇒ 替换 registry 里那一条（保持 workspaceId），档案里同步改 path。（开发中先写成"追加"，立刻被 `inspectBindingIssues` 的 `duplicate-workspace-id` 拒绝 —— 这正说明存储层的一致性检查挡在正确的位置。）
- **没有跨文件事务**：registry 与 profile 是两步。固定顺序（registry 先）逐步记录发布事实；档案步骤失败 ⇒ `status=partial` + `resume` 明确写出"重新执行同一 bind 即可继续"，不自动回滚、不删档案。registry 步骤失败 ⇒ 直接 `failed`，**不**去建一份"档案说属于某项目、registry 里没有这个绑定"的半成品。
- **只读打开**：返回 `usable / inconsistent / unreachable / missing` 四态；档案缺失、工作区不在档案里、两条路径不一致分别报 `profile-missing` / `workspace-not-in-profile` / `workspace-path-mismatch`；目录不可达只改 `availability` 并**保留绑定**。只有 `usable` 才允许被后续业务当成"打开的完整结果"。

### 2.2 B2 有限检测候选与资料缺口

复用既有的只读目录线索探测（有界、拒绝链接、句柄成对关闭）拿构建设描述文件样例，然后**真读内容**解析：

| 规则 | 来源 | 落点 |
|---|---|---|
| `edk2-dsc-platform-name` | `.dsc` 的 `[Defines] PLATFORM_NAME` | `buildTargets`（**不是** boardName） |
| `edk2-dsc-include` | `.dsc` 的 `!include <path>` | `keyEntryPoints` |
| `edk2-dec-package-name` | `.dec` 的 `[Defines] PACKAGE_NAME` | `keyEntryPoints` |

- 每条候选带**可复核证据**：所属 workspace、相对路径（POSIX）、实际采集时间、被解析文件的 SHA-256、行号；永久回归用独立 `crypto` 计算的 hash 对照，并断言"改了文件内容候选就跟着变"（证明是读文件而不是预填）。
- **不猜身份**：`PLATFORM_NAME` 不映射板名；看到 `.dsc/.inf` 不推断 IBV/芯片厂商/代际。`UNSUPPORTED_IDENTITY_GAPS` 是**产品行为**而不是文档：每次检测都返回这些缺口（含"需要什么资料"），保证"检测过一轮"不会让调用方以为身份已经齐了。
- **预算**：文件数 / 单文件字节 / 总字节 / 候选数 / 目录扫描路径 / 深度 / 取消，全部命中即 `truncatedBy` 如实标记并转成可见的资料缺口；工作区根外链接（含直接构造的 `..` 与绝对路径证据）拒绝读取。
- **只读**：`wroteToProfile: false`，永久回归比对档案文件 hash 不变。

### 2.3 B3 人工确认与 CAS

- 有限字段 allowlist（身份字段 + `buildTargets`/`keyEntryPoints`），未知字段名、空串、超长、控制字符、数组字段的 `null`、同字段重复、指向不存在工作区的证据 —— 全部在 IO 之前受控拒绝。
- 与已有确认值相同 ⇒ `no-change`，**不**制造无意义的 revision 递增。
- 只改被点名的字段：未触达字段、其它工作区、已有证据与资料缺口原样保留（永久回归逐项断言）。
- 期望 revision 不符 ⇒ `revision-conflict` + 返回实际 revision，**不写**（永久回归比对原字节 hash 不变）；现有领域确认竞争是同一 Node 进程中两个并发调用，并非两个进程，恰好一个 `confirmed`、另一个 `revision-conflict`。真实双子进程确认竞争待下一批补证。
- 确认动作在 schema **已有**的 `ProjectField.evidence` 里留痕（`human-note` + 采集时间；可选 `source-file` + 相对路径 + 内容 hash）。没有往 v1 添加 `confirmedBy`/history 等未定义字段；`operatorLabel` 明确只是声明，不是身份认证，也不等于经验卡审核审计。

### 2.4 B4 每工作区快照、证据复验与 M1 消费

- 快照按工作区**分别**采集：`availability`、`branch`、`head`、`capturedAt`。Git 用固定 argv（`git -C <dir> rev-parse …`）、无 shell、`timeout` + `maxBuffer` + `signal` 限时限输出并可取消；**不** fetch、不执行项目脚本、不读认证信息；远端 URL 不自动采集（`null`，因此没有凭证泄漏面）；非 Git 目录**省略** `vcs` 字段而不是写空字符串；detached HEAD ⇒ `branch = null`。
- 永久回归用**真实仓库 + 真实 worktree + 真实 detached HEAD** 对照：两个 worktree 各自的 HEAD 都入档且互不冒充，主检出的 HEAD 不会被 worktree 的值覆盖。
- 证据复验按"所属工作区 + 相对路径"重新有界读取并比较 SHA-256：`valid` / `changed`（给出实际 hash 供人工对照）/ `missing` / `unreadable` / `not-verifiable`（commit 类或没有路径/hash）/ `not-checked`（超预算，计入 `uncheckedCount` 并让视图标不完整）。
- 刷新快照是**只改一个工作区条目**的 CAS 写（`refreshed` / `unchanged` / `revision-conflict`）；它不动身份字段、构建目标、其它工作区与人工确认值。
- M1 消费（`view.ts`）：档案字段 → `project-profile` 族事实；检测结果 → `detected-candidate` 族事实；两者对同一业务事实键（`project-profile.<field>`）⇒ 确认值与新候选自然形成 `needs-confirmation`。证据复验结果覆盖到候选的 `evidence[].validity`（`changed→stale`、缺失→`unavailable`、超预算未看→`stale`），依赖快照**声明侧取档案里记录的采集时刻 HEAD、目标侧取本次读到的当前 HEAD** ⇒ HEAD 变化自然变成 `verification-drift`。
- 视图明确写出它**不是**原子快照（registry/profile revision 分别列出），并且**不改档案**：证据变 stale/unavailable 只影响本次视图，不自动删证据、不覆盖人工确认。

## 3. 节点 C：人工入口与一次完整演示

- `cli/project.mjs`：薄入口，只做"解析参数 → 调领域 API → 打印受控结果"，领域规则一条都不复制。命令 `open / bind / detect / confirm / refresh / read / help`，命令与选项顺序无关。
- **显式路径**：`--root` 必填，**没有**任何默认知识根回退；工作区必须显式给出。
- **离线**：只碰本地文件系统与本地 git。
- **写入确认**：`bind`/`confirm`/`refresh` 缺 `--write` ⇒ 退出码 3 + 单个 JSON `write-not-confirmed`，并列出"本来会做什么"；永久回归断言此时 registry 未变。
- **JSON/退出码**：`--json` 时 stdout 恰好一个可解析对象，payload 显式带 `code` 与 `exitCode`（脚本只按 `code` 分流）。退出码：0 成功｜2 用法错误｜3 被拒绝（缺写确认 / 未授权）｜4 revision 冲突｜5 不一致｜6 未找到｜7 取消或 IO 失败。未知命令/超长参数回显有界。
- **取消**：`SIGINT`/`SIGTERM` 转成 `AbortSignal` 传进文件与 Git 子进程（核心层取消路径有永久回归）；若已写入则按 `bind` 的 `steps`/`resume` 如实报告发布事实。
- `cli/project-scenario.mjs`：合成端到端演示，**每一步都重新启动 `cli/project.mjs` 子进程**（因此"新进程读取"是真的新进程），只读写临时目录。10 步：初始化 → 未确认写入被拒绝 → 绑定 → 有限检测（身份仍未知 + 真实候选）→ 确认 → 采集初始快照 → 新进程读回同一 ID/revision/确认值 → 改证据文件并提交（HEAD 变化）后重读提示变化但确认值未覆写 → 显式刷新后漂移消失 → 第二工作区独立快照不互串 → 越权路径在 IO 前被拒。

## 4. 整批门禁（实施方实跑）

```powershell
# packages/bios-agent
npm test                       # 711 项：707 通过、0 失败、4 显式 skip
node --test tests/storageBackup*.test.mjs tests/knowledgeCli.test.mjs tests/memory*.test.mjs tests/project*.test.mjs
                               # 288 项：287 通过、0 失败、1 skip
node --test tests/storageRecords.test.mjs tests/storageRegistry.test.mjs tests/storagePreflight.test.mjs `
  tests/storageJournal.test.mjs tests/storageReviewWriter.test.mjs tests/storageWrite.test.mjs
                               # 249 项：246 通过、0 失败、3 skip
npm run typecheck              # 通过
npm run selfcheck              # 6 项通过
npm run check:format           # 120 文件通过
node cli/project-scenario.mjs  # status=ok，failures=[]
node cli/memory-scenario.mjs   # 合成 PXE 场景

# 仓库根
npm run typecheck              # 通过
npm run check:format           # 2014 文件通过
node --test tests/processGuards.test.mjs   # 2 项通过
git --no-pager diff --check    # 通过
```

本轮相关用例分布：`memoryDecisions.test.mjs` 25、`memoryPxeScenario.test.mjs` 3（memory 合计 28，上轮 22）、`projectBinding.test.mjs` 9、`projectDetectionView.test.mjs` 9、`projectCli.test.mjs` 5、`projectScenario.test.mjs` 2（project 合计 25）。711 = 上轮 680 + 31。

4 个已有 skip 是本机**文件型 symlink** 创建权限所限，不计为通过。本轮新增项目根外文件链接分支创建失败时只输出 diagnostic、仍算通过，未执行该分支，也不属于上述 4 个显式 skip；下一批纠正。演示脚本与合成诊断不计入永久用例数。

## 5. 未测与边界

- **未测**：真实 ACL、网络盘、断电、其它 OS、远端 CI、生产安装包；真实 AMI/Insyde/百敖平台、真实 EDK II 大库、其它构建格式（`.fdf`/`.asl` 只作为线索计数，不解析）；真实双进程确认竞争及其它真实并发工作流；桌面 UI、Session/Pi 注入、RAG/向量库、自动批准经验。
- **检测能力边界**：只有三条真实规则（DSC 平台名、DSC include、DEC 包名）。板名、IBV、芯片厂商/家族/代际、客户、产品线**没有**合法规则，一律保持 `unknown` 并列入缺口。检测上限是资源预算而非正确性保证。
- **一致性边界**：视图**不是**跨 registry/profile/源码/Git 的原子快照；不承诺消除 TOCTOU；不隔离同机恶意写入者；`authority`/`authorization` 仍是调用方声明，不构成企业认证或权限服务。
- **CLI 边界**：它是验收/工程师手动入口，不是桌面正式接入；未注册为模型知识写工具；`SIGINT` 路径只做结构与核心层覆盖，未做真实按键时序测试。
- **未改范围**：schema 未升级、无迁移器、无通用多记录事务、无历史字段查询；未重写存储/锁/journal/审核/备份设计；未改 Electron/PiRuntime；未读真实客户知识库或客户源码；保留 dirty tree、未跟踪文件与六项既有历史文档删除；未 add/commit/push。

## 6. 实施时交接快照（当前执行见 §7）

- 实施时建议路线为 BM-04 经验/Feature → BM-05 任务/上下文 → BM-06 Pi 专业工具 → BM-07 UI。当前具体任务以 [BM-04 批次](bm04_development_plan.md) 与 §7 为准。正式需求沿革、字段历史或耐久来源 hash 若需要新格式，另交 M2 设计再评审，不要把全部时态存储升级变成业务前置。
- 已知可改进但**本批未做**（不属当前验收范围）：
  1. 检测只支持 EDK II 三条规则；`.inf`/`.fdf` 只计数不解析（要加规则必须是"有字段语义"的规则，而不是看到文件就推断厂商）。
  2. `view.ts` 把数组型字段的多个条目合成一条事实（值用排序后的逗号连接）；如果将来需要"逐个构建目标的确认状态"，要改成每条目一个事实键，并同步调整确认入口。
  3. 证据变 stale/unavailable 只体现在视图里，**没有**写回档案的 `evidence[].validity`；如果将来需要"档案里也记录复核结论"，要单独设计一个显式动作，而不是让读取顺手改库。

## 7. 第二十八轮独立验收回写

- 独立 Package 711 项（707 通过、0 失败、4 skip），targeted 288 项（287 通过、1 skip）、旧存储 249 项（246 通过、3 skip）及指定门禁通过；项目真实新进程演示与 M1 PXE 演示通过。
- R27-1/3 原场景独立关闭。R27-2 只部分关闭：缺源及简单有效关系已修复，但分叉环仍随数组顺序变化，被撤回来源仍支持替代，未授权关系仍影响可见目标，见 R28-3。
- BM-03 正常项目闭环已交付，但 R28-1（发布后异常/warnings 丢失）、R28-2（字段证据互串、截断/实际 IO/取消）、R28-4（入口授权与 CLI）阻塞整批通过；不得以 §4 全绿覆盖这些额外诊断。
- 项目链接分支未执行、确认竞争仅同进程；已在本文件纠正覆盖声称。下一批补明确 skip 与真实双进程证明。
- 当前 [R28 收尾＋BM-04 完整业务](bm04_development_plan.md)，内部修复通过后继续经验/Feature 录入、审核、检索与跨项目参考，一次交回；保持 v1、无 UI/迁移/真实客户库。

## 8. BM-04 节点 A 的修复回写（R28-1/R28-2/R28-4 对 BM-03 的影响）

上面 §4 的门禁数字与 §7 的独立结论保持不变；本节只回写**同一批代码在 BM-04 里被修掉的事实**，完整证据见 [BM-04 实施记录 §1](bm04_implementation.md#1-节点-a-r28-14-旧红新绿)。

- **写入事实（R28-1）**：`core/projects/writeNotes.ts` 现在把存储层的 `cleanup`/`lockRelease`/`journal.state`/`warnings` 折叠进 `BindProjectResult` / `ConfirmProfileResult` / `RefreshWorkspaceResult`；
  bind 新增状态 `needs-review`（已提交但需要人工核对），档案读取失败不再抛错而是返回 `partial` + 已发布身份/revision/续办提示；CLI 退出码新增 **8**。
- **检测与证据（R28-2）**：检测不再依赖 `stat` 的大小（改用 `readFileBounded` 的实际字节封顶）；证据复验改为按事实键分组、两类独立预算，结果带回 key；视图按事实键归属证据、未复验事实显式列出、部分结果 ⇒ `incomplete`。
- **授权与 CLI（R28-4）**：`open`/`detect`/`capture`/`verify`/`refresh` 都要求在调用时给出本次会话的 `cwd`（+ 可选授权根），并在访问工作区之前重新判定；`openProjectProfile` 新增 `not-authorized` 状态；`cli/project.mjs` 的参数解析/退出码/输出改为与 `cli/business.mjs` 共用 `cli/cliArgs.mjs`，命令级参数白名单与安全整数校验在任何 IO 之前生效。
- 覆盖声称已经修正：项目 symlink 分支在 `EPERM` 时**显式 skip**（不再"只输出 diagnostic 仍算通过"）；`confirm` 的并发验证改为**两个真实 Node 子进程**竞争同一 revision（一成一败、失败方不留痕迹）。

## 9. 第二十九轮独立复验回写

R28-1/2/4 核心项目回归与正常项目演示通过；真实双确认子进程已执行，新增项目文件型链接权限分支显式 skip。共享 M1 关系范围/授权仍待 R29-4，不能据本节宣称全部边界通过。BM-04 正常业务已交付但四组有限收尾尚未关闭；最新见 [第二十九轮验收](round29_acceptance.md)，当前执行 [BM-05 完整批次](bm05_development_plan.md)，不重新开发档案模块。
