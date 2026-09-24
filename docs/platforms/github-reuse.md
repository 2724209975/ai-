# GitHub 复用评审（01）

查证日期：2026-09-22。范围：公开仓库、维护者文档与部分源文件的只读检查；未安装、登录、购买、发送或读取客户端凭据。仓库自述不是本项目实测。分支链接可变，正式引入前必须固定 commit、审核依赖与保留许可。本次没有复制第三方实现代码。

## 推荐结论

优先复用协议与适配边界，保留本项目 02 的唯一发送入口。QQ 候选为独立桥接进程 + OneBot 适配；微信尚没有验证通过的本人已有联系人接入路径；2026-09-24 复查确认可匹配该场景的路线全部是非官方 Hook 或 UI 自动化，见 [wechat-route-options.md](wechat-route-options.md)。新发现的腾讯微信 Bot 项目必须纳入比较，但不能把 Bot 会话视为本人好友会话。不能直接采用上游自动回复示例或自动发送重试。

| 项目 | 可复用部分 | 与目标的差异和限制 | 许可/处理建议 |
| --- | --- | --- | --- |
| [Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin) | 扫码状态机、轮询游标、媒体处理、错误分类的参考 | Bot 身份与 context_token 会话；未找到读取本人完整好友会话/本人原客户端发送事件的证据 | [MIT](https://github.com/Tencent/openclaw-weixin/blob/main/LICENSE)。先参考设计，不接入产品发送链路 |
| [NapNeko/NapCatQQ](https://github.com/NapNeko/NapCatQQ) | 外部 QQ 桥接候选，OneBot 收发/媒体/状态接口 | 基于 NTQQ；实际登录、多端共存、原客户端自身消息和长期运行待实测 | [限制性许可证](https://github.com/NapNeko/NapCatQQ/blob/main/LICENSE)，含授权及非商业等限制；不是普通 MIT。不得直接搬代码，使用/分发范围也需核清 |
| [botuniverse/onebot-11](https://github.com/botuniverse/onebot-11) | 消息段、请求回包关联、私聊 ID 和 API 边界 | 协议规范不是登录实现，不保证某桥接完整实现，不提供本项目业务授权 | 依据公开规范独立实现；复制规范/代码前另核对应许可 |
| [nonebot/adapter-onebot](https://github.com/nonebot/adapter-onebot) | 事件模型、消息解析、RPC 与测试组织可参考 | Python/NoneBot 宿主依赖，不适合直接替换当前 TypeScript 模块；不能保证底层 QQ 能力 | [MIT](https://github.com/nonebot/adapter-onebot/blob/master/LICENSE)，不为复用它另引全套宿主 |
| [wechaty/wechaty](https://github.com/wechaty/wechaty) | Puppet 抽象、多平台消息/联系人/媒体接口思路 | 能力取决于 Puppet；self() 只证明登录账号发送，不证明人工操作；返回消息标识也依赖提供方 | 本轮未独立核验所有 Puppet 的许可，不能把主框架许可传递给提供方；暂不引依赖 |
| [lich0821/WeChatFerry](https://github.com/lich0821/WeChatFerry) | Windows 微信桥接候选；项目列有收消息、语音、图片下载、文本及 GIF 发送 | Hook 路径、客户端版本耦合；需常开 Windows 环境，不能靠本机关闭后仍运行；不在当前授权下安装或执行 | [MIT](https://github.com/lich0821/WeChatFerry/blob/master/LICENSE)，源码许可不证明平台允许或账号稳定性；本轮只读评估 |
| [LagrangeDev/Lagrange.Core](https://github.com/LagrangeDev/Lagrange.Core) | QQ 协议桥接候选 | 当前 README 已为 V2，V1 sunset，Web 服务指向 Milky；旧 OneBot 教程不可当当前路径；涉及协议实现，不自行部署 | 当前许可未完整核验，保留备选，不引入 |

## 读源码得到的具体约束

1. [腾讯 send.ts](https://github.com/Tencent/openclaw-weixin/blob/main/src/messaging/send.ts)：返回的 `messageId` 是本地 clientId，`serverMessageId` 才是可选服务端 ID。不能把前者当平台回执。其多媒体说明文本与媒体可能拆成多次请求；本项目必须交由 02 每条复核，不能直接调用循环发送封装。
2. [腾讯协议说明](https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol_zh_CN.md)：明确区分客户端行为与服务端契约。出现 cursor、client_id 或成功 ret，并不证明完整补齐、服务端幂等或已送达。需要独立验证。
3. [OneBot WS](https://github.com/botuniverse/onebot-11/blob/master/communication/ws.md)：`echo` 是请求/响应关联字段，不是服务端防重复键。WS 断开后重发相同 echo 不能当防重机制。
4. [OneBot API](https://github.com/botuniverse/onebot-11/blob/master/api/public.md)：`send_private_msg` 返回 message_id；`get_msg` 按已知 ID 查询。发送超时且没有 ID 时，不能声称能够凭 taskId 查明结果。
5. [NapCat 事件](https://napneko.github.io/develop/event)列有 message_sent/private 和 friend_recall，但没有区分人工发送与系统发送的承诺；[配置](https://napneko.github.io/config/basic)的 reportSelfMessage 也不能单独证明跨端人工接管能力。

## 维护状态的证据边界

已打开上述仓库与部分 README/源码、腾讯提交页、WeChatFerry releases 页面。GitHub 页面部分提交/发布信息动态加载失败；本机 GitHub API 请求 TLS 失败，web API 请求也未返回。因此本次不报告无法核实的“最新发布时间”“最近提交 SHA”或稳定性评分。可见源码、Issue、提交数量和星数都不是长期可靠性验收。

2026-09-24 复查（GitHub API 可用后）：**WeChatFerry 已归档**（最后提交 2026-07-10、最后发布 v39.5.2），不再是在研候选；**openclaw-weixin 的许可当前为 `NOASSERTION`**，与上文 MIT 记录不符，需重核；Wechaty 的微信 puppet `wechaty/puppet-wechat` 最后提交停在 2022-07-14。微信候选的完整决策包见 [wechat-route-options.md](wechat-route-options.md)。当前明确的迁移信号是 Lagrange README 的 V1 sunset/V2/Milky；当前具体媒体和自身消息声明以 NapCat 维护者文档为准，但页面有较旧内容，正式试验需固定桥接、客户端和协议版本。

## 引入前的最小审查

- 00 确认接口后，只在 packages/platform 内增加协议转换，公共类型从统一契约导入；外部桥接由 07 部署。
- 安装前列出组件、固定版本/摘要、许可证、所需权限、持续在线设备、退出与撤销登录步骤，交本人完成必要配合。
- 桥接只开放内网认证端口；任何回调快速回复、上游自动回复插件、群管理/加好友/凭据查询 API 均不接到本模块。
- 不导入上游调度器。发送只来自 02 的有效任务，未知结果留待核对；重连只恢复接收，不能自动补发。
- 微信先验证会话身份范围；若仅能“我与 Bot 聊天”，立即判目标不符，停止继续包装成代聊接入。
