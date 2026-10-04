# BIOS Agent 专业开发 MVP 方案

更新：2026-10-04

历史节点：第十一轮独立验收完成（253 用例/251 通过/0 失败/2 权限 skip）；C2A/C2AR 的协议与纯校验通过，A1～A3 关闭。
C2B 的审核持久化主体已落地；第十二轮独立复跑 295 项/293 通过/0 失败/2 权限 skip，但额外诊断 R1～R4 阻塞，**整体未通过**。
C2BR 经第十三轮独立复跑 326 项/324 通过/0 失败/2 权限 skip；R1/R3 与恢复二次中断关闭，**R2/R4 各留一处遗漏，整体未通过**。
C2BR2 经第十四轮独立复跑 343 项/341 通过/0 失败/2 权限 skip，F1 关闭，F2 主要路径通过；
[§6 的 I1](bm02c2br2_development_plan.md#6-当前唯一接续任务i1) 经[第十五轮独立验收](round15_acceptance.md)关闭：348 项/346 通过/0 失败/2 权限 skip，六文件 165 项全绿。审核持久化整改收口。
当前：[第二十九轮独立验收](round29_acceptance.md)：732 项（727 通过、0 失败、5 skip）、targeted 309 项（307 通过、2 skip）、旧存储 249 项（246 通过、3 skip）及指定门禁通过。已有项目业务与经验/Feature 录入、审核、关键词搜索、跨项目参考和人工 CLI；正常流程通过，但 R29 四组阻塞整批通过。真实双确认进程已执行，R28-3 关系范围/授权尚未完整关闭。正式语义历史、任务业务、Session 注入与知识 UI 尚未交付。
已补 [分层记忆与时态一致性设计](layered_memory_temporal_design.md)；只更新后续路线，不重写底座、不打断 C3，也不立即升 schema 或引入向量库。
C1/C1R 的第九轮通过结论保持，后续功能仍是开发要求，不提前做 UI。

代码基线：BIOS Agent 桌面端 v0.9.0，当前开发分支 `BIOS_Agent`。

已核对的本机 Pi 版本：`@earendil-works/pi-coding-agent@0.87.1`。

> 本文是 BIOS 专业能力的第一期开发依据。现有 `product_brief.md`、`mvp_scope.md`、`tech_design.md` 主要记录早期品牌、安装和 DSH 裁剪；保留这些历史记录，本期新增需求以本文为准。实施前仍须完整阅读仓库根目录 `AGENTS.md`，并以实际代码、类型和运行环境核实接口。

## 1. 产品目标

为 ODM／OBM BIOS 开发建立持续可用的项目知识与历史经验，让 Agent 在新对话中快速恢复项目背景，并在新项目中找到以前完成过的定制、修复及其适用限制。

首版验证两个核心价值：

1. 换对话、重启应用后，项目身份、开发入口和未完成任务不丢失。
2. 开发新需求时，可以检索历史项目经验，并根据来源和平台差异决定怎样参考。

采用 Pi Package 路线：Pi 负责模型与执行循环；`bios-agent` 负责 BIOS 工具、Skills 和工程知识；现有桌面端负责配置、审核和展示。

## 2. 首版验收场景

准备一个历史项目 A 和一个目标项目 B，以及 A 中已经完成的客户定制案例，例如 PXE Boot 定制。它们可以使用不同 IBV／芯片平台，但试点信息必须真实提供，不预先假定厂商或代际。

用户在项目 B 新建对话，输入：

> 参考项目 A 中客户 X 的 PXE Boot 定制，分析如何在当前项目实现。先给出移植计划。

Agent 应完成：

1. 读取 B 的已确认项目档案，显示基线、构建目标、板卡和未确认信息。
2. 在被授权的经验来源中查找该定制，返回原始需求、实现位置、提交和验证证据。
3. 区分可以复用的需求／验证方法与需要重新定位的实现。
4. 读取 B 的相关代码，给出候选入口、平台差异、资料缺口和验证计划。
5. 在另一条新对话中恢复该任务的进度、决策和待办。
6. 用户实际完成开发与验证后，能够保存并审核一条新经验。

MVP 不承诺自主完成跨平台移植或证明硬件功能正确。上述场景中的分析必须有来源；资料不足时明确输出缺口。

## 3. 范围与非目标

| 首版必做 | 具体内容 |
|---|---|
| 项目接入 | 绑定当前目录，识别候选身份，允许人工确认／修正 |
| 项目档案 | IBV、芯片平台、基线、构建目标、板卡、客户、关键入口 |
| 有界代码搜索 | 文件／文本搜索，返回相对路径、行号和快照依据 |
| 跨会话记忆 | 项目档案与独立任务记录，受预算限制的上下文注入 |
| 历史经验 | 人工录入、来源提交关联、草稿提取、审核与检索 |
| 适用性分析 | 可解释的平台差异与复用限制，不输出虚假适配结论 |
| 桌面集成 | 项目知识入口、经验搜索／审核、任务状态、上下文来源 |
| 验证 | CLI、RPC、桌面端、重启与多会话场景 |

首版暂缓：

- Fork／修改 Pi 内核、引入 LangChain 或第二套 Agent 执行循环。
- 一次适配全部 AMI、Insyde、百敖及全部芯片平台。
- 完整 C／ASL 语义分析、宏求值、构建依赖图和自动接口映射。
- PDF／原理图／图片批量解析、向量数据库、复杂 RAG、知识图谱、模型微调。
- 自动构建执行与日志诊断工具、烧录、串口、BMC／EC 操作、硬件自动化。
- 自动 cherry-pick／复制历史补丁、自动认定移植成功。
- 云同步、团队权限服务器、商业账号和 UI 全面重做。

现有 Pi 的普通编辑／终端能力继续按现有产品规则运行。MVP 新工具不会增加硬件操作；完整的执行安全约束作为后续任务，不能声称一个 Extension 就提供了操作系统沙箱。

## 4. 架构与目录

```text
PiDeck_BIOS/
├── packages/bios-agent/
│   ├── package.json                 # Pi Package 清单
│   ├── tsconfig.json
│   ├── extensions/index.ts          # 唯一自动加载入口，注册工具和事件
│   ├── core/
│   │   ├── contracts/               # 数据 schema、版本与纯类型
│   │   ├── storage/                 # 文件读写、锁、原子替换、迁移
│   │   ├── projects/                # 项目识别、档案、身份绑定
│   │   ├── search/                  # 授权过滤、检索、排序
│   │   ├── experiences/             # 经验草稿与审核状态
│   │   ├── tasks/                   # 与 Session 无关的任务记录
│   │   └── context/                 # 预算、去重、来源、过期检查
│   ├── cli/                        # 人工初始化／查看／审核入口
│   ├── skills/
│   │   ├── bios-project-onboarding/SKILL.md
│   │   └── customer-feature-porting/SKILL.md
│   └── tests/fixtures/              # 自建、脱敏测试数据
├── src/main/bios/                   # 调用 core 的桌面适配层
├── src/main/ipc/biosIpc.ts
├── src/shared/types/bios.ts         # 桌面契约与必要的 type-only 重导出
└── src/renderer/src/components/bios/ # 视图；副作用与状态分属 hooks／atoms
```

目录为建议落点；开发 AI 可以根据实际仓库做小范围调整，但职责不变。

边界要求：

- `core` 不依赖 Electron、React、Jotai 或 Pi Session，可独立测试。
- Extension 是薄适配层，调用 core，使用 Pi 官方扩展 API，不访问 Pi 内部私有模块。
- 桌面 main 调用同一份 core；renderer 只通过现有 preload／IPC 边界访问。
- 数据 schema 在 Package 内只有一份定义；桌面共享层可以 type-only 重导出／适配，禁止手工复制第二套同名结构。
- Package 内部辅助文件不列入 Pi 自动加载清单，防止重复注册工具。
- Pi 与桌面端的 Agent 通信继续使用现有 stdio RPC，不扩张 GUI Bridge 为知识服务桥。
- 首版无需 HTTP 服务。桌面与 Pi 通过相同文件存储协议访问知识，并发写入必须使用跨进程锁。
- 不向 `App.tsx`、`src/main/index.ts` 堆入识别、检索或存储逻辑。

Package 清单至少声明唯一 Extension 和 Skills 路径：

```json
{
  "name": "bios-agent",
  "version": "0.1.0",
  "private": true,
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions/index.ts"],
    "skills": ["./skills"]
  }
}
```

Pi 宿主提供的依赖按官方要求声明为 peer dependencies，不打包第二份 Pi Runtime。初期以本机 0.87.1 为测试基线，记录支持版本；不能仅凭 peer 的 `*` 声明就声称所有 Pi 版本兼容。

## 5. 知识存储与项目身份

### 5.1 首版存储选择

首版采用可导出的 JSON 记录和 Markdown 说明，不立即引入数据库服务。原因：试点数据量有限，先验证知识结构和复用效果，同时避免桌面端与多个 Pi 子进程各自导出 SQLite 快照造成覆盖。

逻辑上的 Project DB、Experience DB、Feature DB 先映射为记录集合；将来需要 SQLite 时，通过 Storage 接口迁移，保留稳定 ID 和 schemaVersion。

```text
<knowledgeRoot>/
├── registry.json
├── projects/<biosProjectId>/profile.json
├── projects/<biosProjectId>/tasks/<taskId>.json
├── experiences/<experienceId>.json
├── features/<featureId>.json
├── projects/<biosProjectId>/context/<contextId>.json
├── journal/<operationId>.json       # 已有 v1/v2 分族核对，不是业务历史库
├── audit/intents/<operationId>.json
├── audit/<recordId>/<eventId>.json
├── locks/
└── cache/                           # 可删除、可重建，不能是唯一事实来源
```

桌面端默认使用应用 userData 内的 `bios-knowledge/`。CLI 可以配置同一个绝对路径；独立运行时使用用户级知识目录。实际路径通过配置注入，不硬编码某个用户名、盘符或 Pi Session 路径。

首版容量目标：20 个项目、2,000 条经验；达到配置上限时提示，不静默丢弃。索引、列表与正文读取均需有大小上限。

### 5.2 身份规则

- `biosProjectId` 是知识项目的稳定 UUID，不能用 Session ID、agentId、目录名或远端 URL替代。
- registry 维护桌面 `projectId`、规范化路径与 `biosProjectId` 的对应关系。
- 新 clone 默认是独立知识项目，可由用户显式关联到已有项目；相同远端不自动合并。
- worktree 记录自己的路径、分支、HEAD；是否共享项目身份由明确绑定决定，任务和代码依据保留工作区信息。
- 目录移动可重新绑定；目录暂时不可达时标记状态，不删除档案。
- 无 Git 的目录可以接入，用文件 hash 作为依据；Git 提交来源显示为不可用。
- 不自动在 BIOS 源码仓库生成 `AGENTS.md`、客户资料或知识副本；导出由用户选择位置。

### 5.3 写入契约

每条记录含 `schemaVersion`、`revision`、`createdAt`、`updatedAt`。写入使用预期 revision、跨进程锁、同目录临时文件和原子替换；revision 冲突返回结构化错误，不覆盖他人修改。

锁覆盖完整读－校验－写流程，超时应可取消。可以选用 `proper-lockfile` 等轻量库，但 Package 必须声明自己的运行依赖，不借用宿主的未声明依赖。

审核与审计变更需使用可恢复的事务记录／journal，重启能恢复未完成操作。损坏 JSON 不得回落为空并覆盖原文件；保留原数据，报告文件与恢复方式。未知 schemaVersion 只读或拒绝写入，不能猜测格式。

## 6. 最小数据契约

以下是必需字段与语义，开发时补充明确的 TypeScript 类型和运行时校验。

| 记录 | 必需内容 |
|---|---|
| ProjectProfile | ID、绑定路径、候选／确认字段、IBV 与版本、芯片厂商／家族／代际、架构、板卡与版本、客户／产品线、CRB 基线、构建目标、关键入口、资料缺口 |
| TaskRecord | ID、目标项目、工作区／分支、需求、状态、决策、待办、阻塞、相关文件、来源经验、验证记录、revision |
| FeatureRecord | 稳定 ID、原始需求、别名、客户／产品线、验收条件、关联实现经验 |
| ExperienceCard | ID、featureId（可选）、需求／症状、根因、方案、适用与不适用条件、源项目、源码／提交依据、验证、复用范围、审核状态 |
| EvidenceRef | 来源类型、项目／工作区、相对路径、行号或文档位置、commit 或内容 hash、采集时间、有效性状态 |
| ContextManifest | 目标项目、任务 ID、档案 revision、来源记录与 revision、选取原因、过期项、预算／截断信息 |

项目字段分别记录 `value`、`status: unknown | candidate | confirmed`、证据和更新时间。无法识别保持 unknown；冲突候选都保留，不生成假的精确置信度。

ExperienceCard 状态：`draft | reviewed | verified | deprecated`。

- draft：人工／AI 提交的待审核记录；默认不参与自动推荐。
- reviewed：人工确认记录描述与来源；不代表已上板验证。
- verified：人工确认已附具体验证记录；每项验证的范围单独展示。
- deprecated：失效／被替代；可在历史查询中展示，不推荐用于新修改。

验证记录包括类型、范围、结果、日期、执行者和证据引用。必须区分代码检查、编译、上板、循环测试和客户验收。不能因为有 commit 或编译成功就升级为硬件 verified。

复用范围至少支持：当前项目、指定客户、内部通用。跨客户复用需要明确授权；允许在原客户范围内检索，不等于允许把原客户代码带进目标客户任务。

## 7. 核心功能规则

### 7.1 项目检测与轻量搜索

首次检测读取有界文件列表、构建入口、关键配置和少量内容，输出候选与证据。常见 INF／DEC／DSC／FDF／ASL 文件可以作为定位线索；首版不声称完成宏求值或实际构建闭包解析。

至少支持：未知项目、通用 EDK II 风格项目、一个基于真实样例验证的 IBV／芯片组合。试点尚未提供时，先完成通用能力和自建 fixture，不虚构厂商适配规则。

忽略 VCS、依赖、产物和二进制目录，遵循 ignore 配置；遍历可取消，进度可显示，符号链接／路径逃逸需校验。单次检测默认上限：20,000 个路径、200 个内容文件、每文件 256 KiB；命中上限明确标记 incomplete，允许用户指定更小的目标目录重新扫描。上限只是资源预算，不是正确性保证。

源码搜索优先复用现有能力／`rg`，以参数数组调用；缺少 rg 时提供有界实现或明确可恢复错误。结果默认最多 50 个命中，有分页／继续检索机制；不把整库源码送入上下文。

### 7.2 经验检索与跨平台参考

顺序固定：授权范围过滤 → 状态过滤 → 项目／客户／平台条件 → 关键词与人工别名 → 可解释排序。

权限过滤在返回标题、摘要、计数前完成，避免通过“找到一条无权查看的案例”泄露资料。首版不使用 embedding。FeatureRecord 支持 PXE／网络启动等人工别名，不承诺自动理解全部术语。

结果输出源平台、已验证范围、匹配理由、差异、不可复用条件、缺失信息及 EvidenceRef。跨 IBV 案例允许作为参考，但不能标记成可直接移植。通用关键词命中不等于平台兼容。

经验来源提交指向仓库和 commit；当前分支代码另行检查。引用未提交文件必须保存内容 hash；文件移动／hash 改变标记需要复核，不用旧行号冒充当前实现。

### 7.3 跨会话上下文

项目档案、任务、经验保存在知识根，Session 只关联 ID。关闭／删除 Session 不删除工程知识。

启动／切换项目时解析绑定；每轮任务开始时检查 revision 和代码快照，生成 ContextManifest，再选择上下文。Extension 使用已核对的 Pi 生命周期／上下文 API，禁止凭旧博客猜事件签名。

上下文最少包含：确认项目身份、当前工作区与基线、当前任务、相关经验摘要、禁用条件、待确认问题。默认正文预算为 12,000 字符且 UTF-8 不超过 24 KiB，可配置；这是字符／字节限制，不冒充精确 token 计数。

项目档案需记录资料是否允许用于当前模型端点。模型使用策略尚未确认时，不自动注入客户案例正文或商业资料；在项目接入时说明“本地存储不代表推理数据留在本地”。这项规则约束本期知识注入，不冒充对 Pi 所有普通工具的数据外发控制。

采用“最新上下文替换／去重”的机制，不每轮追加同一份记忆。文档、源码、案例正文作为引用数据处理，不能把其中的文字直接升级为系统指令。详情通过工具按需读取。

多任务同时进行时按 taskId 隔离。桌面端无选定任务、CLI 无显式 taskId 时列出待办摘要，不擅自续跑某个任务。

确认项目字段不会因重新检测被自动改写；基线或关键文件变化时保留原结论并标记待复核。存在变化不代表必须重扫整个仓库。

### 7.4 草稿、审核和任务交接

首版支持表单录入经验，并允许模型通过专用工具提交经验草稿。可从当前会话与选定 Git 差异提炼候选，但不静默扫描所有历史对话。

审核／发布／标记 verified 由桌面操作或人工 CLI 命令触发，不注册成模型自动可调用的批准工具。审核界面展示来源、差异和验证证据，记录操作者标签与时间；标签不是企业身份认证。

任务状态建议：`planned | in_progress | blocked | done | archived`。完成任务不等于经验 verified。模型可以提出交接草稿；用户可修正。任务保存做 revision 校验，两个会话写同一任务不能静默互相覆盖。

MVP 的复用控制是应用层的数据访问规则。Pi 普通文件／终端工具仍具有其原有系统权限，不能声称这些规则能防止任意绕过；首版不自动挂载未授权的跨客户源码目录。

### 7.5 分层记忆与时态一致性（业务阶段新增要求）

详细规则、兼容边界和验收矩阵以 [分层记忆设计](layered_memory_temporal_design.md) 为准；这是待实现设计，不是当前底座已具备的能力。

工作/任务/项目/复用/流程五层分别复用 Pi 上下文与 Manifest、TaskRecord、ProjectProfile、Experience/Feature/Evidence、Skills；不建立五套数据库。检索只找候选，权威记录负责有效性；首版仍用关键词/别名。

工程发生/录入/业务生效时间分开，revision 负责同记录因果与冲突。确认状态、有效状态、适用范围和验证快照分开判断；替代/撤回必须有明确目标，不能按 timestamp 最新者胜出。当前读取与历史读取分开，缓存/旧摘要不得让撤回结论复活。

进入 BM-03～05 前完成 M1 纯策略契约及 M2 兼容闸门；历史/时态字段若需正式新 schema，先明确转换与备份恢复再编码。此处不修改当前 schema v1 或审核/journal 协议。UI 仍在 BM-07。

## 8. Pi 工具与 Skills

| 首版工具 | 作用与边界 |
|---|---|
| `bios_detect_project` | 只读检测，返回候选／证据，不直接确认身份 |
| `bios_get_project_context` | 返回当前档案、taskId 对应任务、来源和过期状态 |
| `bios_search_code` | 只在已绑定／获授权源码根内做有界搜索 |
| `bios_search_history` | 对获授权仓库做限定 Git 历史查询，不自动扫描全部提交 |
| `bios_search_experience` | 带权限、状态和平台条件检索经验 |
| `bios_get_experience` | 按 ID 重新校验访问范围，返回详情／来源 |
| `bios_propose_experience` | 创建 draft，不升级审核或验证状态 |
| `bios_save_task_handoff` | 保存指定任务交接，校验 revision，返回冲突 |

每个工具定义输入 schema、输出 details、错误码、取消和结果大小边界。列表／摘要不返回整段补丁；只读取详情时按限额返回。错误通过 Pi 当前工具契约表达，不能返回普通成功对象后只在文本写“失败”。

首版 Skills：

- `bios-project-onboarding`：读取候选、核实构建目标、列缺口、引导人工确认。
- `customer-feature-porting`：检索原始需求、核查授权与证据、比较平台、定位目标入口、提出计划及验证清单。

厂商 Skill 只有在有真实资料／案例时增加。空壳 AMI／AMD Skill 不计为支持。Skill 不存客户秘密、板卡事实或完整平台文档。核心项目事实由 Extension 选择注入，不依赖模型每次自觉加载 Skill。

## 9. 桌面端最小交互

在现有项目操作／抽屉中增加“BIOS 项目知识”入口，不重做整个工作台。

1. 项目档案：候选信息、证据、人工编辑／确认、资料缺口、知识根配置。
2. 经验库：搜索、平台／客户／状态过滤、详情、原始来源、创建与审核。
3. 任务交接：选择 taskId、需求、决策、待办、阻塞、验证状态。
4. 上下文来源：显示当前绑定、档案 revision、使用的经验、预算截断和过期警告。

Agent 不可用／模型网络失败时，档案查看、搜索、人工录入和审核仍可使用。知识损坏／加载失败时给出可恢复提示，不阻止整个应用启动。

UI 使用现有 shadcn 原语、Jotai、i18n 和布局约定。新增 IPC 同步共享通道、handler、preload、API 类型和 preview stub；主进程由 projectId 解析可信根，拒绝渲染层任意声明目录为可信路径。

## 10. Package 加载、开发与发行

- 开发时可以用本地 Package 加载；示意命令 `pi -e <package绝对路径>`。此命令是否同时发现 Skills，应按当前 Pi 实际行为测试。
- 稳定后支持 `pi install <package路径>` 的独立 CLI 使用，说明 global／local scope 与项目 trust。
- 桌面集成需检查实际 `PiProcess`、扩展和技能 resolver：现有禁用／白名单模式不能导致 BIOS Package 消失或重复加载。
- 诊断用 `--no-extensions`／`--no-skills` 保持有效；不能为 BIOS 能力强行绕过用户禁用项。
- 模型能力探测等非开发进程不启动扫描／watcher；资源在 `session_start` 或实际工具调用中启动，shutdown／reload／取消路径清理。
- 正式包内代码与 Skills 放可读取的 resources，运行依赖明确打包；知识写入 userData，不写安装目录／asar。
- 自定义知识根作为单一配置传给 main 和 Pi，不能两边各拼一个默认路径。独立 CLI 使用同一配置时必须读到同一项目。
- 保持普通 Pi 会话可用。BIOS 能力可以关闭；关闭不删除知识。
- 本期不发布公开 npm 包，也不自动 push／创建 PR／发 Release。

## 11. 开发任务与依赖

当前进度（2026-10-04）：历史存储/审核/journal/盘点/离线备份恢复通过范围保持；BM-03/BM-04 正常业务可运行，完整通过待 R29 收尾；M1 已实施，关系剩余项归 R29-4；M2 仅认可 v1，正式格式升级/迁移未批准。当前批次 BM-05，BM-05～09 尚未完成。

最新事实见 [第二十九轮验收](round29_acceptance.md)。当前执行 [R29 有限收尾＋BM-05 完整任务/上下文批次](bm05_development_plan.md)：内部过闸后直接交任务事实/重开、人工交接包/Manifest 重验及经验草稿沉淀，一次交回；不升 schema、不重做历史底座、不提前 UI/RAG/自动学习。

下表定义任务依赖，实际状态见上方进度与 task_breakdown.md。同一模块内可将小修复并入能力批次，内部节点顺序实现、测试，整批统一验收；不同时扩展多个无关模块。

节奏调整：每批以可运行能力交付，小修复内部门禁通过后直接继续同批业务。真实覆盖/泄漏、虚假结论与实际预算失效仍阻塞依赖模块，低风险维护项记录技术债。当前节奏与完成标准见 [BM-03 批次](bm03_development_plan.md)，不为单条修复反复人工转交。

| 编号 | 任务 | 前置 | 主要落点 | 验收标准 |
|---|---|---|---|---|
| BM-00 | 基线与接口验证 | 无 | docs、Pi 本机 docs／types | 记录版本与加载方式；验证 CLI 和 RPC 最小工具；不改 Pi 内核 |
| BM-01 | Package 骨架与数据契约 | BM-00 | packages/bios-agent | 独立加载成功；只有一个注册入口；有类型检查／测试入口 |
| BM-01R | 第一轮基础整改 | BM-01 骨架 | core、tests、开发依赖、CI | 关闭验收 R1～R6 中本轮问题；真实 IO 边界落实到 BM-02A |
| BM-01R2 | 第二轮验收小收尾 | BM-01R 主体 | core、tests、docs | F1～F4 通过；后续 G1 已关闭，见第四轮验收 |
| BM-02AR | 存储基础边界收尾 | BM-02A 主体 | core/storage、contracts、tests、docs | 关闭第四轮 S1～S5，不提前开放更新或模型写工具 |
| BM-02 | 存储、registry、并发与迁移 | BM-01R2 | core/storage、contracts | 两进程竞争无覆盖；冲突可见；崩溃恢复；损坏文件不被清空 |
| BM-02D1 / D1R | 备份协议与纯校验及收尾 | C3/C3R、第二十一轮 B1/B2 | backup 纯校验、测试 | 第二十二轮通过纯校验范围；103 项，B1/B2 关闭，不重做 |
| BM-02D2 / D2R | 离线导出与安全收尾 | D1/D1R | storage/backup、真实 IO 测试 | 第二十五轮已发现整改收口；导出已实现，整批覆盖/恢复验证待 D3 |
| BM-02D3 | 新目录恢复 | D2R 节点门禁通过 | storage/backup、真实往返测试 | 第二十七轮本机离线范围通过，R26-1/2 关闭 |
| BM-02D4 | 最小人工 CLI | D3 内部门禁通过 | cli | 第二十七轮声明范围通过，R26-3 关闭 |
| BM-M0 | 分层记忆与时态设计 | 当前契约 | docs | 五层归属、时间/状态/范围、兼容与分阶段验收明确；本轮文档已补齐 |
| BM-M1 | 记忆决策纯契约 | M0、R26 已通过 | core/memory、纯策略 tests | 已实施，29 项既有回归通过；R27-1/3 保持，R28-3 范围/授权剩余项归 R29-4 |
| BM-M2 | 兼容与持久化闸门 | M1、备份恢复 | 有限格式/协议方案，后续实现 | v1 项目路线可执行；历史字段/沿革/耐久来源指纹与迁移另评审、未实施 |
| BM-03 | 档案与有界项目检测 | BM-02、M1/M2 对应契约 | core/projects、人工 CLI | 正常新进程闭环和 R28 核心项目整改通过；共享关系边界仍待 R29-4 |
| BM-04 | Feature 与经验录入／检索 | BM-03、M1/M2 对应契约 | core/knowledge、人工 CLI | 已实施正常业务，R29 四组待有限收尾；不冒称完整授权/专有别名联动或真实厂商适配 |
| BM-05 | 任务记忆与上下文选择 | BM-03、04 | core/tasks、context、人工 CLI | 当前批次；任务状态/重开/CAS、taskId 隔离、Manifest 来源重验、人工交接及经验草稿；Pi Session 注入另按 BM-06 |
| BM-06 | Pi 工具与两个 Skills | BM-03～05 | extensions、skills、cli | CLI／RPC 都能使用；工具校验／取消／截断；模型不能直接批准经验 |
| BM-07 | 桌面适配与最小 UI | BM-06 | main/bios、IPC、preload、renderer | 人工确认／审核；任务选择；来源展示；模型断网仍可管理知识 |
| BM-08 | 真实试点与回归 | BM-07 | fixtures、测试、试点记录 | 完成第 2 节场景；记录成功／缺口，不能只用合成 fixture 宣称厂商支持 |
| BM-09 | 打包与交付文档 | BM-08 | 打包配置、docs | 安装版加载成功；知识写入正确；可关闭、备份恢复；校验结果齐全 |

BM-00 可以先进行，无需等待试点资料。BM-03 的真实厂商规则与 BM-08 需要用户提供合法使用的样例；缺资料时完成通用逻辑与 fixture，将实际适配标记待验证，不阻塞所有其他模块。

每个任务完成时更新本期开发日志和任务状态，记录改动、测试、已知问题与下一项；既有 BA 编号任务是历史阶段，不改写其含义。

## 12. 测试与最终门禁

### 12.1 必测行为

- 相同远端不同目录不自动合并；路径移动、大小写、worktree、无 Git 都有明确结果。
- 检测结果含证据；资料不足／多平台输出 unknown／冲突，不伪造平台与板卡。
- 目录超限、巨大文件、符号链接逃逸、取消、rg 不存在、目录不可达均可处理。
- knowledgeRoot 中的恶意 ID／路径不能读取任意文件；被拒绝客户案例不泄露标题／计数／详情。
- draft／deprecated 不默认推荐；reviewed 与 verified 的验证范围显示准确。
- branch／HEAD／未提交内容变化后旧证据标记复核，人工确认字段不静默被覆盖。
- 两个 Pi 进程与桌面同时更新同一记录产生冲突，原始内容不丢失。
- 原子替换中断、审计未完成、损坏 JSON、未知 schemaVersion 可诊断／恢复。
- 删除 Session、重启、压缩会话后仍能恢复项目／任务；多个项目和 taskId 不串记忆。
- 上下文保持预算、去重，引用资料中的命令不会成为系统指令。
- CLI、RPC 加载／禁用／reload／shutdown 正常；安装包资源完整，卸载／更新不误删知识。

测试使用自建／脱敏源码，不能把 IBV／客户源码、商业资料、密钥或原始 BIOS 镜像提交到公开仓库。

### 12.2 验证命令

沿用根仓库已有命令：

```powershell
npm run typecheck
node --test tests/<本次涉及的测试>.test.mjs
npm run check:format
```

Package 已提供 `typecheck`／`test`／`selfcheck`／`check:format` 命令，在 `packages/bios-agent` 中运行；第二轮独立复跑 45 个用例通过、0 跳过。CI 已增加 Package 安装和类型/格式/测试步骤，远端执行尚未验证；tsc/Biome 工具链目前来自根工程，需要根依赖安装前提。根检查不代替 Package 门禁。修改格式只处理本次触达文件，避免无关全量格式化。

最终跨域集成与交付时运行：

```powershell
npm test
npm run build
git diff --check
```

此外必须做 CLI 与 RPC smoke、桌面主流程验证、目标 Windows 安装包 smoke 和一次备份恢复。若全量测试出现卡住／并发问题，记录并定位，分段运行也要证明覆盖范围；不能把未结束当作通过。

验收记录分开写：自动化通过、人工通过、真实项目未验证、已知限制。没有真实平台证据时，只报告通用能力通过。

## 13. 第一项任务给开发 AI 的提示词

以下保留第一轮原始任务依据，不再作为下一轮指令。当前执行 [记忆底座加速批次](memory_foundation_development_plan.md)及 §6 提示词；旧 D3 §11.6 和历史整改提示词不重跑。

```text
请根据 docs/bios-agent/mvp_development_plan.md 开始 BIOS 专业能力 MVP 开发。

先完整阅读根 AGENTS.md，检查 git status 和当前代码，保留现有修改。
本轮只执行 BM-00 和 BM-01；如果任务需要更细拆分，先记录拆分后执行。

目标：
1. 核对本机 Pi 版本及 Package、Extension、Skills、RPC 接口。
2. 创建 packages/bios-agent 的最小 Package、唯一扩展入口与纯数据契约。
3. 提供独立类型检查和必要测试；验证 CLI／RPC 能加载最小只读工具。
4. 记录如何在现有桌面白名单与禁用模式下接入，暂不实现完整 UI。
5. 更新本期开发日志、任务状态、验证结果及已知问题。

遵循本文边界，不 fork／修改 Pi 源码，不复制第二套 Agent 循环。
本轮不实现全部知识库、不添加空壳厂商支持、不运行硬件或烧录操作。
工具 API 以本机文档与导出类型为准，资源加载不能只靠猜测。
不要修改 BIOS 业务源码，不把真实客户资料放进源码仓库。
用 apply_patch 编辑；未经用户明确授权不提交、推送、创建 PR 或发布。

完成后报告涉及文件、测试命令和结果、可复现的加载步骤、剩余问题。
```

后续开发 AI 每轮替换任务编号与验收目标，继续使用本文作为范围约束；不要一次实现整份方案。

## 14. 首版完成后再讨论的能力

1. 引入试点 IBV／芯片平台的真实适配器，解析构建条件及配置引用。
2. CRB 与目标板差异管理，关联原理图／设计指南与验证清单。
3. 构建工具、日志解析、有限执行权限与硬件验证流程。
4. 文档解析与检索效果评估，按数据规模引入 SQLite／向量检索。
5. 更多厂商、平台代际、产品线与团队审核协作。

这些能力单独立项，不因目录预留而提前实现。

## 15. 参考与版本依据

- [Pi Package 官方文档](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)
- [Pi Skills 官方文档](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/skills.md)
- [Pi Extensions 官方文档](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
- 本机实际参考：`D:/BIOS_Pi_Agent/PiRuntime/node_modules/@earendil-works/pi-coding-agent/docs/` 与该包导出的类型。

官方 main 文档可能早于／晚于安装版本；实现以支持版本的实际类型及运行测试为准。项目适配规则来自获授权的真实源码／文档，公共 Pi 文档不提供商业 BIOS 平台知识。
