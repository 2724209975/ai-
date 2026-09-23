# 07 测试环境与发布门槛

当前只提供**隔离的 PostgreSQL 测试 Compose**，没有可部署的 API/worker、登录、真实 adapter 或生产镜像。`compose.test.yml` 不能用于生产；模拟闭环不能证明微信或 QQ 的现有个人账号接入。

本机有 Docker Compose 时，在项目根目录设置仅用于测试的 `POSTGRES_TEST_PASSWORD`，执行 `docker compose -f deploy/compose.test.yml up -d --wait`。将 `TEST_DATABASE_URL` 指向 `postgres://chat_agent_test:<test-password>@127.0.0.1:5433/chat_agent_test`，然后执行 `npm ci`、`npm --prefix apps/web ci`、`npm run verify`。真实数据库测试会在此数据库内创建随机 schema 和无登录受限角色，验证迁移、事务、重启后的未知发送及联系人 RLS，然后清理；测试库用户需具备 `CREATE ROLE` 权限。**不要把 TEST_DATABASE_URL 指向生产数据库**。未设置它时测试明确 skip，不能计为通过。`npm run migrate` 是单独的迁移入口，读取 `DATABASE_URL`；测试用例读取 `TEST_DATABASE_URL` 并自行迁移隔离 schema，两者不能混淆。

CI 使用 GitHub Actions 的隔离 PostgreSQL service，并安装 Chromium；会跑模块、契约、真实数据库端口、模拟跨模块闭环、网页构建和 390px 手机视口浏览器测试。浏览器测试由本地同源 fixture API 回答，只验证 06 客户端请求/状态展示，**不能计作 02/03 Owner API provider 已接通**。本机 Chromium fixture 的 2 条用例已通过；CI 配置尚未在远程运行，工作区也尚无 Git 仓库。所用 [checkout v7](https://github.com/actions/checkout/releases)、[setup-node v7](https://github.com/actions/setup-node/releases) 与 [PostgreSQL service](https://docs.github.com/en/actions/tutorials/use-containerized-services/create-postgresql-service-containers) 参考官方资料，版本仍以首次实际 CI 运行为准。

2026-09-23 续作：CI 缺少 `TEST_DATABASE_URL` 时 PostgreSQL 用例现在直接失败；本地无数据库时仍明确 skip。真实数据库回归新增 `withDispatchLease` 超时未知与 RLS global fact scope 生命周期检查。此前 RLS 检查在隔离 PostgreSQL 17.11 上复现了“提交后无 scope 仍可读 global fact”，已由 [A12](../docs/decisions.md) 批准的全局迁移 `0003_data_scope_fix.sql` 修复（不改写已应用的 `0002_data.sql`）；随后在本机隔离 PostgreSQL 17.11 实跑 `npm run test:integration` 为 **3 pass / 0 fail / 0 skip**，并额外通过真实 HTTP→PostgreSQL→mock 发送的浏览器 E2E。首次远程 CI 仍必须记录迁移、受限角色、恢复断言与浏览器用例的实际结果和运行链接。

本地 PostgreSQL 17.11 后续已实跑（覆盖上一段“尚未执行”状态）：迁移与恢复断言运行至 RLS 检查，受限角色在提交 scope 事务后无 scope 仍读到一条 global fact，整条集成测试失败。详见 07 交付记录。修复必须走架构总控的新全局迁移，随后重跑完整测试；远程 CI 仍未运行。

后续需要 02/03/06 provider、登录与鉴权接线后把浏览器 fixture 切换为真实 HTTP provider 联调，并增加命令竞态测试；真实微信、QQ AC23 必须在本人电脑关闭时分开采证。发布前按 [运行手册](runbook.md) 做独立备份恢复和故障演练，并填满 [验收矩阵](../docs/reports/acceptance-matrix.csv)。
