# v2 本机隔离预发布

2026-10-11 已在日常 QQ、微信数据库的独立副本完成升级、启动、重启、认证与冷备份恢复演练。日常数据库及 `.local-workspace-release` 未替换。当前预发布使用本地 fixture，不能据此判定真实模型质量或真实平台送达。实测见[交付报告](reports/v2-prerelease-2026-10-11.md)。

## 使用现有预发布

在项目根目录执行：

```powershell
npm run prerelease -- status
npm run prerelease -- start
npm run prerelease -- stop
```

也可运行 `deploy/start-prerelease.ps1` 或 `deploy/stop-prerelease.ps1`。PostgreSQL 与 Core 均隐藏运行；地址由 status 返回，只能在这台电脑访问。浏览器验证使用 1440、390、320 像素视口，未开放手机局域网访问，未部署 Android APK。

`.local-prerelease/current.json` 指向 `%LOCALAPPDATA%/ChatAgentTrial/v2-prerelease/<releaseId>`。登录密码保存在该目录的 `private/access.txt`；两个预发布页面共用此密码，日常密码没有改变。QQ、微信使用不同会话存储，但 Cookie 域相同；同一浏览器切换平台可能需要重新登录。

整个预发布目录仅授予当前 Windows 用户和 SYSTEM 访问。private 包含凭据、历史环境、认证会话和数据库指纹，不提交或共享；公开报告只保留计数、迁移映射和检查结果。

## 重新准备与演练

```powershell
# 原日常数据库必须已停止；脚本不会替你停止日常业务
npm run prerelease -- prepare
npm run prerelease -- verify
npm run prerelease -- rollback
```

prepare 每次创建新目录并更新 current 指针；不会自动关闭较早的副本，重新 prepare 前应先 stop。旧副本可用 `--root <绝对目录>` 指定。

准备顺序为：确认 PostgreSQL 17 集群已停止 → 按文件 SHA-256 和大小验证冷复制 → 备份私有配置 → 创建独立工作副本 → 生产模式构建网页并复制运行代码/依赖 → 组合迁移谱系 → 升级与幂等检查 → 比对旧表字段投影与行数 → 导出升级后逻辑备份。原冷备份不启动，修改只发生在独立工作副本。

数据库正在运行、私有配置缺失、路径越界/链接、旧迁移 checksum 不符时停止操作。复制集群使用独立端口、口令、Session，重置 archive、日志及 ALTER SYSTEM 路径，避免向日常目录写文件。

verify 实际启动生产 Core，检查 readyz、已构建网页、未登录 API 的401、全局暂停及原记录，然后停止/重启，复核日常库冷文件指纹。完成后保留预发布运行。

rollback 是**独立恢复演练**：停止预发布，从原冷备份创建额外恢复副本，验证旧迁移、旧数据及 v2 任务表不存在，停止恢复副本，再启动升级后的预发布。它不覆盖日常库，也不将预发布退回旧版。真实上线产生发送记录后不可直接用冷备份覆盖账本；须先对账，优先按会话回退业务管线。

start/stop/verify/rollback 使用排他命令锁。出现 `PRERELEASE_COMMAND_IN_PROGRESS` 时检查 `private/command.lock` 的进程，确认管理命令已结束再处理遗留锁；不能仅凭 PID 强制停止未确认归属的进程。

## 迁移谱系

日常副本已经应用16个迁移，0013/0014属于早期关系顾问/旧Skill退役，0015/0016是账号映射/手机联动，与源码编号不同。预发布保留已应用文件原始字节与SHA-256，按SQL内容复用账号/联动迁移，新迁移追加为：

| 源码 | 本轮部署副本 |
| --- | --- |
| 0015_reply_pipeline_v2.sql | 0017_reply_pipeline_v2.sql |
| 0016_context_memory_v2.sql | 0018_context_memory_v2.sql |
| 0017_decision_models_v2.sql | 0019_decision_models_v2.sql |

**不能直接覆盖日常迁移目录。** 管理脚本读取真实 schema_migrations 校验旧谱系再生成部署迁移集合，映射保存在 preparation.json。

## 固定运行边界与下一步

预发布只启动生产 Core，不启动 QQ/微信 Bridge、不注入客户端、不接收真实消息。固定回环绑定、START_PAUSED=1、本地 persistent-fake，关闭收集、发送、媒体及手机联动；不把旧私有模型/平台凭据传入 Core。注册模型只有本地 rules/fixture，网页操作不会因此获得 Bridge 或云端密钥。

会话保留原 pipeline_version，没有自动把原联系人改为v2。本人后续授权10元及现有数据上传，已在独立CLI完成真实模型合成场景测试及提示修复，见[报告](reports/v2-real-model-2026-10-11.md)。本预发布Core仍不启用云端；真实聊天、真人评分、联系人试点尚未完成。后续顺序：

1. 本轮已明确费用/上传权限并完成两批Provider测试。新增批次须扣除累计费用后预留新额度，不重置账本。桌面库暂无真实正文，真实聊天回放待有可用数据时执行。
2. 已按同一截止点生成120组A/B及12题评分页，等待本人评分；记录自然度、事实错误、采纳/修改及成本。
3. 明确2–3个联系人、时间段和人工审批范围，再安排运行副本切换与只接收验证。人工审批与真实自动发送授权独立，自动发送继续关闭。
4. 根据真实反馈修复并决定扩大范围。范围未确定前保持本地预发布，不替换日常副本。

2026-10-11后续进展：本人实际完成11题评分，反馈修复与追加复测见[报告](reports/v2-feedback-2026-10-11.md)。当前本人已授权两位精确QQ好友，`scripts/qq-candidate-trial.mts`在预发布QQ克隆库内创建新schema，复用原WebUI已认证调试事件接入、最新源码和独立计量；原预发布Core继续保持上文的本地夹具边界。候选试用不替换部署目录、不迁移原联系人、不启用发送；运行清单、访问令牌、真实聊天和账本仅存用户私有目录。新增试用最多45分钟及0.5元，退出关闭自己的事件连接和接收服务，保留试用schema与证据，不关闭本人的WebUI或QQ客户端。
