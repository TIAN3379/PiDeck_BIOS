# BIOS Agent MVP 测试清单

更新：2026-10-01，第四轮独立验收（G1 修复 + BM-02A）。
本表记录**实际执行**的结果；未执行/未触顶的项显式标注，不把计划中的功能视为已实现。

最新结论见 [第四轮验收](round4_acceptance.md)，下一批任务见 [BM-02AR 收尾说明](bm02a_remediation_plan.md)。
[本轮实施说明](bm02a_implementation.md) 保留为实施方自测依据，不代替独立验收。

## 功能测试

| 测试项 | 操作步骤 | 预期结果 | 实际结果 | 状态 |
|---|---|---|---|---|
| Package 加载 | SDK 装载唯一入口、检查工具清单 | 只注册 bios_detect_project | 符合，已自动化 | 通过 |
| CLI/RPC Skills | 临时 cwd/agent 配置、离线 get_commands | 两个 BIOS Skills 可见 | 符合，宿主技能隔离断言通过 | 通过 |
| 只读线索扫描 | 自建临时 DSC/INF/ASL、忽略目录 | 返回线索和 unknown/缺口，不读正文 | 符合 | 通过 |
| 多工作区契约 | 同档案放两份 VCS 快照/无 Git 绑定 | 能独立表达 branch/HEAD/状态 | schema 用例通过；真实绑定逻辑未实现 | 结构通过 |
| 空库初始化 | 空目录执行 `initializeKnowledgeStore` | 创建布局 + 合法空 registry，revision=0 | 6 个布局目录与 registry 均创建 | 通过 |
| 重复初始化 | 对已初始化根再次初始化（含不同 `now`） | 返回 existing，**registry 原字节不变** | hash 相同、createdAt/revision 未重置 | 通过 |
| 新进程读取 | 真实 `spawn` 子进程读取同一知识根 | schemaVersion/revision/createdAt 与初始化一致 | 空 registry 头字段一致；非空项目/记录未验证 | 部分通过 |
| 两进程同时初始化 | 真实 `spawn` ×2 并发首建 | 不产生半文件、不互相覆盖 | 正常硬链接发布通过；wx 回退会暴露空文件（S1） | 有条件通过 |
| 五类记录读取 | 按 kind+ID 写入并读回 | 类型、路径、字节数与内容一致 | 五类均通过 | 通过 |
| 有界列表 | 5 条记录 + 1 条损坏 | 摘要返回、损坏进 `problems`、预算截断可见 | 正常条数/扫描预算通过；异常输出预算失效（S4） | 有条件通过 |
| 项目内记录列表 | 两项目任务及 A 目录内放 B 内容 | 不能将错项目任务当成当前记录 | 普通分目录用例通过；错归属内容仍进入摘要（S2） | 待修复 |
| 绑定解析 | 路径/项目/桌面 ID、矛盾组合与多工作区 | 缺失与冲突可解释，不任取检出 | 常规通过；矛盾条件/多工作区/重复项目有遗漏（S5） | 待修复 |

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
| 超大 registry / 记录 | 注入更小字节预算 | 拒绝，不物化正文 | `too-large`（先限字节再读取） | 通过 |
| 记录 ID / 项目不匹配 | 文件内容 ID 与路径 ID 不同；任务 projectId 与目录不同 | 拒绝 | `record-id-mismatch` 两条 | 通过 |
| 非法记录 ID | `../escape`、`con`、`exp.`、`Exp`、`a/b`、缺 projectId | 派生路径前拒绝 | `invalid-record` | 通过 |
| 记录不存在 / 非文件 | 不存在 ID；记录路径是目录 | 明确区分 | `not-found` / `not-a-file` | 通过 |
| 取消（存储） | 已 abort 的 signal 调 readRecord/listRecords | 立即失败 | `cancelled` | 通过 |
| 真实权限失败（存储） | 制造 EACCES | `permission-denied` | 未在本机造出，映射仅有代码覆盖 | 未测 |
| 硬链接不可用的回退（S1） | 注入 ENOSYS，暂停 wx 最终目标写入 | 不可见半目标或明确拒绝 | 暴露 0 字节 registry，读者 invalid-json | 待修复 |
| 读取中增长（S3） | fstat 大小 2 后增长至 1003，预算 100 | 超限/变化拒绝，不解析前缀 | 读取 3 字节成功解析 {} | 待修复 |
| 最后 IO 点取消（S3） | EOF read 时 abort；已开始空目录打开后 abort | 整体 cancelled | readJson/listEntries 仍成功 | 待修复 |
| 列表单条非法文件名（S4） | experiences/Exp.json | 单条 problems，不整体崩溃 | 整体 invalid-record | 待修复 |
| 列表异常输出预算（S4） | 两个坏 JSON、1 字节/1 条预算 | 异常输出也有界，截断可见 | problems=2、truncated=false，结果约 696 字节 | 待修复 |

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
| 持久化/冲突/恢复（更新） | BM-02B 场景 | 见各存储批次验收 | 普通记录写入未实现，不提前验证为通过 | 未测 |

## UI 与真实平台测试

- BIOS 专业 UI 尚未实现；本轮没有修改桌面业务代码，不记为 UI 验收通过。
- 尚无获授权真实 BIOS 试点；不能凭 fixture 宣称 AMI/Insyde/国产 IBV 或任何芯片代际支持。
- 安装版加载、重启工程记忆、经验复用闭环、备份恢复待相应阶段实现后验证。

## 兼容性与回归

| 环境/门禁 | 实际结果 | 状态 |
|---|---|---|
| Windows + Node 24.14.1 + Pi 0.87.1 | Package **89 用例：88 通过 / 0 失败 / 1 显式 skip**（skip 为文件符号链接权限） | 通过 |
| Package 类型/格式/selfcheck | 类型通过、格式 25 文件、selfcheck 6 项通过（含存储离线演示） | 通过 |
| 根类型/格式/processGuards | 类型通过、格式通过、守卫 2 项通过 | 通过 |
| Linux/macOS | 未运行本轮 Package 验收 | 未测 |
| 干净 clone/独立 Package 工具链 | 未完成安装验证；README 已写清先装根依赖再装 Package，tsc/Biome 来自根 | 未测 |
| GitHub Actions | 已有 Package 步骤，本次未执行远端流水线 | 未测 |
| 根全量测试/生产构建/安装包 | 本次无跨域业务改动，未执行 | 未测 |

## 测试结论

- G1 已闭环：句柄生命周期有确定性断言（open/close 计数），并有子进程 GC 诊断复现验收方的观察方式。
- BM-02A 主体有条件通过：正常初始化、静态文件读取/保护与目录链接拒绝已有证据；补查 S1～S5 仍待修复。
- “预先取消通过”不等于中途取消通过，“正常文件预算通过”不等于错误输出预算通过，“最终 JSON 完整”不等于发布窗口不可见半文件。
- 仍**未测**：文件符号链接（本机权限）、真实 EACCES、告警上限实际触顶、Linux/macOS、远端 CI、生产构建与安装包。
- 下一批先 **BM-02AR** 关闭 S1～S5 并补永久回归；独立复验通过后才进入 BM-02B（revision 冲突、可取消锁、原子替换）。
