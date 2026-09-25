# 微信发送可行性：离线门禁

日期：2026-09-25。只读检查本机 `WeChatWin.dll` 3.9.11.25，SHA-256 `2058A926258BAEAECF92B30668FF200382F4493B0A5323428781D0B993E19C51`；没有调用微信发送接口，也没有向任何人发送消息。

## 已确认

- 当前移植的 wxhelper DLL 只校准了接收和登录检查两个偏移。上游 `kSendTextMsg=0x22c2010` 落在函数体中部，起始指令为 `movaps [rax-0x48],xmm6`，不是可调用入口；`kGetSendMessageMgr=0x1b4f500` 和 `kFreeChatMsg=0x1b50d80` 也不是可靠入口。三者都不得在本机客户端上调用。
- 源码 `WeChatService::SendTextMsg` 调用内部 `send` 后，把返回值存入 `success`，随后固定 `return 0`。HTTP `/api/sendTextMsg` 因而可能报告 `code:0`，即使内部结果不是成功；该响应不能作为受理回执。
- 二进制包含 `SendMessageMgr::sendTextMsg` 字符串，但现有只读定位器没有找到对该字符串的直接引用；用其它函数的版本差值推测入口缺乏足够依据。本轮不填猜测偏移。

## 工程准备

新增独立的 `wxhelper-send-port.mts` 候选端口，只用于注入的假传输测试。它核对账号、授权对象、真人确认前置检查、方案时限和纯文本长度；一次提交后无论 HTTP 报什么，都返回 `RESULT_UNKNOWN`，不自动重试。正式微信桥接仍只接收，未导入该端口，也没有发送 worker。

本机单元测试通过；隔离 PostgreSQL 真实事务测试也通过：两段文字经 02 确认后，假接口第 1 段返回 `code:0`，发送账本仍记 `RESULT_UNKNOWN`，第 2 段在发送前取消，联系人因 `UNKNOWN_SEND` 暂停；假接口只收到 1 次调用。这个结果证明本地门禁行为，不代表微信平台已经发送或受理。

完整本机门禁 `npm run verify` 通过：216 unit、9 contract、28 PostgreSQL integration、13 E2E，加网页构建，0 fail、0 skip；日志私留 `.local-wechat-spike/verify-send-offline-20260925.log`。

## 下一门槛

1. 在同一 SHA-256 的离线二进制上，分别确认发送、管理器获取和消息释放的真实函数入口与调用约定，并修正 wxhelper 固定返回 0 的问题，重建后只用假接口核对响应语义。
2. 补齐真实平台回执语义后，用隔离 PostgreSQL 和假传输复测受理与失败分支；当前未知结果暂停分支已通过。
3. 以上通过后，再明确一次真实测试的收件人、原文和次数，由本人逐条授权；出现未知结果立即停止并人工核对。

当前结论：**离线发送门禁未通过，真实微信出站继续关闭**。
