# BIOS Agent 开发文档导航

只想让下一位 AI 接手，按以下顺序读：

1. 仓库根 `AGENTS.md`：开发边界与门禁。
2. [最新独立验收：第二十九轮](round29_acceptance.md)：732 项（727 通过、0 失败、5 skip）及指定门禁通过；BM-04 正常业务已交付，但 R29-1～4 阻塞整批通过，R28-3 仍未完整关闭。
3. [BM-04 实施记录](bm04_implementation.md)：真实需求/经验服务、审核、搜索、人工 CLI 与逐步子进程演示；§7 回写独立结论，前文为实施方快照。
4. [BM-03 实施记录](bm03_implementation.md)：已交付项目领域服务、人工 CLI 与真实子进程演示；§7 与更新日志回写 R28 修复事实，前文为实施方快照。R26-1～3 与 D3/D4 已通过范围保持。
5. [当前批次：R29 收尾＋BM-05 完整任务/上下文业务](bm05_development_plan.md)：内部修复过闸后直接完成任务状态/重开、人工交接包、Manifest 重验与经验草稿沉淀，一次交回；旧批次提示词不再执行。
6. [分层记忆与时态一致性设计](layered_memory_temporal_design.md) 与 [M1/M2 实施记录](memory_foundation_implementation.md)：M1 已实施，关系范围/授权剩余项归 R29-4；v1 路线保持，正式字段历史/沿革/耐久指纹与迁移未实现。
7. [MVP 主方案](mvp_development_plan.md) 与 [任务状态](task_breakdown.md)、[测试清单](test_checklist.md)、[开发日志](development_log.md)：产品目标、分阶段路线与实际进度。

按需要补读：

- [C2B 原完成标准](bm02c2b_development_plan.md) 与 [实施记录](bm02c2b_implementation.md)（§1～§9 为 C2B 历史，§10～§12 为三轮实施方快照，独立结论优先）：已落地的审核 IO 及实施方证据；旧提示词不重跑。
- [第十三轮验收](round13_acceptance.md)：F1/F2 的来源；conflict 绑定与三项主清理失败已通过，不重新执行整轮整改。
- [第十二轮验收](round12_acceptance.md) 与 [C2BR 原整改标准](bm02c2b_remediation_plan.md)：R1～R4 的来源；已关闭部分不重做。
- [C2A 原完成标准](bm02c2a_development_plan.md)、[C2AR 收尾标准](bm02c2a_remediation_plan.md)与[C2A 实施记录](bm02c2a_implementation.md)：修正后的协议见实施记录 §3；协议与纯校验的第十一轮通过结论保持，旧提示词不再执行。
- [第九轮验收](round9_acceptance.md)：C1/C1R 已通过，不重新执行已关闭的 J1～J4。
- [桌面接入边界](desktop-integration.md)：专业 Package 尚未正式接入 UI。
- [C1 原完成标准](bm02c1_development_plan.md)：协议和范围依据，旧提示词不再执行。
- [C1R 完成标准](bm02c1_remediation_plan.md)、[C1 实施记录 §6](bm02c1_implementation.md)与[第八轮验收](round8_acceptance.md)：J1～J4 的来源与修复历史，均不再是当前执行任务。
- [第七轮验收](round7_acceptance.md)：BR 已通过，不重复开发 W1～W4。
- [BM-02BR 实施记录](bm02br_implementation.md)：W1～W4/R1～R4 的实施方记录；独立结论见第七轮，不重复开发。
- [BM-02BR 原完成标准](next_development.md) 与 [第六轮验收](round6_acceptance.md)：已关闭问题的来源，非当前开发任务。
- [BM-02B 实施记录](bm02b_implementation.md)：历史自测与取舍（§5/§9 的提交路径表述已被 BM-02BR 取代），不替代验收。
- [中断开发交接](bm02br_handoff.md)：已接续完成，保留为当时快照与接续提示词，不再是执行入口。
- [第五轮验收](round5_acceptance.md)：B0 来源及前置证据；不是当前任务。
- [早期验收摘要](acceptance_history.md)：已关闭问题与被删除文档的恢复方法。
- `bm02a_*`、`bm02b_development_plan.md`：历史需求/设计依据，保留供契约和源码注释追踪；其中旧提示词不再执行。
- `product_brief.md`、`mvp_scope.md`、`tech_design.md`、`release_checklist.md`：早期桌面身份/发行阶段说明，不能替代 BIOS 专业 MVP 主方案或证明发布完成。

当前状态（2026-10-04）：第二十轮独立复跑 **423 项（420 通过、0 失败、3 显式 skip）**，七文件 240 项（239 通过、1 skip）、列举调用者五文件 194 项（191 通过、3 skip）及指定门禁通过。额度 15/0/1 的关闭故障独立诊断为 16/16、1/1、2/2，之后无新扫描 IO；C3/C3R 通过声明的本机只读盘点范围，PF-1～PF-4、S1～S3 收口。
**BM-02D1 主体已落地**：新增 `backupVersion=1` 契约与 93 项永久测试；第二十一轮独立复跑 `npm test` **516 项（513 通过、0 失败、3 显式 skip）**及指定门禁通过，但 B1/B2 曾阻塞。
**第二十五轮历史节点**：R24-1/2 已关闭；当时 D3 未开始。其通过范围保持，不重做旧整改。
**第二十六轮独立验收**：D3 恢复 API 与 D4 薄 CLI 已实现，正常 API/CLI 往返通过；独立 Package 641 项、backup＋CLI 218 项、旧存储 249 项及包/根指定门禁通过。当时源 manifest 变化、目标晚期合法字节漂移仍误报 restored，部分 CLI JSON 解析错误无对象输出，R26-1～3 阻塞整批通过，详见 [验收](round26_acceptance.md) 和 [实施记录 §15](bm02d3_implementation.md#15-第二十六轮独立验收回写)。不批准正式资料保护使用。
**第二十七轮独立验收**：独立 Package 680 项（676 通过、0 失败、4 文件型链接权限 skip），backup＋CLI＋memory 257 项（256 通过、1 skip）、旧存储 249 项（246 通过、3 skip）及指定门禁通过。R26-1～3 关闭，D3/D4 在声明范围通过；M1 已实施但 R27-1～3 待收口，M2 仅认可 BM-03 的 v1 路线，未批准迁移。 具体诊断见 [验收](round27_acceptance.md)，R26 独立关闭证据见 [D3/D4 实施记录 §17](bm02d3_implementation.md)。
**第二十八轮独立验收**：Package 711 项（707 通过、0 失败、4 skip）、memory＋project＋backup＋CLI 288 项（287 通过、1 skip）、旧存储 249 项（246 通过、3 skip）及指定门禁通过。BM-03 正常项目闭环已交付且真实新进程演示通过，但发布事实丢失、字段证据/预算、关系图、授权/CLI 四组问题尚待修复；整批未通过。R27-1/3 关闭，R27-2 部分关闭。新项目链接分支没有实际执行，确认竞争现有测试是同进程，不声称已证明双进程。详见 [验收](round28_acceptance.md)与 [BM-03 回写](bm03_implementation.md#7-第二十八轮独立验收回写)。
**第二十九轮独立验收**：Package 732 项（727 通过、0 失败、5 skip）、targeted 309 项（307 通过、2 skip）、旧存储 249 项（246 通过、3 skip）、包类型/格式 132 文件、selfcheck 6 项、根类型/格式 2014 文件与 processGuards 2 项通过。BM-04 正常录入/审核/搜索/跨项目参考已交付；详情授权/来源、别名与字段/证据、真实预算/取消/提交状态、关系范围过滤四组仍待收尾，整批未通过。真实双确认子进程已执行，项目链接权限分支显式 skip；不等于生产或真实厂商适配。见 [验收](round29_acceptance.md)。
R1～R4/F1/F2/I1 已在第十五轮声明的本机审核持久化范围收口，不重做。
C2A/C2AR 在第十一轮通过协议与纯校验范围，A1～A3 关闭，不重新执行旧任务。
C1/C1R 经第九轮通过声明的本机范围，J1～J4 已关闭。
C1 只做"记录意图 + 核对结果"：不重放数据、不回滚、不自动回收遗留锁（也没有按 PID/年龄抢锁或 `force`）。
C2B 打通了**一条经验卡审核**的真实持久化：意图/事件工件、审核专用 journal v2、领域入口、只读巡检与显式收口；
仍然**没有**身份认证、没有知识模型工具入口、没有知识 UI，也没有通用多文件事务、自动后台恢复或迁移；备份**导出＋恢复到新目录＋人工 CLI** 已由 D2R/D3/D4 覆盖（仅 offline-copy，不含在线快照/网络盘/断电原子恢复），未回写原库、不迁移 BIOS 源码、不重绑 registry 的旧工作区绝对路径。
用户确认加快节奏：[R29 收尾＋BM-05 完整任务/上下文业务](bm05_development_plan.md) 内部过闸后继续业务，一次交回；不升 schema、不重做历史底座。随后 BM-06 Pi 专业工具、BM-07 UI；不把全部时态存储升级设为业务前置。
