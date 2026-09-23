# 任务 01：微信与 QQ 接入

## 任务目标

实现平台适配边界、完整 mock adapter，并对微信和 QQ 分别做真实接入 spike。负责连接、入站归一、媒体获取、发送执行、回执/回显、本人发言识别、断线同步和关机运行证据。不要把官方机器人/客服账号成功等同于本人原账号好友会话成功。

## 必读与范围

依次读根目录 PRD v1.3 的 §2–3、§5、§7、§9–11、§13–14，[架构](../architecture.md)、[公共契约](../contracts.md)、[接入验证](../platform-validation.md)、[候选可行性](../platforms/feasibility.md)、[复用评审](../platforms/github-reuse.md)、[决策](../decisions.md)、[计划](../development-plan.md)。主责 AC16、AC18、AC23；协作 AC03–07、AC17、AC20。

负责建议目录：`packages/platform/{mock,wechat,qq}` 及本任务的 `tests/integration/platform`、`docs/reports/platform-*`。不要修改 orchestration 业务规则；01 不判断是否可以恋爱/表白/承诺，只校验调用方、schema 和平台能力。

## 输入输出与依赖

实现 contracts 的 `PlatformPort` 和六类归一事件。输入 SendEnvelope 只能来自 02，必须原样携带 sendTaskId/sendKey。输出 CapabilitySnapshot 必须逐项标 `documented/tested/unsupported/unknown`，事件保留平台原始 ID、顺序、来源、引用、时间和脱敏诊断引用。

依赖总控提供 contracts/infrastructure；依赖本人提供测试账号、测试联系人和 D01 风险选择；与 02 对接未知结果/reconcile，与 03 对接媒体私有存储。平台契约不足时写变更提案，不私建第二套事件。

## 实施要求

先完成可注入重复、乱序、本人发言、agent 回显、延迟/矛盾回执、明确失败、结果未知、断线和能力缺失的 mock。随后按 platform-validation 执行双平台 spike；先使用测试账号/沙箱。真实 adapter 必须验签、防重放、保护凭据，并明确提交边界和可查询性。

可自行决定 adapter 内部 SDK 包装、重连退避、媒体缓存和平台错误映射；不得自行决定更换账号形态、接受封号风险、购买服务、修改首版平台、把未验证能力标为通过，或绕过 02 直接向 04/05/06 提供发送方法。

## 验收与交付

- contract tests 覆盖同一事件重复、乱序回执、本人/agent/回显三分、媒体缺失、连接恢复。
- 发送超时分清 definite failure 与 RESULT_UNKNOWN；后者先 reconcile，绝不换 sendKey 盲重发。
- 微信和 QQ 各一份实测报告及原始证据索引；AC23 各自记状态，mock 单列。
- 只有本人发言识别、未知回执、恢复同步、目标账号形态和关机测试均通过，才建议 `GO_AUTO`。
- 交付记录列出变更文件、依赖版本、凭据配置说明（无真实值）、测试命令/结果、能力矩阵、AC 状态、未验证项和公共变更提案。

完成后不要宣称整个平台已上线，不部署主账号自动发送；交由架构总控集成验收。
