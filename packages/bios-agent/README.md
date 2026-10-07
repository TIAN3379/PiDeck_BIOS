# bios-agent Pi Package

版本 0.1.1，随 BIOS Agent 桌面分发，也可独立加载。参阅[使用指南](../../docs/bios-agent/user_guide.md)、[架构](../../docs/bios-agent/tech_design.md)、[分层记忆设计](../../docs/bios-agent/layered_memory_temporal_design.md)。

## 能力

项目检测/档案/确认字段；任务、决策、交接和动态上下文；只读 Git/diff 证据；经验草稿、正式需求确认、记忆维护；有界关键词/别名和候选索引；生命周期内准备背景、检索线索、记账与受控复盘；接入/UEFI/排障/功能移植 Skills。

外部 JSON 为权威数据，使用 revision/CAS、锁、journal、来源重验和离线备份。没有向量库、模型训练、全仓自动学习或正式 v2 迁移。Session 摘要不是工程事实。

## 加载和权限

```powershell
pi -e ./packages/bios-agent/extensions/index.ts
```

Package 清单登记 extensions/skills，桌面通过资源清单自动加载，测试基线 Pi 0.87.1。

宿主提供知识根、项目/客户/需求/目录许可、真实端点许可及运行时身份。未知配置默认拒绝；不能靠聊天文字或自定义环境扩大授权。桌面优先一次接入确认，不手填 UUID。

`/bios-workflow off` 暂停当前会话自主工作流，`/bios-context off` 只关显式任务上下文。草稿未审核，本项目 working 线索不会自动成为跨项目 current 推荐。

## 验证

```powershell
npm --prefix packages/bios-agent run typecheck
npm --prefix packages/bios-agent run check:format
npm --prefix packages/bios-agent test
npm --prefix packages/bios-agent run selfcheck
npm --prefix packages/bios-agent run scenario:project
npm --prefix packages/bios-agent run scenario:experience
npm --prefix packages/bios-agent run scenario:task
```

CLI 位于 cli，具体参数以脚本帮助为准，不绕过人工确认/提交门禁。测试保留存储与故障回归，用临时合成工程，不操作真实客户资料。旧轮次细节在 Git 历史中查阅，不重复复制到 README。
