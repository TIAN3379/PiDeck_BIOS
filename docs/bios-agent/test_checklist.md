# BIOS Agent MVP 测试清单

更新：2026-10-04。最新 [第二十九轮独立验收](round29_acceptance.md)：Package 732 项（727 通过、0 失败、5 skip）、targeted 309 项（307 通过、2 skip）、旧存储 249 项（246 通过、3 skip）及指定门禁通过。正常项目/经验演示可运行，但 R29 四组额外诊断尚未转永久回归、整批未通过。真实双确认进程已执行，项目 symlink 权限分支已显式 skip。当前回归标准见 [BM-05 批次](bm05_development_plan.md)。下列早期统计和实施方快照不替代本次结论。
**BM-02D1 第二十一轮整体暂未通过**：独立复跑新增 93 项全部通过，Package **516 项（513 通过、0 失败、3 显式 skip）**及指定门禁通过；B1/B2 额外诊断阻塞，不计入永久用例数。
**第二十五轮独立验收**：backup 五文件 **160 项全绿**、旧读取 **100 项（98 通过、2 skip）**、Package **583 项（580 通过、0 失败、3 skip）**及包/根指定门禁通过。R24-1/2 通过，已发现 D2R 整改收口。D1/D1R、C3/C3R 已通过范围保持，UI/Pi 工具/记忆不提前。
**第二十六轮独立实跑（历史）**：backup＋CLI 218 项全绿（207＋11）；Package 641 项（638 通过、0 失败、3 skip）、旧存储 249 项（246 通过、3 skip）、selfcheck 6、包/根指定门禁通过。额外 15 文件 API/CLI 原字节往返和五类新进程 reader 通过，但 R26-1～3 独立复现，整批暂未通过。见 [验收](round26_acceptance.md)；额外诊断不计永久用例数。
第十五轮 I1 关闭、审核持久化整改收口的结论保持。
**348 用例 = 基线 253 + 审核持久化 95（writer 39 + reconcile 52 + contracts 4）**，六文件针对性 165 项通过，
包内类型/格式 56 文件/selfcheck 6 项及根类型/格式 2014 文件/processGuards 2 项通过。
第十五轮额外独立诊断确认正式取消、残留增量、原意图/journal/业务 hash 与事件清单不变；首错元数据传播保持。第十二～十四轮结论保留问题来源，C2A/C2AR 与 C1/C1R 通过范围保持。新增叶子 symlink 在本机权限不足时曾走空通过分支；**C3R 已改为显式 skip 并如实计数**，未执行行为不再计为通过。
本表记录**实际执行**的结果；未执行/未触顶的项显式标注，不把计划中的功能视为已实现。
第八轮发现的 J1～J4 经 C1R 修复后已由第九轮独立复验关闭，新增 14 项含子用例；journal 针对性 37 项全绿。第六轮独立基线 140 用例，BR 的 W1～W4 已由第七轮独立关闭。

最新独立实跑见 [第二十九轮验收](round29_acceptance.md)：Package **732 项（727 通过、0 失败、5 显式 skip）**，backup＋CLI＋memory＋project＋knowledge targeted **309 项（307 通过、2 skip）**、旧存储 249 项（246 通过、3 skip）、包类型/格式 132 文件、selfcheck 6 项、根类型/格式 2014 文件、processGuards 2 项及 `git diff --check` 通过。R28 原诊断已有永久回归，R28-1/2/4 核心修复通过；不据此宣布 R28-3 完全关闭，其关系范围剩余项归 R29-4。新增独立诊断 R29-1～4 尚未转永久回归。BM-04 新增 `knowledgeService` 7、`experienceScenario` 3、`projectWriteFacts` 5 项；`projectBinding` 12、`projectCli` 7、`memoryDecisions` 26，memory 合计 29 项（含 PXE 场景 3 项）。项目 symlink 分支在本机为显式 skip（`EPERM`），确认竞争已执行两个真实 Node 子进程。实施方快照保留在 [BM-04 实施记录 §4](bm04_implementation.md#4-整批门禁实施方实跑)，上一轮 711 项基线见 [第二十八轮验收](round28_acceptance.md)。
C2B/C2BR 的 API、状态/取消/清理表与真实进程证据见 [C2B 实施记录](bm02c2b_implementation.md)（**§12 是 I1 修正后的唯一有效描述**，§10/§11 为前两轮快照）；完成标准见 [C2BR2 §6](bm02c2br2_development_plan.md#6-当前唯一接续任务i1)，原标准见 [C2B 方案](bm02c2b_development_plan.md) 与 [C2BR 原标准](bm02c2b_remediation_plan.md)；
C2AR 的红绿说明、协议条款与未测边界见 [C2A 实施记录](bm02c2a_implementation.md) §3/§6，完成标准见 [C2AR 整改方案](bm02c2a_remediation_plan.md)；
C1R 的红绿证据、约定与未测边界见 [BM-02C1 实施记录](bm02c1_implementation.md) 第 6 节；
原协议见 [C1 方案](bm02c1_development_plan.md)。BR/B0 已通过，旧实施记录不替代最新结论。

## 功能测试

| 测试项 | 操作步骤 | 预期结果 | 实际结果 | 状态 |
|---|---|---|---|---|
| Package 加载 | SDK 装载唯一入口、检查工具清单 | 只注册 bios_detect_project | 符合，已自动化 | 通过 |
| CLI/RPC Skills | 临时 cwd/agent 配置、离线 get_commands | 两个 BIOS Skills 可见 | 符合，宿主技能隔离断言通过 | 通过 |
| 只读线索扫描 | 自建临时 DSC/INF/ASL、忽略目录 | 返回线索和 unknown/缺口，不读正文 | 符合 | 通过 |
| 多工作区契约 | 同档案放两份 VCS 快照/无 Git 绑定 | 能独立表达 branch/HEAD/状态 | schema 用例通过；**BM-03 已实现真实绑定**：`projectBinding` 用真实仓库 + worktree + detached HEAD 对照，两个工作区各自入档互不冒充 | 通过 |
| 项目绑定与打开 | 新/已有项目绑定、重复执行、路径迁移、越权路径 | 显式身份、幂等、不一致可解释、被拒时不触碰知识库 | `projectBinding` 9 项全绿（含 registry 文件 hash 对照） | 通过 |
| 有限检测候选 | 合成 EDK II DSC/DEC，改文件内容后重测 | 候选来自真实内容、落点正确、证据 hash 可独立核对、检测不写档案 | `projectDetectionView` 覆盖；平台名只进 `buildTargets`，板名留在缺口 | 通过 |
| 人工确认与 CAS | 正常确认、相同值、过期 revision、双进程竞争 | 只改被点名字段、冲突不写、失败方不留半截写入 | `projectBinding`/`projectCli` 覆盖，含原字节 hash 对照与退出码 4 | 通过 |
| 每工作区快照与证据复验 | 真实 Git 仓库、detached HEAD、改文件、超预算、取消 | 分别采集、非 Git 省略 vcs、变化/缺失显式可见、预算如实 | `projectBinding`/`projectDetectionView` 覆盖 | 通过 |
| M1 消费视图 | 档案字段 + 检测候选 + 证据复验 + HEAD 变化 | 确认值/新候选/陈旧证据可解释，确认值不被覆盖 | `projectDetectionView` + `projectScenario` 覆盖 | 通过 |
| 人工 CLI | 子进程跑 bind/detect/confirm/refresh/read | 显式路径、写确认、JSON 单对象、退出码分类 | `projectCli` 5 项；演示 `cli/project-scenario.mjs` 10 步全过 | 通过 |
| 空库初始化 | 空目录执行 `initializeKnowledgeStore` | 创建布局 + 合法空 registry，revision=0 | 6 个布局目录与 registry 均创建 | 通过 |
| 重复初始化 | 对已初始化根再次初始化（含不同 `now`） | 返回 existing，**registry 原字节不变** | hash 相同、createdAt/revision 未重置 | 通过 |
| 新进程读取 | 真实 `spawn` 子进程读取同一知识根 | schemaVersion/revision/createdAt 与初始化一致 | 空 registry 头字段一致；**非空 fixture**（含 registry 绑定 + 项目档案 + 任务）ID/revision 一致 | 通过 |
| 两进程同时初始化 | 真实 `spawn` ×2 并发首建 | 不产生半文件、不互相覆盖 | 第五轮完整 Package 测试实际复跑既有双子进程用例通过；**wx 回退已删除**（S1 关闭） | 通过 |
| 五类记录读取 | 按 kind+ID 写入并读回 | 类型、路径、字节数与内容一致 | 五类均通过 | 通过 |
| 有界列表 | 5 条记录 + 1 条损坏 | 摘要返回、损坏进 `problems`、预算截断可见 | 正常条数/扫描预算通过；异常输出预算已修（S4 关闭，`problems` 计预算、`droppedProblems` 可见） | 通过 |
| 项目内记录列表 | 两项目任务及 A 目录内放 B 内容 | 不能将错项目任务当成当前记录 | 单条拒绝 + 列表只进 `problems`（S2 关闭） | 通过 |
| 绑定解析 | 路径/项目/桌面 ID、矛盾组合与多工作区 | 缺失与冲突可解释，不任取检出 | 常规通过；重复 `biosProjectId`、矛盾条件、多工作区歧义均明确返回（S5 关闭） | 通过 |
| 五类记录写入（BM-02B） | 五类各做 create→update，再用真实 `spawn` 子进程读回 | revision 0→1、ID/归属/createdAt 不变、路径一致、新进程可读 | 五类共 5 个子用例 + 1 次子进程读取全部通过；`updatedAt` 不倒退 | 通过 |
| registry 单文件更新（BM-02B） | `updateRegistry` 0→1；空 `projects`；已有档案在场 | 绑定生效、`createdAt` 不变、不改写也不创建档案 | revision 0→1→2；档案 hash 不变、无新建档案 | 通过 |
| revision 乐观并发（BM-02B/02BR） | 旧 revision / update 目标缺失 / create 目标已存在 / 非法或 null-in-update / 记录与 registry 溢出 / create 传数字 / 非安全整数 | 明确拒绝，原字节不变 | 既有用例通过；BM-02BR 补齐 registry 溢出、`unsafe-current-revision` 与 `expectedRevision` 非安全整数（W1 关闭） | 通过 |
| 跨进程更新竞争（BM-02B） | 真实 `spawn` ×2，同 `expectedRevision`，用会合点同时起跑 | 恰好一方提交、另一方冲突，内容与赢家一致 | 赢家 revision 1，输家 `expected=0/actual=1`；无残留锁/临时文件 | 通过 |
| 跨进程创建竞争（BM-02B） | 真实 `spawn` ×2 创建同一 ID | 仅一方 `created`，另一方冲突且不覆盖 | 赢家 revision 0，输家 `expected=null/actual=0`，内容为赢家 | 通过 |
| 提交窗口可见性（BM-02B） | 在 `rename` 之前真的读一次（临时文件已写完） | 读者只见旧完整记录，窗口内恰有 1 个同目录临时文件 | 旧 revision/旧内容；目标 hash 不变；临时文件同目录且不叫目标名 | 通过 |
| 真实并发反复读写（BM-02B） | 子进程读 60 次，同时主进程串行更新 15 次 | 无半 JSON/空文件，revision 单调不减 | 0 错误，revision 单调不减且最大 ≥1，最终 =15 | 通过 |
| 跨进程锁行为（BM-02B） | 他人持锁下更新：超时 / 取消；失败路径释放；`ownerId` 不匹配释放；损坏/缺失元数据锁 | 超时 `lock-timeout`、取消 `cancelled`、只删自己的锁、不抢占 | 四种场景均符合；失败路径锁目录为空 | 通过 |

## 第六轮额外边界诊断 → BM-02BR 永久回归对照

第六轮独立诊断的 7 项**未通过**项已逐条改为永久回归；下表是"诊断 → 回归用例 → 当前结果"的对照：

| 项 | 第六轮独立诊断 | 现在的永久回归（`tests/storageWrite.test.mjs`） | 当前结果 |
|---|---|---|---|
| W1 / P1 | registry 在 MAX_SAFE_INTEGER 连续更新 | 「W1：registry 达到 MAX_SAFE_INTEGER 时拒绝递增」「W1：已不安全 revision 的记录与 registry 都拒绝递增」 | 拒绝递增（`revision-overflow` / `unsafe-current-revision`），原字节不变 |
| W2 / P2 | 已持锁，timeout=NaN | 「W2：非法锁时序参数在入口结构化拒绝…」 | `invalid-limits`，不取锁不等待 |
| W2 / P2 | 锁元数据 createdAt=1e100 | 「W2：极端/损坏的锁元数据只按忙碌处理…」 | 有界 `lock-timeout`，无 RangeError、不抢占 |
| W2 / P2 | timeout=0，lock-read 期间 abort | 「W2：等待读锁诊断期间取消优先于超时…」 | `cancelled`（新增「W2：timeout=0 只尝试一次…」固定"尝试 1 次"语义） |
| W2 / P2 | 合法 poll 远大于 timeout（交接时补充诊断） | 「W2：合法但超长的 poll 不得让等待越过 timeout 预算」 | 10ms 预算内收场（修复前实测 1192ms 红） |
| W3 / P2 | 实际关闭临时句柄后注入 close EIO | 「W3：准备阶段 close 失败必须中止提交…」+「R3：临时文件句柄在正常/失败/取消路径都被显式关闭」 | 中止提交、`fd === -1`、无残留 |
| W3 / P2 | revision 冲突 + `lock-remove` EIO（交接时补充诊断） | 「W3：失败路径上的自有锁释放失败必须作为附加诊断…」等 3 条 | 保留原错码，附加上界诊断 |
| W3 计划偏差 | 核对 create 提交原语 | 「W3：create 是非覆盖发布——提交窗口内目标出现则冲突而非覆盖」「R3：create 记录时硬链接不被支持…」 | create 走 `link` 非覆盖发布，不支持即 `publish-unsupported` |
| W4 / P2 | registry 为坏 JSON，再新建 feature | 「W4：registry 损坏 / 未来版本 / 绑定冲突 / 目录时拒绝写入…」「W4：先有合法记录，registry 随后损坏时 update 拒绝…」 | 四类场景均拒绝，且既有记录与 registry 原 hash 不变 |

上述第六轮诊断均只操作临时合成库，当时已清理（含独立进程的 IO 包装还原），不污染包内测试。

## 异常测试

| 异常场景 | 触发方式 | 预期处理 | 实际结果 | 状态 |
|---|---|---|---|---|
| 大目录取消 | 400 项 fixture，调用后 abort | ProbeCancelledError | 既有用例通过 | 通过 |
| 小/空目录及工具层取消（F3） | 调用后立即 abort，条目不足 yieldEvery | cancelled，不返回成功 | 三类回归均拒绝 | 通过 |
| 取消的资源清理（G1） | opendir 期间立即 abort，检查句柄状态 | 拒绝前关闭，不需 GC 兜底 | 句柄 open/close 计数相等；子进程 GC 诊断无句柄警告 | 通过 |
| 路径/深度预算 | 低预算扫描 fixture | 截断原因可见 | 既有用例通过 | 通过 |
| 普通根外/junction 逃逸 | targetDir 指向根外或根内 junction | 授权失败，无线索返回 | 本机实际执行通过，无跳过 | 通过 |
| 相对额外授权根（F4） | 进程/会话 cwd 不同，额外根为 . | 配置拒绝，不自动扩权 | 非法配置拒绝；不可达合法根单列、realpath 去重 | 通过 |
| 告警预算触顶 | 超过 MAX_PROBE_WARNINGS 个不可读子目录 | 计数丢弃告警、截断可见 | 源码落实；用例仅验证初值/不变量，未实际触顶 | 部分验证 |
| RPC 超时 | 1ms 启动超时 | 终止子进程并报错 | 自动化通过（封装补 stderr 上限、close 收尾） | 通过 |
| 根内目录链接逃逸（存储） | 把 `experiences/` 换成指向根外的 junction | 读取拒绝，根外文件字节不变 | 目录 junction 成功创建；拒绝为 symlink-rejected，sentinel hash 不变 | 通过 |
| 最终文件链接逃逸（存储） | 记录文件本身是 file symlink | 读取拒绝 | **本机 EPERM（需管理员/开发者模式），显式 skip 并记录原因** | 未测 |
| 损坏 registry | 写入非法 JSON 后初始化/读取 | 拒绝且原字节不变 | `invalid-json`，hash 不变 | 通过 |
| 未来版本 registry / 记录 | schemaVersion+1 / +5 | 拒绝且原字节不变 | `unsupported-schema-version`，hash 不变 | 通过 |
| 超大 registry / 记录 | 注入更小字节预算 | 拒绝，不物化正文 | `too-large`（分块读到 EOF 或上限 +1；`stat` 仅预检） | 通过 |
| 记录 ID / 项目不匹配 | 文件内容 ID 与路径 ID 不同；任务 projectId 与目录不同 | 拒绝 | `record-id-mismatch` 两条 | 通过 |
| 非法记录 ID | `../escape`、`con`、`exp.`、`Exp`、`a/b`、缺 projectId | 派生路径前拒绝 | `invalid-record` | 通过 |
| 记录不存在 / 非文件 | 不存在 ID；记录路径是目录 | 明确区分 | `not-found` / `not-a-file` | 通过 |
| 取消（存储） | 已 abort 的 signal 调 readRecord/listRecords | 立即失败 | `cancelled` | 通过 |
| 真实权限失败（存储） | 制造 EACCES | `permission-denied` | 真实 EACCES 未在本机造出；**发布链接注入 EACCES 已覆盖**（AR-1） | 部分通过 |
| 硬链接不可用的回退（S1） | 注入 ENOSYS，暂停最终目标写入 | 不可见半目标或明确拒绝 | **回退已删除**：`publish-unsupported`，目标不存在、无 `.tmp` 残留 | 通过 |
| 发布窗口不可见半文件（S1） | `beforeIo("link")` 时检查目标 | 读者只能看到缺失 | 目标必为 ENOENT，恰有 1 个完整临时文件 | 通过 |
| 读取中增长（S3） | 注入过期 `stat`（报告 2 字节） | 超限/变化拒绝，不解析前缀 | 超限 → `too-large`；合法前缀 + 尾巴 → `invalid-json`；正常读取 `bytes` = 真实字节 | 通过 |
| 各 IO 点取消（S3） | EOF read 前 abort；opendir 后 abort；列表末条 abort；初始化竞争等待 abort | 整体 cancelled | 四条均 `cancelled`，不进入 `problems`、不改写成 `init-race` | 通过 |
| 发布调用级/提交前取消（S3 剩余，B0） | 已取消 callSignal；`boundary.signal`；`beforeIo(link)` 等待时 abort；link 成功后迟到 abort | 提交前拒绝且不创建目标；提交后如实报告 | **已修复**：两处 signal 任一取消都在提交前拒绝；钩子等待期间取消不再创建目标；迟到取消仍返回真实 `created`（3 条永久回归） | 通过 |
| 列表单条非法文件名（S4） | experiences/Exp.json + 损坏 + 非 .json | 单条 problems，不整体崩溃 | 合法记录照常返回；`invalid-record`/`invalid-json` 进 `problems`；非 .json 计入 `skippedEntries` | 通过 |
| 列表异常输出预算（S4） | 6 条坏 JSON，`maxListProblems:1` / `maxListBytes:300` | 异常输出也有界，截断可见 | 问题数受限，`truncatedBy` 含 `problems`/`bytes`，`droppedProblems > 0` | 通过 |
| 非法限额（S4） | `NaN`/`Infinity`/`-1`/`1.5`；显式 `undefined` | 非法结构化拒绝、undefined 保留默认、默认对象不被污染 | `invalid-limits`；默认对象不变 | 通过 |
| 临时写/sync/rename 故障注入（B3） | 在 `write-temp`/`sync`/`rename` 注入 `EIO` | 拒绝、原字节不变、无临时文件残留、句柄已关闭 | 三者均 `permission-denied`（`rename` 注入点按原样抛出）；hash 不变、0 残留；随后同路径可正常提交 | 通过 |
| 提交前取消（B3） | 在 `rename` 之前 abort | `cancelled`、原字节不变、清理临时文件、释放锁 | 符合；随后同路径可正常提交 | 通过 |
| 提交后迟到取消 + 释放失败（B3） | `rename` 之后 abort，并注入锁目录删不掉 | 仍报告真实 `updated`；释放失败如实上报不吞掉 | `status=updated`、`revision=1`、`lockRelease=failed`、内容与磁盘一致；残留锁需人工清理（不抢占自愈） | 通过 |
| 锁超时/取消（B2） | 他人持锁时 `lockTimeoutMs=120`；等待中 abort | `lock-timeout`（含 `ownerId`）/`cancelled`，不写目标、不删他人锁 | 两种均符合；目标 hash 不变、无临时文件、他人锁目录仍在 | 通过 |
| 不删他人锁/坏元数据（B2） | 释放前替换 `ownerId`；`owner.json` 写成半个 JSON / 删除 | `not-owner`/`missing` 且不删除；坏元数据按忙碌超时 | 均符合；锁目录保留、目标字节不变 | 通过 |
| 非法 kind/托管字段/跨项目档案（BM-02B） | 未知 kind；`data` 里带 `revision`；只读类记录传 `projectId`；档案 `projectId`≠`id`；任务缺 `projectId` | 写文件前结构化拒绝，不取锁不落盘 | `invalid-record`（`unknown-record-kind`/`managed-key-in-body`/`unexpected-project-id`/`missing-project-id`）与 `record-id-mismatch`；锁目录空、记录目录空 | 通过 |
| 超限写入（BM-02B） | 注入 `maxRecordBytes: 4096`，正文 64 KiB | 拒绝且不创建目标 | `too-large`；目标不存在、无残留；默认预算下同一正文可正常落盘 | 通过 |
| 未初始化写入（BM-02B） | 只建空目录就 `createRecord`/`updateRecord` | 拒绝且不产生半初始化目录树 | `not-found`（`store-not-initialized`）；未创建记录目录 | 通过 |
| 根内目录链接逃逸（写入） | 初始化后把 `experiences/` 换成根外 junction 再写入 | 拒绝写入，根外内容不变 | `symlink-rejected`；根外目录仍只有 sentinel、锁目录空 | 通过 |
| registry 链接逃逸（W4） | 把 `registry.json` 换成根外目录 junction / 文件 symlink | 普通 create/update 拒绝，根外 sentinel 不变 | junction 子用例本机实跑通过（`symlink-rejected`）；文件 symlink 子用例 EPERM 显式 skip | 部分通过（1 子用例未测） |
| 安全 revision（W1） | `expectedRevision` 传 `NaN`/`Infinity`/`2^53`/小数；当前 revision 已是 `2^53`；registry 达 `MAX_SAFE_INTEGER` | 结构化拒绝且原字节不变、不落盘不留锁 | 记录与 registry 共用同一套判定（`invalid-expected-revision`/`unsafe-current-revision`/`revision-overflow`） | 通过 |
| 锁等待预算（W2） | 他人持锁，`timeoutMs=10` + `pollMs=1000`（合法但失配）；`timeoutMs=0` | 落在预算附近超时、只尝试一次、不抢占 | 修复前实等约 1192ms（红）→ 修复后 `< 500ms`；`timeout=0` 消息含"尝试 1 次" | 通过 |
| 失败路径锁释放诊断（W3） | 原错误（revision 冲突）+ `lock-remove` EIO / 元数据被改写 / 元数据不可读 | 保留原 `code`/`expected`/`actual`，附加有界诊断，不删他人锁 | 三种清理状态均附加固定文案，锁目录如实保留；后续人工清理 | 通过 |
| create 发布故障面（W3/R3） | 记录 create：硬链接 `ENOSYS`；发布等待期间取消；发布成功后迟到取消 | 不支持即明确失败不回退；取消不留目标；迟到取消不假称回滚 | `publish-unsupported`（只试一次 link）/ `cancelled` 无残留 / 真实 `created` 且内容保留 | 通过 |
| 临时句柄生命周期（R3） | 正常提交、`sync` 失败、打开后取消、`close` 先关后抛、`open` 前失败 | 所有已创建句柄都被显式关闭，不依赖 GC | 捕获真实 `FileHandle` 断言 `fd === -1`；`open` 前失败时 `closeFile` 调用 0 次 | 通过 |
| 替换重试预算（R3） | `rename` 连续 `EBUSY` 3 次后放行；始终失败；退避期间取消 | 重试次数如实上报；最终失败落在标称预算附近；取消立即生效 | 4 次尝试成功；始终失败恰好 12 次约 2.2s 后 `permission-denied`；取消 `< 1s` 返回 `cancelled` | 通过 |

## 数据测试

| 数据场景 | 输入数据 | 预期结果 | 实际结果 | 状态 |
|---|---|---|---|---|
| schemaVersion/必填/枚举 | 空对象、未来版本、错误枚举 | 拒绝并返回结构化错误 | 既有契约用例通过 | 通过 |
| 保留主名带后缀（F1） | con.json、nul.x、com1.foo | schema/运行时/路径全拒绝 | 共享规则回归通过 | 通过 |
| 默认知识根 | 无 override/env | 用户级目录，不依赖 D 盘 | 当前用户目录下 BIOS_Knowledge | 通过 |
| 普通相对配置根 | knowledge、./relative | 拒绝 | 主解析入口拒绝 | 通过 |
| Windows 无盘符根（F2） | 根相对及盘符相对输入 | 完全限定根要求，不依赖进程盘符 | 实际 Windows 入口拒绝；纯平台判定用例通过 | 通过 |
| paths 入口相对根（F2） | 字符串/对象 root=knowledge | 统一拒绝 | 两入口拒绝；合法根统一规范化 | 通过 |
| 合法 ..cache | 根内 ..cache 目录 | 不被误判为父目录逃逸 | 布局/授权回归通过 | 通过 |
| registry 绑定冲突 | 两个项目绑同一工作区路径 | 冲突，不随便挑一个 | `binding-conflict` 且原字节不变 | 通过 |
| 绑定边界 | 同项目两个 worktree；无桌面 ID | 各自可解析、不互相覆盖 | 两个 workspaceId 独立解析 | 通过 |
| 持久化/冲突（更新，BM-02B） | 五类 create→update；两子进程同 revision 竞争；并发读写 60 次 | revision 单调、内容完整、冲突可解释 | 见功能表四行：revision 0→1、恰好一方提交、0 错误且单调不减 | 通过 |
| 归属不可伪造（BM-02B） | 正文里注入 `projectId`/`targetProjectId`/`id`/`revision`；档案传不匹配 `projectId` | 由参数与路径决定，正文不可覆盖 | `invalid-record`（托管键）/`record-id-mismatch`；子进程读回的归属等于传入参数 | 通过 |
| 恢复/迁移（BM-02C/D） | journal、审核审计、只读预检、备份恢复、版本迁移 | 故障注入可恢复、审计一致、预检只读有界 | C1/C1R、审核 IO、C3/C3R、D1/D1R 已通过声明范围；D2R 已发现整改收口；D3/D4 经第二十七轮通过本机离线范围，R26-1～3 关闭；实际迁移仍未实现 | 部分完成 |

## UI 与真实平台测试

- BIOS 专业 UI 尚未实现；本轮没有修改桌面业务代码，不记为 UI 验收通过。
- 尚无获授权真实 BIOS 试点；不能凭 fixture 宣称 AMI/Insyde/国产 IBV 或任何芯片代际支持。
- 安装版加载、重启工程记忆、经验复用闭环、备份恢复待相应阶段实现后验证。

## 兼容性与回归

| 环境/门禁 | 实际结果 | 状态 |
|---|---|---|
| Windows + Node 24.14.1 + Pi 0.87.1 | Package **220 用例：218 通过 / 0 失败 / 2 显式 skip**（两个 skip 均为文件型符号链接权限）= BR 基线 183 + C1 23 + C1R 14；journal 37 项全部通过 | 第九轮独立复跑通过，独立诊断确认 J1～J4 关闭；skip 不算通过 |
| Windows + Node 24.14.1 + Pi 0.87.1（C2A） | Package **235 用例：233 通过 / 0 失败 / 2 显式 skip** = C1R 基线 220 + 审核契约 15；审核契约针对性 15 项全绿 | 第十轮独立复跑通过（契约/校验主体）；当时协议 A1～A3 未通过 |
| Windows + Node 24.14.1 + Pi 0.87.1（C2AR） | Package **253 用例：251 通过 / 0 失败 / 2 显式 skip** = C2A 基线 235 + 审核契约 +2 + 关联 16；两个审核文件共 33 项全绿 | **第十一轮独立复跑通过（协议与纯校验范围）**；本轮无审核 IO |
| Windows + Node 24.14.1 + Pi 0.87.1（C2B） | Package **295 用例：293 通过 / 0 失败 / 2 显式 skip** = C2AR 基线 253 + 审核持久化 42；审核/journal/IO 五文件合跑通过 | **第十二轮整体未通过**（R1～R4 独立诊断阻塞）；实施方实跑不能替代独立结论 |
| Windows + Node 24.14.1 + Pi 0.87.1（C2BR） | Package **326 用例：324 通过 / 0 失败 / 2 显式 skip** = C2B 基线 295 + 审核持久化整改（42 → 73）；六个文件合跑 143 项全绿 | **第十三轮独立复跑确认，整体未通过**；含 2 个 writer 崩溃检查点、**1 个真实 recovery 二次中断**与 2 组真实进程竞争；F1/F2 曾待补 |
| Windows + Node 24.14.1 + Pi 0.87.1（C2BR2） | Package **343 用例：341 通过 / 0 失败 / 2 显式 skip** = C2BR 基线 326 + F1/F2 回归 17；六个文件合跑 160 项全绿 | **第十四轮独立复跑确认**；F1 与 F2 主路径通过，当时 I1 未覆盖 |
| Windows + Node 24.14.1 + Pi 0.87.1（C2BR2 / I1） | Package **348 用例：346 通过 / 0 失败 / 2 显式 skip** = C2BR2 基线 343 + I1 回归 5；六个文件合跑 165 项全绿 | **第十五轮独立复跑确认，I1 关闭**；既有回归保持 |
| Package 类型/格式/selfcheck | 类型通过、格式 56 文件、selfcheck 6 项通过（含存储离线演示） | 通过（第十五轮独立复跑） |
| Windows + Node 24.14.1 + Pi 0.87.1（BM-02C3） | Package **383 用例：381 通过 / 0 失败 / 2 显式 skip** = C2BR2 基线 348 + 预检 35；七文件针对性 **200 项**全绿 | 第十六轮独立确认测试结果；整体暂未通过，PF-1～PF-4 待关闭。叶子链接环境不适用不是行为通过 |
| Package 类型/格式/selfcheck（C3） | 类型通过、格式 **64 文件**、selfcheck 6 项通过 | 通过（第十六轮独立复跑） |
| Windows + Node 24.14.1 + Pi 0.87.1（BM-02C3R） | Package **400 项：397 通过 / 0 失败 / 3 skip**；七文件 **217 项**（216 通过、1 skip） | 第十七轮独立确认；PF-1～PF-3 关闭，PF-4 剩 S1。第 3 个 skip 是本机文件 symlink 权限限制，不是行为通过 |
| Package 类型/格式/selfcheck（C3R） | 类型通过、格式 **65 文件**、selfcheck 6 项通过 | 通过（第十七轮独立复跑） |
| Windows + Node 24.14.1 + Pi 0.87.1（BM-02C3R-S1） | Package **407 项：404 通过 / 0 失败 / 3 skip** = 第十七轮 400 + S1 回归 7；七文件 **224 项**（223 通过、1 skip） | **第十八轮独立确认成功列举范围通过**；A=16/16、B=10/10；失败出口 S2 尚未修复 |
| Package 类型/格式/selfcheck（S1） | 类型通过、格式 **66 文件**、selfcheck 6 项通过 | 通过（第十八轮独立复跑） |
| Windows + Node 24.14.1 + Pi 0.87.1（BM-02C3R-S2） | Package **414 项：411 通过 / 0 失败 / 3 skip** = 第十八轮 407 + S2 回归 7；七文件 **231 项**（230 通过、1 skip）；列举契约相关 185 项（182 通过、3 skip） | **第十九轮原漏计通过**；A=16/16，宽预算/嵌套/读取组合永久回归保持；S3 全局停止遗漏不在此通过范围 |
| Package 类型/格式/selfcheck（S2） | 类型通过、格式 **67 文件**、selfcheck 6 项通过 | 通过（第十九轮独立复跑；新增 `directoryListing.ts`） |
| 第十九轮额外关闭故障诊断（S3，修前） | 真实关闭后注入 EIO；额度 15/0/1 | **未通过（已定位）**：实际/报告 17/2/3，均多一次超限探测；hash 不变、受控错误可见。计量 helper 未转发 `return()`，关闭故障进不了可见出口，为永久红回归的来源 |
| Windows + Node 24.14.1（BM-02C3R-S3） | Package **423项：420通过/0失败/3skip**；七文件240项（239通过/1skip）；五文件194项（191通过/3skip） | **第二十轮独立通过声明范围**：原关闭故障16/16、1/1、2/2，无后续扫描IO；嵌套/读取/明细/取消对照保持 |
| Package 类型/格式/selfcheck（S3） | 类型通过、格式67文件、selfcheck6项通过 | 通过（第二十轮独立复跑） |
| Windows + Node 24.14.1（BM-02D1，实施方） | D1 针对性 **93 项：93 通过 / 0 失败 / 0 skip**（清单 70 + payload 23）；Package **516 项：513 通过 / 0 失败 / 3 显式 skip** = 第二十轮 423 + D1 93 | **实施完成、待独立验收**：见证 §「D1 备份协议」条目；三项 skip 为既有本机链接权限限制，D1 新增用例无 skip |
| Package 类型/格式/selfcheck（D1） | 类型通过、格式 **77 文件**、selfcheck 6 项通过 | 通过（实施方实跑；新增 `core/storage/backup/`） |
| 第二十一轮独立复跑（D1） | backup 93 项全绿；Package 516 项/513 通过/0 失败/3 权限 skip；包/根指定门禁通过 | 门禁通过，整体被额外 B1/B2 阻塞；不等于 D1 验收通过 |
| 第二十一轮额外 B1/B2 诊断 | 两字节伪装一字节错误成功；假视图抛原始异常；排除数组实际遍历 100,001 项 | 已独立复现，永久回归及修复待 D1R；不计入 516 项 |
| 根类型/格式/processGuards | 类型通过、格式 2014 文件通过、守卫 2 项通过；`git diff --check` 通过 | 通过 |
| Linux/macOS | 未运行本轮 Package 验收 | 未测 |
| 干净 clone/独立 Package 工具链 | 未完成安装验证；README 已写清先装根依赖再装 Package，tsc/Biome 来自根 | 未测 |
| GitHub Actions | 已有 Package 步骤，本次未执行远端流水线 | 未测 |
| 根全量测试/生产构建/安装包 | 本次无跨域业务改动，未执行 | 未测 |

## 测试结论

- G1 已闭环：句柄生命周期有确定性断言（open/close 计数），并有子进程 GC 诊断复现验收方的观察方式。
- 第六轮独立复跑：140 用例中 139 通过、1 文件符号链接权限 skip；新增 3 条 B0 和 30 个写入用例通过，BM-02AR/B0 已闭环。
- 第七轮独立复跑：**183 用例：181 通过、0 失败、2 个文件符号链接权限 skip**；W1～W4/R1～R4 关闭，可进入 C1 开发，不等于整个生产知识系统已经就绪。
- 修复过程一律"先红后绿"：锁等待越过预算（修复前实测 1192ms）、失败路径锁释放诊断缺失、
  `exists` + 清理失败组合吞掉残留诊断，三条都先有失败回归再改代码。
- “预先取消通过”不等于中途取消通过，“正常文件预算通过”不等于错误输出预算通过，“最终 JSON 完整”不等于发布窗口不可见半文件——三类窗口都有确定性回归（受控 IO 故障注入，不代表本机磁盘真的发生过对应故障）。
- 两点“取消语义”区分保持不变：**提交前的取消必须生效**（写入属新增状态），**释放锁的清理必须免疫取消**（锁没有回收器，取消若阻止清理会把目标永久锁死），两者各自有断言。
- 仍**未测**：真实 EACCES 与真实 `EBUSY` 重命名竞争（注入 `EIO`/`EBUSY` 只覆盖分支）、告警上限实际触顶、跨平台（Linux/macOS）、干净 clone 独立工具链、远端 CI、生产构建与安装包、真实客户 BIOS 试点；文件型符号链接在本机因权限显式 skip（目录 junction 用例实际执行、未跳过）。
- 已**不适用**：普通记录并发更新、双子进程初始化（均已有真实多进程证据）。
- 第八轮独立复跑确认：**206 用例：204 通过、0 失败、2 个文件符号链接权限 skip**；
  新增 23 条全部在 `tests/storageJournal.test.mjs`：记账内容与真实字节指纹、prepared 先于数据、
  prepared 发布失败、提交前失败/取消的 aborted 语义、提交后终态失败与迟到取消的 needs-recovery、
  inspect 的只读/有界/0 预算/取消穿透、reconcile 的 committed/aborted/conflict/unreadable/busy、
  旧 prepared 不覆盖后续更新、两个真实进程并发核对、**真实子进程在 4 个检查点被终止后的新进程核对**。
- C1 的三条关键断言（最容易写错、也最难事后发现）：`before.hash` 来自**磁盘真实字节**（改过空白的旧文件也不受影响）；
  **数据提交点 = `link`/`rename` 成功**（记账失败只报 `needs-recovery`，绝不改成"未提交"）；
  **恢复只核对不重放**（`conflict` 只报告，遗留锁 `busy` 不抢）。
- C1 侧仍**未测**：断电实验（`SIGKILL` ≠ 掉电）、Linux/macOS、真实客户试点、无人值守的遗留锁回收（明确未实现）。
- 第九轮（C1R 实施方实跑，针对第八轮 J1～J4）：**220 用例：218 通过、0 失败、2 个文件符号链接权限 skip**；
  新增 14 条全部在 `tests/storageJournal.test.mjs`，且**先红后绿**（13 红 1 绿，绿的那条是返回值路径锁残留警告的不回归守卫）：
  J1 持锁期间换目标（含只换 projectId）、J2 目标版本/结构/身份/归属/绑定非法（含"非法目标真实 hash 恰等于 after"）、
  J3 抛错与返回值两条路径的释放诊断 + 终态失败/成功收口的清理诊断、J4 候选数组真实 UTF-8 字节预算（300 字节复现、
  恰好够/少一字节、多条合计触顶、较长合法 ID、0 预算）。
- C1R 的三条关键约定：**预算只约束 `pending` 数组的序列化字节**（不是整个返回对象）；
  **校验与哈希必须来自同一次有界读取**（解释规则复用 `interpretRecord` / `interpretRegistryValue`）；
  **首错优先**（清理失败只作附加诊断，不假装已删锁）。
- 第九轮独立复跑确认上述 220 项/37 项和所有规定门禁；另用合成临时根复查 J1～J4、非法目标 revision/hash 同时匹配、非法 registry 和 0/1/2/300/精确边界，全部符合预期。独立诊断不计入永久测试数。
- 第十轮（C2A 实施方实跑）：**235 用例：233 通过、0 失败、2 个文件符号链接权限 skip**；
  新增 15 条全部在 `tests/auditContracts.test.mjs`：合法样例与"不修改输入"、版本闸门（未知版本只报一条）、
  未知字段脱敏（不回显字段名/值）、UUID 与 recordId、动作↔状态对逐条对照、revision 关系与溢出、时间先后、
  标签/理由的字符与 **UTF-8 字节**双预算、证据形态互斥与总字节、"分项之和 ≤ 总量"不变式、
  序列化口径与循环引用、路径脱敏、恶意大输入的诊断有界、既有契约（五类记录 / schemaVersion / journalVersion）不变。
- C2A 的三条关键约定：**分层拒绝**（越界数值由 schema 拒、关系与溢出由语义层拒）；
  **每条字节/数量规则必须可达**（`字节上限 < 3 × 字符上限`，总量上限例外并有不变式测试）；
  **纯契约无 IO**（本轮不建审计目录、不写文件、不做身份认证）。
- 第十轮独立复跑确认 235 项/审核契约 15 项和全部指定门禁；额外 97 个纯数据断言通过，控制字符合法事件实测 12,593 字节。事件校验主体通过，但原协议 A1～A3 阻塞，不将纯测试全绿视为审核恢复已实现或协议已正确。
- 第十一轮（C2AR 实施方实跑）：**253 用例：251 通过、0 失败、2 个文件符号链接权限 skip**；
  两个审核文件共 33 项（`auditContracts` 17 + `auditAssociation` 16）全绿。新增覆盖：
  前后 hash 的 14 种非法格式、控制字符/长 ID/数值边界的保守上界（13,056 < 16,384）、
  意图版本闸门与脱敏、投影版本闸门与受控派生名、publish/认领/二次认领幂等、键顺序无关、
  逐项决定冲突、非法发布事实拒绝、身份对齐、实测指纹 vs 声明、大输入诊断有界。
- C2AR 的关键约定：**完成终态永远在事件之后**；**决定比较不看发布事实**（认领已有事件保留其原始
  `publication`/`recordedAt`）；**审核写只认 journal v2 绑定**，不再用"intent 是否存在"判断普通写。
- 第十一轮独立复跑确认上述 253 项/33 项及指定门禁；额外 29 个关联场景、两项 v1 兼容断言通过，控制字符事件实测 12,979 字节、证据 8,187 字节。A1～A3 在协议与纯校验范围关闭，不将此视为审核 IO 已完成。
- 第十二轮（C2B 实施方实跑）：**295 用例：293 通过、0 失败、2 个文件符号链接权限 skip**；基线 253 未削弱。
  新增 42 项分两个文件：`storageReviewWriter.test.mjs`（25）覆盖三方绑定真实字节、动作/reviewer 规则表、
  提交前拒绝不留痕、意图/v2/记录三处发布失败、提交前取消、事件失败、终态失败、迟到取消、
  意图撞名幂等与 `audit-conflict`、事件非覆盖、锁 busy/释放失败、v1 与 v2 共存；
  `storageReviewReconcile.test.mjs`（17）覆盖巡检只读与 v1/v2 区分、预算与取消、not-found/not-review/unreadable、
  before⇒aborted、after⇒recovery 收口、writer 事件认领、高 revision⇒conflict、四类 inconsistent、busy、
  **2 个真实子进程崩溃检查点**与 **2 组真实双进程竞争**（写入竞争、恢复竞争）。
- C2B 的关键约定：**完成终态永远在审计事件之后**；**提交点之后的失败只报 pending**（`applied-audit-pending`
  时 `audit = null`，不预支发布事实）；**决定比较不看发布事实**（认领保留原 `publication`/`recordedAt`）；
  **普通写仍 v1、旧 v1 读者拒绝 v2**；核对永不重放记录、不递增 revision。
- 第十二轮独立复跑确认 295 项及指定门禁；独立诊断发现完整 v2/输入/硬限额、错绑定发布/首次矛盾收口、认领时钟/恢复阶段结果、工件清理诊断问题，详见 R1～R4。现有绿色用例不覆盖或错误期待这些行为。
- 下一步：[D3＋D4 加速批次 §11](bm02d3_development_plan.md#accelerated-delivery)：恢复 API、原字节往返、新进程读取内部验证后继续薄 CLI；补参数/确认/JSON/退出码/取消与真实子进程演示，整批验收。旧整改不重做，不做 UI/Pi 工具/记忆。
- D1 备份协议（实施方实跑，**待独立验收**）：新增 `tests/storageBackupManifest.test.mjs` **70 项** + `tests/storageBackupPayload.test.mjs` **23 项**（fixture 见 `tests/helpers/backupFixtures.mjs`，hash/字节一律用 `node:crypto`/`Buffer` 独立重算）。覆盖：
  最小/全落点清单与打乱顺序、规范化字节口径与输入键序无关、输入不被改写、受控落点表与 `knowledgeLayout()` 同名漂移守卫；
  严格字段/版本/时间/ID/hash/bytes、未知字段（含 symbol 键）拒绝且不回显字段名与值；
  17 类路径逃逸与 Windows 别名（绝对/盘符/UNC/反斜杠/`.`/`..`/重复与首尾分隔符/NUL/冒号 ADS/尾点/尾空格/大小写变体/保留名/非 ASCII/未 URL 解码）与超长路径；
  未知落点、`.tmp`/隐藏文件、journal/意图/事件 ID 不符、`audit/intents` 与事件目录的区分、`cache`/`locks` 不得进入 data 清单；
  重复路径、缺 registry、缺必需固定目录、缺祖先目录；七类限额的「0 / 恰好足够 / 差一」、总量溢出前拒绝、`maxIssues=0` 不误报成功、非法与未知限额字段抛 `invalid-limits`；
  payload 缺失/多余/重复/长度错/等长 hash 错、空 payload、中文与 CR/LF 等长差异、**原始字节保真**（BOM/CRLF/制表符/尾空格/非法 UTF-8 逐字节进 hash，只差一个尾空格字节即失败，调用后字节不变）、未来业务版本与损坏 JSON 的**字节一致但无业务准入**对照、严格条目形态、条目数预算。
- 第十五轮（C3 预检实施，实施方实跑）：新增 `tests/storagePreflight.test.mjs` **35 项**（含子用例），覆盖版本盘点（v1/v2 journal 合法共存、五类记录、意图/事件）、
  缺注册表/缺档案/孤立项目、坏 JSON·归属不符·绑定冲突·未来版本（分类与已知校验器同码）、prepared/conflict·锁·`.tmp` 人工事项、
  超大与增长文件、中间目录 junction 与叶子链接、共享条目/读取/摘要/问题/输出字节预算与 0/undefined/非法限额、取消与并发消失、
  以及"扫描前后目录清单与逐文件 SHA-256 相同、不建目录、不泄漏正文哨兵"的只读证据。
- C3R（实施方实跑，先红后绿）：`storagePreflight.test.mjs` **35 → 52 项**（新增 17 个 C3R 子用例）——
  根列举 EACCES 必须 `incomplete` + `truncatedBy:"root-listing"` + 根 `.` 错误码（不得 `complete/no-migration-needed`）、
  非根探测 `permission-denied` 收集成问题后继续扫描、非根探测点取消仍抛 `cancelled`；
  `problems + manual <= maxProblems`（额度 0 / 1 / 恰好够 / 差一 / 只含单类 / 人工事项先到）；
  `outputBytes` 等于三类明细合并数组的真实 UTF-8 字节（含括号与逗号、空明细 0、差一按字节截断后仍逐字节一致）；
  截断时 `scannedEntries` 等于已观察条目（根触顶 2、第一层触顶 3、多目录累计 3、预算 0 时为 1、无截断时与独立重算的列举条目总数一致），
  且列举截断后不再打开候选；`maxFileBytes=0` 立即停读（`read-bytes`）。叶子文件链接由"空通过"改为**显式 skip**。
- 第十四轮（I1 整改，实施方实跑）：审核持久化 **90 → 95 项**（writer 39 + reconcile 52 + contracts 4），新增 5 项、先红后绿。
  红的那一项：同 operationId 同字节意图已存在（真实撞名）→ 仅在 `audit/intents/` 注入 `unlink-temp` 失败 →
  在**复读已有意图**的 IO 等待点用正式 `AbortSignal` 取消 ⇒ 修正前 `cancelled` 无清理诊断、磁盘却有新增 `.tmp`。
  三个对照：清理成功 + 取消不误报且不新增 `.tmp`；清理失败 + 不取消仍 `exists-identical` 且 `cleanup=failed`；
  已有意图是坏文件时仍 `audit-conflict`（带清理诊断、原字节保留）。同时断言原意图/journal/业务 hash 不变、无新事件。
- 第十三轮（C2BR2 整改，实施方实跑）：审核持久化 **73 → 90 项**（writer 34 + reconcile 52 + contracts 4），新增 17 项、先红后绿。
  F1 负例组（Node 含父测试 9 项）：目标既非 before 也非 after 时，意图被删 / `intentVersion=99` / 坏 JSON / 字节被改 / target·eventId·before·after 各自被改
  且 `journal.intentHash` 同步为新真实 hash —— 全部 `inconsistent`、`changed=false`、journal 仍 prepared 且字节不变、无新事件；
  另 1 项正例确认合法绑定 + 目标后续更新仍记 `conflict` 且二次核对幂等。
  F2（Node 含父测试 7 项）：writer 事件/意图发布失败 + 对应 `.tmp` 删不掉 ⇒ 结果带 `artifactCleanup` 与 warnings、磁盘确有 `.tmp`（意图那例原错误码 `permission-denied` 不变）；
  recovery 事件失败/终态失败 ⇒ `pending` + 对应工件诊断（终态那例保留 `publication=recovery` 的 audit）；`exists` 撞名后读取被取消 ⇒ `cancelled` 穿透但保留清理诊断；
  1 项对照确认无清理失败时为空数组且不删除历史残留。
- 第十二轮（C2BR 整改，实施方实跑）：审核持久化用例 **42 → 73 项**（`storageReviewWriter` 31 + `storageReviewReconcile` 38 + 新增 `storageReviewContracts` 4）。
  新增：R1 六类 v2 变体与 schema 一致性、revision 边界、**16 KiB 精确边界与空白放大**、九种非法 `evidence`；
  R2 三种"改意图 + 改绑定指纹"伪造、锁等待期换目标、未来版本意图、坏事件；
  R3 时钟回拨认领、时钟回拨拒发、决定不同的事件、发布失败/终态失败/发布前后取消、**真实 recovery 二次中断**；
  R4 意图/事件/journal 逐件清理失败、提交前抛错传播、exists 撞名分支。
  同时**替换**了 1 条把错误行为写成预期的旧断言（"第一次 aborted、第二次 inconsistent" → 第一次即 `inconsistent`），并在用例里写明原断言为何错误。

- 第十三轮独立复跑以上 326 项与门禁；R1/R3 和恢复二次中断关闭。额外生产 API 诊断发现当时的 F1/F2，来源见 [第十三轮验收](round13_acceptance.md)；两项主复现已由 C2BR2 修复并由第十四轮确认。
- 第十四轮独立复跑 343 项与门禁、额外诊断确认 F1 与 F2 三个主失败路径通过；当时 I1 新增 `.tmp`=1 却无清理诊断，见 [第十四轮验收](round14_acceptance.md)。
- 第十五轮独立复跑 348 项/六文件 165 项与指定门禁，正式 AbortSignal 的三个对照、原文件 hash/事件清单不变和元数据传播诊断通过；I1 关闭，审核持久化整改收口。证据见 [第十五轮验收](round15_acceptance.md)。
- 第十六轮独立复跑 C3 383 项/七文件 200 项与指定门禁通过，但合成诊断确认 PF-1～PF-4 未覆盖：根列举 EACCES 仍完整通过；问题/人工合计 2 超过额度 1；报告 184 字节但摘要/问题数组实际 189；条目截断后统计为 0。C3 整体暂未通过。
- C3R 收尾（实施方实跑，**待独立复验**）：同一批 C3R 回归先在旧实现上跑出 **16 项红**（含既有"输出字节"用例按旧口径写成预期的那条），修复后 52 项全绿、0 失败、1 显式 skip；
  Package **400 用例/397 通过/0 失败/3 显式 skip**、七文件 217 项、包与根全部门禁通过。该实施快照后来经第十七轮独立复跑确认，但 S1 阻塞整体收口。
- 第十七轮额外合成诊断（不计永久用例数）：PF-1 根 EACCES ⇒ incomplete/root-listing；PF-2 保留问题/人工合计 1；PF-3 计量 516 与真实合并明细一致。PF-4 剩余 S1：嵌套额度 15 真实观察 18/报告 16；输出额度 200 触顶时真实观察 10/报告 1。两条待补永久回归，现有绿色用例未覆盖。
- S1 接续（实施方实跑，**待独立复验**）：`storagePreflight.test.mjs` **52 → 59 项**（新增 7 个 S1 用例，含 6 个子用例）——
  ① 嵌套 audit（额度 15）真实观察 ≤ 16、统计一致、耗尽后不再开候选；② 输出先触顶时已观察十条仍入账且不再读候选；
  ③ 父目录恰好用完额度（4）进入子目录前成本已入账（`scannedEntries=5`、零 audit 候选被打开）；④ 0/1 边界与正常完成对照（正常完成时等于独立重算的列举条目总数）；
  ⑤ 读取预算先停（1200 字节）仍保留观察成本且 `readFiles<10`；⑥ 逻辑核对不冒充物理观察（登记项目缺目录）。
  计量方式：**独立 Node 子进程包装真实 `fs.promises.opendir`/`open`**（只计数），不与报告自身字段互为证明。
  junction 创建失败分支由空返回改为**显式 `context.skip`**；本机 junction 可用、相关用例实际执行；3 个 skip 仍全部是本机文件型 symlink 权限限制。

- 第十八轮独立复跑 407 项/七文件 224 项及指定门禁通过；S1 原两种复现关闭，成功列举范围通过。补充迭代 `EIO` 诊断 S2：experiences 四条已交出后抛错，features 继续，额度 15 实际观察 20/报告 16；尚未进入永久测试，不计入 407 项。下一轮按 [C3R §7](bm02c3_remediation_plan.md#7-第十八轮后的唯一接续任务s2) 收尾。
- S2 接续（实施方实跑，**待独立复验**）：`storagePreflight.test.mjs` **59 → 66 项**（新增 1 父 + 6 子用例）——① 额度 15：experiences 交出 4 条后 `EIO`，统计=真实观察=16、后续类别只用真实剩余额度、原错误仍作为受控问题可见且不回显原始正文、不再打开候选；
  ② 零观察失败（0 条后 `EIO`）计数保持 0、不制造虚假成本；③ 宽预算 31/31；④ 嵌套 audit 16/16 且不开任何事件候选；⑤ 与读取预算提前停止组合 24/24；
  ⑥ 取消对照：结构化穿透且目录句柄已配对关闭（取消后可立即删除目录）。
  修前红：四条断言在旧计费形态下失败（A 复现验收的 20/16），修后全绿。计量仍由**独立 Node 子进程**包装真实 `fs.promises.opendir`/`open`（只计数，并注入"交出 N 条后抛 `EIO`"）。

- 第十九轮独立复跑 414 项、七文件 231 项、列举调用者五文件 185 项与指定门禁通过；S2 原漏计独立计量 16/16。关闭故障 S3 诊断：额度 15/0/1 实际并报告 17/2/3，仍列举 features；前后清单/hash 不变、无正文泄漏。计量 helper 未转发 `return()`，下一轮需保留原关闭路径并补永久红回归。不是报告低计，也不是完整通过误报。
- S3 接续（实施方实跑，**待独立复验**）：`storagePreflight.test.mjs` **66 → 75 项**（新增 1 父 + 8 子用例）——① 额度 15：experiences 真实关闭后注入 `EIO`，统计=真实观察=16、`truncatedBy` 含 `scan-entries`、原错误仍作受控问题可见且不回显哨兵、不再列举 features/不开候选、前后清单与 SHA-256 不变；
  ② 额度 0 → 1/1；③ 额度 1 → 2/2；④ 嵌套 audit 子目录关闭失败 → 16/16、只列举一个事件目录、零事件候选；
  ⑤ 宽预算（5000）+ 配置关闭故障 → **不锁存**（`complete=true`、`outcome=blocked`、后续类别照常列举）；⑥ 取消 + 配置关闭故障 → `cancelled` 结构化穿透且同进程内目录可删除（句柄已配对关闭）；
  ⑦ 关闭错误 × 读取预算停止对照（`next()` 4 条后失败 + 关闭注入 + `maxReadBytes=1200`）→ **24/24**：成本不丢、`truncatedBy` 含 `read-bytes`、features 仍被列举（不误锁存）、`readFiles<21`；
  ⑧ 关闭错误 × 明细额度停止对照（额度 15 + `maxProblems=0` + 关闭注入）→ **16/16**：`truncatedBy` 含 `scan-entries` 与 `problems`、明细丢弃仍 `complete=false`、`blockingProblems≥1` 不被裁剪、features 未被列举。
  计量方式：计量代理**完整转发原迭代器 `return()`/`throw()`**（旧代理只转发 `next()`，关闭故障因此进不了可见出口），关闭注入在 `Dir` **构造之前**包装 `fs.Dir.prototype.close`（先完成真实关闭再注入受控 `EIO`，`WeakSet` 保证每目录一次），包装只在独立子进程生效。
  修前红：A/B/C/D 四条断言失败（E/F/G/H 通过）；修后 9 项全绿。行数 `scan` 409（略超 400 目标、未超 600 门槛）、`inspect` 95；`boundary` 576 未改。

- 第二十轮独立复跑423项、七文件240项、五文件194项及指定门禁通过；原关闭故障16/16、1/1、2/2，无后续扫描IO；宽预算实际故障继续后续类别、库清单/hash不变。S3关闭，C3/C3R在声明范围收口。

## 第二十二轮 D1R＋D2 独立验收（已执行）

D1/D1R 通过纯校验范围；B1 两字节伪装一字节受控拒绝，假原型拒绝，B2 100,001 项拒绝且迭代访问 0；永久正常对照和 128 项 backup 实际执行。

D2 常规测试及门禁通过，但额外独立实验发现 junction 清理误删、额外文件/缺空目录仍发布、发布前取消仍提交、关闭错误被吞、提交后残留仍 cleanup=ok，以及原错误/源路径透传。详见 [报告](round22_acceptance.md)，额外实验不计入 551 项。其它未执行范围不算通过。

## D2R＋D3＋D4 实施方覆盖快照（整体结论以第二十六轮为准）

第二十七轮历史：R26-1～3 关闭；targeted 257 项（256 通过、1 skip）、Package 680 项（676 通过、4 skip）。当时 M1 22 项，三组额外诊断失败；第二十八轮关闭 R27-1/3，R27-2 剩余项见 R28-3，不以旧全绿代替验收。

节点 A 的 32 项安全测试计数已执行，backup 160 项全绿。第二十五轮确认 R24-1/2 通过，并独立补单路径 EIO、ENOENT、未知子树真实 opendir 与 targetExists 对照；诊断见 [报告](round25_acceptance.md)，不计入 583 项。单路径 EIO 永久回归已在 D3 故障组补齐。

节点 B（D3，实施方实跑，待独立验收）：`tests/storageBackupRestore.test.mjs` **13 项** + `tests/storageBackupRestoreFailure.test.mjs` **34 项**，backup targeted 共 **207 项全绿**。覆盖：最小/富库原字节往返（五类记录 + 普通 v1/审核 v2 journal + 意图/事件 + 已知空目录）、cache/locks 恢复为空、中文/缩进/CRLF/尾空格逐字节、registry 最后非覆盖发布、真实新进程 `readRegistry`/`readRecord`/`inspectKnowledgeStore` 读取、真实双进程同目标竞争、非覆盖与 canonical/父链链接拒绝、备份拒绝（无/坏/未来/未知字段 manifest、额外条目、缺文件/目录、错长度/hash、容器链接、坏 JSON 与未来业务版本“重配 hash 后仍拒绝”）、预算 0/精确/差一、预检截断/摘要裁剪、复制期间增删/等长改写/增长、短写/sync/link 失败、句柄关闭失败、清理不可核对（单路径 EIO）、取得后/发布前/发布后取消与提交事实、成功与失败前后源库与备份字节及集合不变。

节点 C（D4，实施方实跑，待独立验收）：`tests/knowledgeCli.test.mjs` **11 项**。覆盖 help 不读库、未知/重复/缺值/相对路径/缺写确认（退出码 2 且不创建输出）、非覆盖目标 sentinel 不变、结构化 JSON 单对象与错误脱敏、退出码 0/1/2/3 映射（含“已提交需复核/残留非 0”）、SIGINT 后安全收尾无 `.tmp` 半成品、真实子进程 CLI 导出→恢复→新进程读取与 API 结果一致。

端到端合成演示（可复现，实际输出见 [实施记录 §14.5](bm02d3_implementation.md#145-可复现端到端演示实际输出)）：inspect 退出 0（14 文件/6 类版本族）→ export `published=true` → restore `status=restored` → 14 文件逐字节不一致 0 个、cache/locks 为空、新进程 reader 可解释。**这些是实施方自测，独立验收通过前不记为通过。**

## 后续分层记忆验收（计划，未测）

M0 已补，M1 已实施但 R28-3 未收口，M2 认可 v1 路线但未批准格式迁移。当前 [BM-04 批次](bm04_development_plan.md#5-永久测试门禁与交付文档) 要求四组永久回归及经验/Feature/审核/授权检索/真实 CLI 与新进程场景；Session、正式语义历史仍未实现。

这些要求不加入当前 C3 实现范围；不得把设计文档或模型生成的样例当作测试通过证据。
