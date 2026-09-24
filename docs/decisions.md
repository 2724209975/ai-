# 决策记录与待定问题

本文件是产品/架构决策状态的唯一登记处。`Proposed` 是可继续开发的可替换工程默认值，不代表产品确认；`Blocked validation` 是必须实测；`Open` 需本人决定。本人决定后记录日期、结论、依据和影响，并同步 PRD/契约/测试。

## 已作架构决定

| ADR | 状态 | 决定 | 依据与后果 |
| --- | --- | --- | --- |
| A01 | Accepted 2026-09-22 | TypeScript 模块化单体、PostgreSQL 持久任务、API+worker、单机 Compose | 个人项目降低运维复杂度；模块只能经公共端口协作；未来有测量依据再拆服务 |
| A02 | Accepted | 02 是唯一业务发送授权/调度入口；01 只执行平台动作；04/05 永无发送凭据 | 对应用户强制架构规则；契约和依赖检查需防止旁路 |
| A03 | Accepted | inbox/outbox 至少一次、联系人 generation/CAS、持久 sendKey、未知结果 fail closed | 处理重复、并发、崩溃与平台非事务边界；不宣称 exactly-once |
| A04 | Accepted | live/import/trial/replay 强类型隔离；只有 live 可建 SendTask | 防止历史导入与技能试用误发 |
| A05 | Accepted | 单库先承担业务存储、任务队列与关键词检索；暂不引入 Redis/消息中间件/向量库 | 减少一致性和运维负担；性能/质量证据出现后再评估 |
| A06 | Accepted | 模型、媒体存储、平台均通过端口替换；第一闭环用 fake model + mock adapter | 让 D01/D06 未定时可开发，模拟结果不得计为真实接入验收 |
| A07 | Accepted 2026-09-23 | 采纳 01 的 P01–P06 与 02/03/04 的裁剪上下文、候选分条提案，语义写入 contracts.md v0.2.0 | 逐能力证据、unknown 来源更正、媒体完整性、原子接纳/发送账本、02 租约及已批准素材可信读取成为公共设计；机器 schema/生产事务实现仍待 G0，不能据此宣称已集成 |
| A08 | Accepted 2026-09-23 | 审定 01 后续 P01/P02：自身账号来源不明使用 `PlatformSelfMessageUnattributed`，后续更正复用 `PlatformOriginResolved`；`reconcile` 返回带覆盖证据的 `RecoveryReport` | 未知来源不得伪装联系人入站或本人接管；历史覆盖和发送未知需分别判定。旧消费者不识别新事件时保持暂停，真实微信/QQ 能力仍需实测 |
| A09 | Accepted 2026-09-23 | 审定 03 提案：同步 `readContextProjection`/依赖 epoch、独立 OwnerDataQueryPort；全局迁移号 0001 核心、0002 数据，PostgreSQL 同库事务与受限读取 | 02 的每条发送必须在租约内复核最新依赖；03 变更同事务提升 epoch 并写 outbox。首批 SQL/基础端口已落盘，02/03 生产 provider、独立数据库角色和真实 PG 验证仍需 07 集成 |
| A10 | Accepted 2026-09-23 | 审定 04 媒体提案：保留 `unsupported` 原类型，缺可靠解释进入 `PAUSED_MEDIA`；分析 claim 保留正反证据、替代解释和不确定性 | 02 mock 桥接已修复并回归；媒体解释引用为可选新增，缺失不能默认为完整。`MODEL_UNAVAILABLE` 进入故障暂停；正式 taxonomy 仍待 D10 |
| A11 | Partial 2026-09-23 | 批准 06 的 G1 最小 Owner REST 路由和通用可操作资源/命令形状；其余提案路由暂不冻结 | 先让 02 待办/确认/暂停与 06 联调，后端重算 `allowedActions`；鉴权、CSRF、03/05 provider 和其他路由完成后再审。前端现有页面不代表后端能力已交付 |
| A12 | Accepted 2026-09-23 | 采纳 03 修复后的事实 RLS 策略为全局迁移 `0003_data_scope_fix.sql`：把空字符串 `app.contact_id` 视为无 scope，`USING`/`WITH CHECK` 同时收紧；已应用的 `0002_data.sql` 不改写 | 07/03 在隔离 PostgreSQL 17.11 真实复现“提交后无 scope 仍可读 global fact”；修复后受限非 BYPASSRLS 角色的无 scope 读/写负测通过。历史 `0002` 与可重放的泄漏脚本保留作证据；回滚只能发布后续迁移，不能恢复已证明泄漏的策略 |
| A13 | Accepted 2026-09-23 | 采纳 02 的确认/发送持久化为全局迁移 `0004_orchestration.sql`（`orch_conversations/plans/confirmation_tasks/send_tasks/owner_commands/control_commands`，含组合外键与唯一键）；02 持久 provider 与 03 `PgDataProvider` 共用同一事务和 advisory 发送边界 | 02 的 `schema.proposed.sql` 由该编号取代，不再作为并列真源；真实 PostgreSQL 的文字确认、逐条发送、worker 重启恢复、依赖 epoch 失效与未知发送阻断用例通过。自动模式、鉴权 Owner API、持久调度与真实平台仍未交付 |
| A14 | Accepted 2026-09-23 | 单人管理端采用「scrypt 口令哈希 + 服务端会话」：口令用 `node:crypto` scrypt（N=2^15、r=8、p=1，参数随哈希存储并在校验时重新限定上界），会话令牌只存 SHA-256；cookie 为 HttpOnly、SameSite=Strict（HTTPS 下 Secure），写操作要求精确 Origin、与会话绑定的 CSRF 令牌与 JSON 请求体，登录按来源限速并永不区分「用户不存在」与「口令错误」 | 不引入第三方依赖即可满足「成熟口令哈希 + HttpOnly 会话 + CSRF/Origin 校验与限速」的既有要求，口令与令牌明文不入库、不入日志。会话暂存私有目录（`SESSION_DIR`，目录 0700/文件 0600/原子写），可整体撤销；升格为编号迁移表、单设备撤销与登录审计仍是后续独立提案 |
| A15 | Accepted 2026-09-23 | `0005_orchestration_states.sql` 把持久会话状态词汇补齐到 contracts.md §5（只放宽 CHECK，不改写数据）；`0006_orchestration_scheduling.sql` 增加聚合批次列与到期索引，02 由 worker 定时领取到期批次并提交已批准分条 | 聚合窗口默认 0 表示保持即时生成；窗口大于 0 时批次内容与截止时间持久化，进程崩溃后由 `recover()` 补做，模型调用仍在锁外，提交靠 generation CAS，重复 flush 不产生第二个方案。暂停中的联系人只记录来信、不进入聚合 |
| A16 | Accepted 2026-09-24 | QQ 真实接入入口落盘为 `apps/bridge` 组合根：入站鉴权以 **OneBot 签名**为主路径——2026-09-24 实机核查纠正了先前的错误结论，NapCat 的 `token` 不是 Bearer 凭据而是 **HMAC-SHA1 签名密钥**（`napcat.mjs` 中 `n["x-signature"]="sha1="+HMAC(token, body)`，并带 `x-self-id` 头），正好对应 01 既有的 `verifyWebhook`；桥接因此优先走签名校验，另保留传输层 Bearer 作为其他桥接的备选；原始事件字节私密落盘，并与 inbox 去重行、outbox 事件在同一事务提交，之后才交 02 业务消费；出站只能经 02 的 `withDispatchLease` 与发送账本，桥接自身不持有发送授权。`PgConfirmedService` 的平台依赖由具体 `MockPlatformAdapter` 改为结构化端口 `DispatchPlatform`，mock 与 QQ 桥接都满足它 | 不改变公共对象、事件、状态或 Owner API；01 的验签入口保留给会签名的桥接，两种入口共用同一套状态码与去重语义。未验证项：真实 NapCat 是否发送 `X-Self-ID`、是否会重放事件、传输层 token 是否足够可信。因此部署必须保证桥接端口不公网暴露（仅 07 的反代内侧），且本人发言 mapper 未经实测前不得把自身消息归类为 owner |
| A17 | Accepted 2026-09-24 | 批准 02 的 AC04 mock 自动发送最小纵切与私有证据表，落为全局迁移 `0007_mock_auto_approval.sql`：仅当持久策略为 `sendMode=auto`、02 构造显式开启 `mockAutoEnabled`、适配器确为 `MockPlatformAdapter`、04 判定可回复且风险仅 ordinary、触发消息为 live 文字时，才自动生成第一候选的固定分条 SendTask；默认关闭 | 自动方案不伪造本人确认票据，另存 `orch_mock_auto_approvals`（方案、内容 hash、批准时 policy/generation/dependency/skill 版本与原因）；每条仍经 `withDispatchLease` 复核，任何新消息、接管、策略变化、未知结果或部分发送中断按既有机制取消余条。QQ/微信桥接与其他适配器不能启用该路径，因此真实平台自动发送仍不可用。公共自动方案事件形状未定，暂不发布 `ReplyPlanProposed` 的自动变体；`approvalSource=mock_auto|owner_confirmation` 目前只是 02/06 私有投影字段，尚未写入公共契约 |
| A18 | Accepted 2026-09-24 | 05 Skill 持久化全局迁移号 `0009` 已写入 `db/migrations`（`0008` 归 03，编号必须连续）。审查修订了 RLS 写法（FORCE + 覆盖各命令的 USING/WITH CHECK 策略）、把 `visibility_scope` 限定为 global，并显式记录全局表写入者尚未做角色隔离 | 审查前保持 proposed，`db/migrations` 不得占用该编号；D12/D13 仍 Open，导入格式、内置清单与执行规则未定；迁移现有内存数据时不自动授予 grant，试用与导入不写 live。已应用后只能回退消费者，不能删除历史版本或调用记录。2026-09-24 审查曾判定不通过（受限角色无法写入），修订后受限角色可在自身 scope 内写调用记录、跨联系人写入被 RLS 拒绝，真实库用例通过；见 [审查记录](reports/05-skills-persistence-review-2026-09-24.md) |
| A19 | Accepted 2026-09-24 | 采纳 03 的平台撤回/编辑同事务失效端口提案，分配全局迁移号 `0008` 给只追加审计表 `data_platform_message_mutations`；端口 `invalidatePlatformMessage(tx,{contactId,conversationId,platformAccountId,platformMessageId,platformEventId,mutation,rawEventRef,receivedAt},correlationId)` 与 02 的 `consumeOnce`、发送边界同事务，返回 `applied/duplicate/unmatched` | 撤回/编辑一律按"旧证据不再可信"处理，不读取也不猜测新正文；`unmatched` 同样保留审计并要求人工核对，不能当成安全恢复；只按 live+账号+会话+平台消息 ID 关联，禁止仅凭平台消息 ID 跨联系人检索；表启用并强制 RLS。D09 的编辑正文语义仍待 01 真实样本，D07 私有数据生命周期未定 |
| A20 | Accepted 2026-09-24 | 03 的来源更正（`PlatformOriginResolved`）持久化审计预留后续编号 `0010`，须待 01 明确事件证据格式后再写迁移；同时批准 06 的 G2/G3 只读投影新增可选字段 | 06 新增 `connectionQueryStatus`/`faultQueryStatus`（`ready/unavailable`，字段缺失按 unavailable）与 connections[] 的账号/能力/恢复字段；空数组不得解释为"已连接"或"无故障"，`unresolvedSendCount` 只能取 RecoveryReport 的受控聚合；来源未明只展示"人工核对"，更正后不自动解除暂停。字段均为可选，机器 schema 与 provider 随实现补齐 |
| A21 | Accepted 2026-09-24（第 0.5 步实测通过，待只接收 spike） | 微信接入路线由本人在 2026-09-24 选定 **wxhelper**（Windows 注入 Hook：有 MIT 许可文件，另附 README「仅学习研究／勿商用」声明）。**第 0.5 步已实测通过**：本机微信 `WeChat.exe` FileVersion **3.9.11.17 为 x64**（PE machine=0x8664，装在 Program Files (x86) 里）；按 x64 编译上游 `dev-3.9.11.19`（commit `7d290e45`，`WECHAT_VERSION=391119`）的 DLL 并注入成功，`POST /api/checkLogin` 返回 `code=1`，微信未崩溃，HTTP 服务仅监听 `127.0.0.1:19088`（本机 config.ini 覆盖了上游默认的 0.0.0.0）。编译期与运行期共四处本地改动：补 Detours 的 CMake 定义、`wechat_service.cc` 三处调用点转型、`config.cc` 日志改到 `%TEMP%`（原相对路径写只读安装目录导致 `DllMain` 失败、`LoadLibrary` 返回 0）、注入器不再强制 SeDebugPrivilege。**尚未安装任何消息 hook**，因此没有任何消息数据流出 | 记录与清理方式见 [platform-wechat-wxhelper-2026-09-24.md](reports/platform-wechat-wxhelper-2026-09-24.md)，计划见 [wechat-wxhelper-plan.md](platforms/wechat-wxhelper-plan.md)。下一步是第 1 步只接收 spike：把 hook 推送接到本项目的接收端、由知情测试好友发文字/图片/语音/表情各一条、私密留存原始字节，再产出微信版报告与快照。3.9.11.17 与偏移表只在 checkLogin 这一条路径上验证过，其余路径的兼容性仍待实测。微信能力维持六族 `unknown`（快照不变）；不改公共对象、事件、状态或 Owner API；QQ 侧 CONDITIONAL 结论不受影响 |

## PRD D01–D13

| ID | 状态 | 推荐方案 | 需要本人/实测决定 | 阻塞影响 |
| --- | --- | --- | --- | --- |
| D01 微信、QQ 接入 | 2026-09-24：**QQ 半场完成**——只接收 + 两次受控真实发送实测，判定 CONDITIONAL 并经本人确认（报告 docs/reports/platform-qq-2026-09-24.md：收/发/回执三族 tested，另三族 unknown；升级项=已批准表情、本人/回显区分、AC23）；**微信推迟（本人选 B）**，同日后本人改选 **wxhelper** 注入路线（见 A21）；宿主本机 Windows，阿里云后置；非官方路线与账号风险已由本人接受 | 先做两平台 time-boxed spike；目标是本人现有个人账号与既有好友会话，机器人只作能力探针，不替代目标场景 | 已决定：先 QQ 后微信；微信路线选定 wxhelper；已接受风险与许可；已具备测试账号与知情测试联系人。仍需：微信第 0 步（3.9.x 能否登录）实测 + 登录时本人在场扫码；阿里云宿主参数（后置） | QQ 只接收证据已取得（CONDITIONAL）；升到 GO_CONFIRM_ONLY 需本人授权一次受控真实发送，并另测本人/系统回显、媒体完整获取、断线补齐；AC23 关机运行后置到阿里云阶段；微信半场仍为六族 unknown，路线可用性待第 0 步实测（计划见 docs/platforms/wechat-wxhelper-plan.md） |
| D02 外部通知 | Open | 首个闭环只做网页待办；之后选一个可靠推送渠道并测送达，通知只含最少敏感信息 | 可接受渠道、是否付费、内容隐私 | 不阻塞网页闭环；阻塞可靠后台通知声明 |
| D03 确认后恢复 | Open；临时安全默认 | 自动模式因普通待确认暂停：确认发送后仍保持暂停并显式恢复；拒绝/缺事实/接管/未知结果始终手动恢复 | 是否采用“发送并恢复”独立按钮作为便捷动作 | 影响 02/06 状态与 UX；不阻塞保守实现 |
| D04 时序参数 | Open；运行时配置 | 默认只用于开发夹具：聚合 8s、最大聚合 30s；回复延迟 0；主动联系默认关闭；所有时区必填。生产值需试运行 | 个人时区、各联系人允许窗口、冷却/频次、期望回复延迟 | 阻塞主动联系真实启用与体验验收；不阻塞结构 |
| D05 历史导入 | Open，等待样本 | 第一种格式只在取得原始导出样本后实现；先建 preview/identity mapping/import 隔离框架 | 每个平台脱敏样本、导出方式、跨平台映射 | 阻塞具体解析器和历史初始分析 |
| D06 部署/模型/费用 | Open；本人已确认有阿里云服务器，实例参数未核实 | 先只读核查现有实例；按文本、图像/动态表情、语音分别做供应商试验；预算硬上限与用量告警 | 现有实例系统/架构/CPU/内存/磁盘/已有业务；月预算、数据地区偏好、联系人/日消息量、时延/可用性目标 | 阻塞真实部署、模型、容量与费用结论；不阻塞 mock 闭环 |
| D07 生命周期 | Open | 先不写生产删除承诺；实现可配置保留、到期、删除传播和备份清除证明 | 消息/原媒体/识别/模型输入输出/日志/反馈/备份各自期限 | 阻塞生产数据政策与备份验收 |
| D08 质量门槛 | Open | 建立时间截断、本人标注的小样本；安全 AC 100% 通过，体验指标先报告基线再定门槛 | 样本与最低可接受质量、评价覆盖率 | 阻塞“效果达标”声明，不阻塞功能闭环 |
| D09 平台变更事件 | Blocked validation | adapter 能表达 edit/delete/recall/rename/missing；影响证据时递增 generation 并失效派生物；无法获取则展示限制 | 根据 D01 路线实测 | 阻塞对应平台行为定义 |
| D10 分析体系 | Open | 采用 PRD §15 的自然语言六维和建议阶段做可替换 `taxonomyVersion=draft-1` 试验；UI 明示“草案” | 是否采用这些维度/阶段，是否需要人格框架，最小证据规则 | 阻塞正式分析标签；不阻塞证据快照骨架 |
| D11 分析更新/质量 | Open | 新有效对话/明确事件/手动刷新进入去重队列；最低证据不足输出 unknown；不得把自评分作准确率 | 时间窗口、更新频率、成本、评审样本 | 阻塞生产自动更新策略与质量声明 |
| D12 Skill 格式/清单 | Open | 首版候选：结构化表单+受限 Markdown；内置清单沿用 §16.2 作为草案；导入只解析不执行 | 确认格式、大小限制、内置清单、是否兼容某外部格式 | 阻塞正式导入器/内置内容，不阻塞版本库 |
| D13 Skill 组合/执行 | Open | 首版只执行声明式指令和案例；不运行代码、不装依赖、不联网；每阶段最多 1 个 Skill，手动合规指定优先，否则基础流程/人工 | 是否接受限制、冲突优先级、超时预算 | 阻塞完整执行器；保守方案可先实现 |

## 建议集中确认的产品选择

第一批只需本人决定 5 项，其他参数可等 spike/试运行：

1. D01：目标已固定为现有个人微信/QQ 账号的既有好友聊天；需要决定可接受的常在线桥接路径及相应风险。
2. D01：真实接入 spike 先做微信还是 QQ。推荐先验证更关键、使用量更高的平台，同时用 QQ 官方机器人做 adapter 机制参照，但不把机器人单聊算作原账号接入。
3. D03：推荐“确认并发送”后保持暂停，另提供明确的“发送并恢复自动”动作；人工接管永远单独恢复。
4. D06：先只读核查现有阿里云实例，再确定月预算上限、数据地区偏好、预计联系人数量和日均文字/图片/语音/动态表情量。
5. D13：推荐接受首版 Skill 仅声明式、无代码/依赖/网络，每阶段最多一个。

## 决策模板

```text
ID / 日期：
状态：Accepted / Rejected / Superseded
结论：
可观察验收标准：
依据和限制：
影响文件/模块/AC：
迁移或回滚：
```
