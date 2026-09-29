# BIOS Agent 开发日志

## 2026-09-30 · v0.8.0 身份与启动体验

- 将应用外部身份改为 BIOS Agent。
- 保留原架构，通过 Electron Builder NSIS 输出普通 Windows 安装程序。
- 安装器创建桌面和开始菜单快捷方式。
- 更新、反馈和仓库链接切换到 `TIAN3379/PiDeck_BIOS`。
- 移除原作者 AtomGit pre-push 和自动镜像工作流。
- 保留内部 PiDeck 兼容标识与数据目录，降低首轮改造风险。
- 类型检查、格式检查、身份改造定向测试和 Windows 打包版启动冒烟均已通过。
- 已生成 `BIOS-Agent-0.8.0-setup.exe`；下一步是提交并推送，真实安装由用户执行以验证桌面快捷方式。
