$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}
$LogDir = "C:\1\ai代聊\_cleanup"
if (-not (Test-Path -LiteralPath $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }
$Log = Join-Path $LogDir "admin-run.log"
if (Test-Path -LiteralPath $Log) { Remove-Item -LiteralPath $Log -Force -ErrorAction SilentlyContinue }
function W([string]$m) { $m | Tee-Object -FilePath $Log -Append | Out-Null }
function FreeGB { [math]::Round((Get-PSDrive C).Free / 1GB, 2) }

trap {
    $msg = $_.Exception.Message
    W "!!!!! 未捕获错误: $msg"
    W ($_.ScriptStackTrace)
    "ERR" | Set-Content -LiteralPath (Join-Path $LogDir "admin-error.flag") -Encoding UTF8
    continue
}

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
W "===== 提权清理 开始 $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ====="
W "IsAdmin=$isAdmin  用户=$([Security.Principal.WindowsIdentity]::GetCurrent().Name)"
if (-not $isAdmin) { W "错误: 未获得管理员权限，终止。"; exit 1 }
$startAll = FreeGB
W "起始可用空间=$startAll GB"

# ---------- 第1组: Windows 升级残留 ----------
$targets = @("C:\`$WINDOWS.~BT", "C:\`$Windows.~WS", "C:\`$SysReset", "C:\ESD", "C:\XboxGames")
foreach ($t in $targets) {
    if (-not (Test-Path -LiteralPath $t)) { W "[跳过] 不存在: $t"; continue }
    $fb = FreeGB
    $logical = (Get-ChildItem -LiteralPath $t -Recurse -Force -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum)
    W "----- 删除 $t (逻辑大小 {0:N2} GB / {1} 文件) -----" -f (($logical.Sum) / 1GB), $logical.Count

    $ev = $null
    & takeown.exe /F $t /R /A /D Y 2>&1 | Select-Object -Last 2 | ForEach-Object { W "  takeown: $_" }
    & icacls.exe $t /grant "*S-1-5-32-544:(F)" /T /C /Q 2>&1 | Select-Object -Last 2 | ForEach-Object { W "  icacls: $_" }
    Remove-Item -LiteralPath $t -Recurse -Force -ErrorAction SilentlyContinue -ErrorVariable ev
    if (Test-Path -LiteralPath $t) {
        W "  PowerShell 删除后仍存在(错误 $($ev.Count) 个)，改用 cmd rmdir"
        & cmd.exe /c "rmdir /S /Q `"$t`"" 2>&1 | Select-Object -Last 2 | ForEach-Object { W "  rmdir: $_" }
    }
    if (Test-Path -LiteralPath $t) {
        $left = (Get-ChildItem -LiteralPath $t -Recurse -Force -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum)
        W "  [未完成] 仍存在: {0:N2} GB / {1} 文件" -f (($left.Sum) / 1GB), $left.Count
    } else {
        W "  [完成] 已删除"
    }
    W "  本项实测释放={0:N2} GB  当前可用={1} GB" -f ((FreeGB) - $fb), (FreeGB)
}

# ---------- 第2组: Windows 更新缓存 ----------
W "----- Windows 更新缓存 -----"
$fb = FreeGB
$svc = @('wuauserv', 'bits')
$stopped = @()
foreach ($s in $svc) {
    try { Stop-Service -Name $s -Force -ErrorAction Stop; $stopped += $s; W "  已停止服务: $s" }
    catch { W "  无法停止服务 $s : $($_.Exception.Message)" }
}
if ($stopped.Count -eq 0) {
    W "  [跳过] 更新服务无法停止，不清空 SoftwareDistribution（避免损坏更新组件）"
} else {
    $dl = "C:\Windows\SoftwareDistribution\Download"
    if (Test-Path -LiteralPath $dl) {
        $before = (Get-ChildItem -LiteralPath $dl -Recurse -Force -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum)
        $ev = $null
        Remove-Item -LiteralPath "$dl\*" -Recurse -Force -ErrorAction SilentlyContinue -ErrorVariable ev
        $after = (Get-ChildItem -LiteralPath $dl -Recurse -Force -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum)
        W "  清空前 {0:N2} GB / {1} 文件 -> 剩余 {2:N2} GB / {3} 文件  错误 {4} 个" -f `
          (($before.Sum) / 1GB), $before.Count, (($after.Sum) / 1GB), $after.Count, $ev.Count
    } else { W "  [跳过] 目录不存在: $dl" }
}
foreach ($s in $stopped) {
    try { Start-Service -Name $s -ErrorAction Stop; W "  已重启服务: $s" }
    catch { W "  警告: 服务 $s 启动失败: $($_.Exception.Message)" }
}
W "  本项实测释放={0:N2} GB" -f ((FreeGB) - $fb)

W "===== 提权清理 结束 $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ====="
W "结束可用空间=$((FreeGB)) GB   本次提权共释放=$((FreeGB) - $startAll) GB"
W "LOG=$Log"
