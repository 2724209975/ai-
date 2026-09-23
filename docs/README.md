# 工程协作基线

需求基线为根目录《个人聊天代理 AI PRD v1.3.md》。截至 2026-09-23，01–07 均在开发（05 已启动骨架，D12/D13 未定）；公共契约 v0.3.0、G0 PostgreSQL 底座与全局迁移 `0001`–`0004` 已落盘，本机隔离 PostgreSQL 17.11 的 3 项真实用例通过。尚无微信/QQ 真实接入或生产部署验收，最新状态见开发计划。

阅读顺序：

1. [需求提取与现状](requirements.md)：已确认范围与建议的区别。
2. [架构](architecture.md)：模块归属、技术建议和目录。
3. [公共契约](contracts.md)：对象、端口、事件、状态与一致性，唯一公共契约定义。
4. [开发计划与 42 条验收映射](development-plan.md)：阶段、任务状态、集成门槛。
5. [决策与待定问题](decisions.md)：D01–D13 的唯一决策登记处。
6. [真实接入验证](platform-validation.md)：权威状态、能力矩阵、实测步骤；[候选可行性](platforms/feasibility.md)和 [GitHub 复用评审](platforms/github-reuse.md)是补充调研，不改变未验证状态。
7. [01 接入](tasks/01-platform.md)、[02 发送控制](tasks/02-orchestration.md)、[03 数据记忆](tasks/03-memory.md)、[04 AI](tasks/04-ai.md)、[05 Skill](tasks/05-skills.md)、[06 网页](tasks/06-web.md)、[07 集成部署](tasks/07-integration.md)：整份内容可复制到独立开发任务。

优先级：本人后续明确决定 > PRD 已确认规则 > 公共契约 > 模块实现。发现冲突先记录影响，不能用技术文档悄悄修改产品范围。PRD 的待定条目不因本文存在而自动确认。

后续公共改动由架构总控协调：先更新 contracts.md 与 decisions.md，再更新受影响任务和测试。任务文档不复制完整公共类型；[packages/contracts](../packages/contracts/README.md) 是首批机器可读实现，必须与 contracts.md 在同次变更同步。历史交付报告保留当时版本，不作为当前公共定义。
