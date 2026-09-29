# BIOS Agent v0.8.0 MVP 范围

## 必做

- 应用、窗口、快捷方式和安装包显示为 BIOS Agent。
- Windows NSIS 安装器创建桌面和开始菜单快捷方式。
- 安装版能够通过用户 PATH 找到 `D:\BIOS_Pi_Agent\PiRuntime\pi.cmd`。
- 仓库、问题反馈和自动更新指向 `TIAN3379/PiDeck_BIOS`。
- 禁止向原作者 AtomGit 自动推送。
- 完成类型检查、单元测试、构建和 Windows 安装包验证。

## 暂缓

- 全新品牌图标和完整视觉系统。
- 重命名所有内部 `PIDECK_*` 标识符、数据格式和扩展文件名。
- macOS 签名、公证和 Linux 发布验证。
- 商业化、账号系统和云端同步。

## 完成标准

运行 `BIOS-Agent-0.8.0-setup.exe` 可完成安装，桌面出现 BIOS Agent 快捷方式，双击可启动应用；代码已推送到 `BIOS_Agent` 分支。
