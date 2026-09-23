# 任务 07：集成测试与云端部署

## 任务目标

建立可复现工程、CI、测试环境、端到端验收、单机云部署、观测、备份恢复、故障演练和运行手册；持续维护 42 条 AC 的证据矩阵。07 验证各模块协作，不自行改变产品规则来让测试通过。

## 必读与范围

完整阅读 PRD v1.3、[README](../README.md)、[架构](../architecture.md)、[公共契约](../contracts.md)、[接入验证](../platform-validation.md)、[决策](../decisions.md)、[计划](../development-plan.md)及 01–06 交付记录。协作全部 AC；主责环境、跨模块 E2E、AC 证据真实性、AC23 关机验证和最终发布门槛。

负责根工程配置、`tests/{contracts,integration,e2e,fixtures}`、`deploy`、`docs/reports/acceptance-*` 与 runbook。模块 bug 回到对应 owner 修；公共契约变更交总控，不在测试夹具偷偷适配。

## 输入输出与依赖

输入为 01–06 的版本化端口、迁移、测试和交付记录。输出包括锁定依赖、CI、开发/测试 Compose、fake clock/model、mock adapter、迁移/启动检查、验收矩阵、部署配置模板、备份/恢复脚本和证据、事故/回滚手册。

依赖 D01 的真实平台、D06 的云/预算/SLO、D07 生命周期、D08 质量门槛。未决定前搭建本地和 mock 环境，费用相关选择只给可比报价与测量，不自行采购或部署付费生产资源。

## 实施要求

工程门禁：格式/类型/单元、contract schema 兼容、真实 PostgreSQL integration、移动端 E2E、依赖方向扫描、迁移检查、secret scan。所有测试/报告标环境与 adapter；mock pass 不能覆盖 real blocked。夹具使用合成/脱敏数据，不纳入真实账号 token。

故障注入至少覆盖 API/worker/DB/adapter/model 重启、outbox 重投、租约过期、重复/乱序事件、发送提交前/中/后断线、磁盘/存储错误、备份恢复。恢复顺序：保持 dispatch gate 关闭→数据库与媒体一致性→adapter reconcile→重放 inbox/outbox→失效过时 plan→人工审查未知结果→明确开启。

生产建议仍是单机 Compose，HTTPS、最小暴露端口、非 root 容器、secret 注入、健康/就绪检查、结构化日志和告警。可自行决定 CI 平台、反代和观测工具（优先少组件）；不得把单机称高可用、硬编码凭据、在备份未验证时上线、自动开启真实联系人或用删除失败日志掩盖 AC。

## 验收与交付

- development-plan 的 42 行均有 owner、状态、环境、commit、步骤、证据与限制；安全/权限/隔离/去重/接管用例全部通过才能自动试运行。
- 微信和 QQ 分别执行 AC23 及相关真实消息/媒体/本人发言/回执；平台不支持则清楚 blocked/fail。
- 从空环境部署、迁移、创建本人账号、暂停默认、mock smoke 可复现；备份恢复到独立环境并校验消息/版本/outbox/媒体一致性。
- 观测能以 correlationId 串起入站→快照→plan→确认→各 send task→receipt，日志不含 token/密码/完整敏感正文。
- 最终运行手册含启动/升级/回滚、全局暂停、未知发送处理、token 轮换、磁盘/费用告警、备份恢复和联系平台支持路径。
- 交付记录列镜像/依赖、测试命令和结果、AC 汇总（mock/wechat/qq 分栏）、容量成本测量、未解决 D 项、已知风险和 go/no-go 建议。
