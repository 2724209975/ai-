# 07 集成测试与部署启动记录

> 后续实跑状态以 [2026-09-24 G2 记录](07-g2-integration-2026-09-24.md) 为准；下文保留 2026-09-23 阶段证据与当时的阻塞状态。

日期：2026-09-23。状态 `In progress`。依据 PRD v1.3、`docs/contracts.md` v0.3.0；负责范围限定为测试、CI、隔离环境、证据矩阵和运行说明。没有创建生产环境或开启真实发送。

## 本段交付

- 根目录统一 `npm run verify`（总控维护 package/lock）串接模块、契约、PostgreSQL integration、网页构建与模拟 E2E。
- `.github/workflows/verify.yml`：GitHub Actions 的 PostgreSQL 17 service、Node 24、Chromium。该文件是待首次远程运行验证的 CI 配置；当前工作区未初始化 Git。
- `tests/contracts`：检查 04/05/06 禁止直连平台发送、全局迁移编号、基本凭据特征、42 行 AC 矩阵。`tests/integration/postgres-recovery.test.mts` 在真实 PostgreSQL 中创建隔离 schema，调用 G0 迁移和事务端口，覆盖原子回滚、重复入站、依赖 epoch、提交意图恢复为未知、未知结果禁止重发、消费去重，并用非 superuser 角色验证事实 RLS 联系人隔离。
- `tests/e2e/mock-confirmation.test.mts`：01 mock → 03 内存上下文 → 04 fake → 02 确认 → mock 回执，以及旧候选和未知发送。`mock-mobile-browser.test.mts`：Chromium 390px，06 build + 同源 fixture API，验证编辑确认请求、旧版本 409 和结果未知展示。fixture API 不是实际 Owner API provider。
- `deploy/compose.test.yml`、`deploy/README.md`、`deploy/runbook.md`：隔离数据库环境与恢复顺序；`docs/reports/acceptance-matrix.csv` 为 AC01–AC42 的独立 mock/微信/QQ 证据槽。完整 AC 目前均未标 pass。

## 本机验证

Windows / Node v24.15.0；`npm ci --cache .npm-cache` 成功。在工作区内安装 Chromium，设置 `RUN_BROWSER_E2E=1` 与 `PLAYWRIGHT_BROWSERS_PATH=C:\1\ai代聊\.playwright-browsers` 后执行完整 `npm run verify`；总控补充来源不明集成回归后最终复跑：142 项模块测试、4 项契约检查、5 项模拟 E2E（其中手机视口 2 项）与 06 构建通过，0 fail。没有 `TEST_DATABASE_URL`，真实 PostgreSQL 用例明确 skip 1 项。本机没有 Docker、psql 或 pg_ctl；真实 PostgreSQL 用例尚未运行，CI 也尚无远程执行结果。

## 仍需联调与发布阻塞

1. 首次 GitHub Actions 运行需确认迁移在 PostgreSQL 17 上成功、受限角色 RLS、生存/恢复检查与 Chromium 均实际通过；本机 skip 不能替代这份证据。
2. 02/03/06 尚无经过鉴权的持久 Owner API provider。浏览器 fixture 测试只能证明客户端行为；真实 HTTP/worker 多进程 E2E、暂停/恢复、部分发送、媒体短期鉴权、登录与 CSRF 仍待接线。
3. 真实微信和 QQ 的现有个人账号接入、本人来源、媒体、回执和本人电脑关机后的 AC23 均未验证。mock、QQ OneBot 原型和手机 UI 构建不能代替。
4. 无生产镜像、现有阿里云实例核查、独立 `pg_dump`/`pg_restore` + 媒体备份恢复、费用/SLO/保留期决定，故当前是 `no-go` 生产部署与自动模式。D01、D06–D08 仍须按 `docs/decisions.md` 处理。

## 07 本轮续作（2026-09-23）

### 环境与实际命令

环境为 Windows、Node v24.15.0、adapter=mock；工作区没有 `.git`，因此矩阵 commit 为 `unversioned-workspace-no-git`。本机 127.0.0.1:5432/5433 均无服务，未发现 Docker、PostgreSQL 服务或 PostgreSQL 命令行；WSL 没有可用发行版。未提供 `TEST_DATABASE_URL`，也没有远程 GitHub Actions 运行记录。

执行 `$env:RUN_BROWSER_E2E='1'; $env:PLAYWRIGHT_BROWSERS_PATH='C:\1\ai代聊\.playwright-browsers'; npm run verify`：142 项模块测试、4 项契约检查、5 项模拟 E2E 与网页构建通过；真实 PostgreSQL 集成测试 1 项 skip，0 fail。新增 PostgreSQL 回归代码未被真实数据库执行，不能记为通过。

矩阵更新后单独执行 `npm run test:contracts`：4 pass、0 fail。执行 `$env:CI='true'; npm run test:integration` 且不提供 `TEST_DATABASE_URL`：预期失败 1 项，错误为 `TEST_DATABASE_URL is required in CI`，证明数据库缺失不会在 CI 静默 skip；这不是 PostgreSQL 运行证据。`node --check tests/integration/postgres-recovery.test.mts` 通过语法检查。

### 本轮变更与验证限制

- `tests/integration/postgres-recovery.test.mts` 增加真实 `withDispatchLease` 传输超时后的 `RESULT_UNKNOWN`、新 sendKey 阻断、提交后跨连接存活检查；增加含 global fact 的 RLS 无 scope 读取检查。CI 环境缺 `TEST_DATABASE_URL` 现在直接失败，避免数据库门禁被 skip 掩盖。本机上述新增断言均未运行。
- `docs/reports/acceptance-matrix.csv` 为 42 条逐行补环境、命令、结果、证据、阻塞原因、风险限制和下一步依赖；微信 real、QQ real 均独立记为 blocked。AC03 与 AC15 仅在 mock 栏记通过，对应完整 AC 仍 blocked。其余已有单元子用例不升级为完整 AC pass。AC23 两平台均未执行。
- `tests/contracts/acceptance-matrix.test.mts` 对新增证据列强制非空。真实 HTTP/worker 的鉴权、会话、CSRF 和跨进程恢复用例仍待 02/03/06 provider 装配；当前 `tests/e2e/mock-mobile-browser.test.mts` 只使用同源 fixture API。

### 向架构总控的具体迁移提案（未自行修改公共迁移）

`db/migrations/0002_data.sql` 的 `data_facts_scope` 允许 `scope='global'`，前提只检查 `current_setting('app.contact_id', true) IS NOT NULL`。PostgreSQL 自定义 GUC 在事务级设置结束后可能呈空字符串；若如此，受限角色在无联系人 scope 的新事务可读 global facts。新增真实 PG 断言要求提交后无 scope 时连 global facts 也不可读。请总控在隔离 PostgreSQL 17 上验证；若复现，以新全局迁移（建议编号 `0003`，不要改已应用的 0002）把策略改为 `NULLIF(current_setting('app.contact_id', true), '') IS NOT NULL`，并检查所有联系人 scope 策略及受限运行角色。未拿到这项实测前，RLS 隔离不得验收。

### 发布判断与下一步

**no-go**：无真实 PostgreSQL 迁移结果、远程 CI、真实 Owner API/worker、独立数据库及媒体备份恢复、微信/QQ 个人账号能力与 AC23 证据。先运行 PostgreSQL 17 CI，处理迁移/RLS 回归；02/03/06 provider 到位后，用本人会话鉴权与 CSRF 构造真实 HTTP→worker→PostgreSQL→mock adapter E2E，并注入 API/worker/DB/adapter/model 重启、发送提交前/中/后断线、outbox 重放及未知发送人工核对。01 提供独立微信/QQ 真实证据后，分别更新矩阵。费用、实例、保留期与 SLO 依 D06–D08 决定；未部署付费资源，未开启真实联系人自动发送。

## 隔离 PostgreSQL 17 实跑补记（2026-09-23；覆盖上文数据库未运行状态）

通过 PostgreSQL Windows 二进制包 17.11 在系统临时目录的纯 ASCII 路径初始化独立 cluster，监听 `127.0.0.1:55417`，创建专用 `chat_agent_test` 数据库；版本查询返回 `PostgreSQL 17.11 on x86_64-windows`。使用临时信任认证仅绑定 loopback，不接入生产数据或平台。工作区中文路径下 `initdb` 在初始化阶段出现 UTF-8 字节错误，因此 cluster 与数据目录均放入系统临时目录。

执行 `$env:TEST_DATABASE_URL='postgres://postgres@127.0.0.1:55417/chat_agent_test'; npm run test:integration`，重复两次。两次均真实执行 0001/0002 迁移及幂等检查、入站/outbox 事务回滚与去重、依赖 epoch、worker 新连接后的 `SUBMITTING → RESULT_UNKNOWN`、禁止换 sendKey 重发、`withDispatchLease` 传输超时后的未知结果与阻断；这些断言均运行到 RLS 检查前且未失败。整条测试结果为 **1 fail、0 pass、0 skip**，不能把前述子断言登记为完整集成测试通过。

失败定位：`tests/integration/postgres-recovery.test.mts` 在受限 `NOLOGIN` 角色下，先于事务内 `setContactScope('contact-A')`，确认只读到 contact-A 与 global；提交事务后不再设置 scope，直接查询 `data_facts`，实际返回 `[{'scope_setting':'','scope':'global'}]`，期望 0 行。测试错误为 `transaction-local contact scope leaked after commit`。测试结束后清理检查：`test_%` schema 与 `test_role_%` 角色均为 0 个。此为**真实 PostgreSQL 17.11 复现的 RLS 安全门禁失败**，不是假设。`data_facts_scope` 中 `current_setting(...) IS NOT NULL` 对空字符串仍为真；应由架构总控按上文提案分配新迁移修订，不修改已执行的 0002。

矩阵已改记隔离 PostgreSQL 17.11 的失败环境；AC09 附加此 RLS 证据，但完整跨联系人回复 AC 仍 blocked。真实 HTTP/worker、远程 CI、微信和 QQ 均未因本次数据库实跑而升级状态。修复迁移后必须重新运行整个 PostgreSQL 测试，并以受限角色再次证明事务提交后无 scope 时 global fact 为 0 行，之后才能推进发布门禁。

已将上述新迁移提案发送给项目任务“00 项目总控与架构”。本机数据库已正常关闭；工作区下载包、解压目录及系统临时 cluster 已清理。矩阵变更后 `npm run test:contracts` 为 4 pass、0 fail。

## 02/03 接线后的隔离库复测（2026-09-23）

02/03 并行交付后，用另一隔离 PostgreSQL 17.11 cluster（loopback `127.0.0.1:55417`、专用空测试库）执行 `$env:TEST_DATABASE_URL='postgres://postgres@127.0.0.1:55417/chat_agent_test'; npm run test:integration`：**2 项中 1 pass、1 fail、0 skip**。`tests/integration/postgres-confirmed-flow.test.mts` 的 mock adapter 文字确认、两条分开发送与 worker 重启恢复通过；该用例临时装载 02 的 `schema.proposed.sql`，尚不等于全球编号迁移或已鉴权 HTTP provider 验收。`tests/integration/postgres-recovery.test.mts` 仍在无 scope 可读 global fact 处失败，诊断为 `scope_setting=""`。

另外执行 `node packages/data/postgres/provider.integration.mts`：03 provider 的事务、去重、上下文、跨联系人读等前置断言运行至末尾，在 `RLS_SCOPE_LEAK_AFTER_COMMIT` 失败（实际 1 行、期望 0）。执行 `node packages/data/postgres/rls-proposal.integration.mts`：**退出码 0**；该脚本在隔离 schema 重现 0002 泄漏，再单独应用 03 的 `0003_data_facts_scope.proposed.sql`，验证空 scope 无读取、A/B 互隔离以及无 scope 写入拒绝。这证明拟议 SQL 在该隔离用例中有效，**不表示总控已批准或全局迁移已应用**。发布门禁仍 no-go。

上述三组测试的临时 schema/角色清理后均为 0 个；第二个 PostgreSQL cluster 已关闭并清理。更新 AC03/AC09/AC18 证据后，`npm run test:contracts` 为 4 pass、0 fail。已向“00 项目总控与架构”补交 02/03 测试与拟议策略的实跑结果；截至本记录，`db/migrations` 仍只有 0001/0002，等待总控批准新编号迁移后重跑。

07 随后新增 `tests/integration/postgres-data-provider.test.mts`，把 03 原本独立执行的真实 PG provider/RLS 脚本接入统一 `npm run test:integration` 与 CI。07 原恢复测试也不再假定迁移永远恰好两份，便于总控追加 0003。数据库关闭后的本机检查：`npm run test:integration` 为 3 skip（无 URL）、0 fail；`npm run test:contracts` 为 4 pass；新 wrapper 语法检查通过。03 主责已确认其脚本也使用 `applied.slice(0,2)`，并在另一隔离 PostgreSQL 17.11 实例上运行统一测试，报告为 1 pass（02）、2 fail（03/07 的已知 RLS 漏读）、0 skip。wrapper 尚未在新迁移后实跑；当前 CI 的真实 PG 门禁应明确失败于已复现的 RLS 问题。

## 06 HTTP 端口到 07 门禁（2026-09-23）

06 新增 `apps/web/server/owner-http.mts` 与 `pg-owner-browser.integration.mts`。07 新增 `tests/e2e/pg-owner-browser.test.mts`，让根 `npm run test:e2e`/CI 在 `TEST_DATABASE_URL` 与 `RUN_BROWSER_E2E=1` 时执行真实浏览器→HTTP→02/03 PostgreSQL→mock adapter 的用例。当前本机无运行中的数据库，执行 `npm run test:e2e` 为 5 项原 mock pass、1 项新增 PG/HTTP skip；**该新增用例还没有 07 实跑通过证据**。06 原用例使用固定测试 cookie 与简单 Origin 前缀检查，仅代表 fixture，不代表生产登录和 CSRF。

07 另增 `tests/e2e/owner-http-security.test.mts`，用合成 HMAC 会话与精确 Origin/CSRF header 注入 06 路由，真实 HTTP 验证缺会话、伪造签名、缺 CSRF、恶意 Origin 均被拒绝，合法请求仅执行一次命令。`node --test tests/e2e/owner-http-security.test.mts`：1 pass。此为 07 安全边界夹具；正式会话签发、密码登录、撤销、密钥轮换及 API/worker 生产装配仍未实现，不能据此称真实 Owner 鉴权已完成。RLS 与生产鉴权两项发布门禁继续 blocked。
