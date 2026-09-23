# 06 手机网页管理端

运行 npm run build，产物在 build；npm run preview 预览构建。默认只调用同源 /api/v1，不包含 DemoOwnerApi，也没有真实发送路径。后端未提供时页面显示接口错误，不显示演示记录。旧 dist 为此前演示产物，不是本次构建结果。

页面以 hash 导航：overview、tasks、contacts、conversations、facts、analyses、media、skills、imports、audit、faults。写命令只在后端 allowedActions 包含对应动作时呈现，并提交版本和幂等键；后端仍须独立检查。409 后刷新，明确提示旧内容未发送。确认与恢复分离。发送按逐条状态展示；SUBMITTED 仅是平台接受。

当前 REST 路由及字段是 docs/reports/web-06-api-proposal-2026-09-23.md 的待批准提案。02 尚无 REST provider，03/05/07 所需接口也未就绪，因此不能将页面构建视为模拟联调或真实平台验收。上线还需登录、HTTPS、CSRF/Origin、查询 scope、媒体短期鉴权和持久发送账本。
