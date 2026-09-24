# 微信路线候选事实与决策包

日期：2026-09-24。方式：GitHub API 与许可文件的**只读**核查；未安装、未下载运行、未登录、未发送。这是 G2 微信半场的决策输入，不是能力结论；能力状态见 [platform-wechat-capability-snapshot-2026-09-24.json](../reports/platform-wechat-capability-snapshot-2026-09-24.json)（六个能力族全为 `unknown`）。

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

### 复用结论

**没有可以直接拿来当"微信接入"的成品**，但有两条明确的**代码复用路线**，优先级高于自己从零写：

1. **OneBot v11 兼容桥（首选）**：Akasha-WeChat、smrwang 虚拟网关、jessiongod 桥都声称 OneBot v11。若属实，本项目只需增加一个微信平台配置与消息段映射，`packages/platform/qq` 的整套实现（事件解码、wire→公共事件归一化、签名/鉴权入口、出站传输）以及 02/03/04/06 全部复用——这是投入产出最高的路线。其中 smrwang 用**官方微信 Linux 客户端**（账号形态最接近目标），但入站仍属 Beta；Akasha 入站是设计目标但**无许可**。
2. **Windows Hook + HTTP（次选）**：wxhelper（MIT、3.1k★）已提供 HTTP 接口，我们只需写一个微信平台适配器；代价是版本强耦合、注入式，且 README 声明仅限学习研究。

**不建议先做**：RPA/UI 自动化路线（wxauto 等）——它拿不到稳定消息 ID 与回执，会与已确认的"未知结果先核对、不盲目重发"冲突。

**先行条件（与 QQ 同等级）**：① 许可确认（Akasha / WeChatPadPro / aixed / TonyChen 均**无许可**，wxhelper 有用途声明）；② 常在线宿主（官方 Linux 客户端需 Linux+X11，Hook 路线需常开 Windows）；③ 本人手发与系统回显是否有可区分信号——这一点在所有候选中都未验证，缺它就不能开自动发送。

**建议的最小下一步**：先对 smrwang 虚拟网关做一次**只读**评估（Docker 内跑官方 Linux 客户端 + 入站 Beta），确认它到底能不能承载"本人现有账号 + 既有好友会话"；若不能，再看 Akasha-WeChat 并要求作者澄清许可。两条都失败时，微信维持"长期挂起"，把精力放在 QQ 的 GO_CONFIRM_ONLY 三项缺口上。