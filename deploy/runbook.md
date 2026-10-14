# 运行与恢复手册（07 初稿）

2026-10-11 v2独立预发布已有可执行启停、升级、重启与冷恢复入口，见[指南](../docs/prerelease-v2.md)和[报告](../docs/reports/v2-prerelease-2026-10-11.md)。只运行本机隔离副本，不替换日常环境，不启用真实模型/Bridge/自动发送；真实平台生产恢复仍未验收。

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
2. 必填 `DATABASE_URL`、`OWNER_ID`、`OWNER_PASSWORD_HASH`（scrypt 存储格式）、`PUBLIC_ORIGIN`、`CORE_PLATFORM`；`HOST` 默认 `127.0.0.1`，绑非回环地址必须显式 `ALLOW_NON_LOOPBACK_BIND=1`，非回环 `PUBLIC_ORIGIN` 默认要求 HTTPS；同一 Wi-Fi 下的私有 IPv4 HTTP 访问见下节，须另设 `ALLOW_LAN_HTTP=1`。
3. 启动即暂停：进程先读 `dispatch_global_control`，活动态则调用 02 的 `pauseAll`，然后才 `recover()`。暂停态重启只记录、不重复抬高 epoch。只有本人显式恢复后才会有可派发工作。
4. 就绪检查：`GET /healthz`（存活）、`GET /readyz`（`database`/`schema`/`control`/`recovery`）。`/readyz` 为 503 时不要给它派工，也不要据此自动重启掩盖故障。
5. 日志为单行 JSON，每个请求带 `X-Request-Id`；错误响应体里的 `correlationId` 与日志行同值，可用于串联。日志不含正文、口令、平台标识。
6. 一个核心进程只应服务一个平台账号：`/api/v1/contacts` 的平台标签来自 `CORE_PLATFORM`，账号→平台的持久映射尚未实现。

### 候选模型（DeepSeek）

默认 `INTELLIGENCE_PROVIDER=persistent-fake`。启用真实模型：设 `INTELLIGENCE_PROVIDER=deepseek` 与 `DEEPSEEK_API_KEY`（缺密钥进程启动即失败），可选 `DEEPSEEK_MODEL`（默认 `deepseek-flash`，可改 `deepseek-v4-pro`）、`DEEPSEEK_BASE_URL`、`DEEPSEEK_THINKING`（默认 `disabled`）、`DEEPSEEK_TIMEOUT_MS`、`DEEPSEEK_MAX_TOKENS`、`DEEPSEEK_TEMPERATURE`、`DEEPSEEK_DATA_REGION`、`DEEPSEEK_RETENTION_POLICY`。微信桥接另设 `WECHAT_INTELLIGENCE=deepseek`，与 `WECHAT_ENABLE_OUTBOUND` 相互独立。

**回复更像真人（2026-10-04 起默认）**：DeepSeek 候选使用 `reply-candidates-3`：从本联系人的最近消息中取本人真实回复作为示例、统计本人说话习惯（句长、句号、表情、口头禅），写入图片描述，并把回答拆成 1–3 条短消息、去掉 Markdown 和 AI 腔。**连续消息合并**：日常建议在核心、QQ 桥接、微信桥接都设 `AGGREGATION_WINDOW_MS=10000`（最后一条消息后等 10 秒再生成，对方连发几条只出一次候选），`MAX_AGGREGATION_MS` 默认 30000；默认 0 表示立刻生成。

**失控闸**：`DEEPSEEK_DAILY_CALL_LIMIT`（默认 300）与 `DEEPSEEK_DAILY_TOKEN_LIMIT`（默认 500000）按 UTC 日计数，超出即拒绝调用；04 把拒绝映射成 `MODEL_UNAVAILABLE`，02 据此暂停该联系人转人工。它是**进程内的循环闸**：重启清零，不能当作月度预算、也不代表账单上限；月度成本以平台账单与 `model_call` 日志对账。

密钥只从环境变量读取：不写入配置对象、日志或错误文本；baseUrl 只接受 https 且不得带凭据、查询或片段。地区与保留策略是操作者声明，默认 `provider-default-unverified`，不构成供应商承诺。模型只提供候选文本，决策、事实与边界检查、确认、租约、账本与未知结果处理都不变——**接入模型不放宽任何发送权限**。启动日志里出现 `model_provider_selected` 与 `runtime_started` 的 `intelligenceModel` 即表示已生效；每次调用另有一行 `model_call`（模型/提示版本/地区/结果/时延/输入输出 token，不含正文），用于对账成本。

成本参考（2026-09-26 官方定价页）：`deepseek-flash` 每 1M token 输入未命中缓存 $0.15 谷/$0.3 峰、输出 $0.6 谷/$1.2 峰；峰时为 UTC 周一至周五 01:00–04:00 与 06:00–10:00（北京时间 09:00–12:00、14:00–18:00），其余时间为谷时。账单以平台为准，本手册只记录当时页面事实。

### 微信原文件获取（P4-4，默认关闭）

默认不取原文件：图片和语音照旧转人工。开启后桥接在收信时把**图片**取回并私有落盘；**语音取不到**——本固定 helper 构建的 `GetVoiceByDB` 是空壳（`return 0`），所以语音一次请求都不发，继续转人工。

- `WECHAT_MEDIA_FETCH=1` 才开启，且必须同时给两个**绝对**路径：`WECHAT_DATA_PATH`（微信数据目录）与 `WECHAT_MEDIA_DIR`（私有媒体目录，不能放在网页静态目录里）。缺任一项进程**启动即失败**。
- P4-4a 修复：桥接媒体查询与归属回查在联系人 scope 的事务中进行，运行角色仍须 NOBYPASSRLS；消息先提交、媒体后补绑定，第二段事务同步抬高 epoch 并使旧快照失效。预先中止不调用 helper，迟到结果直接丢弃。测试只用假 helper。
- P4-4b 完整性：`npm ci` 安装精确锁定的 sharp 0.35.5 与平台对应原生包；不要省略 optional dependencies，也不要把 Windows 的 `node_modules` 复制到其它宿主。解码以隐藏子进程完整读取像素，最多 2 并发/父进程、16,777,216 像素、10 MiB 文件，缺失解码器或不能启动时转人工。默认 8 秒总时限覆盖 helper、分段文件轮询、限量读取与解码；只取已经完整且验证后未变化的字节。APNG/动画/BMP 暂不支持。其它宿主的原生兼容性仍需在部署卡实测。
- 可选：`WECHAT_WXHELPER_BASE_URL`（默认 `http://127.0.0.1:19088/`，只接受 http + 回环 + 无凭据/查询）、`WECHAT_MEDIA_MAX_BYTES`（默认 10 MiB）、`WECHAT_MEDIA_POLL_MS`（默认 250）、`WECHAT_MEDIA_POLL_TIMEOUT_MS`（默认 8000）。
- `GET /healthz` 的 `mediaFetch` 只报计数与固定原因码：`{enabled,image,voice:'unsupported-by-helper',disabled,attempted,fetched,unavailable,duplicate,lastReason}`。不含路径、消息 ID 或联系人。
- 失败一律降级为转人工且**不重试**：`TRANSPORT_FAILED`、`HELPER_REJECTED`、`FILE_NOT_WRITTEN`、`FILE_TOO_LARGE`、`DECODE_FAILED`、`PATH_INVALID`、`VOICE_UNSUPPORTED_BY_HELPER`。
- **消息 ID 上限**：helper 用 nlohmann 按 int64 解析 `msgId`，而桥接的请求体是 JSON 数字；超过 2^53 的 ID 会被 JSON 解析器四舍五入成另一个 ID。桥接因此**主动拒绝 16 位以上或大于 2^53 的 ID**（`WX_MEDIA_MSGID_UNSAFE`），宁可转人工也不去取错的消息。真机复测时若真实 ID 超限，必须先决定改协议（例如让 helper 接受字符串 ID）再开启。
- 真机只接收复测（本人执行）：①暂停并确认无未决发送；②启动微信 3.9.11.25、注入同一 helper；③用测试号发一张图片；④核对 `/healthz` 的 `mediaFetch.fetched` 增 1、数据库有一条 `data_media_assets`（`stored/complete`）且对应消息 `media_id` 非空；⑤确认该图片会话按预期转人工；⑥再发一条语音，确认 `mediaFetch` 不出现语音请求、语音仍转人工；⑦全局暂停并保留证据。
- 已知未决点（复测时一并回答）：`downloadAttach` 是否在本机真的写出文件（依赖 `kGetMgrByPrefixLocalId`/`kPushAttachTask` 移植偏移）；保存图片后 `.dat` 的实际位置是否等于 `GetCurrentDataPath()`；真实 `msgId` 是否在安全整数范围内。

### 媒体理解 provider（P4-3 / P4-4c，默认关闭）

P4-4c 已装配图片确认模式的受控流程：消息提交后，锁外获取并验证图片，短事务复核后绑定；锁外解释，短事务再复核并通过 03 保存，建立新快照后生成待确认候选。暂停、策略/技能/证据变化或新来信均会拒绝迟到结果，不自动恢复。启用图片会把图片发给配置的模型并产生费用，真实平台与供应商质量尚未验收。

- `MEDIA_VISION_ENABLED=1` 才启用图片：需要 `MEDIA_API_KEY`（或单独的 `MEDIA_VISION_API_KEY`）。**不会读取 `DEEPSEEK_API_KEY`**，文本密钥不能顺手解锁媒体调用。
- 微信桥接同时需要 `WECHAT_MEDIA_FETCH=1` 与原文件/私有目录配置；core 同时需要绝对路径 `MEDIA_PRIVATE_DIR`，对应桥接的 `WECHAT_MEDIA_DIR` 并位于网页静态目录之外。core 只解释已经绑定的资产，不获取平台文件。两个进程使用相同的模型配置，避免即时来信与人工重新生成采用不同解释配置；各自的单进程预算独立计数。
- 只处理已入名单、代理开启且未暂停的确认模式图片批次；缺文件、截断、不支持、解释不确定或超时均转人工。关闭理解开关时保留 P4-4 原文件获取行为。已有有效解释和本人纠正会复用；本人删除解释后不自动重新解释。
- 可选：`MEDIA_VISION_MODEL`（默认 `deepseek-flash`，官方文档称该模型支持图像输入，格式按文件内容判定：JPEG/PNG/GIF/WebP）、`MEDIA_VISION_MODEL_VERSION`、`MEDIA_VISION_DETAIL`（默认 `original`；`low` 会缩放到 512×512，不足以声称全图覆盖）、`MEDIA_BASE_URL`、`MEDIA_TIMEOUT_MS`、`MEDIA_MAX_TOKENS`、`MEDIA_TEMPERATURE`、`MEDIA_DATA_REGION`、`MEDIA_RETENTION_POLICY`。
- 语音 provider 离线契约仍需 `MEDIA_VOICE_ENDPOINT`（完整 https transcriptions 地址）与 `MEDIA_VOICE_MODEL`，但本卡没有语音获取或运行装配：core / 微信入口对 `MEDIA_VOICE_ENABLED=1` 明确拒绝启动（`VOICE_RUNTIME_UNSUPPORTED`），不能把 adapter 存在当作语音可用。
- **独立失控闸**：`MEDIA_DAILY_IMAGE_CALL_LIMIT` / `MEDIA_DAILY_IMAGE_TOKEN_LIMIT` / `MEDIA_DAILY_VOICE_CALL_LIMIT` / `MEDIA_DAILY_VOICE_TOKEN_LIMIT`，默认各 200 次、各 200k token（本人 2026-10-03 确认）。按 UTC 日、按类型分别计数，与文本限额互不占用；重启清零，不是月预算也不是账单上限（D06 未定）。
- 任一开关配置错误（缺密钥、缺端点、非法取值）都会让进程**启动即失败**，而不是等到第一条来信才发现。四项限额即使类型关闭也会校验。
- 未完成：真实图片字节来源、真实模型调用、供应商兼容性、理解质量与本人真机验收。测试只使用合成字节、假 helper/模型及隔离 PostgreSQL。若进程在模型已响应、解释尚未提交时崩溃，恢复可能再次调用；单进程日限额不是跨进程或月费用硬上限。


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

准备好现有 PostgreSQL 集群、已构建网页与私有配置后，运行 `npm run serve:local`。新增必填 `LOCAL_PG_BIN`（含 postgres.exe/pg_ctl.exe 的绝对目录）、`LOCAL_PG_DATA`（既有集群绝对目录，含 PG_VERSION）；数据库必须是 `postgres://...@127.0.0.1:<port>/<database>`，PUBLIC_ORIGIN 默认为 `http://127.0.0.1:<core-port>`；显式启用下节局域网选项后也可配置私有 IPv4 地址。单平台默认桥接端口 19099，可用 `LOCAL_BRIDGE_PORT` 调整；双平台用 `LOCAL_QQ_BRIDGE_PORT` / `LOCAL_WECHAT_BRIDGE_PORT`（默认按启用顺序 19099 / 19100）。所有监听端口必须不同。私有原始事件、会话和集群不要放入仓库。

**双平台设置 `LOCAL_STACK_PLATFORMS=qq,wechat`**，共享 PostgreSQL 和一个 core，独立运行 `bridge-qq` / `bridge-wechat`。未设置时仍由 `LOCAL_BRIDGE_PLATFORM` 选择一个平台（默认 `wechat`）；每个已启用平台都要提供自己的必填变量：

- `wechat`：入口 `apps/bridge/wechat-main.mts`；必填 `WECHAT_ACCOUNT_ID`、`WECHAT_SELF_REF`、`WECHAT_INGRESS_TOKEN`、`WECHAT_PROCESS_ID`，以及已通过哈希守护的两个 DLL 路径。
- `qq`：入口 `apps/bridge/main.mts`；必填 `QQ_ACCOUNT_ID`、`QQ_SELF_ID`、`QQ_BRIDGE_TOKEN`。出站由 `QQ_ENABLE_OUTBOUND=1` 开启，此时另需 `QQ_ONEBOT_BASE_URL`；只接收模式不需要 OneBot 地址，也不需要 `QQ_PROCESS_ID`（未给就视为进程存活）。QQ 看门狗另可用 `QQ_ONEBOT_HEALTH_URL`、`QQ_QUIET_MS`、`QQ_WATCHDOG_INTERVAL_MS`。

账号与平台映射由迁移 `0013` 和桥接注册持久化，`CORE_PLATFORM` 不再决定联系人标签。两个内部账号 ID 必须不同；不要同时为同一账号启动多个桥接。历史 raw inbox 证据冲突或缺失显示「平台待核对」，不能凭核心配置猜测。

脚本不初始化数据库，也不启动微信、helper、登录或注入。集群必须已经停止：即使配置端口空闲，只要启动前仍有 postmaster.pid，也拒绝接管，不能把外部运行在另一端口的集群当作本轮所有。无法确认是否陈旧时由本人核查，不自动删除 PID 文件。已运行的外部数据库/核心/桥接占用端口同样拒绝接管；请本人先停对应外部进程。本人按既有受控清单完成微信操作后再运行常驻入口。未配置出站开关时依旧只接收；真实发送授权沿用 P1，不因常驻改变。

启动顺序是 PostgreSQL 可查询 → 应用编号迁移 → 核心 readyz → 各桥接 healthz。本机栈默认 `START_PAUSED=0`，也可显式设为 `1`；独立入口不设置时仍保留原来的暂停默认值。正常启动不额外制造账号暂停，已有人工暂停、账号故障和未决发送保留。只有全新空库才在 `START_PAUSED=0` 时解除初始全局暂停，不能把启动当作清除本人暂停的操作。桥接核对账本并完成首次健康探测后再启动 worker。局域网配置时仅核心绑定 `0.0.0.0`，桥接与数据库绑定 `127.0.0.1`。

单个桥接异常只停止并重启该桥接；数据库或 core 异常先停止两个桥接，再按依赖顺序重启整组。日志服务名区分 `bridge-qq` 与 `bridge-wechat`。重启使用退避，停止失败则终止守护以免重叠进程。Ctrl+C 停止本轮所有子进程；数据库使用 pg_ctl fast stop。Windows 进程终止后仍须核对含糊发送，不能推断消息已送达。

加载私有配置后可使用无密钥模板：

```powershell
. .\deploy\workspace-stack.example.ps1
npm run build:web
npm run serve:local
```

此模板设置 QQ 接收端口 19099、微信接收端口 19100。同步修改各平台回调目标，否则来信会送错端口。不会修改出站授权开关，不执行登录、注入或真实发送。升级现有运行实例时先停止本人管理的本机栈，保留私有集群和配置，重新构建；`serve:local` 会在 worker 启动前执行 `0013`。若使用单独运行的数据库，先 `npm run migrate`，再重启核心和两个桥接。

### 同一 Wi-Fi 下用手机操作

可使用单平台或双平台模板。加载原有私有启动配置（数据库、本人密码哈希、平台账号与桥接参数），再执行下列命令；模板只覆盖局域网参数，不包含账号或密钥，也不自动读取 `.env`：

```powershell
# 先按 ipconfig 的 WLAN IPv4 修改模板中的 PUBLIC_ORIGIN
. .\deploy\lan-access.example.ps1
npm run build:web
npm run serve:local
```

模板设置 `ALLOW_LAN_HTTP=1`、`ALLOW_NON_LOOPBACK_BIND=1`、`HOST=0.0.0.0`、`PORT=8787`、`SECURE_COOKIES=0`。`PUBLIC_ORIGIN` 必须是电脑实际私有 IPv4 的 HTTP 地址，仅接受 `10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16`；域名、公网地址、链路本地地址和 IPv6 HTTP 不在此选项范围内。关闭选项并把 PUBLIC_ORIGIN 改回 `http://127.0.0.1:8787` 后恢复原来的本机访问。直接启动核心时也使用这些参数；桥接另开进程时显式设 `HOST=127.0.0.1` 和桥接自己的 `PORT`。

Windows 防火墙准备：在**管理员 PowerShell** 中执行 `powershell -File .\scripts\enable-lan-access.ps1 -Port 8787`。规则只允许管理端口的入站 TCP，网络类型为 Private（专用），来源为 LocalSubnet（本地子网），不会开放数据库和桥接端口。脚本可重复执行；电脑 Wi-Fi 须在 Windows 网络设置中标记为可信的专用网络。已有其他广泛放行 Node 的规则需要另外核对；此脚本不会修改其他程序的规则。移除此规则可用 `Remove-NetFirewallRule -Name PersonalChatAgent-LAN-8787`。若管理端口变化，删除旧规则再为新端口创建规则。

启动器输出管理页面地址，等核心就绪后，手机连接同一 Wi-Fi，浏览器打开该地址（例如 `http://192.168.31.17:8787`）。电脑浏览器也使用同一个地址；其他 Origin 的登录和写入会被拒绝。使用现有密码登录，查看来信和候选，编辑并确认；微信发送结果未知时仍须核对原客户端，再在手机网页填写证据并点「已送达并恢复」。联系人设置、全局及联系人现有暂停/恢复功能均沿用原实现，会话时长未调整。

本人最后用真实手机完成一次「收到消息 → 查看候选 → 确认 → 查看发送结果」；自动浏览器测试不替代真机送达验收。电脑保持开机、不休眠；若 IP 变化，修改 `PUBLIC_ORIGIN` 后停止并重启整组，再用新地址登录。若无法连接，先核对私有网络、防火墙和路由器是否开启访客网络/客户端隔离。本轮没有外网访问、手机推送或原生 App。

Windows 单独强杀 PostgreSQL 主进程可能留下连接或后台进程，端口未释放时会保持拒绝重启，不会为此接管端口、删除 PID 文件或停止未知进程。这条进程树恢复路径尚未验收；故障时本人按本轮 PID、启动时间和集群目录核查并处理，保持暂停。离线数据库崩溃演练使用 `pg_ctl stop -m immediate`，原生停止其后台进程并在重启时执行 WAL 恢复，不能据此宣称单杀主进程同样能够自动恢复。

日志在忽略目录 `.local-stack-logs/stack.jsonl`，每文件最多 1 MiB，最多 5 份轮转副本。只保留固定进程事件以及模型调用的快照/调用 UUID、登记版本、结果、时延和 token 数；未知 stdout/stderr 原文丢弃，不记录消息、路径、环境变量、平台标识、URL 或凭据。日志写入失败会停止整组；日志数量不是完整审计，发送事实以数据库账本为准。试用报告可读取当前与轮转日志；旧日志仍按已有未知指标规则处理。私有目录的 Windows ACL 需本人配置，脚本的文件 mode 不等于 Windows 权限保证。

人工演练只在本人在场、全局暂停、测试号且发送关闭时进行：

1. **微信退出**：本人关闭微信，等待一个检查周期，总览出现“微信进程已退出”，同账号所有联系人包含 ACCOUNT_FAULT；记录截图与版本，不恢复/重试旧发送。重新打开微信后更新进程 PID并重启常驻入口，由本人重新完成必要受控操作。
2. **助手无响应**：本人采用既有安全退出步骤停止 helper 或制造受控端点不可达；检查显示“helper 无响应或响应异常”。探测超时为 3 秒；不得靠重启时重新注入绕过验证。修复由本人执行。
3. **疑似 hook 失效**：在测试号受控退出登录且无有效回调的情况下等待默认 5 分钟，再等一个检查周期；checkLogin 非 1 才显示“长时间无事件且登录探测异常”。只安静、但 checkLogin 正常不会被判故障。已登录但 hook 静默失效无法由此证明，须本人安排一条受控入站验证。
4. **核对与恢复**：健康探测成功后总览仍显示等待本人恢复。联系人页“恢复联系人”只清除一个暂停原因；ACCOUNT_FAULT 在未健康时会被拒绝。存在未知发送时必须先按既有证据核对流程处理；其余暂停原因逐项审核。确认所有旧候选/未提交任务已失效，再由本人决定是否解除全局暂停。禁止补发旧任务。
5. **常驻重启**：本人停止一项由常驻入口创建的测试子进程，观察依赖逆序停止、退避和顺序重启；再次核对启动即暂停。终止常驻入口自身后不会自动复活，开机自启和整机常在线留到 P5。

本卡自动验收使用 fixture HTTP、模拟进程状态、合成平台数据和隔离 PostgreSQL。以上真实人工演练尚未执行。

### 完整离线进程演练（P2-x）

QQ 图片默认关闭。配置 `QQ_MEDIA_FETCH=1` 时，缓存目录 `QQ_MEDIA_CACHE_DIR`、私有素材目录 `QQ_MEDIA_DIR` 必须为绝对路径；与 `RAW_EVENT_DIR` 一起设置本人专用 ACL，不放进网页静态目录。媒体与 NapCat 本机缓存必须对桥接可读，不能把另一台机器的路径视为已下载文件。大小上限为 10 MiB，固定 `get_image` 不接受任意 URL、文件标识路径或重定向。

先保持 `QQ_MEDIA_ORIGINAL_VERIFIED=0`、理解与出站关闭；本人安排知情好友发一张测试图，在私有缓存中核对原始文件的尺寸/格式/字节与好友原件一致。核对后本人决定 Q1，记录无身份/正文的结论，再明确当次理解模型预算，才打开原件标志及 `MEDIA_VISION_ENABLED`。下载成功或完整解码都不能单独替代原件核对。QQ 语音与动态表情理解本轮拒绝；任何不确定项仍人工处理。QQ 状态与真机门槛见当前计划。

`tests/integration/postgres-local-stack.test.mts` 新建独立临时集群并实际启动 PostgreSQL、生产核心、模拟桥接及独立模拟 helper，使用持久假模型与合成联系人。它复用 `serve:local` 的进程驱动，生产入口没有 fixture 环境开关，模拟桥接不绕过生产 DLL 守护。

配置 `LOCAL_TEST_PG_BIN` 为包含 initdb/postgres/pg_ctl 的本机原生目录，并配置 `TEST_DATABASE_URL` 后，运行 `node --test tests/integration/postgres-local-stack.test.mts`。新演练不连接该 URL 指向的库；此变量沿用集成门禁开关，新集群使用随机端口。原生 `PG_DUMP_BIN` 所在目录也可作为备选；CI 的容器备份包装脚本不能替代原生数据库目录。完整门禁仍需原有测试库、备份工具、浏览器及网页构建环境。远程 CI 的原生工具准备留到 P6，尚未运行。

演练覆盖启动迁移、核心/桥接硬退出、数据库原生立即停止后的暂停重启、不补发旧任务/未知发送、三类原生模拟 helper 故障、外部端口与不同端口集群保护、迁移取消和本轮进程回收。结果见 [P2-x 报告](../docs/reports/P2-x-local-stack-2026-10-02.md)。不计真实平台闭环；P1 继续使用 [现行清单补充](../docs/reports/P1-current-checklist-supplement-2026-10-02.md)。真实验收如果使用常驻入口，任一异常重启即结束本轮，不因模型计数重置而增加预算；轮转日志对账覆盖完整时间窗，每个文件只传一次。


## 聊天工作台与恢复

登录后默认进入聊天；旧待办、联系人和会话链接进入新的聊天入口。电脑左侧可搜索联系人、筛选平台与待处理状态，手机点击会话进入详情；聊天设置位于右侧面板。聊天内可编辑分条候选、确认、重新生成、不回复及处理暂停。Enter 换行，Ctrl/Cmd+Enter 确认；空内容、旧版本和后端阻塞不能发送。普通查询刷新或切换聊天保留当前登录会话的编辑；退出登录清空。浏览器整页重新加载会结束这些内存草稿。

「一键恢复」清除手动暂停、人工接管，以及最近 30 秒健康探测正常的账号故障；「恢复全部代理」使用相同规则，并显示恢复数与跳过原因；全局暂停时也可直接在当前聊天恢复全部。代理关闭、未知发送、停止联系、事实及媒体待核仍保留专门处理。恢复不会补发旧方案或自动回复积压消息；可在聊天中为最新来信生成新候选。微信回复结果未知时，先在原客户端核对，再点「已收到，恢复聊天」；平台接受不代表送达。

提交中断时页面保留原幂等键，先查询最新状态。只有「重试同一请求」重放相同命令，不自动重发。若已确认但部分回复未发送，逐条查看状态；不能将结果未知的回复当作失败重新发送。运行状态的探测结果超过 30 秒显示未知，探测正常不证明聊天历史完整。

真实验收由本人分别在 QQ 和微信完成一次：来信 → 查看上下文 → 编辑候选 → 确认 → 原客户端核对结果；微信必要时人工标记已收到，再手发一条检查暂停与一键恢复。另在同一 Wi-Fi 手机查看窄屏详情。自动测试只使用合成数据和隔离数据库。

## v2 P6离线验收与逐会话回滚

见[验收指南](../docs/p6-acceptance-v2.md)和[交付报告](../docs/reports/v2-p6-2026-10-11.md)。本轮未部署或启用真实联系人灰度；真实试点须本人逐联系人授权并保持人工审批。回退仅更改pipeline version，保留已提交/送达/未知账本；未知结果先原客户端对账，不能切换管线后盲目重试。
