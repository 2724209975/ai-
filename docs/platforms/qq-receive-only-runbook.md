# QQ G2 只接收验证步骤

日期：2026-09-24。对象仅为**非主力个人 QQ 测试账号与其已有、知情的一对一好友会话**；QQ 官方 Bot、群聊或模拟 OneBot 回包均不计目标能力。本机已有一次真实**只接收**记录（见 [CONDITIONAL 报告](../reports/platform-qq-2026-09-24.md)），未真实发送。宿主为**本机 Windows 11 23H2（build 22631）** / 20 逻辑核 / 15.6 GB RAM / C 盘约 58 GB 可用 / QQ NT 9.9.30；先前把注册表 `ProductName=Windows 10 Pro` 直接当系统版本，已按 build 纠正。[微软版本对应表](https://learn.microsoft.com/en-us/windows/release-health/windows11-release-information)将 build 22631 归为 Windows 11 23H2。阿里云后置，AC23 关机运行尚未验证。本页是复现与后续验证步骤，未执行部分明确标注。公共语义以 [contracts.md](../contracts.md) v0.3.0 与 [A16](../decisions.md) 为准。

## 开工前确认清单（本人一次回复即可）

以下五项齐了就能开始只接收 spike；缺任一项时先用本机模拟，不接真实桥接。**不要在聊天或仓库里提供号码、密码、二维码、token 或聊天记录。**

| # | 事项 | 状态（2026-09-24 本人答复） |
| --- | --- | --- |
| 1 | 非主力测试 QQ 号 | ✅ 已具备 |
| 2 | 知情测试好友 | ✅ 已具备 |
| 3 | 宿主 | ✅ 本机 Windows 11 23H2（build 22631 / 20 逻辑核 / 15.6 GB RAM / C 盘约 58 GB 可用 / QQ NT 9.9.30 已装）；阿里云后置，AC23 关机运行后置 |
| 4 | 登录方式与时间窗 | ⏳ 登录时需本人在场（扫码），具体时间窗待约定 |
| 5 | 风险与许可 | ✅ 本人已接受非官方路线与账号风险，并允许个人测试（记于 A16 / D01） |

上述清单是首次 spike 开始前的历史快照。本人已完成那次交互登录；后续若需重新登录，仍由本人在场扫码，不传递票据。

## 入口条件与边界

本人已接受对 NapCat 非官方路线及账号风险进行非主力账号评估；[固定版本 v4.18.28 发布页](https://github.com/NapNeko/NapCatQQ/releases/tag/v4.18.28)与[该版本许可](https://github.com/NapNeko/NapCatQQ/blob/v4.18.28/LICENSE)已于 2026-09-24 只读复查。许可证的具体个人测试使用权限需在安装前核清；不复制、修改或再分发其代码。维护者文档说明 HTTP 客户端可推送事件，配置项包括 `messagePostFormat`、`reportSelfMessage` 与 `token`；这只是组件声明，不能当作实际收发证据。[配置说明](https://napneko.github.io/config/basic)、[事件说明](https://napneko.github.io/develop/event)。

本机只接收验证已完成一次，结果见 [2026-09-24 脱敏报告](../reports/platform-qq-2026-09-24.md)。后续扩展验证仍须限定非主力个人 QQ 已有好友的知情测试会话。密码、二维码、session、token、QQ 号码、聊天原文均不发到聊天或仓库。07 核查隔离、持久卷、端口与日志权限；名单外事件现只保存最小发现元数据，原始证据保留期仍由 00/03 定。

本阶段**只接收**：`QQ_ENABLE_OUTBOUND=0`、`WORKER_ENABLED=0`。`apps/bridge/main.mts` 默认也为此模式，不需要 `QQ_ONEBOT_BASE_URL`；即使存在待发送任务也不启动 worker。不要在同一数据库另起可发送的 API/worker 或上游自动回复插件。`/healthz` 仅证明本进程存活，不证明 QQ 已登录、历史已补齐或可发送。`HOST` 默认 `127.0.0.1`；跨容器部署由 07 配置私有网络和隔离端口，不公开 `/onebot/event`、OneBot HTTP/WS、WebUI 或数据库。配置里的 token（本次 NapCat 签名推送将其用作 **HMAC-SHA1 密钥**）只存目标主机私有配置，不能出现在命令回显、普通日志或报告；桥接按 `x-signature` 校验原始字节并核对 `x-self-id`。真实桥接的 `messagePostFormat` 应配置为数组。若后续打开 `reportSelfMessage`，没有经审核 peer mapper 的自身消息会作为内部 `unmapped_self` 私密留证并暂停账号，204 表示隔离和暂停已提交，**不表示本人接管已识别成功**；本次真实 spike 尚未打开该开关。

## 执行与记录

1. **宿主核查**：本次先在本机 Windows 验证，只记录版本、资源、隔离与可用磁盘；阿里云及 [aliyun-readiness.md](aliyun-readiness.md) 留待 AC23 前再核查。固定客户端与桥的版本和下载摘要，审核许可证及安装权限后，本人于测试窗口自行扫码/确认。记下登录、重启、重新扫码条件，不记录票据。
2. **接收入口检查**：先跑 `npm run spike:preflight`（只需 `DATABASE_URL`：在一次性 schema 里迁移、登记一个合成联系人、以只接收姿态启动**真实入口进程** `apps/bridge/main.mts`、投递同一条合成事件两次，校验错误 token 401、接纳 204、重放幂等、无发送、outbox 已发布，随后删除该 schema 与临时目录；不接触真实账号），再跑 `npm run spike:posture`（校验 `QQ_ENABLE_OUTBOUND` 未开、`WORKER_ENABLED` 未开、监听仍在 loopback、token 已配置且没有多余 OneBot 地址；违反任一条即报错退出）。再配置私有事件推送至 `POST /onebot/event`，确认错误 token 为 401、正确账号的目标私聊入站为 204、错误 `self_id` 为 403。使用完全合成数据在隔离测试库先重放一次，真实样本只由知情测试好友按约定从原 QQ 客户端发送。HTTP 204 只表示接纳到本地持久层，不表示业务消费完整、媒体已下载或历史无缺口。
3. **最小入站样本**：好友先发一条不含私人信息的文字；随后在明确时间窗分别发测试图片、语音、静态表情、动态表情、含引用文字和可撤回的测试文字。每类记录账号类型、会话是否原有好友、事件时间/接收时间、是否有平台消息 ID、原始事件私有引用、引用/媒体字段的存在性及返回状态。原始字节与媒体只留在私有存储，报告用随机证据编号，不写正文、URL、QQ 号或可反推身份的裸哈希。
4. **异常与重复**：用同一已授权样本在本地测试环境重放两次，比较 `platform_inbox_raw`、`data_messages`、02 待办数量；再交换两条合成消息到达顺序。**重放必须是同样的字节**：同一平台事件键但内容哈希不同（例如桥接重新序列化后 `time` 变了）会被判为冲突并返回 **409**，桥接日志记为 `ingress-conflict`，这是设计上的防篡改而不是故障；真实平台若这样重投，按"平台重投会改字段"如实记录，不要改期望去迁就。混合文本+媒体必须成为 `unsupported`，进入人工处理且不生成可发送方案；纯媒体不能改写成文本。动态表情只有拿到原始动画字节并核实完整性才能记 `complete`，单帧/缩略图一律 `partial` 或 `unavailable`。
5. **本人来源专项**：本次真实 spike 未打开 `reportSelfMessage`，所以此项仍未实测。后续若本人从手机/原客户端向知情测试好友手发一条约定文字，用 `npm run spike:shape -- <原始事件文件或目录>` 在主机私有诊断区**只读字段形状**：它输出顶层键名、`post_type`/`message_type`/`sub_type`/`notice_type`（只回显固定枚举）、`self_id`/`user_id`/`target_id`/`message_id`/`time`/`sender` 是否存在、消息段类型与每段 `data` 的键名、字节长度；**不输出取值或文件名**。无法审计对端时桥接 204 只表示 `unmapped_self` 私密证据和账号暂停已提交，不能把它当作接管成功。字段映射经 01/00 审核并补测试后，才能验证 `PlatformSelfMessageUnattributed`、独立本人证据与系统回显关联。此阶段不由系统发测试消息，故不能完成系统回显对照。
6. **断线与恢复**：在只接收模式下依次重启桥接与 01，记录登录是否保留、期间好友的测试消息是否补齐、重复事件是否被去重、是否存在可证明的连续覆盖游标。没有连续覆盖证据的 `RecoveryReport.historyComplete=false`，连接状态保持 `reconciling/degraded`；不能因为重连或 `/healthz` 正常而开放新发送。已接纳但 02 消费失败的 outbox 行由 `apps/bridge/outbox-pump.mts` 重投：`bridge.start()` 先跑一次 tick 再启动定时器，锁住待处理行，02 消费提交后才标记 `published_at`。隔离 PostgreSQL 用例验证本地崩溃窗口与重复回调，但**平台断线期间能否补齐历史仍未实测**，两者不能混为一谈。
7. **证据汇总与私有追溯**：`npm run spike:summary`（需要 `DATABASE_URL`、`QQ_ACCOUNT_ID`，可选 `RAW_EVENT_DIR`）输出**去敏聚合**：已登记/仅发现/无法映射自身的入站计数、按类型的消息计数、同平台消息 ID 的重复行数、会话状态与暂停原因计数、待办与发送状态计数、未发布 outbox、私有原始文件数与未引用数。它只查询聚合列，不读取正文、媒体或平台标识。另一名复核者若能在私有测试环境访问原库和 `RAW_EVENT_DIR`，可运行 `npm run spike:manifest > .local-napcat/qq-evidence-manifest.json`：仅在本机私有文件中保存每条内部 inbox UUID、时间、scope、事件/消息类型和原始文件 SHA-256 核对状态，不输出文件路径、裸摘要、号码或正文。该目录已被 Git 忽略；不要把 manifest 发到聊天或提交仓库。若原环境不可访问，报告保留“逐样本未独立复核”。
8. **生成报告**：`npm run spike:report`（需要 `DATABASE_URL`、`QQ_ACCOUNT_ID`；`SPIKE_OUT` 指定输出路径，`SPIKE_ENV_EXTRA='宿主=...;CPU=...'` 补宿主事实）。它从当日能力快照与上一步的去敏汇总生成 `docs/reports/platform-qq-<日期>.md`，包含路线/版本/环境、逐项能力证据、证据汇总、未验证项、风险与契约提案。**结论字段不会被推断**：默认写「未填写结论，G2 保持未完成」，只有 `SPIKE_VERDICT` 显式取四个判定之一时才写入，且仍需本人确认。同一路径已存在时拒绝覆盖，避免覆盖历史报告。
9. **停止与清理**：结束测试后停止桥接与 01，撤销测试账号会话或由本人按需退出。记录组件版本、登录次数、断线时间、故障码和证据编号；秘密不入库外报告。私有原始事件按 03/00 的保留策略清理，去重与发送账本的保留另行评估，不能直接删除后再重放。

## 判定

本阶段最多得出**接收侧 CONDITIONAL**，不能给 `GO_CONFIRM_ONLY` 或 `GO_AUTO`，因为出站回执、本人/系统回显区分、媒体完整获取及 AC23 关机后双向收发仍未实测。任一事件误判为联系人或未经授权发生真实发送、凭据泄露、端口公网暴露，立即 `NO_GO` 并停止测试。只接收的合格证据是：确认为个人 QQ 已有好友会话、鉴权正确、入站类型有逐项实测结果、重复不产生第二次业务副作用、未知/不完整内容转人工、断线缺口被显式标记。

后续若要升为 `GO_CONFIRM_ONLY`，需 02 提供明确的测试会话、发送内容及次数并经本人授权，完成真实文字/批准表情发送、回执关联、未知结果不重试、人工接管/回显区分及独立宿主关机测试。`GO_AUTO` 还需来源、历史连续覆盖、恢复和长期稳定性证据。微信必须单独跑同等级验证；QQ 结论不能推断微信。

交接：01 向 00/06 提供版本化账号连接状态、逐能力 `documented/tested/unsupported/unknown` 与 `RecoveryReport` 的受控摘要；02 只使用真实来源证据和发送状态，03 接收私有媒体/原始事件，04 决定媒体理解并在不足时暂停，07 负责宿主隔离和关机演练。名单外联系人现在只保留最小发现元数据（`payload_ref='discovery:metadata-only'`，仅留作用域 ID、事件键、时间与摘要），未入名单不再落全文；已登记账号但无法确定对端的自身消息按 `unmapped_self` 处理，只保留受限原始证据并暂停整个账号（不猜 contactId）。能力快照的填法见下一节。

## 能力快照怎么填（G2 的交付格式）

历史预 spike 快照及本机只接收更新均在 [platform-qq-capability-snapshot-2026-09-24.json](../reports/platform-qq-capability-snapshot-2026-09-24.json)。六个能力族 `receive_types`、`send_types`、`receipt_levels`、`owner_message_signal`、`history_sync`、`media_fetch` 必须逐项看证据状态；其中只接收实测仅覆盖接收侧部分，不把其余 `documented` 或 `unknown` 项升级为 `tested`。真实报告中的 `accountId` 是已登记账号的内部 UUID，不是 QQ 号。

填写规则由 [contracts.md](../contracts.md) §2 与机器校验 `assertCapabilitySnapshot` 共同强制，`tests/contracts/capability-snapshot.test.mts` 会拒绝以下写法：

1. 把 `tested` 的来源写成 `http(s)://` 文档链接——文档不能证明本项目实测过；
2. 总体状态与逐项推导不一致（总体不能强于最弱的能力族）；
3. 少写任何一个能力族、重复同一族、证据为空、`unknown` 不写缺失原因、时间不是 RFC3339。

因此每完成一项实测，把该项改成 `tested` 并填写本项目证据编号（例如 `run:qq-receive-only-2026-09-25-a`），再让总体状态由推导得出，不要手写升级。报告交付时必须同时给出该 JSON 与 markdown 报告，两者结论一致；只接收阶段六项不可能全部 `tested`，总体应停在 `unknown` 或 `documented`。
