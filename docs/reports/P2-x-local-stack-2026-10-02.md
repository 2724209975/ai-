# P2-x 本机完整启动与异常恢复演练

2026-10-02，总控按本人确认的顺序完成离线整组演练。范围见 [审定](P2-x-local-stack-proposal-2026-10-02.md)。代码分支 `task/P2-x-local-stack-rehearsal`；不新增依赖、公共契约或迁移，0013 未分配。

## 结果与边界

在 Windows 本机使用 PostgreSQL 17.11，新建随机端口的独立临时集群，实际运行 PostgreSQL、生产 `apps/core/main.mts`、直接复用 `createWxBridge` 的 fixture 桥接以及独立 HTTP fixture helper。模型为持久假实现，联系人、入站和发送均为合成。演练复用生产常驻入口的同一子进程驱动，但没有运行完整生产微信 CLI，也没有跳过 DLL 指纹守护；没有启动微信/真实 helper、登录、注入、联系好友、调用 DeepSeek 或真实发送。

已验证：

- 数据库可查询与 12 项迁移完成后，核心 readyz、桥接 healthz 依次就绪；未登录管理请求被拒绝，输入 START_PAUSED=0 仍被驱动强制为暂停。
- 桥接和核心实际硬退出后，整组逆序停止、退避、重新顺序启动；重启后全局与账号保持暂停。
- 数据库核对本轮 postmaster PID 后执行原生 immediate 停止，后台进程一起退出，重启执行 WAL 崩溃恢复；仍保持暂停。
- 人工确认但尚未提交的合成任务在桥接重启后成为 CANCELLED_PRE_SUBMIT，恢复后也不补发。新任务合成提交一次后为 RESULT_UNKNOWN，随后核心与数据库重启没有第二次提交，联系人恢复被 SEND_RESULT_UNKNOWN 拒绝。
- 模拟 helper 真实子进程的登录异常、响应挂起和退出，分别形成 HOOK_LOGIN_ABNORMAL、HELPER_UNRESPONSIVE、PROCESS_EXITED；探测恢复为 healthy 后仍保留 ACCOUNT_FAULT，必须人工恢复，故障期间恢复被拒绝。该用例全程发送数为零。
- 外部核心端口占用不会被接管；已在另一端口运行的外部集群会因 PID 文件被拒绝，不对其调用 pg_ctl，外部监听与数据库持续可用。
- 取消启动中的实际迁移子进程后先等待其退出，再停止数据库；手动停机不触发重启。本轮 Node 子进程、采样到的数据库后台 PID、helper 均已退出，临时集群清理前核对路径前缀。
- 轮转日志仅包含固定事件与允许指标，不包含合成正文、平台身份、临时路径或测试令牌。

**未完成的 Windows 边界：单独强杀 PostgreSQL 主进程后的自动进程树恢复。** 最初该方式使整组演练反复 LOCAL_PORT_IN_USE；还观察到后台连接进程残留。独立新集群 probe 对照：正常 fast stop 可释放端口；仅杀 postmaster、仍保留合成连接时首次绑定 EADDRINUSE；显式关闭连接后可同端口重启；原生 immediate 停止后端口可绑定、所属后台进程退出。证据不足以证明长期 TIME_WAIT 错误拒绝，也不能判单杀主进程自动恢复通过。本卡据此明确数据库验收使用 immediate，保持生产端口/所有权检查；未用放宽检查或删除 PID 文件来让测试通过。排查遗留的两个隔离后台进程按原父 PID、创建时间和命令路径精确核对后回收；最终本机 PostgreSQL 进程枚举为零。P1 遇到异常仍结束本轮，不自动追加模型调用或发送。

## 修复与文件

`scripts/local-stack.mts` 提取共享驱动到 `scripts/local-stack-driver.mts`，入口不接受 fixture 环境或命令行覆盖。生产微信组合根、出站默认值与发送权限不变。

驱动增加启动前集群 PID 保护、ready 时核对实际所属 PID、可取消的就绪与迁移、幂等停止、命令回收及停止期限。替换进程尚未取得集群 PID 文件时，不覆盖上一个已知所属记录；不主动删除 PID 文件。进程有 PID 时的操作 error 不再伪装成已退出，停止仍等实际 exit。新回归用例在旧 error=finish 逻辑下确实失败，修复后通过。

`scripts/local-supervisor.mts` 修复两处已复现的问题：后续服务等待启动时，较早依赖退出未能及时停止整组；一个停止失败导致其他依赖没有清理。现在监听所有已创建进程的退出，尽力停止其余服务后才报告停止失败，并禁止启动替换。新增固定 service_stopped 事件可核对停止顺序，两条回归先复现失败后通过。

新增/修改文件：

- `scripts/local-stack.mts`、`local-stack-driver.mts`、`local-stack-driver.test.mts`、`local-supervisor.mts`、`local-supervisor.test.mts`
- `tests/integration/postgres-local-stack.test.mts`：4 个真实进程集成用例
- `tests/fixtures/local-stack-helper.mts`、`local-stack-bridge.mts`、`local-stack-wait.mts`：仅 test 环境、回环、合成身份、假模型；拒绝真实模型密钥与生产出站开关
- `deploy/runbook.md`、当前开发计划与本卡两份报告

## 完整门禁

使用原有隔离测试库、本机原生 PG 工具、浏览器执行 `npm run verify`，退出码 0。新进程演练另建自己的集群，不使用原有测试库。结果：

| 类别 | 通过 | 失败 | 跳过 |
| --- | ---: | ---: | ---: |
| unit | 278 | 0 | 0 |
| app | 20 | 0 | 0 |
| tools | 15 | 0 | 0 |
| contracts | 10 | 0 | 0 |
| PostgreSQL integration | 44 | 0 | 0 |
| E2E（含手机 Chromium） | 30 | 0 | 0 |
| 合计 | **397** | **0** | **0** |

网页 TypeScript 检查与构建通过。较上一基线 390 增加 7 项：3 个进程/监督回归、4 个原生整组集成。最慢新增用例约 13.5 秒，整个集成组约 25.8 秒。原有验证集群在核对本轮 PID 后已 fast stop；临时日志与测试材料未入仓库。

运行新集成用例需 `LOCAL_TEST_PG_BIN` 指向含 initdb/postgres/pg_ctl 的原生目录；原生 PG_DUMP_BIN 同目录可作为备选。仅设置集成环境而缺少该工具时会明确失败，不偷偷跳过。现有 CI 使用容器备份包装脚本，尚需 P6 配置原生工具；本次没有运行或宣称远程 CI 通过。Linux 原生进程路径与整机/休眠/开机自启也未验收。

## 下一步

P1 真实闭环仍由本人按 [原清单](P1-1-checklist-2026-10-02.md) 和 [现行补充](P1-current-checklist-supplement-2026-10-02.md) 在场执行。需明确当次模型预算，准备唯一知情测试好友与来信；最终收件人/正文/单条单次授权在候选出现后确认。P1 未通过前不开始 P2 试用，P3 真实送达/来源取证仍未执行，自动模式关闭。P5 部署和 P6 远程 CI 继续后置。
