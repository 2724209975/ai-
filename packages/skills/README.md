# 05 Skill 开发骨架

当前状态只见 [开发计划 §0](../../docs/development-plan.md#0-当前状态每完成一个任务由总控更新本节)；本页保留模块说明与操作约束，不维护测试数字或进度。

依据 `docs/contracts.md` v0.3.0；D12/D13 仍 Open。这里的格式与单阶段一个 Skill 是可替换的开发默认值，不是已确认产品需求。

## 输入与输出

- `registry/registry.mts`：`previewImport` 只解析 JSON 数据并返回错误/冲突；`previewDraft` 可供表单编辑预览。`createVersion`、`setStatus`、`setGrant` 必须收到已认证 owner 命令；返回不可变定义/授权副本并记录 `SkillVersionChanged` 或 `GrantChanged`。每次编辑、停用、删除都生成新版本。内置六项位于 `builtins.mts`，只是未启用草案。
- `selection/select.mts`：输入 03 已裁剪的 `ContextProjection`、`callerContactId=contactId`、`stage`、`taskId` 和 `mode=live`。先核对消息、事实、分析与快照引用及联系人范围。自动选择仅使用当前版本落在有效 grant 范围内的 Skill；本人单次指定必须带 owner 命令、taskId、stage、精确版本，不更改 grant。选择结果绑定联系人、任务、阶段和依赖 epoch；每阶段最多一个，未命中返回基础流程原因。
- `execution/invoke.mts`：输入 registry、选择结果与同一投影；调用前重查任务绑定、Skill 当前版本及 grant/epoch，失效则仅记录回退。正常输出 `SkillInvocation` 的版本、`skillEpoch`、输入引用、声明式建议及 `requiresCheck=true`。建议仅交给 04；04 做事实/风格/风险检查，02 做权限与发送前检查。缺事实返回 `manual_required`，执行失败返回基础回退，均不产生未检查候选。调用记录仅存引用、规则枚举、原因和采用标记，不存完整上下文。
- 内存 registry 的 `getDependencyEpoch(contactId)` 与 `isSkillDependencyCurrent` 可在事件未投递前拒绝旧版本/旧 grant 调用，仅用于骨架验证；生产复核需在 02 发送租约内完成。
- `trials/trial.mts`：只接受已认证 owner 的 `mode=trial` 夹具，输出版本化建议和空 `sideEffects`。无事实写端、发送端或 live 上下文参数。

导入内容、对方消息、OCR、转写均无 owner 命令能力。导入文件不能包含脚本、代码围栏、网络请求或不支持字段。当前只支持受限 JSON；Markdown、格式大小上限、完整内置内容待 D12。0009 只允许 global 定义，preview/import/store 对非 global scope 返回 `PRIVATE_SCOPE_NOT_ENABLED`；全局 Skill 暂拒绝任何案例，避免无法核验私密来源。声明式规则只有枚举，不执行导入文本。联系人消息中的词只用于适用性匹配，不能变更 Skill 或权限。

## 尚需集成

内存 registry/journal 用于骨架验证；PG store 已能跨进程保存版本、grant、epoch 和调用记录。完整 REST 定型仍暂缓。02 仍须在未发方案失效及每条发送前复核版本，04/06 后续接入各自端口。`skillEventAffectsPendingPlan` 只是 02 消费事件的纯判断助手，不能替代同步 epoch。试用要在 API 和数据库层继续隔离。详见 05 提案和交付记录。

`registry/pg-store.mts` 与 `db/migrations/0009_skills.sql` 是持久化纵切（grant/invocation 的 RLS 为 FORCE + 覆盖各命令策略）。写方法必须由调用方放在同一 PostgreSQL 事务内，版本/grant、02 现有 `dispatch_control.skill_epoch`、outbox 和 owner 命令回放记录共同提交。0009 已应用，不可原地修改。独立非 BYPASSRLS owner/runtime 角色的权限与 direct SQL 负测在隔离 PostgreSQL 上通过；生产角色配置仍需总控接入。联系人私有定义及历史版本 RLS 位于 `registry/0011_skills_scope.proposed.sql`，只是候选，不在全局迁移序列中。
