# BM-01R 整改记录（R1～R6）

日期：2026-10-01
范围：只做 `docs/bios-agent/round1_acceptance.md` 的 R1～R6 整改；不实现 BM-02 存储、不做桌面 UI、不接入厂商规则。
实施方自测结论：**R1/R2/R3/R4/R5/R6 均已在 Package 侧完成**；R3 的"真实 IO 前校验"按验收要求留给 BM-02A。

> 后续独立验收：45 个既有用例确实全部通过，但发现四个未覆盖的边界，当前状态为有条件通过。最新结论以 [第二轮验收](round2_acceptance.md) 为准；下文保留当时的开发记录，不代表 F1～F4 已修复，也不代表工作区文件已经提交或远端 CI 已执行。

## 验证命令与结果

| 检查 | 结果 |
|---|---|
| `packages/bios-agent` → `npm install` | 通过（241 包，安装 Pi 宿主 0.87.1；锁文件提交） |
| 包内 `npm run typecheck` | 通过（exit 0） |
| 包内 `npm test` | **45 通过，0 失败，0 跳过**（原 20 用例全部保留） |
| 包内 `npm run selfcheck` | 5 项通过 |
| 包内 `npm run check:format` | 通过（16 文件） |
| 根 `npm run typecheck` | 通过 |
| 根 `npm run check:format` | 通过 |
| `git diff --check` | 通过 |

Pi 集成用例（SDK 装载、CLI `-e` 加载、隔离配置下的 RPC `get_commands`）在宿主缺失时会**失败**并提示安装，
不再 skip；本次为 0 跳过。

## R1 · 扫描可取消与单目录读取上限（P1）

**问题**：同步扫描不让出事件循环，取消事件无法在扫描中生效；`readdirSync` 一次取出整个目录，
`maxPaths` 不构成实际读取上限。

**整改**（`core/projects/probe.ts`）：

- 改用 `fs/promises.opendir` 流式迭代，目录句柄顺序使用（同时最多 1 个），`finally` 兜底关闭；
- 每 `yieldEvery`（默认 200）个条目 `setImmediate` 让出事件循环，**让出后立刻检查 `AbortSignal`**；
- 单层超大目录在命中预算时立即 `break`，不再先物化整个目录的 `Dirent` 列表；
- 新增预算维度与上限：`truncatedBy: paths | depth | pending-directories`、
  `MAX_PENDING_DIRECTORIES = 5000`、`MAX_PROBE_WARNINGS = 50`；
- 取消抛 `ProbeCancelledError`（冒泡为失败的 tool result，不是普通成功结果）。

**证据**：`tests/probe.test.mjs`
- 「开始后取消能中途生效」：先让扫描跑过一个让出点，再 `abort()`，断言 reject（不是只测预先取消）；
- 「路径预算」「深度预算」分别断言截断维度；
- 「不可读 / 不存在的目标如实进入 warnings」断言不抛错、不静默。

## R2 · 知识根默认值与相对路径（P2）

**问题**：默认值写死 `D:\BIOS_Knowledge`（与 MVP §5.1 不符，且没有该盘符的机器要改源码）；
override 与环境变量接受相对路径，会随 cwd 漂移。

**整改**（`core/paths.ts`）：

- 默认值改为 `<用户目录>/BIOS_Knowledge`，不再按平台写死盘符；
- 相对路径（override 与环境变量）**一律拒绝**，抛 `KnowledgePathError("relative-root")`；
- 桌面端由适配层传入 `<userData>/bios-knowledge`；core 不引入 Electron；
- 移除 `platform` 参数，测试全部使用真实平台的 path 与真实临时目录。

**证据**：`tests/paths.test.mjs`（默认值由 home 推导、优先级、相对路径拒绝、空白按未提供处理）。

> 迁移说明：本轮之前默认是 `D:\BIOS_Knowledge`。仍希望放在项目盘的用户，
> 通过显式绝对路径配置或 `BIOS_KNOWLEDGE_ROOT=D:\BIOS_Knowledge` 得到同一结果——
> 位置由配置决定，不再由代码默认值决定。

## R3 · ID 与路径拼接（P1，存储前置）

**问题**：`CON`、`NUL` 等保留名可通过；`exp.` 产生尾随点；大小写与尾随点别名会让两个 ID 命中同一目标；
schema 与路径规则是两份正则；`resolveInsideRoot` 不能识别根内链接指向根外。

**整改**：

- 新增 `core/contracts/ids.ts` 作为**唯一**规则来源，schema 的 `pattern` 与运行时校验共享同一份正则源码；
- 规则收紧：只允许小写字母/数字与 `.` `_` `-`（消除大小写别名）、首字符必须字母或数字、
  拒绝尾随点、拒绝 Windows 设备保留名（含 `con.json` 这类主名为保留名的形式）、长度 1–128；
- 稳定项目 ID 与工作区标识改为 **UUID**（`BiosProjectIdSchema` / `UuidSchema`）；
- `core/paths.ts` 的所有 ID 参数改为调用同一份校验（抛 `KnowledgeIdError`）；
- `resolveInsideRoot` 明确其边界为**词法检查**，并在注释中写明它不能证明链接未逃逸。

**证据**：`tests/paths.test.mjs`（保留名、尾随点、大写、分隔符、`..`、超长、同前缀目录）、
`tests/contracts.test.mjs`（schema 与运行时函数对同一组非法 ID 给出一致结论）。

**留给 BM-02A**：真实 IO 前的根/父目录 realpath 与链接策略、新文件尚无 realpath 的情形、
不声称提供操作系统级沙箱。R6 的授权校验已在 Package 侧落地（见下）。

## R4 · 每工作区绑定（P2）

**问题**：`workspacePaths[]` 只存一份 `gitBranch` / `gitHead`，两个 worktree 在不同分支时无法回答
"档案里的 HEAD 属于哪个检出"。

**整改**（`core/contracts/records.ts`、`common.ts`）：

- `bindings` → `workspaces: WorkspaceBinding[]`，每条含
  `workspaceId`(UUID) / `path` / `availability`(`reachable|missing|permission-denied|unknown`) /
  可选 `vcs`(`branch`、`head`、`remoteUrl`) / `capturedAt`；
- 无 Git 目录**省略** `vcs`，状态靠 `availability` 与内容 hash 表达，不写空字符串分支名；
- 目录移动 = 更新 `path`（保持 `workspaceId`）；目录不可达 = 改 `availability`，不删除绑定；
- Task 的 `workspace.workspaceId`、EvidenceRef 的 `workspaceId` 关联到具体工作区；
- 项目身份与工作区快照分离；相同远端不自动合并项目（合并只能显式绑定）。

**版本策略**：结构变更仍保留 `schemaVersion = 1`——写入能力（BM-02）尚未上线，
仓库里不存在需要迁移的 v1 数据；首个可写入版本发布前，v1 不承诺向后兼容。

**证据**：`tests/contracts.test.mjs`（两个 worktree 各自的 branch/HEAD 互不覆盖、无 Git 工作区、
非法 `availability` 与非法 `workspaceId` 被拒）。

## R5 · 可复现依赖、宿主路径解耦、Skills 断言与 CI 门禁（P2）

**问题**：类型解析绑定仓库外的兄弟目录；测试写死本机盘符；Package 未声明开发依赖；
CLI 测试继承个人配置且未断言 Skills；CI 没有覆盖本包。

**整改**：

- `package.json` 增加 `devDependencies.@earendil-works/pi-coding-agent: 0.87.1` 并提交 `package-lock.json`；
- `tsconfig.json` **移除 `paths`**，宿主类型由包内 `node_modules` 解析——不再依赖开发机布局；
- 测试里的宿主定位改为"包内安装位置 → `PI_CODING_AGENT_ROOT`"，缺失时**失败并给出安装指引**（不 skip）；
- RPC 用例改为：临时 cwd + `PI_CODING_AGENT_DIR` 隔离配置 + `--mode rpc` + 下发 `get_commands`，
  断言两个 BIOS Skills 可见**且宿主自带技能未混入**（隔离生效的反证）；
- 子进程封装处理 `error` / `exit` / 超时 / 输出上限（并有超时用例）；
- `biome.jsonc` 的 include 增加 `packages/bios-agent/**`，包内新增 `check:format` / `format`；
- `.github/workflows/ci.yml` 新增两步：`packages/bios-agent` 的 `npm ci` 与
  `npm run typecheck && npm run check:format && npm test`。

**注意（踩坑记录）**：RPC 用例最初整体 60s 超时，原因是封装里漏了 `--mode rpc`，
Pi 因此以默认模式启动、永远不回响应。自动化测试的价值就在这类"看起来像环境问题"的地方。

## R6 · 授权根约束（P2）

**问题**：工具接受任意绝对目录或 `../`，只判断是否为目录；"跳过子链接"不能解释为访问范围控制。

**整改**：

- 新增 `core/projects/authorization.ts`：默认授权根是会话工作目录（`ctx.cwd`）；
  额外根只从适配层注入的 `BIOS_AUTHORIZED_ROOTS` 读取，**模型无法用工具参数扩权**；
- 比较使用 `realpath`，因此根内指向根外的符号链接／junction 被拒绝；
- 先授权、后扫描：拒绝时不返回目标目录内的任何线索样例；
- 结果与 details 里回传命中的授权根与生效根集合，使"在哪个范围内扫描"可复核；
- 同一规则可直接复用到 BM-03 的正文搜索。

**证据**：`tests/authorization.test.mjs`（子目录通过、根外与 `../` 拒绝、额外根可用且非全局放行、
不存在/非目录分别报错、链接逃逸拒绝——Windows 无权限创建链接时明确 skip 并说明原因）、
`tests/extensionLoad.test.mjs`（工具层拒绝且不泄漏范围外线索、环境变量注入的额外根可用）。

## 其余同步项

- `desktop-integration.md`：知识根段落更正为"用户级默认 + 适配层注入"；验收步骤补 `npm install`；
  说明 Skills 断言已自动化。
- `cli/selfcheck.mjs`：新增非法 ID（保留名/尾随点/大写/分隔符）与相对知识根检查。
- `README.md`：补"安装"一节（干净 clone 的可复现步骤）、ID 规则、工具行为边界与授权模型。

## 仍未完成（不属于本轮）

- **BM-02A**：真实 IO 的根/父目录 realpath 与链接策略、`Storage` 接口、registry schema、
  限额读取、损坏 JSON 的保留策略。
- 厂商适配规则（BM-03，需真实样例）、经验检索与审核语义（BM-04）、上下文预算（BM-05）、
  桌面入口（BM-07）、真实试点（BM-08）。
- 本包 `tests/fixtures` 仍为空：暂无可用真实 BIOS 项目，样例数据需自建脱敏。
