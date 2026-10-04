# BM-02D1 实施记录：离线备份协议与纯校验

日期：2026-10-04。工作区 `D:\BIOS_Pi_Agent\PiDeck_BIOS`，分支 `BIOS_Agent`。
状态：**第二十二轮 D1/D1R 的协议与纯字节校验范围通过，B1/B2 关闭**，见 [验收](round22_acceptance.md)。§1～9 保留历史与红绿证据；D2 IO 暂未通过，当前执行 [D2R＋D3](bm02d3_development_plan.md)，不重做 D1R。
依据：[第二十轮验收](round20_acceptance.md)（C3/C3R 在声明的本机范围收口）与 [BM-02D1 方案](bm02d1_development_plan.md)。

## 1. 本轮交付边界（先说不做）

交付一份**可测试的备份协议**：`backupVersion=1` 的清单契约、受控落点判断、资源上限校验，
以及**内存原始字节**的清单核验。目的是把"将来能安全恢复什么、不能恢复什么"先写成可执行判据。

- **不做任何 IO**：不扫描或导出真实库、不建备份目录、不解压、不恢复、不加锁、
  不调用初始化/reconcile；**没有 CLI/UI/模型工具**。
- `backupVersion` 描述**清单自身结构**，与业务 `schemaVersion`、`auditVersion`、`journalVersion` 无关；
  本轮不迁移、不重写任何现有记录。
- 不引入新依赖：只用 `node:crypto`（hash）与 `node:buffer`（字节计量）。
- 复用既有判据，不复制第二套规则：知识 ID（`contracts/ids.ts`）、journal 文件名与 operationId
  （`journal/contract.ts`）、审核意图文件名（`contracts/auditIntent.ts`）、意图目录名
  （`review/artifacts.ts`）；`projects`/`experiences`/`features`/`audit`/`profile.json` 这些
  存储层没有集中导出的字面量由漂移守卫测试与 `knowledgeLayout()` 对照兜住。

## 2. 文件与公开 API

新增 `core/storage/backup/`（全部在新模块内，未改预检/写入/审核/journal 的行为）：

| 文件 | 行数 | 职责 |
|---|---:|---|
| `limits.ts` | 83 | 独立 `BackupLimits` + `resolveBackupLimits`（未知字段与非法值在处理数据前拒绝） |
| `contract.ts` | 172 | `backupVersion=1` 契约常量/类型、诊断码、失败码 |
| `issues.ts` | 58 | 严格对象判定、未知字段计数、有界问题收集器 |
| `paths.ts` | 242 | 规范相对路径校验 + 受控落点分类（文件/目录） |
| `manifest.ts` | 264 | `validateBackupManifest` + `measureBackupManifestBytes` |
| `verify.ts` | 118 | `verifyBackupPayload`（内存原始字节核验） |
| `index.ts` | 29 | 窄出口 |

窄出口只暴露契约与两类纯校验；落点分类表、问题收集器、限额解析细节留在模块内部。
`core/storage/index.ts` 增加一行 `export * from "./backup/index.ts";`，并更新模块说明
（明确"不含任何导出/恢复 IO"）。`errors.ts` 新增两个受控码：`invalid-backup-manifest`、
`backup-payload-mismatch`（理由写在类型注释里：清单不可信与字节不一致是两种不同动作）。

```ts
validateBackupManifest(value: unknown, limits?: Partial<BackupLimits>): BackupManifestValidation
verifyBackupPayload(manifest: unknown, entries: unknown, limits?: Partial<BackupLimits>): BackupPayloadVerification
measureBackupManifestBytes(manifest: BackupManifest): number
resolveBackupLimits(overrides?: Partial<BackupLimits>): BackupLimits
```

- 成功：`{ ok: true, manifest }` / `{ ok: true, files, totalBytes }`。
- 失败：`{ ok: false, code, issues, droppedIssues }`；`issues[].where` 是**受控定位**
  （字段名或 `数组[下标]`），`message` 是固定文案——**不回显**恶意路径、绝对路径、客户正文或原始异常。
- 非法限额（含未知限额字段）在**处理任何数据之前**抛 `invalid-limits`；其余失败一律走结果对象。

## 3. manifest v1 与受控落点

```ts
{
  backupVersion: 1,
  backupId: string,            // 既有知识 ID 判据
  createdAt: number,           // [0, 8_640_000_000_000_000] 的安全整数
  consistency: "offline-copy", // 固定；不接受 online/atomic 之类无法证明的更强标记
  exclusions: ["cache", "locks"],   // 恰好这两项，不缺、不多、不重复（集合比较，顺序无关）
  directories: string[],       // 相对 data/ 的规范目录路径
  files: Array<{ path: string; bytes: number; sha256: string }>
}
```

严格对象：顶层与文件项都拒绝未知字段（含 symbol 键）、缺失字段、非数组；
`backupVersion !== 1` 直接拒绝，未来版本不做尽力解释。字段顺序固定为
`backupVersion → backupId → createdAt → consistency → exclusions → directories → files`，
规范化对象的 JSON UTF-8 字节即清单字节预算的口径（同一份语义必须得到同一个字节数）。

受控落点（固定深度，与预检同一张布局表）：

| 文件 | 允许位置 |
|---|---|
| Registry | `registry.json` |
| 项目档案 | `projects/<projectId>/profile.json`（projectId 为小写 UUID） |
| 任务 / 上下文 | `projects/<projectId>/tasks/<id>.json`、`projects/<projectId>/context/<id>.json` |
| 经验 / 特性 | `experiences/<id>.json`、`features/<id>.json` |
| Journal | `journal/<operationId>.json`（operationId 为小写 UUID） |
| 审核意图 | `audit/intents/<operationId>.json`（同一 UUID 判据 + `auditIntentFileName` 对照） |
| 审核事件 | `audit/<recordId>/<eventId>.json`（recordId 为受控 ID 且**不得**是 `intents`，eventId 为小写 UUID） |

目录只允许这些落点的祖先目录，外加 `journal` 与 `audit/intents` 两个可选空目录；
必需固定目录为 `projects`、`experiences`、`features`、`audit`。`cache`/`locks`
只以 `exclusions` 表达，**不得**出现在 data 清单里。

路径拒绝覆盖：绝对/盘符/UNC、反斜杠、空段与 `.`/`..`、重复与首尾分隔符、NUL、
冒号/ADS、尾点/尾空格、设备保留名、大小写变体、非 ASCII、非字符串、超长，
以及**不做 URL 解码**（`%2e%2e` 按非法字符拒绝）。诊断一律"名称已省略"。

跨数组一致性：两数组各自不重复；文件路径不得与目录同路径；每个文件与每个子目录的
**每一级**祖先目录都必须登记；`registry.json` 恰好一次（缺则 `missing-registry`）。

## 4. 资源限额、零值与错误口径

| 限额 | 默认 | 0 的含义 |
|---|---:|---|
| `maxManifestBytes` | 2 MiB | 清单必然超限 ⇒ 明确拒绝（清单有必需的 `registry.json`） |
| `maxFiles` | 10,000 | 一个文件项都不允许 ⇒ 必然拒绝 |
| `maxDirectories` | 2,000 | 一个目录都不允许 ⇒ 必然拒绝（四个固定目录必需） |
| `maxFileBytes` | 16 MiB | 只允许长度 0 的 payload |
| `maxTotalPayloadBytes` | 256 MiB | 所有文件都必须是空 payload |
| `maxRelativePathChars` | 240 | 任何路径都超限 ⇒ 必然拒绝 |
| `maxIssues` | 50 | 不返回问题对象，但 `droppedIssues` 如实计数、**结论仍是失败** |

- 数量边界**先于**逐条细节：条数超限时不遍历（不为一千万条路径做无界工作），
  累积总量在**溢出前**拒绝（`total > MAX_SAFE_INTEGER - bytes` 时先报 `payload-too-large`）。
- 预算耗尽**不能**返回可恢复的半份清单：只要有错（含"没地方写错误"）就是失败。
- **本轮不声称**已限制文件读取或 JSON 解析内存：清单字节预算检查的是**内存对象**；
  D2/D3 的实际读入口必须先按字节有界读取（写进 §6 未测边界）。
- `verifyBackupPayload` 顺序：校验清单 → 条目数与形态 → 长度 → SHA-256。hash 每条只算一次；
  不解析业务 JSON；等价于"同一路径集合 + 同长度 + 同字节"。
- 定义**结构性不可达**的一处防御：`path-conflict`（同一路径同时是文件与目录）在受控落点表下
  不可能出现（文件规则与目录规则互斥），保留为不变量断言；可达的同类错误是
  `missing-ancestor` / `unknown-landing`，都有永久用例。实测未构造出可达输入，故该分支无专用用例。

## 5. 永久回归与实跑

新增两个测试文件 + 一个 fixture helper（均为合成内存数据，不读写用户库、不落盘）：

- `tests/storageBackupManifest.test.mjs`：**70 项** —— 合法清单（最小/全落点/打乱顺序/
  独立字节口径/输入不变/落点表漂移守卫）、严格字段与版本、17 类路径逃逸与别名、
  未知落点与名字不符、目录混用、重复/跨数组/祖先/必需项，以及 7 类限额的
  「0 / 恰好足够 / 差一」与溢出、错误裁剪、非法限额。
- `tests/storageBackupPayload.test.mjs`：**23 项** —— 全落点通过、顺序无关、空 payload、
  未来业务版本与损坏 JSON 的字节一致对照（明确**不做**业务准入）、输入不变；
  **原始字节保真**（BOM / CRLF / 制表符 / 尾空格 / 非法 UTF-8 序列逐字节进 hash，
  只差一个尾空格字节即失败，调用后字节不变）；缺失/多余/重复/长度错/hash 错、
  中文与 CR/LF 等长差异；严格输入、清单前置校验、条目数预算、`maxIssues=0`、独立 `createHash` 复算。
- `tests/helpers/backupFixtures.mjs`：合成清单/payload 构造与**独立** `sha256Hex`、
  `canonicalManifestBytes`（不复用实现字段互证）。

实跑（本机 Windows + Node 24.14.1，实施方，方案 §5 指定门禁）：

```text
node --test tests/storageBackupManifest.test.mjs tests/storageBackupPayload.test.mjs → 93 项：93 通过、0 失败、0 skip
npm test                                                                              → 516 项：513 通过、0 失败、3 显式 skip
npm run typecheck / selfcheck（6 项）/ check:format（77 文件）                          → 通过
仓库根 typecheck / check:format（2014 文件）/ processGuards（2 项）/ git diff --check    → 通过
```

`npm test` 由 423 → 516（+93 为本轮新增）。三个 skip 仍是既有本机文件型 `symlinkSync`
权限限制（叶子链接、`storageRecords` 记录文件链接、`storageWrite` registry symlink），
本轮未删除、未弱化，新增用例**无** skip 分支。

## 6. 未测与边界（本轮未扩大）

- 未做：真实知识根扫描/导出（D2）、恢复到新目录（D3）、管理 CLI（D4）、ZIP/压缩/加密/增量/网络上传。
- **不构成**任何备份或恢复能力：`validateBackupManifest` 成功只表示"清单协议合法"，
  `verifyBackupPayload` 成功只表示"清单与所给字节一致"；都不表示已导出、已落盘、
  业务可解释或可以立即恢复。
- 字节一致**不等于**业务版本准入：未来 `schemaVersion` 或损坏 JSON 的字节可以满足 payload 核验，
  这条对照是刻意的（见 §5）。
- 路径合法**不能**推导磁盘上没有 symlink/junction：链接边界是 D2/D3 的真实 IO 职责。
- SHA-256 只校验完整性，**不提供**签名、身份认证或恶意篡改防护。
- 清单字节预算检查的是内存对象；未限制文件读取与 JSON 解析内存（D2/D3 必须有界读取）。
- 未测：生产打包/安装、其它 OS、干净 clone、远端 CI、真实 ACL、断电、真实 BIOS/硬件。
- 未改：预检/写入/审核/journal 行为、PiRuntime/Electron、业务 schema；未 add/commit/push；
  脏工作树、未跟踪文件与六项历史文档删除均保留。

## 7. 后续（本轮不实施）

| 阶段 | 下一步能力 | 仍需另行验收 |
|---|---|---|
| D1，本轮 | manifest/布局/字节纯校验 | 不具备任何备份或恢复 IO |
| D2 | 显式离线导出至根外新备份目录，失败不发布完整容器 | 有界读取、links/未知落点拒绝、取消/清理、变化检测、非覆盖发布 |
| D3 | 校验后仅恢复到新空目标目录，不覆盖现有库 | 真实路径边界、业务版本闸门、失败不发布、字节级往返、新进程可读 |
| D4 | 最小人工管理 CLI | 显式 root、参数校验、退出码、有界报告；不注册模型批准工具 |

D2～D4 的详细方案待前一阶段通过后给出；D 完成后再做 M1/M2，再进入 BM-03～05，UI 保持 BM-07。

## 8. 第二十一轮独立验收回写

[第二十一轮验收](round21_acceptance.md)独立复跑：backup 93 项全部通过；Package 516 项/513 通过/0 失败/3 权限 skip；包类型/selfcheck 6/格式 77、根类型/格式 2014/processGuards 2 与 `git diff --check` 通过。

整体暂未通过。B1：真实两字节视图覆盖 `byteLength=1` 可在声明及预算 1 时错误成功，假 Uint8Array 原型视图还会抛原始 crypto 异常。B2：排除数组 100,001 项在问题额度 0/1、manifest 字节额度 1 时仍完整遍历才拒绝。原实施快照中的“先数量边界”和“实际长度”不能覆盖这两处遗漏。

第二十一轮当时只安排 D1R。用户随后确认加速，现按 [D1R＋D2 批次](bm02d2_development_plan.md)先执行原 §8.1～8.3 技术标准并通过节点回归，再同一对话做 D2，最后统一验收。C3/C3R 通过范围保持；D1R/D2 尚未实施，D3/D4 不在当前范围，本次排期没有代码修复。

## 9. D1R 实施：B1/B2 收尾（2026-10-04）

依据 [第二十一轮 §2/§3](round21_acceptance.md) 与 [D1 方案 §8.1～8.3](bm02d1_development_plan.md#8-当前唯一任务bm-02d1r)。只改 backup 纯校验、相应测试与文档；未改 Boundary/预检/写入/审核/journal 行为。**节点自测通过不等于独立验收通过**。

### 9.1 B1：品牌与实际视图长度先于 hash

- **品牌**改用 Node 的 `util.types.isUint8Array`（不看原型链）：`Object.create(Uint8Array.prototype)` 带个自有长度不再被当成字节视图；`instanceof` 只保留为类型收窄手段。
- **长度**由 `%TypedArray%.prototype` 上的 `byteLength` getter 直接取（`Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), "byteLength")`）。真实视图的自有同名属性/ getter 覆盖不了它，于是"实现读到的长度"与"crypto 实际 hash 的字节数"必然同源。
- 该可信长度同时用于**大小比较、单文件/总预算、安全累加与成功摘要**；长度不符时**先失败、不调用 crypto**。
- 判据拿不到（品牌不符或 getter 不可用）时返回受控的 `payload-entry`，**不是** catch-all 吞异常，也没有为任意对象/Proxy 造通用沙箱，未新增生产测试开关。

红 / 绿（先写永久断言，再改实现）：

| 场景 | 旧实现（红） | 修后（绿） |
|---|---|---|
| 真实 `Uint8Array([65,66])` 覆盖自有 `byteLength=1`，清单声明 1、`maxFileBytes`/`maxTotalPayloadBytes` 均为 1 | **错误成功** `{ok:true,totalBytes:1}`，且期间 hash 调用 1 次 | 受控 `payload-size-mismatch`，hash 调用 **0** 次 |
| 同一视图不覆盖 `byteLength`（对照） | 受控 `payload-size-mismatch`、hash 0 次（本来就对） | 同左（未弱化） |
| `Object.create(Uint8Array.prototype)` + 自有长度 | 原始 `ERR_INVALID_ARG_TYPE` 逃逸 | 受控 `payload-entry` |
| 正常 `Buffer` / 非零偏移子视图（前后各 3 字节哨兵）/ 空文件 | 通过、总量只算视图 | 同左；合法 payload 恰好 1 次 hash |

hash 调用次数在**独立子进程**里包装 `node:crypto` 的 `createHash` 计量（只计数并转发真实实现；fixture 与期望 hash 在计量开始前就绪），不在生产 API 上加开关。

### 9.2 B2：排除条数先于元素访问

`readExclusions()` 在 `Array.isArray` 之后**先要求 `length === 2`**，不等即受控 `invalid-exclusions`，不迭代、不访问元素；数量合格后才核对成员与重复。保留反序接受与规范输出，不 normalize、不排序去重、不新增预算项。

红 / 绿：

| 场景 | 旧实现（红） | 修后（绿） |
|---|---|---|
| `exclusions` 0 / 1 / 3 / 100,001 项（`Proxy` 计数元素访问） | 实际访问 100,001 项后才拒绝 | 受控 `invalid-exclusions`，**元素访问 0 次** |
| 第 2 个元素是抛错 getter 的 3 项数组（哨兵） | 原始异常逃逸 | 受控 `invalid-exclusions` |
| `['locks','cache']` 反序 / 重复 / 未知成员 / `maxIssues=0`·`1` 裁剪 | — | 反序通过；重复与未知仍拒绝；零/一问题额度仍失败且如实计数 |

### 9.3 节点门禁与边界

```text
node --test tests/storageBackupManifest.test.mjs tests/storageBackupPayload.test.mjs → 103 项：103 通过、0 失败、0 skip（D1 原 93 + D1R 新增 10）
npm run typecheck / check:format（77 文件）                                        → 通过
```

- 既有 93 项断言未删除、未放宽；新增用例均真实执行、无 skip。
- 修的只是"已接受对象形态造成的契约错误"，不声称存在真实文件攻击：普通文件读出的未改动 Buffer 行为不变。
- 未测边界沿用 §6；D3/D4 不在本轮范围。节点通过后按 [D1R＋D2 批次](bm02d2_development_plan.md)继续 D2，本批统一交回独立验收。
