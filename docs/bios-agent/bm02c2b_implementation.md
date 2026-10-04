# BM-02C2B 实施记录：一次经验卡审核的最小持久化闭环

日期：2026-10-01。工作区 `D:\BIOS_Pi_Agent\PiDeck_BIOS`，分支 `BIOS_Agent`。
状态（2026-10-02 更新）：**第十五轮独立复验通过声明范围，I1 关闭，审核持久化整改收口**：348 用例/346 通过/0 失败/2 权限 skip，六文件 165 项全绿。
证据见 [第十五轮验收](round15_acceptance.md)，I1 修复见下文 §12；[接续标准 §6](bm02c2br2_development_plan.md#6-当前唯一接续任务i1) 已完成、旧提示词不重跑。下一轮仅执行 [BM-02C3](bm02c3_development_plan.md)。
下文 §1～§9 是 C2B 历史，§10/§11 是两轮实施方快照；**§12 是 I1 修正后的唯一有效描述**（§11 的"提前退出不丢诊断"当时有 I1 例外）。

前置：[第十一轮独立验收](round11_acceptance.md)（C2A/C2AR 协议与纯校验通过，A1～A3 关闭）、
[C2B 任务](bm02c2b_development_plan.md)、[C2A 实施记录 §3](bm02c2a_implementation.md)（修正后的唯一协议）。
上级文档：[导航](README.md)、[任务表](task_breakdown.md)、[测试清单](test_checklist.md)、[MVP 主方案](mvp_development_plan.md)。

本轮把已通过的纯契约接到了**真实文件 IO**，形成闭环：
**人工调用领域 API → 一条已有 ExperienceCard 的状态变更 → 不可变审计事件 → 新进程显式核对/收尾**。
**普通写（v1）与 C1 的行为一行未改**：本次只新增并列的审核路径。

---

## 1. 交付边界（先说不做）

**做了**（`packages/bios-agent/core/storage/review/`）：

| 编号 | 交付 | 落点 |
|---|---|---|
| C2B-1 | 完整审核 journal v2 契约 + 意图/事件的**真实字节**工件 IO | `review/contract.ts`、`review/artifacts.ts` |
| C2B-2 | 一次审核的领域写入口（同一目标锁贯穿；记录只提交一次；提交后失败如实报 pending） | `review/decisions.ts`（纯策略）、`review/writer.ts`、`review/commitSteps.ts` |
| C2B-3 | 只读巡检 + 显式恢复（事件先于完成终态；无重放/抢锁） | `review/inspect.ts`、`review/reconcile.ts` |
| C2B-4 | 故障/竞争永久回归 + 本文档 + 导航同步 | `tests/storageReviewWriter.test.mjs`、`tests/storageReviewReconcile.test.mjs` |

**明确不做**（与任务书一致）：通用 N 文件事务、批量审核、跨项目修改、自动后台恢复、模型审核工具、
锁抢占/回收、数据重放/回滚、迁移/备份/CLI/UI、RAG、厂商适配、企业身份认证、`verified` 的硬件证据真实性判定。
未改 Electron/PiRuntime，未读取客户资料，未 `git add`/`commit`/`push`。

**普通写未变**：`JOURNAL_SCHEMA_VERSION = 1`、五类记录 `schemaVersion = 1`、`core/storage/write.ts`
与 `core/storage/journal/{contract,writer,wiring}.ts` 的规则与字段**一行未动**；`createRecord` / `updateRecord`
仍只产生 v1 journal。审核使用**并列的 v2**。

---

## 2. API 与结果

### 2.1 入口

```ts
recordReviewDecision({
  root, recordId, expectedRevision, action, operatorLabel, reason, evidence?,
  limits?, signal?, ioHooks?, now?, lockTimeoutMs?, lockPollMs?,
}): Promise<ReviewDecisionResult>
```

- **不接受**整条替代记录、自由路径、授权根或 `toStatus`：状态由 `AUDIT_ACTION_TRANSITIONS` 结合**当前状态**推出。
- **不接受** `expectedRevision: null`（审核必然是 update）。
- 生成并返回稳定的 `operationId` / `eventId`；重试/恢复必须用返回的 `operationId` 调 `reconcileReviewOperation`，
  **不盲目重新发起**（重新发起会拿新的 operationId，不会与旧工件对撞，但也不会替你收口旧现场）。

### 2.2 结果（判别联合）

| `kind` | 含义 | `audit` | `journal.state` |
|---|---|---|---|
| `applied` | 业务已提交、审计已存在、终态已写 | 真实事实（首发布或认领） | `committed` |
| `applied-audit-pending` | 业务已提交、**审计待补** | `null`（不预支发布事实） | `prepared` |
| `applied-journal-pending` | 业务已提交、事件已发布/认领、**终态待收口** | 真实事实 | `prepared` |

`audit` 里只有 `eventId` / `relativePath` / `publication` / `recordedAt` 四个字段，**没有**"计划写什么"这类
暗示。其余失败一律**抛结构化错误**（与 `updateRecord` 同一风格）：

| 场景 | 错误码 | detail |
|---|---|---|
| 陈旧/非法 revision、`null` revision | `revision-conflict` | — / `review-with-null-revision` |
| 动作不在枚举内 | `invalid-record` | `unknown-review-action` |
| 动作与当前状态不匹配 | `invalid-record` | `review-action-mismatch` |
| 证据下标指向不存在的证据/验证记录 | `invalid-record` | `review-evidence-index` |
| 记录不存在 | `not-found` | — |
| 知识库未初始化（registry 读不动） | `not-found` / 其它 registry 错误 | `store-not-initialized` |
| 同 operationId 已有**不同字节**意图 | `audit-conflict` | `review-intent-conflict` |
| 同 operationId 已有 v2 journal | `audit-conflict` | `review-journal-exists` |
| 锁等待超时 | `lock-timeout` | 持锁者诊断 |

`audit-conflict` 是本轮**新增的唯一错误码**（`core/storage/errors.ts`）：它的可行动作是"人工判断"，
既不是可重试的并发冲突（`revision-conflict`），也不是 registry 绑定冲突（`binding-conflict`）。

### 2.3 巡检与恢复

```ts
inspectPendingReviewOperations({ root, limits?, signal?, ioHooks? }): Promise<InspectPendingReviewResult>
reconcileReviewOperation({ root, operationId, limits?, signal?, ioHooks?, now?, lockTimeoutMs?, lockPollMs? }): Promise<ReconcileReviewResult>
```

`reconcileReviewOperation` 的 `outcome`：

| outcome | 何时 |
|---|---|
| `committed` / `aborted` / `conflict` | 三种终态（`conflict` 也需要人看；`aborted` 时若存在事件则报 `inconsistent`） |
| `unreadable` | journal/意图/事件/目标读不懂（未来版本、坏 JSON、超限、链接…），**未改任何文件** |
| `inconsistent` | 读得懂但**对不上**：完成终态缺事件、意图指纹不符、事件与决定冲突、`aborted` 却有事件 |
| `busy` | 目标锁被他人持有（不抢锁、不删锁、不按 PID/年龄回收） |
| `not-review` | 这是**合法**的普通写 v1（请用 `reconcileJournalOperation`） |

巡检与恢复的分桶一致：**合法 v1** 才计入 `ordinaryJournalEntries`（普通写，不是问题也不是审核候选）；
`journalVersion: 1` 但结构不合法的文件**按问题保留**——把它算成"普通写"等于用一个正常计数掩盖坏文件。

---

## 3. 提交点与顺序（唯一版本）

```text
① 取 ExperienceCard 的原目标协作锁（与 recordReviewDecision / updateRecord 同一把、同一路径）
② 同源复读 + 校验 + expectedRevision；动作解析出唯一 toStatus
③ 意图 link            audit/intents/<operationId>.json        （非覆盖）
④ v2 prepared link     journal/<operationId>.json              （非覆盖）
⑤ 记录 rename          experiences/<recordId>.json             ★ 唯一业务提交点
⑥ 事件发布/认领        audit/<recordId>/<eventId>.json         （非覆盖）
⑦ v2 完成终态          （rename 替换自己那个 journal）           ← 只能在 ⑥ 之后
⑧ 释放自有锁
```

三条被代码形状固定下来的规则（评审时看调用顺序即可核对）：

1. `finalizeReviewJournalEntry(...committed...)` 在 `writer.ts` 里只有一处，且**位于事件步骤之后**；
2. 提交点之后的任何失败（事件失败 / 终态失败 / 迟到取消）都走**返回值**而不是异常；
3. 恢复器（`reconcile.ts`）走的是同一顺序：**先事件、后终态**，绝不"先收口再补审计"。

---

## 4. 状态 / 取消 / 清理表

| 阶段 | 失败或取消 | 业务记录 | 意图 | v2 journal | 事件 | 返回/抛出 |
|---|---|---|---|---|---|---|
| 参数/准入/取锁 | 前置校验失败、锁超时 | 不变 | 无 | 无 | 无 | 抛（`lock-timeout` 等） |
| 意图 link 前 | 发布失败 | 不变 | 无 | 无 | 无 | 抛原错误 |
| v2 link 前 | 发布失败 | 不变 | **保留孤立意图** | 无 | 无 | 抛原错误 |
| 记录 rename 前 | 失败/取消 | 不变 | 保留 | 尽力记 `aborted`；写不进去留 `prepared` | 无 | 抛原错误（+有界诊断） |
| **记录 rename 后** | 事件失败/迟到取消 | **已提交** | 保留 | `prepared` | 无 | **`applied-audit-pending`**（`audit: null`） |
| **记录 rename 后** | 实际字节 ≠ prepared 绑定 | **已提交** | 保留 | `prepared` | 无（不伪造） | **`applied-audit-pending`** + 指纹不一致警告 |
| 事件发布/认领后 | 终态写失败 | 已提交 | 保留 | `prepared` | 已发布/已认领 | **`applied-journal-pending`**（真实发布事实） |
| 全部完成 | — | 已提交 | 保留 | `committed` | 已发布/已认领 | `applied` |
| 锁释放 | 释放失败 | 已提交 | 保留 | 终态已写 | 已在 | 结论**仍然有效** + `warnings`（锁残留） |
| 临时文件清理 | 清理失败 | 已提交 | 保留 | 终态已写 | 已在 | `cleanup: "failed"` + `warnings`，**不改写"已提交"** |

取消语义（按阶段，不按"一刀切"）：

- **提交前取消**：`cancelled` 穿透（不被普通 FS 错误包装），业务不变、无事件；记账尽力而为
  （C1 的同一取舍：**原错误优先**，写不进去就留 `prepared`，由 reconcile 得出确定结论）；
- **提交后取消**：不否认已发生的事实，返回 `applied-audit-pending`，警告里说明"取消发生在提交之后"；
- **核对期间取消**：在尚未发布/写终态前穿透；一旦事件已发布，结果如实带事件事实，journal 未完成就报待收口；
- 锁的释放**忽略取消**（锁没有回收器，一次取消不该让目标此后永远写不进去）。

---

## 5. 真实 IO 与进程证据

### 5.1 工件（C2B-1）

| 工件 | 路径 | 发布方式 | 幂等规则 |
|---|---|---|---|
| 审核意图 | `audit/intents/<operationId>.json` | `link` 非覆盖 | 同 operationId **同真实字节** ⇒ `exists-identical`；字节不同 ⇒ `audit-conflict` |
| 审计事件 | `audit/<recordId>/<eventId>.json` | `link` 非覆盖 | 撞名只报 `exists`，是否认领由**纯比较**裁决；工件层从不判"对错" |
| 审核 journal v2 | `journal/<operationId>.json` | prepared 用 `link`；终态用 `rename` | prepared 撞名 ⇒ `audit-conflict` |

- `audit/` 目录由 `initializeKnowledgeStore` 的既有布局创建（本轮未改初始化）；
  `audit/intents/` 与 `audit/<recordId>/` **惰性创建**，旧知识库不需要迁移；
- 意图/事件读取**先限字节再解析**（`maxJournalBytes`，默认 16 KiB，与 v1 同预算，只能收紧）；
  `intentHash` 取**同一次有界读取**返回的字节指纹，不是"读回来再序列化一遍"；
- 校验与哈希**同源**：`readReviewTargetFingerprint` 用同一次 `readJson` 的结果做 `interpretRecord` + revision + hash
  （保留 C1R/J2 的结论）。

### 5.2 v2 契约（C2B-1）

v2 = v1 的通用字段（`journalVersion/operationId/operation/state/target/before/after/preparedAt/finishedAt?/source?`）
+ **审核判别位与绑定**：`journalPurpose: "review"`、`eventId`、受控派生的 `intentName`、`intentHash`。
校验顺序与 v1 一致（根形态 → 版本闸门 → 未知字段 → 结构与关系 → 终态三要素），并且：

- `operation` 必须是 `update`；`target.kind` 只接受 `experience-card`；`after.revision === before.revision + 1`；
- `intentName` 必须等于 `<operationId>.json`（不接受调用方给路径）；
- `completed` 终态必须带 `finishedAt`/`source`；`conflict` 只能由恢复观察产生。

**旧 C1 读者拒绝 v2**：`validateJournalRecord` 对 `journalVersion !== 1` 报 `unsupported-journal-version`
（v2 额外的键也会被当作未知字段报出）。永久用例断言版本拒绝这一条**必须存在**，
不因为先报了"多了几个键"就被当成小问题。

### 5.3 进程级证据（C2B-4）

| 场景 | 复现方式 | 断言要点 |
|---|---|---|
| 提交点已过、事件未发布 | `ioHooks.beforeIo` 在事件 `link` 前把子进程**挂住**并 `SIGKILL` | 记录已是新 revision、无事件、v2 `prepared`；新进程核对后发布 `recovery` 事件并收口；revision 不再变 |
| 事件已发布、终态未写 | 同上，检查点改在 journal `rename` 之前 | 事件存在（`writer`）；核对**认领**它（保留原 `publication`/`recordedAt`）后收口；恰好一条事件 |
| 两个真实审核进程同 `expectedRevision` 竞争 | 两个子进程等同一个"go"文件后同时发起 | **恰好一方提交**；另一方 `revision-conflict`；一个状态变更、一个有效事件、一条 committed v2；两边都释放锁 |
| 两个真实恢复进程竞争同一操作 | 同法，对同一个 prepared 操作并发 `reconcileReviewOperation` | 两者都得到 `committed` 且发布事实**一致**；只有一个 `changed`；一条事件；revision 不变 |

崩溃现场的残留锁：父进程**确认子进程已退出**后才在合成 fixture 里清理（这不等于产品自动抢锁；
产品行为是 `busy` + 人工确认）。

---

## 6. 永久用例与门禁实跑

新增 **42** 项永久用例（两个文件），基线 253 项不削弱：

| 文件 | 条数 | 覆盖 |
|---|---|---|
| `tests/storageReviewWriter.test.mjs` | 25 | 正常路径与三方绑定真实字节、动作/reviewer 规则表、连续审核历史不覆盖、全部提交前拒绝（原字节不变）、意图/v2/记录三处发布失败、提交前取消、事件失败、终态失败、迟到取消、意图撞名幂等与冲突、事件非覆盖、锁 busy/释放失败、v1 与 v2 共存、读回不依赖内存 |
| `tests/storageReviewReconcile.test.mjs` | 17 | 巡检只读与 v1/v2 区分、预算语义与中途取消、not-found/not-review/未知版本/坏文件、before ⇒ aborted、after ⇒ recovery 收口、writer 事件认领、更高 revision ⇒ conflict、意图缺失/被替换/事件缺失/aborted 有事件 ⇒ inconsistent、busy、**两个真实崩溃检查点**、**两组真实进程竞争** |

门禁（实施方实跑，2026-10-01，Windows + Node 24.14.1）：

| 目录 | 命令 | 结果 |
|---|---|---|
| `packages/bios-agent` | `node --test tests/auditContracts.test.mjs tests/auditAssociation.test.mjs tests/storageJournal.test.mjs` | **70 项：70 通过、0 失败** |
| 同上 | `node --test "tests/storageReviewWriter.test.mjs" "tests/storageReviewReconcile.test.mjs"` | **42 项：42 通过、0 失败、0 skip** |
| 同上 | `npm test` | **295 项：293 通过、0 失败、2 显式 skip**（均为文件型 symlink EPERM）；基线 253 未削弱 |
| 同上 | `npm run typecheck` | 通过 |
| 同上 | `npm run selfcheck` | 6 项通过 |
| 同上 | `npm run check:format` | 通过（55 文件） |
| 仓库根 | `npm run typecheck` | 通过 |
| 仓库根 | `npm run check:format` | 通过（2014 文件） |
| 仓库根 | `node --test tests/processGuards.test.mjs` | 2 项通过 |
| 仓库根 | `git diff --check` | 通过 |

体量（目标 ≤400 行，>600 评估拆分）：`contract.ts` 331、`artifacts.ts` 294、`commitSteps.ts` 106、
`decisions.ts` 122、`writer.ts` 376、`inspect.ts` 231、`reconcile.ts` 343 —— 全部在目标内。
抽查时若发现"只有定义、没有调用方"的导出，一律删除而不是留着当"将来的接口"
（`writer.ts` 初版 481 行：抽出 `commitSteps.ts` 并删掉 8 个未被使用的辅助导出后回到目标以内）。

---

## 7. 关键语义的"为什么"

- **为什么意图先于数据、事件后于数据**：意图是"人做过这个决定"的依据，必须在业务改变之前存在；
  事件是"这条决定已按这个身份发布"的事实，提前发布会在提交失败时留下"审计说变了、业务没变"。
- **为什么完成终态必须在事件之后**：终态的含义是"这次操作不需要人再看"。先写终态，
  一旦事件缺失就再也没人回来补（第十轮 A1）。
- **为什么已有事件按**稳定决定字段**认领**：`publication`/`recordedAt` 是发布事实，
  同一次决定由谁发布、发几次都不同；比字节必然冲突，覆盖又等于改写发布历史（第十轮 A2）。
- **为什么审核要有专用 v2 而不是靠"意图文件存在"**：文件存在不能证明它属于这次提交；
  v2 用 `operationId`/`eventId`/受控意图名/**意图原字节指纹**/target/before/after 绑定三方（第十轮 A3）。
- **为什么 reviewer 只在 approve 时被设置**：只有"批准"这一步存在审核人；打回/恢复提交会清除它，
  废弃**保留**原审核人（废弃不是一次审核通过）。把它写成表（`REVIEW_REVIEWER_EFFECT`）而不是散在 if 里，
  是为了让"谁算审核人"可单测、可评审。
- **为什么证据下标必须回查业务内容**：`record-evidence/0` 在一条没有证据的经验卡上是无法复核的声明；
  事件一旦落盘就不可改，宁可现在拒绝。
- **为什么新增 `audit-conflict`**：它的可行动作是"人工判断"，与可重试的并发冲突语义不同；
  错误码是调用方决定行为的依据，混用会让"重试"掩盖"工件被替换"。

---

## 8. 未测与边界

- **未做**：通用多文件事务、批量/跨项目审核、后台自动恢复、模型工具入口、CLI/UI、迁移与备份；
  未注册任何模型工具（审核入口只能由人工 CLI/UI 的域入口调用，本轮甚至还没有 CLI）。
- **身份**：`operatorLabel` 是声明，**不是**认证；没有用户表、签名或权限模型。
- **文件系统与持久性**：`recordedAt` 是**发布尝试时的时间标签**，不是精确落盘时刻，也不是掉电持久性保证；
  硬链接不可用时按既有策略 `publish-unsupported` 明确失败（不回退直写）。
- **孤立意图**：v2 发布失败时保留的意图**不在巡检候选里**（巡检只扫 `journal/`）。
  这是本轮已知限制：`audit/intents/` 下的孤儿需要人工比对；下一轮若要自动化，应先定义"孤儿意图"的判据
  （不能简单按年龄删除）。
- **`aborted` 却存在事件**：**第一次核对就报警**（见 §10.2）。事件路径由 `recordId`/`eventId`
  精确派生（`audit/<recordId>/<eventId>.json`），不需要扫目录——C2BR 修正了本文件此前
  "第一次只能给 aborted"的结论与理由。
- **未执行**：根全量测试、生产构建/安装包、干净 clone、远端 CI、Linux/macOS、断电实验、真实客户 BIOS 试点。
  子进程终止**不是**断电实验；并发竞争用例只证明"这两个进程、这台机器、这次时序"下的行为。
- **成本**：工件的解析仍走既有 TypeBox 校验（`Value.Errors` 急切物化），本轮的"有界"指读取字节与输出规模，
  **不**声称任意未知输入的校验成本恒定。

## 9. 下一轮建议（不自动开始）

1. 第十三轮复验已完成；**C2BR2 的 F1/F2 已实施完成（见 §11），下一步是交回独立复验**，R1/R3 不重做。
2. C2BR2 复验通过后再按依赖排迁移与 D；最小管理 CLI、备份恢复及后续 UI 仍未实现。

---

## 10. C2BR 有限整改（实施方快照，2026-10-02）

后续独立结论：[第十三轮验收](round13_acceptance.md) 关闭 R1/R3；R2 的 conflict 提前终态与 R4 的底层失败清理提取仍需修复。本节保留当时实施陈述，不替代上述结论；下一轮在本文件追加 §11，不再复制实施报告。

第十二轮独立验收结论是**整体不通过**：主体已落地，但 R1～R4 四组"看起来校验过、其实没有"的缺口被实测出来。
本节是整改后的唯一有效描述；§2～§5 中与之冲突的地方（如"完成终态"的措辞、"16 KiB 跟随 `maxJournalBytes`"的隐含假定）
以本节为准。**先红后绿**：先写失败回归（新增 `storageReviewContracts.test.mjs` 与 writer/reconcile 的新用例），再改实现。

### 10.1 R1：真正执行完整 v2 schema、审核工件硬限额、evidence 输入结构化拒绝

| 验收实测 | 现在 |
|---|---|
| `eventId="not-a-uuid"`、`target.id="../other"`、`target.id="con"`、`before.unexpected=…` 全部 `ok=true` | `validateReviewJournalRecord` 先过版本闸门与判别位，再执行 `ReviewJournalRecordSchema`（`collectSchemaIssues` 出脱敏诊断、`validateShape` 出**类型**），最后才是文件名/派生名/递增关系/终态三要素 |
| `before=MAX_SAFE_INTEGER-1 / after=MAX_SAFE_INTEGER` 被误拒 | 递增规则复用 `collectAuditRevisionIssues`（与事件/意图同一份）：`after` 允许恰好 `MAX_SAFE_INTEGER`，`before` 到顶才拒绝；审核入口另有 `revision-overflow` 守卫，保证 `revision + 1` 真的递增 |
| 配置 `maxJournalBytes=64 KiB` 后，17.6 KiB 的意图仍被读成合法 | 新增 `REVIEW_ARTIFACT_MAX_BYTES = 16 KiB` 与 `reviewArtifactLimit()`：**配置只能收紧**；意图/事件/审核 v2 的读取与写入全部走它（普通 v1 journal 的可配置预算不变） |
| `evidence:[null]` 抛裸 TypeError | `assertEvidenceList()` 在**取锁之前、任何解引用之前**按同一份元素 schema 校验形态/条数/字节/互斥，失败即 `invalid-record`（`invalid-evidence-shape` / `invalid-evidence-rules`）；稀疏数组的洞、未来 `kind`、非法下标同样结构化拒绝 |

红绿证据（`tests/storageReviewContracts.test.mjs`，4 项）：六类 v2 变体逐项拒绝且**与同一份 TypeBox schema 判定一致**（同时断言诊断不回显未知字段名/值）；
revision 边界正例+反例与"业务记录 revision 到顶 → `revision-overflow`"；16 KiB **精确边界**（16384 可读、16385 拒绝）与空白放大（+1000 字节前缀）；
配置收紧写入口（`maxJournalBytes=10` → `too-large`）；`evidence` 九种非法输入 + 稀疏数组 + 合法输入不受误伤。

### 10.2 R2：收口前先验证完整绑定与矛盾现场

- **顺序**：持锁复读后**先比锁定目标身份**，再判 `journal.state`。旧实现先处理终态，于是"被换成别的目标并写成终态"会被当成一次幂等核对。
- **完整绑定**：`loadBoundIntent` 现在复用 `compareAuditAssociation`（投影 ↔ 意图逐项比较 operationId/eventId/target/before/after + "声明指纹 == 实测指纹"），
  不存在事件时传 `null`。旧实现只比实测指纹、文件名 operationId 与 eventId，于是"改意图的 target/before/after 并把 `journal.intentHash` 更新为新文件的真实 hash"能一路发布成功。
- **目标 = before**：先精确读取**绑定的**事件路径（由 `recordId`/`eventId` 派生）。已有事件 ⇒ **第一次就 `inconsistent`**；坏事件 ⇒ `unreadable`；只有事件确实缺失才写 `aborted`。
  原 `storageReviewReconcile.test.mjs` 的"第一次 aborted、第二次 inconsistent"断言已按此**替换并写明旧断言为何错**（不是删除失败用例）。

红绿证据：三种伪造（target/before/after）逐项拒绝且无新事件/无终态/业务与工件字节不变；锁等待窗口内换目标 → `unreadable`；
未来版本的意图 → `inconsistent`；绑定路径上是坏事件 → `unreadable`（原文件字节保留）。

### 10.3 R3：先认领已有事实，按恢复阶段返回真相

- **认领优先**：恢复先判定绑定路径上的事件（`inspectBoundEvent`，writer 与 recovery 共用）：存在且决定一致 ⇒ 直接认领其 `publication`/`recordedAt`，
  **不构造新候选、不尝试发布**，因此不受本次时钟回拨、也不受新候选序列化预算影响；只在事件确实缺失时才生成 recovery 发布事实。
- **时钟策略**：`recoveryRecordedAt()` 只有拒绝一种选择——`now < decidedAt` 时**拒绝发布**并返回可重试的 `pending`（不把回拨时钟"归一化"成决定时间，那等于伪造发布事实）。
  恢复时钟的类型/范围在入口校验（`invalid-review-clock`，属参数错误，可结构化抛出）。
- **阶段结果**：新增结论 `pending`（"业务已观察为 after，事件或终态待补"）。事件发布失败、终态写入失败、发布后迟到取消一律返回 `pending` 并带上当时已知的 `audit`/`observed`；
  **未发布前**取消仍穿透为 `cancelled`。终态失败不再把 `prepared` 说成 `committed`。

红绿证据（含验收要求的**真实 recovery 二次中断**）：
writer 事件 + 时钟回拨 ⇒ 认领（`publication=writer`、`recordedAt` 原值、事件字节不变）；
事件缺失 + 时钟回拨 ⇒ `pending` 且不发事件，校准时钟后同一现场能收口；合法但决定不同的事件 ⇒ `inconsistent` 且不覆盖；
发布失败 ⇒ 结构化 `pending`（`observed.revision=1`、`audit=null`、可重试，不抛异常）；终态失败 ⇒ `pending` 且 `audit.publication=recovery`；
发布前取消 ⇒ `cancelled`；发布后取消 ⇒ `pending` 且带已发布事实；
**子进程在执行 recovery、已发布事件、未写终态时被 SIGKILL** ⇒ 新进程认领第一次的 recovery 事件（时间不重打、事件字节不变、业务 revision/字节不变），仅清理其合成锁。

### 10.4 R4：全部工件清理诊断可传播

- 新增 `ArtifactCleanupFailure` 与结果字段 `artifactCleanup`（writer/reconcile 都是**始终存在**的数组，空数组 = 本次没有工件残留）；
  业务 `cleanup` 的定义保持不变（只表示记录文件的临时文件），两者谁也不能代表谁。
- 逐件来源：意图（created / exists-identical / 抛错里取回）、v2 prepared、事件（created / **exists 撞名分支** / failure / 迟到取消）、终态（失败错误里取回 + 成功但清理失败）、
  提交前抛错（`attachCleanupNote` 附加到**原错误**、原错误码不变）、认领冲突。
- 测试逐个注入 `unlink-temp` 失败并**对照磁盘**：事件目录里确实留下 `.tmp`；
  另外明确记录一处**语义差异**：`replaceJson`（业务记录、journal 终态）成功后临时文件已被 `rename` 改名成目标，因此"清理失败"只表示那个名字没删掉，磁盘上不存在第二份文件——
  不能一概要求"一定留下 .tmp"（`publishJsonMeasured` 的硬链接发布才会真的留下）。

### 10.5 C2BR 实跑与门禁（2026-10-02，实施方）

```text
node --test tests/auditContracts.test.mjs tests/auditAssociation.test.mjs tests/storageJournal.test.mjs \
  tests/storageReviewWriter.test.mjs tests/storageReviewReconcile.test.mjs tests/storageReviewContracts.test.mjs   → 143 项全绿
npm test          → 326 用例：324 通过、0 失败、2 个既有文件符号链接权限 skip（基线 295 未削弱）
npm run typecheck / selfcheck（6 项）/ check:format（56 文件）                                                   → 通过
仓库根 typecheck / check:format（2014 文件）/ processGuards（2 项）/ git diff --check                            → 通过
```

审核持久化用例由 42 项扩展为 **73 项**（writer 31 + reconcile 38 + contracts 4）：新增 R1 4 项、R2 6 项、R3 12 项（含真实二次中断）、R4 6 项，
并**替换**1 条把错误行为写成预期的旧断言。两个 skip 与基线相同，没有新增 skip。

### 10.6 C2BR 未测与边界

- 仍未做：迁移/备份、CLI/UI、RAG、平台适配、模型审核工具、后台自动恢复、企业权限；根全量测试、构建/安装包、干净 clone、远端 CI、Linux/macOS、断电实验未执行。
- 恢复时钟用的是注入/系统时间：本流程**不判断时钟是否被人为回拨**，只在"早于决定时间"这一可见矛盾上拒绝。
- `replaceJson` 的清理诊断语义（见 §10.4 末段）**未修改**：它是 BM-02B 的既有原语，改动面超出本轮范围；本轮只保证"诊断不被吞掉"与"与磁盘对照"。
- 当时结论：**C2BR 实施方实跑，交回独立复验**；后续第十三轮仍有 F1/F2，通过前不得作为迁移/UI 的前置依据。

---

## 11. C2BR2 两处收尾（实施方快照，2026-10-02）

独立补注：[第十四轮验收](round14_acceptance.md) 确认 F1 与 F2 主要失败路径通过，仍有意图 exists 后复读取消的 I1；事件路径的回归不能替代意图路径。接续修复在本文件追加 §12，不另建实施报告。

第十三轮独立验收结论：整改大部分有效，R1、R3 与真实 recovery 二次中断覆盖**关闭**；R2 的 conflict 提前写终态（F1）
与 R4 的底层失败清理提取（F2）各留一处遗漏。本轮只补这两处，不改已通过部分，不扩大为 C1 重构或异常体系改造。
**先红后绿**：先加永久回归，确认按第十三轮的复现步骤真的失败，再改实现。

### 11.1 F1：任何 prepared 收口之前都要过完整意图绑定

**旧行为（红）**：`!matchesAfter && !matchesBefore` 分支在 `loadBoundIntent` **之前**就写 `conflict` 终态。
把业务合法更新到下一个 revision（形成"既非 before 也非 after"的现场）后，8 种绑定破坏全部得到
`outcome=conflict、changed=true`，journal 被写成 `conflict`——此后核对只走 `verifyTerminalState` 的 conflict 分支，
**第一层的绑定问题再也看不见**（§10.2 那句"无论走哪条分支先验证完整三方绑定"是过度陈述）。

**修正后的分支顺序（唯一版本）**：

```text
持锁复读 journal
  → 锁定目标身份必须等于锁的对象（C1R/J1）
  → 判定 journal.state（非 prepared ⇒ verifyTerminalState）
  → 读目标指纹（不可判定 ⇒ unreadable，保留证据）
  → ★ 完整绑定：实测意图字节指纹 + operationId/eventId/target/before/after 逐项
      （loadBoundIntent 复用 compareAuditAssociation；不存在事件时传 null）
      失败 ⇒ inconsistent，changed=false，不写任何终态、不发事件、不改任何字节
  → 目标既非 before 也非 after ⇒ conflict（**绑定已验证**，合法意图 + 目标后续更新是正常现场）
  → 目标 = before ⇒ 绑定路径上"事件确实缺失"才 aborted，否则 inconsistent
  → 目标 = after ⇒ 认领已有事件 / 生成 recovery 发布事实 → committed
```

- **分类口径**：绑定失败一律 `inconsistent`——与"目标=after"时**同一口径**，即分类不随目标指纹分支漂移；
  `unreadable` 保留给"读不懂的**目标/工件文件**"（坏 journal、坏事件路径、业务记录不可判定、目标读不到）。
- **不取消合法 conflict**：正例（完整绑定 + 目标被合法更新）仍记 `conflict`，再次核对幂等、业务 revision/hash 不变。
- 红线未动：不自动迁移/回滚/篡改已落盘历史终态，不把普通写或任意磁盘编辑器拉进认证范围。

红绿证据（`storageReviewReconcile.test.mjs`，8 负例 + 1 正例；Node 含负例父测试共 10 项）：
8 个负例（意图被删 / `intentVersion=99` / 坏 JSON / 字节被改但 hash 未同步 / target·eventId·before·after 各自被改
且 `journal.intentHash` 同步为新文件真实 hash）——每一项都断言 `outcome=inconsistent`、`changed=false`、
journal 仍 prepared 且**字节不变**、业务与意图字节不变、无新事件、业务 revision 未被改动；
1 个正例断言 conflict 收口 + 二次核对幂等。

### 11.2 F2：失败路径也要把已发生的清理事实带出来

**根因（红）**：`boundary` 的 `publishJsonMeasured` / `replaceJson` 在失败路径附加的是**业务**文案
`CLEANUP_FAILED_NOTE`，而审核工件的提取器 `cleanupFailureFromError` 只认审核专用 `ARTIFACT_CLEANUP_NOTE`。
于是三种现场（writer 事件发布失败、recovery 事件发布失败、recovery 终态失败）都报
`artifactCleanup=[]`（recovery 终态那例连 warnings 也没有），**而磁盘上确有 `.tmp`**。

**修正**：

- `commit.ts` 新增 `attachCleanupFailureNote()` 与 `hasCleanupFailureMark()`：用 **WeakSet 结构标记**表达
  "这个正在传播的错误里有一次临时文件没删掉"。它不比对文案、不新增可枚举字段、不进入任何落盘内容、
  不改变原错误码/`detail`/`cause`；`boundary` 的两个失败点改用它（业务文案保持逐字不变，C1/journal 的文案匹配不受影响）。
- `artifacts.ts`：`cleanupFailureFromError` 先看**结构标记**、再保留文案兜底；`withCleanupNote` 改走
  `attachArtifactCleanupNote`，于是本模块自己抛出的冲突/读取失败也带同类标记。
- **提前退出不丢诊断**：`exists` 撞名后的重新读取（writer 与 recovery 两条路径）被取消/失败、
  恢复阶段发布前取消、提交前抛错，都在重新抛出**原错误**之前把已取得的清理说明附加到它上面（错误码不变）；
  未发布前的 `cancelled` 仍然穿透，只是不再"顺手抹掉"磁盘残留这份事实。
- 结果字段仍是 `artifactCleanup`（空数组 = 本次没有工件残留）；`applied-*` / `pending` 的 warnings 由它逐件生成。
- **归因边界**：只在当前工件的调用上下文里取回，不把别的工件诊断归到当前工件；不拿业务 `cleanup` 推断工件状态；
  没有清理失败时保持空数组（对照用例另断言：不删除历史残留、不凭目录内容捏造本次失败）。

红绿证据：`storageReviewWriter.test.mjs` 2 项（事件发布失败 + 事件 `.tmp` 删不掉 ⇒ `applied-audit-pending` 且
`artifactCleanup` 带 event、warnings 有诊断、磁盘确有 `.tmp`；意图发布失败 + 意图 `.tmp` 删不掉 ⇒ 抛出**原错误码
`permission-denied`** 且消息带工件残留诊断、业务未提交）与 1 项对照（无清理失败 ⇒ 空数组、不删历史残留）；
`storageReviewReconcile.test.mjs` 3 项（recovery 事件失败 ⇒ `pending` + event 诊断 + 磁盘 `.tmp`；
recovery 终态失败 ⇒ `pending`、保留 `publication=recovery` 的 audit 与 observed、review-journal 诊断 + 磁盘 `.tmp`；
`exists` 撞名后读取被取消 ⇒ `cancelled` 穿透但错误消息保留清理诊断）。

### 11.3 实跑与门禁（2026-10-02，实施方）

```text
node --test tests/auditContracts.test.mjs tests/auditAssociation.test.mjs tests/storageJournal.test.mjs \
  tests/storageReviewWriter.test.mjs tests/storageReviewReconcile.test.mjs tests/storageReviewContracts.test.mjs   → 160 项全绿
npm test          → 343 用例：341 通过、0 失败、2 个既有文件符号链接权限 skip（基线 326 未削弱，skip 未增加）
npm run typecheck / selfcheck（6 项）/ check:format（56 文件）                                                   → 通过
仓库根 typecheck / check:format（2014 文件）/ processGuards（2 项）/ git diff --check                            → 通过
```

永久用例由 326 增至 **343**（审核持久化 73 → **90**）：按 Node 含父/子测试计数，F1 10 项、F2 7 项，合计新增 17，先红后绿；
未删除、未放宽任何既有 R1/R3/R4 用例，仍保留 2 个 writer 崩溃检查点、1 个真实 recovery 二次中断与 2 组真实双进程竞争。

### 11.4 C2BR2 未测与边界

- 仍是**本机 Windows + Node 24 + 合成知识库**：未执行根全量测试、生产构建/安装包、干净 clone、远端 CI、Linux/macOS、断电实验；
  杀进程 ≠ 断电；并发用例只证明"这两个进程、这台机器、这次时序"。
- **原始 hook 错误不携带结构标记**：测试里若让 `beforeIo` 直接 reject 一个非 `StorageError`，清理说明不会被附加
  （`attachCleanupNote` 对非 StorageError 原样返回）。生产路径的发布/替换失败都经 `mapFsError` 变成 `StorageError`，
  因此该分支只出现在注入式测试里；本轮不为它扩大异常体系改造（改用 `ioHooks.link` 注入即走真实路径，见 §11.2 证据）。
- `replaceJson` 成功后"不一定存在额外 `.tmp`"的既有语义未改；C1/journal 的 `CLEANUP_FAILED_NOTE` 文案匹配未改。
- 当时结论：C2BR2 实施方实跑后交回复验；后续第十四轮已确认 F1 与 F2 主要路径通过，仍有 I1，完成标准尚未全部满足，不作为迁移/CLI/UI 的前置依据。

---

## 12. C2BR2 / I1：意图撞名后取消的清理传播（2026-10-02）

第十四轮独立验收：**F1 关闭**，F2 原三项主复现通过，只剩 **I1**（[round14 §3](round14_acceptance.md)）：`publishReviewIntentArtifact`
在"已有同字节意图"的复读被取消时直接重抛 `cancelled`，**丢掉了本次已经发生的 intent 临时文件清理失败**
（实测 `code=cancelled`、无清理诊断、磁盘上确有新增 `.tmp`）。这属于 C2BR2 原标准 §3 已要求的行为，不是新功能。

### 12.1 先红

在 `storageReviewWriter.test.mjs` 的工件幂等组新增 `I1`（父测试 + 4 个子用例）。红的那一项：
发布合法意图 → 用同 operationId、同字节再发布（走真实撞名路径）→ 仅在 `audit/intents/` 注入 `unlink-temp` 失败 →
在**复读已有意图**的 `beforeIo("read")` 上取消。修正前实测：`StorageError/code=cancelled`、消息只有"存储操作已取消"、
新增 `.tmp` = 1（诊断与磁盘不一致）。其余三个对照在修正前即为绿。

### 12.2 最小修复

`core/storage/review/artifacts.ts` 的撞名复读 catch：

```ts
if (isCancelledError(error)) throw published.cleanup === "failed" ? attachArtifactCleanupNote(error, "intent", relativePath) : error;
```

- 取消仍然穿透（没有发布任何新事实，不能被改写成 `pending`/冲突），但**本次**已取得的清理说明随错误一起出来；
- 判据只认**本次调用**的 `published.cleanup === "failed"`，不把目录里的历史残留归到这一次；cleanup 成功时不误报；
- 复用既有 helper（`attachArtifactCleanupNote` → `attachCleanupFailureNote` 的 WeakSet 标记），不另起异常体系；
  `cancelled` 码、`detail`/`cause` 与其它首错元数据全部保留，诊断是有界文案并带受控相对路径。

**同类分支审计**：审核模块里其余 5 处 `isCancelledError(error) → throw error` 都发生在"发布之前"的取锁/读指纹/纯读
（`reconcile` 的取锁与目标指纹、`readArtifact`、`readReviewJournalArtifact`、`readReviewTargetFingerprint`），
没有任何本次发布产生的清理事实可丢，因此不做连带改动。

### 12.3 四个对照（永久回归，`I1` 共 5 项）

| 现场 | 断言 |
|---|---|
| **清理失败 + 复读取消** | `cancelled` + `审核工件的临时文件清理失败` + 受控路径 `audit/intents/…`；新增 `.tmp` 恰好 1 个；原意图字节、业务字节、journal 数量不变；无新事件 |
| 清理成功 + 复读取消 | `cancelled`，**不含**清理诊断，`.tmp` 不增加（不误报） |
| 清理失败 + 不取消 | 仍 `exists-identical` 且 `cleanup="failed"`，新增 `.tmp` = 1（结论不被清理问题改写） |
| 已有意图是坏文件 + 清理失败 | `audit-conflict` 且带清理诊断，坏文件原字节保留（不覆盖） |

### 12.4 实跑与门禁（2026-10-02，实施方）

```text
node --test tests/auditContracts.test.mjs tests/auditAssociation.test.mjs tests/storageJournal.test.mjs \
  tests/storageReviewWriter.test.mjs tests/storageReviewReconcile.test.mjs tests/storageReviewContracts.test.mjs   → 165 项全绿
npm test          → 348 用例：346 通过、0 失败、2 个既有文件符号链接权限 skip（343 基线未削弱，skip 未增加）
npm run typecheck / selfcheck（6 项）/ check:format（56 文件）                                                   → 通过
仓库根 typecheck / check:format（2014 文件）/ processGuards（2 项）/ git diff --check                            → 通过
```

审核持久化 90 → **95 项**（writer 34 → 39）；F1、R1/R3、真实 recovery 二次中断、writer 崩溃检查点与双进程竞争回归全部保留。

### 12.5 I1 未测与边界

- 与 §11.4 相同的未测范围：本机 Windows/Node 24 与合成知识库；未跑根全量测试、构建/安装包、干净 clone、远端 CI、Linux/macOS、断电实验。
- 诊断只在"本次发布确实留下残留"时出现；磁盘上的**历史**残留不会被归到本次调用（对照已断言）。
- 低层工件 API（`publishReviewIntentArtifact`）是测试与恢复窗口的诊断入口，产品调用方仍应走 `recordReviewDecision`。
- 实施方交付时结论：I1 实施完成、待独立复验。后续[第十五轮验收](round15_acceptance.md)已独立复跑并关闭 I1，确认正式取消/磁盘残留/hash 对照与首错元数据传播；没有扩大为生产系统验收。
