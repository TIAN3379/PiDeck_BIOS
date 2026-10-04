# 第十六轮独立验收：BM-02C3

日期：2026-10-02。工作区 `D:\BIOS_Pi_Agent\PiDeck_BIOS`，分支 `BIOS_Agent`。

结论：**C3 主流程与既有回归通过，整体暂未通过。** 独立补充诊断发现 PF-1～PF-4；下一轮只做 [C3 有限收尾](bm02c3_remediation_plan.md)，不启动备份/CLI/业务记忆实现。第十五轮已关闭的审核持久化问题不重做。

本轮另按用户要求补齐 [分层记忆与时态一致性设计](layered_memory_temporal_design.md)，并更新 MVP 路线。它是 BM-03～05 的设计前置，不是 C3 的新增实现要求。此次只改文档，未修改运行代码、提交或推送。

## 1. 独立复跑

| 检查 | 实际结果 |
|---|---|
| Package `npm test` | 383 项：381 通过、0 失败、2 显式 skip |
| C3 + 审核/journal 七文件针对性测试 | 200 项全部通过 |
| Package `typecheck` / `selfcheck` / `check:format` | 通过；selfcheck 6 项；格式检查 64 文件 |
| 根 `typecheck` / `check:format` | 通过；格式检查 2014 文件 |
| 根 `tests/processGuards.test.mjs` | 2 项全部通过 |
| `git diff --check` | 通过 |

针对性命令及全部门禁见 [收尾方案 §4](bm02c3_remediation_plan.md#4-门禁与交付)。额外诊断使用新建的合成临时库，不接触真实知识库/客户源码；诊断用目录已清理。补充诊断不计入永久测试数量。

当前有一个证据口径限制：新增叶子文件 symlink 用例在本机权限不足时执行空的“不适用”子测试，并计为通过。上述 381 是测试运行器的实际计数，**不代表叶子链接行为在本机得到验证**。已有两个显式 skip 保持；下一轮应如实标记新增环境限制，不能为维持 skip 数把未执行行为计为通过。中间目录 junction 用例实际通过。

## 2. 已通过范围

- 窄出口 `inspectKnowledgeStore`，固定落点扫描，不注册模型工具/CLI/IPC/UI。
- 业务 schema v1、journal v1/v2、intent v1、audit v1 分族解释；不编造旧格式转换或主动升版。
- 坏 JSON、记录身份/归属、未来版本、缺档案、prepared/conflict、锁和临时残留的现有用例通过。
- 有界读取、失败读取预留额度、取消传播、候选并发消失，以及只读清单/文件 hash 证据通过。
- C2B 已验收范围的审核/恢复/清理回归未退化。

以上不是完整性证明、原子快照、断电保证或安全备份许可；没有真实硬件/IBV 适配验收。

## 3. 必须关闭的四项

### PF-1 · P1：根列举失败被吞掉，返回完整通过

位置：`core/storage/preflight/categories.ts` 的 `scanRootExtras`，以及 `scan.ts` 的 `pathState` / `listEntriesBounded`。

复现：初始化合法空库；通过既有 `beforeIo` 在 `operation === "opendir" && target === root` 时抛带 `code="EACCES"` 的合成错误。此前固定目录扫描正常。

实际结果：

```json
{"complete":true,"outcome":"no-migration-needed","problems":[],"truncatedBy":[]}
```

`listEntriesBounded` 已把错误交回，`scanRootExtras` 却直接返回；根布局外的文件/残留没有扫描，报告仍声称完整。应结构化拒绝根级失败，或返回明确不完整/阻断的报告，不能与成功或可选目录缺席等价。

另一个同域缺口：在 `experiences` 的 `stat` hook 抛结构化 `permission-denied`，错误直接穿出 `pathState`，无法按非根目录问题收集后继续。下一轮一起统一错误策略，仍须让取消穿透。这里只证明受控故障注入路径，未声称完成真实 Windows ACL 验证。

### PF-2 · P2：问题与人工事项没有共享条数预算

位置：`scan.ts` 的 `addProblem` / `addManual`；`limits.ts` 明确 `maxProblems` 包含人工事项。

复现：合法库中放 `experiences/bad.json`（内容 `{`）及一个受控锁目录；设置 `maxProblems=1`。

实际：`problems.length=1`，`manual.length=1`，合计 2，`complete=true`，`truncatedBy=[]`。两个数组分别比较同一个上限，实际放大成两份额度。

要求：共同保留条数不超过 1；丢弃明细仍保留阻断/人工总计，并标记 `incomplete`。不能改文档把共享预算解释为两份来绕过完成标准。

### PF-3 · P2：输出字节口径不等于实际序列化结果

位置：`scan.ts` 的 `measure` / 三类报告追加函数；`limits.ts` / `contract.ts` 的输出口径。

复现：合法空初始化库先宽预算扫描，得到 `outputBytes=184`；再设置 `maxOutputBytes=184` 扫描。

实际：报告仍为 `complete=true / no-migration-needed`，`outputBytes=184`，但 `JSON.stringify(summaries)` 与 `JSON.stringify(problems)` 的实际 UTF-8 字节合计为 **189**。对象逐条计量漏掉数组括号/逗号；人工事项又被计入计数而未写进字段的口径说明。

要求：明确包含摘要、问题、人工事项三组可变明细的实际序列化口径，统一代码/类型注释/文档。固定报告信封是否计入可以明确约定，但不得声称计入而漏算。边界值、空数组、中文/转义字符和混合明细必须有独立字节断言，不用自身计数证明自身正确。

### PF-4 · P2：目录截断后漏计已扫描条目

位置：`scan.ts` 的 `listEntriesBounded` / `chargeEntry`。

复现：合法空初始化库，设置 `maxScanEntries=1`。此前项目等固定目录为空，最终根列举触顶。

实际：`incomplete` 判定正确，但 `scannedEntries=0`；底层已经观察条目并以 `listing.scanned` 返回，截断分支全部丢掉。已消耗预算却报告零扫描，无法支持之后的诊断/预算复用。

要求：统计包含截断时已观察的条目，明确是否包含唯一的超限探测条目；底层计量与候选处理不重复扣账。跨目录共用总预算，不通过只改统计名称掩盖真实成本。

## 4. 下一步与未测范围

当前唯一执行任务：**BM-02C3R，关闭 PF-1～PF-4，并修正环境未执行用例的计数口径。** 不增加新的业务特性，不借此重写 Boundary 或改变既有写入协议。

未执行根全量测试、生产打包/安装、远端 CI、干净 clone、其他 OS、真实 ACL、断电实验、真实 BIOS 样例。分层记忆文档是设计交付，不能记为记忆引擎已实现。

C3 收尾独立通过后，再按原路线拆分备份/恢复与最小管理 CLI；进入 BM-03～05 前执行记忆设计中的契约/兼容性闸门。UI 仍留 BM-07。
