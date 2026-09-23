# 02 第一段交付：模拟确认闭环

日期：2026-09-23。依据 PRD v1.3、公共契约 v0.2.0。范围是 G1 的**内存参考实现**与 01/03/04 模拟联调；未接真实微信或 QQ，未达到生产发送门槛。

## 已交付

- `packages/orchestration/policy/evaluate.mts`：联系人默认确认模式、两个主动开关默认关闭；表白、关系决定、具体约见、重大承诺、敏感内容、停止请求与缺事实分类。04 的风险标签不直接授权发送。
- `packages/orchestration/conversations/engine.mts`：名单准入、策略版本、会话 generation、入站去重、候选持久 ID 分配（内存）、确认任务、编辑内容哈希与幂等键、旧方案失效、本人发言接管、单人/全局暂停、逐条发送前检查、部分发送取消、回执与结果未知阻塞。确认后只授权本方案；自动模式当前也转确认，原因 `AUTO_REVIEW_UNAVAILABLE`。
- `packages/orchestration/integration/mock-ports.mts`：仅用于开发的 03 MemoryDataContextStore 与 04 fake intelligence 接线。03 按联系人构造上下文，04 的局部 key 由 02 换成 UUIDv7；本人编辑后的文字再次送 04 检查。01 mock adapter 仍只由 02 持有发送 authority。

## 06 最小接口投影

查询应返回联系人/策略 `contactId, agentEnabled, sendMode, goal, activeContactEnabled, activeConfessionEnabled, policy.version`；会话控制 `state, pauseReasons, revision, generation, unresolvedSendId`；待办 `taskId, taskVersion, reasonCodes, allowedActions`；方案 `planId, planVersion, contextSnapshotId, triggerMessageIds, policyVersion, alternatives[{alternativeId,strategySummary,parts[{replyPartId,sequence,type,content}]}]`；发送 `sendTaskId, sequence, status, receiptLevel, platformMessageId, lastError, correlationId`。当前内存引擎只有 `getConversation`/`listPending`，正式 REST 投影由 06/总控与机器 schema 对齐。

`confirmPlan` 的必填字段遵循 contracts.md：`taskVersion, planVersion, alternativeId, editedParts, contentHash, idempotencyKey`；409 `STALE_PLAN/CONFLICT_VERSION` 必须刷新待办。`resumeContact` 在本模块按指定 reason 清除，不会一次清掉其他暂停原因；API 命令形状需随正式 schema 定稿。

## 验证

运行：`node --test packages/orchestration/conversations/engine.test.mts packages/orchestration/integration/mock-ports.test.mts`。结果：**11 pass / 0 fail**。覆盖 AC01/02/03/15/16/17/19/20 的模拟子场景，另有权限矩阵、重复命令冲突与超时未知阻塞；01→03→04→02→01 的文字确认与回执联调已通过。上述 AC 仍不能标产品验收通过，尤其 AC16/18/23 需要真实接入与持久恢复证据。

## 集成阻塞与后续

1. G0/03 尚无 PostgreSQL inbox/outbox、02 状态与 03 消息同事务、持久任务/发送账本。当前 `seen`、幂等键、确认票据和任务只在内存；进程重启不可恢复，不能用于真实发送。
2. `withDispatchLease`、DispatchJournal.claim/finish、事实/分析/技能实时版本校验、最终素材批准校验与截止时间尚未实现。当前 mock adapter 的 preflight 回调只验证内存状态，不能作为生产业务租约。
3. 聚合窗口、延迟、主动联系、主动表白的时段/冷却、媒体与表情发送、完整的停止/拒绝管理待办、反馈审计均待 G3/G4。D03 使用保守默认：自动模式待确认事项发送后仍需显式恢复；D04 参数不固化到本段。
4. 04 fake 只作确定性夹具，无法独立证明内容安全；因此本段不开放自动发送。03/04 接口通过本地 adapter 衔接，待 `packages/contracts` 建立后替换本地投影类型并补契约测试。
5. `PlatformOriginResolved`、恢复报告、媒体批准属于 v0.2.0 公共语义，但尚未接入本段引擎。01 的真实平台能力未验证。

本段未新增公共契约提案，也未改动其他模块或根配置。

## 续作：聚合与发送竞态（2026-09-23）

在上述 G1 成果上增量修改 `packages/orchestration/conversations/engine.mts` 及其测试；公共契约仍为 v0.2.0，未新增公共字段、事件或 API，因而本次没有待总控审批的契约变更。

- 增加运行时 `aggregationWindowMs`、`maxAggregationMs` 和供调度器调用的 `flushDue(conversationId)`。连续入站消息在同一收集批次中保留消息 ID 顺序，只对截止点生成一次方案；新消息重置静默窗口，但不超过最大聚合时间。默认窗口为 0，维持原 G1 即时生成行为。D04 仍未定；开发夹具采用 8 秒和 30 秒，生产参数未启用。
- `flushDue` 对同一 generation 避免重复生成；新消息、策略或控制变化仍使旧方案失效。非 live 的历史导入/试用事件可交 03 记录，但不改变 live 会话 generation、不失效待确认方案、不触发生成。
- 修复提交结果返回前发生暂停的竞态：平台已经接受的部分保留真实提交状态，但旧回调不能将会话重置为 READY；其余未提交分条仍取消。未知结果或明确失败时也取消后续尚未提交的分条。D03 继续按保守默认：自动模式待确认发送后需显式恢复。

验证命令：`node --test packages/orchestration/conversations/engine.test.mts packages/orchestration/integration/mock-ports.test.mts`，结果 **15 pass / 0 fail**。新增虚拟时钟聚合与最大窗口、收集期间新消息失效、平台接受后暂停竞态、历史导入隔离四项测试。AC05 获得内存 mock 的聚合子场景证据；AC17/20 获得提交后暂停与余条取消的模拟竞态证据；AC22 获得 02 侧“不进入实时流程”的模拟证据。均不等于真实平台或持久恢复验收通过。

随后补齐模型尚在生成时的新消息竞态，以及入站事件的 enrolled 外部联系人标识/actor 一致性校验；不匹配事件在写入 03 和调用 04 前拒绝。回执状态机对已接受发送的矛盾失败回执、平台消息 ID 冲突和非法跃迁记录 `RECEIPT_CONFLICT` 并暂停该联系人；未知发送被后续回执证实后清除未知标记，但要求显式恢复，不直接继续发送。最终复跑同一命令为 **19 pass / 0 fail**，新增四项覆盖这些边界。AC15/18/19 获得额外模拟竞态与回执证据，仍需持久账本和真实平台核验。

仍需总控/03 的 PostgreSQL inbox/outbox、状态与消息同事务、持久调度及 DispatchJournal；总控机器 schema 尚未落地。`flushDue` 目前由测试显式驱动，worker 定时领取、重启恢复和 G3 的主动联系/延迟/冷却尚未接入。`withDispatchLease`、事实/分析/技能实时版本及素材批准检查仍缺，因此自动发送继续关闭，不能接真实联系人。01 的真实微信/QQ 能力与回执也仍未验证。请总控在 G0/G3 集成时把聚合截止点与发送租约纳入持久调度和故障注入测试。

## 续作：PostgreSQL 确认发送闭环（2026-09-23）

在原内存参考实现之外新增 `packages/orchestration/postgres/confirmed-service.mts` 和 `schema.proposed.sql`。02 使用 03 正式 `PgDataProvider`，入站在同一事务中完成 inbox 去重、消息保存、generation/依赖 epoch 更新和旧方案失效；模型调用后持久保存候选、确认任务。Owner 确认复核快照、epoch、generation、版本、内容 hash，按分条创建固定 sendKey；发送前逐条走 `withDispatchLease`，回执同步到持久发送任务。启动 `recover()` 先将悬空提交意图标记未知并恢复中断的候选生成。依赖变化后的旧候选返回 `STALE_PLAN`；旧发送回调不能覆盖新一代会话状态。此 provider 只持有 `MockPlatformAdapter`，不接真实平台，也不开放自动发送。

已在本机配置隔离的 PostgreSQL 17.11 测试库（`127.0.0.1:55432/codex_orchestration_test`，数据位于临时目录）。运行 `TEST_DATABASE_URL=postgres://testuser@127.0.0.1:55432/codex_orchestration_test node --test tests/integration/postgres-confirmed-flow.test.mts`，结果 **1 pass / 0 fail**；覆盖模型在入站事务提交后崩溃、worker 重启生成、重复入站、确认幂等、两分条逐条提交、第二次重启、交付回执、依赖 epoch 变化拒绝旧确认、未知结果取消余条并在再次重启后保持阻断。`npm run test:unit` 为 **158 pass**，`npm run test:contracts` 为 **4 pass**，`npm run build:web` 通过。测试库仅用于隔离联调，正式迁移和实际平台均未验证。

`schema.proposed.sql` 尚未进入全局 `db/migrations`：已把 [持久化提案](02-orchestration-persistence-proposal-2026-09-23.md)及编号请求送架构总控，等待统一编号与审查。另在同一真实库运行 `tests/integration/postgres-recovery.test.mts`，受限角色的 RLS 断言 **1 fail**：事务结束后 `app.contact_id` 变为空字符串，现有 `0002_data.sql` 仍允许读取 global fact。03 已提交 `0003_data_facts_scope.proposed.sql`；复现结果已送架构总控协调 07。RLS 修复及负测通过前，不启用该持久流程作为安全部署。

已把 02 provider 路径与测试结果送 06 任务，请其接 07 鉴权的最小 Owner HTTP API 并将浏览器 fixture 换为真实 HTTP 联调。该 API 和 HTTP 浏览器验收不属于本段通过证据。后续还需策略/暂停的完整持久 Owner 命令、生成窗口的持久调度、发送前截止时间和 Skill/素材版本逐项复核、真实平台接入与 07 故障注入。

应 06 的最小 API 接线请求，02 随后补 `ownerOverview()`、`ownerTasks()`、`ownerContacts()`、`confirmTask()`、`pauseAll()`、`pauseContact()`。待办投影返回最近 100 个任务和真实分条状态，仅有效待确认任务提供 `confirmPlan`；暂停命令检查期望版本和持久幂等键，失效旧方案并更新 dispatch 暂停 epoch。确认及暂停仍须经 06/07 鉴权 HTTP adapter 才能暴露。真实 PostgreSQL 用例再次 **1 pass / 0 fail**，新增投影、分条未知状态、全局与联系人暂停幂等断言；签名和验证结果已通知 06。
