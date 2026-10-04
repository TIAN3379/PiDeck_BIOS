# 第七轮独立验收：BM-02BR 写入协议收尾

日期：2026-10-01。范围：BM-02BR W1～W4、交接 R1～R4，以及既有 BM-02B 写入回归。

## 1. 结论

**BM-02BR 在本机、协作式本地文件系统的已声明范围内通过，可以进入 BM-02C1。** 第六轮的 W1～W4 与中断交接的 R1～R4 已收口，本次未发现阻塞下一阶段的问题。

这不是整个 BIOS 专业 MVP、生产安装包或跨平台认证。两个文件型符号链接测试因 Windows EPERM 明确跳过，不能写为通过；journal、迁移、跨文件事务、知识 UI 和真实客户试点仍未实现。下一阶段只做 [BM-02C1 单文件 journal 与恢复核对](bm02c1_development_plan.md)，不提前做 UI。

## 2. 实际检查

- 实际仓库 `D:\BIOS_Pi_Agent\PiDeck_BIOS`，分支 `BIOS_Agent`，检查时 HEAD `36eb385a`；Windows + Node 24.14.1，Package 开发宿主 Pi 0.87.1。
- 直接读取 revision/commit/boundary/lock/write 源码、回归测试及 [实施记录](bm02br_implementation.md)，未仅凭实施方报告判定通过。
- 工作树包含前几轮累计修改/未跟踪文件；普通 git diff 不包含未跟踪源码，因此不是精确的“本轮改动清单”。未恢复六份已授权删除的早期文档。
- 验收方没有修改生产源码或永久测试，只运行检查并更新文档；没有 add/commit/push，没有修改 PiRuntime 或客户 BIOS 资料。

| 门禁 | 本次独立结果 |
|---|---|
| Package `npm test` | **183 测试：181 pass、0 fail、2 skip** |
| Package `npm run typecheck` | 通过 |
| Package `npm run check:format` | 31 文件，通过 |
| Package `npm run selfcheck` | 6 项，通过 |
| 根 `npm run typecheck` | 通过 |
| 根 `npm run check:format` | 2014 文件，通过；该脚本不覆盖 Package |
| 根 `node --test tests/processGuards.test.mjs` | 2 项，通过 |
| 根 `git diff --check` | 通过；不代替未跟踪文件检查 |

两个 skip 分别是 `storageRecords.test.mjs` 的最终记录文件 symlink，以及 `storageWrite.test.mjs` 的 registry 文件 symlink。目录 junction 的初始化/读写边界与 registry 准入用例实际执行，不是全组跳过。

## 3. 原任务与证据对照

| 项目 | 本次确认 | 结论 |
|---|---|---|
| W1 revision | 记录和 registry 共用安全整数/公共头逻辑；拒绝 unsafe expected/current 及 MAX_SAFE_INTEGER 递增；原 hash 不变，schemaVersion/createdAt 保留，updatedAt 不倒退 | 关闭 |
| W2 参数与诊断 | 写入口和公开取锁入口校验 timing；损坏/极端元数据有界处理、不抛 RangeError、不抢占；取消不被超时覆盖 | 关闭 |
| R1 等待剩余预算 | poll 取剩余 timeout 与配置间隔较小值；timeout=0 只尝试一次；超长 poll 不再强迫睡足整个间隔 | 关闭 |
| W3 正常 close | 失败中止提交；真实 FileHandle fd=-1 的生命周期断言覆盖正常、sync/close 失败、打开后取消等路径 | 关闭 |
| W3 创建与提交点 | create 用完整同目录临时文件 + sync + close + link，EEXIST 不覆盖、unsupported 不直写回退；更新仍 rename；提交后迟到取消/清理失败返回真实状态 | 关闭 |
| R2 失败清理 | 锁释放 failed/not-owner/missing、EEXIST + tmp 清理失败均保留首个错误并附加诊断；不删他人锁、不输出正文 | 关闭 |
| W4/R3 准入补证据 | 坏 JSON、未来版本、绑定冲突、目录拒绝普通写入；预先存在的目标记录 hash 保持；registry junction 根外 sentinel 保持 | 关闭（文件 symlink 权限边界保留 skip） |
| R3 并发与重试 | 真实双子进程创建/更新竞争、新进程读回、并发读者完整 JSON 与 revision 单调继续通过；故障注入重试最终成功/有界失败/取消通过 | 通过 |
| R4 格式/实施记录 | revision.ts 格式已修；README 提交路径和 timing/warnings 与代码基本一致；有唯一实施记录，不把自测冒充独立结论 | 关闭；验收方本次同步剩余导航/主计划的旧状态 |

## 4. 补充独立诊断

使用新建合成临时知识库，从公开 storage API 执行，不修改永久测试：

1. registry 人工置为 MAX_SAFE_INTEGER，update 拒绝且原 hash 不变。
2. 先持有目标锁，timeout=10/poll=1000 的写请求以 lock-timeout 收场，本次约 31ms（含文件 IO）；不再需要 120ms watchdog 取消收场。
3. 持锁元数据日期置为 1e100，仍是有界 lock-timeout，不抛裸 RangeError、不偷锁。
4. expectedRevision=99 冲突 + lock-remove EIO：保留 expected=99/actual=0 和 revision-conflict，追加锁未释放说明，残留锁可见，不携带合成正文。
5. 注入“真实先关后抛”的 close EIO：不提交，原 hash 不变，捕获句柄全部 fd=-1。
6. 第一次 rename 共享冲突后用定时器在实际退避期间 abort：整体 cancelled，仅一次 rename 尝试，原 hash 不变。这补充了现有用例主要在进入退避前 abort 的证据。
7. 先有合法记录再损坏 registry：update 在取锁前 invalid-json，目标/registry hash 不变、无新锁。

诊断结束前已清理本次新建临时库及其中受控残留锁，未删用户知识数据。故障注入只证明分支，不代表本机磁盘真实发生过 EIO/共享冲突。

## 5. 限制与下一步

- 未执行：根全量测试、生产构建/安装包、干净 clone 独立工具链、远端 CI、Linux/macOS、真实 EACCES/共享冲突实验、客户 BIOS 试点。不能凭本次结果宣布整个产品发布就绪。
- 目前只保证协作式单文件写入与原子可见性，不保证掉电持久性、OS 级沙箱或跨文件事务；进程崩溃后的锁仍需人工确认，不会自动按 PID/年龄回收。
- 第六轮/交接文档保留为问题来源，不再执行其旧提示词；BM-02B + BR 写入基础可供下一阶段开发使用。
- 唯一下一任务是 [BM-02C1](bm02c1_development_plan.md)。采用保守的“记录意图、核对实际结果、不自动重放旧内容”协议；C2 才讨论审计/多文件/迁移，D 才做管理与备份，BM-07 才做 UI。
