# 测试清单

适用：v0.9.3（2026-10-07）。使用隔离配置与合成工程，不污染用户知识、安装配置或客户代码。

## 自动门禁

```powershell
npm run typecheck
npm run check:format
npm test
npm --prefix packages/bios-agent run typecheck
npm --prefix packages/bios-agent run check:format
npm --prefix packages/bios-agent test
npm --prefix packages/bios-agent run selfcheck
node scripts/sync-workflow-choices.js --check
npm run build
npm run docs:build
node scripts/verify-asar-runtime.js release/win-unpacked
git diff --check
```

## GUI 与目录包

完整构建后启动真实 Electron 窗口，fixture 隔离 userData：

```powershell
npx playwright test e2e/bios-library.spec.ts e2e/bios-first-run-gate.spec.mts e2e/bios-connections.spec.mts
```

打包后再验证：

```powershell
$env:PIDEK_E2E_EXECUTABLE_PATH = (Resolve-Path 'release/win-unpacked/BIOS Agent.exe').Path
npx playwright test e2e/bios-library.spec.ts e2e/bios-first-run-gate.spec.mts e2e/bios-connections.spec.mts
Remove-Item Env:PIDEK_E2E_EXECUTABLE_PATH
```

覆盖接入重试/确认、普通聊天隔离、重复接入、取消刷新、本地库浏览/编辑、退出保护和审核退回。任务/历史/接续/复盘另在根 tests、Package tests 与其它 bios E2E 回归。

## 本版执行结果

2026-10-07 本机实跑：

- 根全量：6405 项，6399 通过、6 跳过、0 失败；Package 全量：879 项，874 通过、5 跳过、0 失败。
- 根与 Package 类型/格式检查、selfcheck 6 项、workflow choices 校验、完整应用构建、文档站构建通过。
- 开发构建上述三文件 GUI：9/9 通过；v0.9.3 目录包相同组重复两轮：18/18 通过，用户数据隔离。
- GUI 首跑有 1 条新会话启动时序失败，补上输入框就绪/历史恢复/发送可用等待后完整复跑通过；没有放宽业务断言。
- 包内 11 个主进程运行依赖、模型目录、sql.js WASM 和冗余清理核对通过；修正旧 DSH 校验列表后 packaging 定向 2/2 通过。
- 95 份旧轮次文档移除、8 份当前文档保留；检查不将客户代码/用户配置/知识/凭据/备份和二进制提交到公开源代码。

跳过项不计为通过。GUI 使用 mock Pi 及合成工程，不代表真实云模型、硬件或干净电脑安装。

## 未覆盖

干净新电脑安装/首次下载、真实云模型、Pi 所有新版本、固件编译/烧录/上板/量产、多机共享库、网络盘/断电恢复、macOS/Linux。合成测试只证明明确覆盖的路径。
