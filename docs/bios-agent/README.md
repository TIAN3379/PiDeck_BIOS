# BIOS Agent 文档

当前版本：v0.9.3（2026-10-07）。基于 PiDeck 的 BIOS 工程桌面助手：Pi 负责模型与执行循环，BIOS Package 提供知识工具和 Skills，桌面端处理权限、确认与本地管理。

- [使用指南](user_guide.md)：安装、接入、对话、任务接续、旧项目经验沉淀和知识库编辑。
- [技术架构](tech_design.md)：源码入口、保存、检索、自动记忆和安全边界。
- [分层记忆与时态设计](layered_memory_temporal_design.md)：v1 决策及尚未实现的历史/迁移边界。
- [下一步开发](next_development.md)：按实际缺口排序，不重做底座。
- [测试清单](test_checklist.md)与[发布清单](release_checklist.md)：复跑命令、验证范围与分发要求。
- [开发记录](development_log.md)：当前交付概要。
- [BIOS Package](../../packages/bios-agent/README.md)：独立加载、测试与 CLI。

同一主题只维护一份当前文档，不继续堆积旧轮次计划、验收、临时交接和截图。已提交历史由 Git 保留；清理前的未提交文档另有本机恢复快照，不随软件发布。

本版以 Windows x64 试用为主。构建和合成测试不代表实际固件编译、上板、量产或所有 IBV/Silicon 已适配。
