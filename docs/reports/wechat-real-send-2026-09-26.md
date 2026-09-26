# 微信主链真机跑通记录（2026-09-26）

## 结论

确认模式主线在**真实微信账号**上走通了一次：知情测试好友发来真实消息 → 桥接接收 → 生成候选 → 本人在手机宽度页面点「确认并发送」 → **桥接**通过真 helper 提交 → 结果记 `RESULT_UNKNOWN`、联系人暂停 → 本人核对好友已收到。核心进程全程没有派发。

这是本机测试小号对知情测试好友的一次受控发送，**不是**平台能力验收：回执仍只到「结果未知 + 人工核对」，没有平台消息 ID，候选内容仍来自 04 的持久 fake。

## 环境与准备

| 项 | 值 |
| --- | --- |
| 客户端 | `WeChat.exe` 3.9.11.25（`WeChatWin.dll` SHA-256 `2058A926…`），测试小号登录，单进程 |
| 移植 DLL | SHA-256 `9F1A96D9…`（接收偏移 + 三个发送入口 + `code:2 result_unknown` 包装） |
| 注入 | `injector.exe -I <pid> -p <dll>`；注入后 `checkLogin` 返回 `code:1`、`hookSyncMsg` 返回 `code:0`，微信未崩 |
| helper | `127.0.0.1:19088` 在微信进程内监听；`config.ini` 的 `RecvHttpUrl` 指向 `127.0.0.1:19099/wxhelper/event?token=…`（由本人在管理员会话中修改，令牌不入库） |
| 桥接 | `apps/bridge/wechat-main.mts`，`WECHAT_ENABLE_OUTBOUND=1`，`/healthz` 报 `receive-and-dispatch` |
| 核心 | `apps/core/main.mts` 8787，`/readyz` 四项 ok，启动即暂停已确认 |
| 数据 | 本机隔离 PostgreSQL 17.11（loopback），全新库 + `wechat-spike-enroll.mts` 登记的知情测试好友 |

本机 fixture 端点在注入前已停止，19088 交给真 helper。

## 逐步骤证据

| 步骤 | 证据 |
| --- | --- |
| 真实入站 | 知情测试好友发来 3 条「你在干嘛呢」（22:31:53 / 22:36:12 / 22:37:38）；`platform_inbox_raw` 由 7 增至 12，`data_messages` 相应增加，桥接 stderr 多次 `ingress-inserted` |
| 候选生成 | 待办 `01a0de26-7a18-7a27-a65b-8addf1ddbfd6`，`plan=AWAITING_CONFIRMATION`，3 个候选（1/2/1 分条） |
| 本人确认 | 本人在网页点「确认并发送」（方案 3，内容「谢谢你告诉我，我想先听听你的想法。」） |
| 派发在桥接 | 发送任务 `01a0de28-0065-7c37-9e75-b2b0df9cdca4`；`dispatch_attempts` 记录 `status=RESULT_UNKNOWN`；桥接 stderr `send-RESULT_UNKNOWN`；核心日志只有 HTTP 路由，无发送动作 |
| 未知即暂停 | 会话 `PAUSED_UNKNOWN_SEND`，`pause_reasons={UNKNOWN_SEND}`，`dispatch_control.unresolved_send_key` 被占用 |
| 人工核对 | 本人确认测试好友已收到该条消息 |

## 过程中发现的三个问题

1. **网页缺少「核对结果」入口（已修）**。`POST /api/v1/sends/:id/resolve` 早就存在，但 06 只有一句「核对前不要重复发送」的警告，没有任何记录结果的按钮——主线的最后一公里只能靠脚本。本次已补：未知结果那条下面出现「核对证据」输入 + 「记已送达」「记明确失败」，`expectedVersion` 取自投影，记录结果与恢复联系人仍然是两个独立动作。
2. **未核对的未知结果会挡住恢复（设计正确，但当时把我自己挡住了）**。演练时我点过一次「确认并发送」，那条发给的是本机 fixture，事后没核对，于是 `unresolved_send_key` 一直占着：恢复联系人返回 503 `SEND_RESULT_UNKNOWN`，页面刷新后又因版本变化返回 409。处置：把那条按事实记为 `FAILED_DEFINITE`（证据「本机 fixture，未提交平台」）后恢复成功。这说明这道门真的生效，不是文档承诺。
3. **暂停期间的来信只记录、不生成方案，恢复后也不会补做**。好友那条消息在暂停期间到达，只进了 `data_messages`；恢复后必须再有新消息才会生成候选。这是既定语义（旧方案失效、重新判断），但真实体验上容易让人以为消息丢了。建议在 D03 一起决定是否要在恢复时对「最后一条未回复的来信」显式提示。

另外记录一个操作细节：`injector.exe` 的 `-p` 才是注入文件路径，`-d` 是卸载时用的文件名；用 `-d` 传路径会静默什么都不做（exit 0、无输出）。

## 边界与未完成

- 回执仍为未知：没有平台消息 ID，`RESULT_UNKNOWN` 的解除完全依赖本人人工核对；这不是平台送达证据。
- 发送内容仍是 04 的持久 fake 产物（本次是占位文本），真实模型待 D06。
- 微信客户端每次更新都要重做偏移移植；本次未验证其他 80 余个接口。
- AC 矩阵不变：42 行仍 `blocked`，微信 real 栏不因本次单条发送而通过；AC23（关机持续运行）仍未做。
