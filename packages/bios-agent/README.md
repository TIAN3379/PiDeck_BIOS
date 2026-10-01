# bios-agent

BIOS 专业开发知识的 Pi Package：把项目档案、任务、经验与证据做成**可复核**的记录，
让换对话／重启应用后项目身份与开发上下文不丢失，并能在新需求上复用历史项目的经验。

当前状态：唯一扩展入口 + 纯数据契约 + 知识根解析 + 只读线索工具 + 两个 Skill，
以及 **BM-02A 存储底座**（显式初始化 + 有界读取）。
经验检索、上下文注入、桌面 UI 尚未实现。

## 边界

- Pi 负责模型与执行循环；本包只提供工具、Skills、工程知识结构与存储底座。
- `core/` 是纯数据层：不依赖 Electron／React／Jotai／Pi Session，可独立测试，
  桌面端主进程复用同一份代码，renderer 只经既有 preload／IPC 边界访问。
- 只声明 `peerDependencies`（Pi 宿主提供的 5 个包），不打包第二份 Pi Runtime。
- 不虚构厂商适配规则：没有在真实样例上验证过之前，不判定 IBV／芯片厂商／板卡。

## 安装与依赖前提

`core/` 与 `extensions/` 用 TypeScript 直接交付（Pi 用 jiti 加载、Node 用原生 type stripping 跑测试），
**不需要构建**。依赖分两层，缺一层就跑不完门禁：

| 层 | 提供什么 | 安装方式 |
|---|---|---|
| 根工程 | `tsc`、`biome` 等工具链（`npm run typecheck` / `check:format` 都由它提供） | 在仓库根执行 `npm install`（CI 用 `npm ci`） |
| 本 Package | Pi 宿主 `@earendil-works/pi-coding-agent@0.87.1`（类型检查与集成测试用） | 在 `packages/bios-agent` 执行 `npm install` |

即：**先装根工程依赖，再装本包依赖**，包内 `typecheck` / `test` / `check:format` / `selfcheck` 才都可用。
本包不重复声明 tsc 与 biome，避免同一工具出现两套版本。

宿主只在开发/CI 使用；运行期由 Pi 宿主提供（peerDependencies）。
`packages/bios-agent/node_modules` 不进版本库，`package-lock.json` **进版本库**。

没有网络或想复用已有宿主时，可用 `PI_CODING_AGENT_ROOT` 指向
`@earendil-works/pi-coding-agent` 包目录——但集成用例不会因此跳过（缺宿主即失败）。

## 命令

```bash
npm run typecheck     # tsc --noEmit（含 core / extension / selfcheck）
npm test              # node --test（契约、路径、扫描、授权、加载链路、存储）
npm run selfcheck     # 契约 / ID / 知识根 / 存储离线演示（不启动 Pi、不连模型）
npm run check:format  # biome 格式门禁（CI 会跑）
npm run format        # 格式化本包
```

## 目录

```text
bios-agent/
├── package.json                 # Pi Package 清单（pi.extensions / pi.skills）+ devDependency
├── tsconfig.json                # 独立类型检查配置（宿主类型来自包内 node_modules）
├── extensions/index.ts          # 唯一自动加载入口，注册 bios_detect_project
├── core/
│   ├── contracts/               # 记录与 registry 的 schema、ID 规则、版本闸门、运行时校验
│   ├── paths.ts                 # 知识根解析与完全限定路径校验
│   ├── projects/                # 授权根校验、异步有界线索探测
│   └── storage/                 # BM-02A：IO 边界、registry、记录读取与列表
├── cli/selfcheck.mjs            # 自检入口（含存储离线演示）
├── skills/                      # bios-project-onboarding / customer-feature-porting
└── tests/                       # 契约、路径、扫描、授权、加载链路、存储
```

## 加载方式

开发期单次加载（不改动 Pi 设置）：

```bash
pi -e <本目录绝对路径>
```

目录形式的 `-e` 会同时发现 Package 清单里的扩展与 Skills（Pi 0.87.1 实测）。

稳定接入 Pi（写入 Pi 的设置，按作用域选择 personal 或项目级）：

```bash
pi install ./packages/bios-agent
```

注意：同一份包既有 `packages` 设置又被 `-e` 注入时可能产生重复来源；
正式接入方式与风险见 `docs/bios-agent/desktop-integration.md`。

## 知识根

优先级：**显式注入**（桌面设置／CLI 参数） > 环境变量 `BIOS_KNOWLEDGE_ROOT` > 用户级默认。

- 默认值：`<用户目录>/BIOS_Knowledge`，不含任何盘符假设；
- **必须是完全限定的绝对路径**：Windows 上 `\BIOS_Knowledge` 虽然 `isAbsolute` 为真，
  却依赖进程当前盘符（同一配置在不同进程会指向不同知识库），因此与 `C:name`、
  普通相对路径一样被拒绝；合法形式是 `C:\...` 或 `\\server\share\...`；
- 桌面端应显式传入 `<userData>/bios-knowledge`（core 不依赖 Electron，路径由适配层给）；
- `resolveKnowledgeRoot` 与 `resolveKnowledgePaths` 的字符串／对象入口共用同一校验，
  不存在"绕过入口拿到相对根"的旁路。

## 存储层（BM-02A）

独立验收状态：主体有条件通过，初始化发布回退、列表归属校验、增长/中途取消、异常输出预算与绑定歧义仍待收尾。
详见仓库 `docs/bios-agent/round4_acceptance.md` 与 `bm02a_remediation_plan.md`；下述接口已实现，不代表所有异常边界已通过。

本轮加入的存储只做两件事：**显式初始化**与**有界读取**。
普通记录的 create/update、可取消跨进程锁与原子替换（BM-02B）、journal 与迁移（BM-02C）、
管理 CLI 与备份恢复（BM-02D）尚未实现——因此现在**不给模型开放任何写知识的工具**。

### 接口

| 接口 | 本轮行为 |
|---|---|
| `initializeKnowledgeStore({ root, limits?, signal?, now? })` | 创建目录布局与合法空 registry；已存在则校验后返回 `existing`，**不覆盖、不重置 revision/时间** |
| `readRegistry({ root, ... })` | 有界读取 + 版本闸门 + 结构校验 + 绑定一致性校验 |
| `readRecord({ root, kind, id, projectId? })` | 按受控 kind+ID 定位并限额读取；校验记录 ID、任务所属项目一致 |
| `listRecords({ root, kind, projectId? })` | 有界扫描 + 摘要（不返回正文）；单条问题进 `problems` 而不是整体失败 |
| `resolveProjectBinding(registry, query)` | 按路径／知识项目 ID／桌面 projectId 解析绑定；缺失与冲突分别返回 |

### 记录落点

| kind | 根内路径 |
|---|---|
| `project-profile` | `projects/<projectId>/profile.json` |
| `task-record` | `projects/<projectId>/tasks/<taskId>.json` |
| `context-manifest` | `projects/<projectId>/context/<manifestId>.json` |
| `experience-card` | `experiences/<id>.json` |
| `feature-record` | `features/<id>.json` |

`context-manifest` 的落点是本轮新增的（主线文档 §5.1 只列到 `projects/<id>/` 子树），
与 `registry.json`、`audit/`、`cache/` 的既有约定一致。

### 限额（默认值，可注入更小预算）

| 项 | 默认 | 说明 |
|---|---|---|
| `maxRecordBytes` | 256 KiB | 单条记录 |
| `maxRegistryBytes` | 1 MiB | registry |
| `maxListEntries` | 200 | 单次列表返回条数 |
| `maxListBytes` | 256 KiB | 列表摘要累计字节 |
| `maxScanEntries` | 5000 | 单次列表扫描的目录条目数 |

限额**先于内容生效**：先看文件大小，再按上限读取（上限 +1 字节用于检出"读取期间增长"），
不做"先整文件物化再判断大小"。

### 链接政策与信任假设

- 知识根自身允许经 `realpath` 解析（库可能配在链接路径下），解析结果记为 canonical root；
- **根内任何符号链接／junction 一律拒绝**（目录段与最终文件都拒绝），
  因此"根内链接指向根外"会被拒绝，且拒绝时不读取、不写入根外内容；
- **硬链接不在覆盖范围**：`lstat` 无法区分硬链接，它在本策略下表现为"根内的常规文件"；
- 检查反映的是**本进程在操作时刻**看到的路径状态，不提供操作系统级沙箱，
  也不阻止同机其他进程在检查与操作之间替换路径；
- 在 BM-02B 引入跨进程锁之前，生产写入面保持为"只创建初始文件"。

### 初始化发布协议

写同目录临时文件 → `link()` 到目标（目标已存在即 `EEXIST`，天然不覆盖）→ 删除临时文件；
文件系统不支持硬链接时回退 `O_EXCL`（`flag: "wx"`）直接创建。因此：

- 重复初始化不会重写 registry（原字节不变）；
- 两个进程同时首建不会互相覆盖：落后一方读到对方发布的内容，或拿到可重试的 `init-race`；
- 绝不使用"先 `exists` 判断、再 `writeFile`"这种会被并发插空的写法。

验收补充：O_EXCL 仅防覆盖，不保证完整发布；当前直接创建最终目标的回退可能暴露空/半 registry，须在 BM-02AR 修复，不能据此宣称所有文件系统下初始化均安全。

### 错误码

`not-found`、`invalid-root`、`path-escape`、`symlink-rejected`、`not-a-file`、`permission-denied`、
`invalid-json`、`invalid-record`、`unsupported-schema-version`、`record-id-mismatch`、
`too-large`、`cancelled`、`init-race`、`binding-conflict`。

损坏与未知版本一律**拒绝**并保留原文件字节：既不会"修复"成空库，也不会回落成默认值。

## 工具行为边界

`bios_detect_project`：

- **只扫描已授权范围**：默认是会话工作目录；额外根只能由适配层通过
  `BIOS_AUTHORIZED_ROOTS`（`path.delimiter` 分隔）注入，**且必须是完全限定的绝对路径**——
  `.`、`..` 这类相对配置会被拒绝，不会按进程 cwd 补全；模型不能用参数给自己扩权。
  校验使用真实路径，因此根内指向根外的链接会被拒绝。
- **有界且可取消**：路径／深度／待处理目录预算触达即 `truncated: true`（`truncatedBy` 给出维度）；
  告警另有上限（`MAX_PROBE_WARNINGS`），触顶时计入 `droppedWarnings` 并同样标记 `truncated`。
  目录用 `opendir` 流式迭代，**每个条目与每个异步等待点之后都检查取消**；
  取消以失败结果结束，不会返回"成功但空/截断"；句柄在所有抛错路径上都由 `finally` 关闭。
- **不读文件内容**，只统计 `.inf` / `.dec` / `.dsc` / `.fdf` / `.asl` 线索；
  身份结论固定为 `unknown`，并显式列出资料缺口。

## ID 与路径规则

记录 ID 的规则只有一份（`core/contracts/ids.ts`），schema 的 `pattern` 与运行时校验共享同一份正则，
因此两者的**允许集合完全一致**：

- 只允许小写字母、数字与 `.` `_` `-`，首字符必须是字母或数字（限制小写可消除
  大小写不敏感文件系统上的别名碰撞）；长度 1–128；
- 拒绝 Windows 设备保留名——**包括带点后缀的形式**（`con.json`、`nul.txt`），
  保留名不区分大小写且扩展名不能解除保留；
- 拒绝以 `.` 结尾的名字与路径分隔符；
- 稳定项目 ID 与工作区标识使用 UUID，不能用目录名、Session ID 或远端 URL 代替。

项目档案与工作区快照分离：`ProjectProfile.workspaces[]` 每个工作区各自保存
`workspaceId` / `path` / `availability` / 可选 `vcs`(branch、head、remoteUrl) / `capturedAt`；
registry 只保存绑定关系，不复制一份 branch/HEAD。

注意：这些是**名称与词法**层面的保护，不是操作系统级沙箱。

## 已验证基线

- Pi 宿主 `@earendil-works/pi-coding-agent@0.87.1`（由本包 devDependency 固定，锁文件进版本库）。
- `typebox@1.3.27`（与 Pi 宿主依赖同版本）。
- 契约版本 `BIOS_CONTRACTS_SCHEMA_VERSION = 1`；BM-01R / BM-01R2 / BM-02A 在写入能力上线前调整过 v1 结构，
  首个可写入版本发布前 v1 不承诺向后兼容。
- 包内门禁：`typecheck`、**89 个测试（88 通过、0 失败、1 显式 skip）**、`selfcheck` 6 项、格式检查（25 文件）。

`peerDependencies` 里的 `"*"` 只表示"由宿主提供、不要打包"，**不表示**兼容所有 Pi 版本。

## 已知限制

- 只有 `bios_detect_project` 一个工具；**没有任何写知识的工具**（写协议在 BM-02B）。
- 存储只有初始化与读取：没有更新、锁、原子替换、journal、迁移与备份恢复。
- 没有检索、上下文预算与任务交接；Skills 中提到的这些能力当前不可用。
- 真实 Git worktree 的检测/绑定/迁移尚未实现，只有契约层的结构测试。
- `tests/fixtures` 尚无样例数据（试点的真实项目资料不可用，样例需自建脱敏）。
- 未验证范围：Linux/macOS、完整干净 clone 的独立工具链、远端 CI、生产构建与安装包；
  文件型符号链接用例在本机因权限被显式 skip（目录 junction 用例未跳过）。
