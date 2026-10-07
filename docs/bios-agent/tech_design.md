# 当前技术架构

更新：2026-10-07，v0.9.3。[分层记忆设计](layered_memory_temporal_design.md)描述后续时态边界。

## Pi 是执行核心

Electron + TypeScript + React 桌面启动 Pi RPC 会话，Pi 负责模型、工具循环和 Session。BIOS 能力以 Package 的 Extensions/Skills 实现，不 fork Pi，不另建 Agent 循环。安装包通过 extraResources 分发专业包，扩展管理可禁用；禁用不删除知识。回归基线 Pi 0.87.1。

| 层 | 源码入口 | 职责 |
| --- | --- | --- |
| 领域 | packages/bios-agent/core | 项目、任务、知识、记忆决策、上下文、自动化、存储与备份 |
| Pi 适配 | packages/bios-agent/extensions | 工具、命令、生命周期、动态上下文、复盘保存、外发守卫 |
| 方法 | packages/bios-agent/skills | 接入、通用 UEFI、排障、客户功能移植 |
| 桌面 | src/main/bios | 配置、运行时身份、接入、知识库、历史与业务适配 |
| 接口 | src/main/ipc/bios*Ipc.ts、src/preload、src/shared/types/bios* | 一致 IPC 契约和验证 |
| 界面 | src/renderer/src/components/bios、hooks/useBios* | 最小状态、统一确认、本地库和按需管理 |
| 验证 | tests/bios*、packages/bios-agent/tests、e2e/bios* | 服务、领域、权限、会话、GUI、打包回归 |

## 保存与检索

权威数据为外部知识根下的 JSON：registry/项目档案、任务、经验、需求、上下文清单、审计与 journal。自动化检查点/工作线索位于独立 automation 目录，不冒充正式已审核经验。

关键词/别名和有界进程内增量索引找候选；命中后重读权威记录，复查授权、revision、状态和来源。索引不是事实来源，没有向量数据库或模型训练。扫描、字节、条数/上下文预算触顶报告不完整，不上传整库。

单记录提交使用 revision/CAS、协作锁、受限路径和清理协议。审计/journal 区分意图与实际结果，不承诺通用多记录事务。备份为停止写入后的 offline-copy，恢复到新目录，不覆盖原库/迁移源码/重绑定工作区。

## 对话工作流

项目授权后，生命周期钩子准备背景、调查前检索工作线索、执行后记录实际进度和待审核草稿；预算、幂等检查点、取消与重启门禁防重复写入。

任务是跨会话工程目标，不是聊天。接续重读任务、源码和来源；歧义、身份冲突、证据变化或旧运行状态不明确时询问，不自动续跑。working 草稿只作本项目未验证线索，不成为正式或跨项目 current 推荐。

历史只读 Git/diff 证据。身份、客户归属、正式需求和审核通过真实确认处理，模型文字不能批准。

## 桌面与权限

工作区关联核对真实目录和桌面工程身份，普通聊天不接入。旧授权路径缺 desktopProjectId 时经确认补齐并复用原 ID；冲突拒绝自动合并。取消接入撤回许可和关联，保留知识但不列为当前接入。

请求绑定会话、Agent、代次/cwd，配置变化、撤权、换代使旧预览和回执失效。旧环境快照不能套用新许可，必要时停进程重开。外发许可绑定 provider/模型/API 地址，不由项目授权自动放行。

本地人工库编辑与模型调用分离，离线可用；保留 CAS、路径、审核回退确认、退出保护和备份互斥，不增加模型资料范围。

这些守卫针对 BIOS 专业通道，不是任意 shell/扩展的企业 DLP。资料和日志是数据，不得当作权限指令。

## 边界

v1 记忆决策、来源重验和预算已落地；正式双时态历史、耐久内容指纹、schema v2 迁移、全仓自动学习与无人审核未实现。历史测试不证明当前板卡/代码基线。

本轮分发 Windows x64；不以构建推断干净电脑安装、真实模型、固件验证或 macOS/Linux 通过。
