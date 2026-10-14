<!-- plan-progress: carried=0 added=7 -->
# 将 PowerShell 7 从 MSIX/商店版迁移为机器级 MSI 安装

## 目标

把用户级、按用户绑定的 MSIX 版 PowerShell 7.6.6 替换为**机器级 MSI 版 7.6.6**，使 `pwsh.exe` 成为沙箱账号（`CodexSandboxOffline` / `CodexSandboxOnline`）也能正常启动的普通可执行文件，从而消除沙箱内每次工具调用都要求提权的问题。

## 已核实的事实（计划依据）

| 事实 | 值 |
|---|---|
| 已装版本 | 7.6.6，MSIX/商店包 `Microsoft.PowerShell_7.6.6.0_x64__8wekyb3d8bbwe` |
| 是否最新 | 是，winget 报告无可用升级；微软文档确认 7.6.6 为当前 LTS/稳定版 |
| `C:\Program Files\PowerShell` | 不存在（无 MSI） |
| `pwsh` 可用原因 | 当前用户专属应用执行别名（`...\WindowsApps\pwsh.exe`，0 字节重解析点） |
| **仅用机器级 PATH 时** | `Get-Command pwsh` → **NOT FOUND**（已实测） |
| 沙箱账号 | `CodexSandboxOffline`、`CodexSandboxOnline`，均已启用 |
| 当前会话权限 | 非提权；但 `a4151` 在 Administrators 组内 → UAC 为**同意提示**，无需管理员凭据 |
| 系统 | Windows 11 专业版 build 22631，x64 |

## 核心设计决策

**顺序反转**：社区常见做法是"先卸载商店版，再装 MSI"。本计划**先装 MSI、验证通过后再卸载 MSIX** —— 因为当前 DSH 会话本身就运行在 MSIX 版 `pwsh.exe` 上，先卸载会中途打断工具调用能力。

**用绝对路径验证**：DSH → Node 进程的环境变量在启动时已捕获，写入注册表的 PATH 更新**不会**反映到已运行进程。因此安装后的验证一律通过 `C:\Program Files\PowerShell\7\pwsh.exe` 绝对路径进行，不依赖 `pwsh` 名称解析。

**不用 `winget install --installer-type wix`**：winget 把 MSI 与 MSIX 视为同一包 ID `Microsoft.PowerShell`，在 MSIX 已注册时可能误判为"已安装"而空转。直接下载官方 MSI + `msiexec` 更可控、可复现。

---

## 实施步骤

### 阶段 0 —— 快照与前置确认（无需提权）
- 记录 MSIX 的 `PackageFullName`：`Microsoft.PowerShell_7.6.6.0_x64__8wekyb3d8bbwe`（供回滚重装用）。
- 备份机器级 PATH 原值（读 `HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment` 的 `Path`，用 `DoNotExpandEnvironmentNames`）；确认其中当前**不含** PowerShell 条目。
- 确认 `C:\Program Files\PowerShell` 仍不存在，避免覆盖既有安装。

### 阶段 1 —— 下载并校验 MSI（无需提权）
- 下载 `https://github.com/PowerShell/PowerShell/releases/download/v7.6.6/PowerShell-7.6.6-win-x64.msi` 到 `$env:TEMP\PowerShell-7.6.6-win-x64.msi`（不写入工作目录 `C:\1\ai代聊`）。
- `Unblock-File` 解除"来自 Internet"标记。
- `Get-AuthenticodeSignature` 必须为 `Valid` 且签署者为 Microsoft Corporation。
- 计算 SHA256，与 GitHub v7.6.6 Release 页公布的官方哈希比对。
- **中止条件**：签名无效或哈希不符 → 停止，不进入阶段 2。（防护中间人/损坏下载）

### 阶段 2 —— 提权静默安装 MSI（触发一次 UAC）
- 通过 `Start-Process msiexec.exe -Verb RunAs -Wait -PassThru` 提权，参数：
  ```
  /package "<msi>" /quiet /norestart
  ADD_PATH=1 USE_MU=1 ENABLE_MU=1 REGISTER_MANIFEST=1
  ```
- `ADD_PATH=1` 把 `C:\Program Files\PowerShell\7\` 加入**机器级** PATH（这是本方案的关键）。
- 退出码处理：`0` 成功；`3010` 成功但建议重启；`1603` 等失败 → 用 `/l*v` 日志定位后回报。
- 用户需在桌面弹出的 UAC 窗口中点"是"。DSH 审批已关闭且本会话无提权，Windows UAC 属用户侧交互，无法由我代点。

### 阶段 3 —— 安装后验证（用绝对路径）
- `& 'C:\Program Files\PowerShell\7\pwsh.exe' -NoProfile -Command '$PSVersionTable.PSVersion'` → 必须为 `7.6.6`。
- 确认该新进程的 `$PSHOME` 为 `C:\Program Files\PowerShell\7`。
- 读 HKLM 注册表确认机器级 PATH 已包含 `C:\Program Files\PowerShell\7\`。
- **决定性回归测试**（复现阶段 0 前的失败场景）：
  ```powershell
  $env:PATH = [Environment]::GetEnvironmentVariable('Path','Machine')
  Get-Command pwsh   # 必须解析到 C:\Program Files\PowerShell\7\pwsh.exe
  ```
  此项通过即代表沙箱账号可见性问题的根因已被消除。

### 阶段 4 —— 移除 MSIX 包
- 首选按用户精确移除（无需提权）：
  `Remove-AppxPackage -Package 'Microsoft.PowerShell_7.6.6.0_x64__8wekyb3d8bbwe'`
- 备选：`winget uninstall --id Microsoft.PowerShell --source winget`
- **若因文件占用失败**（当前 DSH 会话仍持有 MSIX 的 `pwsh.exe`）→ 跳过，留到阶段 5 之后重试。
- 绝不手动删除 `C:\Program Files\WindowsApps\...`（受保护目录，会破坏包注册状态）。

### 阶段 5 —— 重启 DSH 与最终验收
- 重启 DSH，使 Node 进程重新读取更新后的机器级 PATH。
- 新会话中验证：`where.exe pwsh` → `C:\Program Files\PowerShell\7\pwsh.exe`；`$PSHOME` 指向 Program Files；`winget list --id Microsoft.PowerShell` 显示 MSI 版。
- 若阶段 4 曾被延迟，此时重试卸载 MSIX 并确认 `Get-AppxPackage -Name Microsoft.PowerShell` 为空。

---

## 边界情况与失败模式

| 情况 | 处理 |
|---|---|
| UAC 被拒绝/关闭 | 系统零变更，回报并停止；可选择改走 ZIP 方案（但需管理员改机器级 PATH，不省事） |
| 下载被 SmartScreen/杀软拦截 | `Unblock-File`；必要时改用浏览器手动下载后放到同一路径 |
| MSI 返回 1603 | 用 `/l*v $env:TEMP\ps-msi.log` 定位，回报具体原因，不盲目重试 |
| MSI 返回 3010 | 安装已成功；提示重启，功能可用 |
| MSIX 与 MSI 短暂共存 | 无害：机器级 PATH 优先于用户级 PATH，`pwsh` 解析到 MSI |
| MSIX 卸载被占用 | 延后到 DSH 重启后重试（阶段 5） |
| `winget list` 出现重复/陈旧条目 | 视为显示层问题；以文件路径与 `$PSHOME` 为准判定 |
| 安装后 `pwsh` 名称仍指向旧版 | 预期行为（进程环境陈旧），重启 DSH；期间用绝对路径 |

## 回滚方案

1. 卸载 MSI：`msiexec /x` 对应 ProductCode，或"程序和功能"中卸载 PowerShell 7。
2. 恢复商店版：`winget install --id Microsoft.PowerShell --source winget`（7.6.0 起默认即 MSIX），或从 GitHub 下载 `PowerShell-7.6.6.msixbundle` 后 `Add-AppxPackage`。
3. 恢复机器级 PATH：将阶段 0 备份的原值写回 HKLM（若 MSI 未自动清理）。
4. **原始状态基线**：无 MSI、机器级 PATH 不含 PowerShell 条目、MSIX `Microsoft.PowerShell_7.6.6.0_x64__8wekyb3d8bbwe` 存在、无用户 profile（`Documents\PowerShell\profile.ps1` 不存在）、`PSModulePath`(User) 为空。

## 验收标准

- [ ] `C:\Program Files\PowerShell\7\pwsh.exe` 存在，`-NoProfile` 下报告 7.6.6
- [ ] 该二进制的 Authenticode 签名有效且签署者为 Microsoft
- [ ] 机器级 PATH 含 `C:\Program Files\PowerShell\7\`
- [ ] 仅用机器级 PATH 时 `Get-Command pwsh` 成功（根因消除的决定性证据）
- [ ] `Microsoft.PowerShell_7.6.6.0_x64__8wekyb3d8bbwe` 已移除
- [ ] DSH 重启后工具调用正常，`pwsh` 解析到 Program Files
- [ ] 工作目录 `C:\1\ai代聊` 未被改动

## 假设

- 你可在 UAC 弹窗中点击"是"（`a4151` 已在 Administrators 组，属同意型提示）。
- 目标架构为 x64（已核实 `AMD64`），故使用 `win-x64.msi`。
- 需要联网访问 GitHub Releases。
- 愿意接受**在 PowerShell 7.7 之前停留在 7.6.x LTS 分支**：微软文档明确 7.7 起不再提供 MSI 包，winget 仅分发 MSIX。这是本方案的真实长期代价。

## 明确不做

- 不启用 `ENABLE_PSREMOTING`（避免改变系统远程管理配置）
- 不修改执行策略、不安装 PowerShell Preview
- 不调整 Windows Terminal 配置、不注册额外事件日志清单以外的加固项（属"方案 3 完整加固"范围，本次未选）
- 不触碰 `C:\1\ai代聊` 项目文件

## 唯一需要你介入的点

阶段 2 的 UAC 同意弹窗（点一次"是"）。其余步骤可自动完成；阶段 5 需要重启 DSH，重启后我会继续完成最终验收。
