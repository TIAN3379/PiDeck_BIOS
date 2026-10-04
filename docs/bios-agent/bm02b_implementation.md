# BM-02B 实施说明（跨进程写入协议：revision / 可取消锁 / 原子替换）

日期：2026-10-01

> **历史记录提示（2026-10-01 追加）**：本文 §5「共用同一条提交路径」与 §9「create 不覆盖靠锁内存在性检查」
> 描述的是 BM-02B 当时的实现，已被 [BM-02BR 实施记录](bm02br_implementation.md) 的 W3 取代：
> `createRecord` 改为**非覆盖发布**（同目录完整临时文件 + `sync` + `close` + `link`），
> `updateRecord` / `updateRegistry` 仍走 `rename`；替换重试由 6 次线性退避改为 12 次指数退避（上限 250ms、标称总预算 4000ms）。
> 本文保留原貌作为历史，冲突时以 BM-02BR 实施记录与源码为准。

> 这是**实施方本地自测与设计记录**，不代替独立验收。
> 后续独立结论见[第六轮验收](round6_acceptance.md)：139 通过/1 skip 确认，但 W1～W4 未关闭；下述溢出/校验/IO 闭环表述以独立复现为准。当前开发入口是 [next_development.md](next_development.md)。
> 范围为 `bm02b_development_plan.md` 定义的 B0～B4 + 文档。
> 明确**未**实现：删除记录、自动绑定/档案联动、journal、迁移、备份 CLI、桌面 UI、RAG、模型写工具、Pi 内核改造。

**交付性质**：既有 Package/文档已有 Git 跟踪，本轮包含它们的修改及未跟踪的 lock.ts、write.ts、storageWrite.test.mjs 等新文件；并非整个 packages 或锁文件都未跟踪。本轮未 `git add` / `commit` / `push`。

## 1. 交付物

| 模块 | 本轮改动 |
|---|---|
| `core/storage/boundary.ts` | `publishJson` 接受 `callSignal`（B0）；新增 `replaceJson` 原子替换、`readJsonForCleanup`、`pathExists`、`beforeIo`；`StorageIoOperation` 增加 `sync` / `rename` / `unlink-temp` / `lock-mkdir` / `lock-read` / `lock-remove` |
| `core/storage/errors.ts` | 新增错误码 `revision-conflict` / `lock-timeout`；`StorageError` 增加 `expected` / `actual`；新增 `isCancelledError` |
| `core/storage/lock.ts` | **新增**：跨进程协作式锁 `acquireStorageLock` + `LockReleaseOutcome` / `LockDiagnostics` |
| `core/storage/write.ts` | **新增**：`createRecord` / `updateRecord` / `updateRegistry` + 选项与结果类型 |
| `core/storage/registry.ts` | `KnowledgeLayout` 增加 `locksDir`，初始化时创建 `locks/` |
| `core/storage/records.ts` | 导出 `interpretRecord` / `InterpretedRecord`（与读取共用同一条校验链） |
| `core/storage/index.ts` | 导出 lock / write 模块 |
| `README.md` | 先写 BM-02B 契约（写入入口、revision 语义、锁、提交点、错误码），再实施 |
| `tests/storageWrite.test.mjs` | **新增 30 个用例**（§6 的 9 组要求） |
| `tests/storageRemediation.test.mjs` | **新增 3 条 B0 永久回归** |

## 2. B0：`publishJson` 的取消缺口

第五轮验收复现的两个缺口：`publishJson` 完全忽略 `callSignal`；提交钩子等待返回后未再检查取消，导致"已取消却仍 created"。

修复后的取消检查点（全部位于**提交点之前**）：

1. 函数入口；
2. 临时文件写完之后；
3. 提交钩子（`beforeIo("link")`）返回之后——这正是第五轮漏掉的那个点：钩子是一个真实的 `await`，等待期间取消必须生效；
4. 发起提交 IO（`link`）之前。

同时把取消错误从 `catch` 里穿透出去（`isCancelledError`），避免被 `classifyLinkFailure` 归成"链接失败"。

**提交点语义**：`link()` 一旦返回成功，目标就已经存在，`publishJson` 不再回滚、也不再改口；
此后到达的取消只会影响"是否清理临时文件"，不会把结果说成失败。

回归（`storageRemediation.test.mjs`）：

| 用例 | 断言 |
|---|---|
| 两个 signal 任一取消 | 调用方 signal 与 boundary signal 各自都能在提交前拒绝，且目标不存在 |
| `beforeIo("link")` 等待期间取消 | 钩子内 `abort` 后必须 `cancelled`，**不创建目标**（B0 缺口本体） |
| link 成功后迟到的取消 | 仍返回真实 `created`，返回的 `bytes` 与磁盘字节一致 |

## 3. B1：五类记录写入 + registry 单文件更新

### 3.1 revision 语义（唯一一处乐观并发控制）

| 入口 | `expectedRevision` | 含义 |
|---|---|---|
| `createRecord` | 必须 `null` | "要求目标不存在" |
| `updateRecord` | 非负整数 | "要求目标存在且 `revision` 等于该值" |

结果里的 `status` 是 `created` / `updated`（**不是** `create` / `update`），`revision` 是提交后的值：
create 恒为 `0`，update 恒为 `旧值 + 1`。

被显式拒绝（都带可行动字段 `expected` / `actual`）：

| 情况 | 错误 | `detail` |
|---|---|---|
| 旧 revision | `revision-conflict` | — |
| update 目标不存在 | `revision-conflict` | 实际值 `actual = null` |
| create 目标已存在 | `revision-conflict` | 实际值 `actual = n` |
| `expectedRevision` 是负数/小数/字符串 | `revision-conflict` | `invalid-expected-revision` |
| update 传 `null` | `revision-conflict` | `unexpected-null-revision` |
| **create 传数字** | `revision-conflict` | `create-with-number-revision` |
| `revision + 1` 溢出 | `revision-conflict` | `revision-overflow` |

最后两条是刻意加的：create 收数字会退化成"要求存在且相等"却仍报告 `created`，调用方会以为"我新建了一条"；
而 `MAX_SAFE_INTEGER` 上的 `+1` 等于自身，乐观并发控制会静默失效。两者都必须在写文件前拒绝。

### 3.2 记录公共头与业务正文的边界

`schemaVersion` / `revision` / `createdAt` / `updatedAt` 由存储层生成，**不接受调用方覆盖**：
`data` 里出现托管字段即 `invalid-record`（`managed-key-in-body`）。`id` 与归属字段
（任务的 `projectId`、清单的 `targetProjectId`）由受控路径与参数共同决定，业务正文同样不能注入。

`updatedAt` 取 `max(now, 旧 updatedAt)`，**不倒退**：时钟回拨不会让记录的"最后修改时间"变小。

写前跑与读取**完全相同**的 `RECORD_SCHEMAS` 校验（`assembleRecord`），
避免出现"写成功但读不出来"的文件。

### 3.3 参数校验在取锁之前

`assertRecordKind`（运行时守卫：非法 kind 会走到 `recordRelativeSegments` 的 `switch` 之外，
以裸 `TypeError` 形式炸出来，因此必须在写前结构化拒绝）、ID 合法性、归属参数、`expectedRevision` 形态、
托管字段冲突——全部发生在 `acquireStorageLock` **之前**。参数错误不占别人的锁，也不产生一次无谓等待。

### 3.4 `updateRegistry`

`updateRegistry({ root, expectedRevision, projects, now?, ... })` 复用初始化的 registry 校验与版本闸门，
再跑 `inspectBindingIssues`；重复 `biosProjectId` / 同一路径归属两个项目 / 重复 `desktopProjectId`
一律 `binding-conflict` 且**不落盘**。空 `projects` 是合法状态（"删掉一个绑定"必须能表达）。

**它不改写、也不创建任何档案文件**——绑定关系与档案内容是两件事，测试对已存在的档案断言 hash 不变。

## 4. B2：跨进程可取消锁

- 锁是知识根内 `locks/` 下的一个目录，靠 `mkdir` 的原子性获取；`ownerId`（进程内随机 token）写在
  `owner.json`（`ownerId` / `pid` / `createdAt` / `target`）。
- 锁名 = 受控相对目标（相对知识根）→ **Windows 上先 `toLowerCase()` 归一** → SHA-256 前 32 位十六进制，
  形如 `lock-<hex>`。散列而不是直接用路径：相对路径可能超文件名长度、含分隔符无法当文件名，
  且 Windows 大小写不敏感——不归一会让同一文件拿到两个锁。
- **不抢占**：`owner.json` 损坏或缺失时只当作"忙碌"（无法判断持有者是否存活），按超时上报；
  也没有 TTL 或回收器——遗留锁必须人工处理，这是刻意的选择。
- 等待是**有界且可取消**的：`lockTimeoutMs` / `lockPollMs`，每轮 `delayWithCancellation` 之前与之后都检查取消。
  超时错误带持有者诊断（`ownerId=` / `pid=` / `createdAt=`）。
- 释放前校验 `ownerId` 是自己，不是自己的锁**只报告、不删除**（`not-owner` / `missing`）。
- **释放忽略取消信号**：锁没有回收器，如果"用户取消写入"能阻止清理，一次取消就会把锁永久留在磁盘上，
  此后所有写者都超时。因此新增 `boundary.readJsonForCleanup`，只给释放用；
  `publishJson` / `replaceJson` 的取消语义不受影响。
- `lockRelease` 结果（`released` / `not-owner` / `missing` / `failed`）在写入结果里**如实上报**；
  释放失败不会把已提交的写入改口成失败，也不会被静默吞掉。

## 5. B3：单文件完整原子提交

`createRecord` / `updateRecord` / `updateRegistry` **共用同一条提交路径** `replaceJson`
（`publishJson` 的 `link` 非覆盖发布只用于初始化首建 registry，见下文 §9 取舍）。

`replaceJson` 的提交序列：

1. `ensureDirectory` 目标目录；
2. `assertNoSymlinks(目标)`；
3. 在**同一目录**创建 `.<name>.<pid>.<8hex>.tmp`（`wx`，非覆盖）；
4. 写完整 payload → `sync()` → `close()`；
5. `assertNoSymlinks(目标)`（**再次**检查：写入期间路径可能被换成链接，`rename` 会跟随它写到根外）；
6. `rename(临时文件 → 目标)` ← **提交点**；
7. 清理临时文件（失败记 `cleanup: "failed"`，不回滚）。

- 增量写：`assertPayloadWithinLimits` 按**实际 UTF-8 字节数**（`maxRecordBytes`）与字符数（`maxJsonChars`）拦截超限。
- Windows 的 `EBUSY` / `EPERM` / `EACCES`（杀毒/索引/编辑器短时持有目标）有界重试：
  `MAX_RENAME_ATTEMPTS = 6`，退避 `RENAME_RETRY_BASE_MS = 25` × 尝试次数**线性**增长（0/25/50/75/100ms），
  等待本身可取消；尝试次数写入 `renameAttempts`。其它错误码不重试，立即失败（绝不回退成"先删后写"）。
- 任意步骤失败：`finally` 保证临时文件被删除、句柄被关闭，**目标原字节不变**。
- 提交点之后不做回滚声明：`cleanup: "failed"` 表示"内容已生效，但临时文件没删掉"，需要人看。

## 6. 验收矩阵对照

| 计划要求（§6） | 证据（测试用例，`tests/storageWrite.test.mjs`） |
|---|---|
| 五类 create/update、revision 0→1、ID/归属/createdAt 保持 | 「B1：五类记录 create→update 后 revision 0→1…新进程可读回」（5 个子用例 + 1 次真实 `spawn` 读取） |
| registry 更新生效、不创建/改写档案 | 「B1：updateRegistry 0→1 生效，且不改写也不创建任何档案文件」 |
| 重复绑定拒绝 | 「B1：updateRegistry 拒绝重复项目 ID / 重复路径 / 重复桌面 ID，且不落盘」 |
| registry 缺失 / 过期 revision | 「B1：registry 缺失或 expectedRevision 过期时明确冲突，原字节不变」 |
| 旧 revision / 缺失 / 已存在 / 非法值 | 「B1：旧 revision / 缺失 / 已存在 / 非法 expectedRevision 一律明确拒绝且原地字节不变」 |
| 溢出、损坏、未来版本、错误归属 | 「B1：revision 溢出与损坏/未来版本/错误归属记录都拒绝覆盖」 |
| 真实双子进程更新竞争 | 「B4：两个真实子进程以同一 expectedRevision 更新同一记录：恰好一方提交，另一方冲突」（`spawn` ×2 + 会合点） |
| 真实双子进程创建竞争 | 「B4：两个真实子进程创建同一 ID：仅一方成功，另一方冲突且不覆盖赢家内容」 |
| 提交前读者只见旧完整记录 | 「B4：提交前读者只见旧完整记录（临时文件与目标同目录且不叫目标名），提交后只见新完整记录」 |
| 并发反复读写无半 JSON | 「B4：真实并发反复读写：读者不出现半 JSON/空文件，revision 单调不减」（子进程读 60 次） |
| 锁超时 | 「B2：锁等待超时 → lock-timeout，不写目标、不删除他人锁」 |
| 锁等待取消 | 「B2：锁等待期间取消 → cancelled，不写目标」 |
| 失败后释放自有锁 | 「B2：写入因 revision 冲突失败时释放自有锁，不留锁目录也不留临时文件」 |
| 不删他人锁 | 「B2：只释放自己的锁：ownerId 不匹配时报 not-owner 且不删除锁目录」 |
| 遗留/损坏锁不抢占 | 「B2：遗留/损坏锁不自动抢占，只按忙碌超时」 |
| 临时写 / sync / rename 故障 | 「B3：临时写 / sync / rename 注入失败：原字节不变、无残留、随后仍能正常写入」 |
| 提交前取消 | 「B3：提交前（rename 之前）取消：原字节不变、无残留」 |
| 提交后迟到取消不假称回滚 | 「B3：提交成功后的迟到取消仍报告真实 updated（不假称回滚），锁释放失败如实上报」 |
| 非法 kind / ID / 归属参数 | 「B4：非法 kind / 非法 ID / 归属参数错误在写文件前结构化拒绝，不取锁不落盘」 |
| 写入预算 | 「B4：超大写入被限额拒绝，目标不创建、不残留」 |
| 根内 junction 逃逸 | 「B4：根内目录被换成 junction 时拒绝写入，根外内容不变」（本机实际执行，未跳过） |
| 未初始化 | 「B4：知识库未初始化时拒绝写入，不留下半初始化的目录树」 |

## 7. 未验证与明确边界

- **故障注入不等于真实磁盘故障**：`StorageIoHooks` 用来确定性复现特殊分支（临时写/sync/rename 失败、
  提交窗口、锁释放失败）。本机没有真的发生过这些磁盘故障。
- **真实权限失败（EACCES）仍未在本机造出**；`permission-denied` 的映射由 errno 表覆盖，本轮注入的是 `EIO`/`EBUSY`。
- **Windows 重命名重试的实际触发未实测**：只验证了有界与不留残留，没有在真机上制造 `EBUSY` 竞争。
- **文件型符号链接用例在本机仍跳过**（Windows 需管理员/开发者模式）；目录 junction 已实际执行。
- **告警上限触顶、跨平台（Linux/macOS）、干净 clone 独立工具链、远端 CI、生产构建/安装包、真实 BIOS 试点**均未运行。
- **未实现**：删除记录、自动绑定/档案联动、journal/迁移（BM-02C）、管理 CLI/备份恢复（BM-02D）、
  经验检索、上下文预算、桌面 UI、模型写工具。
- 锁只约束**遵守同一协议**的本地进程，不阻止绕过协议的编辑器/进程在检查与操作之间替换路径。

## 8. 本轮测试统计

`npm test`（包内，Windows + Node 24.14.1 + Pi 0.87.1 实测）：

- **140 个用例：139 通过、0 失败、1 显式 skip**（skip 为既有的文件符号链接权限用例）。
  第五轮基线 107 + B0 回归 3 + `storageWrite.test.mjs` 30 = 140。
- 门禁：包内 `typecheck`、`check:format`（29 文件）、`selfcheck`（6 项）；
  根 `typecheck`、根 `check:format`（2014 文件）、`node --test tests/processGuards.test.mjs`（2 用例）、`git diff --check` 全部通过。

## 9. 已知设计取舍与风险

- **锁的 owner token 判断依赖 `owner.json` 可读**：元数据被删/被改后只能按忙碌处理，
  代价是"可能永久阻塞"，收益是"绝不抢占可能仍在写盘的另一进程"。取舍偏向安全。
- **释放忽略取消**：这是"取消导致永久锁"与"清理动作不可中断"之间的取舍。既然没有回收器，只能选后者。
- **提交点之后没有回滚**：Windows 上没有"原子替换 + 可回滚"的文件系统原语；
  因此 `created` / `updated` 的含义严格是"提交 IO 已返回成功"，而不是"事务已提交"。
- **"create 不覆盖"靠锁内的存在性检查，而不是靠文件系统原语**：`createRecord` 与 `updateRecord` 共用
  `replaceJson`（`rename` 是替换语义），因此对"绕过协议、不取锁的写者"没有额外保护——
  这在协作式锁的前提下是可接受的，但**不能**说成"文件系统保证新建不覆盖"。初始化首建 registry 仍然用
  `publishJson` 的 `link`，那一步是真正的 OS 级非覆盖。
- **未做"删除记录"**：删除需要决定墓碑/审计语义，本轮明确不做。
