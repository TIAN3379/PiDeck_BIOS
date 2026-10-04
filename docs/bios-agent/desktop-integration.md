# BIOS Agent Package 与桌面端接入

本文只回答一件事：`packages/bios-agent` 这个 Pi Package 在**现有桌面端**的扩展／技能加载与禁用机制下
会被怎样对待，正式接入（BM-07）需要做什么、不能做什么。

本轮（BM-00／BM-01）**没有修改任何桌面端代码**，结论来自对本机 Pi 宿主（0.87.1）与桌面端现有实现的只读核对，
以及可复现的加载实测（见 §3）。行号会随代码演进漂移，请以符号名为准。

> 最新复验：[第二十九轮验收](round29_acceptance.md)，732 项（727 通过、0 失败、5 skip）；正常经验业务已交付，但 R29 四组待收尾、整批未通过。不代表专业知识已接入桌面。
> 当前 [R29 收尾＋BM-05 完整任务/人工交接批次](bm05_development_plan.md) 在 Package 内完成领域服务与人工入口，不改 PiRuntime/Electron；内部门禁后继续业务，一次交回。真实 Pi 工具/上下文接入为 BM-06，知识 UI 为 BM-07。
> 第十一轮 C2A/C2AR、第九轮 C1/C1R 的声明范围通过结论保持。本文描述现有接入机制，不代表桌面 BIOS 集成或远端 CI 已完成；UI 仍按原路线留 BM-07。

## 1. 现有机制（核对于 2026-10-01）

### 1.1 扩展注入

- 组装 `--extension` 的地方：`src/main/extensions/builtInExtensions.ts` → `appendBuiltInExtensionArgs()`。
- 内置清单常量：`BUILT_IN_EXTENSIONS`（14 项）、`INTERNAL_BUILT_IN_EXTENSIONS`、`ALL_BUILT_IN_EXTENSIONS`（同文件）。
- 调用点：`src/main/pi/PiProcess.ts` → `start()`（展开内置注入 + 白名单分支）；
  注入器由 `src/main/extensions/piProcessExtensionResolvers.ts` → `createPiProcessExtensionResolvers()` 提供，
  在 `src/main/pi/AgentManager.ts` 装配进 PiProcess。
- 用户移除项：`src/shared/types/settings.ts` → `removedBuiltInExtensions`，
  过滤发生在 `listActiveBuiltInExtensionPaths()`（`pi-deck-shell-proxy.ts` 作为内部适配器恒保留）。

### 1.2 路径解析（dev / 打包 / 覆盖层）

- `resolveBuiltInExtensionsDir()`：dev 取 `appPath/resources/extensions`，打包态取 `resourcesPath/extensions`。
- `resolveBuiltInExtensionsOverlayDir()`：`<userData>/builtin-extensions`（热更新覆盖层）。
- `resolveBuiltInExtensionPath()`：**覆盖层优先、其次随包**；覆盖层是否被采信由
  `src/main/extensions/builtInExtensionsManifest.ts` → `readVerifiedArtifact()` 整份校验决定。

### 1.3 禁用开关（真实存在，不是可选设计）

- 设置项：`src/shared/types/settings.ts` → `piRpcNoExtensions`、`piRpcNoSkills`；
  由 `PiProcess.start()` 直接转成 `--no-extensions` / `--no-skills`（诊断用总开关）。
- **白名单模式**：扩展与技能分别判断。存在被禁用的扩展（全局或项目级）且白名单模式生效时，
  `PiProcess.start()` 会加 `--no-extensions`，只注入扩展解析器输出的路径
  （`enabledExtensionResolver.resolveEnabledExtensionPaths()`）；
  被禁用的技能由独立的技能解析器处理，走 `--no-skills` + 逐条 `--skill`。
- 版本门槛：`src/main/extensions/extensionVersionGate.ts` 的
  `MIN_PI_MINOR_VERSION_FOR_EXTENSION_WHITELIST` / `_SKILL_WHITELIST`——Pi 版本低于门槛时降级为默认发现。

### 1.4 技能加载

- 解析器：`src/main/skills/piProcessSkillResolvers.ts` → `skillWhitelistResolver.resolveEnabledSkillPaths()`。
- **返回 `null`（即没有任何禁用项）时完全不传 `--skill`**，技能发现交给 pi 自己。
- pi 自己会扫描的技能根（`skillWhitelistResolver.ts` 的 `buildLocations()` 一带）包括：
  `~/.pi/agent/skills`、`~/.agents/skills`、`<cwd>/.pi/skills`、从 cwd 到仓库根的祖先 `.agents/skills`、
  settings.json 里的显式 `skills`，以及 **package 资源**（`pi.skills` 清单或约定 `skills/` 目录，
  经 `src/main/packageResourceResolver.ts` → `resolveConfiguredPackageResources()`）。
- 桌面端的内置技能**不是**用 `--skill` 注入的，而是被复制到 `~/.pi/agent/skills`（`SkillManager.installTemplate()` 等）。

### 1.5 打包资源

- `package.json` → `build.extraResources`：`resources/extensions`（filter 为 `*.ts` + `extensions-manifest.json`）、
  `resources/skills`、`resources/prompts`、`node_modules/undici` → `extensions/node_modules/undici` 等。
- 清单生成：`scripts/generate-extensions-manifest.mjs`、`scripts/generate-content-manifests.mjs`。
- 守卫测试：`tests/extensionPackagingDeps.test.mjs`、`tests/builtInExtensions.test.mjs`、
  `tests/distDevConfig.test.mjs`、`tests/processGuards.test.mjs`。

## 2. 本 Package 的接入结论

### 2.1 实测：`-e <包目录>` 同时加载扩展与 Skills

用包根目录（不是单个文件）作为 `-e` 参数时：

- 扩展加载成功（退出码 0，stderr 无 `Failed to load extension`）；
- 同一次启动中下发 RPC `get_commands`，列表中包含
  `skill:bios-project-onboarding` 与 `skill:customer-feature-porting`。

因此 **Pi 0.87.1 的目录形式 `-e` 会同时发现 Package 清单里的 Skills**，
`mvp_development_plan.md` §10 中"是否同时发现 Skills，应按当前 Pi 实际行为测试"这一项至此有了本机答案。

注意：同一次启动还会列出宿主已有的技能（如 `skill:image-gen`、`skill:pideck-doctor`、`skill:usage-probe`）。
`-e` **不做来源隔离**，只是追加一个来源。

### 2.2 正式接入时必须验证的三个边界

1. **桌面白名单需要正确解析本包。**
   桌面扩展白名单生效时，由解析器决定显式注入哪些扩展；技能白名单单独决定技能路径。
   Pi 的 `--no-extensions` 本身不拒绝显式 `-e`，但不能因此绕过桌面禁用逻辑。
   → 正式接入（BM-07）要把 bios-agent 纳入相应解析器链路，不能依赖用户手工追加参数。

2. **多来源加载与去重。**
   Pi 0.87.1 的资源合并与扩展发现包含路径去重；同一包在 packages 设置与 `-e` 中出现，
   不能直接断言必然注册两次。不同路径下的包副本、不同注册入口则仍有重复注册风险。
   → 为本包明确一个分发/配置来源，并补同路径、多副本、reload 的实际测试；不能只靠路径去重推断所有情形安全。

3. **禁用开关不得为 BIOS 能力开例外。**
   `piRpcNoExtensions` / `piRpcNoSkills` 与白名单模式都必须对 bios-agent 继续生效
   （用户禁用后 BIOS 能力应当一起消失，而不是"重要所以强行注入"）。

### 2.3 可以确认没有冲突的地方

- **热更新覆盖层不会碰到本包**：`resolveBuiltInExtensionPath()` 只接受
  `isBuiltInExtensionName()` 认可的名字（即 `ALL_BUILT_IN_EXTENSIONS` 内的内置扩展），
  更新器写覆盖层时也只写本地清单里已认识的文件。因此本包既不会被覆盖层覆盖，也不会被自动更新。
- **桌面端的删除／禁用逻辑只作用于 `pi-deck-*`**：`ExtensionManager.disableBuiltIn()` 对非 `pi-deck-` 前缀直接抛错，
  `removeBuiltInFile()` 也只处理内置扩展文件。本包不会被这些路径删除。

### 2.4 随包分发（未来）需要同步改动的地方

- `package.json` → `build.extraResources` 新增条目与 `filter`（漏了 filter 会导致打包版缺文件）。
- 独立 Package 的运行依赖应由自己的 manifest 声明并随实际 Package 布局可解析。
  如果选择复用现有内置扩展分发/更新机制，才需同时处理 `extensions/node_modules/<pkg>` 与
  `VENDOR_DEP_PACKAGE_NAMES`（`src/main/extensions/builtInExtensionsUpdater.ts`）；这不是所有 Pi Package 的强制目录。
- **守卫覆盖不到本包**：`tests/extensionPackagingDeps.test.mjs` 目前只扫描 `resources/extensions/*.ts`。
  把包放进 `packages/bios-agent` 不会被它扫到，需要另加守卫或把该目录纳入扫描范围。

### 2.5 知识根必须"一份解析"（词法配置边界已复验）

知识根的统一解析函数在 `packages/bios-agent/core/paths.ts`：

- 默认值为 `<用户目录>/BIOS_Knowledge`，不含任何盘符假设（第一轮的硬编码 `D:\BIOS_Knowledge` 已移除）；
- override/env、paths 字符串/对象及默认 home 入口共用完全限定路径要求；Windows 无盘符根相对、盘符相对和普通相对路径均拒绝（第二轮 F2 已闭环）；真实 IO 链接策略仍由 BM-02A 实现；
- 正式接入时桌面适配层应传入 `<userData>/bios-knowledge`，独立 CLI 使用默认值或显式完全限定绝对路径，
  两者都可用 `BIOS_KNOWLEDGE_ROOT` 覆盖。

core 不依赖 Electron；桌面与 CLI 复用统一解析规则，不允许各自隐式按 cwd 拼路径。

若希望知识根仍放在项目盘（例如 `D:\BIOS_Knowledge`），通过显式绝对路径配置或环境变量表达即可——
位置应由配置决定，而不是由代码默认值决定。

### 2.6 目标目录的授权范围（配置边界已复验）

`bios_detect_project` 不再接受任意目录：默认授权根是会话工作目录，
额外根只能由适配层通过 `BIOS_AUTHORIZED_ROOTS` 注入（**模型不能用工具参数给自己扩权**），
校验使用真实路径，因此根内指向根外的链接会被拒绝。被拒绝时不返回目标目录内的任何线索。

额外根必须由用户/适配层指定完全限定绝对路径；相对配置被拒绝，不再按进程 cwd 补全（第二轮 F4 已闭环）。不可达的合法配置单独返回 unreachableRoots，生效根按 realpath 去重。

## 3. 可复现的验收步骤

```powershell
# 1. 从仓库根开始安装工具链，再安装包内开发宿主
#    tsc/Biome 目前来自根工程；不要依赖个人全局安装
npm ci
cd packages\bios-agent
npm ci

# 2. 包内门禁
npm run typecheck
npm run check:format
npm test
npm run selfcheck

# 3. CLI 加载（不连模型：RPC 模式 + 立即关闭 stdin）
#    PATH 上没有 pi 时，把 pi 换成：
#    node packages\bios-agent\node_modules\@earendil-works\pi-coding-agent\dist\bundle\cli.js
pi --mode rpc --no-session --no-context-files --no-approve -e <packages\bios-agent 绝对路径>
#    期望：退出码 0；stderr 不出现 "Failed to load extension"

# 4. 扩展与 Skills 发现（沿用同一次启动，下发一条 RPC 命令）
#    {"id":"c1","type":"get_commands"}
#    期望：响应中包含 skill:bios-project-onboarding、skill:customer-feature-porting
```

第 2～4 步已全部自动化为 `tests/extensionLoad.test.mjs`：SDK 装载与工具注册/调用、CLI `-e` 加载、
以及隔离配置（临时 cwd + `PI_CODING_AGENT_DIR`）下的 `get_commands` / Skills 断言，
并反证宿主自带技能未混入。宿主缺失时该文件**失败**（不再 skip 冒充通过），
可用 `PI_CODING_AGENT_ROOT` 指向已有宿主目录；CI 配置已增加宿主安装和 Package 门禁步骤，远端运行尚未验证。

## 4. 本轮明确不做

- 不注册 BIOS IPC、不新增 preload 通道、不加渲染层 UI；
- 不改 `resources/extensions/**` 与内置扩展清单（避免影响 14 个内置扩展与 manifest 校验）；
- 不使用 `--no-extensions` / `--no-skills` 之外的旁路来"保证 BIOS 能力可用"。
