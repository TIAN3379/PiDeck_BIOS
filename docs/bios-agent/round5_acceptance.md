# 第五轮独立验收：BM-02AR

日期：2026-10-01。工作区：`D:\BIOS_Pi_Agent\PiDeck_BIOS`，分支：`BIOS_Agent`。
依据：[第四轮历史摘要](acceptance_history.md#第四轮与-s1s5)、[BM-02AR 任务](bm02a_remediation_plan.md)和当时代码；不是仅转述实施方自测。

> 历史报告：本页 B0 已在[第六轮验收](round6_acceptance.md)关闭；当前只执行 [next_development.md](next_development.md)，不要重复修 B0 或重做 BM-02B。

## 1. 结论

**BM-02AR 主体有条件通过，可以启动 BM-02B，但先完成 B0 发布取消小修。**

S1、S2、S4、S5 已关闭；S3 的增长读取、EOF/空目录/列表末条取消、初始化竞争等待取消已通过，但发布入口还存在一个 P2 取消缺口。本轮没有发现需要推翻存储设计或重做整轮收尾的问题。

下一轮是新增能力：[BM-02B 安全写入开发任务](bm02b_development_plan.md)，不是再开一轮泛化整改。B0 完成后继续同一轮的跨进程锁、revision 冲突和单文件原子提交；暂不开放模型写工具。

## 2. 本次实际复跑

| 门禁 | 结果 |
|---|---|
| Package `npm test` | 107 个用例：106 通过、0 失败、1 显式 skip |
| 新增 `storageRemediation.test.mjs` | 18 个用例全部通过 |
| Package `npm run typecheck` | 通过 |
| Package `npm run check:format` | 26 个文件通过；未使用写入格式命令 |
| Package `npm run selfcheck` | 6 项通过 |
| 根工程 `npm run typecheck` | 通过 |
| 根工程 `npm run check:format` | 2014 个文件通过；未使用写入格式命令 |
| 根 `node --test tests/processGuards.test.mjs` | 2 通过、0 跳过 |
| `git diff --check` | 通过 |

文件型符号链接用例因本机 EPERM 跳过，不能记为通过。目录 junction 的读取及初始化逃逸用例实际运行通过。既有“两个真实子进程同时初始化”用例也随完整 Package 测试复跑通过；本轮并没有新增普通记录并发更新能力。

加载/RPC/Skills、非空 fixture 新进程读取和 G1 句柄生命周期回归均包含在上述测试内。受控故障注入证明特定分支行为，不等于真实磁盘发生过 ENOSYS/EACCES。

## 3. 第四轮问题关闭情况

| 问题 | 本轮检查结果 | 判定 |
|---|---|---|
| S1：直写最终文件的回退暴露半文件 | 删除 `wx` 最终目标回退；完整临时文件再硬链接发布；不支持时失败，目标不存在、临时文件清理 | 关闭 |
| S2：列表放入错项目的任务/清单 | 单条与列表共用 `interpretRecord`，校验 ID 和 `projectId`/`targetProjectId` | 关闭 |
| S3：增长文件及取消传播 | 不信任 stat，分块到 EOF/上限+1；读取/列表/竞争等待回归通过；发布仍漏调用级 signal | 部分关闭，剩余 B0 |
| S4：非法候选拖垮列表、异常输出无界 | 路径派生位于单条容错链；问题数/字符串字段字节有预算；非法限额拒绝；链接明确报问题 | 关闭 |
| S5：绑定重复/矛盾/多工作区任取首个 | 重复项目 ID 拒绝；组合条件共同生效；多工作区只给项目 ID 返回歧义 | 关闭 |

两处既有测试的期望修改与新契约一致：非法 registry 先报 `inconsistent-registry`；多工作区按项目 ID 查询报 `ambiguous-workspace`。不是通过削弱断言掩盖失败。

额外改进成立：JSON 解析错误不再透传可能含客户正文的原始 SyntaxError/cause；记录解析映射不再依赖 `as never`；非空 registry/档案/任务确实在新进程读取并核对 ID/revision。

## 4. B0：发布取消遗漏（P2）

位置：`packages/bios-agent/core/storage/boundary.ts`，接口声明第 93 行，`publishJson` 实现第 310～337 行（行号随修改漂移，以符号为准）。

- 接口声明接收第三个 `callSignal`，实现却只接收两个参数，仅检查 boundary 自身的 signal。
- 发布前取消检查位于 `await beforeIo("link", ...)` 之前；等待返回后没有再次检查，仍发起提交。

独立诊断在新建临时知识根执行，最终清理了该临时根，没有修改真实知识库或源码。两种情况均确定性复现：

```text
initializeKnowledgeStore + beforeIo("link") 中 abort：
  aborted=true，status="created"，registry.json 已存在

无 boundary signal 的 publishJson(path, value, 已取消的 callSignal)：
  aborted=true，status="created"
```

预期：提交 IO 尚未发起时任一有效 signal 已取消，应返回 `cancelled`，不创建目标并清理自己的临时文件。提交 IO 一旦成功，返回真实提交状态；不能因随后取消假称“没写入”或删除已提交目标。

修复与永久回归放在下一轮 B0，**不能把当前 S3 写成全部关闭**。这不是半文件问题，S1 无需重开。

## 5. 文档与证据边界

- 本次将 README/实施记录中 `maxListProblems` 默认 64 修正为源码实际的 **50**。
- `maxListBytes` 当前累计摘要/问题的字符串字段 UTF-8 字节，不等于完整 JSON 序列化响应大小；后续工具层仍要控制最终输出预算。
- `droppedProblems` 是预算截断后未检查候选的计数下界，不是“已确定损坏但没有展示”的精确数量。
- 测试清单中“本轮未重跑真实并发初始化”的说法已按本次实际复跑修正。

尚未验证：Linux/macOS、干净 clone 独立安装、远端 CI、根全量测试、生产构建/安装包、真实 EACCES、告警数量上限实际触顶。没有授权真实 BIOS 样例，不能宣称厂商或芯片平台适配成功。

## 6. 交付与下一步

当前上一轮文档和 Package 骨架已有提交；本轮源文件修改及新增实施记录/测试仍在工作树中。此次验收只修改文档，不修改生产代码、不 `git add`/`commit`/`push`，也不替用户清理现有改动。

下一轮顺序：**B0 取消闭环 → B1 写入契约 → B2 跨进程锁 → B3 单文件提交 → B4 真实竞争/故障测试**。全部完成再交回独立验收；BM-02C 的 journal、跨文件事务和迁移恢复仍留到之后。
