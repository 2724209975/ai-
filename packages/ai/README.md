# 04 AI 端口（开发夹具）

语义基线为 `docs/contracts.md` v0.3.0。入口是 `index.mts` 的 `createFakeIntelligencePort()`；Node 24 原生运行 `.mts`，当前无额外依赖。

```ts
import { createFakeIntelligencePort } from './packages/ai/index.mts';

const ai = createFakeIntelligencePort();
const decision = ai.makeDecision({ context, policy });
if (!decision.ok) return decision;
if (!decision.value.shouldReply) return decision; // 等待/不回复/缺事实由 02 处理
const proposal = await ai.proposeReply({ context, policy, decision: decision.value });
if (!proposal.ok) return proposal;
for (const alternative of proposal.value.alternatives) {
  const check = ai.checkReply({ context, policy, decision: decision.value, parts: alternative.parts });
  // 02 依据检查报告与最新业务状态决定待确认、暂停或拒绝。
}
```

`context` 是 03 从不可变 `ContextSnapshot` 的引用解析出的联系人裁剪投影，形状见 `types.mts`。必须含完整的消息、事实、分析引用版本，且所有消息早于等于 cutoff。04 会拒绝跨联系人、未来消息、投影缺项或与策略版本不一致的输入。`policy` 是 02 的只读投影；04 不接受平台发送或策略写入端口。

`proposeReply` 返回 1–3 个替代候选，每个有 1–8 条有序文字分条。`clientAlternativeKey/clientPartKey` 只在本次提案内区分候选；02 持久化时分配 `planId/alternativeId/replyPartId`、版本、状态和失效依赖。04 不判断是否允许自动发送。02 还须对本人编辑后的最终分条重新调用 `checkReply`，再做其自己的发送前检查。`checkReply.authorization` 固定为 `not_evaluated`。

`createFakeIntelligencePort(primary, fallback?)` 可注入候选生成 gateway。超时会中止 signal；结构错误、超时、provider 异常均返回 `MODEL_UNAVAILABLE`，不返回空候选。显式传入 fallback 才会回退，结果的 `generatorVersion` 指明实际生成者。当前默认是假模型，文案固定，只供闭环联调，不代表个性化质量。

`analyzeContact` 当前输出 `taxonomyVersion=draft-1` 的有限聊天表现观察和推测；关系阶段与趋势保持未知。`interpretMedia` 对无完整已验证解释的媒体返回 `UNSUPPORTED_CAPABILITY` 或 `MEDIA_UNCERTAIN`。这些结果不得算作真实媒体或分析能力验收。

## 03 / 02 交接（第二段）

`adaptDataContextProjection(03buildContextResult, mediaById?)` 把 03 已裁剪的 Snapshot/Projection 映成 04 本地类型，不额外读取事实或其他联系人。它保留 `unsupported` 原类型；媒体解释按 `mediaId` 附着，未提供解释时不能靠空文本继续。03 当前无 `storeMedia` 和完整分析快照，所以 `mediaById` 只能由测试或日后正式存储读取提供，03 的分析替身不会产生策略提示。

`prepareReplyForOrchestration(port, context, policy)` 依次取得决策、方案并检查所有候选。不回复时返回 `proposal=null`；媒体理解失败等返回结构化错误，02 应据错误建立待办和暂停受影响联系人。成功也始终返回 `authorization=not_evaluated`；02 仍负责方案 ID/版本、确认票据、权限、状态失效及逐条发送前检查。现有 02 mock 桥接尚未改用此入口，尤其不能继续把 `unsupported` 映成文字；具体改动见交付记录的总控提案。

媒体夹具声明必须按类型附完整覆盖：图片与静态表情 `full_image`，语音 `transcriptCoverage=complete`，动态表情 `temporal_sequence`。任何关键内容不清楚、局部或单帧结果返回 `MEDIA_UNCERTAIN`，由 02 转人工。当前没有真实视觉、转写或时序模型，覆盖声明只用于夹具契约测试。

草案分析把观察和推测分开，每项有支持引用、反向证据列表、替代解释和不确定性；关系阶段仍为未知，不依据消息数量、AI 发言或单条暧昧话作正式标签。分析策略提示只有在有效版本、证据、反向证据字段、替代解释和不确定性俱全时才被引用，且不能更改策略权限。D10/D11 未决前不设更新门槛或准确率。

运行时间截断评测：`node packages/ai/eval/time-cutoff.mts`。该评测使用 03 内存投影，在确认和自动模式分别覆盖文字、图片、语音、静态/动态表情及不支持类型，并断言未来消息不进入快照；它不测试真实模型质量。

## 07 命令行闭环使用的 PostgreSQL fake 端口

02 的 `PgConfirmedService` 使用 `PersistentIntelligence`，并直接传入 03 的完整 `PersistentContext` 投影。04 提供 `createPgPersistentFakeIntelligence()`：

```ts
import { PgDataProvider } from './packages/data/postgres/provider.mts';
import { createPgPersistentFakeIntelligence } from './packages/ai/index.mts';
import { PgConfirmedService } from './packages/orchestration/postgres/confirmed-service.mts';

const data = new PgDataProvider();
const intelligence = createPgPersistentFakeIntelligence();
const service = new PgConfirmedService({ pool, data, intelligence, platform: mockPlatform, authority });
```

这里的 `pool`、`mockPlatform`、`authority` 由 07/02 的 CLI 初始化。02 负责从 03 `buildContext/readContextProjection` 获取已裁剪且经依赖版本复核的完整投影；04 直接验证联系人、策略版本、快照引用和截止时间，不二次查询数据库。文字输入返回 1–3 个结构化候选和依赖版本；本人编辑后调用 `checkEdited` 重新检查，缺本人事实返回 `MISSING_FACT`。无可靠媒体解释返回 `media_uncertain` 且不生成候选。02 仍拥有名单、确认、状态、持久化和唯一发送授权。

离线测试可用 `createPersistentFakeIntelligence()` 接收 03 内存投影。静态检查运行 `node packages/ai/eval/typecheck.mts`，以实际 02 `PersistentIntelligence` 类型编译 04 代码。真实 PostgreSQL 回归用例为 `packages/ai/strategy/persistent-fake.pg.integration.mts`，需要隔离测试库及 `TEST_DATABASE_URL`；缺数据库时明确 skip，不能记为实跑通过。当前仅为 fake 模型和 mock 平台闭环接口，D06/D08 未决，不能用于自动发送质量放行。

`createTextCandidateGateway(provider)` 定义了后续真实文本候选 provider 的模型/提示版本、数据地区、留存声明和可选 token/延迟/成功或失败观测；观测不包含聊天内容或异常正文，观测器异常不会覆盖 provider 结果。目前只有测试 stub，没有外部请求。小样本评测设计见 `eval/text-sample-plan.md`。

运行测试：`node --test packages/ai/index.test.mts`。
