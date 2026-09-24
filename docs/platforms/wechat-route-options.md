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
