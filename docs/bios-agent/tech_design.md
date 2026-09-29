# BIOS Agent v0.8.0 技术方案

## 方案

沿用 Electron Builder 的 NSIS 目标，不增加新的启动器或运行时依赖。安装器通过 `createDesktopShortcut` 和 `createStartMenuShortcut` 创建系统入口。

## 产品身份

- npm 包名：`bios-agent-desktop`
- productName：`BIOS Agent`
- Windows App ID：`com.tian3379.bios-agent`
- deep link：`bios-agent://`，解析器继续兼容旧 `pideck://`
- GitHub 更新仓库：`TIAN3379/PiDeck_BIOS`
- 版本线：从上游 `0.7.x` 之后的 `0.8.0` 开始独立维护

## 兼容策略

- 暂时沿用现有 PiDeck userData 目录，避免已有设置和会话丢失。
- 保留内部环境变量、扩展文件名和数据契约。
- 运行时继续从 PATH 探测 pi CLI；本机用户 PATH 已包含 `D:\BIOS_Pi_Agent\PiRuntime`。
- 旧 deep link 保留只读兼容，新安装只注册 `bios-agent://`。

## 风险

- 当前 Windows 安装包未做商业代码签名，系统可能显示未知发布者提示。
- GitHub Releases 尚未上传 v0.8.0 资产前，应用内自动更新不会发现版本。
- 图标仍沿用上游首版资产，后续应作为独立视觉任务替换。
