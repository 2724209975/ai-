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

## 运行期事故记录：修复前的 DLL 让微信崩了两次

Windows 应用程序日志（本机时间）显示 `WeChat.exe` 3.9.11.17 在 **17:39:35 与 17:39:50** 各有一次 `APPCRASH`：

- 异常代码 `0xe06d7363`（MSVC 未处理的 C++ 异常），故障模块 `KERNELBASE.dll`；
- 时间点对应**日志路径修复之前**的两次注入尝试，与第 3 处本地改动的原因完全吻合：`Config::init()` 里的 `spdlog::daily_logger_mt` 在只读安装目录上抛 `spdlog_ex`，异常穿出 `DllMain`，微信被终止（随后微信自行重启，因此当时仍能观察到进程）；
- 修复日志路径后的注入（17:41:28）之后，**没有**再出现任何 WeChat 崩溃事件，`/api/checkLogin` 正常返回，HTTP 路由表（52 条）加载完成。

结论：**"日志写只读目录"这个缺陷会崩掉宿主进程，不只是加载失败**；修复后的版本在观测窗口内未见崩溃。凡是要重跑本流程，必须使用修复后的 DLL，不要用上游原版直接注入。

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

## 关键结论更新（2026-09-24 17:50）：消息路径偏移与本机版本不匹配，路线在本机被阻断

第 1 步只接收 spike 的第一次尝试**失败，并且把微信读崩**：

| 时间 | 事件 |
| --- | --- |
| 17:46:39 | 修复版 DLL 注入成功（新进程 pid 34828），`/api/checkLogin` 返回 `code=1` |
| 17:46:51 | `POST /api/hookSyncMsg` 返回 `code:0`（Detours 附加成功），消息 hook 就位 |
| 17:47–17:50 | 知情测试好友按约定发送文字/图片/语音/表情 |
| **17:50:16** | `WeChat.exe` 崩溃：**错误模块 `wxhelper.dll`**，异常码 `0xc0000409`（`STATUS_STACK_BUFFER_OVERRUN` / `__fastfail`，BEX64），偏移 `0x75a1d` |

判定依据（三条互相印证）：

1. **崩溃模块是我们注入的 DLL 自己**，不是微信、也不是安全软件（`错误模块名称: wxhelper.dll`，路径即 `%TEMP%\wxhelper-inject\wxhelper.dll`）。
2. DLL 日志里**完全没有** `add http msg work` 记录（该行在 `HandleSyncMsg` 内、推送之前）→ handler 在读取消息结构字段时就崩了，没有走到推送。
3. 本地接收端 `0.0.0.0` 之外的流量为 0：`%TEMP%\wxhelper-inject` 之外**没有任何消息内容落盘**（私有 raw 目录里只有我们自己的 `capture.log`）。

原因：本机构建用的是 `V_3_9_11_19` 偏移表，其中 `kDoAddMsg = 0x230a3e0`；该地址在 3.9.11.17 上**不是**消息接收路径（或参数结构与 3.9.11.19 不同），Detour 挂上后一有消息到达就把宿主读崩。

**换分支解决不了**：`dev-3.9.11.25` 分支的同一张表里 `V_3_9_11_19` 与 `V_3_9_11_25` 的 `kDoAddMsg` **都是 `0x230a3e0`**，与 .19 分支一致；上游没有任何版本表覆盖 **3.9.11.17**（可选值只有 `3.9.8.25 / 3.9.9.43 / 3.9.10.19 / 3.9.11.19 / 3.9.11.25`）。

可控性说明：注入**随进程消失**，没有持久化残留在系统里；但**"每次消息到达都可能崩宿主"这件事在被修好之前不可接受**，因此本路线在第 1 步保持**阻断**，不再重复注入当前二进制。

### 出路的三个选项（需要本人选一个，我不擅自继续）

## 第二次实验：换到 3.9.11.25 客户端后仍然崩（2026-09-24 18:06 / 18:11）

## 偏移移植的第一阶段（2026-09-24 晚）：工具链可用，但函数边界表被混淆（只读，未注入）

按本人授权，先做**完全离线/只读**的定位工作。结论与阻塞点：

1. **方法可行**：这份 `WeChatWin.dll` 的日志字符串带完整内部函数名，例如 `SyncMgr::doAddMsg`（RVA `0x4f203e0`）、`SyncMgr::PreProcessAddMsg`（`0x4f20288`）、`SyncMgr::ConvertAddMsgToChatMsg`（`0x4f20588`）、`SendMessageMgr::sendTextMsg`（`0x4f1c788`），另有 `doAddMsg srvid: %d, msgtyp: %d,cTime:%d,msgseq: %d from : %s to %s`（`0x4f201c0`）这类格式串。构建路径串显示该二进制来自 `MicroMsgWindowsV3911` 工程。
2. 自建工具已能完成"字符串 → `lea reg,[rip+disp32]` 引用点"这一步：`SyncMgr::doAddMsg` 有 **2 处引用**，都落在 `0x230f0xx` 一带，与上游表里的 `kDoAddMsg = 0x230a3e0` **同区域**，方向正确。
3. **阻塞点**：本二进制的 `.pdata`（x64 函数边界/展开表）**在磁盘与内存中都是混淆后的字节**（两处逐字节一致，均非合法 `RUNTIME_FUNCTION` 数组；1,824,912 字节里只有 75 条看起来像条目）。因此无法"零成本"精确还原函数入口，只能靠反汇编启发式推断。
4. 由此可以判定：上游那两张表的作者是在**具备反汇编环境**（其 wiki 描述的 Ghidra 脚本 + `.fid` 特征库 + 逐版本积累）的条件下产出偏移的；仅凭脚本化的字符串扫描**不足以**产出可靠入口地址，而错误的入口 = 崩溃（今天的四次崩溃已经证明）。

本阶段的所有工具都在 `.local-wxhelper/`（gitignored，不进仓库）：`find-strings.mjs`、`dump-strings.mjs`、`grep-strings.mjs`、`find-function.mjs`、`call-targets.mjs`、`check-offsets.ps1`、`dump-pdata.ps1`、`read-mem.ps1`、`inject.ps1`。全部只做文件读取与只读的内存读取（`OpenProcess` + `ReadProcessMemory`），**没有注入、没有写内存、没有创建线程**。

### 因此本阶段的取舍

继续做偏移移植 = 上真实的逆向环境（Ghidra 等，体积大、需下载安装），在**离线的二进制副本**上完成：

- 用字符串/引用点定位候选函数，用反汇编确认入口（而不是靠填充字节猜）；
- 从 `doAddMsg` 自身的日志调用反推消息结构各字段偏移（这决定 hook handler 能否正确解析）；
- 产出**属于本机这份二进制**的偏移表，离线自证后再申请一次注入验证。

这是**数小时到数天级**的独立工程量，且仍不能保证一次成功；期间每次验证都要重启微信，且一次错误入口就可能再崩一次。若本人不接受这个投入，则应改走官方 Linux 客户端路线或把微信挂起（见下方选项 2/3）。

本人在 17:57 前后安装了 **3.9.11.25** 客户端（同一安装目录，`[3.9.11.25]\WeChatWin.dll`）。两次注入实验如下：

| 次数 | 构建 | 结果 |
| --- | --- | --- |
| 1（18:06） | 混合构建：`.19` 代码 + `.25` 偏移表 | 注入后约 4 秒，微信在 `ntdll.dll` 内以 `0xc0000005` 崩溃 |
| 2（18:11） | **纯 `.25` 构建**（修好上游分支 14 处未完成改动后编译，SHA-256 `770D2CA059868136C7476662AF5294F822FB5321484AE31F50E2C48F08B313F5`） | 注入成功、`127.0.0.1:19088` 起来，但**调用 `/api/checkLogin` 的瞬间**同一个 `ntdll.dll 0xc0000005` 崩溃 |

关键判据：

1. 第 2 次崩溃点精确落在 `checkLogin`，而该接口只走 `kGetAccountServiceMgr` 一个偏移 → **这张表里的偏移在这个二进制上不成立**。
2. 客户端本身没问题：`WeChatWin.dll` 为**腾讯官方签名有效**的 3.9.11.25（100,449,384 字节，SHA-256 `2058A926258BAEAECF92B30668FF200382F4493B0A5323428781D0B993E19C51`，PE 时间戳 2024-07-21），`WeChat.exe` 同样签名有效。
3. 离线把 `.25` 表的关键偏移映射到该文件的节区（`.local-wxhelper/check-offsets.ps1`）：虽然都落在 `.text`，但若干部位**不是函数入口**（例如 `kGetAccountServiceMgr` 起始字节 `00 00 4d 8b c6…`、`kChatMgr` 起始 `cf e8 …`、`kSendTextMsg` 起始 `0f 29 70 b8`），与"偏移指向 ABI 入口"的前提不符。
4. 对照：`.19` 表与 `.25` 表在 `kDoAddMsg/kSendTextMsg/kGetSendMessageMgr` 等 10 个关键常量上**数值完全相同**，所以两次崩溃的差异来自代码层，而这个二进制两版表都对不上。

结论：**同一个版本号存在不同二进制构建**（腾讯多通道分发），上游两张表对应的都不是本机这份 3.9.11.25 二进制。按事先约定，**停止在这台机器上继续注入实验**；这条路线在拿到"与本机二进制匹配的偏移表"之前不可用。当天共 4 次微信崩溃：17:39 两次（修复前 DLL 的日志缺陷）、18:06 一次（混合构建）、18:11 一次（`.25` 表与二进制不匹配）。

1. **换到受支持的客户端版本**（3.9.11.19 或 3.9.11.25）：DLL 已经构建好，版本对上即可直接用。阻塞点是腾讯官方只下发 4.x，旧版安装包只能来自非官方渠道——来源可信度必须由本人确认，且要先记录安装包 SHA-256。
2. **做偏移移植**（逆向工程）：在**离线快照**上定位 3.9.11.17 的消息路径与结构偏移（用上游 wiki 的 Ghidra 脚本与 .fid 特征），改一行偏移表再一次性验证；工作量以小时到天计，且微信每次更新都要重来。属独立工作量，需单独授权。
3. **改走官方 Linux 客户端路线**（smrwang 网关）或**微信长期挂起**：前者许可干净、能落在阿里云 Linux 宿主，但只有纯文本、无平台消息 ID 与回执；后者则把精力放回 QQ 的三项升级。

（上方第 1 条已被本次实验否定：换了 3.9.11.25 客户端仍因偏移不匹配崩溃；剩下第 2、3 条仍然成立。）

- 收：文字/图片/语音/表情能否被 hook 并以正确类型上报；重复投递与乱序。
- 发：发送接口与"平台受理级"回执；`msgId` 能否与发送账本关联。
- 本人手发与系统回显能否区分；历史补齐；媒体完整获取。
- 3.9.11.17 与偏移表 `V_3_9_11_19` 的差异是否会在**除 checkLogin 之外**的路径上暴露（本次只验证了一条最简路径）。
