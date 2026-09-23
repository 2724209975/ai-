# 平台模块：当前仅离线模拟

遵循 docs/contracts.md v0.1.0 的 PlatformPort 语义、六类事件名和发送状态。此目录已有 QQ 候选 HTTP 传输代码，但没有真实微信/QQ 连接、账号登录或平台调用；未安装外部依赖、未保存凭据。公共 schema 包尚未提供，mock/adapter.mts 的类型是模拟器内部投影，不能作为另一个公共契约发布。待 00 采纳字段细节后替换为 packages/contracts 导入。

## 运行

在仓库根目录、Node.js 24.15.0（本次环境）执行，无需 npm install：

```powershell
node --test packages/platform/mock/adapter.test.mts
node packages/platform/mock/examples.mts
```

续作新增 QQ OneBot 协议解析、格式转换及回调接纳入口（无真实连接），见 [qq/README.md](qq/README.md)。全部测试命令：

```powershell
node --test packages/platform/mock/adapter.test.mts packages/platform/qq/onebot-codec.test.mts packages/platform/qq/webhook-ingress.test.mts packages/platform/qq/send-executor.test.mts
```

Node 原生剥离 TypeScript 类型运行测试，不做静态类型检查。本机没有 tsc，尚未执行 strict 类型检查或全项目 CI；不声称通过正式 contract tests。

## 提供给 02/03 的使用方式

由装配层构造 mock，持有一个不暴露给 04/05/06 的 authority 对象；只有模拟 02 持有相同对象可调用 submitSend。此对象身份检查只用于进程内测试，不能冒充生产服务鉴权。

submitSend 每次读取 02 注入的 preflight 回调（默认拒绝），校验截止时间、平台能力、批准素材查询结果。同 sendKey 返回账本已有结果；同键不同内容、同任务不同键拒绝。RESULT_UNKNOWN 阻止同会话新任务，不阻止其他会话；所有结果带 adapter=mock。明确失败也不由适配器自动重试。

observe 接受合成 Observation，而非未经验证的网络 payload。只有测试驱动提供 verifiedOwnerEvidence 才产生 owner；账本平台 ID 匹配优先视为 agent。无关联的自身消息保留 unknown，交 02 暂停/核对；不能以“没有找到发送记录”推定本人。先回显、后回执时，初次 unknown 不自动改成 owner；正式来源更正事件尚待 00 定义。

reconcile 只返回模拟事件/未决发送，不重发；CONNECTED 前必须经过 RECONCILING。historyComplete=false 明示没有平台历史补齐证据。恢复后是否可发送旧计划必须由 02 对 generation/policy/暂停等最新状态重新核对，mock 不代替业务状态机。

fetchMedia 只读内存夹具，报告原始字节、摘要、类型及完整性。动态单帧不标 complete；夹具完整性由测试元数据声明，没有真实下载、GIF 解码或媒体理解。真实媒体获取需经 02 名单门控、01 下载、03 私有存储再交 04。

snapshot 是隔离的内存副本，用来模拟账本恢复，不是持久化组件。生产 inbox/outbox 原子事务、跨进程锁、提交账本和消费 ack 必须接总控/03 的 PostgreSQL 端口。本地去重不保证业务副作用 exactly-once。测试模拟跨重建恢复，不等于实际进程/数据库崩溃测试。

## 真实路径

见 docs/platforms/feasibility.md、github-reuse.md、capabilities.md、verification.md。微信和 QQ 真实能力均 unknown；无已验证路径时不创建返回模拟成功的“真实适配器”。配置示例只是说明，不会启用任何平台连接。
