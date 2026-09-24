# QQ G2 只接收验证步骤

日期：2026-09-24。对象仅为**非主力个人 QQ 测试账号与其已有、知情的一对一好友会话**；QQ 官方 Bot、群聊或模拟 OneBot 回包均不计目标能力。当前未登录真实账号、未连接阿里云服务器、未实际接收或发送。本人要求服务器最后核查，因此本页是后续可执行步骤，不是已执行记录。公共语义以 [contracts.md](../contracts.md) v0.3.0 与 [A16](../decisions.md) 为准。

## 入口条件与边界

本人已接受对 NapCat 非官方路线及账号风险进行非主力账号评估；[固定版本 v4.18.28 发布页](https://github.com/NapNeko/NapCatQQ/releases/tag/v4.18.28)与[该版本许可](https://github.com/NapNeko/NapCatQQ/blob/v4.18.28/LICENSE)已于 2026-09-24 只读复查。许可证的具体个人测试使用权限需在安装前核清；不复制、修改或再分发其代码。维护者文档说明 HTTP 客户端可推送事件，配置项包括 `messagePostFormat`、`reportSelfMessage` 与 `token`；这只是组件声明，不能当作实际收发证据。[配置说明](https://napneko.github.io/config/basic)、[事件说明](https://napneko.github.io/develop/event)。

进入真实验证时，先由本人确认：测试账号确为个人 QQ、已有好友测试会话且对方知情、测试时间窗、是否可在阿里云隔离运行客户端与桥、必要登录方式。只提供脱敏的服务器系统/架构/资源/是否承载其他业务；密码、二维码、session、token、QQ 号码、聊天原文均不发到聊天或仓库。07 先检查隔离、持久卷、端口与日志权限；00/03 确定名单外原始事件最小保存与保留期。未满足时可继续本地模拟，不能启动真实桥接。

本阶段**只接收**：`QQ_ENABLE_OUTBOUND=0`、`WORKER_ENABLED=0`。`apps/bridge/main.mts` 默认也为此模式，不需要 `QQ_ONEBOT_BASE_URL`；即使存在待发送任务也不启动 worker。不要在同一数据库另起可发送的 API/worker 或上游自动回复插件。`/healthz` 仅证明本进程存活，不证明 QQ 已登录、历史已补齐或可发送。`HOST` 默认 `127.0.0.1`；跨容器部署由 07 配置私有网络和隔离端口，不公开 `/onebot/event`、OneBot HTTP/WS、WebUI 或数据库。Bearer token 只存目标主机私有配置，不能出现在命令回显、普通日志或报告。真实桥接的 `messagePostFormat` 应配置为数组；`reportSelfMessage` 可在自身消息专项中打开，但当前未有经审核的 peer mapper，自己发出的事件当前会收到 400，不能据此归类为联系人来信。

## 执行与记录

1. **宿主只读核查，放在本地工作完成后**：执行 [aliyun-readiness.md](aliyun-readiness.md) 中的只读命令，由 07 记录 OS、架构、资源、现有业务与可用私有网络；不重装、不开放端口。固定客户端与桥的版本和下载摘要，审核许可证及安装权限后，本人于测试窗口自行扫码/确认。记下登录、重启、重新扫码条件，不记录票据。
2. **接收入口检查**：配置私有事件推送至 `POST /onebot/event`，确认错误 token 为 401、正确账号的目标私聊入站为 204、错误 `self_id` 为 403。使用完全合成数据在隔离测试库先重放一次，真实样本只由知情测试好友按约定从原 QQ 客户端发送。HTTP 204 只表示接纳到本地持久层，不表示业务消费完整、媒体已下载或历史无缺口。
3. **最小入站样本**：好友先发一条不含私人信息的文字；随后在明确时间窗分别发测试图片、语音、静态表情、动态表情、含引用文字和可撤回的测试文字。每类记录账号类型、会话是否原有好友、事件时间/接收时间、是否有平台消息 ID、原始事件私有引用、引用/媒体字段的存在性及返回状态。原始字节与媒体只留在私有存储，报告用随机证据编号，不写正文、URL、QQ 号或可反推身份的裸哈希。
4. **异常与重复**：用同一已授权样本在本地测试环境重放两次，比较 `platform_inbox_raw`、`data_messages`、02 待办数量；再交换两条合成消息到达顺序。混合文本+媒体必须成为 `unsupported`，进入人工处理且不生成可发送方案；纯媒体不能改写成文本。动态表情只有拿到原始动画字节并核实完整性才能记 `complete`，单帧/缩略图一律 `partial` 或 `unavailable`。
5. **本人来源专项**：当前桥接缺经审核的自身消息 peer mapper。本人若从手机/原客户端向知情测试好友手发一条约定文字，先在主机私有诊断区观察原事件字段，记录是否有稳定对端字段、`message_sent`/回显情况；桥接收到 400 时不把它伪装为接管成功。字段映射经 01/00 审核并补测试后，才能验证 `PlatformSelfMessageUnattributed`、独立本人证据与系统回显关联。此阶段不由系统发测试消息，故不能完成系统回显对照。
6. **断线与恢复**：在只接收模式下依次重启桥接与 01，记录登录是否保留、期间好友的测试消息是否补齐、重复事件是否被去重、是否存在可证明的连续覆盖游标。没有连续覆盖证据的 `RecoveryReport.historyComplete=false`，连接状态保持 `reconciling/degraded`；不能因为重连或 `/healthz` 正常而开放新发送。已接纳但 02 消费失败的 outbox 行由 `apps/bridge/outbox-pump.mts` 负责重投：`bridge.start()` 先跑一次 tick 再启动定时器，领取行先提交、再交消费者、最后标记发布。真实库用例 `tests/integration/postgres-outbox-pump.test.mts` 覆盖"消费者失败后行保持未发布并可重投"和"只投本账号事件"；`tests/integration/postgres-qq-bridge.test.mts` 覆盖"提交后在消费者崩溃时 outbox 行仍在、重复 webhook 不产生第二个业务副作用"。因此接收侧不再有已知的补齐阻塞项。
7. **停止与清理**：结束测试后停止桥接与 01，撤销测试账号会话或由本人按需退出。记录组件版本、登录次数、断线时间、故障码和证据编号；秘密不入库外报告。私有原始事件按 03/00 的保留策略清理，去重与发送账本的保留另行评估，不能直接删除后再重放。

## 判定

本阶段最多得出**接收侧 CONDITIONAL**，不能给 `GO_CONFIRM_ONLY` 或 `GO_AUTO`，因为出站回执、本人/系统回显区分、媒体完整获取及 AC23 关机后双向收发仍未实测。任一事件误判为联系人或未经授权发生真实发送、凭据泄露、端口公网暴露，立即 `NO_GO` 并停止测试。只接收的合格证据是：确认为个人 QQ 已有好友会话、鉴权正确、入站类型有逐项实测结果、重复不产生第二次业务副作用、未知/不完整内容转人工、断线缺口被显式标记。

后续若要升为 `GO_CONFIRM_ONLY`，需 02 提供明确的测试会话、发送内容及次数并经本人授权，完成真实文字/批准表情发送、回执关联、未知结果不重试、人工接管/回显区分及独立宿主关机测试。`GO_AUTO` 还需来源、历史连续覆盖、恢复和长期稳定性证据。微信必须单独跑同等级验证；QQ 结论不能推断微信。

交接：01 向 00/06 提供版本化账号连接状态、逐能力 `documented/tested/unsupported/unknown` 与 `RecoveryReport` 的受控摘要；02 只使用真实来源证据和发送状态，03 接收私有媒体/原始事件，04 决定媒体理解并在不足时暂停，07 负责宿主隔离和关机演练。名单外联系人现在只保留最小发现元数据（`payload_ref='discovery:metadata-only'`，仅留作用域 ID、事件键、时间与摘要），未入名单不再落全文；已登记账号但无法确定对端的自身消息按 `unmapped_self` 处理，只保留受限原始证据并暂停整个账号（不猜 contactId）。能力快照的填法见下一节。

## 能力快照怎么填（G2 的交付格式）

预 spike 快照在 [platform-qq-capability-snapshot-2026-09-24.json](../reports/platform-qq-capability-snapshot-2026-09-24.json)：六个能力族 `receive_types`、`send_types`、`receipt_levels`、`owner_message_signal`、`history_sync`、`media_fetch` 各有一条证据项，当前是 `documented`（维护者/规范文档）或 `unknown`（无实测），总体状态因此只能是 `unknown`。`accountId` 是占位值，选定真实测试账号后必须换成已登记 `PlatformAccount` 的内部 UUID 并重新签发。

填写规则由 [contracts.md](../contracts.md) §2 与机器校验 `assertCapabilitySnapshot` 共同强制，`tests/contracts/capability-snapshot.test.mts` 会拒绝以下写法：

1. 把 `tested` 的来源写成 `http(s)://` 文档链接——文档不能证明本项目实测过；
2. 总体状态与逐项推导不一致（总体不能强于最弱的能力族）；
3. 少写任何一个能力族、重复同一族、证据为空、`unknown` 不写缺失原因、时间不是 RFC3339。

因此每完成一项实测，把该项改成 `tested` 并填写本项目证据编号（例如 `run:qq-receive-only-2026-09-25-a`），再让总体状态由推导得出，不要手写升级。报告交付时必须同时给出该 JSON 与 markdown 报告，两者结论一致；只接收阶段六项不可能全部 `tested`，总体应停在 `unknown` 或 `documented`。
