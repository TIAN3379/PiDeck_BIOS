# BIOS Agent 开发日志

## 2026-09-30 · v0.8.0 身份与启动体验

- 将应用外部身份改为 BIOS Agent。
- 保留原架构，通过 Electron Builder NSIS 输出普通 Windows 安装程序。
- 安装器创建桌面和开始菜单快捷方式。
- 更新、反馈和仓库链接切换到 `TIAN3379/PiDeck_BIOS`。
- 移除原作者 AtomGit pre-push 和自动镜像工作流。
- 保留内部 PiDeck 兼容标识与数据目录，降低首轮改造风险。
- 类型检查、格式检查、身份改造定向测试和 Windows 打包版启动冒烟均已通过。
- 已生成 `BIOS-Agent-0.8.0-setup.exe`，代码已推送到 `BIOS_Agent` 分支；真实安装由用户执行以验证桌面快捷方式。

## 2026-09-30 · DSH 后端裁剪

- 删除 DSH host、runtime、插件、凭据、配置、会话归档与沙箱 Node 相关主进程实现。
- 删除 DSH 配置页、运行时控制、模型/技能/子代理/目标工具及 Web 端入口。
- 删除 DSH 打包资源、依赖、发布脚本、工作流、测试和专项文档。
- 将运行时后端类型收敛为 Pi 与独立生图后端；普通 Agent 创建、发送、历史、目标和自动化统一走 Pi。
- 保留 Pi portable Node 安装所需的通用归档解压能力，避免与 DSH runtime 实现耦合。
- `npm run typecheck` 与 `npm run build` 均通过。

## 2026-10-01 · BM-00/BM-01 BIOS Package 基线与骨架

- BM-00：核对本机 Pi 宿主 `@earendil-works/pi-coding-agent@0.87.1`（PATH 上的 `pi` 指向 `D:\BIOS_Pi_Agent\PiRuntime\pi.ps1`，bin 为 `dist/bundle/cli.js`），确认 Package/Extension/Skills 的真实契约：`pi.extensions` / `pi.skills` 清单、peer 白名单（`pi-ai`、`pi-agent-core`、`pi-coding-agent`、`pi-tui`、`typebox`，范围 `"*"` 且不打包）、jiti 直接加载 TS 无需编译、工具用 `defineTool` + `execute(toolCallId, params, signal, onUpdate, ctx)`、`SKILL.md` frontmatter 的 `name`/`description` 规则。
- BM-00：确认加载判据——`-e` 加载失败会在 stderr 报 `Failed to load extension` 且退出码 1，成功时静默；`-t/--tools` 对未注册工具名静默，**不能**作为 CLI 层工具注册判据。工具注册的硬证据改用 Pi 导出的 `discoverAndLoadExtensions()`（离线，不启动会话、不连模型）。
- BM-00：实测 `pi -e <包目录>` 会**同时发现** Package 的 Skills（`skill:bios-project-onboarding` 出现在 RPC `get_commands` 响应中），回答 `mvp_development_plan.md` §10 的开放问题；`-e` 不做来源隔离，宿主已有技能仍会出现。
- BM-01：新建 `packages/bios-agent` 最小 Pi Package：清单（只有 `peerDependencies`，只有 `typecheck`/`test`/`selfcheck`，刻意不提供 `build` 因而不进入 Electron 构建链）、独立 `tsconfig.json`（paths 指向 PiRuntime 的 Pi 声明文件 + `allowImportingTsExtensions` + `checkJs`）、`core/contracts`（五类记录 schema/类型/状态机 + 版本闸门 + 结构化错误码）、`core/paths`（知识根解析与路径逃逸防护）、`core/projects/probe`（有界只读线索探测，不读文件内容）、唯一扩展入口 `extensions/index.ts` 注册 `bios_detect_project`、两个 Skill、包内测试与自检入口。
- BM-01：最小只读工具只返回线索计数、样例相对路径与**资料缺口**，身份字段一律保持 `unknown`——厂商适配规则需要 BM-03 的真实样例验证，本轮不猜。
- 验证：包内 `typecheck` / `test`（20 个用例，含 Pi SDK 装载与 CLI `-e` 加载两条链路）/ `selfcheck` 全绿；根 `npm run typecheck` 通过；`npm run check:format` 通过；`pi -e <包目录>` 实测加载成功且 Skills 可见；工作区未改动 `src/`、`resources/`、根配置。
- 新增 `docs/bios-agent/desktop-integration.md`：记录桌面端扩展／技能加载与禁用开关的真实位置，并列出白名单模式丢包、双加载、热更新覆盖层三个风险点及正式接入要求。
- 已知限制：本轮只有 `bios_detect_project` 一个工具且不判定身份；没有存储层（锁、原子替换、revision 冲突、迁移属 BM-02）；没有检索、上下文预算与任务交接，Skills 中相关能力当前不可用；`tests/fixtures` 尚无样例数据（用户暂无真实 BIOS 项目）。

## 2026-10-01 · BM-01R 基础整改（R1～R6）

- R1：`core/projects/probe.ts` 改为 `fs/promises.opendir` 流式迭代 + 定期让出事件循环，**让出点之后立刻检查取消**；新增待处理目录与 warnings 上限，截断维度写入 `truncatedBy`；取消抛 `ProbeCancelledError`（失败结果，不是普通成功结果）。
- R2：移除 `D:\BIOS_Knowledge` 硬编码默认值，改为用户级 `<用户目录>/BIOS_Knowledge`；**相对知识根一律拒绝**（桌面与 CLI 的 cwd 不同）；桌面端由适配层注入 `userData/bios-knowledge`；测试改用真实平台 path 与真实临时目录。
- R3：新增 `core/contracts/ids.ts` 作为 ID 规则唯一来源（schema 的 `pattern` 与运行时校验共享同一份正则）——只允许小写、拒绝尾随点与 Windows 设备保留名、拒绝路径分隔符；项目 ID 与工作区标识改用 UUID；`resolveInsideRoot` 明确为词法检查，真实 IO 的链接策略留给 BM-02A。
- R4：`bindings` → `workspaces[]`，每个工作区独立保存 `workspaceId` / `path` / `availability` / 可选 `vcs`(branch、head、remoteUrl) / `capturedAt`；Task 与 Evidence 关联到具体工作区；无 Git 目录省略 `vcs`；结构仍为 `schemaVersion = 1`（写入能力未上线，不存在需要迁移的数据）。
- R5：包内声明 `devDependencies`（Pi 宿主 0.87.1）并提交锁文件；`tsconfig` 去掉 `paths`，宿主类型由包内 `node_modules` 解析；测试宿主缺失时**失败而非 skip**；RPC 用例改为临时 cwd + `PI_CODING_AGENT_DIR` 隔离，断言两个 BIOS Skills 可见且宿主技能未混入；`biome.jsonc` 纳入本包并提供包内 `check:format`；CI 新增本包 `npm ci` 与门禁步骤。
- R6：新增 `core/projects/authorization.ts`——默认授权根为会话工作目录，额外根只由适配层经 `BIOS_AUTHORIZED_ROOTS` 注入（模型无法用参数扩权）；realpath 比较拒绝链接逃逸；先授权后扫描，拒绝时不返回任何线索样例。
- 验证：包内 `typecheck` / `test`（**45 通过、0 失败、0 跳过**）/ `selfcheck`（5 项）/ `check:format` 全绿；根 `typecheck` 与 `check:format` 通过；`git diff --check` 通过。
- 踩坑：RPC 集成用例曾整体 60s 超时，根因是测试封装漏了 `--mode rpc`（Pi 以默认模式启动、永不回响应）。
- 整改细节与证据见 `docs/bios-agent/round1_remediation.md`；R3 的真实 IO 层校验与存储事务属 BM-02A。

## 2026-10-01 · BM-01R2 第二轮收尾（F1～F4）

- F1（P1）：消除 ID 校验两条链的裂缝——保留名负向断言改为 `(?!(?:con|…|lpt[1-9])(?:\.|$))`，
  覆盖 `con.json` / `nul.txt` 这类带点后缀形式；运行时改为"先由**同一正则**判定是否接受、再分类错误码"，
  使 schema、`inspectKnowledgeId` 与路径入口对同一组输入给出相同结论（错误码仍可更细）。
- F2：知识根统一要求**完全限定的绝对路径**。Windows 上 `\BIOS_Knowledge` 的 `isAbsolute` 为真却依赖进程盘符，
  现在与 `C:name`、普通相对路径一并拒绝（合法形式：盘符绝对或 UNC）；新增纯函数 `isFullyQualifiedPath(value, platform)`
  支撑跨平台判定；`resolveKnowledgePaths` 的**字符串入口**同样校验，取消"绕过 resolveKnowledgeRoot 拿相对根"的旁路；
  默认 `home` 也遵守同一契约。
- F3：`probeProjectDirectory` 补齐取消检查点——函数入口、`await opendir` 之后、**每个条目**、
  `for await` 正常结束之后与**最终 return 之前**。小目录（条目数少于 `yieldEvery`）与空目录在调用后立即取消
  现在会抛 `ProbeCancelledError`，不再返回"成功但空"的结果。
- F4：额外授权根只接受完全限定绝对路径，非法配置抛 `invalid-authorized-root`（不再按进程 cwd 补全 `.` / `..`）；
  完全限定但不可达的根标记为 `unreachableRoots`（离线，与非法区分）；生效根按 realpath **去重**。
- 第 4 节收口：`resolveInsideRoot` 与 `isWithinAuthorizedRoot` 的逃逸判定改为精确匹配 `..` / `..` + 分隔符，
  根内合法的 `..cache` 目录不再被误判；probe 新增 `droppedWarnings` / `skippedDirectories`，告警触顶也会标记 `truncated`；
  RPC 测试封装补 stderr 上限、改用 `close` 收尾、补 stdin 错误处理，并新增工具层真实 AbortSignal 取消回归；
  README 写清"先装根工程依赖、再装本包依赖"的安装前提，并修正上限语义描述。
- 验证：包内 `typecheck` / `test`（**60 通过、0 失败、0 跳过**）/ `selfcheck`（5 项）/ `check:format` 全绿；
  根 `typecheck`、根 `check:format`、`tests/processGuards.test.mjs` 通过；`git diff --check` 通过。
- 整改细节见 `docs/bios-agent/round2_remediation.md`；存储事务、真实 IO 链接策略与 registry 绑定属 BM-02A。

## 2026-10-01 · G1 修复 + BM-02A 存储基础

- G1：`core/projects/probe.ts` 把"成功 `opendir` 之后"的取消检查移入 `try` 保护范围。修复前取消会绕过 `finally`，句柄只能等 GC 关闭。新增 4 个回归：句柄 open/close 计数（取消、正常完成、预算截断、迭代中取消都要求 `closed === opened`），以及子进程 `--expose-gc` 诊断（3 次取消后显式 GC 不再出现 "Closing directory handle on garbage collection"）。
- BM-02A 契约：新增 `core/contracts/registry.ts`（`RegistrySchema` + 推导类型 + 空库工厂 + 复用同一版本闸门）。registry 只保存项目↔工作区↔桌面 projectId 的绑定关系，**不复制 branch/HEAD**（那是 ProjectProfile 工作区快照的职责）。
- BM-02A 存储：新增 `core/storage/`——结构化错误码与 errno 映射、可注入限额、IO 边界（canonical 知识根、根内链接拒绝、有界读取、非覆盖发布、布局创建、有界列目录）、registry 读取与显式初始化、记录读取与有界列表、绑定解析。
- 初始化发布协议：同目录临时文件 + `link()` 非覆盖发布，文件系统不支持硬链接时回退 `O_EXCL`。重复初始化返回 `existing` 且 registry 原字节不变；真实两个子进程同时首建不产生半文件、不互相覆盖（落后方得到 existing 或可重试的 `init-race`）。
- 边界策略：根内符号链接／junction 一律拒绝（目录段与最终文件），因此"根内链接指向根外"被拒绝且不触碰根外内容；**硬链接不在覆盖范围**（`lstat` 无法区分，已在 README 写明）；不宣称操作系统级沙箱，并记录检查与操作的竞态与信任假设。
- 记录读取：路径只能由受控 kind + ID 派生；文件位置、记录内 `id`、任务的 `projectId`（清单的 `targetProjectId`）必须一致，否则 `record-id-mismatch`；损坏 JSON、未来版本、超大分别返回 `invalid-json` / `unsupported-schema-version` / `too-large`，且**原文件字节不变**。
- 列表：`maxListEntries` / `maxListBytes` / `maxScanEntries` 三档预算与截断维度；单条损坏进入 `problems`，不整体失败也不当成"不存在"。
- 自检：`cli/selfcheck.mjs` 增加存储离线演示（临时库初始化 → 写入自建 fixture → 读取 → 破坏后拒绝且 hash 不变），现 6 项。
- 验证：包内 `typecheck`、`test`（**89 用例：88 通过、0 失败、1 显式 skip**）、`selfcheck`（6 项）、`check:format`（25 文件）；根 `typecheck`、根 `check:format`、`tests/processGuards.test.mjs` 通过；`git diff --check` 通过。
- 未测：文件型符号链接（本机 EPERM，显式 skip 并注明原因）、真实权限失败、告警上限触顶；Linux/macOS、干净 clone 独立工具链、远端 CI、生产构建与安装包均未运行。
- 实施细节与验收矩阵对照见 `docs/bios-agent/bm02a_implementation.md`；写事务、锁与迁移属 BM-02B/C。

## 2026-10-01 · 第一轮独立验收

- 结论：BM-00 本机基线通过，BM-01 骨架有条件通过；不将尚未开发的存储/经验/上下文/桌面功能计为本轮缺陷，也不宣称真实厂商适配已通过。
- 复跑 Package 类型检查、20 个测试（0 失败/0 跳过）、4 项 selfcheck，以及根类型/格式检查，均通过。根格式命令不覆盖 packages，Package 独立格式/CI 门禁仍待补。
- 使用空临时配置与 cwd、离线 RPC get_commands 再次确认两个 BIOS Skills 可见，没有发送 prompt 或调用模型；该断言尚未进入仓库测试。
- 发现需要整改：同步目录扫描不能及时处理中途取消、readdirSync 不受单目录预算限制；默认知识根写死 D 盘；Windows 保留名/真实 IO 链接边界未覆盖；多个 workspace 共用 branch/HEAD；本机依赖布局和 RPC 测试隔离不足；检测目标缺少授权根限制。
- 校正桌面接入文档中的解析器路径、独立白名单、同路径去重、依赖分发与自动化覆盖描述。
- 新增 round1_acceptance.md，给出 R1～R6、BM-01R 提示词和 BM-02A～D 存储验收批次；同步主方案和任务状态。
- 本次只检查/测试/更新文档，不修复源码，不提交或推送；未运行根全量测试、生产构建、安装版或真实 BIOS 项目验证。

## 2026-10-01 · 第二轮独立验收（BM-01R）

- 独立复跑：Package typecheck、45 个测试（0 失败/0 跳过）、check:format（16 文件）、5 项 selfcheck；根 typecheck/check:format（2014 文件）与 processGuards 2 用例，均通过。
- 确认主体整改已落地：流式异步扫描、工作区独立 VCS 快照、包内 Pi 0.87.1 类型/宿主、隔离 RPC Skills、Package CI 步骤与真实路径授权；本机链接逃逸测试实际执行。
- 额外诊断发现：F1 保留主名带后缀被 schema 接受但运行时拒绝；F2 Windows 无盘符知识根随 cwd 盘符漂移且 resolveKnowledgePaths 仍接受相对根；F3 小目录异步等待期间取消后仍返回成功；F4 额外授权根接受按进程 cwd 解析的相对配置。
- 结论修正为 BM-01R 有条件通过，不重做架构；先完成 BM-01R2 小收尾，再进入 BM-02A。已更新主方案/任务状态，并保留第一轮验收与实施方自测为历史依据。
- 新增 round2_acceptance.md：记录实测结果、R1～R6 闭环矩阵、F1～F4 复现与回归标准、BM-02A 的具体范围，以及下一位开发 AI 的可复制提示词。
- 按分阶段开发工作流补充 test_checklist.md，单独记录功能、异常、数据、兼容/回归及未验证范围，避免把既有自动化全绿等同于全部验收通过。
- 未验证根全量测试、生产构建/安装包、真实 BIOS 项目、远端 CI 或完整干净 clone；隔离安装补验被执行策略拒绝，未执行，不记为代码失败。tsc/Biome 目前仍依赖根工具链。
- 本次只读取/测试/诊断并更新文档，没有修复源码，没有提交/推送，没有修改真实 BIOS 业务项目。

## 2026-10-01 · 第三轮独立验收（BM-01R2）

- 独立复跑 Package typecheck、60 测试（0 失败/0 跳过）、check:format（16 文件）、5 项 selfcheck；根 typecheck/check:format（2014 文件）、processGuards 2 用例和 git diff --check 均通过。
- F1～F4 功能闭环：保留名后缀一致拒绝、所有知识根入口要求完全限定路径、小/空目录与工具层取消失败、额外根拒绝相对配置。安装前提、合法 ..cache、计数输出及 RPC 封装也有落实。
- 测试出现目录句柄 GC 关闭警告；独立连续三次在 opendir 等待期间取消，再 GC，得到三次相同警告。新增取消检查在 try/finally 外面，成功打开的句柄未及时关闭，列为 G1（P2）。现有取消断言不能证明资源释放。
- 结论：BM-01R2 功能通过，资源清理待收尾；下一轮只需先小修 G1 并补回归，门禁通过后在同一轮进入 BM-02A，不重做架构或再次铺开大整改。
- 新增 round3_acceptance.md 和 bm02a_development_plan.md，明确 registry、显式初始化、真实 IO 根/链接边界、有界读取、损坏保护和两进程首次初始化验收；普通记录/绑定更新仍留 BM-02B，journal/迁移留 BM-02C。
- 更新主方案、任务表、测试清单、桌面接入状态和历史文档导向；Package/锁文件仍未跟踪，远端 CI/干净 clone/根全量测试/生产安装版/真实 BIOS 平台未验证。
- 本次仅验收和更新文档，没有修复源码、提交或推送，没有修改真实 BIOS 业务项目。

## 2026-10-01 · 第四轮独立验收（G1 + BM-02A）

- 独立复跑 Package typecheck、89 测试（88 通过/0 失败/1 文件链接权限 skip）、格式 25 文件、自检 6 项；根 typecheck、格式 2014 文件、processGuards 2 用例及 git diff --check 均通过。
- G1 确定性资源回归和 GC 诊断通过；registry、初始化、读取、列表主体已经落地，未越界开发桌面 UI 或模型写工具。
- 用合成临时数据与受控 IO 故障注入复现：S1 wx 回退发布空 registry；S2 单条拒绝错项目任务但列表返回摘要；S3 读取增长文件只解析合法前缀、最后 IO 点取消仍成功；S4 非法候选文件名导致整体失败、problems 不计列表预算；S5 矛盾查询/多工作区任取首个及重复项目 ID 未拒绝。
- 结论：BM-01/G1 通过；BM-02A 主体有条件通过，先 BM-02AR 关闭 S1～S5，独立复验后再 BM-02B。不将普通记录更新、journal、迁移等尚未实施功能列成本轮缺陷。
- 新增 round4_acceptance.md 与 bm02a_remediation_plan.md（AR-1～3、9 组回归、提示词和 BM-02B 后续方向）；同步主方案、任务、README、测试清单与历史文档导向。
- 非空数据新进程读取、初始化逃逸、最终文件符号链接/真实 EACCES、跨平台/干净安装/远端 CI/生产安装版/真实 BIOS 平台未充分验证。Package/锁文件仍未跟踪。
- 本次只验收和更新文档；临时诊断脚本/合成数据已清理，没有修改生产源码/永久测试，没有提交或推送，没有修改 PiRuntime 或客户 BIOS 项目。
