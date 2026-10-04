# BM-M1/M2 实施记录：R26 三项收尾＋记忆决策模块＋兼容方案

日期：2026-10-04。工作区 `D:\BIOS_Pi_Agent\PiDeck_BIOS`，分支 `BIOS_Agent`（Windows / Node 24.14.1）。
状态：**第二十九轮独立验收完成**：R26-1～3/D3/D4/R27-1/3 已通过范围保持；M1 29 项既有测试通过，R28-3 原核心场景通过但范围/授权剩余项归 R29-4，未完整关闭。BM-04 正常业务已交付、整批待 R29；M2 仅认可 v1，正式格式升级/迁移未批准。最新见 §12 与 [验收](round29_acceptance.md)，前文保留历史快照。
依据：[第二十六轮验收](round26_acceptance.md)、[记忆底座批次方案](memory_foundation_development_plan.md)、[分层记忆与时态设计](layered_memory_temporal_design.md)。未重做 R23/R24 与历史审核/journal/存储整改。

## 1. 节点 A：R26-1～3 的红绿

### 1.1 R26-1（P1）源完成标记变化未参与复核

**旧红（第二十六轮 §4 的复现）**：富库正常导出后，在恢复第一次 `beforeIo("backup-write", …)` 时把备份 `manifest.json` 的 `backupVersion` 从 1 改成 2，其余 payload 不动 —— 恢复仍返回 `restored / published=true / cleanup=ok / reviewReasons=[]`。

**原因**：准入只读取一次完成标记；`recheck-source` 用**内存里的旧清单**重新检查容器集合与 payload，从不重读完成标记原字节，因此"换成另一份合法清单/未来版本/删掉完成标记"全都不可见。

**修后（绿）**：

- `restoreSource.ts` 新增 `readBackupManifestWithFingerprint`：读完成标记前先 `lstat` 判**常规文件**（链接/非常规类型即 `manifest-not-regular-file`），再做有界读取，返回 `{ manifest, fingerprint, byteLength }`——保留**原始字节指纹**而不是只留解析后的对象；
- 新增 `assertBackupManifestUnchanged`：完成点之前**有界重读**同一路径，与准入指纹逐字节比较；任何差异（合法等长改写、未来版本、删除、替换成另一份合法清单）都收敛成受控 `backup-source-changed`（`manifest-changed` / `manifest-unreadable`），取消原样穿透；
- `restore.ts` 在 `recheck-source` **第一步**就做这项复核（放在容器/payload 复核之前）：完成标记是"这是同一份备份"的锚点，后面逐文件核对在"换了一份同形状清单"时仍会看起来通过。

**永久回归**（`storageBackupRestoreFailure.test.mjs` §6）：未来版本、**合法等长改写**（换一个仍合法的 `backupId`，并断言文件字节数不变，避免用例退化成"只比长度"）、直接删除完成标记、**换成另一份同形状不同 backupId 的合法清单**（容器集合完全一致，只有指纹能发现）→ 全部 `backup-source-changed` + `published=false` + 目标无 registry + 备份其余字节不变；静态合法原字节照常恢复成功（基线）；完成标记被换成文件型链接 → `backup-payload-mismatch`（本机无权限创建时按已知权限码显式 skip）。

### 1.2 R26-2（P1）目标晚期合法改写仍返回原字节恢复成功

**旧红**：目标非 registry 文件复制与集合盘点完成后，在源复核阶段把目标 `features/feat-1.json` 改成一份**仍然合法**的 JSON —— 独立 SHA-256 已与清单不同，仍返回 `restored / published=true / cleanup=ok / reviewReasons=[]`。

**原因**：只在每个文件刚复制完时回读 hash；之后的目标集合核对**不核字节**，源复核后直接发布 registry，发布后只做 schema/工件预检。预检"能解释"一份 JSON，并不证明它是被抄下来的那些字节。

**修后（绿）**：

- `restoreTarget.ts` 新增 `verifyTargetAgainstManifest(session, manifest, limits, signal, { registryBytes? })`：**集合 + 归属 + 逐文件长度/SHA-256** 一次做完。非 registry 文件走 `readOwnedFileBounded`（身份核对）；registry 已发布时不在自有登记表里，因此先 `assertAncestorsOwned` 再按路径有界读取，与清单声明的长度/hash 比较；
- `expectedTargetLayout(manifest, { registryPublished })`：发布前后期望集合不同（发布前不含 registry），避免"用集合差异掩盖字节差异"；
- `restore.ts` 在**完成点之前**（源复核之后、发布之前）调用一次（`facts.phase = "verify-target"`），发现变化即拒绝发布、按归属清理、`published=false`；
- **发布之后**再调用一次（带 `registryBytes`），任何字节/集合漂移只报 `committed-needs-review`（`reviewReasons` 新增固定枚举 `verify-restored-drift`），`published` 保持 true、**库保留**、不用清理删掉可观察到的变化来"强行通过"；随后仍跑现有预检（`verify-restored-failed`），两类原因分开报告；
- 次数是**有限**的（完成前后各一次），不做"反复扫到磁盘不变为止"的循环，不声称消除 TOCTOU。

**永久回归**（§7）：源复核阶段注入（用"完成标记第 2 次被读"作为阶段标记，不靠 sleep）① 目标文件合法改写 ② 目标多出一个未声明文件 ③ 目标删掉一个已声明文件 → 全部拒绝发布；**发布后 registry 被合法改写** → `committed-needs-review` + `published=true` + `verify-restored-drift` + 库保留且内容确实与原字节不同。

**真实入口证据**（`knowledgeCli.test.mjs`）：用 `--import` 预加载模块在**真实 CLI 子进程**里制造"发布后 registry 被合法改写"，断言退出码 **3**、`status=committed-needs-review`、`published=true`、`reviewReasons` 含 `verify-restored-drift` —— 不是只有纯 mapper 自测。

### 1.3 R26-3（P2）解析失败绕过 `--json` 单对象契约

**旧红**：`inspect --json --root`、`inspect --json --unknown`、`bad-command --json` 三种参数都退出 2，但 **stdout 为空**、只有 stderr 文本；显式请求 JSON 的自动化调用方拿不到可解析的错误结果。原因：解析 catch 把输出模式硬编码成 `false`。

**修后（绿）**：

- `knowledgeOutput.mjs` 新增 `jsonRequested(argv)`：按**解析器同一套取值规则**走一遍（`--root`/`--backup-root` 后面的 token 是值，不算选项），只看未被消费的独立 `--json`；因此 `inspect --root --json` 被判为"没有请求 JSON"（`--json` 是 `--root` 的值位置），不会把一次明确错误的调用报成 JSON 结果；
- `requestedCommand(argv)`：只接受已知命令，其余一律 `"unknown"`，解析失败时**不**把任意正文当成命令名回显；
- 解析失败时按该意图输出**一个**受控 `usage-error` 对象（stdout）或人类可读诊断（stderr），退出码仍是 2；
- 解析错误里的未知参数/命令正文改走 `boundedToken()`：先截断再过滤字符集，长度有界，不回显超长输入。

**永久回归**（`knowledgeCli.test.mjs`）：缺值 / 未知参数 / 未知命令 / 重复参数 / 不适用选项 → 退出 2 且 stdout 恰好一个 JSON 对象（含 `status=usage-error`、`command`）；4000 字符的未知参数 → 文案有界且不含原样长串；`--json` 前置位置生效；`--root --json` 与无 `--json` 两种情形 stdout **为空**、走 stderr；全部对照断言**零写入**（沙箱目录保持为空）。

## 2. 节点 B：M1 实际 API 与限额

`core/memory/`（新增 5 个文件，窄出口 `core/memory/index.ts`）：

| 文件 | 职责 |
|---|---|
| `contract.ts` | 输入/输出契约、原因码与分类枚举、`MemoryLimits` + `resolveMemoryLimits`、`MemoryInputError` |
| `projection.ts` | v1 记录 → 候选（严格校验 + 内存中的 legacy/unspecified 标签，**不修改输入**、不落盘） |
| `policy.ts` | 授权/端点、范围适配、时态半开区间、替代/撤回（有界链）、验证与证据漂移 |
| `decide.ts` | 固定顺序管道 + 事实键冲突 + 分类 + 预算与确定性输出 |
| `index.ts` | 窄出口 |

主要入口：

```ts
decideMemory({ intent, now, target, authorization, candidates, relations, limits? })
	→ { intent, status: "ok" | "incomplete", items: MemoryDecision[], dropped, limits }

projectV1Record(kind, value) → { ok: true, candidate } | { ok: false, code: "invalid-record", issues }
projectV1ExperienceCard / projectV1FeatureRecord / projectV1ProjectProfile / projectV1TaskRecord
```

**边界（实际做到的事）**：不 import `node:fs`、不扫描 Git、不连模型、不读时钟（`now` 由调用方传入）、不写知识库、不升 schema、不新增落盘字段。`authority` 是**调用方声明**：纯模块不把"调用方说读过"当成自己完成的磁盘复核。

**判定顺序与语义**（每条都有对应永久用例）：

1. **授权先于可见**：`current-project` 要求项目 ID 双方都已知且相同；`customer` 要求目标客户同时出现在候选 `customers` 与上层 `customers` 白名单；`internal-general` 需要上层放行**且**候选带显式授权说明。端点三态：`false` 直接拒绝，`null` 允许判定但**不能是 current**。未授权候选**完全不出现在结果里**（不返回 ID/标题，也不进 `dropped` 计数）。
2. **范围适配**：双方都声明且不同 ⇒ 排除（`scope-mismatch`）；候选声明而目标未声明 ⇒ `scope-unknown`（需复核，不排除）；只在一侧声明 ⇒ 不作判断（"不知道"既不是匹配也不是不适用）。
3. **时态**：半开区间 `[from, to)`；未生效 ⇒ `needs-review`，已结束 ⇒ `needs-review`；区间倒置与非法时间抛 `invalid-time-range` / `invalid-input`。
4. **revision 因果优先**：同记录较高 revision 是当前结论，即使它的 `recordedAt` 更早（时钟回拨/同毫秒不影响）；旧 revision 在 current 下 `excluded`（`older-revision`），history 下可见。
5. **替代/撤回**：关系必须绑定记录 ID + 目标 revision + 范围；缺目标记录 ⇒ 整体 `incomplete` 且所有已授权候选带 `unresolved-relation`；目标 revision 不匹配、循环、链长超过 `maxRelationChain` ⇒ `unresolved-relation`（**不**回退成"旧事实有效"）；链长触顶另带 `relation-chain-truncated`。
6. **冲突不按时间戳选赢者**：事实键相同且**范围重叠**、值不同时，双方都标 `conflict`；若其中一方是人工确认值（`confirmedFields` 里以该事实键命名且 `status=confirmed`），双方都标 `needs-confirmation` —— 确认值不被覆盖，差异交人工。范围不重叠（不同板卡/客户）不构成冲突。
7. **验证与证据分开报告**：只比较候选**显式声明**依赖的 commit/板卡/构建目标/内容 hash，无关变化不全局失效；声明了但目标侧未知 ⇒ 按漂移处理（"无法判定"不等于"没有变化"）；证据 `unavailable` 只报告不当成删除或判错；`strongestPassed` 只按记录里实际通过的最强类别，`compile` 永远不会升级成 `board-boot`。
8. **v1 legacy**：既没有生效区间、也没有依赖快照 ⇒ 一律 `legacy-unspecified` + `reference`（不冒充当前已验证事实），**不**用 `createdAt` 伪造生效时间；投影后的 `recordedAt` 取记录头 `createdAt`（那是它的真实语义）。
9. **预算与确定性**：`maxCandidates`/`maxRelations` 超限**不返回部分结论**（只报 `incomplete` + 生效预算），避免半份结论被当成完整结论；`maxReasons=0` 时原因数组为空但 `reasonsTruncated=true`；`maxOutputBytes` 按 `items` 的 UTF-8 序列化字节截断并如实 `dropped` 计数；输入先做形态与数组长度检查，重复 `recordId+revision` 直接拒绝；相同输入（含数组顺序置换）输出逐字节一致。

## 3. 节点 B：永久测试与合成演示

- `tests/memoryDecisions.test.mjs`（19 项）：覆盖 MT-01（确认 vs 检测候选）、MT-01b（无证据保持 unknown）、事实键范围重叠要求、MT-02（revision 因果优先、时钟回拨）、MT-03/03b（录入≠生效、未来/结束、半开端点、倒置与非法时间）、MT-04（Board A 替代不影响 Board B，history 可见）、跨客户未授权与端点 unknown 的**零泄漏**、MT-05（撤回不因旧摘要复活）、MT-08（deprecated 不进 current、history 可见）、关系完整性（缺目标/错 revision/循环/链长上限）、MT-07/10（依赖漂移、无关变化不失效、unavailable、compile≠board-boot）、MT-11（权威不可读不回显标题）、MT-12（legacy 只作参考）、预算 0/精确/差一/非法限额、确定性与标题截断、v1 投影（严格校验/不修改输入/不伪造生效时间）、输入形态拒绝。
- `cli/memory-scenario.mjs` + `tests/memoryPxeScenario.test.mjs`（3 项）：**合成 PXE 场景**——目标 Board B、未来才生效的新需求、Board A 的旧经验、被撤回结论的旧会话摘要、另一家客户未授权资料、与人工确认值不一致的新检测候选同时出现。演示调用真实 M1 API 并打印一个 JSON 对象；回归断言六类结果（current 1 / reference 1 / needs-review 3 / excluded 3）、未授权材料在 hint 与计数上都不可见、history 同样受授权约束、两次运行逐字节一致、非法意图退出 2。

## 4. 节点 C：M2 字段差距与持久化闸门（**只设计，不实施**）

本批**不改真实 schema**、不写迁移器、不动 C3 支持版本表、不新建通用多记录事务或语义历史库。下表是"现有 v1 能表达什么 / 缺什么 / 降级影响"的差距表。

### 4.1 逐记录族

| 记录族 | v1 可直接复用 | v1 不能表达 | 当前降级结果与业务影响 | 是否必须改格式 |
|---|---|---|---|---|
| `ProjectProfile` | identity 各字段的 `value/status/evidence`、独立工作区快照、`buildTargets`、`keyEntryPoints`、`gaps` | 字段确认者/独立确认时间、字段级历史/替代/撤回 | 可保留当前 confirmed 并显示新候选；经验审核 audit 不覆盖项目字段确认，普通 journal 的 revision/指纹不是历史值账本，不能查询旧确认语义 | **否**（BM-03 当前事实无需升版）；历史查询另评审 |
| `ExperienceCard` | `status`（draft/reviewed/verified/deprecated）、`reuseScope`（level/customers/authorization）、`validations`（kind/scope/result）、`evidence`、`featureId` | 事实键（同一业务属性，如"某需求 PXE 默认值"）、生效区间、细粒度替代/撤回目标（记录 ID + revision + 范围）、验证依赖快照（commit/关键配置/hash） | 只能整卡 `deprecated`；"某板卡条件被替代"只能写进 `appliesWhen/doesNotApplyWhen` 文本，**机器不可判**；"当前 HEAD 是否仍通过"无法回答（M1 只能给 `legacy-unspecified`/`reference`） | **是**（若要"某板卡条件被替代"与"需求沿革"成为可执行语义） |
| `FeatureRecord` | `originalRequirement`、`aliases`、`acceptanceCriteria`、`relatedExperienceIds`、`customer/productLine` 的字段状态 | 需求版本沿革、生效区间、具名替代目标 | `relatedExperienceIds` 指向经验卡而非旧 FeatureRecord，不能冒充沿革；v1 首版可人工确认当前需求并关联经验，不能机器判定需求版本链 | **是**（正式沿革需另评审）；**否**（BM-04 有限录入/检索） |
| `TaskRecord` | `status`（含 done 重开）、`decisions/todos/blockers`、`relatedFiles`、`validations`、`workspace` 快照 | 交接摘要的来源快照 hash、重开原因的结构化记录 | `revision` 因果 + `taskId` 隔离已能表达"done 重开后新 revision 优先、旧交接摘要不得写回 done"（BM-05 执行规则，不需新字段） | **否** |
| `ContextManifest` | `sources`（recordId/kind/revision/reason）、`expiredSources`、`budget`、`profileRevision`、`generatedAt` | 生成时来源字节 hash/完整依赖快照 | 可重读 revision 并在当前进程临时计算 hash、输出 stale/incomplete；但没有耐久来源 hash，不能把当前指纹当生成时快照。完整跨进程来源字节证明另评审 | **否**（有限 v1 重验）；持久化指纹如需新格式另评审 |

### 4.2 若确实需要格式变化（评估口径，不在本批实施）

1. **源/目标版本与未知值转换**：新字段必须有"未知 = unspecified"的显式取值，绝不把 `createdAt` 反填成 `effectiveFrom`；转换只做"新增字段缺省 + 旧记录保持 v1 语义"，不做猜测式补值。
2. **谁显式确认**：新字段的写入必须走现有单记录 CAS/锁/审核/journal 链路；`operatorLabel` 仍是声明而非身份认证。
3. **历史上限**：语义变更记录（旧/新事实、目标版本、范围、依据、时间）必须在**所属业务记录**里，与当前状态用一次已有单记录提交共同保存；条数/字节有上限，**超限拒绝本次写入并要求显式归档**，不静默丢弃撤回/替代链。
4. **单记录提交与恢复的影响**：沿用现有原子替换 + revision 冲突 + 协作锁 + journal/审核；不引入通用多记录事务前置。
5. **版本分层纪律**：记录格式版本与 journal/audit/backup 版本**互相独立**；备份保留原字节**不等于**未来业务版本已经可恢复 —— 恢复侧必须继续走业务准入（预检 `unsupported-*` 即 `blocked`），**禁止**把未知未来版自动纳入准入或"尽力解释"。
6. **后续闸门**：C3 支持版本表、备份/恢复测试与人工执行闸门都要等 M2 方案**独立评审通过**后再动；本批不预支。

### 4.3 BM-03 下一批的有限建议

- **不涉及 schema 变更、可先做**：registry 绑定与档案的读取一致性、"检测候选 vs 人工确认"的可见差异（复用 M1 的 `needs-confirmation`/`conflict`）、板卡/HEAD/证据变化的可见提示（复用 M1 的 `verification-drift`）、以及一个最小读取/消费入口。
- **须 M2 方案验收后才做**：把"事实键 + 生效区间 + 细粒度替代/撤回 + 验证依赖快照"落成真实字段与迁移；在此之前 BM-03/04 只能用"整卡状态 + 人工确认 + M1 策略输出"的降级形态交付，并在结果里如实标注 `legacy-unspecified`/`reference`。

## 5. 整批门禁（实施方实跑，修改后）

```text
node --test tests/storageBackup*.test.mjs tests/knowledgeCli.test.mjs
   → backup 七文件＋CLI：235 项：234 通过、0 失败、1 显式 skip（本机文件型链接权限）
      （R26 之前为 218；新增 17 = R26-1 七项 + R26-2 五项 + CLI 五项）
node --test tests/memoryDecisions.test.mjs tests/memoryPxeScenario.test.mjs
   → 22 项：22 通过、0 失败、0 skip
npm test（Package 全部用例）            → 680 项：676 通过、0 失败、4 显式 skip
旧存储 targeted（records/registry/preflight/journal/reviewWriter/write）→ 249 项：246 通过、0 失败、3 skip
npm run typecheck / check:format（105 文件）→ 通过
npm run selfcheck                       → 6 项通过
仓库根 typecheck / check:format（2014 文件）→ 通过
仓库根 tests/processGuards.test.mjs / git diff --check → 2 项通过 / 通过
```

680 = 上轮 641 + R26 收尾 17 + M1 22。4 个 skip 全部是本机文件型 symlink 权限所限（完成标记文件链接及三个既有对照），不计为通过；目录 junction 对照实际执行。

## 6. 未测与边界

- **未测**：真实 ACL、网络盘、断电、其它 OS、远端 CI、生产安装包、真实客户 BIOS/硬件；M1 **没有**接真实检索索引、没有接 Session、没有磁盘读回、没有向量库、没有自动批准经验、没有后台 AutoDream。演示是合成场景。
- **M1 的边界**：它是决策模块，不是搜索引擎或语义历史账本；`authority`/`authorization`/`endpointAllowed` 都是**调用方声明**，不构成企业认证或可信权限服务；不保证限制 Pi 的普通文件/终端工具；不承诺捕获全部 ABA 或消除 TOCTOU。
- **R26 的边界**：完成点前后的目标复核是**有限次**（各一次），只承诺"注入点之前发生的可观察变化会被发现"，不承诺"检查期间任意时刻的变化都能发现"，也不隔离同机恶意写入者。
- **M2**：只交付设计闸门，**未**改 schema、未写迁移器、未改 C3 支持版本、未新增多记录事务；M2 方案仍待独立评审，**不得**标为"持久化实现完成"。
- 保留 dirty tree、未跟踪文件与六项既有历史文档删除；未 add/commit/push；未改 PiRuntime/Electron；未读真实客户库或客户源码。

## 7. 断点（如后续接续）

当时建议推进 v1 的 BM-03，不提前持久化新时态字段。第二十七轮发现 M1 身份、准入、关系和预算缺口，故“只构造 MemoryCandidate、不必改内存契约”的建议被 [BM-03 原批次](bm03_development_plan.md) 取代，允许有限调整未发布的 M1 内存 API，不改磁盘 schema。当前任务以 §10 与 [BM-04 批次](bm04_development_plan.md) 为准。

## 8. 第二十七轮独立验收回写

- 独立 Package 680 项（676 通过、0 失败、4 文件型 symlink 权限 skip）；backup＋CLI＋memory 257 项（256 通过、1 skip），其中 memory 22 项；旧存储 249 项（246 通过、3 skip）及包/根指定门禁通过。
- R26-1～3 独立关闭：源 manifest 漂移拒绝发布；目标完成点前漂移拒绝、发布后漂移 committed-needs-review 并保留；真实 CLI JSON 参数错误 exit 2 单对象，发布后故障 exit 3 永久回归通过。D3/D4 在本机声明范围通过。
- M1 已实施但未完整通过：R27-1（draft/unknown 经验成为 current、非当前版本参与冲突、未授权 revision 干扰及裸 ID 跨族去重）；R27-2（缺失/不可读/未授权关系来源仍废弃目标、边排列改变结果）；R27-3（首条超输出预算、非法策略/形态未受控、数量闸门晚于逐项检查）。完整复现见 [验收 §4](round27_acceptance.md#4-m1-三组有限整改)。
- §4.1 已纠正项目字段确认审计、Feature 关联类型、ContextManifest 来源 hash 的误述；M2 仅认可 BM-03/v1 路线，具体新格式/历史上限/转换与迁移还未批准。
- 下一批按 [M1 收尾＋BM-03 完整项目模块](bm03_development_plan.md) 执行，内部修复过闸即继续真实业务，不再只交小补丁。未修改运行代码、未提交推送；未测范围及历史通过边界保持。

## 9. 本轮（BM-03 节点 A）R27-1～3 的修复回写

上面 §1～§8 的数字与本轮无关的历史快照保持不变；R27 三组的修复实现、红绿现象与门禁见 [BM-03 实施记录 §1](bm03_implementation.md#1-节点-ar27-13-旧红新绿)。要点回写：

- **契约层**：`MemoryCandidate.kind` → `family`；`MemoryRelation` 改为两端具名的 `source`/`target` 记录身份；`MemoryDecision` 增加 `factKey`/`family`。记录身份（族+ID+revision）、事实身份（+事实键）、关系端点三者从此显式区分；磁盘 v1 记录格式一字未改。
- **R27-1 关闭**：按记录族/字段的当前准入（`eligibilityVerdict`）与唯一的"非当前"原因表（`NON_CURRENT_BLOCKERS`）；revision 集合只在已授权可见集合上计算；可授权最高版本不可读不得让旧版本复活；同裸 ID 跨族合法。
- **R27-2 部分关闭**：已实施端点复验、多条适用边共同判定，原缺源 fixture 已补真实声明方；简单关系/环已有回归，但第二十八轮发现分叉图仍受排列影响、被撤回来源仍生效、未授权来源仍影响目标。关系前信号快照不是来源最终有效的证明；完整关闭待 R28-3。
- **R27-3 关闭**：浅层 → 数量（不访问元素）→ 有界嵌套 的闸门顺序；非法策略与形态受控拒绝且文案有界；输出按 JSON 数组精确 UTF-8 记账（`[]` = 2 字节，预算 0/1 不放任何条目，超限首条不再保留）。
- 一处规则收窄：`legacy-unspecified` 限定在经验族（档案字段/任务状态不因"没有生效区间"被降级），经验卡既有回归不变。
- 本轮 memory targeted 为 **28 项**（上轮 22），其中 `memoryDecisions.test.mjs` 25、`memoryPxeScenario.test.mjs` 3；旧红全部转为永久回归，并补了同 ID 跨族、授权隔离、不可读最高版本、关系排列/矛盾/循环、当前/历史对照与预算精确边界的反例。

## 10. 第二十八轮独立验收回写

独立原场景复验确认 R27-1/3 关闭；M1 28 项既有回归通过，PXE 演示 current 2/reference 1/needs-review 3/excluded 3。但 R27-2 未完整关闭，R28-3 的分叉环、撤回来源及隐藏来源对照尚未纳入永久回归。不能把简单环测试或授权 revision 隔离测试等同于全图/关系授权保证。

完整复现见 [第二十八轮验收 §4](round28_acceptance.md#4-四组有限收尾)。当前 [BM-04 批次](bm04_development_plan.md) 先内部修 R28，再同批交经验/Feature 业务；M2 的字段历史、正式需求沿革、耐久来源指纹与迁移仍未批准/未实现，不新增持久化格式。

## 11. BM-04 节点 A 的修复回写（R28-3）

§9 的回写保持不变；R27-2 的剩余项（分叉环、撤回来源、隐藏来源）在 BM-04 节点 A 收口，实现与红绿见 [BM-04 实施记录 §1.3](bm04_implementation.md#13-r28-3p1关系图仍受输入顺序与无效来源影响)。要点：

- `policy.ts` 的 `relationVerdict` 被 `evaluateRelationStates` 取代：**确定性排序建图 + Kahn 拓扑序求解 + 环保留矛盾**，
  结果与输入排列无关（分叉环正反排列逐字节相同）；节点预算（`maxRelationNodes`）与链长预算都有界。
- 声明方五态：`readable` / `blocked` / `unreadable` / `unauthorized` / `absent`；**未授权来源的整条边被忽略**
  （隐藏来源不能改变可见事实），`absent`/`unreadable` ⇒ `unresolved`，`blocked` 或"声明方自己已被替代/撤回" ⇒ `not-effective`。
- `decide.ts` 用"可见集合 / 输入集合"区分"给了但未授权"与"根本没给"，并把图结论接到候选上；`legacy-unspecified`
  同时扩展到**需求族**（v1 需求同样没有语义时间，不能冒充当前已验证事实），档案字段与任务状态不受影响。
- memory targeted 由 28 项（`memoryDecisions` 25 + `memoryPxeScenario` 3）增加到 **29 项**（26 + 3）：
  新增"分叉上的环与撤回来源都保留矛盾且与输入排列无关"一组，并**修正**了原来的"未授权声明方 ⇒ 目标降级"断言
  （R28-3 明确要求隐藏来源不改变可见事实）。旧红场景全部保留在永久回归里，没有被删除或弱化。

## 12. 第二十九轮独立验收回写

memory 29 项（decisions 26＋PXE 3）既有回归通过；原分叉环排列、撤回来源及简单隐藏来源场景已修复。但 R28-3 仍未完整关闭：拓扑建图没有先排除不适用 scope，会形成跨板卡假环；未知范围判定早于 unauthorized，隐藏来源仍改变目标。这两组归 R29-4，复现见 [验收 §4](round29_acceptance.md#4-四组有限收尾)。

当前 [BM-05 批次](bm05_development_plan.md) 先内部收尾，再交任务/人工交接/Manifest 重验与经验草稿；保持 v1 和既有 storage/audit/journal，不把生成时未保存的 hash/HEAD 冒称耐久历史证明，不提前 Session/Pi 注入或迁移。
