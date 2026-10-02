# 工程协作阅读入口

当前计划、进度、测试基线和阶段门槛只见 [开发计划 §0](development-plan.md#0-当前状态每完成一个任务由总控更新本节)。历史交付与实测证据保留在 docs/reports/，不作为当前状态入口。

阅读顺序：

1. [开发计划](development-plan.md)：先读 §0、§2，再读所领任务卡；任务卡决定本次范围、依赖和可改路径。
2. [PRD v1.3](../个人聊天代理%20AI%20PRD%20v1.3.md)与 [需求提取](requirements.md)：确认产品范围，区分已确认规则与待定建议。
3. [架构](architecture.md)：重点读 §2 模块权责与 §4 一致性边界。
4. [公共契约](contracts.md)与 [机器契约](../packages/contracts/README.md)：公共对象、事件、状态、端口和隔离规则。
5. [决策登记](decisions.md)：架构决定与 D01–D13；部署位置按开发计划推迟到 P5 决定。
6. 对应模块职责：[01 接入](tasks/01-platform.md)、[02 发送控制](tasks/02-orchestration.md)、[03 数据记忆](tasks/03-memory.md)、[04 AI](tasks/04-ai.md)、[05 Skill](tasks/05-skills.md)、[06 网页](tasks/06-web.md)、[07 集成](tasks/07-integration.md)。旧模块文档的阶段安排服从当前任务卡。
7. 按任务需要读 [平台验证](platform-validation.md)、[运行手册](../deploy/runbook.md)和任务卡引用的历史报告。

优先级：本人明确决定 > PRD v1.3 已确认规则 > 公共契约 > 模块实现。公共变更由总控协调，不能用技术文档悄悄改变产品范围。
