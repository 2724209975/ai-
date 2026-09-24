# QQ 真实接入 spike 报告（2026-09-24）

> 本报告由 `npm run spike:report` 从能力快照与去敏证据汇总生成；结论字段由人填写，生成器不会推断。模拟、公开文档与本机闭环均不作为平台实测证据。

## 路线、版本与环境

| 项 | 值 |
| --- | --- |
| 平台与账号形态 | qq · 内部账号 01997000-0000-7000-8000-0000000e0001 |
| 适配器版本 | napcat-v4.18.28 |
| 能力快照 | docs/reports/platform-qq-capability-snapshot-2026-09-24.json（总体状态 unknown，逐项推导 unknown） |
| 采样时间 | 2026-09-24T03:50:47.877Z |
| 操作人填写的宿主事实 | 见下 |
| 宿主 | Windows 11 23H2 本机 |
| CPU | 20 逻辑核 |
| 内存 | 15.6 GB |
| QQ 客户端 | 9.9.30.48517 |
| 运行时 | Node v24.15.0 · win32/x64 |
| PostgreSQL | 17.11 |
| 适配器 | qq-onebot bridge（apps/bridge） |

## 能力快照（逐项证据）

| 能力族 | 状态 | 证据来源 | 限制 |
| --- | --- | --- | --- |
| receive_types | tested | run:qq-receive-only-2026-09-24 | 本机只接收实测：文字、图片、语音、QQ 原生表情各一条均由知情好友从原客户端发出，全部被接纳（HTTP 204）并私密留存原始事件字节；本适配器只声明 text、image、voice、unsupported：表情段（face）与未知段记为 unsupported，image 段一律记 image 而不认作静态或动态表情，因此不声明 sticker_static/sticker_animated；每类型仅一条样本；未在真实账号上验证重复投递、乱序、断线补齐与 24h 关机运行（这些目前只有合成夹具证据）；含引用文字的样本正文与引用 ID 正确；撤回样本经审计表记为 applied 并把原正文墓碑化 |
| send_types | documented | https://napneko.github.io/config/basic | send_private_msg 为文档声明；发送窗口、频率限制与幂等键均未实测；本适配器当前只声明 text：已批准表情发送需要 03 的素材读取端口，未接线前对 approved_sticker 一律返回 UNSUPPORTED_CAPABILITY，因此不声明 sticker 发送能力 |
| receipt_levels | unknown | https://napneko.github.io/develop/event | 无实测：当前只能把桥接成功回包记为 accepted，无法区分 accepted 与 delivered，也无法按 sendKey 查询超时后的结果 |
| owner_message_signal | unknown | https://napneko.github.io/develop/event | message_sent 事件已文档化（维护者文档）；本次只接收运行把 reportSelfMessage 关闭，平台未推送自身消息；且缺少经审核的对端 mapper，本人手发与桥接回显无法区分，因此该能力未测，不能算 documented 已达成的可用信号 |
| history_sync | unknown | https://napneko.github.io/config/basic | 无实测：没有可证明的连续覆盖游标；断线重连后的补齐范围与是否丢消息均未测，RecoveryReport.historyComplete 只能为 false |
| media_fetch | unknown | https://github.com/botuniverse/onebot-11/blob/master/api/public.md | get_image/get_record 仍为文档声明（OneBot 公共 API）；本适配器尚未接线媒体抓取：只保存原始事件（内含平台侧不透明媒体引用），因此无法判断原图/原语音/完整动态序列是否可取；这属于本项目待办，不是平台结论 |

## 只接收证据汇总（去敏）

```json
{
  "inbox": {
    "enrolled": 7,
    "discovery_only": 0,
    "unmapped_self": 0
  },
  "messagesByType": {
    "image": 1,
    "text": 3,
    "unsupported": 1,
    "voice": 1
  },
  "duplicateMessageRows": 0,
  "conversations": [
    {
      "state": "PAUSED_FAILURE",
      "count": 1
    }
  ],
  "pauseReasons": {
    "MEDIA_UNCERTAIN": 1,
    "PLATFORM_MUTATION_UNVERIFIED": 1
  },
  "tasks": {
    "pending": 0,
    "resolved": 1
  },
  "sends": {},
  "outboxPending": 0,
  "rawFiles": {
    "files": 7,
    "unreferenced": 0
  },
  "accountId": "01997000-0000-7000-8000-0000000e0001",
  "observedAt": "2026-09-24T03:50:47.877Z",
  "limitations": [
    "只证明事件被接纳并去重后的本地状态，不证明 QQ 已登录、历史已补齐或对方可见",
    "回执只有 accepted 级：桥接受理不等于送达",
    "冲突的同键重放会在接纳时被拒绝并回滚，因此本汇总不记录它们；重复投递按 event key 去重不产生第二行业务副作用",
    "本机闭环（mock 或假 OneBot）的结果不得并入本汇总"
  ]
}
```

## 未验证项与已知限制

- 本快照含 2026-09-24 本机只接收 spike 的实测结果：NapCat v4.18.28（官方包 SHA-256 已核对）以注入方式携带非主力测试账号运行，投递到 apps/bridge 的签名入口
- accountId 为已登记 PlatformAccount 的内部 UUID；QQ 号只留在本机数据库与 NapCat 本地配置，未进入本文件
- NapCat 许可为受限许可，个人测试使用权限需在安装前核清；不复制、修改或再分发其代码
- 事件推送用配置里的 token 作为 HMAC-SHA1 签名密钥（x-signature: sha1=...）并带 x-self-id；部署仍必须保持私有网络且不暴露端口
- 只证明事件被接纳并去重后的本地状态，不证明 QQ 已登录、历史已补齐或对方可见
- 回执只有 accepted 级：桥接受理不等于送达
- 冲突的同键重放会在接纳时被拒绝并回滚，因此本汇总不记录它们；重复投递按 event key 去重不产生第二行业务副作用
- 本机闭环（mock 或假 OneBot）的结果不得并入本汇总

## 风险与人工维护

- 非官方路线风险、许可范围与常在线依赖：见 docs/platforms/qq-spike-plan.md 与 wechat-route-options.md（按平台）。
- 人工维护频率、故障码与断线次数：由操作人在测试窗口内如实记录，未记录即视为未验证。

## 结论

**结论：CONDITIONAL**（由本人确认后填写）

补充说明：

2026-09-24 本机只接收判定：CONDITIONAL（由本人确认）。

已实测（真实账号，只接收）：知情好友发出的文字、图片、语音、QQ 原生表情各一条均被接纳（HTTP 204），原始事件私有留存；文字生成 3 个候选待办；含引用文字的平台引用 ID 记入 provenance；撤回事件经审计表记为 applied 并把原正文墓碑化；全程发送任务为 0（worker 关闭）。

升到 GO_CONFIRM_ONLY 仍缺：
1. 受控真实发送授权 —— 需本人指定约定内容、条数与次数，用于实测 send_types 与 receipt_levels（区分"桥接受理"与"送达"）；
2. 本人/系统回显区分 —— 需打开 reportSelfMessage 并补经审核的对端 mapper；
3. 媒体完整获取 —— 需接线 01 媒体抓取与 03 私有存储（当前只保存原始事件，未下载媒体字节）；
4. 断线与历史覆盖 —— 需实测重连补齐与可证明的连续游标，RecoveryReport.historyComplete 才能为 true；
5. AC23 关机持续运行 —— 宿主迁到阿里云后单独实测。

本次没有发生任何真实发送；模拟、公开文档与合成夹具结果均未并入本报告。
## 对公共契约的变更提案

- 无。若发现契约缺口，先提案，不在本地私加同名字段或状态。

## 2026-09-24 独立复核备注

上文保留原操作人提交的实测记录，**不改写为另一人已复核**。7 条已登记 inbox、6 条 data_messages（文字 3、图片 1、语音 1、unsupported 1）与 1 条撤回事件在数量上相符；7 个原始文件、0 个未引用文件与汇总相符。这只是报告内部算术核对。能力表目前用同一个 `run:qq-receive-only-2026-09-24` 批次引用，尚无逐样本私有证据索引；本轮也没有原数据库或原始事件目录可读，因此原始字节的 SHA-256、平台来源、媒体内容及撤回关联**未由另一人独立核查**。

为补追溯而新增 `npm run spike:manifest`：在原测试环境用私有 `DATABASE_URL`、`QQ_ACCOUNT_ID`、`RAW_EVENT_DIR` 运行，输出每条内部 inbox UUID、接收时间、归类、业务事件/消息类型及原始文件完整性结果。它不输出 QQ 号、好友标识、正文、媒体 URL、文件路径或裸摘要。复核者只在私有环境比对该索引与原始记录，公开报告仅补随机证据编号和逐项通过/失败；原环境不可访问则继续保持“未独立复核”。此工具本身也不能证明 NapCat 从平台补齐历史。

公开来源的 2026-09-24 复查：[NapCat 发布页](https://github.com/NapNeko/NapCatQQ/releases)列有 v4.18.28；[维护者 Windows Shell 指引](https://napneko.github.io/guide/boot/Shell)说明下载 Shell 包及启动方式；[v4.18.28 固定版本许可](https://github.com/NapNeko/NapCatQQ/blob/v4.18.28/LICENSE)是受限条款，个人测试的具体授权范围仍需核清。上文“官方包 SHA-256 已核对”是原操作人的记录，本轮未取得本地包及摘要，**不能作为独立核对结论**。系统版本按本机 build 22631 与[微软 Windows 11 版本表](https://learn.microsoft.com/en-us/windows/release-health/windows11-release-information)核对为 Windows 11 23H2；旧环境清单曾依据注册表 ProductName 写成 Windows 10 Pro。结论继续为 **CONDITIONAL**，不升级为发送或 AC23 通过。

## 2026-09-24 操作人补充（同一人，不构成独立复核）

原测试环境（本机 PostgreSQL 55432 的 `chat_agent_spike`、`.local-napcat/raw-events`）仍可访问，已按复核建议补上可追溯索引：`npm run spike:manifest` 输出 7 条内部样本（6 条 `PlatformInboundObserved`：text/image/voice/unsupported/text/text；1 条 `PlatformMessageMutationObserved`），逐条 `rawIntegrity=verified`（私有原始文件摘要与 inbox 行一致），文件保存在私有目录，不输出 QQ 号、对端标识、正文、URL 或裸摘要。

同时复核了我此前记录的 NapCat 包摘要：本地 `NapCat.Shell.v4.18.28.zip` 的 SHA-256 = `bcdd8bdb9e44bd0cf6a90908e572141787fd9e98cb8d8eecc5adf25bbdcabb94`，与发布页一致。

以上仍属同一操作人的记录；复核方提出的"需要另一人用私有索引独立核对来源、媒体内容与撤回关联"这一条依然成立，结论继续为 **CONDITIONAL**。