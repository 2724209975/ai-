# 00 总控交付：G1 本机闭环跑通与两项缺陷修复

日期：2026-09-23。需求基线：PRD v1.3；公共契约：`docs/contracts.md` v0.3.0。首个提交 `c85929e`，本次提交 `12b2fb2`（分支 `main`）。状态：`In progress`。

## 1. 目标与范围

把 G1 最小确认闭环在本机真正跑起来：文字入站 → 上下文快照 → 1–3 个候选 → 手机网页确认/编辑 → 逐条提交 → mock 回执。

改动限定在 `packages/ai/strategy/persistent-fake.mts`、`apps/web/src/App.tsx`、新增 `scripts/dev-seed.mts` 与 `tests/integration/postgres-fake-intelligence.test.mts`，以及本文档同步。**未**修改公共契约、全局迁移、Owner API 语义或任何真实平台代码；没有创建生产环境或开启真实发送。

## 2. 缺陷一：04 的 PostgreSQL 持久桥接从未工作（阻塞级）

现象：`npm run serve:owner` 收到入站消息后抛 `NOT_FOUND`，永远不产生待办，因此管理端从来没有可用闭环。

根因：`persistent-fake.mts` 的 `scopedContext` 按**内存上下文**形状读取（`context.id`、`context.hash`、`context.messageRefs`…），而 02 的 `#proposeFor` 交给它的是 `PgDataProvider.buildContext` 的**投影**形状 `{snapshot,messages,facts,analyses,dependencyEpoch}`。`context.id` 恒为 `undefined`，于是 `readContextProjection(undefined)` 返回 `NOT_FOUND`。

类型检查没有拦住它的原因有两个：该文件 import 的 `ProposedContext` 在 `confirmed-service.mts` 中并不存在（只是 type-only import，Node 原生剥离类型时直接擦除，且只在运行时才会暴露）；`packages/**` 不跑 `tsc`，只有 `apps/web` 有类型检查。只有真实 PostgreSQL 上的端到端接线能暴露这个缺口，而此前没有任何用例走 `createPgPersistentFakeIntelligence`。

修复：按 02 已声明的投影信封读取 `context.snapshot`，并把 04 侧入参收窄为最小快照信封类型（不要求完整 PG 投影，内存替身同样可用）。04 仍在自己的读事务里重读快照并比对 `id`、`conversationId`、`generation`、`policyVersion`、`hash` 与三类引用，不匹配即 `STALE_CONTEXT`，因此伪造或丢失的信封仍不可替代 03 已存的快照。

回归证据：新增 `tests/integration/postgres-fake-intelligence.test.mts`（真实 PostgreSQL：入站文字经 PG 持久桥接生成待办；候选数为 1–3、无空分条、`allowedActions` 正确）。该用例在修复前必然失败。

## 3. 缺陷二：手机网页切换页面时渲染上一页数据（06）

现象：hash 切页时 React 会先用上一页的数据渲染新页面。`overview` 渲染器读 `row.allowedActions.includes`，于是点到「总览」直接白屏；其他页面则短暂显示错误的空列表。

修复：查询结果与所属 `page` 一起保存，只有与当前页匹配时才作为当前数据使用；`overview` 在缺少当前页数据时不渲染。已逐个点击 11 个导航页验证。

## 4. 开发注入口 `scripts/dev-seed.mts`

mock 平台适配器没有 HTTP 入口（真实适配器的 webhook 才会承担这一角色），因此 `serve:owner` 自身不可能产生待办。该脚本固定本地联系人与会话 ID、只写 `data_contacts`/编排表并注入一条 `mode=live` 的合成文字，不做任何平台调用；重复运行会在同一联系人上生成新待办。它是开发夹具，不是产品路径，也不构成平台验收证据。

## 5. 验证

环境：Windows、Node 24.15.0；本机隔离 PostgreSQL 17.11（`127.0.0.1:55432`），`chat_agent_dev` 用于手工闭环，`chat_agent_test` 用于自动化。

- `npm run verify`：175 项模块测试、4 项契约检查、6 项真实 PostgreSQL 用例、8 项 E2E（含 390px Chromium 与真实 HTTP→PostgreSQL→mock 发送）与网页构建全部通过，0 fail。
- 手工闭环（真实 HTTP：登录 → 会话 cookie → CSRF+Origin → 管理命令）：注入「你好，在忙吗？」→ 待办 1 条、候选 3 个、`allowedActions=[confirmPlan,rejectPlan]`、原因 `CONFIRM_MODE` → 改稿确认返回 `resultVersion=2`、`status=SCHEDULED` → worker 提交 1/1 条、回执 `accepted`、`platformMessageId=mock:…` → 待办归零、结果未知 0。
- 390px 移动视口：11 个导航页切换 0 页面错误、无横向溢出。

文档同步：`docs/architecture.md` 契约版本、`packages/platform/README.md` 契约版本与 schema 包状态、`docs/README.md` 迁移号与用例数、`docs/development-plan.md` 用例数与 Owner API 进展、`docs/reports/acceptance-matrix.csv` 全表环境/提交号与 AC03 证据。

## 6. 已知限制

- 平台适配器仍是 mock：所有结果只算本机闭环证据，**不计**微信/QQ 验收，AC03 仍为 `blocked`。
- mock 的发送账本在进程内存中，重启服务后适配器侧记忆清空；发送记录与状态以 PostgreSQL 为准。
- `/skills`、`/imports`、`/faults` 仍返回 501；`sendMode=auto` 仍降级为待确认（`AUTO_REVIEW_UNAVAILABLE`），AC04 未交付。
- 架构文档推荐的 JSON Schema/Ajv 边界校验尚未接到 HTTP 路由。
- 无远端仓库，首次远程 CI 仍未执行；`packages/**` 仍无静态类型检查。

## 7. 下一步

1. 建立远端仓库并完成首次远程 CI（G0/G1 未闭门项）。
2. D01 真实平台 spike（优先 QQ OneBot 个人账号桥），产出 go/conditional/no-go 报告。
3. 并行：02 自动模式落地（AC04）、06 三个 501 资源的持久 provider。
