# 06 → 架构总控：G2/G3 管理端状态投影提案

日期：2026-09-24。状态：Proposed。基线为 contracts.md v0.3.0、01 PlatformAccount / RecoveryReport / PlatformSelfMessageUnattributed 语义，以及 02 已有 Owner overview、tasks、conversations。提案只增加受控查询字段，不赋予前端发送或恢复权限。

## 问题与最小响应

当前 02 ownerOverview() 固定返回 connections:[]、faults:[]。空数组不能证明“已连接”或“无故障”，尤其 01 的真实账号能力和恢复还未接入。建议保留 GET /api/v1/overview，在投影中增加可选的 connectionQueryStatus、faultQueryStatus（ready/unavailable）。字段缺失按 unavailable 处理。只有 ready 且数组为空时，页面才能显示“当前查询范围内无记录”；unavailable 需展示“无法判断”，服务失败仍用 503 错误，不用空数组降级。

connections[] 每项建议包含 accountId、platform、connectionState、capabilitySnapshotId、verificationStatus、lastReconciledAt、limitations[]，以及 recovery:{status,historyComplete,gaps[],unresolvedSendCount}。06 目前 UI 临时兼容 id/state 别名，正式 schema 由总控统一。unresolvedSendCount 只可取 RecoveryReport.unresolvedSends 的受控聚合；connectionState 和恢复 status 需保持不同含义。historyComplete 只能取 01 的真实 RecoveryReport 证据；没有连续覆盖证据时为 false。状态来源为 01 的版本化账号/能力/恢复投影，经 Owner API 裁剪；不能从 mock adapter 的 CONNECTED 或网页请求成功推断真实微信/QQ 可用。

GET /api/v1/conversations 的 messages[] 建议在 actor=unknown 时可选带 originStatus、originEvidenceRefs、resolvedAt；Owner API 只返回可安全显示的证据引用，不返回原始凭据。02 已有 OWNER_ORIGIN 暂停原因和 unknown actor，06 可先展示“来源未明，人工核对”，不得自判为本人或系统回显。PlatformOriginResolved 后更新投影但不自动解除暂停；恢复动作仍由后端 allowedActions 控制。

02 tasks.reasonCodes 已能返回 AUTO_REVIEW_UNAVAILABLE。06 将其显示为“自动模式暂未开放，本轮转人工确认”；不是自动发送成功。发送状态逐条来自 02 sends[]，RESULT_UNKNOWN 和 PARTIALLY_SENT 明示，SUBMITTED 只表示平台接受。

## 兼容与职责

新增字段均为可选；旧 consumer 可忽略。总控批准后先更新机器 schema、01/02 provider 与契约测试，再将 06 的临时类型换成正式类型。无需数据迁移；只读投影回滚时置 unavailable，不能用空数组伪装成功。受影响 AC16/17/18/20/23 及 G2/G3 的故障与恢复可见性。01 提供账号能力/恢复证据，02 提供可操作状态和来源暂停，03 提供受控证据读取，07 负责鉴权和端到端故障注入，06 只展示。

/skills、/imports、/faults 目前无持久 provider，继续返回 501 NOT_IMPLEMENTED；不得标注为无记录。01 的真实微信/QQ 验收与关机运行仍需单独平台证据。
