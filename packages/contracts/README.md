# 公共机器契约 v0.3.0

当前状态只见 [开发计划 §0](../../docs/development-plan.md#0-当前状态每完成一个任务由总控更新本节)；本页保留模块说明与操作约束，不维护测试数字或进度。

`index.mts` 是 01–07 共用的 wire literal、类型和最小运行时断言；`schemas/` 是可供 HTTP/事件边界验证的 JSON Schema 2020-12。语义、状态转移、权限优先级只在 `docs/contracts.md` 定义。当前 schema 覆盖事件信封、来源不明自身消息、恢复报告和确认命令；其余业务对象需要随 provider 接线继续补齐，不能因类型存在就跳过后端权限检查。

新事件 `PlatformSelfMessageUnattributed` 不能降级为 `PlatformInboundObserved`。未知媒体类型不能改写为文字。`RecoveryReport.historyComplete=true` 仅在覆盖为 complete、无 gap 且有平台实测来源时由 01 产出；机器 schema 的结构约束本身不能证明平台能力。

本地检查：`node --test packages/contracts/index.test.mts`。07 的真实 PostgreSQL/HTTP 契约测试在 `tests/` 下独立运行。
