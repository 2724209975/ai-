# 04 AI 端口（开发夹具）

当前状态只见 [开发计划 §0](../../docs/development-plan.md#0-当前状态每完成一个任务由总控更新本节)；本页保留模块说明与操作约束，不维护测试数字或进度。

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

`adaptDataContextProjection(03buildContextResult, mediaById?)` 把 03 已裁剪的 Snapshot/Projection 映成 04 本地类型，不额外读取事实或其他联系人。它保留 `unsupported` 原类型；媒体解释按 `mediaId` 附着，未提供解释时不能靠空文本继续。媒体解释只能来自测试声明或受控存储，是否具备完整解释须逐项验证，不因存储存在就假定可理解。

`prepareReplyForOrchestration(port, context, policy)` 依次取得决策、方案并检查所有候选。不回复时返回 `proposal=null`；媒体理解失败等返回结构化错误，02 应据错误建立待办和暂停受影响联系人。成功也始终返回 `authorization=not_evaluated`；02 仍负责方案 ID/版本、确认票据、权限、状态失效及逐条发送前检查。02 装配须保留 `unsupported` 原类型，不得映成文字绕过媒体检查。

媒体夹具声明必须按类型附完整覆盖：图片与静态表情 `full_image`，语音 `transcriptCoverage=complete`，动态表情 `temporal_sequence`。任何关键内容不清楚、局部或单帧结果返回 `MEDIA_UNCERTAIN`，由 02 转人工。当前没有真实视觉、转写或时序模型，覆盖声明只用于夹具契约测试。

## P4 媒体字节与解释交接

`interpretContextMedia(context, policy, { source, provider })` 和 `prepareReplyWithMedia(port, context, policy, options)` 是显式的 04 开发/集成入口。`source` 可使用 03 的 `FileMediaStore`，provider 实现 `BinaryMediaProvider`：声明图片/语音各自支持的 MIME、模型与 prompt 版本、数据地区和留存设置，接收字节/类型/MIME/取消信号，返回解释和可选 usage。无需新增依赖；没有默认真实 provider、环境开关或生产入口装配。

处理只读取当前联系人在最近一次本人/助手回应之后的 live 图片和语音。整个上下文先做联系人、策略版本与截止点校验；未知来源、不支持类型、动态/静态表情、非 live 媒体整批拒绝。文件须完整且非空，消息/联系人/媒体绑定、资产版本和 SHA-256 必须正确；codec 需 provider 显式支持。本层不解码或转码，实际格式解码验证属于 provider/获取适配器。默认整批 15 秒、单文件 10 MiB、最多 8 个媒体，均可配置；它们是处理资源限制，不是费用预算或平台能力保证。

provider 只收到单个媒体的字节和 codec，不收到联系人身份、消息 ID、磁盘路径、其他消息或策略写入口。解释必须非空，显式给出完整性、关键内容是否不清楚、图片全图覆盖或语音完整转写；模型自报覆盖仍需真实样本验收。证据引用由可信消息和文件哈希生成，不采纳模型自行编造的引用。模型返回后重新读取资产核对版本/哈希/绑定，删除或变化使整批失败；一次失败不返回此前已完成的局部结果，不自动 fallback 或重试。

成功只返回新的上下文投影/解释草稿，不修改输入、不落盘、不授予发送权限；交接仍经过原有意图/风险/事实检查，`authorization=not_evaluated`。**生产组合根不得直接把这些内存草稿当作发送依据**：必须先由下一张卡将解释写入 03，纳入不可变快照、依赖 epoch、本人纠正/删除失效及 02 发送前复核。当前生产图片/语音仍转人工。观测仅有版本、匿名快照/调用标识、结果、token 和时延，不含正文、路径、媒体/消息/联系人身份。用量缺失为 null；观测器故障不影响业务结果。

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

离线测试可用 `createPersistentFakeIntelligence()` 接收 03 内存投影。静态检查运行 `node packages/ai/eval/typecheck.mts`，以实际 02 `PersistentIntelligence` 类型编译 04 代码。真实 PostgreSQL 回归用例为 `packages/ai/strategy/persistent-fake.pg.integration.mts`，需要隔离测试库及 `TEST_DATABASE_URL`；缺数据库时明确 skip，不能记为实跑通过。该用例只验证 fake 模型与 mock 平台，不用于真实生成质量或自动发送放行。

`createTextCandidateGateway(provider)` 定义了后续真实文本候选 provider 的模型/提示版本、数据地区、留存声明和可选 token/延迟/成功或失败观测；观测不包含聊天内容或异常正文，观测器异常不会覆盖 provider 结果。DeepSeek 的显式装配见核心与微信桥接入口，实测证据只见开发计划 §0；默认 fake 不发外部请求。小样本评测设计见 `eval/text-sample-plan.md`。

运行测试：`node --test packages/ai/index.test.mts`。
