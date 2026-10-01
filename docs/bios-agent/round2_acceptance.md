# BIOS Agent 第二轮验收与下一步任务

日期：2026-10-01

> 历史报告：本页 F1～F4 功能已在 BM-01R2 关闭。当前结论见 [第三轮验收](round3_acceptance.md)，下一轮使用 [BM-02A 开发说明](bm02a_development_plan.md)，不再重复本页收尾任务。

范围：BM-01R（第一轮 R1～R6 整改）；基于当前 `BIOS_Agent` 工作区。Package 与锁文件仍是未跟踪文件，本报告不对应已提交或已发布版本。

结论：**主要整改已落地，现有门禁通过；BM-01R 有条件通过，尚未完全闭环。先完成一个小收尾批次 BM-01R2，再进入 BM-02A。**

没有发现需要推倒 Package 架构的问题。本轮没有实施 BM-02 存储、桌面入口或厂商适配，这些不是本轮漏项。

## 1. 实际验收结果

本次由验收方重新运行，不仅引用开发日志。

| 检查 | 本次结果 | 说明 |
|---|---|---|
| Package `npm run typecheck` | 通过 | 解析包内 Pi 0.87.1 的类型，不再依赖兄弟 PiRuntime |
| Package `npm test` | **45 通过、0 失败、0 跳过** | 授权 8、契约 14、加载/RPC 7、路径 9、扫描 7 |
| Package `npm run check:format` | 通过，16 文件 | 没有自动修改文件 |
| Package `npm run selfcheck` | 通过，5 项 | 用户级默认知识根生效 |
| 根 `npm run typecheck` | 通过 | 桌面工程类型检查 |
| 根 `npm run check:format` | 通过，2014 文件 | 此命令仍不代替包内格式检查 |
| `node --test tests/processGuards.test.mjs` | 2 通过 | 现有 CI 守卫顺序未被破坏 |
| `git diff --check` | 通过（已跟踪文件） | 新增文档另做空白检查；未跟踪 Package 不在普通 git diff 范围内 |
| 额外边界诊断 | 发现 F1～F4 | 见第 3 节；既有测试没有覆盖这些输入 |

环境：Windows，Node v24.14.1，npm 11.11.0，Package 内安装的 `@earendil-works/pi-coding-agent@0.87.1`。SDK/CLI/RPC 测试离线运行，没有发送模型 prompt。授权链接逃逸用例在本机实际执行，没有因权限而跳过。

未执行：根全量测试、生产构建、安装包 smoke、真实 BIOS 项目验证、GitHub Actions 远端运行、完整干净 clone 的安装验证。隔离安装补验命令被执行策略拒绝，未运行；不将其记录为 npm 或代码失败。CI 配置已接入，不等于远端 CI 已绿。

## 2. 上一轮 R1～R6 是否闭环

| 上轮问题 | 本轮已经解决 | 本次结论 |
|---|---|---|
| R1 同步扫描/无限单目录物化 | 改为异步 opendir、流式读取、批次让出、句柄清理、队列与 warnings 上限 | 主体通过；小目录取消遗漏见 F3 |
| R2 默认 D 盘/启动 cwd 漂移 | 默认改为用户目录，普通相对 override/env 被拒绝 | 部分通过；Windows 无盘符根路径与 paths 旁路见 F2 |
| R3 ID 安全规则不同源 | 集中 IDs、项目/工作区 UUID、小写、运行时保留名/尾点拒绝 | 部分通过；schema 与运行时仍不等价见 F1；真实 IO 策略按计划留 BM-02A |
| R4 多工作区共用 HEAD | workspaces[] 各自保存 VCS、可达状态和采集时间，Task/Evidence 有工作区关联 | **结构验收通过**；尚未实现实际 registry 绑定行为 |
| R5 宿主路径/RPC/CI | 移除 types paths 与硬编码宿主盘符，锁定开发宿主，隔离 RPC 断言 Skills，缺宿主不 skip，Package 门禁进入 CI | 当前仓库门禁通过；安装说明/测试封装边界见第 4 节 |
| R6 任意 targetDir | 先 realpath 授权后扫描，根外与根内 junction 逃逸拒绝，额外根由适配层提供 | 主体通过；额外根缺少绝对路径校验见 F4 |

schemaVersion 仍为 1 的处理在本阶段可接受：没有上线的持久化数据需要迁移。首次可写入版本发布后不能再用这个理由静默更改数据结构。

## 3. 必须收尾的四个问题

优先级：P1 为持久化前必须保证的数据契约问题；P2 为已实现能力的正确性/配置边界问题。下面的结论有实际调用证据，不是对未来功能的猜测。

### F1 · P1：带后缀的 Windows 保留名在 schema 层仍被接受

位置：`packages/bios-agent/core/contracts/ids.ts:29`、`:74`、`:114`。

正则的负向断言只排除整个字符串等于 `con`、`nul`、`com1` 等情况；运行时函数却取第一个点之前的主名再检查。因此两条校验链依然不一致。

本次使用真实 `typebox/value` 与 IDs 模块调用得到：

| 输入 | Value.Check(KnowledgeIdSchema, id) | inspectKnowledgeId(id) |
|---|---|---|
| exp-1 | true | 接受 |
| con.json | **true** | reserved-name |
| nul.x | **true** | reserved-name |
| com1.foo | **true** | reserved-name |

现有路径测试覆盖了 `con.json`，但 schema 一致性测试只覆盖无后缀保留名，所以 45 个测试全绿没有发现这个裂缝。未来存储若只用契约校验，能接受随后路径层拒绝的记录；换一条导出/导入路径也会得到不同结论。

修复要求：共享规则必须覆盖保留主名的点后缀形式，不仅共享“部分正则”。schema、运行时 ID 检查与路径函数针对同一组输入必须一致；运行时可以提供更细的错误码，但不能有不同的允许集合。

新增验收：至少覆盖全部设备名族的无后缀、单/多点后缀、正常内部点名，并在完整 ExperienceCard/FeatureRecord 的校验入口验证。不要删掉保留名测试或放宽断言。

### F2 · P2：Windows 无盘符根路径仍随 cwd 的盘符漂移，paths 还有相对根旁路

位置：`packages/bios-agent/core/paths.ts:67`、`:123`。

Windows 的 `path.isAbsolute('\\BIOS_Knowledge')` 为 true，但它没有指定盘符。`resolve` 会使用进程当前盘符，仍然违背“相同配置在桌面/CLI 指向同一知识库”的要求。

本次在同一个诊断进程切换 cwd 后，使用完全相同的 override 得到：

```text
cwd = C:\Windows                 → C:\BIOS_Knowledge
cwd = D:\...\packages\bios-agent → D:\BIOS_Knowledge
```

此外，公开入口 `resolveKnowledgePaths('knowledge')` 仍接受相对根并 resolve 到 cwd；传 `{ root: 'knowledge', source: 'override' }` 时，返回的 root 还是相对字符串，registryPath 却已经是绝对路径。调用方可以绕过 resolveKnowledgeRoot，读写根与展示根也可能不一致。

修复要求：知识根统一验证为平台上完全限定的路径。Windows 支持明确盘符绝对路径与合法 UNC；拒绝依赖当前盘符的 `\\name` / `/name`、盘符相对路径等。所有公开路径布局入口复用同一验证/规范化规则，不依赖调用方“先调用对函数”。默认 home 的注入也要遵守明确的绝对路径契约。

新增验收：override、环境变量、paths 的字符串与对象入口都拒绝普通相对路径和 Windows 根相对路径；合法盘符/UNC 不变；规范化返回的 root 与派生路径一致。跨平台用相应实现/平台条件测试，不在 POSIX 上把 Windows 路径当真实目录。

### F3 · P2：取消发生在异步打开目录期间，小扫描仍返回成功

位置：`packages/bios-agent/core/projects/probe.ts:130`、`:142`、`:152`、`:164`、`:197`。

长扫描在 yieldEvery 批次处确实可以中断，这是本轮已解决的主要问题。但取消只在 while 顶部与批次让出后检查；`await opendir`、异步条目读取之后及最终返回前没有完整检查。

本次对现有 `core/contracts` 小目录执行：

```javascript
const controller = new AbortController();
const pending = probeProjectDirectory(smallDir, { signal: controller.signal });
controller.abort();
await pending;
```

实际结果：`signal.aborted=true`，扫描 6 个路径后仍 resolve 成功。取消在函数已开始、首次异步等待期间发生，不是预先取消；由于条目数量不足 200 且没有后续目录，整个函数不会再次检查 signal。

修复要求：补齐异步等待后的取消检查，以及每条/小批次处理和最终结果返回前的检查。保持 finally 关闭目录；取消始终抛 ProbeCancelledError，不把取消包装成成功或普通 warning。

新增验收：空目录/少于 yieldEvery 的目录在调用开始后立即 abort，应拒绝；已有大目录取消仍通过；工具 execute 层用真实 AbortSignal 证明失败会冒泡。不要只依赖 setImmediate 恰好在哪个时刻执行。

### F4 · P2：额外授权根声称必须绝对，但实际接受相对配置

位置：`packages/bios-agent/core/projects/authorization.ts:38`、`:92`。

authorizedRoots 注释规定为绝对路径，实际却直接调用 statSync/realpathSync；`'.'`、`'../..'` 均被当作进程 cwd 的相对路径处理，而不是会话 ctx.cwd。

本次令会话 cwd 为 `C:\Windows`、进程 cwd 为 Package 目录，并传 `authorizedRoots: ['.']`：Package 目录被加入授权根，访问它成功。另一个 `authorizedRoots: ['../..']` 调用将整个桌面仓库纳入了范围。

这是适配层配置输入的校验缺口，不是模型通过 targetDir 直接扩权；不能把它描述为已有客户代码泄漏。但将来多个 Pi/桌面进程 cwd 不同，同一配置会授予不同访问范围。

修复要求：额外根只接受完全限定的绝对路径，使用与 F2 一致的规范化策略；非法配置应明确报配置错误，不能把它 resolve 到进程 cwd。不存在但明确配置的根可以标记离线/忽略，但要与非法路径区分。有效根按 realpath 去重。

新增验收：环境变量及直接 core 参数的相对根被拒绝；在进程 cwd 与会话 cwd 不同的条件下不意外扩大范围；已登记的第二根、普通根外拒绝和 junction 逃逸测试保持通过。

## 4. 非阻塞建议与文档校准

以下不是新增的大阶段，不要求重构整个项目。

1. **把开发依赖前提写完整。** 当前 Package 的 devDependencies 只有 Pi 宿主；tsc、Biome 等工具仍来自根工程，包内 `.bin` 没有这两个命令。当前 CI 先安装根依赖再安装包依赖，能够解释本机门禁通过。README 不能只写进入 Package 执行 npm install 就宣称所有检查独立可用：明确“先安装根工程依赖、再安装 Package”，或者为真正独立开发声明完整工具链。本次没有证明独立复制 Package 后可运行全部检查。
2. **RPC 测试封装仍有小缺口。** stdout 有大小上限，但 stderr 无上限；使用 exit 而非 close 完成输出收集，stdin 没有 error 处理。当前正常和超时用例通过，不表示 spawn/管道失败路径全部可靠。可在收尾中补封装及错误路径测试，不引入第二套 Agent 通信。
3. **目录包含判断要比较父目录段。** `isWithinAuthorizedRoot(root, join(root, '..cache'))` 本次返回 false，但这是合法根内目录，不是 `../` 逃逸。`resolveInsideRoot` 有同样的 startsWith('..') 过度拒绝。收尾时可改为精确识别 `..` 或 `.. + sep`；保留根外和同前缀目录用例。
4. **区分截断与告警上限。** probe 的 warnings 保存上限已存在，但触达该上限没有设置 truncated；README 的“所有上限触达即 truncated”不完全准确。补丢弃计数/覆盖状态或修正文档，不把最多 50 条样例称为实际失败目录总数。
5. **不要扩大结构测试的结论。** worktree 用例验证了两份快照能在同一 schema 中表达，不是实际 Git worktree 检测/绑定/迁移已经实现。EvidenceRef 中 ID、相对路径和跨记录引用的业务校验，以及工作区 ID 唯一性，按 BM-02/03 的真实操作入口继续补齐。
6. **工作区不等于提交。** 当前 Package、锁文件及若干文档尚未跟踪，CI 配置也是本地修改。保留开发方“自测通过”的历史记录，但将“已提交锁文件”“复验完成”等表述区分为本地交付/独立验收/远端验证。

## 5. 下一步：BM-01R2 小收尾，再 BM-02A

### 5.1 本轮收尾的固定范围

- 只修 F1～F4，并补对应回归；第 4 节建议能在同一触达模块小范围解决的可一并收口。
- 不重做 Package，不改 Pi 内核，不加 UI、厂商支持、向量库或构建/烧录工具。
- 新测试补现有 45 用例的遗漏，不删除有效回归；补验后更新实际测试总数和 skip 原因。
- 完成判据：F1 校验链一致；F2/F4 同配置不随 cwd 漂移/扩权；F3 所有已观察到的取消不返回成功；类型、格式、自检、相关根守卫通过。

这是对上一轮要求的边界闭环，不是另开一轮大型功能。通过后即可进入 BM-02A。

### 5.2 BM-02A 开始时该做什么

只做“知识存储底座 + registry + 安全读/初始化”，完整写入事务仍在 BM-02B/C；未经事务协议保护，不开放通用更新/审核入口。

建议接口以纯 core 为主，接受已经统一验证的 knowledgeRoot、资源限额和取消参数；主进程/CLI 将来复用它，不把业务堆进 Extension。

| 子任务 | 要求 | 验收证据 |
|---|---|---|
| Registry 契约 | schemaVersion/revision、稳定 project/workspace ID、规范化路径绑定；同远端不自动合并 | 单项目、多工作区、无 Git、目录移动/不可达的脱敏 fixture |
| 初始化 | 创建自己的目录布局；重复执行不覆盖现存数据；并发初始化不破坏 registry | 独立进程重跑/竞争；现存损坏/未来版本 registry 保留 |
| 有界读与列表 | stat/open/读取均有限额；不先整文件物化再判断大小；分页/条数限制 | 超大 JSON、过量记录、非文件路径、权限/消失情况 |
| 真实 IO 根策略 | 根和父目录链接策略、词法与真实路径校验；新文件没有 realpath 时检查已存在父链 | 根内 junction 指向根外被拒，根外哨兵文件不变；非法 ID 在 IO 前拒绝 |
| 版本/损坏保护 | 缺字段、损坏 JSON、未知版本返回结构化错误，不回落空对象再覆盖 | 保存并比较原文件字节/hash；错误含可定位信息，无凭据 |
| 数据操作边界 | 检查文件 ID 与记录 ID 一致；定义绑定唯一性/引用检查的位置；缓存不是事实来源 | 冒名文件、重复 workspace ID/冲突路径、缓存缺失仍可读 |

BM-02A 的初始化也不能以“还不是完整写入模块”为理由忽略竞争：至少采用不覆盖现存文件的创建协议。完整 update(expectedRevision)、可取消跨进程锁、原子替换进入 BM-02B；审核审计 journal、故障恢复与迁移进入 BM-02C；管理 CLI/备份恢复进入 BM-02D。

不要在 BM-02A 后就声称“工程记忆已完成”：用户价值闭环还需要 BM-03 项目档案、BM-04 经验、BM-05 Task/上下文和后续桌面集成。

## 6. 下一位开发 AI 可直接使用的提示词

```text
请继续 BIOS Agent MVP，本轮只执行 BM-01R2 小收尾，不开发 BM-02 或 UI。

先完整阅读 AGENTS.md、docs/bios-agent/mvp_development_plan.md、
docs/bios-agent/round2_acceptance.md；round1_acceptance/remediation 是历史依据。
查看 git status，保留现有未提交和未跟踪文件，不擅自重建/删除依赖目录。

修复最新验收 F1～F4：
1. Windows 保留名带点后缀时，TypeBox schema、inspect/assert ID、路径入口均拒绝；
   同一组输入验证三条链，增加完整记录校验入口的回归。
2. 知识根要求完全限定绝对路径，Windows 无盘符根路径不能借 cwd 补盘符；
   resolveKnowledgePaths 的字符串/对象入口也必须统一校验、规范化。
3. 异步目录打开/读取之后和结果返回之前补取消检查；小/空目录调用后立即 abort
   必须失败，大目录中途取消仍有效；工具层用真实 AbortSignal 回归。
4. 额外授权根不能接受相对配置，不按进程 cwd 自行补全；合法根 realpath 去重，
   保持第二个授权根/根外拒绝/junction 逃逸测试通过。

只做相关小范围改动。第 4 节的安装说明、目录段判断、RPC 封装/告警描述
可以在触达模块顺手收口，但不要借此实现厂商适配、知识库、UI 或新通信通道。
core 保持独立、Pi Extension 唯一入口，不改 Pi 内核，不写真实 BIOS 源码。

依赖按明确的根工程 + Package 安装前提准备；不要靠个人全局 tsc/biome。
用 apply_patch 编辑。未经用户明确授权不 add/commit/push、建 PR 或发 Release。

运行包内 typecheck/test/check:format/selfcheck、根 typecheck/check:format
和 tests/processGuards.test.mjs，执行 git diff --check，并检查未跟踪新增文件。
记录实际测试总数、失败/跳过、诊断结果与未验证范围，更新任务和日志。
完成后停止，交回复核；下一开发批次才执行文档第 5.2 节的 BM-02A。
```

## 7. 本次改动范围

本次只做源代码阅读、测试、边界诊断和文档更新，没有修复 Package 源码，没有提交、推送或触碰真实 BIOS 项目。按独立产品开发 Skill 的分阶段原则，把已有功能缺陷、已通过门禁和未来未开发能力分开记录。
