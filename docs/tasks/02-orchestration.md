# 任务 02：会话流程与发送控制

## 任务目标

实现联系人准入、策略与版本、确认/自动模式、聚合/延迟/不回复、主动联系、表白专项授权、人工接管、暂停、失效、发送调度和恢复。02 是唯一业务发送授权和调度入口，每个 ReplyPart 提交前重新检查。

## 必读与范围

依次读 PRD v1.3 §4–6、§9–13、§14，[架构](../architecture.md)、[公共契约](../contracts.md)、[决策](../decisions.md)、[计划](../development-plan.md)。主责 AC01–05、AC07、AC10–15、AC17、AC19–20、AC24、AC30、AC33–34、AC38；协作 AC08、AC16、AC18、AC21–23、AC35–42。

负责 `packages/orchestration/{policy,conversations,scheduling,dispatch}`、相关 API command handler 与本模块测试。联系人/消息正文由 03 存；模型由 04；技能由 05；平台动作由 01；UI 由 06。

## 输入输出与依赖

消费 platform/control/fact/analysis/skill 事件和 04 ReplyPlan 提案；实现 contracts 的 OrchestrationPort、ConversationControl、ContactPolicy、ReplyPlan、ConfirmationTask、SendTask 状态。只通过 PlatformPort.submitSend 出站。所有命令支持 idempotencyKey、expectedVersion、correlationId。

需要 03 的 ContextSnapshot/依赖版本，04 的结构化 Decision/候选，05 的调用版本，01 的 Capability/receipt/reconcile，06 只提交 owner 命令。当前 D03 未定时使用 decisions.md 的保守默认；D04 参数保持运行时配置且生产主动联系默认关闭。

## 实施要求

业务状态/outbox 同事务；按联系人 generation/CAS 串行协调，模型调用不持锁。新消息、owner 发言、策略变化、暂停、事实/分析/skill 失效必须同步提高版本或 epoch，使旧计划即使漏收事件也过不了 preflight。多条方案按 sequence 逐条检查；提交后的未知状态阻塞该联系人，未提交余条取消。

权限规则使用显式 policy/risk evaluator，不由模型置信度决定。可以自行选择内部 reducer、scheduler 和租约实现；不得改 PRD 权限、把确认当长期授权、自动恢复人工接管、在结果未知时重发、允许 01/04/05/06 创建 SendTask，或把“不回复”当禁用联系人。

## 验收与交付

- 组合/表驱动测试覆盖普通、主动、表白、约见承诺、关系决定、未知事实、停止请求、全局/单人暂停。
- 虚拟时钟覆盖聚合、窗口、延迟、冷却；并发测试覆盖新消息与确认、暂停与发送、部分发送、重复命令、worker 重启。
- mock E2E 完成 contracts §6；AC01–05、10–20、24、30、33–34、38 有证据；安全项失败即禁止自动模式。
- 状态查询提供 allowedActions 与可解释 reason，不泄露模型内部推理。
- 交付记录包含迁移/状态图差异、测试与 AC、D03/D04 使用的临时配置、限制和公共变更提案。

完成后交总控逐阶段集成；不要自行开启真实联系人自动模式。
