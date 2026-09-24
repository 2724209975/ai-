# 微信路线候选事实与决策包

日期：2026-09-24。方式：GitHub API 与许可文件的**只读**核查（本页当日为决策输入）；后续进展与实测结论见 [platform-wechat-wxhelper-2026-09-24.md](../reports/platform-wechat-wxhelper-2026-09-24.md) 与 [platform-wechat-capability-snapshot-2026-09-24.json](../reports/platform-wechat-capability-snapshot-2026-09-24.json)。**当日结论更新**：本人选定 wxhelper 路线，上游偏移表与本机二进制不匹配（同版本号不同构建），经离线偏移移植后**只接收实测通过**——只捕获到文字/图片/语音与一条『拍一拍』，表情（贴纸）未出现；发送、回执、媒体完整获取仍 `unknown`。

## 结论先行

目标场景是「本人现有的个人微信账号 + 既有好友一对一」。按 2026-09-24 的事实，**能满足该账号形态的路线只剩下非官方 Hook 或 UI 自动化**，而它们分别卡在许可、维护状态或平台风险上；此前评审列出的两条主力路线已经失效（一条归档、一条 puppet 停更四年）。因此微信半场目前**不可能给出 `GO`**：要么本人明确接受某条非官方路线及其封号风险，要么把微信推迟到找到可用路线之后。这不是能力不足，而是没有可接受的路线可测。

## 核查事实（2026-09-24）

| 候选 | 机制与账号形态 | 许可 | 维护状态 | 对本场景的判定 |
| --- | --- | --- | --- | --- |
| [lich0821/WeChatFerry](https://github.com/lich0821/WeChatFerry) | Windows 微信 Hook，个人账号 | MIT | **已归档**（archived），最后提交 2026-07-10，最后发布 v39.5.2（2026-03-28） | 9-22 评审把它列为在研候选，现已失效；只能作为历史对照，不选 |
| [wechaty/wechaty](https://github.com/wechaty/wechaty) + [puppet-wechat](https://github.com/wechaty/puppet-wechat) | SDK 与 Puppet 抽象；微信能力取决于 puppet | Apache-2.0 | 主框架最后发布 v0.56（2021-01-25）、最后提交 2025-12-21；**微信 puppet 最后提交 2022-07-14** | 微信 puppet 停更约四年，等于没有可用的微信路线；不选 |
| [aixed/WeChat-Hook](https://github.com/aixed/WeChat-Hook) | PC 微信 Hook（自述针对 3.9.10.16 与 4.1.10.27），个人账号 | **未检测到许可文件（NONE）** | 活跃：2026-09-15 有提交，2096 stars | 技术形态匹配，但**无许可即默认禁止使用/修改/分发**；且与客户端版本强耦合。若评估，必须先解决许可 |
| [yincongcyincong/wechat_chatter](https://github.com/yincongcyincong/wechat_chatter) | **macOS** 微信逆向 Hook，个人账号 | **GPL-3.0** | 活跃：2026-09-22 有提交，634 stars | 许可为传染性 GPL-3.0，与本项目分发方式冲突风险高；且仅 macOS，与现行 Linux 宿主规划不符 |
| [LAVARONG/wechat-automation-api](https://github.com/LAVARONG/wechat-automation-api) | Windows **UI 自动化**（Flask + uiautomation）驱动客户端发送 | **未检测到许可文件（NONE）** | 活跃：2026-09-18 有提交，175 stars | UI 层自动化拿不到可靠消息 ID/回执，与「未知结果不得重发」的契约冲突；无许可 |
| [Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin) | 腾讯 Bot 身份与 context_token 会话 | **NOASSERTION** | 活跃：2026-09-21 有提交，887 stars | 账号形态不符（Bot 不是本人好友会话）；9-22 评审记录的“MIT”与当前事实不符，已更正 |

## 对 9-22 评审的两处更正

1. **WeChatFerry 已归档**，不再是候选路线；其 MIT 许可不影响“已停止维护”的事实。
2. **openclaw-weixin 的许可当前为 `NOASSERTION`**（GitHub 无法识别标准许可），9-22 评审写的 MIT 需要重新核对，不能据此判断可复用范围。

## 每条路线若要成立，需要什么

无论选哪条，以下条件都不可跳过，且与现有规划冲突点已标出：

1. **许可**：`NONE` 的仓库默认不可使用；GPL-3.0 会传染到分发方式；受限许可需作者明确授权。三者都必须由本人确认后我才继续。
2. **常在线宿主**：Hook/UI 自动化都要求微信客户端常驻，而客户端是 Windows 或 macOS。Linux 云主机跑不了，必须另加一台常开 Windows/macOS 主机——这直接改变 [aliyun-readiness.md](aliyun-readiness.md) 的宿主规划，且**不能**用“本人电脑关机后仍运行”这条要求蒙混。
3. **平台风险**：三条可用形态都是非官方注入或 UI 驱动，账号被限制/封禁的概率高于 QQ 桥接；必须由本人明确接受，且先在小号上试。
4. **契约对齐**：UI 自动化路线基本拿不到稳定 `message_id` 与回执，无法支撑「未知结果先核对、不盲目重发」；若选它，等于要放宽一条已确认的产品要求——这属于产品决策，不是工程折中。

## 需要本人决定

- **A. 接受某条非官方路线**（并承担许可与封号风险，另备常开 Windows/macOS 宿主）→ 我按 [platform-validation.md](../platform-validation.md) §4 出同等级只接收 spike 计划。
- **B. 推迟微信**，先把 QQ 侧（QQ 桥接已就绪）走完 G2，微信等出现可用路线再评估。
- **C. 改变场景**（例如接受企业微信/客服/公众号形态）→ 回到产品需求确认，不能沿用「本人个人账号好友会话」的既有验收。

在本人选择之前，微信半场保持 `unknown`，不会以任何模拟或公开文档结论替代实测。

## 2026-09-24 GitHub 复用检索（按"能复用多少本项目代码"排序）

检索方式：GitHub API 只读查询（关键词：wechat onebot / wcferry / ntchat / wxauto / wechatpadpro / wechat hook；含已归档项目的高星分支与其衍生项目）。未安装、未登录、未运行任何候选。

| 候选 | 机制与账号形态 | 许可 | 维护 | 可复用部分 | 主要阻塞 |
| --- | --- | --- | --- | --- | --- |
| [alingalingling/Akasha-WeChat](https://github.com/alingalingling/Akasha-WeChat) 179★ | 个人微信号；自称 OneBot v11 + 反向 WebSocket + 图片识别 + 表情发送；入站 WeFlow(SSE)、出站 UIA/REST | **NONE** | 2026-08-09 | 若真为 OneBot v11，可复用 `packages/platform/qq` 的解码/归一化/入口/出站传输，02/03/04/06 不动 | 无许可；入站依赖 WeFlow（实质与稳定性未知）；未实测 |
| [smrwang/wechat-onebot-virtual-gateway](https://github.com/smrwang/wechat-onebot-virtual-gateway) 4★ | Docker 内跑**官方微信 Linux 客户端** + 私有 X11 虚拟桌面，暴露 OneBot v11（正/反向 WS） | Apache-2.0 | 2026-08-20 | 同上（OneBot v11） | 私聊**入站是 Beta 且默认关闭**，只验证纯文本 Copy 链路、无多会话扫描；需 Linux+X11 宿主；官方 Linux 客户端能否承载本人账号与既有好友未验证 |
| [jessiongod/wechat-onebot-bridge](https://github.com/jessiongod/wechat-onebot-bridge) 3★ | Akasha-WeChat 的衍生分支，接 OneBot v11 WS 服务端 + 桌面管理器 | MIT | 2026-08-29 | 同上；许可比上游明确 | 极小项目；入站仍走 WeFlow |
| [ttttupup/wxhelper](https://github.com/ttttupup/wxhelper) 3161★ | 逆向 PC 微信、注入 DLL，导出**默认 19088 的 HTTP 接口**；限定微信版本 3.8.0.41–3.9.2.26 | MIT，但 README 声明"仅学习研究、勿商用" | 2026-06-12 | 契约与 02/03/04/06 不变；需**新写一个微信平台适配器**（HTTP） | 注入式、版本强耦合；用途声明与许可需你确认 |
| [TonyChen56/WeChatRobot](https://github.com/TonyChen56/WeChatRobot) 7210★ / [aixed/WeChat-Hook](https://github.com/aixed/WeChat-Hook) 2099★ | 同类 PC 微信注入 Hook | **NONE** | 2025-12-17 / 2026-09-15 | 同 wxhelper 路线 | 无许可 |
| [cluic/wxauto](https://github.com/cluic/wxauto) 7329★ / [scottfly189/WeChatAuto.SDK](https://github.com/scottfly189/WeChatAuto.SDK) 268★ / [fanyuantaier/wechatauto-replica](https://github.com/fanyuantaier/wechatauto-replica) 306★ | Windows **UI 自动化 / RPA** | Apache-2.0 / MIT / Apache-2.0 | 2026-04-13 / **2026-09-23** / 2026-09-22 | 契约与 02/03/04/06 不变 | **拿不到稳定平台消息 ID 与回执**，与"未知结果先核对、不盲目重发"的既有要求冲突，需产品让步 |
| [wechatferry/wechatferry](https://github.com/wechatferry/wechatferry) 2093★（含已归档的 lich0821/WeChatFerry） | 原主力 Windows Hook 路线 | MIT | **2025-07-18 停更**，活跃分支均为个位数 star | — | 已失效，不选 |
| [WeChatPadPro/WeChatPadPro](https://github.com/WeChatPadPro/WeChatPadPro) 2626★ | 基于 WeChat Pad 的管理工具 | **NONE** | 2026-08-20 | — | 无许可、通常依赖付费服务，先核清商业模式与授权 |
| [Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin) 887★ | 腾讯 Bot 身份 | NOASSERTION | 2026-09-21 | 仅作能力探针 | 账号形态不符（Bot 不是本人好友会话） |

## 2026-09-24 复核：读完 README 与接口清单后的修订

上表是"按 star 与协议自称"的初判；本节是逐项读 README／接口清单后的复核，**以本节为准**。仍然未安装、未登录、未运行任何候选。

1. **smrwang 虚拟网关是"出站优先"的网关，入站是 UI 复制实验链路。** README 自述：私聊**出站**已验证（`send_private_msg`，经确定性微信 UI 提交文本，且明确"返回成功不代表对方已读或平台级投递回执"）；私聊**入站**是可面板开关的 Beta、**默认关闭**，只覆盖"已登记且已校准私聊的**纯文本气泡**"，依赖 **Copy 菜单复制原文**后再构造隔离事件，并要求会话不置顶、不折叠、窗口与气泡位置已校准。能力矩阵里**文件/图片/语音/贴纸/引用回复一律"暂不支持"**，群聊与原生 `@` 不支持。优点是"**不模拟私有协议、不解密本地数据库**"，在私有 X11 里跑**官方 Linux 客户端**。→ 账号形态与许可最好，但**能力上限是纯文本、入站本身是 UI 层、无平台消息 ID 与回执**。
2. **Akasha-WeChat 实际上没有许可证文件。** GitHub 许可检测为空，根目录取 `LICENSE` 返回 404；README 与文件树里写的 "MIT 许可证"只是**自称**，不构成授权。它同时公开了真实依赖链：`微信 ←→ WeFlow ──SSE──→ bridge ←→ 下游(OneBot 反连)`，前置条件是 **Windows 桌面微信 + WeFlow（本机 API 端口 5031）+ `send_method: "uia"`**（出站走 UI 自动化）。
3. **WeFlow 是"微信聊天记录导出和年度报告应用"，不是协议桥。** [hicccc77/WeFlow](https://github.com/hicccc77/WeFlow) 14447★、**无许可**、最后推送 2026-08-28，自述即本地聊天记录导出／年度报告工具；Akasha README 也写明"WeFlow 超好的读取本地的微信聊天记录导出和年度报告应用"，并注明**因作者删库、需从 QQ 群下载**。→ 该路线的"实时入站"实质是读本地记录/导出库的 SSE 推送，且叠加了**第二层无许可 + 已删库、由社群分发的供应链风险**；出站是 UIA，同样没有消息 ID 与回执。
4. **wxhelper 的能力面比初判宽，版本上限也更清楚。** README 支持 **3.8.0.41 / 3.8.1.26 / 3.9.0.28 / 3.9.2.23 / 3.9.2.26 / 3.9.5.81**（3.9.5.81 为 x64 分支），接口清单含 `hook消息 / hook图片 / hook语音`（接收）、`发送文本/图片/文件`、`获取消息附件（图片、视频、文件）`、`获取语音文件(silk3)`、`联系人列表`、`撤回消息`；默认 HTTP 端口 19088，hook 类接口须先调用对应 hook 才会推送。→ **唯一能同时覆盖收/发/媒体三族的候选**，但仍是注入式逆向 DLL、免责声明"仅学习研究、勿商用"，且支持范围停在 3.9.x。
5. **RPA 候选的维护度比初判高**（`scottfly189/WeChatAuto.SDK` MIT，2026-09-23 仍有推送），但机制不变：UI 自动化拿不到平台消息 ID 与回执。

### 复用结论（复核后排序，标准＝能否支撑本项目已确认的契约）

| 排序 | 路线 | 账号形态 / 宿主 | 许可 | 能支撑的契约 | 硬缺口 |
| --- | --- | --- | --- | --- | --- |
| 1（唯一可能全测六族） | Windows 注入 Hook：wxhelper | 个人号 + **常开 Windows** | MIT，附"仅学习研究/勿商用"声明 | 接收事件（hook 消息/图片/语音）、发送文本/图片/文件、媒体附件与语音文件获取、联系人列表 | 注入式封号风险最高；版本锁 3.8–3.9.5.81（与当前 4.x 客户端脱节）；需自写微信适配器 |
| 2（最保守，但只有文本） | smrwang 官方 Linux 客户端网关（Docker + X11） | 个人号 + **Linux 宿主（与阿里云规划一致）** | Apache-2.0（最干净） | 私聊文本出站（UI 提交）+ Beta 文本入站（UI 复制链路） | 图片/语音/贴纸一概不支持；出站成功≠送达、无消息 ID、无回执；入站 Beta 默认关且需校准；4★ 早期项目 |
| 3（复用最省，但被两层许可卡住） | Akasha-WeChat / jessiongod 桥（OneBot v11） | 个人号 + 常开 Windows + WeFlow | 上游**无许可文件**（仅自称 MIT）；WeFlow **无许可、已删库、经 QQ 群分发** | 若 OneBot v11 属实，`packages/platform/qq` 整套复用 | 入站依赖无许可的导出应用而非协议桥；出站 UIA 无消息 ID/回执；项目极小 |
| 4（不建议先做） | RPA/UI 自动化：wxauto / WeChatAuto.SDK / wechatauto-replica | 个人号 + 常开 Windows | Apache-2.0 / MIT / Apache-2.0 | 轮询式收发 | 无稳定消息 ID/回执 → 与"未知结果先核对、不盲目重发"冲突，需产品让步 |
| —（排除） | WeChatFerry（已归档停更）、wechaty puppet-wechat（2022 停更）、TonyChen56 / aixed（**无许可**）、WeChatPadPro（无许可 + 付费服务）、Tencent/openclaw-weixin（Bot 形态不符） | — | — | — | — |

### 优劣对照（同一份需求下的取舍）

- **只看账号安全**：官方 Linux 客户端（第 2 条）> UI 自动化（第 4 条）> 注入 Hook（第 1 条）。注入 Hook 直接改 `WeChat.exe` 内存，是封号概率最高的一档，必须由本人明确接受后、且只在测试小号上做。
- **只看能否测出与 QQ 同等级的六族结论**：只有第 1 条可能走到；第 2 条最多把 `receive_types`/`send_types` 限定为"文本"，其余（图片/语音/贴纸、回执级别、本人回显、历史补齐、媒体获取）只能记 `unknown`。
- **只看代码复用**：第 3 条最省（OneBot v11 直接复用 `packages/platform/qq`）；第 1/2 条都要新写 `packages/platform/wechat` 适配器。但 QQ 桥已把"验签入口 + wire→公共事件归一化 + 出站只经 02 租约"这套模式走通，新适配器是**有界工作量**，不是从零开始——所以"复用"不构成选第 3 条的理由，它被许可问题抵消了。
- **只看宿主成本**：第 2 条能落在阿里云 Linux（与 [aliyun-readiness.md](aliyun-readiness.md) 一致，但需容器/X11 与扫码登录）；第 1/3/4 条都必须另备**常开 Windows**（自带机器长期开机或 Windows 云主机），直接关系 AC23"关机持续运行"。
- **三条候选共同的先行条件**：① 许可（Akasha 与 WeFlow 都必须先解决，否则不能用）；② 常在线宿主 + 扫码登录时本人到场；③ **本人手发与系统回显是否可区分**——三条**全部未验证**，缺它就不能开自动发送。

### 建议的最小下一步

1. **先由本人做一个取舍**：接受注入 Hook 路线（换取唯一可能全测的结论）及其封号风险，还是接受"微信先只有文本"（换取最干净的许可 + 最贴近阿里云的宿主）。
2. 选第 1 条时，先做**只读**可行性核查：3.9.x 客户端在当前是否还能安装并登录（腾讯可能强制升级/拒绝低版本登录），再决定要不要开同等级只接收 spike。
3. 选第 2 条时，先做**只读**核查：私聊入站 Beta 的开关、联系人映射与界面校准能否在无 GUI 的云主机上完成（需要 VNC/窗口尺寸校准），再申请本人授权登录一次测试小号。
4. 两条都暂不接受时，微信维持 `unknown` 与"长期挂起"，精力回到 QQ 的三项升级（已批准表情发送、本人/系统回显区分、AC23）。
