# 工程协作基线

需求基线为根目录《个人聊天代理 AI PRD v1.3.md》。截至 2026-09-24，01–07 均在开发（D12/D13 未定）；公共契约 v0.3.0、全局迁移 `0001`–`0009` 和本地确认闭环已落盘。最新完整本机门禁记录为 208 unit、9 contract、24 PostgreSQL integration、13 E2E 和网页构建通过，0 fail/skip；远程 CI 尚未运行，42 条完整产品 AC 均未判通过。见 [07 G2 集成记录](reports/07-g2-integration-2026-09-24.md)和 [验收矩阵](reports/acceptance-matrix.csv)。

**2026-09-26 工程进展**：生产核心组合根落盘（`apps/core`、`npm run serve:core`）：本人管理 API + 聚合/收集 + 05 Skill 内部 outbox，**结构上不能派发**（派发只在各平台账号桥接），默认启动即暂停、配置失败关闭、单行 JSON 日志带 `X-Request-Id`。最新完整本机门禁为 **234 unit、10 contract、29 PostgreSQL integration、22 E2E 与网页构建，0 fail/skip**。见 [00 核心组合根记录](reports/00-control-core-root-2026-09-26.md) 与 [A22](decisions.md)。远程仓库仍未配置，首次远程 CI 仍无证据。

**2026-09-26 主线推进**：微信桥接接上出站派发（默认关闭，`WECHAT_ENABLE_OUTBOUND=1` 才装配），并与核心、手机网页一起在本机走完一次主线：合成入站 → 3 个候选 → 手机页面确认 → **桥接**提交（核心不派发）→ `RESULT_UNKNOWN` → 联系人暂停 → 人工核对 → 显式恢复。同批修复「全新库 `pause_epoch=0` 导致第一次恢复返回 400」的缺陷。最新完整本机门禁为 **238 unit、10 contract、31 PostgreSQL integration、22 E2E 与网页构建，0 fail/skip**。见 [微信出站接入与主线演练](reports/wechat-bridge-dispatch-2026-09-26.md) 与 [A24](decisions.md)。真实发送仍待逐条授权，真实模型待 D06。

**2026-09-26 真机主链跑通**：在测试小号（客户端 3.9.11.25 + 移植 DLL `9F1A96D9…`，`checkLogin=1`、`hookSyncMsg=0`）与知情测试好友上走完整条确认模式主线：真实来信 → 候选 → **本人点「确认并发送」** → 桥接经真 helper 提交 → `RESULT_UNKNOWN` + 联系人暂停 → **本人核对好友已收到** → 页面记「已送达」→ 显式恢复为 `READY_CONFIRM`。核心全程未派发。同批补上 06 缺失的「核对结果」入口（记已送达 / 记明确失败 + 证据）与 `scripts/owner-resolve-send.mts`。见[真机记录](reports/wechat-real-send-2026-09-26.md)。边界：回执仍无平台消息 ID、候选仍是持久 fake、AC23 与 42 行矩阵不变。

**2026-09-26 真实模型接入**：首个真实模型选定 **DeepSeek**（[A25](decisions.md)），经 04 的 `TextModelProvider` 契约落地；同时修订 04 内部端口，让生成阶段能拿到策略投影（目标/限制/表达偏好）。决策、事实与边界检查仍是确定性实现——模型只出候选文本，02 的确认、租约、账本与未知结果处理一行未改。密钥只从 `DEEPSEEK_API_KEY` 读取，不进配置对象、日志与错误，缺密钥启动即失败。最新完整本机门禁 **244 unit、10 contract、31 PostgreSQL integration、22 E2E 与网页构建，0 fail/skip**。见 [DeepSeek 接入记录](reports/deepseek-provider-2026-09-26.md)。未完成：**尚未发出真实 API 调用**（等密钥），成本/时延/限流与月预算上限未定。

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
