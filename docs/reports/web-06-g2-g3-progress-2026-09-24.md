# 06 G2/G3 管理端状态消费准备

日期：2026-09-24。契约基线：docs/contracts.md v0.3.0；连接/恢复新增字段仍是总控审查通过的**只读方向提案**，正式公共 schema 尚未冻结。

## 本轮改动

- apps/web/src/App.tsx 将 02 的 AUTO_REVIEW_UNAVAILABLE 明确显示为“自动模式暂未开放，本轮转人工确认”；OWNER_ORIGIN 与 actor=unknown 显示来源未明和人工核对，不能据此判为本人或 agent。未知发送、部分发送按 02 的逐条状态警示，SUBMITTED 仍只表示平台接受。
- 总览区将“全局调度未暂停”与平台连接状态分开。当前 02 ownerOverview 返回 connections:[]、faults:[]，但没有查询覆盖证据，页面显示“连接/恢复与故障查询尚未接入，无法判断”，不把空数组当无故障或微信/QQ 已连接。
- 对拟议的只读连接/恢复投影，页面仅在后端提供时展示 connectionState、验证状态、最近核对、historyComplete、缺口和未决发送数量；缺字段维持未知。消息的安全 originEvidenceRefs 仅作为引用文字展示。
- 409 的旧内容未发送提示只用于旧候选确认；其他冲突提示状态已变化。503 显示依赖故障或发送结果未知，501 明示持久 provider 未提供。/skills、/imports、/faults 仍由后端真实返回 501，不插入演示数据。
- apps/web/server/g2-mobile-browser.test.mts 增加合成 HTTP 浏览器回归；docs/reports/web-06-g2-g3-proposal-2026-09-24.md 列出最小 Owner 查询提案。总控已认可只读、可选字段与 fail-closed 方向；01 已确认 01 RecoveryReport 的 coverage/historyComplete/gaps/unresolvedSends 语义可作来源，但真实 provider 尚未接入。正式字段由总控协调。
- 03 后续提供按联系人 scope 裁剪的 listUnknownOrigins：06 页面只在 02 将 messageId/contactId 对齐后的会话投影含 originEvidenceRefs 时显示不透明引用，不读取 provenance 或原始路径。02 新增 approvalSource 后，mock_auto 发送记录显示“自动决策（仅 mock 平台）”，owner_confirmation 显示“本人确认”；未知来源仍保持人工核对与暂停语义。

## 验证与证据

| 项 | 结果 | 性质 |
| --- | --- | --- |
| apps/web npm run build | TypeScript 与 Vite 构建通过，产物 build | 静态构建 |
| 320px Chromium | 旧 overview 缺 coverage 时显示未知；未知发送警告、自动模式退回确认、旧候选 409、来源未明/不透明证据引用、mock_auto 标记与结果未知会话；无横向溢出 | 合成 HTTP UI 回归，pass |
| 390px Chromium | 503 不能变成“暂无待办”；/skills、/imports、/faults 的 501 显示不可用；新投影 reconciling、historyComplete=false 与 gap 可见；无横向溢出 | 合成 HTTP UI 回归，pass |
| apps/web/server/owner-http.test.mts | 无会话/CSRF 被拒，409 保持冲突且不声称已发送；/skills、/imports、/faults 真实路由均返回 501 且未调用 provider；2 pass | HTTP adapter 单测 |
| 微信/QQ 真实账号 | 未运行 | blocked |

本轮三项 Chromium 回归 **3 pass / 0 fail**；HTTP adapter 测试 **2 pass / 0 fail**。截图：[320px 总览](../../apps/web/evidence/g2-overview-320.png)、[390px 501 页面](../../apps/web/evidence/g2-faults-501-390.png)。截图和合成响应只证明页面表达，不能算 01 能力、真实登录持久性或平台验收。

## 待集成

1. 01/02/总控：按公共 PlatformAccount、能力快照和 RecoveryReport 完成受控 Owner 账号投影，显式报告查询覆盖；historyComplete=true 必须有连续历史证据，不能沿用 mock CONNECTED。02 将来源未明与恢复证据通过会话投影裁剪，allowedActions 始终由后端计算。
   02 尚未将 03 的 listUnknownOrigins 合入 ownerConversations；现阶段真实 Owner HTTP 响应不会出现 originEvidenceRefs，浏览器断言使用明确标记的合成投影。
2. 03/05/总控：/imports、/skills、/faults 的持久查询与命令 provider 尚缺；501 保持。具体请求体需公共 schema 审定。
3. 07：在真实 HTTP→PostgreSQL→mock 流程增加断线/恢复、来源 unknown、结果未知与会话过期注入；320–390px 合成 HTTP 测试不能替代真机、慢网和真实平台。
4. D01 QQ/微信个人账号及常在线宿主验证仍未完成。确认模式和 mock 发送的 G1 通过不能升级为真实自动模式或 AC23。

本轮只修改 apps/web 与 docs/reports；无数据库迁移、公共契约或 01/02 权限逻辑改动。
