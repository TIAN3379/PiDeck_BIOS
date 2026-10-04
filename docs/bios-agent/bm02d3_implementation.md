# BM-02D3/D4 实施记录与独立验收回写

日期：2026-10-04。工作区 `D:\BIOS_Pi_Agent\PiDeck_BIOS`，分支 `BIOS_Agent`（Windows / Node 24.14.1）。
状态：D3/D4 已实施（§14 实施方自测快照）；[第二十六轮独立验收](round26_acceptance.md) 见 §15（当时的独立结论：正常闭环通过、R26-1～3 未关闭）；**R26-1～3 已在本次实施中红绿收口（§16）**，同批交付 M1 纯决策模块与 M2 有限设计（见 [BM-M1/M2 实施记录](memory_foundation_implementation.md)），**整批仍待统一独立验收**。§2～13 是历史节点，不覆盖最新结论；不重新执行 §6 旧断点。

## 15. 第二十六轮独立验收回写

日期：2026-10-04。本节是独立验收结论，不是 §14 的实施方自测，也不代表修复已经实施。

- 独立 backup＋CLI 218 项全绿；Package 641 项（638 通过、0 失败、3 权限 skip）、旧存储 249 项（246 通过、3 skip）、selfcheck 6、类型/格式及根指定门禁通过。
- 额外合成富库保留 task，15 文件原字节与集合一致；真实 API/CLI 往返和新进程 reader 读取五类记录成立。额外诊断不计入永久测试。
- R26-1：第一次复制 hook 后 manifest 改为 backupVersion=2，现场纯校验拒绝，但恢复仍无警告 restored；初始清单未被重读/指纹复核。
- R26-2：目标集合盘点后，在第二次读备份 registry 的 hook 中合法改写目标 feature，独立 SHA-256 不同，恢复仍无警告 restored；逐文件早期回读和后期预检不足以证明最终原字节一致。
- R26-3：真实 CLI 子进程 `inspect --json --root`、未知选项/命令均退出 2，但 stdout 无 JSON 对象；解析失败输出模式硬编码为 false。
- 正常闭环通过，但上述三项尚未关闭，整批暂未通过，不批准正式资料保护使用。完整证据见 [验收](round26_acceptance.md)。§14 的覆盖声明限于其实际测试，不证明这些遗漏已关闭。
- 下一轮按 [记忆底座加速批次](memory_foundation_development_plan.md)：三项永久红绿收尾→内部门禁→完整 M1 纯记忆模块与演示→M2 兼容方案，一次交回，不停在仅修补丁。保留 schema、底座和历史通过范围。

下文保留原实施时间顺序；当前状态以上述独立结论为准。
依据：[第二十二轮验收](round22_acceptance.md) §3 与 [D2R＋D3 批次方案](bm02d3_development_plan.md)。实施方不自行声明通过。

## 1. 本批进度

| 节点 | 内容 | 状态 |
|---|---|---|
| A：D2R | 关闭 D2-1～D2-4（归属/junction 清理、目标完整集合、生命周期与清理事实、公共错误脱敏） | 已发现整改经第二十五轮收口；见 §12；整批备份恢复仍待 D3 |
| A′：R23-1～3 / R24-1～2 | 等待后身份重验、句柄保护、有界盘点、清理事实与未知子树策略 | R23 经第二十四轮通过；R24 经第二十五轮通过 |
| B：D3 | `restoreKnowledgeBackup`：仅恢复到不存在的新目录、registry 最后非覆盖发布、原字节往返、新进程读取 | **已实施**（§14）：API 与失败/取消/预算/变化/IO 矩阵落地；targeted 207 项全绿 |
| C：D4 | inspect/export/restore 薄 CLI、参数确认、JSON/退出码、取消配对与真实子进程演示 | **已实施**（§14）：`cli/knowledge.mjs` + `cli/knowledgeOutput.mjs`，11 项 CLI 用例；整批待独立验收 |

D1/D1R（协议与纯字节校验）、D2 的正常导出路径与真实双进程竞争**未重做**；B1/B2 与已关闭的 C3/审核/journal 整改未重做。

## 2. 节点 A：D2R 的四组修复

### 2.1 D2-1 目标边界与归属（P1）

`core/storage/backup/target.ts` 从"词法路径 + 无脑删除"重写为**带身份的自有目标会话**：

- 新增 `TargetSession`：根、每个目录、每个文件在 `mkdir`/`open` **成功当下**登记 `dev + ino + 类型`；
- `assertAncestorsOwned` / `stillOwned`：写、读、发布、清理前**逐级复核**祖先链与自身身份。`data/` 被 rename 走并换成 junction 后，身份核对不通过 ⇒ 停手、保留、报告，而不是穿过链接去 unlink 别人的文件；
- `cleanupOwned`：只删**仍证明归我所有**的分支；已不存在的条目按"无内容可清"处理（不计残留），存在但归属不符的**整支跳过**并计入有界残留（最多 5 条样本 + 计数）；不递归删除；
- 目录 `mkdir` 的 `EEXIST` 现在是**冲突**，不再被当作"本次创建"无条件接纳；
- `resolveTargetParent` 改为逐级比对**词法**父链与 `realpath`（`parent-chain-link`），并把结果交调用方：**先按 canonical 判重叠**（保留"词法分离但解析后重叠 ⇒ `backup-target-overlap`"），再拒绝父链链接；
- 清理**不看取消信号**（`checkAncestorsOwned` 与信号解耦）：旧实现里一次取消会让所有清理检查抛 `cancelled`，把本次创建的空目录全留成"无主残留"——这是本轮实跑发现的第二个真缺陷。

### 2.2 D2-2 完整目标集合（P1）

新增 `core/storage/backup/container.ts`：

- `enumerateContainer`：只读、有界（目录/文件数封顶于 D1 预算）、不跟随链接（Windows junction 在 dirent 上同样报告为链接）地枚举容器根与 `data/` 子树，区分文件/目录/链接；
- `assertContainerMatchesManifest`：根条目、目录集合、文件集合与清单**全量且唯一**比对（导出时根必须恰好 `data`，因为完成标记最后发布；恢复时必须是 `data` + `manifest.json`）；差异只回**计数与受控码**，不回显未知条目名；链接一律拒绝；
- **顺序**：容器集合核对放在逐文件回读复核**之后**、发布**之前**——否则"回读前被塞进来的额外文件/删掉的空目录/换成的链接"会落在两次复核之间（首版实现正是这个漏洞，已被永久用例逼出并修掉）；
- 额外文件属于未知归属：失败时**保留**并报告残留，不静默删除。

### 2.3 D2-3 生命周期与清理事实（P2）

- 根/目录/文件**取得即登记**，覆盖等待期间的取消与失败：取得目标后立刻登记，再让取消生效；目标根 mkdir 阶段取消不再留下无主空目录；
- `publishOwnedManifest`：临时文件**创建即登记**，`sync` → `close`（用注入的 `closeFile`，**close 失败必须阻止发布**）→ 复查取消 → 真实 `link` → 提交 → 删临时文件；
- **取消在真实 link 之前必须生效**（hook/等待中的取消不再发布完成标记）；
- 提交后删临时文件失败 ⇒ `published: true` + `cleanup: "failed"` + 残留样本，**不回滚**已完成备份；
- 结构化事实：`StorageError.facts = { phase, published, cleanup, residuals? }`（`errors.ts` 新增可选 `facts`，旧调用者不受影响），成功结果也带 `cleanup` 与 `residuals`；不再把清理结果拼进 message。

### 2.4 D2-4 公共错误脱敏（P2）

新增 `core/storage/backup/failure.ts` 的 `sanitizeBackupFailure`，在**导出公共边界**统一收口（不论是否取得目标、不论清理成败）：

- 类别：保留原受控码；未分类异常一律收敛成 `backup-io-failed`，不透传原始 message/cause；
- 文案：每个码一条**固定**文案（不含路径、条目名、正文），前缀只带受控阶段标签；
- 定位：只保留**白名单格式**的 `detail`（`^[a-z0-9][a-z0-9._=-]{0,39}$`，带空格/斜杠/大小写混杂的会被丢弃）；不再返回 `path`；
- 取消保留 `cancelled` 类别，同时带 `published/cleanup` 事实。

## 3. 旧红 / 新绿证据

旧红来自 [第二十二轮 §3](round22_acceptance.md#3-阻塞发现) 的独立复现（实施方用同一套步骤写成永久用例，旧实现下必红）：

| 组 | 旧实现（红） | 修后（绿） |
|---|---|---|
| D2-1 | 五步复现后 **outside sentinel 被删除**、target 被移除 | sentinel 与顶替上去的 junction 都保留且内容不变；`facts.cleanup="failed"` + 残留可见 |
| D2-1（父链） | `realpath + lstat(canonical)` 发现不了父链 junction | junction 父目录 ⇒ `backup-argument-invalid / parent-chain-link`，且不创建任何输出（"解析后重叠"仍报 `backup-target-overlap`） |
| D2-2 | 额外文件/缺空目录下仍 `exported / published=true / cleanup="ok"` | 两类都 `backup-payload-mismatch`、无完成标记；额外文件**保留**并报告残留 |
| D2-3 | 根 mkdir 取消留空目标；link hook 取消仍发布；link 失败留 `.tmp`；close 失败仍发布；提交后 unlink 失败仍报 `cleanup="ok"` | 逐条按 §2.3 行为断言（含 `published=true/cleanup=failed` 与残留） |
| D2-4 | 原始异常正文（`PRIVATE_CUSTOMER_BODY_123`）与源绝对路径直接透传 | 受控类别 + 固定文案 + `facts`；断言公共错误里不出现敏感标记与沙箱/源绝对路径 |

本轮另外补上方案 §A3 要求、此前缺失的真实 IO 注入：**短写**（每次最多 3 字节，容器字节仍与源逐字节一致）与 **sync 失败**（阻止发布、无完成标记）。

## 4. 受影响文件与行数

| 文件 | 行数 | 变化 |
|---|---:|---|
| `core/storage/backup/target.ts` | 532 | 重写为自有目标会话（身份/祖先/清理/发布）；**超过 400 行目标**，见下方披露 |
| `core/storage/backup/container.ts` | 138 | 新增：容器唯一集合盘点与清单比对 |
| `core/storage/backup/failure.ts` | 66 | 新增：公共失败统一脱敏与结构化事实 |
| `core/storage/backup/export.ts` | 282 | 调整：接入会话/集合核对/事实/脱敏；容器核对后置为最后一道复核 |
| `core/storage/errors.ts` | 301（+22） | 可选 `facts`（`OperationFailureFacts`），旧调用者兼容 |
| `tests/storageBackupTargetSafety.test.mjs` | 563 | 新增：D2-1～D2-4 永久回归 + 短写/sync 注入（21 项） |

**行数披露**：`target.ts` 532 行，超过 400 行目标但**未超 600 行强制拆分门槛**。它现在同时承担"身份/归属与清理"和"建/写/读/发布 IO"两类职责，下一节点应拆成
`ownedTarget.ts`（会话、身份复核、清理）＋ `target.ts`（目录/文件 IO 与发布），本轮不为凑行数删减说明性注释，也没有在上下文已紧张时做高风险搬家。

## 5. 节点 A 门禁（实施方实跑）

```text
node --test（backup 五文件）                                     → 149 项：149 通过、0 失败、0 skip
npm run typecheck / check:format（86 文件）                       → 通过
```

既有 D1/D1R/D2 用例（128 项）全部保留并通过；新增 21 项全部真实执行（junction 用例在本机实际执行，未走 skip）。整批交回前仍需按 [批次方案 §6](bm02d3_development_plan.md#6-门禁与交付) 跑完整门禁（`npm test`、selfcheck、旧存储 targeted、仓库根门禁），这些**尚未在本节点运行**。

<a id="6-断点交接节点-bd3-剩余步骤"></a>

## 6. 断点交接：节点 B（D3）剩余步骤

接续时按 [批次方案 §3～§5](bm02d3_development_plan.md#3-节点-bd3-最小-api-和准入) 实现，复用本节点修正后的窄原语（不要再写一套放宽 IO）：

1. `core/storage/backup/restore.ts` + `backup/index.ts` 窄出口导出 `restoreKnowledgeBackup({ backupRoot, root, offlineConfirmed: true, limits?, preflightLimits?, signal?, ioHooks? })`；
2. 校验参数与限额（显式 root 必须**不存在**、父链按 `resolveTargetParent` + 链接拒绝、与备份容器不重叠）；
3. 备份侧准入：有界读 `manifest.json` → `validateBackupManifest` → `enumerateContainer` + `assertContainerMatchesManifest(..., { manifestPresent: true })` → 逐文件长度/SHA-256（`readBoundedFile` + `measureBackupPayload`）→ `inspectKnowledgeStore({ root: <backup>/data })` 要求 `complete`/`no-migration-needed`/无截断裁剪/无阻断/无人工事项；
4. 排他创建新 root（`acquireTargetRoot`）→ 按 manifest 建全部已知空目录 + **空** `cache`/`locks` → 除 registry 外逐文件复制并回读核对（`writeOwnedFile` + `readOwnedFileBounded`）；
5. 重新核对备份容器集合/内容/准入 → **registry 最后非覆盖发布**（`publishOwnedManifest`）= D3 完成点；发布后再用预检确认新库可解释，未通过则返回 `committed-needs-review` 类状态而非"未写入"；
6. 失败/取消按归属清理（复用 `cleanupOwned`），未知/替换分支保留并结构化报告；成功结果与失败 `facts` 均复用本节点的结构化字段；
7. 新增 `tests/storageBackupRestore*.test.mjs`：最小与富库往返（五类记录 + v1/v2 journal + 意图/事件 + 已知空目录）、字节保真（中文/缩进/CRLF/尾空格）、**真实新进程**用现有 reader 读取、非覆盖/重叠/链接拒绝、双进程同目标竞争、备份拒绝（无/坏/未来 manifest、额外条目、缺文件、错长度/hash、坏 JSON）、预算 0/精确/差一、预检截断/裁剪、恢复中备份变化、IO/完成点/取消故障、只读与兼容；
8. 跑整批门禁（backup targeted + `npm test` + selfcheck + 旧存储 records/registry/preflight targeted + 仓库根 typecheck/check:format/processGuards/`git diff --check`），追加 `bm02d2_implementation.md` 的 D2R 节（本文可作依据），并同步导航/MVP/task/test/log/Package 为 **"D2R＋D3 已实施，待统一独立验收"**。

**历史同步说明**：初次节点交付将状态同步留到整批，因此导航曾落后；第二十三/二十四轮已同步实际部分进度。继续开发时按真实完成项更新，不能把“尚未实现”长期保留，也不能把只完成修复标成整批完成。

## 8. 第二十三轮三处遗漏的修复（R23-1～3）

依据 [第二十三轮验收](round23_acceptance.md) §4 与 [方案 §8.1](bm02d3_development_plan.md#81-节点-a-的剩余修复)；D2-1/D2-3 的原复现已通过，这里补的是同一职责上的三处遗漏。旧红为第二十三轮 §4 的独立复现（等待窗口写穿 junction、读关闭失败仍发布、登记失败漏关句柄、1005 条全量装载）。

**R23-1 等待后的身份重验**：`target.ts` 里所有受控等待（`beforeIo` hook）之后、**真实 IO 发起之前**都重查一次取消与祖先身份：`writeOwnedFile`、`createOwnedDirectory`（mkdir 前）、`publishOwnedManifest`（建临时文件前、`link` 前）。文件身份改以**已取得句柄的 `fstat`** 为准，并与路径 `lstat` 交叉核对（`acceptCreatedFile`）：两者不是同一对象即拒绝登记（`replaced-after-create`）。`readBoundedFile` 支持传入期望身份，读前用句柄 `fstat` 核对；提交后删临时文件前先确认它仍归本次调用所有，被替换则保留并计为残留。**不宣称消除 TOCTOU**：仍保留"最后一次检查与系统调用之间"的竞态限制。

**R23-2 句柄生命周期**：`readBoundedFile` 不再在 `try` 内提前 `return`（旧实现在正常路径先返回结果，`finally` 记下的关闭失败永远不被检查），改为缓存结果、**读与正常关闭都成功**才返回；异常路径关闭失败不覆盖首错。`writeOwnedFile`/`publishOwnedManifest` 把身份登记放进关闭保护内，登记失败（含 lstat 不可核对）也会显式关掉句柄；lstat 的原始 fs 错误在登记处收敛成受控 `permission-denied`。

**R23-3 有界逐项容器盘点**：`container.ts` 改用 `opendir` 逐项观察（不再 `readdir` 整目录 + `map` 全量），**每观察一条即计费**，超预算立刻停手；根只允许固定条目（未知根条目立即失败、不递归未知子树），链接与非常规类型立即失败；目录句柄由 `for await` 的 `return()` 与 `finally` 的 `close()` 双重保证关闭。**预算口径（对外披露）**：允许观察 = payload 文件上限 `maxFiles` ＋ payload 目录上限 `maxDirectories` ＋ 固定容器根条目 2 ＋ 一次超限探测 1；根/data 容器元目录不计入 payload 目录口径，`maxFiles`/`maxDirectories` 仍与 D1 清单限额同源。

**回归纪律修正**：junction 用例不再以"实现成功（`error === undefined`）"作为 skip 条件，只在**真实 junction 创建抛已知权限错误**时 skip；注入可用却错误成功必须红。

**新增/更新永久回归**（`tests/storageBackupTargetSafety.test.mjs` 21 → 28 项）：R23-1 写穿 junction（断言 outside 无新文件、sentinel 不变、replacement 保留、`backup-target-exists`、无 manifest）；R23-2 三条（仅目标 r 句柄关闭失败、仅 manifest 临时句柄关闭失败、登记 lstat 失败，均断言不发布、`facts.published=false`、**活动句柄 0**）；R23-3 有界扫描（`maxFiles=8/maxDirectories=8` + 目标 data 注入 1000 个未知文件，真实 `opendir` 只计数目标侧 name 读取，断言 ≤25 次观察且未知文件保留）。子进程注入仍是窄包装（`open` 代理、`lstat` 定路径、`opendir` 计数），结束显式 close 全部句柄。

**实跑（实施方，本节点全部真实执行，无 skip）**：

```text
node --test（backup 五文件）         → 156 项：156 通过、0 失败、0 skip
npm run typecheck / check:format（86 文件）→ 通过
```

### 8.2 接续 D3 的补充约束（来自方案 §8.2）

1. **备份侧只读边界**要自己负责常规类型/祖先/根链接/身份与变化核对，不能拿"自有写入会话"的检查冒充——D3 的容器读取需补链接/类型/链检查；
2. `publishOwnedManifest` 现在已含 R23-1/R23-2 修正，可直接用于 registry 原字节最后发布；仍**不得**在新根写 backup manifest、也不得先 `initialize` 空 registry；
3. 恢复目标的集合是**知识库布局**（另加空 `cache`/`locks`），不是 `manifest`+`data` 容器形状：复用有界列举原语但要另写目标集合对照。

### 8.3 R24-1/2 修复（实施方记录，D3 未开始）

依据 [第二十四轮验收](round24_acceptance.md) §4 与 [方案 §9.1](bm02d3_development_plan.md#91-两处窄修与内部验证)。

**R24-1 清理「不可核对」不等于「不存在」**：`target.ts` 的 `pathExists` 与 `targetExists` 改为**只有 `ENOENT` 才返回 false**；`EACCES/EIO` 一律抛受控 `permission-denied`。`cleanupOwned` 里该抛出落在逐条 catch 内 ⇒ 该条**不删、不计 removed**，保留 `owned` 并在磁盘上原样留下现场，`cleanup="failed"` + 有界残留；主错误类别与 `published` 完全不受影响（首错不被掩盖）。

**R24-2 未知 data 子树入队前拒绝**：`container.ts` 的 `enumerateContainer` 新增可选 `declared`（已校验清单的目录/文件集合）。观察到目录时**先判定是否声明**，未声明立即 `backup-payload-mismatch/container-undeclared-directory` 并停手，**不 opendir 该子树**；文件同理（`container-undeclared-file`）。`export.ts` 传入 `validated.manifest` 的集合。合法空目录（projects/audit/journal 等）与全局扫描预算语义不变。

**测试纪律**：junction 对照只在**已知权限/平台码**（EPERM/EACCES/ENOSYS/ENOTSUP/EINVAL/UNKNOWN）时 skip，其它异常直接失败。

**新增永久回归**（`storageBackupTargetSafety.test.mjs` 28 → 32 项）：R24-1 两条（目标路径 lstat EACCES ⇒ 主错误类别保留、`cleanup=failed`、残留 ≥1、磁盘上目标与 registry 仍在；真实 ENOENT 对照 ⇒ `cleanup="ok"` 且目标清干净）；R24-2 一条（真实 `data/unknown/nested/private.txt`，断言真实 opendir 记录里**不出现**该子树、无 manifest、未知内容保留）。

**实跑（实施方）**：`node --test`（backup 五文件）= **160 项：160 通过、0 失败、0 skip**；`npm run typecheck` / `check:format`（86 文件）通过。

**仍未开始（本批交付的剩余全部）**：D3 `restoreKnowledgeBackup`——只读备份容器边界与准入（根/祖先/最终文件的类型与链接检查、有界 manifest 原字节读取、纯协议校验、完整集合、长度/hash、业务/工件预检）、仅写不存在的新知识根（排他取得、canonical 重叠/父链拒绝）、按清单建已知目录 + 空 `cache`/`locks`、非 registry 逐文件复制回读、**registry 原字节最后非覆盖发布**为完成点、失败/取消按归属清理与提交后事实报告、原字节往返与**真实新进程 reader** 验证，以及 §5/§9.2 的拒绝/双进程/预算/变化/IO/取消矩阵。断点与顺序见 §6 与 §8.2。

## 11. 第二十五轮/D3＋D4 批次的断点（本轮只交付红例）

本轮上下文预算在完成 R24-1/R24-2 后已到临界，按 [方案 §11.4](bm02d3_development_plan.md#114-减少返工与文档负担)「保存红例、触达文件、最后命令与下一具体步骤」交接，**D3 未实现、D4 未开始**。

**已保存的红例**：新增 `tests/storageBackupRestore.test.mjs`（3 项，全部因 `restoreKnowledgeBackup 尚未实现（本批第一项交付）` 而红）——
① 最小库「导出 → 恢复到不存在的新根 → registry/记录字节一致 + 空 cache/locks」；
② 真实新进程用现有 `readRegistry`/`readRecord` 读取恢复后的库；
③ 目标已存在（含空目录）必须 `backup-target-exists` 拒绝。
`restoreKnowledgeBackup` 通过 `tests` 里的 `storage.restoreKnowledgeBackup` 间接取引用，缺 API 时给的是这条明确断言（不是模块加载错误）。

**最后门禁（本轮实跑）**：backup 五文件 **160 项：160 通过、0 失败、0 skip**；`npm run typecheck` / `check:format`（86 文件）通过；**新增的 `storageBackupRestore.test.mjs` 3 项为已知红**，`npm test` 因此不再是全绿（这是本批预期状态，不是回归）。

**下一具体步骤（按方案 §10.1/§11.1，从代码接续，不重做 R23/R24）**：
1. 新增 `core/storage/backup/restore.ts`：只读备份准入（有界读原始 `manifest.json` → `validateBackupManifest` → `enumerateContainer(...)` **显式传入已验证清单集合** + `assertContainerMatchesManifest({ manifestPresent: true })` → 逐文件长度/SHA-256 → `inspectKnowledgeStore({ root: <backup>/data })` 要求 `complete`/`no-migration-needed`/无截断裁剪/无阻断/无人工事项）；
2. 复用 `target.ts` 的自有目标会话：`resolveTargetParent` + 父链/重叠拒绝 → `acquireTargetRoot` → 按清单建全部已知目录 + 空 `cache`/`locks`；
3. 非 registry 逐文件复制 + 回读核对（`writeOwnedFile`/`readOwnedFileBounded`），复核备份集合与准入后**原 registry 原字节最后非覆盖发布**（`publishOwnedManifest`）= 完成点；失败/取消按 `cleanupOwned` 清理，提交后只报「已提交/需复核/残留」；
4. 目标集合是**知识库布局**（不是 manifest/data 容器）：另写目标集合对照，不直接套用容器包装；
5. 让上述 3 项红例转绿，再按 §5/§10.2 补拒绝/双进程/预算/变化/IO/取消矩阵与富库往返；随后按 §11.2 接 D4 薄 CLI（`cli/knowledge.mjs`：`--help`/`inspect`/`export`/`restore`，显式绝对路径、离线＋写入确认、JSON/退出码 0/1/2/3、SIGINT 清理），最后跑整批门禁并同步状态。

**维护项**：`target.ts` 约 596 行、`storageBackupTargetSafety.test.mjs` 约 859 行（均超 400/600 目标）。按方案 §10.1，窄拆属于 D3 实现的一部分（归属/生命周期/盘点与窄注入 helper 分开），本轮未做，避免在无验证余量时搬家。

## 9. 未测与边界（本节点）

- 未开始 D3（恢复）；未做 D4 CLI、UI/Pi 工具、记忆/RAG、ZIP/加密/网络/增量备份、在线快照或通用事务；未升任何 schema/协议版本；未改 PiRuntime/Electron；未读真实客户库或客户源码。
- 未在本节点运行 `npm test`（整批门禁留到节点 B 完成后统一跑）；未跑旧存储 targeted 与仓库根门禁。
- 身份核对用的是 `dev+ino+类型`（可验证元信息），**不宣称** OS 沙箱或消除 TOCTOU；仍承诺 offline-copy ＋ 观察式变化检测的边界。
- 未测：真实 ACL、网络盘、断电、其它 OS、远端 CI、生产安装包、真实 BIOS/硬件；文件型 symlink 权限不足时相关对照仍显式 skip（本节点 junction 对照实际执行）。
- 保留 dirty tree、未跟踪文件与六项既有历史文档删除；未 add/commit/push。

## 10. 第二十三轮独立验收回写（历史）

[验收报告](round23_acceptance.md)：独立补跑 backup 149 项全绿、Package 572 项（569 通过、0 失败、3 skip）、旧读取 100 项（98 通过、2 skip）、包/根指定门禁通过。原清理、集合、取消、发布关闭/残留、脱敏复现改善；D3 仍没有代码或恢复测试，整批未完成。

额外实验发现 R23-1～3：backup-write 等待期间 data 换 junction 后 outside/registry 被创建，后置复核才失败；目标 r 句柄 close 报 EIO 被 try 内 return 吞掉；wx open 后登记 lstat 失败留 1 个活动句柄；maxFiles=1 的容器盘点先取得/map 1,005 个真实条目才判超限。§2 中“写/读/发布前核对”“有界列举”“close 失败阻止继续”不能作为所有分支已成立的保证。

只按 [批次方案 §8](bm02d3_development_plan.md#8-第二十三轮接续先补三处遗漏再完成-d3)补遗漏，然后同一对话继续 D3。§6 的步骤继续作为断点，但只读容器链接边界、目标新布局集合和修正后的发布原语必须明确。§6 原“状态同步留到整批”的做法不能让导航长期显示尚未实施；本轮已同步实际部分进度，未标整批完成。

## 11. 第二十四轮独立验收回写（历史）

[验收报告](round24_acceptance.md)：独立复跑 backup 156 项全绿、Package 579 项（576 通过、0 失败、3 skip）、旧读取 100 项（98 通过、2 skip）、包类型/selfcheck 6/格式 86、根类型/格式 2014/processGuards 2/diff 检查通过。R23 原复现通过，并独立补测 mkdir 等待替换、manifest 登记失败/同名 tmp 替换、容器目录关闭故障和取消；D3 仍无 API 或恢复测试。

R24-1：目标回读失败后，清理 lstat 注入 EACCES，实际 target/data/registry 仍在，却 cleanup=ok/residuals=[]；catch-all 存在性检查必须区分不可核对与缺失。R24-2：实际 data/unknown/nested 被 opendir 后才报集合不符；流式预算修复成立，但未知 data 子树立即拒绝尚未实现。

按 [方案 §9](bm02d3_development_plan.md#9-第二十四轮接续完成-d3-而不再只交补丁)窄修后同一对话完成 D3，不再将节点修复当整批终点。§4/§5 为首次节点历史数字；当前 target.ts 588 行、安全测试 755 行，按触达评估拆分，不削弱永久回归。未做正式客户/硬件/安装包验证，未提交推送。

## 12. 第二十五轮独立验收回写（当前）

[验收报告](round25_acceptance.md)：R24-1/2 在声明范围通过，已发现 D2R 整改收口；D3 仍无 API/恢复模块/恢复测试。独立 backup 160 项全绿、Package 583 项（580 通过、0 失败、3 skip）、旧读取 100 项（98 通过、2 skip）；包类型/selfcheck 6/格式 86、根类型/格式 2014/processGuards 2/diff 检查通过。这些独立补跑不改写为 §9 实施方自测。

额外独立验证最小导出精确预算/原字节/hash、清理全链 EACCES/单路径 EIO/真实 ENOENT、未知子树实际 opendir 记录、未知文件拒绝，以及 targetExists 的分类对照，全部符合预期。源 registry 保持；不可核对和未知内容保留、cleanup=failed、有界残留、首错与未发布事实正确。没有新的阻塞发现；单路径 EIO 在 D3 故障组补永久用例，不单开整改。

当前 target.ts 596 行、安全测试 859 行，恢复实现时窄拆职责并保留回归。当时下一任务为 [方案 §10](bm02d3_development_plan.md#d3-restore-next)：新增恢复 API、最小/富库原字节往返、真实新进程 reader，完成原 §5 矩阵和整批门禁。只修 R24 不能标整批完成。未改运行代码、未读真实客户库、未验证安装包/硬件、未提交推送。之后用户扩大批次范围，见 §13。

## 13. 用户要求加快交付后的接续（计划变更，非实施证据）

当前以 [方案 §11](bm02d3_development_plan.md#accelerated-delivery)为准：沿 §6 实现 D3，内部门禁通过后，同一批追加 D4 的 inspect/export/restore 薄 CLI、显式确认、JSON/退出码、取消和真实子进程演示，再整批独立验收。旧“本批不做 D4”不再执行，其余安全边界保持。

本节只记录用户授权的任务合并，**不证明 D3/D4 已实现**。下一开发方沿本文追加实际实施与测试记录，不重做 R23/R24、不另建每个小问题的计划文档。上下文不足保存当前红例、触达代码、最后门禁和下一具体步骤。

## 14. D3＋D4 实施记录（本次交付，待统一独立验收）

日期：2026-10-04。工作区 `D:\BIOS_Pi_Agent\PiDeck_BIOS`，分支 `BIOS_Agent`（Windows / Node 24.14.1）。
状态：**D3 恢复 API 与 D4 薄 CLI 均已实施并通过本次内部 targeted/类型/格式/包内全量门禁；整批仍待独立验收**。
依据：[批次方案 §11](bm02d3_development_plan.md#accelerated-delivery)（取代旧“本批不做 D4”）、[第二十五轮验收](round25_acceptance.md) §4、本文 §6/§8.2 断点。未重做 R23/R24、B1/B2、C3/审核/journal 任何已关闭整改。

### 14.1 实际 API 与完成点

新增窄出口（经 `core/storage/backup/index.ts` 再经 `core/storage/index.ts` 对外）：

```ts
restoreKnowledgeBackup({ backupRoot, root, offlineConfirmed: true, limits?, preflightLimits?, signal?, ioHooks? })
	→ { status: "restored" | "committed-needs-review", root, backupRoot, backupId,
	    files, directories, totalBytes, published: true, cleanup: "ok" | "failed",
	    residuals: string[]（≤5 条受控相对路径）, reviewReasons: RestoreReviewReason[] }
```

`RestoreReviewReason` 是固定枚举：`cleanup-failed` / `verify-restored-failed` / `verify-restored-error` / `cancelled-after-publish`。

执行顺序（每一步都有对应失败/取消事实）：

| 阶段（`facts.phase`） | 内容 |
|---|---|
| `argument` | 限额、`offlineConfirmed:true`、两侧完全限定路径；解析备份容器与恢复目标的**父链**；先 canonical 重叠判定、再拒父链链接；备份容器必须是常规目录（拒链接） |
| `admission` | 有界读 `manifest.json` → `JSON.parse` → `validateBackupManifest`；`enumerateContainer`（**显式传入已验证清单集合**）+ `assertContainerMatchesManifest(manifestPresent:true)`；逐文件长度/SHA-256；`inspectKnowledgeStore({root:<备份根>/data})` 要求完整/无需迁移/无截断裁剪/无阻断/无人工事项 |
| `acquire-target` | `mkdir` 非递归排他取得新根；已存在（空目录、旧库、半成品、文件或链接）即 `backup-target-exists` |
| `copy` | 按清单深度升序建目录 + 另建**空** `cache`/`locks`；除 registry 外逐文件复制（`writeOwnedFile`）并**回读核对**（`readOwnedFileBounded`） |
| `verify-container` | 目标实际集合与清单派生布局**全量相等**（目标是**知识库布局**，不是容器形状；另有 `restoreTarget.ts` 判据） |
| `recheck-source` | 重跑容器集合、逐文件长度/hash 与业务准入——等长改写/增删/增长都会被发现 |
| `publish` | **原 registry 字节最后非覆盖发布**（`publishOwnedManifest`）= **D3 完成点** |
| `verify-restored` | 用现有 `inspectKnowledgeStore` 复核新库可解释；失败/取消只报 `committed-needs-review`，**不删除已恢复的库** |

`published` 只在 `link` 成功后为 `true`；提交点之前的失败/取消按归属 `cleanupOwned` 清理并复用 D2R 的脱敏收口（`sanitizeBackupFailure(error, "restore", facts)`）。**未**在新根写 backup manifest，**未**先 `initialize` 空 registry，**未**迁移 BIOS 源码或重写 registry 的旧工作区绝对路径。

### 14.2 D4 实际命令契约（`cli/knowledge.mjs`，`npm run knowledge`）

| 命令 | 行为 |
|---|---|
| `--help` / 无参数 | 只读帮助（命令、参数、确认项、退出码与局限）；不读知识库、不创建文件，退出 0 |
| `inspect --root <绝对路径> [--json]` | 现有只读预检；输出结论/数量/截断/版本分布与人工事项计数，**不含业务正文** |
| `export --root <源绝对根> --backup-root <新绝对目录> --offline-confirmed --confirm-write [--json]` | 现有导出；保留非覆盖、限额与清理事实 |
| `restore --backup-root <绝对备份根> --root <新绝对知识根> --offline-confirmed --confirm-write [--json]` | 新恢复；registry 最后发布、`cache`/`locks` 为空、不改旧 BIOS 绑定 |

- 三个命令**只**接受显式绝对路径；相对路径、未知/重复/缺值/不适用参数、缺任一项写确认都在调用 API 前受控拒绝（退出码 2）。
- `--json` 时 stdout **只**一个结果对象，诊断走 stderr；错误对象只带 `code`/受控 `detail`/`phase`/`published`/`cleanup`/`residuals`，不含 stack、原始异常正文、业务正文或未知条目名。
- 退出码：`0` 成功无问题；`2` 命令/参数错误；`1` 拒绝/取消/预检不完整；`3` **已发布/已提交**但存在残留或需复核。
- SIGINT → `AbortController` 传到 API，等待已有清理完成再结束，不 `process.exit()` 打断收尾；`SIGINT` listener 在 `finally` 配对移除。
- 拆分：输出契约与退出码映射（纯函数）在 `cli/knowledgeOutput.mjs`，入口只做解析与编排——CLI **不是**第二套存储实现，判据全在 `core/storage`。

### 14.3 红绿证据

| 红（上一轮保存） | 绿（本次） |
|---|---|
| `tests/storageBackupRestore.test.mjs` 3 项因“`restoreKnowledgeBackup 尚未实现`”失败 | 3 项转绿（最小闭环 / 真实新进程 reader / 目标已存在拒绝）；原红例已扩展为成功往返组 |
| 红例 ② 的读取脚本按 `read.id` + `read.record.*` 写错形状（读 `record.record` 之外的字段） | 修正为**现有 reader 的真实返回形状**（`readRecord → { kind, id, record, path, bytes }`）；这是测试自身断言错误，不是产品字段改动 |

未新增“为了通过而放宽断言”的写法；新增用例全部真实执行（junction 对照在本机实际执行，本机零 skip）。

### 14.4 测试数字（实施方实跑，全部为本次修改后）

```text
node --test tests/storageBackup*.test.mjs            → 207 项：207 通过、0 失败、0 skip
   （既有 160 项全部保留；D3 新增 47 项 = 成功往返13 + 失败/预算/变化/IO/取消/只读34）
node --test tests/knowledgeCli.test.mjs              → 11 项：11 通过、0 失败、0 skip
npm test（Package 全部用例）                          → 641 项：638 通过、0 失败、3 显式 skip
旧存储 targeted（records/registry/preflight/journal/reviewWriter/write）
                                                     → 249 项：246 通过、0 失败、3 显式 skip
npm run typecheck / check:format（96 文件）           → 通过
npm run selfcheck                                    → 6 项通过
仓库根 typecheck / check:format（2014 文件）          → 通过
仓库根 tests/processGuards.test.mjs / git diff --check → 2 项通过 / 通过
```

641 = 上轮 583 + 58（D3 47 + D4 11）。3 个 skip 仍是本机文件型 symlink 权限所限（junction 本机可用并实际执行）。D3 用例覆盖：最小/富库原字节往返、五类记录 + 普通 v1/审核 v2 journal + 意图/事件 + 已知空目录、中文/缩进/CRLF/尾空格逐字节、真实新进程用 `readRegistry`/`readRecord`/`inspectKnowledgeStore` 读取、非覆盖与 canonical/父链链接拒绝、真实双进程同目标竞争、备份拒绝（无/坏/未来/未知字段 manifest、额外根/data 条目、缺文件、缺空目录、错长度、错 hash、容器链接、坏 JSON 与未来业务版本“重配 hash 后仍拒绝”）、预算 0/精确/差一、预检截断/摘要裁剪、复制期间增删/等长改写/增长、短写/sync/link 失败、句柄关闭失败、清理 lstat 不可核对（单路径 EIO 永久用例）、取得后/发布前/发布后取消与提交事实、成功与失败前后源库与备份字节及集合不变。

### 14.5 可复现端到端演示（实际输出）

步骤与结果（合成富库用现有写入/审核 API 生成；沙箱在系统临时目录并清理）：

```text
inspect --root <store> --json
→ {"command":"inspect","status":"ok","outcome":"no-migration-needed","complete":true,"truncatedBy":[],
   "scannedEntries":26,"readFiles":14,"readBytes":8769,"blockingProblems":0,"problems":0,"manualItems":0,
   "versions":[audit-event@1×1, audit-intent@1×1, journal@1×6, journal@2×1, record@1×4, registry@1×1]}  退出 0

export  --root <store> --backup-root <backup> --offline-confirmed --confirm-write --json
→ {"status":"exported","published":true,"files":14,"directories":10,"totalBytes":8769,"cleanup":"ok","residuals":[]}  退出 0

restore --backup-root <backup> --root <restored> --offline-confirmed --confirm-write --json
→ {"status":"restored","published":true,"files":14,"directories":12,"totalBytes":8769,"cleanup":"ok",
   "residuals":[],"reviewReasons":[]}  退出 0

独立核对（fs/crypto 重算，不借助实现字段）：14 个文件逐字节不一致 0 个
目标目录：audit cache experiences features journal locks projects registry.json；cache 空=true locks 空=true
真实新进程 reader：{"schemaVersion":1,"recordId":"exp-a","revision":1,"problem":"PXE 默认开启"}
```

### 14.6 受影响文件与行数

| 文件 | 行数 | 变化 |
|---|---:|---|
| `core/storage/backup/restore.ts` | 240 | 新增：恢复入口（参数/准入/排他取得/复制/复核/发布/提交后事实） |
| `core/storage/backup/restoreSource.ts` | 115 | 新增：只读备份准入（完成标记、容器集合、逐文件字节、业务/工件预检） |
| `core/storage/backup/restoreTarget.ts` | 109 | 新增：**知识库布局**的期望集合与目标盘点/比对 |
| `core/storage/backup/pathCompare.ts` | 41 | 新增：导出/恢复共用的路径段比较与重叠拒绝（`export.ts` 改为复用） |
| `core/storage/backup/container.ts` | 174 | 调整：导出可复用的逐项有界目录枚举 `forEachDirectoryEntry`（行为不变） |
| `core/storage/backup/contract.ts` | — | 调整：容器形状常量 `BACKUP_DATA_DIR_NAME` / `BACKUP_MANIFEST_FILE_NAME` 移入契约层 |
| `core/storage/backup/export.ts` | 264 | 调整：改用 `pathCompare` 的重叠判定；常量改从契约层引入 |
| `core/storage/backup/index.ts` | — | 调整：窄出口新增恢复 API 与容器常量 |
| `cli/knowledge.mjs` | 258 | 新增：参数解析与三个命令编排 |
| `cli/knowledgeOutput.mjs` | 203 | 新增：帮助文本、退出码映射与有界结果对象（纯函数） |
| `tests/storageBackupRestore.test.mjs` | 398 | 扩展：成功往返（含双进程竞争与路径/链接拒绝） |
| `tests/storageBackupRestoreFailure.test.mjs` | 582 | 新增：拒绝/预算/变化/IO/取消/只读矩阵 |
| `tests/knowledgeCli.test.mjs` | 327 | 新增：参数/退出码/端到端/SIGINT/与 API 同源 |
| `tests/helpers/restoreFixtures.mjs` | 207 | 新增：合成库 fixture、独立 walk/snapshot 与容器复核 |

**维护项披露**：`target.ts` 596 行与 `storageBackupTargetSafety.test.mjs` 859 行仍超 400/600 目标，本轮按方案 §10.1 已把恢复相关职责拆到三个新文件 + 契约模块，未继续塞入既有文件；两个测试文件 582/327 行为按组组织的矩阵用例，未再拆分。未在无验证余量时搬家。

### 14.7 未测与边界（本次）

- 未验证：真实 ACL、网络盘、断电、其它 OS、远端 CI、生产安装包、真实客户 BIOS/硬件；**registry 里旧工作区绝对路径原样保留**，未证明原路径在本机仍在线（后续 BM-03 人工确认）。
- 只承诺 offline-copy 与可验证发布点：不承诺在线原子快照、同机恶意写入者隔离、消除 TOCTOU；无签名的 hash 只证明“字节与清单一致”，不证明来源可信（首版不引入认证系统）。
- D4 **未**提供：默认用户库回退、交互式确认、删除/初始化/任意记录写入/审核命令、无限制开关；SIGINT 用例断言的是“退出、无 `.tmp` 半成品、已发布 registry 完整”这条不变量，不承诺打断落在任意时刻都得到同一退出码。
- 未做 UI/Pi 工具/记忆/RAG/自动学习；未升任何 schema/协议版本；未改 PiRuntime/Electron；未读真实客户库或客户源码。
- 保留 dirty tree、未跟踪文件与六项既有历史文档删除；未 add/commit/push。低风险未承诺平台能力继续登记技术债；数据误删/覆盖、泄漏、路径逃逸、虚假成功、预算失效与取消损坏在本批均为已关闭项（有永久用例兜底）。

## 16. 第二十六轮 R26-1～3 的红绿回写（本次实施，收口 §15 的三项发现）

[验收报告](round26_acceptance.md)：D3/D4 主体与正常往返成立（独立 backup+CLI **218 项**全绿、Package **641 项**、旧读取 249 项与包/根指定门禁通过），但额外独立诊断发现两项**虚假无警告恢复成功**与一项 CLI 输出契约缺口，编号 R26-1～3。下面是本轮修复事实；详细设计与新模块见 [BM-M1/M2 实施记录](memory_foundation_implementation.md)。

| 项目 | 旧红（第二十六轮 §4 独立复现） | 修后（绿） |
|---|---|---|
| R26-1（P1） | 复制期间把备份完成标记 `backupVersion` 1→2，其余 payload 不动 —— 仍 `restored/published=true/cleanup=ok` | 准入保留**原始字节指纹**；`recheck-source` 第一步有界重读并逐字节比较，差异一律 `backup-source-changed`、`published=false`。永久回归覆盖未来版本、**合法等长改写**、删除、**换成另一份同形状合法清单**、静态原字节基线、完成标记换成链接 |
| R26-2（P1） | 源复核期间把目标 `features/feat-1.json` 改成仍合法的 JSON —— 仍 `restored/published=true` | 新增 `verifyTargetAgainstManifest`（集合+归属+逐文件长度/hash）：**完成点前**（`phase=verify-target`）拒绝发布；**发布后**再复核一次，漂移只报 `committed-needs-review`（新固定枚举 `verify-restored-drift`）、`published=true`、库保留。永久回归覆盖目标改写/多文件/缺文件与发布后 registry 改写；另有**真实 CLI 子进程**预加载注入证明退出码 **3** |
| R26-3（P2） | `inspect --json --root` 等三种参数退出 2 但 stdout 为空 | `jsonRequested` 按取值规则做**保守** JSON 意图识别（`--root --json` 不算请求 JSON）；解析失败也输出一个受控 `usage-error` 对象；未知参数/命令正文有界省略。永久回归覆盖缺值/未知/重复/不适用/未知命令、`--json` 前后位置、被取值选项消费的情形、无 JSON 时 stdout 为空与**零写入** |

**本轮实跑（实施方，修改后）**：backup 七文件＋CLI **235 项（234 通过、0 失败、1 显式 skip）**、Package **680 项（676 通过、0 失败、4 显式 skip）**、旧存储 targeted 249 项（246 通过、3 skip）、typecheck/check:format/selfcheck 与仓库根门禁通过。R26 之外还同批交付了 M1 纯决策模块（见新实施记录），本文件 §14 的 D3/D4 结论与未测边界保持不变。

## 17. 第二十七轮独立验收：R26-1～3 关闭

独立 Package 680 项（676 通过、0 失败、4 文件型 symlink 权限 skip）；backup＋CLI＋memory targeted 257 项（256 通过、1 skip）、旧存储 249 项及指定包/根门禁通过。目录 junction 对照实际执行。

额外独立合成库：正常 15 文件/9340 字节原字节往返，五类新进程 reader 可读；首写时源 manifest 变化拒绝于 recheck-source，目标合法晚期变化拒绝于 verify-target，均 published=false、cleanup ok/无残留；发布后 registry 变化返回 committed-needs-review/verify-restored-drift 并保留已发布库。三类真实 CLI JSON 参数错误 exit 2 单对象；targeted 内真实发布后漂移子进程 exit 3 通过。

R26-1～3 关闭，D3/D4 通过约定的本机离线范围。有限观察复核不消除 TOCTOU，不等于生产资料保护认证或断电实验。M1 新诊断独立列为 R27-1～3，不回滚已通过 D3/D4；下一批为 M1 有限收尾＋完整 BM-03，见 round27_acceptance.md 与 bm03_development_plan.md。本文历史实施数字保留，本轮未修运行代码或提交推送。
