# 07 G2 集成与恢复实跑记录（2026-09-24）

记录时 `main` HEAD `ecea2b2` 加当日未提交共享工作区变更；公共契约 v0.3.0。07 门禁环境为 Windows、Node 24.15.0、隔离 PostgreSQL 17.11（`127.0.0.1:55418`，专用 `chat_agent_test`，仅 loopback）、合成事件、fake OneBot HTTP 端点、mock adapter、Chromium 390px。07 没有进行真实账号发送或部署付费资源；01 已另行完成 QQ 本机只接收试验，证据见 `platform-qq-2026-09-24.md`。完整本机门禁输出见 `07-verify-local-2026-09-24.log`。

## 命令、结果与证据

| 检查 | 命令（省略隔离库 URL 的具体端口外细节） | 结果 | 证据与限制 |
| --- | --- | --- | --- |
| 迁移、scope 与恢复 | `TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55418/chat_agent_test PG_DUMP_BIN=<PG17 pg_dump> PG_RESTORE_BIN=<PG17 pg_restore> node --test tests/integration/postgres-recovery.test.mts tests/integration/postgres-data-provider.test.mts tests/integration/postgres-backup-restore.test.mts` | 3 pass，0 fail，0 skip | `0003_data_scope_fix.sql` 后，非 superuser/BYPASSRLS 受限角色在事务内 scope A 只能读 A 与 global；事务提交、无 scope 的后续查询读 **0 行**，含 global。03 provider 同样断言无 scope 读/写拒绝。独立数据库加私有 raw-event 文件恢复后，未解决发送仍阻断。|
| 完整本机门禁 | `TEST_DATABASE_URL=<isolated PG17.11> PG_DUMP_BIN=<PG17 pg_dump> PG_RESTORE_BIN=<PG17 pg_restore> RUN_BROWSER_E2E=1 PLAYWRIGHT_BROWSERS_PATH=<workspace Chromium> npm run verify` | **208 unit、9 contract、24 real-PG integration、13 E2E、网页构建通过；0 fail/skip** | `07-verify-local-2026-09-24.log`。新 G2 项含 fake OneBot 入站→持久去重→02 确认→授权发送、outbox 崩溃后补投/双 pump、来源不明账号暂停、撤回与未关联 mutation、重复/乱序、传输断开变 `RESULT_UNKNOWN` 和重启后不重发；内部 Skill outbox 亦独立验证。fake OneBot 的 `accepted` 不等于真实 QQ 送达。|
| 曾出现的中间失败 | 同一完整命令先有 05 `listGranted` 的 `text = uuid` SQL 42883；05 修复后首次集成并行运行 fake OneBot 一例返回 503，单文件和随后完整重跑通过 | 已在最新完整门禁消失 | 05 负责人已修复其模块。503 未确定根因，保留并行稳定性风险；远程 CI 仍需运行。|
| 06 G2 手机负测 | `RUN_BROWSER_E2E=1 PLAYWRIGHT_BROWSERS_PATH=<workspace Chromium> node --test apps/web/server/g2-mobile-browser.test.mts` | 3 pass，0 fail，0 skip | 320/390px 夹具验证连接/故障查询不可用时不显示为 ready、503 不伪装成功、未知来源和历史缺口提示。最新根 `npm run verify` 已包含该类 G2 E2E；仍属 UI fixture。|

备份恢复测试使用 `pg_dump --format=custom` 与 `pg_restore` 恢复到**另一空数据库**，另复制私有原始事件目录并核对 SHA-256/字节、消息和版本、待投递 outbox、发送账本、全局暂停与未知发送阻断。它没有覆盖媒体文件、会话目录、凭据、整机或生产增量备份，因此不构成完整灾备验收。CI 配置以 PostgreSQL 17 service 和容器内客户端执行同一用例；`deploy/pg-dump-ci.sh`、`deploy/pg-restore-ci.sh` 的 Docker 包装尚无远程运行证据。

## AC 与发布边界

`acceptance-matrix.csv` 保持 42 行，逐项列出环境、命令、子结果、证据、skip/blocked 原因与依赖。mock 只有 AC03、AC15 现列 pass；其余完整 AC 保持 blocked/not-run。微信 real 与 QQ real 各栏全部 blocked。AC09 的 RLS 子门禁已在真实 PostgreSQL 17.11 通过，但不代表跨联系人完整回复 AC 通过。AC23 的真人账号关机持续运行未执行。

01 的 QQ 真实本机**只接收**试验结论为 CONDITIONAL：知情好友的文字、图片、语音、QQ 原生表情各一条经 NapCat v4.18.28 签名入口接纳，原始事件私有留存；引用 ID 与一条撤回已记录，发送任务为 0。07 在矩阵 AC03/05/06/19 附该**01 原操作人记录**，但目前只有批次引用 `run:qq-receive-only-2026-09-24`，没有交给 07 的逐样本私有索引或真实试验库/原始目录访问条件，故 07 **未独立复核**每个 raw 文件、摘要和审计行。批次的 7 条 inbox = 6 条消息 + 1 条撤回，计数自洽，不能代替逐样本复核。完整 AC 的 `qq_status` 仍为 blocked；没有真实媒体字节抓取、本人/系统来源区分、断线补齐、送达回执、关机运行或任何真实发送证据。微信 real 未运行。

**2026-09-24 追加（本报告之后发生的平台实测）**：QQ 随后完成两次受控真实发送，并给出 `accepted` 级回执与平台消息 ID；微信侧经**离线偏移移植**后完成只接收实测（捕获文字/图片/语音 + 一条『拍一拍』，5/5 带平台消息 ID，见 [记录](platform-wechat-wxhelper-2026-09-24.md)）。这两项**不改变**本报告的判断：`acceptance-matrix.csv` 的 42 行 AC 仍按整条产品流程评估，微信接收端尚未接入 `apps/bridge`，因此 `wechat_status` 继续全部 `blocked`；QQ 的 AC23、本人/系统回显与媒体完整获取也仍未通过。

G2 只接收前置门禁在隔离 PG + fake OneBot 下通过：接收提交后故意让消费失败，待投递记录保持 `published_at IS NULL`，随后双 pump 并发仅消费一次、发布一次，重复 webhook 不产生第二待办；未映射自身消息保存私密 raw 并在同一接收事务暂停账号，名单外仅留发现元数据；冲突键拒绝且 raw 文件审计无孤儿；撤回匹配/未匹配均暂停，匹配时正文墓碑与依赖 epoch 同事务更新，重复 mutation 不重复失效；启动配置默认 outbound 关闭。证据分别为 `tests/integration/postgres-qq-bridge.test.mts`、`postgres-outbox-pump.test.mts`、`postgres-platform-mutation.test.mts`、`packages/platform/qq/bridge-run-mode.test.mts`。这只支持 01 进入本机 QQ **只接收**试验，不授权真实出站或自动发送。

05→02 内部 Skill 事件现由独立 `packages/infrastructure/postgres/skill-outbox-pump.mts` 消费 `SkillVersionChanged`/`GrantChanged`，不按 QQ accountId 过滤。`apps/web/server/main.mts` 这个**本地 mock 组合根**启动时重放并周期运行，停机前等待 pump。`tests/integration/postgres-skill-outbox-pump.test.mts` 在 PG17.11 验证消费者已提交而发布前崩溃、重启/双实例重投仅一条 02 inbox、全局与单联系人事件、坏 payload 留 pending 并报告故障；02 的 `postgres-skill-invalidation.test.mts` 另验真实方案失效范围。生产组合根尚未接线，QQ 进程不承担 Skill 消费，故不能宣称真实平台运行时已消费这些事件。坏事件会挡住队列后续 Skill 事件，需运维处置。

待办依赖：远程 GitHub Actions 首跑与并行稳定性复核；01 真实平台只接收来源/历史覆盖取证，后续独立回执与真实出站审定；媒体、会话目录与整机恢复；D01、D06–D08。G2 仍为生产及真实联系人自动发送 **no-go**。
