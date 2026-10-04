# BM-02C2A 实施记录（审核审计契约与一致性协议）

日期：2026-10-01
状态：**C2A/C2AR 已经第十一轮独立验收通过（协议与纯校验范围），A1～A3 关闭**；
最新结论见 [第十一轮验收](round11_acceptance.md)，修正见本文 §3、§6；[第十轮验收](round10_acceptance.md) 保留问题来源。下一轮按 [C2B 方案](bm02c2b_development_plan.md) 实现 IO。
本轮仍**不实现审核持久化 IO**，也不改变 journal v1（§3.6 定义将来审核专用 v2 的协议，但不落 IO）。
前置：[第九轮独立验收](round9_acceptance.md)（C1/C1R 在本机范围通过，J1～J4 关闭）。
任务与完成标准：[C2A 开发方案](bm02c2a_development_plan.md)。本文是该轮唯一实施记录，不是独立验收报告。

范围：`packages/bios-agent/core/contracts/`（新增 `audit.ts` / `auditValidation.ts` 与契约出口）、
`tests/auditContracts.test.mjs`、本包 README 与本文档。**不含**审核写入口、审计 IO、通用多文件事务、
迁移/备份/CLI/UI/RAG/厂商适配/模型写工具，也不改 PiRuntime。

---

## 1. 交付边界（先说清楚做与不做）

| 做 | 不做（本轮明确不做，留给后续） |
|---|---|
| 审核审计的**纯** schema/类型（typebox schema 是唯一来源） | 任何审计文件的读写（无 IO、无目录创建），留给 C2B |
| 不可信输入的**纯**解释与结构化拒绝（跨字段、安全 revision、时间、限额、脱敏） | 审核写入口（CLI/UI 域入口）、权限实现、LLM 批准工具 |
| **唯一推荐**的"业务记录 + 审计"提交/恢复协议与状态表（本文 §3～§5） | 通用 N 文件事务、迁移、备份恢复、删除 |
| 永久回归（正常/异常/预算/未知版本），原 220 基线继续通过 | 断言 `verified` 的硬件证据成立（那是 experiences 域的规则） |

关键澄清，避免夸大：本轮的校验**不生成** eventId/operationId，也**不认证**操作者身份。
`operatorLabel` 是调用方声明的人工标签，`publication` 是发布者自报的事实，二者都**不是**企业身份认证或权限证明。

---

## 2. 审计事件的契约（C2A-2/C2A-3 的落点）

独立版本 `auditVersion: 1`（**不**复用记录 `schemaVersion`，也**不**改 journal `journalVersion`）。
一条事件 = 一次人工决定的**不可变记录**，字段如下（均来自 `core/contracts/audit.ts` 的 schema）：

| 字段 | 语义与约束 |
|---|---|
| `auditVersion` | 必须为 `1`；其它值一律 `unsupported-audit-version`，**不猜格式**（不再产生其它字段级噪音） |
| `eventId` | 规范小写 UUID（事件身份，重试幂等的锚点） |
| `operationId` | 规范小写 UUID，对应 C1 journal 的 operationId（把审计与那次写入绑在一起） |
| `target` | `{ kind: "experience-card", recordId }`：首版只覆盖经验卡；`recordId` 用通用知识 ID 规则。**不接受**任何 target/temp/lock 路径 |
| `action` | `submit-review` / `request-changes` / `approve` / `deprecate` / `restore`，与 `fromStatus`/`toStatus` 必须成对合法（§2.1） |
| `fromStatus` / `toStatus` | 复用既有 `draft` / `reviewed` / `verified` / `deprecated` |
| `operatorLabel` | 声明的人工标签，1..128 字符且 ≤256 UTF-8 字节；**不是认证** |
| `decidedAt` | 人工动作时间（epoch ms，`Date` 可表示范围内） |
| `reason` | 1..512 字符且 ≤1024 UTF-8 字节的简短理由（C2AR-3 统一：主文/常量/README/测试不得再出现 2048） |
| `before` / `after` | `{ revision, hash }`：安全非负整数 revision + 64 位小写十六进制真实字节 SHA-256；**审核是 update 关系**：`after.revision === before.revision + 1`，不接受 `null` |
| `evidence` | ≤32 条**有界关联元数据**（§2.2），不复制正文 |
| `publication` | `writer`（写入路径在提交点之后立即发布）/ `recovery`（恢复器依据已落盘的审核意图补发） |
| `recordedAt` | 事件落盘时间（epoch ms），必须 `>= decidedAt` |

### 2.1 动作与状态对的合法关系（唯一推荐表）

| action | from | to | 说明 |
|---|---|---|---|
| `submit-review` | `draft` | `reviewed` | 提交人工审核 |
| `request-changes` | `reviewed` | `draft` | 审核要求修改（回到草稿） |
| `approve` | `reviewed` | `verified` | 审核通过（**不**代表硬件验证证据已由本契约保证） |
| `deprecate` | `reviewed`\|`verified` | `deprecated` | 停用（不再作为新修改的依据） |
| `restore` | `deprecated` | `draft` | 从停用恢复为草稿 |

刻意**没有** `draft → verified` 的直达动作：把"提交—审核—通过"压成一步会让审计无法回答"谁在什么时候审的"。

失败码的归属必须说准（C2AR-3 修正）：**未知 action / 未知状态由结构层的枚举拒绝**，报 `invalid-audit`；
只有"枚举内已知、但与状态对不匹配"（含 `from === to`）才报 `audit-action-mismatch`。
此前本文写作"未知 action 一律 action-mismatch"与实现不符。

### 2.2 证据关联的引用规则（不复制内容的边界）

每条 `evidence[i]` 只允许三种形态，且**互斥**：

| kind | 必填 | 禁止 | 含义 |
|---|---|---|---|
| `record-evidence` | `index`（非负整数） | `recordId` | 指向目标记录 `evidence[]` 的下标 |
| `record-validation` | `index` | `recordId` | 指向目标记录 `validations[]` 的下标 |
| `external-reference` | `recordId` 或 `note` 至少一个 | `index` | 指向外部材料/记录，只留引用与 ≤256 字符说明 |

文本/结构上限（同时校验字符数与 UTF-8 字节）：标签 128 字符 / 256 字节；理由 512 字符 / **1024** 字节；
单条 `note` 256 字符；证据总序列化字节 ≤8 KiB；**单条事件序列化字节 ≤16 KiB**
（按存储层同一份序列化形式 `JSON.stringify(value, null, "\t") + "\n"` 实测，不估算）。
超限一律**拒绝**并给出 `audit-too-large` / `audit-evidence-invalid`，**不静默截断后假称原决策完整**。

总量与上界的表述（C2AR-3 修正）：16 KiB 是**兜底闸门**，它的保守上界按常量算——
信封 ≤1 KiB + 标签 128 码元×6 + 理由 512 码元×6 + 证据 8 KiB = **13,056 B < 16,384 B**（×6 是
JSON 对控制字符 `\uXXXX` 转义的最坏膨胀）。此前"分项之和 ≈9.6 KiB"的说法既漏了转义膨胀、
又用错了理由上限，已删除。闸门与上界之间留 ≥1 KiB 余量，测试同时断言"不误报"与"上界不虚"。

### 2.3 诊断的输出边界（脱敏）

- issue 结构为 `{ code, path, message }`，最多 20 条，另有 `droppedIssues` 如实计数；
  单条 message ≤200 字符；`describeAuditIssues(issues, limit)` 再限一次展示条数。
- **不回显输入**：未声明字段只报告"存在未声明的字段（名称已省略）"，路径里出现的未知片段被替换成 `<unknown>`；
  长度/模式类错误只报字段与上限，不回显字段内容；任何诊断都不含记录正文。
- 校验**不修改**传入实例（纯函数），数组/对象/数值异常与未知路径字段都被结构化拒绝，不使用 `any` 与强转。

---

## 3. 一致性协议（C2AR-1 修正后的唯一版本）

> **本节已按第十轮 A1/A2/A3 重写（2026-10-01）**，替换掉"先收口 journal 再补发事件"与
> "同 eventId 字节相同即幂等"的旧表述。旧版的两处致命点是：恢复先写完成终态会**永久丢失审计**（A1）；
> 用字节相同当幂等条件，会把发布事实（`publication`/`recordedAt`）当成决定的一部分（A2）。
> 旧版"靠 intent 文件是否存在区分普通写/审核写"也不再作为判据（A3）。
> 本轮只改协议与纯校验，**没有任何 IO 实现**；实际落地与窗口行为属 C2B。

### 3.1 提交点与顺序

"业务记录 + 审计"是**两个文件**，因此不存在跨文件原子提交。唯一推荐的顺序是
**意图先于数据、审计事件先于完成终态**，业务提交点仍然是记录文件的 `rename`：

```text
① 取"目标记录的协作锁"（复用 C1，同一把；不引入第二把锁）
② 同源读取/校验当前版本（expectedRevision、schema、预算）
③ 发布 audit intent（link 非覆盖）：audit/intents/<operationId>.json
④ 发布审核 prepared journal（未来为 v2；本轮不改 v1）：journal/<operationId>.json
⑤ 业务记录提交（rename）                                    ← ★ 唯一业务提交点
⑥ 审计事件：发布或**认领**已有事件：audit/<recordId>/<eventId>.json
⑦ 写 journal 完成终态（committed / 或审核专用的完成态）
⑧ 释放自有锁
```

三条不可交换的次序要求：

1. **完成终态永远在事件之后**（A1）。写终态意味着"这次操作不需要人再看"，一旦在事件缺失时提前写下去，
   下次恢复看到终态就直接返回，**审计永久缺失且没有任何迹象**——这是比"审计暂缺"严重得多的失败。
2. **writer 与 recovery 遵守同一条顺序**。恢复不是"先调用 C1 的收口函数、再顺手补一条审计"：
   现有 `reconcileJournalOperation` 对已有终态是提前返回的（`reconcile.ts` 的幂等分支），
   先调它就等于先写终态。恢复必须自己按"持锁 → 复读目标与关联 → 发布/认领事件 → 再收口"完成。
3. **意图先于数据**：③④ 都失败在 ⑤ 之前，业务数据不动；反过来先改记录再写意图，
   崩溃后就再也说不清"这次改动是人决定的还是程序顺手干的"。

窗口 ⑤ 之后、⑥ 之前中断时，审计最多是**暂缺**，而依据（intent + v2 journal 绑定）仍在，
恢复器可以据此补发（§3.4），补发事件的 `publication: "recovery"`，事实来源仍是那次人工决定。

### 3.2 落点（路径只由受控 ID 派生）

| 文件 | 路径 | 发布方式 | 为什么 |
|---|---|---|---|
| 审核意图 | `audit/intents/<operationId>.json` | `link`（非覆盖） | 文件名由 operationId 派生（`auditIntentFileName()`），撞名即拒绝，绝不覆盖 |
| 审计事件 | `audit/<recordId>/<eventId>.json` | `link`（非覆盖） | 按记录关联 = 枚举一个目录即可（受 `maxScanEntries` 约束）；两个路径段都来自受控 ID |

"每事件一个不可变文件"的取舍保持不变（历史天然不被覆盖；同 `eventId` 已有事件时走 §3.4 的**认领**语义，
而不是"字节相同才算成功"）；"某记录的全部审计" = 列 `audit/<recordId>/`（有界），
"全库最近事件"的两级枚举/分页仍是 C2B 的问题，本轮不建目录、不建索引。

### 3.3 发布事实与认领（A2 修正）

- `publication`（`writer` / `recovery`）与 `recordedAt` 是**发布事实**，不是决定的一部分：
  它们由**实际发布者在发布那一刻**填写，同一次决定由谁发布、发布几次都会不同。
- **不存在事件**时：由当前写入方发布，`publication: "writer"`、`recordedAt` = 实际落盘时间。
- **已有事件**时：先**完整校验**该事件，再逐项比较**稳定决定字段**（`AUDIT_INTENT_DECISION_FIELDS`：
  operationId / eventId / target / action / fromStatus / toStatus / operatorLabel / decidedAt / reason /
  before / after / evidence）；一致 ⇒ **认领**它，**原样保留**它的 `publication` 与 `recordedAt`
  （不重新生成、不以恢复时间替换、不覆盖）；不一致 ⇒ `audit-decision-conflict`，交人工判断。
- 因此**不能在比较时带上 publication/recordedAt**：那会把"同一次决定的两次发布"误报成冲突；
  也不能反过来把已有 writer 事件**改写**成 recovery——那是篡改发布历史。
- 对象键顺序不影响结论；`evidence` **数组顺序有意义**（逐项按下标匹配），
  因为排列本身携带"先看哪条"的意图。

### 3.4 窗口与恢复（A1 修正后的完整表）

恢复的**唯一顺序**：持锁 → 复读目标与关联（意图 + v2 绑定）→ 发布或认领事件 → 写完成终态 → 释放锁。
每一步的判定都必须复用它已有的纯校验（`compareAuditAssociation` / `validateAuditEvent`），不得"看一眼差不多"。

| 窗口（崩溃/失败点） | 磁盘状态 | 结论与动作 |
|---|---|---|
| ① 之前失败 | 无 intent、无 journal、记录未动 | 报原错误（含清理诊断）；不产生审计事件 |
| ② 之前失败 | 同上（校验未过） | 结构化拒绝；不留任何新文件 |
| intent 已发布、prepared journal 未发布 | intent 存在、记录 = before | 不发布事件；journal 缺失 ⇒ 无法证明**属于哪次提交**，只能人工判断（不自动删意图） |
| 意图齐、提交前失败/取消 | intent + prepared journal、记录 = before | journal → `aborted`；**不发布**事件；intent 保留为"未生效的决定"证据 |
| 提交点已过、事件未发布（首次中断） | intent + prepared journal、记录 = after | **先发布事件**（`publication: "recovery"`、`recordedAt` = 本次实际落盘时间）→ 再写完成终态 |
| 恢复器在**事件发布之后、写终态之前**再次中断 | 事件已存在、journal 仍 prepared | 下次恢复：校验并**认领**已有事件（保留其原始 publication/recordedAt）→ 再写完成终态；**不重复发布** |
| 恢复器在**事件发布之前**再次中断 | 同"提交点已过、事件未发布" | 与首次中断完全同路径，可重试；事件仍未发布 |
| 事件已发布、写终态失败 | 事件存在、journal prepared | 同上（认领 → 收口）；终态写失败**不改口**成"未提交"，如实报 `needs-recovery` |
| intent 缺失 / 坏 JSON / 未来 intent 版本 / 超限 / 链接 / 关联不一致 | 各类不可解释状态 | **保守拒绝**：不发布事件、不写"完成"终态，保留证据交人工（§3.5） |
| 记录 revision 更高 / hash 既非 before 也非 after | 记录被后续合法写入改过 | `conflict`：不发布事件、不改记录、不改 journal 终态 |
| 目标坏 JSON / 未知版本 / 结构或归属非法 / 链接 / 不可读 | — | `unreadable`：保留证据不动手（与 C1 同一判定链） |
| 锁被他人持有 / 归属无法证明 | — | `busy`：不抢锁、不删锁、不改任何文件；需人工确认 |
| 取消 / 清理失败 | — | 取消穿透（不写终态、不发事件）；清理失败只作附加诊断，不覆盖原错误 |
| **终态已完成但事件缺失** | journal = committed、无事件 | **异常**：不冒充成功、不猜测补写人工决定（决定只能来自 intent）；显式报不一致交人工 |
| 终态已完成且事件存在 | 两者齐备 | 幂等返回；**不**新增事件、**不**重写终态、**不**删遗留锁 |
| 两个恢复者并发 | — | 目标协作锁串行化；后者复读后走"认领或幂等"分支，**恰好一次**发布 |

**必须始终成立的四条**：
1. 恢复**只**发布/认领审计事件与收口 journal，**绝不**重放业务内容、**绝不**重复递增 revision；
2. 恢复**不能**凭空构造或改写 `action` / `fromStatus` / `toStatus` / `target` / `reason` / `eventId` /
   `operatorLabel` / `decidedAt`——只能沿用已落盘意图，否则"人工决定"就变成"恢复器的推断"；
3. **完成终态只在事件发布/认领成功之后写**；事件失败时业务结果照实报 `applied + audit pending + needs-recovery`；
4. 危险动作（发布、认领、写终态）都必须**先持锁、再复读**，与 C1 的幂等规则一致。

### 3.5 关联校验：意图凭什么属于这次提交（A3 修正）

"存在一个 `purpose=review` 的文件"**不是**证明：它可能属于别的操作、可能被替换、也可能只是同名的垃圾。
审核路径必须能用**未来的审核 journal v2** 把三方绑定在一起：

| 绑定项 | 来源 | 校验规则 |
|---|---|---|
| `operationId` | v2 投影 | 与意图逐字相等 |
| `eventId` | v2 投影 | 与意图逐字相等 |
| 意图指纹 | v2 投影的 `intentHash` | 必须等于**本次实际读到**的意图原字节 SHA-256（由 IO 层测量后传入纯比较） |
| 意图身份 | v2 投影的 `intentName` | 必须由 `operationId` 派生（`<operationId>.json`），不接受调用方给路径 |
| `target` / `before` / `after` | v2 投影 | 与意图逐项相等（kind/recordId、revision、hash） |

- 任一项不一致 ⇒ `audit-association-mismatch`，**拒绝**发布人工决定；**声明值不是证明**：
  `intentHash` 只有与实测字节指纹相等时才有意义，纯函数不把任意一方单独当证据。
- 意图本身不可解释（未知版本 / 坏 JSON / 超限 / 链接 / 未知字段 / 结构非法）⇒ 保守拒绝，
  不写"完成"终态、不发事件，保留现场给人工。
- 关联投影**不是**完整 journal v2，也不能拿它绕过 v2 自身的结构校验；它只回答
  "这次提交绑定了哪条意图、哪条事件、哪个目标、哪两个版本"。
- **不能再用"intent 文件不存在 ⇒ 这是普通写"来收口**：审核 journal 只认 v2 绑定，
  缺绑定就保守拒绝（普通写仍走 v1，见 §3.6）。

### 3.6 journal v1 / v2 兼容（A3 修正）

- **普通写继续用 v1**：`JOURNAL_SCHEMA_VERSION = 1`、字段与解释**完全不变**，本轮不实现 v2 IO。
- **审核写使用专用 v2**（本轮只定义协议）：v2 必须携带必填审核 discriminator
  （`journalPurpose: "review"`）、绑定的 `eventId`、受控意图名与意图字节指纹，以及 target/before/after；
  上述绑定由 `validateAuditJournalProjection()` 纯校验，未知字段一律拒绝。
- **旧 C1 恢复器对 v2 必须拒绝**：`journalVersion !== 1` 一律 `unsupported-journal-version`（现状即如此），
  绝不"读不懂就当普通写收口"——否则审核 journal 会被静默降级，审计再次丢失。
- **不做自动迁移**：v1 不升级、不原地改写、不猜测缺失的审核字段；迁移是显式另立任务。
- 判别"这是不是审核写"只看 v2 的 discriminator 与绑定，**不看 intent 文件是否存在**
  （旧协议 §3.6 的说法作废）。

### 3.7 权限与应用层边界（§4.8）

- 审核动作只由**人工 CLI/UI 的域入口**触发；**不**注册 LLM 批准工具，工具层不得调用审核入口；
- 当前通用 `updateRecord` 能直接改 `experience-card.status`：那是**底层能力**，不构成审核流程，
  本轮也不去堵它（堵它需要权限模型，属后续设计）；
- `operatorLabel` 是声明；应用层校验（"只有 CLI 能调"）**不是** OS 级防护，也不防本机绕过协议的其他进程。

### 3.8 未来最小 API 与结果结构（C2B 的依据，本轮不实现）

结果是**判别联合**，把"业务是否提交""审计是否存在""journal 是否收口"三件事分别表达，
不用元数据暗示未发生的发布（C2AR-3）：

```text
type ReviewDecisionResult =
  | { kind: "rejected";          issues }                       // 未提交：校验/关联/锁失败（业务未变）
  | { kind: "applied";           revision, record,              // 业务已提交、审计已存在
      audit: { eventId, path, publication: "writer" | "recovery", recordedAt },
      journal: { operationId, state: "committed" } }
  | { kind: "applied-audit-pending"; revision, record,          // 业务已提交、审计待补（可重试）
      audit: { eventId, publication: null, recordedAt: null },
      journal: { operationId, state: "needs-recovery" }, warnings }
  | { kind: "applied-journal-pending"; revision, record,        // 事件已发布/认领、终态待收口
      audit: { eventId, path, publication, recordedAt },
      journal: { operationId, state: "prepared" }, warnings }

reconcileJournalOperation({ root, operationId })   // 既有入口；C2B 需按 §3.4 顺序扩展，不能先收口再补审计
  → { outcome, changed, audit: null | { eventId, path, publication, recordedAt }, warnings? }
```

不变式：`revision` 只在**本次真的提交了记录**时递增；审计未发布时 `publication`/`recordedAt` 必须是
`null`（**不预支** "writer" 或 "recovery"）；认领已有事件时返回的是那条事件**真实**的发布事实；
`needs-recovery` 绝不改口成"未提交"。

### 3.9 C2B 需要做的 IO checkpoint 测试清单（只列计划，不伪称已测）

| # | checkpoint（`beforeIo` 命中点） | 期望 |
|---|---|---|
| 1 | intent `link` 之前失败 | 记录未动、无 journal、无事件；报原错误 |
| 2 | 审核 journal（v2）`link` 之前失败 | intent 存在但数据未提交；不产生事件 |
| 3 | 业务 `rename` 之前取消 | journal → `aborted`，**不发布**事件 |
| 4 | 业务 `rename` 之后、事件 `link` 之前中断 | 记录 = after；**完成终态尚未写**；下一次恢复先发布事件再收口 |
| 5 | **恢复器在事件发布之后、写终态之前再次中断** | 下次认领已有事件（保留原 publication/recordedAt），不重复发布 |
| 6 | 事件已存在但决定字段不同 | `audit-decision-conflict`：不发布、不覆盖、不写完成终态 |
| 7 | 终态写失败 | 业务照实报 applied；事件已在；journal 待收口；`needs-recovery` |
| 8 | 已有终态但事件缺失 | 显式报不一致（不冒充成功、不猜测补写人工决定） |
| 9 | `lock-remove` 失败 | 只作附加诊断，不覆盖原错误 |
| 10 | 恢复期间 `read` 取消 | `cancelled` 穿透；不发布事件、不改记录 |
| 11 | 目标 revision 更高 / hash 既非 before 也非 after | `conflict`：不发布、不改写 |
| 12 | 两个真实进程并发恢复同一 operationId | 锁串行化；恰好一个发布事件；另一个认领/幂等返回 |
| 13 | 意图被替换（实测字节指纹 ≠ v2 绑定值） | `audit-association-mismatch`：拒绝发布 |
| 14 | v1 普通 journal 被当作审核处理 | 旧恢复器按 v1 收口；审核路径要求 v2 绑定，缺绑定即拒绝 |

### 3.10 人工决定与恢复观察如何区分

- `operatorLabel` + `decidedAt` + `reason`：**人工决定的声明**（来自 intent），恢复器只搬运、不修改；
- `publication`（`writer` / `recovery`）+ `recordedAt`：**发布事实**（谁、什么时候把这个事件写下去），
  认领已有事件时保留其**原始值**（§3.3）；
- 因此同一事件的 `publication: "recovery"` 明确表示"内容一致由恢复器观察到、决定由人工做出"；
- 反之，C1 journal 的 `recovery-observed` **永远不能**被当作审核证据（journal 没有操作者与理由字段）；
- 元数据（标签、时间、publication）都**不是认证凭据**：它只回答"这条事件是谁写的、基于什么意图"，
  不回答"这个人是否有权限"。

### 3.11 锁（§4.3）

- **复用目标记录的同一把协作锁**，不新增"审计锁"：单锁 ⇒ 锁顺序唯一 ⇒ 不存在死锁面；
- 等待上限/取消/清理沿用 C1：`timeoutMs`/`pollMs` 入口校验（`pollMs` 裁到剩余预算）、
  提交前取消生效、**释放忽略取消**、`busy` 不抢锁、不按 PID/mtime/年龄回收、无 `force`；
- 并发恢复：由这把锁串行化；第二个恢复者拿到锁后复读 journal 与关联，走"认领或幂等"分支；
- 审计事件的发布（`link`）在持锁范围内完成，因此"两个进程同时发布同一事件"不会发生；
  即使发生（外部写者绕过协议），`link` 的非覆盖语义 + §3.3 的决定比较也能保证不覆盖历史。

---

## 4. 本轮实际改动（C2A-2～C2A-4；C2AR 的增补见 §6）

| 文件 | 行数 | 内容 |
|---|---|---|
| `core/contracts/audit.ts` | 213 | `AuditEventSchema` 及嵌套 schema（目标/指纹/证据/发布）、由 schema 推导的类型、`AUDIT_SCHEMA_VERSION`、动作-状态表、全部限额常量、`readAuditVersion` / `isAuditAction` / `isLegalAuditTransition` / `describeAuditTransitions` / `describeAuditTarget` |
| `core/contracts/auditValidation.ts` | 430 | `validateAuditEvent`（纯）、`isValidAuditEvent`、`describeAuditIssues`、`measureAuditEventBytes`、`utf8ByteLength`、`sanitizeAuditPath`、issue 类型与脱敏映射，以及**可复用**的 `collectSchemaIssues` / `collectAuditRevisionIssues` / `collectAuditTextIssues` / `collectAuditEvidenceIssues`（C2AR 抽出，供意图与投影复用同一份规则） |
| `core/contracts/auditIntent.ts` | 184 | **C2AR 新增**：`AuditIntentSchema`（审核**意图**：稳定决定字段，**不含** publication/recordedAt）、`validateAuditIntent`、`auditIntentFileName`（受控派生）、`AUDIT_INTENT_DECISION_FIELDS` |
| `core/contracts/auditAssociation.ts` | 237 | **C2AR 新增**：`AuditJournalReviewProjectionSchema`（未来 journal v2 的关联投影）、`validateAuditJournalProjection`、`compareAuditAssociation`（publish / claim / 冲突的纯判定） |
| `core/contracts/index.ts` | 21 | 契约出口新增 `audit.ts` / `auditValidation.ts` / `auditIntent.ts` / `auditAssociation.ts`（注释说明审核是独立类别，不进 `RECORD_SCHEMAS`） |
| `tests/auditContracts.test.mjs` | 437 | 17 条永久回归（见 §5，含 C2AR 补入的 hash 格式与转义上界用例） |
| `tests/auditAssociation.test.mjs` | 420 | **C2AR 新增**：16 条永久回归（意图/投影/认领/冲突，见 §5、§6） |

体量说明：`auditValidation.ts` 430 行略高于"目标 ≤400"，但**远低于** 600 的拆分门槛；
本轮已按职责把它能共享的部分抽成可复用函数（意图/投影各自成文件），若继续增加事件级规则，
下一轮应先把"诊断与脱敏管道"独立成模块再往里加。

导出的常量（也是契约的一部分，改它们要同步测试）：

| 常量 | 值 | 说明 |
|---|---|---|
| `AUDIT_SCHEMA_VERSION` | `1` | 独立版本闸门；未知版本只报一条 `unsupported-audit-version` |
| `AUDIT_TARGET_KIND` | `experience-card` | 首版唯一合法目标类型 |
| `AUDIT_MAX_EVENT_BYTES` | 16 KiB | **兜底闸门**：分项之和（≈9.6 KiB）小于它，合法输入不会触发；测试断言该不变式 |
| `AUDIT_LABEL_MAX_CHARS` / `_BYTES` | 128 / 256 | 256 < 3×128 ⇒ 字节规则**可达**（100 个汉字 = 300 B 被拒，85 个 = 255 B 通过） |
| `AUDIT_REASON_MAX_CHARS` / `_BYTES` | 512 / 1024 | 同上（341 汉字 = 1023 B 通过，342 汉字 = 1026 B 被拒） |
| `AUDIT_EVIDENCE_MAX_ITEMS` | 32 | 条数由 schema 的 `maxItems` 拒绝 |
| `AUDIT_EVIDENCE_MAX_BYTES` | 8 KiB | 按序列化字节逐条计量，超限报 `audit-evidence-invalid` |
| `AUDIT_EVIDENCE_NOTE_MAX_CHARS` | 256 | 单条说明长度 |
| `AUDIT_MAX_ISSUES` / `AUDIT_ISSUE_SCAN_LIMIT` | 20 / 200 | 输出条数与结构错误**后处理**上限，另有 `droppedIssues` 计数 |
| `AUDIT_MAX_DATE_MS` | `8_640_000_000_000_000` | 时间戳上界（与锁模块同口径） |
| `AUDIT_INTENT_SCHEMA_VERSION` | `1` | 意图独立版本闸门 |
| `AUDIT_INTENT_PURPOSE` | `review` | 意图用途（首版唯一；不放宽成自由字符串） |
| `AUDIT_MAX_INTENT_BYTES` | 16 KiB | 与事件同量级（意图是事件的子集，不含发布事实） |
| `AUDIT_INTENT_NAME_LENGTH` | `41` | 受控意图名（`<operationId>.json`）长度 |
| `AUDIT_JOURNAL_V2_VERSION` | `2` | 未来审核专用 journal 版本（**本轮只定义协议**，不改 v1） |

### 4.1 校验的分层（谁报哪个 code）

| 层 | 负责 | code |
|---|---|---|
| 版本闸门 | `auditVersion` 缺失 / 不支持 | `invalid-audit-version` / `unsupported-audit-version` |
| schema（结构） | 类型、必填、枚举、长度、条数、格式、**数值范围**（Integer + `minimum`/`maximum`） | `invalid-audit`；未声明字段 → `unknown-field` |
| 语义（跨字段与预算） | 动作↔状态对、`after = before + 1` 与溢出、`recordedAt >= decidedAt`、标签/理由字节、证据形态互斥与总字节、单条事件总量 | `audit-action-mismatch` / `audit-revision-invalid` / `audit-time-invalid` / `audit-text-invalid` / `audit-evidence-invalid` / `audit-too-large` |
| 意图与投影（C2AR 新增） | 意图结构/版本、投影版本（非 2 一律拒绝）、受控意图名派生、意图↔投影↔事件三方对齐、实测意图字节指纹 | `invalid-audit-intent` / `invalid-audit-intent-version` / `unsupported-audit-intent-version` / `invalid-audit-projection` / `unsupported-journal-version` / `invalid-intent-hash` / `audit-association-mismatch` / `audit-decision-conflict` |

两条纪律写在这里，避免后来者改回去：
1. **越界数值由 schema 拒绝，关系与溢出由语义层拒绝**。语义层里的"安全整数"确认是**防御性**的
   （保护 `before + 1` 与溢出判定的算术），公开输入到不了那里，测试也不为它伪造输入。
2. **每一条字节/数量规则都必须可达**。取值遵守 `字节上限 < 3 × 字符上限`（UTF-16 计数下 3 字节字符才是最大消耗），
   否则规则永远不触发、等于没有；总量上限是唯一例外，它作为兜底闸门存在，并用"分项之和 ≤ 总量"的不变式测试守住。

### 4.2 脱敏与有界（最容易做错的一处）

- 未声明字段：TypeBox 会给出两条错误（一条把字段名放进 `instancePath`，一条放进 `params`），
  本模块把两条**合并**成一条固定文案 `存在未声明的字段（名称已省略）`；路径经 `sanitizeAuditPath` 白名单化，
  未知片段替换成 `<unknown>`。
- 长度/格式/类型类错误一律用固定文案，不回显字段值；诊断里不会出现记录正文。
- 结构错误枚举由 TypeBox 自身限量（实测 40 条数组场景只产出 8 条），因此 `droppedIssues` 主要由
  **语义层**触发（32 条矛盾证据 = 64 条诊断 → 保留 20、丢弃 44，测试精确断言这个数）。

关于"成本有界"的准确表述（C2AR-3 修正）：`Value.Errors` **先急切实体化整个错误数组**再交给我们遍历
（实测 `Array.isArray(Value.Errors(...)) === true`）。因此 `AUDIT_ISSUE_SCAN_LIMIT = 200` 限制的是
**错误后处理与诊断输出**，**不是** TypeBox 对未知对象的遍历耗时/内存——
不能据此声称"任意未知输入的校验成本恒定"。真正的输入规模约束必须由未来 IO 层的**读取字节上限**提供；
本轮不引入新的沙箱或验证框架。

## 5. 永久回归与实跑门禁

`tests/auditContracts.test.mjs`（15 条，全部实跑通过）：

| 用例 | 断言要点 |
|---|---|
| 合法样例通过，且校验不修改输入 | 冻结实例（含嵌套与数组成员）后校验不抛；返回内容与 JSON 快照一致 |
| `auditVersion` 闸门先行 | 缺失/`0`/`1.5`/`"1"`/`NaN` → `invalid-audit-version`；`2` → 只报一条 `unsupported-audit-version`（无字段噪音） |
| 未知字段被拒绝且不回显名字 | 顶层 + 嵌套 + 5 种路径字段名；诊断串里不含字段名、不含值 |
| UUID / recordId | 大写 UUID、长度错、非 UUID、`42`；`../escape`/`Exp`/`con.json`/`a/b`/129 字符/空串；非 `experience-card` 目标 |
| 动作与状态对 | 遍历 `AUDIT_ACTION_TRANSITIONS` 断言每条合法对通过（≥5 组），6 种矛盾组合被拒，未知动作/状态由枚举拒绝 |
| revision | 越界（`2^53`/`-1`/`1.5`/`NaN`/`Infinity`/`1e100`）由 schema 拒；溢出（`MAX_SAFE_INTEGER`）与关系错误（跳跃/不动）报 `audit-revision-invalid`；`MAX_SAFE-1 → MAX_SAFE` 允许 |
| 时间 | 越界由 schema 拒；`recordedAt < decidedAt` 报 `audit-time-invalid`；`epoch 0` 合法 |
| 文本预算 | 标签/理由的字符与**字节**边界各取一上一下（85/86 汉字、341/342 汉字）；空串被拒；断言两条字节规则可达 |
| 证据形态与预算 | 33 条超限；`record-*` 缺 `index` / 带 `recordId`；`external-reference` 带 `index` / 两者都缺；`note` 257 字符与空串；32×200 汉字超 8 KiB |
| 分项之和 ≤ 总量 | 逐条加到证据预算边界构造"最大合法事件"：必须**通过**校验且总字节 ≤ 总量；再加一条即被证据预算拒绝 |
| 序列化口径 | `measureAuditEventBytes` 与 `JSON.stringify(value, null, "\t") + "\n"` 的 UTF-8 字节逐字节一致；循环引用返回 `undefined` 而不抛 |
| 路径脱敏 | `/evidence/0/evilKey` → `/evidence/0/<unknown>`；超长路径被截断 |
| 恶意大输入 | 40 条未知字段 + 20 万字符标签 + 重复正文：issue ≤ 20、单条 ≤ 200 字符、渲染 ≤ 4 KiB、无正文/字段名泄漏；语义层 64→20 的丢弃计数精确断言 |
| 结构错误扫描有界 | 1000 个未知字段：issue ≤ 20、去重后仍报"名称已省略" |
| 既有契约不变 | `RECORD_SCHEMAS` 仍是五类、`BIOS_CONTRACTS_SCHEMA_VERSION = 1`、`JOURNAL_SCHEMA_VERSION = 1` |
| C2AR：前后 hash 的 7 种非法格式 × 2 字段 | 大写/非 hex/63 位/65 位/路径/null/数字，逐条断言 `invalid-audit` 与路径，并统计"确实检查了 14 例" |
| C2AR：控制字符/长 ID/数值边界 | 128 个 `\u0001` 标签、512 个 `\u0000` 理由、128 字符 ID、`MAX_SAFE-1 → MAX_SAFE`、`AUDIT_MAX_DATE_MS`：合法且实测字节 ≤ 保守上界（13,056）< 闸门（16,384） |

`tests/auditAssociation.test.mjs`（C2AR 新增 16 条）：

| 用例 | 断言要点 |
|---|---|
| 合法意图通过且不改输入 | 深冻结后校验不抛；结果**不含** publication/recordedAt（校验通过不等于已发布） |
| 意图版本闸门与未知字段 | 缺失/`0`/`1.5`/`"1"`/`NaN` → `invalid-audit-intent-version`；`2` → 只报一条版本问题；未知字段不回显名字 |
| 意图复用事件的规则 | 动作↔状态对、`after = before + 1`、标签/理由字节、证据形态与总字节全部报**同一套 code** |
| 意图预算与事件同量级 | `AUDIT_MAX_INTENT_BYTES` 与事件一致；保守上界 < 闸门 |
| 投影版本闸门与受控派生名 | `journalVersion` 1/3 → `unsupported-journal-version`；缺版本 → `invalid-audit-projection`；非派生名 → `audit-association-mismatch`；路径字段 → `unknown-field` |
| 不存在事件 ⇒ publish | 结果**逐字节等于** `{ok:true,kind:"publish"}`，不含 publication/recordedAt/eventId |
| writer 事件认领 | 保留 writer 与原 `recordedAt`（不被恢复时间替换） |
| recovery 事件二次认领 | 两次结果深度相等；换成不同 `recordedAt` 的事件仍保留**磁盘上那条**的真实时间 |
| 键顺序无关 | 打乱 intent/event 的键顺序仍认领成功 |
| 决定冲突逐项 | 动作/操作者/决定时间/理由/前后指纹/目标/证据内容/**证据顺序**/eventId/operationId 各一项 → `audit-decision-conflict` 且路径准确 |
| 非法已有事件 | 未知/缺失 publication、发布早于决定、未知字段、缺 auditVersion → 拒绝且不回显正文 |
| 投影与意图身份对齐 | operationId/eventId/target/before/after 各错一项 → `audit-association-mismatch` |
| 实测指纹 vs 声明 | 8 种非法指纹 → `invalid-intent-hash`；合法但不等 → `audit-association-mismatch` |
| 大输入 | issue ≤20、单条 ≤200 字符、渲染有界、无正文泄漏 |
| 路径脱敏 | 意图/投影字段名保留，未知片段 `<unknown>` |
| 比较字段元数据 | 决定字段**不含** publication/recordedAt；投影版本与意图名长度是协议常量 |

实跑（2026-10-01，Windows + PowerShell + Node 24.14.1 + Pi 0.87.1）：

| 工作目录 | 命令 | 结果 |
|---|---|---|
| `packages/bios-agent` | `node --test tests/auditContracts.test.mjs tests/auditAssociation.test.mjs` | **33 项：33 通过、0 失败、0 skip**（17 + 16） |
| 同上 | `npm run typecheck` | 通过 |
| 同上 | `npm test` | **253 项：251 通过、0 失败、2 显式 skip**（均为文件型 symlink EPERM）；C2A 基线 235 未削弱 |
| 同上 | `npm run selfcheck` | 6 项通过 |
| 同上 | `npm run check:format` | 通过（45 文件） |
| 仓库根 | `npm run typecheck` | 通过 |
| 仓库根 | `npm run check:format` | 通过（2014 文件；该脚本**不检查**本 Package） |
| 仓库根 | `node --test tests/processGuards.test.mjs` | 2 项通过 |
| 仓库根 | `git diff --check` | 通过（不覆盖未跟踪文件内容） |

模块体量：`audit.ts` 200 行、`auditValidation.ts` 349 行（都在 400/600 行红线内）；
契约层**不 import** storage/Electron/Pi。

### 5.1 未测与边界（本轮不做也不声称）

- 本轮**没有任何 IO**：没有创建 `audit/` 目录、没有写文件、没有恢复器实现。§3 的协议是**设计**，
  它的窗口行为（intent / journal / 事件 / 终态的顺序与恢复）**尚未实现、也未测试**；C2B 才落 IO 与 checkpoint 清单。
- 未做**身份认证**：`operatorLabel` 是声明；没有用户表、没有签名、没有权限模型。
  "审核只由人工 CLI/UI 调用"是应用层约定，不是 OS 防护。
- 未做 `verified` 的领域规则校验（例如"上板验证证据必须存在"）：那是 experiences 模块的职责，
  本契约不声称 `verified` 有硬件证据支撑。
- 未改 journal v1、未改记录 `schemaVersion = 1`、未改五类记录集合、未动 storage API；
  也未实现 journal v2 / intent 文件 / 迁移（§3.6 只是协议）。
- 未执行：根全量测试、生产构建/安装包、干净 clone、远端 CI、Linux/macOS、断电、真实客户 BIOS 试点。
- 诊断的"不回显输入"是**本契约层**的保证：上层若把原始输入拼进自己的错误消息，等于绕过这里——
  C2B 的写入口必须沿用 `AuditIssue`，不要自造消息。
- C2AR 的纯比较**不计算哈希、不读盘、不生成时间**：`intentBytesHash` 必须由未来 IO 层测量后传入；
  把声明值当证明、或让纯函数"顺手算一下哈希"，都会把 IO 责任偷偷挪进契约层（本轮明确不做）。

## 6. C2AR：A1～A3 的收口（2026-10-01）

第十轮的三项阻塞项都是**协议缺陷**，不是代码 bug：没有旧实现可以"先红后绿"，因此本轮的做法是
**先修正协议条款（§3），再把可执行的部分做成纯函数与永久用例**，让将来 C2B 只能按修正后的语义实现。

| 项 | 第十轮的判据 | 本轮落地 | 固定它的用例 |
|---|---|---|---|
| A1 | 恢复先写终态会永久丢失审计；不能先调用 C1 收口再补事件 | §3.1 顺序改为"事件/认领 → 完成终态"；§3.4 给出**恢复器自身在事件前后再次中断**、终态缺事件等全部窗口；§3.8 结果区分"审计待补/终态待收口" | 关联层用 `publish / claim` 明确"事件存在与否"；协议条款由 §3.4 的表逐行覆盖（IO 行为待 C2B 的 checkpoint 测试） |
| A2 | "同 eventId 字节相同"当幂等条件与发布来源语义冲突 | §3.3 定义：决定字段逐项比较、**认领**已有事件的原始 publication/recordedAt、不一致即冲突；`AUDIT_INTENT_DECISION_FIELDS` 明确排除发布事实 | `tests/auditAssociation.test.mjs` 的 writer 认领 / recovery 二次认领 / 键顺序无关 / 逐项冲突 4 组用例 |
| A3 | 只靠 intent 是否存在区分普通写，缺可验证关联 | §3.5 定义三方绑定（operationId/eventId/受控意图名/意图字节指纹/target/before/after）；§3.6 定义审核专用 journal v2 且要求旧 v1 恢复器拒绝 v2；不再用"intent 缺失即普通写" | 投影版本闸门、受控派生名、身份对齐、实测指纹 vs 声明 4 组用例；`JOURNAL_SCHEMA_VERSION` 仍为 1（既有用例断言） |

同轮收口项（第十轮 §3）：

1. 理由上限统一为 **1024** 字节（§2 表、§2.2、常量与测试一致）；未知枚举由**结构层**报 `invalid-audit`（§2.1 已改）。
2. 结果结构改为判别联合（§3.8），分别表达"业务是否提交""审计是否存在""journal 是否收口"，
   审计未发布时 `publication/recordedAt` 必须是 `null`。
3. 删掉"分项之和 ≈9.6 KiB 即总上界"的错误论证，改为**保守上界 13,056 B < 16,384 B** 的推导
   （含 `\uXXXX` 六倍转义），并用控制字符/长 ID/数值边界样例固定"上界不虚、闸门不误报"。
4. `Value.Errors` 的 eager 行为写清：200 条上限只约束**诊断后处理**，不宣称整体验证成本恒定（§4.2 与代码注释）。
5. 前后 hash 的 14 种非法格式纳入永久测试（`auditContracts.test.mjs`）。

### 6.1 诚实的红绿说明

- 本轮**没有"修复前红"**可跑：A1～A3 是协议与缺失的校验，不是可复现的既有失败。写测试时先按修正后的
  语义写好用例，再让它们暴露**用例自身的假通过风险**并逐一改掉，共发现 6 处：
  `??` 把 `null` 指纹悄悄替换成默认值；投影里用了长度 19 的名字（先被结构层拦住，测不到派生规则）；
  只改 `after.revision` 导致"先失败在事件校验"而非决定比较；`expectFailure` 读错结果形状字段（`code` 在意图校验里不存在）；
  `"intent"` 误判为契约字段名；`x`.repeat(37)+".json" 长度算成 42 而不是 41。
  这些都是"测试看起来绿、其实没测到"的典型形态，写在这里以免下轮重犯。
- 永久用例数：`auditContracts` 15 → **17**，新增 `auditAssociation` **16**；包内 235 → **253**。
  数量不是验收依据；两个既有文件 symlink 权限 skip 保持不变。

### 6.2 C2AR 未做与边界

- **没有任何 IO**：没有 intent 文件、没有审计事件、没有 v2 journal、没有恢复器改动；
  `packages/bios-agent/core/storage/` 与 `JOURNAL_SCHEMA_VERSION = 1` 一行未改。
- `compareAuditAssociation` 只做纯比较：不读盘、不算哈希、不生成时间；投影被视为"未来已通过 v2
  结构校验的 journal"提供的关联视图，不能替代 v2 自身的校验。
- 未做：审核写入口、权限/身份、通用 N 文件事务、迁移/备份/CLI、UI、RAG、厂商适配、模型审核工具；
  未执行根全量测试、生产构建/安装包、干净 clone、远端 CI、Linux/macOS、断电、真实客户试点。
- 下一步（不自动开始）：C2B 按 §3 实现审核专用 v2 + 真实 IO，并把 §3.9 的 14 个 checkpoint 变成实测用例。
