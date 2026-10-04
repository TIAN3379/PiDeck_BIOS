# BM-02C3：知识库版本盘点与迁移预检

更新：2026-10-04。当前状态：**C3/C3R经第二十轮独立验收在声明的本机只读盘点范围通过**；423项/420通过/0失败/3skip，PF-1～PF-4、S1～S3收口。
独立结论见 [第二十轮验收](round20_acceptance.md)，回写见 [C3记录§15](bm02c3_implementation.md)。唯一下一任务为 [BM-02D1](bm02d1_development_plan.md)，本文及C3R旧提示词不再执行。
本文件保留原完成标准，末尾旧提示词不再直接执行。
落地细节、公开 API/状态表、布局覆盖、预算与只读证据、未测边界见 [BM-02C3 实施记录](bm02c3_implementation.md)。
前置：[第十五轮独立验收](round15_acceptance.md)，I1 关闭，审核持久化整改收口。

## 1. 目标与取舍

提供一个可测试的只读核心入口，回答：这份知识库包含哪些格式版本，哪些文件无法解释，是否需要迁移，以及有哪些阻断事项。后续备份、管理 CLI 可复用该结果，不再各自递归扫盘或猜格式。

源码当前只有 registry/五类业务记录 `schemaVersion=1`；审计事件 `auditVersion=1`、审核意图 `intentVersion=1`；普通 journal v1 与审核 journal v2 **合法共存，彼此不是旧新业务格式**。版本来源复用已有常量/校验器，不与 Package、Pi 或桌面版本混用。

当前没有正式旧业务 schema 或转换规则。因此本轮不升业务 schema，不发明 v0→v1/v1→v2，不做实际迁移；结果只能表示“当前已检查范围无需格式迁移”或“受阻/不完整”。它不是整库一致性证明，也不是安全备份许可。

## 2. 范围与入口

建议 `core/storage/preflight/`，由 `core/storage/index.ts` 导出窄入口，例如 `inspectKnowledgeStore(options)`；命名可依现有风格调整。版本分类策略与磁盘遍历分开，单文件目标 ≤400 行；新增公开结果用唯一契约/推导类型，不加 `any`，不靠强转绕过错误。

入口显式接收完全限定的 `root`、限额、AbortSignal 和现有测试 IO hooks，不自动读取默认用户知识库。复用 `StorageBoundary`，**不要调用初始化 API**。结果必须具备：

- 独立报告版本、观察式扫描语义与支持的各格式版本。
- `complete`、明确截断原因和统计：扫描条目、读取文件、版本分布、报告/丢弃的问题数、预算口径。
- 有界文件摘要和问题：工件类别、受控相对路径、观察到的格式版本/状态、可行动错误码；不返回记录正文、原始 JSON、客户字段或凭据。
- 唯一总体结论：`no-migration-needed` / `blocked` / `incomplete`（命名可调整但语义不得弱化）。任何截断都不能返回通过。报告问题被截断时仍保留阻断/不完整结论。

不提供写 API/修复按钮/后台巡检，不把入口注册成 Pi 工具，不增加 CLI/IPC/UI，也不改 PiRuntime。

## 3. 扫描与版本规则

只遍历已知布局、固定深度，覆盖下表。不得沿 registry 的 workspace.path 扫 BIOS 源码，不得跟随链接，不得递归未知目录。

| 落点 | 预检内容 |
|---|---|
| `registry.json` | 必需；版本、结构与既有绑定一致性校验；不存在/损坏明确阻断，不创建空库 |
| `projects/<projectId>/profile.json` | 项目 ID、版本、结构与路径身份；registry 中已登记项目缺 profile 报问题；未登记目录可列为孤立候选，不自动关联/删除 |
| `projects/<projectId>/tasks/*.json`、`context/*.json` | 业务格式、文件 ID、父项目归属与结构；不遗漏未登记项目目录内的受控候选 |
| `experiences/*.json`、`features/*.json` | 业务格式、文件 ID 与结构 |
| `journal/*.json` | 按 journalVersion 显式路由 v1/v2 校验器；未知版本不猜；prepared/conflict 报人工核对事项，不调用 reconcile |
| `audit/intents/*.json`、`audit/<recordId>/*.json` | intentVersion/auditVersion、结构与路径身份；不把版本族混用 |
| `locks/` 与事实目录下的 `.tmp` | 只报告存在/残留；无论 PID/年龄都不判断可抢，不删除、不清理 |
| `cache/` | 标为可重建且未检查，不递归；不是事实记录，也不混入格式版本统计 |

可选目录不存在应视为未使用（例如没有 journal 或 audit/intents 的旧初始化库），不能因为它们缺席而修改布局；registered profile 的必需性与可选目录要区分。未知文件/异常 ID/非普通文件/未知子目录均给有界诊断；未知目录不进入。锁或残留、未完成/conflict journal 暂列 `blocked` 人工核对事项，不宣称失败操作未提交。

坏 JSON、超限、读权限错误、未来/无效版本：报告受控路径和类别，保留原字节；不得按当前格式解析后再“补默认值”。不要创建假的旧版本适配器。版本结构有效不代表审核三方绑定或上板验证有效，本轮**不新增全库跨引用/审核一致性检查器**。

## 4. 安全、预算与并发语义

- 从入口到每个真实 IO 复用既有 canonical root/根内路径与拒绝 symlink/junction 规则。根非法或链接根立即拒绝，不降级为空库。目录句柄有 paired cleanup；取消不能绕开关闭。
- 全局扫描条目、读取/输出字节、文件摘要条数、问题条数、单条诊断长度均有限额。目录层级共享预算；坏文件/未知文件/目录也消耗扫描预算，不能只计算成功记录。
- 使用有界读取，不 `readFile` 整库、不全目录物化后再 slice。说明读取字节预算如何包含失败尝试/增长文件；实际读取与预留额度字段不混称。输出按真实 UTF-8 序列化字节计量，不用字符数冒充字节；中英文/控制字符用例触顶。
- 数值覆盖验证为有限安全非负整数；0 的语义明确，NaN/Infinity/负数/小数拒绝，显式 undefined 不取消默认限额。新限额落在本域，避免为只读扫描扩大所有写入接口。
- 不拿锁、不发布临时文件，不调用 write/update/review/reconcile。扫描是逐文件观察，**不是原子快照**；并发中消失/变化的候选报问题，不自动反复扫描。即便全部读到合法格式，也不承诺扫描结束后状态不变。后续备份需要单独的协作一致性设计。
- 首错/根级失败/取消结构化处理；非根单文件问题可收集继续，但预算或取消立刻停止。诊断不得包含被读取的正文。不得吞掉取消并返回成功。

## 5. 永久测试与完成标准

在新合成临时知识库上测试，不读真实用户/客户知识库；复用已有 fixture/helpers。至少覆盖：

1. 合法空初始化库、非空五类记录、v1/v2 journal 与审计/意图共存；当前版本得到无需迁移结论，不将 journal v2 当作未来业务格式。
2. 可选目录缺失不误报；registry/已登记 profile 缺失；未登记项目候选不自动合并。
3. 坏 JSON、错误路径 ID/父项目、registry 绑定冲突、版本字段缺失/非法/未来版本；错误分类与已知格式校验器一致。
4. prepared/conflict、锁与 `.tmp` 的人工事项；既有 terminal 内容保持，不重放/不偷锁/不清理。
5. 超大/增长文件、根/中间目录/叶子链接拒绝（Windows junction 可复用已可用方案）；保留既有两个 skip，新增权限条件未满足时显式跳过并报告真实数量，不把未执行行为计为通过。
6. 深层目录共同条目预算、摘要和异常输出预算、UTF-8 转义触顶、非法配置和 0/undefined 语义；截断/问题丢弃不误报通过。
7. IO 等待中取消、已开目录取消时句柄关闭；并发候选消失明确诊断，没有无限重试。
8. 扫描前后完整文件清单及 SHA-256 相同（含 registry、业务、journal、意图、事件、锁、残留、cache）；原本不存在的目录未被创建。公开报告里不出现注入的正文哨兵。

修改既有行为前先写红回归；新增功能写行为测试。保留 348 项基线、真实进程回归与两个既有权限 skip，不删/放宽断言。发现预检能力之外的旧问题先记录，不自行启动另一项重构。

## 6. 门禁与交付

Package 目录：

```powershell
node --test tests/storagePreflight.test.mjs tests/auditContracts.test.mjs tests/auditAssociation.test.mjs tests/storageJournal.test.mjs tests/storageReviewWriter.test.mjs tests/storageReviewReconcile.test.mjs tests/storageReviewContracts.test.mjs
npm run typecheck
npm test
npm run selfcheck
npm run check:format
```

新测试文件若拆分须补入针对性命令与完整测试入口，报告真实数量，不预填通过。根目录：

```powershell
npm run typecheck
npm run check:format
node --test tests/processGuards.test.mjs
git diff --check
```

交付代码、永久测试和一份 `bm02c3_implementation.md`：公开 API/分类与状态表、布局覆盖、预算/取消/只读证据、实跑结果、未测边界。同步导航/task/test/log/MVP/Package README；状态为“实施完成、待独立验收”，不是自称验收通过。

本轮收尾验收后再排备份快照与管理 CLI；实际迁移必须等有正式源/目标 schema、转换规则、备份与恢复演练。[分层记忆设计](layered_memory_temporal_design.md) 仅补充之后的 BM-03～05 路线，C3 不实现记忆规则或升版。项目记忆/检索/交接之后才到 BM-07 UI。

保留脏工作树与未跟踪文件，不删历史，不改 PiRuntime/Electron，不读客户资料，不 add/commit/push。

## 7. 简短交接提示词

```text
在 D:\BIOS_Pi_Agent\PiDeck_BIOS 的 BIOS_Agent 分支，先读 AGENTS.md、
docs/bios-agent/round15_acceptance.md 和 bm02c3_development_plan.md。
只做 BM-02C3：知识库版本盘点与迁移预检，覆盖已知布局，复用现有边界/版本校验，
有界、可取消、只读、不误报完整；schema v1 与 journal v1/v2 不混用、不主动升版。
保留 348 项基线及两个权限 skip，补磁盘 hash/取消/预算/坏文件永久回归。
不做实际迁移/备份/CLI/UI/模型工具，不改 PiRuntime、不读客户资料、不 add/commit/push。
跑指定门禁，写一份 C3 实施记录并同步状态，完成后交回独立验收。
```
