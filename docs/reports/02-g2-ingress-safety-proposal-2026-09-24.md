# 02 → 架构总控：G2 消息变更与无法映射自身消息的保守门禁

状态：接口提案；公共契约 v0.3.0 不变。02/03/01 分别负责会话控制、证据状态和平台原始来源。

## 平台撤回/编辑

02 消费 `PlatformMessageMutationObserved` 时与 03 共用一个事务。03 拟提供 `invalidatePlatformMutation(tx,{callerContactId,contactId,conversationId,platformAccountId,platformMessageId,mutation},correlationId)`：用 live、账号、会话、平台消息 ID 精确关联；找到后保守墓碑化原消息内容，失效依赖事实/分析/快照，推进 dependency epoch 与 outbox；找不到返回 linked=false，不猜消息。02 不论是否找到都使旧方案失效、取消未提交分条、置 `PAUSED_FAILURE` 与 `PLATFORM_MUTATION_UNVERIFIED` 理由，并保持暂停直至本人审查。D09 的编辑新正文、撤回后保留范围与审计语义未定；此阶段不把任何替换正文重新纳入上下文。未提交发送不会继续使用可能过期的证据。

## 自身消息无法映射对端

01 在鉴权后若无法以受信来源确定对端，先保存原始事件，再调用 02 私有 `pauseAccountForUnmappedSelf(accountId,{rawEventRef,correlationId})`。02 在发送边界锁下批量暂停该账号已登记会话、提高 pause_epoch/generation、失效候选与未提交发送、标记 `OWNER_ORIGIN_UNMAPPED`；不虚造 contactId 或 data_messages。01 不从事件的 target_id 猜对端；后续由 Owner 核对证据和显式恢复。请 01 提供受信 rawEventRef/correlationId 与调用时点，07 测鉴权、断线和重放。

## Owner 只读投影

03 的 `PgOwnerDataPort.listUnknownOrigins({contactIds})` 已按联系人 RLS scope 裁剪为 `messageId/contactId/originStatus/originEvidenceRefs`。02 在 `ownerConversations()` 仅按 messageId + contactId 合并 unknown 来源，不读取原始 provenance、路径或凭据。无可信 01/07 汇总 provider 时 `connectionQueryStatus/faultQueryStatus='unavailable'`，空数组不得解释为已核对无故障。

本提案复用现有状态/原因字段，暂不占 05 预留的 0008。若总控要求新的公共事件、理由枚举或核对命令，再单独版本化提案和消费者测试。
