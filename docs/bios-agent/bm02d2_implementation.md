# BM-02D2 实施记录：D1R 收尾 ＋ D2 离线导出

日期：2026-10-04。工作区 `D:\BIOS_Pi_Agent\PiDeck_BIOS`，分支 `BIOS_Agent`。
状态：**已完成第二十二轮独立验收：D1/D1R 通过纯校验范围，D2 暂未通过**。§1～7 保留实施方快照；独立结论和修正见 §8，不以历史自测代替验收。
依据：[第二十一轮验收](round21_acceptance.md)（B1/B2）、[D1 方案 §8.1～8.3](bm02d1_development_plan.md#8-当前唯一任务bm-02d1r)、[D1R＋D2 加速批次](bm02d2_development_plan.md)。

## 1. 本批两个节点

| 节点 | 内容 | 记录 |
|---|---|---|
| A：D1R | 关闭 B1（真实视图品牌与实际长度先于 hash）、B2（exclusions 数量先于元素访问） | [D1 实施记录 §9](bm02d1_implementation.md#9-d1r-实施b1b2-收尾2026-10-04) |
| B：D2 | 离线导出：预检准入 → 受控 inventory → 有界原字节复制 → 源变化检测 → 目标回读复核 → 非覆盖发布 `manifest.json` | 本文 |

节点 A 的旧红新绿与节点门禁见 §9；本文只记 D2。**两个节点都只是"实施完成"，统一交回独立验收。**

## 2. 公开 API 与容器形状

```ts
exportKnowledgeBackup({
  root,                                  // 完全限定的源知识根（不读默认真实用户库）
  backupRoot,                            // 完全限定、尚不存在的目标目录；父目录必须已存在
  offlineConfirmed: true,                // 必须在任何输出创建前显式为 true
  limits?, preflightLimits?, signal?,     // 两套独立预算；取消信号
  backupId?, now?,                        // 注入（测试用）
  ioHooks?,                               // 受控 IO 注入（仅测试；默认仍是真实 fs）
}): Promise<ExportKnowledgeBackupResult>
```

成功结果只包含调用方已知的目标与计数：`status:"exported"`、`backupRoot`（canonical）、`backupId`、
`createdAt`、`consistency:"offline-copy"`、`files`、`directories`、`totalBytes`、`published:true`、`cleanup`。
**不附源绝对路径、不附预检报告、不含正文。**

```text
<backupRoot>/
  manifest.json       # 最后发布；它的存在是本 API 的完成标记
  data/
    registry.json …   # 原字节复制；cache/locks 内容既不复制也不在 data/ 下建目录
```

新增窄方法：`StorageBoundary.readRawBytes`（`core/storage/readBytes.ts`）——只做**有界读原始字节**
（读到 EOF 或上限+1、每个等待点查取消、`finally` 关句柄、指纹按原始字节算）。
`readJson` 未改动（回归见 §5），导出不复用 JSON 解析，因此 payload 不经 parse/stringify 往返。

## 3. 路径、准入、资源与发布口径

- **参数先于 IO**：`offlineConfirmed !== true`、相对路径、非法限额、非法 `now`/`backupId` 都在创建任何输出之前受控失败。
- **目标取得**：`mkdir`（非 recursive）成功才算拿到；已存在（空目录/旧备份/半成品/文件/链接）一律 `backup-target-exists`，
  不凭 `exists` 承诺无覆盖；父链不存在时 `backup-argument-invalid`，不自动创建父目录。
- **重叠判定**：按**路径段**比较（`C:\know` 与 `C:\knowledge` 不互相包含），目标父目录 `realpath` 后判定，
  拒绝"相同 / 目标在源内 / 解析后重叠"。"源在目标内"在当前约束下不可达：源必须已存在、目标必须不存在，
  已存在的源不可能是尚不存在目标的子目录（同 `path-conflict` 一类结构性不可达，已在实现里保留断言）。
- **准入**：复用既有 `inspectKnowledgeStore`，要求 `complete`、`outcome="no-migration-needed"`、
  `truncatedBy` 空、`dropped*` 为 0、`blockingProblems=0`、`manualItems=0`、`problems` 为空
  （不只检查 problems 数组是否为空）；不合格即 `backup-source-not-eligible`，前置/后置各查一次。
- **受控 inventory**：固定深度、与 D1 落点表同一份判据；未知落点、知识根布局外条目、链接、超限或截断都失败；
  空目录按已知落点保留；`cache`/`locks` 不进入清单也不创建。
- **复制**：逐文件 `readRawBytes`（预算取 `min(maxFileBytes, 剩余总量)`）→ 独占创建写目标（`wx`、循环处理短写、`sync`、`close`）；
  长度、总量累加与 SHA-256 全部来自这一次真实读取；**不把源与目标整库装进内存**。
- **源变化检测**：复制后重新盘点（集合签名）、重跑准入、逐文件重读源字节比对长度与 hash；
  任一变化即 `backup-source-changed`（同长度改写也能发现）。
- **目标回读复核**：逐文件有界回读目标并对 `manifest` 条目重算长度与 hash（复用 D1 的 `measureBackupPayload` 口径，
  不另造放宽的校验，也不为调用纯 API 而无界装载整库）。
- **发布**：全部复核通过后，目标内独占临时文件 → `sync` → `close` → `link` 到 `manifest.json` → 删临时文件。
  硬链接不可用即 `publish-unsupported`，**不**退化成"先 exists 再覆盖写"。
- **失败/取消**：提交点前失败必须清理本次排他创建的内容（文件先删、目录自深到浅、最后删目标根），
  不做递归删除；发现残留/归属不明/删除失败即保留并如实报告，主失败码不被清理失败覆盖（只追加说明）。
  提交点之后不存在的路径一律"如实报告已发布"，不假称未提交、不回滚已完成备份。
- 新增受控码：`backup-argument-invalid`、`backup-source-not-eligible`、`backup-target-exists`、
  `backup-target-overlap`、`backup-source-changed`、`backup-io-failed`（未分类失败不透传原始异常正文）；
  预算耗尽复用 `too-large`，取消复用 `cancelled`，发布不可用复用 `publish-unsupported`。
- `StorageIoOperation` 增加 `"backup-write"`（目标侧新建文件的钩子类别），既有类别语义未改。

## 4. 永久回归与实跑

新增两个测试文件（合成临时库，不读客户资料）：

- `tests/storageBackupExport.test.mjs`（10 项）：空库/受控残留不变/五类记录 + 审核工件 + 字节保真、
  参数与目标拒绝（未确认离线、相对路径、未知限额、已有目标、重叠、父目录缺失）。
  容器正确性由**独立 fs/crypto** 重算：遍历 `data/`、逐文件长度与 SHA-256、目录集合（含空目录）与清单逐项一致。
- `tests/storageBackupExportFailure.test.mjs`（15 项）：准入拒绝（坏 JSON、未来版本、锁、`.tmp`、未知条目）、
  复制期间取消、源同长度改写、目标回读被改坏、单文件/总量预算差一、**真实双进程竞争同一目标**。
  每个负例都断言三件事：受控类别、**没有 `manifest.json`**、**本次目标被清理干净且源库未被修改**。

```text
node --test（backup 四文件）                                     → 128 项：128 通过、0 失败、0 skip（D1R 103 + D2 25）
node --test（records/registry/preflight 受影响旧读取回归）        → 100 项：98 通过、0 失败、2 显式 skip
npm test                                                         → 551 项：548 通过、0 失败、3 显式 skip
npm run typecheck / selfcheck（6 项）/ check:format（83 文件）     → 通过
仓库根 typecheck / check:format（2014 文件）/ processGuards（2 项）/ git diff --check → 通过
```

`npm test` 由 516 → 551（+35 = D1R 10 + D2 25）。三个 skip 仍是既有本机文件型 `symlinkSync` 权限限制；
D1R/D2 新增用例均实际执行、无 skip 分支（目标父链 junction 对照在本机可创建并已执行）。

## 5. 可复现样例

```powershell
# 一次真实导出（合成库）：生成 <目标>/manifest.json 与 <目标>/data/**
node --test tests/storageBackupExport.test.mjs      # 内含"最小库导出 + 独立复核容器"用例
```

```ts
import { exportKnowledgeBackup } from "./core/storage/backup/index.ts";
const result = await exportKnowledgeBackup({ root: "D:\\kb", backupRoot: "E:\\backups\\kb-2026-10-04", offlineConfirmed: true });
// result = { status: "exported", files, directories, totalBytes, published: true, cleanup: "ok", ... }
```

复核口径（测试里就是这么做的，不用实现自身字段互证）：遍历 `data/` 得到实际文件/目录集合，
逐文件 `statSync().size` 与 `createHash("sha256").update(readFileSync(...)).digest("hex")`，
与 `manifest.json` 的 `files[].bytes/sha256`、`directories` 逐项比较。

## 6. 未测与剩余技术债

- 未实现（不在本批）：D3 恢复到新空目录、D4 管理 CLI、UI/Pi 工具/记忆、ZIP/压缩/加密/增量/网络备份。
- **不是**在线原子快照：`offline-copy` ＋ 观察式变化检测；两次检查一致不能证明从未有写入者，
  也发现不了"改了又改回原样"的变化；不承诺同机恶意进程隔离、网络盘或断电耐久性。
- 未注入的故障（有真实 IO 覆盖，但未逐项构造）：短写（`write` 返回部分字节）与 `sync`/`close` 失败、
  删不掉残留导致 `cleanup:"failed"` 的报告路径、manifest 发布时硬链接不可用（`publish-unsupported`）。
  这些分支已有实现与受控类别，但**没有**专门用例；记录为剩余技术债，优先级中等（不影响正常路径正确性）。
- 目标 payload 在无 `manifest.json` 时可见（未完成容器）；每个 payload **不是**独立原子发布。
- `preflightLimits` 与 `BackupLimits` 各自生效，有效可导出范围由较紧的一方决定；实际 IO 会因预检/复核多次读取，
  `maxTotalPayloadBytes` **不是**整个导出过程的 IO 总量预算。
- 未测：生产打包/安装、其它 OS、干净 clone、远端 CI、真实 ACL、断电、真实 BIOS/硬件。
- 未改：预检/写入/审核/journal 行为（`readJson` 未动）、PiRuntime/Electron、业务 schema；
  未 add/commit/push；脏工作树、未跟踪文件与六项历史文档删除保留。

## 7. 后续

D1R＋D2 统一独立验收通过后：D3（仅恢复到新空目录 + 字节级往返 + 新进程可读）→ D4（最小人工 CLI）→
M1/M2 记忆闸门 → BM-03～05 → Pi 工具（BM-06）→ 最小 UI（BM-07）。RAG/向量库与自动学习不是当前前置。

## 8. 第二十二轮独立验收回写

[验收报告](round22_acceptance.md)：独立复跑 backup 128 项、旧读取 100 项（98 通过、2 skip）、Package 551 项（548 通过、0 失败、3 skip）及指定门禁通过。B1/B2 原复现拒绝，D1/D1R 的协议与纯字节校验范围通过。

D2 独立故障实验确认 D2-1～4 阻塞：junction 替换后清理误删目标外 sentinel；额外文件/缺空目录仍发布；根取得和发布前取消、关闭失败、临时清理事实未完整处理；原异常和完整源路径透传。§3 中“按所有权清理”“正常 close 后才发布”“提交后清理如实报告”是实现意图，当前不能当作已成立保障。

§6 把未注入的关闭/发布/清理分支整体视为中等技术债不成立，相关实际错误必须修。下一批按 [D2R＋D3 方案](bm02d3_development_plan.md)：修复节点通过后继续恢复往返，整批统一验收。D2R/D3 尚未实施，D4/CLI/UI/记忆不提前。
