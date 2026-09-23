# 06 手机网页续作交付记录

日期：2026-09-23。契约基线：contracts.md v0.2.0；新增 REST 细节均为 06 提案，待架构总控批准。

## 变更

- 检查了原 React/Vite 单页及 dist 构建：原页只使用 DemoOwnerApi，旧 dist 仍是演示版本。
- apps/web/src/api.ts 移除 DemoOwnerApi，改为同源 /api/v1 HTTP 适配；统一错误、凭证和禁缓存处理。后端缺失时显示接口未接通/HTTP 错误，不注入演示数据。
- apps/web/src/App.tsx 和 style.css 增加 11 个手机页面：总览/连接、待办、联系人、会话、资料记忆、分析证据、媒体与表情素材、Skill、导入、审计、故障。当前为数据投影和部分命令入口，见下方限制。
- 待办按方案与分条编辑，命令携带 taskVersion、planVersion、alternativeId、editedParts、contentHash、idempotencyKey。409 刷新并明确提示旧版本未发送。发送逐条显示提交、平台接收、送达、确定失败、结果未知；确认与恢复分开。
- 按后端 allowedActions 决定命令入口；前端不定义业务风险放行规则。媒体只接受同源受控 /api/v1/media/ 地址。所有写操作仍须后端鉴权、版本和权限复核。
- docs/reports/web-06-api-proposal-2026-09-23.md 给出查询、命令、响应和缺口，供架构总控审查。未修改 06 以外代码或公共契约。

## 验证

| 检查 | 结果 | 证据性质 |
| --- | --- | --- |
| npm run build | TypeScript + Vite 通过，产物 apps/web/build | 静态构建 |
| 360×740、320×640 浏览器视口 | 页面宽度与 scrollWidth 分别相等，无横向溢出；导航可触控、待办导航更新 hash | 手机尺寸布局检查，非真机 |
| 缺后端 /api/v1/overview、/tasks | 两页明确显示 HTTP 404 当前数据不可用；没有待办或发送成功假象 | 负向 UI 检查 |
| 慢网、重复点击、刷新/返回、会话过期、409 竞态、部分发送 | 尚无可调用 provider/夹具，未运行 E2E | blocked |
| 微信/QQ 真实平台 | 未接入、未运行 | blocked |

首次沙箱构建无法覆盖旧 dist/tsconfig.tsbuildinfo；将构建输出固定为 build，禁用 TypeScript 增量文件，获准在工作区写入后构建通过。预览指向 build。旧 dist 留存，不作为本次证据。

## API 依赖和未完成

02 只有内存 getConversation/listPending，没有 /api/v1 路由、持久幂等/发送账本或正式 allowedActions 投影；03 的媒体/记忆/导入查询，04 的分析证据，05 的 Skill，07 的鉴权/HTTPS/CSRF 均未提供。提案中的动作 URL 未经总控批准，不能称已联调。联系人加入和完整配置、资料新建、会话本人回复、Skill 创建/导入/临时指定、历史上传/映射、故障核对与安全媒体获取目前只有页面框架或待后端接口，尚不可用。

D02 只提供网页内刷新，没有后台通知。D03 按安全默认把确认与恢复分开。D05/D10–D13 未定事项不固化为 UI 权限。模拟联调：未发生。真实平台验收：未发生。AC03/15/20/27/31/32/35/37 的 06 UI 证据均未达到通过门槛；目前只有构建和无后端负向展示。

下一步由总控批准 REST schema 和 provider；02/03/05/07 提供后以固定夹具做 mock E2E，覆盖旧确认、新消息、编辑多条、结果未知、部分发送、暂停隔离与刷新/会话过期，再做真机和真实平台验收。
