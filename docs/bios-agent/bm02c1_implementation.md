# BM-02C1 实施记录（单文件 journal 与进程崩溃后结果核对）

日期：2026-10-01
状态：**C1/C1R 经第九轮独立复验在声明的本机范围通过，J1～J4 关闭**；
结论见 [第九轮验收](round9_acceptance.md)，当前任务见 [C2A](bm02c2a_development_plan.md)。
本文保留实施方历史过程与实跑；独立结论以验收报告为准，不代表审核持久化、迁移、D 或 UI 已实现。

- 需求：[BM-02C1 开发方案](bm02c1_development_plan.md)；前置独立结论：[第七轮验收](round7_acceptance.md)（BM-02BR 通过，基线 183 测试）。
- 范围：`packages/bios-agent` 的 `core/storage`、契约与测试，以及本包 README 与本文档。
- 明确不做：C2 审核审计/多文件事务/版本迁移、D 备份与管理 CLI、记录删除、RAG、厂商适配、模型写工具、桌面 IPC/UI、PiRuntime 改造。不引入数据库/服务/重型依赖。
- 记录 schemaVersion 仍为 1；journal 有独立 `journalVersion`。

## 1. 边界（先说清楚不做什么）

C1 采用**保守恢复**：journal 只记录"写入意图 + 提交前后 fingerprint"，恢复只做**核对并收口 journal**，
**不重放目标数据、不回滚目标、不重复加 revision**。未提交的业务操作由调用方重新读取后自行决定是否重发。

因此：

- journal 与"能从它重建丢失数据"无关——它**只存元数据与 SHA-256**，不复制客户记录正文。
- 进程崩溃后的**遗留锁仍不自动回收**（不按 PID/mtime/年龄抢占，不提供 `force` 后门）；
  活动锁或归属不明的锁让 reconcile 返回 `busy`，需人工确认。
- journal 文件是非可信输入，但**不是**权限凭据或防篡改签名；因为 C1 不允许据它改写业务数据，
  伪造 journal 也无法获得任意文件写入能力。
- 杀进程测试**不等于断电实验**：`fsync` + `rename`/`link` 保证的是"读者不会看到半成品"，
  掉电后目录项与数据块谁先落盘仍依赖文件系统。

## 2. journal 协议

### 2.1 布局与内容

落点：`<知识根>/journal/<operationId>.json`（`operationId` 由 storage 用 `crypto.randomUUID()` 生成，
**不接受调用方或 JSON 提供路径**）。`journal/` 目录**惰性创建**（首次写 journal 时），
所以旧知识库没有该目录仍完全兼容，初始化协议与 6 个布局目录语义不变。

```jsonc
{
  "journalVersion": 1,
  "operationId": "…小写 UUID…",
  "operation": "create" | "update",
  "state": "prepared" | "committed" | "aborted" | "conflict",
  "target": { "kind": "registry" } | { "kind": "experience-card", "id": "exp-x" },
  "before": { "revision": null, "hash": null },      // 不存在 = 两者皆 null
  "after":  { "revision": 0,    "hash": "…64位小写hex…" },
  "preparedAt": 1759300000000,
  "finishedAt": 1759300000100,                        // 终态必填
  "source": "writer-confirmed" | "recovery-observed"  // 终态必填
}
```

- `target.projectId` 只在 `task-record` / `context-manifest` 出现（与写入路径一致）；其余 kind 落点由 ID 决定。
- 路径**只由受控函数派生**（`recordRelativeSegments` 或常量 `registry.json`），journal 里没有绝对路径、
  临时文件名或锁路径，恢复侧也因此无法被诱导去写任意位置。
- `before`/`after` 的 hash 是 **SHA-256**：`before.hash` 取自"有界读取时实际读到的磁盘字节"，
  `after.hash` 取自"实际提交的同一份 `serializeJsonPayload` 字节"。**不允许**读 JSON 后再 `stringify` 重算。

### 2.2 校验（journal 是不可信输入）

`validateJournalRecord` 逐项校验，任一项不满足即拒绝（保留原文件、报告，绝不猜测或当空文件覆盖）：

| 项 | 规则 |
|---|---|
| `journalVersion` | 必须恰好为 1；其它值单独归类为"版本不支持" |
| `operationId` | 小写 UUID，且必须等于文件名主体（`<operationId>.json`） |
| `operation` / `state` / `source` | 枚举 |
| `target` | `registry`，或已知 `RecordKind` + 合法 ID；`task-record`/`context-manifest` 必须带 UUID `projectId`；其它 kind 不接受 `projectId` |
| `before`/`after` | `revision` 为 `null` 或 `[0, MAX_SAFE_INTEGER]` 安全整数；`hash` 为 `null` 或 64 位小写 hex；两者必须同时为 null 或同时非 null |
| 前后关系 | `create`：`before` 必须为"不存在"，`after.revision === 0`；`update`：`after.revision === before.revision + 1` |
| 时间 | `preparedAt`/`finishedAt` 为 `[0, Date 上限]` 安全整数；`finishedAt >= preparedAt`；`finishedAt`/`source` 仅终态必填 |
| 来源 | `state === "conflict"` 只能由 `recovery-observed` 产生（写入方从不写 conflict） |

### 2.3 写入顺序（唯一数据提交点）

```text
参数与有效库准入（assertStoreInitialized）
→ 取目标原有协作锁
→ 重读目标并校验 expectedRevision（含完整 schema 与预算）
→ 组装新值，算出 before/after fingerprint
→ 持久发布 prepared journal（同目录完整临时文件 + sync + close + link）
→ 数据提交：create = link 非覆盖发布；update / registry = rename 原子替换
   ← ★ 数据提交点
→ 写 journal 终态（rename 替换 prepared）
→ 释放自有锁
→ 返回实际结果（含 operationId 与 journal 状态）
```

关键语义：

- **数据提交点是 `link`/`rename` 成功**，不是"journal 终态写成功"。journal 只是记账。
- prepared 发布**失败**：不提交数据，原 hash 不变，直接抛原错误（此时连 journal 文件都没有）。
- prepared 之后、数据提交点之前的失败/取消：**保留原错误**，尽力写 `aborted`；
  写不进去就保留 `prepared` 并附加一句有界诊断（"journal 终态未写入，需 reconcile"），
  报告里的 `expected`/`actual`/`detail`/`cause` 与 `lockRelease`/`cleanup` 语义均不退化。
- 数据已提交后 journal 终态失败或迟到取消：**返回真实的 `created`/`updated`**，
  journal 状态为 `needs-recovery` 并给出警告，**绝不抛成可盲重试的"未提交"错误**，不重增 revision、不回滚目标。
- journal 自身也用完整临时文件 + `sync` + `close` + 提交原语，受 journal 字节预算约束；
  `prepared` 走 link（operationId 唯一，天然不覆盖），终态走 rename（替换自己的文件）。
- 初始化空 registry 继续走既有初始化协议，**不**改造成通用事务；低层 boundary 调用不产生 journal。

### 2.4 结果字段

`createRecord` / `updateRecord` / `updateRegistry` 的成功结果新增类型化字段（原字段不变）：

```ts
journal: {
  operationId: string;
  state: "committed" | "needs-recovery";
  relativePath: string;   // journal/<operationId>.json
};
```

`needs-recovery` 同时进入 `warnings`（含 operationId 与"不要重复提交同一 revision"的提示）。

## 3. 恢复 API（显式调用，不接模型/GUI）

### 3.1 `inspectPendingJournal(options)` —— 只读

有界扫描 `journal/`，返回候选与问题摘要，**不修改** target / journal / 锁：

```ts
type InspectPendingJournalResult = {
  scanned: number;                     // 实际读取的 journal 文件数
  truncated: boolean;
  truncatedBy: readonly string[];      // "entries" | "bytes" | "scan" | "problems"
  pending: readonly PendingJournalEntry[];   // 仅 state === "prepared" 的候选
  problems: readonly JournalProblem[];       // 有界、脱敏（不含正文）
  droppedProblems: number;
  skippedEntries: number;              // 非 .json 条目（含 .tmp 残留），不删除、不报错
  finalized: { committed: number; aborted: number; conflicted: number };
};
```

`journal/` 不存在 → 空结果（不是错误）。链接条目只报告、不读取。坏 JSON / 未来版本 / ID 与文件名不符 /
非法目标 / 超限均归入 `problems` 并保留原文件。

### 3.2 `reconcileJournalOperation(options)` —— 持锁核对

```ts
type ReconcileJournalResult = {
  operationId: string;
  relativePath: string;
  outcome: "committed" | "aborted" | "conflict" | "unreadable" | "busy";
  journalState: JournalState | null;    // 收口后（或读到的）状态
  observed: JournalFingerprint | null;  // 持锁复读到的目标状态
  target: JournalTarget | null;
  changed: boolean;                     // 本次是否写入了 journal 终态
  warnings?: readonly string[];
  detail?: string;                      // 受控说明
};
```

判定表（只有**对同一受控目标取到原有协作锁并复读**之后才允许改 journal 终态）：

| 持锁复读后的当前目标 | 处理 |
|---|---|
| 与 `after`（revision + hash）完全一致 | 记 `committed`，`source: recovery-observed`；不写目标、不递增 revision |
| 与 `before`（含 create 的"不存在"）完全一致 | 记 `aborted`（未提交）；**不**自动完成旧操作 |
| 与前后都不一致，或 revision 更高/同 revision 不同 hash | 记 `conflict`，报告人工核对；不覆盖新数据 |
| 目标缺失但 `before` 非"不存在" | `conflict`（数据可能被删/被移动，不能谎称未提交） |
| 目标坏 JSON / 未知版本 / 非文件 / 链接 / 超限 / 不可读 | `unreadable`：保留证据、不改 journal、不清空目标、不猜恢复 |
| journal 自身缺失 | 抛 `not-found` |
| journal 自身坏 / 版本未知 / 字段非法 | `unreadable`（不改任何文件） |
| 已有终态（重复恢复） | 幂等：直接返回该终态，`changed: false`，**不碰业务目标** |
| 目标锁被他人持有（超时） | `busy`：不改文件、不删锁、不按 PID/年龄抢占 |

并发：两个恢复者对同一目标争同一把锁，后进入者持锁后**重新读取 journal**，
若已是终态则幂等返回，因此不会互相覆盖；不依赖进程内队列。

`writer-confirmed` 与 `recovery-observed` 必须区分：字节相同只能证明"目标内容符合意图"，
不能证明一定是原写者提交，更不能冒充业务审核。

## 4. 资源与代码边界

- 新增 `core/storage/journal/`：`contract.ts`（类型/校验/常量）、`writer.ts`（prepared/终态）、
  `inspect.ts`、`reconcile.ts`、`index.ts`。**不**把 journal 塞回 `boundary.ts` / `write.ts`。
- journal 独立限额（可注入更小值，非负整数校验沿用 `resolveStorageLimits`；**默认值不为业务记录兜底**）：

| 限额 | 默认 | 0 的语义 |
|---|---|---|
| `maxJournalBytes` | 16 KiB | 单条 journal 元数据字节上限；0 = 任何 journal 都读不出（一律归入 problem），不会退化成"无上限" |
| `maxJournalInspectEntries` | 200 | 0 = 不返回候选（仍给出 `scanned`/`truncated`） |
| `maxJournalInspectBytes` | 256 KiB | 0 = 候选摘要全部因字节预算被截断（`truncatedBy` 含 `bytes`） |
| `maxJournalScanEntries` | 5000 | 0 = 不扫描目录（`scanned=0`，`truncated`） |
| `maxJournalProblems` | 50 | 0 = 不返回问题对象，但 `droppedProblems` 如实计数 |

- 扫描用 `listEntries`（`opendir` 有界），候选与问题都计预算；输出 `scanned`/`truncated`/`truncatedBy`。
- 大目录/坏文件不会整份物化进内存或上下文；不新增未经限额的 `readFile`。
- 注入面（`ioHooks`）仍只用于测试，不允许外部 JSON 指定执行代码；取消、句柄/目录/定时器清理规则不变。
- `closeFile` 注入点增加**第二个参数 `tempPath`**（既有实现忽略多余参数，兼容）：journal 接入后
  "临时文件"不再只有业务目标一种，用例必须能按路径区分，否则会测到 journal 自身的提交。

## 5. 分组落地与实跑

### C1-1 journal 契约、受控路径与真实字节 fingerprint

改动：

- 新增 `core/storage/journal/contract.ts`（368 行）：类型/常量、`journalRelativeSegments`、
  `journalTargetSegments`（恢复侧唯一路径来源）、`validateJournalRecord`（§2.2 全部规则）、
  `buildPreparedJournalRecord` / `buildFinalJournalRecord`、`assertJournalRecordValid`。
- 新增 `core/storage/pathBoundary.ts`（54 行）：把 `boundary.ts` 里**纯路径判定**
  （`describeJsonParseFailure`、`assertNoSymlinkAlongExistingPath`、`isWithinRoot`）抽出；
  `boundary.ts` 仍对外 `export { describeJsonParseFailure }`，公共 API 不变。
- `commit.ts`：新增 `payloadFingerprint(payload)`；`closeFile` 注入点增加第二个参数 `tempPath`
  （既有实现忽略多余参数，兼容）。
- `boundary.ts`：`readJson` / `readJsonForCleanup` / `publishJsonMeasured` / `replaceJson` 增加 `fingerprint`
  ——**有界读取返回实际读到字节的 SHA-256**，提交原语返回**实际写下去字节的 SHA-256**；
  没有新增任何不受限额的 `readFile`。
- `registry.ts`：新增 `readRegistryWithFingerprint`（`readRegistryWithBoundary` 改为调用它），
  校验与指纹**同源**，避免"校验的是 A、记进哈希的是 B"；`KnowledgeStoreLayout` 增加 `journalDir`
  （**不在初始化时创建**，旧库因此完全兼容）。
- `limits.ts`：新增 5 个 journal 限额（§4 表），沿用"非负整数 + 非法即拒绝"的既有校验，0 的语义写在类型注释里。
- `lock.ts`：`MAX_DATE_MS` 改为导出（journal 时间字段上界复用同一份定义）；
  `LockReleaseOutcome` 移到锁模块（供 reconcile 复用，避免反向依赖 `write.ts`）。

回归：

- 「三类入口都留下 committed 记录，且 before/after 是磁盘真实字节的指纹」：先把记录改成 **2 空格缩进**的合法 JSON，
  断言 `journal.before.hash` 等于该文件真实字节的 SHA-256，且**不等于**"重新序列化"的结果；
  create 的 before 必须是"不存在"，after 对应实际落盘字节。
- 「初始化不建 journal 目录（旧库兼容），首次写入才惰性创建」+ 无 journal 目录时巡视为空结果。

### C1-2 接入三类写入口

改动：

- 新增 `core/storage/journal/writer.ts`（110 行）：`prepareJournalEntry`（link 非覆盖发布，撞名即拒绝）、
  `finalizeJournalEntry`（rename 替换，**返回结果而不抛错**）；两者都走 boundary 低层原语，
  **不递归调用写入入口**（否则一次业务写入会生成 journal 的 journal）。
- 新增 `core/storage/journal/wiring.ts`（105 行）：`commitUnderJournal` 是"prepared → 数据提交 → 终态记账"的
  唯一顺序，外加 `releaseOwnLock` / `lockReleaseNote` / `needsRecoveryNote` / `recordAbortedBestEffort`。
  抽出的原因：`write.ts` 的职责是"入口 + 校验 + 持锁提交"，journal 接线是另一套时序与错误语义
  （顺带把该文件从 676 行降回 576 行）。
- `write.ts`：三类入口在**预算与 schema 校验之后、数据提交之前**发布 prepared；成功结果新增 `journal` 字段
  （`committed` / `needs-recovery` + operationId + 相对路径），`needs-recovery` 同时进 `warnings`。
  `WriteJournalOutcome` 定义在 `journal/contract.ts`（避免"结果类型 ↔ 写入模块"的循环）。

回归：

- 「prepared 在数据提交点之前已落盘（窗外目标是旧字节）」：在业务目标 `rename`/`link` 的钩子里读 journal，
  必须恰好有一条 `prepared`，且目标仍是旧字节。
- 「prepared 发布失败 → 数据不提交、原错误保留、无 journal 残留」。
- 「提交前失败记 aborted；提交前取消保留 prepared 并给出有界诊断」：数据 IO 失败 → `aborted`（writer-confirmed）；
  提交前取消 → aborted 写入同样被取消，于是**保留 prepared + 消息里给出提示**（刻意的"尽力"语义，由 reconcile 兜底）。
- 「数据已提交但 journal 终态失败/迟到取消 → 真实成功 + needs-recovery，revision 只加一次」：
  注入 journal 终态 `rename` 失败，断言返回 `updated`、`revision=1`、`journal.state=needs-recovery`、警告含 operationId；
  随后 reconcile 得 `committed`，**revision 仍为 1**，且 `source=recovery-observed` 不冒充写入方。

### C1-3 有界 inspect + 持锁 reconcile

改动：

- 新增 `core/storage/journal/inspect.ts`（233 行）：`inspectPendingJournal`（只读、有界、目录不存在=空结果、
  候选/问题/扫描/字节四维预算，输出 `scanned`/`truncated`/`truncatedBy`/`skippedEntries`/`droppedProblems`/`finalized`，
  扫描途中取消穿透）与 `readJournalEntry`（供 reconcile 复用的有界读取 + 校验，额外区分"不存在"）。
- 新增 `core/storage/journal/reconcile.ts`（243 行）：`reconcileJournalOperation`。
  仅**终态**才"不开锁直接幂等返回"；`prepared` 必须先取**目标原有协作锁**、持锁**复读 journal**（幂等）、
  再复读目标指纹；判定表见 §3.2；`busy` 时一个字节都不改；释放锁忽略取消并如实上报。

回归：

- 「reconcile 对 before/after/更高 revision/坏目标的判定，且重复核对幂等」
  （committed / aborted / conflict / unreadable / 目标缺失 → conflict）。
- 「reconcile 输入与不可读 journal 的确定结论」（非法 operationId → `invalid-record`；不存在 → `not-found`；
  坏文件 → `unreadable` 且不改任何文件）。
- 「目标锁被占用时 reconcile 返回 busy —— 不抢锁、不改文件」。
- 「旧 prepared 不会覆盖后续的合法更新（判定冲突而不是重放）」。
- 「两个真实进程并发核对同一条 journal —— 只有一个改终态，且互不覆盖」（真实 `spawn` ×2 + 会合点；
  断言恰好一方 `changed=true`、终态一致、目标字节不变、无残留锁）。
- 「inspect 只读、有界：只把 prepared 当候选，坏文件保留原样」：伪造 committed / prepared / aborted /
  坏 JSON / 未来版本 / 文件名与 operationId 不符 / 非法 target / 非 `.json` / `.tmp` 残留，
  断言问题分类、跳过计数、**每个文件 hash 不变**、`.tmp` 不被清理、诊断不泄漏文件内容。
- 「inspect 的预算（0 语义）与扫描中途取消」：`maxJournalInspectEntries: 0` → 无候选且 `truncatedBy` 含 `entries`；
  `maxJournalProblems: 0` → 无问题对象但 `droppedProblems` 如实计数；`maxJournalScanEntries: 0` → 不扫描；
  扫描中 abort → `cancelled`。

### C1-4 真实退出与回归/文档

改动：新增 `tests/storageJournal.test.mjs`（985 行）。"真实进程退出"部分用 `spawn` + 检查点标记文件，
实际顺序是 **到达 checkpoint → 父进程终止（`SIGKILL`）→ 等待 `close` 确认子进程已退出 →
harness 清理本 fixture 自己的遗留锁**，覆盖 4 个检查点 ×（create / update），
并对 **registry 额外覆盖"已提交但终态未写"**：

| 检查点（`beforeIo` 命中即挂住，等父进程终止） | 崩溃后磁盘状态 | 新进程核对结论 |
|---|---|---|
| `prepared`：业务目标的 `write-temp` 之前 | prepared journal，目标未动 | `busy`（遗留锁）→ 人工清锁 → `aborted` |
| `temp-ready`：业务目标的 `link`/`rename` 之前 | prepared journal + 完整 `.tmp`，目标未动 | 同上；且核对**不清理**该 `.tmp` |
| `committed`：journal 的 `rename` 之前 | 数据已提交、journal 仍 prepared | `busy` → 清锁 → `committed`（**revision 不重复加**） |
| `final`：`lock-remove` 之前 | journal 已 committed（writer-confirmed）、锁还在 | 直接幂等返回 `committed`、`changed=false`，锁仍残留（不抢） |

每个检查点额外断言：未清锁前核对**不得修改目标 / journal / 锁 / 残留文件**（快照比对）、
核对后目标字节与崩溃时一致、`locks/` 在 harness 清理后为空。
harness 只在**确认自己启动的子进程已退出**后清理该 fixture 的确切遗留锁——这不等于产品自动抢锁。

实跑（2026-10-01，Windows + PowerShell + Node 24.14.1 + Pi 0.87.1）：

| 工作目录 | 命令 | 结果 |
|---|---|---|
| `packages/bios-agent` | `npm run typecheck` | 通过 |
| 同上 | `npm test` | **206 用例：204 通过、0 失败、2 显式 skip**（均为文件型 symlink EPERM） |
| 同上 | `npm run selfcheck` | 6 项通过 |
| 同上 | `npm run check:format` | 通过（39 文件） |
| 仓库根 | `npm run typecheck` | 通过 |
| 仓库根 | `npm run check:format` | 通过（2014 文件；该脚本**不检查**本 Package） |
| 仓库根 | `node --test tests/processGuards.test.mjs` | 2 项通过 |
| 仓库根 | `git diff --check` | 通过（不覆盖未跟踪文件内容） |

用例数变化：183 → **206**（新增 23 条，全部在 `tests/storageJournal.test.mjs`）；
`storageWrite.test.mjs` 只做"按路径收窄注入"的机械化修改，**未删改任何既有断言**。数量不是验收依据。

体量取舍：`boundary.ts` 578 行、`write.ts` 576 行（都在 600 行红线内），`journal/` 五个模块 105～368 行。
`pathBoundary.ts` 与 `journal/wiring.ts` 的抽取都是为了守这条红线，且都是**移动 + 转发**，
没有改变任何行为与公共 API。

### 5.1 未测、skip 与明确边界

- 未执行：仓库根全量测试、生产构建/安装包、干净 clone 独立工具链、远端 CI、Linux/macOS、真实客户 BIOS 试点。
- 两个 skip 仍是**文件型符号链接权限**（EPERM）：`storageRecords` 的最终记录文件 symlink 与
  `storageWrite` 的 registry 文件 symlink；journal 侧的链接用例用**目录 junction 实跑**（未跳过）。
- 故障注入（`ioHooks`）只用于确定性复现分支，**不代表本机磁盘真的发生过这些故障**。
- 杀进程测试 ≠ 断电实验：`link`/`rename` + `fsync` 只保证"读者不见半成品"，掉电后目录项与数据块谁先落盘未验证。
- 进程崩溃后的**遗留锁仍不自动回收**（不按 PID/mtime/年龄抢占，无 `force` 后门）：`busy` 需要人工确认，
  无人值守锁回收未实现。
- C1 **不会**重放/回滚业务数据，也不会据 journal 重建内容（只存元数据与哈希）；完整备份/重放属后续独立设计。
- 未实现（本轮明确不做）：C2 审核审计/多文件事务/版本迁移、D 备份与管理 CLI、记录删除、RAG、厂商适配、
  桌面 IPC/UI、模型写工具、PiRuntime 改造。

## 6. C1R（第八轮独立验收 J1～J4 的永久回归与最小修复）

先按验收报告逐条写成**永久回归**并记录红灯（14 条新用例，13 红 1 绿——绿的那条是"返回值路径的锁残留警告"
的不回归守卫，本来就成立），再最小修复；没有删改 206 条基线里的任何断言，也没有新增 skip。

| 项 | 复现（与验收报告一致） | 永久回归 | 红灯结果 | 最小修复 |
|---|---|---|---|---|
| J1 | 读 journal 后、`lock-mkdir` 前把 target 由 A 改成 B | `C1R-1：持锁复读到目标被改到别处时，不得继续持旧锁收口`、`C1R-1：目标比较必须覆盖项目归属` | 返回 `committed/changed=true`，journal 被写成 B 的终态，而 B 的字节与该 `after` 无关 | 新增 `journalTargetKey()`（由 `journalTargetSegments` 派生，覆盖 kind/id/**projectId**）+ 持锁复读后比对；不一致即 `unreadable/changed=false`，**不追新目标重新加锁** |
| J2 | 目标 `schemaVersion=999` / 结构残缺 / 路径 ID 与内容 ID 不符 / 归属不符 / registry 未知版本 / registry 绑定冲突 | `C1R-2`（6 个子用例，含"非法目标的真实 hash **恰好等于** `after`"的构造） | 全部被当成"合法但不同的一版"，记 `conflict` 并改写 journal | `readTargetFingerprint` 改为**同一次有界读取**后复用 `interpretRecord` 与新增的 `interpretRegistryValue`；解释不过即抛错 → `unreadable`，目标与 journal 原字节都不动 |
| J3 | 持锁读目标时 abort + `lock-remove` 注入 EIO | `C1R-3：核对抛错时保留首错，并附加有界的锁清理诊断`、`C1R-3：结论走返回值时…`、`C1R-3：journal 终态写入失败的清理诊断不被丢弃；成功收口的 cleanup 也要如实传递` | 抛出的 cancelled 消息里没有锁残留提示，磁盘却留下 1 把锁；终态失败的警告丢掉"清理失败"；成功收口的 `cleanup: failed` 被完全丢弃 | 错误路径改为"首错优先 + `attachCleanupNote` 附加固定诊断"；终态失败分支转发已附带的清理诊断；成功分支传递 `finalized.cleanup` |
| J4 | 一条 363 字节的候选数组配 300 字节预算 | `C1R-4：巡检的候选字节预算按真实 UTF-8 序列化计量`、`C1R-4：多条候选合计触顶与较长合法目标都按真实字节判定` | 返回 1 条候选（363 字节）且 `truncated=false` | 预算改为覆盖 `pending` 数组的**实际 UTF-8 序列化字节**（信封 `[]` + 逗号 + 每条 `JSON.stringify` 计量），逐条判定，不预先攒齐 |

### 6.1 约定（改这几处代码前必须先读）

- **预算口径**：`maxJournalInspectBytes` 只约束 `pending` 数组的序列化字节（含 `[]` 与逗号）；
  `problems` 由 `maxJournalProblems`（条数）+ 单条诊断长度上限独立约束；`scanned`/`truncatedBy` 等统计字段
  不计入。**不能**把它宣传成"整个返回对象的硬上限"。空数组的信封开销（2 字节）是固定成本，
  因此 0 预算下不返回任何候选。
- **目标解释唯一来源**：记录走 `interpretRecord`，registry 走 `interpretRegistryValue`
  （`readRegistryWithFingerprint` 也用它，避免两条链漂移）；`revision` 与哈希必须来自同一次 `readJson`。
- **持锁身份**：`journalTargetKey(target)` 是"锁目标 = journal 目标"的判据；持锁复读后不一致 →
  `unreadable` + `changed=false` + `observed=null`（不冒充观测过新目标）。**不做**跨目标重新加锁。
- **首错优先**：抛错路径上清理失败只作附加诊断（`attachCleanupNote` 保留 `code`/`path`/`detail`/`expected`/`actual`/`cause`）；
  返回值路径上清理失败进 `warnings`。两者都不假装"锁已经删掉"。
- 仍然**没有**任何自动抢锁、按 PID/年龄回收锁的路径，也没有 `force` 后门；测试只能清理自己合成根里的锁。

### 6.2 C1R 实跑（2026-10-01，Windows + PowerShell + Node 24.14.1 + Pi 0.87.1）

| 工作目录 | 命令 | 结果 |
|---|---|---|
| `packages/bios-agent` | `node --test tests/storageJournal.test.mjs` | **37 项：37 通过、0 失败、0 skip**（原 23 + C1R 14） |
| 同上 | `npm run typecheck` | 通过 |
| 同上 | `npm test` | **220 项：218 通过、0 失败、2 显式 skip**（均为文件型 symlink EPERM）；206 基线未削弱 |
| 同上 | `npm run selfcheck` | 6 项通过 |
| 同上 | `npm run check:format` | 通过（39 文件） |
| 仓库根 | `npm run typecheck` | 通过 |
| 仓库根 | `npm run check:format` | 通过（2014 文件；该脚本**不检查**本 Package） |
| 仓库根 | `node --test tests/processGuards.test.mjs` | 2 项通过 |
| 仓库根 | `git diff --check` | 通过（不覆盖未跟踪文件内容） |

体量：`journal/reconcile.ts` 300 行、`journal/inspect.ts` 255 行、`registry.ts` 464 行，均在 600 行红线内；
`tests/storageJournal.test.mjs` 1423 行（测试文件不受组件行数口径约束）。

### 6.3 C1R 未测与边界

- J1～J4 的 IO 故障/竞态注入都是**确定性复现分支**，不代表本机磁盘真的出过对应损坏，
  也不构成对恶意进程的攻防验证。
- 真实崩溃回归与并发核对回归保持原样继续实跑；目录 junction 实跑，文件 symlink 权限 skip 未变（未改系统权限）。
- 仍**未测**：断电实验（`SIGKILL` ≠ 掉电）、Linux/macOS、干净 clone 独立工具链、远端 CI、
  生产构建/安装包、真实客户 BIOS 试点、无人值守的遗留锁回收（明确未实现）。
- 临时合成根都在系统 temp 下并在用例内清理；J3 的合成残留锁随用例清理，不影响其它用例。

## 6. 与既有测试的关系

journal 接入后，**一次 update 会包含两次 rename、三次临时文件准备**（journal prepared / 数据提交 /
journal 终态），而 `ioHooks` 只按操作名回调。既有回归里按操作名注入的用例必须补**路径过滤**
（`isJournalPath(target)`），否则会打到 journal 自身的提交上、失去原意。本组改动只做这一处机械化收窄，
**不削弱任何既有断言**，并新增 journal 自身清理/记账失败的独立用例。
