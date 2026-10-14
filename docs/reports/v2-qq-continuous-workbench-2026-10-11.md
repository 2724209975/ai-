# QQ 持续候选、统一工作台、上下文记忆与图片理解验收

2026-10-11，执行本人要求的四项后续工作。复用现有 Bridge、任务状态机、工作台、Owner 登录、媒体获取和长期记忆模块。继续仅处理已选两位 QQ 好友。真实自动发送未授权，发送次数及数据库发送任务均为 0。

## 1. 持续运行与恢复

- 增加持续候选模式，取消原 45 分钟退出；费用和调用次数上限继续生效。原临时模式仍保留时限。
- 接收连接断开后按 1–30 秒范围退避重连，每次重新认证并检查登录账号、所选好友；旧连接迟到事件不进入消息处理。不声称断线期间的消息已完整补齐。
- 复用本机进程监督器，异常退出后恢复同一个试用目录、数据库 schema、联系人和候选。启动时校验并恢复 QQ 的隔离 PostgreSQL，必要时启动既有 NapCat；不启动或替换日常数据库及微信服务。
- 新增 PostgreSQL 会话锁，防止两个候选进程同时调用模型。账本每次预留、结算都落盘同步，重启重放账本，保留费用和次数；缺失、损坏、未结清的账本不会重置额度。未知费用阻止新的模型调用。
- 本人停止会留下停止标记，监督器不会擅自重启。重启不会清除本人全局暂停；持续候选只清除已授权的本人手动回复或未解析媒体暂停，保留停止请求、本人主动暂停等特殊原因。
- 实际异常退出验收通过：进程被替换、QQ 重连，联系人、候选标识和版本、费用、已有登录会话均保留，新增模型调用为 0。
- 演练中修复了联系人身份比较错误地包含数据库附加字段、账本误用独占创建模式两个问题，并补充账本跨重启追加测试。

主要源码：`scripts/qq-candidate-trial.mts`、`qq-trial-control.mts`、`qq-trial-services.mts`、`qq-trial-receiver.mts`、`qq-trial-ledger.mts`。

## 2. 接入统一工作台

- 新工作台：<http://127.0.0.1:55135/#chat>。手机同一局域网入口：<http://192.168.31.17:55135/#chat>，使用已有工作台密码。
- 复用同一 Bridge Service 和数据库，展示聊天、当前候选、任务诊断、实际上下文和联系人记忆；不另造一份手机数据。已退出试用的联系人在列表、详情、任务和记忆接口均不可访问。
- 候选可编辑、切换和复制。复制按钮及快捷键只写剪贴板；不审批、不产生发送任务、不将复制视为已送达或用于长期记忆学习。本人当下活动类候选保留事实核对提示。
- 服务端拒绝直接审批、确认发送、切换自动模式、改变模型额度和扩大试用范围；不是只隐藏按钮。保持现有密码会话、CSRF、Origin 验证。模型配置在本试用中只读。
- 真实接口验收通过：未登录 401；确认/审批发送、自动模式、错误 CSRF、错误 Origin、非所选联系人均拒绝。原候选和上下文、记忆可读。复制按钮浏览器验收通过，发送任务仍为 0。
- 最终页面在 1280、390、320 像素宽度没有横向溢出；修正任务诊断区挤压聊天标题的排版。浏览器尺寸验证不能代替手机实机联网验收。

当前电脑 WLAN 属于 Public 网络，当前进程无管理员权限，未修改防火墙。已提供 `scripts/enable-qq-trial-lan.ps1`，由本人在管理员 PowerShell 运行；规则仅允许当前 WLAN、本机地址、工作台端口、Node 程序和 LocalSubnet，密码登录仍然必需。手机实机访问尚待本人确认，未声称已完成。

## 3. 上下文与长期记忆

- 复用既有 P2/P3 实现，新增三轮连续上下文测试：保留前轮消息、当前触发批次准确、已确认边界进入上下文；另一联系人不读取这些记忆；删除后新上下文不再检索该边界。
- 真实 PostgreSQL/pgvector 离线验收覆盖引用原文、历史导入不触发回复、未核实历史和推断不变成确认事实、冲突替换、关系确认、过期/删除、向量检索、任务失效及晚返回结果隔离。
- 工作台可查看实际选择的上下文和记忆，也可继续使用已实现的记忆确认、修正和删除功能。
- 没有把“刚忙完、在发呆、吃了东西”等模型候选写为本人已确认的当下事实。没有替本人投票，也没有补抓手机或另一台电脑的更多聊天。
- 人类对真实多轮候选的自然度评价沿用此前跳过的状态；程序离线通过不代表人类质量评价完成。

## 4. 图片理解

- 复用 `createQqImagePreparation`、原图读取、私有媒体存储及 `createVisionMediaProvider`，通过 NapCat WebUI 的只读 `get_image` 获取图片，限定原始事件、所选好友和本机缓存根。未启用永久 OneBot 发送接口。
- 检查本机 NapCat 源码：`get_image` 使用原媒体下载，`thumbSize=0`、`downloadType=1`。路径出界、文件格式不符、下载失败或内容不清时沿用转人工处理。
- 图像请求使用 original 细节与明确关闭的 thinking；文字决策、文字生成和图片解释共用同一账本与剩余额度。图像费用预留按官方每图最多 1024 image tokens，加文字字节上界、系统余量和输出上限；不将整个 base64 当文字 token。
- 实际调用已配置的图片模型一次，上传本机合成的 640×480 PNG 验收图；正确识别红色方形、蓝色圆形及 `HELLO 123`，完整图片覆盖且无关键不清。输入 383、输出 43 tokens，按高峰非缓存价格保守计费 0.001110 元。
- 该验收是真实模型调用，样本是合成图片。尚未收到所选好友的新图片来验证完整 QQ 接收 → 原图下载 → 理解 → 候选链路；不会把这项待验证内容描述成真实好友图片已经成功识别。

价格与图像限制来源：[DeepSeek 价格说明](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)、[DeepSeek 图像接口](https://api-docs.deepseek.com/zh-cn/guides/vision/)。取高峰、非缓存上界；实际供应商扣费可能更低。

## 验证与费用

全量门禁 **949 pass / 0 fail / 0 skip**：unit 433、app 33、tools 239、contracts 11、integration 184、e2e 49。网页构建通过，隔离测试数据库已停止；日志 `output/rewrite/verify-qq-continuous-release.log`。最终小幅排版修正后再次构建及验证实际桌面、手机尺寸页面；严格 TypeScript 检查通过。

本轮仅新增 1 次付费图片模型调用。累计模型费用上界 **2.064130 元**；当前试用剩余 **0.417386 元、27 次**。沿用本人此前 10 元总授权及当前小额试用上限，没有重置额度、重新计次或充值。

实际恢复、图片验收、工作台接口验收及凭据仍存于原用户私有试用目录。公共验收摘要只保存去正文、去凭据的证据。截图：`output/rewrite/qq-continuous-workbench-desktop.png`、`qq-continuous-workbench-mobile.png`。

当前可继续接收两位所选好友的新消息、生成及复制候选。尚待现场完成的项目是手机实机联网和真实好友来图的完整链路验证；真实自动发送始终关闭。

## 本机运行操作

在项目目录的 PowerShell 中读取当前试用清单，然后查看、启动、重启或停止。命令不打印密钥或密码：

```powershell
$qqTrialManifest = (Get-Content .local-prerelease/qq-candidate-current.json -Raw | ConvertFrom-Json).manifest
node scripts/qq-trial-control.mts status $qqTrialManifest
# 按需选择其中一个操作
node scripts/qq-trial-control.mts start $qqTrialManifest
node scripts/qq-trial-control.mts restart $qqTrialManifest
node scripts/qq-trial-control.mts stop $qqTrialManifest
```

手机入口连不上时，在管理员 PowerShell 中运行：

```powershell
& 'C:\1\ai代聊\scripts\enable-qq-trial-lan.ps1'
```

本人停止后需要明确启动才会再次接收；本轮没有设置 Windows 开机启动或改变 QQ 日常启动项。
