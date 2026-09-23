# 03 数据与个人记忆：首段交付记录

日期：2026-09-23。基线：PRD v1.3、`docs/contracts.md` v0.2.0。任务仍为进行中。

## 已实现

- `packages/data/context/store.mts`：Contact 的平台账号/外部联系人唯一性；Message 的平台消息键与事件键去重、来源/模式记录、稳定截止排序；`buildContext` 同时返回不可变 Snapshot 与按 caller contact、联系人和 allowedScopes 裁剪的 Projection，含 generation、cutoff、policyVersion、引用版本及内容 hash。
- 有效事实按联系人和 global scope、本人授权范围、有效期与确认状态查询；候选、模型推测和 AI 生成内容不自动成为有效本人事实。本人消息候选必须引用同联系人的真实本人消息。事实更正/删除采用 expectedVersion，删除正文和证据引用并发出无正文失效记录。
- 消息删除清除正文/媒体引用，关联事实删除、分析失效、旧快照不可再读取；新增事实或分析也失效旧快照。来源 unknown 只有带证据、带版本更正为 owner/agent，保留更正记录，旧投影失效。
- `packages/data/context/store.test.mts`：9 项测试覆盖去重及冲突、跨联系人/scope、有效期边界、纠正和删除传播、本人事实候选来源、未来消息与 trial/replay 隔离、旧快照失效、unknown 来源更正。

测试命令：`node --test packages/data/context/store.test.mts`，9 pass / 0 fail。Node v24.15.0。未执行 TypeScript 静态检查：当前工作区未安装 tsc，未为本专项修改根配置或下载依赖。

## 模块交接

02/04：`buildContext({callerContactId,contactId,cutoffTime,cutoffMessageId?,generation,allowedScopes,policyVersion})` 返回 `{snapshot,messages,facts,analyses}`。02 拥有名单门控、generation、policyVersion 及最终 preflight；03 不授予发送权限。快照中的 refs 均有 id/version，调用者必须保存并在方案及发送前复核。`listInvalidations(afterSequence)` 是内存事件替身，不能作为生产 outbox。

06：本人跨联系人的管理查询须经 API 鉴权并设计独立 owner 查询端口；当前 `callerContactId` 是 02/04 的单联系人上下文能力，不可直接暴露给网页。

## 尚未完成及公共缺口

- 当前无 PostgreSQL 基线、编号迁移和公共机器 schema。内存 Map 不能证明跨进程幂等、事务/outbox、重启一致性或数据库级隔离。正式迁移需由总控统一编号；不要把此实现认作 AC09/AC21 的产品验收。
- `AtomicReceptionPort`、`DispatchJournal` 属总控与 03 的共同事务基线，尚未落地。01 真实接入前须完成；本模块仅能在 02 已认证、已名单门控后接纳 Message。
- `storeMedia`、`ApprovedAssetPort`、媒体解释、摘要、完整分析快照、反馈、审计、历史导入预览/提交尚未实现。D05 缺导出样本，D07 保留/备份删除周期待定；对应 AC22 和删除备份验收阻塞。
- 当前分析对象只是带依赖引用的有效性替身，不能代表 D10/D11 的正式分析。Message 的稳定顺序在替身中以 `sentAt/platformEventId/platformMessageId/id` 排序；正式 adapter 若提供更准确的原平台顺序键，应在公共类型与迁移中固定。
- 公共契约 v0.2.0 已说明 Snapshot/Projection，但尚未指定 `readContextProjection` 的复核方法、本人查询端口及过期事实导致的同步失效 epoch。建议总控在机器契约中定义这三个接口；当前实现以读取时拒绝及事件替身表达行为。

AC 状态：AC08、09、21、29、31 只有模块级部分证据；AC22 等待格式样本；其他与 02/04/06/07 联合验收尚未开始。没有真实平台或部署验收证据。

## 同日续作：持久化基础与后续能力

状态仍为 In progress，公共契约仍为 v0.2.0；没有修改公共契约、跨域业务状态或全局迁移。仅改 `packages/data/**` 和本交付记录/03 提案。

### 已完成

- 修复事实纠正、删除、过期后依赖它的分析未同步失效的问题；分析证据现在可以引用同联系人消息或获授权事实，拒绝 AI 发言作为分析证据。新增 `searchFacts`，先调用联系人及 scope 裁剪，再执行文本匹配。
- `packages/data/postgres/schema.proposed.sql`：03 对象的 PostgreSQL 表、唯一键、来源/模式约束、scope 与证据索引草案。`postgres/context-repository.mts`：消息、事实、关键词、有效分析的参数化读取 SQL，在发送查询前校验 `callerContactId === contactId`，SQL 本身也限制 contact/scope。真实数据库事务、RLS、编号迁移及写端尚待总控审批和集成。
- `imports/service.mts`：格式中立预览联系人、首末时间、数量、解析异常；确认本人/对方映射和范围后才导入；固定 `mode=import`，按源 hash 幂等，平台消息键再次去重。它不持有 01/02 的发送端口。D05 原始导出样本未到，尚无具体解析器；当前内存作业状态不跨重启，也不保证批量提交原子性。
- `media/file-store.mts`：私有目录保存原始字节和 sha256，重新实例化可读取；消息联系人验证、联系人私有读取、表情批准版本与平台检查、删除字节。当前不含 04 的解释持久化，不具备数据库元数据事务和备份策略。
- `feedback/file-journal.mts`：按 02 的 plan→contact 解析器绑定联系人，单文件 `wx` 写入，幂等键去重，可跨实例重读；包含原候选、最终内容、动作、理由/评分、来源。生产上仍须改用同库事务与 02 方案状态关联，避免单机文件和数据库状态分叉。
- 提交给架构总控的提案：`docs/reports/03-data-contract-proposal-2026-09-23.md`，覆盖同步依赖 epoch、投影复核、本人查询端口、数据库角色/迁移编号、兼容与回滚。

### AC 证据与测试

命令：`node --test packages/data/context/store.test.mts packages/data/imports/service.test.mts packages/data/media/file-store.test.mts packages/data/feedback/file-journal.test.mts packages/data/postgres/context-repository.test.mts packages/orchestration/integration/mock-ports.test.mts`。Node v24.15.0；15 pass / 0 fail（03 模块 14，02/03/04 mock 联调 1）。所有测试均为 unit/mock 开发夹具，没有实际 PostgreSQL 或真实平台证据。

| AC | 本次证据 | 状态 |
| --- | --- | --- |
| AC08 | 有效期边界已有测试；依赖分析随事实变更失效 | unit 部分通过；02 暂停待办未联测 |
| AC09/31 | 内存查询、事实检索和 PG SQL 适配的伪造联系人负测；媒体/反馈私有读取负测 | unit 部分通过；数据库级隔离未验 |
| AC21/29 | 事实更正/删除/过期失效上下文及分析；媒体字节删除 | unit 部分通过；摘要/索引物化清理、02 待发方案、备份仍未验 |
| AC22 | 通用预览、身份映射、重复源幂等、import/live 隔离 | 框架 unit 部分通过；D05 格式及跨重启导入事务 blocked |
| AC07 | 批准版本、允许平台和私有字节摘要复核 | unit 部分通过；02/01 发送链未联测 |

### 待解决风险和 D05/D07

- **G0 公共基线**：当前无机器 schema、`pg` 事务装配、正式编号迁移、outbox/inbox、数据库级隔离策略和可重启的 03 消息/事实/导入持久写端。SQL 草案不得直接部署。`AtomicReceptionPort` 与 `DispatchJournal` 的跨域事务须总控批准。当前功能不能宣称生产持久化或 AC09/21 完整通过。
- **D05**：仍需本人提供脱敏原始导出样本及身份对应方式。未猜微信/QQ 导出格式。格式解析、原始文件处理、导入事务及失败恢复待定。
- **D07**：消息、媒体、反馈、审计、导入源、备份的期限与清除周期尚未决定。当前文件存储无生产备份清除证明；删除在开发目录有效，不构成备份物理清除承诺。
- **对接**：02/04 可继续使用现有 `buildContext` 投影和新增事实检索/分析失效；同步 epoch、正式 `readContextProjection` 契约、owner 查询端口与真实 PG 联测等待总控采纳提案。导入模块不提供任何 SendTask 接口，但实际数据库约束及 02 联合负测尚未完成。
