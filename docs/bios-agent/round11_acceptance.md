# 第十一轮独立验收：BM-02C2AR

日期：2026-10-01。工作区 `D:\BIOS_Pi_Agent\PiDeck_BIOS`，分支 `BIOS_Agent`。

结论：**C2A/C2AR 在本轮声明的协议与纯校验范围内通过，A1～A3 关闭。** 未发现阻塞该范围交付的新问题。通过的是设计与纯函数，不是尚未实现的审核持久化。下一轮执行 [BM-02C2B：最小审核持久化闭环](bm02c2b_development_plan.md)。

## 1. 独立复跑

| 目录 | 命令 | 结果 |
|---|---|---|
| `packages/bios-agent` | `npm test` | 253 项：251 pass、0 fail、2 文件 symlink 权限 skip；约 33.0 秒 |
| 同上 | `node --test tests/auditContracts.test.mjs tests/auditAssociation.test.mjs` | 33 项全部通过，0 skip；约 0.8 秒 |
| 同上 | `npm run typecheck` | 通过 |
| 同上 | `npm run check:format` | 45 文件通过，未修改文件 |
| 同上 | `npm run selfcheck` | 6 项通过 |
| 仓库根 | `npm run typecheck` | 通过 |
| 仓库根 | `npm run check:format` | 2014 文件通过，未修改文件 |
| 仓库根 | `node --test tests/processGuards.test.mjs` | 2 项通过 |
| 仓库根 | `git diff --check` | 通过；不覆盖未跟踪内容 |

新增永久用例 18 项：事件测试 15→17，新增关联测试 16；没有削弱原 235 基线，没有新增 skip。两个 skip 仍是本机文件型符号链接权限，不能算通过。

源码核对：`audit.ts` 212 行、`auditValidation.ts` 429 行、`auditIntent.ts` 183 行、`auditAssociation.ts` 236 行。校验模块略超过 400 行目标，未到 600 行评估红线；本轮不以此要求无关重构，后续 IO 另建模块，不能塞进纯契约。契约没有引入 storage/Electron/Pi/文件 IO。

## 2. A1～A3 的关闭依据

| 项 | 协议与代码 | 永久回归与独立检查 | 结论 |
|---|---|---|---|
| A1 提前终态漏审计 | 实施记录 §3.1/§3.4 明确 writer/recovery 均先发布或认领事件，再写完成终态；二次中断、事件失败、终态缺事件都有保守分支 | publish/claim 纯结果区分事件存在；本轮检查窗口表的先后顺序。真正的磁盘窗口测试留 C2B，不冒充已测 | 协议范围关闭 |
| A2 发布事实误判冲突 | `compareAuditAssociation` 比较稳定决定字段，已有事件先完整校验，再返回原事件，保留 publication/recordedAt | writer 认领、recovery 二次认领、键顺序、逐项决定冲突用例通过；独立改变发布时间/来源仍认领并保留原值，改变决定仍拒绝 | 关闭 |
| A3 缺失意图降级/绑定不足 | 审核采用未来专用 v2 discriminator 与完整绑定；意图、关联投影、实测意图 hash 和已有事件逐项核对；实际 v1 不扩义 | 投影版本/派生名/身份/hash 回归通过；独立使用 Node SHA-256 计算真实序列化意图指纹，换内容或仅换键顺序却沿用旧 hash 均拒绝；重新绑定真实 hash 后等价决定可认领 | 关闭 |

额外内联诊断共 29 个关联/边界场景，不写业务文件，不计入 253 项永久测试：

- 不存在事件只返回 publish，不预支来源与时间；undefined 不是“事件不存在”。
- writer/recovery 各用两个合法时间认领，返回原事件；11 种合法但不同的决定拒绝。
- 关联投影的 operationId/eventId/target/before/after 改动拒绝；缺失或未来版本意图、错误实测 hash 拒绝。
- 深冻结意图、投影与事件后仍可认领，无输入修改。
- 32 条外部证据接近预算、标签/理由控制字符转义、最长 ID、安全 revision/时间上界：合法事件实测 **12,979 字节**，证据 **8,187 字节**，低于当前 13,056 字节保守预算及 16 KiB 总闸门。

另直接调用现有 v1 journal 校验器：完整 v1 样例通过，仅改 journalVersion 为 2 后得到 unsupported-journal-version，确认旧解释不静默接收审核 v2。没有调用 IO 恢复器，因此不把此项称为审核恢复实测。

## 3. 同轮收口与后续实现约束

理由上限已统一为 1024 字节，未知 action 的结构层错误已澄清；hash 14 个非法格式及转义边界进入永久测试。200 条扫描上限现在明确只约束诊断后处理，不保证未知输入的整体验证成本恒定。

未来结果已区分未提交、业务已提交但审计待补、事件已存在但 journal 待收口、全部完成。C2B 实现时还必须钉死这些细节，不能只照伪代码填字段：

- 没有事件时，writer/recovery 根据实际执行路径生成自己的 publication；§3.3 的 writer 示例不能套到恢复器。
- 取消按阶段判断：提交前取消中止；业务/事件发布后迟到取消不能否认已发生的事实。§3.4“取消不发事件”只适用于该发布尚未发生的窗口。
- `recordedAt` 是发布尝试时记录的时间标签，不是认证或精确文件系统落盘时间；校验其与 decidedAt 的先后，不能升级为掉电持久性保证。
- 审核完成终态幂等返回仍须验证事件/意图关联；合法业务记录后来增加 revision，不是重放旧审核的理由。

这些是下一轮 IO 的明确验收条件，不要求再开纯协议轮次。修正后的唯一协议见 [C2A 实施记录 §3](bm02c2a_implementation.md#3-一致性协议c2ar-1-修正后的唯一版本)，实际落地以 [C2B 任务](bm02c2b_development_plan.md) 的明确规则为准。

## 4. 未测与范围

尚无 audit 目录、审核写入口、完整 journal v2 或审核恢复器；本轮没有跨文件 IO、审核多进程竞争或审核崩溃恢复实测。没有身份认证、企业权限模型或硬件验证证据真实性判断。

未执行根全量测试、生产构建/安装包、远端 CI、干净 clone、Linux/macOS、断电、真实 BIOS 项目。旧 C1 的进程终止测试不等于新审核协议已经通过，也不等于电源故障实验。

本次只更新文档，未修改生产源码/永久测试，未新增删除，未 add/commit/push，未改 PiRuntime，未读取客户资料。保留全部既有累积改动与历史删除。分阶段 MVP 技能用于将下一轮限定为一次经验卡审核闭环，文档写作技能用于区分独立实测、实施方记录和未来 IO 任务。
