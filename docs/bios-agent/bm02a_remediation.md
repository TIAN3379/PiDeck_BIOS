# BM-02AR 实施记录：存储边界收尾

日期：2026-10-01。依据 [第四轮历史摘要](acceptance_history.md#第四轮与-s1s5) 与 [历史收尾任务](bm02a_remediation_plan.md)。
本记录只描述**本轮实际做了什么、用什么回归证明、还有哪些没测**，作为独立复验的输入；
自测结论不等同于独立验收结论。

> 历史实施记录：第五轮留下的 B0 现已在[第六轮验收](round6_acceptance.md)关闭；当前任务见 [next_development.md](next_development.md)。以下保留当时自测记录，不代替最新独立结论。

## 0. 范围与结果

- 只改 `packages/bios-agent/core/storage/*`、两个既有测试的期望值、`README` 与本套文档；
  未新增 UI、RAG/数据库、厂商识别、Pi 内核改造或模型写知识工具；未偷跑 BM-02B/C/D。
- 顺序：先给每个子任务加**失败/窗口回归**，再做最小修改。
- 结论：S1～S5 均有实现改动 + 永久回归；包内与根门禁全绿。

| 门禁 | 结果 |
|---|---|
| Package `typecheck` | 通过 |
| Package `check:format` | 通过（26 文件，无改动） |
| Package `test` | **107 用例：106 通过、0 失败、1 显式 skip**（较本轮前 +18） |
| Package `selfcheck` | 通过（6 项） |
| 根 `typecheck` | 通过 |
| 根 `check:format` | 通过（2014 文件，无改动） |
| `tests/processGuards.test.mjs` | 通过（2 用例） |
| `git diff --check` | 通过（无空白错误） |

新增用例全部集中在 `packages/bios-agent/tests/storageRemediation.test.mjs`（18 条），
按收尾文档 §3 的 9 组组织；故障注入只用于**确定性复现特殊分支**，不代表本机磁盘真的发生过对应故障。

## 1. S1 —— 初始化完整发布（AR-1）

**问题（第四轮）**：`publishJson` 在硬链接失败时回退 `writeFile(target, { flag: "wx" })`，只能保证"不覆盖"，
不能保证"写完整前不可见"，并发读者可能看到 0 字节/半截 registry；
且初始化竞争重试把 EPERM/EACCES 也当成"可重试"。

**实现**：

- `core/storage/errors.ts`：新增错误码 `publish-unsupported`；新增 `classifyLinkFailure()` 把链接失败分为
  `exists` / `unsupported`（ENOSYS、ENOTSUP、EOPNOTSUPP、EXDEV、EINVAL，Windows 上含 EPERM）/
  `permission`（EACCES，非 Windows 的 EPERM）/ `other`，并把原始 errno 放进 `detail`。
- `core/storage/boundary.ts` `publishJson`：**删除直写回退**。流程固定为
  「同目录临时文件（`flag: "wx"`）→ `link()` → 删临时文件」，`finally` 保证临时文件在任何路径下都被删除。
  链接失败按 `classifyLinkFailure` 分派：`exists` → 返回 `"exists"`；`unsupported` → `publish-unsupported`；
  其余 → `permission-denied`/`mapFsError`。三者都**不创建目标文件**。
- `core/storage/registry.ts`：`isRetryableInitRaceError()` 改成白名单（仅 `not-found` / `init-race`），
  `sleepWithCancellation()` 在等待前/后都检查取消；取消、权限、永久结构/版本错误不再被改写成 `init-race`。

**回归证据**（`storageRemediation.test.mjs`）：

| 用例 | 断言要点 |
|---|---|
| AR-1：硬链接不被支持时初始化明确失败，不创建 registry 也不留半文件 | 注入 `link` ENOSYS → `publish-unsupported`；链接只被尝试 1 次；无目标、无 `.tmp` 残留 |
| AR-1：发布权限不足时报 permission-denied，不创建 registry | 注入 EACCES → `permission-denied`；无目标、无残留 |
| AR-1：发布窗口内目标不存在，读者看不到空/半 registry | `beforeIo("link")` 时目标必为 ENOENT，且同目录恰好 1 个完整临时文件；发布后内容合法、`.tmp` 清空 |
| AR-1：既有 registry 的字节在失败/重复发布尝试下原样保留 | registry 已存在时 `status === "existing"`、`link` 调用数为 0、文件 hash 不变 |

**未测/限制**：不支持硬链接的文件系统上初始化会**明确失败**，本轮不提供替代发布路径；
真实的"两子进程首发"竞争仍在既有 `storageRegistry.test.mjs` 覆盖，本轮未新增真实多进程发布竞争。

## 2. S2 / S3 —— 共享校验链与有界读取/取消（AR-2）

**问题（第四轮）**：`readRecord` 与列表用了两套校验（列表不校验归属，A 目录里的 B 项目记录被当成合法摘要）；
读取信任 `stat` 且"未到 EOF 就解析恰好合法的前缀"；最后一个 IO 点取消仍返回成功，列表 `catch` 把
`cancelled` 收成一条 `problems`。

**实现**：

- `core/storage/records.ts`：抽出共用校验链 `interpretRecord()`——版本 → kind schema → 文件 ID/记录 ID →
  任务 `projectId` / 清单 `targetProjectId`；`readRecord` 与列表逐条读取都复用它。
  kind→解析器改用**类型化映射**（`SUMMARIZERS` / `OWNERSHIP_CHECKS` 及 `RecordByKind`），不再 `switch` + `as never`。
- `core/storage/boundary.ts` `readJson()`：改为分块 `while (total <= maxBytes)` 直到 EOF 或上限 +1；
  `stat` 仅作快速预检；`reachedEof` 兜底，未到 EOF 不解析前缀；每个 IO 等待点后 `throwIfAnyCancelled`，
  并在**循环后/返回前**再检查一次（覆盖"最后一次 read 直接 EOF"）；`finally` 关闭 `FileHandle`。
- `records.ts` 列表循环新增 `rethrowIfCancelled()`：整体取消**穿透**单条问题的 catch；
  初始化重试同样不吞取消。

**回归证据**：

| 用例 | 断言要点 |
|---|---|
| AR-2：A 目录内的 B 项目任务/上下文清单：单条拒绝、列表只进 problems | `readRecord` → `record-id-mismatch`；列表 `entries` 不含错归属项、`problems` 记 `record-id-mismatch` |
| AR-2：stat 报告过小后文件增长：拒绝解析合法前缀，正常读取确实到达 EOF | 注入过期 `stat`：超限 → `too-large`，合法前缀 + 尾巴 → `invalid-json`；正常文件 `bytes === 真实字节数` |
| AR-2：最后一次 read 返回 EOF 时取消 | 空文件 + `read` 前 abort → `cancelled`（而非成功/`invalid-json`） |
| AR-2：空目录打开期间取消 | `opendir` 后 abort → `cancelled`（而非成功空列表） |
| AR-2：列表处理最后一条时取消 | 打开第 2 条（最后一条）前 abort → `cancelled`，不进入 `problems` |
| AR-2：初始化竞争等待期间取消 | 注入 EEXIST 进入重试等待，等待期间 abort → `cancelled`，不写成 `init-race`，目标不存在 |

另外 `core/storage/errors.ts` 新增 `throwIfAnyCancelled()`，让"调用方 signal 与 boundary signal 任一取消即失败"
只有一个实现来源；`boundary` 与 `records` 的所有等待点都走同一出口。

**未测/限制**：取消发生在"硬链接发布已成功提交之后"时，返回的是真实提交状态（不假装回滚），
由实现注释与既有测试说明，本轮未新增该窗口的专项用例。

## 3. S4 —— 列表预算与异常输出（AR-3）

**问题（第四轮）**：非法候选文件名（如大写 ID）让整个列表失败；`problems` 不计入列表字节预算；
限额可为 `NaN`/负数且默认对象可能被单次调用污染。

**实现**：

- `core/storage/limits.ts`：新增 `maxListProblems`（默认 50）；`resolveStorageLimits()` 忽略显式 `undefined`
  并校验有限非负整数，否则抛 `invalid-limits`；返回新对象，**不修改默认对象**。
- `core/storage/records.ts`：候选文件名/ID/路径派生/读取/版本/结构/归属错误统一进有界 `problems`；
  `measureEntry` / `measureProblem` 按**实际输出字段**计量；条目与 `problems` **共用** `maxListBytes`；
  超限返回 `truncatedBy`（`bytes` / `entries` / `problems` / `scan`）与 `droppedProblems` / `skippedEntries`。
- `core/storage/boundary.ts` `listEntries()`：新增 `includeSymlinks`——链接默认**跳过且不读目标正文**；
  传 `true` 时把名字交回调用方，由 `assertNoSymlinks` 在 `open` 前明确拒绝（`symlink-rejected`）。
  三处目录扫描统一传 `includeSymlinks: true`，链接既不静默消失也不被读成记录。

**回归证据**：

| 用例 | 断言要点 |
|---|---|
| AR-3：混入大写/非法 ID 文件名、非 .json 与损坏记录：合法记录仍可列 | 合法 2 条正常返回；大写 ID → `invalid-record`、损坏 → `invalid-json`；`notes.txt`/`.hidden.json` 计入 `skippedEntries` |
| AR-3：project-profile 列表遇到非法项目目录名：进 problems，其余项目继续可列 | 非 UUID 目录 → `invalid-record`，合法项目仍列出 |
| AR-3：小字节预算下 problems 也受限，截断原因与丢弃计数可见 | `maxListProblems: 1` → 1 条 + `truncatedBy` 含 `problems`；`maxListBytes: 300` → 问题数受限、`truncatedBy` 含 `bytes`、`droppedProblems > 0` |
| AR-3：非法限额被结构化拒绝，undefined 保留默认，默认对象不被调用污染 | `NaN`/`Infinity`/`-1`/`1.5` → `invalid-limits`；显式 `undefined` 保留默认；默认对象不被修改；公共入口同样拒绝 |

**未测/限制**：`droppedProblems` 是"未尝试输出"的下界计数（截断点之后不再逐条计量），
语义已在 README 与代码注释写明，不宣称精确等于"被丢弃的合法问题数"。

## 4. S5 —— 绑定解析（AR-3）

**问题（第四轮）**：`registry.projects` 里重复 `biosProjectId` 未被拒绝；矛盾组合查询被静默忽略；
多工作区仅给项目 ID 时取 `workspaces[0]`。

**实现**（`core/storage/registry.ts`）：

- `inspectBindingIssues()` 新增 `duplicate-bios-project`：`biosProjectId` 唯一性**先于一切解析**。
- `resolveProjectBinding()` 重写：先跑唯一性检查（有冲突即 `conflict` / `inconsistent-registry`），
  再做 `normalizeFilter` + 组合过滤；显式条件矛盾（项目 ID 与桌面 ID 指向不同项目）→ `contradictory-filters`；
  路径属于 A 而显式项目为 B → `missing` / `no-match`（**不返回 A 的 resolved**）；
  多工作区仅指定项目/桌面 ID → `conflict` / `ambiguous-workspace` 并给出候选；单工作区仍自动解析。

**回归证据**：

| 用例 | 断言要点 |
|---|---|
| AR-3：重复 biosProjectId 的 registry 被拒绝，不靠 find 选首条 | 内存对象与文件两条路径：`conflict`/`inconsistent-registry`、`binding-conflict` |
| AR-3：矛盾组合查询不静默忽略，多工作区不任取首个 | 路径 A + 项目 B → `missing`/`no-match`；项目 A + 桌面 desk-b → `contradictory-filters`；一致组合仍 `resolved`；多工作区 → `ambiguous-workspace` + 排序候选 |

**期望变更的既有用例**（预期行为变更，非缺陷）：

- `storageRegistry.test.mjs`：同路径归属两项目 → 由 `ambiguous-workspace` 改为 `inconsistent-registry`
  （整份 registry 已不成立，任何"解析成功"都不可信）。
- `storageRecords.test.mjs`：多工作区仅项目 ID → 由 `resolved`（取首个）改为 `conflict`/`ambiguous-workspace`。

## 5. 收尾文档 §3 的 9 组回归映射

| §3 组 | 覆盖用例（`storageRemediation.test.mjs`） |
|---|---|
| 1 硬链接不支持/权限/发布暂停 | AR-1 四条 |
| 2 A 目录内 B 记录 | AR-2「A 目录内的 B 项目任务/上下文清单」 |
| 3 stat 后增长 / 真实 EOF | AR-2「stat 报告过小后文件增长」 |
| 4 各 IO 点取消 | AR-2 四条取消用例 |
| 5 混入非法/损坏条目 | AR-3「混入大写/非法 ID…」「非法项目目录名」 |
| 6 小预算 + 多条损坏 + 非法限额 | AR-3「小字节预算…」「非法限额…」 |
| 7 重复 ID / 矛盾 / 多工作区 | AR-3「重复 biosProjectId…」「矛盾组合查询…」 |
| 8 目录 junction 逃逸 / 最终文件链接 | AR-3「初始化时根内目录是逃逸 junction」（本机实际执行，未跳过）；最终文件链接仍沿用既有用例 |
| 9 非空 fixture 新进程读取 | AR-3「非空 fixture 新进程读取」（真实子进程，带超时/输出上限） |

## 6. 未验证范围（与自测分开）

- 跨平台：Linux/macOS 只做了代码路径与逻辑推断，未在真实平台运行。
- 文件型符号链接用例在本机因权限（EPERM）仍显式 skip；**目录 junction 用例未跳过**，本轮实际执行。
- 干净 clone 的独立工具链、远端 CI、生产构建与安装包均未运行。
- 真实的"多进程同时首发"竞争、真实权限失败、告警上限触顶未在本轮新增真实环境复现。
- 未使用真实客户 BIOS 项目或模型；全部为自建临时数据 + 受控 IO 故障注入。

## 7. 交回与下一阶段

- 本轮**没有** `git add`/`commit`/`push`；保留所有既有用户改动与未跟踪文件。
- 完成后交回独立验收；BM-02B（写入协议、锁、原子替换）等 AR 复验通过后再启动，
  详细方向见 [收尾任务](bm02a_remediation_plan.md) §5。
