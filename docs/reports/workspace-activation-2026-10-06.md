# 聊天工作台启用记录

2026-10-06 已启用，统一入口为 http://127.0.0.1:8790/#chat。

实际运行源原为 `C:/Users/a4151/.codex/worktrees/adc7/ai代聊`，包含另一路未提交的账号门户、原生历史与军师功能。此次未覆盖两个工作目录的已有修改，将新工作台与原运行功能合并至独立部署目录 `C:/1/ai代聊/.local-workspace-release`。QQ、微信沿用各自数据库和平台端口，统一门户新增工作台汇总分页、历史游标与平台命令路由；没有合并或重建已有数据库。当前源项目的共享数据库、一个 core、两个独立桥接配置仍可用于新环境。

原数据库已应用 `0013_relationship_advisor.sql`、`0014_retire_legacy_skills.sql`，部署目录将账号映射迁移顺延为 `0015_platform_accounts.sql`；校验前 14 个迁移校验和后，对两个数据库应用 0015。当前源项目的 0013 文件保持原状。

数据库升级前备份：`C:/Users/a4151/AppData/Local/ChatAgentTrial/workspace-backup-2026-10-06T06-12-33-454Z`，包含两个 PostgreSQL 自定义格式备份、暂停状态和私有配置。旧监督器经已验证的控制接口正常停止，保留原数据库目录、会话和账号配置；只撤销升级停止增加的 QQ 全局暂停，既有联系人暂停继续保留。

项目根目录的“启动项目”“停止项目”“检查启动配置”快捷方式已指向部署目录。部署入口默认 START_PAUSED=0，已有暂停不被启动流程解除。未来源码修改需重新构建并更新部署副本，当前工作目录的修改不会自动改变正在运行的副本。

合并版本完整 `npm run verify` 结果为 **852 通过、0 失败、0 跳过**：单元 391、应用 33、工具 242、契约 12、数据库集成 128、浏览器 46。日志为 `test-results/workspace-release-verify-final.log`。测试 PostgreSQL 已停止。

上线后只读探测记录位于 `.local-workspace-release/.local-launch/activation-health.json`：两个 core 和桥接已就绪，两个数据库迁移为 0015，新网页资源正常，匿名工作台 API 返回 401。QQ 已登录、探测 healthy，有 1 个会话，保留 OWNER_ORIGIN_UNMAPPED 人工接管暂停；微信 0 个登记会话，接入 unavailable、探测 fault，原有全局暂停保留。微信尚需连接客户端并核对账号；真实发送闭环未执行。
