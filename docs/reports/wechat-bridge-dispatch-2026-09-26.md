# 微信出站接入 bridge + 主线本机演练（2026-09-26）

## 范围

按本人确认的主线（确认模式闭环：真实入站 → 上下文 → 1–3 候选 → 手机确认/编辑 → 逐条发送 → 回执）执行第 1、2 步：

1. 把已经离线验证过的微信发送端口正式接进 `apps/bridge`，使微信桥接在显式开启后能派发；
2. 把「核心 + 微信桥接 + 手机网页」三个进程按真实形态一起跑起来，走完一次主线。

**没有**做：真实微信发送（需要逐条授权，且要已登录的测试号进程）、真实模型（D06）、生产部署与反代。本次的 helper 端点与入站消息都是本机合成，不构成任何平台能力证据。

## 变更文件

| 文件 | 作用 |
| --- | --- |
| `apps/bridge/run-mode.mts` | 抽出共用实现，新增 `resolveWxBridgeRunMode`（读 `WECHAT_ENABLE_OUTBOUND`）；QQ 行为不变 |
| `apps/bridge/wechat-bridge.mts` | 新增 `dispatch` 选项与派发 worker；`intelligence` 可选注入（真实模型将来从这里进）；`/healthz` 报 `mode`/`worker` |
| `apps/bridge/wechat-main.mts` | 按运行模式装配：`WECHAT_ENABLE_OUTBOUND=1` 时要求 `WECHAT_WXHELPER_BASE_URL` 并创建 loopback 传输 |
| `apps/web/server/owner-http.mts` | **缺陷修复**：全局暂停版本单独校验，接受 0（见下） |
| `scripts/wxhelper-fixture-endpoint.mts` | 本机 fixture：只答 `/api/sendTextMsg` 与 `/healthz`，不接触微信、不声称送达、不记录收件人与正文 |
| `scripts/mainline-rehearsal.mts` | 走完主线的可复现脚本（登录 → 恢复 → 合成入站 → 等待候选 → 确认 → 观察派发 → 核对未知 → 恢复联系人） |
| `tests/integration/postgres-wechat-bridge-dispatch.test.mts` | 真实 PostgreSQL：只有配置传输才派发、code 0 仍记 `RESULT_UNKNOWN`、余下分条取消、不重试、无传输时无 worker |
| `tests/integration/postgres-core-runtime.test.mts` | 新增「全新库以 epoch 0 经 HTTP 恢复」用例 |
| `packages/platform/wechat/wx-bridge-run-mode.test.mts` | 微信出站开关的单元测试（默认只接收；无传输却开 worker 直接拒绝） |

## 出站开关与安全性质

- 默认仍然**只接收**：不设 `WECHAT_ENABLE_OUTBOUND=1` 就没有传输、没有 worker，`createWxBridge` 返回的 `worker` 为 `undefined`，`/healthz` 报 `receive-only`。
- 开启后，桥接只提交 02 已经确认、加租约、逐条 preflight 通过的分条；传输固定 `127.0.0.1:19088`，进程不持有微信凭据、不直连腾讯。
- 无论 helper 回什么（包括 `code:0`），一次提交一律记 `RESULT_UNKNOWN` 并暂停该联系人；不重试、不换 `sendKey`。
- 健康检查会如实报告 `mode: receive-and-dispatch`，所以「只接收的观察桥」不能冒充带派发的桥。

## 运行中发现并修复的缺陷

**全新部署无法通过 API 恢复。** 新迁移的库 `dispatch_global_control` 是 `paused=true, pause_epoch=0`，但 06 的 HTTP 版本校验要求 `expectedVersion > 0`，所以第一次「恢复全部代理」返回 400 `VALIDATION_FAILED`——恰好只在新环境第一次使用时发生。

修复：`pauseAll`/`resumeAll` 改用只接受非负整数的暂停版本校验（`isPauseEpoch`），其它资源版本仍然必须为正。新增真实 PostgreSQL 用例：全新库登录后以 `expectedVersion: 0` 恢复成功并变为 `ACTIVE`。

## 命令与证据

环境：Windows、Node 24.15.0、隔离 PostgreSQL 17.11（`127.0.0.1:55418`，仅 loopback）、Chromium 390×844。数据来自**全新库** `chat_agent_main`：迁移 `0001`–`0009` → `scripts/wechat-spike-enroll.mts` 登记知情测试好友（wxid 不落文档）→ 启动 fixture 端点（19088）→ 启动微信桥接（19099，`WECHAT_ENABLE_OUTBOUND=1`）→ 启动核心（8787）。

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 单元 | `npm run test:unit` | 238 pass（含微信出站开关 4 项、派发开关 3 项、日志/健康 15 项） |
| 契约 | `npm run test:contracts` | 10 pass（含「核心不得触达平台适配器/派发/发送」） |
| 真实数据库 | `npm run test:integration` | 31 pass（含微信桥接派发、核心运行时、epoch 0 恢复） |
| E2E 与构建 | `RUN_BROWSER_E2E=1 npm run verify` | 22 pass，网页构建通过；总计 **0 fail / 0 skip** |
| 主线演练 | `node scripts/mainline-rehearsal.mts` | 见下 |

主线演练逐步骤输出（脚本 stdout，已脱敏）：

```
logged_in            csrfPresent=true sessionCookiePresent=true
resumed              status=ACTIVE                     ← 新库 epoch 0 恢复，修复前为 400
inbound_pushed       200                              ← 合成 wxhelper 推送，走真实接收链路
candidate_ready      AWAITING_CONFIRMATION allowedActions=[confirmPlan,rejectPlan] alternatives=3
confirmed            status=SCHEDULED
send_observed        RESULT_UNKNOWN receiptLevel=unknown platformMessageId=null pauseReasons=[UNKNOWN_SEND]
unknown_resolved     status=DELIVERED evidence=operator-check
mainline_complete    contactStatus=READY_CONFIRM pauseReasons=[] sends=1
```

配套证据：

- fixture 端点只记录「有一次提交 + 字节数 + 摘要」，不含收件人与正文（见脚本注释与实现）；两轮演练各 1 次提交，**同一次确认没有第二次提交**。
- 桥接 stderr：`ingress-inserted`、`send-RESULT_UNKNOWN`——派发发生在桥接进程，不在核心。
- 核心日志为单行 JSON，路由已折叠为 `/api/v1/sends/:id/resolve`、`/api/v1/contacts/:id/resumeContact`，不含正文与口令。
- 手机宽度（390×844）界面证据：`apps/web/evidence/mainline-tasks-390.png`（待办与三个候选）与 `apps/web/evidence/mainline-conversation-390.png`（未知发送暂停态）。截图里只有合成入站文本与 fake 候选，无真实聊天内容。

第二张界面证据来自真实点击：脚本在 390px 页面点「确认并发送」，随后会话页显示「未知发送，已暂停（UNKNOWN_SEND）」与两条发送记录（一条 `unknown`、一条此前人工核对后的 `delivered`）。

## 未完成与边界

- **真实发送仍未执行**：本次 helper 端点是本机 fixture，没有向任何人发出消息。真实出站需要测试号登录 + 已移植 DLL + 本人逐条授权（收件人/原文/次数），并接受「首条必然 `RESULT_UNKNOWN`、人工核对后才恢复」的既有约束。
- **真实模型未接**（D06）：候选仍是 04 的持久 fake。桥接已留出 `intelligence` 注入点，选定模型后可从这里接入。
- **回显与回执**：微信本人回显、平台消息 ID、`accepted` 级回执都还没有真实样本；未知结果处理路径本次已在合成链路上走通。
- **06 平台标签**：仍来自进程配置（[A23](../decisions.md) 提案）。
- AC 矩阵不变：42 行仍为 `blocked`，微信/QQ real 栏仍未通过；本次是工程与流程证据，不是平台验收证据。
