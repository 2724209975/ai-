# API v2：P1–P5 已实现接口

此处只列已实现接口。独立DecisionResult、模型配置和响应式手机任务界面已实现；完整会话列表/历史仍复用v1工作台接口，消息导入管理接口未实现。记忆接口沿用原服务POST命令风格及明确会话路径；RFC中尚未提供的PATCH/DELETE路径不视为已实现。

所有接口复用 Owner Cookie 会话；写操作还要求既有 Origin/CSRF 校验与 JSON 内容类型。Owner 身份来自服务端会话，不能在 body 中指定。未经认证401，权限403，参数无效400，版本/过期等业务冲突沿用既有409映射。

| 方法 | 路径 | 行为 |
| --- | --- | --- |
| GET | `/api/v2/conversations/:id/reply-jobs` | 当前 pipelineVersion、conversationVersion、contactId/factScopes授权、最新100个任务 |
| GET | `/api/v2/reply-jobs/:id` | 任务、来源ID、快照ID、候选与审批版本、发送状态 |
| GET | `/api/v2/reply-jobs/:id/trace` | 上述详情、状态迁移、脱敏模型调用计量和选择/编辑/真实送达反馈 |
| POST | `/api/v2/conversations/:id/pipeline` | 按会话启用2或回退1；只改变管线追踪、不授权自动发送 |
| POST | `/api/v2/reply-jobs/:id/approve` | 校验版本与最终内容，复用现有确认方法创建发送任务；响应不代表已发送 |
| POST | `/api/v2/reply-jobs/:id/cancel` | 取消未提交任务；发送中/受理/未知不能当作未发送取消 |
| POST | `/api/v2/reply-jobs/:id/regenerate` | 预期任务版本/会话修订+幂等键，创建新批次；禁止未决/已提交发送重试 |
| GET | `/api/v2/model-config` | Owner配置版本和可用模型元数据，无凭据或地址 |
| POST | `/api/v2/model-config` | expectedVersion（首次0）、idempotencyKey和完整config，改变路由/预算/隐私并使生成中和待审批任务过期 |
| GET | `/api/v2/model-usage` | 近30天实际token/错误/P50/P95、按币种的已知费用和未知项、按模型/版本/任务/提示/币种的models聚合、最近100次决策/生成调用 |

## 切换管线

```json
{"version":2,"expectedVersion":3,"idempotencyKey":"unique-command-key"}
```

expectedVersion 使用列表返回的 conversationVersion（不是 conversationRevision）。返回 resultVersion、correlationId、status=UPDATED。相同幂等键和相同内容返回原结果；不同内容不能复用该键。回退改 version=1。

## 审批

```json
{
  "taskVersion":1,
  "planVersion":1,
  "alternativeId":"returned-alternative-id",
  "editedParts":[{"type":"text","content":"用户确认的最终文字"}],
  "contentHash":"sha256-of-canonical-parts-json",
  "expectedConversationRevision":2,
  "idempotencyKey":"unique-approval-key"
}
```

版本与 alternativeId 使用 GET 返回值；hash 采用既有 contentHash：对每段 `{type,content}` 组成的数组 JSON 做 UTF-8 SHA256。支持已有 shownAlternativeIds 候选反馈字段。服务端不会信任模型提供的发送开关、会话版本或权限。成功返回 jobId、planId、resultVersion、status=SEND_QUEUED；重复批准返回同一审批结果，不创建第二套发送任务，之后应 GET 当前状态确认实际结果。

## 取消及任务字段

取消 body：`{"expectedVersion":5,"idempotencyKey":"unique-cancel-key"}`，版本来自任务 version。成功返回 CANCELLED/resultVersion/correlationId；同键重复返回原结果。

任务 schemaVersion=`2.0`，含 id、conversationId/contactId/accountId、status/reasonCode/version、conversationRevision/generation/policyVersion、triggerMessageIds、contextSnapshotId、traceId、planId、candidates、generatorVersion/promptVersion、planVersion、approvalTask、sends、createdAt/updatedAt。候选及 sends 暂复用原 Plan/Send DTO；这不是 RFC 最终 ContextPackage/DecisionResult 协议。

v1 接口保留。新版 OwnerPort 是可选扩展，未装配持久化 v2 服务时对应接口返回501；数据库生产装配 `pg-owner-port.mts` 已实现身份校验和上述转发。

## P2/P3：上下文、记忆和本人设置

| 方法 | 路径 | 行为 |
| --- | --- | --- |
| GET | `/api/v2/conversations/:id/context-preview` | 最近任务实际Context包；status=valid/stale/not_built，过期内容不返回 |
| GET | `/api/v2/conversations/:id/memories` | items（来源/版本/状态/修订链）、relationship、personalStyle、controls |
| POST | `/api/v2/conversations/:id/memories` | memory + idempotencyKey；本人新建已确认或待确认记忆 |
| POST | `/api/v2/conversations/:id/memories/:memoryId/confirm` | expectedVersion + idempotencyKey；仅明确来源待确认项 |
| POST | `/api/v2/conversations/:id/memories/:memoryId/correct` | expectedVersion + content + object + 可选validUntil + idempotencyKey |
| POST | `/api/v2/conversations/:id/memories/:memoryId/expire` | expectedVersion + idempotencyKey，退出检索 |
| POST | `/api/v2/conversations/:id/memories/:memoryId/delete` | expectedVersion + idempotencyKey，清正文/证据/向量/缓存，保留幂等墓碑 |
| POST | `/api/v2/conversations/:id/relationship` | expectedVersion + stage + locked + 可选sourceRefs + idempotencyKey |
| POST | `/api/v2/conversations/:id/style` | expectedVersion + settings + locked + global + idempotencyKey |
| POST | `/api/v2/conversations/:id/memory-controls` | expectedVersion + enabled + styleSamples + retentionDays + idempotencyKey |

设置首次创建expectedVersion=0，之后以GET版本为准。settings允许tone/length/emoji/punctuation/addressing/avoid字符串；联系人设置覆盖全局设置。未知顶层字段、body中的Owner身份或发送开关均拒绝。

memory字段：memoryType、subject、predicate、object、content、evidenceType、evidenceRefs（`[{id,version}]`）、confidence、importance，以及可选validFrom/validUntil/conflictKey/locked。详见 [记忆契约](memory-engine-v2.md)。UI入口为聊天设置中的“聊天记忆”：v2开关、确认/纠正/失效/删除、关系修订/锁定、表达偏好、记忆/采样开关和Context检查。

## P4/P5 路由与界面

任务详情增加decision、route、quality；candidates继续使用旧Plan的parts结构，quality中的candidateKey/style对应生成顺序natural/playful/direct。approve响应只证明创建了同一发送账本中的任务，手机/电脑都必须等待真实回执。编辑后的文本重新质量校验。regenerate只创建新回复任务，不复用未知发送的sendKey。模型注册/配置字段和价格定义见 [决策与生成](decision-generation-v2.md)。

P6的model-usage响应新增models数组，聚合不受最近100次明细限制；未知token/费用仍为null，usageKnownCalls与unknownCostCalls分别计数。无新增发送权限或自动灰度接口。
