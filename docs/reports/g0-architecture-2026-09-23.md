# G0 公共接口裁决与集成交接（2026-09-23）

需求基线：PRD v1.3。公共语义：`docs/contracts.md` v0.3.0。状态：公共底座已落盘，G0 退出门槛未关闭；真实平台和生产 provider 未接线。

## 四组提案裁决

| 来源 | 裁决 | 已落实 | 仍需对应模块接线 |
| --- | --- | --- | --- |
| 01 来源/恢复 | 接受 P01/P02；来源更正沿用 `PlatformOriginResolved` | `PlatformSelfMessageUnattributed`、`RecoveryReport` 类型/schema；mock 来源不明独立事件 | 01 的 QQ/微信真实 producer、覆盖实测与恢复证据；02/03/06 消费者 |
| 03 数据事务 | 接受同步投影复核、依赖 epoch、独立 OwnerDataQueryPort、全局迁移 | 0001/0002 迁移、RLS、事务/inbox/outbox、依赖 epoch 底座 | 03 的 PostgreSQL 写/读 provider 与受限角色；02 同事务发送前复核、06 本人查询 |
| 04 媒体/分析 | 接受可选媒体解释引用和结构化 claim；不接受静默类型降级 | 02 mock 桥接保留 `unsupported`，转 `PAUSED_MEDIA`；单测覆盖 | 03 解释/纠正存储、04 真实模型、02 正式待办/故障路由；D10 taxonomy |
| 06 REST | 仅批准 G1 最小查询与确认/暂停路由；其余 URL/JSON 暂不冻结 | contracts.md §3 记录资源/命令形状 | 02/03/07 的鉴权、CSRF、provider 与移动端联调；完整管理 API 后续审定 |

## 可复用底座与边界

- `packages/contracts` 首批机器类型/JSON Schema；其它对象随 provider 接线补齐。未知事件、未知来源、非 live 发送均须拒绝或暂停。
- `db/migrations/0001_core.sql` 与 `0002_data.sql` 全局编号；`scripts/migrate.mts` 用校验和拒绝迁移漂移。尚无本机真实 PostgreSQL 运行结果，不得将 SQL 文件存在当迁移通过。
- `packages/infrastructure/postgres` 提供事务、原子入站/outbox、消费者 inbox、发送提交意图和未知恢复、同步依赖 epoch。`withDispatchLease` 使用单库全局 advisory lock 串行提交边界与依赖/暂停变化，降低个人部署的竞态复杂度；02/03 provider 必须使用同一边界。网络提交与数据库仍非分布式事务，未知结果不可盲目重发。
- 数据表联系人读取启用 RLS；应用运行角色不得是 superuser/BYPASSRLS。`setContactScope` 只由可信后端事务调用，不能从浏览器参数直接授予跨联系人读取。本人管理查询需独立鉴权端口。

## 当前验证与待办

`npm run verify` 最终本机复跑：142 项模块测试、4 项契约检查、5 项模拟 E2E（含 2 项 390px Chromium fixture）及网页构建通过，0 fail；真实 PostgreSQL 1 项因本机没有服务而 skip，GitHub Actions 配置未远程运行。微信/QQ 个人账号、回执、历史覆盖与关机持续运行均未验证。详见 [07 交付记录](07-integration-start-2026-09-23.md)。

接线顺序：07 首先跑真实 PostgreSQL 迁移/恢复与 CI；03 将写入/失效接到同库事务，02 将每条发送接到 `withDispatchLease` 和 `readContextProjection`，01 提供真实来源/恢复证据，06 接最小 Owner API。任何模块遇到公共字段或状态变化继续提交提案，由总控同步 `contracts.md`、机器 schema、迁移与测试。
