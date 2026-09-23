# 04 交付 07：PostgreSQL 命令行闭环 fake 智能端口

日期：2026-09-23。范围：只改 `packages/ai` 和本报告；未改 02、03、07，不调用真实模型或平台发送。

## 可导入入口

- `createPgPersistentFakeIntelligence({ pool, data })` 从 `packages/ai/index.mts` 导出，返回与 02 `PgConfirmedService.PersistentIntelligence` 一致的 `propose` 和 `checkEdited`。07 的调用示例写在 `packages/ai/README.md`。
- 适配器按快照 ID 经 03 `getDependencyEpoch` 和 `readContextProjection` 在同一个只读意图事务中取完整裁剪上下文，核对 contact、conversation、generation、policyVersion、hash 及消息/事实/分析引用。02 的 `ProposedContext` 缺消息类型、时间和证据，不被当作 04 的模型输入。
- 文字路径沿用现有 fake 决策、1–3 候选、候选检查和本人编辑后检查；只返回策略、方案和风险。02 分配持久 ID、确认与发送任务，并执行最后授权。
- 无可靠媒体解释时不生成候选，向 02 返回 `media_uncertain`；无依据本人事实返回 `unknown_fact` 或编辑检查的 `MISSING_FACT`。模型异常保持显式错误，不能转成可发送的空结果。

## 验证

| 层级 | 结果 | 限制 |
| --- | --- | --- |
| 离线 fake | `node --test packages/ai/index.test.mts packages/ai/strategy/persistent-fake.test.mts`：28 pass / 0 fail；02 mock 与 05 裁剪联调：5 pass / 0 fail | 覆盖完整投影读取、快照不匹配、结构化候选、编辑后缺事实、未解图片停用方案；尚非真实 PostgreSQL 服务联测 |
| 时间截断 | `node packages/ai/eval/time-cutoff.mts`：12/12 夹具不含 cutoff 后消息 | 仅 fake 离线夹具，不证明回复质量 |
| 真实模型 | 未选型、未调用，无 token、媒体费用、时延或质量数据 | D06/D08 仍待定 |
| 真实平台 | 未接微信或 QQ，未发送 | 07 命令行闭环目前目标为 PostgreSQL + mock 平台，不能计真实平台验收 |

公共契约保持 v0.3.0；本段未新增公共字段。D10/D11 的性格维度、关系阶段和更新门槛继续待定。剩余对接由 07 将端口传入 `PgConfirmedService` 并运行隔离 PostgreSQL + mock 端到端测试；04 不提供发送凭据或自动发送放行结论。
