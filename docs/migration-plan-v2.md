# v2 数据迁移与回滚计划

## 逻辑表映射

| RFC 逻辑表 | 复用实际存储 / 本轮处理 |
| --- | --- |
| accounts / contacts / conversations | `orch_platform_accounts` + `data_contacts` + `orch_conversations`；保留原名称与权限 |
| messages / message_events | `data_messages`、inbox/raw event/outbox 与 `data_platform_message_mutations`；不复制原始消息 |
| message_batches | `orch_conversations.collection_*` + 新任务 trigger_message_ids；不另建第二个聚合队列 |
| reply_jobs | 本轮新增 `orch_reply_jobs`、`orch_reply_job_transitions` |
| reply_candidates | `orch_plans.alternatives` 及确认任务，后续按 API DTO 统一呈现 |
| send_jobs | `orch_send_tasks` + `dispatch_attempts` + 原 outbox；发送权威保持原实现 |
| decision_records / summaries / relationship_states | 0016新增data_conversation_summaries/data_relationship_states；独立Decision留给P4 |
| memory_items / memory_evidence / style_profiles | 0016新增记忆元数据/任务/向量/风格/控制；复用data_facts/data_evidence及原反馈账本 |
| user_feedback / model_calls / audit_events | 复用已有反馈、计量与日志；P4–P6 统一结构、来源和检索 |

## 0015：P1 增量迁移

新增会话 `pipeline_version`（默认1，限定1/2）、`current_reply_job_id`；新增任务记录/状态轨迹表，建立同一会话/联系人/账号的复合约束及索引。任务的 Plan 与 Context Snapshot 必须属于相同范围。快照 conversation UUID 和编排 text ID 用生成 UUID 列对齐，保留现有类型。

迁移不改写聊天正文、不移动发送账本、不删除旧字段，不回填虚假的v2任务历史。新P4/P5源码readiness需要0017；先隔离验证，部署时停止业务worker、备份数据库/私有文件，再迁移和发布。迁移工具保持checksum约束，不修改已应用0001–0015。下一编号0018。

## 0016：P2/P3 增量迁移

Context快照增加统一包，facts增加memory_owner_id归属及explicit-statement/imported-unverified来源分类。新增记忆元数据、Embedding副本、提取任务、增量摘要、关系、全局/联系人风格、记忆开关/有效期、幂等命令表；建立同一Owner/联系人/会话/账号复合外键和RLS。

消息/事实删除触发器同步清理正文衍生物，使用迁移角色拥有的SECURITY DEFINER函数和迁移时固定search_path；迁移拥有者需具备BYPASSRLS或等效数据库管理员权限，业务角色只授予所需表权限，不授予schema创建权。删除来源与旧Owner事实入口仍共用原事务，不依赖异步outbox才生效。

pgvector为可选数据库扩展：可用时安装到public，不可用时迁移仍可应用并使用中文关键词。生产建议由数据库管理员预装扩展；Embedding服务默认关闭，必须另行明确授权和配置。CI先预装共享扩展再并行测试，避免随机schema同时创建扩展的竞争。回退到v1保留全部记忆表及原账本；旧路径忽略带memory_owner_id的新记忆，不能通过普通facts查询绕过Owner边界。

本轮只在全新临时 PostgreSQL/随机测试 schema 中运行迁移。日常数据库与 `.local-workspace-release` 没有部署或迁移。

## 灰度与回滚

默认所有会话=1。通过认证 API、expectedVersion 和幂等键逐会话改为2，始终人工审批。切换会使尚未提交的候选/队列过期，避免新旧路径并存发送；已提交、受理、未知的证据仍保留并等待回执/人工核对。

业务回滚：API切回1，检查SENDING/SUBMITTED/UNCERTAIN，不删账本。源码回滚保留工作区和本轮diff，选择撤销本轮修改，不整体reset既有工作。数据库保留0015–0017的增量字段/表；恢复旧二进制前需验证其旧facts查询是否忽略memory_owner_id，不能假设历史源码具备新归属过滤。不得删除迁移文件伪装未执行。

## 0017：P4/P5 增量迁移

新增DECIDING状态及任务决策/路由/质量JSON，新增ai_model_configs_v2、ai_model_commands_v2、ai_model_calls_v2。配置和用量按Owner启用FORCE RLS；调用记录与任务、联系人/会话和快照建立复合外键。预算在实际调用前原子预留，未知/中断用量不假定为零。反馈复用原data_feedback.rating扩展送达元数据，无新的发送队列。

注册集合在各Core/Bridge环境中保持一致，API只选择注册键。升级时给业务角色授予新表所需权限；源码readiness探测0017字段/表。迁移0017仅在隔离临时数据库应用，未迁移日常运行数据库。历史0015/0016未改写。回退v1保留决策、配置、计量和反馈证据；如回退二进制，先确认其readiness及旧数据查询兼容增量表。

## P6回滚演练

没有新增DDL；沿用0015–0017。待审批、生成中、UNCERTAIN场景的按会话回退和重启已在隔离PostgreSQL+Mock验证。保留未知结果/send_key、历史、记忆、模型账本，不删除迁移或以旧备份覆盖发送事实。真实联系人上线尚未执行；详见[P6指南](p6-acceptance-v2.md)。

## 独立预发布的实际部署编号（2026-10-11）

日常副本存在历史0013/0014，账号映射/手机联动是0015/0016。隔离预发布保留16个旧迁移字节与checksum，源码0015/0016/0017依次追加为部署0017/0018/0019，不能直接覆盖迁移目录。两个副本16→19升级、幂等、旧表投影/行数及16迁移冷恢复通过；日常库未迁移。后续编号按目标库实际谱系确定，见[指南](prerelease-v2.md)。
