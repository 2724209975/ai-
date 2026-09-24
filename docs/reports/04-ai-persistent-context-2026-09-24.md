# 04 持久化上下文与模型接线交付（2026-09-24）

状态：`In progress`。承接 2026-09-23 的 04 交付；本段仅修改 `packages/ai` 和本报告。未调用平台发送，未修改联系人目标、权限或已确认事实。公共基线仍是 `docs/contracts.md` v0.3.0；D06、D08、D10、D11 均未裁决。

## 本段变更

- 04 的 `PersistentIntelligence` 适配器直接消费 02 传入的 03 完整 `PersistentContext` 投影，检查联系人、策略版本、依赖 epoch、快照引用与 cutoff，不再按快照 ID 二次查询数据库。`createPgPersistentFakeIntelligence()` 保留旧 CLI 参数的兼容入口，但不使用其 `pool/data`。02 仍负责持久化方案、确认、状态失效和发送授权。
- 文字消息的 fake 路径返回 1–3 个已检查候选；本人编辑后重新检查。缺本人事实被阻断。图片、语音、静态或动态表情及不支持类型，在没有对应完整、可靠解释时不生成候选，返回可供 02 暂停并转人工的 `media_uncertain`。媒体解释夹具必须含来源及类型对应的完整画面、完整转写或时间序列；单帧、局部、关键内容不清楚时失败。
- `createTextCandidateGateway` 提供可替换文本 provider 契约，记录 provider/model/prompt 版本、数据地区、留存声明及可选 token/延迟/成功失败观测；失败观测不包含异常正文或聊天内容。当前只用本地 stub，没有外部模型请求，也没有费用或真实质量数据。`eval/text-sample-plan.md` 写明本人标注、时间截断和分模式评测方法，仍是待 D06/D08 决策的方案。
- 04 本地决策、方案和检查保留证据引用、提示版本、不确定性，授权值固定为 `not_evaluated`。`draft-1` 分析逐项列支持证据、反向证据、替代解释与不确定性；样本少时保留未知，不输出正式性格或关系阶段。03 当前持久化分析投影尚不能在 04 安全映成有完整主张的策略提示，因此不会把它当作已确认结论。

## 致架构总控：公共接口提案（待裁决，未修改 02/03/公共契约）

**缺口。** 02 `PgConfirmedService.PersistentIntelligence` 的返回值使用 `Draft`。它目前仅有候选、风险、生成器版本和依赖版本，接不住 04 `ReplyDecision/ReplyProposal/ReplyCheck` 的 `evidenceRefs`、`promptVersion`、`uncertainty`、`triggerMessageIds`、`requiredFacts`、`confirmationReasons` 及检查报告。02 持久化计划时自行取得触发消息，但无法持久保存 04 给出这些字段的原始依据。03 的分析投影已有 claims 等字段，04 尚缺经总控确认的结构化策略主张与证据映射契约。

**建议。** 在 02 持久化输入或独立的 `IntelligenceHandoff` 中增加可选的决策/提案/逐候选检查元数据，保留上述引用及版本。02 应在写入时核对引用属于同一快照，并决定存储及 06 展示字段；缺失元数据的旧 fake 消费者可继续工作，但不能显示为“已解释”。03/04/02 共同定义分析 claim 的可引用结构和失效规则，D10/D11 裁决之前只能显示草案和未知，不直接启用正式阶段策略。任何新增字段都不应成为发送授权；发送仍由 02 在最新策略及依赖检查后决定。

**兼容与验收。** 新元数据先可选，旧计划按无依据元数据处理；如需改变事件或持久化 schema，由总控安排版本和迁移。建议联合回归 AC06、AC25–28、AC32：媒体失败转人工、推测正反证据/不确定性、策略前后解释、本人编辑后检查、02 最终授权。总控已认可此方向，当前优先处理 G2 接入和数据失效，暂不分配迁移；04 保留提案与兼容测试。04 不越权修改 02、03、06 或公共契约文件。

## 验证状态

| 层级 | 本次结果 | 结论范围 |
| --- | --- | --- |
| 静态与离线 fake | `node packages/ai/eval/typecheck.mts` 通过（以当前 02 `PersistentIntelligence` 类型严格检查 04 源码）；`node --test packages/ai/index.test.mts packages/ai/strategy/persistent-fake.test.mts packages/ai/strategy/persistent-fake.pg.integration.mts`：31 pass、0 fail、1 skip；02 mock/05 联调加 PG 桥测试：5 pass、0 fail、1 skip | 覆盖 03 裁剪投影、1–3 候选、编辑后事实检查、媒体失败、证据/不确定性、失败遥测和只读授权；仍是假模型或 stub |
| 时间截断 fake | `node packages/ai/eval/time-cutoff.mts`：确认/自动 × 文字、图片、语音、静态表情、动态表情、不支持类型，共 12/12 个夹具排除截止点后消息 | 文字给出已检查方案；其他类型缺可靠解释时失败。不是质量或产品验收 |
| 真实 PostgreSQL | 架构总控在隔离 PostgreSQL 17.11 `127.0.0.1:55432/chat_agent_test` 独立运行 04 回归：1 pass、0 fail、0 skip。07 又在隔离 PostgreSQL 17.11 `127.0.0.1:55418` 联合运行 `packages/ai/strategy/persistent-fake.pg.integration.mts`、`tests/integration/postgres-fake-intelligence.test.mts` 和 03 G2 回归：3 pass、0 fail、0 skip；其中 04 的投影→方案/编辑/媒体失败及 02 持久化桥两条均通过。04 当前环境未提供 `TEST_DATABASE_URL`，本轮本地复跑为 skip | 有真实数据库加合成数据的 04/02 接口证据；仍是假模型，不是实际平台或产品质量验收 |
| 真实模型 | 未选择或调用；无真实 token、媒体费用、延迟、错误率、质量数据 | D06/D08 未决，不宣称媒体理解、性格分析或回复质量达标 |
| 真实平台 | 未在微信或 QQ 上进行本次验证，未发送 | 不构成真实平台或产品验收 |

待总控协调的下一步：确定 02 元数据接口和 03 分析投影契约；将 02/04 PostgreSQL 组合回归保持在 CI 门禁；D06/D08 决定真实模型与本人标注后才执行小样本质量评测。D10/D11 的维度、关系阶段和更新门槛继续保持待定，不能把本报告的建议转成已确认需求。
