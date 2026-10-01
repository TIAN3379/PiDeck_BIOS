# BM-01R2 收尾记录（F1～F4）

日期：2026-10-01

> 后续独立验收：F1～F4 功能通过，但发现取消时目录句柄清理 G1，故“60 用例通过”不是资源生命周期全部通过。详见 [第三轮验收](round3_acceptance.md)；下一轮按 [BM-02A 开发说明](bm02a_development_plan.md) 先小修再推进存储。
范围：只做 `docs/bios-agent/round2_acceptance.md` 第 3 节的 F1～F4，以及第 4 节中落在同一触达模块的建议。
不开发 BM-02、不做桌面 UI、不接入厂商规则、不改 Pi 内核。

**交付性质说明**（对应第 4 节建议 6）：以下结论都是**本地交付 + 本机自测**结果。
Package、锁文件与文档目前仍未被 git 跟踪，CI 步骤也只是本地配置改动：
"CI 已接入"≠"远端 CI 已绿"，"复验完成"也仅指本机复跑，不代表独立验收已完成。

## 验证命令与结果

| 检查 | 结果 |
|---|---|
| 包内 `npm run typecheck` | 通过 |
| 包内 `npm test` | **60 通过，0 失败，0 跳过**（上一轮 45 个全部保留，新增 15 个） |
| 包内 `npm run selfcheck` | 5 项通过 |
| 包内 `npm run check:format` | 通过（16 文件） |
| 根 `npm run typecheck` | 通过 |
| 根 `npm run check:format` | 通过（2014 文件） |
| `node --test tests/processGuards.test.mjs` | 2 通过 |
| `git diff --check` | 通过（已跟踪文件）；新增文件另做行尾检查 |

## F1（P1）· 带后缀的保留名在 schema 层被接受

**现象**：`Value.Check(KnowledgeIdSchema, "con.json")` 为 true，而 `inspectKnowledgeId("con.json")` 返回
`reserved-name`——两条链的允许集合不同，未来"只用契约校验"的写入路径会收下随后被路径层拒绝的记录。

**根因**：负向断言只排除"整个字符串等于保留名"（`(?!…$)`），而运行时检查取第一个点之前的主名。

**整改**（`core/contracts/ids.ts`）：

- 负向断言改为 `(?!(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$))`，同时覆盖无后缀与点后缀形式；
- 运行时改为**先由同一份正则判定是否接受**，再单独分类错误码；
  分类不再参与"是否接受"的判定，因此 schema 与运行时不可能出现不同允许集合；
- 保留 `reserved-name` / `trailing-dot` / `charset` 的细分错误码，报错仍可操作。

**证据**（`tests/contracts.test.mjs`）：

- 覆盖 `con`/`prn`/`aux`/`nul`/`com1`/`com9`/`lpt1`/`lpt9` 的无后缀、单点后缀、多点后缀共 32 组输入，
  断言 schema 与运行时**同时**拒绝，并在完整 `ExperienceCard` 校验入口验证；
- 反例集合（`console`、`nullify`、`com10`、`lpt10`、`com1x`、`auxiliary`、`printer`、`con2`、`exp-1.2`）
  断言两者**同时**接受，避免把正常项目名误杀；
- 另外断言错误码仍指向具体原因（`con.json` → `reserved-name`，`Exp` → `charset`）。

## F2（P2）· 无盘符根路径随 cwd 盘符漂移；paths 有相对根旁路

**现象**：Windows 上 `\BIOS_Knowledge` 的 `isAbsolute` 为真但无盘符，`resolve` 会补进程当前盘符，
同一 override 在 `C:\Windows` 与 `D:\...` 下得到两个不同知识库；
`resolveKnowledgePaths("knowledge")` 仍接受相对根并 resolve 到 cwd，对象入口返回的 `root` 还是相对字符串。

**整改**（`core/paths.ts`）：

- 新增 `isFullyQualifiedPath(value, platform)` 纯函数：Windows 只接受盘符绝对（`C:\…`）或合法 UNC
  （`\\server\share\…`），拒绝 `\name`、`/name`、`C:name`；POSIX 只接受以 `/` 开头；
- 新增 `requireFullyQualifiedRoot(value, label)` 作为**唯一**校验+规范化入口，
  不再使用会补盘符的 `resolve()`；
- `resolveKnowledgeRoot`（override / env）、`resolveKnowledgePaths`（**字符串入口与对象入口**）、
  `resolveInsideRoot`、`defaultKnowledgeRoot` 全部复用该入口，取消"绕过上游函数拿相对根"的旁路；
- `defaultKnowledgeRoot(home)` 也要求 `home` 完全限定，默认值仍是 `<home>/BIOS_Knowledge`。

**证据**（`tests/paths.test.mjs`）：

- `isFullyQualifiedPath` 按平台参数做纯函数断言（win32 与 linux 两组规则，不依赖真实目录）；
- 平台条件下的非法输入（Windows 上 `\BIOS_Knowledge` / `/BIOS_Knowledge` / `C:BIOS_Knowledge` / `BIOS_Knowledge`）
  经 override 与环境变量两条通道都被拒绝；
- `resolveKnowledgePaths("knowledge")`、`resolveKnowledgePaths({ root: "knowledge" })`、
  `resolveKnowledgePaths({ root: "." })` 均被拒绝；合法完全限定根在两个入口给出一致结果；
- `defaultKnowledgeRoot("relative-home")` 被拒绝。

## F3（P2）· 取消发生在异步等待期间时小扫描仍返回成功

**现象**：小目录（条目数少于 `yieldEvery`）在 `probeProjectDirectory` 已开始后 `abort()`，
函数仍扫描完成后 resolve 成功；检查点只在循环顶部与批次让出之后。

**整改**（`core/projects/probe.ts`）补齐检查点：

- 函数入口（同步阶段）；
- **`await opendir` 之后**（取消可能恰好落在这个等待窗口）；
- **每一个条目**（`for await` 的 `next()` 本身也是等待点，只靠批次检查会漏掉小目录）；
- `for await` 正常结束之后；
- **最终 `return` 之前**。

取消一律抛 `ProbeCancelledError`，不包装成成功结果或普通 warning；`finally` 仍兜底关闭目录句柄。

**证据**：`tests/probe.test.mjs` 新增
- 「小目录调用后立即取消」与「空目录调用后立即取消」两个用例（复现验收脚本的场景）；
- 保留原有大目录中途取消、预先取消、预算截断用例；
- `tests/extensionLoad.test.mjs` 新增**工具层**真实 `AbortSignal` 回归：
  调用 `execute` 后立即 abort，断言整次工具调用以失败告终（`cancelled`），而不是返回"扫描了 N 个路径"的成功结果。

## F4（P2）· 额外授权根接受相对配置

**现象**：`authorizedRoots: ['.']` 被 `statSync` 按**进程** cwd 解析，把包目录加进授权范围；
`'../..'` 可把整个仓库纳入范围。会话 cwd 与进程 cwd 不同时，同一配置授予不同访问范围。

**整改**（`core/projects/authorization.ts`）：

- 额外根先经 `requireFullyQualifiedRoot` 校验，非法配置抛新错误码 `invalid-authorized-root`，
  **不按进程 cwd 补全**；
- 完全限定但当前不可达的根进入 `unreachableRoots`（离线标记），与"配置非法"明确区分；
- 会话 `cwd` 同样要求完全限定（失败为 `invalid-cwd`）；
- 生效根按 `realpath` 去重（`C:\k` 与 `C:\k\.` 不会算两个根）；
- 相对 `targetDir` 改为 `join(cwdReal, requested)`——按**会话** cwd 解析，越界仍由授权检查拒绝。

**证据**（`tests/authorization.test.mjs`）：`. / .. / ../.. / ./sub / 空串` 全部被拒绝；
进程 cwd 与会话 cwd 不同的条件下 `.` 不会扩权且 `effectiveRoots` 不含 `process.cwd()`；
不可达根记为离线；realpath 去重；原有的第二个根可用、根外拒绝、junction 逃逸用例保持通过。

## 第 4 节建议的顺手收口

| 建议 | 处理 |
|---|---|
| 1 安装前提写完整 | README 新增"安装与依赖前提"表：根工程提供 `tsc`/`biome`，本包提供 Pi 宿主；明确"先装根、再装包" |
| 2 RPC 封装缺口 | 补 stderr 上限、改用 `close`（stdout/stderr 排空后收尾）、补 stdin 错误处理 |
| 3 目录包含判断 | `resolveInsideRoot` 与 `isWithinAuthorizedRoot` 改为精确匹配 `..` / `..` + 分隔符；根内 `..cache` 不再误判，逃逸用例保留 |
| 4 截断与告警上限 | probe 新增 `droppedWarnings` / `skippedDirectories`，告警触顶同时标记 `truncated`（维度 `warnings`）；README 修正上限语义 |
| 5 不扩大结构测试结论 | README「已知限制」明确：真实 worktree 检测/绑定/迁移尚未实现，只有契约层结构测试 |
| 6 工作区≠提交 | 本文档开头声明本地交付/独立验收/远端验证的区别；不把"CI 已接入"写成"CI 已绿" |

## 未完成与未验证（明确边界）

- **未验证**：干净 clone 上"只复制 Package 目录"能否独立跑全部检查（当前仍依赖根工程的 tsc / biome）；
  远端 GitHub Actions 未运行；根全量测试、生产构建、安装包 smoke 未执行。
- **未实现**：BM-02A 起的存储（registry 契约与初始化、限额读、真实 IO 根与链接策略、版本/损坏保护）；
  R3 提到的 IO 层链接策略与并发锁仍在 BM-02B/C。
- **未实现**：真实 Git worktree 的检测、绑定与迁移；EvidenceRef 的业务级校验（跨记录引用、工作区 ID 唯一性）
  按验收意见留给 BM-02/03 的真实操作入口。
- **仍为空**：`tests/fixtures` 没有样例数据（暂无真实 BIOS 项目，样例需自建脱敏）。
