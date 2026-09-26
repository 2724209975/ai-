# 工程协作基线

需求基线为根目录《个人聊天代理 AI PRD v1.3.md》。截至 2026-09-24，01–07 均在开发（D12/D13 未定）；公共契约 v0.3.0、全局迁移 `0001`–`0009` 和本地确认闭环已落盘。最新完整本机门禁记录为 208 unit、9 contract、24 PostgreSQL integration、13 E2E 和网页构建通过，0 fail/skip；远程 CI 尚未运行，42 条完整产品 AC 均未判通过。见 [07 G2 集成记录](reports/07-g2-integration-2026-09-24.md)和 [验收矩阵](reports/acceptance-matrix.csv)。

**2026-09-26 工程进展**：生产核心组合根落盘（`apps/core`、`npm run serve:core`）：本人管理 API + 聚合/收集 + 05 Skill 内部 outbox，**结构上不能派发**（派发只在各平台账号桥接），默认启动即暂停、配置失败关闭、单行 JSON 日志带 `X-Request-Id`。最新完整本机门禁为 **234 unit、10 contract、29 PostgreSQL integration、22 E2E 与网页构建，0 fail/skip**。见 [00 核心组合根记录](reports/00-control-core-root-2026-09-26.md) 与 [A22](decisions.md)。远程仓库仍未配置，首次远程 CI 仍无证据。

**2026-09-24 平台实测更新**：QQ 侧只接收 + 两次受控真实发送已实测，判定 CONDITIONAL（[报告](reports/platform-qq-2026-09-24.md)）；微信侧经**离线偏移移植**后只接收实测通过——捕获文字/图片/语音并全部带平台消息 ID，能力快照只有 `receive_types` 为 `tested`、总体仍 `unknown`（[记录](reports/platform-wechat-wxhelper-2026-09-24.md)｜[快照](reports/platform-wechat-capability-snapshot-2026-09-24.json)）。生产部署与 AC23 关机运行仍未验收，最新状态见开发计划与 [decisions.md](decisions.md)。

**接入续作**：QQ 又取得一次系统发送与回显精确平台 ID 对照，来源能力仍 unknown；微信只接收已接入 `apps/bridge`、持久 inbox/outbox 与 02，前次真实字节离线重放和本轮新实时文字入站均通过，发送仍关闭。最新完整本机门禁为 **212 unit、9 contract、27 PostgreSQL integration、13 E2E 与网页构建，0 fail/skip**。见 [QQ 来源专项](reports/qq-self-origin-2026-09-24.md) 与 [微信接入报告](reports/wechat-receive-bridge-2026-09-24.md)。

阅读顺序：

1. [需求提取与现状](requirements.md)：已确认范围与建议的区别。
2. [架构](architecture.md)：模块归属、技术建议和目录。
3. [公共契约](contracts.md)：对象、端口、事件、状态与一致性，唯一公共契约定义。
4. [开发计划与 42 条验收映射](development-plan.md)：阶段、任务状态、集成门槛。
5. [决策与待定问题](decisions.md)：D01–D13 的唯一决策登记处。
6. [真实接入验证](platform-validation.md)：权威状态、能力矩阵、实测步骤；[候选可行性](platforms/feasibility.md)和 [GitHub 复用评审](platforms/github-reuse.md)是补充调研，不改变未验证状态；[QQ spike 计划](platforms/qq-spike-plan.md) 是 G2 入口的决策清单与执行顺序。
7. [01 接入](tasks/01-platform.md)、[02 发送控制](tasks/02-orchestration.md)、[03 数据记忆](tasks/03-memory.md)、[04 AI](tasks/04-ai.md)、[05 Skill](tasks/05-skills.md)、[06 网页](tasks/06-web.md)、[07 集成部署](tasks/07-integration.md)：整份内容可复制到独立开发任务。

优先级：本人后续明确决定 > PRD 已确认规则 > 公共契约 > 模块实现。发现冲突先记录影响，不能用技术文档悄悄修改产品范围。PRD 的待定条目不因本文存在而自动确认。

后续公共改动由架构总控协调：先更新 contracts.md 与 decisions.md，再更新受影响任务和测试。任务文档不复制完整公共类型；[packages/contracts](../packages/contracts/README.md) 是首批机器可读实现，必须与 contracts.md 在同次变更同步。历史交付报告保留当时版本，不作为当前公共定义。
