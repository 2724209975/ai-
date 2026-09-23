# 00 总控交付：本人登录、管理 API 与持久调度

日期：2026-09-23。基线：PRD v1.3、公共契约 v0.3.0。首个 Git 提交 `c85929e26257eed0a0c597831fd8bb0dc077f428`（分支 `main`，177 个文件）。

本轮按本人确认的四步执行：生产登录与会话 → 补齐 Owner API → 持久调度 → Git 初始化与首次提交。前两步的公共语义已登记为 [A14](../decisions.md)（登录与会话）和 [A15](../decisions.md)（状态词汇与调度迁移）。

## 1. 本人登录与会话

新增 `packages/infrastructure/auth/`：

- `password.mts`：`node:crypto` scrypt（N=2^15、r=8、p=1），参数随哈希存储且在校验时重新限定上界，口令长度 12–200 个码点，不引入第三方依赖。
- `session-store.mts`：会话只存令牌的 SHA-256；`FileOwnerSessionStore` 目录 0700、文件 0600、临时文件加 rename 原子写；支持整体撤销与过期清理。
- `owner-auth.mts`：登录、鉴权、退出、撤销、限速与 cookie 构造。cookie 为 `HttpOnly; SameSite=Strict; Path=/; Max-Age`，HTTPS 下加 `Secure`；会话同时有空间空闲过期与绝对过期；写操作要求精确 Origin、会话绑定的 CSRF 令牌和 JSON 请求体；登录按来源限速（默认 5 次/15 分钟），失败时不区分「口令错误」与「账号不存在」。

新增 `apps/web/server/owner-session-http.mts`（`GET /api/v1/session`、`POST /api/v1/session/login`、`POST /api/v1/session/logout`）、`owner-server.mts`（会话 + 鉴权 API + 静态资源组合，向 shell 注入 CSRF meta，拒绝路径穿越）、`main.mts`（本地组合根：PostgreSQL + mock 平台 + fake 智能 + worker）。前端新增登录门禁与退出入口；`apps/web/server/pg-owner-browser.integration.mts` 已把夹具 cookie 换成真实登录。

工具：`npm run owner:password` 从 stdin 生成 `OWNER_PASSWORD_HASH`；`npm run serve:owner` 启动管理服务。**凭据只经环境变量注入，不写入仓库或日志。**

## 2. 补齐 Owner API

- 02（`PgConfirmedService`）：新增 `rejectTask`、`resumeAll`、`resumeContact`、`updatePolicy`、`ownerConversations`；`ownerOverview`/`ownerTasks`/`ownerContacts` 的 `allowedActions` 现在会返回 `rejectPlan`、`updatePolicy`、`resumeAll` 等真实可执行动作。策略编辑在同一事务内提升 `policy_version` 与 generation、失效未发方案并写 `ContactPolicyChanged`；解除暂停只清除指定原因，未解决发送会阻止恢复。
- 03（新增 `packages/data/postgres/owner-data-port.mts`）：本人管理端口按联系人在同一事务内逐个设置联系人 scope，再读取事实、媒体、分析；支持事实 `confirm/correct/delete`（模型推测不能由本人确认）、贴纸批准与撤销（版本 + 平台列表校验）、分析纠正（标记失效并提升依赖 epoch）、审计读取。
- 路由层（`apps/web/server/owner-http.mts`）：新增 `/conversations`、`/facts`（含 `confirmFact/correctFact/deleteFact`）、`/analyses`（含 `correctAnalysis`）、`/media`（含 `approveAsset/revokeAsset`）、`/audit`、`/tasks/{id}/reject`、`/control/resume-all`、`/contacts/{id}/resumeContact|updatePolicy`。
- 尚无持久 provider 的 `/skills`、`/imports`、`/faults` 返回 `501 NOT_IMPLEMENTED`，**不返回假空列表**。

## 3. 持久调度与聚合

- `0005_orchestration_states.sql`：把持久会话状态词汇补齐到 contracts.md §5（只放宽 CHECK，不动数据）。
- `0006_orchestration_scheduling.sql`：新增聚合批次列、窗口约束与到期索引。
- 02 新增聚合批次（默认窗口 0 保持即时生成）、`claimDueCollections`（`FOR UPDATE SKIP LOCKED` 领取）、`flushDue`（短事务领取 + generation CAS 提交）、`dispatchableConversations`；`recover()` 会补做崩溃时仍在收集的批次。
- `packages/orchestration/postgres/worker.mts`：定时拉取到期批次与已批准分条，逐条提交；重叠 tick 直接跳过，单个会话失败不影响其他会话。`dispatchNext` 的 CAS 保证重复 flush 不产生第二个方案、重复提交不产生第二个 sendKey。

## 4. Git 与门禁

- 首个提交 `c85929e`；新增 `.gitattributes`（`* text=auto eol=lf`，避免 Windows 把检出文件改成 CRLF）、`.gitignore` 增补 `.pg-local/`、`.postgres17-test.zip`、`.local-sessions/`。
- 环境说明：最初由 Codex 沙箱账号创建的 `.git` 会让本人的 Git 报 `dubious ownership`，已删除并以本人账号重新初始化；当前 git 工作区干净。
- 远程 CI 仍未运行：仓库没有远端。`.github/workflows/verify.yml` 已就绪，配置远端后即可作为首次真实门禁。

## 验证

环境：Windows / Node v24.15.0、隔离 PostgreSQL 17.11（`127.0.0.1:55432`，临时数据目录）；平台 adapter = mock，智能 = deterministic fake。

| 门禁 | 结果 |
| --- | --- |
| `npm run test:unit` | 175 pass / 0 fail（新增 7 项登录与会话用例） |
| `npm run test:contracts` | 4 pass / 0 fail |
| `TEST_DATABASE_URL=... npm run test:integration` | 5 pass / 0 fail（02 确认发送重启恢复、03 provider/RLS、本人管理 API、聚合与调度、07 inbox-outbox/未知发送） |
| `RUN_BROWSER_E2E=1 npm run test:e2e` | 8 pass / 0 fail（含真实登录与真实 HTTP→PostgreSQL→mock 发送浏览器流程） |
| `npm run build:web` | 通过 |
| 本地启动冒烟 | `npm run serve:owner` 启动、登录 200、七个查询路由 200、`/skills` 与 `/imports` 返回 501、路径穿越 403、工作进程无 stderr |

## 已知限制与偏差

1. 会话暂存私有目录（`SESSION_DIR`）。升格为编号迁移表、单设备撤销与登录审计是后续独立提案；当前只有整体撤销（`revokeAll`）。
2. `/skills`、`/imports`、`/faults` 无持久 provider，UI 会显示明确错误而不是空列表。
3. 重复提交同一命令会返回新的 `correlationId`（不会重复执行）；03 侧 facts/media/analyses 命令没有独立幂等表，重复提交靠 `expectedVersion` 得到 `CONFLICT_VERSION`。
4. 自动模式仍未实现：`sendMode=auto` 一律转确认，理由 `AUTO_REVIEW_UNAVAILABLE`。
5. 平台适配器是 mock；真实微信/QQ 接入、回执、关机运行（AC23）与真实媒体能力仍未验证。
6. D04 的聚合/延迟参数仍不是生产值：`AGGREGATION_WINDOW_MS` 默认 0，`MAX_AGGREGATION_MS` 默认 30 秒，只作开发夹具。

## 下一步

1. 建立远端仓库并触发首次 GitHub Actions 运行，记录迁移、受限角色 RLS、真实 PostgreSQL 用例与 Chromium 用例的实际结果。
2. 按 D01 继续真实平台接入（先 QQ），把 mock adapter 换成真实 adapter；未通过前不开启任何真实联系人的自动模式。
3. 05 Skill 与 03 导入的持久 provider 就绪后补齐 `/skills`、`/imports` 路由，替换当前的 501。
4. 生产部署与备份恢复演练（07），并在 D06–D08 落定后给出容量与成本结论。
