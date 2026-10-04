# 第二十一轮独立验收：BM-02D1

日期：2026-10-04。仓库 `D:\BIOS_Pi_Agent\PiDeck_BIOS`，分支 `BIOS_Agent`；Windows / Node 24.14.1。

结论：**D1 主体已落地，常规门禁通过，但整体暂未通过。** 独立诊断发现 B1 原始字节长度/品牌判据失真、B2 排除数组缺少遍历前数量边界。下一轮仅做 [D1R 两处有限收尾](bm02d1_development_plan.md#8-当前唯一任务bm-02d1r)，通过后再安排 D2 离线导出。第二十轮 C3/C3R 的通过结论保持，不重开已关闭整改。

## 1. 独立门禁

排期更新（同日）：用户随后确认加快节奏，当前执行入口改为 [D1R＋D2 加速批次](bm02d2_development_plan.md)。本报告保留验收事实；§5 当时的“仅 D1R、再单独领取 D2”交接安排已被新批次替代，B1/B2 尚未因此关闭。

| 门禁 | 实际结果 |
|---|---|
| D1 两个新测试文件 | 93 项：93 通过、0 失败、0 skip |
| Package `npm test` | 516 项：513 通过、0 失败、3 显式 skip |
| Package 类型 / selfcheck / 格式 | 通过；selfcheck 6 项；格式 77 文件 |
| 根类型 / 格式 | 通过；格式 2014 文件 |
| 根 `tests/processGuards.test.mjs` | 2 项全部通过 |
| `git diff --check` | 通过 |

三个 skip 仍为本机文件型符号链接权限限制，不计为行为通过；D1 的 93 项均实际执行。额外诊断不是永久测试，不计入 516 项。

## 2. B1：长度及原始字节品牌必须来自真实视图（P2）

落点：`packages/bios-agent/core/storage/backup/verify.ts`，`instanceof Uint8Array` 判定及第 96～108 行的 `bytes.byteLength` 比较/累加。

真正的 `Uint8Array` 可以定义同名自有 `byteLength` 属性。当前实现读取该属性，但 `createHash().update()` 按底层实际视图取字节；两者因此可能不是同一长度。

独立复现：实际视图为 `[65, 66]` 两字节，hash 独立计算自这两个字节；清单声明 1 字节，单文件/总 payload 上限均为 1。把视图的自有 `byteLength` 设为 1 后，核验返回 **`{ok:true, files:1, totalBytes:1}`**，实际仍 hash 了 2 字节。上限和成功摘要都失真。

| 对照 | 结果 | 核验期间 hash 调用 |
|---|---|---:|
| 正常 2 字节视图，清单声明 1 | 受控 `payload-size-mismatch` | 0 |
| 同一视图覆盖 `byteLength=1` | 错误成功，报告总量 1 | 1 |
| 正常非零偏移 Buffer 子视图，清单/预算均为 2 | 成功，总量 2 | 1 |

计量前已准备清单、fixture 和期望 hash，避免把 fixture 构造计入 hash 调用；包装 Node crypto 只计数并转发真实实现，结束后恢复。

另一个同源对照：`Object.create(Uint8Array.prototype)` 配自有 `byteLength=1`，也通过 `instanceof`，但不是真正字节视图。当前核验会从 Node crypto 抛出原始 `ERR_INVALID_ARG_TYPE`，没有返回承诺的受控失败。

可在 Package 根用 Node ESM 运行的最小复现（无 IO）：

```javascript
import { createHash } from "node:crypto";
import { verifyBackupPayload } from "./core/storage/backup/index.ts";

const bytes = new Uint8Array([65, 66]);
const sha256 = createHash("sha256").update(bytes).digest("hex");
const manifest = {
  backupVersion: 1, backupId: "backup-1", createdAt: 1700000000000,
  consistency: "offline-copy", exclusions: ["cache", "locks"],
  directories: ["projects", "experiences", "features", "audit"],
  files: [{ path: "registry.json", bytes: 1, sha256 }]
};
Object.defineProperty(bytes, "byteLength", { value: 1 });
console.log(verifyBackupPayload(manifest, [{ path: "registry.json", bytes }],
  { maxFileBytes: 1, maxTotalPayloadBytes: 1 }));
```

这是纯 API 已接受的对象形态造成的契约错误，不是已经证明存在真实文件攻击；普通文件读出的未改动 Buffer 对照正常。修复不要求把 API 改造成任意 JavaScript 对象、Proxy 或并发共享内存的安全沙箱。

## 3. B2：固定排除集合也要先限条数（P2）

落点：`packages/bios-agent/core/storage/backup/manifest.ts`，`readExclusions()` 第 142～148 行。

协议已经要求 exclusions 恰好两项，但实现只判断 `Array.isArray`，随后完整 `for...of`，最后才拒绝。该数组不受 `maxFiles`/`maxDirectories` 限制，`maxManifestBytes` 也只在成功构造清单后检查，不能阻止这里的超长非法输入消耗。

独立诊断用 100,001 项普通数组、每项均为 `cache`；给其迭代器加只计数并转发原数据的包装，不改变长度或条目。`maxManifestBytes=1`，分别用 `maxIssues=0` 和 1：两次都实际访问 **100,001 项** 后才失败。零问题预算仍正确拒绝，但没有限制遍历工作。合法反序 `['locks', 'cache']` 对照通过。

完成标准是数量不等于 2 时，在访问元素/调用迭代器前返回 `invalid-exclusions`。不需要新增一套可配置 exclusions 预算，也不能改成排序/去重后容忍多项。

## 4. 已确认的交付与范围

本轮新增独立 `backupVersion=1` 契约、规范路径和受控落点、七项独立预算、类型化 manifest 校验及内存字节核验。存储层窄出口接入，新增两个错误类别；未扩展旧读写/预检行为。

既有测试已覆盖固定布局、Windows 路径别名拒绝、祖先/重复/排除、数量/字节预算和安全整数累加、裁剪不误报成功、缺失/多余/重复 payload、CRLF/BOM/非法 UTF-8 等原始字节。业务版本准入与字节一致明确分开，这个取舍保持。

仍无导出/恢复 IO、管理 CLI、知识 UI 或记忆实现；hash 不提供签名或身份认证，路径合法不证明真实磁盘没有链接。未测根全量单测、生产打包/安装、远端 CI、干净 clone、其它 OS、真实 ACL、断电或 BIOS/硬件。

## 5. 下一轮与验收交付

按分阶段开发技能，只排 **BM-02D1R：关闭 B1/B2并补永久回归**。规格和短提示词已追加至 [D1 方案 §8](bm02d1_development_plan.md#8-当前唯一任务bm-02d1r)，不另开一份重复方案，也不重跑原 §7 提示词。

D1R 通过后顺序不变：D2 离线导出 → D3 仅恢复到新目录 → D4 最小人工 CLI → M1 记忆纯决策 → M2 兼容/持久化闸门 → BM-03～05 → Pi 工具 → BM-07 UI。M0 分层记忆设计保留，不推翻底座，不立即升 schema 或引入 RAG/自动学习。

本次仅写验收、接续规格及状态文档，未修改运行代码或永久测试；诊断全部使用进程内合成对象，无真实知识库/客户源码读取，无临时诊断文件。未 add/commit/push，累计脏树、未跟踪文件及六项既有历史文档删除保留。
