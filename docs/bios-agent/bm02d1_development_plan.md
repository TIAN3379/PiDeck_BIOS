# BM-02D1：离线备份协议与纯校验

日期：2026-10-04。状态：**第二十二轮 D1/D1R 通过协议与纯字节校验范围，B1/B2 关闭**，见 [验收](round22_acceptance.md)。当前为 [D2R＋D3 批次](bm02d3_development_plan.md)，不重做 D1R。§1～8 保留原规格与历史修复标准；旧提示词不执行。协议与红绿证据见 [D1 实施记录](bm02d1_implementation.md)。
前置：[第二十轮验收](round20_acceptance.md)确认 C3/C3R 在声明的本机范围收口；当前业务/registry schema v1、audit/intent v1、普通 journal v1 与审核 journal v2 保持。

## 1. 本轮目标与范围

给后续备份导出、校验和恢复建立一份可以测试的协议，避免复制了目录却无法判断缺文件、坏字节或路径逃逸。

本轮交付独立 `backupVersion=1` 的 manifest 契约、纯路径/布局判断、manifest 资源上限校验和**内存中原始字节**的清单核验。建议落点 `core/storage/backup/`，通过存储层窄出口导出，沿用既有类型/校验风格，不引新依赖。

**不做 IO**：不扫描或导出真实库，不创建备份目录，不解压、不恢复、不加锁、不调用初始化/reconcile；无 CLI/UI/模型工具。`backupVersion` 不等于业务 `schemaVersion`，不主动迁移或重写现有记录。

## 2. 后续容器与一致性约定

后续 D2 使用目录式容器：`manifest.json` + `data/` 下的原始文件。暂不做 ZIP、压缩、加密、网络上传或增量备份，避免解压路径、复杂容器和额外依赖。

- 文件保存**原始字节**，不 JSON parse/stringify 后重新写。manifest 的 hash 针对实际 payload 字节，不能拿业务序列化结果冒充。
- 一致性标记固定 `offline-copy`：要求操作者关闭使用该知识根的所有写入者，并在后续入口显式确认离线前提；不伪装成在线全库原子快照。C3 的 `complete` 不能证明没有写入者。
- 正常可恢复备份的后续导出闸门：预检完整、无阻断；活动/遗留锁、`.tmp`、prepared/conflict journal、未知落点或无法解释的文件不得静默忽略后宣称完整。D2 再实现准入与前后变化检查；D1 只定义这项约定。
- cache 与 locks 的**内容**不备份，manifest 明确列出这两项排除，后续新目录恢复只创建空目录。不能把其他业务/审核/journal 工件擅自排除。
- SHA-256 只校验完整性，不提供签名、身份认证或恶意篡改防护。恢复仍需路径、布局和受支持数据版本闸门；hash 相符不代表当前应用能解释文件内容。

## 3. Manifest v1

严格对象，只接收明确字段；未知字段、缺失版本、未来 backupVersion 均拒绝，不“尽力恢复”。建议确定以下唯一结构，不额外放客户名称、源绝对路径、正文或整段预检报告：

```typescript
{
  backupVersion: 1,
  backupId: string,
  createdAt: number,
  consistency: "offline-copy",
  exclusions: ["cache", "locks"],
  directories: string[],
  files: Array<{ path: string; bytes: number; sha256: string }>
}
```

- `backupId` 使用既有可接受的安全 ID 判据；`createdAt` 使用既有合法时间戳范围，不从它推导业务有效时间。
- 所有路径为相对 `data/` 的规范路径，使用 `/`。只接受规范形式，不替用户 normalize 一个危险输入再说安全。
- `bytes` 为安全非负整数，hash 为 64 位小写十六进制；拒绝 NaN/Infinity/小数、溢出和大小写宽松匹配。长度为 0 可表示空 payload，但恢复能否读取另由业务格式闸门决定。
- `registry.json` 必须恰好一次。files 与 directories 不重复；跨两数组不能同路径或存在“文件是另一落点父目录”的冲突。
- 顺序不是有效性的前提，打乱合法数组仍通过。后续生成器采用稳定顺序；不通过排序去消除重复项。
- manifest 的 JSON UTF-8 序列化大小也受限。此处检查内存对象，**不声称**已经限制文件读取或 JSON 解析内存；D2/D3 的实际读入口必须先按字节有界读取。

### 3.1 受控落点

复用当前 ID、文件名及 journal/audit 规则，不复制另一套不一致正则。manifest 只接受以下固定深度：

| 文件 | 允许位置 |
|---|---|
| Registry | `registry.json` |
| 项目档案 | `projects/<projectId>/profile.json` |
| 任务/上下文 | `projects/<projectId>/tasks/<id>.json`、`projects/<projectId>/context/<id>.json` |
| 经验/特性 | `experiences/<id>.json`、`features/<id>.json` |
| Journal | `journal/<operationId>.json` |
| 审核意图 | `audit/intents/<operationId>.json` |
| 审核事件 | `audit/<recordId>/<eventId>.json` |

directories 只允许这些路径的已知目录落点。必需固定目录为 `projects`、`experiences`、`features`、`audit`；`journal`、`audit/intents` 以及项目/任务/context/事件目录按实际存在登记，保留已知空目录。每个文件及子目录的祖先目录必须登记；不要因此假设每个项目都有完整档案或绑定。

`cache`/`locks` 在 exclusions 中表达，不放进 data 清单；后续恢复按布局创建空目录。拒绝未知子目录、任意额外文件、`.tmp`、嵌套 manifest、链接类型以及让特殊目录 `audit/intents` 被解释成普通事件目录的混用。

路径拒绝至少覆盖绝对/盘符/UNC/device 路径、反斜杠、空或 `.`/`..` 段、重复分隔符、前后分隔符、NUL、冒号/ADS、尾点/尾空格及保留名。只接受受控 ASCII 固定段与合法 ID，拒绝大小写变体，避免 Windows 别名冲突。不得自动 URL decode 路径。

本轮纯元数据协议没有链接条目；不能从路径合法推导实际磁盘没有 symlink/junction，那是 D2/D3 的真实 IO 边界职责。

### 3.2 独立资源限额

定义一份可覆盖默认值的 BackupLimits，未知项或非法值在处理数据前拒绝；采用安全整数与明确零值语义。建议默认值：

| 限额 | 默认 |
|---|---:|
| manifest UTF-8 字节 | 2 MiB |
| 文件项 | 10,000 |
| 目录项 | 2,000 |
| 单文件字节 | 16 MiB |
| 总 payload 字节 | 256 MiB |
| 相对路径字符 | 240 |
| 返回问题项 | 50 |

这些是可复现的工程预算，不是性能实测。0 表示不允许该项消耗，不当作无限；manifest 因必需 registry 有最小开销，零/过小预算应明确拒绝。总量累加溢出要在溢出前拒绝，不先做不安全运算；问题裁剪仍明确无效，不把“没空间写错误”当成功。预算耗尽不能返回可恢复的半份清单。

## 4. 纯 API 与错误结果

至少提供两类能力，命名可遵循项目惯例，实施记录写出最终窄契约：

1. `validateBackupManifest(value, limits?)`：从 unknown 校验并返回类型化完整 manifest 或受控失败；不接受任意实例/原型作为可信对象，不写调用者数据。类型/schema 与语义校验共同拒绝重复、布局、父子冲突及总量问题。
2. `verifyBackupPayload(manifest, entries, limits?)`：entries 是内存中的相对路径 + `Uint8Array` 原始字节，无 fs/根路径。确认 manifest 本身有效，然后逐项核对唯一集合、长度与 SHA-256；缺失、多余、重复、错误字节均失败。无需解析业务 JSON，也不把坏业务正文升级成已支持记录。

errors 使用有界受控码与条目索引，不回显恶意路径、客户正文、绝对路径或原始异常。可以返回 droppedIssues/摘要计数解释裁剪，但失败语义唯一明确；不能用类型强转绕过 unknown 收窄，也不依赖数组顺序。成功只表示**清单协议合法/清单与所给字节一致**，不表示已导出、落盘、支持业务版本或可以立即恢复。

纯 API 不承担取消 IO；但按先校验数量/资源边界、再计算 hash 的顺序限制工作量。不要为本轮引入 watcher、队列或新的存储引擎。

## 5. 永久测试与完成标准

使用合成内存 fixture；不读写用户库，不把现有业务格式升版来构造例子。

- 最小合法清单与空已知目录；五类记录、普通/审核 journal、意图/事件路径共存；打乱数组顺序仍通过。
- 严格字段/版本、时间/ID/hash/bytes 与非法限额；每类路径逃逸、Windows 别名及固定目录混用负例。
- 重复路径、跨数组冲突、文件父目录冲突、缺 registry/祖先目录、未知落点与 cache/locks 排除声明不符。
- manifest/条数/单文件/总字节/路径/问题预算的 0、1、恰好足够、差一；总量安全整数溢出；错误裁剪不误报成功。
- payload 缺失/多余/重复、长度正确但 hash 错、hash 格式错误、空文件、中文与换行差异；用独立 `createHash` 与 `Buffer.byteLength` 验证，不用实现自身字段互证。
- 原始字节往返对照：内存中的 CRLF/LF、UTF-8、空白保持，不经 stringify 改写；输入对象/数组/字节不变。
- 未来业务 schema 或损坏 JSON 的原始字节可以满足 payload hash 校验，但明确**未做业务版本准入**；这条对照防止后续把字节一致误当可恢复。

新增测试文件必须被 Package 全量 glob 收录。协议/策略可按职责拆分；单文件目标 400 行，不顺手重构已经通过的预检/写入层。

门禁：Package 中 `node --test tests/<新增backup测试>.test.mjs`、`npm run typecheck`、`npm test`、`npm run selfcheck`、`npm run check:format`；仓库根 `npm run typecheck`、`npm run check:format`、`node --test tests/processGuards.test.mjs`、`git diff --check`。新路径 helper 被现有代码复用时补相关 targeted tests，不为了复用改动旧业务行为。

交付一份 `bm02d1_implementation.md`，记录协议、公开 API、资源/零值/错误口径、实际门禁及未测边界；同步导航/MVP/task/test/log/Package 状态为“D1 实施完成、待独立验收”。不得自行把整个 D、备份恢复或 UI 标完成。（**已交付**：见 [D1 实施记录](bm02d1_implementation.md)。）

保留脏工作树、未跟踪文件和历史删除，不 add/commit/push。现有历史提示词均不重跑。

## 6. 后续闸门，当前不实施

| 阶段 | 下一步能力 | 仍需另行验收 |
|---|---|---|
| D1，本轮 | manifest/布局/字节纯校验 | 不具备任何备份或恢复 IO |
| D2 | 显式离线导出至根外新备份目录，失败不发布完整容器 | 有界读取、links/未知落点拒绝、取消/清理、变化检测、非覆盖发布 |
| D3 | 校验后仅恢复到新空目标目录，不覆盖现有库 | 真实路径边界、业务版本闸门、失败不发布、字节级往返、新进程可读 |
| D4 | 最小人工管理 CLI | 显式 root、参数校验、退出码、有界报告；不注册模型批准工具 |

D2 详细规格现已纳入 [D1R＋D2 批次](bm02d2_development_plan.md)；先完成 D1R 节点回归再开发 D2。D3/D4 待前置统一验收后安排。D 完成后再做 M1/M2，BM-03～05、Pi 工具和 BM-07 UI 保持原顺序；不引入 RAG、向量库或自动学习作为当前前置。

## 7. 简短交接提示词

```text
在 D:\BIOS_Pi_Agent\PiDeck_BIOS 的 BIOS_Agent 分支开发。
先完整读 AGENTS.md，再读 docs/bios-agent/round20_acceptance.md、bm02d1_development_plan.md。
C3/C3R 已通过声明的本机范围，PF-1～PF-4、S1～S3 不重做。
只做 BM-02D1：独立 backupVersion=1 manifest、受控路径/布局与资源上限纯校验，
以及内存原始字节的清单/长度/SHA-256 核验；严格 unknown 输入、受控有界错误。
补方案指定永久回归，跑门禁，写 D1 实施记录并同步状态，交回独立验收。
不做导出/恢复 IO、CLI/UI/记忆，不升业务schema、不改PiRuntime/Electron，
不读客户资料，保留脏工作树与历史删除，不提交推送，不执行历史提示词。
```

## 8. 当前唯一任务：BM-02D1R

本节标题和锚点保留第二十一轮的历史接续安排；B1/B2 已由第二十二轮关闭，不再执行本节。§8.1～8.3 保留原完成标准；当前整批执行入口是 [D2R＋D3](bm02d3_development_plan.md)，下面“当前”均指当时的历史状态。

依据：[第二十一轮验收](round21_acceptance.md)。当前常规门禁为 516 项/513 通过/0 失败/3 权限 skip，D1 新增 93 项全部执行；但额外诊断发现 B1/B2，D1 不因此算通过。C3/C3R 与更早收口结论保持。

D1R 节点只改 backup 纯校验、相应测试和文档；其回归通过后按新批次顺序开发 D2。保留 `backupVersion=1`、业务/registry v1、audit/intent v1、普通 journal v1 和审核 journal v2。不做 D3/D4、重写底座、CLI/UI/Pi 工具或记忆。

### 8.1 B1：真实视图品牌与长度先于 hash

- 不再只凭 `instanceof Uint8Array` 和可覆盖的 `.byteLength` 信任字节。确认真实 Uint8Array/Buffer 内部品牌，长度必须取实际视图口径，不能来自用户自有属性或 getter。无需扩展支持更多 payload 类型。
- 正常 Buffer、Uint8Array 和非零偏移子视图保持；hash 只处理视图覆盖的字节，不能把整个 backing buffer 或其前后哨兵算进去。
- 用同一可信长度做大小比较、单文件/总量预算、安全累加与成功摘要；先处理长度/预算失败，再做 crypto，不 hash 已知失败的大字节。
- 两字节覆盖 `byteLength=1`、清单声明/预算均为 1 的原复现必须受控失败，不能返回总量 1 的成功。
- 仅挂 Uint8Array 原型的假视图必须受控失败，不让 `ERR_INVALID_ARG_TYPE` 等原始异常逃逸。不通过 catch-all 吞掉取消/其它域错误，也不引入任意 Proxy 的通用沙箱。

### 8.2 B2：排除条数先于元素访问

`readExclusions()` 在确认数组后，先要求 `length === BACKUP_EXCLUDED_DIRECTORIES.length`；不等时立即给受控失败，不迭代、不访问元素。数量合格后才核对成员/重复；保留反序接受与规范输出，不 normalize、排序去重或增加新预算项。

### 8.3 永久回归与红绿证据

先加入能在旧代码上失败的断言，再实现修复，记录实际红绿结果；不能把上述错误成功改写成期望通过。

- B1 原复现：真实两字节、声明和预算均为 1，覆盖自有 `byteLength` 后仍拒绝；可附 getter 计数，证明判据不依赖该属性。准备 fixture/hash 的工作不混入核验计量。
- B1 原型伪装：`Object.create(Uint8Array.prototype)` + 自有长度，返回受控失败而非原始异常。正常 Buffer/Uint8Array、非零偏移 view、空文件继续通过，摘要用独立可信长度重算。
- B1 先边界后 hash：长度不符或实际字节超预算的负例，观测核验期间 hash 未调用；正常合法对照仍实际计算且只有一次。允许隔离子进程包装 builtin 并转发真实实现，不新增生产 API 的测试开关。
- B2 0/1/3/100,001 项均失败；用元素访问/迭代器计数或哨兵证明数量不符时不访问元素。不能只证明最终失败或只测运行时间。`maxIssues=0/1` 的错误裁剪仍失败且脱敏。
- B2 合法两项正序/反序继续通过；两项重复、未知成员继续拒绝。输入数组/字节内容不变。

D1R 节点先跑 Package 两个 backup targeted、类型和格式，通过后继续 D2；本批交回前再按 [新批次 §6](bm02d2_development_plan.md#6-验证与交付一次完整验收)完整复跑门禁。保留既有 skip，不通过删除断言或放宽 schema 降低门禁。

### 8.4 完成交付

在 `bm02d1_implementation.md` 追加 D1R 实施节，记录 B1/B2 的策略、旧红新绿及节点门禁，不改写独立验收事实。节点通过后继续 D2；整批完成时写 D2 实施记录，并同步为“D1R＋D2 已实施，待统一独立验收”。不要把节点自测当独立通过，也不要自行声明整个 D 完成。

保留当前脏树、未跟踪文件和六项历史文档删除，不 add/commit/push。不读取真实知识库或客户资料，本轮用合成内存 fixture。

### 8.5 简短交接提示词

以下为第二十一轮原提示词，**已被 [新批次 §8](bm02d2_development_plan.md#8-给开发-ai-的简短提示词)替代，不执行**。

```text
在 D:\BIOS_Pi_Agent\PiDeck_BIOS 的 BIOS_Agent 分支接续。
先完整读 AGENTS.md，再读 docs/bios-agent/round21_acceptance.md 与 bm02d1_development_plan.md §8。
只做 BM-02D1R：B1 真实 Uint8Array/Buffer 品牌与实际视图长度核验，拒绝长度伪装/假视图；
B2 exclusions 恰好两项的数量边界先于元素访问。补指定永久回归及旧红新绿，复跑全部指定门禁。
追加 D1R 实施记录并同步状态为待独立复验。C3 已收口，不重做；不做 D2～D4/CLI/UI/记忆，
不升 schema、不改 PiRuntime/Electron，不读客户资料，保留脏树与历史删除，不提交推送。
```
