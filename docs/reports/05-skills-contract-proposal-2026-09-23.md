# 05 公共接口与持久化提案（待架构总控审定）

基线 `docs/contracts.md` v0.3.0；本提案未修改公共契约、`packages/contracts` 或全局迁移。2026-09-23 协调状态：不可变版本、grant 和同步 skill epoch 方向可进入接口协调；公共迁移与完整 REST 定型暂缓。2026-09-24 总控指定 **0008 为候选迁移号**，须审查后才可写入 `db/migrations`；0007 已归 02。D12/D13 的格式、内置内容和执行规则仍待产品选择。

## 动机与建议

当前文字契约已列 SkillDefinition、ContactSkillGrant、SkillInvocation、SkillVersionChanged、GrantChanged，但机器类型、事件 payload、05 持久化和 02 同步复核尚无统一形状。建议总控明确：

1. `SkillDefinition` 引用采用 `(skillId,version)`；编辑/停用/删除生成不可变新版本。内置草案与自定义 Skill 不默认 grant。`ContactSkillGrant` 用 `enabledVersionRange`、`enabled`、单调 `version`，owner 命令必带鉴权证据与 `expectedVersion`。
2. 04→05 端口输入为 03 裁剪的 `ContextProjection`、`callerContactId`、`contactId`、`stage`、`taskId`、模式及可选本人单次指定命令证据。输出为 Skill 版本、选择理由、输入 refs、声明式建议、失败/回退原因和调用 ID。05 不返回发送动作或策略变更。
3. 事件 payload 至少含 `skillId,oldVersion?,newVersion?,contactId?,grantVersion?,reason`。05 同事务更新可同步查询的 `skillEpoch` 或精确版本并写 outbox；02 消费事件使引用旧版本/受影响 grant 的未发 plan 失效，且每条发送在 lease 内复核。单靠异步事件不够。
4. 06 Owner REST 的 Skill preview、版本保存、grant、trial、调用查询、任务单次指定路由须由总控统一确定鉴权、CSRF、版本冲突与 allowedActions。03/05 同库受限读取，禁止 05 自行查 03 全库。

当前可协调的最小读取接口为 `getDependencyEpoch(contactId)` 与精确 `skillId/version/grantVersion` 复核；05 内存原型已提供保守 epoch 检查。全局 Skill 变化提升所有联系人的可见 epoch，联系人 grant 变化仅提升该联系人 epoch。生产上必须与版本及 outbox 同事务，02 在 lease 内读取；下述 SQL 只是 05 范围内的候选表定义，仍不定 REST 路径。

## 2026-09-24 持久化纵切供审查

`packages/skills/registry/schema.proposed.sql` 包含 `skills_current`、不可更新/删除的 `skills_versions`、按联系人键控的 `skills_grants`、只存引用与结构化建议的 `skills_invocations`、owner 命令回放凭据表；无发送任务表。当前版本到历史版本的外键为延迟检查，版本行有 JSON/主键/状态一致性检查。grant 和调用表启用联系人 RLS 读取；迁移审批还须明确数据库 owner/runtime 角色和权限，不能仅凭应用层 `callerContactId`。

`PgSkillStore` 的写方法接收已有事务 `tx`：先取得与 02 共用的 dispatch boundary，检查 owner 命令及 expectedVersion，在同一事务写版本或 grant、提升 `dispatch_control.skill_epoch`、写 `SkillVersionChanged`/`GrantChanged` outbox 和命令回放记录。Skill 版本变化保守提升全部会话 epoch；grant 变化仅提升该联系人的会话 epoch。调用日志只接受 `mode=live`，拒绝 trial/replay 写入；trial 仍走独立无副作用端口。若 outbox 写失败，调用方回滚全部变更。

与 02 对齐：现有 02 方案、确认、dispatch lease 已保存并比较 `skill_epoch`；05 变更后旧方案在同步检查处失败。02 尚需消费 05 事件，把关联未发方案显式标记 `INVALIDATED`、取消未提交分条并重判；这一状态写入不能由 05 越权处理。与 06 对齐的最小 Owner 形状为 `previewImport(source)`、`createVersion(command,draft,expectedVersion?)`、`setStatus(command,skillId,expectedVersion,status)`、`setGrant(command,contactId,skillId,range,expectedVersion?)`、`trial(command,fixture)`、`listCurrent/listInvocations`；所有可操作资源由后端计算 `allowedActions`，具体 URL、鉴权/CSRF 及响应 schema 后定。

## 兼容、迁移与回滚

现有 v0.3.0 事件名保持；机器 payload 若仅加可选字段，旧消费者需契约测试；必填变化须新 `eventVersion` 并双读。候选 0008 审查后先加表及角色，再接 05 provider，最后启用 02/04/06 消费端；迁移现有内存数据时不自动 grant，不把试用或导入写为 live。旧计划若无 Skill 依赖元数据，保持不可自动发送，重新生成。回滚先全局暂停、停止 Skill 选择与 dispatch；保留已发送账本、历史调用和墓碑，不能恢复失效旧计划。已应用 0008 时不得直接删除历史版本或调用表；只能回退消费者并保留存储供审计。

## AC 与协作者

影响 AC35–42，协作 AC12/32/34/38。02 负责 plan 失效和 preflight；03 提供已裁剪投影及受限数据库事务；04 消费建议并检查；06 提供本人操作 UI；07 做持久化、竞态和 mock E2E；01 无 Skill 权限。D12/D13 仍待产品决定；当前 JSON/枚举/单阶段一个 Skill 仅为工程默认值。
