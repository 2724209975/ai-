# 06 手机网页管理端

当前计划、进度、测试基线与实测边界只见 [开发计划 §0](../../docs/development-plan.md#0-当前状态每完成一个任务由总控更新本节)。本页仅说明模块操作与约束，历史证据见任务卡引用的报告。

## 构建与运行

```powershell
npm --prefix apps/web run build      # 产物在 apps/web/build（LF 校验通过 TypeScript）
npm run migrate                      # 需要 DATABASE_URL；首次运行前必须先迁移
$env:DATABASE_URL='postgres://...'
$env:OWNER_ID='owner'
$env:OWNER_PASSWORD_HASH=(node scripts/owner-password.mts < 你的口令文件)
$env:PUBLIC_ORIGIN='http://127.0.0.1:8787'
npm run serve:owner                  # 管理 API + 静态页面，默认 127.0.0.1:8787
```

`serve:owner` 是本地开发组合根（`apps/web/server/main.mts`）：PostgreSQL 持久层 + **mock 平台适配器** + deterministic fake 智能 + 调度 worker。它不会连接真实微信/QQ，也不可能真的发出消息；生产组合与部署由 07 负责。

可配置项：`HOST`、`PORT`、`SESSION_DIR`、`SECURE_COOKIES`、`SESSION_TTL_MS`、`SESSION_IDLE_TTL_MS`、`AGGREGATION_WINDOW_MS`、`MAX_AGGREGATION_MS`、`WORKER_INTERVAL_MS`、`WORKER_ENABLED`、`MOCK_PLATFORM`、`MOCK_PLATFORM_ACCOUNT_ID`、`PG_POOL_MAX`。缺迁移时进程会直接退出并提示先运行 `npm run migrate`。

## 登录与会话

单人账号，没有注册。口令用 `node:crypto` scrypt 校验（`npm run owner:password` 生成哈希，凭据只经环境变量注入，不写仓库/日志）。会话令牌只以 SHA-256 存在 `SESSION_DIR`，浏览器只拿到 `HttpOnly; SameSite=Strict`（HTTPS 下 `Secure`）的 cookie；页面 shell 会注入 CSRF meta，写操作必须同时带正确 Origin 与会话绑定令牌，登录按来源限速。决策见 [A14](../../docs/decisions.md)。

未登录时页面显示登录表单，凭据错误与来源不符都只提示「密码不正确，或未通过来源校验」，不会泄露账号是否存在。退出登录会立即撤销服务端会话。

## 页面与接口

页面以 hash 导航：overview、tasks、contacts、conversations、facts、analyses、media、skills、imports、audit、faults。写命令只在后端 `allowedActions` 包含对应动作时呈现，并提交版本和幂等键；后端独立复核。409 后刷新并明确提示旧内容未发送；确认与恢复分离；发送逐条显示状态，`SUBMITTED` 只代表平台接受。

已接通的查询：`/overview`、`/tasks`、`/contacts`、`/conversations`、`/facts`、`/analyses`、`/media`、`/audit`。

待办默认显示需要处理的方案与尚未完成的发送；已拒绝、已失效和已完成的记录可切换到「历史记录」查看。任何带 `RESULT_UNKNOWN` 发送的记录仍留在待处理列表。每次最多加载 100 条，后端先选待处理记录，再按更新时间补入历史；页面数字只统计本次加载的记录。

联系人页可直接「关闭代理 / 开启代理」。关闭会使旧候选失效、取消尚未提交的发送并清空待生成批次；后续来信继续保存，但不调用模型。重新开启只处理之后的新来信，不补发旧消息，也不清除已有暂停原因；全局或联系人恢复操作不会自行开启已关闭的代理。

确认模式下，尚未确认的待办可点击「重新生成候选」。旧方案立即失效，原来信批次进入持久生成队列；新方案仍需本人确认。重复请求不重复排队，已过期、已确认、暂停或存在未知发送的任务不能借此重新生成。生成由核心进程的候选模型配置决定，操作本身不会提交发送。

已接通的命令：`/tasks/{id}/confirm|reject`、`/control/pause-all|resume-all`、`/contacts/{id}/pauseContact|resumeContact|updatePolicy`、`/facts/{id}/confirmFact|correctFact|deleteFact`、`/analyses/{id}/correctAnalysis`、`/media/{id}/approveAsset|revokeAsset`。

`/skills`、`/imports`、`/faults` 还没有持久 provider，返回 `501 NOT_IMPLEMENTED`，页面会显示明确错误而不是空列表。这些路由与字段仍以 [06 REST 提案](../../docs/reports/web-06-api-proposal-2026-09-23.md) 和 [contracts.md](../../docs/contracts.md) §3 为准；未列入契约的字段不得作为稳定接口使用。

G2/G3 的连接与恢复字段仍是 [只读提案](../../docs/reports/web-06-g2-g3-proposal-2026-09-24.md)。当前 overview 的空连接和空故障数组没有查询覆盖证据，页面明确显示“尚未接入、无法判断”。来源未明的自身账号消息在会话中保持 unknown 并提示人工核对；自动模式的 `AUTO_REVIEW_UNAVAILABLE` 仍是确认待办。320–390px 的 409/503/501 页面回归位于 `server/g2-mobile-browser.test.mts`，已由 `tests/e2e/web-server.test.mts` 接入 `npm run test:e2e`（`RUN_BROWSER_E2E=1` 时执行）；它只使用合成 HTTP 响应，不能算真实平台证据。
