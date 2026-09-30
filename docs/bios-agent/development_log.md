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
