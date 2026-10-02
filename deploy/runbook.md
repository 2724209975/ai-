# 运行与恢复手册（07 初稿）

> 当前阶段与状态只见 [开发计划 §0](../docs/development-plan.md#0-当前状态每完成一个任务由总控更新本节)。P0–P4 在本人电脑运行；本文中的云端、反代或宿主配置只是历史准备步骤，P5 选型后复核，管理端仅私网访问。真实登录、注入与发送由本人执行。

## 微信客户端版本守护（本机操作）

桥接启动前配置 `WECHAT_CLIENT_DLL_PATH` 和 `WECHAT_HELPER_DLL_PATH`，使用本人将实际运行/注入的文件路径；实现不预设操作系统、安装目录或部署宿主。完整指纹固定在 `packages/platform/wechat/binary-preflight.mts`：客户端 `2058A926…`、W01 诊断 helper `B48BD850…`。不能通过环境变量修改预期哈希或关闭检查；只接收也同样检查。

指纹不符或文件不可读时，桥接在数据库/模型/接收服务装配之前退出。成功启动后的 `/healthz` 含偏移构建名与两项 8 位前缀；这说明磁盘文件通过启动检查，不证明微信登录、hook 有效、该 DLL 已加载或能够发送。磁盘文件在运行期间变化的主动检测属于后续看门狗工作，不由启动检查保证。

本人在测试客户端「设置 → 通用设置」中检查是否存在自动升级选项；若存在，取消该选项并重启后复核。**该固定构建的选项位置/可用性尚未本机核验**，没有开关时不能宣称已关闭自动更新；不采用改 hosts、删除更新程序或改安装文件来绕过更新。无论设置如何，每次启动都以完整指纹判定；固定安装包保存在私有目录，不能仅看显示版本号。

更新或出现 WX_CLIENT_BINARY_MISMATCH / WX_HELPER_BINARY_MISMATCH 后按序处理：

1. 全局暂停，停止桥接派发；本人卸载接收 hook，再停本轮进程。微信已退出或 helper 不响应时停止桥接并保留未知发送，不重试。
2. 保留原构建和审计证据，记录新文件完整 SHA-256；不让新客户端搭配旧偏移运行。
3. 重新离线移植和交叉验证偏移，提交带完整指纹的构建提案；确认来源与实测证据后由总控更新允许构建。不能为通过检查而改成当前未知文件的哈希。
4. 本人在场用测试号做只接收复测：文字/图片/语音、平台消息 ID、崩溃/来源/恢复边界；发送仍关闭。不能用 fake helper 或 unit pass 代替真实接收证据。
5. 只接收通过后，再逐条确认新的发送验收；未知结果继续暂停、人工核对。整个恢复期间不补发旧任务。

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

默认 `INTELLIGENCE_PROVIDER=persistent-fake`。启用真实模型：设 `INTELLIGENCE_PROVIDER=deepseek` 与 `DEEPSEEK_API_KEY`（缺密钥进程启动即失败），可选 `DEEPSEEK_MODEL`（默认 `deepseek-flash`，可改 `deepseek-v4-pro`）、`DEEPSEEK_BASE_URL`、`DEEPSEEK_THINKING`（默认 `disabled`）、`DEEPSEEK_TIMEOUT_MS`、`DEEPSEEK_MAX_TOKENS`、`DEEPSEEK_TEMPERATURE`、`DEEPSEEK_DATA_REGION`、`DEEPSEEK_RETENTION_POLICY`。微信桥接另设 `WECHAT_INTELLIGENCE=deepseek`，与 `WECHAT_ENABLE_OUTBOUND` 相互独立。

**失控闸**：`DEEPSEEK_DAILY_CALL_LIMIT`（默认 300）与 `DEEPSEEK_DAILY_TOKEN_LIMIT`（默认 500000）按 UTC 日计数，超出即拒绝调用；04 把拒绝映射成 `MODEL_UNAVAILABLE`，02 据此暂停该联系人转人工。它是**进程内的循环闸**：重启清零，不能当作月度预算、也不代表账单上限；月度成本以平台账单与 `model_call` 日志对账。

密钥只从环境变量读取：不写入配置对象、日志或错误文本；baseUrl 只接受 https 且不得带凭据、查询或片段。地区与保留策略是操作者声明，默认 `provider-default-unverified`，不构成供应商承诺。模型只提供候选文本，决策、事实与边界检查、确认、租约、账本与未知结果处理都不变——**接入模型不放宽任何发送权限**。启动日志里出现 `model_provider_selected` 与 `runtime_started` 的 `intelligenceModel` 即表示已生效；每次调用另有一行 `model_call`（模型/提示版本/地区/结果/时延/输入输出 token，不含正文），用于对账成本。

成本参考（2026-09-26 官方定价页）：`deepseek-flash` 每 1M token 输入未命中缓存 $0.15 谷/$0.3 峰、输出 $0.6 谷/$1.2 峰；峰时为 UTC 周一至周五 01:00–04:00 与 06:00–10:00（北京时间 09:00–12:00、14:00–18:00），其余时间为谷时。账单以平台为准，本手册只记录当时页面事实。

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

## 本机常驻与故障演练（P2-4）

本节只用于当前 Windows 本机开发；不代表 P5 宿主、开机自启或真实平台故障验收。便携检测逻辑在 `apps/bridge/watchdog.mts`，可供后续宿主复用。

准备好现有 PostgreSQL 集群、已构建网页与私有配置后，运行 `npm run serve:local`。新增必填 `LOCAL_PG_BIN`（含 postgres.exe/pg_ctl.exe 的绝对目录）、`LOCAL_PG_DATA`（既有集群绝对目录，含 PG_VERSION）；数据库必须是 `postgres://...@127.0.0.1:<port>/<database>`，PUBLIC_ORIGIN 必须为 `http://127.0.0.1:<core-port>`。核心和微信桥接的其余必填配置沿用各自 README；桥接另需本人提供 `WECHAT_PROCESS_ID`、已通过哈希守护的两个 DLL 路径。默认桥接端口 19099，可用 `LOCAL_BRIDGE_PORT` 调整，三个端口必须不同。私有原始事件、会话和集群不要放入仓库。

脚本不初始化数据库，也不启动微信、helper、登录或注入。已运行的外部数据库/核心/桥接占用端口时拒绝接管；请本人先停对应外部进程。本人按既有受控清单完成微信操作后再运行常驻入口。未配置出站开关时依旧只接收；真实发送授权沿用 P1，不因常驻改变。

启动顺序是 PostgreSQL 可查询 → 应用编号迁移 → 核心 readyz → 桥接 healthz。强制核心 `START_PAUSED=1` 和回环绑定；桥接先设置账号故障暂停再恢复账本，健康探测成功也不自动恢复。异常退出后先逆序停止所有自己创建的依赖，再以 1/2/4…最多 30 秒退避重启整组；连续稳定运行一分钟后退避重置。停止失败时终止守护，不再启动重叠进程。按 Ctrl+C 逆序停止，数据库使用 pg_ctl fast stop；Windows 终止 Node 子进程可能是硬退出，重启仍执行未知发送恢复，不能视为安全送达。

日志在忽略目录 `.local-stack-logs/stack.jsonl`，每文件最多 1 MiB，最多 5 份轮转副本。只保留固定进程事件以及模型调用的快照/调用 UUID、登记版本、结果、时延和 token 数；未知 stdout/stderr 原文丢弃，不记录消息、路径、环境变量、平台标识、URL 或凭据。日志写入失败会停止整组；日志数量不是完整审计，发送事实以数据库账本为准。试用报告可读取当前与轮转日志；旧日志仍按已有未知指标规则处理。私有目录的 Windows ACL 需本人配置，脚本的文件 mode 不等于 Windows 权限保证。

人工演练只在本人在场、全局暂停、测试号且发送关闭时进行：

1. **微信退出**：本人关闭微信，等待一个检查周期，总览出现“微信进程已退出”，同账号所有联系人包含 ACCOUNT_FAULT；记录截图与版本，不恢复/重试旧发送。重新打开微信后更新进程 PID并重启常驻入口，由本人重新完成必要受控操作。
2. **助手无响应**：本人采用既有安全退出步骤停止 helper 或制造受控端点不可达；检查显示“helper 无响应或响应异常”。探测超时为 3 秒；不得靠重启时重新注入绕过验证。修复由本人执行。
3. **疑似 hook 失效**：在测试号受控退出登录且无有效回调的情况下等待默认 5 分钟，再等一个检查周期；checkLogin 非 1 才显示“长时间无事件且登录探测异常”。只安静、但 checkLogin 正常不会被判故障。已登录但 hook 静默失效无法由此证明，须本人安排一条受控入站验证。
4. **核对与恢复**：健康探测成功后总览仍显示等待本人恢复。联系人页“恢复联系人”只清除一个暂停原因；ACCOUNT_FAULT 在未健康时会被拒绝。存在未知发送时必须先按既有证据核对流程处理；其余暂停原因逐项审核。确认所有旧候选/未提交任务已失效，再由本人决定是否解除全局暂停。禁止补发旧任务。
5. **常驻重启**：本人停止一项由常驻入口创建的测试子进程，观察依赖逆序停止、退避和顺序重启；再次核对启动即暂停。终止常驻入口自身后不会自动复活，开机自启和整机常在线留到 P5。

本卡自动验收使用 fixture HTTP、模拟进程状态、合成平台数据和隔离 PostgreSQL。以上真实人工演练尚未执行。
