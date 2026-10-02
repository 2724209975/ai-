# 能力矩阵与证据等级

> 本页保留原查证日期的历史调研、提案或阶段快照，不表示当前能力与进度；最新状态只见 [开发计划 §0](../development-plan.md#0-当前状态每完成一个任务由总控更新本节)，执行范围和顺序以当前任务卡为准。真实操作由本人执行，旧授权不用于新增发送；部署位置到 P5 再决定。

日期 2026-09-22。`documented` = 仓库/维护者/官方文档说明；`tested` = 本项目目标账号有实测证据；`unsupported` = 不适用或明确不支持；`unknown` = 无足够证据。下表中的第三方声明不能升级为 tested。mock 不计入平台 tested。

| 能力 | 微信个人账号（Wechaty/Windows 候选） | QQ 个人账号（NTQQ/NapCat 候选） | 当前本项目真实结论 |
| --- | --- | --- | --- |
| 已有好友一对一 | Wechaty/WeChatFerry 声明有联系人/会话，依赖具体实现 | NapCat 声明好友私聊 | 两者 unknown，未登录 |
| 账号/联系人稳定标识 | 提供方 ID/wxid 映射需验证重登稳定性 | QQ user_id/self_id 与可能的 UID 映射需验证 | 内部 UUID 与外部命名空间分离；不按昵称识别；更名跨重登未测 |
| 原消息 ID/时间 | SDK 有消息与时间；底层完整性待测 | OneBot 有 message_id/time；唯一作用域/重启稳定性待测 | unknown；缺可靠 ID 则不能用内容哈希冒充无损去重 |
| 文本接收 | documented [W1/W2] | documented [Q3/Q5] | unknown |
| 原图接收 | 媒体 API 声明，原图 vs 缩略图待测 | image/get_image 声明 | unknown |
| 原语音接收 | 媒体/语音声明，编码/时长待测 | record/get_record 声明 | unknown；转码文件不替代原音留存 |
| 静态表情 | Emoticon/GIF/媒体声明不足以覆盖全部素材 | face/image/mface 声明 | unknown；平台内置符号与素材不同 |
| 完整动态表情 | 未证实逐类型原动画完整可取 | mface 可上报 image 子类型，不证明一定取到完整动画 | unknown；只有缩略图必须 partial，不是 complete |
| 引用 | 具体 Puppet 支持需查 | reply 段 documented | unknown；引用找不到保留缺失状态 |
| 撤回/编辑 | Wechaty 有 recalled；提供方覆盖待测，编辑未知 | friend_recall documented；编辑未证实 | unknown；撤回不能当普通新文本 |
| 文字发送 | documented | send_private_msg documented | unknown |
| 批准表情发送 | GIF 发送声明不等于所有表情支持 | image/mface/face 声明，不等于素材许可/动画保真 | unknown；批准记录/摘要/平台格式绑定后验证 |
| 请求已受理 | 提供方响应语义待核 | API 成功响应需与实际可见性核对 | unknown；不等于送达 |
| 已发送/平台 ID | Wechaty 返回能力依赖 Puppet | OneBot 返回 message_id | unknown；本地 ID 不能填平台 ID |
| 送达/已读 | 未发现可确认的通用个人路径证据 | get_msg 不代表对方已收/已读 | unknown；绝不推断 |
| 超时查结果 | 提供方是否支持 client key 查询未证实 | get_msg 需已知 ID；丢回包时缺 ID 仍可能无法核对 | unknown；保持 RESULT_UNKNOWN |
| 平台幂等 | 未证实 | echo 仅 RPC 关联，不是幂等保证 | unknown；不承诺 exactly-once |
| 手机本人发言 | self 只代表发送账号 | reportSelfMessage/message_sent 只声明自身消息 | unknown；不得直接产生 owner |
| 电脑本人发言 | 同上，依赖多端同步 | 同上，需与发送账本关联 | unknown |
| 系统回显识别 | 需稳定平台 ID 或已验证强关联 | 需稳定平台 ID 或已验证强关联 | unknown；文本+时间相近不够 |
| 断线补齐/游标 | 具体提供方持久同步能力未证实 | 历史 API 即使存在也需测窗口/顺序/漏失 | unknown；重连不是补齐 |
| 取消已提交消息 | 撤回不等于取消，条件不明 | delete_msg 不保证取消在途发送 | unknown；取消不支持则如实返回 |
| 多端/频率/长期运行 | 未测；版本或提供方依赖 | 未测；客户端兼容与平台限制 | unknown；无 SLA/无限频率承诺 |
| 本人电脑关机持续收发 | 独立在线客户端/提供方及全链路才有可能 | 独立在线 NTQQ/桥接及全链路才有可能 | 两者 AC23 blocked，未测 |

来源编号见 [feasibility.md](feasibility.md)；具体复用文件见 [github-reuse.md](github-reuse.md)。

## Bot 路线单列

QQ 官方 Bot：官方文档证明用户可与机器人单聊，作为“本人 QQ 已有好友会话替代”不适用。

腾讯 openclaw-weixin：有独立 Bot ID、扫码用户 ID、消息类型 USER/BOT、context_token。文档/源码证明存在 Bot 接入候选，不能证明个人好友列表、现有聊天读取或以本人身份发送。当前判断为目标适用性 unknown / 不可据此验收；不要把 `USER` 当本项目 owner。其服务端 message_id 为可选；本地 clientId 不能当平台回执。完整动态表情、本人多端发送、补齐和长期授权均未实测。

## 原型能力的边界

mock 的 30 个离线测试覆盖去重、来源、回执、媒体失败、发送拒绝及模拟恢复；QQ 内部协议、传输、媒体、来源分类与恢复评估另有 57 个离线测试。mock 的 getCapabilities 使用 verificationStatus=unknown 并声明 fixture_only/NO_NETWORK，不表示微信或 QQ 有这些真实能力。总计 87 个离线测试通过，真实能力仍按上表 unknown/blocked 记录。

逐项状态的正式机器表达、未知来源事件和媒体完整性字段仍需 00 在公共 schema 落定。当前没有生产能力快照，不能把此矩阵的 documented 字段直接用于启用自动模式。

## 2026-09-24 实测更新（覆盖上表的 `unknown`）

上表是 2026-09-22 的候选评估矩阵，逐项状态**已由两轮真实 spike 部分取代**，以各平台快照为准：

| 能力 | QQ（[快照](../reports/platform-qq-capability-snapshot-2026-09-24.json)） | 微信（[快照](../reports/platform-wechat-capability-snapshot-2026-09-24.json)） |
| --- | --- | --- |
| 文字接收 | `tested`（真实好友私聊） | `tested`（2 条） |
| 图片接收 | `tested`（1 条，原始字节私密留存） | `tested`（1 条；**仅约 4.3 KB 缩略图级别内联字节**） |
| 语音接收 | `tested`（1 条） | `tested`（1 条，`<voicemsg>` 元数据） |
| 表情（贴纸）接收 | 段类型记为 `unsupported`，未声明静态/动态表情 | **未观测到**（type 47 未出现，故不声明） |
| 文字发送 | `tested`（受控真实发送两次，`accepted` 级回执 + 平台消息 ID） | `unknown`（发送路径偏移未移植） |
| 回执级别 | `tested`（只到 `accepted`） | `unknown` |
| 本人/系统回显、历史补齐、媒体完整获取 | `unknown` | `unknown` |

两项都**没有**达到 `GO_CONFIRM_ONLY`：QQ 还缺批准表情发送、本人/回显区分与 AC23；微信只完成了接收侧，且其偏移表是**针对本机这一个二进制移植的**，微信更新后必须重做。
