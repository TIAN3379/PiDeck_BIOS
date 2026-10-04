# BM-02BR 中断开发交接：从现有代码继续收尾

日期：2026-10-01。状态：**已接续完成（R1～R4 全部关闭），见[实施记录](bm02br_implementation.md)；
本文保留为当时的交接快照，不是验收结论，不要再作为当前执行入口。**

> 后续说明（同日）：本文第 3 节列出的剩余项 R1～R4 均已在[实施记录](bm02br_implementation.md)中关闭，
> 第 4 节的实跑结果（158 用例、包内格式失败）是**修复前**的快照，不适用于当前代码。
> 当前执行入口是[当前阶段任务](next_development.md)与[实施记录](bm02br_implementation.md)。

本文基于当前磁盘代码、实跑门禁和两项独立临时库诊断整理。上一对话因上下文限制中断，但改动已保留在工作树；不要重新开发整轮。原始要求仍以 [当前阶段任务](next_development.md) 为准，第六轮问题来源见 [第六轮验收](round6_acceptance.md)。

## 1. 用户决定与工作区

- 用户已明确继续原规划，**不提前启动 UI**。这次只接续 BM-02BR 的 W1～W4；完成后交回验收，不自动开 BM-02C。
- 工作区父目录：`D:\BIOS_Pi_Agent`；实际开发仓库：`D:\BIOS_Pi_Agent\PiDeck_BIOS`。
- 相邻 `PiRuntime` 是运行时项目，本轮不修改。专业能力在本仓库 `packages/bios-agent` 独立 Pi Package 中，不能改造 Pi 内核或复制 Agent 执行循环。
- 当前分支：`BIOS_Agent`，上游跟踪 `origin/BIOS_Agent`；本次检查 HEAD 为 `36eb385a`。
- origin 是 `https://github.com/TIAN3379/PiDeck_BIOS.git`；upstream 是原项目 `https://github.com/ayuayue/PiDeck.git`。这只是本地配置检查，未拉取或推送。
- 当前环境：Windows、PowerShell、Node 24.14.1；Package 开发宿主 Pi 0.87.1。
- 工作树有大量前几轮遗留修改与未跟踪文件，**不能把 git diff 当成本轮完整差异**。尤其未跟踪文件不会出现在普通 `git diff` 中，必须直接读。
- `lock.ts`、`write.ts`、`storageWrite.test.mjs` 等前轮文件已存在但未跟踪；本轮新增的 `commit.ts`、`revision.ts` 也未跟踪。不要删除、重建或遗漏它们；不是“整个 Package 都未跟踪”。
- 六份早期验收/整改文档的删除，是用户之前要求的文档精简：`round1_acceptance.md`、`round1_remediation.md`、`round2_acceptance.md`、`round2_remediation.md`、`round3_acceptance.md`、`round4_acceptance.md`。历史已归入 [历史摘要](acceptance_history.md)，不要恢复删除或再次批量删文档。
- 本次交接只改文档，没有修改生产源码/永久测试，没有执行 `git add`、`commit`、`push`，也没有读取真实客户 BIOS 资料。

## 2. 已落地的代码，不要重写

| 原任务 | 磁盘上的进展 | 当前判断 |
|---|---|---|
| W1 安全 revision | 新增 `core/storage/revision.ts`，expected/current revision 用安全非负整数；记录和 registry 共用 `nextRecordHeader`；溢出拒绝、保留 createdAt/schemaVersion、updatedAt 不倒退 | 对应新增回归已通过，可保留；不宣称整轮已验收 |
| W2 锁参数/诊断/取消 | `lock.ts` 新增 `resolveLockTiming`，写入口和公开取锁入口均使用；日期/字符串字段有界；普通诊断读取传播取消，超时判定前检查两个 signal | 已有回归通过，但 **poll 可越过 deadline**，见第 3 节 |
| W3 关闭/发布/清理 | 新增 `commit.ts`，抽出临时文件准备、close、清理、rename 重试、cleanup 附加说明；create 改为完整临时文件 + sync + close + link；update/registry 仍 rename；成功后的残留返回 warnings | 主要修复已落地，但 **失败后的锁释放诊断仍被吞**；生命周期与组合分支还需补证据 |
| W4 有效库准入 | `write.ts` 的 `assertStoreInitialized` 改为 `readRegistryWithBoundary`，在普通记录取锁/新建业务目录前校验 registry | 坏 JSON、未来版本、绑定冲突、目录四场景 create/update 回归已通过；链接与既有记录保护证据需补齐 |

重点文件，路径均相对实际仓库：

- `packages/bios-agent/core/storage/revision.ts`：共用 revision/公共头守卫。
- `packages/bios-agent/core/storage/commit.ts`：共用提交原语；225 行。
- `packages/bios-agent/core/storage/boundary.ts`：使用共用原语，新增 `publishJsonMeasured` 和 `closeFile` 注入面；目前 596 行，原 659 行已缩小，exports 兼容仍需保持。
- `packages/bios-agent/core/storage/lock.ts`：取锁、诊断、时序参数；297 行。
- `packages/bios-agent/core/storage/write.ts`：三条写入口、库准入、持锁提交与结果；522 行。
- `packages/bios-agent/core/storage/index.ts`：已导出 revision 模块；不要重复造入口。
- `packages/bios-agent/tests/storageWrite.test.mjs`：约第 961 行开始是本轮 W1～W4 回归。原真实子进程竞争/读回/并发读写用例也在此文件，不能删。

本次 Package 测试由此前 140 增至 158（含嵌套子测试）；数量增加不是验收完成依据。`bm02br_implementation.md` 尚不存在，开发日志/Package README 的部分表述还停在第六轮基线。

## 3. 剩余工作，按此顺序继续

### R1：补 W2 的 deadline 剩余预算（已独立复现）

位置：`core/storage/lock.ts` 的 `acquireStorageLock`，当前约第 281 行。

当前失败后先判定 deadline，之后仍直接等待 `timing.pollMs`，没有把等待裁到剩余 timeout。参数合法不等于等待时间有界到用户指定预算。

本次独立诊断：先持有目标锁，再请求 `timeoutMs=10` / `pollMs=1000`，120ms 的诊断 watchdog 才取消。实际约 121ms 返回 `cancelled`，而不是在 10ms 预算附近返回 `lock-timeout`。120ms 取消只为避免诊断等完 1000ms，不是产品期望。

接续要求：

- 先加永久失败回归：合法 poll 大于 timeout、普通等待跨越截止；使用有界 watchdog，不能把取消结果当超时通过。
- 将每次等待限制到 deadline 剩余预算，剩余预算耗尽不再等待；避免零间隔忙等。
- OS/磁盘调度允许合理误差，不要求精确 10ms，但不能再主动睡足远大于 timeout 的 poll。
- 保留 timeout=0 只尝试一次、两 signal 任一取消穿透、取消与超时同到时优先 cancelled、不抢占他人锁。
- 不增加新锁协议或整库全局锁。

### R2：补 W3 的失败清理诊断（部分已独立复现）

位置：`core/storage/write.ts` 的 `runUnderLock`，当前约第 320～322 行。

现有 catch 仍是 `await lock.release().catch(() => undefined); throw error;`。成功路径已有 warnings，但失败路径仍丢失“锁未释放”的诊断。

本次独立诊断：创建 revision=0 的记录，以 expectedRevision=99 更新，同时在 `beforeIo("lock-remove")` 注入 EIO。结果保留 `revision-conflict`，磁盘仍有一个自有锁目录，但错误 message/detail 都没有锁清理失败说明。原记录 hash 未变。

接续要求：

- 先加“原写入错误 + 自有锁释放失败”的永久回归，再做最小修复。
- 保留原始 code/path/detail/expected/actual；释放抛错，以及返回 `not-owner`/`missing` 的异常清理状态，都要有固定、有界的附加诊断，不覆盖首个错误，不泄漏客户正文。
- 继续忽略取消来清理自有锁；不能因为 abort 放弃释放，也不能删除他人锁。
- 同时检查 **EEXIST + 临时清理失败** 组合：`publishJsonMeasured` 可返回 `{status:"exists", cleanup:"failed"}`，但 `commitRecord` 的 exists 分支随后直接抛 revision-conflict，可能丢掉临时残留诊断。此组合本次只做代码检查，**未独立运行**，应先用回归确认。
- 提交成功后仍返回真实 created/updated 与警告；不要用清理失败制造“未提交”假象。

### R3：补齐证据，不扩张功能

- **FileHandle 生命周期**：当前新增 close 失败测试只有 `closeCalls >= 1`、无 tmp、后续可写，还不足以说明所有准备失败/中途取消路径无遗留句柄。补可观测的真实 handle 状态或等价的 open/close 生命周期证据；覆盖正常、sync/close 失败、已打开后取消。不依赖 GC，不能仅以随后能写作为句柄已关闭的证明。
- **create 故障面**：保留发布窗口“目标缺失或完整文件”、EEXIST 不覆盖；在记录 create 的公开路径补/核对 link 不支持、清理失败、提交前等待期间取消、提交后迟到取消。不要只依靠初始化的 link 测试证明所有新组合。
- **W4**：补 registry 链接/junction 下普通 create/update 拒绝、根外 sentinel 不变；update 场景至少预先创建一条合法记录，再损坏 registry，断言该记录和 registry 原 hash 不变。当前四场景的 update 目标本身不存在，只证明准入错误先于目标缺失，不充分证明既有记录保护。
- 文件型 symlink 在当前 Windows 可能 EPERM；如无法创建明确 skip，目录 junction 能执行则实跑，不能全组假通过。
- 边界重构已抽出 `commit.ts`，不要为了行数继续重写整个存储层。说明 596 行 boundary 与 522 行 write 的职责取舍即可，保持初始化/B0/export 兼容。
- `commit.ts` 已把 rename 重试从前轮 6 次线性退避改为 12 次指数退避、延迟上限 250ms、标称总预算 4000ms。说明取舍并核对预算/取消/最终失败测试；注释中的“本机实测”没有当前实施记录支持，不可当验收证据。

### R4：格式、文档与收口

- 当前确定失败的门禁是 Package `npm run check:format`：`core/storage/revision.ts` 有 CRLF/排版差异。收尾时按现有 Biome 配置定向格式化，不更改配置、不全仓库机械改写。
- 更新 `packages/bios-agent/README.md`：安全 revision 已实现；create 走 link、update/registry 走 rename；锁参数合法范围、cleanup/warnings 和未测边界都与最终代码一致。删除/修正“create/update 都走 rename”“close 仍被吞”等过时的现状说明。
- 核对 `core/storage/index.ts` 的“本轮只读”头注释，以及其他触达注释是否与实际导出能力矛盾；不把历史自测改写成独立验收。
- 更新 `task_breakdown.md`、`test_checklist.md`、`development_log.md`，新增唯一实施记录 `bm02br_implementation.md`，记录 W1～W4 对照、实跑命令、skip、未测和重试取舍。
- 本交接完成后可标为“已接续完成，见实施记录”，保留链接避免再出现多个当前任务入口；不要再新增一套相同的整改计划。
- 全部门禁通过后，状态写“实施完成、待独立复验”，不能自己把 BM-02B/BR 标为完整独立通过。

## 4. 本次实跑结果与后续命令

以下是本次交接检查的快照，不是未来修复后的结果：

| 工作目录 | 命令 | 本次结果 |
|---|---|---|
| `packages/bios-agent` | `npm test` | 158 测试：157 pass、0 fail、1 skip（最终记录文件 symlink，EPERM）；真实双子进程创建/更新竞争、新进程读回、并发读写实际通过 |
| 同上 | `npm run typecheck` | 通过 |
| 同上 | `npm run selfcheck` | 6 项通过；默认路径展示不等于修改实际用户知识库 |
| 同上 | `npm run check:format` | **失败**：检查 31 文件，revision.ts 的格式问题；未自动修复 |
| 仓库根 | `npm run typecheck` | 通过 |
| 仓库根 | `npm run check:format` | 2014 文件通过；注意根脚本不检查这个 Package，不能抵消包内失败 |
| 仓库根 | `node --test tests/processGuards.test.mjs` | 2 项通过 |
| 仓库根 | `git diff --check` | 通过（也不覆盖未跟踪文件内容） |

两项独立诊断使用新建合成临时库，不修改永久测试；结束前已删除本次临时库/锁，目标原 hash 不变。它们尚未进入自动回归，下一位需先补测试。

修复后需重新跑所有上表命令，不能沿用此次绿色结果；单个问题开发时先跑针对性用例，收尾再跑 Package 全量。根全量测试、生产构建/安装包、干净 clone、远端 CI、Linux/macOS、真实客户 BIOS 试点本次均未执行，不得写为通过。

## 5. 最小阅读路线与停止条件

为避免再次消耗上下文，新对话不要一开始读取所有历史文档或扫描整个桌面源码：

1. 完整读仓库根 `AGENTS.md`，运行 `git status --short --branch`。
2. 完整读本文和 `next_development.md`；按需要核对 `round6_acceptance.md` 的 W1～W4。
3. 聚焦 `lock.ts`、`write.ts`、`commit.ts`、`revision.ts`、boundary 提交接口及 `storageWrite.test.mjs` 的对应段落。
4. R1 → R2 → R3 → R4；不重做已有 W1，不重新生成 Package 骨架。
5. 每完成一组，在实施记录中记当前状态/下一项/实跑结果，防止再次中断后丢失进度。

路线仍为：BM-02BR 复验 → BM-02C1 单文件 journal/进程崩溃恢复 → C2 审计/多文件/迁移 → D 管理与备份 → BM-03 档案 → BM-04 经验/特性 → BM-05 任务上下文 → BM-06 Pi 工具/Skills → **BM-07 UI**。当前不提前实施路线中的后续项；进程崩溃恢复也不等于断电保证。

停止条件：W1～W4 原要求及本交接剩余项有回归证据，所有本轮门禁通过，实施文档更新，向用户报告并交回验收。不要自动执行 journal/迁移/备份 CLI/UI/RAG/厂商适配/模型写工具，不要修改 PiRuntime，不要提交或推送。

## 6. 给新对话的提示词

```text
请在 D:\BIOS_Pi_Agent\PiDeck_BIOS 的 BIOS_Agent 分支接续未完成的 BM-02BR。
先完整读 AGENTS.md 和 docs/bios-agent/bm02br_handoff.md，再读 next_development.md。
先检查 git status，保留所有已修改/未跟踪文件及此前授权的六份文档删除。
本轮 W1～W4 的主要代码已写好，不要从头重做；当前 158 测试中 157 通过、
1 个文件 symlink 权限 skip，Package 格式检查失败，整轮尚未验收完成。

按交接文档 R1～R4 接续：先补永久失败测试，修锁等待 poll 越过 deadline，
修失败后的自有锁释放/组合清理诊断，再补生命周期、create 发布与 W4 既有
记录/链接保护证据。保留原错误码、取消语义、提交点、非覆盖发布和真实并发测试。
定向格式化 revision.ts，复跑 Package 和根门禁，更新 README/任务/测试/日志，
新增 bm02br_implementation.md，记录实际结果、skip 与未测。

用户已明确按原规划，不提前做 UI。本轮只收尾 BM-02BR，完成交回独立验收，
不自动继续 BM-02C。不做 journal/迁移/备份CLI/UI/RAG/厂商适配/模型写工具，
不改 PiRuntime、不碰真实客户资料、不 git add/commit/push。
若再次接近上下文限制，先把已完成项和唯一下一项更新到实施记录再停。
```
