# BIOS Agent 第一轮验收与下一步开发

日期：2026-10-01

范围：BM-00 / BM-01；当前 `BIOS_Agent` 工作区中的实现，不是某个已提交版本。

结论：**基线加载通过，Package 骨架有条件通过。先完成 BM-01R 基础整改，再开发 BM-02 存储。**

> 本文是第一轮历史验收。BM-01R 开发后的最新结果及下一轮提示词见 [第二轮验收与下一步任务](round2_acceptance.md)，请勿继续按本报告的旧问题状态重复实施。

## 1. 已经完成什么

- 建立独立的 `packages/bios-agent`，没有 fork Pi，也没有新增 Agent 执行循环。
- Extension 只有一个注册入口，`core` 不依赖 Electron、React 或 Pi Session。
- 五类记录具有 TypeBox schema、推导类型和版本校验；这是结构校验，不是完整业务校验。
- `bios_detect_project` 能返回构建文件线索、计数和资料缺口，不读取文件正文，不虚构厂商、板卡或代际。
- 两个 Skills 有明确的使用流程与能力边界；Pi 0.87.1 实际可以加载它们。
- 这一轮没有改动桌面业务代码，符合先做 Package 的路线。

目前还不是可用的 BIOS 知识系统：没有持久化、经验检索、跨会话任务恢复、上下文注入和桌面入口。这些属于后续阶段，不应作为本轮漏实现，也不能宣称已经支持真实 IBV 平台。

## 2. 本次实际验证

| 检查 | 结果 | 覆盖边界 |
|---|---|---|
| Package `npm run typecheck` | 通过 | 包内 core、extension、selfcheck；测试脚本不在此 tsconfig 的 include 中 |
| Package `npm test` | 20 通过，0 失败，0 跳过 | 契约 9、路径 7、加载/工具 4 |
| Package `npm run selfcheck` | 4 项通过 | 纯契约与路径检查，不代表知识功能已实现 |
| 根 `npm run typecheck` | 通过 | 根工程检查；不能代替 Package 的独立检查 |
| 根 `npm run check:format` | 通过 | 命令只检查 src/tests/scripts/e2e，不覆盖 packages |
| 隔离配置的离线 RPC `get_commands` | 通过 | 两个 BIOS Skills 可见，进程退出码 0，无扩展加载错误 |
| 扫描中途取消诊断 | 未满足 | Abort 定时事件直到同步扫描结束才得到执行 |
| Windows 保留文件名诊断 | 未满足 | 路径函数接受 `CON`、`NUL` 等 ID |

RPC 补验使用临时空目录作为 cwd 与 `PI_CODING_AGENT_DIR`，设置 `PI_OFFLINE=1`，启动 `--mode rpc --no-session --no-context-files --no-approve --no-extensions -e <包目录>`，发送 `get_commands`，得到：

```text
skill:bios-project-onboarding
skill:customer-feature-porting
```

没有发送 prompt，没有调用模型；诊断临时目录已清理。此补验目前是本次验收证据，尚未加入仓库自动化测试。

未执行根全量测试、生产构建、安装包 smoke 或真实 BIOS 项目测试。本轮只新增独立 Package；不能将上述通过项扩大为整应用或真实平台验收通过。

## 3. 必须整改的问题

优先级约定：P1 是继续开放该能力前必须解决的正确性问题；P2 是下一轮应解决的配置、契约或可复现性问题。不是“当前已经造成数据丢失”的结论——存储层尚未实现。

### R1 · P1：扫描并不真正支持中途取消，路径预算也不限制单目录读取

位置：`core/projects/probe.ts:94`、`:123`；`extensions/index.ts:127`，均位于 `packages/bios-agent/`。

`execute` 虽然声明为 async，但里面执行同步扫描，没有让出事件循环。来自同一 Pi 进程的取消事件不能在扫描过程中更新 signal；预先取消和真正中途取消是两种不同测试。

本次诊断先安排定时 Abort，再扫描当前包，扫描完成时 `abortTimerFired=false`，之后定时事件才执行。因而现有 `shouldAbort` 检查不能证明用户点击停止会及时生效。

另一个问题是 `readdirSync` 一次取出整个目录后才检查 `maxPaths`。单目录有大量文件时，即使预算很小，也会先分配全部 Dirent；文件数限制不是实际读取/内存上限。

整改：采用异步、有界的目录迭代，例如 `fs.promises.opendir`，定期让出事件循环并检查取消；控制打开的句柄、待处理目录和 warnings 数量，finally 关闭句柄。可用等价实现，但不能只把同步函数套进 async。

验收：工具开始后再触发取消，能在规定的小批次内退出；单层大目录在低预算下停止迭代并标记不完整；正常、深度超限、路径超限、不可读目录均有测试。取消不返回普通成功结果。

### R2 · P2：知识根默认值偏离方案，相对配置路径会随 cwd 漂移

位置：`core/paths.ts:39`、`:59`。

Windows 默认值写死为 `D:\BIOS_Knowledge`，与 MVP §5.1 的用户级默认目录不一致。代码注释中的“用户明确选择项目盘”没有本轮需求依据。没有 D 盘的机器也不应该需要先修改源码才能运行。

显式 override 和环境变量通过 `resolve(value)` 接受相对路径；桌面与 CLI 的 cwd 不同，同一配置字符串可能指向不同知识库。

整改：桌面由适配层传入 `userData/bios-knowledge`，独立 CLI 使用用户级默认目录；保留显式绝对路径/环境变量优先级。不在 core 引入 Electron。相对配置路径应明确拒绝，或定义唯一且持久的基准，不能隐式依赖启动 cwd。

验收：无配置、不存在 D 盘、显式绝对路径、环境变量、空值/相对路径都有测试；CLI 与桌面传入同一配置时得到同一规范化根。跨平台测试使用对应的 path 实现或真实平台，不能仅切换 platform 字符串却继续使用 Windows 的 path 函数。

### R3 · P1（存储前置）：ID 与路径拼接尚不是完整的文件系统安全边界

位置：`core/paths.ts:70`、`:82`；`core/contracts/records.ts:24`。

当前只检查字符集与词法路径包含关系。本次实测 `CON`、`NUL` 均通过；`projectDir('exp.')` 也会产生尾随点目录名。Windows 保留名、大小写/尾随点别名可能导致写入失败或多个 ID 实际映射到同一目标。schema 与路径规则还是分别写出的正则，尚不是实际单一来源。

`resolveInsideRoot` 不能识别知识根内 junction/符号链接指向根外的情况。此函数可保留为词法检查，但不能在 BM-02 中直接当作 IO 授权证明。

整改分工：BM-01R 统一 ID 规则，稳定项目 ID 使用 UUID，规定其他 ID 的规范化与碰撞规则；BM-02 在真实 IO 前验证根、父目录与链接策略，处理新文件尚无 realpath 的情形。不要声称这提供对恶意本地进程的操作系统级沙箱。

验收：设备保留名、尾随点/空格、大小写碰撞、分隔符、`..`、同前缀目录、根内链接逃逸有用例；拒绝时不创建/修改任何根外文件。Windows 链接测试若受系统权限限制，需要明确 skip 原因，不能静默缺失。

### R4 · P2：多个工作区共用一份 branch/HEAD，不能表达 worktree 快照

位置：`core/contracts/records.ts:28`。

`workspacePaths[]` 允许绑定多个目录，但只保存一份 `gitBranch` 与 `gitHead`。两个 worktree 分别位于不同分支时，无法知道档案中的 HEAD 属于哪个工作区，后续证据过期检查和上下文恢复容易混用。

整改：在第一次持久化之前改成每个工作区独立的绑定条目，至少关联路径、工作区标识、branch、HEAD 与采集时间/可达状态；项目身份与工作区快照分开。Task 和 Evidence 必须能关联具体工作区。相同远端不能自动合并项目。

验收：两个 worktree 的快照互不覆盖，目录移动可重新绑定，无 Git 项目有明确状态；涉及 schema 变化时同步版本策略和全部 fixture。不要在结构尚未定下时大量写入 v1 数据。

### R5 · P2：当前测试依赖本机布局，Skills 的 RPC 断言还未自动化

位置：`tsconfig.json:35`、`tests/extensionLoad.test.mjs:25`、`:57`、`:148`；`package.json:19`。

类型解析绑定仓库外的兄弟 `PiRuntime`，运行测试默认路径则写死为本机 D 盘目录；Package 没有自行声明开发依赖。现有 CLI 测试继承个人 agent 配置并立刻关闭 stdin，没有请求/断言两个 Skills。换机器或进入 CI 时，可能类型检查失败，或 Pi 集成用例跳过而仍显示测试命令成功。

整改：记录并实现支持版本的开发安装流程；将类型解析与宿主运行路径解耦，声明必要开发依赖/锁文件策略，不发布第二份 Pi Runtime。CLI 用临时配置与 cwd，真正发出 `get_commands` 并断言 Skills；处理子进程 error、close、超时与输出上限。CI 显式安装测试宿主，要求关键集成用例不跳过。

根格式命令和现有 CI 尚未为本包提供完整门禁。新增明确的 Package 类型/测试/格式检查并进入 CI，不通过格式化整仓库制造无关改动。

验收：干净 clone 按 README 安装即可检查，不依赖个人 D 盘/兄弟目录/个人扩展；20 个既有用例和新增边界用例通过，必要集成用例零跳过。

### R6 · P2：目标目录没有授权根约束，正式读取正文前要收紧

位置：`extensions/index.ts:44`、`:128`。

工具接受任意绝对目录或 `../` 路径，只判断是否为目录；根目录本身也可通过链接指向其他位置。当前只返回路径线索，尚未读取客户正文，但已不能把“跳过子链接”解释为项目范围访问控制。

整改：默认只扫描当前授权工作区及其子目录；增加其他根应由用户配置/确认，不由模型提供 `targetDir` 自行授权。core 接受显式授权根，适配层负责提供；校验规范路径与真实路径。将同一规则复用到 BM-03 的正文搜索。

验收：授权子目录成功；绝对根外路径、`../`、目标根链接绕过被拒绝；显式登记的第二个根可用。被拒绝结果不返回目标目录内的线索样例。

## 4. 已校正的文档问题

本次同步修正 `desktop-integration.md`：

- 配置包解析器实际在 `src/main/packageResourceResolver.ts`，不是 extensions 子目录。
- 扩展白名单与技能白名单分别控制，不是禁用任意技能就必然触发扩展白名单。
- Pi 0.87.1 对同一规范资源路径有去重；不能断言设置 packages 加 -e 必然加载两次。多副本/多入口仍要测试。
- `extensions/node_modules` 和内置更新器依赖清单是现有内置扩展分发机制，不是所有独立 Package 的强制依赖位置。
- 区分当前硬编码默认知识根与方案要求；区分人工 RPC 实测与已提交自动化。

## 5. 下一轮任务顺序

### 5.1 先做 BM-01R：基础整改

下一位开发 AI 第一轮只做这一项，不同时启动 UI、RAG 或厂商适配。

1. 统一知识根、ID 与每工作区绑定契约，修改 schema fixture 与文档。
2. 修复异步有界扫描、真正中途取消和目标根约束。
3. 补齐缺失边界测试、隔离 RPC Skills 测试、可复现安装与 Package CI/格式门禁。
4. 回归原有 20 用例，更新测试数量、剩余问题与状态；通过后再将 BM-01 改为验收通过。

R3 的真实 IO/链接策略必须在 BM-02 落实，因为现在还没有 storage。其他整改不要用“留到未来”代替已存在工具的安全与可取消行为。

### 5.2 然后做 BM-02：本地存储，不接 UI

建议分成四个可验收的小批次；一个批次完成并复核后再继续。

| 批次 | 内容 | 必须证明 |
|---|---|---|
| BM-02A | Storage 接口、registry schema、初始化、限额读取、版本闸门 | 重启可读；未知版本拒写；损坏 JSON 保留原文件；IO 根约束生效 |
| BM-02B | 预期 revision、跨进程锁、同目录临时文件与原子替换 | 两个真实子进程竞争只有一方按原 revision 成功；冲突不丢数据；锁等待可取消/超时 |
| BM-02C | 审核/审计 journal、恢复协议、迁移框架 | 故障注入后可恢复；记录与审计不出现无法解释的不一致；迁移有备份、幂等与未知版本保护 |
| BM-02D | 最小管理 CLI、自检与备份/恢复说明 | 明确指定知识根，不写 BIOS 源码树；重复初始化不覆盖；备份恢复后 ID/revision/引用一致 |

Storage 建议提供 `initialize / read / list / create / update(expectedRevision)` 与 registry 绑定操作；名称可以调整。列表、正文、文件大小与记录总量必须有限额。锁保护完整读-校验-写流程，不用进程内 Map 假装跨进程锁。

并发与崩溃测试用独立子进程，不只用 Promise.all。Windows 覆盖文件的原子替换行为需要实测；不要先 unlink 旧文件再 rename，造成旧数据消失窗口。尚未实现审核业务时，只验证存储事务协议，不将 schema 结构合法等同于 verified 状态合法。

BM-02 完成时的演示：临时知识根初始化 → 写入脱敏项目档案/任务 → 退出进程 → 新进程读取 → 两进程冲突可见 → 损坏/中断恢复演示。这个阶段仍不承诺模型自动恢复上下文。

### 5.3 BM-02 后再做什么

- BM-03：确认项目档案、通用 EDK II 检测、授权有界搜索和 Evidence 快照；真实 IBV 规则待样例。
- BM-04：经验/Feature、客户范围过滤、人工审核与验证语义。
- BM-05：独立 Task 记忆、上下文预算与模型端点资料授权策略。
- BM-06～09：完整 Pi 工具、桌面集成、真实试点、安装版交付。

后续业务规则包括：多个候选保留、未知模型资料策略默认不注入、verified 必须有人工确认与具体验证、字符与 UTF-8 字节双预算。这些未实现功能按原方案逐步补齐，不算本轮结构校验的虚假测试失败。

## 6. 可以直接交给开发 AI 的提示词

```text
请继续 BIOS Agent MVP，本轮只做 BM-01R，不实现 BM-02 或桌面 UI。

先完整阅读 AGENTS.md、docs/bios-agent/mvp_development_plan.md、
docs/bios-agent/round1_acceptance.md 与 desktop-integration.md。
检查 git status，保留用户和前一轮 AI 的未提交修改。

按验收文档 R1～R6 整改：
1. 移除 D 盘默认知识根，制定稳定绝对路径规则，core 不引入 Electron。
2. 统一安全 ID 校验，修正每工作区 branch/HEAD 契约及版本策略。
3. 改为异步有界目录扫描，支持真实中途取消；授权根校验不得由模型参数绕过。
4. 用自建 fixture 补齐预算、取消、非法 ID、多个 worktree/无 Git 的契约测试。
5. 建立可复现开发依赖与宿主测试流程，隔离配置执行 RPC get_commands，
   断言两个 BIOS Skills 可见；补 Package 格式/类型/测试 CI 门禁。
6. R3 的文件系统 IO 安全检查列入 BM-02A，准确说明本轮纯路径函数的边界。

保持 Pi Package 路线、唯一 extension 入口与独立 core，不修改 Pi 内核。
不修改真实 BIOS 业务源码，不导入客户资料，不新增厂商支持空壳。
用 apply_patch 编辑；未经用户明确授权不提交、推送、创建 PR 或发布。

完成后运行包内 typecheck/test/selfcheck、包内格式检查、根 typecheck 与相关定向测试，
执行 git diff --check；关键 Pi 集成用例不能靠 skip 声称验收通过。
更新 development_log.md、task_breakdown.md 和验收问题状态，
报告新增测试、实测行为和剩余限制。完成 BM-01R 后停止，等待复核再做 BM-02。
```

## 7. 本次验收操作边界

本次只执行检查、测试和文档更新，没有替用户修复业务源码，没有提交或推送。采用分阶段 MVP 验收方式，把已实现缺陷与后续未开发功能分开，避免第一轮直接扩张为完整知识平台。
