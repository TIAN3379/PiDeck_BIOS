# 第二十二轮验收：D1R 通过，D2 离线导出暂未通过

日期：2026-10-04。工作区 `D:\BIOS_Pi_Agent\PiDeck_BIOS`，分支 `BIOS_Agent`，Windows / Node 24.14.1。
依据：[D1R＋D2 方案](bm02d2_development_plan.md)、[实施记录](bm02d2_implementation.md)。本轮只验收、更新文档，没有修复代码、提交或推送。

## 1. 结论与下一步

**D1/D1R 的协议与纯字节校验范围通过，第二十一轮 B1/B2 关闭。D2 正常导出主体已实现，但整体暂未通过。**

独立复跑全部指定门禁通过，不等于失败边界通过。额外实验发现四组遗漏：D2-1 清理路径逃逸、D2-2 目标集合复核缺失、D2-3 提交/取消/清理事实不完整、D2-4 公共错误未统一脱敏。前两组涉及误删和虚假完整备份，不能降为可忽略技术债。

下一轮按 [D2R＋D3 批次](bm02d3_development_plan.md)执行：先永久回归并修复四组遗漏，节点门禁通过后，在同一开发对话继续新目录恢复与真实往返；整批统一交回。不再为每个小修复单独转交，也不在不安全的原语上直接开发恢复。D4 CLI、记忆与 UI 不在下一批范围。

C3/C3R、审核、journal 与旧存储的已通过范围保持。本报告不把导出诊断扩大为旧底座全部失效。

## 2. 独立复跑结果

| 命令 / 范围 | 本轮实际结果 |
|---|---|
| Package `node --test tests/storageBackup*.test.mjs` | 128 项：128 通过、0 失败、0 skip |
| records / registry / preflight 三文件 targeted | 100 项：98 通过、0 失败、2 显式 skip |
| Package `npm test` | 551 项：548 通过、0 失败、3 显式 skip |
| Package typecheck / selfcheck / check:format | 通过；selfcheck 6 项，格式 83 文件 |
| 仓库根 typecheck / check:format | 通过；格式 2014 文件 |
| 根 `tests/processGuards.test.mjs` / `git diff --check` | 2 项通过 / 通过 |

三项 skip 为既有文件型 symlink 权限限制，不算该行为通过。以下独立实验不计入 551 项；全部使用本次创建的合成临时库，无真实客户资料。junction 实验在本机实际执行。

独立重新构造 B1 两字节视图、覆盖自有 `byteLength=1`、预算和声明均为 1：现在返回 `backup-payload-mismatch / payload-size-mismatch`；假原型视图返回受控 `payload-entry`，不抛 crypto 原始异常。B2 的 100,001 项 exclusions 在 `maxManifestBytes=1/maxIssues=0` 下拒绝，迭代器访问计数为 **0**。正常 Buffer/非零偏移等对照由永久回归实际执行。

最小真实库导出成功，独立 fs/crypto 重算 registry 长度和 SHA-256 与 manifest 一致，四个必需目录存在；源 registry 原字节不变。永久测试另覆盖五类记录、v1/v2 journal、审核意图/事件、中文/CRLF 原字节、真实双进程同目标竞争。

## 3. 阻塞发现

### D2-1 / P1：清理只检查词法路径，junction 可导致删除目标外文件

定位：`core/storage/backup/target.ts` 的 `assertInsideTarget`、`createTargetDirectory`、`removeOwnedPath`（约 179 行）与 `removeTargetRoot`；`export.ts` 的 `cleanupOwned`。均相对 Package。

`created` 只保存路径字符串；删除前没有核对本次创建的身份、祖先链接或实际边界。`lstat(backup/data/registry.json)` 会穿过祖先 `data` junction，随后 `unlink` 删除指向目录中的同名文件。非 recursive 不等于不会逃逸。

独立确定性复现：

1. 初始化合成空库，开始导出到全新 `backup`。
2. 目标 registry 回读前（`beforeIo("open", targetPath)`），把 `backup/data` rename 到临时沙箱的 `owned-data`。
3. 创建沙箱中的另一个 `outside` 目录和 `outside/registry.json = "UNRELATED SENTINEL"`；将 `backup/data` 换成指向 outside 的 junction。
4. 在该 hook 抛受控 `backup-payload-mismatch`，触发失败清理。
5. **实际：outside sentinel 被删除，target 也被移除。** 源 registry 原字节不变。

这证明缺少承诺中的“路径被替换/归属不明时保留”，不是要求抵御同机恶意进程的完整 OS 沙箱。恢复功能会复用目标写入和清理，必须先修。

完成标准：取得根、目录、文件时记录可验证归属；每次目标 IO/清理检查祖先与身份，替换/链接/未知归属受控拒绝或保留，不能删除 external sentinel。目录 EEXIST 不得当作本次创建；父链链接也须按原 D2 限制拒绝。`resolveTargetParent` 当前只 realpath 后 lstat canonical，不足以兑现“拒绝父链链接”的注释。

### D2-2 / P1：只回读声明文件，没有核对实际目标唯一集合

定位：`core/storage/backup/export.ts` 的目标复核（约 223 行）。

源重新盘点了，目标没有。逐文件 hash 都相符时，目标多余条目、缺失空目录、未知根条目或替换成目录链接仍可能被遗漏。

独立实验分别在第一次目标文件回读前：

- 写入 `backup/data/extra-secret.txt`，结果仍为 `exported / published=true / cleanup="ok"`，额外文件存在。
- 删除 `backup/data/features` 空目录，结果仍为相同成功，manifest 仍声明 features 目录，实际不存在。

源字节均未改变，manifest 均已发布。不是未承诺的任意时间原子快照：注入发生在最终验证之前，正是原方案 §5 必测行为。

完成标准：有界枚举真实容器和 data 的文件、目录、类型；与 manifest 完全且唯一一致，拒绝额外/缺失/链接/未知临时残留。显式本次 manifest 临时文件只在发布阶段按身份管理，不成为允许任意 `.tmp` 的理由。

### D2-3 / P2：创建、关闭、发布、取消与清理的状态未完整传播

定位：`export.ts` 约 150、181～197、269 行；`target.ts` 的创建、写入、回读和 `publishManifest`（约 139～175 行）。

独立实测：

| 注入窗口 | 实际结果 | 必须改成 |
|---|---|---|
| 目标根 mkdir 的 beforeIo 中 abort | 抛 cancelled，但留下新建空 target；取得目标位于外层 try 之外 | 创建后立即登记归属，覆盖等待中的取消，清理或结构化报告残留 |
| manifest link 的 beforeIo 中 abort | 仍发布 manifest 并返回 exported | hook/等待后、发起实际 link 前复查取消；未到提交点不得发布 |
| 同一 link hook 抛受控失败 | 无 manifest，但留下 `manifest.<pid>.<time>.tmp`，只能在 message 中附“清理失败” | 临时创建起即登记、finally 关闭/清理；结构化 cleanup 与原错误同时保留 |
| manifest 临时文件 close 实际关闭后抛 EIO | 仍发布并返回 exported | 正常准备阶段 close 失败阻止发布，异常 finally 尽力关闭不覆盖首错 |
| link 成功后 unlink(temp) 抛 EACCES | tmp 与 manifest 同在，仍返回 cleanup="ok" | 保持 published=true，准确报告 cleanup="failed" 及有界残留事实 |

后两项通过诊断进程替换 `node:fs/promises` 的窄 IO 函数并调用 `syncBuiltinESMExports` 注入；每项确认故障确实触发，结束恢复函数。不是实际操作系统偶然失效的统计。

相邻代码遗漏：payload/目录仅在整个方法成功返回后 `created.push`，打开/创建后写入、sync、close 或取消失败可失去自有路径登记；各处 `close().catch(() => undefined)` 吞掉正常关闭失败；取消错误又直接绕过 cleanup 附加事实。下一轮按同一生命周期问题一起修，不拆成多个交接。

### D2-4 / P2：清理成功时原始异常直接透传，源路径也进入公共错误

定位：`core/storage/backup/export.ts` 的 `withCleanupStatus`（约 269 行）与入口外围；`readBytes.ts` 的原始读取错误。

- 在目标第一次 `backup-write` hook 抛 `Error("PRIVATE_CUSTOMER_BODY_123")`，清理成功后调用者得到无 code 的同一原始正文。
- 不注入异常，仅对空库配置 `maxFileBytes=0`，得到 too-large，但公共 message/path 含完整源知识库绝对路径。

第一项模拟未知 IO 错误，第二项是正常公开预算入口可达。应在 backup 公共边界无论 cleanup 成败、取得目标前后都统一映射：固定类别、受控阶段、受控相对定位、有界诊断；不保留原始正文/cause/未知名称/完整源路径。成功清理不能成为透传许可，cleanup 失败也不能覆盖主 code。

## 4. 辅助复现片段

下面的 hook 可嵌入现有合成导出 fixture。一次只注入一个场景，且断言注入被触发；所有 outside/sentinel 也必须在自建沙箱内。

```js
// D2-2：发生在目标最终回读前，当前实现会错误成功。
let injected = false;
const ioHooks = {
  beforeIo(operation, targetPath) {
    if (!injected && operation === "open" && targetPath.startsWith(backupRoot)) {
      injected = true;
      writeFileSync(join(backupRoot, "data", "extra-secret.txt"), "UNDECLARED");
      // 另一用例改为：rmdirSync(join(backupRoot, "data", "features"));
    }
  },
};
// exportKnowledgeBackup({ root, backupRoot, offlineConfirmed: true, ioHooks })
// 修复后必须拒绝、无 manifest；未知 extra 不归本次所有，必须保留并报告残留。
```

D2-1 按 §3 的五步添加永久真实 junction 回归；D2-3 用已有 hook 与窄 IO 注入，不靠 sleep、不虚拟整套文件系统；D2-4 同时测试原始异常和零预算真实错误。

## 5. 验收边界与文档事实

- 本轮验证为合成库、本机文件系统；未测试真实 ACL、网络盘、断电、其它 OS、远端 CI、生产安装包或真实 BIOS/硬件。
- 仍接受 offline-copy 的观察式局限：不能证明没有写入者，也不承诺发现所有 ABA 或实现在线原子快照。不能用该局限免除已明确的最终验证和安全清理。
- 原实施记录 §6 的“关闭/发布/清理无专门用例”不能整体认定为中等技术债；本轮证明其中存在真实错误，D2-3 必须关闭。其它未执行范围继续如实留档，不扩展成无限平台防御。
- 文档中“未实施”“D1R 已关闭”与“待独立验收”曾混杂；本轮更新当前入口，以此报告为独立结论。历史实施快照保留，不将旧测试数冒充本轮测试。
- dirty tree、未跟踪代码及六项既有历史文档删除保留；独立实验的自有临时沙箱已清理，只删除已核对的本次诊断目录，未触碰真实知识库。
