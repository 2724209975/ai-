param(
    [string]$SdkPath = "$env:LOCALAPPDATA\Android\Sdk",
    [string]$JavaPath = 'C:\Program Files\Android\Android Studio\jbr',
    [switch]$DeviceTests
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$androidSource = Join-Path $projectRoot 'apps\android'
# AGP/JVM test workers on Windows can mis-handle non-ASCII project classpaths.
# Build an independent copy with an ASCII path; never reset or clean the shared checkout.
$androidBuildRoot = Join-Path $env:USERPROFILE '.codex\cache\reply-assistant-build'
if ($androidBuildRoot -match '[^\x00-\x7F]') { throw 'USERPROFILE contains non-ASCII characters; set an ASCII build path in this script.' }
if (!(Test-Path -LiteralPath (Join-Path $JavaPath 'bin\java.exe'))) { throw 'Java runtime not found; pass -JavaPath.' }
if (!(Test-Path -LiteralPath (Join-Path $SdkPath 'platforms\android-36.1\android.jar'))) { throw 'Install Android SDK platform 36.1 first, or pass -SdkPath.' }
New-Item -ItemType Directory -Force -Path $androidBuildRoot | Out-Null
& robocopy $androidSource $androidBuildRoot /E /XD .gradle .kotlin build /XF *.log local.properties /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw 'Unable to copy Android sources to the build directory.' }
$env:JAVA_HOME = $JavaPath
$env:ANDROID_HOME = $SdkPath
$tasks = @(':app:assembleDebug', ':app:testDebugUnitTest', ':app:lintDebug', ':app:assembleDebugAndroidTest')
if ($DeviceTests) { $tasks += ':fixture:assembleDebug' }
Push-Location $androidBuildRoot
try {
    & '.\gradlew.bat' @tasks '--console=plain'
    if ($LASTEXITCODE -ne 0) { throw 'Android build or verification failed; see Gradle diagnostics.' }
    if ($DeviceTests) {
        $androidAdb = Join-Path $SdkPath 'platform-tools\adb.exe'
        $androidDeviceArgs = @()
        if ($env:ANDROID_SERIAL) { $androidDeviceArgs = @('-s', $env:ANDROID_SERIAL) }
        & $androidAdb @androidDeviceArgs install -r (Join-Path $androidBuildRoot 'fixture\build\outputs\apk\debug\fixture-debug.apk')
        if ($LASTEXITCODE -ne 0) { throw 'Unable to install the offline synthetic-chat fixture on the selected test device.' }
        & '.\gradlew.bat' ':app:connectedDebugAndroidTest' '--console=plain'
        if ($LASTEXITCODE -ne 0) { throw 'Android device verification failed.' }
    }
} finally { Pop-Location }
$androidOutput = Join-Path $projectRoot 'output\android'
New-Item -ItemType Directory -Force -Path $androidOutput | Out-Null
$androidVersion = [regex]::Match((Get-Content -LiteralPath (Join-Path $androidSource 'app\build.gradle.kts') -Raw), 'versionName = "([^"]+)"').Groups[1].Value
Copy-Item -LiteralPath (Join-Path $androidBuildRoot 'app\build\outputs\apk\debug\app-debug.apk') -Destination (Join-Path $androidOutput "reply-assistant-$androidVersion-debug.apk") -Force
Copy-Item -LiteralPath (Join-Path $androidBuildRoot 'app\build\reports\lint-results-debug.html') -Destination (Join-Path $androidOutput 'lint-results-debug.html') -Force
Write-Output "APK: $androidOutput\reply-assistant-$androidVersion-debug.apk"
Write-Output "Tests: $androidBuildRoot\app\build\reports\tests\testDebugUnitTest\index.html"
