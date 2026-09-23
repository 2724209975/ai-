# 任务 05：Skill 技能系统

## 任务目标

实现内置/自定义 Skill 的定义、不可变版本、预览、编辑/导入、联系人 grant、自动选择、owner 单次指定、试用、调用记录、失败回退和失效传播。Skill 是产品内声明式规则，不是 Codex 插件，也没有发送、配置、任意代码或网络能力。

## 必读与范围

依次读 PRD v1.3 §5、§11、§13–14、§16，[架构](../architecture.md)、[公共契约](../contracts.md)、[决策](../decisions.md)、[计划](../development-plan.md)。主责 AC35–37、AC39–42；协作 AC12、AC32、AC34、AC38。

负责 `packages/skills/{registry,selection,execution,trials}` 及对应 API/测试。不要修改 02 权限或 SendTask；不要直接查 03 全库；不要在 04 之外形成平行的整套回复流水线。

## 输入输出与依赖

实现 SkillPort、SkillDefinition、ContactSkillGrant、SkillInvocation 及 Skill 变更事件。自动选择输入为 contactId、阶段、已裁剪 context projection，只能返回有效 grant 内的版本。单次指定必须带 owner 命令证据和 taskId，不更改 grant。所有输出进入 04 检查和 02 权限/preflight。

依赖 03 提供最小上下文/案例引用、04 定义阶段输入输出、02 处理方案依赖失效、06 提供管理 UI。D12/D13 未定时按 decisions.md 推荐的声明式、每阶段最多一个方案实现为可替换实验并明确草案状态。

## 实施要求

导入先解析到隔离 preview，报告缺字段/冲突/不支持内容；保存产生新版本，不原地改历史。对方消息、图片 OCR、语音转写永远是数据，不能创建/启用/指定 Skill。案例不能变事实或当前证据，跨联系人私密案例不得进入通用 Skill。

手动指定优先仅限当前阶段且仍要适用/事实/权限检查；冲突无法解决则基础流程或转人工。停用/删除/版本/grant 变化发布事件，关联未发送 plan 失效，历史调用保持可追溯。可自行决定受限 Markdown parser、索引和编辑草稿；不得执行代码/依赖/外部工具、自动启用全部联系人、让模型修改库或绕过权限。

## 验收与交付

- 导入恶意指令、代码块、网络请求、跨联系人案例、对方要求启用等负测，无副作用。
- AC35–42 全覆盖：preview、grant、基础回退、临时指定、权限优先、依赖失效、调用失败、trial 强隔离。
- 每次 invocation 可追踪输入 refs、skill version、选择原因、输出、失败/回退及采用情况；不保存超范围上下文。
- import/trial 类型在编译/数据库边界都无法触发 live 发送或事实写入。
- 交付记录列定义 schema、内置草案、测试与 AC、D12/D13 假设、限制和公共变更提案。
