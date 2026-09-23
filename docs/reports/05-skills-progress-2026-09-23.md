# 05 Skill 第一段交付记录

日期：2026-09-23。基线 PRD v1.3、公共契约 v0.3.0。状态 In progress；D12/D13 均为 Open。本次只落 `packages/skills/{registry,selection,execution,trials}` 和 05 的报告，未修改公共契约、02/03/04/06、全局迁移或 API。

## 变更文件

- `registry/types.mts`：05 本地定义、grant、调用相关命令和错误类型。
- `registry/registry.mts`：受限 JSON 导入预览、草稿校验、不可变版本、按联系人 grant、变更事件和历史查询。导入只解析不保存；保存必须本人命令。
- `registry/builtins.mts`：PRD §16.2 六项内置名称与用途的开发草案，不自动启用。
- `selection/select.mts`：03 裁剪投影复核、grant 自动筛选、本人任务单次指定、基础回退。
- `execution/invoke.mts`：建议输出、版本化调用记录、缺事实/失败回退、供 02 使用的未发计划影响判断。
- `trials/trial.mts`：强制 trial 模式的无副作用建议。
- `registry/registry.test.mts`、`packages/skills/README.md`：测试与边界说明。
- `docs/reports/05-skills-contract-proposal-2026-09-23.md`：给架构总控的公共接口、迁移和回滚提案。

## 验证与 AC 证据

`node --test packages/skills/registry/registry.test.mts`：8 pass / 0 fail；`npm run test:unit`：150 pass / 0 fail；`npm run test:contracts`：4 pass / 0 fail。Node v24.15.0。均是内存单元或静态契约测试，不等于生产持久化、REST 联调或真实平台验收。未运行 TypeScript 静态检查，工作区未安装 `tsc`。

| AC | 模块证据 | 状态 |
| --- | --- | --- |
| AC35 | 恶意导入、缺字段、冲突、跨联系人案例预览失败；保存无 grant | unit 部分通过；06 UI/持久库待接 |
| AC36 | 未 grant 不自动选；联系人隔离；版本范围不含新版则基础回退 | unit 部分通过 |
| AC37 | owner 命令/task/stage/版本限制，单次指定不改 grant | unit 部分通过；06 命令待接 |
| AC39 | contact/OCR/import 无管理命令；跨联系人和 import 投影拒绝；声明式规则无代码/网络 | unit 部分通过；边界鉴权待接 |
| AC40 | 版本/停用/grant 事件，历史调用保留版本；纯函数识别受影响未发 plan | unit 部分通过；02 失效和发送租约待接 |
| AC41 | 缺必要事实转人工，失败留基础回退且无未检查输出 | unit 部分通过；04 实际检查待接 |
| AC42 | trial 强制 owner+trial 模式，不接事实/发送端口，返回空副作用 | unit 部分通过；数据库/API 隔离待接 |
| AC12/32/34/38 | 05 只输出建议，约见确认、分析更新与 plan 失效由 02/04 继续判定 | 协作接口准备，未联测 |

## 限制与待协调

当前仅支持 JSON 结构化导入；D12 的 Markdown 格式、大小限制、正式内置内容待决定。D13 的组合、优先级和预算未定，采用每阶段最多一个、枚举声明式规则的可替换默认值，绝非确认需求。全局案例暂全部拒绝，以免含未标注的联系人私密内容。内存 journal/事件不能保证重启、事务或跨进程幂等；缺 PostgreSQL 写端和生产同步 Skill epoch，不能开启真实自动发送。需要总控按提案统一机器类型、迁移、Owner REST、02/04/06 provider 和 07 的持久化/竞态验收。无平台发送或事实写入测试证据。

## 续作：骨架验证与接口协调

按后续指示，公共迁移和完整 REST 定型暂缓；不可变版本、grant、同步 skill epoch 仅进入接口协调。05 增加了内存 `getDependencyEpoch(contactId)` 和 `isSkillDependencyCurrent`：Skill 版本事件提升全局 epoch，grant 事件提升对应联系人 epoch；待发调用可在事件投递前同步判旧。它不代替生产同事务 epoch/outbox 与 02 发送租约。

新增 `selection/integration.test.mts`，用 03 的 `buildContext/readContextProjection` 真正生成裁剪投影，经 05 选择与调用，再由 04 `adaptDataContextProjection/makeDecision` 检查。A 的调用不含 B 的私密事实，邀约建议仍保留 `CONCRETE_MEETING` 风险；03 事实变化使旧快照返回 `STALE_CONTEXT`。另补代码围栏导入、OCR/转写文本请求启用 Skill 的负测，均无 grant 副作用。

最新验证：`npm run test:unit` **152 pass / 0 fail**，`npm run test:contracts` **4 pass / 0 fail**。此处为离线内存联测与静态契约测试；没有真实模型、生产数据库、Owner REST 或真实平台证据。04 可继续与 03 对齐裁剪上下文和检查端口，无须等待真实模型才推进 G1。D12/D13 仍为待定产品选择。

## 再续作：调用前复核

05 选择结果新增联系人、任务、阶段绑定；`invokeSkill` 在给出建议前重查 epoch、Skill 当前版本、自动选择的 grant 版本，并从 registry 读取规范规则。grant 在选择与调用之间被撤销、单次指定被复用到另一任务或联系人、选择对象内规则被篡改时，不产生 Skill 建议。联系人 grant 的 epoch 增量不影响其他联系人。仅增加 05 本地代码与测试，未变更公共契约、迁移或 REST。

本次完整回归：`npm run test:unit` **158 pass / 0 fail**，`npm run test:contracts` **4 pass / 0 fail**。仍未做生产持久化、真实平台或 TypeScript 静态编译验证。
