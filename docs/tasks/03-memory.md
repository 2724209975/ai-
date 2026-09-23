# 任务 03：数据与个人记忆

## 任务目标

实现消息、媒体元数据、上下文快照、个人事实/记忆、证据依赖、分析快照存储、反馈、历史导入和审计。隔离必须发生在存储查询与检索阶段，不能把“别泄露”留给提示词。

## 必读与范围

依次读 PRD v1.3 §7–8、§10–13、§14–15，[架构](../architecture.md)、[公共契约](../contracts.md)、[决策](../decisions.md)、[计划](../development-plan.md)。主责 AC08–09、AC21–22、AC29、AC31；协作 AC01、AC05–07、AC15–18、AC25–28、AC32、AC34、AC39–42。

负责 `packages/data/{messages,facts,context,imports,media,analyses}`、编号数据库迁移、对应 integration tests。不要拥有 ContactPolicy 或 SendTask 的业务状态写权限；跨域迁移提交总控审批。

## 输入输出与依赖

实现 DataContextPort 与 contracts 中 Contact/Message/MediaAsset/Fact/ContextSnapshot/AnalysisSnapshot/Feedback/ImportJob/AuditEntry。输入来自 01 观察、02 命令与 04/05 结构化结果；输出必须是经过 caller contact + factScopes 双重裁剪的不可变快照，并带 cutoff/generation/version/hash。

与 02 对接依赖失效事件，与 04 对接证据和分析，与 06 对接查询/纠正/删除，与 07 对接备份恢复。D05 样本未到前只做 preview/adapter 框架；不得猜导出格式。D07 未定时使期限可配置并清楚标注非生产政策。

## 实施要求

区分 owner-confirmed、owner-message candidate、model inference、agent-generated；agent 内容不能成为本人事实，采用候选不自动确认。事实有 scope、来源、证据、有效期与删除状态。删除/过期必须让摘要、索引、上下文、分析及关联待发方案失效；正文清除后审计只留无正文墓碑。

导入固定 `mode=import`，先预览联系人/时间/数量/异常、本人/对方映射和范围；基于源 hash+平台消息 key 去重；任何路径都不能发布 live 发送触发。可自行决定 SQL 索引、分页和摘要缓存；不得跨联系人检索、保存凭据、无期限复制删除正文、执行导入文件代码、把历史 AI 文本当本人真实发言。

## 验收与交付

- 数据库级与服务级隔离负测：伪造 contactId/scope/直接 query adapter 均不能取得 A 的私密内容给 B。
- 有效期边界、纠正、删除传播、摘要/索引清理、并发更新、重启一致性测试。
- 重复导入幂等，import/trial/replay 无法创建 SendTask；样本未确定时 AC22 可验证通用框架但具体格式标 blocked。
- 能从方案追踪所用消息/事实/分析/技能版本，同时删除正文后不可再使用。
- 交付记录包含 schema/迁移、数据字典差异、查询边界、测试与 AC、D05/D07 阻塞和公共变更提案。
