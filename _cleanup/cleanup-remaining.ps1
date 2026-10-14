# Remaining C: drive cleanup - MUST run elevated.
# ASCII only on purpose: PowerShell 5.1 mis-decodes non-BOM UTF-8 Chinese text.
$ErrorActionPreference = 'Continue'
$LogDir = "C:\1\ai_cleanup_out"
if (-not (Test-Path -LiteralPath $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }
$Log = Join-Path $LogDir "remaining-run.log"
if (Test-Path -LiteralPath $Log) { Remove-Item -LiteralPath $Log -Force -ErrorAction SilentlyContinue }

function W([string]$m) { $m | Out-File -FilePath $Log -Append -Encoding UTF8; Write-Host $m }
function FreeGB { [math]::Round((Get-PSDrive C).Free / 1GB, 2) }
function Stat([string]$p) {
    $s = Get-ChildItem -LiteralPath $p -Recurse -Force -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum
    return @{ GB = [math]::Round($s.Sum / 1GB, 2); N = $s.Count }
}

$me = [Security.Principal.WindowsIdentity]::GetCurrent()
$isAdmin = (New-Object Security.Principal.WindowsPrincipal($me)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
W "=================================================================="
W ("REMAINING CLEANUP START  " + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
if (-not $isAdmin) {
    W "ERROR: NOT ELEVATED - nothing was deleted."
    W "Use the .bat launcher, or run this script in an elevated PowerShell window."
    Write-Host ""
    Write-Host "NOT ELEVATED - nothing was deleted. Press Enter to exit." -ForegroundColor Yellow
    Read-Host "Press Enter to close"
    exit 1
}
W ("Elevated OK.  User = " + $me.Name)
$start = FreeGB
W ("Free space at start = " + $start + " GB")

# ---------------- 1) Windows upgrade leftovers ----------------
$D = [char]36
$targets = @( ("C:\" + $D + "WINDOWS.~BT"), ("C:\" + $D + "Windows.~WS"), ("C:\" + $D + "SysReset"), "C:\ESD", "C:\XboxGames" )
foreach ($t in $targets) {
    if (-not (Test-Path -LiteralPath $t)) { W ("[SKIP] not found: " + $t); continue }
    $fb = FreeGB
    $b = Stat $t
    W ("----- DELETE " + $t + "   (logical " + $b.GB + " GB / " + $b.N + " files) -----")
    if ($b.N -eq 0) {
        try { Remove-Item -LiteralPath $t -Recurse -Force -ErrorAction Stop; W "  removed (was empty)" } catch { W ("  failed: " + $_.Exception.Message) }
    } else {
        W "  step 1/3: takeown (slow on 200k+ files, please wait)..."
        & takeown.exe /F $t /R /A /D Y 2>&1 | Select-Object -Last 1 | ForEach-Object { W ("    takeown: " + $_) }
        W "  step 2/3: icacls..."
        & icacls.exe $t /grant "*S-1-5-32-544:(F)" /T /C /Q 2>&1 | Select-Object -Last 1 | ForEach-Object { W ("    icacls: " + $_) }
        W "  step 3/3: deleting..."
        & cmd.exe /c "rmdir /S /Q `"$t`"" 2>&1 | Select-Object -Last 1 | ForEach-Object { W ("    rmdir: " + $_) }
        if (Test-Path -LiteralPath $t) { Remove-Item -LiteralPath $t -Recurse -Force -ErrorAction SilentlyContinue }
    }
    if (Test-Path -LiteralPath $t) {
        $a = Stat $t
        W ("  [INCOMPLETE] still there: " + $a.GB + " GB / " + $a.N + " files")
    } else { W "  [DONE] fully removed" }
    W ("  measured freed = " + ([math]::Round((FreeGB) - $fb, 2)) + " GB   free now = " + (FreeGB) + " GB")
}

# ---------------- 2) Windows Update download cache ----------------
W "----- Windows Update download cache -----"
$fb = FreeGB
$svc = @('wuauserv', 'bits', 'dosvc')
$stopped = @()
foreach ($s in $svc) {
    try { Stop-Service -Name $s -Force -ErrorAction Stop; $stopped += $s; W ("  stopped: " + $s) }
    catch { W ("  could not stop " + $s + " : " + $_.Exception.Message) }
}
Start-Sleep -Seconds 3
$dl = "C:\Windows\SoftwareDistribution\Download"
if ($stopped.Count -eq 0) {
    W "  [SKIP] no update service stopped"
} elseif (-not (Test-Path -LiteralPath $dl)) {
    W ("  [SKIP] not found: " + $dl)
} else {
    $before = Stat $dl
    W ("  before = " + $before.GB + " GB / " + $before.N + " files")
    $errs = 0
    foreach ($k in (Get-ChildItem -LiteralPath $dl -Force -ErrorAction SilentlyContinue)) {
        try { Remove-Item -LiteralPath $k.FullName -Recurse -Force -ErrorAction Stop }
        catch { $errs++ ; if ($errs -le 3) { W ("    err: " + $k.Name + " :: " + $_.Exception.Message) } }
    }
    $mid = Stat $dl
    W ("  after direct delete = " + $mid.GB + " GB / " + $mid.N + " files ; errors " + $errs)
    if ($mid.N -gt 0) {
        W "  fallback: rmdir the Download folder itself..."
        & cmd.exe /c "rmdir /S /Q `"$dl`"" 2>&1 | Select-Object -Last 1 | ForEach-Object { W ("    rmdir: " + $_) }
        if (-not (Test-Path -LiteralPath $dl)) { New-Item -ItemType Directory -Path $dl -Force | Out-Null; W "  recreated empty Download folder" }
    }
    $after = Stat $dl
    W ("  final = " + $after.GB + " GB / " + $after.N + " files")
}
foreach ($s in $stopped) {
    try { Start-Service -Name $s -ErrorAction Stop; W ("  restarted: " + $s) }
    catch { W ("  WARNING: could not start " + $s + " : " + $_.Exception.Message) }
}
W ("  measured freed = " + ([math]::Round((FreeGB) - $fb, 2)) + " GB")

W "=================================================================="
W ("REMAINING CLEANUP END  " + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
W ("Free space now = " + (FreeGB) + " GB   this run freed = " + ([math]::Round((FreeGB) - $start, 2)) + " GB")
W ("Log file: " + $Log)
Read-Host "Finished. Press Enter to close"
