# Decision Engine v2.1 源码差异（2026-10-13）

当前实际链路为 `PgConfirmedService → PgDataProvider/MemoryRepository → ReplyPipelineV2 → ModelServiceV2 → Provider`。发送权威仍是 PgConfirmedService，ReplyPipeline v2 已强制人工审批。现有 risk_level 只有 low/medium/high，情绪冲突和现实承诺共同走 qualityProvider；没有独立分析能力、四级分类及 Shadow 记录。Android 为独立管线，本次不修改 APK。QQ/微信事件契约与接入层不变。

|真实文件|最小变更及接口|
|---|---|
|packages/contracts/decision-v2.mts|保留 2.0 严格协议，新增 2.1 分类、置信度、歧义、风险标签及深度分析校验；ModelRouteConfigV2 加可选 decisionEngineV21|
|packages/ai/pipeline-v2/providers.mts、compatible-provider.mts|DecisionProvider 增加可选协议版本；新增 AnalysisProvider；注册支持 analysis 能力及原生 Responses/Messages 协议|
|packages/ai/pipeline-v2/schemas-v21.mts、transport-v21.mts|分类/分析 Schema、原生 HTTP 请求及计量适配，旧兼容协议默认保留|
|packages/ai/pipeline-v2/decision-engine-v21.mts、pipeline.mts|轻量分类、安全升级、独立分析、L4 不生成；旧决策和候选生成保留；配置关闭/灰度分组/Shadow|
|packages/ai/pipeline-v2/model-service.mts|可选配置校验，分析调用复用预算账本，Shadow 独立持久化，分类统计|
|packages/contracts/context-memory-v2.mts、packages/data/postgres/provider.mts|ContextV2Options 增加轻量检索参数，复用 MemoryEngine 的关键词/边界及摘要|
|packages/orchestration/postgres/confirmed-service.mts|active 仅 L3 追加完整上下文与可选向量检索；Shadow 在旧流程完成后记录；保留审批、版本和重复发送保护|
|packages/ai/types.mts、generation/deepseek-provider.mts|把分类等级与分析结果作为可选生成输入，保留候选生成和风格机制|
|packages/orchestration/postgres/reply-jobs.mts、worker.mts|读取 Shadow 诊断，正常停止时等待已发起的观察工作|
|apps/web/src/api.ts、workspace/ModelPanel.tsx、workspace/ReplyJobPanel.tsx|模型/模式/灰度选择，分类、升级、深度分析及 Shadow 展示|
|db/migrations/0018_decision_engine_v21.sql|新增 shadow_decision_record JSONB；ai_model_calls_v2.task 增加 analysis；来源删除/纠正时同步清理新派生记录|
|tests/integration/postgres-local-stack.test.mts|已有迁移数量断言从 17 更新为 18|
|packages/ai/pipeline-v2/decision-engine-v21.test.mts、tests/integration/postgres-decision-engine-v21.test.mts、tests/e2e/workspace-browser.test.mts|四级决策、数据库/Shadow/回滚与管理台测试|
|packages/ai/eval/decision-v21-replay.mts、decision-v21-replay.test.mts、scripts/decision-v21-replay.mts、tests/fixtures/decision-v21*|可运行的合成/脱敏历史格式离线回放与证据|

决策等级、实际模型、升级原因、分析结果、耗时放在现有 decision_record/route_record 或新增 Shadow JSONB 中；token、价目和费用继续使用 ai_model_calls_v2。只新增迁移，不编辑已应用的 0017。缺失费用不算零。

默认没有 decisionEngineV21 等价 off。示例配置先 shadow，active 只改变决策/候选行为，所有等级仍人工审批。L4 不调用生成，用现有 SKIPPED/人工补充通道标记 HUMAN_REVIEW_REQUIRED，控制台提示本人核对并手动处理。旧版回退只需将 mode 改为 off。
