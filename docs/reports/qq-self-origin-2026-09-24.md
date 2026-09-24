# QQ 本人消息来源专项：首个真实样本

日期：2026-09-24。范围为本机非主力个人 QQ 测试号与此前的知情测试好友。本人在原 QQ 客户端手发一条不含私人信息的文字；本项目的 QQ 出站及 worker 均关闭。此记录不包含账号号码、聊天正文、平台消息 ID、文件名、token 或裸摘要。原始字节仅在 gitignored 私有目录中。

## 准备与门禁

- 在全新隔离 PostgreSQL 17.11 UTF8 测试库中应用全局迁移 `0001`–`0009`，仅登记该知情好友；QQ 接收桥接只监听本机 `127.0.0.1:8788`，出站和 worker 均关闭。
- `npm run spike:preflight` 使用一次性 schema 与合成消息检查真实入口进程：错误 token 被拒、正确事件接纳、重复投递幂等、原始证据仅存一次、无发送、outbox 消费完成，全部通过。
- 本轮完整本机 `npm run verify`：209 unit、9 contract、26 PostgreSQL integration、13 E2E 与网页构建通过，0 fail/skip。它包含新增的去敏 ID 相等关系诊断测试；真实平台结论仍以本专项样本为准。

## 真实观察

接收端获得 **1 条** `message_sent/private/friend` 事件，签名入口返回 204；其字段含 `self_id`、`user_id`、`target_id`、`sender.user_id` 与平台消息 ID，正文为单个 text 段。只在私有环境比较字段：`user_id = self_id`、`sender.user_id = self_id`、`target_id != self_id`；`target_id` 与前次同账号、同知情好友的 9 条私聊入站事件的 `user_id` 相符。对外的 `spike:shape` 只输出字段名、固定枚举及相等/不同，不输出实际 ID 值。

数据库及原始文件的去敏汇总为：`unmapped_self=1`、私有原始文件 1 且无孤儿、待发布 outbox 0、发送任务 0；账号下会话增加 `OWNER_ORIGIN_UNMAPPED` 暂停原因。未创建联系人入站消息、回复方案或真实发送。接收桥接在采样后已停止，私有 NapCat 配置已恢复 `reportSelfMessage=false` 的原保存值。

## 判定与下一门槛

`message_sent` 的真实信号和该样本中的对端字段关系已观察到，但**来源能力仍为 unknown**。单条本人手发样本不能证明不同设备、联系人或版本下的映射恒定，也不能证明系统发送回显如何标记；消息内容、时间相近和 `message_sent_type` 均不作为本人身份凭据。正式 mapper 与 owner verifier 尚未接入，当前账号级暂停应保持待人工审查。

下一轮需在同一受控会话取得系统发送后的真实回显，并用发送账本的精确平台消息 ID 与账号/对端比对；再补手机手发、桌面手发、重复/重连样本及跨联系人负测。只有这些证据齐备、映射器经审核并通过故障注入，才可更新能力快照的 `owner_message_signal`。QQ 总结仍为 [CONDITIONAL](platform-qq-2026-09-24.md)，AC16 与 AC23 均未通过。
