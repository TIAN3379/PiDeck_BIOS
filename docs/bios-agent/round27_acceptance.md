# 第二十七轮验收：恢复收尾通过，记忆模块有限整改与 BM-03 合批

日期：2026-10-04。工作区 `D:\BIOS_Pi_Agent\PiDeck_BIOS`，分支 `BIOS_Agent`；Windows / Node 24.14.1。
依据：记忆底座批次方案、实际实现、独立门禁与额外合成诊断。本轮只验收和更新文档，不修运行代码、不提交推送。

## 1. 验收结论

- **R26-1～3 关闭，D3/D4 通过约定的本机离线范围。** 完成标记变化、完成点前后目标变化和 CLI JSON 解析错误均有独立复验依据；不重做历史存储、审核、预检与备份整改。
- **M1 已真实实现，但本轮不标整体验收通过。** 已有纯决策 API、v1 投影、22 项永久测试和可执行 PXE 合成演示。额外诊断发现三组契约遗漏：当前事实准入与 revision、关系来源与确定性、运行时输入与预算。
- **M2 的“BM-03 复用 v1、不升版”方向可以执行。** 差距表中三处事实误述已在本轮文档中纠正；这不等于批准未来 schema、历史账本或迁移实现。

下一批执行 [M1 有限收尾＋BM-03 完整项目模块](bm03_development_plan.md)：三组修复转为永久回归，内部过闸后直接开发项目绑定、档案读取、检测候选、人工确认、工作区/证据刷新与人工入口，整批一次交回。不要又只交三个补丁，不为每项内部修复等待独立验收。

## 2. 独立门禁

| 范围 | 本轮实际结果 |
|---|---|
| Package `npm test` | 680 项：676 通过、0 失败、4 显式 skip |
| backup＋CLI＋memory targeted | 257 项：256 通过、0 失败、1 显式 skip；memory 22 项包含在内 |
| 旧存储六文件：records/registry/preflight/journal/reviewWriter/write | 249 项：246 通过、0 失败、3 显式 skip |
| Package typecheck / selfcheck / check:format | 通过 / 6 项通过 / 105 文件通过 |
| 根 typecheck / check:format | 通过 / 2014 文件通过 |
| 根 processGuards / git diff --check | 2 项通过 / 通过 |

680 = 上轮 641＋R26 修复 17＋M1 22。4 个 skip 是本机**文件型 symlink** 创建权限所限，不能计为通过；目录 junction 对照实际执行。合成诊断不计入永久用例数。全绿证明既有覆盖未回归，不证明下列新增诊断已经关闭。

复跑命令：

```powershell
# packages/bios-agent
npm test
node --test tests/storageBackup*.test.mjs tests/knowledgeCli.test.mjs tests/memory*.test.mjs
node --test tests/storageRecords.test.mjs tests/storageRegistry.test.mjs tests/storagePreflight.test.mjs tests/storageJournal.test.mjs tests/storageReviewWriter.test.mjs tests/storageWrite.test.mjs
npm run typecheck
npm run selfcheck
npm run check:format
node cli/memory-scenario.mjs

# 仓库根
npm run typecheck
npm run check:format
node --test tests/processGuards.test.mjs
git diff --check
```

## 3. R26 独立复验：已关闭

使用自建临时知识库，含五类记录及非空 task；独立 `fs`/SHA-256 检查，不以产品自己的 hash 校验函数替代观察。

| 场景 | 实际结果 |
|---|---|
| 正常导出→新根恢复 | 15 文件、9340 字节，源/清单/目标逐文件长度与 SHA-256 一致 |
| 新 Node 进程读取 | registry schema 1；profile rev 0、experience rev 1、feature/task/context 各 rev 0，五类均可读 |
| 首次 payload 写入时改源 manifest 为 backupVersion 2 | 注入命中；`backup-source-changed`，phase `recheck-source`，`published=false`；cleanup ok、无残留、目标未发布 registry |
| 源复核期间合法改写目标 feature | 注入命中；`backup-target-exists`，phase `verify-target`，`published=false`；cleanup ok、无残留、目标未发布 registry |
| registry 发布后合法改变目标 registry revision | 注入命中；`committed-needs-review`、`published=true`、`verify-restored-drift`；保留已发布库 |
| 真实 CLI 子进程：`inspect --json --root`、`inspect --json --unknown`、`bad-command --json` | 均 exit 2；stdout 一个可解析 `usage-error` JSON 对象，command 分别为 inspect/inspect/unknown |

Targeted 套件还实际执行了预加载注入的**真实 CLI 发布后漂移→exit 3**，不只是纯退出码 mapper。复核次数有限；不承诺恶意并发隔离、消除 TOCTOU、在线快照或断电一致性。通过的是本机声明范围，不是正式客户资料保护认证。

## 4. M1 三组有限整改

诊断直接调用真实 `decideMemory`，测试 helper 只构造合成输入；没有磁盘、模型、真实客户资料。以下均是本轮实际输出，不是假设缺陷。

### R27-1（P1）：当前准入、授权与 revision 隔离

位置：`core/memory/decide.ts` 的 `latestRevision`、`applyFactKeyConflicts`、`finalize` 与输入去重。

| 合成输入 | 当前输出 | 应有行为 |
|---|---|---|
| 当前范围经验，status=draft 或 unknown，其余为可用声明 | `ok/current`，无原因码 | 未审核经验不得成为当前工程依据；按记录族和字段确认状态分别判断 |
| 当前 PXE=off＋未来才生效的 PXE=on | 当前、未来两条都 `conflict` | 未来事实保留未来/参考提示，不污染当前冲突集合 |
| 同记录 rev 1=off、rev 2=on | rev 2 `conflict`；rev 1 excluded 但参与冲突 | 已被 revision 淘汰的旧版本不能让新版本虚假冲突 |
| 可授权 rev 1＋同 ID 未授权项目的 rev 2 | 可见 rev 1 被标 `older-revision`；rev 2 隐藏 | 未授权输入不能暗中决定授权记录状态 |
| experience-card 与 feature-record 使用相同 ID/revision | duplicate `invalid-input` | v1 记录族有独立命名空间；不能按裸 ID 跨族去重/淘汰 |

修复需要先确定授权可见集合，再按**记录族/来源归属及事实粒度**计算 revision 和当前冲突资格。最高可授权版本若不可读，不得简单过滤后让旧版本复活。不能用“全面禁止 unknown”伤及项目字段确认或 Task 状态；也不能删除合法跨记录、重叠范围的当前冲突。

### R27-2（P1）：替代/撤回关系未经来源复验，且顺序影响结果

位置：`core/memory/policy.ts` 的 `indexRelations`、`relationVerdict`。

| 合成输入 | 当前输出 |
|---|---|
| 只有 exp-a；关系声明 exp-new rev 1 替代它，但 exp-new 根本不在候选中 | `ok`，exp-a excluded/superseded |
| exp-new 存在但 authority=unreadable | exp-new needs-review；exp-a 仍 excluded/superseded，整体 `ok` |
| exp-new 属于未授权项目 | exp-new 隐藏；exp-a 仍被替代，整体 `ok` |
| 同源/同目标两条关系分别 supersedes、retracts；交换数组顺序 | exp-a 原因分别 superseded/retracted，序列化输出不相同 |

关系必须解析**两端的具名记录/版本/归属**，复验来源授权、权威可读性、状态与时态，并检查目标范围。缺源、不可读、旧 revision、未知目标维度不能冒充明确关系；未授权来源不可借关系泄漏或改变可见事实。相关授权来源确实不完整时，应使受影响结论待复核/不完整，而不是虚假确定。

同时收集适用关系并显式处理矛盾，不能“排序后第一条赢”。循环、分叉、链长与关系数量均有限且结果确定；同一输入集合的排列不改变结果。现有测试/演示若用**缺失来源**证明替代成功，须补足真实合成来源并增加反例，不保留错误断言来凑全绿。

### R27-3（P2）：公共输入与实际预算未按契约执行

位置：`decide.ts` 的入口 `resolveMemoryLimits`/`assertQueryShape` 和输出预算。

| 合成输入 | 当前输出 |
|---|---|
| 单条当前候选，maxOutputBytes=1 | items 实际 UTF-8 **201 字节**，status incomplete，但保留整条且 dropped=0 |
| `decideMemory(null)` | 裸 `TypeError`，不是受控 `MemoryInputError` |
| endpointAllowed=`"invalid"`（字符串） | `ok/current`，非法策略没有被拒绝 |
| maxCandidates=0，但给一条记录，使用 getter 计量 recordId 访问 | 返回 incomplete 前 recordId 已读取 3 次；数量预算晚于逐项检查 |

先做浅层形态/数量闸门，再有限检查嵌套数组、字符串、枚举、boolean/null 和时间；拒绝非法策略，错误不回显长正文。输出不能为了“至少有一个解释”保留超限首条；精确计算 JSON UTF-8 与逗号开销，规定预算 0/1 时空数组固定开销的口径，测试精确边界与差一。入口改进仍留在纯模块，不新增 IO/认证服务。

本组当前主要影响纯决策契约；尚无正式模型写入口，不把它描述成已发生企业认证绕过。但它是后续业务调用前必须收口的真实公共入口缺口。

### 最小复现构造

在 `packages/bios-agent` 的 Node ESM 中，导入 `decideMemory` 和 `tests/helpers/memoryFixtures.mjs` 的 `query/currentCandidate/relation/emptyTime/NOW/DAY/authorization`：

```javascript
decideMemory(query({ candidates: [currentCandidate({ status: "draft" })] }));
decideMemory(query({ candidates: [currentCandidate()], relations: [relation()] }));
decideMemory(query({ candidates: [currentCandidate()], limits: { maxOutputBytes: 1 } }));
decideMemory(query({ authorization: authorization({ endpointAllowed: "invalid" }), candidates: [currentCandidate()] }));
decideMemory(query({ candidates: [
  currentCandidate({ recordId: "active", factKey: "pxe", value: "off" }),
  currentCandidate({ recordId: "future", factKey: "pxe", value: "on", time: emptyTime({ effectiveFrom: NOW + DAY }) }),
] }));
```

这些当前红例须变成永久测试，另补同 ID 跨族、授权隔离、不可读最高版本、关系排列、当前/历史对照与预算实际计量；不能只增加日志或改期望接受旧错误。

## 5. M2 文档纠正与闸门

实施记录 §4.1 已纠正三处：

1. 当前经验审核 audit 的 operatorLabel 不等于 ProjectProfile 字段确认审计；普通 journal 的 revision/指纹不能恢复历史字段语义。v1 不支持“查询三个月前确认的字段值”。
2. FeatureRecord.relatedExperienceIds 指向**经验卡**，不是另一条 FeatureRecord，不能用它冒充机器可判的需求沿革。
3. ContextManifest.sources 有 kind/ID/revision/reason，**无来源 hash**；重验时可读取当前来源和临时指纹，但这不等于已持久化生成时快照。未来若需要耐久的来源字节证明，须单独评审。

BM-03 的身份字段、证据、每工作区快照和人工确认可复用现有 v1，因此不用等所有时态字段升级。具体新版本号、逐字段转换、历史硬上限及对应备份恢复未形成可实施方案，不批准迁移器/C3 支持表变更。M2 持久化仍未实现。

## 6. 边界、进度与交接

已从存储可靠性推进到**记忆纯决策层**；但尚无真实项目事实服务、经验检索、任务重开/上下文注入、知识 UI、后台学习或跨 IBV 移植。PXE 演示输出 current 1/reference 1/needs-review 3/excluded 3，属于合成 happy path，不能替代 §4 反例或真实平台验证。

本轮未测根全量测试、构建/安装包、远端 CI、其他 OS、真实 ACL/网络盘/断电及客户硬件。未读默认真实知识库、未接模型或修改 BIOS 源码；仅对本次创建的临时合成目录做检查与清理。保留工作树原有修改、未跟踪文件和六项既有历史文档删除，未新增删除、未 add/commit/push。

下一位 AI 只需先读 `AGENTS.md`、本文和 [当前批次](bm03_development_plan.md)，再按调用链补读相关实现。旧批次提示词已被新批次取代；历史通过范围不回滚，不重新执行已关闭问题。
