# 03 数据与个人记忆：首段可测实现

`context/store.mts` 是无外部依赖的内存仓储替身，用于 02/04/06 的接口联调与 03 的隔离测试。它不跨进程持久，不提供生产事务或备份。正式 PostgreSQL 实现须遵循 `docs/contracts.md` v0.3.0，并复用这些行为测试。

最小调用顺序：03 创建已加入的 Contact；02 在名单和事件认证门控后调用 `appendObservedMessage`；02 确定 `generation`、`policyVersion`、截止点和允许的事实 scope；调用 `buildContext`，得到 `{snapshot,messages,facts,analyses}`；04 消费此投影。02 在方案创建及每条发送前检查自己的 generation/policy，并读取 03 的事实/证据版本失效结果。`readContextProjection` 会拒绝已删除、已过期或 scope 不再允许的快照。

`postgres/schema.proposed.sql` 保留为 03 的历史草案；总控已将修订版编号为 `db/migrations/0002_data.sql`。`postgres/context-repository.mts` 提供参数化、先按联系人和 scope 裁剪的读取适配，现由 `postgres/provider.mts` 在事务内调用。正式调用必须由可信后端执行 `setContactScope(tx, contactId)`，且使用不具备 BYPASSRLS 的受限数据库角色。`imports/service.mts` 只接收由未来 D05 解析器提供的规范行，预览并确认身份映射后以 `import` 模式写入原型。`media/file-store.mts` 和 `feedback/file-journal.mts` 使用私有持久目录，可跨实例重读；它们是开发阶段的单机实现，不提供跨进程事务或生产备份保证。

`postgres/provider.mts` 是 0002 表上的事务型 03 provider。调用方在 `withTransaction` 或 02 的现有事务内传入同一个 `PgClient`；03 在该事务内完成消息/事实/分析/快照变更、同步 dependency epoch 和 outbox。构建上下文返回 `dependencyEpoch`；02 将其随方案保存，在每条发送的 `withDispatchLease` 中调用 `readContextProjection(tx,{callerContactId,contactId,snapshotId,allowedScopes,expectedDependencyEpoch})`。03 不拥有发送权限，也不替 02 检查 policy/generation。生产角色必须受 RLS 限制，不能使用表 owner/superuser/BYPASSRLS；跨联系人管理读使用独立鉴权端口。

真实数据库联测：设置隔离 PostgreSQL 17 测试库的 `TEST_DATABASE_URL` 后运行 `node packages/data/postgres/provider.integration.mts`，并运行 07 的 `npm run test:integration`。总控已批准并落盘 `db/migrations/0003_data_scope_fix.sql`，修复 0002 的 global fact 无 scope 漏读，0002 本身未改。隔离 PostgreSQL 17.11 上统一 integration 3 pass、0 fail、0 skip；远程 CI、生产角色及真实平台仍需独立验收。见 `docs/reports/03-pg-provider-2026-09-23.md`。

运行：`node --test packages/data/context/store.test.mts packages/data/imports/service.test.mts packages/data/media/file-store.test.mts packages/data/feedback/file-journal.test.mts packages/data/postgres/context-repository.test.mts`。

当前调用者隔离采用 `callerContactId === contactId` 的进程内约束。管理端的本人跨联系人查询需要 API 鉴权并使用独立 owner 查询端口；不能给浏览器直接暴露此仓储。上线时数据库查询仍须加入 `contact_id` / `scope` 条件，并在真实 PostgreSQL 中做越权负测。
