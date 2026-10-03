# 微信语音数据库候选：本机离线开发工具

本目录是 P4-5a 的实验候选，不是可用的语音平台接入。运行 `node --test scripts/wxhelper-voice-db.test.mts` 仅编译测试程序、加载系统 SQLite 并访问合成内存数据库；不加载 wxhelper/WeChat，不读取真实聊天库，不调用模型。

Windows 要求已安装 MSVC x64 Build Tools（由 vswhere 定位）和系统 `winsqlite3.dll`。Linux/macOS 要求 C++17 编译器（`CXX` 可指定可执行文件路径）及系统 SQLite 共享库。缺少工具链会失败，不跳过；没有新增 npm、SQLite 包、语音解码或 ASR 依赖。Windows 实测通过，其他系统的分支尚未本机执行。

`voice_candidate.h` 使用固定 helper 的 SQLite 函数签名，是未来独立源码副本可复用的查询内核。`../wxhelper-voice-db.patch` 面向 `wxhelper-src-391125` 的 `wechat_db.cc`；测试夹具只保存所需上游上下文，不能单独编译成 helper。原源码的通用 Select/ExecSelect 不改，语音候选绕开该路径。

候选规则：规范十进制正整数 ID，最大 `9223372036854775807`（不是 JavaScript number）；调用方提供最多 64 个互不重复的已知句柄；每个库只查 Buf、最多返回两行；全体必须唯一、类型必须 BLOB、长度 1–2 MiB，按长度复制，prepare/step/finalize 失败则舍弃结果。任何失败返回固定状态及空 bytes。查询内核不输出 ID、SQL、SQLite 原始错误或原文件。

补丁只读取已经登记的 `MediaMSG<n>.db` 句柄快照，不遍历图片 hook 或新偏移。默认 `WXHELPER_EXPERIMENTAL_VOICE_DB=0`，函数直接返回空字符串；实验开启才调用内核，并沿用原接口的 base64 返回类型。`GetVoiceByDB` service 仍为空壳，HTTP 不接通。现有生产组合根仍拒绝启用语音。

下一步在**独立源码副本**中复制此头文件到 `app/wxhelper/src/`，检查/应用补丁，完成 helper 构建、指纹和回滚材料。不要在已经登记或驻留的 DLL 上覆盖。是否增加接收专用诊断端口、如何鉴权/限流、实际 schema 和消息 ID 范围须下一卡审定；真实登录、启动、注入、卸载和接收验收由本人执行。这里不提供真实平台启动命令。

尚未保证：微信 SQLite ABI/地址与句柄有效性、真实 schema/Reserved0 的语义、已知句柄快照是否完整、跨库事务快照一致性、扫描时间上限、媒体容器完整性/音频解码与转写。`LIMIT 2` 和字节上限约束结果，不约束全表扫描耗时。超过有符号 int64 的 ID 会明确拒绝；如果真实 ID/schema 不符合候选规则，须重新审定查询方法，不能经浮点数转换。任意二进制 BLOB 通过离线检查也不等于完整语音文件，更不能直接送入 ASR。
