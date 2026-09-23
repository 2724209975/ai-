# 01 续作记录：QQ 协议适配基础

基线：contracts.md v0.1.0。续作时复查：公共 schema/infrastructure、02 和 03 的代码仍未提供，不能报告已正式联调。本次未修改公共契约或其他模块。

## 新增实现

- packages/platform/qq/onebot-codec.mts：OneBot 好友私聊/撤回解析、混合内容保留、来源保守识别、HMAC 回调认证、受限发送格式转换、回包解释。
- packages/platform/qq/webhook-ingress.mts：认证/账号校验后接纳事件，等待依赖存储端口确认提交才返回空 204；不包含任何快速回复或发送调用。
- 两组 QQ 测试及 README；mock 快照增加平台/账号绑定，阻止恢复到其他账号。
- 阿里云准备记录：本人确认已有服务器，系统/规格尚待回复；未安装或连接。

OneBot 源码和规范只读参考，自行实现上述代码，未拷贝桥接源码，也未新增 npm 依赖。所有 Wire* 类型仅限平台内部转换，尚未替代公共事件 schema。

## 测试与限制

命令：

```powershell
node --test packages/platform/mock/adapter.test.mts packages/platform/qq/onebot-codec.test.mts packages/platform/qq/webhook-ingress.test.mts
```

当轮实际结果：53 pass、0 fail、0 skipped，构成为 30 个 mock、17 个 QQ codec、6 个接纳入口测试。因中断在 2026-09-23 补记至 verification.md；新增发送执行器后的最新结果见该文件。所有测试使用合成消息和内存端口；不代表真实 QQ、真实持久化、服务鉴权或 02 业务联调已通过。未运行 tsc 或全项目 CI。

关键行为：桥接成功回包只映射 accepted；async/缺消息 ID/关联不符/未验证失败码均结果未知且不可直接重发。媒体保持 unknown 完整性。表情编码核对实际字节摘要及批准版本，但真实解码/平台格式兼容仍待测。私聊 message_sent 不能单凭事件名认定 owner。

## 给 00/02/03 的新增接线信息

- 00：混合内容到公共 contentRef/mediaId 的表达仍需落地，不能丢段或把一条平台消息拆成会碰撞的多个业务事件。事件 ID 生命周期仍待桥接实测。
- 03/基础设施：实现 AtomicReceptionPort 的原事件+去重键+待处理事件同事务；提交后确认、异常不确认，重复返回 duplicate；业务消费者仍需 inbox 同事务。样例 Map 无跨进程保障。
- 02：发送格式转换没有 dispatch 能力。将来必须在租约/最新 epoch 复核之后，由唯一发送端口使用；素材核对结束至提交间的批准撤销竞态需业务提交边界处理。
- 07：实际桥接若不支持所选签名，不得静默跳过认证；另审可信的内网传输与鉴权方案。接纳代码未开启 HTTP 服务，也没有公网端口。

## 尚未完成

QQ 网络传输/登录/原媒体下载、微信真实连接器、生产持久化与公共 schema 集成、真实本人消息识别、双平台关机收发。阶段 C 仍未开始。先确认阿里云系统与规格，再形成具体可审查的安装验证方案。
