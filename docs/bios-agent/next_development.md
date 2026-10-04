# 开发入口与 BM-02BR 完成标准留档

更新：2026-10-04（第二十九轮独立验收后）。[验收](round29_acceptance.md)：732 项（727 通过、0 失败、5 skip）及指定门禁通过，BM-04 正常业务已交付，但 R29 四组阻塞整批通过。当前执行 [R29 收尾＋BM-05 完整任务/上下文批次](bm05_development_plan.md)，内部过闸后直接交任务事实/重开、人工交接包/Manifest 重验与经验草稿沉淀，一次交回；不升 schema、不重做历史底座、不提前 UI/Session 注入。下文 BR 标准与旧提示词只留档。

收尾状态（同日更新）：W1～W4 与交接 R1～R4 均已实施完成，包内实跑 183 用例（181 通过、0 失败、2 个符号链接权限 skip）、格式通过；
已由第七轮独立复跑确认，状态为"声明的本机范围内通过"；实现取舍见 [BM-02BR 实施记录](bm02br_implementation.md)。
本文 W1～W4 是原始完成标准，第 2 节的开发步骤与第 5 节提示词**已完成、不要重跑**；[中断交接](bm02br_handoff.md) 保留为历史快照。
当前交接提示词使用 [BM-05 批次 §7](bm05_development_plan.md#7-新对话简短交接提示词)。先收口 R29 后同一对话交完整任务业务，不等单项独立验收；旧恢复/记忆/BM-03/BM-04 提示词不再执行。M2 格式升级/迁移未批准。

## 1. 目标与范围

关闭 W1～W4，保留已通过的五类写入、真实并发锁与原子可见性。每组先加失败回归，再做最小修复，全部完成交回独立验收。

这轮不重新开发 BM-00/01/02A，不实现 journal、迁移、备份 CLI、删除、UI、经验检索、RAG、厂商适配、模型写工具或 Pi 内核改造。不要“修两项就顺手把剩余所有阶段做完”。

## 2. 按顺序开发

### W1：统一安全 revision（P1，先做）

- expectedRevision 使用安全非负整数守卫；create 的 null 语义保持。
- 当前记录/registry 的 revision 同样要求安全；更新 +1 前检查上限。
- registry 复用公共头生成，保留 createdAt/schemaVersion，updatedAt 不倒退；不要复制另一套溢出逻辑。
- 先加 registry `MAX_SAFE_INTEGER` 与已不安全整数失败用例，再补记录和 expectedRevision 非法值。所有拒绝原 hash 不变；不能把 schemaVersion 升级当作溢出修复。

### W2：锁参数、诊断、取消（P2）

- 写入口和直接公开 `acquireStorageLock` 都校验 timeout/poll/now，避免较低层旁路。参数类型、NaN、Infinity、负数、非整数、超出安全/定时器/Date 范围应结构化拒绝。
- 明确合法范围：timeout=0 可表示只尝试一次；poll 必须正数，拒绝忙等；默认值不变。等待不能因 poll 超长或参数非法变成无界。时间戳允许范围在 README 写清。
- 所有输入可完成的守卫在取锁/写元数据前执行；托管字段/正文形态先行检查，完整新头/记录 schema 仍在锁内执行。
- 锁元数据是非可信诊断数据：无效日期/字段不抛 RangeError，字段长度受限，不泄漏正文；损坏时继续按忙碌处理，不抢占。
- 普通等待读诊断的 catch 必须传播取消；等待返回后、超时决定前复查两个 signal。释放专用读取继续忽略取消，不能又制造永久锁。
- 回归：非法选项入口拒绝且无新锁/目标；极端元数据有界超时；lock-read 期间 abort 与 deadline 同时成立仍 cancelled；两个 signal 任一取消有效。

### W3：完成准备/发布/清理闭环（P2）

- 区分“正常提交前 close”和“异常路径 finally 的尽力关闭”：前者失败中止提交，后者不能覆盖首个错误。
- 记录创建恢复为非覆盖发布：完整、受预算的同目录临时文件 + sync + close + link；目标存在映射冲突，不支持 link 明确 publish-unsupported。更新继续原子 rename，不先删旧文件。
- 可抽共用临时文件准备/提交 helpers，保持现有初始化和 B0 接口兼容；不要为不同 kind 各造写入路径。
- 失败后的临时删除或自有锁释放失败，附加有界 cleanup 诊断/警告；保留原始 code，不在 error/cause 中附带客户正文。提交成功后不能把迟到取消/清理失败改写为未提交。
- 新增 close 失败（实际先关后抛亦可）、清理失败、创建发布窗口和竞争目标已出现用例；明确 FileHandle open/close 生命周期，在诊断进程结束前无依赖 GC 的遗留句柄。
- 原 boundary 已 659 行；本轮评估拆成读取与提交模块，保持 exports 兼容，不做跨层大重构。已有用户 Git 工作树是回退依据，禁止为拆分自动 commit/reset。

### W4：有效知识库准入（P2）

- 普通 create/update 写入前用现有有界 registry 读取、版本闸门、结构和绑定检查确认库有效，不能仅凭文件存在。
- 缺失、坏 JSON、未来版本、目录/链接、非法绑定均明确拒绝；拒绝前不创建业务目录、锁或记录，原字节与根外 sentinel 不变。
- 补坏 registry 与未来 registry 下 create/update 的永久用例；保留当前“未初始化拒绝”和独立 registry update 的语义。
- 不新增整库串行锁或声称消除跨文件竞态；journal 和多文件一致性留 BM-02C。

## 3. 完成标准

140 用例基线（139 通过、1 文件符号链接权限 skip）不削弱、不删永久测试。全部 W1～W4 诊断改为回归；按测试数量与实际结果报告，不指定必须凑到多少条。

```powershell
# packages/bios-agent
npm run typecheck
npm test
npm run selfcheck
npm run check:format

# 仓库根
npm run typecheck
npm run check:format
node --test tests/processGuards.test.mjs
git diff --check
```

真实双子进程竞争、并发读取、非空新进程读取、正常/中途取消、根内 junction 都要继续实跑。故障注入不冒充真实磁盘故障；文件符号链接权限 skip 不写成通过。根全量构建/安装包和远端 CI 未执行就明确标注。

更新 README、任务/测试/日志，新增一份 `bm02br_implementation.md`；不再新增多份彼此重复的整改/下一步文档。报告现有 Git 修改与未跟踪文件的真实情况。未经用户要求不 add/commit/push。

## 4. 再下一步：BM-02C，暂不实现

复验 W1～W4 通过后，优先开 **BM-02C1 单文件 journal/崩溃恢复**，而不是一次做完事务、迁移、备份和 UI。

- 写入前保存有界、完整的准备记录，包含 operationId、受控目标、前后 revision/hash、提交状态；恢复不根据任意绝对路径写文件。
- 数据提交是明确提交点；提交后 journal 更新失败报告“已提交、需要恢复”，不能诱导调用方重复加 revision。
- 重启按真实目标的 hash/revision 判断未提交、已提交或冲突；恢复幂等，不能覆盖后续合法更新，不能凭年龄/PID 自动删活动锁。
- 以真实子进程在“准备后/目标提交前/目标提交后/日志终态前”终止并重新读取做验收，明确进程崩溃与断电不是同一保证。
- BM-02C2 再处理审核审计、多文件事务与版本迁移；BM-02D 再给出离线管理和备份恢复入口。

以上是路线，不是授权当前开发 AI 提前实施 C1/C2/D；详细 journal 协议待收尾独立复验后确定。

## 5. 历史 BR 提示词（已完成，不再执行）

```text
在 D:\BIOS_Pi_Agent\PiDeck_BIOS 的 BIOS_Agent 工作区执行 BM-02BR。
先完整读 AGENTS.md，检查 git status，保留所有已有修改和未跟踪文件。
再完整读 docs/bios-agent/round6_acceptance.md 与 next_development.md。
docs/bios-agent/README.md 是文档导航；旧轮次问题不要重新开发。

当前 140 用例：139 通过、1 文件符号链接 EPERM skip。B0 已独立通过；
五类写入、正常版本冲突、真实双进程竞争与完整读写可见性已成立。
这轮只按 W1～W4 收尾，每组先写复现回归再修：
W1 registry 和记录共用安全 revision/头生成，拒绝非法计数和溢出；
W2 校验锁/时间选项，坏锁诊断不抛裸异常，等待取消穿透且不被超时覆盖；
W3 正常 close 失败不提交，create 恢复完整临时文件的非覆盖发布，
   更新仍原子 rename；错误路径清理失败可诊断，不掩盖原错或假称回滚；
W4 普通写入要求有效 registry，不仅检查存在性，损坏/未来版本拒绝。

不得恢复直写最终文件的 wx 回退，不自动抢占过期锁，不用进程内队列
冒充跨进程锁。评估拆分超过 600 行的 boundary，但不重构桌面/Pi。
复跑第3节门禁和真实进程/生命周期测试；明确 skip、未测及故障注入边界。
更新 README、任务、测试、日志，只新增 bm02br_implementation.md 实施说明。
不做 journal/迁移/备份CLI/UI/RAG/厂商适配/模型写工具，不读真实客户资料。
不自动继续 BM-02C；不 git add/commit/push，交回独立验收。
```
