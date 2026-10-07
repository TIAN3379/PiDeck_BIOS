# BIOS Agent

[English](README.en.md) · [LinuxDO 友链](https://linux.do)

**一个面向个人二次开发的本地 Agent 桌面工作台，可通过安装后的桌面图标直接启动。**

> BIOS Agent 基于 [PiDeck](https://github.com/ayuayue/PiDeck) 二次开发，继续遵循 MIT License，并保留原项目贡献者署名。

![Status](https://img.shields.io/badge/status-experimental-orange)
![License](https://img.shields.io/badge/license-MIT-blue)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)
![Electron](https://img.shields.io/badge/Electron-43-47848f)
![React](https://img.shields.io/badge/React-19-61dafb)
![Version](https://img.shields.io/badge/version-0.9.3-blue)

项目仓库：https://github.com/TIAN3379/PiDeck_BIOS

BIOS 专业功能与上手说明：[使用指南](docs/bios-agent/user_guide.md) · [架构与当前边界](docs/bios-agent/tech_design.md) · [下载发布版本](https://github.com/TIAN3379/PiDeck_BIOS/releases)。本轮发布 Windows x64 预览安装包；macOS/Linux 尚未验证。


<!-- star-history:start -->
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/star-history/star-history-dark.svg">
  <img alt="Star history" src="assets/star-history/star-history-light.svg">
</picture>
<!-- star-history:end -->

![PiDeck 工作台全景](docs/images/readme/hero.png)
![PiDeck 工作台设置](docs/images/readme/setting.png)

---

## 这是什么

**BIOS Agent** 是由 TIAN3379 维护的个人 Agent 桌面应用发行版。本阶段以 Windows 自用、双击启动和持续二次开发为主；底层仍沿用 PiDeck 的 Electron 工作台架构，并通过外部 `pi` CLI 提供 Agent 能力。

**PiDeck** 是一个开源的 pi Agent 桌面工作台，用于在本地项目目录中统一管理 pi Agent 会话，并支持导入 Codex、Claude 本地会话以便统一浏览和恢复。基于 Electron + TypeScript 构建，提供多项目工作区、AI 会话管理、Git 集成、内置终端、模型配置和插件扩展能力，让本地 AI 编码助手在多项目环境中保持统一、可追溯、可配置。

**适合谁用：** 希望在桌面端同时管理多个本地项目的 AI 编程助手会话、需要统一查看会话历史与 Git 状态、并希望以图形化方式管理 pi 配置的开发者。

`PiDeck` **不是** pi 的分支。它是一个轻量 Electron 外壳，通过启动多个 `pi --mode rpc` 进程，将项目管理、会话管理、对话界面、配置管理和工具编排整合到一个原生桌面应用中——所有 Agent 能力由 pi 原生提供，会话文件也由 pi 原生读写，PiDeck 不复刻、不劫持。

---

<details open>
<summary>❤️ 赞助商</summary>

| Logo | 简介 |
| --- | --- |
| <a href="https://88api.ai/sign-up?aff=DAEe"><img src="docs/images/88vip.png" alt="88API" width="120"></a> | [**88API Token聚合站**](https://88api.ai/sign-up?aff=DAEe)<br>88API 是一站式多模型 API 聚合平台，平台由海外企业运营，稳定高效支持开票。平台提供 DeepSeek 官转和开源渠道，价格低至 5 折，完美适配PiDeck项目。一个 API Key 即可统一接入海内外多种模型，覆盖文本对话、图片、音频、音乐和视频生成接口，适用于 AI 编程、Agent 自动化、内容创作及应用开发。<br><br>[**立即注册 →**](https://88api.ai/sign-up?aff=DAEe) |

</details>

---

## 📑 目录

- [PiDeck](#pideck)
  - [这是什么](#这是什么)
  - [📑 目录](#-目录)
  - [✨ 核心亮点](#-核心亮点)
  - [📋 更新日志](#-更新日志)
    - [v0.7.7 更新亮点](#v077-更新亮点)
  - [🧩 功能总览](#-功能总览)
    - [工作区与项目](#工作区与项目)
    - [会话与对话](#会话与对话)
    - [文件 · Git · 终端](#文件--git--终端)
    - [模型与配置](#模型与配置)
    - [扩展与生态](#扩展与生态)
    - [桌面与系统集成](#桌面与系统集成)
  - [🏗️ 工作原理](#-工作原理)
  - [📦 下载安装](#-下载安装)
  - [🧰 快速开始（从源码运行）](#-快速开始从源码运行)
  - [❓ 常见问题 FAQ](#-常见问题-faq)
  - [🧑‍💻 开发指南](#-开发指南)
    - [浏览器预览模式](#浏览器预览模式)
    - [项目结构](#项目结构)
  - [🤝 参与贡献](#-参与贡献)
  - [💬 社区交流](#-社区交流)
  - [🔒 安全与隐私](#-安全与隐私)
  - [☕ 赞助](#-赞助)
  - [License](#license)

---

## ✨ 核心亮点

- 🖥️ **多项目多会话并行** —— 一个窗口管理多个本地项目的全部 Agent 会话，项目间完全隔离。
- 🔌 **双会话后端** —— pi 与生图模式并存，同一项目下自由切换。
- 🧠 **上下文感知输入** —— `@` 文件引用、`/` 斜线命令、`!` Shell 执行，全部在同一个输入框。
- 🗂️ **会话资产化** —— 历史浏览与恢复、Codex / Claude 会话导入、一键导出 HTML。
- 🛠️ **配置可视化** —— pi 的 `models.json` / `auth.json` / `settings.json` 免手写 JSON，连接测试一键直达。
- 📊 **用量看得见** —— 供应商余额/额度查询 + 本地会话用量统计（热力图、每日/模型/项目维度）。
- 🧰 **工作台全家桶** —— 文件树、Git 面板、内置终端、内置浏览器、草稿本，不用来回切窗口。
- 🐾 **有温度的桌面集成** —— 桌面宠物、主题切换、系统托盘、飞书机器人、局域网 Web 访问。

---

## 📋 更新日志

> **最新版本 v0.9.3**（2026-10-07）

### v0.9.3 更新亮点
- 🚀 **BIOS 对话驱动工作流**
- 🚀 **本地知识库可视化管理**
- ✨ **最小 BIOS 右栏**
- ✨ **文档和交付清理**
- ✨ **接入与取消状态一致**
- ✨ **运行态和资料权限收口**

[查看完整更新日志 →](CHANGELOG.zh-CN.md)

---

## 🧩 功能总览

### 工作区与项目

| 功能 | 说明 |
|---|---|
| **多项目工作区** | 添加、搜索、拖动排序和切换本地项目目录，同时运行多个 pi Agent，项目间完全隔离。 |
| **内置 Chat** | 项目列表顶部固定 Chat 入口，写入应用用户目录，适合无需绑定代码项目的通用对话。 |
| **会话引导页** | 新建会话时预选模型与思考档位，支持 `@` 文件引用，开箱即聊。 |
| **信任确认系统** | 桌面端拦截 pi 的信任确认；不信任的项目仍可打开，有 Agent 运行时禁止删除项目。 |

### 会话与对话

| 功能 | 说明 |
|---|---|
| **双会话后端（pi / 生图）** | 同一项目下可创建 pi 会话或生图会话并自由切换浏览。 |
| **生图模式** | 独立生图后端（OpenAI 兼容 /images/generations，支持 OpenAI / 火山方舟 / SiliconFlow 等），在会话中一键切换生图。 |
| **计划模式 (Plan Mode)** | Composer 工具栏切换计划模式，Agent 先生成计划，逐条确认后执行，取消后返回选单。 |
| **Ask 并行问询** | 在后台创建独立问询会话并行提问，可携带主会话上下文，答案一键引用回主输入框。 |
| **活动轨迹** | 思考、工具调用和回答片段按流程聚合展示，工具详情可展开复制，状态和退出码清晰标识。 |
| **回答级修改摘要** | 每轮回答完成后在下方展示本轮修改文件名与行数，Files 面板保留本次会话总览。 |
| **待办条** | Composer 上方常驻 Agent 任务列表，待处理 / 进行中 / 已完成进度一目了然。 |
| **消息编辑/删除** | AI 回答和用户消息均支持复制、编辑和删除，编辑后回填到输入框重新发送。 |
| **会话管理** | 新建、重命名、复制、导出 HTML、删除历史会话、重启与重新加载、关闭 Agent——侧栏或右键菜单即可完成。 |
| **会话导入** | 项目右键导入 Codex 和 Claude 本地会话，转换为 PiDeck 历史会话后继续浏览和恢复。 |
| **刻度定位轴** | 会话右缘刻度轴映射时间线位置，长会话点击即可跳转到对应消息。 |
| **内容行宽限制** | 可拖拽的内容宽度滑块，默认不限宽，适应长行代码阅读或紧凑布局。 |

### 文件 · Git · 终端

| 功能 | 说明 |
|---|---|
| **文件抽屉** | 项目文件树（含 Git 状态标识）、内置文件编辑器；Files 面板保留本次会话修改文件列表。 |
| **外部编辑器集成** | 「在编辑器中打开 / 在资源管理器中显示」自动检测系统文件管理器，支持 JetBrains 系列编辑器目录扫描。 |
| **Git 集成** | 实时显示当前分支，本地 + 远程分支选择器、分支数量徽章、分支切换和新建分支。 |
| **内置终端 Dock** | 当前 Agent 绑定独立终端 tab，支持 PowerShell/cmd/sh fallback、多 tab、主题切换、拖拽高度、右键复制选区和关闭确认。 |

### 模型与配置

| 功能 | 说明 |
|---|---|
| **可视化配置管理** | 编辑器管理 pi 的 `models.json`、`auth.json`、`settings.json`：Provider 卡片 + 模型网格 + 类型感知键值编辑 + 源文件原始 JSON，保存后按需重启 Agent 生效。 |
| **连接测试** | Provider 卡片一键测试连接，模型验证不再把配置回退误判为成功。 |
| **模型能力自适应** | 兼容 pi 0.84.3：上下文窗口 / maxTokens / 思考档位按端点返回自适应，模型目录支持手动刷新，新模型不再不可见。 |
| **用量查询** | 供应商余额/额度查询（内置 OpenRouter、Moonshot-Kimi、通用 OpenAI 兼容网关模板，支持多账号与独立端点），卡片直接显示用量，支持自定义探针配置。 |
| **用量统计** | 基于用量统计插件的本地统计：累计概览、活跃热力图、每日用量、模型与项目维度。 |
| **代理设置** | pi agent 子进程代理与桌面端代理独立配置，模型拉取与连接测试可走桌面端代理。 |

### 扩展与生态

| 功能 | 说明 |
|---|---|
| **配置、Skill 与 Extension 管理** | 可视化管理全局 Skills 与 Extensions，支持启用/禁用内置扩展，区分全局与项目级配置。 |
| **Prompt & Skill 商店** | prompts.chat 国际商店 + skills.sh 社区技能商店，在线搜索、浏览详情、一键安装到本地。 |
| **中文提示词精选** | 内置 XuePrompt 数据库（4000+ 中文提示词），分类/搜索/分页浏览，一键导入本地模板。 |
| **内置扩展** | 内置 `pi-deck-retry-no-body`（空响应自动重试）、图片生成技能模板等开箱即用的扩展。 |
| **视觉桥** | 给不支持看图的模型「装眼睛」：图片先由视觉模型转成文字描述再进入会话，模型/接口/Key 均可在设置中配置。 |

### 桌面与系统集成

| 功能 | 说明 |
|---|---|
| **系统托盘** | 关闭窗口默认最小化到托盘，托盘右键菜单，双击恢复窗口。 |
| **桌面宠物** | 把多 Agent 的运行状态化作桌面上的一只小精灵：状态聚合、置顶、缩放，支持 petdex 社区宠物。 |
| **主题与外观** | 浅色 / 暗色 / 跟随系统一键循环切换（侧栏底栏），语义化设计 token，暗色模式自然适配。 |
| **通知** | 全局通知升级为卡片 toast，Ask 并行问询有独立系统通知开关，后台问题可保持静默。 |
| **主动更新** | 应用更新始终后台检查，`autoDownloadUpdates` 默认开启；下载完成后由用户在设置页确认「重启并安装」。Windows/Linux 使用包内 updater，macOS 打开 GitHub Release 手动安装；Pi CLI 检查独立运行。 |
| **飞书机器人** | 会话可绑定飞书机器人，在飞书群里同步消息与状态。 |
| **局域网 Web 服务** | 设置中启动本机 Web 服务，局域网设备通过 IP + 端口访问网页版，支持双会话后端浏览。 |
| **进程监控 / 日志管理** | 设置页内置进程监控与缓存日志管理，排查问题不用翻目录。 |

---

## 🏗️ 工作原理

```txt
PiDeck
├─ Electron 主进程
│  ├─ 管理项目记录
│  ├─ 启动 pi --mode rpc 进程（每个会话一个独立进程）
│  ├─ 管理 Agent 绑定的本地 pty 终端
│  ├─ 桥接文件、会话、Git 操作
│  ├─ 检查应用与 Pi CLI 更新
│  └─ 暴露最小化、经校验的安全 IPC API
│
├─ Electron Preload
│  └─ 经 contextBridge 向 Renderer 暴露 window.piDesktop
│
├─ React Renderer
│  ├─ 项目 / 会话列表与会话时间线（流式输出）
│  ├─ 文件 / 历史 / Git / 浏览器抽屉
│  ├─ 配置管理 / 技能商店 / 提示词库
│  ├─ Agent 绑定的 Terminal Dock
│  ├─ 模型与上下文状态栏
│  └─ 设置 UI（常用 / 外观 / 代理 / Web 服务 / 桌面宠物 / 视觉桥 / 生图 等）
│
└─ Pi 运行时
   ├─ 每个 Agent 会话一个独立 pi RPC 进程
   ├─ 项目级 cwd 隔离
   └─ 使用 pi 原生会话 / 工具 / 模型 / 上下文
```

核心设计原则：**一个 Agent 会话 = 一个 pi RPC 进程**，确保会话隔离，让 pi 继续负责其原生能力；PiDeck 与 pi 之间只通过 stdio JSON-RPC 通信。

---

## 📦 下载安装

**Windows**、**macOS**、**Linux** 平台的预构建安装包在 GitHub Release 中发布：

👉 **[BIOS Agent GitHub Releases](https://github.com/TIAN3379/PiDeck_BIOS/releases)**

安装 `BIOS-Agent-<版本>-setup.exe` 后，安装器会创建桌面快捷方式和开始菜单入口，之后可直接双击 `BIOS Agent` 图标启动。

> BIOS Agent 需要单独安装 `pi` CLI 并确保其加入系统 `PATH`。

环境要求：

- 系统 `PATH` 中可访问 `pi` 命令
- 已完成 pi 的 Provider / 登录 / API Key 配置

验证 pi 是否可用：

```bash
pi --version
pi --mode rpc
```

---

## 🧰 快速开始（从源码运行）

```bash
git clone https://github.com/TIAN3379/PiDeck_BIOS.git
cd PiDeck_BIOS
git switch BIOS_Agent
npm install
npm run make-icon
npm run dev
```

环境要求：Node.js 20+、npm。

---

## ❓ 常见问题 FAQ

**Q：PiDeck 和 pi 是什么关系？会改动我的会话文件吗？**

A：PiDeck 是 pi 的桌面外壳（不是分支）：Agent 行为、工具调用、会话读写、模型调用全部由 pi 原生完成，PiDeck 只负责窗口管理、进程生命周期、会话浏览、Git 面板、终端和设置这些「框架层」的事，两者通过 stdio JSON-RPC 通信。pi 会话仍由 pi 原生读写，PiDeck 不改变原有会话格式；导入的 Codex / Claude 会话会转换为 PiDeck 历史副本，不影响原文件。

**Q：启动后提示找不到 pi？**

A：PiDeck 依赖系统 `PATH` 中的 `pi` 命令。先在终端执行 `pi --version` 确认可用；若不可用，请先安装 pi CLI 并配置好 Provider / API Key，再启动 PiDeck。

**Q：支持哪些模型？在哪配置？**

A：模型能力完全由 pi 的配置决定。PiDeck 提供可视化编辑器管理 `models.json` / `auth.json` / `settings.json`，支持连接测试；生图模式使用独立配置的生图供应商（OpenAI / 火山方舟 / SiliconFlow 等）。

**Q：会收集我的数据吗？**

A：应用默认发送匿名、低频的 `app_heartbeat` 使用统计（可在设置中关闭），仅用于了解版本分布与平台兼容性；不会收集项目路径、代码、消息内容、会话内容或文件名，也不会上传文件。

**Q：遇到问题如何反馈？**

A：请到 [BIOS Agent GitHub Issues](https://github.com/TIAN3379/PiDeck_BIOS/issues) 提交问题；排查问题时可在设置页导出日志。

---

## 🧑‍💻 开发指南

| 命令 | 说明 |
|---|---|
| `npm run dev` | 启动开发模式 |
| `npm run typecheck` | 运行 TypeScript 类型检查 |
| `npm run test` | 运行全量单测（node --test） |
| `npm run build` | 构建 Renderer + Main 产物 |
| `npm run pack` | 快速打包（--dir，用于验证） |
| `npm run dist` | 为当前平台打包 |
| `npm run dist:win` | 打包 Windows（NSIS + portable + zip） |
| `npm run dist:mac` | 打包 macOS（DMG + zip） |
| `npm run dist:linux` | 打包 Linux（AppImage + deb + tar.gz） |
| `npm run test:e2e` | 运行 Playwright 端到端测试 |
| `npm run docs:dev` | 本地预览官网（docs-site） |
| `npm run make-icon` | 生成图标资源到 `build/icon.svg` |

### 浏览器预览模式

直接打开 `http://localhost:5173/` 进行布局和响应式调试。Renderer 在 `window.piDesktop` 不可用时自动降级为 mock 数据，无需 Electron 环境。但涉及 Agent、会话、文件操作等真实 IPC 功能仍需在 Electron 中验证。

### 项目结构

```txt
src/
├─ main/              # Electron 主进程（唯一可访问 Node 能力的业务层）
│  ├─ pi/             # pi RPC 进程管理、消息解析
│  ├─ sessions/       # 会话扫描、导入、SessionRuntimeCoordinator
│  ├─ git/            # GitService（status/diff/commit 等）
│  ├─ prompts/        # 本地模板 + XuePrompt 中文精选
│  ├─ skills/         # SkillManager
│  ├─ extensions/     # ExtensionManager
│  ├─ settings/       # SettingsStore + DesktopProxy
│  ├─ terminal/       # node-pty 终端会话
│  ├─ pet/            # 桌面宠物
│  ├─ feishu/         # 飞书集成
│  ├─ web/            # 局域网 Web 服务
│  ├─ ipc/            # IPC 域注册（按域拆分 handler）
│  └─ index.ts        # 主进程入口（只做装配）
│
├─ preload/           # contextBridge 暴露受限 IPC API
│
├─ renderer/
│  └─ src/
│     ├─ atoms/          # Jotai 状态（session-first）
│     ├─ components/     # session / sidebar / workspace / ui-shadcn 等
│     ├─ hooks/          # 渲染层 hooks
│     ├─ i18n/           # 文案（zh-CN / en-US）
│     └─ styles/         # 按域拆分的样式 + 语义 token
│
└─ shared/            # 主/渲染共享类型与 IPC 通道定义
```

更多架构约定见 [AGENTS.md](AGENTS.md)，参与开发前请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。

---

## 🤝 参与贡献

欢迎任何形式的贡献：Bug 反馈、功能建议、文档改进、代码 PR。

- 提交 Issue 前请先搜索是否已有同类问题；
- 代码 PR 请遵循仓库的架构约定与提交规范，详见 [CONTRIBUTING.md](CONTRIBUTING.md)。

感谢所有为 PiDeck 做出贡献的人！完整名单请查看 [CONTRIBUTORS.md](CONTRIBUTORS.md)。

---

## 💬 社区交流

欢迎加入 PiDeck 社区群进行交流、反馈和讨论：

| 渠道 | 入口 |
|---|---|
| **QQ 交流群** | `1026218644` |
| **微信群** | 扫描下方二维码（群二维码 7 天有效，过期请加作者微信） |
| **作者微信** | `caoayu97`（加好友请备注「PiDeck」） |

<p align="center">
  <img src="docs/images/wechat-qrcode.png" alt="PiDeck 微信群二维码" width="280" />
</p>

---

## 🔒 安全与隐私

本应用启动本地 `pi` 进程并通过 Electron IPC 暴露有限的文件操作。请仅运行你信任的源码。应用默认发送匿名、低频的 `app_heartbeat` 使用统计，用于了解版本分布、平台兼容性和活跃安装数量，可在设置中关闭；不会收集项目路径、代码、消息内容、会话内容或文件名，也不会上传文件。第三方统计服务会接收请求元数据。pi agent 子进程代理和桌面端模型拉取/测试代理可独立配置；系统浏览器打开的外部链接仍由系统浏览器网络设置决定。

---

## ☕ 赞助

如果 PiDeck 对你有帮助，欢迎请作者喝杯咖啡。微信扫码即可赞赏，感谢支持。

<p align="center">
  <img src="docs/images/wechat_pay.png" alt="微信赞赏码" width="280" />
</p>

## License

MIT
