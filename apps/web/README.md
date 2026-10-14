# 06 手机网页管理端

当前定位（2026-10-12）：桌面主流程的手机辅助入口。手机浏览器连接电脑后端，查看、编辑、复制同一份候选，处理暂停/恢复；需要电脑在线和网络可达。QQ 候选试用仍由本人在 QQ 发送，自动发送关闭。该网页入口与独立 Android App 的模型和本地档案不同，不能认为原生 App 已共享电脑模型或费用账本。

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

## 聊天工作台与接口

默认 `#chat`；`#chat/<会话ID>` 直接进入会话。电脑分栏，手机列表/详情两级；聊天、运行状态、更多是主导航。`#tasks` / `#contacts` / `#conversations` 兼容重定向到聊天；资料、分析、素材、审计从更多进入。未接入路由保留 501 提示，不作为日常入口。

- `GET /api/v1/workspace/conversations`：`search`、`platform=all|qq|wechat|unknown`、`filter=all|pending|attention`、`cursor`、`limit`（1–100，默认 50）。返回 `items/total/nextCursor`，每项含平台、版本、可用动作、最近消息、待确认数与暂停原因；需处理优先，组内最近活动优先。
- `GET /api/v1/conversations/{id}/workspace`：`contact/conversation/tasks/nextCursor`；消息最近 50 条，历史用 `before=nextCursor` 游标加载。联系人范围查询避免全局待办 100 条影响当前聊天。
- 写命令沿用版本与幂等键接口：任务 `confirm|reject|regenerate|present`，联系人 `pauseContact|resumeRoutine|resumeContact|updatePolicy|requestPausedReply|acknowledgePausedInbound`，发送 `resolve`，全局 `pause-all|resume-all`。

回复候选分条编辑、选方案、重新生成、不回复均在聊天底部。确认后发送记录按时间展示；只有证明匹配平台消息 ID 的代理回显才与发送记录合并，文本相同不能证明回显。未知结果保持人工核对；「已收到，恢复聊天」明确记录送达并请求恢复，其余核对方式折叠。恢复结果显示仍需处理的原因，关闭的代理不会被恢复按钮开启。

实现拆为 `Workspace`、`CandidateEditor`、`MessageTimeline`、`usePolling` 与共享设置控件。详情每 3 秒刷新，列表/运行状态每 5 秒；隐藏页面停止轮询，再进入立即更新。切换取消旧查询，加载历史保留阅读位置，新消息提示不强制跳底。草稿按会话/方案/版本保存在登录会话内存中；切换和普通刷新保留，过期草稿只供复制，退出或登录失效清空，浏览器整页加载不承诺保留。

网络错误保留最后读取的内容与更新时间，并阻断操作。提交结果不明保留完整命令及幂等键，先查询后端结果，禁止自动重发；用户可重试同一请求。409 刷新最新权限，明确提示旧版本未发送。Ctrl/Cmd+Enter 确认，Enter 换行，输入法合成期间不触发发送。

旧查询仍兼容。`skills/imports/faults` 暂无持久 provider，返回 501。运行状态显示持久账号映射、探测时间及下一步，缺失/过期探测显示未知，不代表历史同步完整。独立开发 mock 与真实桥接的差别仍见上面的运行说明。

浏览器验收在 `tests/e2e/workspace-browser.test.mts`、`tests/e2e/lan-mobile-browser.test.mts` 与 `server/pg-owner-browser.integration.mts`。配置 `RUN_BROWSER_E2E=1` 与隔离 `TEST_DATABASE_URL` 后由完整 `npm run verify` 执行；合成界面截图在 `output/playwright/`。真实登录和发送由本人另行完成。
# 手机联动体验（第三批）

「更多 → 手机联动」提供配对码倒计时、复制和重新生成、关联对象搜索、资料读取时间及可读的版本选择。每个对象的资料编辑可折叠，刷新和对象搜索保留未保存修改；保存携带开始编辑时的版本，手机新版本产生后比较冲突。

电脑资料显示当前话题相关的较早原文、来源数量与近期聊天。页面的「最近读取电脑资料」是电脑页面读取时间；手机是否下载成功，以手机显示的成功同步时间为准。现用桌面启动目录已单独更新相关联动文件，详见[第三批报告](../../docs/reports/android-link-ux-2026-10-09.md)。

### v2 P5工作台

电脑/手机响应式网页共用同一Owner会话和reply-job：编辑审批携带会话修订和最终内容哈希，显示决策、路由、质量和真实发送状态；失败生成可创建新任务，不对不确定发送自动重试。聊天设置包含模型配置/隐私/预算、记忆类型/搜索/状态、风格锁定及实际上下文预览。详见[API](../../docs/api-v2.md)与[P4/P5契约](../../docs/decision-generation-v2.md)。
