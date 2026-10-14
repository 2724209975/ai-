# Decision Engine v2.1 交付与启用

本次只扩展已有 ReplyPipeline v2、MemoryEngine v2、Provider、模型账本和管理台。发送权威、QQ/微信事件契约、去重、审批内容哈希、会话修订和发送状态机不变。Android 独立管线未修改，运行副本未部署或替换。源码差异见 [真实源码差异清单](decision-engine-v21-diff.md)。

## 分类与路由

|等级|行为|额外调用|
|---|---|---|
|L1 普通|沿用 economyProvider 或既有联系人生成模型|分类|
|L2 暧昧|给原候选生成器附加温和调侃、遵守边界策略|分类|
|L3 情绪/歧义|扩展有来源上下文 → 独立深度分析 → 原常规模型与三候选机制|分类 + 分析|
|L4 高风险|不生成候选，不创建发送任务；现有 SKIPPED/人工补充通道提示本人核对并在平台手动处理|分类，可能来自 L3 升级|

L4 不设置“模型已审批”，也没有自动降低授权的入口。现有 v2 的所有候选仍需本人确认；明确拒绝继续复用停止联系暂停机制。L4 人工处理提示在回复任务卡显示，不新增一套可绕过审批的发送队列。

主分类失败、超时、429、5xx 或非法结构可调用明确配置的备用分类；认证/隐私/预算拒绝不通过备用模型绕过。两者都失败进入 L4。低分类置信度、歧义或不一致风险升级至 L3；分析不可用、超时或非法输出升级至 L4。规则和已确认边界只能提高风险；模型不能修改事实、授权、路由配置或发送状态。生成阶段另有 L4 独立阻断，质量阶段也拒绝 L4 候选。

## 兼容协议与上下文

`schema_version=2.0` 的原字段和严格校验保留。`2.1` 新增 `classification_level`、`classification_confidence`、`ambiguity {detected, reason}`、`risk_flags`；仍保留 action、strategy、tone、emotion、required_memory_keys、证据 ID 等字段。分析输出有独立结构校验、可见消息/记忆证据检查，拒绝额外执行字段。Schema 定义在 `packages/ai/pipeline-v2/schemas-v21.mts`，运行时校验在 `packages/contracts/decision-v2.mts`。

Active 阶段先使用当前完整触发批次、最近 12 条消息及相关引用、短关系摘要、必要边界/承诺和至多 3 条普通相关记忆；关键词检索继续复用 MemoryEngine。普通分类不调用查询 Embedding。仅 L3 重新构建完整有来源快照，并在已有云端授权和记忆控制允许时调用可选 Embedding；召回长期事实、历史事件、边界和未解决话题。既有生成风格、候选校准和事实门禁继续使用对应快照。

Shadow 完成旧流程后在后台运行分类/分析，仅写 `shadow_decision_record` 和模型调用计量。它不替换旧决策、不生成另一组候选，不修改联系人暂停、任务版本或审批结果；旧引擎已暂停的明确拒绝场景也能记录观察结果。正常进程停止等待已发起的 Shadow 工作；进程强制中断可能丢失未完成的诊断，running 调用继续保留预算占用。Shadow 收费调用沿用现有统一费用及调用限额，需要为观察流量预留额度，不能把它当作免费流量。

## 配置示例

示例在 [deploy/decision-v21.example.json](../deploy/decision-v21.example.json)。`registryAdditions` 是要追加到已有 `AI_V2_PROVIDERS_JSON` 数组的记录，不是整份替换配置。`routeConfigPatch` 是要合并到已有模型配置的字段，不是可直接 POST 的完整命令。

示例保留指定模型 ID：`gpt-6-luna`、`claude-haiku-5-5`、`claude-opus-5-5`。主/备用分类和深度分析通过 Provider key 选择，业务逻辑没有这些型号判断。生成配置继续使用已有 economyProvider/contactOverrides/fallbackProvider，qualityProvider 留给旧引擎。

新增可选 `protocol`：默认 `chat-completions` 保持原实现；也支持 `openai-responses` 和 `anthropic-messages`。Responses 请求 `store=false`，原生 Messages 使用 `x-api-key` 和版本头；截断、拒绝、错误 JSON 不当作成功输出。格式参考 [OpenAI GPT-6 Luna 官方资料](https://developers.openai.com/api/docs/models/gpt-6-luna) 和 [Claude Messages 官方契约](https://platform.claude.com/docs/en/api/messages/create)。这些适配器已通过模拟 HTTP 契约测试，本轮没有向指定真实模型发起收费请求。

API Key 只放服务器环境变量 `AI_V2_OPENAI_KEY` / `AI_V2_ANTHROPIC_KEY`。示例中的版本、地区和保留条款须填部署者核实值；价格沿用原 price 格式，须按实际计费渠道配置。未硬编码价格，也未扩大原费用授权；启用共享人民币账本时缺少有效价目将拒绝请求。存在单独缓存写入计费而本账本未配置对应价格时，费用保持未知。

1. 在目标数据库备份后，使用现有迁移入口 `npm run migrate` 应用新增 `0018_decision_engine_v21.sql`。本轮只在隔离测试库执行，未修改真实运行数据库。已部署的迁移编号若有 overlay 差异，沿用现有 `composeMigrationLineage` 机制追加，不编辑旧迁移校验和。
2. 在使用同一数据库/Owner 的 Core 与 Bridge 配置相同 Provider 集合，并重新启动目标运行副本。
3. 管理台“聊天设置 → 模型配置 → 四级决策 v2.1”选择主/备用分类和分析模型。先选 Shadow、置信度 0.8；可限制联系人和灰度比例。全局/联系人云端授权继续优先于模型设置。
4. 保存操作复用 `POST /api/v2/model-config`，整份 config 加 expectedVersion/idempotencyKey；它会让正在生成或待审批的旧候选过期，保留已提交/不确定发送记录。

不配置 decisionEngineV21 等价 off。配置不会启用真实自动发送，Active 也始终人工确认。

## Shadow 与灰度

先对授权的脱敏历史数据评估，再对选定联系人运行 Shadow。比较人工标注等级、复杂情绪漏判率、L1/L2 误升级率、非法 JSON、召回证据、分类/分析 P50/P95 和额外费用。模型用量界面按 active/shadow/等级显示数量、升级和分析失败，实际模型及 token/费用继续按原调用账本展示。不能用模型自评代替人工等级标注。

达到部署者确定的质量、费用和延迟门槛后，先设置 active + contactIds 白名单 + cohortPercent=5，再逐步 10/25/50/100。experimentKey 与 contactId 的固定哈希保持分组稳定；不同实验标识与配置版本可用于 A/B 对比旧/新引擎，模型仍可随时通过 Provider key 切换。切换会使未发送旧候选过期。任何阶段都保留 L4 人工处理及 v2 原审批机制。

## 数据、计量与回滚

迁移只新增 `orch_reply_jobs.shadow_decision_record`，并允许 `ai_model_calls_v2.task='analysis'`。已有 decision_record/route_record 保存等级、实际分类模型、初始等级、升级原因、分类耗时、分析模型/状态/耗时及分析数据。既有账本保留计量、价格、费用、错误和配置版本，不保存密钥或完整提示。

深度分析可能引用记忆文字。新增快照清理触发器接续 MemoryEngine 的来源删除/纠正机制，清除相关 v2.1 决策、分析和 Shadow 派生正文，保留旧 v2 决策与调用计量。失效来源对应的审批继续由既有快照/版本校验阻断。

回滚：在管理台将模式设为 off 并保存，随后新任务立即使用旧决策。需回退整个源码/运行副本时，先通过当前 API 删除 config 中整个可选 decisionEngineV21 字段并保存，再切换旧副本，避免旧版严格配置校验拒绝新字段。保留 0018 的兼容列、分析调用账本和迁移记录；不执行删列、不恢复覆盖聊天数据库、不触碰未知发送。已有 SKIPPED/L4 或暂停联系人仍由本人判断和手动处理，回滚不自动恢复发送。

## 测试与证据

单元覆盖四级路由、上下文/边界保留、低置信度/潜台词、主备用分类失败、非法字段与证据、分析失败、隐私/预算、旧版与分组回退、三种 Provider HTTP 协议和截断输出。隔离 PostgreSQL 集成覆盖实际迁移、候选、Shadow 隔离、拒绝场景、长期记忆召回、来源清除、取消迟到分析、原审批/去重/重启/QQ微信接入。

离线回放命令：`node scripts/decision-v21-replay.mts`。自带 24 条合成历史场景，全部匹配；复杂情绪漏判与普通消息误升级在该夹具上均为 0，非法结构为 0，额外外部 API 费用为 0，平台调用为 0。仅 L3 的 8 条调用分析。截止后的消息/事实被排除。支持同一 JSON 格式的脱敏数据文件和输出路径：`node scripts/decision-v21-replay.mts 脱敏样本.json 结果.json`，要求 ownerAuthorized/deidentified=true 和 m/f 匿名 ID；该入口只跑离线规则夹具，不调用真实模型或平台。

回放证据见 [decision-v21-replay-2026-10-13.json](reports/decision-v21-replay-2026-10-13.json)。最终回归结果见 [交付报告](reports/decision-v21-2026-10-13.md)。工作区现有回放数据明确标为 synthetic，本轮未使用真实联系人私密记录或发送试运行；合成夹具不能证明三个真实模型的情绪质量、实际费用或 API 延迟。真实脱敏历史 + 人工标注 + 经费明确的真实模型回放仍是开启灰度前的验收步骤。
