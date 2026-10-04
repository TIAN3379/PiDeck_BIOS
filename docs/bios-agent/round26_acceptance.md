# 第二十六轮验收：恢复与 CLI 主体成立，三项收尾与 M1 同批推进

日期：2026-10-04。工作区 `D:\BIOS_Pi_Agent\PiDeck_BIOS`，分支 `BIOS_Agent`，Windows / Node 24.14.1。
依据：D3 方案 §3～6/§11、实施记录 §14、当前源码。本轮仅验收与更新文档，未修运行代码或永久测试，未提交推送。

## 1. 结论与实际进展

D3 恢复 API 和 D4 人工 CLI 已真实交付：正常离线导出、恢复到不存在的新根、原字节往返、五类记录跨进程读取、双确认与完成点状态均有运行证据。不是上一轮仅修导出边界的状态。

**正常闭环通过；整批暂未通过。** 独立诊断发现两项虚假无警告恢复成功和一项 CLI 输出契约缺口，编号 R26-1～3。既有永久测试全绿不代表这些遗漏已关闭；仍不批准正式资料保护使用。D1/D1R、C3/C3R 及历史审核/journal 通过范围保持，不重做旧整改。

下一轮执行 [记忆底座加速批次](memory_foundation_development_plan.md)：三项红绿收尾 → 内部门禁 → 完整 M1 纯决策模块 → M2 兼容方案 → 一次统一验收。允许在同一开发对话内部过闸后继续 M1，不再等待单项修复的独立验收；实际 schema/迁移/业务 IO 不提前实施。

## 2. 本轮独立门禁

| 范围 | 结果 |
|---|---|
| backup 七文件＋CLI | 218 项：218 通过、0 失败、0 skip（207＋11） |
| Package `npm test` | 641 项：638 通过、0 失败、3 显式 skip |
| 旧存储 records/registry/preflight/journal/reviewWriter/write | 249 项：246 通过、0 失败、3 skip |
| Package typecheck / selfcheck / check:format | 通过；selfcheck 6 项，格式 96 文件 |
| 根 typecheck / check:format | 通过；格式 2014 文件 |
| 根 processGuards / git diff --check | 2 项通过 / 通过 |

641 = 上轮 583＋D3 47＋CLI 11（含父测试计数）。3 个既有文件型 symlink 权限 skip 不计通过；本机 backup/CLI junction 用例实际执行。数字为本轮独立复跑，不只是复制实施方记录。

## 3. 额外独立往返与对照

使用自行创建、解析为真实路径的 `bios-accept26-*` 临时沙箱。合成富库通过现有初始化、写入及审核 API 创建，保留 task 文件；字节/hash/集合由 `node:fs`、`node:crypto` 独立计算，不使用实现自报数字互证。下表不计入 641 项。

| 场景 | 实际结果 |
|---|---|
| API 富库导出→恢复 | 15 文件全部与源/清单 SHA-256 相同；文件、目录集合相符；cache/locks 为空；restored |
| 新 Node 子进程用现有 reader | registry schema=1；五类记录均读回；experience revision=1，其余 revision=0 |
| 真实 CLI export→restore→新进程 reader | 三个退出码均 0；15 文件字节一致；五类记录均可解释 |
| CLI inspect | 退出 0；complete=true、no-migration-needed、阻断/人工事项均 0；单 JSON 对象 |
| restore 缺 `--confirm-write` | 退出 2、JSON usage-error；没有创建目标 |
| manifest 读取前将备份根移动并换成真实 junction | 受控 backup-source-not-eligible；admission 阶段、published=false、cleanup=ok；没有虚假成功。此对照不证明读取过程从未跟随链接 |

第一版独立 reader 诊断误以为落盘记录含 `kind`，导致扫描未选中记录；这是诊断自身错误。已改为显式列出五类 kind/ID/projectId 并重跑，真实读取全部成立，没有因此改产品字段。

## 4. 三项必须关闭的遗漏

### R26-1（P1）：源 manifest 变化未参与复核

位置：`core/storage/backup/restore.ts:165`、`:199`；`restoreSource.ts:60`。

复现：富库正常导出后，在恢复第一次 `beforeIo("backup-write", ...)` 时，将备份 `manifest.json` 的 `backupVersion` 从 1 改为 2，其它 payload 不动。当前 `validateBackupManifest` 对现场清单明确返回 invalid-version，但恢复仍返回 **restored / published=true / cleanup=ok / reviewReasons=[]**。

原因：准入只读取一次 manifest；`recheck-source` 使用初始内存清单重新检查文件名和 payload，没有重读当前 manifest 原字节/身份。它不能发现完成标记变化，也不能支持“备份容器内容未变”的承诺。

应有结果：在 registry 发布前发现清单变化，受控拒绝，published=false；只按归属清理目标，备份现场保留。不把“读取到了另一份合法清单”当允许恢复另一备份。保存必要原始指纹/身份并有界重读、重新校验；合法等长改写、删除/替换、未来/坏清单均补永久回归。最终文件常规类型/链接核对随本项触达完善；文件型链接本机权限不足必须显式 skip，不宣称已实际验证。

### R26-2（P1）：目标晚期合法改写仍返回原字节恢复成功

位置：`core/storage/backup/restore.ts:190`～`:224`；`restoreTarget.ts`。

复现：目标非 registry 文件复制及集合盘点已完成，恢复开始 `recheck-source`；在第二次打开 `<backup>/data/registry.json` 的 hook 中，改写目标 `features/feat-1.json` 的 `originalRequirement`，保留其它合法字段。hook 确实触发，独立 SHA-256 与初始 manifest 不同，最终仍 **restored / published=true / cleanup=ok / reviewReasons=[]**。预检能解释这份 JSON，但不证明它是被恢复的原始字节。

原因：只在每个文件刚复制完时回读 hash；之后目标集合核对不核字节，源复核后直接发布 registry，发布后只做 schema/工件预检。

应有结果：完成点前做有界目标集合、归属、长度/hash 复核；发现变化则拒绝发布。发布后检查也区分“可解释”与“字节/布局仍吻合”；可观察的变化必须 committed-needs-review，published=true，保留库并让 CLI 返回 3。不能用清理删除未知/替换物来强行通过，也不能把检查次数无限循环到磁盘稳定。

这两项使用**确定性阶段 hook**，不是凭空推测纳秒级 TOCTOU。故障注入有意打破调用者的离线声明，以验证方案已承诺的可观察变化检查；不是要求隔离同机恶意进程、在线快照或 OS 原子检查，也不宣称能捕获全部 ABA。

### R26-3（P2）：解析失败绕过 `--json` 单对象契约

位置：`cli/knowledge.mjs:136`～`:144`。

真实子进程执行以下三种参数，全部退出 2，但 stdout 为空、只有 stderr 文本：

```text
node cli/knowledge.mjs inspect --json --root
node cli/knowledge.mjs inspect --json --unknown
node cli/knowledge.mjs bad-command --json
```

解析 catch 把输出模式硬编码为 false。显式请求 JSON 的自动化调用方无法解析错误结果。修复时定义解析失败的保守 JSON 意图识别（不要误将路径值视为选项），结果仍是一个有界 usage-error；未知参数/命令正文不无限回显。补 JSON 前后位置、重复/缺值/不适用选项、无 JSON 人类输出及零写入对照，不放松严格解析。

## 5. 边界与交接

未执行根全量测试、安装包重打、远端 CI、真实 ACL、其它 OS、网络盘、断电、客户 BIOS/硬件或真实资料保护试点。当前专业记忆、经验检索、任务上下文和知识 UI 尚未交付。

临时沙箱删除前校验绝对父目录及专用名称，只清除本轮自行创建的合成诊断资料；可重新生成，未删除用户资料。原 dirty tree、未跟踪文件和六项既有历史文档删除保持。未 add/commit/push，未改变 PiRuntime/Electron 或现有持久化版本。
