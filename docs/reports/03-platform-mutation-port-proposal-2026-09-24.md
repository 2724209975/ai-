# 03 平台撤回/编辑的同事务失效端口提案与 A19 落地

当前状态：总控已在 `docs/decisions.md` 接受 A19，并分配 `0008_platform_message_mutations.sql`。以下先保留审批前提案，再记录已落地版本；以末节为准。

## 已确认缺口

`PlatformMessageMutationObserved` 目前由 02 消费后失效未提交计划，但未通过 03 定位 `data_messages`，也未失效以消息为证据的事实/分析/快照或提升 `dependency_epoch`。现有 `data_messages` 无平台变更审计字段/表。PRD 的 D09 仍需平台样本确定编辑正文语义，因此编辑事件只能作为「旧证据不再可信」处理，不读取或猜测新正文。

## 拟定 02→03 端口（不改公共契约前先审议）

在 02 的 `consumeOnce` 与 dispatch boundary 同一个 PostgreSQL 事务内调用：

```ts
invalidatePlatformMessage(tx, {
  contactId, conversationId, platformAccountId,
  platformMessageId, platformEventId,
  mutation: 'recall' | 'edit',
  rawEventRef, receivedAt,
}, correlationId): Promise<
  | { status: 'applied'; messageId: string; oldVersion: number; newVersion: number }
  | { status: 'duplicate'; messageId?: string }
  | { status: 'unmatched'; affectedContactId: string }
>
```

- 03 先校验联系人、会话、平台账号三者绑定；事务本地设置 `app.contact_id`，只按 `(mode='live', platform_account_id, conversation_id, platform_message_id)` 定位消息并 `FOR UPDATE`。不允许仅凭平台消息 ID 跨联系人检索。
- `platformEventId` 用作同一次变更的去重键。相同键、相同不可变字段重复时返回 `duplicate`，不重复提升版本/epoch/outbox；同键不同内容返回 `CONFLICT_VERSION`。原始证据引用仅允许不透明 ID，不存平台令牌或私有媒体字节。
- 匹配时追加平台变更审计，旧消息 `version+1` 并从上下文排除。第一版建议沿用现有 `deletion_status='deleted'` 且清空 `content_ref/media_id`，平台原始字节仍由私有原始事件存储与审计引用保留；关联事实清空正文/墓碑，分析失效，快照失效；同一事务提升该联系人的 dependency epoch、写 `EvidenceInvalidated` outbox。若总控希望保留正文供人工核对，需另加 `evidence_status` 并确保 03 查询、04 分析和发送前复核全部排除 invalid 状态；不得只加字段而让旧查询继续读取。
- `unmatched` 仍记录变更事件及受影响联系人，不写猜测消息。02 必须同事务失效未提交计划并将联系人暂停待核；不能因没有关联消息就继续自动发送。
- 02 不因来源更正或平台变更自动清除 `OWNER_ORIGIN`、`MEDIA_UNCERTAIN` 等既有暂停。发送前 `readContextProjection` 应因快照状态/epoch 改变返回 `STALE_CONTEXT`。

## 拟议新编号迁移（编号由总控分配，避开 0007/0008）

新增只追加 `data_platform_message_mutations`：`id uuid PK`、`contact_id uuid FK`、`conversation_id uuid`、`platform_account_id uuid`、`platform_message_id text`、`platform_event_id text`、`message_id uuid NULL FK`、`mutation text CHECK(recall/edit)`、`raw_event_ref text`、`received_at timestamptz`、`status text CHECK(applied/unmatched)`、`old_version bigint NULL`、`new_version bigint NULL`、`created_at timestamptz`。唯一键 `(platform_account_id,conversation_id,platform_event_id)`；`message_id` 允许空，以保存无法关联的风险证据。启用并强制 RLS，`USING/WITH CHECK` 仅允许事务本地 `app.contact_id=contact_id`，无 scope 时不可读写。新表只存引用与状态，不存原文/媒体/令牌。迁移需走全局 checksum 与 07 的隔离库测试；不改写 0002 或占用 02 的 0007、05 候选 0008。

## 审批后要落盘的负测门禁

1. A/B 同平台账号、相同 `platformMessageId`：A 变更只能命中 A；伪造 A contactId 搭配 B conversation/account 被拒，B 的正文、快照、epoch 均不变。受限角色无 `app.contact_id` 不得读写审计表。
2. 已有关联消息的撤回与编辑：原消息不再进入 `queryMessages/buildContext`；以其为证据的事实/分析不再进入上下文；旧快照的发送前同步复核返回 `STALE_CONTEXT`，epoch 和 outbox 各增长一次。编辑事件不给正文时不得用新正文替换。
3. 相同 `platformEventId` 重放：审计行、消息版本、epoch、outbox 均不增加；同键异内容冲突；在事务内强制异常回滚后，消息/事实/快照/epoch/outbox/审计必须一起回滚。
4. 平台消息 ID 无法关联：审计行为 `unmatched`，不误改其他联系人；02 保留 `PAUSED_*` 待核状态并取消未提交发送。不能把「没有查到消息」判定成安全恢复。
5. 已删除消息再次收到变更、乱序 edit/recall、同一消息不同事件键的多次变更：第一版按 fail closed，仅追加审计并保持旧上下文不可用，绝不复活正文或自动解除暂停。

以上为审批前的提案状态。D09 编辑/撤回格式仍待 01 的真实样本；D07 私有文件与备份清除仍待生命周期决定。

## 2026-09-24 总控批准的最小端口落地

总控先批准不依赖新迁移的最小失效方向。03 已在 `PgDataProvider.invalidatePlatformMutation` 落地如下签名，供 02 当前事务调用：

```ts
invalidatePlatformMutation(tx, {
  callerContactId, contactId, conversationId, platformAccountId,
  platformMessageId, mutation: 'recall' | 'edit',
}, correlationId): Promise<{ linked: boolean; messageId?: string }>
```

它先验证调用联系人 scope 和联系人/会话/账号绑定，再按 live/account/conversation/platformMessageId 加锁查找。未找到只返回 `linked:false`，不改猜测消息；找到且仍 active 时复用 `deleteMessage` 的消息正文墓碑、关联事实墓碑、分析/快照失效、dependency epoch 与 `EvidenceInvalidated` outbox，同一事务完成。重复命中已删除消息返回 linked=true，不二次提升 epoch/outbox。`mutation` 仅进入 outbox 的失效原因 `platform_recall/platform_edit`，编辑的新正文不会进入上下文。

受限角色 PostgreSQL 用例 `node packages/data/postgres/provider.integration.mts` 已退出 0，覆盖 A/B 同平台消息 ID、跨联系人伪造、匹配失效、旧快照同步复核、事实墓碑、重复与未匹配不二次提升 epoch；03 单测 `node --test packages/data/postgres/*.test.mts` 为 5 pass。此时的最小端口尚无只追加 mutation 审计表；随后总控接受 A19，见下节。

## A19 已批准的审计端口与迁移

总控分配全局 `0008_platform_message_mutations.sql`，03 已落地 `PgDataProvider.invalidatePlatformMessage(tx,{callerContactId,contactId,conversationId,platformAccountId,platformMessageId,platformEventId,mutation,rawEventRef,receivedAt},correlationId)`。按平台事件键读只追加审计表；相同键同内容返回 `duplicate`，冲突返回 `CONFLICT_VERSION`；精确关联 live 消息时调用保守墓碑端口并追加 `applied` 审计，找不到则追加 `unmatched` 审计。`0008` 表只存引用/版本/状态，启用强制 RLS。02 当前调用此已批准接口，编辑新正文仍不进入上下文。

07 在隔离 PostgreSQL 17.11 `127.0.0.1:55418/chat_agent_test` 已运行最新统一集成门禁，报告 20 pass / 0 fail / 0 skip，包含平台 mutation 审计/重放/跨联系人和 fake OneBot recall。03 将以此连接再跑本专项门禁并记录。D09 真实平台编辑语义与 D07 文件/备份清除仍未完成。
