# QQ 真实接入 Spike 计划（G2 前置）

日期：2026-09-24。状态：**待本人决策与账号输入**；本次未安装、未下载候选代码、未登录任何账号、未连接任何真实平台、未修改 01 代码。基线：PRD v1.3、公共契约 v0.3.0、[platform-validation.md](../platform-validation.md)、[aliyun-readiness.md](aliyun-readiness.md)、[packages/platform/qq](../../packages/platform/qq/README.md)。

本页把 G2 入口的不可外包项（路线、风险接受、账号、常在线宿主）与工程缺口分开列出，使 spike 一旦拿到账号即可执行。公开资料只作 spike 输入，不构成能力验证。

## 1. 为什么先做 QQ

01 的 QQ OneBot 协议层已有 87 项离线测试（事件解码、媒体指针、自身来源分类、恢复评估、发送执行器、出站传输）；微信没有任何已验证候选，个人微信现有好友会话也没有可确认的官方路径。先验 QQ 能以最低新增代码换到第一份真实证据；这不代表微信被放弃，两个平台的 AC23 仍需分别实测。

## 2. 候选组件事实（2026-09-24 只读查证）

| 项 | 事实 | 对本项目的影响 |
| --- | --- | --- |
| 版本 | NapCat 最新发布 `v4.18.28`（2026-09-14），仓库仍在活跃维护（2026-09-23 有提交），约 1.07 万 stars | 版本可固定；维护活跃不等于稳定性承诺 |
| 许可 | **不是开源许可**。许可证为 “Limited Redistribution License for NapCat”，正文声明未经作者明确许可禁止使用、复制、修改或分发本代码，仅在包含完整许可文本与来源声明时允许再分发；GitHub 识别为 `NOASSERTION` | 引入需本人明确接受受限许可：不能随本项目再分发其代码，交付或开源前需另行处理。**这是 D01 的风险项之一，不能默认为已接受** |
| 网络模型 | 支持 HTTP 服务端（NapCat 收）、HTTP 客户端（NapCat 把事件推给应用）、正向与反向 WebSocket | 01 的入口按事件推送设计，对应 HTTP 客户端模式或反向 WS |
| 鉴权 | HTTP 客户端配置项为 `name`/`url`/`messagePostFormat`/`reportSelfMessage`/`token`/`enableForcePushEvent`，**未见签名密钥或 HMAC 字段** | 01 的 `verifyWebhook`（HMAC-SHA1）在这条路线上不成立。入口安全模型必须改为私有网络加 token 且不暴露公网，或改用反向 WS 复用 token。该结论需在 spike 实测确认，并据此更新 [contract-proposals.md](contract-proposals.md) 中关于验签的表述 |
| 消息格式 | `messagePostFormat` 可配置为数组格式 | 满足 01 解码器只解析数组、拒绝 CQ 字符串的前提 |
| 自身消息 | `message_sent` 事件对私聊与好友可用 | 本人发言识别有原始信号，但仍需实测区分本人手发与桥接发送回显；`self-origin.mts` 的独立 verifier 仍缺实现 |
| 本机载体 | 本机已装 QQ NT 9.9.30（Windows），但**本机没有 Docker** | 本机可做只读对照，不适合作为常在线宿主 |
| 常在线宿主 | 尚无已核查宿主；已建议阿里云 ECS Ubuntu 24.04 加 Docker，现有实例参数未核实 | AC23（本人电脑关机后持续运行）必须落在独立在线宿主，且桥接与核心同址或在私有网络内 |

## 3. 01 侧代码缺口（spike 前必须补）

已有（离线、无真实连接）：私聊事件解码、媒体指针采集与私有存储接口、自身来源分类端口、恢复评估、发送执行器、OneBot 出站 HTTP 传输、87 项离线测试。

仍然缺：

1. **入口进程**：没有监听端口。需要一个组合根把 NapCat 事件推送、传输鉴权、`decodePrivateEvent`、原子接纳（PostgreSQL inbox/pending/outbox 同事务）与 02 的 `ingestPlatformEvent` 接起来。当前唯一的真实组合根是 `apps/web/server/main.mts`，而它接的是 mock 适配器。
2. **原子接纳的 PostgreSQL 实现**：`AtomicReceptionPort` 只有依赖形状，没有生产存储实现；需要把 `packages/infrastructure/postgres/event-store.mts` 的 `commitReceived` 与原始事件私有引用、pending/outbox 同事务接起来。
3. **出站接线**：把 02 的 dispatch 租约接到 `QqSendExecutor` 与 `OneBotHttpTransport`（现在只有 mock 平台被接进 worker）。
4. **结构决定**：新增组合根（例如 `apps/bridge/`）属于架构变化，按项目规则应先登记决策再改代码。

## 4. 需要本人决定或提供

1. **路线确认**：QQ 个人账号加 OneBot（NapCat）。不同意则回到产品决策，不进入 spike。
2. **风险接受**（必须明确，不得含糊）：非官方路线可能违反腾讯条款；账号可能被限制或封禁；需要长期保持登录的客户端；依赖为非开源且限制使用的许可。
3. **测试账号与联系人**：一个可接受风险的 QQ 号（建议非主力号）和一名愿意配合的测试联系人。沙箱阶段不使用主号。
4. **常在线宿主**：现有阿里云实例（需先只读核查参数），还是新建实例或其他常开设备。

## 5. 执行顺序（每步产出可复验证据）

0. 宿主只读核查（沿用 aliyun-readiness.md 的命令），固定 NapCat 版本与镜像摘要，保存许可文本；不改现有业务、不开放公网。
1. 沙箱账号登录：验证登录稳定性、是否依赖扫码或手机在线、失败与恢复方式。
2. **只接收不发**：跑入站能力矩阵（文字、图片、语音、静态表情、动态表情、引用、撤回、自身消息），保存脱敏原始事件样本，逐项标注 `documented`、`tested`、`unsupported` 或 `unknown`。
3. 媒体验证：原图、原语音、动态完整性，`get_image` 与 `get_record` 的路径语义与跨主机可读性，URL/token 失效期。
4. 本人发言识别：手机手发、桥接回显、系统消息三类对照，验证 `self-origin` 分类；无法区分则记录缺口并禁用自动模式。
5. **受控出站**：在 [verification.md](verification.md) 的批准清单内，经 02 租约发送文字与已批准表情，记录回执层级与 `message_id` 关联。
6. 故障注入：重复、乱序、断网、提交中断、核心与桥接分别重启、重登；验证 `RESULT_UNKNOWN` 与 reconcile，不重发。
7. 关机验证：关本人电脑，确认接收、判断、生成、发送持续，如实记录对手机、扫码或常在线设备的依赖。
8. 产出 `docs/reports/platform-qq-YYYY-MM-DD.md`，结论只能是 `GO_CONFIRM_ONLY`、`GO_AUTO`、`CONDITIONAL` 或 `NO_GO`；模拟或公开文档结果不得计入。

## 6. 本轮完成与未做

完成：路线候选事实查证（版本、许可、网络模型、鉴权、消息格式、自身消息）、01 侧代码缺口清单、spike 执行顺序与证据要求。

未做：未安装或下载 NapCat，未创建 `apps/bridge`，未改动 01/02/03 代码，未登录任何账号，未产生任何真实收发。
