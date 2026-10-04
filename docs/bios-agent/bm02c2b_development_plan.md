# BM-02C2B：一次经验卡审核的最小持久化闭环

日期：2026-10-01；2026-10-02 更新。状态：**经 C2BR/C2BR2 整改，第十五轮独立验收通过声明范围，I1 关闭，审核持久化收口**。证据见 [第十五轮验收](round15_acceptance.md)，下一轮仅执行 [C3 只读预检](bm02c3_development_plan.md)。[实施记录](bm02c2b_implementation.md)、更早验收与整改标准保留历史，不重跑旧提示词。
落地细节、状态/取消/清理表、进程证据与未测边界见 [C2B 实施记录](bm02c2b_implementation.md)。
本文转为完成标准留档，第 7 节提示词不要重跑。
前置：[第十一轮独立验收](round11_acceptance.md)：C2A/C2AR 的协议与纯校验通过，A1～A3 关闭，253 项中 251 pass、2 文件 symlink 权限 skip。

## 1. 本轮目标与范围

把已通过的纯契约接到真实文件 IO，实现一个闭环：**人工调用领域 API → 一条已有 ExperienceCard 状态变更 → 不可变审计事件 → 新进程显式核对/收尾**。

本轮只保护这一条记录及其审核工件，不做通用 N 文件事务、批量审核、跨项目修改、自动后台恢复、锁抢占、数据重放/回滚、迁移/备份/CLI/UI、RAG、厂商适配或模型审核工具。不会增加企业身份认证，也不自动证明 verified 的上板验证真实性。知识写模型仍不可用。

改动限于 Package 的 review 领域/存储、必要纯契约/共享小 helper、永久测试与文档。沿用 TypeBox/现有 IO 边界，不新增依赖；不改 Electron/PiRuntime，不碰客户资料，不删历史文档，不 add/commit/push。保留现有修改/未跟踪文件/既有删除。

## 2. 文件组织与实施顺序

建议 `core/storage/review/` 按职责拆 `contract.ts`、`artifacts.ts`、`writer.ts`、`inspect.ts`、`reconcile.ts`、`index.ts`；若需纯状态策略另建小文件。命名可调整，但契约不反向 import IO，模块目标 ≤400 行，超过 600 行评估拆分。

| 编号 | 交付 | 完成判据 |
|---|---|---|
| C2B-1 | 完整审核 v2 契约与工件 IO | 不把关联投影当完整 journal；意图/事件真实字节读写有界、非覆盖、损坏保护 |
| C2B-2 | 一次审核领域写入口 | 同一目标锁贯穿整个协议；记录只提交一次；提交后的失败如实表达 pending |
| C2B-3 | 只读巡检与显式恢复 | 新进程持锁复读，事件先于完成终态；无重放/抢锁；重复核对不改业务 revision |
| C2B-4 | 故障/竞争永久回归与文档 | checkpoint 与真实子进程行为通过；全部指定门禁通过，记录未测 |

先确定 API/结果/状态表再编码，完成上述闭环后交回验收，不自动做 D/UI。需要公共 helper 时只做有回归保护的最小抽取，不能借此重写 C1/普通写管线。

## 3. C2B-1：真实工件与完整 v2

- 复用 `AuditIntentSchema`、`AuditEventSchema`、`compareAuditAssociation`；纯比较的 intentBytesHash 必须来自**同一次有界读取返回的原字节指纹**，不能重排键后重序列化冒充原字节。
- 路径只由验证过的 ID 派生：`audit/intents/<operationId>.json`、`audit/<recordId>/<eventId>.json`、`journal/<operationId>.json`。所有目录段/最终文件沿用现有 canonical root、链接拒绝和受控 resolve；旧库惰性增加目录，不重写初始化 registry。
- 意图与事件 immutable，发布用同目录临时文件写完/sync/close，再 link 非覆盖；不支持硬链接明确失败，不回退直写。返回真实创建/已存在/清理情况，不泄漏正文。
- 意图撞名不能覆盖：同 operationId 同真实字节可明确幂等认领；不同字节冲突。已有事件完整校验后按稳定决定认领，返回其原 publication/recordedAt；不同决定/非法事件拒绝，不覆盖。
- 完整审核 journal v2 必须包含 operation=update、状态与时间/来源约束，加上已通过的审核 discriminator、eventId、受控 intentName、intentHash、target、before/after。目标仅 experience-card，指纹非 null、after=before+1，文件名与 operationId 一致。明确 prepared 与 committed/aborted 等终态的字段规则和合法迁移，不为省事接受任意状态。
- 从**完整已校验 v2**提取关联投影，禁止任意拼投影绕过版本/状态/归属校验。意图须在业务提交前持久化并绑定真实 hash。
- 普通写继续生成 v1；`JOURNAL_SCHEMA_VERSION=1` 和五类记录 schemaVersion=1 不变。旧 v1 校验器继续拒绝 v2，不扩义、不迁移、不原地升级。可新增显式审核 inspect/reconcile API，与旧 C1 入口并存，不要求旧恢复器处理 v2。
- 意图/事件读取先以真实字节限额拒绝，再解析校验；首版沿用 16 KiB 硬上限，可配置限额只能收紧。v2 另有明确 journal 预算，采用现有有限读取。缺失、坏 JSON、未来版本、错误身份、链接/目录、增长或超限不能当成不存在。

## 4. C2B-2：领域入口与提交真相

最小入口建议 `recordReviewDecision({root, recordId, expectedRevision, action, operatorLabel, reason, evidence?, signal?, ...测试注入})`。输入不能传整条替代记录、自由路径、扩大授权根或自行声明“已审核”。生成并返回稳定 operationId/eventId；重试/恢复必须用返回的 operationId 查原操作，不盲目重新发起。

```text
取 ExperienceCard 的原目标协作锁
→ 同源复读/验证原记录与 expectedRevision
→ 校验 action/from/to，组装唯一 after（真实序列化与 hash）
→ 意图 link → v2 prepared journal link
→ 记录 rename（唯一业务提交点）
→ 事件发布/认领 → v2 完成终态 → 释放自有锁
```

- 必须与普通 updateRecord 使用**同一把、同一路径**目标锁。锁等待参数有限、取消及时、释放免疫取消；不重入再调用会取锁并自动写 v1 的 updateRecord，不先调用 C1 收口再补事件。
- registry/记录合法准入、身份、safe revision、溢出、时间与字节预算沿用现有规则。保留 id/createdAt/业务正文，revision 只增 1、updatedAt 不倒退；审核入口只接受窄动作。若设置/清除 reviewer，先写明每个动作的规则，不能把提交人或恢复器误当批准人；审核标签不作身份认证。
- 内部 status 与 from/to 完全对应；record-evidence/record-validation 下标要对当前不可变业务内容验证实际存在。外部引用声明不冒充已读取/已验证证据；不扩展跨客户权限/检索。
- 同一序列化 after 既用于指纹又用于真正提交；不能为重新生成时间改变字节。实际提交返回 hash 若与 prepared 不符，要显式报不一致，不能改写意图掩盖它。
- 业务提交前失败/取消：业务不变，无事件；已存在 prepared 时可记 aborted，失败仍保留原错误和清理诊断。意图已发布但 prepared 失败时保留孤立意图供人工判断，不自动删除未知工件。
- 业务提交后事件失败：返回 **applied-audit-pending + needs-recovery**，携带 operationId/revision，不能假称未提交或提供虚假的发布事实。
- 事件存在但终态失败：返回 **applied-journal-pending**，保留真实事件来源/时间；全部成功返回 applied。迟到取消不能否认已经提交/发布的事实。原错误优先，句柄/临时文件/锁残留以有界附加诊断呈现。
- 首次发布的 publication 根据实际路径为 writer 或 recovery；recordedAt 在该次发布尝试临近提交前取值并校验，不称精确文件系统落盘时刻。已有事件永不重打时间。

## 5. C2B-3：巡检与恢复

建议显式 `inspectPendingReviewOperations` / `reconcileReviewOperation`（最终名字记入 README）。不注册模型工具，不接 CLI/UI，不自动后台运行。

- 巡检只读。候选数量、扫描数、真实 UTF-8 输出字节和 problems/warnings 都有明确上限与截断计数；空结果也保留固定信封开销。普通合法 v1 与审核 v2 明确区分；未知版本不猜，不因 intent 缺失降级。
- 恢复与 writer 用同一目标锁。锁前读取仅定位目标，持锁后复读完整 journal；目标身份或绑定变化拒绝，不在旧锁下操作新目标（保留 J1）。意图/目标的版本、结构、身份和 hash 来自各自同一次有限读取（保留 J2）。
- prepared 且目标=before：aborted，不发事件；目标=after：先验证关联，再发布/认领事件，最后 committed。任一意图/事件不可解释或关联不一致：拒绝发布/成功收口，保留证据。
- 目标高于 after、同 revision 不同 hash、既非 before 也非 after：conflict，**不改业务、不发事件、不猜测补完**。缺失/非法目标保持保守解释。
- 已有 committed：核对它所绑定的意图与事件，匹配才幂等返回；事件缺失/坏/冲突显式报不一致，不无条件成功。不要求当前业务仍停在旧 after，后续合法更新不应让历史完成审核失效。已有 aborted 不产生事件，异常存在事件必须说明不一致。
- 两个恢复者持同锁串行，后者复读后认领/幂等；没有两把锁或递归取锁。busy 不删他人锁，不按 PID/mtime/年龄抢占，无 force。进程崩溃残留锁仍需要人工确认；测试只能在确认其归属的合成 fixture 中模拟人工清理。
- 恢复期间取消在尚未发布/写终态前穿透；一旦已发布，结果如实带事件事实，journal 未完成就报告待收口。恢复自己再次中断后，下一次保留第一次发布时间，不重新递增记录。

## 6. C2B-4：必须永久验证

使用临时合成知识库，不用客户 BIOS 文件。测试公开结果及真实磁盘字节，不以源码字符串断言替代行为。故障注入和子进程终止不是断电实验。

| 场景 | 必须断言 |
|---|---|
| 正常审核与新进程读回 | 状态/reviewer 规则正确，revision 只增 1，完整 v2/intent/event 三方关联和真实 hash 一致 |
| 无效动作/陈旧 revision/缺记录/非法 evidence index | 业务与旧工件原字节不变，无新审计事件 |
| intent link / v2 prepared link / 记录 rename 前失败或取消 | before 保持；事件不存在；prepared 若有则按未提交处理 |
| rename 后、事件 link 前终止 | after 保持，事件暂缺；新进程核对先补事件后终态，不重放记录 |
| writer 事件发布后、终态前终止 | 恢复认领 writer 来源与原时间，不误判冲突 |
| recovery 发布后、终态前再次终止 | 再次恢复认领第一次 recovery 来源/时间，记录和事件 hash 不再改变 |
| 事件发布失败/终态失败/迟到取消 | 返回实际 applied-pending 分支，不能把已提交误报未提交 |
| intent 缺失/损坏/未来版本/被替换/错绑定 | 无降级为普通 v1、无事件/成功终态，原字节保留 |
| 同 eventId 不同决定 / 非法事件 / 完成终态缺事件 | 冲突/不一致，不覆盖、不无条件成功 |
| 同 ID 等价决定但 JSON 键顺序不同 | 原字节 intent 指纹规则仍严格；已有合法事件按稳定决定认领 |
| 高 revision、同 revision 不同 hash、坏/未来/错身份目标 | 保守 conflict/unreadable；校验与 hash 同源，无业务写入 |
| 真实两审核进程同 expectedRevision 竞争 | 恰好一方提交；另一方冲突；一条状态变更、一个有效事件，无覆盖 |
| 真实两进程恢复竞争 | 一次发布或已有事件认领，终态一致，无业务 revision 重复递增 |
| 他人锁/损坏锁、取消+清理失败、句柄生命周期 | busy/原错保留，清理诊断可见，只释放自己的锁，不靠 GC |
| 路径逃逸/链接/超限读取与精确输出预算 | 根外 sentinel 不变；少一字节就截断/拒绝，不能漏算括号/缩进 |
| v1/v2 共存 | 普通写仍 v1/C1；旧 v1 读者拒绝 v2；新审核入口完整验证 v2，不自动迁移 |

实现 [C2A 实施记录 §3.9](bm02c2a_implementation.md) 的全部适用 checkpoint，并覆盖恢复器二次中断。允许新增同域测试文件拆分；不删旧断言、不新增 skip 掩盖失败。

门禁：

```powershell
# packages/bios-agent；相关测试文件名以实际落点为准
node --test tests/auditContracts.test.mjs tests/auditAssociation.test.mjs tests/storageJournal.test.mjs
node --test "tests/storageReview*.test.mjs"
npm run typecheck
npm test
npm run selfcheck
npm run check:format

# 仓库根
npm run typecheck
npm run check:format
node --test tests/processGuards.test.mjs
git diff --check
```

新建唯一 `bm02c2b_implementation.md`，记录 API、状态/取消/清理表、真实 IO/进程证据、永久用例与未测。同步导航/task/test/log/MVP/Package README。基线 253 项不削弱，新增数量按实际统计；完成交回验收，不自动提交或继续 D/UI。

## 7. 简短提示词

```text
在 D:\BIOS_Pi_Agent\PiDeck_BIOS 的 BIOS_Agent 分支，读 AGENTS.md、
docs/bios-agent/round11_acceptance.md 和 bm02c2b_development_plan.md。
C2A/C2AR 已在协议与纯校验范围通过；只做 C2B-1～4：一次经验卡审核的
真实持久化、专用 journal v2、审计发布/认领、显式巡检恢复及故障/多进程测试。
保持普通 v1/C1 行为，事件先于完成终态，提交后的失败如实报 pending。
不做通用事务/迁移/CLI/UI/模型审核工具，不改 PiRuntime、不碰客户资料，
保留全部已有改动、不 add/commit/push。跑指定门禁，更新文档，交回验收。
```
