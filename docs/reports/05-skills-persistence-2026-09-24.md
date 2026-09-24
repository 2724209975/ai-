# 05 Skill 持久化纵切交付记录

日期：2026-09-24。基线 PRD v1.3、公共契约 v0.3.0、D12/D13 Open。按总控协调，**0008 只是候选全局迁移号**；本次没有写入 `db/migrations`、`packages/contracts` 或 REST 路由。

## 变更

- `packages/skills/registry/schema.proposed.sql`：定义当前 Skill、不可变版本、联系人 grant、调用记录、owner 命令回放表，包含约束和联系人读取 RLS 草案。没有发送任务或 live 事实表。
- `packages/skills/registry/pg-store.mts`：事务内的版本创建/停用/删除、grant、同步 skill epoch、outbox、调用日志和受限读取。共享 02 的 dispatch boundary；不持有平台发送端口。
- `packages/skills/registry/pg-store.test.mts`：隔离事务夹具验证不可变历史、grant 联系人 epoch、命令幂等、outbox 失败回滚、重建 provider 后读取、日志与 trial/cross-contact 拒绝。
- `packages/skills/registry/pg-store.real.test.mts`：独立 schema 的真实 PostgreSQL 用例，覆盖迁移草案、断开重连后读取、事件/epoch、调用记录及受限数据库角色的联系人 RLS。
- `packages/skills/README.md`、[接口提案](05-skills-contract-proposal-2026-09-23.md)：同步补充候选 0008、02/06 对接、兼容与回滚。

## 验证

在 07 提供的隔离 PostgreSQL 测试库上，`node --test packages/skills/registry/pg-store.real.test.mts`：**1 pass / 0 fail**；`npm run test:unit`：**195 pass / 0 fail**；`npm run test:contracts`：**4 pass / 0 fail**。真实 PG 用例在随机独立 schema 中执行 0001–0007 已有迁移与 05 SQL 草案，验证断开数据库连接再读取、历史版本、联系人 grant、同步 epoch、outbox、调用记录，以及非表拥有者角色下 A/B 的 RLS 隔离。测试后清除随机 schema 和角色。

本机未安装 `tsc`，静态编译未验证。真实 PG 测试验证的是客户端断开重连，**没有重启 PostgreSQL 服务**；真实 PG outbox INSERT 故障注入验证版本、epoch 和事件一同回滚。无 02 消费 05 事件后显式更新 plan 状态的联测。

## AC 与接口边界

AC35/36：版本和 grant 存储草案有事务/命令重放验证；保存后不自动 grant。AC37：单次指定仍只在当前任务，不写 grant。AC39：PG 读取及调用日志写端先核对联系人，设置事务级 RLS scope；真实 PG 受限角色无法跨读 A/B grant 与调用记录；对方/OCR/转写无 owner 命令能力。AC40：版本/grant 变更在同一事务内提升 `skill_epoch` 并写事件，真实 PG 故障注入证明 outbox 失败时三者一同回滚；02 现有确认与 dispatch 路径复核 epoch，但显式标记旧 plan 失效的消费者尚未接线。AC41：调用失败/缺事实回退逻辑沿用内存骨架；日志存版本/引用/原因，持久端口拒绝不符合枚举规则的伪造输出。AC42：持久调用日志只接受 live，trial 保持独立无事实/发送能力。以上均为模块/隔离测试证据，未构成产品 AC 全通过。

02 需审查 `skill_epoch` 更新、事件消费后的 plan 状态写入，以及 lease 内精确版本/grant 复核；06 需审查最小 Owner 查询/命令投影、鉴权、CSRF 和 `allowedActions`，无 URL 定稿。03 仍提供已裁剪上下文；04 只接收 05 建议并运行检查。D12 的导入格式/内置内容和 D13 的组合/执行规则仍是未决产品选择；JSON、枚举规则和单阶段一个 Skill 仍只是开发默认值。

当前 `setStatus(...,'deleted')` 是逻辑墓碑，历史版本定义仍保留供追溯。D07 的正文/备份清除期限尚未确定；正式删除策略须由总控审定，不能把逻辑删除称为物理清除。
