# P4-5b 本机受限接收构建

Windows 本机开发工具；不选定 P5 部署宿主，不修改生产桥接的 helper 允许指纹。使用既有固定源码与本机修复、固定 vendor 源码、MSVC/CMake，独立复制后编译完整 x64 Release DLL。没有新 npm 或编解码依赖。源码副本先建立自身 Git 根，避免外层仓库静默跳过补丁；打包前检查源码标记、编译定义、PE 架构及原树未变。

```powershell
# 参数必须指向已登记的 B48BD850... 原 helper，不能用任意重编译文件代替。
node scripts/wxhelper-receive-only-build.mts '<原 helper 的绝对路径>' p45b-new-isolated-build
```

产物在忽略目录 `.local-wxhelper/<本轮名>/bundle`。此命令**不运行 DLL/注入器**。本次成功产物和操作包见 [清单](../../docs/reports/P4-5b-checklist-2026-10-03.md)。新构建哈希未必与本次相同，不能自动把它当作已登记产物；`build-pin.mts` 只登记本次经过审定的文件。旧错误产物已隔离，不使用。

受限宏开启时：固定回环端口 19188、禁用日志/外部回调/隐藏模块；专用鉴权入口只接受四条固定操作（状态、检查登录、装接收 hook、解除 hook），拒绝旧 HTTP/router 和 WebSocket 路由。私有配置在 DLL 同目录，含随机 token 和一个测试好友；仅采集这个好友的类型计数和最新语音编号，不读正文或媒体缓冲。原语音内核参与完整编译，但无可调用的数据库发现/导出接口，`voiceDatabaseReady=false`。

Policy 限频/总请求、采集时限/条数；正确 token 的解除 hook 不受预算和过期限制。过期仅停止采集和新装 hook，不自动退出平台或卸载 hook。客户端只接受回环固定命令，不跟随重定向、不自动重试，限制响应大小与超时，stdout 不含凭据/绑定/编号。owner 脚本只由本人执行；AI 仅作语法解析，未执行。

专项测试：`node --test scripts/wxhelper-receive-only.test.mts scripts/wxhelper-receive-only-client.test.mts`，使用 C++ 原生策略及合成 HTTP 服务，不连接真实助手。原生策略编译 `/W4 /WX`；完整上游 DLL 仍有既有 TODO/警告，构建成功不构成偏移或平台验收。实际鉴权/采集/崩溃恢复边界待本人验收；数据库句柄来源需下一卡独立复核。
