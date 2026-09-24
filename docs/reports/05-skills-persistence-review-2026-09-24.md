# 总控审查：05 Skill 持久化与该模块 0008 候选迁移

日期：2026-09-24。审查对象：[schema.proposed.sql](../../packages/skills/registry/schema.proposed.sql)、[pg-store.mts](../../packages/skills/registry/pg-store.mts)、[05 交付记录](05-skills-persistence-2026-09-24.md)、[接口提案](05-skills-contract-proposal-2026-09-23.md)。基线：PRD v1.3、公共契约 v0.3.0。结论：**未通过，05 的候选迁移（现编号 `0009`；`0008` 已归 03 的平台变更审计）不得写入 `db/migrations`。**

## 结论摘要

版本不可变、grant、同步 skill epoch、outbox 与命令回放的设计方向与契约一致，隔离夹具与真实 PostgreSQL 用例也确实覆盖了这些路径。但当前 DDL 的 RLS 只建了 `FOR SELECT` 策略且未 `FORCE`，这会让**本地以 superuser 运行的一切测试通过，而受限运行角色在生产无法写入**——与 [A12](../decisions.md)（`0003_data_scope_fix.sql`）修复的正是同一类失效。必须先修订，再谈占用 `0008`。

## 阻断项（必须修订）

### 1. 受限运行角色无法写入（已实测复现）

在隔离 PostgreSQL 17.11 上执行 `0001`–`0007` + 该草案，然后以**非 superuser、非 BYPASSRLS** 角色（`GRANT USAGE ON SCHEMA` 与 `SELECT,INSERT,UPDATE` 均已授予）在事务内设置 `app.contact_id` 后插入 `skills_grants`：

```
as restricted role with app.contact_id set: 42501 new row violates row-level security policy for table "skills_grants"
as table owner (no SET ROLE): OK
restricted role read count: 1
```

原因：表启用 RLS 后只存在 `FOR SELECT` 策略，INSERT/UPDATE/DELETE 没有任何适用策略，因此默认拒绝；而表拥有者未被 `FORCE`，所以以 superuser/owner 运行时一切正常。`recordInvocation`、grant 变更、版本创建都是运行期写操作，受此影响。

要求：与 `0002_data.sql` 保持一致的写法——按命令覆盖的策略（`USING` + `WITH CHECK` 同时限定 `app.contact_id`）并 `FORCE ROW LEVEL SECURITY`；若确实要区分读写角色，必须显式写明并由测试证明，不能依赖"本地是 superuser"。

### 2. 全局表的写入者未定义，也没有负测

`skills_current`、`skills_versions`、`skills_command_receipts` 是全局表（无 RLS），草案没有说明它们的写入者是谁。本人管理端按 A14 是"独立鉴权端口"，但端口不会自动获得写权限；同时运行期角色若能写这三张表，就等于可以伪造 Skill 定义与命令回执。要求：明确写入者、给出授权语句、并补一条"运行期角色不得写这三张表"的负测。

### 3. `visibility_scope` 没有执行点

草案允许 `visibility_scope` 为联系人范围，但 `skills_versions.definition` 没有任何联系人隔离。若将来某个查询 JOIN 到版本表，跨联系人定义会直接泄漏（AC39）。要求：要么约束定义只允许 `global`（私有 Skill 另行设计并单独提案），要么给版本表加同等强度的 scope 规则与负测。

### 4. 真实 PostgreSQL 用例的证据强度不足

现有用例用受限角色只验证了 SELECT 隔离，而运行期真正的写操作（`recordInvocation`、grant、版本创建）全部以 superuser 执行，所以第 1 项才会漏过。要求：真实库用例必须以受限角色执行运行期的写入路径。

## 非阻断但需记录

- `skills_current.current_version` 到 `skills_versions` 是**延迟外键**，首次写入必须与版本行同事务；否则会得到 `23503`（审查过程中已实际遇到）。store 若在事务外创建版本会稳定失败，应写明前提。
- `skills_versions` 用触发器禁止 UPDATE/DELETE，与"版本不可变"一致；但 `skills_current` 的 `status` 与 `skills_versions.status` 有 `CHECK (definition->>'status' = status)` 的耦合，状态迁移只允许追加新版本行，文档需写清。
- `setStatus(...,'deleted')` 是逻辑墓碑，历史定义仍保留：符合 A18/D07 未定时的保守做法，但不能对外称为物理删除。

## 通过的部分

- 版本不可变、`(skill_id,version)` 主键、grant 的 `enabledVersionRange`、联系人级 epoch 递增与 `SkillVersionChanged`/`GrantChanged` outbox 同事务；故障注入证明 outbox 失败时版本、epoch 与事件一起回滚。
- 命令回放表用 `command_id` 主键 + `request_hash`，同命令不同请求被拒。
- 调用记录拒绝非 live 输入（AC42），端口层拒绝跨联系人读写（AC39 的模块级证据）。
- 不持有发送端口、不写 live 事实、不自动授予 grant。

## 后续

修订后由 05 重跑真实库用例（含受限角色的写入路径），交回总控复审；复审通过才把该 SQL 以全局编号 `0009` 写入 `db/migrations`（`applyMigrations` 要求编号连续，且已应用文件不可修改）。在此之前 [decisions.md](../decisions.md) 的 A18 保持 Candidate。
