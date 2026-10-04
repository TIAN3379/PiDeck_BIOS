# 第二十五轮验收：R24-1/2 收口，下一步直接实现 D3

日期：2026-10-04。工作区 `D:\BIOS_Pi_Agent\PiDeck_BIOS`，分支 `BIOS_Agent`；Windows / Node 24.14.1。
依据：[上一轮验收](round24_acceptance.md)、[批次方案 §9](bm02d3_development_plan.md#9-第二十四轮接续完成-d3-而不再只交补丁)、[实施记录](bm02d3_implementation.md)。本轮只验收和更新 Markdown，未修运行代码、提交或推送。

## 1. 结论

**R24-1/2 在本轮声明范围内验收通过，已发现的 D2R 整改收口；D3 未开始，备份恢复整批未完成。**

实际交付是存在性错误分类、声明集合提前拒绝与 4 项新增测试计数（含父测试，backup 156 → 160）。没有 `restoreKnowledgeBackup`、恢复模块或恢复专项测试。实施方如实记录了这点，但导航还保留“R24 待修”，本轮同步。

下一任务直接是 [D3 恢复闭环 §10](bm02d3_development_plan.md#d3-restore-next)，不增加独立整改阶段，不重做已经通过的 R23/R24。D2 导出已实现并通过这些修复复核；**这不等于已经证明可以恢复或批准正式资料保护使用**。D4 CLI、记忆和 UI 仍不提前。

## 2. 独立门禁

| 范围 | 本轮结果 |
|---|---|
| backup 五文件 | 160 项：160 通过、0 失败、0 skip |
| records / registry / preflight | 100 项：98 通过、0 失败、2 显式 skip |
| Package `npm test` | 583 项：580 通过、0 失败、3 显式 skip |
| Package typecheck / selfcheck / check:format | 通过；selfcheck 6 项、格式 86 文件 |
| 仓库根 typecheck / check:format | 通过；格式 2014 文件 |
| 仓库根 processGuards / git diff --check | 2 项通过 / 通过 |

583 = 上轮 579 + 4。文件型 symlink 的既有权限限制仍显式跳过，不计为通过；backup junction 本机实际执行。实施方只报告 backup/类型/格式；其余是本轮独立补跑，不改写为实施方自测。

## 3. 修复复核与独立实验

`target.ts` 的 `pathExists` / `targetExists` 仅对 ENOENT 返回 false；其它 lstat 故障抛受控错误。清理逐项捕获故障，不删 owned、不累计成功移除，保留首错及实际残留。

`container.ts` 新增可选的已验证声明集合；导出入口实际传入清单文件/目录集合。目录先检查声明再加入 pending，未知文件也立即拒绝。**D3 复用时必须传入声明集合**；不能把可选参数的存在当作所有调用者都已启用保护。

下表为额外独立实验，不计入 583 项。使用自建 `bios-accept25-*` 临时沙箱、合成空库、真实 fs/crypto 与窄 IO 包装，不读默认真实库或客户资料。

| 实验 | 实际结果 |
|---|---|
| 最小库正常导出，文件数 1、目录数 4、单文件/总 payload 预算恰等于实际长度 | exported；原字节、清单集合和独立 SHA-256 一致 |
| 目标回读触发首错，随后目标全链 lstat 注入 EACCES | 首错 backup-payload-mismatch 保持；published=false、cleanup=failed、有界残留；registry 现场保留 |
| 同样首错，但仅目标 registry 路径 lstat 注入 EIO | 相同真实失败事实；目标 registry 原字节保留，不把单路径不可核对当缺失 |
| 外部移除本次自有空 features 目录，再触发失败 | 真实 ENOENT 对照：cleanup=ok，目标清完，无虚假残留 |
| 真实插入 data/unknown/nested/private.txt，记录实际 opendir | 受控拒绝，无 manifest；从未打开 unknown 子树；未知内容保留 |
| 真实插入未声明文件 | 受控拒绝，无 manifest；未知内容保留，不递归清理 |
| 单独调用 targetExists，分别注入 EACCES/EIO，再检查真实不存在路径 | 两类故障均拒绝；只有真实 ENOENT 返回 false |

每个实验后源 registry 原字节保持，错误不泄漏注入正文。包装在每组/最终恢复；删除前验证临时沙箱绝对父目录和名称，仅移除本轮沙箱。诊断脚本首次预算字段拼写、路径记录断言存在错误，修正脚本后全部重跑通过；不是产品缺陷或新增永久测试。

## 4. 剩余交付与边界

下一轮必须有新增恢复代码和测试：仅恢复至不存在的新根，备份只读准入，原 registry 最后非覆盖发布，空 cache/locks，最小及富库原字节往返，真实新进程调用现有 reader。按原方案 §5 补齐恢复拒绝、双进程竞争、预算/变化、IO/取消与提交后事实，连同尚缺的 D2 批次覆盖一次交回。

单路径 EIO 本轮已独立验证，但尚未成为永久用例；在 D3 故障组补入即可，不为它单开修复轮次。`target.ts` 596 行、安全测试 859 行；新增恢复时按职责窄拆并保留回归，不把整份 restore 继续塞入两文件，也不另开无交付的大重构。junction skip 列表包含宽泛 UNKNOWN，当前本机零 skip；后续触达时改为具体平台证据，不能用未知异常掩盖错误成功。

本轮没有新的阻塞发现。真实 ACL、网络盘、断电、其它 OS、远端 CI、生产安装包、客户 BIOS/硬件未验证；不宣称 OS 沙箱、消除 TOCTOU、在线快照或签名可信来源。根全量测试/重打包未运行：本轮未改桌面或运行代码，执行范围按批次方案门禁。

保留原 dirty tree、未跟踪文件及六项既有历史删除；未 add/commit/push。D3 整批通过后再安排 D4，随后 M1/M2 → BM-03～05 → Pi 工具 → 最小 UI。
