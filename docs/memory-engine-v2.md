# MemoryEngine v2：P2/P3 已实现契约

2026-10-11，在电脑端 PostgreSQL 路径增量实施；Android 独立流程保留。发送权限仍由原流水线负责。交付证据见 [报告](reports/v2-p2-p3-2026-10-11.md)。

## 实际入口与分层

pipeline_version=2 的 PgConfirmedService 调用原 PgDataProvider.buildContext(v2)，将 ContextPackageV2 保存到 data_context_snapshots.context_package_v2，再经 Context Adapter 传给候选 Provider。DeepSeek 的 v2 提示词使用同一个包，不重复追加旧历史/事实/风格；v1保留原组装器。

包包含Owner/账号/联系人/会话/平台、revision、完整triggerMessageIds、近期/引用消息、摘要、关系、记忆、风格、兼容事实、来源版本、选择原因、检索能力与预算。任务/快照关联及hash继续由原流程保存。

| 层 | 实际实现 | 证据与权限 |
| --- | --- | --- |
| L1 | 默认最近40条，按时间/数值平台序号排序；整批超出40条仍保留；系统/平台原生引用解析 | 当前账号/联系人/会话有效live及已导入import消息；触发批次仍必须为live，引用也保存版本 |
| L2 | 较早新增文字达到30条后增量摘录，保存前序摘要、起止消息、来源版本和待回应问题 | 本地原文摘录，不调用摘要模型；不反复处理已有来源 |
| 关系 | unknown/stranger/familiar/getting_to_know/dating；本人修订/锁定/CAS/幂等 | 默认unknown；不由“晚安”升级关系；推测字段独立且有TTL，本轮不自动产生关系推测 |
| L3 | 复用facts/evidence，新增元数据、异步任务、向量副本、幂等记录 | 事实/偏好/边界/经历/承诺/关系事件/临时状态；范围复合约束及Owner/联系人RLS |
| L4 | 全局本人表达统计/设置，联系人统计/设置覆盖，最多8条本会话示例 | 至少10条合格文字才产生统计；草稿、仅批准/受理、未经本人修改的AI文字不采样 |

## 预算和预览

默认totalTokens=8192、outputReserve=1024、systemReserve=1024、recentLimit=40。估算版本cjk-char-latin4-v1：中文字/表情计数，其他字符约4字/token；属于估算，非供应商精确tokenizer。

超预算依次移除较早非当前批消息、风格示例、非强制记忆、兼容事实、摘要及统计。当前批及其引用、边界、锁定记忆、重要承诺不能截断或静默丢弃；仍超限进入FAILED/CONTEXT_BUDGET_EXCEEDED，不生成部分候选。发模型请求前再估算完整system/user，输出上限受预留预算限制。

认证Owner的GET /api/v2/conversations/:id/context-preview返回最近任务实际选择包及有效/过期状态，不另生成“预览版”。包含来源ID/版本、召回/排除原因和估算。

## 异步写入、确认和修订

Core独立10秒维护循环只处理opt-in v2会话，不占用回复/发送循环。任务按Owner+联系人+消息+版本唯一，支持SKIP LOCKED、60秒租约、attempt fencing、30秒失败重试（最多5次）及重启恢复。慢提取/Embedding在事务外，提交前复核来源、版本、租约和记忆开关。

默认本地保守规则识别明确偏好、边界、住址/生日/职业，以及带24小时TTL的“今天不开心”等状态，全部写入pending。问候/猜测不写事实。提取端口可替换，本轮未启用云端提取。

本人授权的QQ历史通过`qq-history-import.mts`及`packages/data/imports/qq-history.mts`保存为import，复用上下文、引用、摘要、风格和本地待确认提取。导入不经过live ingress，不创建回复或发送任务；同一账号/会话已有平台消息不重复保存，未返回正文的记录仅保留unsupported占位。历史提取使用imported_unverified证据类型，不能直接成为已确认事实。

- explicit_statement对应本会话有效真实来源，本人确认后才active。
- inferred/imported_unverified不能直接确认，高置信度不能替代证据；本人可明确纠正或手工新建自己的确认。
- user_confirmed来自认证Owner，允许无消息证据的本人明确补充。
- promise有效版本只能由本人明确确认，不从未发送候选自动创建。
- subject/predicate/规范化object去重，重复陈述合并来源；conflictKey失效旧active版本，纠正保留supersedes修订链。
- 联系人可关闭记忆和风格采样。记忆有效期默认90天，可配置1–3650天；到期退出查询/清向量，不代表原始聊天文件的物理删除保留政策。

## 检索和删除

先限定Owner/账号/联系人/会话/有效来源，再过滤过期、替代和删除。中文NFKC字词/双字片段与可选向量余弦相似度混合排序：语义0.35、关键词0.25、问题明确提及的记忆object 0.20、时效0.10、可信度0.05、重要性0.05（P6标注回放修复通用词挤掉关键事实）。普通条目最多10条，边界、锁定条目、重要承诺强制纳入；强制项超预算明确失败。

向量保存事实版本/模型/维度/real[]；安装pgvector后对同一副本执行public.vector及余弦算子，先过滤到范围内MATERIALIZED子查询。当前为范围内扫描，没有HNSW大规模性能承诺。Embedding未配置时使用中文关键词召回。

记忆事实增加memory_owner_id标记与复合外键，避免被旧普通facts查询当成无Owner归属事实；v2通过专属检索选择，v1回退不读取新记忆。关闭联系人记忆也排除该联系人兼容长期事实，显式全局本人配置保留。

删除同步清空事实/元数据正文、证据、向量和相关Context包。来源删除/撤回同步删除关联事实，清空相关摘要/风格及命令缓存副本。保留不含正文的幂等墓碑，旧创建请求重放不能复活删除内容；历史修订也可单独删除。

审批继续检查原generation/dependencyEpoch、消息/事实版本、来源及TTL。明确设置变更使旧候选失效；后台新摘要/风格样本不单独撤销有效快照，来源撤回则同步撤销。

## 风格和部署配置

合格样本为本人真实live文字、按当前账号和发送者精确映射的已导入import文字，以及原发送账本中DELIVERED且存在本人edited反馈的最终文字。无正文、未识别媒体、trial/replay和未发送候选不参与文字采样。全局统计仅保存本人消息聚合值及内部来源ID，其他联系人原文示例不进入本会话；全局显式设置先应用，联系人设置覆盖；支持版本和本人锁定。

Embedding默认关闭。部署者明确授权后配置MEMORY_EMBEDDING_AUTHORIZED=1、MEMORY_EMBEDDING_URL（完整HTTPS地址）、MEMORY_EMBEDDING_MODEL、MEMORY_EMBEDDING_KEY。禁止重定向；密钥/正文不进入维护日志。测试使用合成文本/假向量，真实数据库执行pgvector算子。

本轮只在临时测试运行时安装pgvector，未部署日常服务或发送真实聊天。Windows构建依据 [pgvector官方说明](https://github.com/pgvector/pgvector)。

P4/P5补充：显式v2云端权限也限制新媒体理解、查询Embedding和后台向量生成；默认仍需原单独Embedding授权。实际送达反馈记录最终send引用/哈希/编辑统计，已有L4学习范围仍是本人原文及送达后的编辑文字。模型选择、显式风格优先级及响应式记忆中心见 [决策与生成](decision-generation-v2.md)。

P6证据校验改为一次批量检查真实来源及版本，40条记忆检索固定10次SQL；跨周标签和边界测试见[P6验收](p6-acceptance-v2.md)。
