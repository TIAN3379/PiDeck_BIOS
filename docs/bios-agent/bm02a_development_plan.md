# 下一轮开发：G1 小修 + BM-02A 存储基础与 registry

日期：2026-10-01。前置结论见 [第三轮历史摘要](acceptance_history.md#第三轮与-g1)，整体目标沿用 [MVP 方案](mvp_development_plan.md)。本文为已实施的历史需求依据。

> 后续状态：本任务及 G1/存储基础收尾已闭环。本文保留为原始需求依据，当前执行 [next_development.md](next_development.md)，不重新开发整个存储层。

## 1. 本轮目标与顺序

本轮只建立“初始化知识库 → 有界读取经过校验的记录 → 新进程读取同一结果”的基础。不要求现在完成自动跨平台移植或完整长期记忆体验。

1. 修复 G1 目录句柄清理，新增回归，先跑 Package 门禁。
2. 门禁通过后直接进入 BM-02A，不必为这个小修另起整轮开发。
3. 定义 registry 契约和类型化 Storage 接口，复用现有 ID/版本/记录校验。
4. 实现受控初始化、真实 IO 边界、有界读取/列表、结构化错误。
5. 用自建临时数据验证重启读取和损坏保护，更新开发记录后停止扩展范围。

若 G1 未闭环，先解决，不以“测试退出码 0”代替资源回收验收。

## 2. 允许改动与非目标

允许：`packages/bios-agent/core/contracts/`、`core/storage/`、相关 paths/probe 的必要小调整、包内测试及 BIOS 文档。现有工具/Skills 不应重复注册，不引入第二份 Pi Runtime。

本轮不做：

- Pi 内核 fork、LangChain、HTTP 服务、SQLite/向量库、RAG。
- Electron/IPC/preload/renderer UI 或内置扩展打包。
- 厂商/芯片/板卡识别、构建、烧录、串口、自动移植。
- 档案/经验/任务的通用 create/update/delete 工具、经验审核、模型自动写知识。
- 完整 expectedRevision 更新协议（BM-02B）、journal/迁移恢复（BM-02C）、管理 CLI/备份恢复（BM-02D）。

唯一生产写能力是显式初始化所需的目录和空 registry。既有文件不覆盖；测试 fixture 的构造不是生产写 API。registry 的绑定解析可以完成，但新增/改绑的持久化更新留到 BM-02B。

## 3. 模块与接口要求

### 3.1 Storage 的类型边界

推荐落点 `core/storage/`，按实际职责拆分，不强制文件数量。core 不导入 Electron、React 或 Pi Session。

提供语义清楚的接口，命名可调整：

| 接口 | 本轮行为 |
|---|---|
| `initializeKnowledgeStore` | 显式初始化；已存在则校验后返回 existing，不覆盖 |
| `readRegistry` | 有界读取，版本/结构/绑定约束校验 |
| `readRecord` | kind + ID（任务还需 projectId）定位、限额读取和校验 |
| `listRecords` | 有界发现和摘要，不一次返回全部正文 |
| `resolveProjectBinding` | 根据已有 registry 明确解析绑定/缺失/冲突，不按相同远端猜合并 |

从 schema 推导类型。按 kind 返回对应记录类型，避免 `any`、盲目 cast、成功结果中的“失败”字符串；不复制一套与现有 contracts 分叉的类型。错误可沿用抛结构化异常或带判别字段的结果，但保持一致。

### 3.2 registry 契约

采用主文档的 `registry.json`，在 contracts 中补充 schema 和推导类型：

- 明确 schemaVersion、revision、时间等头字段，复用已定义的通用字段及规则。
- 对应关系可表示桌面 projectId（没有桌面 ID 时允许独立 CLI）、规范化绝对工作区路径、稳定 biosProjectId、workspaceId。
- 项目/工作区 UUID 与现有 ProjectProfile/workspaces 一致；同一工作区不允许出现互相矛盾的归属，重复绑定和非法路径报错。
- 同一个 biosProjectId 可有多个 workspace；不同目录不因为同远端自动合并。
- registry 只负责索引/绑定；不要再维护一份独立 branch/HEAD 真相，与 ProjectProfile 的工作区快照分叉。
- 路径暂时不可达不删除绑定；移动目录需要未来显式改绑，不能只按文件夹名重新生成 ID。

若需调整已存在但尚未发布的 v1 契约，必须记录差异。不能因为目前没有正式数据就写自动覆盖未来版本的逻辑。

### 3.3 真实 IO 边界

- 复用完全限定知识根解析；默认 home/桌面显式 userData 路径保持一致，不引入新盘符假设。
- 所有操作从受控 kind/ID 派生路径，生产 API 不接受模型任意传文件名或绕过布局的绝对路径。
- 校验真实知识根、内部目录和最终记录文件，处理符号链接/junction。可选择拒绝内部链接这一简单策略；政策须写清并覆盖根内指向根外的目录及最终文件链接。
- 初始化也受同一边界约束，不能先写入再检查。不存在的目标按已存在父目录检查，不能只在 read 上做 realpath。
- 权限不足、目标为目录、不可达根等有明确失败结果；拒绝时不读取/返回根外正文，不写根外文件。
- 明确 Windows 常规盘符/UNC 路径支持与特殊设备命名空间策略；只承诺实测范围。
- 不宣称 realpath 检查提供操作系统级沙箱；记录检查与操作间竞态及信任假设，不无声跟随未知链接。

### 3.4 初始化与损坏保护

- 显式初始化创建所需布局和合法空 registry；重复执行不重置 revision、时间或绑定。
- 已存在的无效 JSON、未知 schemaVersion、结构错误、超大文件或链接不能被“修复”为新空库，原文件字节保持不变。
- 发布 registry 使用不会覆盖已存在文件的方案；单独 `exists` 后 `writeFile` 不合格。
- 两个进程首次初始化同一个根：一个创建，另一个读到完整合法的已有 registry，或得到明确可重试的初始化竞争结果；不能产生空/半写 JSON 或互相覆盖。
- 可使用同目录临时文件 + 非覆盖发布，或最小初始化互斥。记录失败时临时文件/锁的处理，不实现“启动自动删锁”这种危险恢复。
- 初始化只处理初始创建，不借机开放普通记录更新或偷跑整套 BM-02B/C。

### 3.5 有界读取、列表与错误

- 先限制输入字节，再 JSON 解析；检查文件大小但随后无界 readFile 仍存在增长竞态，要有实际读取上限并关闭 FileHandle。
- 版本闸门先于当前 schema 解释；文件 ID、请求 ID、记录内 ID 必须一致。任务的 projectId 必须与所在项目一致。
- 列表明确 maxEntries/maxBytes（或等价预算）、取消、扫描截断原因、条目异常；超限不能装成完整结果。
- 不把一个损坏条目默默当成“不存在”，也不把任何 IO 失败转换为空数组。整体错误与单条问题应可区分。
- 配置合理有限默认值，并允许测试用更小预算；不强制一次读取 2,000 条经验正文。未知版本只返回可安全解释的元信息/错误，不猜字段。
- 至少可区分 not-found、invalid-root/path-escape、permission-denied、invalid-json、invalid-record、unsupported-schema-version、record-id-mismatch、too-large、cancelled，以及初始化竞争/绑定冲突。
- 所有成功、取消、超限、解析失败路径都释放文件/目录句柄；异常信息不夹带客户正文。

## 4. 必须完成的自动化验收

| 场景 | 必须证明 |
|---|---|
| G1 打开目录期间取消 | cancelled，拒绝前资源已关闭；重复取消不触发 GC 关闭句柄警告 |
| 正常完成/预算截断/迭代中取消 | 扫描行为不退化，清理正常 |
| 空库初始化两次 | 第二次 existing；registry 原字节/revision 不变 |
| 新进程读取 | 初始化/fixture 准备后，用新 Node 子进程读取同一根，得到相同 ID/revision |
| 两子进程同时初始化 | 不覆盖，不发布半文件；若返回竞争错误，可重试得到合法 existing |
| 有效记录读取 | 五类现有记录按对应 schema 校验，类型与 kind 对应；列表按预算返回摘要 |
| 损坏与未知版本 | 初始化/读取明确拒绝，前后文件 hash 相同 |
| 超大或读取中增长文件 | 实际读取上限生效，失败不泄漏 FileHandle |
| ID/路径/项目不匹配 | 拒绝，不能凭合法 JSON 返回错项目记录 |
| 内部目录/最终文件链接逃逸 | 初始化及读取均拒绝；外部 sentinel 原字节不变，无根外正文泄漏 |
| 缺失/权限/非文件/取消 | 可解释错误，不伪装成功；权限或链接用例未能执行要显式记为未测 |
| 绑定边界 | 同项目两工作区、相同远端不同项目、无桌面 ID、缺失路径、矛盾绑定均有明确结果 |

只用自建临时 fixture，不读取或修改客户 BIOS 资料。GC 观察用作诊断/补充，资源回归应优先用可控的等待时序和资源生命周期断言；不要依赖不确定的 GC 时机作为唯一断言。两进程测试要真的 spawn，不能只用同进程 Promise.all。

Package 门禁：typecheck、check:format、test、selfcheck。根 typecheck/check:format 和 processGuards 定向回归；如新增跨域桌面代码则超出本轮范围，先说明，不自行扩张。测试不能用 skip 冒充宿主装载通过。

## 5. 交付要求与后续

交付源码、永久回归、README 接口/限额/链接政策说明；更新 task_breakdown、development_log、test_checklist。说明真正执行的平台/命令/用例数、未验证项和初始化发布协议。

至少给出一份本机离线演示：初始化临时库 → 放入自建合法 fixture → 新进程读取 → 损坏记录读取失败且原字节不变。可先用测试驱动，不要求现在新增完整 CLI。

本轮成功后才进入 BM-02B：expectedRevision、跨进程可取消锁与原子更新；随后 BM-02C journal/迁移，BM-02D 管理/备份。BM-02A 通过不代表“长期记忆产品可用了”。不擅自提交、推送或发 Release。

## 6. 可直接交给开发 AI 的提示词

```text
请在 D:\BIOS_Pi_Agent\PiDeck_BIOS 当前 BIOS_Agent 工作区开发。
先完整阅读 AGENTS.md、docs/bios-agent/mvp_development_plan.md、
docs/bios-agent/acceptance_history.md、docs/bios-agent/bm02a_development_plan.md，
核对当前源码和 git 状态。已有修改/未跟踪文件均保留，不 reset、不擅自提交或推送。

本轮目标限定为：先关闭 G1 目录句柄清理遗漏，再实施 BM-02A 存储基础与 registry。
F1～F4 功能已经通过，不要重做 Package/Pi 架构。
G1 是 probe.ts 成功 opendir 后的取消检查位于 try/finally 外面；
修复并新增资源生命周期回归，不能只断言 cancelled，也不能吞取消。
小修门禁通过后直接继续本轮 BM-02A，不必另开整轮整改。

按 bm02a_development_plan.md 的接口、真实 IO 边界、初始化非覆盖发布、
有界读取/列表、registry 契约和验收矩阵实施。
生产写能力仅限显式初始化空库；普通记录与绑定更新留给 BM-02B。
数据校验复用 core/contracts，类型从 schema 推导；所有资源有可靠清理。
真实 spawn 两进程验证初始化竞争，并用新进程证明可重启读取。
损坏/未来版本/超大/链接逃逸记录必须拒绝且不改原字节。

不改 Pi 内核、不加 LangChain/HTTP/RAG/数据库、不做桌面 UI/厂商识别/构建烧录，
不扩展到 BM-02B/C/D。只用自建临时数据，不接触真实客户 BIOS 代码。
运行包内类型/格式/测试/selfcheck 与根定向回归，记录警告和未验证范围。
更新 README、任务表、日志、测试清单，并新增本轮实施说明；
区分实施方自测与独立验收、本地文件与已提交/远端 CI 状态。
完成上述范围后停止，交回验收。
```
