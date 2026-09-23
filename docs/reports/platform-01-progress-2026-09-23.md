# 01 续作：受控 QQ 发送执行器与 HTTP 传输

基线 contracts v0.1.0；当前未出现公共 schema/基础设施及 02/03 实现。未修改公共约定、根依赖或其他模块。上轮文件已保留，补齐 verification.md 中因中断未记录的 53 项测试结果。

## 新增

`packages/platform/qq/send-executor.mts` 与测试：将授权租约、提交意图、一次传输与回执记录串联，全部依赖注入；没有账号登录或数据库实现。HTTP 网络传输代码见下文，尚未连接真实桥接。

依赖顺序：持有正确 authority 的 02 → withDispatchLease（业务 preflight）→ journal.claim（原子持久提交意图）→ transport.submitOnce → journal.finish（单调记录回执）。每次等待后需要的业务状态一致性由 02 的有效租约覆盖；测试 gate 不是生产锁。

claim 必须同时约束账号、会话、sendKey、sendTaskId、内容指纹和未决发送；不能只凭键存在与否判断。生产实现需在同一事务完成，未提供前只测试内存替身。

传输超时/异常后 RESULT_UNKNOWN，不重复发送、不换键；晚到回包暂不自动升级，需 reconcile。只有执行器能证明尚未调用传输的过期请求才报告明确未提交失败。平台已返回成功但 finish 失败，返回实际证据并标 recorded=false，业务必须修复记录/暂停；不能把存储错误当平台失败。

发送内容限定为文字或绑定素材 ID/批准版本/字节摘要的表情。执行器复核内联 bytes 与摘要，批准的新鲜度与目标平台由可信 02 gate 负责；不允许绕过准备步骤发送普通图片、语音或任意平台指令。

## 测试

```powershell
node --test packages/platform/mock/adapter.test.mts packages/platform/qq/onebot-codec.test.mts packages/platform/qq/webhook-ingress.test.mts packages/platform/qq/send-executor.test.mts packages/platform/qq/onebot-http-transport.test.mts
```

发送执行器阶段为 **65 pass / 0 fail / 0 skipped**。新增 12 项：提交顺序、并发防重、超时未知/换键拒绝、提交后异常、身份/账号/权限拒绝、账本失败阻止提交、回执写失败保留证据、过期/其他 action 拒绝、同键改内容、调用者突变隔离、未支持消息拒绝、表情字节绑定。未执行静态类型检查、真实 PostgreSQL、真实 02、真实 QQ/微信测试。

## 同日续作：OneBot HTTP 发送传输

新增 `packages/platform/qq/onebot-http-transport.mts` 与 4 项测试，并为协议解析补 1 项 HTTP 回包关联测试。根据 OneBot 11 HTTP 规范，请求采用 `POST /send_private_msg`、JSON 参数与 Bearer token；HTTP 回包可能不带 WebSocket `echo`，由可信 HTTP 请求/响应配对关联，若回包自带矛盾 `echo` 则保持未知。禁止重定向及传输层自动重试，限制回包大小；非 200、错误内容、网络异常均不推断平台一定未发。合成回包已贯通受控执行器到回执记录。

HTTP 阶段离线测试为 **70 pass / 0 fail / 0 skipped**。尚无真实桥接、登录、发送、tsc 或 PostgreSQL 验证。来源：[OneBot HTTP](https://github.com/botuniverse/onebot-11/blob/master/communication/http.md)、[鉴权](https://github.com/botuniverse/onebot-11/blob/master/communication/authorization.md)。

## 同日续作：媒体与自身消息来源

新增 `media-acquisition.mts` 与 6 项测试：只按已认证原事件指针、经授权门控读取媒体，并交 03 私有存储端口；记录摘要、字节数和文件头 MIME。桥接声称 `original` 仍保持完整性 unknown；缩略图、单帧、转码明确 partial；缺失、越限和存储失败为 unavailable。没有实际桥接媒体读取实现。OneBot `get_image`/`get_record` 返回桥接本地路径或转码结果，跨进程原件可读性需另验。[OneBot 公开 API](https://github.com/botuniverse/onebot-11/blob/master/api/public.md)

新增 `self-origin.mts` 与 5 项测试：自身消息只有通过持久账本的精确平台 ID 关联才视为 agent 回显；owner 需要独立经验证的桥接来源端口，当前无真实实现；其余保持 unknown。因公共契约缺少 unknown 自身消息专门事件，已写 [变更提案](../platforms/contract-proposals.md)，未修改公共约定。

媒体与来源分类阶段离线测试为 **81 pass / 0 fail / 0 skipped**。本人要求服务器核查延后；未进行安装、登录、付费或真实消息发送。

## 同日续作：恢复证据评估

新增 `recovery-assessment.mts` 与 6 项测试。纯函数检查账号身份、历史对持久游标的连续覆盖、需重登状态和未决发送证据；断线前 PRE_SUBMIT 任务列为失效，SUBMITTING/RESULT_UNKNOWN 只凭明确平台 ID 或确定未发证据解除未知。缺口不推进游标；单会话未知不冻结其他会话的重新 preflight；任何恢复都不自动补发旧回复。实际查询、持续游标和事务持久化仍待桥接/03/02 集成。NapCat 维护者列出 [私聊历史 API](https://napneko.github.io/develop/api)，但不能由接口列表推出无漏补齐能力。

00 需要决定的恢复报告字段已加入 [契约提案](../platforms/contract-proposals.md)，未改公共 schema。完整离线测试现为 **87 pass / 0 fail / 0 skipped**。

## 剩余依赖与行动

- 00/03：决定 unknown 自身消息事件提案，并提供正式 contract types 与持久账本、事件事务及私有媒体存储端口。内部实现接口只在 platform 中使用，正式发布前按公共 schema 统一。
- 02：实现 withDispatchLease，绑定最新会话/policy/暂停/素材版本；处理 recorded=false 与未知发送；不向 04/05/06 暴露执行器。
- QQ：选择并授权桥接组件，固定客户端版本、许可和登录流程，将候选 HTTP 传输接到真实桥接并提供原媒体获取，然后实测。
- 微信：仍缺符合本人已有好友会话的验证路径，不能拿 Bot 替代。
- 本人：已确认阿里云服务器，但要求先推进其他事项、服务器最后核查。当前无需提交服务器资料，也不需要把密钥或密码发到任务里。

电脑关机后持续收发仍未验证；阶段 C 尚未开始。本轮无安装、付费、登录或真实消息发送。
