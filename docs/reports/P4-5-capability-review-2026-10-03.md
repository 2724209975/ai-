# P4-5 语音获取：只读源码复核

2026-10-03，总控在 P4-4a 衔接修复期间读取本机固定 helper 源码。没有启动、注入、替换或请求真实 helper，没有读取聊天数据库或语音内容。此次仅明确后续实现依据，不能算语音获取验收。

## 可确认的现状

本机源码树 `.local-wxhelper/wxhelper-src-391125` 的 Git HEAD 为 `36ecd7e349df6954393f75e30e38e89710d399aa`，含既有本机接收诊断修改。下述是当前文件内容结论，不假设 HEAD 等于实际驻留 DLL。

- `app/wxhelper/src/misc_controller.cc:80` 的 `GetVoiceByMsgId` 调用服务方法 `GetVoiceByDB`；`wechat_service.cc:1035` 的方法体只有 `return 0`。现有 HTTP 路径没有语音导出实现。
- `sync_msg_hook.cc:42` 仅在 `type == 3` 时读取 `param2 + 0x40` 的 `SKBuiltinBuffer` 并产生 `base64Img`。没有 `type == 34` 分支。此代码证明图片路径存在，**不能证明语音在同一地址上使用同一布局**，不能直接照抄该偏移读取语音。
- `wechat_db.cc:275` 有 `GetVoiceBuffByMsgId` 候选实现：查 `MediaMSG<n>.db` 中 `Media.Buf`，按 `Reserved0` 匹配消息 ID。但没有通过现有服务方法接出；而且检查 `result.size()==0` 后直接用 `result[1][0]`，行数为 1 或列为空时可能越界。数据库结构、返回值、二进制保真及实际客户端适配都尚未验证。
- `wxutils.cc:36` 的缓冲区读取依赖若干内存解引用，没有为语音来源提供独立长度上限和可读范围证据。模型或推测不能代替此验证。

用于复查的 SHA-256：

| 文件 | SHA-256 |
| --- | --- |
| sync_msg_hook.cc | 68E7580E94ABD5A661DFE092650B9DF7AA2A8488D29592BEAB47907F37561BAF |
| wechat_db.cc | 6C2EE55BF73B4B4FAF96004A5A86E69E0BD7B4225DF313D1489FFF5BAAFDD055 |
| wechat_service.cc | 7A6BE21772E701DF94CB16C8522203BE1258B47F47894CAB1E9430488DFB595C |

## 后续实现顺序

1. 在隔离副本里先验证数据库候选的空结果、行列界限、消息 ID 精度、最大字节数和错误脱敏；保留默认关闭，不直接改已登记 DLL。真实数据库表结构与语音字节证据仍须本人执行的只接收验收确认。
2. 收信 hook 方案须先获得 `type=34` 对应结构的独立证据；在此之前保留为备选，不声称“不需要新偏移”。
3. 确定实际语音容器后，再独立审定 silk 转码依赖和 ASR 兼容性。取得字节不代表当前语音 provider 能解码。
4. 新 helper 需独立构建记录、客户端/DLL 指纹和回退说明，随后按开发计划 §2.5 由本人完成平台操作。

结论：完成只读能力审查；语音获取实现、helper 构建与真机验收仍未完成。本轮先修复图片获取的 RLS、后补绑定失效和总时限；真实模型接线之前还需解决图片完整性验证。
