# v2 重构源码审计（2026-10-11）

需求基准：[用户提供的 v2.0 实施方案](reconstruction-v2-rfc.md)。该文件描述目标，不代表现有功能。本次按用户明确授权执行 P0/P1；未启用真实消息自动发送、未操作真实平台或向真实模型提交聊天。

以下差异表是P0审计基线。用户随后授权P2/P3，现已实现统一上下文和分层记忆，当前状态见 [P2/P3报告](reports/v2-p2-p3-2026-10-11.md)、[记忆契约](memory-engine-v2.md)；新增源码快照见 [P2/P3清单](reports/v2-source-inventory-p2-p3-2026-10-11.json)。

## 审计范围与当前实际架构

检查应用入口、模块依赖、数据迁移、平台接收与发送、编排、模型、上下文、资料联动、Android 主流程、部署脚本和验证入口。全库源文件清单扫描覆盖 `apps`、`packages`、`db`、`scripts`、`tests`、`deploy`、`.github`；排除依赖、缓存、构建产物及私有运行目录。文件路径、行数与内容校验值见 [源码清单](reports/v2-source-inventory-2026-10-11.json)。关键链路按调用与数据库依赖追踪，下列结论均以源码为依据。清单扫描不等于逐行正确性证明。

| 现有路径 | 入口与实现 | 实际职责 |
| --- | --- | --- |
| 电脑业务核心 | `apps/core/main.mts`、`apps/core/runtime.mts`、`packages/orchestration/postgres/confirmed-service.mts` | 原生 Node HTTP，持久化接收/聚合/生成/审批/发送协调；不是当前文档早期建议的 Fastify |
| QQ/微信桥接 | `apps/bridge/main.mts`、`apps/bridge/wechat-main.mts`、`packages/platform` | 平台归一化、原始事件持久化、自发/回显识别、媒体、连接恢复及唯一出站入口 |
| 电脑及手机网页 | `apps/web/src`、`apps/web/server/owner-http.mts`、`pg-owner-port.mts` | React/Vite 工作台、Cookie 会话、CSRF、Owner 命令 |
| 数据 | `packages/data/postgres/provider.mts`、`context-repository.mts`、`db/migrations` | PostgreSQL，联系人范围约束、消息/事实/证据/快照版本、删除与失效 |
| AI | `packages/ai/strategy/persistent-fake.mts`、`generation/deepseek-provider.mts` | 真实配置也沿用规则决策与规则检查，只把候选生成交给模型；尚无独立生产决策模型 |
| Android | `apps/android/app/src/main/java/cn/replyassistant` | 原生 Kotlin/Compose、SQLite、手机直接多模态请求、三候选、复制/填入、显式发送标记；独立于电脑 |
| 手机电脑联动 | `packages/link`、`apps/android/.../data/LinkClient.kt`、`0014_mobile_link.sql` | 带授权的资料/偏好同步、版本冲突与离线缓存；不是统一生成后端 |
| 运维与检查 | `scripts/local-stack*`、`deploy/runbook.md`、`package.json`、`.github/workflows/verify.yml` | 本地双桥接进程、迁移、备份恢复、单元/合同/真实隔离数据库/浏览器检查 |

当前电脑回复流：平台事件 → inbox/消息去重 → 已登记会话范围检查 → 持久化聚合 → Context 快照 → 规则决策/模型候选/规则质量检查 → 人工审批 → 持久化发送任务 → 发送边界与账本 → Bridge → 回执。Android 是另一条生成路径，不能把电脑检查通过算作 Android 的 v2 完成。

## 复用与差异映射

| 方案能力 | 可复用代码/存储 | 差异与处理 |
| --- | --- | --- |
| 平台统一事件、去重 | `packages/contracts`、QQ `normalize.mts`、微信 `reception.mts`、`infrastructure/postgres/event-store.mts`、`data_messages` | 保留现有 eventVersion=1，服务入口拒绝未知版本；不再建一份重复消息表。群参与者和复合媒体完整表达留后续 |
| 消息聚合 | `orch_conversations.collection_*`、`flushDue` | 原实现开始生成后清空 batch，重启仅取最后一条来信；P1 新任务保存完整 trigger ids 并据此恢复 |
| 会话隔离 | 平台账号映射、联系人 RLS、范围检查、generation/policy/dependency/skill epochs | 复用；P1 补本人自发及撤回/编辑的 revision 更新、任务绑定会话/联系人/账号及快照范围外键 |
| 统一回复任务 | `orch_plans`、`orch_confirmation_tasks`、`orch_send_tasks` | 原来状态分散，生成前没有独立任务；P1 增加 `orch_reply_jobs` 与迁移轨迹，关联旧表而非替代 |
| 幂等审批与发送 | `orch_owner_commands`、`orch_control_commands`、`dispatch_attempts`、`dispatch-journal.mts` | 保留同一发送权威；P1 补任务 revision 门禁、取消、版本开关及提交/送达区分 |
| 结果未知 | 原账本 `RESULT_UNKNOWN`、回执对账及人工处理 | 对外任务状态映射为 `UNCERTAIN`，保留禁止盲重试；新增 `SUBMITTED` 表示受理而未证实送达 |
| L1 近期上下文 | `PgDataProvider.buildContext/readContextProjection`、版本快照 | 可复用快照/权限；当前查询没有统一 token 预算，引用原生 ID 也未完整解引用，P2 改造 |
| L2 摘要/关系状态 | `data_analyses`、Android 原文摘录与 `ContextEngine.kt` | 电脑 `summaryRefs` 仍为空；摘录不等于增量摘要，需新增覆盖范围、证据、版本、未解决问题 |
| L3 长期记忆 | `data_facts`、`data_evidence`、修订/删除/失效机制 | 事实底座可用；关键词子串检索不是混合检索，没有 pgvector、记忆提取队列、冲突归并/TTL体系，P3 新增 |
| L4 风格 | `packages/data/feedback`、`generation/humanlike.mts`、Android `Personalization.kt` | 可复用真实表达/候选选择/编辑记录；须统一画像版本、来源与有效发送条件，不能用未发送草稿训练 |
| 决策/路由/生成/检查 | 现有 AI port、策略、候选 Gateway、Provider 与预算 | 保留接口；P4 独立 DecisionResult/DECIDING 阶段与模型路由。P1 先拒绝非法草稿/未知 action/越权字段 |
| 界面与反馈 | 现有工作台、原生回复面板 | P1 提供 API，暂不换 UI；P5 接入任务进度、上下文预览、记忆中心 |
| 回放与成本 | `packages/ai/eval`、模型预算/计量、合成测试 | 复用；P6 还需 150+ 场景、检索质量、性能与逐会话灰度验证 |

## 数据与 API 风险

- 迁移原有 0001–0014，本轮新增 0015，均增量变更；下一编号 0016。逻辑表名映射见 [迁移计划](migration-plan-v2.md)，不重命名旧表或回填旧计划为虚构 v2 历史。
- 编排表是单 Owner 部署模型；联系人数据有既有范围隔离。新 API 依赖配置 Owner + 会话认证，不把它宣称为多租户服务。多 Owner 托管需要单独的身份/行级权限改造。
- v1/v2 共用发送任务与账本。任何以后新增生成路径都必须从这里审批/发送，不能另开一个绕过门禁的发送队列。
- 旧计划把全部平台受理记录归为 `SENT`，新任务用 `SUBMITTED` 表达实际证据。旧 UI 语义暂保留，P5 应显示新状态；真实风格学习须使用送达或本人核对的最终文本。
- `pipeline_version` 只选择任务追踪路径，不代表自动发送授权。v2 一律进入人工审批；应用正常启动及异常恢复继续使用原权限/暂停机制。
- 新增 API 全部通过既有 session/CSRF/同源检查。读任务与读 trace 不会审批或发送。详情见 [API](api-v2.md)。

## 工作区、分支与回滚

开始前已存在大量未提交修改（首次检查为 78 个已修改跟踪文件、79 个未跟踪条目），其中包含手机 0.6.0 和电脑联动。保留这些内容，本轮在 `codex/v2-p0-p1` 分支实现，未批量提交或丢弃已有工作。现有快捷方式使用 `.local-workspace-release` 副本，源码变更不会自动更新实际运行版本。

按会话默认 `pipeline_version=1`；合成测试中显式切到 2。回滚以 API 切回 1，使未提交的旧候选与队列过期；保留发送中/已受理/未知结果的账本以对账。已经提交的平台调用不能撤销，回滚前必须先核对这些状态。不要删除已应用迁移或直接回退共享脏工作区；先保留完整工作区，再按本轮 diff 选择撤回源码。

## 本轮完成边界与后续顺序

P0 交付本审计和 [兼容架构](architecture-v2.md)、[回复管线](reply-pipeline-v2.md)、[记忆设计](memory-engine-v2.md)、[迁移计划](migration-plan-v2.md)、[API](api-v2.md)。P1 增量实现与实际检查见 [交付报告](reports/v2-p0-p1-2026-10-11.md)。P2/P3 是后续优先工作；本轮不把长期记忆、独立决策模型、Android 共用后端或 UI 宣称为已实现。

当前后续状态：P4/P5已增量实施并通过899项完整验证，详见[P4/P5交付报告](reports/v2-p4-p5-2026-10-11.md)与[本轮源码索引](reports/v2-source-inventory-p4-p5-2026-10-11.json)。初始审计比较和历史索引保留。

当前P6离线验收/灰度演练已完成，修复记忆检索排名和批量证据校验，新增按模型用量汇总；完整验证912项通过，真实模型/真人/实际联系人上线仍待验。见[P6报告](reports/v2-p6-2026-10-11.md)、[数值证据](reports/v2-p6-evidence-2026-10-11.json)和[源码索引](reports/v2-source-inventory-p6-2026-10-11.json)。
