# 03 数据与个人记忆：首段可测实现

当前状态只见 [开发计划 §0](../../docs/development-plan.md#0-当前状态每完成一个任务由总控更新本节)；本页保留模块说明与操作约束，不维护测试数字或进度。

`context/store.mts` 是无外部依赖的内存仓储替身，用于 02/04/06 的接口联调与 03 的隔离测试。它不跨进程持久，不提供生产事务或备份。正式 PostgreSQL 实现须遵循 `docs/contracts.md` v0.3.0，并复用这些行为测试。

最小调用顺序：03 创建已加入的 Contact；02 在名单和事件认证门控后调用 `appendObservedMessage`；02 确定 `generation`、`policyVersion`、截止点和允许的事实 scope；调用 `buildContext`，得到 `{snapshot,messages,facts,analyses}`；04 消费此投影。02 在方案创建及每条发送前检查自己的 generation/policy，并读取 03 的事实/证据版本失效结果。`readContextProjection` 会拒绝已删除、已过期或 scope 不再允许的快照。

`postgres/schema.proposed.sql` 保留为 03 的历史草案；总控已将修订版编号为 `db/migrations/0002_data.sql`。`postgres/context-repository.mts` 提供参数化、先按联系人和 scope 裁剪的读取适配，现由 `postgres/provider.mts` 在事务内调用。正式调用必须由可信后端执行 `setContactScope(tx, contactId)`，且使用不具备 BYPASSRLS 的受限数据库角色。`imports/service.mts` 只接收由未来 D05 解析器提供的规范行，预览并确认身份映射后以 `import` 模式写入原型。`media/file-store.mts` 和 `feedback/file-journal.mts` 使用私有持久目录，可跨实例重读；它们是开发阶段的单机实现，不提供跨进程事务或生产备份保证。

`postgres/provider.mts` 是 0002 表上的事务型 03 provider。调用方在 `withTransaction` 或 02 的现有事务内传入同一个 `PgClient`；03 在该事务内完成消息/事实/分析/快照变更、同步 dependency epoch 和 outbox。构建上下文返回 `dependencyEpoch`；02 将其随方案保存，在每条发送的 `withDispatchLease` 中调用 `readContextProjection(tx,{callerContactId,contactId,snapshotId,allowedScopes,expectedDependencyEpoch})`。03 不拥有发送权限，也不替 02 检查 policy/generation。生产角色必须受 RLS 限制，不能使用表 owner/superuser/BYPASSRLS；跨联系人管理读使用独立鉴权端口。

真实数据库联测：设置隔离 PostgreSQL 17 测试库的 `TEST_DATABASE_URL` 后运行 `node packages/data/postgres/provider.integration.mts`，并运行 07 的 `npm run test:integration`。总控已批准并落盘 `db/migrations/0003_data_scope_fix.sql`，修复 0002 的 global fact 无 scope 漏读，0002 本身未改。完整测试数字只见开发计划 §0；生产角色及真实平台须独立验收。见 `docs/reports/03-pg-provider-2026-09-23.md`。

运行：`node --test packages/data/context/store.test.mts packages/data/imports/service.test.mts packages/data/media/file-store.test.mts packages/data/feedback/file-journal.test.mts packages/data/postgres/context-repository.test.mts`。

当前调用者隔离采用 `callerContactId === contactId` 的进程内约束。管理端的本人跨联系人查询需要 API 鉴权并使用独立 owner 查询端口；不能给浏览器直接暴露此仓储。上线时数据库查询仍须加入 `contact_id` / `scope` 条件，并在真实 PostgreSQL 中做越权负测。

## 媒体资产与解释的持久化（P4-2，未装配生产）

`postgres/media-repository.mts` 只由 `postgres/provider.mts` 在 03 的事务内调用；调用方负责事务、`setContactScope` 和发送边界锁，仓储自身不接收浏览器路径或平台凭据。

- `registerMediaAsset` 只登记 03 私有字节存储产出的元数据（`MediaAsset`）：资产必须与同一联系人的 live 来信消息一一对应，`fetch_status=stored`、`completeness=complete`、SHA-256 合法、MIME 与 `mediaType` 相符，且未被批准发送。重复登记返回 `duplicate` 且不重复抬高 epoch。
- `attachMediaToMessage` 是收信后补绑定入口：消息先提交，01 取得字节并经 03 私有存储落盘，再由该方法复用 `registerMediaAsset` 完成绑定。绑定在独立事务里提交，必须同步抬高 epoch、失效旧快照及派生依据、写 `EvidenceInvalidated`。首次绑定返回 `duplicate=false`；精确重放同一资产返回 `true`，不再改变版本或产生事件。共享发送边界锁与消息版本 CAS 拒绝竞争资产，不能用事前查重替代事务复核。桥接读取消息和 `FileMediaStore` 的消息归属回查均使用可信联系人 scope 的短事务，适用于受 RLS 限制的运行账号。
- `storeMediaInterpretation` 把 04 的完整草稿存为新的 `valid` 版本，写入前逐项复核：草稿状态、结构化含义中的 `mediaType/sourceAssetVersion/sourceSha256/promptVersion/dataRegion/retentionPolicy`、覆盖声明（图片 `full_image`、语音 `complete_transcript`）、消息与资产版本（CAS，不符返回 `CONFLICT_VERSION`）、来源消息的 `actor=contact`、`mode=live`、早于 cutoff，以及证据引用必须等于由可信消息绑定与文件哈希构造的两个引用（不采纳模型自报引用）。相同输入的幂等重放返回 `duplicate`。
- `readMediaInterpretation` 只返回最新 `valid` 版本，并把该版本的 `data_evidence` 与当前源消息/资产版本逐项比对；任一不符（含直接改库、缺少某个证据行、来源不再是 live 来信）就按「没有可用解释」返回 `undefined`，不做部分降级。因此这个读路径是同步失效复核，不依赖 outbox 是否被消费。
- `changeMediaInterpretation` 是本人纠正/删除：纠正另存新版本并记 `correctedByOwner`，删除清空正文并让该资产回到 `interpretation_status=pending`。既有版本一律置 `invalid` 且清空正文，只保留版本号与引用。
- 三个写路径都在同一事务内抬高 dependency epoch、使受影响快照失效并写一个 `EvidenceInvalidated` outbox。父消息删除会同时清空解释正文与资产存储引用（`purgeMessage`），由消息删除本身负责唯一那次失效事件。
- 已存在的事实/分析只经源消息引用媒体含义；解释变化时按保守口径失效这些派生项，同时保留引用其他证据或本人的独立事实。派生项失效属于实现安全选择，不是契约承诺。

### 微信原文件获取（P4-4，01 取值 / 03 落库）

桥接在收信后按 `WECHAT_MEDIA_FETCH=1` 取图片原文件：先请 helper 把文件写到微信数据目录（`<WECHAT_DATA_PATH>\wxhelper\image\<msgId>.dat`），桥接自己识别容器并解混淆、完整解码验证，再用 03 的私有 `FileMediaStore` 落盘，最后由 `attachMediaToMessage` 在第二段事务里把资产与消息绑起来。任何一步失败都转人工，**不重发 helper 请求、不改标媒体类型**。默认 8 秒是请求、轮询、读取、解码共用的总时限；中止/超时后的结果不再进入存储。语音在本固定 helper 构建上没有可用获取入口（`GetVoiceByDB` 是空壳），因此一次请求都不会发出。

### 图片完整性验证（P4-4b）

P4-4c 的 `PgPrivateImageReader` 在 RLS 联系人 scope 下读取当前消息/资产绑定，拒绝已删除、非 live/非对方图片及已删除/失效的解释；再从私有目录限量读取字节并核对数据库哈希。文件旁的 JSON 不能代替当前数据库来源与版本。02 只将 04 返回的草稿经现有 `storeMediaInterpretation` 保存；绑定和解释各自正常抬高 epoch，02 只在复核全部原版本后的同事务内承接自身写入产生的 generation，随后建立新快照。

`media/image-validation.mts` 是 01 获取与 04 请求前共享的纯字节验证器。先检查容器分块/结束边界，再在独立 `image-validation-worker.mjs` 子进程中通过精确锁定的 sharp 0.35.5 完整解码像素。文件头识别不再等于完整性；通过后原字节不缩放、不转码，解码后像素只在临时子进程内使用。

只接受 PNG、JPEG、单帧 GIF/单帧 WebP；APNG、多帧图片、BMP 与其它类型失败关闭。微信 `.dat` 解混淆路径仍无 WebP，BMP 虽能识别头也不能通过完整验证。限制为 10 MiB 输入、16,777,216 像素、4 通道、每个父进程最多 2 个解码子进程；默认单次 5 秒，超时/取消杀死并等待子进程退出。不继承应用密钥/数据库 URL，不输出原生错误文本，也不通过 IPC 返回像素。这是资源限制，不是操作系统级内存沙箱。

`media/bounded-image-file.mts` 用文件描述符限量读取并复核前后大小/修改时间，防止外层 stat 后变大的文件绕过内存上限。获取层对未写完的文件在同一总时限内继续轮询，只在内容改变后重试验证；验证完成后再次读取并比较字节哈希，期间被替换的文件必须重新验证。超时、超限、动画或格式错误不会写入媒体资产。验证证明当前字节容器完整且可解码，不证明平台确实取得原图、内容语义正确或供应商支持。
