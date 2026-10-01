# BIOS Agent 第三轮验收：BM-01R2

日期：2026-10-01。基于当前 `BIOS_Agent` 本地工作区，不对应已提交或已发布版本。

> 历史报告：G1 已修复并独立复验通过；BM-02A 主体已实现。当前存储收尾问题见 [第四轮验收](round4_acceptance.md)，下一轮使用 [BM-02AR 任务](bm02a_remediation_plan.md)。

结论：上一轮 F1～F4 的功能修复通过；60 个测试全部通过、无跳过，但取消路径仍有一个目录句柄清理缺陷 G1（P2）。BM-01R2 功能通过，资源生命周期尚未完全闭环。

不需要再开一轮大整改。下一位开发 AI 先修 G1 并补回归，门禁通过后在同一开发轮进入 BM-02A。具体任务和提示词见 [BM-02A 开发说明](bm02a_development_plan.md)。存储、桌面 UI、厂商识别尚未实现，不是本轮承诺后遗漏的功能。

## 1. 独立复跑结果

环境：Windows、Node 24.14.1、Pi 开发宿主 0.87.1；使用现有根工程和 Package 依赖，没有重装依赖或调用模型。

| 门禁 | 实际结果 |
|---|---|
| Package `npm test` | 60 通过、0 失败、0 跳过；出现目录句柄 GC 清理警告 |
| Package `npm run typecheck` | 通过 |
| Package `npm run check:format` | 16 文件通过，无格式修改 |
| Package `npm run selfcheck` | 5 项通过 |
| 根工程 `npm run typecheck` | 通过 |
| 根工程 `npm run check:format` | 2014 文件通过，无格式修改 |
| `node --test tests/processGuards.test.mjs` | 2 通过、0 失败、0 跳过 |
| `git diff --check` | 通过；该命令不覆盖未跟踪文件 |

包内 60 用例分布：authorization 13、contracts 15、extensionLoad 8、paths 14、probe 10。与上轮 45 用例相比新增 15 个。SDK 工具装载、离线 CLI/RPC、Skills 隔离和工具层取消均实际执行；不等同于安装版桌面集成测试。

## 2. 上轮问题闭环

| 问题 | 本轮核查 | 结论 |
|---|---|---|
| F1：保留主名带后缀，schema 与运行时接受集合不一致 | `ids.ts` 共享负向断言覆盖保留名的点后缀；运行时先按共享正则判断再分类错误；用例覆盖 schema/运行时/路径入口 | 通过 |
| F2：Windows 无盘符根、paths 入口旁路 | 完全限定路径检查用于根解析、布局字符串/对象入口和默认 home；盘符相对及根相对路径被拒绝，规范化一致 | 通过 |
| F3：小目录异步等待期间取消返回成功 | 小目录、空目录和工具层 AbortSignal 均拒绝为 cancelled；源码已覆盖 opendir 后、条目、结束与返回前检查 | 功能通过；清理新增 G1 |
| F4：额外根接受相对配置 | 额外根和 ctx.cwd 均要求完全限定路径；不可达额外根单独返回，realpath 去重 | 通过 |

上轮附带建议也有落实：README 说明两层安装前提；RPC 测试增加 stderr 上限、close 收尾及 stdin 错误处理；合法 `..cache` 不再误拒；扫描新增丢弃告警/跳过目录计数。

告警超限分支目前主要靠代码检查，测试只覆盖计数初值和不变量，没有实际制造超过 50 个不可读子目录。不能将它写为“告警触顶已实测”。这不阻止先推进存储基础。

## 3. G1（P2）：取消时跳过目录句柄关闭

位置：`packages/bios-agent/core/projects/probe.ts:158–168`，关闭兜底在 216–218 行。

当前顺序是：

```text
await opendir() 成功，获得目录句柄
throwIfAborted()                 ← 在 try/finally 外面抛错
try { for await (...) { ... } }
finally { await dir.close() }
```

若用户在 opendir 等待期间取消，新增检查会正确抛出 ProbeCancelledError，却跳过 finally。此时还没进入目录异步迭代器，迭代器也不会替它关闭句柄。资源只能等垃圾回收，频繁取消时会积累未及时释放的目录句柄。

独立复现：在 Package 目录启动 `node --expose-gc --trace-warnings --input-type=module`，连续三次调用 `probeProjectDirectory('./core/contracts', { signal })` 后立即 abort；等待拒绝后触发 GC。只扫描已有目录名，不写业务文件。结果：

```json
{
  "cancelled": 3,
  "warnings": [
    "Closing directory handle on garbage collection",
    "Closing directory handle on garbage collection",
    "Closing directory handle on garbage collection"
  ]
}
```

因此不是只凭警告猜测问题：取消点在保护范围之外与实际 GC 警告一致。现有测试只断言拒绝，没有验证资源关闭，故全部通过仍可漏掉本问题。

修复要求：成功获取句柄后，所有可能抛错的取消检查都处于可靠的关闭保护范围内；保持 opendir 失败仍按现有规则记录 warning，不把 cancelled 吞成成功。新增资源生命周期回归，证明取消拒绝前句柄已关闭，而非靠 GC 兜底。正常完成、预算截断、迭代中取消也要保持可用；只对已关闭句柄的预期错误做必要容错。

## 4. 当前能力边界与交付状态

- 已实现：独立 Pi Package、纯数据契约、统一路径解析、真实路径授权、有界可取消的只读线索工具、两个 Skills、包内门禁。
- 未实现：JSON 存储、registry、跨进程更新、持久化工程记忆、历史经验检索、上下文选择、BIOS 专业 UI。
- 真实 Git worktree 目前只是数据结构可表达，不是已完成实际绑定/迁移；没有真实 BIOS 平台支持结论。
- 本机测试不等于 Linux/macOS、完整干净 clone、远端 GitHub Actions、生产构建或安装包验证；这些本轮未执行。
- `packages/`、锁文件及新增文档仍未跟踪；CI/Biome 有本地修改。没有提交、推送或证明远端 CI 通过。
- 本次验收只读源码、运行测试/诊断并更新文档，没有修复业务源码或修改真实 BIOS 项目。

## 5. 下一步决定

依照分阶段 MVP 工作流，下一轮限定为“G1 小修 + BM-02A 存储基础”，不同时开发完整事务、经验系统或桌面 UI。

BM-02A 的价值是让工程知识有一个可靠、可重启读取的载体；之后 BM-02B/C 才承担安全更新与恢复，BM-03 再做项目身份确认。不能在没有更新协议前给模型开放任意 save/update 工具。

按 [BM-02A 开发说明](bm02a_development_plan.md) 实施，完成后提交本地结果供独立验收；提交/推送仍须用户另行授权。
