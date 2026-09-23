# 03 → 架构总控：数据持久化与依赖复核提案

当前裁决（2026-09-23）：按 [A09](../decisions.md)采纳到 `docs/contracts.md` v0.3.0，分配全局迁移 0001/0002；真实 PG 与 provider 接线仍待验证。下文是 v0.2.0 时的原始提案，不再表示当前未审批状态。

## 动机与缺口

现有机器契约、共享 PostgreSQL 事务装配和全局迁移编号尚不存在。03 已提供 `packages/data/postgres/schema.proposed.sql` 草案与按联系人裁剪的读取适配，但不能绕过总控自行把草案当生产迁移。02 发送前须同步复核事实/分析/证据有效性，仅靠异步 `FactChanged` 不够。06 的本人跨联系人管理查询需要独立鉴权能力，不能复用 02/04 的单联系人读取权限。

## 建议批准的公共接口与事务约定

1. `DataContextPort.readContextProjection({callerContactId,contactId,snapshotId,allowedScopes})`：复核引用版本、事实当前有效期、删除状态及 scope；失效返回 `STALE_CONTEXT`，并供 02 每条 preflight 使用。`isContextCurrent` 仅可作为同一语义的布尔封装。
2. `DataContextPort.getDependencyEpoch(contactId)` 或等效的同步版本令牌：事实、证据、分析、摘要、媒体解释的失效在同一事务内递增并写 outbox；02 在 `withDispatchLease` 中读取。全局事实变更须影响所有获授权联系人，不能只产生异步事件。
3. 独立 `OwnerDataQueryPort`：经 06 API 本人鉴权后按目标联系人执行管理读写；不得接受浏览器自报 `callerContactId` 作为授权依据。02/04 仍只能拿当前联系人的裁剪投影。
4. 03 的消息/事实/证据/分析/快照/导入/反馈/媒体元数据表使用总控统一编号迁移，接入共享 `pg` 事务与 outbox。正式表加数据库级联系人隔离策略或等效受限查询角色，并做绕过服务适配器的负测。`AtomicReceptionPort`、`DispatchJournal` 的跨域表与事务由总控审批后单独编号。
5. 稳定消息顺序键和 `ImportJob` 原始文件存放/回收方式在机器 schema 固定；不将 03 原型中的 `platformEventId` 字典序视为所有平台的最终顺序保证。

## 兼容、迁移和回滚

上述前三项为可选新增端口/字段；旧消费者可继续读原接口，02 新消费者在未具备同步复核时必须拒绝自动发送。迁移按总控编号先建 03 表与索引、再切 provider、最后切 consumer；对现存开发内存数据不承诺自动迁移。回滚时暂停 dispatch，保留已提交发送和审计事实，回退读取 provider；不能删除已提交的发送账本。

## AC 与协作者

- 02：AC08、15、17、21、29、34 的发送前同步复核；事实失效不能依赖事件延迟。
- 04：AC08、09、25–29、31、32 的证据投影、来源和失效处理。
- 01：AC05、16、18 的认证入站、来源更正、媒体原始引用。
- 06：AC21、22、27、29 的本人鉴权查询、纠正/删除和预览 UI。
- 07：PostgreSQL 数据库级隔离、跨进程重启、迁移、备份清除测试。
- 05：AC39–42 只能消费 03 已裁剪投影，试用模式不写事实或发送任务。

请总控评审并分配全局迁移号，确认事务/权限角色与机器 schema 后再把 `schema.proposed.sql` 升级为可执行迁移。
