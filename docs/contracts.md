# 公共契约 v0.3.0

本文件是跨模块语义的唯一文字定义；`packages/contracts` 提供首批机器可读类型与 JSON Schema。已落盘不等于各 provider 已切换；生产调用方必须逐步导入机器契约并通过契约测试。字段名、状态、错误和事件如需改变，必须按“兼容性与变更”流程执行，不能在专项任务内另立定义。

## 1. 通用约定

- 标识均为不可推断的 UUIDv7；外部平台标识只作为带平台命名空间的字段，不作内部主键。时间使用 UTC RFC 3339，显示时按联系人策略时区转换。
- 所有对象含 `id`、`createdAt`、`updatedAt`；可变业务对象另含单调递增 `version`。更新命令携带 `expectedVersion`，冲突返回 `CONFLICT_VERSION`。
- 所有事件含 `eventId`、`eventType`、`eventVersion`、`occurredAt`、`correlationId`、`causationId`、`aggregateId`、`aggregateVersion`、`payload`。消费者以 `(consumer,eventId)` 去重。
- `mode`：`live | import | trial | replay`。只有 `live` 可进入发送流程；其他模式在数据库和类型层拒绝创建发送任务。
- `actor`：`owner | contact | agent | system | platform | unknown`。`owner` 仅指有可靠证据的本人真实发言，`agent` 为本系统提交的发言；未关联的自身消息为 `unknown` 并暂停该联系人的自动处理，不能因没有发送账本就推断为 owner。
- 外部输入在边界进行 schema 校验；未知枚举不静默映射。敏感字段不进入日志。审计保存决策摘要和引用，不保存模型内部推理。
- 删除采用“正文清除 + 墓碑”：审计可保留 ID、动作、时间与散列，但不得保留已删除正文或让派生缓存继续可检索。备份物理清除周期待 D07。

## 2. 核心对象

| 对象 | 必需字段与约束 | 所有者 |
| --- | --- | --- |
| PlatformAccount | `platform, externalAccountRef, connectionState, capabilitySnapshotId, lastInboundAt, lastReconciledAt` | 01 |
| PlatformCapabilitySnapshot | `accountId, adapterVersion, observedAt, receiveTypes, sendTypes, receiptLevels, ownerMessageSignal, historySync, mediaFetch, constraints, verificationStatus, evidence[]`；每项 evidence 含 `capability,status,sourceRef,observedAt,adapterVersion,constraints,unavailableReason?`，status 为 `documented/tested/unsupported/unknown`；总体状态不能替代逐项证据 | 01 |
| Contact | `platformAccountId, externalContactRef, displayName, enrollmentStatus, conversationId`；唯一键 `(platformAccountId,externalContactRef)`，不按昵称合并 | 03 |
| ContactPolicy | `contactId, agentEnabled, sendMode, goal, activeContactEnabled, activeConfessionEnabled, allowedWindows, timezone, factScopes, restrictions, version`；新增默认确认模式、两个主动开关均 false | 02 |
| ConversationControl | `conversationId, state, pauseReasons[], revision, lastOwnerMessageId, lastInboundMessageId, unresolvedSendId, generation`；`generation` 每次影响上下文/权限的变更递增 | 02 |
| Message | `conversationId, platformMessageId, platformEventId, actor, type, contentRef, mediaId, quotedMessageId, sentAt, receivedAt, provenance, isAgentGenerated, mode, platformOrderKey?`；平台稳定顺序键有实测证据才填；未知时采用平台消息 ID/内部 ID 确定性回退，不把 event ID 字典序当平台时序保证；平台去重键由 capability 定义并存档 | 03，01 提交 |
| MediaAsset | `messageId, mediaType, storageRef, sha256, fetchStatus, completeness, interpretationStatus, platformMetadata, approvalStatus, approvalVersion, allowedPlatforms`；`completeness=complete/partial/unavailable/unknown`；私有访问 | 03 |
| MediaInterpretation | `mediaId, interpreterVersion, text, structuredMeaning, completeness, uncertainty, evidenceRefs, correctedByOwner, status` | 04 生成，03 存储 |
| Fact | `subject, scope, content, sourceCategory, evidenceRefs, validFrom, validUntil, confirmationStatus, deletionStatus, version`；scope 明确 global 或 contactId | 03 |
| ContextSnapshot | `conversationId, generation, cutoffMessageId/time, messageRefs, summaryRefs, factRefs, analysisRefs, policyVersion, hash`；不可变；对应 `ContextProjection` 为基于这些引用及当前联系人授权裁剪出的正文、有效事实与分析，携带每项 id/version/source/scope；消息保留原始 `type=unsupported`，媒体解释引用可选但缺失不得视为成功理解；解释引用含版本、完整度、画面/时序/转写覆盖、证据及本人纠正来源；不另行检索其他联系人 | 03 |
| AnalysisSnapshot | `contactId, analysisVersion, taxonomyVersion, cutoff, sampleRange, claims[], stageHypotheses[], trend, supportingEvidence, counterEvidence, uncertainty, corrections, status, dependencySet`；每条推测 claim 保留支持与反向证据、替代解释、不确定性；维度/阶段体系待 D10，`draft-1` 仅开发草案 | 04/03 |
| SkillDefinition | `skillId, name, source, version, purpose, applicability, requiredContext, rules, examples, outputContract, status, visibilityScope`；版本不可变 | 05 |
| ContactSkillGrant | `contactId, skillId, enabledVersionRange, version`；自动选择仅限有效 grant | 05 |
| SkillInvocation | `taskId, contactId, skillVersion, selectionMode, reason, inputRefs, output, status, fallbackReason, adopted` | 05 |
| ReplyDecision | `conversationId, contextSnapshotId, shouldReply, timing, strategy, riskCategories, requiredFacts, confirmationReasons, analysisRefs, skillInvocationRefs, generatorVersion`；`timing` 为 `now/wait/delay/no_reply`，delay 另带计划时间；风险和原因使用可扩展字符串代码并保留依据 | 04 |
| ReplyPlan | `conversationId, triggerMessageIds, contextSnapshotId, conversationGeneration, policyVersion, factVersions, analysisVersions, skillVersions, alternatives[], status, invalidationReasons, expiresAt`；04 只提案候选，可用局部临时 key；02 在持久化时统一分配 planId、alternativeId、replyPartId、版本与状态；每个 `Alternative={alternativeId,strategySummary,parts[]}`，每个 `ReplyPart={replyPartId,sequence,type,content?,mediaAssetId?}`，type 仅 `text/approved_sticker`，parts 为 1..N 且 sequence 唯一连续 | 02 持久化，04 提案 |
| ConfirmationTask | `planId, activeAlternativeIds, reasonCodes, requiredInputs, status, allowedActions, version`；确认票据绑定 plan/version/alternative/final content hash | 02 |
| SendTask | `planId, replyPartId, sequence, sendKey, scheduledAt, preflightSnapshot, status, attemptCount, platformReceipt, lastError`；唯一 `sendKey` | 02 |
| Feedback | `planId, shownAlternativeIds, action, originalContent, finalContent, reason, rating, source, createdAt` | 03 |
| ImportJob | `format, sourceHash, mode=import, preview, identityMapping, confirmedScope, status, errorReport` | 03 |
| AuditEntry | `actor, action, targetType/id/version, decisionSummary, sourceRefs, result, correlationId` | 03 |

正文可加密字段、数据库索引和拆表属于实现细节，但不能削弱 scope、来源、版本、状态或引用完整性。

## 3. 模块端口

以下为语义接口，不限定 HTTP 或函数签名。进程内优先调用类型化端口；管理端使用 `/api/v1` REST。所有命令返回 `resultVersion` 和 `correlationId`。

### 01 PlatformPort（只有 02 可调用发送方法）

- `getCapabilities(accountId)`、`getConnectionState(accountId)`、`fetchMedia(mediaRef)`、`reconcile(accountId,sinceCursor)`。`reconcile` 返回版本化 `RecoveryReport`：账号/桥接会话、前游标、验证覆盖范围与等级、可持久新游标、缺口、逐会话未决 sendKey 证据和待核对会话；无实测连续覆盖证据时 `historyComplete=false`。`connectionState=disconnected/connecting/relogin_required/reconciling/connected/degraded`；`connected` 前须完成同步与未知发送核对，缺口写在 capability 中。
- `submitSend(sendEnvelope)`：必须含 `sendTaskId,sendKey,conversationRef,partType,content/mediaRef,replyTo,deadline`。01 不判断恋爱业务权限，只验证调用方服务身份、契约与平台能力。
- 输出归一事件：`PlatformInboundObserved`、`PlatformOwnerMessageObserved`、`PlatformSelfMessageUnattributed`、`PlatformAgentEchoObserved`、`PlatformOriginResolved`、`PlatformReceiptObserved`、`PlatformConnectionChanged`、`PlatformMessageMutationObserved`。未匹配发送账本、无独立本人证据的自身账号消息只能发布 `PlatformSelfMessageUnattributed(actor=unknown,originStatus=unknown)`；不能作为联系人入站。`PlatformOriginResolved` 引用原 messageId、旧/新 actor、证据与版本；unknown 可以更正为 agent/owner，但先前暂停不自动恢复。

### 03 DataContextPort

- `appendObservedMessage`、`storeMedia`、`buildContext(contactId,cutoff,generation,allowedScopes)`、`queryFacts(contactId,asOf,allowedScopes)`、`readContextProjection({callerContactId,contactId,snapshotId,allowedScopes})`、`getDependencyEpoch(contactId)`。`buildContext` 同时返回不可变 Snapshot 与已裁剪 Projection；`readContextProjection` 同步复核引用版本、有效期、删除和 scope，失效返回 `STALE_CONTEXT`。02 在每条发送的同一数据库事务/租约内读取依赖 epoch 并复核，异步失效事件不是发送授权。调用方身份/联系人相符才可返回正文。相同时间按有证据的稳定顺序键、平台消息 ID、内部 ID 固定排序，不引入截止点后的内容。
- `confirm/correct/expire/deleteFact`、`storeAnalysisSnapshot`、`invalidateDependencies`、`recordFeedback`、`previewImport/commitImport`。
- 必须先按 contact/scope 过滤再检索；调用方传入另一个联系人 ID 不能获得私密数据。
- `OwnerDataQueryPort` 与上述联系人裁剪端口分离，仅供已鉴权的本人管理 API 使用；不能把浏览器自报 `callerContactId` 当身份。正式 PostgreSQL 表使用受限运行角色、事务级联系人 scope 与 RLS；管理查询使用独立鉴权角色/端口。

### 04 IntelligencePort

- `interpretMedia`、`analyzeContact`、`makeDecision`、`proposeReply`、`checkReply`。
- 输入必须是已裁剪的 `ContextSnapshot` 和策略投影；输出必须结构化并含模型/提示版本、引用、不确定性和失败类型。不能调用 PlatformPort 或改写 ContactPolicy。

### 05 SkillPort

- `listEligible(contactId,stage,contextProjection)`、`invoke(skillVersion,inputProjection,selectionMode)`、`trial(skillVersion,fixture)`、`createVersion/disable/delete`。
- 手动指定是当前任务的临时授权；须由 owner API 命令产生，不能来自消息内容。输出不含发送能力。

### 02 OrchestrationPort / 管理命令

- `enrollContact`、`updatePolicy`、`pauseContact/resumeContact`、`pauseAll/resumeAll`。
- `ingestPlatformEvent`、`confirmPlan`、`rejectPlan`、`submitOwnerReply`、`cancelPlan`、`scheduleActiveContact`。
- `confirmPlan` 必须带 `taskVersion,planVersion,alternativeId,editedParts,contentHash,idempotencyKey`。后端重新计算 allowedAction，不能信任前端布尔值。

### 基础设施事务端口（总控与 03 实现）

- `AtomicReceptionPort.commitReceived`：在单个 PostgreSQL 事务中写入经认证的原始事件私有引用、平台/账号/会话命名空间去重键及待处理 outbox；持久提交后 01 才向上游确认接收。业务消费者仍在自身事务内用 inbox 去重并保存消息/状态副作用。
- 全局迁移顺序为 `db/migrations/0001_core.sql`、`0002_data.sql`、`0003_data_scope_fix.sql`、`0004_orchestration.sql`；脚本维护 checksum，已执行的迁移不可修改。0003 收紧事实策略的 scope 判断（空字符串与未设置同义，历史 0002 保留不改写）；0004 落盘 02 的会话、方案、确认任务、发送任务与幂等命令表。`packages/infrastructure/postgres` 的事务和事件/账本函数、03 的 `PgDataProvider` 与 02 的 `PgConfirmedService` 已共用同一事务边界与 `withDispatchLease` 发送租约；鉴权 Owner API、worker 装配、持久调度和真实平台仍未交付，不能据此称生产闭环已可用。
- `DispatchJournal.claim`：与 02 的 `withDispatchLease` 协同，按账号/会话/sendTaskId/sendKey/内容摘要唯一约束写入提交意图；`SUBMITTING` 的崩溃或无法证明未提交一律按 `RESULT_UNKNOWN` 恢复。`finish` 单调保存回执；写入失败保留提交意图并暂停核对，不能视作未发。
- `withDispatchLease` 由 02 实现，绑定服务身份、conversation generation、global pause epoch、policy/事实/分析/技能版本、确认票据、最终内容摘要及截止时间。租约内串行化同会话的提交边界；网络提交后的新事件只阻止后续分条，不能声称撤回已提交内容。01 不能独自签发或延长租约。
- `ApprovedAssetPort` 由 03 提供私有读取，返回素材 ID、批准版本、允许平台、格式、字节摘要与字节；02 在发送前检查当前批准，01 提交前核对实际字节/摘要/格式。任何不一致拒绝发送。

### 06 查询 API

- 查询总览、连接状态、联系人与策略、会话、待办、媒体/识别、事实/记忆、分析证据、Skill/调用、导入、审计和故障。
- 返回的可操作资源包含后端计算的 `allowedActions`、`version`、失效原因；写入使用上述命令，不允许直接 PATCH 数据库字段。
- 批准 G1 最小 REST 形状：`GET /api/v1/overview`、`GET /api/v1/tasks`（`{items:[...]}`）、`POST /api/v1/tasks/{taskId}/confirm`（`ConfirmPlanCommand`）、`POST /api/v1/control/pause-all`、`POST /api/v1/contacts/{id}/pauseContact`。查询资源必带 `id,version,status,allowedActions`，可带 `reasonCodes,invalidationReason,correlationId`；命令返回 `resultVersion,correlationId,status?`。具体 provider、登录/CSRF、其余路由仍需 02/03/05/07 集成，不能把 06 提案全表当已实现接口。

## 4. 事件目录和失效规则

| 事件 | 发布者 | 必要消费者 | 必须效果 |
| --- | --- | --- | --- |
| PlatformInboundObserved | 01 | 02/03 | inbox 去重；名单外停止；名单内写消息、revision/generation 增加并触发聚合 |
| PlatformOwnerMessageObserved | 01 | 02/03 | 记录本人真实消息；暂停联系人、失效待发方案、取消尚未提交任务；需手动恢复 |
| PlatformSelfMessageUnattributed | 01 | 02/03/06 | `actor=unknown` 保存原始来源；暂停受影响联系人、失效未提交方案并请求人工核对；不得触发联系人回复或自动记为 owner |
| PlatformAgentEchoObserved | 01 | 02/03 | 与 sendKey/receipt 关联，不当作本人风格事实 |
| PlatformOriginResolved | 01 | 02/03/04/06 | 对 unknown 来源记录带证据更正并失效关联方案；不因更正自动解除接管/暂停 |
| PlatformReceiptObserved | 01 | 02/03 | 仅合法状态迁移；重复回执无副作用；矛盾回执升级故障 |
| ContactPolicyChanged | 02 | 02/03/04/06 | generation 增加；所有引用旧 policyVersion 的未发方案失效 |
| GlobalPauseChanged / ContactControlChanged | 02 | 02/06 | 同步 epoch/状态先更新；取消相应待发与主动任务 |
| FactChanged / EvidenceInvalidated | 03 | 02/04/06 | 引用旧事实/证据的方案失效；相关摘要/分析重算或标失效 |
| AnalysisChanged | 03/04 | 02/06 | 引用被纠正/失效分析的方案失效；新分析不改权限与目标 |
| SkillVersionChanged / GrantChanged | 05 | 02/04/06 | 引用失效技能或旧 grant 的未发方案失效；历史调用保留版本 |
| ReplyPlanProposed | 04 | 02 | 02 依据当前 generation/policy 决定待确认、自动调度、等待或拒绝 |
| ReplyPlanInvalidated | 02 | 04/06 | 终止确认/未提交发送；需要时基于最新快照重生成 |
| SendTaskStateChanged | 02 | 01/03/06 | 展示真实提交、回执、未知或失败；未知不得自动创建新 sendKey 重发 |

事件通过同库 transactional outbox 至少一次投递。处理副作用和 inbox 标记在同一事务。事件 schema 只允许向后兼容添加可选字段；破坏性变化发布新 `eventVersion` 并在迁移窗口双读或双写。旧消费者若不认识 `PlatformSelfMessageUnattributed`，必须暂停受影响会话，不得转为联系人入站。媒体错误 `MEDIA_UNCERTAIN`/`UNSUPPORTED_CAPABILITY` 均进入人工待办与 `PAUSED_MEDIA`；`MODEL_UNAVAILABLE` 进入 `PAUSED_FAILURE`，均不得生成可发送方案。

## 5. 状态机

### 会话控制状态

`DISABLED`（未授权/代理关闭）、`READY_CONFIRM`、`READY_AUTO`、`COLLECTING`、`GENERATING`、`AWAITING_CONFIRMATION`、`SCHEDULED`、`DISPATCHING`、`PAUSED_OWNER`、`PAUSED_POLICY`、`PAUSED_MISSING_FACT`、`PAUSED_MEDIA`、`PAUSED_FAILURE`、`PAUSED_STOP_REQUEST`、`PAUSED_UNKNOWN_SEND`。

状态是主状态，`pauseReasons[]` 保存可叠加原因。任何全局暂停均在 dispatch 检查中优先。新入站消息在等待/计划/发送未提交阶段使 generation 增加并令旧计划失效；已提交部分进入回执处理，其余取消。解除一个 reason 不得清除其他 reason。人工接管必需 owner 显式 resume；等待确认后恢复方式 D03 未定，先保持安全暂停语义。

### 回复方案状态

`DRAFT -> ACTIVE -> AWAITING_CONFIRMATION | APPROVED | SCHEDULED -> SENDING -> PARTIALLY_SENT -> SENT`。终态还有 `REJECTED | INVALIDATED | CANCELLED | EXPIRED | FAILED | RESULT_UNKNOWN`。`INVALIDATED` 不能重新激活；重新生成新 planId。`PARTIALLY_SENT` 保留已发 part，剩余 part 取消或形成需重新判断的新方案，绝不复用原 sendKey。

### 发送任务状态

`CREATED -> PREFLIGHT -> LEASED -> SUBMITTING -> SUBMITTED -> DELIVERED`。旁路终态：`CANCELLED_PRE_SUBMIT | REJECTED_PREFLIGHT | FAILED_DEFINITE | RESULT_UNKNOWN`。只有有平台证据“未接受/未发送”时，才可按同一 sendKey 和 adapter 约定重试；超时、断线、进程崩溃发生于可能提交之后，一律先 `RESULT_UNKNOWN` 和 reconcile。

发送前检查按顺序验证：live 模式、全局状态、连接/能力、联系人 enrollment 与控制状态、发送模式/专项权限、plan ACTIVE、conversation generation、policy/fact/analysis/skill 版本、触发消息仍为最新决策范围、事实有效期、媒体批准与平台支持、确认票据、时段/冷却、sendKey 未成功/未知。任一失败记录 reason code 并拒绝。

## 6. 最小可运行流程（文字、确认模式）

1. 模拟或真实 01 收到平台事件，验证来源并以平台 event/message key 写 inbox；转成 `PlatformInboundObserved`。
2. 02 检查联系人已加入、代理开启，03 在同一事务保存 Message；02 增加 revision/generation，进入 `COLLECTING`。重复事件只返回既有结果。
3. 聚合截止后 02 向 03 请求截止点固定的 ContextSnapshot；03 在联系人 scope 内返回消息、有效事实、有效分析引用。
4. 04 基于快照做决策与 1–3 个候选；假模型可提供确定夹具。02 再校验 generation/policy，创建 ACTIVE ReplyPlan 与 ConfirmationTask，状态为 `AWAITING_CONFIRMATION`。
5. 06 展示来源、策略摘要、版本和候选；本人选择/编辑后发送 `confirmPlan`。若版本已旧，返回 `STALE_PLAN` 并展示最新待办。
6. 02 生成绑定最终内容 hash 的确认票据和各 ReplyPart 的 SendTask。worker 逐条 preflight；通过后只有 02 调用 01 `submitSend`。
7. 01 返回平台接受信息并继续产出回执/回显；02 更新 `SUBMITTED/DELIVERED/RESULT_UNKNOWN`，03 记录实际发送与反馈，06 展示状态。下一条发送前重新执行 preflight。

最小闭环通过条件：可重复启动恢复；重复入站不产生第二方案；旧确认不能发送；重复确认不产生第二 sendKey；模拟 adapter 可覆盖成功、明确失败、未知、重复/乱序回执；每个关键对象可由 correlationId 追溯。它只证明内部流程，不证明微信/QQ 接入。

## 7. 错误约定

错误结构：`{code,message,retryable,correlationId,details?}`。`message` 可展示，`details` 不含密钥/原始模型推理。

| code | HTTP 建议 | 处理 |
| --- | --- | --- |
| VALIDATION_FAILED | 400 | 修正输入，不重试 |
| UNAUTHENTICATED / FORBIDDEN | 401/403 | 登录或拒绝；不泄露资源存在性 |
| NOT_FOUND | 404 | 资源不存在/不可见 |
| CONFLICT_VERSION / STALE_PLAN | 409 | 读取最新版本，不发送旧内容 |
| STALE_CONTEXT | 409 | 读取新上下文并重新生成，不发送旧计划 |
| POLICY_BLOCKED / PAUSED | 409 | 展示 reason 与允许动作 |
| UNSUPPORTED_CAPABILITY | 422 | 转人工或改变已批准输入，不能静默降级 |
| MISSING_FACT / MEDIA_UNCERTAIN | 422 | 建待办并暂停相关自动处理 |
| RATE_LIMITED | 429 | 仅在平台明确未接受时按约束重试 |
| PLATFORM_UNAVAILABLE / MODEL_UNAVAILABLE | 503 | 暂停受影响步骤，恢复后重判 |
| SEND_RESULT_UNKNOWN | 503 | 对该联系人阻塞发送并 reconcile，禁止盲目重发 |

## 8. 兼容性与变更

公共变更提案须写：动机、受影响对象/事件/API、兼容策略、数据迁移、回滚、AC 影响、01–07 协作者。总控批准后更新本文、机器 schema、契约测试、任务文档与 decisions.md。枚举删除、语义改变、必填字段新增为破坏性变更；只加可选字段也要测试旧消费者。本版新增事件且补足恢复/依赖语义，旧消费者需显式升级或保持暂停；不可静默双写为旧入站事件。版本号按 SemVer；首个实现仍处 0.x，但不能跳过迁移。
