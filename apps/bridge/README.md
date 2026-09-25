# 01 QQ 桥接组合根

把 NapCat 一类 OneBot 11 桥接推来的私聊事件接进 02/03/04，并把 02 授权后的分条发回桥接。它**不登录 QQ、不保存平台凭据、不暴露公网**；客户端登录与桥接本体由本人在本机测试环境操作，独立在线宿主留待后续验证。

```powershell
$env:DATABASE_URL='postgres://...'
$env:QQ_ACCOUNT_ID='<内部平台账号 uuid，与 contacts 的 platform_account_id 一致>'
$env:QQ_SELF_ID='<QQ 号>'
$env:QQ_BRIDGE_TOKEN='<与 NapCat 配置一致的 token>'
$env:QQ_ENABLE_OUTBOUND='0' # 只接收；默认值也是 0
$env:WORKER_ENABLED='0'
node apps/bridge/main.mts
```

可配置项：`HOST`、`PORT`（默认 8788）、`RAW_EVENT_DIR`、`MAX_BODY_BYTES`、`QQ_REQUIRE_SELF_ID_HEADER`、`AGGREGATION_WINDOW_MS`、`MAX_AGGREGATION_MS`、`WORKER_INTERVAL_MS`、`QQ_ENABLE_OUTBOUND`、`WORKER_ENABLED`、`PG_POOL_MAX`。默认**只接收**；只有明确设置 `QQ_ENABLE_OUTBOUND=1` 才要求 `QQ_ONEBOT_BASE_URL` 并创建真实发送传输，worker 也只会在该模式启动。单独设置 `WORKER_ENABLED=1` 而未启用出站会拒绝启动。真实出站需另有经本人批准的测试会话、消息内容与次数，且只能由 02 租约执行。

路由：`POST /onebot/event`（OneBot 事件推送）、`GET /healthz`。鉴权支持两种：**签名路径**（OneBot 惯例，也是 NapCat 实际所用）用配置里的 token 作为 HMAC-SHA1 密钥校验 `x-signature: sha1=...` 并核对 `x-self-id`；**传输层路径**用于其他桥接，要求 `Authorization: Bearer <token>`。

## 这条路径上做了什么、没做什么

入站顺序固定为：鉴权 → 01 解码 → 已登记事件的原始字节私密落盘 + inbox 去重 + outbox 事件（同一事务）→ 02 业务消费。名单外只写发现元数据与摘要，不留聊天原文、不产生分析、方案或发送。已鉴权但无法确认对端的自身消息按内部 `unmapped_self` 私密留证，并在同一事务内由 02 暂停该账号的已登记会话；它不会冒充公共 `PlatformOwnerMessageObserved` 或联系人入站。图片/语音等非文字消息由 02/04 判为需要人工处理（`PAUSED_MEDIA`），**不会被改写成文字**；混合或空白内容保留为 `unsupported`。

出站只能由 02 的 dispatch 租约发起；桥接只负责把已经授权的分条编码成一次 OneBot 请求并如实回报结果。桥接明确失败或超时都保守记为结果未知，绝不重发；`accepted` 只代表桥接受理，不代表送达。

本机真实账号已完成只接收 spike 与两次逐条授权的真实文字发送，结论和未测项见[脱敏报告](../../docs/reports/platform-qq-2026-09-24.md)。已接线的 outbox pump 在启动及常驻运行时重投待处理的 01 事件，只有 02 消费提交后才标记 `published_at`；重复推送由 inbox 去重。仍缺媒体原件下载与 03 私有存储、本人发言的经审核 peer mapper、已批准表情发送、平台历史连续覆盖与独立宿主关机验证。NapCat 的许可与风险见 [QQ spike 计划](../../docs/platforms/qq-spike-plan.md)，复现步骤见 [runbook](../../docs/platforms/qq-receive-only-runbook.md)。

## 只接收采证用的两个命令

```powershell
npm run spike:preflight # 一次性 schema + 合成事件，验证真实入口进程（只需 DATABASE_URL）
npm run spike:posture   # 校验只接收姿态：出站与 worker 必须关闭、监听必须留在 loopback、token 已配置
npm run spike:summary   # 去敏聚合：入站分类计数、消息类型计数、会话/暂停/待办/发送状态、未发布 outbox、原始文件审计
npm run spike:shape -- <原始事件文件或目录>   # 只读字段形状（无取值、无文件名），用于判定 message_sent 的对端字段
npm run spike:report  # 从能力快照 + 去敏汇总生成 G2 报告骨架（结论字段不由生成器推断）
```

`spike:summary` 只查询聚合列，不读取正文、媒体或平台标识；输出附适用边界（不证明登录、补齐或送达），可与能力快照一起归档为 G2 证据。完整步骤见 [QQ 只接收验证步骤](../../docs/platforms/qq-receive-only-runbook.md)。

## 微信 wxhelper 只接收组合根

单次发送验证的准备与当前审批边界见[专项记录](../../docs/reports/wechat-send-prep-2026-09-25.md)。`scripts/wechat-send-once.mts` 是默认关闭的独立人工入口；本节的 `serve:wechat-receive` 仍只接收，不启动任何微信派发 worker。

`npm run serve:wechat-receive` 启动 `apps/bridge/wechat-main.mts`，只接收 wxhelper 的 HTTP 消息推送，**没有微信发送端口或 dispatch worker**。必需环境变量：`DATABASE_URL`、`WECHAT_ACCOUNT_ID`（内部 UUID）、`WECHAT_SELF_REF`（测试号 wxid）、`WECHAT_INGRESS_TOKEN`（私密随机值）；`HOST` 必须为 `127.0.0.1`，`PORT` 默认 `19099`，`RAW_EVENT_DIR` 指向私有目录。先运行迁移，并用 `WECHAT_SPIKE_PEER` 和 `node scripts/wechat-spike-enroll.mts` 只登记知情测试好友。令牌与平台标识不得写进仓库、日志或报告。

wxhelper 的私有 `config.ini` 中，`RecvHttpUrl` 应指向 `http://127.0.0.1:19099/wxhelper/event?token=<私密值>`；只在同机回环访问，不经公网反向代理。wxhelper 本身不签名，所以不能把该入口开放给不受信任的本机进程或网络。启动顺序：桥接健康检查 → 核对客户端与移植 DLL 哈希 → 测试号登录 → `checkLogin` → `hookSyncMsg` → 一条获知情好友配合的入站验证；结束时 `unhookSyncMsg` 并停止桥接。移植 DLL 的发送函数虽然已离线验证，但本节的只接收服务不会调用它；未验证的其他偏移不可调用。

登记好友的原始字节、inbox/outbox 与 02 消费落在 PostgreSQL；名单外只留最小发现元数据，本人方向事件触发账号暂停。18–19 位 `msgId` 无损保存。图片/语音只表示观察到对应类型，未取得原件时要求人工处理。详见[本轮接入报告](../../docs/reports/wechat-receive-bridge-2026-09-24.md)。
