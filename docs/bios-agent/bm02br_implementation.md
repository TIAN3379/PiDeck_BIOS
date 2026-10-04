# BM-02BR 实施记录（写入协议有限收尾 W1～W4 + 交接 R1～R4）

日期：2026-10-01
状态更新：**第七轮已在声明的本机范围独立通过**，见 [独立验收](round7_acceptance.md)。以下保留实施时“待独立复验”的自测记录；本文仍是开发侧唯一实施记录，不是独立验收报告；
不得据此把 BM-02B / BM-02BR 标为"完整独立通过"。

- 原始完成标准：[当前阶段任务](next_development.md) 的 W1～W4。
- 问题来源：[第六轮验收](round6_acceptance.md)。
- 接续入口（已完成，保留链接）：[中断交接](bm02br_handoff.md)。
- 范围：`packages/bios-agent/core/storage/*`（revision / lock / write / commit / boundary / index）
  与 `packages/bios-agent/tests/storageWrite.test.mjs`，以及本包 README 与本文档。
  **未**实现 journal、迁移、备份 CLI、删除、UI、RAG、厂商适配、模型写工具；未改 PiRuntime。

本轮没有 `git add` / `commit` / `push`；工作树中除既有修改外，新增未跟踪文件为
`core/storage/{revision,commit,lock,write}.ts`、`tests/{storageWrite,storageRemediation}.test.mjs`
等（前轮已存在），文档侧新增 `docs/bios-agent/bm02br_implementation.md`。

## 1. W1～W4 对照

| 组 | 要求 | 落点 | 回归（`tests/storageWrite.test.mjs`） |
|---|---|---|---|
| W1 | `expectedRevision` 与当前 revision 都是安全非负整数；registry 复用公共头；溢出拒绝 | `core/storage/revision.ts`（`assertExpectedRevisionShape` / `assertSafeRevision` / `nextRecordHeader` / `describeValue`），记录与 registry 共用 | 「W1：expectedRevision 的非安全整数…不落盘不留锁」「W1：已不安全 revision 的记录与 registry 都拒绝递增…」「W1：registry 达到 MAX_SAFE_INTEGER…」「W1：registry 更新沿用公共头…」 |
| W2 | 锁时序参数入口校验、坏元数据不抛裸异常、读诊断传播取消、等待前复查两 signal | `core/storage/lock.ts`（`resolveLockTiming`、`parseLockMeta`、`readLockMeta` / `readLockMetaForCleanup`） | 「W2：非法锁时序参数…」「W2：极端/损坏的锁元数据只按忙碌处理…」「W2：等待读锁诊断期间取消优先于超时…」「W2：锁等待对 boundary 与调用方两个 signal 都敏感…」「W2：托管字段/正文形态错误在取锁之前拒绝…」 |
| W3 | 正常 close 失败中止提交、create 非覆盖发布、失败路径清理/释放有界诊断、成功后返回真实状态与警告 | `core/storage/commit.ts`（`prepareTempFile` / `removeTempFile` / `renameWithRetry` / `attachCleanupNote`）、`boundary.ts`（`publishJsonMeasured`）、`write.ts`（`runUnderLock`） | 「W3：准备阶段 close 失败必须中止提交…」「W3：失败路径上的清理失败只作附加诊断…」「W3：create 是非覆盖发布…」「W3：提交成功但有遗留时返回有界警告…」 |
| W4 | 普通 create/update 先确认库有效（不是"文件存在"） | `core/storage/write.ts` 的 `assertStoreInitialized`（复用 `readRegistryWithBoundary` 的有界读取 + 版本闸门 + 结构/绑定校验） | 「W4：registry 损坏 / 未来版本 / 绑定冲突 / 目录时拒绝写入…」 |

## 2. 接续轮（R1～R4）做了什么

### R1 锁等待不得越过 timeout 预算（先红后绿）

- 现象（交接时的独立诊断）：先持有目标锁，再以 `timeoutMs=10` / `pollMs=1000` 请求，
  实际约 121ms 才由 120ms watchdog 取消收场，而不是在 10ms 预算附近 `lock-timeout`。
- 根因：失败分支先判 deadline，但等待量仍直接取 `timing.pollMs`——**参数合法不等于等待有界到用户预算**。
- 修复（`lock.ts`）：`await delayWithCancellation(Math.min(timing.pollMs, deadline - Date.now()), signals)`。
  进入该行时 `Date.now() < deadline` 已成立，剩余量至少 1ms，因此不会退化成零间隔忙等。
- 回归：新增「W2：合法但超长的 poll 不得让等待越过 timeout 预算」（watchdog 只兜底，断言**以超时收场** +
  实际等待 `< 500ms` + 不抢占他人锁）与「W2：timeout=0 只尝试一次…」（断言消息含"尝试 1 次"）。
- 红/绿证据：修复前该用例以 `poll(1000ms) 不得把 10ms 预算拖成实等 1192ms` 失败；修复后通过。
- 保留语义：`timeout=0` 只尝试一次；两 signal 任一取消穿透且不可被超时覆盖（取消与截止同时成立报 `cancelled`）；
  不新增锁协议、不加整库全局锁。

### R2 失败路径的清理/释放诊断（先红后绿）

- 现象：`runUnderLock` 的 catch 仍是 `await lock.release().catch(() => undefined); throw error;`，
  成功路径有 `warnings`，失败路径丢掉"锁未释放"的诊断；另外 `publishJsonMeasured` 返回
  `{status:"exists", cleanup:"failed"}` 时，`commitRecord` 的 exists 分支直接抛 `revision-conflict`，
  **临时残留诊断被吞**。
- 修复（`write.ts`）：
  - 抽出 `lockReleaseNote(outcome)`（成功/失败两条路径共用同一措辞）与 `releaseOwnLock(lock)`（把释放结果
    收敛成 `LockReleaseOutcome`，释放抛错 → `failed`，仍**忽略取消**）；
  - 失败路径：`released` 才原样抛；`not-owner` / `missing` / `failed` 用 `attachCleanupNote`
    追加固定文案，`attachCleanupNote` 逐一搬运 `code` / `path` / `detail` / `expected` / `actual` / `cause`，
    **不覆盖首个错误、不含正文**；
  - `exists` 分支按 `published.cleanup` 决定是否附加 `CLEANUP_FAILED_NOTE`。
- 回归（均先红后绿）：「W3：失败路径上的自有锁释放失败必须作为附加诊断，不覆盖原错误」、
  「W3：失败路径上锁释放命中 not-owner/missing 时同样给出有界诊断且不删锁」、
  「W3：发布窗口内目标已存在且临时清理失败时，冲突诊断不被吞掉」。
- 保留语义：提交成功后仍返回真实 `created` / `updated` 与 `warnings`，不用清理失败制造"未提交"假象。

### R3 补证据（不扩张功能）

- **FileHandle 生命周期**：「R3：临时文件句柄在正常/失败/取消路径都被显式关闭（不依赖 GC）」
  用注入的 `closeFile` 捕获真实句柄，断言 `handle.fd === -1`（Node 关闭后置 -1 的可观测事实），
  覆盖正常提交、`sync` 失败、打开后取消、`close` 失败（先关后抛，注入被调用两次）、
  `open` 之前失败（`closeFile` 调用次数必须为 0）。不再以"随后还能写"代替句柄已关闭。
- **create 故障面**（公开路径）：新增「R3：create 记录时硬链接不被支持 → publish-unsupported，不回退直写」
  （只尝试一次 `link`、不创建目标、无 `.tmp`、锁已释放）、
  「R3：create 在发布等待期间取消 → cancelled，不留目标/临时文件/锁」、
  「R3：create 提交成功后的迟到取消仍报告真实 created（不假称回滚）」；
  清理失败路径由 R2 的用例覆盖（create 公开路径）。
- **替换重试预算核对**：「R3：rename 可重试失败最终成功时 renameAttempts 如实反映尝试次数」（4 次尝试）、
  「R3：rename 始终失败时有界放弃（预算内、不在退避中挂死）」（恰好 12 次尝试、实际约 2.2s、原字节不变、
  无残留、锁已释放）、「R3：rename 退避等待期间取消立即生效（不等完这一轮退避）」（`< 1s` 返回 `cancelled`）。
- **W4 既有记录与链接保护**：
  - 「W4：先有合法记录，registry 随后损坏时 update 拒绝：既有记录与 registry 原 hash 都不变」
    （坏 JSON / 未来版本 / 绑定冲突 / registry 是目录四场景，先 create 一条合法记录再损坏 registry）；
  - 「W4：registry 被换成链接/junction 时普通 create/update 拒绝，根外 sentinel 不变」：
    目录 junction 子用例**实跑通过**；文件型 symlink 子用例在本机 EPERM，**显式 skip 并记录原因**，未假通过。
- **`commit.ts` 注释中的"本机实测"已删除**：改为"标称预算 + 说明延迟序列理论总和约 2.05s、
  先触达的是次数上限"，并说明真实的 Windows 共享冲突持续时间没有可控实验数据，不作为"偶发失败已消除"的依据。

### R4 格式、文档与收口

- 定向格式化：`npx biome format --write core/storage/revision.ts`（该文件此前是 CRLF，
  其余存储文件均为 LF）。**只改这一个文件**，未改配置、未全仓库机械改写；`biome` 未改动其它内容。
- README 更新：状态行、验收状态、revision 语义（去掉"已知 W1"）、锁参数范围与 poll 预算裁剪（W2）、
  释放失败在两条路径的上报方式（W3）、create 走 `link` 非覆盖发布 / update+registry 走 `rename`（W3 修正，
  删掉"create/update 都走 rename"与"正常路径 close 错误当前被吞掉"等过时表述）、
  有效库准入（W4）、提交后警告与残留、已验证基线的真实统计、已知限制（含两个 skip 与未测范围）。
- `core/storage/index.ts` 头注释"本轮范围：只读"与实际导出（lock / write / revision）矛盾，已改写为
  当前范围并显式声明 journal/迁移未实现、不导出占位实现。
- 同步 [任务状态](task_breakdown.md)、[测试清单](test_checklist.md)、[开发日志](development_log.md)，
  并把 [中断交接](bm02br_handoff.md) 标为"已接续完成，见实施记录"，保留链接避免出现多个当前任务入口。

## 3. 实跑结果（2026-10-01，Windows + PowerShell + Node 24.14.1 + Pi 0.87.1）

| 工作目录 | 命令 | 实际结果 |
|---|---|---|
| `packages/bios-agent` | `npm run typecheck` | 通过（`tsc --noEmit` 无输出） |
| 同上 | `npm test` | **183 用例：181 通过、0 失败、2 显式 skip**（均为文件型 symlink EPERM：`storageRecords` 的"最终记录文件本身是链接"与新增的"registry 是文件型 symlink"）；真实双子进程创建/更新竞争、新进程读回、并发读写实际通过 |
| 同上 | `npm run selfcheck` | 6 项通过 |
| 同上 | `npm run check:format` | 通过（31 文件） |
| 仓库根 | `npm run typecheck` | 通过 |
| 仓库根 | `npm run check:format` | 通过（2014 文件；注意根脚本**不检查**本 Package，不能抵消包内结果） |
| 仓库根 | `node --test tests/processGuards.test.mjs` | 2 项通过 |
| 仓库根 | `git diff --check` | 通过（不覆盖未跟踪文件内容） |

测试数量变化：第六轮基线 140 → 交接时 158 → 本次 183（新增 W2 预算 2 条 + W3 诊断 3 条 +
W4 证据 5 条（含 2 个子用例与 1 个目录 junction 实跑）+ R3 证据 8 条（含 5 个句柄子用例与 2 个链接子用例））。
**数量不是验收依据**。

## 4. 未测、skip 与明确边界

- 未执行：仓库根全量测试、生产构建与安装包、干净 clone 的独立工具链、远端 CI、Linux/macOS、
  真实客户 BIOS 资料试点。以上均**不得**写为通过。
- 两个显式 skip 都是**符号链接权限**（本机 EPERM，需开发者模式/管理员）：
  `registry.json` 的文件型 symlink；`storageRecords` 里的记录文件 symlink。目录 junction 用例实跑通过。
- 故障注入（`ioHooks`：`ENOSYS` 发布、`close` 失败、`EIO`、`EBUSY`）只用于确定性复现分支，
  **不代表本机磁盘真的发生过这些故障**；真实 EACCES 与真实 `EBUSY` 重命名竞争仍未在真机造出。
- 仍不宣称：崩溃一致性/断电一致性（journal 属 BM-02C1）、跨文件事务、审计与迁移（BM-02C2）、
  备份恢复与管理 CLI（BM-02D）；锁只约束遵守同一协议的本地进程。
- 文件体量：`boundary.ts` 596 行（路径边界 + 有界读取 + 发布/替换/列举），`write.ts` 522 行
  （三类入口 + 库准入 + 持锁提交与结果），`commit.ts` 225 行（提交原语 + 有界诊断）。
  取舍是"按职责拆出提交原语、保持导出兼容"，**没有**为凑行数继续重写整个存储层；
  新业务（journal）应开新模块，不要塞回这两个文件。

## 5. 与既有文档的关系

- [BM-02B 实施记录](bm02b_implementation.md) 的 §5「共用同一条提交路径」与 §9
  「create 不覆盖靠锁内存在性检查」描述的是 **BM-02B 当时**的实现，已被本轮 W3 取代
  （create 改为 `link` 非覆盖发布；rename 重试改为 12 次指数退避、上限 250ms、标称总预算 4000ms）。
  该文件作为历史记录保留，不逐字改写；冲突时以本文与源码为准。
- 本轮只收尾 BM-02BR。**不自动继续 BM-02C**：下一步是独立复验，通过后再确定
  BM-02C1 单文件 journal/崩溃恢复的协议。
