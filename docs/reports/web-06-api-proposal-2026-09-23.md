# 06 → 架构总控：Owner REST 接口提案

当前裁决（2026-09-23）：按 [A11](../decisions.md)只批准 G1 最小路由和通用资源/命令形状，见 `docs/contracts.md` v0.3.0 §3；下表其余 URL/JSON 仍为 06 提案，不是已交付后端。以下保留原始提案语境。

## 动机与共同规则

02 目前只有内存引擎 getConversation/listPending，没有 REST 路由、鉴权查询层、机器 schema 或持久发送账本。06 需要可操作查询投影。所有 ID 不透明，时间用 ISO 8601。列表响应为 {items:[...]}；故障不能伪装为空列表。可操作资源必须带 id,version,status,allowedActions[],reasonCodes?,invalidationReason?,correlationId?，allowedActions 由后端实时计算。命令返回 resultVersion,correlationId,status?；错误遵循公共 code,message,retryable,correlationId,details?。

## 查询响应

| GET /api/v1 路由 | 最小字段 |
| --- | --- |
| /overview | version,globalPaused,allowedActions,pendingCount,unknownSendCount,connections[{id,platform,state,limitations?}],faults[{id,status,summary}] |
| /contacts | items[{id,version,allowedActions,status,name,platform,agentEnabled,sendMode,goal,relationshipStatus?,stylePreference?,activeContactEnabled,activeConfessionEnabled,allowedWindows?,restrictions?,pauseReasons?,policyVersion}] |
| /conversations | items[{id,contactId,contactName,revision,generation,status,pauseReasons,allowedActions,version,messages[{id,actor,type,text?,at,mediaId?}],sends[]}] |
| /tasks | items[{id,taskId,taskVersion,planId,planVersion,contactId,contactName,conversationId,triggerMessages[{id,type,text?,at}],reasonCodes,requiredInputs?,alternatives[{alternativeId,strategySummary,parts[{replyPartId,sequence,type,content?,assetId?}]}],sends[],allowedActions,version,status,invalidationReason?}] |
| /facts | items[{id,version,status,allowedActions,content,scope,sourceKind,evidenceRefs?,updatedAt,expiresAt?,confirmed}] |
| /analyses | items[{id,contactId,contactName,version,status,allowedActions,analysisVersion,taxonomyVersion,cutoffAt,sampleRange,claims[{label,hypothesis,supportingEvidence[],counterEvidence[],alternativeExplanation?,uncertainty}]}] |
| /media | items[{id,contactId,kind,capturedAt,previewUrl?,recognition?,uncertainty?,source?,approvedPlatforms?,status,version,allowedActions}] |
| /skills | items[{id,name,source,skillVersion,purpose,enabledContactIds[],invocationReason?,invocationStatus?,status,version,allowedActions}] |
| /imports | items[{id,filename,phase,contactMappings?,dateRange?,messageCount?,anomalies?,duplicates?,status,version,allowedActions}] |
| /audit | items[{id,at,contactId?,action,decisionSummary,policyVersion?,planVersion?,sendStatus?,correlationId}] |
| /faults | items[{id,summary,affectedContactIds[],occurredAt,recoveryState?,correlationId,status,version,allowedActions}] |

sends[] 每条至少含 sendTaskId,sequence,status,receiptLevel?,platformMessageId?,lastError?,correlationId?。状态区分 CREATED/PREFLIGHT/LEASED/SUBMITTING/SUBMITTED/DELIVERED/FAILED_DEFINITE/REJECTED_PREFLIGHT/CANCELLED_PRE_SUBMIT/RESULT_UNKNOWN；任务或方案投影另表达 PARTIALLY_SENT/INVALIDATED。SUBMITTED 仅为平台接受，不是对方已读。媒体 previewUrl 仅允许同源短期鉴权 /api/v1/media/{id}/content，不能暴露原始存储 URL。

## 写命令

| POST /api/v1 路由 | 请求 |
| --- | --- |
| /tasks/{taskId}/confirm | taskVersion,planVersion,alternativeId,editedParts[{type,content}],contentHash,idempotencyKey |
| /tasks/{taskId}/reject | expectedVersion,idempotencyKey |
| /control/pause-all 和 /control/resume-all | expectedVersion,idempotencyKey |
| /contacts/{id}/pauseContact 和 /contacts/{id}/resumeContact | expectedVersion,idempotencyKey；恢复指定 reason |
| /contacts/{id}/updatePolicy | expectedVersion,policy:{goal,...},idempotencyKey |
| /facts/{id}/correctFact、confirmFact、deleteFact | expectedVersion,idempotencyKey；纠正带 content |
| /analyses/{id}/correctAnalysis | expectedVersion,correction,idempotencyKey |
| /media/{id}/correctRecognition、approveAsset、revokeAsset | expectedVersion,idempotencyKey；纠正带 recognition |
| /skills/{id}/trialSkill、disableSkill | expectedVersion,idempotencyKey；trial 强类型隔离且不发送 |
| /imports/{id}/commitImport | expectedVersion,idempotencyKey；须已有预览与身份/范围确认 |

后端重新计算权限、版本与发送前条件；前端按钮和哈希不是授权凭据。409 STALE_PLAN/CONFLICT_VERSION 后 06 刷新并提示旧版本未发送；重复幂等键不得创建新 sendKey。确认后保持暂停，恢复为独立命令（D03 临时安全默认）。命令 URL 命名仍待 provider 确认。

## 缺口、兼容与回滚

联系人加入名单和完整策略编辑、个人资料新事实/范围、会话本人回复与 Skill 临时指定、Skill 创建/编辑/导入/grant/试用夹具、导入上传/预览/身份映射、故障 reconcile、媒体字节鉴权和 07 同源登录/HTTPS/CSRF/Origin 校验仍无 provider。06 目前只有查询页面与上表部分命令入口，不能标为完成。

本提案不改变 02 状态语义，无数据迁移。总控确认后先发布机器 schema 与 provider，再切换 06 consumer；可选字段增加也测旧 consumer。若投影不稳定，06 回到只读错误状态并禁用命令，不能回退已提交发送事实。影响 AC03/15/17/18/20/27/31/32/35/37；01 提供连接与回执，02 状态命令，03 事实媒体证据导入，04 分析，05 Skill，07 身份与集成。
