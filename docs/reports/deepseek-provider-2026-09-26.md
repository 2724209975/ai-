# DeepSeek 作为首个真实模型接入（2026-09-26）

## 背景

主线已经跑通，但候选内容一直是 04 的持久 fake（占位文本）。本人选定 **DeepSeek** 作为首个真实模型，本次把 provider 实现、接线与门禁做完；真实 API 调用等本人提供密钥后再做。

## 变更文件

| 文件 | 作用 |
| --- | --- |
| `packages/ai/generation/deepseek-provider.mts` | DeepSeek provider：构造 prompt、调用 OpenAI 兼容的 `chat/completions`、把回答归一化成 04 校验的候选结构 |
| `packages/ai/generation/deepseek-env.mts` | 只读 DeepSeek 自己的环境变量；密钥不进公共配置、不进日志、不进错误文本；附带可安全记录的描述视图 |
| `packages/ai/generation/fake-provider.mts`、`text-provider-contract.mts` | **契约修订**：`generate`/`invoke` 现在收到 `PolicyProjection` |
| `packages/ai/strategy/persistent-fake.mts` | 抽出 `intelligenceFromPort`；新增 `createTextModelIntelligence`（同一套决策/检查/持久化，只有候选文本换成模型） |
| `packages/ai/index.mts` | 导出 provider、env 工厂与新的 intelligence 工厂 |
| `apps/core/config.mts`、`runtime.mts`、`main.mts` | `INTELLIGENCE_PROVIDER=deepseek` 可选；缺密钥在**启动时**失败；核心用真实模型做编辑检查 |
| `apps/bridge/wechat-main.mts` | `WECHAT_INTELLIGENCE=deepseek` 时，微信桥接用真实模型生成候选（候选就是在这里产生的） |

## 为什么改了 04 的内部契约

原来的 `CandidateGateway.generate` / `TextModelProvider.invoke` 只收到 `context` 和 `decision`，**策略投影在进入生成前就被丢掉了**——目标、额外限制、表达偏好这些恰恰是写 prompt 必须的东西。改成随请求一起传 `PolicyProjection` 后，prompt 才能带上「保持轻松暧昧」「不提钱」「不约见面时间」这类约束。这是 04 内部端口，不涉及公共对象、事件或迁移。

## 决策与检查仍是确定性的

本次只把**候选文本**换成模型：`makeDecision`（是否回、时机、风险类别）与 `checkReply`（事实/边界检查）仍是原有的确定性实现，02 的租约、确认、账本、未知结果处理也一行未改。也就是说模型多了一层不可靠性来源，但**没有任何权限被放宽**：模型输出仍要过同一套检查，仍需本人确认，仍然只能经 02 派发。

## 配置

```
INTELLIGENCE_PROVIDER=deepseek          # 默认 persistent-fake
DEEPSEEK_API_KEY=<私密>                  # 必填；缺失时进程启动即失败
DEEPSEEK_MODEL=deepseek-chat            # 默认 deepseek-chat
DEEPSEEK_MODEL_VERSION=<可选>            # 默认同 model；记录用，DeepSeek 不返回日期化快照
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_DATA_REGION=CN                 # 记录用声明
DEEPSEEK_RETENTION_POLICY=provider-default-unverified   # 默认值即「未核实」，不假装有承诺
DEEPSEEK_TIMEOUT_MS=30000  DEEPSEEK_MAX_TOKENS=800  DEEPSEEK_TEMPERATURE=1
```

微信桥接另用 `WECHAT_INTELLIGENCE=deepseek`（默认 persistent-fake）选择候选来源，与出站开关 `WECHAT_ENABLE_OUTBOUND` 相互独立：可以「真实模型 + 只接收」，也可以「fake + 可派发」。

密钥处理：只从 `DEEPSEEK_API_KEY` 读取，不写入 `CoreConfig`（有用例断言配置对象里不含密钥），不出现在日志与错误里（有用例断言错误文本不含密钥）。baseUrl 只接受 `https:` 且不得带凭据、查询或片段。

## 测试与门禁

`packages/ai/generation/deepseek-provider.test.mts`（假端点，无网络）：

- prompt 带上目标、额外限制、已确认事实，并把推测标成推测；历史按「对方/本人/助手」标注时间；
- 正常回答归一化正确、`usage` 记录 input/output token；
- ```` ```json ```` 围栏、前后夹带文字、`parts` 为对象而非字符串都能救回来；纯文本、空数组、无 JSON 一律失败关闭；
- HTTP 402、空回答、不可用 JSON 全部抛错，且**错误文本里不含密钥**；
- 缺密钥/非 https baseUrl/非法数值立即拒绝；`describeDeepSeekEnv` 的输出不含密钥；
- 端点不响应时按自己的超时中止，不会把联系人永远挂在「生成中」。

完整本机门禁：**244 unit、10 contract、31 PostgreSQL integration、22 E2E 与网页构建，0 fail / 0 skip**（新增 6 项 provider 用例与 1 项配置用例）。

## 未完成与边界

- **还没发出过真实 API 调用**：本机没有密钥，本次全部用假端点验证；真实调用的成本、时延、限流表现都还没有测量，D06 的预算上限仍未定。
- 数据地区与保留策略目前是**操作者声明**，不是 DeepSeek 的承诺；如果本人要求核实，需要单独查证并写入 D06。
- 未使用 `deepseek-reasoner`：推理模型更慢更贵，首版用 `deepseek-chat`；换模型只需改 `DEEPSEEK_MODEL`。
- 只接了微信桥接与核心；QQ 桥接仍固定用 fake（`apps/bridge/bridge.mts` 的 intelligence 未做成可注入），属于后续一致化工作。
