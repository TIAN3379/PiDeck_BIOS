# 发布清单

v0.9.3，Windows x64 预览版。仓库 TIAN3379/PiDeck_BIOS，开发分支 BIOS_Agent。首次公开发布先试用观察；不承诺 Stable 更新频道自动发现预览版，请手动下载安装。

1. 执行[测试清单](test_checklist.md)的根/Package 类型、格式、单测、构建和隔离 GUI。
2. package.json/package-lock.json 版本一致，双语 CHANGELOG 描述用户变化。
3. sync-release-notes.js 先预览再 --apply，同步徽章、站点与 workflow tag choices。
4. 公开提交不包含凭据、真实用户配置、客户代码/知识、探针、备份和安装包。
5. 按功能中文分批提交，push origin BIOS_Agent，不推 upstream、不强推、不自动合并 main。
6. 完整构建后 `npx electron-builder --win nsis --publish never`，验证目录包真实启动/GUI。
7. 核对 setup、同版 blockmap/latest.yml 及实际 SHA-256；更新元数据的名称/hash 对应真实产物。
8. Release 指向验证提交，上传安装包、blockmap、latest.yml、校验和，说明已知限制。
9. 核对 Release/tag 目标 SHA、资产和远端 branch SHA。

本机安装包：97,910,637 字节。SHA-256：

`be0c91e338d07439431c46216d10ff3e512a38e8a4f7862e8d97e398c5ceb357`

安装包、blockmap、latest.yml 与 SHA256SUMS.txt 在 release 目录；GitHub 资产以 tag 的 Release 为准。

用户只需 setup，不需软件源码；Pi/Node/模型配置可能联网。源码、编译工具链、Git、聊天、模型凭据和历史知识另备，不包含在安装包。

新电脑须重新核对资料许可/工作区，不能沿用旧机器绝对 Pi/源码路径。用户知识在独立数据根，软件清理不删除。

旧构建和排查副本在新产物成功后从源码目录移除，优先回收站。目录包测试不等于干净电脑安装或真实固件验证。
