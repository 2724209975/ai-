# 微信 wxhelper 路线：第 0.5 步（注入与偏移兼容性）实测记录

日期：2026-09-24。范围：**只做到"注入 + 调用一个只读接口"**。本记录**不包含**任何消息收发、媒体、回执或历史能力结论——微信能力快照仍是六族 `unknown`（[platform-wechat-capability-snapshot-2026-09-24.json](platform-wechat-capability-snapshot-2026-09-24.json)）。

## 结论

wxhelper 路线在本机微信 **3.9.11.17（x64）** 上**通过第 0.5 步**：

- 注入成功，微信进程未崩溃（注入前后均为同一 pid，会话未中断）；
- 注入后的 HTTP 服务**只监听 `127.0.0.1:19088`**（回环限定生效，非默认的 0.0.0.0）；
- 唯一调用的接口 `POST /api/checkLogin` 返回 `{"code":1,"data":null,"msg":"success"}`，与"该账号已登录"一致；
- **尚未调用 `POST /api/hookSyncMsg`**，即当前**没有任何消息 hook 被安装**，没有消息数据流出。

## 构建事实（可复现）

| 项 | 值 |
| --- | --- |
| 源码 | `ttttupup/wxhelper` 分支 `dev-3.9.11.19`，commit `7d290e454c5315b2b061aad00aa3af4793a216bc` |
| 子模块 | spdlog `91807c2e`、nlohmann/json `199dea11`、Detours `f9204902` |
| 目标版本常量 | `WECHAT_VERSION=391119`（即分支内 `V_3_9_11_19` 偏移表） |
| 工具链 | Visual Studio 2022 Build Tools 新增 VCTools 工作负载，MSVC 14.44.35207，cmake 3.31.6-msvc6，x64 Release |
| 产物 | `wxhelper.dll`（649 KB / SHA-256 `90B29871310D96C27124043E4DA2829B332F591A8649A766B86BC8EEA60607F4`）、`injector.exe`（SHA-256 `F28DDDAC8C9B7FC07A148839A31A889D6FC7139D1B1E8981B2112F310687C939`） |
| 本机构建清单 | `.local-wxhelper/build-manifest.json`（gitignored，不入库） |

### 为编译与运行做的四处本地改动（均已记录在构建清单里）

1. `app/3rdparty/Detours/CMakeLists.txt` **新增**：上游 Detours 只有 nmake，没有 CMake，而 wxhelper 用 `add_subdirectory(Detours)`；本文件按它 `src/Makefile` 的对象清单从源码构建 `detours`。
2. `app/wxhelper/src/wechat_service.cc` **3 处调用点加显式转型**：`__StartSearch`/`__PayTransferConfirm`/`__PayTransferRefuse` 被声明为 `(uint64_t, uint64_t)`，调用处传的是指针；x64 ABI 等价，仅消除编译错误。
3. `app/wxhelper/src/config.cc` **日志路径改为 `%TEMP%\wxhelper-logs\daily.txt`**：原实现写相对路径 `logs/daily.txt`，而微信的工作目录是只读的安装目录，spdlog 抛异常导致 `DllMain` 失败、`LoadLibrary` 返回 0（见下面的诊断链）。
4. `app/injector/src/injector.cc` **不再强制要求 SeDebugPrivilege**：上游在拿不到该特权时直接 `return 0`；本机微信与注入器同属一个用户，改为尽力提升后继续。

## 失败链诊断（可复现，供后续版本排错）

1. 上游注入器输出 `注入结果：0`，进程里没有 `wxhelper` 模块、19088 无监听 —— 但 `OpenProcess(PROCESS_ALL_ACCESS)` 在 PowerShell 侧实测**成功**，说明不是权限问题。
2. 注入一个**空白探针 DLL**：`LoadLibraryW` 返回非零 → **注入通路本身正常**，问题在 wxhelper 自己的初始化。
3. 探针 DLL 在被注入进程内报告：`cwd=C:\Program Files (x86)\Tencent\WeChat`、`created_logs_dir=0 err=5`（拒绝访问）、`config_ini_openable=1` → 命中第 3 处本地改动的原因。
4. 改日志路径重建后：`LoadLibraryW` 成功，`127.0.0.1:19088` 出现监听，`/api/checkLogin` 返回 `code=1`。

## 已确认的接口契约（读源码所得，非实测收发）

- 装/卸消息 hook：`POST /api/hookSyncMsg`、`POST /api/unhookSyncMsg`（hook 的是消息接收路径 `kDoAddMsg`）。
- hook 生效后，每条消息由 DLL 主动 **POST 到 config.ini 的 `RecvHttpUrl`**，报文 JSON 字段：`pid`、`fromUser`、`toUser`、`content`、`signature`、`msgId`、`msgSequence`、`createTime`、`displayFullContent`、`type`（图片消息额外带 `base64Img`）。
- 只读接口示例：`POST /api/getContactList`、`POST /api/checkLogin`。
- **有平台消息 ID（`msgId`）**，这是 wxhelper 相对 UI 自动化路线的关键优势。

## 安全姿态与清理

- 本机 `config.ini`（`[config] HttpServerHost=http://127.0.0.1`）写入了微信安装目录，作用是**避免默认 0.0.0.0 绑定**；删除该文件即恢复上游默认（会把 API 暴露到局域网），因此**不要删**，除非同时卸载 DLL。
- 注入**不是持久化**：退出微信即卸载；不写注册表、不写启动项。
- 探针 DLL（`probe.dll`、`probe2.dll`）当前仍在微信进程内，但只有"写一个诊断文件"的逻辑，无其他副作用；下次重启微信即清除。
- 三个进程内模块都来自 `%TEMP%\wxhelper-inject\`，可随时比对哈希。

## 尚未验证（下一步才是它们）

- 收：文字/图片/语音/表情能否被 hook 并以正确类型上报；重复投递与乱序。
- 发：发送接口与"平台受理级"回执；`msgId` 能否与发送账本关联。
- 本人手发与系统回显能否区分；历史补齐；媒体完整获取。
- 3.9.11.17 与偏移表 `V_3_9_11_19` 的差异是否会在**除 checkLogin 之外**的路径上暴露（本次只验证了一条最简路径）。
