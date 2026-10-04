# 第二十三轮验收：D2R 部分收口，D3 未开始

日期：2026-10-04。工作区 `D:\BIOS_Pi_Agent\PiDeck_BIOS`，分支 `BIOS_Agent`；Windows / Node 24.14.1。
依据：[D2R＋D3 方案](bm02d3_development_plan.md)、[节点实施记录](bm02d3_implementation.md)、[第二十二轮原发现](round22_acceptance.md)。本轮没有修复代码、提交或推送。

## 1. 结论和实际进度

**本次只交付了节点 A（D2R）的实现，节点 B（D3）尚未开始；整批未完成，节点 A 也暂未整体通过。**

源码没有 `restoreKnowledgeBackup`、restore 模块或恢复测试；实施记录如实说明 D3 未开始，这是有效的断点记录，不是整批完成证据。当前门禁全部通过，但额外实验发现三处原语遗漏：R23-1 等待后的目标身份复核、R23-2 读取关闭/登记失败句柄生命周期、R23-3 容器列举先无界装载后判预算。

上一轮的具体复现已明显改善：清理 junction 不再误删外部 sentinel，目标额外文件/缺空目录拒绝，根取得/发布前取消与 link 失败清理正确，manifest close 失败阻止发布，提交后残留如实报告，原始异常/源绝对路径不再透传。**D2-2 的原集合错误、D2-4 的原公共错误复现关闭；D2-1/D2-3 的原复现通过，但同一目标/生命周期职责仍有遗漏。** 不要求重做已经通过的补丁。

下一步仍接续原批次，不新建一轮孤立整改任务：按 [方案 §8](bm02d3_development_plan.md#8-第二十三轮接续先补三处遗漏再完成-d3)补三处永久回归及最小修复，节点门禁通过后同一对话继续 D3；完成真实恢复往返后整批验收。**不提前 D4 CLI/UI/记忆，不重做 B1/B2、C3 或审核/journal 已关闭问题。**

## 2. 独立执行的门禁

| 范围 | 本轮结果 |
|---|---|
| Package 全部 backup 五文件 | 149 项：149 通过、0 失败、0 skip |
| records / registry / preflight 三文件 | 100 项：98 通过、0 失败、2 显式 skip |
| Package `npm test` | 572 项：569 通过、0 失败、3 显式 skip |
| Package typecheck / selfcheck / check:format | 通过；selfcheck 6 项、格式 86 文件 |
| 根 typecheck / check:format | 通过；格式 2014 文件 |
| 根 processGuards / git diff --check | 2 项通过 / 通过 |

572 = 上轮 551 + 本轮 21。三个 skip 仍为既有文件型 symlink 权限限制；新 backup 测试没有 skip，本机真实 junction 用例实际执行。实施方未运行的完整门禁已由本轮独立补跑，不伪造为其自测结果。

以下实验不计入 572 项：均使用本次创建的合成临时库和独立 fs/crypto，不读真实客户库。诊断时的窄 Node IO 包装全部恢复，活动句柄显式关闭，自有临时沙箱已核对后清理。

## 3. 原问题的独立对照

| 实验 | 实际结果 |
|---|---|
| 最小库正常导出 | exported、published=true、cleanup=ok；独立重算文件长度/hash一致，源 registry 不变 |
| 回读前加入 data/extra-secret.txt | backup-payload-mismatch、无 manifest；额外文件保留、cleanup=failed、有界 residuals |
| 回读前删除 features 空目录 | backup-payload-mismatch、无 manifest、cleanup=ok、target 清理完 |
| data 换 junction 后抛受控错误 | 原失败码保留、无 manifest；outside sentinel 和 replacement 保持、cleanup=failed |
| 根 mkdir hook 中取消 | cancelled / acquire-target / published=false / cleanup=ok；target 不存在 |
| manifest link hook 中取消 | cancelled / publish / published=false / cleanup=ok；target 不存在 |
| manifest link hook 抛受控失败 | publish-unsupported、无 manifest 或自有 tmp；cleanup=ok |
| 仅 manifest 临时句柄 close 实际关闭后抛 EIO | permission-denied / publish / published=false；没有完成标记 |
| 实际 link 成功后 temp unlink 抛 EACCES | exported / published=true / cleanup=failed；manifest 和 tmp 同在，不伪称回滚 |
| 首个目标写 hook 抛含敏感标记的裸 Error | backup-io-failed、固定文案、结构化 facts；不透传敏感标记 |
| 真实 maxFileBytes=0 预算拒绝 | too-large、固定文案/facts、不回显源绝对路径 |

上述源 registry 原字节均保持。永久测试另执行短写（每次 3 字节）与 sync 故障、正常富库和真实双进程导出竞争。

## 4. 仍需在本批节点 A 收口的三处遗漏

### R23-1 / P1：祖先身份检查在等待前，实际写入前没有再查

定位（相对 Package）：`core/storage/backup/target.ts` 的 `writeOwnedFile`，约 202～216 行；相邻 `createOwnedDirectory`、`readOwnedFileBounded/readBoundedFile`、`publishOwnedManifest` 也须按同一等待边界检查。

流程是 `assertAncestorsOwned` → `await beforeIo("backup-write", absolute)` → `open(...,"wx")` → 按路径 lstat 登记。hook/等待期间目标祖先被替换后，实际 open 前没有再验身份；创建后的登记又可能把外部新文件当作本次目标。

独立真实复现：对合成空库，在目标 `data/registry.json` 的 backup-write hook 中，将自有 data rename 到另一个沙箱目录，再把原 data 路径换成指向沙箱 outside 空目录的 junction；hook 正常返回，不抛错。**实际 outside/registry.json 被创建，内容为源 registry 原字节；随后到 verify-hash 才报 backup-target-exists。** 没有 manifest，清理保留 replacement，但根外写入已经发生。

这不是要求消除所有 TOCTOU 或构造 OS 沙箱，而是现有明确等待点后没有重验已承诺的身份，D3 将复用该写原语。必须在受控 hook/等待结束后、实际 IO 发起前重查祖先/自身与取消；新文件身份优先从取得的句柄核对，路径替换不能被登记为自有。发布前同时验证自有临时文件和目标祖先，提交后临时清理也不能穿过替换物。仍如实保留最后一次检查与系统调用之间的竞态限制。

永久断言：注入确实触发，outside 既有 sentinel 不变、不得创建 outside/registry.json；无 manifest；replacement 保留且事实报告残留。再补 mkdir/发布的同类等待窗口，不靠 sleep。

### R23-2 / P2：读操作的 close 失败被 return 吞掉；登记失败漏关句柄

定位：`target.ts` 的 `readBoundedFile`，约 273～283 行；`writeOwnedFile` 约 216 行、`publishOwnedManifest` 约 325 行。

两条独立实验：

1. 仅包装目标 **r 模式**句柄的 close：实际关闭后抛 EIO。注入触发，结果仍为 **exported / published=true / cleanup=ok**。原因：try 内已经 `return Buffer.concat(...)`，finally 只是赋值 `failure`，没有取消待返回结果；finally 后的 failure 检查不会执行。正常读关闭失败没有按实现注释阻止继续发布。
2. 目标 payload 的 wx open 已成功，随后身份登记用的 lstat 注入 EACCES。返回 permission-denied / copy / cleanup=failed，但诊断进程保存的 FileHandle **仍有 fd，活动句柄数为 1**。原因：`acceptCreated` 在关闭保护之外；它失败直接跳过关闭代码。诊断最后显式 close，未依赖 GC。

修复同一生命周期：open 成功即进入覆盖登记、读写、sync 与取消的 finally/关闭保护；正常关闭失败须传播，异常关闭失败不覆盖首错。读结果缓存到局部变量，只有读与正常 close 均完成后返回。恢复读取不能复用当前会吞 close 错误的版本。

增加 read-close、payload/manifest 登记失败的真实窄 IO 注入；分别断言原 code、未发布、cleanup 状态、全部取得句柄已显式关闭。现有 close 回归的 closeFile 对每个目标句柄都抛，实际先卡在 payload，不能单凭用例名称证明 manifest 和读关闭分支都覆盖。

### R23-3 / P2：容器列举先 readdir 全目录，再 map 全部条目，预算未约束扫描/内存

定位：`core/storage/backup/container.ts` 的 `list`，约 44～53 行及后续根/子树循环。

`readdir(...,{withFileTypes:true})` 先分配完整目录数组，紧接着 map 全量名称；文件/目录数超限判断发生在后面的遍历。根未知条目、links 数组没有相同上界，未知普通子树还会进入 pending。这与“有界、只扫受控落点”不符；失败结果本身正确，不代表工作量有界。

独立实验：最小正常源、`maxFiles=1/maxDirectories=4`；在真实目标 data 盘点前生成沙箱中的 1,000 个未知小文件，保留真实 readdir，仅包装返回 Dirent 的 name getter计数。**真实返回 1,005 项，name getter 实际访问 1,005 次**，之后才 too-large / verify-container；没有 manifest，未知文件保留。这证明其全量装载/转换先于预算，而不是传入一个伪造的巨大 JS 清单。

改用既有有界列举或逐项 opendir：根只观察固定容器条目加一次超限探测；data 使用显式共用扫描预算，区分允许的文件/目录/链接/异常，每个实际观察均计费。未知路径或类型立即失败，不递归未知子树；不要通过把默认限额放大掩盖全量读取。目录句柄的成功/失败/取消/关闭生命周期一起测试。

预算口径可为允许文件＋目录＋固定容器条目＋一次探测，或另设有明确默认/0语义的内部扫描预算；文件和目录的 D1 限额保持。必须披露 actual observed 的口径，不把根/data 容器元目录混算成 payload 目录。增长/links/根未知项的扫描也不能无界。

## 5. 非阻塞维护项和接续纪律

- target.ts 为 532 行，未超 600 行强制评估阈值；适合在触达修复/恢复时按身份清理与 IO 发布拆分，但不为凑行数开独立交接，不重构旧 Boundary。
- `readBoundedFile` 的“链接一律拒绝”目前依赖调用者，没有自带完整路径链检查；D3 只读容器侧应补实际类型/链检查，不把导出自有会话的检查误当任意备份都受保护。
- 容器目录链接测试会在 `error === undefined` 时 skip，可能把“错误成功”当权限不足；接续改为只在真实 junction 创建抛已知权限错误时 skip，注入可用但 API 成功必须红。这是回归质量修正，不另开业务阶段。
- D1/D1R、C3/C3R 与旧存储/审核/journal 已通过声明范围保持；不要求重复其整轮开发。
- 三处遗漏均纳入当前批次 §8，节点通过后直接继续未开始的 D3；D3 的恢复准入、registry 最后发布、原字节往返和新进程读取标准不变。不得将实施记录 §6 的复用示例直接照抄成安全保证，尤其 manifest 读取需链接/类型校验与 publish/close 修正。
- 未测真实客户库、ACL、网络盘、断电、其它 OS、远端 CI、安装包和真实 BIOS/硬件；不声称可靠在线快照或同机恶意进程隔离。
