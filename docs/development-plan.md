# 开发计划（2026-10-04 重写：QQ 优先）

本文件是**唯一的当前计划与状态入口**，供本人和多个 AI 协作开发时使用。历史进展、测试数字和实测细节在 `docs/reports/`；已交付卡的完整卡文、旧版状态段落和 G0–G7 看板只保留在 git 历史中（`git log -- docs/development-plan.md`）。

改动优先级不变：本人明确决定 > PRD v1.3 已确认规则 > [公共契约](contracts.md) > 模块实现。

## 0. 当前状态（每完成一个任务，由总控更新本节）

| 项 | 状态 | 证据 |
| --- | --- | --- |
| 本机完整门禁 | 最近一次（P4-6c）760 pass / 0 fail / 0 skip | [P4-6c](reports/P4-6c-2026-10-04.md) |
| 确认主线（P1） | **本人 2026-10-02 判通过**：微信真实来信 → DeepSeek 候选 → 确认 → 发送 → 人工核对 → 恢复，同次闭环 | [P1 报告](reports/p1-real-mainline-2026-10-02.md) |
| 微信接收 | 文字/图片/语音真实实测通过，带平台消息 ID；只绑定客户端 3.9.11.25（`WeChatWin.dll` 前缀 `2058A926`） | [A21](decisions.md)、[接收接入](reports/wechat-receive-bridge-2026-09-24.md) |
| 微信发送 | 人工核对送达；**无回显、无平台消息 ID**，每次都记 `RESULT_UNKNOWN` 并暂停该联系人 | [真机发送](reports/wechat-real-send-2026-09-26.md)、[W01](reports/wechat-w01-2026-09-26.md) |
| QQ | **CONDITIONAL**（2026-09-24）。只接收和受控文字发送有实测，accepted 回执带平台消息 ID；系统回显 ID 与账本一致（1 个样本）。P4-6a/b/c 已交付模型接线、看门狗、本机栈 QQ 选择、持久账本回显识别与受控图片链路（默认关闭）；已批准表情发送和新版真机验收待完成。缺口由 **P4-6** 补 | [QQ spike](reports/platform-qq-2026-09-24.md)、[自身来源](reports/qq-self-origin-2026-09-24.md) |
| 真实模型 | DeepSeek `deepseek-flash` 已在微信路径实测；限额是单进程 UTC 日调用/token 计数，重启清零，不是月费用上限 | [P1 报告](reports/p1-real-mainline-2026-10-02.md)、[A25](decisions.md) |
| 回复质量 | **尚未评估**（D08 未定）。反馈采集、试用报告、提示词版本/回放工具已交付，真实试用未开始 | [P2-1](reports/P2-1-2026-10-02.md)、[P2-2](reports/P2-2-2026-10-02.md)、[P2-3](reports/P2-3-2026-10-02.md) |
| 多媒体理解 | 微信图片：受控获取 → 完整性验证 → 理解 → 候选已接线，默认关闭，真实字节和质量未验收。**微信语音 NO_GO，已搁置** | [P4-4c](reports/P4-4c-2026-10-03.md)、[P4-5e](reports/P4-5e-2026-10-04.md) |
| 关机后持续运行（AC23） | 未做；部署位置推迟到 P5 决定，之前一律在本人电脑上运行 | — |
| 远程仓库与 CI | 未配置；`.github/workflows/verify.yml` 已写好但从未运行，放到 P6 | — |
| 42 条 AC | 全部未判通过，映射见附录 A | [证据矩阵](reports/acceptance-matrix.csv) |

**当前阶段**：P1 已通过。本人 2026-10-04 决定**微信暂时搁置，优先推进 QQ（P4-6 系列）**，目标是让 QQ 独立跑通「真实来信 → DeepSeek 候选 → 确认 → 发送 → 回显不误停」，并补齐 CONDITIONAL → GO_CONFIRM_ONLY 的缺口。微信语音（P4-5f）搁置，NO_GO 维持。P2 试用和 P3 自动模式尚未开始；提前开发 P4 不代表 P2/P3 门槛已通过。

| 未完成的卡 | 状态 | 下一步 |
| --- | --- | --- |
| P4-6a QQ 入口对齐主线 | 已交付；真机待本人执行 | [复核报告](reports/P4-6a-review-2026-10-04.md) |
| P4-6b QQ 系统回显识别 | 已交付；真机待本人执行 | [报告](reports/P4-6b-2026-10-04.md)、A26 |
| P4-6c QQ 图片原件获取与受控理解 | 已交付，默认关闭；Q1 真机核对待本人 | [报告](reports/P4-6c-2026-10-04.md) |
| P4-6d QQ 已批准表情发送 | **暂时搁置（本人 2026-10-04），不实现发送** | [未批准提案](reports/P4-6d-proposal-2026-10-04.md)留存；迁移 0013 未应用，恢复前重新审定 Q2 |
| QQ 真机验收 | 每张卡交付后由本人执行 | 见 §4.2 末尾清单 |
| P4-5f 微信语音 provider 复核 | **搁置**（本人 2026-10-04） | 见 §4.3 |
| P2-6 本机试用 | 未开始，需 D06 预算 | — |
| P3-1 真实验证、P3-2～4 | 未开始 | 依赖 P2 结论与 D03/D04 |
| P4 其余扩展、P5、P6 | 未开始 | 见 §4.4 |

## 1. 总体路线

核心判断：发送安全（租约、账本、未知结果暂停、隔离）已经很扎实，但**回复好不好用从未验证**。P2/P3 保留真实运行门槛。本人 2026-10-02 决定先开发 P4；2026-10-04 决定 P4 内**先做 QQ**。功能开发全部在本人电脑上完成，最后再决定部署到哪里。

```text
P0 工程底座 ─> P1 真实闭环验收 ─> P4 扩展功能（当前：QQ） ─> P2 本机试用期（1–2 周）─> P3 小范围自动模式 ─> P5 常在线部署 ─> P6 收尾
```

P0–P4 全部在本人电脑上运行：电脑开着才收信、出候选和发送；关机或休眠时什么都不做，重启后「启动即暂停」，不会补发。

| 阶段 | 目标 | 退出门槛（本人判定） | 状态 |
| --- | --- | --- | --- |
| P0 工程底座 | 单一状态入口；决策与事实一致；基线全绿 | 完整门禁 0 fail、0 skip | 已完成 |
| P1 真实闭环验收 | 真实来信 → 真实候选 → 确认 → 真实发送 → 核对 → 恢复，同一次完成 | 账本、`model_call`、待办、核对记录对得上，有报告 | 已通过（微信） |
| P2 本机试用期 | 1–3 个真实联系人只开确认模式，积累质量数据 | 质量基线报告；本人据此定 D08 | 开发已交付，试用未开始 |
| P3 小范围自动模式 | 1 个联系人真实自动发送，再逐个扩大 | P3 安全用例全过；自动发送能拿到送达确认；1 周无越权 | 未开始 |
| P4 扩展功能 | QQ、多媒体、历史导入、外部通知、分析、Skill | 各自对应的 AC | 进行中 |
| P5 常在线部署 | 本人电脑关机后系统仍运行 | 宿主可行性、AC23 实测、备份恢复演练、告警 | 未开始 |
| P6 收尾 | 私有远程仓库与 CI | 远程 CI 首次全绿 | 未开始 |

**P4 内部顺序**（本人 2026-10-04 调整）：

1. **QQ**：P4-6a～c 已交付，接下来准备文字和图片的 QQ 版 P1 真机验收。本人 2026-10-04 决定暂时不做表情发送，P4-6d 搁置，不作为本轮验收的前置条件。
2. **多媒体剩余项**：本人纠正/删除解释的网页入口；微信语音搁置。
3. **历史导入**（AC22，D05）：需要本人提供导出样本。
4. **外部通知**（D02）：待办、未知发送、故障提醒，只含类型和时间；P5 宿主告警复用。
5. **性格与关系分析**（AC25–34，D10/D11）。
6. **Skill**（AC35–42，D12/D13）。

每一项开工前，由总控按 §4 格式拆成任务卡。

## 2. 多 AI 协作规则（每个执行 AI 开工前必读）

### 2.1 角色

- **本人**：做产品决策；执行一切真实平台操作（登录、注入、真实发送、核对送达）；判定阶段门槛。
- **总控 AI**（同一时间只有一个）：维护本文件、[decisions.md](decisions.md)、[contracts.md](contracts.md)、`packages/contracts`、根 `package.json` 与锁文件、`db/migrations` 编号分配；负责合并分支、更新 §0。
- **执行 AI**：每次只领一张任务卡（§4），只改卡上列出的路径。

### 2.2 开工前阅读

1. 本文件的 §0、§2 和自己那张任务卡。
2. [architecture.md](architecture.md) 第 2、4 节（模块权责与一致性边界）。
3. 卡上「背景」列出的文档，以及对应模块的 `docs/tasks/0X-*.md`。
4. 卡上列出的源码，以及现有测试。

### 2.3 分支、文件归属与合并

- 每张卡一个分支 `task/<卡号>-<简短英文名>`，或使用 worktree。合并由总控执行。
- **只改卡上「可改路径」**。需要改别的路径、公共契约、新增依赖或迁移时，先写提案 `docs/reports/<卡号>-proposal-<日期>.md`，交总控审定后再改。
- **冲突热点**：同一时间只能有一张进行中的卡改动下列文件：
  - `packages/orchestration/postgres/confirmed-service.mts`
  - `apps/web/server/owner-http.mts`
  - `apps/web/src/App.tsx`
  - `apps/bridge/wechat-main.mts`
  - `packages/platform/wechat/reception.mts`
  - `apps/bridge/bridge.mts`（P4-6a/b/c 都改它，必须串行）
- **迁移编号**：已用到 `0012`。下一个编号由总控分配，执行 AI 不得自取：

  | 编号 | 分配给 | 状态 |
  | --- | --- | --- |
  | 0011 | P2-3 方案生成版本元数据 | 已应用，旧记录不回填 |
  | 0012 | P2-4 账号健康记录 | 已应用；探测恢复不解除故障暂停 |
  | 0013 | 预留给 P4-6d 表情发送 | 本卡搁置，未应用；恢复前由总控随新提案确认 |

- 已应用的迁移、他人的历史报告一律不改写。
- **不要写死部署位置**：P0–P4 的代码和配置不能假设某种宿主；本机专用的启动脚本放在 `scripts/` 并注明「本机开发用」。

### 2.4 完成定义（每张卡都要满足）

1. 本机完整门禁全绿，0 fail、0 skip：

   ```bash
   TEST_DATABASE_URL=postgres://<user>@127.0.0.1:55432/chat_agent_test RUN_BROWSER_E2E=1 npm run verify
   ```

   PostgreSQL 用例缺 `TEST_DATABASE_URL` 时会 skip，**skip 不算通过**。
2. 新行为都有测试；修复缺陷先写能复现的失败用例。
3. 交付记录 `docs/reports/<卡号>-<日期>.md`：改了哪些文件、测试数量、新增迁移、未完成项和限制、需要总控处理的公共变更。
4. mock/fake 结果与真实平台结果分开写；不得把 mock 通过写成平台通过。

### 2.5 红线（执行 AI 一律不做，只能准备好步骤交给本人）

- 真实微信/QQ 发送；启动、注入或卸载 wxhelper/NapCat；登录任何平台账号；联系真实好友。
- 把 `WECHAT_ENABLE_OUTBOUND=1`、`QQ_ENABLE_OUTBOUND=1` 写进默认配置，或在任何非本人在场的进程里开启。
- 调用付费 DeepSeek 或媒体模型 API。本人在场并明确授权的 smoke 除外，且必须在预算上限内。
- 放宽 `RESULT_UNKNOWN`、暂停、epoch/CAS、租约语义（本人已批准的 P4-6b 回显规则除外，且只限卡上写明的条件）；绕开 02 直接发送；让 `apps/core` 具备派发能力（[A22](decisions.md) 有契约测试守护）。
- 把密钥、口令、真实聊天正文、联系人身份、QQ 号、原始事件文件提交进仓库或写进日志。
- 改写已应用迁移；靠修改测试期望让测试通过。
- 购买或开通任何云资源。

## 3. 待本人决定

| 编号 | 问题 | 计划采用的默认值 | 什么时候必须决定 |
| --- | --- | --- | --- |
| Q1 | 是否打开 `QQ_MEDIA_ORIGINAL_VERIFIED` | 关闭；QQ 图片继续转人工 | P4-6c 交付后，本人真机核对确认是原图而非缩略图 |
| Q2 | P4-6d 表情发送方案（迁移 0013、批准存储统一） | 本人 2026-10-04 决定暂时不做，提案未批准 | 恢复本卡时重新审定提案 |
| D06 | 月度模型预算上限 | 沿用按日调用次数和 token 上限 | P2 开始前 |
| D08 | 回复质量门槛 | P2 先报告基线，不预设门槛 | P2 结束时 |
| D03 | 自动模式下「确认并发送」后是否同时恢复自动 | 保持暂停，另给「发送并恢复」按钮 | P3 开始前 |
| D04 | 聚合窗口、回复延迟、主动联系 | 聚合 8s / 最长 30s、无延迟、主动联系关闭 | P3 开始前 |
| D02 | 外部通知渠道 | 只做网页待办；通知只含最少信息，不含正文 | P4 做外部通知前 |
| H1 | 常在线部署位置 | **暂不决定**，P5-0 时再选 | P5 开始时 |

本人决定后由总控写入 [decisions.md](decisions.md)。

## 4. 任务卡

每张卡的格式：模块（对应 01–07）｜可改路径｜依赖｜要做｜验收｜边界。卡号前缀即阶段。

### 4.1 已交付卡索引

完整卡文见 git 历史，范围与限制以各报告为准。

| 卡 | 内容 | 状态 | 报告 |
| --- | --- | --- | --- |
| P0-1 | 状态入口收敛 | 已交付 | [报告](reports/P0-1-2026-10-02.md)、[完成记录](reports/P0-1-followup-2026-10-02.md) |
| P0-2 | 决策登记更正（A20/A23 迁移预留撤销） | 已交付 | [报告](reports/P0-2-2026-10-02.md) |
| P0-3 | 干净 main 基线复核 | 已交付，342 pass | [报告](reports/P0-3-2026-10-02.md) |
| P1-1 | 受控验收步骤清单与对账脚本 | 已交付 | [报告](reports/P1-1-2026-10-02.md)、[现行补充](reports/P1-current-checklist-supplement-2026-10-02.md) |
| P1-2 | 微信真实闭环执行 | 本人判通过 | [报告](reports/p1-real-mainline-2026-10-02.md) |
| P2-1 | 候选反馈采集（五种终态、拒绝原因） | 已交付 | [报告](reports/P2-1-2026-10-02.md) |
| P2-2 | 试用报告脚本（无正文/身份） | 已交付，部分指标受采集缺口限制 | [报告](reports/P2-2-2026-10-02.md) |
| P2-3 | 提示词版本化与离线回放（迁移 0011） | 已交付 | [报告](reports/P2-3-2026-10-02.md) |
| P2-4 | 本机常驻与看门狗（迁移 0012，仅微信入口） | 已交付，真实人工演练未执行 | [报告](reports/P2-4-2026-10-02.md) |
| P2-5 | 微信客户端版本守护 | 已交付 | [报告](reports/P2-5-2026-10-02.md) |
| P2-x | 本机完整启动与异常恢复演练 | 离线已交付；单杀 PG 主进程路径未验收 | [报告](reports/P2-x-local-stack-2026-10-02.md) |
| P3-1 | 微信发送送达确认（离线研究/取证工具） | 离线已交付；真实验证未执行 | [报告](reports/P3-1-offline-2026-10-02.md) |
| P4-1 | 多媒体理解底座 | 已交付 | [报告](reports/P4-1-2026-10-02.md) |
| P4-2 | 媒体解释持久化与失效复核 | 已交付；网页纠正入口未接 | [报告](reports/P4-2-2026-10-03.md) |
| P4-3 | 真实图片/语音 provider 与独立限额 | 已交付；真实供应商未验收 | [报告](reports/P4-3-2026-10-03.md) |
| P4-4 | 微信图片原文件获取 | 已交付；真机字节未验收 | [报告](reports/P4-4-2026-10-03.md) |
| P4-4a | 图片获取链路衔接修复 | 已交付 | [报告](reports/P4-4a-2026-10-03.md) |
| P4-4b | 图片完整性验证（sharp 0.35.5） | 已交付 | [报告](reports/P4-4b-2026-10-03.md) |
| P4-4c | 受控图片理解接线（默认关闭） | 已交付；真实质量未验收 | [报告](reports/P4-4c-2026-10-03.md) |
| P4-5 | 微信语音能力只读复核 | 已完成 | [复核](reports/P4-5-capability-review-2026-10-03.md) |
| P4-5a | 语音数据库候选离线边界验证 | 已交付 | [报告](reports/P4-5a-2026-10-03.md) |
| P4-5b | 独立受限 helper 构建与接收验收准备 | 已交付；本人真机未执行 | [报告](reports/P4-5b-2026-10-03.md)、[清单](reports/P4-5b-checklist-2026-10-03.md) |
| P4-5c | 可信数据库句柄来源离线复核 | 已交付；NO_GO | [报告](reports/P4-5c-2026-10-03.md) |
| P4-5d | SQLite 入口与 MediaMSG 来源离线定位 | 已交付；NO_GO | [报告](reports/P4-5d-2026-10-04.md) |
| P4-5e | 展开链与数据库对象生命周期复核 | 已交付；NO_GO | [报告](reports/P4-5e-2026-10-04.md) |

### 4.2 P4-6 QQ 系列（当前优先）

**共同背景**：[QQ spike 报告](reports/platform-qq-2026-09-24.md)、[自身来源专项](reports/qq-self-origin-2026-09-24.md)、[QQ 平台 README](../packages/platform/qq/README.md)、[apps/bridge README](../apps/bridge/README.md)、[01 职责](tasks/01-platform.md)、[A16](decisions.md)。

**共同规则**：
- **不改微信文件**（`apps/bridge/wechat-main.mts`、`apps/bridge/wechat-bridge.mts`、`packages/platform/wechat/*`）。新写的共享辅助模块先只给 QQ 用；微信改用它的事留到以后，在报告里登记。
- `apps/bridge/wechat-bridge.mts` 和 `wechat-main.mts` 是**只读参照**：QQ 要补的东西微信基本都已有，照着它的结构做。
- 真实 NapCat 登录、注入和发送一律由本人执行；所有平台交互在测试中用假 OneBot HTTP 服务（参照 `tests/integration/postgres-qq-bridge.test.mts` 里的写法）。

**P4-6a QQ 入口对齐主线**
- 模块：01+07｜可改：`apps/bridge/main.mts`、`apps/bridge/bridge.mts`、新增 `packages/platform/qq/onebot-probe.mts`（含测试）、`scripts/local-stack-driver.mts`、`scripts/local-stack.mts`、`scripts/local-stack-driver.test.mts`、`tests/integration/postgres-qq-bridge.test.mts`、新增 `tests/integration/postgres-qq-watchdog.test.mts`、`apps/bridge/README.md`、`deploy/runbook.md`、本卡报告
- 依赖：无
- 要做：
  1. **真实模型**：`QqBridgeOptions` 增加 `intelligence?: PersistentIntelligence`，默认仍是 `createPgPersistentFakeIntelligence`（现状 `bridge.mts:72` 写死）。`main.mts` 读 `QQ_INTELLIGENCE`（`persistent-fake`|`deepseek`，默认 fake，其他值启动失败），装配照搬 `wechat-main.mts:64-73`。复用 `readDeepSeekEnv`、`describeDeepSeekEnv`、`createDeepSeekFromEnv`、`createTextModelIntelligence`（`packages/ai/index.mts`），日限额自动生效；日志只输出 `model_call` 的度量和模型名。
  2. **启动即暂停与看门狗**：增加 `startPaused?`、`watchdog?`、`onWatchdogFatal?`。`start()` 的顺序与 `wechat-bridge.mts:252-255` 一致：记 `BRIDGE_RESTARTED` → `recover` → `watchdog.tick`，然后 outbox，最后 worker。复用 `apps/bridge/watchdog.mts` 的 `createAccountWatchdog`。
  3. **OneBot 只读探针** `createOneBotHealthProbe({ baseUrl, accessToken, selfId, pid? })`，实现 `HealthProbe`：
     - **只能**调用固定动作 `get_login_info`，返回的 `user_id` 必须等于 `QQ_SELF_ID` 才算登录正常；
     - 不做通用 action 调用器；不跟随重定向；限制回包大小；有超时；
     - 提供 `QQ_PROCESS_ID` 时才检查进程是否存活，否则视为存活。
     - 故障码复用 0012 已有枚举（`HOOK_LOGIN_ABNORMAL`、`HELPER_UNRESPONSIVE`、`PROCESS_EXITED`），**不新增迁移**。
  4. **装配规则**：
     - 看门狗在配置了 `QQ_ONEBOT_HEALTH_URL`（默认取 `QQ_ONEBOT_BASE_URL`）时启用；只接收模式没有配置时不启用，`/healthz` 如实报告。
     - `main.mts` 默认 `startPaused: true`；`QQ_QUIET_MS`、`QQ_WATCHDOG_INTERVAL_MS` 可调，默认与微信一致；看门狗致命时进程退出码为 1。
     - 看门狗致命时，`/healthz` 和 `/onebot/event` 都返回 503。
  5. **`/healthz`** 输出 `{status, adapter, mode, worker, watchdog?}`，不含 QQ 号、token 或 URL。worker 只在出站开启时创建（照搬 `wechat-bridge.mts:148-152`），出站关闭时不再传一个拒绝发送的 transport。
  6. **本机常驻栈**：
     - `LocalStackConfig` 增加 `platform`，取自 `LOCAL_BRIDGE_PLATFORM=wechat|qq`（默认 `wechat`，其他值失败）；
     - 必填环境变量按平台切换：QQ 要求 `QQ_ACCOUNT_ID`、`QQ_SELF_ID`、`QQ_BRIDGE_TOKEN`，出站时再要求 `QQ_ONEBOT_BASE_URL`；
     - `CORE_PLATFORM` 跟随平台（现状 `local-stack-driver.mts:33` 写死 wechat）；
     - 入口按平台选 `apps/bridge/main.mts` 或 `wechat-main.mts`（现状 `:81` 写死）；
     - 更新 `local-stack.mts` 的头注释。
- 验收：
  - QQ 桥接注入 fake 文本 provider（参照 `tests/integration/postgres-wechat-bridge-dispatch.test.mts`），真实模型路径产出候选；
  - 假 OneBot `get_login_info` 测出三种故障码写入 `orch_account_health` 并暂停，以及 `/healthz` 和入口的 503（参照 `postgres-account-watchdog.test.mts`）；
  - 探针负测：`user_id` 不符、超时、超大回包、重定向、非 JSON；
  - `readLocalStackConfig` 的 qq 和 wechat 两个分支，以及缺变量时失败；
  - 启动即暂停后，人工恢复须先有 healthy 记录；
  - 完整门禁 0 fail、0 skip。
- 边界：不调真实 DeepSeek；不连接真实 NapCat；不改 02、迁移和公共契约。

**P4-6b QQ 系统回显识别**
- 模块：01+02 协作｜可改：`packages/platform/qq/onebot-codec.mts`、`packages/platform/qq/webhook-ingress.mts`、`packages/platform/qq/self-origin.mts`、新增 `packages/platform/qq/pg-echo-ledger.mts`、`packages/infrastructure/postgres/reception.mts`（只加可选钩子）、`apps/bridge/bridge.mts`，以及上述文件的测试、`tests/integration/postgres-qq-bridge.test.mts`、`packages/platform/qq/README.md`、本卡报告
- 依赖：P4-6a（同改 `bridge.mts`）
- **语义（本人 2026-10-04 批准）**：只有 `message_sent` 才走匹配，下面四条**全部**成立才记为系统回显：
  1. 平台消息 ID 与 `dispatch_attempts.platform_message_id` 精确相等；
  2. 账号与 `dispatch_attempts.account_id` 相等；
  3. 事件的 `target_id` 等于该 attempt 所属会话的 `orch_conversations.external_contact_ref`；
  4. attempt 状态是 `SUBMITTED` 或 `DELIVERED`。

  匹配成功时：保存私有原始证据，写一条 inbox 去重行（scope `agent-echo`），**不暂停、不产生公共事件**。02 不接收 `PlatformAgentEchoObserved`，所以不改 02。

  其他情况**一律维持现状**：走 `unmapped_self`，暂停整个账号（`OWNER_ORIGIN_UNMAPPED`）。包括：任一条不符、没有 `target_id`、本人手发，以及账本里还没写入平台 ID（回显比 HTTP 回包先到）。
- 要做：
  1. 解码：`message_sent` 带 `target_id` 时，把它作为候选 peer 交给分类器；身份证明只看 ID 关系，不看正文、时间或 `message_sent_type`。
  2. Pg 账本：实现 `SendEchoLedger.findByPlatformMessageId`，由 `dispatch_attempts` join `orch_conversations` 查询。表很小，**不加索引、不加迁移**。查询在接收事务内执行，与 `finishDispatch` 的写入在事务层面串行化。
  3. 分类：复用 `classifyQqSelfMessage`（`packages/platform/qq/self-origin.mts`），只接受 `durable_platform_id_match`；`owner` 分支不接 verifier，仍是 unknown。
  4. `createPgReceptionPort` 增加可选钩子 `classifySelf(tx, observation)`，在同一事务内判定。**不传钩子时行为完全不变**，微信不受影响。
  5. 回显先到的竞态：本卡**不做重试和等待**，按安全方向暂停，并在报告里写明真机需要观察先后顺序。
- 验收：
  - 精确匹配：不暂停、不建消息、原始证据和 inbox 各 1 行；
  - 消息 ID 对但好友不对、账号不对、状态是 `RESULT_UNKNOWN` 或 `SUBMITTING`、没有 `target_id`、账本无此 ID，都保持账号暂停；
  - 重复投递幂等；本人手发样本仍暂停；不传钩子时 reception 行为不变（回归）；
  - 完整门禁 0 fail、0 skip。
- 边界：`owner_message_signal` 能力仍为 unknown，AC16 不因本卡通过；不新增迁移和公共事件。交付时由总控把本语义写成 ADR 登记进 [decisions.md](decisions.md)。

**P4-6c QQ 图片原件获取与受控理解**
- 模块：01+03+04 协作｜可改：新增 `packages/platform/qq/onebot-media-source.mts`、`packages/platform/qq/media-acquisition.mts`、新增 `apps/bridge/image-preparation.mts`（共享 `ImagePreparationPort` 构造，先只给 QQ 用）、`apps/bridge/bridge.mts`、`apps/bridge/main.mts`，以及上述文件的测试、新增 `tests/integration/postgres-qq-media.test.mts`、`apps/bridge/README.md`、`deploy/runbook.md`、本卡报告
- 依赖：P4-6b（同改 `bridge.mts`）；复用 P4-4b 的完整性验证、P4-4c 的受控理解流程
- 要做：
  1. **OneBot 媒体来源**（实现 `MediaSource`）：
     - 固定动作 `get_image`，参数是原始事件中 image 段的 `file` 标识，通过 `MediaPointer`（账号、好友、原事件、段索引）从私有原始事件中取得；
     - 只接受落在 `QQ_MEDIA_CACHE_DIR`（必须是绝对路径）内的本机文件路径，经 realpath 校验，拒绝符号链接逃逸；
     - 不接受任意 URL，也不接受 `file://`；读取有上限（`QQ_MEDIA_MAX_BYTES`，最大 10 MiB）；整体有超时。
  2. **完整性**：
     - `PgPrivateImageReader` 和理解流程要求 `completeness='complete'`（`packages/data/media/pg-private-reader.mts:24`），而 `acquireQqMedia` 目前只给出 unknown 或 partial；
     - 新增完整解码验证，复用 P4-4b 的图片校验；
     - 部署配置 `QQ_MEDIA_ORIGINAL_VERIFIED=1` 时，才把完整解码通过的字节标为 complete。默认关闭（Q1），关闭时图片继续转人工。
  3. **装配**：`QQ_MEDIA_FETCH=1` 加上 `readMediaEnv` 的 `MEDIA_VISION_ENABLED`，组成 `ImagePreparationPort`：
     - `acquire`：逻辑参照 `wechat-bridge.mts:89-124`，只把取图调用换成 QQ 的；
     - `interpret`：`createImageMediaInterpreter`；
     - `discard`：沿用。
     - 语音理解开关打开时直接拒绝启动（与微信一致）；只开理解不开获取时启动失败。
     - `/healthz` 增加 `mediaFetch` 计数，只输出计数和固定原因码。
- 验收：
  - 假 OneBot `get_image` 返回缓存目录内的文件：取得 → 私有存储 → 理解（假 provider）→ 新快照 → 待确认候选；
  - 负测：目录外路径、符号链接、URL、超大文件、截断或损坏的图、未开 `QQ_MEDIA_ORIGINAL_VERIFIED`、跨联系人、超时、重复投递；这些情况都转人工，且零模型请求；
  - 完整门禁 0 fail、0 skip。
- 边界：不做 QQ 语音（`get_record` 返回转码文件，另行评估）；不调真实模型；不新增依赖和迁移；动态表情继续拒绝。

**P4-6d QQ 已批准表情发送（暂时搁置）**
- 状态：本人 2026-10-04 明确“暂时不做表情发送”；当前提案未批准，不实现发送、不应用迁移 0013。以下为保留的候选任务范围，恢复前须重新审定 Q2。
- 模块：02+01+03+06｜先写 `docs/reports/P4-6d-proposal-<日期>.md`，经本人审定（Q2）和总控分配迁移后再改代码
- 依赖：P4-6c；冲突热点 `confirmed-service.mts`，本卡进行期间不派其他卡改它
- 已知缺口：
  - `confirmPlan` 只接受文本部分（`confirmed-service.mts:387-389`），dispatch 写死 `partType:'text'`（:517）；
  - `orch_send_tasks.content` 是 NOT NULL 文本，需要迁移 0013 来存素材 ID、批准版本和摘要；
  - 批准存储有两套且不一致：`data_media_assets`（owner API 写）与文件元数据 `approveSticker`。需要统一以数据库为准，供 `napcat-bridge.mts` 的 `loadApprovedSticker` 使用；
  - QQ 发送端口目前对表情返回 `UNSUPPORTED_CAPABILITY`（`napcat-bridge.mts:62`）；编码侧 `onebot-codec.mts:116-143` 已就绪。
- 验收（提案中细化）：每条发送前复核批准状态、平台、版本和字节摘要；撤销批准后旧方案不能派发；未批准或不支持的格式拒绝；完整门禁 0 fail、0 skip。

**QQ 真机验收清单（本人执行；每张卡交付后由总控准备具体步骤）**
1. P4-6a 后：QQ 本机常驻栈启动即暂停；看门狗正常；人工恢复后，DeepSeek 在预算内产出候选。
2. P4-6b 后：受控发送 1 条，回显不暂停；本人手发 1 条，仍暂停。记录回显和 HTTP 回包的先后。
3. P4-6c 后：知情好友发 1 张图，核对取得的是原图，再由本人决定 Q1。
4. 表情发送暂不验收；P4-6d 恢复并交付后另安排，不影响本轮文字和图片验收。
5. 汇总成 QQ 版 P1 报告，更新 QQ 能力快照，由本人判定是否从 CONDITIONAL 升为 GO_CONFIRM_ONLY，结论须注明仅覆盖已验收能力，表情发送未实现（AC23 仍待 P5）。

### 4.3 搁置

**P4-5f 微信语音 provider 与数据库注册/销毁保护**：本人 2026-10-04 决定搁置。恢复时，从 [P4-5e 报告](reports/P4-5e-2026-10-04.md) 的缺失项继续离线定位：BufInfoStorage +8 provider、注册/关闭/锁顺序、公开 SQLite ABI。证据不足时保持 NO_GO，新接口、补丁和产物另行审定。

### 4.4 其余待办卡

**P2-6 本机试用（本人执行）**
- 依赖：D06 预算；P2-1/2/4 已交付
- 要做：1–3 个真实联系人只开确认模式，持续 1–2 周，每周跑一次试用报告；期间发现的问题由总控拆成新卡。试用期间不合并会改变生成行为的改动，除非本人同意。
- 验收：`docs/reports/p2-trial-<日期>.md` 给出质量基线；本人确定 D08 和 P4 余下优先级。

**P3-1（续）微信发送送达确认的真实验证**：离线工具已交付。还需要本人逐条授权的真实样本，证明可以匹配；做不到就如实报告，由本人决定接受「每条都要核对」还是停在确认模式。QQ 侧由 P4-6b 处理。

**P3-2 自动发送路径从 mock 扩展到真实平台**
- 模块：02+总控｜可改：`packages/orchestration/`、`db/migrations/`（编号由总控分配）、`docs/decisions.md`
- 依赖：P3-1（微信）或 P4-6b（QQ）、D03、D04
- 要做：新 ADR，在 [A17](decisions.md) 的条件之上，允许已逐个开启的联系人走自动路径；加每联系人每日自动发送上限和一键全局关闭。
- 验收：负向测试证明以下情况都不会自动发送：未开启的联系人、风险非 ordinary、来信非 live 文字、存在未知发送。

**P3-3 自动模式安全用例（真实路径版本）**：AC04、05、10–15、17–20、24 在桥接路径上（假 helper/假 OneBot）的集成和 E2E；另加「休眠或断电后重启：保持暂停、不补发、不重复发送」。全部通过才可进入 P3-4。

**P3-4 单联系人自动试运行（本人执行）**：1 个联系人开启自动，持续 1 周，每天看审计和试用报告；无越权再逐个增加。出现任何越权立即全局暂停，回到确认模式。

**P4 其余扩展**（按 §1 顺序，开工前由总控细化成卡）：
- 多媒体：本人纠正/删除媒体解释的网页入口（冲突热点 `owner-http.mts`、`App.tsx`）；
- 历史导入（AC22，D05）；
- 外部通知（D02）；
- 性格与关系分析（AC25–34，D10/D11）；
- Skill（AC35–42，D12/D13）。

**P5 常在线部署**（所有开发完成后再开始；开始前不做任何部署决定或采购）
- **P5-0 部署位置选型（本人决定 H1）**：AI 整理对比材料。已知约束：
  - 微信 hook 只能在 Windows 上运行，并绑定特定 `WeChatWin.dll` 构建；
  - 微信和 QQ 掉线后都需要扫码，宿主必须能远程操作；
  - 管理端只走私网。
  - 候选方案：A 家里常开的 Windows 电脑；B 阿里云 Windows 实例（机房 IP 风控、注入稳定性、ICP，参见 [aliyun-readiness.md](platforms/aliyun-readiness.md)）；C 核心和桥接分开放置，需另写提案。
  - 产出：对比表（费用、风控、运维、断电断网影响）。
- **P5-1 宿主可行性试验（本人执行）**：同版本客户端，校验哈希；测试号只接收，连续运行至少 3 天，记录掉线、风控、hook 失效和资源占用。结论 go/no-go；no-go 时回到 P5-0，不得换账号或绕过平台验证。
- **P5-2 部署包**：开机自启、启动即暂停、密钥放私有目录、只放行必要端口；在全新同类环境中照文档从零部署成功。
- **P5-3 手机远程访问**：私网组网加 HTTPS（非回环 origin 必须 HTTPS，见 [A22](decisions.md)）；公网扫描不到管理端端口。
- **P5-4 备份与恢复演练**：每日备份数据库、私有原始事件和媒体，副本放在宿主之外。恢复后校验一致，并按「保持暂停 → reconcile → 人工复核未知发送 → 明确开启」的顺序恢复。
- **P5-5 宿主告警**：宿主离线（由外部检测）、需要重新扫码、磁盘不足，复用 P4 的通知渠道。
- **P5-6 本机数据迁移**：全局暂停 → 停桥接 → 备份 → 恢复到新宿主 → 校验 → 保持暂停 → 本人确认后开启。同一时间同一平台只能有一端运行桥接。
- **P5-7 AC23 实测（本人执行）**：微信、QQ 分别验证。本人电脑关机，新宿主独立完成真实来信 → 候选 → 确认 → 核对；再重启一次宿主，确认恢复后保持暂停、不重发。

**P6-1 私有远程仓库与首次 CI**
- 模块：07｜可改：`.github/`、`deploy/`、`docs/reports/`
- 依赖：本人创建私有仓库并授权推送（执行 AI 不替本人建仓）
- 要做：推送前对整个历史做 secret 扫描（密钥、口令、聊天内容、原始事件、QQ 号）；推送；运行 `verify.yml`；修掉只在 Linux CI 上出现的问题。
- 验收：CI 首次全绿，运行链接写进报告。在 P6-1 完成之前，代码只存在本人电脑上。

## 5. 并行安排

| 时段 | 可进行的卡 | 注意 |
| --- | --- | --- |
| 现在 | P4-6a → P4-6b → P4-6c，**串行** | 三张都改 `apps/bridge/bridge.mts`；每张卡交付后由本人做对应的真机验收 |
| P4-6c 交付后 | P4-6d 提案 → 审定 → 实现 | 改 `confirmed-service.mts`，期间不派其他卡改冲突热点 |
| 与 P4-6 并行（可选） | 不改冲突热点的离线卡，例如历史导入的数据形状调研 | 由总控确认可改路径不重叠 |
| QQ 收尾后 | P4 其余扩展；本人决定 D06 后开始 P2-6 | 试用期间不合并会改变生成行为的改动 |
| P2 结束后 | P3-1 真实验证、P3-2、P3-3 | P3-2 依赖 D03、D04 |
| P4 结束后 | P5-0，然后按选定方案依次进行 | — |
| P5 结束后 | P6-1 | — |

## 附录 A：AC01–AC42 主责映射

「主责」负责编写端到端验收和证据，「协作」提供模块测试和接口。涉及平台实况的用例必须分别记录 mock 与微信/QQ real 结果。

| AC | 主责 | 协作 | 关键证据 |
| --- | --- | --- | --- |
| AC01 名单外不处理 | 02 | 01,03,07 | 无分析/方案/发送副作用 |
| AC02 新联系人默认权限 | 02 | 06,07 | 默认策略版本与 UI |
| AC03 确认模式 | 02 | 01,04,06,07 | 编辑最终内容与回执 |
| AC04 自动普通消息 | 02 | 01,04,03,07 | preflight 与实际来源 |
| AC05 连续消息聚合去重 | 02 | 01,03,07 | 虚拟时钟、重复事件 |
| AC06 多媒体理解失败 | 04 | 01,03,06,07 | 各类型 real 能力 + 转人工；QQ 图片见 P4-6c |
| AC07 仅批准表情 | 02 | 01,03,04,06,07 | 素材版本/平台能力；QQ 见 P4-6d |
| AC08 未知/过期事实 | 03 | 02,04,06,07 | 过期注入与暂停 |
| AC09 联系人隔离 | 03 | 04,07 | 存储/检索双层越权测试 |
| AC10 表白专项授权 | 02 | 04,06,07 | 开关组合矩阵 |
| AC11 关系确认 | 02 | 04,06,07 | 风险分类强制确认 |
| AC12 具体约见承诺 | 02 | 04,05,06,07 | Skill 也不能绕过 |
| AC13 拒绝/停止 | 02 | 04,03,06,07 | 边界事件与状态 |
| AC14 主动联系约束 | 02 | 04,06,07 | 时段/冷却/未回复 |
| AC15 旧确认失效 | 02 | 03,06,07 | CAS/新消息竞态 |
| AC16 本人发言接管 | 01 | 02,03,06,07 | 真实平台身份/回显区分；QQ 回显见 P4-6b，本人来源仍 unknown |
| AC17 部分发送后取消 | 02 | 01,03,06,07 | 逐条 preflight/竞态 |
| AC18 超时未知 | 01 | 02,03,06,07 | 提交边界故障注入 + reconcile |
| AC19 联系人故障隔离 | 02 | 01,07 | 并发两联系人 |
| AC20 单人/全局停止 | 02 | 01,06,07 | epoch 同步检查 |
| AC21 删除/过期传播 | 03 | 02,04,06,07 | 索引/摘要/方案依赖 |
| AC22 导入去重且不发送 | 03 | 02,04,07 | import/live 类型隔离 |
| AC23 关机持续运行 | 01 | 02,04,07 | 微信、QQ 分开 real 证据（P5-7） |
| AC24 目标变更需确认 | 02 | 04,06,07 | 建议与配置命令分离 |
| AC25 数据不足分析未知 | 04 | 03,06,07 | 阈值/证据展示 |
| AC26 观察与推测分离 | 04 | 03,06,07 | 结构化 claim 类型 |
| AC27 分析证据追溯 | 04 | 03,06,07 | 正反证据/时间范围 |
| AC28 AI 表白非关系证据 | 04 | 03,07 | provenance 过滤 |
| AC29 纠正/删源失效 | 03 | 04,02,06,07 | 依赖图与重算 |
| AC30 分析不改权限目标 | 02 | 04,06,07 | 负向接口/数据库测试 |
| AC31 分析联系人隔离 | 03 | 04,06,07 | 跨联系人请求测试 |
| AC32 分析调整策略可解释 | 04 | 02,03,06,07 | 分析版本与前后变化 |
| AC33 无权限只建议 | 02 | 04,06,07 | 主动/表白开关 |
| AC34 分析失效使方案失效 | 02 | 03,04,06,07 | 并发删除/确认测试 |
| AC35 技能导入不启用不发送 | 05 | 02,06,07 | preview 与 live 隔离 |
| AC36 仅启用技能可自动选 | 05 | 04,02,07 | grant 过滤/基础回退 |
| AC37 单次手动指定 | 05 | 04,02,06,07 | 临时授权/不改长期配置 |
| AC38 Skill 不越过约见确认 | 02 | 05,04,07 | 策略优先级 |
| AC39 注入不改权限/跨读 | 05 | 03,02,04,07 | 恶意消息/技能夹具 |
| AC40 技能变更使方案失效 | 05 | 02,04,03,07 | 版本依赖与历史追溯 |
| AC41 缺事实/失败回退 | 05 | 04,02,03,07 | 失败分类/基础流程 |
| AC42 历史试用不发送不写事实 | 05 | 02,03,04,07 | trial/live 类型隔离 |

阶段对应：P1–P2 覆盖 AC01–03、15、18、19 的真实确认路径；P3 覆盖 AC04、05、10–20、24；P4 覆盖 AC06–09、16（QQ 回显部分）、21、22、25–42；P5 覆盖 AC23。

## 附录 B：验收记录规则

每条 AC 记录 `not-run/pass/fail/blocked`，环境 `unit/integration/mock-e2e/wechat-real/qq-real`，以及代码 commit、契约版本、数据夹具、步骤、期望与实际、日志 correlationId、截图或回执、已知限制。`pass(mock-e2e)` 不能汇总为平台通过；平台能力不足时记为 blocked 或 fail，不能改期望来通过。证据矩阵见 [acceptance-matrix.csv](reports/acceptance-matrix.csv)。

权限、隔离、重复、旧方案、接管、暂停、未知发送类用例必须全部通过，才可对任何联系人开启自动模式。初次真实运行只选少量联系人、只开确认模式；本人逐个评审后才启用自动。回滚方式：全局暂停 → 停止桥接派发 → 保留入站和审计 → 恢复上一可用版本；数据库回滚不能丢失已提交的发送事实。
