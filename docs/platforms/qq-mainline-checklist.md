# QQ 文字与图片真机验收步骤

状态：P4-6e 离线准备；尚未开始本轮真机验收。P4-6a～c 已交付，表情发送 P4-6d 搁置。真实操作由本人执行，最终结论由本人判定。本清单不构成发送或付费模型授权。

## 开始前

本轮使用独立的新验收数据库、原始事件目录、素材目录和会话目录。不能沿用微信 P1 的库或把旧 QQ spike 累计数作为本轮计数。QQ 仍为 CONDITIONAL，文字 accepted 回执和系统回显都不代表好友已收到。

先由本人确定 QQ 测试号、一位知情 QQ 测试好友和本轮模型预算；身份、正文、密钥与口令仅留本机。微信登记的好友绑定不能自动用于 QQ。文字阶段建议最多一次文本调用、一次确认、一个文字分条；图片理解另设最多一次视觉调用和一次文本调用，首轮不发送图片候选。本人未明确当次预算时停在离线准备。

本人登录、启动/停止 NapCat、配置 webhook 和真实发送按[开发计划 §2.5](../development-plan.md#25-红线执行-ai-一律不做只能准备好步骤交给本人)执行。这里提供步骤，AI 不执行上述操作。

## 本机配置

使用 Node、已安装 PostgreSQL 和项目现有本机栈，参见 [运行手册](../../deploy/runbook.md)。本人选取互不冲突的数据库、网页和桥接回环端口；OneBot HTTP 端口另外配置。已有集群必须先停止且归本人本轮所有，`serve:local` 不接管其他集群。

| 设置 | 本轮要求 |
| --- | --- |
| `LOCAL_BRIDGE_PLATFORM` / `CORE_PLATFORM` | `qq` |
| `LOCAL_PG_BIN` / `LOCAL_PG_DATA` | 安装目录及本轮独立集群的绝对路径 |
| `DATABASE_URL` | 本轮库，主机必须为 `127.0.0.1`；禁止指向微信或旧试验库 |
| `PUBLIC_ORIGIN` / `LOCAL_BRIDGE_PORT` | 回环网页地址、独立桥接端口 |
| `OWNER_ID` / `OWNER_PASSWORD_HASH` | 本人账号及自己设置口令的 scrypt 哈希；参见 `scripts/owner-password.mts`，不要把口令发到聊天里 |
| `SESSION_DIR` / `RAW_EVENT_DIR` / `QQ_MEDIA_DIR` | 本轮独立私有绝对目录，不能在网页 build 目录里 |
| `QQ_ACCOUNT_ID` / `QQ_SELF_ID` / `QQ_BRIDGE_TOKEN` | 内部账号 UUID、测试 QQ 号、与 NapCat 一致的私有 token |
| `QQ_ONEBOT_HEALTH_URL` | 本人配置的回环 OneBot HTTP 地址，保证只接收阶段也有登录探针 |
| `QQ_PROCESS_ID` | 可选，本人核对后填写；不猜 PID |
| `INTELLIGENCE_PROVIDER` / `COLLECTION_ENABLED` | 核心先用 `persistent-fake` / `0`；来信生成由 QQ 桥接负责，不在核心重复生成 |
| `QQ_INTELLIGENCE` | 预检查为 `persistent-fake`；真实文字阶段经本人授权改 `deepseek` |
| `QQ_ENABLE_OUTBOUND` / `WORKER_ENABLED` | 准备和图片核对阶段均 `0`；文字闭环只由本人当次临时开启 |
| `QQ_MEDIA_FETCH` / `QQ_MEDIA_ORIGINAL_VERIFIED` | 初始均 `0`；核对原图阶段仅打开获取，原件标志仍 `0` |
| `MEDIA_VISION_ENABLED` / `MEDIA_VOICE_ENABLED` | 初始均 `0`；视觉理解需另授权，语音本轮始终 `0` |

所有密钥和本机路径放忽略的私有配置文件，默认模板不得打开出站。文本与媒体限额分别由 `DEEPSEEK_DAILY_CALL_LIMIT` / `DEEPSEEK_DAILY_TOKEN_LIMIT` 和 `MEDIA_DAILY_IMAGE_CALL_LIMIT` / `MEDIA_DAILY_IMAGE_TOKEN_LIMIT` 控制；每阶段建议调用上限设为 `1`。token 计数在回包后累计，进程重启清零，核心与桥接分开计数，不能充当月费用或单次费用硬上限。

建立新集群、空库并迁移到 `0012` 后，只登记本轮好友。现有 `node scripts/qq-spike-enroll.mts` 可在**只有独立数据库运行、核心/桥接/NapCat 全部停止**时使用；它要求 `QQ_SPIKE_PEER` 及建议预先生成固定的 `QQ_SPIKE_CONTACT_ID`、`QQ_SPIKE_CONVERSATION_ID`，用于本轮可追溯绑定。该旧登记脚本会清除全局暂停，因此不得在任何运行中的平台栈上执行。登记完成后停止这一本轮数据库，随后本人用 `npm run serve:local` 启动整栈；核心与桥接都会启动即暂停。旧脚本不是解除验收暂停的方式。

网页预先用 `npm run build:web` 构建。栈默认在 `.local-stack-logs/stack.jsonl` 写脱敏度量并轮转，保留本轮覆盖到的所有日志（包括 `.1` 等归档），不要只取最后一份。不得在候选出现后重启桥接再确认旧候选；启动暂停会使旧方案失效。

## A：文字闭环

1. 本人确认库中只有本轮好友、策略为确认模式，没有旧发送任务或未知结果。记录起始时间（含时区）；查看本机栈、网页和 `/healthz`，应是启动暂停，看门狗 healthy。健康恢复不会自行解除暂停。
2. 本人明确本轮文本调用预算和单次发送安排后，在启动前临时设置 `QQ_INTELLIGENCE=deepseek`、`QQ_ENABLE_OUTBOUND=1`、`WORKER_ENABLED=1` 及回环 `QQ_ONEBOT_BASE_URL`。保持媒体关闭。这只是本人装配派发能力，最终正文仍由网页逐条确认。
3. 本人登录测试号并配置 NapCat 把签名推送送到桥接 `/onebot/event`，token 一致。完成健康检查后在网页逐项解除账号故障、联系人和全局暂停；未知发送不可绕过。
4. 知情好友发送一条普通文字。等候选出现后，核对仅一次文本模型调用；不要点重新生成，也不要在核心请求另一个候选。没有候选或次数不符时暂停，保留整轮证据。
5. 本人核对收件人和最终文字，选择**一个文字分条**并仅确认一次。即使响应超时也不得再次确认或重复发送。
6. 对账应为一个方案、一次确认、一个任务、一次账本提交及平台消息 ID；观察 `agent_echo` 是否出现、是否未触发 `OWNER_ORIGIN_UNMAPPED`。账本未就绪的早到回显仍会暂停，不能通过重放事件消除首次暂停。
7. 好友在自己的 QQ 核对正文一致且只有一条。只在报告记录核对时间和结论；accepted、回显或 ID 相等不能代替此步，也不直接把账本升级为 DELIVERED。
8. 在没有进行中的发送时，本人向同一好友手发一条事先约定的测试文字；这应产生 `unmapped_self` 并暂停账号。单独记录手发样本，不能将它计入助手的一次派发。最终全局暂停。

记录系统回显与 HTTP 回包的先后时，仅依据本人当次能核对的证据；无法确定就记 unknown。数据库接纳时间与当前账本时间不能证明网络完成顺序。

## B：原图核对（Q1，零付费模型调用）

1. 先结束文字轮次、全局暂停并正常停止本机栈。切换到只接收：出站和 worker 均为 `0`，`QQ_INTELLIGENCE=persistent-fake`、`MEDIA_VISION_ENABLED=0`。打开 `QQ_MEDIA_FETCH=1`，填写回环 OneBot 地址、绝对 `QQ_MEDIA_CACHE_DIR`、私有 `QQ_MEDIA_DIR`；原件标志维持 `0`。
2. 本人重启后先检查 healthy，再逐项处理暂停原因。未知发送未核对时不得进入下一阶段。知情好友发送一张事先保存原件的静态 PNG/JPEG 图，不用截图、混合文字图片或动态表情。
3. 取得路径应在本机 NapCat 缓存内，好友本人保留的原件与缓存文件在本机比较字节 SHA-256、尺寸与格式。仅尺寸相同不够；若平台重新编码或找不到原件，Q1 不通过。缓存路径与摘要不要写进共享报告。
4. 原件标志为 `0` 时，本轮不会登记 complete 私有资产或调用视觉模型，图片交人工；不能以此时 `assets=0` 判断取图失败。人工在平台缓存核对，不将资产 completeness、下载成功或解码成功当作 Q1 证据。
5. 本人决定 Q1 并记录无身份的结论。确认原图后才允许下一阶段设 `QQ_MEDIA_ORIGINAL_VERIFIED=1`；不能让程序根据单个成功下载自行开关。全局暂停并停止。

## C：图片理解（Q1 通过后，另计预算）

1. 本人授权最多一次视觉调用和一次文字生成后，保持出站关闭，原件标志设 `1`，打开 `MEDIA_VISION_ENABLED=1` 和配置的视觉 provider。`MEDIA_PRIVATE_DIR` 与 `QQ_MEDIA_DIR` 指向同一本轮私有目录（核心启动也校验这个目录）。QQ 桥接文本 provider 为 deepseek，核心收集仍关闭。
2. 重启会失效旧候选。本人核对健康、策略与暂停后，请好友发**新的一张静态原图**；不要重放 B 的原事件或旧来信。
3. 核对受控取图、complete 资产、有效 full_image 解释、新快照与待确认候选。保留视觉及文字调用度量；图片准备快照与最终方案快照可能不同，不能强行按相同快照绑定一次视觉调用。
4. 本轮只评估解释和候选是否符合图片，**不确认发送**。记录实际调用数与人工质量判断；失败、调用增加或内容不确定时维持人工处理。
5. 结束时全局暂停，再正常停止本机栈；本人停止本轮 NapCat 连接。确认核心、桥接、本轮数据库均已退出，保留证据。不要按进程名批量停止其他数据库或客户端。

## 脱敏对账与报告

在本轮进程停止前、已全局暂停时，另开终端加载同一本轮私有配置。工具仅连接回环数据库，执行 repeatable-read 只读查询，不读原始聊天、图片文件，也不调用 OneBot。填写这一阶段的真实起止时间与本轮联系人内部 UUID：

```powershell
$env:QQ_AUDIT_CONTACT_ID=$env:QQ_SPIKE_CONTACT_ID
$env:QQ_AUDIT_START='<实际起始 ISO 时间，必须含 +08:00 或 Z>'
$env:QQ_AUDIT_END='<实际结束 ISO 时间，必须含 +08:00 或 Z>'
node scripts/qq-mainline-audit.mts .local-stack-logs/stack.jsonl
```

发生轮转时在同一命令中补齐本轮归档文件，最多八份，每份最大 8 MiB；重复 callId 会去重，度量冲突会计入 conflicts，没有 ID 保持不确定。旧日志丢失不能当作零调用。不要仅缩小窗口隐藏失败或额外调用。

输出区分账号级 inbox 与选中联系人的 live 消息、方案、媒体；`current` 是读取时当前状态，账户上旧未决尝试也会显示。方案按创建时间归入窗口，其发送任务包含随后发生的派发。`contactPaused` 表示联系人暂停原因，`dispatchGatePaused` 是派发控制行当前标志，两者不能互相替代；全局暂停另列。

工具始终返回 `verdict=operator_required`。输出中的模型记录只证明操作者提供的日志形状，不能证明付费 provider 或真实平台。最终报告分列 A/B/C，附本轮代码版本、整轮起止时间、调用数、确认/派发数、回显分类、好友人工核对、Q1 结论、异常及最终停止状态。本人判定 QQ 能力时明确范围仅为本轮实际通过的文字/图片能力，表情发送、自动模式、常在线部署仍未验收。
