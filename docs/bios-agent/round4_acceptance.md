# BIOS Agent 第四轮验收：G1 修复与 BM-02A

日期：2026-10-01。基于当前 `BIOS_Agent` 本地工作区，尚非已提交/发布版本。

结论：G1 已关闭，BM-01 基础骨架通过；BM-02A 主体落地，但有条件通过，暂不进入普通记录更新。新增发现的 S1～S5 都在本轮已有初始化、读取、列表及绑定模块内，不要求改架构或增加新产品功能。

下一轮完成 [BM-02A 收尾任务](bm02a_remediation_plan.md)。这些边界关闭后再开发 BM-02B；不要把仍有读取一致性问题的底层直接接到模型写工具或桌面 UI。

## 1. 独立执行的门禁

环境：Windows、Node 24.14.1、Pi 开发宿主 0.87.1；使用现有依赖，未调用模型。

| 检查 | 实际结果 |
|---|---|
| Package `npm test` | 89 用例：88 通过、0 失败、1 显式 skip |
| Package `npm run typecheck` | 通过 |
| Package `npm run check:format` | 25 文件通过，无修改 |
| Package `npm run selfcheck` | 6 项通过，含同进程存储离线演示 |
| 根工程 `npm run typecheck` | 通过 |
| 根工程 `npm run check:format` | 2014 文件通过，无修改 |
| `node --test tests/processGuards.test.mjs` | 2 用例通过、无跳过 |
| `git diff --check` | 通过；不覆盖未跟踪文件 |

跳过的是最终记录文件符号链接：本机创建 file symlink 报 EPERM。目录 junction 测试实际执行。此次 Package 输出未再出现上一轮的目录句柄 GC 清理警告。

测试分布：authorization 13、contracts 15、extensionLoad 8、paths 14、probe 14、storageRecords 15、storageRegistry 10。相对上轮新增 29 个用例。

## 2. 已确认的进展

- G1：opendir 后取消检查已移入 try/finally；3 个资源生命周期测试及 1 个子进程 GC 诊断通过。正常、截断和取消清理得到验证。
- registry schema、独立存储模块及稳定 ID 基础已实现，没有引入第二份 Pi 执行循环或桌面业务改动。
- 重复初始化保留 registry 字节/revision；损坏、未来版本及静态超大文件拒绝；五类记录单条读取通过。
- 正常硬链接发布的两子进程初始化、空 registry 新进程读取通过。
- 根内目录 junction 逃逸拒绝；知识根 canonical 化与根内链接政策明确，不夸大为 OS 沙箱。
- 普通记录更新、跨进程锁、journal、迁移、管理 CLI、专业 UI 未实现，符合本轮范围。

“新进程读取”现有永久用例只验证空 registry 的头字段，不含非空项目绑定或业务记录。selfcheck 的 fixture 读回在同一进程，不能替代该验收场景。初始化时链接逃逸、读取中增长、存储中途取消也没有得到现有永久用例充分覆盖。

## 3. 补查方法

验收使用自建临时目录及合成记录，没有读取客户代码。除正常 public API 诊断外，针对难以自然命中的 IO 时序，在独立诊断进程包装 Node 文件系统操作：注入硬链接 ENOSYS、暂停直接写目标、在 fstat 后增长文件、在最后一次 read 返回 EOF 时 abort。它们是故障注入结果，不是宣称本机真实磁盘发生了对应故障。

临时诊断脚本和合成数据已删除；没有修改生产源码或永久测试。以下为实测摘要，源码位置以当前行号为准。

## 4. 必须关闭的 S1～S5

### S1（P1）：无硬链接时回退会发布半文件

位置：`core/storage/boundary.ts:232–239`，`core/storage/registry.ts:200–227`。

`link()` 不可用时，直接 `writeFile(target, payload, { flag: 'wx' })`。O_EXCL 只保证不覆盖，并不保证目标文件在完整写好前不可见；创建和写入之间读者能读到空/半文件。进程若此时退出，目标损坏文件还会永久保留。

故障注入 ENOSYS 并暂停回退写入：目标 registry 已存在，大小 0；并发 `readRegistry` 报 invalid-json。已有双进程测试没有强制回退分支，最终 JSON 合法的断言也不能证明写入期间不可见。

修复：只保留完整内容的非覆盖发布。最小方案是硬链接不可用时明确失败，保留目标未创建；若要支持回退，必须实现可证明不暴露半目标的协议并测试。不要以“重试解析”代替发布保证，不覆盖既有损坏文件。EACCES 等权限问题与确实不支持链接也要区分。

### S2（P1）：列表没有执行单条读取的项目一致性校验

位置：`core/storage/records.ts:248–276`；对照单条读取的 113–134 行。

将内容属于项目 B 的合法任务放进 A/tasks，文件名和内容 ID 相同：

```text
readRecord(A, task-1) → record-id-mismatch
listRecords(A, task-record) → entries 含 task-1，problems=[]，truncated=false
```

列表只校验 ID，不校验 task.projectId/context.targetProjectId。它会把另一项目的任务摘要当成当前项目记录，后续检索/上下文容易引用错误知识。

修复：单条与列表共用完整的 kind、版本、结构、ID、所属项目验证；错归属条目进入 problems，不能进入 entries。同时覆盖 context-manifest，避免两套验证逐渐分叉。

### S3（P2）：增长文件会被当成合法前缀；最后等待点取消仍可成功

位置：`core/storage/boundary.ts:182–201、246–278`。

读取容量使用 `min(maxBytes, stat.size) + 1`，不是读到 EOF 或实际上限。注入“stat 返回大小 2 后，文件变成 1003 字节”，上限 100，实际结果：读取 3 字节的合法前缀 `{} `，成功返回 `{}`。既没有发现已超限，也没有发现文件后部是无效内容。

取消方面：在 read 返回 EOF 时 abort，`readJson` 仍成功；已开始空目录 `listEntries` 后立即 abort，仍返回成功空列表。检查点只有读取循环/条目内，没有最后等待点之后和返回前的检查。列表 catch 还可能把 cancelled 收为单条问题，初始化重试 catch 可能把它改成 init-race。

修复：在有限内存内读到 EOF 或上限+1，不能解析截断前缀；IO 等待后/返回前检查取消，并明确传递 operation signal。取消是整体失败，不能混入 problems 或变成初始化竞争。发生发布后的取消须明确提交状态，不能承诺已提交写入被撤销。

### S4（P2）：单条坏文件名使列表整体失败，错误列表不受预算保护

位置：`core/storage/records.ts:238–245、269–276`；预算解析在 `core/storage/limits.ts:45–48`。

实际诊断：

```text
experiences/Exp.json → 整个 listRecords 抛 invalid-record（路径派生在 catch 外）
两个损坏 JSON，maxListBytes=1 / maxListEntries=1
  → problems=2，entries=0，truncated=false，完整结果约 696 字节
```

maxListBytes 只计 label+id，不包含 path、revision 等条目字段或 problems；坏记录不消耗条数预算。虽然默认 maxScanEntries 最终限制了数量，但配置的列表输出预算并未实际保护异常结果。目录枚举还静默跳过链接，不能把它说成“拒绝项已报告”。

修复：文件名/路径派生异常也按单条问题处理；给 problems 数量和输出字节明确限额/丢弃计数/截断维度；条目预算计算涵盖实际承诺的输出字段。固定元数据是否计入要写清，小于固定头预算时仍必须有明确结果。所有可配置限额验证为有限合法整数，不允许 NaN/Infinity/undefined 覆盖解除约束。

### S5（P2）：绑定解析忽略矛盾条件，多个工作区任取首个

位置：`core/storage/registry.ts:68–128、239–282`。

三个实测：

1. 同一项目两个工作区，只传 biosProjectId，返回 workspaces[0]，没有提示工作区歧义。
2. 路径属于 A，同时显式指定 biosProjectId=B，仍返回 A 的 resolved。
3. registry.projects 中重复同一 biosProjectId、各自 workspaces=[]，inspectBindingIssues 返回 []。

项目 ID 不等于具体检出；未来若按任取首个工作区执行，可能修改错误分支。矛盾输入不能被“优先级”静默抹去，重复项目不能靠 find 选首条。

修复：项目唯一性约束、组合查询一致性、多工作区歧义都明确处理。可以返回仅项目级命中、需要指定工作区或 conflict；只有一个 workspace 时才可自动定位。离线路径保留，不隐式新建/合并项目。

## 5. 附带建议及未验证范围

- 去掉列表 `as never`、`as unknown as` 的补丁式类型串联；在共享校验出口用可解释的 kind→record 类型映射，不为过类型检查绕过真实收窄。
- JSON.parse 错误的 detail/cause 可能带原文片段，按“错误不夹带客户正文”的既定要求脱敏；不能只检查 message。
- 并发测试补 error、输出上限、超时和终止清理，避免测试无限等待；暂未造成当前门禁失败。
- 文件型符号链接、真实 EACCES、告警实际触顶、Linux/macOS、干净 clone、远端 CI、根全量测试/生产安装版及真实 BIOS 平台未验证。跳过项不计通过。
- Package/锁文件/文档仍未跟踪；本轮没有 git add/commit/push、Release 或修改 PiRuntime/真实 BIOS 项目。

## 6. 下一步

按分阶段 MVP 工作流，当前只修 BM-02A 已承诺的安全发布、读取一致性和可解释列表/绑定，不提前扩展到更新协议。任务及可复制提示词见 [BM-02A 收尾说明](bm02a_remediation_plan.md)。BM-02B 的 expectedRevision、跨进程可取消锁与原子更新仍是后续明确方向，不是本轮额外漏项。
