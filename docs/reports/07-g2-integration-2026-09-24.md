# 07 G2 集成与恢复实跑记录（2026-09-24）

基线 `main` HEAD `6d8e615` 加当日未提交共享工作区变更；公共契约 v0.3.0。环境为 Windows、Node 24.15.0、隔离 PostgreSQL 17.11（`127.0.0.1:55418`，专用 `chat_agent_test`，仅 loopback）、合成事件、fake OneBot HTTP 端点、mock adapter、Chromium 390px。没有连接真实微信或 QQ 账号，没有部署付费资源。完整原始命令输出见 `07-verify-local-2026-09-24.log`。

## 命令、结果与证据

| 检查 | 命令（省略隔离库 URL 的具体端口外细节） | 结果 | 证据与限制 |
| --- | --- | --- | --- |
| 迁移、scope 与恢复 | `TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55418/chat_agent_test PG_DUMP_BIN=<PG17 pg_dump> PG_RESTORE_BIN=<PG17 pg_restore> node --test tests/integration/postgres-recovery.test.mts tests/integration/postgres-data-provider.test.mts tests/integration/postgres-backup-restore.test.mts` | 3 pass，0 fail，0 skip | `0003_data_scope_fix.sql` 后，非 superuser/BYPASSRLS 受限角色在事务内 scope A 只能读 A 与 global；事务提交、无 scope 的后续查询读 **0 行**，含 global。03 provider 同样断言无 scope 读/写拒绝。独立数据库加私有 raw-event 文件恢复后，未解决发送仍阻断。|
| 完整本机门禁 | `TEST_DATABASE_URL=<isolated PG17.11> PG_DUMP_BIN=<PG17 pg_dump> PG_RESTORE_BIN=<PG17 pg_restore> RUN_BROWSER_E2E=1 PLAYWRIGHT_BROWSERS_PATH=<workspace Chromium> npm run verify` | 193 unit、4 contract、13 real-PG integration、8 E2E、网页构建通过；0 fail/skip | `07-verify-local-2026-09-24.log`。13 项包含 fake OneBot 入站→持久去重→02 确认→授权发送，以及重复/乱序、传输断开变 `RESULT_UNKNOWN` 和重启后不重发。fake OneBot 的 `accepted` 不等于真实 QQ 送达。|
| 曾出现的中间失败 | 同一完整命令先有 05 `listGranted` 的 `text = uuid` SQL 42883；05 修复后首次集成并行运行 fake OneBot 一例返回 503，单文件和随后完整重跑通过 | 已在最新完整门禁消失 | 05 负责人已修复其模块。503 未确定根因，保留并行稳定性风险；远程 CI 仍需运行。|
| 06 G2 手机负测 | `RUN_BROWSER_E2E=1 PLAYWRIGHT_BROWSERS_PATH=<workspace Chromium> node --test apps/web/server/g2-mobile-browser.test.mts` | 3 pass，0 fail，0 skip | 320/390px 夹具验证连接/故障查询不可用时不显示为 ready、503 不伪装成功、未知来源和历史缺口提示。该文件目前不在根 `npm run verify` 的 8 项 E2E 内，且仍属 UI fixture。|

备份恢复测试使用 `pg_dump --format=custom` 与 `pg_restore` 恢复到**另一空数据库**，另复制私有原始事件目录并核对 SHA-256/字节、消息和版本、待投递 outbox、发送账本、全局暂停与未知发送阻断。它没有覆盖媒体文件、会话目录、凭据、整机或生产增量备份，因此不构成完整灾备验收。CI 配置以 PostgreSQL 17 service 和容器内客户端执行同一用例；`deploy/pg-dump-ci.sh`、`deploy/pg-restore-ci.sh` 的 Docker 包装尚无远程运行证据。

## AC 与发布边界

`acceptance-matrix.csv` 保持 42 行，逐项列出环境、命令、子结果、证据、skip/blocked 原因与依赖。mock 只有 AC03、AC15 现列 pass；其余完整 AC 保持 blocked/not-run。微信 real 与 QQ real 各栏全部 blocked。AC09 的 RLS 子门禁已在真实 PostgreSQL 17.11 通过，但不代表跨联系人完整回复 AC 通过。AC23 的真人账号关机持续运行未执行。

待办依赖：远程 GitHub Actions 首跑与并行稳定性复核；01 真实平台来源/回执/历史覆盖；02/03/06 继续完善生产组合与 owner 查询不可用状态；入站 outbox 的崩溃后 pump/重放；独立媒体与整机恢复；D01、D06–D08。G2 仍为生产及真实联系人自动发送 **no-go**。
