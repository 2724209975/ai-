# 05 Skill 权限隔离与联系人私有定义增量提案

日期：2026-09-24。状态：**05 模块候选，未获总控批准，未进入 `db/migrations`**。已应用的 `0009_skills.sql` 不可改写；`0010` 预留给 03。候选 SQL 位于 `packages/skills/registry/0011_skills_scope.proposed.sql`，最终编号、公共契约和部署角色由总控决定。

## 动机与范围

0009 把 Skill 定义限制为 `global`，因此现阶段按联系人启用靠 grant；PRD 未明确要求定义本身可私有。当前 preview/import/PG store 对非 global 定义统一返回 `PRIVATE_SCOPE_NOT_ENABLED`，这是开发边界，不把私有定义误写成已确认产品需求。0009 还没有配置生产 owner/runtime 数据库角色：运行期角色不能靠应用层命令鉴权来保护版本表和命令回放表。

提案分两层：

1. **首版必须完成的角色隔离**：owner 写入者是独立鉴权服务角色，负责 current/versions/command_receipts 的写入、Skill 版本/grant/epoch/outbox 同事务；runtime 是非表拥有者、非 superuser、无 BYPASSRLS 的服务角色，仅能读取 current/versions，并只能在受信事务设置 `app.contact_id` 后按 grant 读取和写调用记录。runtime 对 current/versions/receipts 无 INSERT/UPDATE/DELETE，对 receipts 无 SELECT。`PUBLIC` 对三表的权限撤销。实际角色名和跨模块基础表授权由总控部署配置统一定稿；不得让 runtime 成为 owner 角色的成员。05 的 `setGrant` 已在事务内设置目标联系人 scope，以适配 grants 的 FORCE RLS。01 消息、OCR、转写和导入内容没有 owner 鉴权能力。
2. **待产品批准的私有定义扩展**：增量迁移把 current scope 放宽为 `global` 或联系人 UUID；历史 `skills_versions.definition.visibilityScope` 加独立约束和 SELECT RLS。无 scope（NULL 或空串）一律读不到 current/versions。历史版本按自身不可变 scope 授权，不能借后来把 current 改成 global 读取旧的 A 私有示例。runtime 对 receipts 的禁读同样阻断命令回放结果泄漏。批准前 preview/store 继续拒绝私有定义；批准后再同步改变 05 校验与 Owner UI，不自动迁移或授予任何 grant。

## 输入输出与兼容

05 端口继续引用 `(skillId, version)`；`getVersion`、`listGranted` 在可信事务内设置联系人 scope 后返回可见定义，未经 scope 返回空。Owner 跨联系人管理通过独立鉴权角色，不复用 runtime 对外查询。`SkillVersionChanged` v1 payload 只含 `skillId, oldVersion?, newVersion, reason`；`GrantChanged` v1 含 `skillId, contactId, oldVersion?, grantVersion, reason`，均不含定义、示例、OCR、消息正文或导入内容。事件名与版本不变，旧消费者继续按 skill/grant epoch 失效未发送 plan；02 仍须 lease 内同步复核，事件本身不授予发送。05 不写 live 事实或发送任务，trial 不入 live 调用表。

0009 数据中只有 global 定义，候选迁移加约束和 SELECT policy 不改已有行；现有 global Skill 在有合法 contact scope 时仍可读。缺失 scope 的 runtime 读取由原本可见收紧为 0 行，是有意的安全兼容变化；调用方必须在事务中设置 `app.contact_id`。定义 scope 从私有改为 global 时，旧私有版本仍对其他联系人不可见；反向修改同理。内存草案和正式导入格式 D12、执行规则 D13 不随本提案定型。

## 迁移、回滚与删除

总控若批准，应按全局迁移序列创建新的增量文件，先配置独立数据库角色和最小权限，再暂停相关 worker，应用迁移，运行 05/07 真实库 A/B direct SQL 与全量门禁，最后恢复 worker。角色配置需明确 owner 对版本表的表拥有权或等价的安全写入端口、runtime 的只读授权，以及 grant/invocation 的 RLS 写入权限；若未完成角色隔离，不应启用私有定义。已应用迁移不能靠修改 0009 回滚。候选应用后如需停用，先暂停 Skill 选择和发送，回退消费者并发布新迁移调整 policy；保留不可变版本、调用记录和审计，不重新放出失效计划。

`setStatus(...,'deleted')` 目前只是逻辑墓碑，历史定义及命令回放结果仍含正文。D07 的正文、日志和备份物理清除期限未定；不能向用户承诺已物理删除。若产品要求删除传播，须另定历史版本正文脱敏、命令回放清理与备份证明，同时维护可追溯 ID/版本/动作；不得直接破坏当前不可变版本审计假设。

## 验证与 AC 影响

`pg-store.real.test.mts` 在随机隔离 schema 先应用已批准迁移，再临时应用 0011 候选 SQL：无 scope 读 0；A 可读私有 current/v1 和示例，B 直接 SQL 与 `getVersion` 均读不到；current 改为 global 的 v2 后，B 可读 v2 但仍不能读 v1；`listGranted` 按授权可用。0009 基线还验证 runtime 不能写 current/versions/receipts、不能直读 receipts；v1 outbox 无正文。此测试证明候选 SQL 与所配测试角色的行为，生产角色配置未落地。

影响 AC35–37、AC39–42；协作 AC12/32/34/38。02 负责未发送方案失效及发送前检查，03 继续提供已裁剪上下文，04 只消费建议并复核，06 负责 Owner 管理 UI，07 负责迁移集成与备份/恢复测试。公共类型、事件、REST 暂无变动；如产品决定增加私有定义入口或改变删除语义，须由总控更新 `docs/contracts.md`、`packages/contracts` 和全局迁移。
