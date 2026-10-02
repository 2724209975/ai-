# 平台模块与模拟器边界

当前状态只见 [开发计划 §0](../../docs/development-plan.md#0-当前状态每完成一个任务由总控更新本节)；本页保留模块说明与操作约束，不维护测试数字或进度。

遵循 docs/contracts.md v0.3.0 的平台端口、事件和发送状态。mock 类型是模拟器内部投影，不作为另一个公共契约发布；真实连接装配见 apps/bridge，登录和注入由本人执行。当前能力与实测边界只见开发计划 §0。

## 运行

在仓库根目录、Node.js 24.15.0（本次环境）执行，无需 npm install：

```powershell
node --test packages/platform/mock/adapter.test.mts
node packages/platform/mock/examples.mts
```

QQ OneBot 协议解析、格式转换及回调接纳入口，见 [qq/README.md](qq/README.md)。全部测试命令：

```powershell
node --test packages/platform/mock/adapter.test.mts packages/platform/qq/onebot-codec.test.mts packages/platform/qq/webhook-ingress.test.mts packages/platform/qq/send-executor.test.mts
```

Node 原生剥离 TypeScript 类型运行这些测试；完整门禁与类型检查范围见根 package.json 和开发计划 §0。

## 提供给 02/03 的使用方式

由装配层构造 mock，持有一个不暴露给 04/05/06 的 authority 对象；只有模拟 02 持有相同对象可调用 submitSend。此对象身份检查只用于进程内测试，不能冒充生产服务鉴权。

submitSend 每次读取 02 注入的 preflight 回调（默认拒绝），校验截止时间、平台能力、批准素材查询结果。同 sendKey 返回账本已有结果；同键不同内容、同任务不同键拒绝。RESULT_UNKNOWN 阻止同会话新任务，不阻止其他会话；所有结果带 adapter=mock。明确失败也不由适配器自动重试。

observe 接受合成 Observation，而非未经验证的网络 payload。只有测试驱动提供 verifiedOwnerEvidence 才产生 owner；账本平台 ID 匹配优先视为 agent。无关联的自身消息保留 unknown，交 02 暂停/核对；不能以“没有找到发送记录”推定本人。先回显、后回执时，初次 unknown 不自动改成 owner；来源更正事件见公共契约，真实平台证据不足时保持 unknown。

reconcile 只返回模拟事件/未决发送，不重发；CONNECTED 前必须经过 RECONCILING。historyComplete=false 明示没有平台历史补齐证据。恢复后是否可发送旧计划必须由 02 对 generation/policy/暂停等最新状态重新核对，mock 不代替业务状态机。

fetchMedia 只读内存夹具，报告原始字节、摘要、类型及完整性。动态单帧不标 complete；夹具完整性由测试元数据声明，没有真实下载、GIF 解码或媒体理解。真实媒体获取需经 02 名单门控、01 下载、03 私有存储再交 04。

snapshot 是隔离的内存副本，用来模拟账本恢复，不是持久化组件。生产 inbox/outbox 原子事务、跨进程锁、提交账本和消费 ack 必须接总控/03 的 PostgreSQL 端口。本地去重不保证业务副作用 exactly-once。测试模拟跨重建恢复，不等于实际进程/数据库崩溃测试。

## 真实路径

见 docs/platforms/feasibility.md、github-reuse.md、capabilities.md、verification.md。逐项真实能力只见开发计划 §0 引用的证据；不得创建返回模拟成功的“真实适配器”。配置示例只是说明，不会启用任何平台连接。
