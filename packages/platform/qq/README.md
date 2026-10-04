# QQ OneBot 协议基础（离线可测，未连接真实 QQ）

当前状态只见 [开发计划 §0](../../../docs/development-plan.md#0-当前状态每完成一个任务由总控更新本节)；本页保留模块说明与操作约束，不维护测试数字或进度。

本目录依据公开 OneBot 11 规范独立实现，没有复制 NapCat/NoneBot 代码，没有第三方依赖。仍不是已完成的个人 QQ 连接器：协议层、发送传输与新增的归一化/桥接端口都已离线可测，真实平台证据与限制只见开发计划 §0；登录由本人执行。可运行的入口组合根在 [apps/bridge](../../../apps/bridge/README.md)；它需要运维提供已登录的 OneBot 端点，并记录在 [A16](../../../docs/decisions.md)。

运行全部平台测试：

```powershell
node --test packages/platform/mock/adapter.test.mts packages/platform/qq/onebot-codec.test.mts packages/platform/qq/webhook-ingress.test.mts packages/platform/qq/send-executor.test.mts packages/platform/qq/onebot-http-transport.test.mts packages/platform/qq/media-acquisition.test.mts packages/platform/qq/self-origin.test.mts packages/platform/qq/recovery-assessment.test.mts
```

## 当前实现

- `decodePrivateEvent`：好友私聊、引用、文字/图片/语音/原生表情/不支持内容分段保留，撤回独立处理。拒绝群聊/临时会话/不安全数字 ID；要求桥接上报数组格式，暂不解析 CQ 字符串。
- 媒体事件只提供私密原始事件中的段索引，完整性与动画状态均 unknown；不把 image 段认作完整静态/动态表情。未知段保留缺口，不丢弃后继续当纯文本成功。
- `media-acquisition.mts` 通过账号/好友/原事件/段索引指针调用受控媒体来源和 03 私有存储，读取前必须经过 02/03 授权租约。不接受任意 CDN URL 或 `file://` 路径；字节长度、摘要和文件头 MIME 单独记录。`original` 只是桥接声明，未经过真实样本验证前完整性仍为 unknown；缩略图、单帧和转码为 partial，缺失与存储故障为 unavailable。动画状态仍 unknown。
- 自身消息保持 unknown。`message_sent` 的联系人映射取决于具体桥接，必须由经审核的 mapper 提供；不按昵称、相似文本、时间接近来推断。下一步由账本关联 agent；可靠 owner 信号仍未验证。
- `self-origin.mts` 已提供独立的来源分类端口：先查持久发送账本的精确平台消息 ID；匹配本账号/联系人则为 agent 回显，范围冲突则 unknown。无账本匹配时，只有经目标桥接实测的独立来源 verifier 才可归为 owner；目前没有该 verifier 的真实实现，普通自身事件保持 unknown。公共 unknown 事件语义见 [01→00 提案](../../../docs/platforms/contract-proposals.md)。
- `recovery-assessment.mts` 仅离线评估恢复证据：账号不符、需重登、历史窗口不能证明覆盖持久 cursor 时不开放新 preflight；断线前未提交任务一律建议失效，提交未知按会话阻塞，已受理证据只作为回执。没有网络查询、游标持久化或自动补发；历史覆盖能力仍需真实桥接验证。公共恢复报告字段也见 [01→00 提案](../../../docs/platforms/contract-proposals.md)。
- `verifyWebhook`：按原始字节校验能提供 OneBot HMAC-SHA1 的回调。NapCat 的 HTTP 推送使用 token 作为 HMAC-SHA1 签名密钥，签名路径与私网限制见 [A16](../../../docs/decisions.md)；其他桥接可按明确配置使用 Bearer 传输鉴权，二者不得混淆。
- `ingestOneBotWebhook`：验签、账号匹配、解析后调用 `AtomicReceptionPort.commitReceived`。只在原子提交返回 inserted/duplicate 后给空 204；失败不假装成功；不使用快速回复旁路。协议签名不含新鲜度保证，持久去重和消费者 inbox 必须保留；不能简单丢弃旧时间戳导致补齐失败。
- `encodePrivateSend`：纯格式转换，不发送。文字始终是 text 段，CQ 外观不会变为命令；表情由可信资产端口读取，核对批准状态、平台、版本及实际字节摘要。仅明确配置支持的 MIME/动画格式可编码，不支持普通图片/语音发送。大小限制是调用方的本地预算，不宣称平台实际限额。
- `decodeSendResponse`：WebSocket 要求匹配 echo；HTTP 通过单次请求/响应配对关联。只将明确成功且有平台 ID 的回包标为 SUBMITTED/accepted，不是送达或已读。async、缺 ID、未知失败码、关联错乱一律 RESULT_UNKNOWN，禁止据此重发。

## 依赖边界与后续集成

2026-09-23 新增 `send-executor.mts`：可注入账本、02 dispatch gate 和单次传输的执行器。必须先经 02 租约/版本复核并原子 claim 提交意图，再调用一次 submitOnce；执行器不包含账号登录。候选 HTTP 传输在独立文件中。超时与传输异常结果未知，不重试；账本控制未知会话的新键，执行器本身不另建数据库。实际传输客户端必须禁止库内自动重试。

调用者只能提交 text 或带 assetBinding（素材 ID/批准版本/摘要）的内联表情，执行器复核字节摘要；最新批准/目标平台仍由 02 gate 复核。裸普通图片、语音、任意 action 不允许。该内部 SendAttempt 不是可接受外部 HTTP 请求的公共 schema。

finish 失败时返回 `recorded=false`，保留已观察到的 accepted/platformMessageId；03 的提交意图保持未决，02 必须暂停并修复记录，不能当成平台未发送再试。超时后返回的迟到回包当前不自动升级账本，仍需单独 reconcile；平台结果无法查询时保持未知，不静默推断失败。生产 finish 必须单调迁移，处理矛盾回执。

2026-09-24 协议与归一化离线测试通过；真实入口组合根与假 OneBot/真实 PostgreSQL 联调见 [apps/bridge](../../../apps/bridge/README.md)。本地模拟不证明真实 QQ 登录、收发、媒体或跨进程恢复；桥接默认只接收。归一化的混合/空白内容保留为 `unsupported` 并请求人工处理。

`onebot-http-transport.mts` 仅为候选桥接的出站 HTTP 实现：固定 `POST /send_private_msg`、Bearer token、无重定向/内部重试、限制回包大小。OneBot HTTP 响应本身不保证带 `echo`，此路径由一次 HTTP 请求对应的响应关联；WS 路径仍要求平台回显 `echo`。两种方式都只把有 `message_id` 的成功回包记为桥接受理。传输异常、非 200、超时和回包不合法都保守记为结果未知。此组件需由 02 授权执行器独占，配置在私有网络内；不能直接对外提供发送 API，实测结果见计划引用的 QQ 报告。

这里的 WireMessage/WireObservation 是平台内部中间结构，不替代公共 Message/Event。公共契约 v0.3.0 已提供首批机器 schema；混合消息当前按 `unsupported` 保守归一化，未知来源更正和真实连接事件仍待端到端验证。

`packages/infrastructure/postgres/reception.mts` 已实现 PostgreSQL inbox/outbox 同事务与私有原始文件存储，假 OneBot 联调已覆盖基础去重和 02 门控。桥接 outbox pump 重投待消费事件，消费者通过 inbox 去重；名单外只保留最小发现元数据。原事件可能带媒体密钥，禁止进入普通日志/报告。

dedupeKey 当前按平台/账号/联系人/消息 ID/事件种类生成；桥接 message_id 生命周期、跨登录复用范围未实测，正式启用前必须固定 profile，必要时添加已验证的命名空间。不拿 transport echo 当平台幂等键。

公共 schema、02 dispatch 租约/epoch、持久发送账本和桥接组合根已落地；真实桥接媒体完整性、自身来源与恢复覆盖仍须逐项验证，账号实测与 outbox 接线证据见计划。OneBot `get_image`/`get_record` 标准响应是桥接本机路径，跨容器/机器不可直接假定可读；后续需固定安全传输与原件/转码语义。不得将编码结果直接送到平台绕开 02。本次没有创建通用任意 action 调用器。

## 持久账本回显（P4-6b）

QQ 桥接只对带实际 `target_id` 的 `message_sent` 查询持久发送账本：平台消息 ID、内部账号、目标好友都须精确匹配，attempt 状态只接受 `SUBMITTED` / `DELIVERED`。正文、时间、`message_sent_type`、mapper 和事件自称的 actor 都不是回显证明。不接 owner verifier，`owner_message_signal` 仍是 unknown。

确认的系统回显只保存私有原始证据和 scope=`agent-echo` 的 inbox 行，不创建公共事件或消息，不暂停，也不改变送达状态。其余自身事件由 02 暂停整个账号，保留 `OWNER_ORIGIN_UNMAPPED`。早于 HTTP 结果提交的回显不等待新证明、不重试；之后相同字节重投也保留首次隔离结果。相同事件键更换字节返回 409。

自发事件的去重锁按账号和事件键串行，判定前跨回显/隔离两个 scope 检查已有记录。账本读取与证据提交同事务，对匹配行采用非等待读锁；结果写入中或被锁的记录保守视为证据不足。失败匹配的读锁在调用 02 暂停前释放，避免与派发租约产生锁顺序冲突。暂停仍经过 02 的既有提交边界，可能等待正在结束的派发；这不会重新判定回显，也不会重发。

`createPgReceptionPort` 的分类钩子为可选，不传时保留原来的消息消费与 outbox 行为。无迁移、索引或公共契约新增。假 HTTP / 真实隔离 PostgreSQL 的通过结果见 [交付报告](../../../docs/reports/P4-6b-2026-10-04.md)；真实 NapCat 的事件顺序、账号和回显字段仍由本人验收。

## 查证来源（2026-09-22）

- [OneBot 私聊事件](https://github.com/botuniverse/onebot-11/blob/master/event/message.md)：身份、时间、消息字段。
- [OneBot 消息段](https://github.com/botuniverse/onebot-11/blob/master/message/segment.md)：text/image/record/reply 与 base64 输入。
- [OneBot HTTP POST](https://github.com/botuniverse/onebot-11/blob/master/communication/http-post.md)：原始正文签名、空响应不触发快速操作。
- [OneBot 响应语义](https://github.com/botuniverse/onebot-11/blob/master/communication/http.md)：ok/async/failed。
- [OneBot HTTP 鉴权](https://github.com/botuniverse/onebot-11/blob/master/communication/authorization.md)：Bearer access token。
- [OneBot 公开媒体 API](https://github.com/botuniverse/onebot-11/blob/master/api/public.md)：`get_image` 返回路径，`get_record` 返回转码文件路径；不等于跨进程原件可取。
- [NapCat 自身事件声明](https://napneko.github.io/develop/event)：属于实现扩展，真实来源尚未验证。
