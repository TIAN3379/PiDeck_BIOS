# 下一轮开发：BM-02B 单记录安全写入

日期：2026-10-01。前置：[第五轮独立验收](round5_acceptance.md)。

> 历史需求依据：BM-02B 已开发并完成[第六轮复验](round6_acceptance.md)，主流程成立但 W1～W4 未关闭。当前只执行 [next_development.md](next_development.md)，不重复整轮 B0～B4；本文保留用于契约/设计追踪。

## 1. 要交付什么

让知识库从“能初始化和读取”推进到“多个进程能安全创建/更新记录”。这为之后保存项目档案、任务和经验提供基础，**还不是桌面知识管理功能**。

本轮只做：B0 发布取消修复、五类记录 create/update、registry 单文件 update、expectedRevision、跨进程锁、有界完整提交及测试。按 B0～B4 顺序实施，完成后交回验收，不自动继续 BM-02C。

不做：删除记录、自动绑定/档案联动、审核业务、journal、迁移、备份 CLI、UI、RAG、厂商识别、模型写工具、Pi 内核改造和真实客户 BIOS 修改。尤其不把“registry 更新成功”说成“registry+profile 事务成功”。

## 2. B0：先补最后一个取消缺口

修复 `StorageBoundary.publishJson`，实际接收 `callSignal`，沿用 `throwIfAnyCancelled`，boundary signal 与 callSignal 任一取消都生效。

- 入口、路径检查/临时写等待之后、提交钩子等待之后且提交 IO 发起之前检查取消。
- 取消错误不得被普通 FS catch 改写成 `permission-denied`；沿用取消穿透规则。
- 提交前取消不创建目标，`finally` 仅清理本次临时文件。
- 提交 IO 发起之后可能已经生效；成功后报告已提交，不因迟到的 abort 假称回滚。

至少先添加三个失败回归：只取消 callSignal；`beforeIo("link")` 等待期间取消；link 成功后取消仍报告真实 created。同时覆盖两个 signal 的任一取消，不用 `callSignal ?? boundarySignal` 隐藏另一信号。

## 3. B1：写入入口与版本语义

接口名可按代码风格调整，但必须先在 README 写清参数、返回和错误，再实施：

| 入口 | 必需条件 | 成功行为 |
|---|---|---|
| `createRecord` | kind、ID、必要 projectId、业务数据、`expectedRevision: null` | 目标必须不存在；新记录 revision=0 |
| `updateRecord` | 同上、`expectedRevision: number` | 读取既有记录；revision 匹配后 +1 |
| `updateRegistry` | registry 业务数据、`expectedRevision: number` | 读取既有 registry；一致性校验后 revision +1 |

`null` 表示“预期不存在”，不能用 0 代替，因为已存在记录可以是 revision=0。registry 的首次创建继续由显式初始化负责。

要求：

- 类型由现有 schema 推导；公共入口接受的运行时数据也必须校验，不只靠 TS。非法 kind/ID/projectId、revision、限额、时间参数在写文件前结构化拒绝。
- 业务数据不让调用方控制 `schemaVersion`、revision、createdAt、updatedAt；存储层生成头字段，复用现有 schema/版本闸门，不复制第二套记录模型。
- 保留 ID/项目归属不变；update 保留 createdAt，生成 updatedAt；采用可注入时钟，并保证 updatedAt 不倒退。
- expectedRevision 与当前 revision 都要求安全非负整数；+1 不得越过安全整数边界。
- `revision-conflict` 返回预期/实际 revision（不存在可为 null）及受控标识，不返回客户正文；不自动重试改为覆盖。
- 已有损坏 JSON、未来版本、错误 ID/归属、非法绑定一律拒绝，原字节不变。完整 replacement update 不是隐式 merge；不支持 upsert。
- 使用同一记录解释链，registry 复用绑定一致性校验。不要新增模型“批准经验”工具；业务审核和审计留之后阶段。

建议把通用提交逻辑与记录校验适配分开，避免 `records.ts` 无限制增长；无必要不要大规模重构已通过的读取链。

## 4. B2：真正的跨进程锁

锁必须覆盖：**读取当前文件 → 校验 → 比较 revision → 构造新数据 → 完整写临时文件 → 原子提交**。只有进程内 Promise 队列不合格。

- 锁键来自 canonicalRoot + 受控相对目标；Windows 同一目标的大小写/路径别名不能取得两把锁。初始化与 registry update 也需设计兼容竞争：持锁后重新读取，不能覆盖竞态创建的文件。
- 用原子 mkdir 或 `wx` 抢占锁；选择轻量库也可以，但必须在本 Package 声明运行依赖，不能偷用宿主依赖。
- 可使用知识根内新增的 `locks/` 操作目录；继续走 IO 边界，拒绝根内链接。不能把活动锁放入可随时删除的 cache，更不能用用户传入的任意文件路径。
- 锁带随机 owner token、PID/创建时间等诊断信息；只释放自己持有的锁。元数据未完成/损坏时按忙碌或需人工恢复处理，不抢占。
- 等待有超时、可取消、不忙等；定时器/监听器/句柄在所有退出路径清理。超时返回 `lock-timeout`，不偷偷继续写。
- 本轮不凭 mtime、PID 或“看起来过期”自动删别人的锁。崩溃遗留锁明确返回诊断；文档说明需确保没有活动写者再人工处理，不实现自动恢复命令。
- 说明只保证遵守同一协议的本地进程；不保证绕过协议的编辑器/进程，也不承诺未经验证的网络盘语义。

## 5. B3：单文件完整提交

创建继续采用“同目录完整临时文件 + 非覆盖发布”；硬链接不可用维持 `publish-unsupported`，不要恢复最终目标 `writeFile(wx)` 回退。

更新采用同目录临时文件 + 单次原子 replacement：

1. 持锁后读取、校验当前值及 expectedRevision。
2. 构造并校验新值，序列化一次，按实际 UTF-8 bytes 及字符上限检查；不能只检查业务字段估算长度。
3. 以独占方式创建同目录唯一临时文件，完整写入、sync、关闭；异常仅清理自己创建的临时文件。
4. 提交前再次检查信号和路径边界，调用原子 rename/replacement。**禁止先删除原文件、先改名原文件再填新文件，或原地截断写入。**
5. 原子提交成功即提交点。返回实际已提交 revision；迟到取消和清理失败不能报告“未写入”。清理失败可返回有界诊断，不泄漏正文。
6. Windows 忙碌/共享占用只允许有界、可取消重试；不能改成非原子回退。未提交时原文件 hash/revision 不变。

如果所选文件系统不支持安全 replacement，明确失败；不能只凭最终 JSON 能读就宣称发布窗口安全。记录原子可见性与断电持久性的区别：本轮不实现 journal，不声称跨文件/断电恢复完成。

## 6. B4：必须交付的测试

全部自建临时 fixture，真实子进程带超时、stdout/stderr 上限和退出清理。已有 107 用例不得削弱断言；权限条件允许显式 skip，但写清未测，不修改机器权限设置。

| 组 | 必需证据 |
|---|---|
| B0 取消 | 两类 signal、提交前等待中 abort、提交成功后 abort；目标状态与返回一致 |
| 五类 create/update | 五类各真实落盘再新进程读取；revision 0→1、ID/归属/createdAt 保持、updatedAt 正确 |
| registry update | 0→1；重复 ID/路径/桌面绑定拒绝；不暗中创建或改写 profile |
| 乐观冲突 | 旧 revision、缺失、已存在、非法 expectedRevision、计数溢出均明确；拒绝时 hash 不变 |
| 真实更新竞争 | 两个真实子进程用相同 expectedRevision，通过屏障协调争用同一目标；恰好一方提交，另一方 revision-conflict，实际 revision 只增加一次 |
| 真实创建竞争 | 两子进程创建同一 ID，仅一方成功；另一个冲突，完整文件不覆盖 |
| 可见性 | 提交前暂停写者；读者看到旧完整记录/缺失；提交后看到新完整记录，不出现空/半 JSON。另加真实并发反复读写循环 |
| 锁 | 锁等待取消/超时，不写目标；错误退出后释放自有锁；别人的锁不删除；遗留/坏锁不自动抢占 |
| 故障与取消 | 临时写/sync/关闭/rename 注入失败；提交前取消；原文件 hash 不变、自己临时文件无残留、句柄全部关闭 |
| 安全与预算 | 非法 kind/ID、错误项目、损坏/未来记录、超大写入、根内 junction 拒绝；根外 sentinel 不变 |

确定性钩子和真实多进程测试都需要；不要只用 `Promise.all`、同进程两次调用或最终文件校验替代跨进程/窗口验证。若 B0 前置已通过，可以不另交一份验收再继续 B1～B4。

## 7. 文档、门禁与完成标准

更新 README、task_breakdown、test_checklist、development_log，新增 `bm02b_implementation.md`，记录接口/锁/提交点/失败语义、实跑命令和未测项。不要把本次 1 个权限 skip 写成通过，也不要把单文件更新说成多文件事务。

门禁：

```powershell
# 在 packages/bios-agent
npm run typecheck
npm test
npm run selfcheck
npm run check:format

# 在仓库根
npm run typecheck
npm run check:format
node --test tests/processGuards.test.mjs
git diff --check
```

默认只修改 Package core/storage、必要契约/测试和文档；如引入依赖，更新 Package 清单/锁文件并解释理由。不开桌面写入口，不改 PiRuntime。开发完成保留工作树，未经用户要求不提交、不推送。

本轮验收通过后下一项才是 BM-02C：为审核/跨文件变更建立 journal、崩溃恢复及版本迁移；不要在本轮提前实现。

## 8. 可复制给开发 AI 的提示词

```text
在 D:\BIOS_Pi_Agent\PiDeck_BIOS 的 BIOS_Agent 分支完成 BM-02B。
先完整读取根 AGENTS.md、检查 git status，保留用户已有修改和未跟踪文件。
完整读取 docs/bios-agent/round5_acceptance.md 和 bm02b_development_plan.md，
同时阅读 MVP 主文档 §5.3、现有 contracts/storage 和测试；按 B0～B4 顺序实施。

验收基线是 107 用例：106 通过、1 个文件符号链接 EPERM skip。
S1/S2/S4/S5 已关闭；不要重做骨架或恢复直写最终文件的 wx 回退。
先修 publishJson 忽略 callSignal/提交前等待后漏查取消，补永久回归；
然后实现五类 create/update、registry 单文件 update、expectedRevision、
跨进程可取消锁和完整临时文件原子提交。create 的 null 表示不存在，新 revision=0；
update 必须锁内复读与比较，匹配后 +1，损坏/未来版本拒绝且不覆盖。

按文档完成真实双子进程创建/更新竞争、并发读取、锁取消/超时、故障注入、
预算/归属/链接安全回归。提交前失败原字节不变；提交成功后不能因晚到 abort
假称回滚。不要用进程内队列冒充跨进程锁，不自动抢占“过期锁”。

不做 journal/迁移/多文件业务事务、删除、UI、RAG、厂商适配、模型写工具或 Pi 内核改造。
不使用真实客户 BIOS 资料；不自动继续 BM-02C。
更新任务/测试/日志/README，新增 bm02b_implementation.md；实跑第7节门禁，
如实记录 skip 和未测项。未经用户要求不要 git add/commit/push。
最后报告 B0～B4 完成情况、测试数量、风险和未完成内容，交回独立验收。
```
