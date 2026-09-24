# 01 QQ 桥接组合根

把 NapCat 一类 OneBot 11 桥接推来的私聊事件接进 02/03/04，并把 02 授权后的分条发回桥接。它**不登录 QQ、不保存平台凭据、不暴露公网**；真实账号登录与桥接本体由运维（本人在服务器上）提供。

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

路由：`POST /onebot/event`（OneBot 事件推送，需要 `Authorization: Bearer <token>`）、`GET /healthz`。

## 这条路径上做了什么、没做什么

入站顺序固定为：传输鉴权 → 01 解码 → 原始字节私密落盘 + inbox 去重 + outbox 事件（同一事务）→ 02 业务消费。名单外的联系人目前仍被原始存储实现完整留存原事件字节，不产生分析、方案或发送；这项隐私最小化缺口须由 00/03 修正。已在册联系人的图片/语音等非文字消息会作为对应类型入库并由 02/04 判为需要人工处理（`PAUSED_MEDIA`），**不会被改写成文字**；混合或空白内容保留为 `unsupported`。

出站只能由 02 的 dispatch 租约发起；桥接只负责把已经授权的分条编码成一次 OneBot 请求并如实回报结果。桥接明确失败或超时都保守记为结果未知，绝不重发；`accepted` 只代表桥接受理，不代表送达。

尚未接线：真实账号登录与桥接安装（D01 spike 范围）、媒体下载与 03 私有存储、本人发言的经审核 peer mapper、`X-Self-ID` 实测、outbox 发布器、已批准表情发送（需要 03 的素材读取端口）。目前 outbox 在提交后尝试 inline 消费；若消费失败，重放事件仍去重，待发布器未补齐前不能宣称可靠交付。NapCat 的许可与风险见 [QQ spike 计划](../../docs/platforms/qq-spike-plan.md)，只接收试验见 [runbook](../../docs/platforms/qq-receive-only-runbook.md)。

## 只接收采证用的两个命令

```powershell
npm run spike:preflight # 一次性 schema + 合成事件，验证真实入口进程（只需 DATABASE_URL）
npm run spike:posture   # 校验只接收姿态：出站与 worker 必须关闭、监听必须留在 loopback、token 已配置
npm run spike:summary   # 去敏聚合：入站分类计数、消息类型计数、会话/暂停/待办/发送状态、未发布 outbox、原始文件审计
npm run spike:shape -- <原始事件文件或目录>   # 只读字段形状（无取值、无文件名），用于判定 message_sent 的对端字段
npm run spike:report  # 从能力快照 + 去敏汇总生成 G2 报告骨架（结论字段不由生成器推断）
```

`spike:summary` 只查询聚合列，不读取正文、媒体或平台标识；输出附适用边界（不证明登录、补齐或送达），可与能力快照一起归档为 G2 证据。完整步骤见 [QQ 只接收验证步骤](../../docs/platforms/qq-receive-only-runbook.md)。