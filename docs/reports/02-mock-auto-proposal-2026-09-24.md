# 02 → 架构总控：AC04 mock 自动发送最小纵切

状态：总控已批准私有证据表和全局迁移 `0007_mock_auto_approval.sql`；公共自动方案事件形状仍待版本化提案。公共契约 v0.3.0 保持原有 ConfirmPlan/SendTask/DispatchJournal 字段。

## 范围

仅当持久联系人策略明确 `sendMode=auto`、02 构造时显式启用 `mockAutoEnabled`、发送适配器是 `MockPlatformAdapter`、04 决定可回复且所有候选检查通过、风险仅为 ordinary、消息为 live 文字时，02 可选择第一候选自动生成固定分条 SendTask。默认开关为关闭；QQ/微信桥接与任何其他适配器不能启用此路径。自动方案不伪造本人确认票据，另存 `orch_mock_auto_approvals`，记录方案、内容 hash、批准时 policy/generation/dependency/skill 版本与原因。正式迁移建议 0007，排在现有 0006 后；由总控确认编号。

自动批准只使分条进入已有 `withDispatchLease`。每一条都重新核对策略、代际、03 快照/依赖、全局及联系人暂停、此前分条结果和内容 hash。任何新消息、本人接管、策略变化、未知结果或部分发送中断均按现有持久机制取消余条。风险、模型/Skill 故障或权限不明时不建自动发送任务，保留确认或人工处理。

## 公共契约提议

不新增公共命令和状态。总控裁决：自动方案暂不发布 `ReplyPlanProposed` v1，以免静默省略旧消费者可能依赖的 `taskId`，也不造虚假确认任务；公共自动方案事件另走版本化提案和消费者测试。Owner 会话投影用 `approvalSource=mock_auto|owner_confirmation` 如实区分来源，现有 SendTask 状态流仍可观察发送结果。该字段只在 02/06 私有投影中使用，尚未写入公共契约。

## 门禁与回滚

隔离 PostgreSQL 17 + 01 mock 验证低风险自动、需确认风险、缺事实/媒体、重启、重复入站、权限变化、未知发送、逐条竞态；真实 QQ/微信自动发送不在验收范围。关闭 `mockAutoEnabled` 后不产生新自动方案；已有未提交分条仍由 02 的同一发送前检查决定并可通过全局/联系人暂停阻断。D03/D04 继续使用现有保守默认，不固定生产时段参数。
