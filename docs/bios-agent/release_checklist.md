# BIOS Agent v0.8.0 自用发布清单

- [x] 产品名称、App ID、协议和安装包名称已切换。
- [x] 桌面快捷方式与开始菜单快捷方式已配置。
- [x] GitHub Releases、Issues 和更新仓库已切换。
- [x] 原作者 AtomGit 自动推送已禁用。
- [x] MIT License 和上游贡献者署名保留。
- [x] 类型检查通过。
- [x] 受身份改造影响的定向单元测试通过（132/132）；完整套件首轮 7010 项中 6964 项通过，旧身份失败项已修复并定向复验。
- [x] Windows NSIS 安装包构建通过。
- [x] `win-unpacked/BIOS Agent.exe` 打包版启动冒烟通过。
- [ ] 安装包安装后桌面快捷方式可启动。
- [x] GitHub `BIOS_Agent` 分支已推送。
- [ ] v0.8.0 Release 已创建并上传安装包、blockmap 与 `latest.yml`。

## 已知限制

- Windows 包暂未使用受信任的代码签名证书，首次运行可能出现 SmartScreen 提示。
- 当前仍使用上游图标，独立图标将在后续迭代完成。
- v0.8.0 首轮只验证 Windows x64 自用路径。
