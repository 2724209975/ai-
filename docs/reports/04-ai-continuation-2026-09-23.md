# 04 AI 第二段交付记录（2026-09-23）

当前裁决（2026-09-23）：下文公共提案已按 [A10](../decisions.md)采纳到 `docs/contracts.md` v0.3.0；02 mock 桥接已修复，正式 PostgreSQL/媒体 provider 仍待接线。以下交付记录保留当时的验证范围。

接续 `04-ai-progress-2026-09-23.md` 的未完成项。状态仍为 `In progress`；本段只修改 `packages/ai` 和本报告，未调用平台发送，也未改联系人目标、权限或事实。

## 本段交付

- 新增 04 侧 `adaptDataContextProjection`，直接接收 03 的已裁剪 `buildContext` 结果，保留消息类型、cutoff、事实/分析引用版本及联系人范围；03 现有分析替身不映成可用的策略提示。
- 新增 `prepareReplyForOrchestration` 供 02 交接：结构化决策为不回复时无方案；需要回复时全部候选先经检查；即使检查通过也只标 `authorization=not_evaluated`。02 的方案持久化、编辑后复查、确认和发送前校验职责不变。
- 假媒体包装要求类型对应的完整覆盖：图片/静态表情为完整画面，语音为完整转写，动态表情为时间序列；关键内容不清楚、局部画面、单帧或来源不明均显式失败。决策检查待回应的整段联系人消息，较早的未解媒体不会因后续文字而被跳过。`unsupported` 类型不能伪装成空文字或成功理解。
- `draft-1` 分析对可读文字样本给出有限的表达观察与推测，逐项记录支持、反向证据、替代解释和不确定性。阶段维持未知；不把 AI 发送、消息数量、单次表情或单条亲密用语升级为已确认关系。只有具备证据、反向证据字段、替代解释和不确定性的有效分析提示才可参与策略，且不改变目标/权限。

## 致架构总控：公共对接提案（待批准，尚未改公共契约）

1. **动机与缺口**：02 当前 `mock-ports.mts` 的 `scopedProjection` 将 03 的 `unsupported` 消息改写为 `text`；02 只将 `MEDIA_UNCERTAIN` 变成 `media_uncertain` 风险，未将 `UNSUPPORTED_CAPABILITY` 以同等人工处理路径纳入。03 的 `ContextProjection` 当前只有 `contentRef/mediaId`，无媒体解释/纠正引用，分析对象也只有 `claims/dependencySet` 替身。
2. **对象/API/事件**：建议总控在机器 schema 中明确 `ContextProjection` 的 `Message` 媒体解释引用及版本、纠正来源、类型化完整度/时序覆盖和 `unsupported` 原类型；定义 02 对 `MEDIA_UNCERTAIN`/`UNSUPPORTED_CAPABILITY`/`MODEL_UNAVAILABLE` 的待办与 `PAUSED_MEDIA`/`PAUSED_FAILURE` 映射；明确 `AnalysisSnapshot` 的 claim 正反证据、替代解释、uncertainty、taxonomyVersion 与失效依赖。04 只返回提案和错误，不发布发送事件。
3. **兼容与迁移**：新增媒体解释引用建议先为可选字段；缺失按不可可靠理解处理，不按空文本成功。机器 schema 发布后 04 适配器和 02 mock 桥接同时切换并补旧消费者契约测试。03 分析替身不能自动迁成正式有效分析；历史解释/分析缺来源时保持未知或重算。若字段语义或必填性改变，按 v0.2.0 规则发布新事件版本并双读迁移。
4. **回滚及 AC**：回滚为停用新媒体候选并保持人工处理，不能退回 `unsupported -> text`；涉及 AC06、AC08、AC09、AC25–28、AC32 及 02 的 AC03/04/15–20。01 提供媒体/能力与来源证据，02 持久化待办和暂停，03 存储裁剪/纠正/失效，04 消费并标注不确定性，05 仅获裁剪上下文，06 展示原媒体和原因，07 联合验收。请总控裁决 schema、02 桥接与错误路由；04 未越权修改其目录。

## 本段验证记录

| 环境 | 结果 | 能证明的范围 |
| --- | --- | --- |
| 离线 fake | `node --test packages/ai/index.test.mts`：18 pass / 0 fail；03/02 相关回归 `node --test packages/data/context/store.test.mts packages/orchestration/conversations/engine.test.mts packages/orchestration/integration/mock-ports.test.mts`：29 pass / 0 fail | 03 投影适配、聚合消息失败路径、五类消息夹具、证据结构、02 mock 文字确认流程；旧 02 桥接的媒体缺口仍在 |
| 时间截断 fake | `node packages/ai/eval/time-cutoff.mts`：确认/自动 × 文字、图片、语音、静态表情、动态表情、不支持类型共 12 例；12/12 未引入 cutoff 后消息；文字得到已检查提案，其他五类在未提供可靠解释时均返回结构化失败 | 防未来消息泄露的离线夹具证据；不是回复质量/效果验收 |
| 真实模型 | 未选型、未调用；无真实 token/媒体费用、时延、错误率或质量数据 | D06/D08 未决，不能宣称媒体理解或个性化达标 |
| 真实平台 | 未在微信/QQ 上执行本段测试，也未发送 | 平台获取媒体、回执、关机运行与产品验收均未验证 |

未完成：03 正式媒体存储与纠正/失效、分析快照结构、02 将新交接入口和错误路由接入持久流程、真实模型选型及本人标注评审。D06（模型/费用）、D08（标注/质量门槛）、D10（正式维度/阶段）、D11（更新和证据门槛）仍为 Open；`draft-1` 只是开发草案，不能作正式诊断或自动发送依据。所有 AC 仍为模块级部分证据，未记为产品验收通过。
