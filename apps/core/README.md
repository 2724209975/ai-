# 生产核心组合根

当前计划、进度、测试基线与实测边界只见 [开发计划 §0](../../docs/development-plan.md#0-当前状态每完成一个任务由总控更新本节)。本页仅说明模块操作与约束，历史证据见任务卡引用的报告。

`npm run serve:core` 启动 `apps/core/main.mts`。它是常驻核心进程：本人管理 API、聚合/收集 worker、05 Skill 内部 outbox pump。**它不派发**——平台发送只属于每个平台账号自己的桥接进程（`apps/bridge`），只有桥接持有 02 的发送租约。

v2 P2/P3增加独立记忆维护循环（默认10秒），仅处理逐会话启用v2的消息。需要迁移0016；默认本地保守提取并等待本人确认，Embedding默认关闭。配置、来源/删除约定见 [记忆契约](../../docs/memory-engine-v2.md)，API见 [接口文档](../../docs/api-v2.md)。此循环不提供发送权限。

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

可选：`HOST`（默认 `127.0.0.1`）、`PORT`（默认 8787）、`SESSION_DIR`、`WEB_BUILD_DIR`、`START_PAUSED`、`COLLECTION_ENABLED`、`AGGREGATION_WINDOW_MS`、`MAX_AGGREGATION_MS`、`WORKER_INTERVAL_MS`、`SKILL_OUTBOX_INTERVAL_MS`、`PG_POOL_MAX`、`LOG_LEVEL`、`INTELLIGENCE_PROVIDER`、`SECURE_COOKIES`、`ALLOW_NON_LOOPBACK_BIND`、`ALLOW_LAN_HTTP`（默认关闭）。手机启动模板和防火墙步骤见 [运行手册](../../deploy/runbook.md#同一-wi-fi-下用手机操作)。

## 启动即失败关闭

| 规则 | 行为 |
| --- | --- |
| 监听地址 | 默认只绑 loopback；绑非回环地址必须显式 `ALLOW_NON_LOOPBACK_BIND=1` |
| 对外 origin | 非回环默认要求 `https://`；显式 `ALLOW_LAN_HTTP=1` 允许 RFC1918 私有 IPv4 的 HTTP 地址，其他 HTTP 地址仍拒绝启动（`INSECURE_ORIGIN`） |
| 全局暂停 | 独立入口默认 `START_PAUSED=1`，本机栈默认 `0`；已有暂停保留，新空库可直接运行，不重复抬高 epoch |
| 派发 | 结构上不存在：worker 以 `dispatchEnabled: false` 构造，平台对象只有账号 `core-no-dispatch`，`submitSend` 只抛错 |
| 智能提供方 | 接受 `persistent-fake` 或 `deepseek`；真实模型需要 `DEEPSEEK_API_KEY`，其他名称拒绝启动 |

启动顺序固定为：清理过期会话 → 遵守 START_PAUSED 与已有暂停 → `recover()`（先核对含糊发送，再补做到期批次）→ Skill outbox 重放 → 收集循环。

## 端点

- `GET /healthz`：进程存活，`200`，无鉴权。
- `GET /readyz`：`database` / `schema` / `control` / `recovery` 四项，全部 ok 才 `200`，否则 `503`。只返回固定检查名与 ok/failed，不回显驱动错误。
- `/api/v1/*`：与本地组合根同一套 Owner API，仍要求本人会话与 CSRF。

日志是单行 JSON（`ts`/`level`/`service`/`event` + 扁平标量字段），每个请求带 `X-Request-Id`；路由标签把 uuid、平台消息 ID 这类标识段替换为 `:id`，凭据名与正文名的字段一律写 `[redacted]`，不落正文、口令与平台标识。

## 已知边界

P4-4c 已装配受控图片理解，默认关闭。显式 `MEDIA_VISION_ENABLED=1` 后还需独立媒体密钥及绝对路径 `MEDIA_PRIVATE_DIR`（对应桥接的 `WECHAT_MEDIA_DIR`，位于网页静态目录之外）。core 只读取 01/03 已绑定的私有图片，不获取平台文件。02 先通过 03 保存完整解释并建立新快照，再生成确认模式候选；迟到结果会因暂停或版本变化失效。已有有效解释和本人纠正会复用，本人删除的解释不会自动重做。`MEDIA_VOICE_ENABLED=1` 在运行入口拒绝，语音装配留后续卡。独立媒体限额与真实验收边界见 [runbook](../../deploy/runbook.md)。

暂停期间的来信会保留未核对提醒。恢复后，在会话页点击「为最新来信生成候选」，即可将最新未处理文字加入持久生成队列；收集 worker 使用本核心进程配置的模型生成待确认方案。真实模型运行时应同时配置核心 `INTELLIGENCE_PROVIDER=deepseek` 与微信桥接 `WECHAT_INTELLIGENCE=deepseek`，避免正常来信与手动补处理使用不同模型。

该入口仅适用于已恢复、代理开启、确认模式、没有未知发送且最新文字从未生成方案的会话；重复请求按命令去重，旧页面版本被拒绝。生成候选不等于发送，仍需在当前聊天确认。点击「已核对，清除来信提醒」表示不再补处理这批来信；计数从迁移 `0010` 后开始，旧消息不补计。

- 账号与平台映射已由迁移 `0013` 持久化，联系人标签、健康摘要与派发按账号隔离；历史缺失或冲突映射显示未知。双平台本机模板见 [运行手册](../../deploy/runbook.md)。

### v2 P4/P5

2026-10-11生产Core已在独立本机预发布通过数据库升级、启停、重启、认证及冷恢复。使用 `npm run prerelease -- status`、`start`、`stop`，详见[指南](../../docs/prerelease-v2.md)。固定本地fixture、暂停，关闭采集/Bridge/发送；日常副本未替换，历史迁移编号差异由独立迁移谱系处理。

运行源码需要迁移0017；回复决策/生成/质量分阶段处理，Owner在聊天设置中配置注册模型、预算和云端权限。注册格式见`deploy/models-v2.example.json`，配置见[决策与生成](../../docs/decision-generation-v2.md)。Core继续没有真实发送能力。响应式手机网页使用同一Core和审批账本；真实送达反馈复用原存储。当前修改未部署到日常副本。
