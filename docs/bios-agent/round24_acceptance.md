# 第二十四轮验收：R23 原复现通过，D3 仍未开始

日期：2026-10-04。工作区 `D:\BIOS_Pi_Agent\PiDeck_BIOS`，分支 `BIOS_Agent`；Windows / Node 24.14.1。
依据：[批次方案](bm02d3_development_plan.md) §8、[实施记录](bm02d3_implementation.md)、[上一轮验收](round23_acceptance.md)。本轮仅验收与更新文档，未修运行代码、提交或推送。

## 1. 结论与进度

**上一轮三处原复现已通过；本批仍未完成，D3 没有开始。**

实际新增的是 target/container 的修复与 7 项永久回归（backup 149 → 156、Package 572 → 579）。代码中仍无 `restoreKnowledgeBackup`、restore 模块或恢复测试。实施记录表格如实写明 D3 未开始，但文件头和导航仍停留在上一轮，不能将“本轮修复完成”理解为“D2R＋D3 整批完成”。

R23-1 的目标外写入、R23-2 的读关闭吞错/登记失败漏关、R23-3 的全量 readdir 原复现均通过。两处同域遗漏仍需收口：R24-1 清理不可核对时误报成功；R24-2 未知 data 子树先递归再拒绝。后者是 R23-3 的剩余策略要求，**不是原全量装载缺陷仍存在**。D2R 完成标准尚未全部满足，不批准正式资料保护使用。

下一轮不另拆单项整改：按 [原方案 §9](bm02d3_development_plan.md#9-第二十四轮接续完成-d3-而不再只交补丁)完成两处窄修，再在同一开发对话实现 D3、原字节往返与新进程读取，整批交回。不要重复已经通过的 R23 修复或历史底座开发；D4/CLI/UI/记忆不提前。

## 2. 独立门禁

| 范围 | 结果 |
|---|---|
| backup 五文件 | 156 项：156 通过、0 失败、0 skip |
| records / registry / preflight | 100 项：98 通过、0 失败、2 显式 skip |
| Package `npm test` | 579 项：576 通过、0 失败、3 显式 skip |
| Package typecheck / selfcheck / check:format | 通过；selfcheck 6 项、格式 86 文件 |
| 仓库根 typecheck / check:format | 通过；格式 2014 文件 |
| 仓库根 processGuards / git diff --check | 2 项通过 / 通过 |

579 = 上轮 572 + 新增 7。三个 skip 为既有文件型 symlink 权限限制；backup junction 对照本机真实执行，无 skip。实施方仅报告 backup/类型/格式，本轮独立补跑其未执行的其它门禁；不将这些结果改写为其自测。

下面是额外独立实验，不计入 579 项。使用自建 `bios-accept24-*` 临时沙箱、合成空库、真实 fs 和窄 IO 注入；不读客户资料。包装在每个实验后恢复，所有取得文件句柄显式关闭；清理前核对沙箱父目录与名称，只移除本轮沙箱。

## 3. 原问题和相邻分支的独立对照

| 实验 | 实际结果 |
|---|---|
| 正常最小库导出 | exported、manifest 存在；独立读取每个 payload，长度与 SHA-256 等于清单 |
| backup-write 等待中 data 换 junction，hook 正常返回 | copy / backup-target-exists / published=false / cleanup=failed；outside 只有原 sentinel，没有 registry；replacement 保留 |
| 创建 projects 前的 mkdir hook 中 data 换 junction | copy / backup-target-exists / published=false；outside 没有新目录，sentinel 保持 |
| link hook 中挪走自有 manifest tmp，再放同名 FOREIGN 普通文件 | publish / backup-target-exists / published=false / cleanup=failed；替换物保留，无 manifest |
| 仅目标 r 句柄 close 实际关闭后抛 EIO | verify-hash / permission-denied / published=false / cleanup=ok；活动文件句柄 0 |
| payload wx open 后登记 lstat 注入 EACCES | copy / permission-denied / published=false / cleanup=failed；活动文件句柄 0 |
| 仅 manifest tmp open 后登记 lstat 注入 EACCES | publish / permission-denied / published=false / cleanup=failed；活动文件句柄 0 |
| maxFiles=1、maxDirectories=4，真实 data 注入 1,000 个未知小文件 | verify-container / too-large / published=false；目标侧迭代实际产出 5 项即停止，未知文件保留 |
| 容器 data 的 Dir.close 实际关闭后抛 EIO | 注入 1 次，verify-container / backup-io-failed / published=false / cleanup=ok；关闭故障没有被当成正常完成 |
| opendir 已取得期间取消 | verify-container / cancelled / published=false / cleanup=ok，无完成标记 |

所有实验源 registry 原字节保持。永久测试另实跑富库、短写、sync 故障、提交后 tmp 删除失败和真实双进程导出竞争。未知子树与清理不可核对实验见下一节，不混入“通过”表。

## 4. 剩余两处：在 D3 同批收口

### R24-1 / P2：清理不可核对被当成“不存在”，虚报 cleanup=ok

定位：Package `core/storage/backup/target.ts:430` 的 `pathExists`、`:463` 的 `cleanupOwned`；同文件 `:564` 的 `targetExists` 有相同 catch-all 存在性语义。

`pathExists` 对任何 lstat 异常都返回 false，调用方立即从 owned 删除条目并累计 removed。只有 ENOENT（按已有判据确认不存在）才能这样处理；EACCES/EIO 是“不能确认”，不是“没有内容”。

真实窄注入：空库完成 payload 复制后，首个目标回读 open hook 抛受控 backup-payload-mismatch，同时只让目标路径的 lstat 返回 EACCES。原错误正确保留，但返回 **verify-hash / published=false / cleanup=ok / residuals=[]**；独立同步 fs 确认 **target/data/registry.json 仍存在，target 根也存在**。源 registry 没变，无 manifest。

修复：存在性分为不存在、存在、不可核对，或仅对 not-found 返回 false、其它错误交清理 catch。不可核对不删除 owned、不算 removed，保留现场并给 cleanup=failed 与有界残留；不能掩盖首错。核对 targetExists 的调用者，避免其它入口把 EACCES 当目标缺失或安全空目录。

永久回归包含目标全链 EACCES、单路径 EIO、真实 ENOENT 对照；断言原 code、published=false、残留事实及实际磁盘内容。禁止递归强删来使清理结果“通过”。无需实现 ACL 产品或 OS 沙箱。

### R24-2 / P2：有界盘点仍进入未知 data 子树

定位：`core/storage/backup/container.ts:100` 的 data 遍历和 `:109` 的 pending.push。现在扫描已流式受预算约束，但普通目录不经过受控落点/清单集合判定就入队。

独立复现：真实 data opendir 前加入 `unknown/nested/private.txt`。最终 backup-payload-mismatch、无 manifest、未知内容保留；然而包装的真实 opendir 调用记录包含 **data/unknown 和 data/unknown/nested**。因此“最终拒绝”成立，“未知子树立即拒绝、不递归”的要求未成立。现有注释只禁止未知根条目，不能覆盖未知 data 子树。

窄修：复用现有 `classifyBackupDirectoryPath` 与文件分类，或传入已经验证的 manifest 集合，在每次观察到目录后、入队前判受控落点与集合，未知立即受控拒绝。不能按 `isDirectory` 就遍历；不能为恢复接受任意目录。保持已有文件/目录/扫描预算和空目录语义。

永久测试：真实 unknown 子树触发后，opendir 记录不得出现该子树；根未知、链接/非常规类型、合法嵌套 project/audit/journal 与预算边界继续通过。源/备份和未知内容保持。该修复可与 D3 的只读容器准入一起落地，不再单独交回。

## 5. 接续要求与非阻塞维护

- 下一步交付不是“再修两点”，而是完整 D3：全新目标排他取得、原 registry 最后非覆盖发布、cache/locks 为空、原字节集合/hash往返、真实新进程 reader、双进程/拒绝/变化/预算/故障矩阵。
- source 的已有 canonical 语义保持；任意备份容器的只读根/祖先/最终文件链接和类型核对，不能用导出自有会话的身份检查替代。root manifest 的类型也须在 D3 准入中明确。
- `target.ts` 588 行，`storageBackupTargetSafety.test.mjs` 755 行；后者已超 600 行，应在触达时评估按归属、生命周期、盘点拆测试与窄注入 helper，保留全部行为。不是要求另开大重构轮次。
- junction 测试不再将 API 错误成功转 skip，但仍对任意 symlink 创建异常 skip；只豁免已知权限/平台不可用码，其它异常应失败。当前本机无 skip，作为同批测试纪律补齐。
- 实施记录有重复的 §8，且状态头/断点引用不一致；本轮同步当前事实并整理编号，保留历史记录，不删早期证据。
- 未测真实 ACL、网络盘、断电、其它 OS、客户库、远端 CI、安装包或 BIOS 硬件，不声称在线快照、完整恶意竞态隔离或已接 UI。
