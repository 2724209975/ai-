# QQ 真实接入 spike 报告（2026-09-24）

> 本报告由 `npm run spike:report` 从能力快照与去敏证据汇总生成；结论字段由人填写，生成器不会推断。模拟、公开文档与本机闭环均不作为平台实测证据。

## 路线、版本与环境

| 项 | 值 |
| --- | --- |
| 平台与账号形态 | qq · 内部账号 01997000-0000-7000-8000-0000000e0001 |
| 适配器版本 | napcat-v4.18.28 |
| 能力快照 | docs/reports/platform-qq-capability-snapshot-2026-09-24.json（总体状态 unknown，逐项推导 unknown） |
| 采样时间 | 2026-09-24T08:55:57.276Z |
| 操作人填写的宿主事实 | 见下 |
| 宿主 | Windows 11 23H2 本机 |
| CPU | 20 逻辑核 |
| 内存 | 15.6 GB |
| QQ 客户端 | 9.9.30.48517 |
| NapCat | v4.18.28（官方包 SHA-256 已核对） |
| 运行时 | Node v24.15.0 · win32/x64 |
| PostgreSQL | 17.11 |
| 适配器 | qq-onebot bridge（apps/bridge） |

## 能力快照（逐项证据）

| 能力族 | 状态 | 证据来源 | 限制 |
| --- | --- | --- | --- |
| receive_types | tested | run:qq-receive-only-2026-09-24 | 本机只接收实测：文字、图片、语音、QQ 原生表情各一条均由知情好友从原客户端发出，全部被接纳（HTTP 204）并私密留存原始事件字节；本适配器只声明 text、image、voice、unsupported：表情段（face）与未知段记为 unsupported，image 段一律记 image 而不认作静态或动态表情，因此不声明 sticker_static/sticker_animated；每类型仅一条样本；未在真实账号上验证重复投递、乱序、断线补齐与 24h 关机运行（这些目前只有合成夹具证据）；含引用文字的样本正文与引用 ID 正确；撤回样本经审计表记为 applied 并把原正文墓碑化 |
| send_types | tested | run:qq-controlled-send-2026-09-24 | 本机实测：本人授权后经管理端确认，向知情测试好友真实发送 1 条文字；桥接返回 accepted 并给出平台消息 ID（记录在本地发送账本），收件人确认收到；发送前检查全部通过：live 模式、全局与联系人未暂停、计划/票据/内容哈希与依赖版本一致；发送仍只发生在 02 的 dispatch 租约内；本次只测文字：已批准表情发送未接线（当前对 approved_sticker 返回 UNSUPPORTED_CAPABILITY）；发送窗口、频率限制与桥接幂等键仍无平台证据 |
| receipt_levels | tested | run:qq-controlled-send-2026-09-24 | 实测只取得 accepted 级：桥接回包给出平台消息 ID，可与发送账本关联；delivered 级无平台证据：本次由收件人人工确认收到，系统不据此自动升级为送达；按 sendKey 查询超时结果的能力同样不存在；同一路径的两次实测划出边界：第一次回包无法配对时记为 RESULT_UNKNOWN（不重发、暂停联系人待人工核对），修复后取得 accepted + 平台消息 ID |
| owner_message_signal | unknown | https://napneko.github.io/develop/event | message_sent 事件已文档化（维护者文档）；本次只接收运行把 reportSelfMessage 关闭，平台未推送自身消息；且缺少经审核的对端 mapper，本人手发与桥接回显无法区分，因此该能力未测，不能算 documented 已达成的可用信号 |
| history_sync | unknown | https://napneko.github.io/config/basic | 无实测：没有可证明的连续覆盖游标；断线重连后的补齐范围与是否丢消息均未测，RecoveryReport.historyComplete 只能为 false |
| media_fetch | unknown | https://github.com/botuniverse/onebot-11/blob/master/api/public.md | get_image/get_record 仍为文档声明（OneBot 公共 API）；本适配器尚未接线媒体抓取：只保存原始事件（内含平台侧不透明媒体引用），因此无法判断原图/原语音/完整动态序列是否可取；这属于本项目待办，不是平台结论 |

## 只接收证据汇总（去敏）

```json
{
  "inbox": {
    "enrolled": 2,
    "discovery_only": 0,
    "unmapped_self": 0
  },
  "messagesByType": {
    "text": 2
  },
  "duplicateMessageRows": 0,
  "conversations": [
    {
      "state": "READY_CONFIRM",
      "count": 1
    }
  ],
  "pauseReasons": {},
  "tasks": {
    "pending": 0,
    "resolved": 2
  },
  "sends": {
    "DELIVERED": 1,
    "SUBMITTED": 1
  },
  "outboxPending": 0,
  "rawFiles": {
    "files": 0,
    "unreferenced": 0
  },
  "accountId": "01997000-0000-7000-8000-0000000e0001",
  "observedAt": "2026-09-24T08:55:57.276Z",
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

本报告的证据汇总块来自**发送阶段库** `chat_agent_spike_send`（含触发消息的接收与那 1 条真实发送）。只接收阶段的证据在独立库 `chat_agent_spike`：7 条已登记入站（文字 3、图片 1、语音 1、unsupported 1、撤回事件 1）、7 个私有原始文件、0 未引用、0 发送；两库都可用 `npm run spike:summary` 复现，索引见 `npm run spike:manifest`。

2026-09-24 本机实测（本人已确认），判定保持 CONDITIONAL。

只接收阶段：知情好友发出的文字、图片、语音、QQ 原生表情各一条均被接纳（HTTP 204），原始事件私有留存；文字生成 3 个候选待办；含引用文字的平台引用 ID 记入 provenance；撤回经审计表记为 applied 并把原正文墓碑化；全程零发送。

受控发送阶段（本人授权、每次 1 条、发完即止）：两次真实发送同一句约定文字。第一次桥接回包无法配对，系统按契约记为 RESULT_UNKNOWN——不重发、暂停联系人、等待人工核对；随后本人核对（收件人确认收到、NapCat 无报错）并用新增的 resolveUnknownSend 记录为 DELIVERED。第二次发送取得真实回执：SUBMITTED + accepted + 平台消息 ID，计划转 SENT，会话无暂停、无未知。

两次发送暴露并已修复两个缺陷：
1. QQ 的时间戳只有秒级精度，触发消息的 sent_at 可能领先本机时钟，以"当前时间"为截止点会判定消息晚于截止点→ NOT_FOUND→503、候选生成失败；现截止点取"当前时间与触发消息时间的较晚者"。
2. 桥接对未带 echo 的请求会自行生成 echo，而传输层按 echo 校验请求/响应配对，导致已送达的消息被记为未知；现 echo 随请求体发送（OneBot 约定），跨请求的 echo 仍判未知。

平台观察（供后续 spike 复用）：QQ 消息时间为整秒，可与本机时钟相差最多约 1 秒；桥接会推送我们未消费的事件类型（被拒绝并记录错误码，不猜测）；桥接只提供 accepted 级回执，delivered 无平台证据，送达必须另行人工确认；媒体未理解会阻塞该联系人的后续候选（pending 批次包含未处理的媒体消息），因此在媒体管线接线前该联系人无法继续生成候选。

升到 GO_CONFIRM_ONLY 仍缺：已批准表情发送（素材端口未接线）、本人手发与系统回显区分（reportSelfMessage 关闭且缺经审核的 peer mapper）、独立宿主与关机持续运行（AC23，待迁阿里云后实测）。本次所有发送都由本人逐条授权，未发生任何未授权发送。
## 对公共契约的变更提案

- 无。若发现契约缺口，先提案，不在本地私加同名字段或状态。
