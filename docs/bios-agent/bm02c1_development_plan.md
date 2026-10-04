# BM-02C1：单文件 journal 与进程崩溃后结果核对

日期：2026-10-01。状态：**C1/C1R 已由第九轮独立复验在声明的本机范围通过，J1～J4 关闭**；见 [第九轮验收](round9_acceptance.md)。当前只执行 [C2A](bm02c2a_development_plan.md)，既有改动见 [C1 实施记录](bm02c1_implementation.md)；
本文转为完成标准留档，第 6 节的提示词**不要重跑**。前置：[第七轮独立验收](round7_acceptance.md) 通过 BM-02BR；基线 183 测试，181 pass、2 文件 symlink 权限 skip。

## 1. 本轮交付与不做事项

给五类记录 create/update 和 registry update 增加单文件写入意图记录，使进程在提交前后退出后，新进程能够区分目标仍是旧值、已是预期新值或与两者都不一致。恢复必须幂等、不覆盖后续合法更新。

**C1 采用保守恢复：只核对并收口 journal，不自动重放目标数据、不回滚目标、不重复加 revision。** 未提交的业务操作由调用方重新读取后决定是否重新发起。这是单文件结果恢复底座，不是业务任务自动续跑或完整事务系统。

只改 `packages/bios-agent` 存储 core/契约/测试及对应文档。不做 C2 审核审计、多文件事务、版本迁移，不做 D 备份/管理 CLI，不做记录删除、全文 RAG、厂商适配、模型写工具、桌面 IPC/UI 或 PiRuntime 改造。不引入数据库/服务/重型依赖。既有知识记录 schemaVersion 保持 1；journal 自己有独立版本。

## 2. 最小协议，先写入实施记录再编码

### 2.1 记录布局与内容

建议 `journal/<operationId>.json`：每个写入一个 UUID，由 storage 生成，不能直接信任模型/JSON 提供的文件路径。内部 journal 写入使用 boundary 低层提交原语，**不再次调用普通 write 入口导致递归 journal**。

准备记录至少包含：

- `journalVersion: 1`、operationId、operation=create/update、state=prepared/committed/aborted/conflict。
- 受控目标描述：registry，或 record 的 kind/id/projectId；路径只由已有 `recordRelativeSegments` 等受控函数派生，不保存/消费任意绝对 target/temp/lock 路径。
- before 的 revision/hash（create 为 null/null）、after 的 revision/hash；hash 是 SHA-256。
- preparedAt/finishedAt 等合法、有界时间字段；终态来源标识，例如 writer-confirmed 或 recovery-observed。

**本轮只保存元数据和 hash，不复制客户记录正文。** 元数据足以核对单文件结果；不能据此宣称能从 journal 重建损坏/丢失的数据。完整内容的备份/重放留后续独立设计。

journal 文件名 operationId 与正文一致；字段类型、枚举、UUID、安全 revision、hash 格式、时间范围、目标 kind/归属组合和前后 revision 关系都须校验。未知 journalVersion、坏 JSON、未知目标、路径逃逸/链接均保留原文件并报告，不能猜格式或当空文件覆盖。

hash 必须对应**实际磁盘字节**：旧文件不能读 JSON 后重新 stringify 再算 hash（空白/编码会改变）；新 hash 使用实际提交的同一份 `serializeJsonPayload` 字节。复用/扩展有界读取返回 fingerprint，不增加未经限额的 readFile。

### 2.2 写入顺序与唯一数据提交点

```text
参数/有效库准入 → 取目标原有协作锁 → 重读并校验 expectedRevision
→ 生成一次完整新值及前后 fingerprint
→ 持久发布 prepared journal
→ 完整目标临时文件 + sync + close → link(create) / rename(update)
→ 写 journal 终态 → 释放自有锁 → 返回实际结果
```

- prepared 保存失败时，不提交业务目标，原 hash 不变。完整 schema/预算失败应尽量发生在 journal 发布前。
- link/rename 成功仍是**数据提交点**，不是 journal 终态写成功才算提交。
- 提交前的取消/IO 失败：保留原错误，尽力记录 aborted；无法写终态则保留 prepared 并附加有界诊断。不要拿此失败覆盖首个错误。
- 数据已提交后，journal 终态失败或迟到取消：返回 created/updated 与 operationId、journal 状态 needs-recovery/警告，**不能抛成可盲重试的“未提交”错误**，不能重增 revision/回滚目标。
- 成功结果兼容原字段，并以类型化字段表示 journal outcome；拒绝用 any/强转塞隐式字段。原 code/expected/actual、cleanup、lockRelease/warnings 语义不退化。
- journal 的 prepared 发布、终态替换也需完整临时文件/sync/close、边界/预算/取消和诊断。提交后的必要清理/记账按真实提交状态处理，不把 abort 当回滚理由。
- 初始化空 registry 继续走现有初始化协议，本轮不把初始化竞争改造成通用事务。普通 API 的新写入进入 journal；低层 boundary 测试不必递归生成 journal。

### 2.3 重启检查与恢复

提供显式 core API（具体命名可定为 `inspectPendingJournal`、`reconcileJournalOperation`），不接模型/GUI，不在每个会话启动时无界扫描。

只读 inspect 返回有界候选与问题摘要，不修改 target/journal/锁。prepared 的候选判定是观察，不是提交归属证明。只有对相同受控目标取得**原有协作锁**并重新读取后的 reconcile 才允许修改 journal 终态。

| prepared + 当前目标状态 | 持锁复读后的处理 |
|---|---|
| 与 after hash/revision 完全一致 | journal 记 committed，来源 recovery-observed；不再写目标、不增加 revision |
| 与 before hash/revision 完全一致；create 的 before 是不存在 | journal 记 aborted/未提交；不自动完成旧操作 |
| 与前后都不一致，或更高合法 revision | 标记 conflict，报告人工核对；不覆盖新数据 |
| 目标损坏、版本未知、不可读或为链接 | 保留证据、报告无法判定；不得清空目标或猜测恢复 |

writer-confirmed 与 recovery-observed 要区分：字节相同只能证明目标内容符合意图，不能证明一定是原写者提交，更不能冒充业务审核审计。

对已经有终态的记录重复恢复应幂等，不触碰业务目标。对 prepared 并发恢复也使用同一目标锁，持锁后复读 journal，避免一个恢复者覆盖另一个已完成的终态。重启后先读实际状态，不依赖内存计数或聊天 Session。

**遗留锁策略保持保守：不按 PID/mtime/年龄自动删锁，不增加 force=true 后门。** 活动锁或无法证明归属的锁使 reconcile 返回 busy/需人工核对，不修改任何文件。崩溃测试可在确认自己启动的子进程已退出后，由测试 harness 清理该 fixture 的确切遗留锁，再测新进程 reconcile；这不等于产品自动抢锁。文档要明确此时用户仍需人工确认，无人值守锁回收未完成。

临时文件仅清理本次调用自己创建的路径；C1 不扫描并删除所有 .tmp，也不回收其他 operation 的文件。prepared/终态损坏不能触发猜测路径删除。

## 3. 资源与代码边界

- 建议新建 `core/storage/journal/` 的 contract、prepare/finalize、inspect/reconcile 小模块；别把 journal 全塞回 596 行 boundary 或 549 行 write。
- journal 独立限额建议：单条元数据 16 KiB、一次输出 200 条/256 KiB、扫描 5000 个候选、最多 50 个问题；可以注入更小值，非法数值拒绝，0 的预算语义明确。最终实现若调整默认值，记录理由，不用提高业务记录上限兜底。
- 用 opendir/有界读取，候选检查、异常摘要也计预算；输出 scanned/truncated/truncatedBy 等可判断字段。大目录/坏文件不能无限物化到内存或上下文。
- 新的 IO/checkpoint 注入面仅测试用，不允许外部 JSON 指定执行代码；既有 signals、句柄/目录/定时器/子进程清理规则保持。
- journal 文件是非可信输入，但不是权限凭据/防篡改签名。C1 不允许从它重写业务数据，所以无法凭伪造 journal 获得任意文件写入能力。
- 先在 `bm02c1_implementation.md` 写清状态、数据提交点、错误结果、API、锁/扫描预算，然后逐组记录实现与实跑；该文件是实施记录，不另起多个重复计划。

## 4. 分组任务与验收

| 编号 | 任务 | 完成判据 |
|---|---|---|
| C1-1 | journal 契约、受控路径、有界字节 fingerprint | 合法样例通过；坏/未来版本/ID不符/非法目标/超限拒绝，原文件/根外 sentinel 不变；旧 hash 为真实字节 |
| C1-2 | 接入三类普通写入口 | prepared 在数据前；create 非覆盖/update rename 保持；提交前失败不改目标，提交后记账失败仍返回真实成功与 needs-recovery |
| C1-3 | 有界 inspect + 持锁 reconcile | old/new/conflict/无法判定均明确；重复和两恢复进程无覆盖；busy 不偷锁；后续合法更新不被旧记录重放 |
| C1-4 | 真实退出与回归/文档 | checkpoint 子进程终止、新进程读取核对、资源/预算/取消与原 183 基线继续通过，交回独立验收 |

永久测试至少覆盖：

1. 五类 create/update + registry update，prepared/终态与结果/实际目标 fingerprint 一致；初始空库或旧库没有 journal 目录仍兼容。
2. before 文件带不同合法空白：核对用真实 hash，不把重新序列化当同一字节；after fingerprint 正好对应实际提交。
3. prepared 发布失败：目标未动；目标提交失败/提交前取消：原 hash 不变；aborted 写失败仍保留首错和 pending 诊断。
4. 目标已提交但终态记录失败/取消：真实 created/updated、新 revision 仅 +1；后续恢复不重复写，warnings/operationId 可定位。
5. prepared 指向 old、after、更高 revision、同 revision 不同 hash、坏 JSON、未来版本、链接的情况；终态重复恢复不改业务文件。
6. 活动写者持锁时 inspect 可报告、reconcile busy 不改文件/不删锁；并行两个 reconcile 只有互斥后的真实结论，不靠进程内队列。
7. journal 自身坏/未来/超限/目标路径注入、非法 kind/ID/归属、文件名与 UUID 不一致，输出和 problems 受预算，不泄漏正文。
8. 两 signal 任一取消、扫描中途取消、已打开句柄关闭、退避定时器清理；不可把清理 abort 制造为永久新锁。
9. **真实子进程退出**：准备记录持久后；目标临时文件准备后但提交前；link/rename 后但 journal 终态前；journal 终态后但锁释放前。父进程等 checkpoint 再终止，确认退出后启动新进程核对（不能用 sleep 猜窗口或只 throw mock 冒充 crash）。

每个崩溃点至少实跑一个 create 和一个 update；registry 同样应有“已提交但终态未写”证据。检查无半 JSON、无旧 journal 覆盖后续更新、幂等；fixture 残留锁清理由 harness 限定在自身已确认退出的子进程与临时根。解释**杀进程测试不等于断电实验**。

## 5. 门禁、交付和停止条件

```powershell
# D:\BIOS_Pi_Agent\PiDeck_BIOS\packages\bios-agent
npm run typecheck
npm test
npm run selfcheck
npm run check:format

# D:\BIOS_Pi_Agent\PiDeck_BIOS
npm run typecheck
npm run check:format
node --test tests/processGuards.test.mjs
git diff --check
```

183 基线不削弱，不凑测试条数。新增失败回归先红后绿；文件 symlink 无权限就明确 skip，junction 实跑。不改用户系统设置来掩盖 skip；故障注入不冒充真实故障。

更新 Package README、task/test/log 与 `bm02c1_implementation.md`，列明真实进程退出证据、API 结果与锁人工处理限制。根全量/安装版/远端 CI/跨平台未执行则标未测。现有修改、未跟踪源码与历史文档删除全部保留，不 add/commit/push。

完成 C1-1～4 后停止并交回验收，不自动开始 C2/D/BM-03，不提前做 UI。若遇到协议矛盾或想改变“不重放、不偷锁”的边界，先写明问题交给用户决定，不能默默扩大成事务框架。接近上下文限制前，在实施记录写当前完成项和唯一下一项。

## 6. 给开发 AI 的提示词

```text
在 D:\BIOS_Pi_Agent\PiDeck_BIOS 的 BIOS_Agent 分支开发 BM-02C1。
先完整读 AGENTS.md、docs/bios-agent/round7_acceptance.md 和
docs/bios-agent/bm02c1_development_plan.md，检查 git status，保留现有修改/
未跟踪文件与前轮文档删除。BM-02BR 已在声明的本机范围通过，183 测试中
181 通过、2 个文件 symlink 权限 skip；不要重做 W1～W4 或骨架。

只按 C1-1～4 做单文件 journal：有界元数据/真实字节 fingerprint、prepared
先于目标提交、提交后 journal 失败仍返回真实成功与 needs-recovery、只读
inspect 与持锁 reconcile。恢复只核对/收口 journal，不重放/回滚目标，
不重复加 revision、不按 PID/年龄偷锁；busy 需人工确认。保留 create link
非覆盖、update rename、有效 registry 准入、安全 revision、取消和清理诊断。

使用真实子进程 checkpoint 终止/新进程恢复测试，不用 mock throw 冒充 crash。
新 journal 模块保持小职责，先在 bm02c1_implementation.md 记录协议再实现，
每组先写回归再修，最后跑方案第5节门禁并更新 README/任务/测试/日志。
不做审计多文件事务/迁移/备份CLI/UI/RAG/厂商适配/模型写工具，不改 PiRuntime，
不碰真实客户资料，不 git add/commit/push。完成交回验收，不自动开下一阶段。
```
