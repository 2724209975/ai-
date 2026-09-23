# 02 → 架构总控：确认发送持久化接线提案

状态：待总控审查。基线 `docs/contracts.md` v0.3.0；不改变公共对象、事件、状态或 Owner API 语义。

## 动机与依赖

当前 02 的内存 `Orchestrator` 在重启后丢失策略、generation、方案、确认票据、幂等键及 SendTask。G0 有 `dispatch_control`、`dispatch_attempts` 和发送租约；03 随后已提交 `packages/data/postgres/provider.mts`，提供同事务 `appendObservedMessage`、持久 `buildContext`、`readContextProjection` 及依赖 epoch。02 已改用该正式接口，不保留重复的 03 临时实现。

## 建议持久对象和事务

由 02 拥有 `orch_conversations`（联系人/策略/控制/版本）、`orch_plans`（generation、policy 与依赖引用、候选和状态）、`orch_confirmation_tasks`（版本、待办状态、最终内容 hash 与确认票据）、`orch_send_tasks`（每条唯一 sendKey、内容 hash、状态/回执）、`orch_owner_commands`（幂等键与请求摘要）。业务行以 `conversation_id` 串行锁定，所有命令带版本；事实、分析、技能版本使用既有依赖 epoch 和 03 的 `readContextProjection` 同步复核。

06 所需最小暂停命令另用 `orch_control_commands` 保存 scope、幂等键、请求摘要、结果版本和 correlationId。02 提供 overview、tasks、contacts 查询投影，以及确认/全局暂停/联系人暂停 provider 方法；HTTP 鉴权、CSRF 和路由由 06/07 负责。

入站消费在一个事务中 `consumeOnce`、03 写 `data_messages` 且同步 bump `dispatch_control.generation/dependency_epoch`、02 读取新 generation 并失效旧方案及写 outbox。模型在事务外运行；持久 `buildContext` 写不可变 `data_context_snapshots`，模型返回后 02 用 generation/policy CAS 提交方案和待办。确认事务锁定任务与方案、验证内容 hash/版本、持久确认票据与每条 SendTask；重复幂等键返回同一方案与 sendKey。

worker 启动先 `recoverAmbiguous`，将已提交但缺 02 结果更新的账本状态同步到 SendTask；`SUBMITTING/RESULT_UNKNOWN` 阻塞该联系人且不重发。每条发送调用现有 `withDispatchLease`，其 `authorize(tx)` 在同一事务核对 live/全局与单人控制、generation、policy/依赖 epoch、方案/确认票据、最终内容 hash、03 投影有效性、上条状态和截止时间。网络提交后持久写回回执；后续每条重新走租约。部分发送保留已提交部分，取消未提交余条。

## 迁移、兼容与回滚

请总控指定新全局迁移编号：07 已提议 `0003` 修复事实 RLS，02 不自行占用该编号。建议在 RLS 修复后加入 02 表，并对 `dispatch_control` 与 02 会话维持单事务一致性。迁移只新增表和索引，不改已有公共 schema；旧内存参考实现保留供离线夹具使用，正式 provider 切换前先停 worker，执行迁移、确认只读恢复，再开放 mock 确认发送。回滚为暂停 dispatch 并恢复上一应用镜像；不得删除 `dispatch_attempts` 或已提交发送事实。

## 验收与协作者

03 提供事务级消息写入、快照写入及 `readContextProjection` 复核；01 保留 submit/receipt/reconcile 证据；04 提供可重建的结构化决定/检查；06 仅接已鉴权最小 Owner API；07 在真实 PostgreSQL 注入 API/worker 重启、outbox 重放、提交边界崩溃、乱序/重复回执、未知结果。影响 AC01–05、15、17–20；微信/QQ real 仍独立验证。本提案不开放自动模式或真实联系人发送。

## 真实库复现与协调

隔离 PostgreSQL 17.11 的 02 重启联调已通过。`tests/integration/postgres-recovery.test.mts` 则复现 0002 RLS 的事务结束后 global fact 泄漏，03 的 provider 联调也复现同一问题；`current_setting('app.contact_id', true)` 此时为 `''`，旧策略的 `IS NOT NULL` 条件仍为真。03 已另交 `packages/data/postgres/0003_data_facts_scope.proposed.sql`，请总控先批准其全局编号并交 07 复测受限角色，再为本提案分配后续编号。复现和迁移顺序已送架构总控；02 不改已发布的 0002，也不改变 v0.3.0 公共契约。
