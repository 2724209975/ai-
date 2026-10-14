# 同一人物的多渠道记录交付

按本人确认的“一个人物、多个聊天渠道、多次文件/截图导入”方案，在现有源码增量实现。电脑源码版本 2.2.0，Android 0.9.0 / code 23；保留既有模型配置界面及其他未提交开发工作，未提交 Git。

## 已实现

- 迁移 0019：所有者范围内的人物、渠道、导入批次/行出处和幂等命令。既有账号、联系人、消息不搬动；现有联系人首次读取时各自形成独立人物，昵称相同不会自动合并。新增历史账号只创建资料及依赖跟踪，不创建平台收发会话。
- 工作台新增「人物与导入」：新建/改名、确认关联/解除、历史渠道、渠道名称与共同参考开关、全部/单渠道历史和翻页。
- JSON/CSV/TSV 解析、带时区的时间与明确说话人、文件预览/修订、原消息 ID/相同文件幂等、疑似重复由本人选择。文件名、行号和原始时间/说话人标记保留；不同渠道不会按文字自动去重。时间未知保留未知，文件内原顺序保留。
- 导入原文可以修订/删除；可靠原文由本人确认形成带来源的记忆。手机上行资料仍走既有手机/联动纠错与冲突路径。导入不创建实时回复、模型调用或发送任务。
- 电脑 v2 上下文保留当前渠道/触发批次，其他关联渠道的相关原文与有效记忆单独标注来源。预算先删可选跨渠道背景；共享边界进入分类和候选检查。旧快照重新验证人物/渠道版本、来源版本、记忆状态，纠错/解除后不能继续审批。
- 手机本机人物关联/解除、全部渠道历史、相关跨渠道背景与来源标记；当前来信不被其他渠道内容替换。源渠道修订、删除或关联变化阻断旧候选复制。电脑同步来源与手机本机记录用稳定来源标识避免重复展示/引用。
- 手机声明 `personChannels=true` 后才下发跨渠道资料；旧版仅收到当前渠道，降级后的跨渠道缓存改为删除标记。联动目录包含新增历史渠道；配对、费用和收发权限沿用原机制。
- HTTP 文件上传按字节收集后统一 UTF-8 解码，避免中文跨网络分块被截坏。补齐本轮相关严格类型检查，同时修正模型元数据联合类型和媒体投影 ID 的既有诊断，运行行为保留。

使用、格式模板与升级边界见 [使用说明](../people-and-history.md)。主要新增模块为 `packages/data/people`、`packages/data/imports/history-file.mts`、`apps/web/src/PeoplePage.tsx` 和 Android `PersonChannels.kt`；复用原数据库、上下文、记忆、模型及联动模块。

## 最终验证

|范围|结果|证据|
|---|---|---|
|单元|486 通过，0 失败/跳过|output/people-unit-verified.log|
|应用/API|36 通过，0 失败/跳过，包含认证/CSRF与中文分块上传|output/people-app-delivery.log|
|工具|254 通过，0 失败/跳过|output/people-tools-delivery.log|
|契约|11 通过，0 失败/跳过|output/people-contracts-delivery.log|
|隔离 PostgreSQL/pgvector|205 通过，0 失败/跳过；19 个迁移及幂等、备份恢复、进程重启、非超级用户 RLS|output/people-integration-verified.log|
|真实 Chromium/HTTP|56 通过，0 失败/跳过；新增流程连接真实隔离 PostgreSQL，320/390px及桌面检查|output/people-e2e-verified.log|
|最新同步/兼容/顺序专项|41 通过，0 失败/跳过；含旧手机不下发跨渠道、降级缓存删除与无时间的文件顺序|output/people-compatibility-final.log|
|网页|TypeScript/Vite 构建通过|output/people-web-delivery.log|
|后端/联动严格类型|9 个入口及其依赖图检查通过；临时目录安装真实 @types 声明并映射路径，未修改项目依赖|output/people-types-verified.log、output/people-typecheck.json|
|Android JVM|93 通过，0 失败/错误/跳过|输出验证 JSON及 ASCII 构建目录 XML|
|Android 构建|APK、Lint、设备测试包编译通过；Lint 0 错误、25 警告|output/android/people-verified-0.9.0.log|
|界面检查|已查看390px合成页面；无横向溢出，人物、渠道、文件批次和操作可读|output/people-browser/people-390.png|

标准六类回归合计 1,048 次测试执行通过，专项 41 次有交叉覆盖，不再累加。完整验证按分阶段命令完成，集成使用 `--test-concurrency=4`，没有把未完整跑完的单条 `npm run verify` 标为成功。最终同步能力和顺序修改之后，重新完成单元、完整集成、端到端、同步专项、类型及 Android 构建/JVM/Lint。

初轮暴露 Node 原生 TypeScript strip 不支持参数属性，已改为普通字段初始化；补齐隔离 PostgreSQL 的客户端二进制环境后，原生启动/备份测试完整通过。新增主导航使旧测试断言过时，已改为包含实际交付的模型配置与人物导入页面。最终结果以上表及日志为准。

机器汇总：[people-channels-verification.json](../../output/people-channels-verification.json)。

## 安装包与实际交付边界

APK：[reply-assistant-0.9.0-debug.apk](../../output/android/reply-assistant-0.9.0-debug.apk)。SHA-256：`4b44ae350c47ee3f38ce6a4987f1282d3b3104a79d240d6297274665ceacc68e`。可按既有同签名方式覆盖安装；本轮没有操作真实手机安装或执行设备 UI 测试，测试包编译不能替代现场验收。

本轮没有管理式重启真实服务、迁移真实聊天库、改动费用账本、连接平台或发起收费模型调用。测试全部使用单独创建的 PostgreSQL 集群、随机合成 schema 和本地模型/平台夹具；测试库收尾停止。网页及 APK 已构建，但现有运行版本必须另行升级后才生效。

现有 QQ 导入、手机截图获取/识别继续复用。新增文件入口支持上述统一 JSON/CSV/TSV，不宣称任意微信专有导出、数据库或 HTML 文件可直接解析；这类文件需要样本后接格式适配器。跨平台关联用于同一个 v2 数据库，旧双平台入口若有独立数据库仍各自隔离。自然回复效果和真实导出文件兼容性需要实际使用核对。
