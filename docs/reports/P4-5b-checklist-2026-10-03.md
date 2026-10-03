# P4-5b 只接收验收清单（本人执行，尚未执行）

本清单验证新构建的受限接收边界及原测试好友类型/语音编号采集。**不验证语音原文件，也不发送回复。** 数据库句柄发现仍待离线复核，状态必须保持 `voiceDatabaseReady=false`。P2/P3 不启动。

## 已准备材料

- 隔离源码/构建日志/源文件哈希：`C:\1\ai代聊\.local-wxhelper\p45b-20261003-final`。
- 本人测试包：`C:\Users\a4151\AppData\Local\ChatAgentTrial\p45b-receive-only-cee4375b`（下称 `$bundle`）。目录权限仅本人、SYSTEM、Administrators。
- 新 DLL 完整 SHA-256：`CEE4375B6F795CE014F62C80A9A08BE178E4F08EC8E8EA2974820382FCE7895B`；原回滚 DLL：`B48BD850E4A3CBBF44022CFEEF82E11272958F3052C8BE8748904DEF3BCFCF12`，原文件保留未覆盖。
- 私有配置 `receive-only.json` 已按原登记测试好友准备；不要打开/粘贴其中 token 或好友绑定。配置在首次会话加载时读取，之后不热更新。
- 原 P1 私有配置仅用于核对磁盘版本/绑定；不启动 P1、core、bridge、模型或数据库。新 DLL 不被生产桥接允许名单接受，不修改其默认指纹。

## 运行前

1. 先保持全局暂停并停止旧核心/桥接/数据库；核对无未决发送。本人关闭原测试微信后重新打开并登录测试号，避免原 helper 驻留；不要更新客户端，不使用主号。
2. 确认已登录的确是测试号、仅原知情测试好友配合，测试期间不处理其他聊天。保持微信可见观察异常；此清单中的脚本只由本人执行。
3. 在 PowerShell 中设置：

```powershell
Set-Location -LiteralPath 'C:\1\ai代聊'
$bundle='C:\Users\a4151\AppData\Local\ChatAgentTrial\p45b-receive-only-cee4375b'
$privateEnv='C:\1\ai代聊\.local-wechat-spike\p1-20261002-e69f8675\private.env'
Get-Process WeChat | Select-Object Id,ProcessName
```

选择本人确认的测试微信进程 ID。不要把 PowerShell 的自动变量 `$PID` 当作微信 ID；下面把 `12345` 改成刚看到的测试微信 ID。

```powershell
& "$bundle\attach-by-owner.ps1" -WeChatProcessId 12345 -CheckOnly
```

期望 `P4_ATTACH_PREFLIGHT_OK`。此检查核对客户端/新 DLL/回滚文件/旧注入器完整指纹、微信加载的客户端路径、无旧 helper 驻留，以及 19088/19188 无占用。任何失败都停止并反馈固定错误，不通过修改配置绕过。

## 本人加载与接收

4. 仅在上述检查成功后，执行一次（仍把 `12345` 换成同一个测试微信 ID）：

```powershell
& "$bundle\attach-by-owner.ps1" -WeChatProcessId 12345
```

期望 `P4_LOADED_RECEIVE_ONLY_HOOK_NOT_STARTED`。脚本在注入前原子写入一次尝试记录；注入器返回码不是成功证据，还要核对实际模块路径、监听 PID/回环地址及专用协议。失败不重复注入，保留包内私有日志，关闭测试微信并反馈。

5. 开始一次接收 hook：

```powershell
node scripts/wxhelper-receive-only-client.mts hook $bundle $privateEnv
```

期望 `P4_RECEIVE_HOOK_CONFIRMED`；客户端先检查受限协议及登录，再装接收 hook。不产生回复候选或发送。

6. 请原知情好友依次发一条文字、一张静态图片、一条短语音；每条后执行一次：

```powershell
node scripts/wxhelper-receive-only-client.mts status $bundle $privateEnv
```

期望 text/image/voice 对应计数各增加 1，`expired=false`。私有 `evidence-*.json` 保存最新语音消息编号为字符串，支持超出 JavaScript 安全整数的编号；超过 SQLite 有符号 int64 时编号留空，不能宣称候选可读取。文字/图片只记类型计数，不保存正文、图片或它们的编号。请勿把证据中的编号贴到聊天里，只反馈各计数、语音编号是否存在及客户端是否稳定。

不会实时推送桥接/读取图片或语音缓冲；不会运行任意 SQL、读联系人/自我资料或调用旧导出/翻译接口。不要用旧管理网页、旧接收脚本或旧 `/api/*` 说明操作本包。所有请求必须鉴权、POST、无 Origin、正文 `{}`。每秒最多 10 次、总共 64 次请求；首次会话加载后 10 分钟停止采集/新装 hook，最多 16 条指定好友事件。**到期不会自动卸载 hook**，仍须执行下一步并退出微信。

## 结束与异常

7. 无论通过与否，执行一次解除接收 hook（正确凭据下不受时限/速率额度限制）：

```powershell
node scripts/wxhelper-receive-only-client.mts unhook $bundle $privateEnv
```

期望 `P4_UNHOOK_CONFIRMED`。随后本人关闭测试微信，使新 helper 随进程退出；核对 19188 不再监听。保留全局暂停，不重启旧桥接或恢复自动发送。

8. 微信崩溃、登录异常、计数不对、编号缺失、API 拒绝或无法确认解除时，停止测试，不重试 hook/注入/导出；本人退出测试微信，保留私有证据并反馈固定错误。不得因为小错误调用不在清单里的旧 API。

9. 回滚不是覆盖正在使用的 DLL：关闭测试微信后保留新包，再按既有 P1 停止/版本检查流程使用原 `B48BD850…` 文件。原配置、DLL、数据库及证据未变。不能自动恢复发送或补发旧任务。

本轮 AI 只完成离线构建与准备，没有执行上述任何真实平台步骤。若要开始验收，先由本人确认测试号及原知情好友在场；阶段结论也由本人判定。即使受限接收通过，数据库句柄/Buf 内容/语音容器与 ASR 仍未通过。
