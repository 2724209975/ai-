# 微信真实来信 → DeepSeek 候选（2026-09-27）

在本机测试号与同一位知情测试好友之间，完成一次**只接收**的实时验证。使用新建隔离库；微信桥接设 `WECHAT_INTELLIGENCE=deepseek`、`WECHAT_ENABLE_OUTBOUND=0`、`WORKER_ENABLED=0`，健康检查为 `receive-only / disabled`。核心就绪检查四项均通过，验证前由本人管理接口显式解除全局暂停。

客户端 `WeChatWin.dll` 哈希前缀 `2058A926`、已验证的 helper DLL 哈希前缀 `9F1A96D9`；单一测试号进程 `checkLogin=1`，安装接收 hook 返回 `code=0`。知情好友手发一条无私人信息的测试短语；实际文字比约定短语少一个空格，去除空格后相同。

| 观察项 | 结果 |
| --- | --- |
| 接收 | 隔离库新增 1 条 `text/live` 来信，带平台消息 ID；私有原始事件文件 1 个 |
| 模型 | `deepseek-flash` 调用成功，约 1033 ms，输入 281 token、输出 41 token |
| 待办 | 本人 API 出现 1 条 `AWAITING_CONFIRMATION`，2 个非空候选，允许 `confirmPlan`；候选为“收到”和“好的，收到测试” |
| 发送 | `orch_send_tasks=0`；桥接未创建发送传输或派发 worker，也未执行确认 |

采样结束后，先通过本人 API 全局暂停，再卸载接收 hook（`code=0`），停止临时核心、桥接和隔离数据库服务。隔离库及证据保留。本轮证明真实微信来信可以经持久化链路生成 DeepSeek 待确认候选；未验证系统发送、平台回执或生产长期运行。
