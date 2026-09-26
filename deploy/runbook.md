# 运行与恢复手册（07 初稿）

状态：生产核心组合根已于 2026-09-26 落盘（`npm run serve:core`），但仍**没有**生产镜像、反代、真实平台桥接的生产部署或恢复验收。此手册是演练顺序，不代表已完成部署。

## 生产核心进程（`npm run serve:core`）

`apps/core/main.mts` 是常驻核心：本人管理 API、聚合/收集 worker、05 Skill 内部 outbox pump。**它不派发**——发送只属于每个平台账号的桥接进程。配置与失败关闭规则见 [apps/core/README.md](../apps/core/README.md)。

1. `npm run migrate`（读 `DATABASE_URL`），缺 schema 时进程会直接退出并输出 `schema_not_ready`，不会带病运行。
2. 必填 `DATABASE_URL`、`OWNER_ID`、`OWNER_PASSWORD_HASH`（scrypt 存储格式）、`PUBLIC_ORIGIN`、`CORE_PLATFORM`；`HOST` 默认 `127.0.0.1`，绑非回环地址必须显式 `ALLOW_NON_LOOPBACK_BIND=1`，非回环 `PUBLIC_ORIGIN` 必须 HTTPS。
3. 启动即暂停：进程先读 `dispatch_global_control`，活动态则调用 02 的 `pauseAll`，然后才 `recover()`。暂停态重启只记录、不重复抬高 epoch。只有本人显式恢复后才会有可派发工作。
4. 就绪检查：`GET /healthz`（存活）、`GET /readyz`（`database`/`schema`/`control`/`recovery`）。`/readyz` 为 503 时不要给它派工，也不要据此自动重启掩盖故障。
5. 日志为单行 JSON，每个请求带 `X-Request-Id`；错误响应体里的 `correlationId` 与日志行同值，可用于串联。日志不含正文、口令、平台标识。
6. 一个核心进程只应服务一个平台账号：`/api/v1/contacts` 的平台标签来自 `CORE_PLATFORM`，账号→平台的持久映射尚未实现。

### 候选模型（DeepSeek）

默认 `INTELLIGENCE_PROVIDER=persistent-fake`。启用真实模型：设 `INTELLIGENCE_PROVIDER=deepseek` 与 `DEEPSEEK_API_KEY`（缺密钥进程启动即失败），可选 `DEEPSEEK_MODEL`（默认 `deepseek-chat`）、`DEEPSEEK_BASE_URL`、`DEEPSEEK_TIMEOUT_MS`、`DEEPSEEK_MAX_TOKENS`、`DEEPSEEK_TEMPERATURE`、`DEEPSEEK_DATA_REGION`、`DEEPSEEK_RETENTION_POLICY`。微信桥接另设 `WECHAT_INTELLIGENCE=deepseek`，与 `WECHAT_ENABLE_OUTBOUND` 相互独立。

密钥只从环境变量读取：不写入配置对象、日志或错误文本；baseUrl 只接受 https 且不得带凭据、查询或片段。地区与保留策略是操作者声明，默认 `provider-default-unverified`，不构成供应商承诺。模型只提供候选文本，决策、事实与边界检查、确认、租约、账本与未知结果处理都不变——**接入模型不放宽任何发送权限**。启动日志里出现 `model_provider_selected` 与 `runtime_started` 的 `intelligenceModel` 即表示已生效。

### 本机复现隔离 PostgreSQL 的两个坑（2026-09-26 实测）

- **二进制不能放在中文路径下**：`C:\1\ai代聊\.pg-local\...` 下 `initdb` 会在 post-bootstrap 以 `invalid byte sequence for encoding "UTF8": 0xb4` 失败（路径里的中文字符被按 GBK 字节传给了 UTF-8 后端）。把二进制解到纯 ASCII 目录（如 `%TEMP%\pg17ascii`）即可。
- **`pg_ctl start` 在受限执行环境里报 `could not create restricted token: error code 87`**：直接后台起 `postgres.exe -D <data> -p <port> -c listen_addresses=127.0.0.1 -c logging_collector=on` 替代即可。

## 本地管理端（开发组合根，不是生产部署）

`npm run serve:owner` 启动 `apps/web/server/main.mts`：PostgreSQL 持久层 + mock 平台适配器 + deterministic fake 智能 + 调度 worker，默认只监听 `127.0.0.1`。它用来验证登录、待办、确认与调度链路，**不会也不能收发真实微信/QQ 消息**。必填环境变量为 `DATABASE_URL`、`OWNER_ID`、`OWNER_PASSWORD_HASH`（用 `npm run owner:password` 从 stdin 生成）、`PUBLIC_ORIGIN`；`SESSION_DIR` 必须位于私有卷且不入仓库。启动前先执行 `npm run migrate`——缺少迁移时进程会直接退出并提示，而不是带病运行。

本地管理端启动时先调用独立的 Skill outbox pump 处理 05 的 `SkillVersionChanged`/`GrantChanged`，然后周期运行，停止时先等待 pump 退出再关闭数据库连接。消费成功后才给 outbox 标记 `published_at`；坏事件保留 pending 并输出无正文的故障提示。QQ 桥接的 pump 只处理平台事件，不能替代 Skill 消费。生产核心组合根（上节）已接同一内部 pump；但真实平台上是否实际消费这些事件仍未验证——QQ 桥接进程不承担 Skill 消费，因此不能把本机结果计为真实平台运行时已消费。

生产部署仍按下节执行：真实 adapter、HTTPS 反代、受限数据库角色与备份恢复都不属于本地组合根。

## 启动与升级

1. 核对 `docs/decisions.md` 的 D01、D06–D08，确认实例、预算、数据周期及目标平台实测结论。部署身份、数据目录和数据库凭据应独立于测试环境；只开放 HTTPS 反代端口。
2. 先验证独立备份可恢复，再运行编号迁移和应用启动检查。新实例默认全局暂停，adapter 状态为 `RECONCILING`，禁止在恢复完成前调度发送。
3. 确认 API 鉴权/CSRF、数据库连接、媒体私有卷、worker 租约、各平台本人来源识别与回执能力，逐个联系人由本人启用。镜像和迁移编号需记录在发布单。
4. 升级前备份数据库与媒体，记录当前镜像、契约版本和迁移哈希；先停 dispatch 并保持入站写入，再升级。迁移只能向前修正，不能通过回滚数据库抹去已经提交的发送事实。

## 故障与未知发送

1. 全局暂停 dispatch；保留入站、outbox、发送账本和审计。平台/API/worker/model/数据库故障不得通过盲目重试发送来“自愈”。
2. 核对数据库与媒体一致性、重放 inbox/outbox 并去重。对崩溃时 `SUBMITTING` 的任务执行 `recoverAmbiguous`，将结果记为 `RESULT_UNKNOWN`；保持相关联系人发送阻塞。
3. adapter 先同步最新消息和回执，取得 `RecoveryReport` 与历史覆盖范围。对未知发送只凭平台可审计证据标记已送达或明确失败；无法证明时由本人处理。本人发言、权限、事实、技能、新消息均使关联旧方案失效。
4. 核查所有受影响联系人、积压、任务版本与未解决发送后，显式恢复单个联系人；最后由本人决定是否解除全局暂停。恢复动作写入审计。

## 备份和恢复演练

- 备份需包含数据库、媒体文件和与之对应的版本/哈希清单；凭据与备份加密密钥不能放仓库。D07 未定前不能承诺具体保留和清除期限。
- 在独立空环境恢复：先阻断发送，恢复数据库和媒体，校验消息、事实版本、outbox 未投递项、发送账本和媒体哈希；用 mock adapter 跑 smoke。真实 adapter 仍需单独 reconcile，不能把备份中的旧任务直接发送。
- 2026-09-24 已在隔离 PostgreSQL 17.11 用 `pg_dump --format=custom`/`pg_restore` 恢复到另一空数据库，并复制私有 raw-event 目录；核对了字节与 SHA-256、消息/版本、outbox、发送账本及全局暂停。恢复后的 `SUBMITTING` 经 `recoverAmbiguous` 成为 `RESULT_UNKNOWN`，未解决 key 仍阻断。见 `docs/reports/07-g2-integration-2026-09-24.md` 和 `tests/integration/postgres-backup-restore.test.mts`。
- 该演练未覆盖媒体目录、会话目录、凭据、整机、增量/定期备份或真实 adapter reconcile；这些仍是发布阻塞。QQ fake OneBot 已用真实 PostgreSQL 验证接收入站提交后消费失败、重启 pump 重放和双 pump 并发去重；真实 QQ 桥接与多日运行仍需只接收试验，恢复时仍先维持 dispatch 关闭。

## 观测与退出

以 `correlationId` 串起入站、上下文、plan、确认、每个 send task、receipt。日志记录版本、状态、错误码和时延，不记录 token、密码、完整敏感消息正文。告警至少覆盖全局暂停、未知发送、outbox 积压、数据库/媒体故障、磁盘空间、备份失败及模型/平台成本异常。阈值等待 D06 与实际测量。

需要退出发布时保持全局暂停，停止 worker dispatch，回退应用镜像但保留数据库中已提交的发送与回执事实。任何不兼容迁移需向前补丁或事先设计兼容窗口。
