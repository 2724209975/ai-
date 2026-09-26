# 00 总控：生产核心组合根落盘记录（2026-09-26）

## 背景与范围

07 G2 记录（2026-09-24）指出的缺口是「生产组合根尚未接线」；本机此前只有两个组合根：`apps/web/server/main.mts`（管理端 + mock 平台适配器，明确不是生产部署）和 `apps/bridge/*`（每平台账号的入站/出站桥接）。缺少一个**不派发的常驻核心进程**：本人管理 API + 聚合/收集 + 05 Skill 内部 outbox 消费。

本次交付 P0 第 2 项，只做工程与运维接线，**没有**新增产品语义、没有改公共契约对象/事件/状态、没有新增迁移、没有真实平台动作、没有部署付费资源。

## 变更文件

| 文件 | 作用 |
| --- | --- |
| `apps/core/config.mts` | 生产核心配置解析与失败关闭校验 |
| `apps/core/health.mts` | `/healthz`、`/readyz` 与共享库就绪探针 |
| `apps/core/runtime.mts` | 核心运行时组合：API + 收集 worker + Skill pump + 请求日志 |
| `apps/core/main.mts` | 进程入口（`npm run serve:core`） |
| `apps/core/README.md` | 运维与边界说明 |
| `packages/infrastructure/observability/logger.mts` | 单行 JSON 结构化日志（类型化字段 + 凭据/正文抹除 + 行长上限 + sink 故障隔离） |
| `packages/infrastructure/observability/request-id.mts` | `X-Request-Id` 采纳规则与粗粒度路由标签 |
| `packages/orchestration/postgres/worker.mts` | 新增 `dispatchEnabled`（默认 true；核心传 false） |
| `apps/web/server/owner-http.mts` | 复用同一 `X-Request-Id`，让错误响应体与日志行可关联 |
| `tests/contracts/architecture.test.mts` | 新增「核心不得触达平台适配器/派发/发送调用」契约断言 |
| `tests/e2e/core-server.test.mts` | 把 `apps/core` 的测试纳入门禁 |
| `tests/integration/postgres-core-runtime.test.mts` | 真实 PostgreSQL 下的核心运行时纵切 |

## 关键决定

1. **派发留在桥接，核心结构上不能发送**。核心的 worker 以 `dispatchEnabled: false` 构造，`PgConfirmedService` 拿到的是账号 `core-no-dispatch`、`submitSend` 只抛错的平台对象。因此核心既不能接纳平台事件（账号不匹配会 `VALIDATION_FAILED`），也不可能提交发送。契约测试对 `apps/core` 断言：不得 import `packages/platform/` 或 `apps/bridge/`、不得出现 `submitSend(`、不得出现 `dispatchEnabled: true`。
2. **启动即暂停**。`START_PAUSED` 默认 1：先读 `dispatch_global_control`，若为活动态则调用 02 的 `pauseAll`（走同一 CAS/幂等入口），再执行 `recover()`。暂停态重启只记录、不重复抬高 epoch。
3. **失败关闭的配置**：非回环 origin 必须 HTTPS；非回环监听必须显式 `ALLOW_NON_LOOPBACK_BIND=1`；`OWNER_PASSWORD_HASH` 必须是 scrypt 存储格式；智能提供方必须显式命名且当前只接受 `persistent-fake`。
4. **可观测但不泄密**：日志为单行 JSON，字段限扁平标量；键名命中凭据/正文名单写 `[redacted]`，超长值折叠，整行超 4096 字符降级为截断行；路由标签把 uuid、18–19 位平台消息 ID 等替换为 `:id`。健康检查只回固定检查名与 ok/failed。

## 命令、结果与证据

环境：Windows、Node 24.15.0、隔离 PostgreSQL 17.11（`127.0.0.1:55418`，仅 loopback）。PostgreSQL Windows 二进制放在**纯 ASCII** 路径（见「发现」一节）。

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 单元 | `node --test packages/infrastructure/observability/logger.test.mts packages/infrastructure/observability/request-id.test.mts packages/orchestration/postgres/worker.test.mts apps/core/config.test.mts apps/core/health.test.mts` | 5 个文件全绿（含日志抹除、请求 id 采纳、派发开关） |
| 契约 | `npm run test:contracts` | **10 pass**（新增核心不可发送断言） |
| 真实数据库纵切 | `node --test tests/integration/postgres-core-runtime.test.mts` | pass：`/healthz`、`/readyz`、无会话 401 且响应体 `correlationId` 等于 `X-Request-Id`、启动即暂停（数据库先前为活动态）、二次 `start()` 不抬高 epoch、已确认且可派发的分条在核心 `worker.tick()` 后仍为 `CREATED`、`dispatch_attempts` 为 0、mock 适配器 `submissionCount` 为 0、日志不含口令散列与正文 |
| 完整本机门禁 | `RUN_BROWSER_E2E=1 npm run verify` | **234 unit、10 contract、29 integration、22 E2E、网页构建；0 fail / 0 skip** |
| 进程级冒烟 | `npm run migrate` + `npm run serve:core`（迁移后的独立库 `core_smoke`） | `/healthz` 返回 `{"status":"ok","service":"core"}`；`/readyz` 四项 ok；`/api/v1/overview` 无会话 401；stdout 为单行 JSON，含 `runtime_started`（`dispatch":"disabled"`）与带 `requestId`/`route`/`status` 的 `http_request` |

最近一次完整门禁的日志按惯例私留本地（`.local-*` 目录不入库）。

## 本次发现

- **PostgreSQL Windows 二进制不能放在中文路径下**：`.pg-local/pgsql`（`C:\1\ai代聊\...`）下 `initdb` 在 post-bootstrap 阶段以 `invalid byte sequence for encoding "UTF8": 0xb4` 失败——路径里的「代」按 GBK 字节喂给了 UTF-8 后端。把同一套二进制解到纯 ASCII 临时目录后立刻成功。已写入 `deploy/runbook.md`。
- **`pg_ctl start` 在当前受限执行环境中失败**（`could not create restricted token: error code 87`）。改用 `postgres.exe -D <data> -p <port> -c listen_addresses=127.0.0.1 -c logging_collector=on` 直接后台启动即可。仅影响本机复现，不影响生产部署方式。
- **数据库空库时的失败关闭已验证**：未迁移的库上 `serve:core` 直接退出并输出 `schema_not_ready`，不会带病运行。

## AC 影响

不改变 `acceptance-matrix.csv`：42 行 AC 仍是 `blocked`，微信/QQ real 栏仍为 `blocked`。本次交付的是工程与运维前置，不产生任何平台通过证据。

## 未完成与依赖

- 远程 GitHub Actions 首跑仍未执行：本机没有 `gh` 且工作区无 remote。需要本人决定远程仓库（建议私有）或提供可推送的 remote URL。
- **账号→平台映射未持久化**：`/api/v1/contacts` 的 `platform` 来自进程配置，一个核心进程只应服务一个平台账号。两平台同进程展示、以及「按账号判定平台能力」都缺一张账号表，需要一次公共提案与迁移（`0010` 已被 A20 预留，故新提案应取 `0011`）。
- 页面导入、Skill 与故障查询路由仍是 `501`：05 有持久库，但 Owner REST 路由未审定（A11 只批准 G1 最小路由）。
- 真实模型（D06）、外部通知（D02）、单设备会话撤销、媒体生命周期（D07）均未实现。
