# 01 交付与公共契约提案

日期：2026-09-22；基线 contracts 0.1.0。本报告是给总控及协作者的文件交接，尚未在其他任务中发送消息，也不代表提案已批准。

## 当前交付

- docs/platforms/feasibility.md、github-reuse.md、capabilities.md、verification.md：平台比较、来源、代码复用审查、矩阵和真实验证清单。
- packages/platform/mock/adapter.mts：可运行的离线平台模拟器及内部类型投影。
- packages/platform/mock/adapter.test.mts：29 unit(mock) 测试通过。
- packages/platform/mock/examples.mts、events.example.json：六类平台事件的合成样例。
- packages/platform/README.md、config.example.json：运行命令、限制与无凭据配置示例。

未修改 PRD、公共设计、其他模块、根 package/锁文件或数据库迁移；没有引入第三方代码或依赖。00 可将计划中 01 状态从 Not started 更新为 In progress（模拟原型完成，真实接入阻塞），不能标整个模块 Done。

## 00 待采纳的问题（未擅改公共类型）

| 提案 | 原因与受影响方 | 兼容/迁移/回滚及 AC |
| --- | --- | --- |
| P01 能力逐项状态与 unavailable reason | 当前 snapshot 总体 verificationStatus 不足以表达“文字 documented、动画 unknown”；01/02/06/07 | 建议补 capability evidence 列表，每项 status/source/version/date/constraints；可选字段先加，旧消费者仍按最保守状态；无现存数据迁移。AC06/07/16/23 |
| P02 unknown 来源与来源更正 | contracts actor 的枚举行未列 unknown 但后文要求；先回显后回执可能先 unknown 后 agent；01/02/03/04 | 00 统一 schema，决定更正复用 mutation 还是新版本事件；不自动恢复本人暂停。旧消费者未知即暂停，回滚保留原始证据。AC16/18 |
| P03 连接与媒体完整性枚举 | 公共语义未定细分连接状态、重新登录、complete/partial/unavailable；01/03/04/06 | mock 值只作内部草案，待公共 schema 后迁移；动态需要原文件/帧/时长证据，不以扩展名确认。AC06/18/23 |
| P04 提交账本、事件原子接纳与 cursor 端口 | adapter sendKey 去重和 03/02 SendTask 状态必须一致；接收持久后才确认上游；01/02/03/07 | 不增第二数据库。由 00/03 给 PostgreSQL/infrastructure 事务端口，claim-before-submit，SUBMITTING 崩溃转未知；回滚保留账本，不回放发送。AC05/17/18/20 |
| P05 生产调用身份与 preflight 交接 | mock authority 对象不是网络鉴权；异步 preflight 与提交间有竞态窗口；00/02/07 | 定义仅 02 可持有的 dispatch capability、租约/epoch/有效期/内容摘要绑定；同会话提交边界串行化。正式契约采纳前不部署。AC16/17/20 |
| P06 已批准表情的可信读取 | mediaRef 字符串不足以证明当前批准/版本/平台格式；01/02/03 | 02 绑定最终素材 hash/version，01 通过可信资产端口核对实际字节及可发格式。mock 仅注入批准查询，不声称生产安全。AC07 |

这些细节是内部原型与公共实现之间的未完成项，不发布第二套公共 contract。公共 schema 包提供后，删除本地投影并导入统一类型，运行 strict 类型检查/契约测试；当前测试仅 Node 类型剥离后的行为测试。

## 各模块交接

- **00**：现有个人微信/QQ 与已有好友是本人本轮明确要求，不应再当可自由替换的 Bot 账号方案；无需再次询问是否必须个人账号。腾讯新 Bot 仓库补充进 D01 调查，不能据此改场景。决定 P01–P06、部署宿主和接受调查的桥接路径。
- **02**：submitSend 关联 sendTaskId/sendKey，每分条重新 preflight；RESULT_UNKNOWN 不换 key，已提交无法保证取消。unknown 来源须暂停核对，不直接当本人；reconcile 结束也不补发旧计划。测试用 authority/preflight 不是生产授权。
- **03**：稳定内部身份+带平台/账号作用域的外部 ID；业务侧 inbox 与副作用同事务。接收原媒体/sha256/完整性/来源，负责私有存储。原始事件引用是最小证据索引，不记录凭据/下载密钥。
- **04**：收到 partial/unavailable 必须明确理解失败；动画单帧不能替代完整动作。owner/agent/unknown 分开，不能以系统发言建立本人事实。无适配发送凭据。
- **07**：独立宿主与凭据存储、真实 PostgreSQL 恢复/权限依赖检查、分平台 24h spike（建议值）；不能把 29 个 mock 测试当真实 AC pass。

## 阻塞

真实账号未登录、组件未安装、测试会话/实发清单未授权、独立在线环境未提供。两平台无法宣称关机持续收发；真实接入阶段 C 尚未完成。现有原型不含网络请求，不会向真实联系人发测试消息。
