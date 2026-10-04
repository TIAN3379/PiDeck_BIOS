# BM-02C3 实施记录：知识库版本盘点与迁移预检

日期：2026-10-02。工作区 `D:\BIOS_Pi_Agent\PiDeck_BIOS`，分支 `BIOS_Agent`。
当前状态（2026-10-04）：**第二十轮独立验收确认S3原复现关闭，C3/C3R在声明的本机只读盘点范围通过**，见§15与[报告](round20_acceptance.md)。§1～14保留历史/实施快照，独立结论优先；下一轮只做 [D1备份协议与纯校验](bm02d1_development_plan.md)。
依据：[第十五轮验收](round15_acceptance.md)（I1 关闭、审核持久化整改收口）与 [BM-02C3 方案](bm02c3_development_plan.md)。

## 1. 交付边界（先说不做）

提供一个**只读**入口 `inspectKnowledgeStore(options)`，回答四个问题：这份知识库有哪些格式版本 /
哪些文件无法解释 / 是否需要迁移 / 有哪些阻断事项。

- **不做**实际迁移：当前只有一套业务 `schemaVersion=1`，没有正式旧 schema 或转换规则，
  不发明 v0→v1/v1→v2；结论只能是"当前已检查范围无需格式迁移"或"受阻/不完整"。
- **不写任何字节**：不调用初始化 API、不建目录、不加锁、不发布临时文件、不调用 reconcile、
  不清理 `.tmp`/锁、不修改未知文件。
- **不是**整库一致性证明、不是备份许可：只有观察式扫描语义，且**不新增**全库跨引用/审核三方绑定检查器。
- **不开放入口**：不加 CLI/IPC/UI，不注册成 Pi 工具，不改 PiRuntime；入口显式接收 `root`，不读默认用户知识库。

## 2. 公开 API 与结果

`core/storage/preflight/`（由 `core/storage/index.ts` 以窄出口导出）：

| 文件 | 行数 | 职责 |
|---|---|---|
| `limits.ts` | 87 | `PreflightLimits` + `resolvePreflightLimits`（显式 `undefined` 保持默认；`NaN`/负数/小数/`Infinity` → `invalid-limits`；0 逐字段定义） |
| `contract.ts` | 147 | 结果契约、支持版本表（唯一来源是各契约常量）、`PREFLIGHT_SCAN_SEMANTICS = "observed-not-snapshot"` |
| `scan.ts` | 325 | 预算与报告原语：条目/读取/摘要/问题/输出字节、`placeholderPath`、`pathState`、`listEntriesBounded`、`readJsonBounded` |
| `verdicts.ts` | 109 | 分类策略：记录 / journal v1+v2 / 审核意图 / 审计事件（与既有校验器同一判据） |
| `categories.ts` | 393 | 固定落点遍历（含人工事项与残留报告） |
| `inspect.ts` | 93 | 入口与结论组装 |
| `index.ts` | 25 | 窄出口（入口 + 契约 + 限额；预算原语不外泄） |

> 上表是 **C3 交付当时**的快照。C3R（§8）后：新增 `auxiliaryCategories.ts`（锁 / `cache/` / 根布局外条目），
> `categories.ts` 345、`scan.ts` 389、`contract.ts` 168、`limits.ts` 94、`inspect.ts` 93、`index.ts` 24、`verdicts.ts` 108
> —— 当时全部仍在 400 行目标内；§2 的 `pathState` 已由 §8 的 `probePath` 取代。
> **S1/S2/S3 后**（最新口径以 §14.3 为准）：`scan.ts` 409、`categories.ts` 346、`inspect.ts` 95、`verdicts.ts` 108、
> `limits.ts` 99、`contract.ts` 173、`auxiliaryCategories.ts` 90、`pathProbe.ts` 49、`index.ts` 24；`scan.ts` 略超 400 目标但未超 600 行拆分门槛。

```ts
inspectKnowledgeStore({ root, limits?, signal?, ioHooks? }): Promise<PreflightReport>
```

`PreflightReport` 的关键字段（全部有界、可 JSON 序列化、不含正文）：

| 字段 | 语义 |
|---|---|
| `outcome` | 唯一结论：`no-migration-needed` / `blocked` / `incomplete` |
| `complete` + `truncatedBy` | 是否在预算内看完全部已知落点；截断原因 ∈ `scan-entries`/`read-bytes`/`file-summaries`/`problems`/`output-bytes` |
| `scanSemantics` | 固定 `"observed-not-snapshot"`（逐文件观察，不是原子快照） |
| `supportedVersions` / `versions` | 本实现支持的版本表（registry/record 1、journal 1+2、audit-intent 1、audit-event 1）与**观察到的**版本分布（含不支持/无法判定 = `version: null`） |
| `scannedEntries` / `readFiles` | 检查过的目录条目数（含被跳过/未知/目录本身）、成功读取文件数 |
| `readBytes` / `reservedBytes` | 成功读取的**实际**字节；失败尝试按单文件上限**预留**的字节（两者分开，不混称） |
| `summaries` / `droppedSummaries` | 单文件摘要（类别、受控相对路径、状态、观察版本、可行动错误码） |
| `problems` / `droppedProblems` / `blockingProblems` | 问题列表、被丢弃条数、**阻断计数（不受输出预算裁剪）** |
| `manual` / `manualItems` | 需要人工核对的事项（prepared/conflict journal、锁、`.tmp` 残留、未登记项目） |
| `limits` / `outputBytes` | 本次实际生效的预算口径、**三类明细合并数组**的真实 UTF-8 序列化字节（精确口径见 §8.2） |

状态取值：`ok` / `unsupported-version` / `invalid` / `missing` / `unreadable` / `unchecked`（后者只用于 `cache/`）。

**结论优先级**：`truncatedBy` 非空或扫描被预算停止 ⇒ `incomplete`；否则有阻断事项（问题 `blocks: true` 或任一人工事项）⇒ `blocked`；
否则 `no-migration-needed`。**截断永远不会产生"通过"**，问题列表被截断也一样（阻断计数独立累加）。

## 3. 布局覆盖（固定深度，不递归未知目录）

| 落点 | 预检内容 |
|---|---|
| `registry.json` | 版本 + `interpretRegistryValue`（结构 → 绑定一致性）；缺失/损坏 ⇒ 阻断，不创建空库 |
| `projects/` | 目录名必须是受控项目 ID；登记项目缺目录/档案 ⇒ 问题；未登记项目 ⇒ 人工事项（不自动关联/删除） |
| `projects/<id>/profile.json` | 完整记录校验（版本 → 结构 → 内容 ID → 归属） |
| `projects/<id>/tasks/*.json`、`context/*.json` | 同上 + 父项目归属（`projectId`/`targetProjectId` 必须与目录一致） |
| `experiences/*.json`、`features/*.json` | 同上（不含项目归属） |
| `journal/*.json` | 按 `journalVersion` 显式路由：1 → `validateJournalRecord`，2 → `validateReviewJournalRecord`，其它 ⇒ `unsupported-journal-version`（不猜字段）；`prepared`/`conflict` ⇒ 人工事项 |
| `audit/intents/*.json` | `validateAuditIntent` + `purpose`/`operationId` 路径身份（与 `readReviewIntentArtifact` 同一判据） |
| `audit/<recordId>/*.json` | `validateAuditEvent` + `eventId`/`target.recordId` 路径身份 |
| `locks/` | 只报告存在（受控锁名才允许进报告），不按 PID/年龄判断可否抢占、不删除 |
| `.tmp` 残留（各事实目录与根） | 只报告存在，不清理；名称省略（位置占位） |
| `cache/` | 标为 `unchecked`（可重建、不是事实记录），**不递归**、不进版本统计 |
| 其它条目 | 有界诊断、不进入；名称一律省略（`<parent>/#unknown-name`），根/项目目录内的未知条目**不阻断**，事实落点目录内的未知条目**阻断** |

**可选的目录缺席 = 未使用**（没有 journal/audit/intents 的旧初始化库不报问题）；`projects/` 与已登记项目的 `profile.json` 视为必需。
**不跟着 registry 的 workspace.path 扫 BIOS 源码**：预检只走知识根内的固定落点。

## 4. 预算、取消与只读证据

- **三类预算共享**：条目（`maxScanEntries`，被跳过的链接/未知条目/目录本身都计）、读取（`maxFileBytes` × 单文件上限 + `maxReadBytes` 总量）、
  输出（`maxFileSummaries`/`maxProblems` 条数 + `maxOutputBytes` **真实 UTF-8 字节**）。
  摘要/问题条数触顶 ⇒ 只计数并标记截断、继续扫描；条目/读取/输出字节触顶 ⇒ 立刻停止（继续只会重复报告同一批条目）。
  > 本节是 **C3 交付当时**的表述；`maxProblems` 的共同额度、`outputBytes` 的数组包络与截断条目统计已在 C3R 修正，**以 §8.2 为准**。
- **失败也计费**：读取失败时按预留额度计入 `reservedBytes`（失败路径拿不到实际字节，高估好于当成零成本）；
  单条诊断按 `maxIssueChars` 截断并加 `…`；输出按 `Buffer.byteLength(JSON.stringify(entry))` 计量，不用字符数冒充。
  > C3R 后改为"三类明细**合并数组**的包络"计量（含括号与逗号，人工事项同样计入），见 §8.2。
- **取消**：`boundary` 的每个 IO 等待点都检查取消（含 `opendir` 与目录迭代结束），取消**结构化穿透**成 `cancelled`；
  目录句柄由 `listEntries` 的配对清理关闭（测试用"取消后根可立即删除"证明无泄漏）。
- **只读**：只使用 `pathExists` / `assertNoSymlinks` / `listEntries` / `readJson`；不调用任何 write/update/review/reconcile/clear 入口。
- **实测证据**（`tests/storagePreflight.test.mjs`）：
  - 富库扫描前后**目录清单 + 逐文件 SHA-256 完全相同**（含 registry、五类记录、journal v1/v2、意图、事件、锁、`.tmp` 残留、cache）；
  - 未初始化根扫描后仍为空目录，`journal/` 与 `audit/intents/` 不被创建，`locks/` 保持为空；
  - 注入正文哨兵（记录字段值、坏文件正文、cache 文件、根说明文件）⇒ `JSON.stringify(report)` 不含哨兵；
  - 读取预算与预留额度实测：`maxFileBytes: 32` 时超限文件报 `too-large` 且 `reservedBytes > 0`；
  - `maxOutputBytes` 卡在"字符数够、字节数不够"之间时按字节截断（`truncatedBy` 含 `output-bytes`）。

## 5. 永久用例与实跑（2026-10-02，实施方）

`tests/storagePreflight.test.mjs`（831 行，35 项，含子用例）覆盖：

1. 空初始化库与富库（五类记录 + v1/v2 journal + 意图 + 事件）⇒ `no-migration-needed`，v2 不被当作未知版本；
2. 可选目录缺席不误报、registry 缺失阻断不建目录、已登记项目缺档案、未登记项目候选（不自动合并）；
3. 坏 JSON / 内容 ID 不符 / 任务归属不符 / 覆盖在记录名上的目录 / registry 绑定冲突 / 记录·journal·意图的未来版本与缺失版本 ⇒ 用**已知校验器的码**（`invalid-json`、`record-id-mismatch`、`not-a-file`、`binding-conflict`、`unsupported-schema-version`、`unsupported-journal-version`、`unsupported-audit-intent-version`）；
4. prepared v2 / conflict v1 / 锁 / `.tmp` 残留 ⇒ 人工事项，且 journal 字节、锁与残留文件**原样保留**；
5. 超大文件、读取期间增长（`stat` 注入）、中间目录 junction、叶子文件链接、根不是目录/不存在/相对路径；
6. 共享条目预算、摘要/问题/输出字节预算、0 与 `undefined` 语义、非法限额（`NaN`/负数/小数/`Infinity`）；
7. 读取等待点取消、列目录等待点取消（含句柄关闭）、候选并发消失只诊断一次不重试；
8. 只读（清单与 SHA-256 不变、不建目录、不泄漏正文）。

```text
node --test tests/storagePreflight.test.mjs tests/auditContracts.test.mjs tests/auditAssociation.test.mjs \
  tests/storageJournal.test.mjs tests/storageReviewWriter.test.mjs tests/storageReviewReconcile.test.mjs \
  tests/storageReviewContracts.test.mjs                              → 200 项全绿（新增文件 35 项）
npm test          → 383 用例：381 通过、0 失败、2 个既有文件符号链接权限 skip（348 基线未削弱，skip 未增加）
npm run typecheck / selfcheck（6 项）/ check:format（64 文件）        → 通过
仓库根 typecheck / check:format（2014 文件）/ processGuards（2 项）/ git diff --check → 通过
```

体量：`limits` 87、`contract` 147、`scan` 325、`verdicts` 109、`categories` 393、`inspect` 93、`index` 25 —— 全部 ≤400 行（C3R 后的行数与新增文件见 §8.1）。

## 6. 未测与边界

- **环境**：本机 Windows + Node 24 + **合成知识库**；未跑根全量测试、生产构建/安装包、干净 clone、远端 CI、Linux/macOS、断电实验。
- **不适用而非跳过**：本机 `symlinkSync(..., "file")` 需特权，叶子文件链接用例在探测失败时走"不适用"分支（**不新增 skip**，两个既有 skip 保持不变）；中间目录用 junction 覆盖。
  > **C3R 已推翻这条口径**：空的"不适用"子测试等于把未执行行为计为通过，现改为显式 `context.skip` 并如实计数（见 §8.1、§8.3）。
- **权限**：未构造"读不到但能列出"的权限场景（Windows ACL 不可靠），因此 `permission-denied`/`unreadable` 分支只有代码路径与分类映射，没有环境证据；
  出现时会按 `status: "unreadable"` + 原错误码报告，并阻断结论。
- **原子性**：扫描是逐文件观察，**不承诺**扫描结束后状态不变；并发下消失/变化的候选只报一次（不自动重扫）。
  若要"扫描所见即一致快照"，需要后续备份方案自己的协作一致性设计，本模块不提供。
- **不覆盖**：审计三方绑定、跨记录引用、上板验证、业务语义正确性（本轮明确不新增一致性检查器）；
  锁与残留只报告不算"失败操作"。
- **迁移**：没有正式源/目标 schema 与转换规则前，预检**不会**输出迁移步骤或迁移可行性结论。
- 当时交付结论：BM-02C3 实施完成，交回独立验收；独立复验后的状态见下节。

## 7. 第十六轮独立验收回写（非修复交付）

383 项/381 通过/0 失败/2 显式 skip、七文件 200 项和指定门禁已独立复跑通过，但额外诊断发现四项未覆盖缺口：

- PF-1：根列举 EACCES 被吞掉，误报完整无需迁移；非根路径探测失败也未按收集策略处理。
- PF-2：`maxProblems` 对问题与人工事项分别计量，实际不是共享额度。
- PF-3：`outputBytes` 漏计数组括号/分隔符，人工事项的预算口径与字段说明不一致。
- PF-4：目录截断分支丢弃 `listing.scanned`，已观察条目被报告为零。

§4 的共同额度/真实输出计量说法目前不成立；§6 的权限分支按问题报告说法尚无完整证据。叶子 symlink 的“不适用空通过”不是行为验证，后续应显式 skip 并记录真实数量。详见 [第十六轮验收](round16_acceptance.md)。

本节只回写独立结论，没有实施修复。开发 AI 完成 C3R 后在本文件继续追加红/绿与门禁证据，不改写本轮历史结果。

## 8. BM-02C3R 收尾实施（PF-1～PF-4）

日期：2026-10-02。状态：**收尾实施完成，待独立复验**（不自行声明整体通过）。依据：[C3R 有限收尾方案](bm02c3_remediation_plan.md) 与 [第十六轮验收](round16_acceptance.md) §3。只读语义、写入协议、schema 与 Boundary 语义均未改动。

### 8.1 四项修复（先加红回归，再最小修复）

| 项 | 第十六轮缺陷 | 修复 | 红 → 绿证据（`tests/storagePreflight.test.mjs` §9） |
|---|---|---|---|
| PF-1 | 根 `opendir` 被拒时 `scanRootExtras` 直接 `return`，报告仍 `complete=true / no-migration-needed`；非根 `stat` 失败直接穿出 `pathState` | `scan.ts` 新增 `probePath`：把探测失败变成显式 `failed` 状态（取消照旧穿透、未知异常只给受控说明）；`scanRootExtras` 把根级失败报成阻断问题并把新截断原因 `root-listing` 记进 `truncatedBy`；`scanCacheDirectory` 不再吞掉探测失败 | 3 例：根列举 EACCES（`outcome != no-migration-needed`、`complete=false`、含 `root-listing`、根 `.` 问题码 `permission-denied`）；`features` 探测 `permission-denied` 按问题收集后继续扫描（`blocked`、`status=unreadable`、同批 `experiences` 照常盘点）；非根探测点取消仍抛 `cancelled` |
| PF-2 | `maxProblems` 对 `problems` 与 `manual` **分别**比较，实际放大成两份额度 | `addProblem`/`addManual` 统一与 `problems.length + manual.length`（`retainedIssues`）比较；`maxProblems` 只约束这两类，不含摘要；`blockingProblems`/`manualItems` 仍先于预算累加 | 4 例：混合库额度 2 恰好全保留且不标记截断；额度 1 合计只保留 1（`droppedProblems>0`、`manualItems=1`、`blockingProblems>=2`）；额度 0 两类明细都为空但总计保留；人工事项先到（未登记项目）与只含单类对照 |
| PF-3 | `outputBytes` 逐条累加，漏掉数组括号/分隔符（验收实测 184 vs 189），人工事项的预算口径与字段说明不一致 | `chargeDetail` 定义唯一序列化包络：三类明细按「摘要 → 问题 → 人工事项」合并成一个 JSON 数组的真实 UTF-8 字节（含 `[`/`]`/`,`），增量记账（第一条 +2、之后 +1）；空明细计 0；固定报告信封不计入 | 3 例 + 既有用例改写：`outputBytes === Buffer.byteLength(JSON.stringify([...summaries, ...problems, ...manual]), "utf8")`；与逐条之和的差值恰为 `n+1`（2 括号 + `n-1` 逗号）；空明细 0（`maxFileSummaries:0`、`maxOutputBytes:0` 都返回空明细且不得算完整）；`maxOutputBytes = 包络-1` 按字节截断且截断后仍逐字节一致（不低报） |
| PF-4 | 目录截断分支丢掉 `listing.scanned`，已观察条目被报告成 `scannedEntries=0` | `listEntriesBounded` 截断时把底层**已观察**条目（含唯一的超限探测条目）计入统计后停止；这些名字不再交给调用方逐个 `chargeEntry`，同一条目只扣一次账 | 5 例：根列举触顶 `scannedEntries=2`；第一层目录触顶 `=3` 且未打开任何候选（不继续新 IO）；多目录累计触顶 `=3`（跨目录共享总预算）；预算 0 时 `=1`；无截断时 `scannedEntries === listedEntryCount(root)`（独立重算的列举条目总数） |

同时修正的三处非功能问题（不新增能力）：

- **环境证据**：叶子文件符号链接用例在本机 `EPERM` 时改为**显式 `context.skip`**（原来是一个空通过的"不适用"子测试），不再把未执行行为计为通过。
- **零值口径**：`maxFileBytes=0` 的注释改为与实现一致（立即停读、标记 `read-bytes` 截断），并补永久用例（`readBytes=0`、`complete=false`）。
- **体量红线**：锁 / `cache/` / 根布局外三个落点拆到 `auxiliaryCategories.ts`（89 行），`categories.ts` 回到 345 行。

### 8.2 最终预算与结论口径（本节为唯一来源，§4 的旧说法作废）

- `maxScanEntries`：所有目录共享；被跳过的链接、未知条目、目录本身都消耗。S1 成功列举口径见 §10.2，失败出口限制见 §11：当前还不能声称所有错误路径都满足真实观察总数 ≤ `maxScanEntries + 1`。同一份预算还覆盖少量**逻辑核对**（如 registry 已登记但磁盘上没有项目目录），但逻辑核对不计入 `scannedEntries`。
- `maxFileBytes` / `maxReadBytes`：成功读取计 `readBytes`，失败尝试按预留计 `reservedBytes`；`maxFileBytes=0` 立即停读 ⇒ `read-bytes` 截断。
- `maxProblems`：**`problems.length + manual.length <= maxProblems`**（与处理顺序无关）；被丢弃的明细同时计入 `droppedProblems` 并标记 `problems` 截断；`blockingProblems` 与 `manualItems` 永不被裁剪。
- `maxOutputBytes`：`summaries` + `problems` + `manual` 合并 JSON 数组的真实 UTF-8 字节（含括号与逗号），空明细 0；**固定报告信封不计入**。
- 结论优先级不变：`truncatedBy` 非空（`scan-entries` / `read-bytes` / `file-summaries` / `problems` / `output-bytes` / `root-listing`）或扫描被停止 ⇒ `incomplete`；否则有阻断 ⇒ `blocked`；否则 `no-migration-needed`。

### 8.3 实跑（2026-10-02，实施方本机 Windows + Node）

```text
node --test（§4 指定七文件）                                      → 217 项：216 通过、0 失败、1 显式 skip
npm test                                                          → 400 用例：397 通过、0 失败、3 显式 skip
npm run typecheck / selfcheck（6 项）/ check:format（65 文件）      → 通过
仓库根 typecheck / check:format（2014 文件）/ processGuards（2 项）/ git diff --check → 通过
```

三个 skip **全部**是本机权限所致（Windows 未开开发者模式，文件型 `symlinkSync` 返回 `EPERM`）：`storagePreflight` 叶子链接（本轮由空通过改为显式 skip）、`storageRecords` 记录文件链接、`storageWrite` registry 文件 symlink。两个既有 skip 未删除或弱化；本轮新增 1 个真实 skip，按实跑如实报告数量，**不要求维持两个**，也不把未执行行为计为通过。中间目录 junction 在本机可用，相关用例实际执行。

`storagePreflight.test.mjs`：35 → 52 项（新增 17 个 C3R 子用例，含子用例），1130 行。

### 8.4 未测与边界（本轮未扩大）

- **未做**：真实 Windows ACL 下的 `permission-denied`（这次只用受控 `ioHooks` 做确定性故障注入，不等于真实 ACL 验证）、根替换/断电竞态、生产打包与安装、其它 OS、根全量测试、远端 CI、干净 clone。
- **未改**：写入协议、Boundary 语义、schema 与迁移规则、模型工具 / CLI / UI、PiRuntime 与 Electron；`root-listing` 只影响**只读报告**的完整性与结论，不触盘。
- **结论边界不变**：仍是观察式格式盘点（逐文件看，不是原子快照），不是完整性证明、不是备份许可；本轮不把它升级为"全库一致"，也不包含实际迁移。
- 分层记忆与时态设计（[M1/M2](layered_memory_temporal_design.md)）是后续设计，**未实施**；本轮不涉及其契约与兼容闸门。

## 9. 第十七轮独立复验回写（未实施 S1 修复）

独立确认包内 400 项/397 通过/0 失败/3 显式 skip，七文件 217 项/216 通过/1 skip 及指定包/根门禁通过。PF-1～PF-3 收尾通过，新增叶子 symlink 显式 skip 口径通过；PF-4 原始截断复现通过，但总体实际观察计费仍未收口。

S1 的两个独立诊断：audit 四个目录各十个候选，额度 15 时真实观察 18、报告 16；experience 十个候选因输出额度 200 停止时真实观察 10、报告 1。原因是成功列举成本仍延后到候选处理，父目录剩余观察成本未先扣账。§8.2 的共享条目预算说法在这些情况下不成立，详见 [第十七轮报告](round17_acceptance.md)。

下一轮只修 [S1](bm02c3_remediation_plan.md#6-第十七轮后的唯一接续任务s1)，保留其他已通过结论；junction 条件失败的测试分支同步显式 skip。本节仅回写验收，无运行代码修复。

## 10. S1 接续实施：目录列举即时计费

日期：2026-10-02（实施完成）。状态：**S1 实施完成，待独立复验**（不自行声明通过）。只做 [收尾方案 §6](bm02c3_remediation_plan.md#6-第十七轮后的唯一接续任务s1) 的 S1；PF-1～PF-3 不重做，只读语义、写入协议、schema、Boundary 与根策略均未改动。

### 10.1 修复（红 → 绿）

缺陷（第十七轮 §3）：只在 `listing.truncated` 时累加 `listing.scanned`，正常列举的观察成本却等调用方**逐个处理候选**时才扣账——父目录只先扣 1 条就进入子目录、或第一条候选就撞上输出预算时，剩余名字的真实观察成本永远不入账，真实观察还会超出全局预算。

修复（`core/storage/preflight/`）：

- `scan.ts` 的 `listEntriesBounded`：**有界列举一返回就**把 `listing.scanned` 计入 `scannedEntries`（截断与否都一样），随后才判断截断；`remaining` 改由"已用条目预算"统一算出。新增"预算已耗尽直接返回 `stopped`"的守卫，避免耗尽后仍发起新列举 IO。
- 遍历侧去掉了逐条 `chargeEntry`（`categories.ts` 的全部循环 + `auxiliaryCategories.ts` 的锁/根循环），改为只检查 `scan.stopped`：**列举与候选处理职责分开，同一条目只扣一次账**。这条同时覆盖项目/任务/context、experience/feature、journal、audit/intents/events、locks 与根落点，不是只修 audit。
- 新增 `chargeLogicalCheck`：`registry 已登记但磁盘上没有项目目录`属于**逻辑核对**，仍消耗同一份条目预算（保持有界）但**不计入 `scannedEntries`**——两者不再互相伪装。`ScanState` 增内部字段 `logicalChecks`（不进公开报告）。
- 新增 `pathProbe.ts`：把候选路径探测（`PathProbe` / `probePath`）从 `scan.ts` 拆出，`scan.ts` 回到 379 行（体量红线）。

红/绿证据：

| 场景 | 修复前（独立计量） | 修复后（同一计量，本机实跑） |
|---|---|---|
| A：audit 四目录各十条事件，`maxScanEntries=15` | `observed=18 / reported=16`（第十七轮 §3.A；本轮实施方在**任何改动前**用同一独立进程计量复现：18 / 16） | `observed=reported=16`（= `maxScanEntries + 1`），且 `record-1` 被截断后不再开候选、`record-2/3` 从未列举 |
| B：experiences 十条候选，`maxOutputBytes=200` | `observed=10 / reported=1`（第十七轮 §3.B） | `observed=reported=10`，`truncatedBy` 含 `output-bytes`，`readFiles<10` |

永久用例（`tests/storagePreflight.test.mjs` §10，新增 6 个子用例）先按上表断言 `observed === scannedEntries`：修复前 A 违反 `observed ≤ 16` 与相等断言、B 违反相等断言（1 ≠ 10），修复后全绿。清单：

1. 嵌套 audit（额度 15）→ 真实观察 ≤ 16、统计一致、耗尽后不再开候选；
2. 输出先触顶 → 已观察十条仍入账、不再读候选；
3. 父目录恰好用完额度（额度 4）→ 进入子目录前成本已入账：`scannedEntries=5`、零 `audit` 候选被打开；
4. 0/1 边界与正常完成对照（正常完成时 `scannedEntries === 独立重算的列举条目总数`）；
5. 读取预算先停（`maxReadBytes=1200`）→ 观察成本保留（`scannedEntries=10`）且 `readFiles<10`；
6. 逻辑核对不冒充物理观察（两个已登记项目缺目录）：正常时 `scannedEntries === 独立重算值`；额度 1 时只够一次核对、`scannedEntries=0`、`truncatedBy` 含 `scan-entries`。

独立计量的做法：**在独立 Node 子进程里包装真实的 `fs.promises.opendir` / `open`**（只计数，不改条目、不读内容、不改上限），先包装后 `import` 生产入口；不与报告自身字段互为证明（`tests/storagePreflight.test.mjs` 的 `observePreflight`）。

同时按第十七轮 §1 修正证据口径：中间目录 junction 用例创建失败时由"空返回"改为**显式 `context.skip`**（与叶子链接一致）。本机 junction 可用，该用例实际执行通过。

### 10.2 最终条目计费口径（本节为唯一来源，§8.2 的条目口径以此为准）

- **观察即时计费**：有界列举返回即把已观察条目计入 `scannedEntries`；被跳过的链接、未知条目、目录本身都算。
- **唯一超限探测条目**：每次列举最多允许"超限探测"多观察 1 条，因此**真实观察总数 ≤ `maxScanEntries + 1`**；截断时立即停止整次扫描并记 `truncatedBy: "scan-entries"`。
- **不重复扣账**：候选处理不再单独扣账；某候选被跳过、解析失败、读取失败，或其它预算（读取/输出字节/条数）先触顶，都不影响此前已观察条目的计数。
- **逻辑核对与物理观察分开**：`registry 已登记但磁盘上没有项目目录`这类核对消耗同一份预算但不计入 `scannedEntries`（`limits.ts` 的 `maxScanEntries` 注释与 `contract.ts` 的 `scannedEntries` 注释已同步）。
- 其余口径（读取分账、共同问题额度、输出字节包络、结论优先级）沿用 §8.2，未变。

### 10.3 实跑（本机 Windows + Node，实施方）

```text
node --test（§4 指定七文件）                                      → 224 项：223 通过、0 失败、1 显式 skip
npm test                                                          → 407 用例：404 通过、0 失败、3 显式 skip
npm run typecheck / selfcheck（6 项）/ check:format（66 文件）      → 通过
仓库根 typecheck / check:format（2014 文件）/ processGuards（2 项）/ git diff --check → 通过
```

`storagePreflight.test.mjs`：52 → 59 项（新增 S1 用例 7 个，含 6 个子用例）。三个 skip 仍全部是本机文件型 `symlinkSync` 的 `EPERM`（`storagePreflight` 叶子链接、`storageRecords` 记录文件链接、`storageWrite` registry symlink）；junction 在本机可用、相关用例实际执行；两个既有权限 skip 未删除或弱化。

### 10.4 未测与边界（本轮未扩大）

- 未做：真实 ACL、断电、真实并发根替换、生产打包/安装、其它 OS、根全量测试、远端 CI、干净 clone。
- 未改：写入协议、Boundary 语义、schema 与迁移规则、模型工具/CLI/UI、PiRuntime 与 Electron；本轮只改**只读预检**的观察计费与统计口径。
- 结论边界不变：仍是观察式格式盘点（逐文件看，不是原子快照），不是完整性证明、不是备份许可；`observed` 是"预检真实观察到的目录条目数"，不是全库一致性证明。

## 11. 第十八轮独立复验回写（未实施 S2）

日期：2026-10-04。独立复跑 Package 407 项（404 通过、0 失败、3 权限 skip）、七文件 224 项（223 通过、1 skip），包内类型/格式 66 文件/selfcheck 6 项及根类型/格式 2014 文件/processGuards 2 项/diff 检查通过。

S1 原复现独立计量 A=16/16、B=10/10，成功/截断列举与其他预算提前停止范围通过，逻辑核对及 junction 显式 skip 口径保持。§10.2 的全局保证只在这些已测场景成立，尚未覆盖非取消迭代失败。

新增 S2 诊断：experiences/features 各二十条，前者真实交出四条后 `next()` 抛 `EIO`，额度 15；真实总观察 20、报告 16。Boundary 局部 `scanned` 在抛错时未返回，预检 catch 继续后续类别但没扣此前成本。错误问题与 incomplete 正确，预算仍失真。

当前只补 [S2](bm02c3_remediation_plan.md#7-第十八轮后的唯一接续任务s2)，PF-1～PF-3 与 S1 已通过行为不重做。本节只回写独立验收，没有生产修复或新增永久测试；合成临时诊断已清理，未读客户数据，未提交推送。完整复现及未测范围见 [第十八轮报告](round18_acceptance.md)。

## 12. S2 接续实施：迭代中途失败的观察成本

日期：2026-10-04（实施完成）。状态：**S2 实施完成，待独立复验**（不自行声明通过）。只做 [C3R §7](bm02c3_remediation_plan.md#7-第十八轮后的唯一接续任务s2)；PF-1～PF-3 与 S1 已通过行为不重做，写入原语、锁、journal/review 协议、根解析与 schema 未改动。

### 12.1 唯一计费来源与修复

缺陷（第十八轮 §3）：`Boundary.listEntries` 把 `scanned` 留在函数局部，只有成功结束才随结果返回；迭代器中途抛错时（即使 `finally` 已关闭目录）这段观察数没有交回预检，预检 catch 又把错误收敛成受控问题后继续扫后续类别 —— 已消耗的成本因此丢失，后续目录拿到虚高额度，真实观察超出共享上限。

修复（**择"窄的受控观察计量接口"**，不是从异常正文猜计数）：

- `core/storage/directoryListing.ts`（新）：把有界列举的输入/输出契约（`DirectoryEntryListing` / `ListEntriesOptions`）从 `boundary.ts` 抽成独立类型模块，`boundary.ts` 原样再导出（既有 import 不变）。这是为了 `boundary.ts` 不越过 600 行拆分门槛：609 → 576 行。
- `ListEntriesOptions.observe?: (observed: number) => void`：每实际观察到一个目录条目回调一次，参数是**本次列举的累计**观察数；回调点在"判定截断与跳过之前"，所以超限探测条目、被跳过的链接/子目录都算，失败前已交出的条目也已经交回。
- `scan.ts` 的 `listEntriesBounded`：以该回调作为**唯一计费来源**——`scan.scannedEntries = baseline + observed`；成功后**不再**叠加 `listing.scanned`（成功路径不双计），失败路径不需要额外补偿（catch 里只收敛错误、不碰计数）。零观察失败时回调从未触发，不制造虚假成本。
- 失败出口与取消语义不变：原始异常仍不是 `StorageError`，预检照旧收敛成受控 `unreadable` 问题（不回显原始正文/客户路径）；取消继续结构化穿透，不做普通问题；目录句柄在成功/截断/失败/取消四条路径都走同一个 `finally` 关闭，且 `close()` 失败不覆盖首错。

红 / 绿证据（同一独立计量：独立 Node 子进程包装真实 `fs.promises.opendir`/`open`，只计数、不改条目/顺序/上限；受控故障注入）:

| 场景（额度） | 修前 | 修后 |
|---|---|---|
| A：experiences 交出 4 条后 `EIO`，features 继续（15） | `observed=20 / reported=16`（第十八轮 §3.1 实测；本轮以同一计量复现 20/16） | `16 / 16`，`incomplete` + `scan-entries`，不再打开 features 候选 |
| B：同一故障、宽预算（5000） | `31 / 27` | `31 / 31`，`blocked`、`complete=true` |
| C：嵌套 audit，`record-0` 交出 3 条后 `EIO`（15） | `19 / 16` | `16 / 16`，零 audit 候选被打开 |
| D：与读取预算提前停止组合（`maxReadBytes=1200`） | `24 / 20` | `24 / 24`，含 `read-bytes` |
| E：零观察失败（0 条后 `EIO`，15） | `16 / 16`（本来就一致） | `16 / 16`（防"虚假成本"回归） |
| F：取消对照 | 结构化穿透 + 句柄关闭 | 同（未弱化） |

永久用例（`tests/storagePreflight.test.mjs` §11，新增 6 个子用例）：A/B/C/D/E/F 各一条，其中 A 同时断言原错误仍作为受控问题可见、诊断**不得**回显注入的原始正文（哨兵 `SENTINEL-S2-ITER`），C 断言失败目录与截断目录都不打开候选，D 断言读取触顶后不再继续读候选，F 断言取消后目录可立即删除（句柄已配对关闭）。修前红：A/B/C/D 四条断言失败（2 条通过），修后全绿。

### 12.2 最终条目计费口径（本节为唯一来源，§10.2 的条目口径以此为准）

- **观察即时计费、唯一出口**：Boundary 每观察到一个条目就通过 `observe` 回调交回累计数，预检据此计入 `scannedEntries`；**成功 / 截断 / 迭代失败**共用这一个出口，成功路径不叠加 `listing.scanned`。
- **失败不丢成本**：迭代中途非取消失败时，失败前已观察的条目仍在预算内，后续类别只能用真实剩余额度；失败本身照旧是受控问题（`unreadable`），结论仍取决于预算/阻断优先级。
- **上限不变**：任何路径下真实观察总数 ≤ `maxScanEntries + 1`（唯一允许的超限探测条目）；零观察失败不产生成本。
- **不重复扣账**：候选处理不扣账；`listing.scanned` 只作为成功出口的自描述，不再参与计费相加。
- 逻辑核对与物理观察的区分（§10.2）、读取分账、共同问题额度、输出字节包络（§8.2）均不变。

### 12.3 实跑（本机 Windows + Node，实施方）

```text
node --test（§4 指定七文件）                                      → 231 项：230 通过、0 失败、1 显式 skip
node --test（storageRecords/storageRegistry/storageRemediation/storageWrite + preflight）→ 185 项：182 通过、0 失败、3 skip
npm test                                                          → 414 用例：411 通过、0 失败、3 显式 skip
npm run typecheck / selfcheck（6 项）/ check:format（67 文件）      → 通过
仓库根 typecheck / check:format（2014 文件）/ processGuards（2 项）/ git diff --check → 通过
```

`storagePreflight.test.mjs`：59 → 66 项（新增 S1/S2 相关的 7 个节点：1 父 + 6 子）；预检模块行数 `scan` 389、`categories` 346、`contract` 173、`verdicts` 108、`limits` 99、`inspect` 93、`auxiliaryCategories` 90、`pathProbe` 49、`index` 24；`boundary` 576、（新）`directoryListing` 46。三个 skip 仍全部是本机文件型 `symlinkSync` 的 `EPERM`（叶子链接、`storageRecords` 记录文件链接、`storageWrite` registry symlink），两个既有权限 skip 未删除或弱化；junction 本机可用、相关用例实际执行。

### 12.4 未测与边界（本轮未扩大）

- 未做：真实磁盘故障（本轮是受控故障注入，不冒充真实 EIO）、真实 ACL、断电、生产打包/安装、其它 OS、根全量测试、远端 CI、干净 clone。
- 未改：写入原语、锁、journal/review 协议、根解析与 schema、模型工具/CLI/UI、PiRuntime/Electron；`listEntries` 新增的 `observe` 是**可选**参数，不传时行为与既有调用者完全一致。
- 体量：`boundary.ts` 本轮从 577 → 609 → 576（抽出列举契约类型）；更大范围的读写拆分属于独立重构，不在 S2 范围，未做。
- 结论边界不变：仍是观察式格式盘点（逐文件看，不是原子快照），不是完整性证明、不是备份许可；`observed` 只表示"预检真实观察到的目录条目数"。

## 13. 第十九轮独立回写（2026-10-04）

完整证据见 [第十九轮验收](round19_acceptance.md)，不修改 §12 的实施方历史数字。

- 独立门禁：414 项/411 通过/0 失败/3 skip；七文件 231 项/230 通过/1 skip；列举调用者五文件 185 项/182 通过/3 skip。包类型/selfcheck 6/格式 67，以及根类型/格式 2014/processGuards 2/diff 均通过。
- S2 原故障在独立真实迭代计量中转为 16/16，受控错误仍可见；成功、零观察、宽预算、嵌套及读取组合回归通过。S2 原漏计关闭，不重做已通过行为。
- §12.2 的“任何路径真实观察 ≤ 上限+1”尚未完全成立：超限 break 后真实关闭完成再注入 EIO，额度 15/0/1 分别观察并报告 17/2/3 条，均多一次探测；后续 features 仍被列举。前后库清单/hash 不变，错误正文未泄漏。
- 根因在预检预算锁存：计量回调保存成本，但 `stopScan` 只在 listing 成功返回后执行，关闭拒绝进入 catch 时未停止。只补 [S3](bm02c3_remediation_plan.md#8-第十九轮后的唯一接续任务s3)，不改为吞错或放宽额度。
- 现有计量代理缺 `return()` 转发，S3 永久回归需保留原迭代关闭路径；故障包装在独立进程、实际关闭后注入，不冒充真实磁盘故障。未测范围沿用 §12.4。
- 本次仅改文档，未改源码/永久测试/PiRuntime/Electron，未接触真实客户库，未提交推送；未开始 D、UI 或记忆实现。

## 14. S3 接续实施：超限探测后锁存停止

日期：2026-10-04（实施完成）。状态：**S3 实施完成，待独立复验**（不自行声明通过）。只做 [C3R §8](bm02c3_remediation_plan.md#8-第十九轮后的唯一接续任务s3)；S1/S2/PF-1～PF-3 已通过行为不重做，写入原语、锁、journal/review 协议、根解析与 schema 未改动，未改 PiRuntime/Electron，未做备份/CLI/UI/记忆。

### 14.1 锁存位置与停止兑现

缺陷（第十九轮 §3）：唯一超限探测条目**已经交出**后，若异步迭代器在收尾（`break` 触发的 `return()`）或关闭时抛错，`Boundary.listEntries` 不会返回截断结果而是走预检 catch；catch 只收敛错误、不保留"条目预算已触顶"，于是下一个类别（features / locks / 根）拿剩余 0 额度再列举一次，产生第二次真实探测（额度 15 实测并报告 17/17）。

**锁存位置（唯一）**：`scan.ts` 的 `listEntriesBounded` 观察回调 `observe(observed)`。每交回一条就判断 `scannedEntries + logicalChecks > maxScanEntries`；为真即"这一条就是那个唯一的超限探测条目"，**就地**写入 `truncatedBy: "scan-entries"`。

**为什么记"截断原因"而不是直接 `stopScan`**：`scan.stopped` 会让 `addSummary` / `addProblem` 停止记录明细，而这里必须保住的恰恰是**导致这次停止的那条受控错误**（关闭/收尾失败），它由上一层错误分支在 `stopped` 置位之前登记。因此新增唯一判据 `isScanStopped(scan) = stopped || truncatedBy.has("scan-entries")`：`scan-entries` 的三个写入点（成功截断 `stopScan`、逻辑核对触顶 `stopScan`、S3 超限探测回调）都只在预算耗尽时发生，所以它等价于"条目预算已耗尽"，并且是**持久**的——不依赖 `listEntries` 是否成功返回。

停止的实际兑现点（三处，都在发起新 IO 之前）：
- `listEntriesBounded` 入口：`isScanStopped` 为真直接返回 `{ stopped: true }`，不再 `opendir`；
- `readJsonBounded` 入口：`isScanStopped` 为真返回 `{ kind: "stopped" }`，不再读取新候选（覆盖"多项目时后续项目目录会先读 `profile.json`"这类嵌套调用）；
- `inspect.ts` 分类门控：`!scan.stopped` 改为 `!isScanStopped(scan)`，连只做一次 `stat` 的 `cache/` 探测（不走 `listEntriesBounded`）也跳过；`buildReport.complete` 同步改用 `isScanStopped`（否则"锁存后不再有任何 IO"的场景会误报 `complete: true`）。

**不吞错**：非取消错误仍由原错误分支收敛成受控 `unreadable` 问题（不回显原始正文），结论 `incomplete` 且含 `scan-entries`；`scan.stopped` 保持 false 直到下一次 IO 前检查，正是为了让这条错误先进入问题列表。**取消**仍由 `isCancelledError` 结构化穿透，优先级不被预算结果覆盖；句柄关闭仍走同一个 `finally`，`close()` 失败不覆盖首错。**未超限**的中途 `next()` 失败与零观察失败照旧继续后续类别，不因"存在错误"就停全库。

§12.2 的"任何出口真实观察 ≤ `maxScanEntries + 1`"在本轮覆盖的所有出口（成功 / 截断 / `next()` 失败 / 关闭失败 / 取消 / 未触顶错误）重新成立；§13 的修正到此为止。

### 14.2 永久回归与红 / 绿证据

计量 helper（`tests/storagePreflight.test.mjs` 的 `observePreflight`）本轮补三项能力，**不减少或放宽任何既有断言**（S1/S2 用例同步复用）：
- **完整转发 `return()` / `throw()`**：旧代理只转发 `next()`，`break` 时原关闭路径不会被调用，"关闭失败"根本进不了可见出口（只会被 `finally` 的 `.catch()` 吞掉）——红回归无从复现；转发后 `break` 走原迭代器关闭路径。
- **关闭故障注入 `closeError`**：在创建 `Dir` **之前**包装 `fs.Dir.prototype.close`（Node 在迭代器构造时就绑定了 close promise，返回后再替换实例方法覆盖不到这条绑定），对指定目录的**首次真实关闭**先调用原方法完成真实关闭、再把结果改成受控 `EIO`；`WeakSet` 保证每个目录只注入一次。
- **取消对照 `abort` 与目录轨迹 `listed`**：在指定目录 `opendir` 返回后取消，并在**同一子进程内**立刻删除该目录（Windows 上未关闭的句柄会挡住删除），不依赖 GC 或子进程退出。

修前 / 修后（同一把尺子：独立 Node 子进程包装真实 `fs.promises.opendir`，只计数、不改条目/顺序/上限）：

| 场景（额度） | 修前 | 修后 |
|---|---|---|
| A：experiences 关闭失败（15） | `observed / reported = 17 / 17`，仍列举 features | `16 / 16`，`incomplete` + `scan-entries`，不再列举 features、不开候选 |
| B：同故障（0） | `2 / 2` | `1 / 1` |
| C：同故障（1） | `3 / 3` | `2 / 2` |
| D：嵌套 audit 子目录关闭失败（15） | `20 / 20`，列举 4 个事件目录 | `16 / 16`，只列举 1 个事件目录、0 事件候选 |
| E：宽预算（5000）+ 配置关闭故障 | —— | 不锁存：`complete=true`、`outcome=blocked`、features 照常列举 |
| F：取消 + 配置关闭故障 | —— | `errorCode="cancelled"`、同进程内目录可删除（句柄已配对关闭） |
| G：关闭错误 × 读取预算停止（`next()` 4 条后失败 + 关闭注入 + `maxReadBytes=1200`） | —— | `24 / 24`：成本不丢、`truncatedBy` 含 `read-bytes`、features 仍被列举（不误锁存）、`readFiles<21` |
| H：关闭错误 × 明细额度停止（15 + `maxProblems=0` + 关闭注入） | —— | `16 / 16`：`truncatedBy` 含 `scan-entries` **与** `problems`、明细丢弃仍 `complete=false`、`blockingProblems≥1` 不被裁剪、features 未被列举 |

永久用例（`storagePreflight.test.mjs` §12，新增 1 父 + 8 子）：A 另断言原错误仍作受控问题可见、诊断不回显哨兵 `SENTINEL-S3-CLOSE`、且扫描前后完整清单与 SHA-256 逐字节不变；G/H 是 §8.2.4 要求的"关闭错误与其他读取/输出预算停止的对照"——G 用**没有条目触顶**的形态（`next()` 失败触发的收尾同样走关闭路径）验证读取停止与"不误锁存"，H 验证明细额度（PF-2 的 `problems` 共同额度）停止与条目锁存互不覆盖、阻断计数不被裁剪。**修前红**：A/B/C/D 四条断言失败（E/F/G/H 通过），**修后全绿**。

### 14.3 实跑（本机 Windows + Node 24.14.1，实施方）

```text
node --test（§4 指定七文件）                                     → 240 项：239 通过、0 失败、1 显式 skip
node --test（records/registry/remediation/write + preflight 五文件）→ 194 项：191 通过、0 失败、3 skip
npm test                                                          → 423 项：420 通过、0 失败、3 显式 skip
npm run typecheck / selfcheck（6 项）/ check:format（67 文件）      → 通过
仓库根 typecheck / check:format（2014 文件）/ processGuards（2 项）/ git diff --check → 通过
```

`storagePreflight.test.mjs` **66 → 75 项**。行数：`scan` 409、`categories` 346、`contract` 173、`verdicts` 108、`limits` 99、`inspect` 95、`auxiliaryCategories` 90、`pathProbe` 49、`index` 24；`boundary` 576、`directoryListing` 46。**`scan.ts` 409 行略超 400 行目标**（锁存判据 + 两个 IO 入口守卫 + 上下文注释共 +20），仍远低于 600 行强制拆分门槛；本轮不为凑行数删减说明性注释，也未做无关重构。三个 skip 仍是本机文件型 `symlinkSync` 的 `EPERM`（叶子链接、`storageRecords` 记录文件链接、`storageWrite` registry symlink），未删除或弱化；本轮新增用例均为真实执行，无空通过分支。

### 14.4 未测与边界（本轮未扩大）

- 未做：真实磁盘关闭故障（本轮是受控故障注入——先完成真实关闭再注入 `EIO`，不冒充真实 EIO）、真实 ACL、断电、生产打包/安装、其它 OS、根全量测试、远端 CI、干净 clone。
- 未改：写入原语、锁、journal/review 协议、根解析与 schema、`directoryListing.ts` 契约形状、模型工具/CLI/UI、PiRuntime/Electron。`ListEntriesOptions.observe` 仍是可选参数，不传时既有调用者行为与结果不变。
- 只读：S3 用例只读取新目录，并在子进程内比较扫描前后完整清单与 SHA-256；未写库、未初始化、未抢锁、未清理残留。
- 结论边界不变：仍是观察式格式盘点（逐文件看，不是原子快照），不是完整性证明、不是备份许可。

## 15. 第二十轮独立回写（2026-10-04）

证据见 [第二十轮验收](round20_acceptance.md)。§14 的数字保留为实施方交付快照，本节为最新独立结论。

- Package 423 项/420 通过/0 失败/3 skip；七文件240项/239通过/1skip；列举调用者五文件194项/191通过/3skip。包类型/selfcheck6/格式67及根类型/格式2014/processGuards2/diff均通过。
- 第十九轮原关闭故障在独立进程重跑：额度15/0/1实际观察与报告分别16/16、1/1、2/2，关闭错误仍受控可见，无注入正文泄漏，库清单/hash不变。生产`beforeIo`轨迹确认之后无新的扫描IO。
- 独立宽预算100对照：关闭注入实际触发，观察/报告47/47，后续features与类别继续，无scan-entries；complete=true/outcome=blocked，不误锁存。嵌套、其他预算与取消永久回归保持。
- **S3原复现关闭，C3/C3R在声明的本机只读盘点范围通过，PF-1～PF-4/S1～S3收口。** 仍不是原子快照、全库一致性证明或备份许可；未测边界沿用§14.4。
- `scan.ts`409行作为维护提醒，不阻塞本轮，也不为凑行数另开无关重构。下一轮只排[D1备份协议与纯校验](bm02d1_development_plan.md)，不再运行历史整改提示词。
- 本轮仅改文档，未改代码/永久测试/PiRuntime/Electron，未读客户资料，未提交推送；合成诊断目录已清理，既有工作树和历史删除保留。

