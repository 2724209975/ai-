# 微信与 QQ 接入可行性（阶段 A）

日期：2026-09-22；需求：PRD v1.3。结论：资料查证已开展，两个个人账号真实接入均未验证，AC23 均未通过；不能宣称当前已可代聊。

初查时 AGENTS.md、architecture/contracts/development-plan/decisions/tasks/01-platform 均不存在。随后工作区新增 requirements.md、README.md、architecture.md，已阅读并采用模块归属；其余公共文档以实际出现后的版本为准，不以 README 的链接当作文件已完成。未改公共约定。

交付前复查：contracts.md、development-plan.md、decisions.md、platform-validation.md、tasks/01-platform.md 均已生成并补读。最终代码位于约定的 packages/platform/；公共契约 v0.1.0 的未定字段以交接提案登记，未自行修改公共文档。

## 路线比较

| 路线 | 账号及会话 | 文档能力 | 持续运行/登录恢复 | 成本维护 | 建议 |
| --- | --- | --- | --- | --- | --- |
| 微信开放平台登录/分享、公众号、企业微信 | 分别是应用登录/分享、公众号或企业身份；不能推定本人好友聊天 | 本轮微信常规官方文档打不开，具体能力不得标官方已证实 | 即使服务器可用也不能弥补身份差异 | 资质、应用和部署成本需另查 | 无个人好友会话证据，不作为替代路径 |
| 腾讯 openclaw-weixin | Bot 账号、扫码用户、Bot 上下文 | 扫码、消息轮询和媒体的维护者实现；见 [复用评审](github-reuse.md) | 独立常在线网关是可行部署假设；session 失效需处理/重新确认；手机离线依赖待测 | 需网关主机和维护；未报价或购买 | 优先澄清身份边界，未证明能代表本人访问已有会话 |
| Wechaty + 明确 Puppet | 宣称个人微信；必须逐提供方确认已有好友 | SDK 有文字/媒体/self，Puppet 支持不一致 [W1] | 可能依赖常在线浏览器、设备、服务商或客户端；不能笼统称纯云 | 主机、提供方订阅、版本维护；未核实报价 | 候选调查，先拿提供方实名义的范围/能力和实测 |
| WeChatFerry/Windows 桥 | 登录 Windows 个人微信，Hook 实现 | 项目列有文本/GIF/媒体能力 [W2] | 独立常开 Windows + 客户端 + 桥；扫码/确认及客户端更新依赖待测 | 专用设备/云 Windows、客户端耦合维护 | 不在当前范围安装或实施 Hook；作为条件候选记录 |
| QQ 官方 Bot | QQ 用户与新建机器人聊天 | 官方明确为机器人 AppID/AppSecret，与本人 QQ 好友会话不同 [Q1] | Bot 可在常在线服务运行，但不满足当前身份目标 | 主机和平台准入维护 | 排除作为个人 QQ 替代 |
| QQ NTQQ + NapCat + OneBot | 登录个人 QQ；维护者列有好友私聊 | 文本、图片、语音、表情/引用和部分查询，均未实测 [Q2–Q5] | 常开宿主 + NTQQ/桥接 + 核心；二维码登录，失效重新确认 | 宿主、升级、客户端兼容、许可证核清 | QQ 优先验证候选，未批准安装，先保留协议边界 |
| Lagrange V2/Milky | QQ 协议实现候选 | 旧 V1 已 sunset；不能套用旧 OneBot 假设 [Q6] | 独立协议进程/会话；登录、限制与恢复待测 | .NET/桥服务及协议维护 | 次选，仅只读评估 |

## 关机运行结论

微信：未验证。QQ：未验证。把适配进程放在 C:\1\ai代聊 本机上，关机必然停止；仅云端模型可用没有意义。

架构上需要独立常在线的完整链路：平台客户端或登录服务 → 桥接/轮询 → 01 → 核心 worker/02 → 01 → 平台；媒体下载、持久数据和凭据会话也必须位于常在线端。Windows 候选需要独立 Windows 宿主，QQ NTQQ 候选需要可运行对应客户端/桥的宿主。是否仍需手机联网、多端是否互踢、重启是否免扫码均无本项目实测，不作承诺。

## 阻塞与交给 00 的决定

- 固定公共契约、平台代码目录、连接器配置/账本/事件持久化端口；适配层不另选数据库。
- 选择接受调查的个人账号路径；Bot 新会话若要采用须先变更产品范围，01 不自行替换。
- 确定常在线宿主、预算、数据保留与登录配合。许可证/安装权限未核清的组件不进入部署。
- 明确断线缺口、未知来源和无回执时的失败关闭策略；不能降级为空文本或伪装成功。
- 已写入模块交接文件的提案不等于已通知其他任务或被总控批准。

## 来源登记

全部为 2026-09-22 访问；日期是查证日期，不是发布时间。第三方维护者文档是声明证据，不是平台背书或本项目验证。

- W0 [微信分享官方入口](https://developers.weixin.qq.com/doc/oplatform/Mobile_App/Share_and_Favorites/Android.html)、[微信登录官方入口](https://developers.weixin.qq.com/doc/oplatform/Website_App/WeChat_Login/Wechat_Login.html)、[公众号消息入口](https://developers.weixin.qq.com/doc/offiaccount/Message_Management/Receiving_standard_messages.html)：web 打开失败，证据缺口。
- W1 [Wechaty Message](https://wechaty.js.org/docs/api/message) 与 [Puppet 入门](https://github.com/wechaty/getting-started/blob/main/README.md)：媒体/发送依赖实现，self 不代表人工。
- W2 [WeChatFerry](https://github.com/lich0821/WeChatFerry)；具体许可证与复用限制见 github-reuse.md。
- W3 [Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin)、[协议说明](https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol_zh_CN.md)：新发现的官方组织仓库，修正“没有任何微信 Bot 官方候选”的可能误读；依旧缺本人已有会话能力证据。
- Q1 [QQ 官方接入](https://bot.q.qq.com/wiki/develop/api-v2/)：QQ 用户与机器人单聊，独立机器人票据。
- Q2 [NapCat 启动](https://napneko.github.io/guide/boot/Shell)：仅供后续部署路线查阅，未执行安装。
- Q3 [请求接口](https://napneko.github.io/develop/api)：私聊发送、get_msg、媒体及状态接口列表。
- Q4 [上报事件](https://napneko.github.io/develop/event)：message_sent、friend_recall、心跳等；其他客户端在线变更列为不支持。
- Q5 [消息格式](https://napneko.github.io/develop/msg) 与 [基础配置](https://napneko.github.io/config/basic)：媒体消息段、reportSelfMessage。
- Q6 [Lagrange 当前 README](https://github.com/LagrangeDev/Lagrange.Core)：V2/Milky 与 V1 sunset。
