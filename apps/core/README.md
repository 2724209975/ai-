# 生产核心组合根

`npm run serve:core` 启动 `apps/core/main.mts`。它是常驻核心进程：本人管理 API、聚合/收集 worker、05 Skill 内部 outbox pump。**它不派发**——平台发送只属于每个平台账号自己的桥接进程（`apps/bridge`），只有桥接持有 02 的发送租约。

```powershell
$env:DATABASE_URL='postgres://...'
$env:OWNER_ID='<内部本人 id>'
$env:OWNER_PASSWORD_HASH='<npm run owner:password 生成>'
$env:PUBLIC_ORIGIN='https://<你的域名>'
$env:CORE_PLATFORM='qq'          # 或 wechat
npm run migrate                  # 先迁移，缺 schema 时进程会直接退出并提示
npm run serve:core
```

必填：`DATABASE_URL`、`OWNER_ID`、`OWNER_PASSWORD_HASH`（必须是 `scrypt$N=..` 存储格式）、`PUBLIC_ORIGIN`、`CORE_PLATFORM`。

可选：`HOST`（默认 `127.0.0.1`）、`PORT`（默认 8787）、`SESSION_DIR`、`WEB_BUILD_DIR`、`START_PAUSED`、`COLLECTION_ENABLED`、`AGGREGATION_WINDOW_MS`、`MAX_AGGREGATION_MS`、`WORKER_INTERVAL_MS`、`SKILL_OUTBOX_INTERVAL_MS`、`PG_POOL_MAX`、`LOG_LEVEL`、`INTELLIGENCE_PROVIDER`、`SECURE_COOKIES`、`ALLOW_NON_LOOPBACK_BIND`。

## 启动即失败关闭

| 规则 | 行为 |
| --- | --- |
| 监听地址 | 默认只绑 loopback；绑非回环地址必须显式 `ALLOW_NON_LOOPBACK_BIND=1` |
| 对外 origin | 非回环 origin 必须是 `https://`，否则拒绝启动（`INSECURE_ORIGIN`） |
| 全局暂停 | 默认启动即暂停（`START_PAUSED=1`）。数据库里若已是暂停态则只记录、不重复抬高 epoch |
| 派发 | 结构上不存在：worker 以 `dispatchEnabled: false` 构造，平台对象只有账号 `core-no-dispatch`，`submitSend` 只抛错 |
| 智能提供方 | 必须显式命名，当前仅接受 `persistent-fake`；写别的值直接拒绝启动 |

启动顺序固定为：清理过期会话 → 启动即暂停 → `recover()`（先核对含糊发送，再补做到期批次）→ Skill outbox 重放 → 收集循环。

## 端点

- `GET /healthz`：进程存活，`200`，无鉴权。
- `GET /readyz`：`database` / `schema` / `control` / `recovery` 四项，全部 ok 才 `200`，否则 `503`。只返回固定检查名与 ok/failed，不回显驱动错误。
- `/api/v1/*`：与本地组合根同一套 Owner API，仍要求本人会话与 CSRF。

日志是单行 JSON（`ts`/`level`/`service`/`event` + 扁平标量字段），每个请求带 `X-Request-Id`；路由标签把 uuid、平台消息 ID 这类标识段替换为 `:id`，凭据名与正文名的字段一律写 `[redacted]`，不落正文、口令与平台标识。

## 已知边界

- **账号→平台映射尚未持久化**：`/api/v1/contacts` 的 `platform` 字段目前来自本进程的 `CORE_PLATFORM`，所以一个核心进程只应服务一个平台账号；两平台同时运行时该字段会显示成同一个值。这需要一次公共提案与迁移，尚未实现。
- 智能仍是 04 的持久 fake，真实模型要等 D06。
- 外部通知（D02）、单设备会话撤销、媒体生命周期（D07）都未实现。
