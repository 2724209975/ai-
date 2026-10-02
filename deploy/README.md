# 07 本机测试环境入口

当前状态与门槛只见 [开发计划 §0](../docs/development-plan.md#0-当前状态每完成一个任务由总控更新本节)。P0–P4 在本人电脑上开发与验证；常在线部署位置到 P5 再决定，私有远程仓库与首次 CI 在 P6。compose.test.yml 仅用于隔离测试数据库。

阅读顺序：

1. [开发计划 §2.4](../docs/development-plan.md#24-完成定义每张卡都要满足)：完整门禁，0 fail、0 skip。
2. [运行手册](runbook.md)：本机操作、故障、暂停、备份与恢复；其中旧部署建议在 P5 复核。
3. [测试 Compose](compose.test.yml)：可选的隔离 PostgreSQL 服务，端口默认 5433，可配置 TEST_PG_PORT；不是生产环境。
4. [集成职责](../docs/tasks/07-integration.md)、[验收矩阵](../docs/reports/acceptance-matrix.csv)和本任务报告。

## 完整本机门禁

测试数据库必须与聊天库隔离。测试使用随机 schema、受限角色和独立恢复数据库，因此测试用户需要创建 schema、角色及数据库的权限。DATABASE_URL 用于运行应用和手工迁移，TEST_DATABASE_URL 用于测试，两者不能混淆。

```powershell
$env:TEST_DATABASE_URL='postgres://<测试用户>@127.0.0.1:55432/chat_agent_test'
$env:RUN_BROWSER_E2E='1'
$env:PLAYWRIGHT_BROWSERS_PATH='<本机 Chromium 缓存目录>'
$env:PG_DUMP_BIN='<PostgreSQL 17 客户端目录>\pg_dump.exe'
$env:PG_RESTORE_BIN='<PostgreSQL 17 客户端目录>\pg_restore.exe'
npm run verify
```

缺数据库连接、浏览器开关或备份工具路径造成的 skip 都不算通过。检查每一类测试的 fail/skipped，不能只看命令退出码。测试 Compose 的连接端口以实际配置为准；Linux 环境使用对应客户端可执行文件路径。
