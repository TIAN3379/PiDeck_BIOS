# bios-agent

BIOS 专业开发知识的 Pi Package：把项目档案、任务、经验与证据做成**可复核**的记录，
让换对话／重启应用后项目身份与开发上下文不丢失，并能在新需求上复用历史项目的经验。

当前状态：唯一扩展入口 + 纯数据契约 + 知识根解析 + 只读线索工具 + 两个 Skill，
以及 **BM-02A/02B/02BR 存储底座**（初始化、读取、普通记录/registry 单文件写入、协作式跨进程锁）、
**BM-02C1 单文件 journal**（写入意图记录 + 只读巡检 + 持锁核对）、
**BM-02C2A 审核审计契约**（纯契约与一致性协议）与
**BM-02C2B 一次经验卡审核的真实持久化**（意图/事件工件 + 审核专用 journal v2 + 领域入口 + 只读巡检与显式收口），
以及 **BM-02D 知识库备份恢复与人工入口**（D1/D1R 清单纯校验、D2R 离线导出、**D3 恢复到不存在的新目录**、**D4 `npm run knowledge` 薄 CLI**；仅 offline-copy），
外加 **BM-M1 记忆决策模块**（`core/memory/`：授权/范围/当前准入/时态/关系/冲突/验证/预算的纯策略 + v1 兼容投影，无 IO/无时钟/无模型；M2 只交字段差距与持久化设计），
以及 **BM-03 项目事实模块**（`core/projects/`：显式绑定与只读打开、有限检测候选与资料缺口、人工确认 CAS、每工作区 Git 快照与证据复验、M1 消费视图）与**薄人工入口** `npm run project` / 合成端到端演示 `npm run scenario:project`，
以及 **BM-04 需求与经验业务模块**（`core/knowledge/`：需求录入/更新/详情、经验草稿与人工审核、有界关键词/别名检索、跨项目参考详情）与**薄业务入口** `npm run business` / 跨项目演示 `npm run scenario:experience`。
BM-02BR 经第七轮通过；C1/C1R 经第九轮独立复验在声明的本机范围通过，J1～J4 关闭；
C2A/C2AR 经第十一轮在协议与纯校验范围独立通过（A1～A3 关闭）。
C2B 经第十二轮独立复跑 **295 测试（293 通过、0 失败、2 符号链接权限 skip）**，
其中审核持久化 42 项与指定包内/根门禁通过；但独立诊断 R1～R4 阻塞，**整体未通过**。
C2BR 经第十三轮独立复跑 **326 测试：324 通过、0 失败、2 权限 skip**，审核/journal 六文件 **143 项**通过；
R1/R3 与真实 recovery 二次中断关闭，原 R2/R4 的 F1/F2 曾阻塞。
C2BR2 第十四轮独立复跑 **343 测试：341 通过、0 失败、2 权限 skip**，六文件 **160 项**通过；**F1 关闭，F2 主要失败路径通过，只剩 I1**。
I1 经第十五轮独立复验关闭：**348 测试：346 通过、0 失败、2 权限 skip**，
审核持久化 **95 项**、六文件 **165 项**通过；审核持久化整改收口。
BM-02C3 经第十六轮独立复跑 **383 测试：381 通过、0 失败、2 显式 skip**、七文件 200 项和指定门禁；但补充诊断 **PF-1～PF-4 阻塞，整体暂未通过**（该结论保持不变）。
其 C3R 经第十七轮独立复跑 **400 项：397 通过、0 失败、3 skip**，七文件 217 项（216 通过、1 skip）与门禁通过；**PF-1～PF-3 关闭，PF-4 剩 S1，整体暂未通过**（该结论保持不变）。
[第十九轮独立复验](../../docs/bios-agent/round19_acceptance.md) 确认 **S2 原漏计关闭**：experiences 四条后 `next()` EIO 的原 20/16 转为 16/16；实跑 **414 项：411 通过、0 失败、3 skip**、七文件 231 项及指定门禁通过。PF-1～PF-3、S1 已通过行为保持。
**S3经[第二十轮独立验收](../../docs/bios-agent/round20_acceptance.md)通过，C3/C3R在声明的本机只读盘点范围收口**：额度15/0/1为16/16、1/1、2/2，受控错误仍可见、之后无新扫描IO；423项/420通过/0失败/3skip、七文件240项、五文件194项与指定门禁通过。
**[BM-02D1 第二十一轮独立验收](../../docs/bios-agent/round21_acceptance.md)整体暂未通过**：协议主体及 93 项永久测试已落地，Package **516 项：513 通过、0 失败、3 skip**与指定门禁通过，但 B1/B2 曾阻塞。
**[第二十五轮独立验收](../../docs/bios-agent/round25_acceptance.md)：R24-1/2 通过，已发现 D2R 整改收口**：独立 backup **160 项**全绿、旧读取 **100 项（98 通过、2 skip）**、Package **583 项（580 通过、0 失败、3 skip）**及指定门禁通过；清理不可核对、未知子树修复经独立 EIO/ENOENT/实际 opendir 对照通过。
**[第二十六轮独立验收](../../docs/bios-agent/round26_acceptance.md)**：D3 恢复 API 与 D4 inspect/export/restore 薄 CLI 已实现，正常 API/CLI 15 文件原字节往返及五类新进程 reader 成立；独立 641 项（638 通过、0 失败、3 skip）、backup＋CLI 218 项、旧存储 249 项及指定门禁通过。当时 R26-1～3（清单变化、目标晚期字节漂移、CLI JSON 解析错误）尚未关闭，整批未通过。
**[第二十七轮独立验收](../../docs/bios-agent/round27_acceptance.md)**：680 项（676 通过、0 失败、4 文件型链接权限 skip），backup＋CLI＋memory 257 项（256 通过、1 skip）、旧存储 249 项及指定门禁通过。R26-1～3 关闭，D3/D4 在本机离线范围通过；M1 已实施，当时当前准入/revision/授权隔离、关系来源/确定性、输入/字节预算三组缺口待修。
**[第二十八轮独立验收](../../docs/bios-agent/round28_acceptance.md)**：Package 711 项（707 通过、0 失败、4 skip）、targeted 288 项（287 通过、1 skip）、旧存储 249 项（246 通过、3 skip）及指定门禁通过；BM-03 正常新进程闭环通过，但 R28 四组当时待收尾，整批未通过。
**[第二十九轮独立验收](../../docs/bios-agent/round29_acceptance.md)**：732 项（727 通过、0 失败、5 skip）、targeted 309 项（307 通过、2 skip）、旧存储 249 项（246 通过、3 skip）及指定门禁通过；BM-04 正常业务已交付，R29 四组阻塞整批通过，R28-3 尚未完整关闭。真实双确认子进程已执行，项目 symlink 权限分支显式 skip。当前 [R29＋BM-05 完整任务/人工交接批次](../../docs/bios-agent/bm05_development_plan.md)，不升 schema、不提前 UI/Pi Session 注入。
叶子 symlink 用例在本机 `EPERM` 时已由"空通过"改为**显式 skip**（junction 创建失败分支同口径），不由通过计数推导已验证；三个 skip 全部是本机文件型链接权限所限，junction 本机可用、相关用例实际执行。见
[第十七轮验收](../../docs/bios-agent/round17_acceptance.md)、[C3 原完成标准](../../docs/bios-agent/bm02c3_development_plan.md) 与
[C3 实施记录](../../docs/bios-agent/bm02c3_implementation.md)（§1～§14保留历史与实施快照，**§15是第二十轮独立收口结论**；[C2B 实施记录 §12](../../docs/bios-agent/bm02c2b_implementation.md) 保留审核侧结论）。
仍不视为生产知识系统就绪：C1 只做"记录意图 + 核对结果"，**不重放数据、不回滚、不自动回收遗留锁**（也没有按 PID/年龄抢锁或 `force`）；
C2A/C2AR 是纯契约；C2B/C2BR 已有审核写入口、审计工件和恢复器，**没有身份认证、没有模型审核工具**。
通用多文件事务/迁移、任务领域、上下文注入、桌面知识 UI 未实现。项目与需求/经验业务、人工审核、关键词检索与人工 CLI 已交付正常流程，整批待 R29 四组。离线导出/新根恢复/人工管理 CLI 的第二十七轮通过范围保持。无向量库、正式语义历史或 schema 升级；不迁移 BIOS 源码、不承诺在线/网络盘/断电恢复。
检测能力只有三条真实规则（EDK II DSC 平台名 / DSC include / DEC 包名）；板名、IBV、芯片厂商与代际**没有**合法规则，保持 `unknown` 并列入资料缺口。BM-03 的读取视图不是跨 registry/profile/源码/Git 的原子快照。
[分层记忆与时态一致性设计](../../docs/bios-agent/layered_memory_temporal_design.md) 已补齐：复用现有记录，BM-03～05 前先做纯契约/兼容闸门；当前不升 schema、不引入向量库，也不把记忆功能塞进 C3。

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
npm run knowledge     # BM-02D4 备份/恢复人工入口（inspect / export / restore）
npm run project       # BM-03 项目事实人工入口（open / bind / detect / confirm / refresh / read）
npm run scenario:project  # BM-03 合成端到端演示（每步真子进程；只写临时目录）
npm run business      # BM-04 需求/经验/审核/检索人工入口
npm run scenario:experience  # BM-04 跨项目经验参考演示（每步真子进程；只写临时目录）
```

## 目录

```text
bios-agent/
├── package.json                 # Pi Package 清单（pi.extensions / pi.skills）+ devDependency
├── tsconfig.json                # 独立类型检查配置（宿主类型来自包内 node_modules）
├── extensions/index.ts          # 唯一自动加载入口，注册 bios_detect_project
├── core/
│   ├── contracts/               # 记录/registry 的 schema、ID 规则、版本闸门、运行时校验，
│   │                            # 审核审计契约（BM-02C2A/C2AR：audit / auditValidation / auditIntent / auditAssociation，独立 auditVersion）
│   ├── paths.ts                 # 知识根解析与完全限定路径校验
│   ├── projects/                # 授权根校验、异步有界线索探测（probe/authorization）
│   │                            # BM-03：contract/fields 契约与字段命名、binding 绑定与打开、
│   │                            #   detection 有限检测、confirm 人工确认 CAS、
│   │                            #   workspace 每工作区 Git 快照与证据复验、view M1 消费视图
│   ├── memory/                  # BM-M1：契约/投影/纯策略/决策管道（无 IO、无时钟、无模型）
│   └── storage/                 # IO 边界、registry/记录读写列表、三类写入入口、跨进程锁、
│       │                        # 提交原语（commit.ts）、安全 revision（revision.ts）、路径判定（pathBoundary.ts）
│       ├── directoryListing.ts  # BM-02C3R-S2：有界目录列举的输入/输出契约（含 observe 观察计量）
│       └── preflight/           # BM-02C3/C3R/S1/S2/S3：只读版本盘点与迁移预检
│                                #   （limits/contract/scan/verdicts/categories/inspect
│                                #    + auxiliaryCategories 辅助落点 / pathProbe 候选路径探测）
│       ├── journal/             # BM-02C1：契约 contract / 写入 writer / 接线 wiring / 巡检 inspect / 核对 reconcile
│       ├── review/              # BM-02C2B：契约 contract / 工件 artifacts / 提交步骤 commitSteps / 策略 decisions
│       │                        #           入口 writer / 巡检 inspect / 收口 reconcile
│       ├── readBytes.ts         # BM-02D2：原始字节的有界读取（Boundary 的 readRawBytes 走这里）
│       └── backup/              # BM-02D1/D1R/D2：离线备份协议、纯校验与离线导出——
│                                #   limits 独立预算 / contract manifest v1 契约 / issues 有界诊断原语
│                                #   / paths 受控落点与规范路径 / manifest 清单校验 / verify 内存字节核验
│                                #   / inventory 受控盘点 / target 目标侧排他写入与发布 / export 导出编排
├── cli/selfcheck.mjs            # 自检入口（含存储离线演示）
├── cli/cliArgs.mjs              # 两个人工 CLI 共用的参数白名单/退出码/受控输出
├── cli/project.mjs              # BM-03 项目事实人工入口（薄 CLI：解析→领域 API→受控输出）
├── cli/project-scenario.mjs     # BM-03 合成端到端演示（真实子进程）
├── cli/business.mjs             # BM-04 需求/经验/审核/检索人工入口
├── cli/experience-scenario.mjs  # BM-04 跨项目经验参考演示（真实子进程）
├── skills/                      # bios-project-onboarding / customer-feature-porting
└── tests/                       # 契约、路径、扫描、授权、加载链路、存储、审核审计与审核持久化
                                 # （storageWrite = BM-02B/02BR 永久回归，含真实双子进程竞争；
                                 #  storageJournal = BM-02C1/02C1R；auditContracts/auditAssociation = BM-02C2A/C2AR；
                                 #  storageReviewWriter / storageReviewReconcile = BM-02C2B，含真实崩溃与双进程竞争；
                                 #  storagePreflight = BM-02C3 + C3R，只读预检：版本/缺档案/坏文件/共同问题额度/
                                 #                    真实输出字节/截断统计/根错误出口/取消/只读 hash；
                                 #  storageBackupManifest / storageBackupPayload = BM-02D1 备份协议纯校验）
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

验收状态：第十一轮独立复跑包内 **253 用例中 251 通过、0 失败、2 个显式 skip**（符号链接权限），
C2A/C2AR 在协议与纯校验范围通过，A1～A3 关闭；
C2B 经第十二轮独立复跑 **295 用例中 293 通过、0 失败、2 个显式 skip**，但独立诊断 R1～R4 阻塞、**整体未通过**；
C2BR 第十三轮独立复跑 **326 用例中 324 通过、0 失败、2 个显式 skip（审核持久化 73 项）**，
格式（56 文件）/typecheck/selfcheck 通过；R1/R3 关闭，原 R2/R4 的 F1/F2 曾阻塞。
C2BR2 第十四轮独立复跑 **343 用例中 341 通过、0 失败、2 个显式 skip（审核持久化 90 项）**，六文件针对性 **160 项**通过；F1 关闭、F2 主要路径通过，当时尚有 I1。
I1 经第十五轮独立复跑 **348 用例中 346 通过、0 失败、2 个显式 skip（审核持久化 95 项）**，六文件针对性 **165 项**通过，I1 关闭。
C3 第十六轮独立复跑 **383 用例中 381 通过、0 失败、2 个显式 skip（新增预检 35 项）**，七文件 **200 项**通过；额外诊断 PF-1～PF-4 阻塞。
C3R 第十七轮独立复跑 **400 项中 397 通过、0 失败、3 skip**，七文件 **217 项（216 通过、1 skip）**；PF-1～PF-3 关闭，PF-4 原始截断通过但 S1 的嵌套/提前停止观察计费仍未收口。
S1 原复现经第十八轮确认通过：**407 项中 404 通过、0 失败、3 skip（预检 52 → 59 项）**，七文件 **224 项**；正常列举即时计费，父目录成本先入账。
S2 原漏计经第十九轮确认通过：**414 项中 411 通过、0 失败、3 skip（预检 59 → 66 项）**，七文件 **231 项**；中途失败成本也进预算、成功不双计。
S3停止锁存经第二十轮独立确认通过：**423项中420通过、0失败、3skip（预检66→75项）**，七文件240项、五文件194项；原关闭故障收口，不重新执行整改。
C1/C1R 已由第九轮独立复跑确认（在声明的本机范围通过，J1～J4 关闭）；
BM-02BR 由第七轮独立复跑确认（183 用例）。
C2B/C2BR/C2BR2 已落地**一条经验卡审核的真实持久化**，经第十五轮通过声明的本机范围；不等同生产知识系统就绪。
最新独立结论见 `docs/bios-agent/round29_acceptance.md`；C1R红绿证据见
`docs/bios-agent/bm02c1_implementation.md`；审核审计的契约、修正后的提交/恢复协议与红绿说明见
`docs/bios-agent/bm02c2a_implementation.md` §3/§6；审核持久化的 API、状态/取消/清理表与进程证据见
`docs/bios-agent/bm02c2b_implementation.md`（§11 为实施方快照，I1 以独立结论为准）。
下述接口不代表跨平台/生产环境的所有异常边界均已通过。

BM-02A 提供**显式初始化与有界读取**，BM-02B/02BR 已实现普通 create/update、可取消跨进程锁、
create 非覆盖发布与 update/registry 原子替换；BM-02C1 在其上加了**单文件写入意图日志与崩溃后结果核对**；
BM-02C2A 加了**审核审计的纯契约与一致性协议**；BM-02C2B 把它接到真实 IO：意图/事件工件 +
**审核专用 journal v2** + `recordReviewDecision` + 只读巡检与显式恢复（普通写仍是 v1）。
通用多文件事务/实际版本迁移尚未实现；管理 CLI/离线备份恢复已由第二十七轮通过声明的本机范围。**C3/C3R 经第二十轮通过本机只读盘点范围**；
现在**不给模型开放任何写知识的工具**（journal 的 inspect/reconcile、审核入口、预检都不接模型）。

### 接口

| 接口 | 本轮行为 |
|---|---|
| `initializeKnowledgeStore({ root, limits?, signal?, ioHooks?, now? })` | 创建目录布局与合法空 registry；已存在则校验后返回 `existing`，**不覆盖、不重置 revision/时间**；发布不做直写回退（见下） |
| `readRegistry({ root, ... })` | 有界读取 + 版本闸门 + 结构校验 + 绑定一致性校验 |
| `readRecord({ root, kind, id, projectId? })` | 按受控 kind+ID 定位并限额读取；校验记录 ID、任务所属项目一致 |
| `listRecords({ root, kind, projectId? })` | 有界扫描 + 摘要（不返回正文）；单条问题进 `problems`；条目与问题共用字节预算，并返回 `droppedProblems` / `skippedEntries` / `truncatedBy` |
| `resolveProjectBinding(registry, query)` | 按路径／知识项目 ID／桌面 projectId 解析绑定；唯一性先于解析，缺失与冲突（含重复 ID、矛盾条件、多工作区歧义）分别返回 |


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
| `maxListBytes` | 256 KiB | 列表摘要与 `problems` 字符串字段累计 UTF-8 字节（不含 JSON 结构开销） |
| `maxScanEntries` | 5000 | 单次列表扫描的目录条目数 |
| `maxListProblems` | 50 | 单次列表 `problems` 条目数上限 |

读取**不信任 `stat`**：`stat` 只用于快速预检，真正的大小判定来自"分块读到 EOF 或上限 +1 字节"，
因此不会把"读取期间增长的文件"当成合法前缀接受，也不做"先整文件物化再判断大小"。
限额非法（`NaN` / `Infinity` / 负数／非整数）会抛 `invalid-limits`；显式 `undefined` 保留默认值，
默认对象不会被单次调用污染。

### 链接政策与信任假设

- 知识根自身允许经 `realpath` 解析（库可能配在链接路径下），解析结果记为 canonical root；
- **根内任何符号链接／junction 一律拒绝**（目录段与最终文件都拒绝），
  因此"根内链接指向根外"会被拒绝，且拒绝时不读取、不写入根外内容；
- **硬链接不在覆盖范围**：`lstat` 无法区分硬链接，它在本策略下表现为"根内的常规文件"；
- 检查反映的是**本进程在操作时刻**看到的路径状态，不提供操作系统级沙箱，
  也不阻止同机其他进程在检查与操作之间替换路径。BM-02B 的写入只是把"同协议的本地写者"
  用 `locks/` 下的协作式锁串起来，仍然**不阻止绕过协议的进程**。

### 初始化发布协议

写同目录临时文件（`flag: "wx"`，完整内容一次写完）→ `link()` 到目标（目标已存在即 `EEXIST`，天然不覆盖）→ 删除临时文件。
**没有直写最终目标的回退**：文件系统不支持硬链接（`ENOSYS`/`EPERM`/`ENOTSUP` 等）时抛 `publish-unsupported`，
而不是用 `flag: "wx"` 直接创建目标——直写无法保证"要么没有，要么完整"，会让并发读者看到空/半 registry。
因此：

- 重复初始化不会重写 registry（原字节不变）；
- 两个进程同时首建不会互相覆盖：落后一方读到对方发布的内容，或拿到可重试的 `init-race`；
- 竞争重试只针对真正可重试的错误（`not-found` / `init-race`），**不会吞掉取消、权限或永久错误**；
- 绝不使用"先 `exists` 判断、再 `writeFile`"这种会被并发插空的写法。

限制：不支持硬链接的文件系统上，初始化会**明确失败**（`publish-unsupported`），当前没有替代发布路径。

## 存储写入（BM-02B）

写入面只有三个入口，全部走同一条管线：**取锁 → 重新读取当前字节 → 乐观 revision 校验 → 组装 → 写同目录临时文件并 `sync` → 原子替换 → 释放锁**。
**没有第四个后门**：不存在"不带 revision 的强制写"，也不存在"直接改文件"的旁路。

| 接口 | 作用 |
|---|---|
| `updateRegistry({ root, expectedRevision, projects, ... })` | 更新 registry（绑定关系）；不创建、不改写任何 profile |
| `createRecord({ root, kind, id, projectId?, data, expectedRevision: null, ... })` | 新建一条记录，目标已存在即失败 |
| `updateRecord({ root, kind, id, projectId?, data, expectedRevision, ... })` | 更新一条已存在记录，ID 与项目归属不变 |

`data` 是**业务字段**，类型上已排除公共头（`schemaVersion` / `revision` / `createdAt` / `updatedAt`）、
`id` 与归属字段（`task-record.projectId`）；运行时若仍出现这些键一律 `invalid-record` 拒绝，
**不静默丢弃**。归属字段与 `id` 由存储层从参数生成。

### revision 语义

| 字段 | 语义 |
|---|---|
| `expectedRevision: null` | 只用于 `create*`：要求**目标不存在** |
| `expectedRevision: number` | 只用于 `update*`：要求目标存在且 `revision` 恰好相等 |
| 成功返回 `revision` | 本次提交后**新内容**的 revision（create = `0`，update = 旧值 + 1） |

不匹配（旧 revision、缺失、已存在、非法 `expectedRevision`、计数溢出）一律 `revision-conflict`，
错误里给出 `expected` / `actual`（不存在时为 `null`）与受控标识（kind / id / 目标相对路径），
**不返回任何记录正文**。相同 `data` 重复提交**不**做幂等特判：第二次必然 revision 冲突。

`expectedRevision`、记录与 registry 的**当前** `revision` 都必须是通过 `Number.isSafeInteger` 的
非负安全整数（W1）：`NaN` / `Infinity` / `2^53` / 小数被拒绝，`detail` 分别是
`invalid-expected-revision` 与 `unsafe-current-revision`（后者先于冲突判定，避免把"文件已坏到不能递增"
说成"别人抢先写了"）；达到 `Number.MAX_SAFE_INTEGER` 时拒绝递增（`revision-overflow`）。
记录与 registry 共用同一份公共头生成（`nextRecordHeader`），**registry 不再有独立的溢出/头逻辑**。

`updatedAt` 取 `max(now, 旧 updatedAt)`（可注入时钟），因此时间**不会倒退**；
`createdAt` 与 `schemaVersion` 在更新时保持原值（写入不是升级结构的机会）。

### 跨进程锁

- 锁目录在**知识根内** `locks/`，锁键 = `canonicalRoot` + 受控相对目标（Windows 上大小写归一，
  避免同一目标两个锁名）；锁文件是**目录**，用 `mkdir` 的原子性实现"只有一个持有者"。
- 元数据 `owner.json` 写在其中（`ownerId` / `pid` / `createdAt` / 目标相对路径）。
  元数据缺失或损坏时按**忙碌**处理，**绝不抢占**他人锁。
- 等待是**有界且可取消**的：超时 `lock-timeout`，取消 `cancelled`；超时信息包含持锁者诊断
  （`pid`、`createdAt`、`ownerId`），仍然不含任何记录正文。
- 时序参数在**任何 IO 之前**校验（写入入口与公开的 `acquireStorageLock` 共用 `resolveLockTiming`）：
  `timeoutMs` ∈ `[0, 2^31-1]` 的整数，`0` 表示"只尝试一次"；`pollMs` 为**正整数**
  （`0` 是忙等，拒绝）；`now` 必须是 `Date` 可表示范围内的安全整数（否则诊断格式化会抛 `RangeError`）。
  非整数 / `NaN` / `Infinity` / 越界一律 `invalid-limits`，不取锁、不落盘。
- 每轮等待量取 `min(pollMs, 剩余预算)`：`pollMs` 大于 `timeoutMs` 时也必须落在调用方给的预算内
  （W2），不会"说好等 10ms、实际睡 1s"；`timeoutMs: 0` 只尝试一次即返回。
- 释放前校验 `ownerId` 是自己；不是自己的锁**不删除**，只报告诊断
  （返回 `not-owner` / `missing` 表示"没删"，不是失败）。
- 释放**不受调用方取消影响**：锁没有回收器，如果"用户取消写入"能阻止清理，
  一次取消就会把锁永久留在磁盘上，此后所有写者都超时。因此只有**释放**使用忽略取消的读取，
  写入/读取路径的取消语义不受影响。
- 写入结果里的 `lockRelease` 如实反映释放结果（`released` / `not-owner` / `missing` / `failed`）；
  释放失败**不会**把已提交的写入改口成失败，也不会被静默吞掉。
  成功路径进 `warnings`；**失败路径**（如 revision 冲突）同样附加一句固定诊断
  （`not-owner` / `missing` / 释放抛错都算"没删成功"），但绝不覆盖原始 `code` / `path` /
  `detail` / `expected` / `actual`（W3）。

### 单文件完整提交

三个入口共用同一套提交原语（`core/storage/commit.ts`），但**发布方式按语义分开**（W3 修正）：

| 操作 | 发布方式 | 为什么 |
|---|---|---|
| `createRecord` | 同目录临时文件（`wx`、完整内容、`sync`、`close`）+ **`link()`** | 硬链接在目标已存在时 `EEXIST`，因此**天然不覆盖**：目标在"取锁之后、提交之前"被别人抢先建好时，本次创建报 `revision-conflict` 而不是把它抹掉 |
| `updateRecord` / `updateRegistry` | 同目录临时文件 + **`rename()`** | 语义就是"替换已存在的目标"，`rename` 是原子替换，读者看不到半成品 |

- 所有路径都：临时文件与目标**同目录**、`flag: "wx"`、一次写完整内容、先 `sync()` 再 `close()`；不宣称崩溃一致性
  （掉电后目录项与数据块谁先落盘依赖文件系统，未经验证）。
- **正常路径的 `close` 属于提交本身**：它失败即中止本次提交（句柄状态未知，不能提交）；
  **异常路径的 `finally` close 是尽力而为**：此时已有错误在传播，close 再失败不覆盖首个错误。
  两条路径都**显式**关闭句柄，不依赖 GC（测试用 `handle.fd === -1` 断言，而不是"随后还能写"）。
- 提交前**再次**确认目标路径上没有链接（写入期间路径可能被换成 junction/符号链接，
  `rename` 会跟随它把内容写到知识根外）。
- 提交前按**实际 UTF-8 字节数与字符数**检查上限（`maxRegistryBytes` / `maxRecordBytes` 与 `maxJsonChars`），
  **不依赖序列化前的估算**；超限时连临时文件都不创建。
- 硬链接不被支持时（`ENOSYS` / `ENOTSUP` 等）抛 `publish-unsupported`，**不回退直写**。
- Windows 共享冲突导致的 `EBUSY` / `EPERM`（重命名）做**有界、可取消**的重试：指数退避、单次延迟上限
  250ms、最多 12 次尝试，标称总预算 4000ms（延迟序列理论总和约 2.05s，因此**先触达的是次数上限**）。
  退避期间取消立即生效（不会"等完这一轮"）；重试耗尽即 `permission-denied`，
  **不回退成"先删后写"**这种非原子替换。
- **提交点** = `link` / `rename` 成功。此后迟到取消不假称回滚，返回真实的 `created` / `updated`。
- **提交成功但有遗留**（临时文件没删掉、锁目录没删掉）用 `warnings` 如实上报，**不制造"未提交"假象**；
  失败路径上的清理失败/锁释放失败则附加到原错误上（固定文案、有界、含原码与 `detail`、**不含正文**），
  `exists` + 清理失败这种"正常返回"的组合同样附加，不吞掉临时残留（W3）。

### 写入意图日志（journal，BM-02C1）

本节说明 C1 的协议要求；第八轮验收指出的 J1～J4（目标/锁一致性、目标完整校验、失败清理诊断、真实输出预算）
已由 C1R 修复并各带永久回归，红绿证据见 [C1 实施记录 §6](../../docs/bios-agent/bm02c1_implementation.md)。
实现细节以源码与实施记录为准；下列要求不是"整个恢复协议已被穷尽验证"的保证。

解决的问题：进程在"数据已提交"与"调用方知道结果"之间退出时，新进程无从判断目标到底是旧值、新值还是别的东西。
journal 把**写入意图**落盘，让崩溃后的核对有依据——**不是**事务，也不是内容备份。

```text
参数/有效库准入 → 取目标原有协作锁 → 重读并校验 expectedRevision → 组装新值（预算+schema）
→ 持久发布 prepared journal → 数据提交（create=link / update=rename）  ← ★ 数据提交点
→ 写 journal 终态 → 释放自有锁 → 返回实际结果
```

- 落点 `journal/<operationId>.json`（operationId 由 storage 生成，**不接受调用方给路径**；`journal/` 目录惰性创建，
  因此旧知识库没有该目录仍完全兼容，初始化协议不变）。内容只有：`journalVersion`、operationId、operation、
  `state`（`prepared`/`committed`/`aborted`/`conflict`）、受控 `target`（`registry` 或 kind/id[/projectId]）、
  `before`/`after` 的 `revision` + **真实字节 SHA-256**、`preparedAt`/`finishedAt`、`source`
  （`writer-confirmed` / `recovery-observed`）。**不复制记录正文**，因此**不能**据它重建丢失的数据。
- `before.hash` 取自**当时读到的磁盘字节**（旧文件带不同空白也算同一版本），`after.hash` 取自**实际提交的那份字节**。
- **数据提交点是 `link`/`rename` 成功**，不是记账成功。数据已提交但终态没写成（IO 失败/迟到取消）时：
  仍然返回真实的 `created`/`updated`，`result.journal.state = "needs-recovery"` 并给出含 operationId 的警告——
  **绝不**变成"未提交"，也**不**重复递增 revision。提交前的失败/取消则尽力记 `aborted`，写不进去就保留 `prepared` + 有界诊断。
- 成功结果新增 `journal: { operationId, state, relativePath }`；`warnings` 语义不变（仍是"提交成立但有遗留"）。
- 两个显式恢复 API（不接模型/GUI、不在会话启动时无界扫描）：
  - `inspectPendingJournal({ root })`：**只读**有界巡检，返回还没收口的 `pending` 候选、`problems`（坏 JSON /
    未来版本 / 文件名与 operationId 不符 / 非法目标 / 超限 / 链接）、`scanned` / `truncated` / `truncatedBy` /
    `skippedEntries`（`.tmp` 与非 `.json` 只跳过、**不删除**）/ `droppedProblems` / `finalized` 计数；
  - `reconcileJournalOperation({ root, operationId })`：对**同一个受控目标**取原有协作锁、持锁复读 journal 与目标后收口：
    目标与 `after` 一致 → `committed`（`recovery-observed`，不写目标）；与 `before` 一致 → `aborted`（不自动完成旧操作）；
    都不一致 → `conflict`；目标坏 JSON/未知版本/结构或归属非法/非文件/链接/不可读 → `unreadable`（保留证据、不动手）；
    已有终态 → 幂等返回；锁被他人持有 → `busy`（**不按 PID/mtime/年龄抢占**，需人工确认）。
- 收口前的三条硬约束（C1R 修入，改这几处代码前先读）：
  - **持锁身份必须一致**：持锁复读后的 journal 目标要与**锁的对象**相同（`journalTargetKey`，覆盖 kind/id/**projectId**）；
    不一致 → `unreadable` + `changed=false` + `observed=null`，**不追新目标重新加锁**（避免跨目标无界追逐）；
  - **校验与哈希同源**：目标的版本/结构/身份/归属/绑定校验与 SHA-256 必须来自**同一次有界读取**
    （记录复用 `interpretRecord`，registry 复用 `interpretRegistryValue`），否则非法目标会被洗成一次"正常判定"；
  - **首错优先**：抛错/返回值两条路径上的清理失败都只作附加诊断，保留原 `code` 等字段，**不假装已删锁**、不覆盖原错误。
- 边界：C1 **不重放、不回滚**业务数据，`conflict` 只报告给人处理；崩溃留下的遗留锁不自动回收；
  杀进程测试不等于断电实验。journal 独立限额：单条 16 KiB、候选 200 条/256 KiB、扫描 5000 条、问题 50 条（均可注入更小值，`0` 语义见 `limits.ts` 注释）；
  `maxJournalInspectBytes` **只约束 `pending` 候选数组的实际 UTF-8 序列化字节**（含 `[]` 与逗号），不是整个返回对象的硬上限。

### 有效库准入（W4）

普通 `createRecord` / `updateRecord` 在**取锁、建目录、创建记录之前**先按读路径的规则确认知识库可用：
缺失 → `not-found`（`store-not-initialized`）；坏 JSON → `invalid-json`；未来版本 →
`unsupported-schema-version`；结构非法 → `invalid-record`；绑定冲突 → `binding-conflict`；
`registry.json` 是目录或根内链接 → `not-a-file` / `symlink-rejected`。
判据不是"文件是否存在"——存在一个被截断或被手改成未来版本的 registry，等于库已经不可读，
此时继续写入会在坏库上累积数据，等到读取时才爆，且分不清哪些记录是坏库之后写的。

被拒绝时不含任何副作用：不产生锁、不创建业务目录、不改动 registry 字节、既有记录原 hash 不变。
`updateRegistry` 仍保持独立语义（registry 不存在时报 `revision-conflict`），不走这道准入。

### 审核审计契约（BM-02C2A，**纯契约，无 IO**）

C1 的 journal 只能回答"磁盘字节与写入意图是否一致"，它没有操作者、理由与"决定"的语义——
**不能**拿它的 `recovery-observed` 冒充一条人工审核记录。因此审核审计是**独立类别**：
自己的 `auditVersion: 1`、自己的 schema 与校验，**不**混进五类业务记录，也**不**改 journal v1。

- `core/contracts/audit.ts`：`AuditEventSchema`（由 schema 推导类型）+ 动作/状态表 + 全部上限常量。
  一条事件 = 一次人工决定的不可变记录：`eventId`/`operationId`（规范小写 UUID）、受控 `target`
  （**只有** `experience-card` + `recordId`，不接受任何路径字段）、`action`（`submit-review` /
  `request-changes` / `approve` / `deprecate` / `restore`）、`fromStatus`/`toStatus`、`operatorLabel`、
  `decidedAt`、`reason`、`before`/`after`（安全 revision + 64 位小写哈希，**审核是 update 关系**：
  `after = before + 1`）、有界的 `evidence`（≤32 条，只存引用/下标/简短说明，**不复制正文**）、
  `publication`（`writer` / `recovery`）、`recordedAt`。
- `core/contracts/auditValidation.ts`：`validateAuditEvent(unknown)` 纯函数，分层拒绝——
  版本闸门（未知版本只报一条 `unsupported-audit-version`，不猜格式）→ schema（类型/枚举/必填/长度/条数/格式/数值范围）
  → 语义（动作↔状态对、`after = before + 1` 与溢出、`recordedAt ≥ decidedAt`、标签/理由的**字符与 UTF-8 字节**双预算、
  证据形态互斥与总字节、单条事件总量）。issue 为 `{ code, path, message }`，最多 20 条并带 `droppedIssues`；
  事件/意图/投影共用同一份规则与脱敏管道（`collectSchemaIssues`、`sanitizeAuditPath`）。
- `core/contracts/auditIntent.ts`（C2AR）：**审核意图** = 一次决定的**稳定字段**（谁/何时决定/理由/动作/目标/前后指纹/证据），
  **不含** `publication`/`recordedAt`——发布事实在意图尚未发布时并不存在。校验通过**不等于**已经发布。
- `core/contracts/auditAssociation.ts`（C2AR）：未来审核 journal v2 的**关联投影**校验，以及
  `compareAuditAssociation` 的纯判定——**不存在事件 ⇒ `publish`**（不预支发布事实）；
  **已有事件 ⇒ 逐项比较稳定决定字段后 `claim`**，保留其原始 `publication`/`recordedAt`；不一致 ⇒ 冲突。
- **脱敏是硬要求**：未声明字段一律报"存在未声明的字段（名称已省略）"，路径里的未知片段替换成 `<unknown>`，
  长度/格式类错误不回显字段值——校验本身绝不能成为泄漏客户资料的通道。校验**不修改**输入。
- 上限：单条事件 16 KiB（兜底闸门；保守上界 13,056 B < 16,384 B，含 `\uXXXX` 六倍转义）、
  标签 128 字符 / 256 字节、理由 512 字符 / 1024 字节、证据 32 条 / 8 KiB；意图同量级。
  要求"字节上限 < 3 × 字符上限"是刻意的：否则在当前 UTF-16 计数下这条规则永远不触发。
- **C2A/C2AR 阶段没有 IO**；后续 C2B 已有工件、写入口和恢复器，但第十二轮发现 R1～R4。
  业务记录与审计的协议见 `docs/bios-agent/bm02c2a_implementation.md` §3，IO 整改以 C2BR 为准。
  三条硬规则：**完成终态永远在审计事件之后**（否则恢复先写终态会永久丢失审计）；
  **决定比较不看发布事实**（认领已有事件保留其原始 `publication`/`recordedAt`，不覆盖、不重打时间）；
  **审核写只认 journal v2 绑定**（operationId/eventId/受控意图名/意图字节指纹/target/before/after），
  不再用"intent 文件是否存在"判断普通写。
- 明确不声称：`operatorLabel` 不是身份认证；`verified` 的硬件证据规则属 experiences 域；
  "审核只由人工 CLI/UI 调用"是应用层约定，不是 OS 防护。

### 审核持久化（BM-02C2B，**真实 IO**）

把上面的契约接到真实文件 IO，闭环是"人工调用入口 → 一条经验卡状态变更 → 不可变审计事件 → 新进程核对/收尾"：

- `core/storage/review/contract.ts`：**审核专用 journal v2**（`journalVersion: 2` + `journalPurpose: "review"`
  判别位 + `eventId` + 受控 `intentName` + `intentHash`），校验规则与 v1 同构（未知键与未知版本一律拒绝）。
  **普通写仍是 v1**（`JOURNAL_SCHEMA_VERSION = 1`），旧 C1 读者对 v2 报 `unsupported-journal-version`。
- `core/storage/review/artifacts.ts`：不可变工件 IO —— 意图 `audit/intents/<operationId>.json`、
  事件 `audit/<recordId>/<eventId>.json`，`link` 非覆盖发布、有界读取、损坏保护；
  意图撞名时**同字节幂等**、不同字节 `audit-conflict`（绝不覆盖）。
- `core/storage/review/writer.ts` + `commitSteps.ts` + `decisions.ts`：`recordReviewDecision`，
  顺序固定为 **意图 → v2 prepared → 记录 rename（唯一提交点）→ 事件发布/认领 → 完成终态**；
  与普通写共用同一把目标锁；`reviewer` 规则成表（approve 设置 / 打回与恢复提交清除 / 废弃保留）。
- `core/storage/review/inspect.ts` + `reconcile.ts`：`inspectPendingReviewOperations`（只读、有界、
  合法 v1 与 v2 分开计数）与 `reconcileReviewOperation`（持锁复读 → 先验证关联 → 目标=after 时
  先发布/认领事件再写终态；目标=before ⇒ `aborted` 且不发事件；既非前后 ⇒ `conflict`）。
- 结果语义：`applied` / `applied-audit-pending`（`audit = null`，不预支发布事实）/
  `applied-journal-pending`；提交点之后的失败一律以结果表达，不抛异常、不改口成"未提交"。
- 新增错误码 `audit-conflict`（同身份不同字节的工件，需要人工判断，不可自动重试）。

**C2BR（R1～R4）修正后的边界**（以 `docs/bios-agent/bm02c2b_implementation.md` §10 为准）：

- **v2 校验真正执行完整 schema**：版本闸门 → 判别位 → `ReviewJournalRecordSchema`（含嵌套
  `additionalProperties`/UUID/KnowledgeId/指纹形态与数值）→ 文件名与派生名 → 递增关系 → 终态三要素。
  诊断走事件/意图同一套脱敏与有界管道，不回显未知字段名/值。
- **审核工件硬限额**：`REVIEW_ARTIFACT_MAX_BYTES = 16 KiB`，意图/事件/审核 v2 的读写都走
  `reviewArtifactLimit()`（配置**只能收紧**）；普通 v1 journal 的可配置预算不变。
- **收口顺序**：持锁复读 → 先比锁定目标身份 → 再判状态 → 用 `compareAuditAssociation` 逐项核对
  "投影 ↔ 意图 ↔ 已有事件"（不存在事件传 `null`）→ 认领/发布 → 终态。目标=before 时
  **第一次**读到绑定路径上的事件即报 `inconsistent`（不再先写 `aborted`）。
- **任何终态之前都要过完整绑定**（C2BR2 / F1，修正 §10 的表述）：`conflict` 也是收口——
  顺序固定为 锁定目标 → 状态 → **完整绑定** →（conflict / before / after）。绑定失败（意图缺失、坏 JSON、
  未来版本、指纹或 target/before/after 对不上）一律 `inconsistent`、`changed=false`、journal 原字节保持
  prepared、不发事件、不改业务与意图；`unreadable` 留给读不懂的**目标/工件文件**。
  合法绑定 + 目标被合法更新仍按协议记 `conflict`，再次核对幂等。
- **恢复结论**：已有且一致的事件**直接认领**其 `publication`/`recordedAt`（不受本次时钟或候选预算影响）；
  只在事件缺失时才生成 recovery 发布事实，且 `now < decidedAt` 时**拒绝**发布（返回可重试的 `pending`，
  不伪造时间）。新增结论 `pending` 表示"业务已到 after，事件或终态待补"，发布失败/终态失败/发布后取消
  都用它表达；**未发布前**取消仍穿透为 `cancelled`。
- **工件清理诊断**：结果新增 `artifactCleanup`（始终存在，空数组 = 无残留），逐件覆盖意图/v2 prepared/
  事件（含 exists 撞名分支）/终态；提交前抛错时把残留附加到**原错误**上（错误码不变）。
  业务 `cleanup` 仍只表示记录文件。
- **失败路径的清理事实也必须能取回**（C2BR2 / F2 + I1）：`boundary` 的失败路径用**结构化标记**
  （`attachCleanupFailureNote` + `hasCleanupFailureMark`，WeakSet，不改错误外形、不比对文案）表达"临时文件没删掉"，
  审核工件的提取器据此把它变成 `artifactCleanup`/warnings；事件 `exists` 撞名后读取被取消/失败、
  **意图 `exists` 后复读被取消**（I1）等路径都在重新抛出原错误前保留清理说明，未发布前的 `cancelled` 仍然穿透。
  判据只认**本次调用**的 cleanup，不把历史残留归到本次。
- 细节、状态/取消/清理表、真实崩溃（含 **recovery 二次中断**）与双进程竞争证据见
  `docs/bios-agent/bm02c2b_implementation.md` §5.3 / §10 / §11 / **§12（I1 修正后的唯一有效描述）**。

### 知识库版本盘点与迁移预检（BM-02C3，**只读**）

`core/storage/preflight/` 提供一个只读入口，回答"哪些格式版本 / 哪些文件无法解释 / 是否需要迁移 / 哪些阻断事项"：

- `inspectKnowledgeStore({ root, limits?, signal?, ioHooks? })`：显式接收完全限定的根，**不读默认用户知识库、不调用初始化 API**；
- 结论只有三种：`no-migration-needed` / `blocked` / `incomplete`，**任何截断都不返回通过**（问题列表被截断时阻断计数仍独立累加）；
  **根自身列举被拒/中途消失**（BM-02C3R / PF-1）会记 `truncatedBy: "root-listing"` 并报阻断问题，绝不退化成"根布局外条目没问题"；
- 版本分类复用既有校验器：记录 `interpretRecord`、journal 按 `journalVersion` 路由 v1/v2（**v1 普通写与 v2 审核合法共存**）、
  审核意图 `validateAuditIntent` + 路径身份、审计事件 `validateAuditEvent` + 路径身份；未知版本只报一条、不猜字段；
- 预算三类共享：**条目**（含被跳过的链接/未知条目/目录本身；**S1/S2 后：每观察到一个条目就即时计入**，不论随后
  是成功、截断还是**迭代中途失败**；目标上限是 `maxScanEntries + 1`，仅允许一次超限探测。
  **S3 后：超限探测条目一旦交出，停止就地锁存**（收尾/关闭失败也不能绕过，`isScanStopped = stopped || truncatedBy 含 scan-entries`），该上限在成功/截断/迭代失败/关闭失败/取消/未触顶错误各出口成立；
  同预算还覆盖少量"逻辑核对"如登记项目缺目录，但逻辑核对不计入 `scannedEntries`；候选处理不重复扣账、成功路径不双计）、
  **读取**（成功按实际字节、失败按单文件上限预留，分账报告）、
  **输出**（BM-02C3R / PF-3 后：`problems.length + manual.length <= maxProblems` 共用一份条数额度；
  字节预算按 `summaries`+`problems`+`manual` 合并 JSON 数组的**真实 UTF-8 字节**计，含数组括号与逗号，空明细为 0，固定报告信封不计入）；
  `0` 逐字段有明确含义（`maxFileBytes=0` = 立即停读并标记 `read-bytes`），`undefined` 保持默认，非法值抛 `invalid-limits`；
- 只走固定落点（registry/项目档案/任务/上下文/经验卡/特性/journal/意图/事件/锁/`.tmp`/cache），
  **不递归未知目录、不跟随链接、不扫 BIOS 源码**；`prepared`/`conflict`、锁与 `.tmp` 一律列为"人工核对事项"，不重放、不偷锁、不清理；
- 不写任何字节（不建目录、不加锁、不发布临时文件），但扫描是**观察式**的，不是原子快照。
- 细节、状态/预算/取消表与只读证据见 `docs/bios-agent/bm02c3_implementation.md`（**§12 是 S2 后的唯一条目计费口径**（含失败出口），其“任何出口上限+1”承诺曾受 **§13** 独立诊断修正，**经 §14 的 S3 锁存重新成立**；**§8.2** 定义读取与输出，§4 的旧说法作废）。

### 离线备份：D1 纯校验通过，D2 导出暂未通过

第二十五轮保留 D1/D1R 已通过结论，R24-1/2 通过，已发现 D2R 整改收口。完整边界见 [验收](../../docs/bios-agent/round25_acceptance.md)，按 [加速批次 §11](../../docs/bios-agent/bm02d3_development_plan.md#accelerated-delivery)完成尚未开始的恢复与薄 CLI。下述为现有导出流程，不代表恢复闭环、正式资料保护或生产平台验证已成立。

D1 两个纯 API 不做 IO；backup 模块另有 D2 导出 IO，尚无 D3 恢复：

- `validateBackupManifest(value, limits?)`：`unknown` → 类型化 `backupVersion=1` 清单，或受控失败
  （`{ ok:false, code:"invalid-backup-manifest", issues, droppedIssues }`）。严格对象：未知字段（含 symbol 键）、
  缺失字段、未来版本都拒绝；字段顺序固定，清单字节预算按规范化 JSON UTF-8 字节计。
- `verifyBackupPayload(manifest, entries, limits?)`：`entries` 是内存中的 `{ path, bytes: Uint8Array }`，
  **没有 fs、没有根路径**。逐项核对唯一集合、长度与 SHA-256；缺失/多余/重复/长度错/hash 错分别报出。
  失败码为 `backup-payload-mismatch`；清单本身非法时原样返回 `invalid-backup-manifest`。
- 受控落点：`registry.json`、`projects/<uuid>/profile.json`、`projects/<uuid>/tasks|context/<id>.json`、
  `experiences|features/<id>.json`、`journal/<operationId>.json`、`audit/intents/<operationId>.json`、
  `audit/<recordId>/<eventId>.json`；目录只允许这些落点的祖先 + `journal` + `audit/intents`，
  必需固定目录为 `projects`/`experiences`/`features`/`audit`。`cache`/`locks` 只在 `exclusions` 里出现。
- 路径只接受规范形式：绝对/盘符/UNC/反斜杠/`.`/`..`/重复与首尾分隔符/NUL/冒号 ADS/尾点/尾空格/
  保留名/大小写变体/非 ASCII/未 URL 解码一律拒绝，**不替调用方 normalize**；诊断"名称已省略"。
- 预算（独立于 `StorageLimits`）：清单 2 MiB / 文件 10,000 / 目录 2,000 / 单文件 16 MiB /
  总量 256 MiB / 路径 240 字符 / 问题 50；未知限额字段与非法的 `NaN`/负数/小数/`Infinity` 抛 `invalid-limits`；
  `0` 表示**不允许**该项消耗；数量边界先于逐条细节，总量在溢出前拒绝；`maxIssues=0` 不返回问题但如实计数且仍失败。
- **能力边界**：成功只表示"清单协议合法"或"清单与所给字节一致"，**不表示**已导出、已落盘、
  业务版本可解释或可以立即恢复；SHA-256 只校验完整性，不提供签名/身份认证。恢复到新目录（D3）
  与最小管理 CLI（D4）按当前方案 §11 同批开发、统一验收。
- **离线导出（BM-02D2）**：`exportKnowledgeBackup({ root, backupRoot, offlineConfirmed: true, limits?, preflightLimits?, signal?, ioHooks? })`
  把一份**通过准入**的知识库复制成根外的 `manifest.json` ＋ `data/`：显式离线确认与参数校验先于任何 IO →
  canonical 重叠判定 → `mkdir` 排他创建全新目标 → 预检准入（`complete`/`no-migration-needed`/无截断裁剪/无阻断/无人工事项）
  → 受控 inventory（固定深度、未知落点/链接/`.tmp` 即失败）→ 有界原字节复制（独占写入、短写循环、`sync`/`close`，
  `readRawBytes` 不走 JSON 往返）→ 源变化检测（重盘点 + 重跑准入 + 重读源字节比对 hash）→ 目标逐文件回读复核
  → 最后用"临时文件 + 硬链接"非覆盖发布 `manifest.json`（硬链接不可用即受控失败）。失败/取消只清理**本次排他创建**
  的内容（文件先删、目录自深到浅、最后删目标根，不递归删除），主失败码不被清理失败覆盖。
  一致性仍是 `offline-copy` ＋ 观察式变化检测，不是在线原子快照。

### 错误码

`not-found`、`invalid-root`、`path-escape`、`symlink-rejected`、`not-a-file`、`permission-denied`、
`invalid-json`、`invalid-record`、`unsupported-schema-version`、`record-id-mismatch`、
`too-large`、`cancelled`、`init-race`、`binding-conflict`、`publish-unsupported`、`invalid-limits`、
`revision-conflict`、`lock-timeout`、`audit-conflict`、`invalid-backup-manifest`、`backup-payload-mismatch`、
`backup-argument-invalid`、`backup-source-not-eligible`、`backup-target-exists`、`backup-target-overlap`、
`backup-source-changed`、`backup-io-failed`。

`audit-conflict` 只由审核路径产生（同身份已有**不同字节**的意图或 journal）：它与可重试的
`revision-conflict` 语义不同——**不可自动重试**，必须交人工判断。

`invalid-backup-manifest` 与 `backup-payload-mismatch` 只由备份协议产生：前者是"清单本身不可信"，
后者是"清单与所给字节不是同一次复制"。更细的定位在结果对象的 `issues[].code` 里，
两个码本身不拆成一堆调用方都得认识的枚举。

JSON 解析失败的说明**不夹带原文**（只给位置/长度等脱敏信息），错误信息里也不放记录正文。

损坏与未知版本一律**拒绝**并保留原文件字节：既不会"修复"成空库，也不会回落成默认值。

`updateRegistry` 复用与初始化相同的 `validateRegistry` + 绑定一致性校验，因此
**重复项目/工作区/路径/桌面 ID 的绑定在写入前就被拒绝**（`invalid-record` / `binding-conflict`）。

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
- 包内门禁（第十轮独立复跑，2026-10-01）：`typecheck` 通过、
  **235 个测试（233 通过、0 失败、2 显式 skip）**、`selfcheck` 6 项通过、格式检查（42 文件）通过；
  仓库根 `typecheck` / `check:format`（2014 文件）/ `processGuards` 通过、`git diff --check` 干净。
  真实双子进程创建/更新竞争、新进程读回、并发读写、根内 junction，以及**真实子进程在 4 个检查点被终止后的新进程核对**
  均在 Windows 实跑通过。复跑命令与未测范围见 `docs/bios-agent/bm02c1_implementation.md` 第 6 节
  （第八轮的独立复跑结论见 `docs/bios-agent/round8_acceptance.md`）。
- 包内门禁（第十一轮独立复跑，2026-10-01）：`typecheck` 通过、
  **253 个测试（251 通过、0 失败、2 显式 skip）**、`selfcheck` 6 项通过、格式检查（45 文件）通过；
  仓库根 `typecheck` / `check:format`（2014 文件）/ `processGuards` 通过、`git diff --check` 干净。
  审核契约与关联针对性 33 项通过；独立证据与未测边界见 `docs/bios-agent/round11_acceptance.md`。
- 包内门禁（C2BR 整改完成时实跑，2026-10-02）：`typecheck` 通过、
  **326 个测试（324 通过、0 失败、2 显式 skip）**、`selfcheck` 6 项通过、格式检查（56 文件）通过；
  仓库根 `typecheck` / `check:format`（2014 文件）/ `processGuards` 通过、`git diff --check` 干净。
  审核持久化针对性 **73 项**通过（含 2 个 writer 崩溃检查点、**1 个真实 recovery 二次中断**与 2 组真实双进程竞争）。
  **第十三轮独立复跑已确认，整体未通过**；证据见 `docs/bios-agent/round13_acceptance.md`，实施快照见 `docs/bios-agent/bm02c2b_implementation.md` §10。
- 包内门禁（C2BR2 整改完成时实跑，2026-10-02）：`typecheck` 通过、
  **343 个测试（341 通过、0 失败、2 显式 skip）**、`selfcheck` 6 项通过、格式检查（56 文件）通过；
  仓库根 `typecheck` / `check:format`（2014 文件）/ `processGuards`（2 项）/ `git diff --check` 干净。
  审核持久化针对性 **90 项**通过（writer 34 + reconcile 52 + contracts 4；含 F1/F2 的 17 项新回归）。
  **第十四轮独立复跑已确认，F1 与 F2 主路径通过，当时 I1 待补**；证据见 `docs/bios-agent/round14_acceptance.md`，实施快照见 `docs/bios-agent/bm02c2b_implementation.md` §11。
- 包内门禁（I1 整改完成时实跑，2026-10-02）：`typecheck` 通过、
  **348 个测试（346 通过、0 失败、2 显式 skip）**、`selfcheck` 6 项通过、格式检查（56 文件）通过；
  仓库根 `typecheck` / `check:format`（2014 文件）/ `processGuards`（2 项）/ `git diff --check` 干净。
  审核持久化针对性 **95 项**通过（writer 39 + reconcile 52 + contracts 4；含 I1 的 5 项新回归）。
  **第十五轮独立复跑确认，I1 关闭**；细节与未测边界见 `docs/bios-agent/round15_acceptance.md` 和 `docs/bios-agent/bm02c2b_implementation.md` §12。
- 包内门禁（C3 预检实施完成时实跑，2026-10-02）：`typecheck` 通过、
  **383 个测试（381 通过、0 失败、2 显式 skip）**、`selfcheck` 6 项通过、格式检查（64 文件）通过；
  仓库根 `typecheck` / `check:format`（2014 文件）/ `processGuards`（2 项）/ `git diff --check` 干净。
  预检针对性 **35 项**通过（版本盘点、缺档案/孤立项目、坏 JSON/归属/绑定/版本、人工事项、超大与增长文件、链接、预算与取消、只读证据）。
  第十六轮已独立确认测试/门禁结果，但 PF-1～PF-4 额外诊断阻塞整体通过；新增叶子链接未执行行为不等于通过。见 `docs/bios-agent/round16_acceptance.md` 与 `docs/bios-agent/bm02c3_implementation.md`。
- 包内门禁（**C3R 收尾实施完成时实跑，2026-10-02，待独立复验**）：`typecheck` 通过、
  **400 个测试（397 通过、0 失败、3 显式 skip）**、`selfcheck` 6 项通过、格式检查（65 文件）通过；
  仓库根 `typecheck` / `check:format`（2014 文件）/ `processGuards`（2 项）/ `git diff --check` 干净。
  七文件针对性 **217 项**（216 通过、1 显式 skip）；预检 **52 项**（35 → 52，新增 17 个 C3R 回归，先在旧实现上跑出 16 项红）。
  3 个 skip 全部是本机权限所限（Windows 文件型 `symlinkSync` 返回 `EPERM`），其中叶子链接由"空通过"改为**显式 skip**，两个既有 skip 未弱化；
  未执行行为不因计数而算通过。上述门禁已由第十七轮独立确认，但 S1 阻塞整体收口；见 `docs/bios-agent/round17_acceptance.md` 和 C3 实施记录 §8/§9。
- 包内门禁（**S1 接续实施完成时实跑，2026-10-02，待独立复验**）：`typecheck` 通过、
  **407 个测试（404 通过、0 失败、3 显式 skip）**、`selfcheck` 6 项通过、格式检查（66 文件）通过；
  仓库根 `typecheck` / `check:format`（2014 文件）/ `processGuards`（2 项）/ `git diff --check` 干净。
  七文件针对性 **224 项**（223 通过、1 显式 skip）；预检 **59 项**（52 → 59，新增 7 个 S1 回归）。
  真实观察由**独立 Node 子进程**包装 `fs.promises.opendir`/`open` 计数（只计数，不改条目/内容/上限）：
  嵌套 audit（额度 15）由 `observed=18 / reported=16` 转为 `16 / 16`，输出触顶（额度 200）由 `10 / 1` 转为 `10 / 10`。
  junction 创建失败分支同步改为显式 `context.skip`；3 个 skip 仍全部是本机文件型链接权限所限。见 C3 实施记录 §10。
- 包内门禁（**S2 接续实施完成时实跑，2026-10-04，待独立复验**）：`typecheck` 通过、
  **414 个测试（411 通过、0 失败、3 显式 skip）**、`selfcheck` 6 项通过、格式检查（67 文件）通过；
  仓库根 `typecheck` / `check:format`（2014 文件）/ `processGuards`（2 项）/ `git diff --check` 干净。
  七文件针对性 **231 项**（230 通过、1 显式 skip）；列举契约相关（records/registry/remediation/write + preflight）**185 项**（182 通过、3 skip）；预检 **66 项**（59 → 66，新增 7 个 S2 回归）。
  同一独立计量注入"交出 N 条后抛 `EIO`"：A 由 `20 / 16` 转为 `16 / 16`、宽预算 `31 / 27` → `31 / 31`、嵌套 audit `19 / 16` → `16 / 16`、与读取预算组合 `24 / 20` → `24 / 24`。
  新增 `directoryListing.ts`（有界列举的输入/输出契约），`boundary.ts` 609 → 576 行；3 个 skip 仍全部是本机文件型链接权限所限。见 C3 实施记录 §12。
- 包内门禁（**S3 接续实施完成时实跑，2026-10-04，待独立复验**）：`typecheck` 通过、
  **423 个测试（420 通过、0 失败、3 显式 skip）**、`selfcheck` 6 项通过、格式检查（67 文件）通过；
  仓库根 `typecheck` / `check:format`（2014 文件）/ `processGuards`（2 项）/ `git diff --check` 干净。
  七文件针对性 **240 项**（239 通过、1 显式 skip）；列举契约相关五文件 **194 项**（191 通过、3 skip）；预检 **75 项**（66 → 75，新增 1 父 + 8 子 S3 回归）。
  计量代理补齐**完整转发原迭代器 `return()`/`throw()`**（旧代理只转发 `next()`，关闭故障进不了可见出口）与关闭故障注入（`Dir` 构造前包装 `fs.Dir.prototype.close`）。
  真实关闭后注入 `EIO`：额度 15/0/1 由 `17 / 17`、`2 / 2`、`3 / 3` 转为 `16 / 16`、`1 / 1`、`2 / 2`，嵌套 audit `20 / 20` → `16 / 16` 且只列举一个事件目录；宽预算不锁存、取消/句柄、关闭错误×读取预算停止（`24 / 24`、不误锁存）、关闭错误×明细额度停止（`16 / 16`、阻断计数不裁剪）四条对照通过。
  `scan.ts` 409 行略超 400 目标（未超 600 拆分门槛）；3 个 skip 仍全部是本机文件型链接权限所限。见 C3 实施记录 §14。
- 包内门禁（**D1 实施完成时实跑，2026-10-04，待独立验收**）：`typecheck` 通过、
  **516 个测试（513 通过、0 失败、3 显式 skip = 第二十轮 423 + D1 93）**、`selfcheck` 6 项通过、格式检查（77 文件）通过；
  仓库根 `typecheck` / `check:format`（2014 文件）/ `processGuards`（2 项）/ `git diff --check` 干净。
  D1 针对性 `storageBackupManifest` + `storageBackupPayload` **93 项全绿（0 skip）**；新增 `core/storage/backup/`
  七个模块（最大 264 行）；hash/字节一律由测试用 `node:crypto`/`Buffer` 独立重算。
  3 个 skip 仍是既有本机文件型链接权限所限，D1 未删除或弱化任何既有断言。见 `docs/bios-agent/bm02d1_implementation.md`。
- 包内门禁（**D1R＋D2 实施方历史快照，2026-10-04；独立结论见第二十二轮**）：`typecheck` 通过、
  **551 个测试（548 通过、0 失败、3 显式 skip = 第二十轮 423 + D1 93 + D1R 10 + D2 25）**、`selfcheck` 6 项通过、格式检查（83 文件）通过；
  仓库根 `typecheck` / `check:format`（2014 文件）/ `processGuards`（2 项）/ `git diff --check` 干净。
  backup 针对性四文件 **128 项全绿（0 skip）**；受影响旧读取回归（records/registry/preflight）**100 项（98 通过、2 skip）**；
  D2 用真实临时目录与独立 fs/crypto 复核容器（含双进程竞争同一目标、取消、源变化、目标回读复核、预算差一）。
  新增 `core/storage/readBytes.ts`（Boundary 窄方法 `readRawBytes`，`readJson` 未改）。见 `docs/bios-agent/bm02d2_implementation.md`。
- 包内门禁（C2B 实施完成时实跑，2026-10-01；已被第十二轮独立诊断阻塞）：`typecheck` 通过、
  **295 个测试（293 通过、0 失败、2 显式 skip）**、`selfcheck` 6 项通过、格式检查（55 文件）通过；
  仓库根 `typecheck` / `check:format`（2014 文件）/ `processGuards` 通过、`git diff --check` 干净。
  审核持久化针对性 42 项通过（含 **2 个真实子进程崩溃检查点**与 **2 组真实双进程竞争**：
  同 expectedRevision 的写入竞争、恢复竞争）。第十二轮已独立复跑确认，但额外诊断 R1～R4 阻塞；
  独立结论见 `docs/bios-agent/round12_acceptance.md`，实施证据与未测边界见 `docs/bios-agent/bm02c2b_implementation.md`。

`peerDependencies` 里的 `"*"` 只表示"由宿主提供、不要打包"，**不表示**兼容所有 Pi 版本。

## 已知限制

- 只有 `bios_detect_project` 一个工具；**没有任何写知识的工具**（存储写入能力存在，但尚未对模型开放）。
- 存储已有初始化、读取、create/update/registry 写入、协作式跨进程锁，以及**单文件 journal 与崩溃后结果核对**；
  但 C1 **只核对、不重放**：`conflict` 交人工处理，进程崩溃留下的锁需人工确认，且明确**不宣称断电一致性**。
- 审核审计已有工件、写入口和恢复器；完整 v2/输入/硬限额、认领/阶段结果、conflict 绑定及失败清理传播（含 I1）经第十五轮通过声明范围复验；仍不视为生产可用，`operatorLabel` 是声明不是认证。
- 没有通用多文件事务/版本迁移；已有 offline-copy 导出、新根恢复和人工管理 CLI，不承诺在线/网络盘/断电一致性。
- 没有检索、上下文预算与任务交接；Skills 中提到的这些能力当前不可用。
- BM-03 已交付真实临时 Git 工作区的绑定、HEAD/branch 快照与新进程读回；正常流程经第二十八轮通过，但 R28 四组阻塞完整通过。不据此声称覆盖所有 Git linked-worktree/子模块/路径迁移并发或真实客户仓库。
- `tests/fixtures` 尚无样例数据（试点的真实项目资料不可用，样例需自建脱敏）。
- 未验证范围：Linux/macOS、完整干净 clone 的独立工具链、远端 CI、生产构建与安装包、
  真实客户 BIOS 资料试点。
- 最新全量 4 个显式 skip 为文件型 symlink 创建权限所限（3 个既有读取/预检对照＋1 个 manifest 对照）；目录 junction 用例实际执行，未执行行为不计通过。
- 故障注入（`ioHooks`）只用于确定性复现特定分支（`ENOSYS` 发布、`close` 失败、共享冲突、journal 终态失败等），
  **不代表本机磁盘真的发生过这些故障**；"杀进程"测试也**不等于断电实验**。
