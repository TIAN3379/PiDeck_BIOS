# BM-02A 实施说明（G1 修复 + 存储基础与 registry）

日期：2026-10-01

> 后续独立验收：G1 关闭，89 用例中 88 通过、1 权限 skip；但故障注入及异常数据补查发现 S1～S5。以下是实施方自测/设计记录，当前验收结论以 [第四轮报告](round4_acceptance.md) 为准；下一轮按 [BM-02AR 收尾任务](bm02a_remediation_plan.md) 执行。
范围：`round3_acceptance.md` 的 G1 小修，加 `bm02a_development_plan.md` 定义的 BM-02A。
不包含 BM-02B/C/D（写事务、锁、journal、迁移、管理 CLI），也不含桌面 UI、厂商识别、经验系统。

**交付性质**（与验收方口径一致）：以下都是**本地实施 + 本机自测**结果。
`packages/`、锁文件与文档仍未跟踪，CI 有本地配置改动——"CI 已接入"≠"远端 CI 已绿"。

## 1. G1：取消时跳过目录句柄关闭

**问题**：`probe.ts` 中 `await opendir()` 成功后的取消检查位于 `try/finally` 之外；
取消恰好落在该检查点时，`finally` 不会执行，目录句柄只能等 GC 关闭。

**修复**：把该检查移入 `try` 内部——**成功拿到句柄之后的所有可能抛错路径都在关闭保护范围内**；
`opendir` 失败仍按原规则记 warning，`cancelled` 不被吞成成功。

**回归**（`tests/probe.test.mjs`）：

| 用例 | 断言方式 |
|---|---|
| 取消时句柄必须已关闭 | 注入包装过的 `openDirectory` 记录 open/close，取消后断言 `closed === opened`（**确定性**，不依赖 GC） |
| 正常完成 + 预算截断 | 同样断言 `closed === opened` |
| 迭代中取消（300 项大目录） | 同样断言 `closed === opened` |
| GC 诊断（复现验收场景） | 子进程 `--expose-gc` 跑 3 次取消后显式 `gc()`，断言无 "Closing directory handle on garbage collection" 警告 |

## 2. BM-02A 交付物

| 模块 | 职责 |
|---|---|
| `core/contracts/registry.ts` | `RegistrySchema` + 推导类型 + 空库工厂 + 版本闸门；registry 只存绑定关系，不复制 branch/HEAD |
| `core/storage/errors.ts` | 结构化错误码 + Node errno 映射 + 取消检查出口 |
| `core/storage/limits.ts` | 可注入限额与默认值 |
| `core/storage/boundary.ts` | canonical 知识根、根内链接拒绝、有界读取、非覆盖发布、目录布局创建、有界列目录 |
| `core/storage/registry.ts` | `initializeKnowledgeStore` / `readRegistry` / `resolveProjectBinding` + 绑定一致性校验 |
| `core/storage/records.ts` | `readRecord` / `listRecords` + 受控路径派生 + ID/项目一致性 |
| `core/storage/index.ts` | 统一出口 |

## 3. 关键设计取舍（与计划要求的对应）

- **只读 + 显式初始化**：唯一生产写能力是初始化时创建布局与空 registry；
  重复初始化返回 `existing`，registry 原字节不变。普通记录写入留给 BM-02B。
- **非覆盖发布**：同目录临时文件 → `link()`（目标已存在即 `EEXIST`）→ 删临时文件；
  不支持硬链接时回退 `O_EXCL`。不使用"`exists` 后 `writeFile`"。
- **链接策略**：根自身允许 realpath 解析；**根内符号链接/junction 一律拒绝**（含最终文件）。
  选择"全拒"而不是"跟随并比较"，是因为本进程无法消除检查与操作之间的竞态，
  而本轮写入面极小；**硬链接不在覆盖范围**，已在 README 明确。
- **有界读取**：先 `stat` 限字节，再按上限（+1 字节）读取以检出"读取期间增长"，
  所有路径关闭 `FileHandle`。
- **一致性**：文件位置（kind + ID）、记录内 `id`、任务的 `projectId`/清单的 `targetProjectId` 必须一致，
  否则 `record-id-mismatch`——一个格式合法的 JSON 不能冒充别的项目记录。
- **列表**：`maxListEntries` / `maxListBytes` / `maxScanEntries` 三档预算 + 截断维度；
  单条损坏进入 `problems`（可区分），既不整体失败，也不当成"不存在"。

## 4. 验收矩阵对照

| 计划要求的场景 | 证据（测试用例） |
|---|---|
| G1 打开目录期间取消 | probe：句柄计数 + GC 诊断（见 §1） |
| 正常完成/预算截断/迭代中取消不退化 | probe：原有 10 个用例 + 3 个句柄断言 |
| 空库初始化两次 | storageRegistry：「重复初始化：返回 existing，registry 原字节与 revision 不变」 |
| 新进程读取 | storageRegistry：「新进程读取同一知识根」（真实 `spawn` 子进程） |
| 两子进程同时初始化 | storageRegistry：「两个真实子进程同时初始化：不产生半文件、不互相覆盖」（真实 `spawn` ×2，断言最终文件可解析、最多一个 created） |
| 有效记录读取（五类） | storageRecords：「五类记录都能按 kind + ID 读取并校验通过」 |
| 列表按预算返回摘要 | storageRecords：「有界列表：按条数预算截断，损坏条目进入 problems」「项目内记录的列表只扫描该项目目录」 |
| 损坏与未知版本（hash 不变） | storageRegistry：损坏 registry / 未来版本；storageRecords：`invalid-json` / `unsupported-schema-version`（均已断言 hash 不变） |
| 超大或读取中增长文件 | storageRegistry：「超过字节上限的 registry」；storageRecords：「超过单条限额的记录」 |
| ID/路径/项目不匹配 | storageRecords：`record-id-mismatch` 两条（内容 ID、任务 projectId） |
| 内部目录/最终文件链接逃逸 | storageRecords：根内 junction 指向根外（通过，且外部 sentinel hash 不变）；**最终文件链接在本机因 EPERM 显式 skip** |
| 缺失/权限/非文件/取消 | storageRecords：`not-found`、`not-a-file`、`cancelled`；权限失败用 `permission-denied` 映射（未在本机造出真实权限失败，见 §5） |
| 绑定边界 | storageRegistry：「resolveProjectBinding：缺失、命中、多项目冲突、无查询条件」；storageRecords：「绑定边界：同项目两工作区…」 |
| 离线演示（初始化→fixture→新进程读取→损坏拒绝） | `npm run selfcheck` 的「存储离线演示」项 + storageRegistry 的重启读取用例 |

## 5. 未验证与未测（明确边界）

- **文件型符号链接用例在本机被 skip**（Windows 需要开发者模式/管理员权限创建 file symlink），
  skip 原因写入测试输出；目录 junction（更常见的逃逸形态）已实际执行并通过。
- **真实权限失败（EACCES）未在本机造出**：`permission-denied` 的映射由代码与 errno 表覆盖，暂无实测用例。
- **告警上限触顶**仍未实测（第三轮验收已指出），只有不变量断言。
- **未运行**：Linux/macOS、完整干净 clone 的独立工具链、远端 GitHub Actions、根全量测试、生产构建、安装包 smoke。
- **未实现**：expectedRevision 更新、跨进程锁、原子替换（BM-02B）；journal/迁移恢复（BM-02C）；管理 CLI/备份恢复（BM-02D）；
  经验检索、上下文预算、桌面 UI、真实 worktree 绑定。

## 6. 本轮测试统计

`npm test`（包内，Windows + Node 24.14.1 + Pi 0.87.1 实测）：

- **89 个用例：88 通过、0 失败、1 显式 skip**（文件符号链接权限）。
- 分布：authorization 13、contracts 15、extensionLoad 8、paths 14、probe 14、storageRecords 15、storageRegistry 10。
- 另有 `selfcheck` 6 项（含存储离线演示）、`check:format` 25 文件、根 `typecheck` / `check:format`、
  `tests/processGuards.test.mjs` 2 项通过。
