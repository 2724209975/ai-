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

成功只返回新的上下文投影/解释草稿，不修改输入、不落盘、不授予发送权限；交接仍经过原有意图/风险/事实检查，`authorization=not_evaluated`。**生产组合根不得直接把这些内存草稿当作发送依据**：必须先由 03 把解释写入不可变快照、纳入依赖 epoch、本人纠正/删除失效及 02 发送前复核。当前生产图片/语音仍转人工。观测仅有版本、匿名快照/调用标识、结果、token 和时延，不含正文、路径、媒体/消息/联系人身份。用量缺失为 null；观测器故障不影响业务结果。

## 持久媒体解释的读取（P4-2）

03 保存解释后（见 03 的 `storeMediaInterpretation`），投影里的 `message.mediaInterpretation` 会是带 `id`、`version`、`correctedByOwner` 和 `status='valid'` 的 `StoredMediaInterpretationProjection`，`snapshot.mediaRefs` 记录该批次选中的解释 id/version。`adaptDataContextProjection` 在这条路径上只做映射与一致性校验：解释必须属于同一联系人、同一消息与同一媒体，状态为 `valid`，覆盖与纠正来源须与快照引用相符，源版本序列须与快照证据引用逐项相等，否则抛 `STALE_CONTEXT`。`validateScopedContext` 再核对持久解释与 `snapshot.mediaRefs` 数量、id、version 完全一致；不一致时 04 不会生成候选。

`mediaById` 参数保留给 P4-1 的受控内存夹具（`status='draft'`）；只有该参数传入的解释才会被当作草稿使用，持久解释优先，且 04 不会把持久解释重标成新生成草稿、也不会改写 `correctedByOwner`。本人纠正后的版本仍只是聊天内容，不提升权限、不改变 `authorization=not_evaluated`，也不代表质量通过。

不存在可用持久解释时，媒体消息仍按 P4-1 口径处理：图片/语音没有完整有效解释则整批 `MEDIA_UNCERTAIN` 转人工；本人删除解释后同一条来信不会重新解读，也不会留下可派发的旧候选。

## 真实媒体 provider 与独立限额（P4-3，未装配生产）

`understanding/vision-provider.mts` 是真实图片 adapter，`understanding/voice-provider.mts` 是通用语音转写 adapter，`understanding/media-env.mts` 负责显式开关与装配，`understanding/media-budget.mts` 是媒体专用失控闸。三者都实现现有 `BinaryMediaProvider`，都只接收单个已校验媒体，都看不到联系人、消息 ID、路径或策略。

- 图片：OpenAI 兼容 chat completions + base64 `data:` URL，图片只出现在 `user` 消息里（供应商文档的硬限制）。**格式按文件字节判定**（PNG/JPEG/GIF/WebP），声明与内容不符直接拒绝，不转发、不改标；内联上限默认 24 MiB、单图 10 MiB、请求体 40 MiB，`detail` 只允许 `low/high/original/auto`，默认 `original`（`low` 会缩放，不足以支撑 `full_image` 覆盖声明）。
- 语音：OpenAI 兼容 multipart `/audio/transcriptions`，容器白名单见 `SUPPORTED_AUDIO_FORMATS`；**本仓库没有任何供应商被声明支持语音**，未配置端点即语音支持列表为空，语音继续转人工。不臆造语音能力。
- 解释一律结构化：非空正文、`completeness`、图片 `visualCoverage=full_image` / 语音 `transcriptCoverage=complete`、不确定性、`criticalUnclear`。模型没给 `uncertainty` 时记为「模型未声明不确定性」，不当作确定。`criticalUnclear` 为真仍走转人工。`evidenceRefs` 由适配器给一个结构占位，`interpretContextMedia` 会丢弃它并换成由可信消息绑定与文件哈希构造的证据——**模型自报引用永远不会成为证据**。
- 失败分类：HTTP 非 2xx 抛 `DEEPSEEK_HTTP_<status>`（含供应商错误码，不含正文）、结构无效/空文本/超长抛 `MODEL_UNAVAILABLE`、字节与格式不符抛 `MEDIA_UNCERTAIN`、未支持的媒体或容器抛 `UNSUPPORTED_CAPABILITY`，最终都由 04 gateway 与 02 转成暂停转人工。错误文本不含密钥、字节或正文。
- 限额：`withMediaDailyBudget` 按 UTC 日、**按媒体类型分别**计调用与 token，图片/语音互不影响，也不与文本限额共享；默认各 200 次、各 200k token（本人 2026-10-03 确认的保守失控闸）。超出抛 `MODEL_BUDGET_EXHAUSTED` → `MODEL_UNAVAILABLE`。它重启清零，不是月预算，也不是账单上限。
- 开关：`MEDIA_VISION_ENABLED` / `MEDIA_VOICE_ENABLED` 默认关闭；开启图片需要 `MEDIA_API_KEY`（或 `MEDIA_VISION_API_KEY`），开启语音还需要 `MEDIA_VOICE_ENDPOINT` 与 `MEDIA_VOICE_MODEL`。**不会回退到 `DEEPSEEK_API_KEY`**：文本密钥不能悄悄解锁媒体付费调用。核心组合根目前只做配置校验，没有媒体路径，生产媒体仍转人工。

这些适配器只在本地假 endpoint 上验证过请求形状、格式复核、失败映射与限额隔离；**真实模型质量、真实供应商兼容性与微信原文件仍未验证**，需要本人授权后才能实测。



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
