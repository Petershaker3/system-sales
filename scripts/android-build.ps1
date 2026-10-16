<#
.SYNOPSIS
    Reproducible Android build environment for Mobile Shop System.

.DESCRIPTION
    The project, not the machine, defines its build environment. Every variable
    this script sets is PROCESS-LOCAL: it applies to this run and its children,
    then dies with the process. Nothing is written to the machine via `setx`,
    the registry, or a user/system environment variable.

    This matters because the Android toolchain here is shared with unrelated
    work on the same machine. A global `setx CARGO_TARGET_DIR` would silently
    redirect every future Rust build on this box, and a global TEMP override
    would affect unrelated tooling.

    WHY THESE PATHS (Gate C audit, ADR-008):
        D: carries the Android SDK/NDK and had 0.46 GB free. A first Android
        build needs roughly 5.1 GB of cargo artifacts plus ~1 GB of Gradle
        output. Left on their inherited locations, both land on a drive that
        cannot hold them and the build dies on a full disk rather than on a
        code error.
        E: holds 72.93 GB free and is otherwise unused by this toolchain.

    DISK OWNERSHIP AFTER THIS SCRIPT RUNS:
        D:\Android\Sdk ............ read-mostly; SDK, NDK, licenses (already paid for)
        E:\Rust\targets ........... cargo build artifacts (was: C:\...\src-tauri\target)
        E:\Gradle ................. Gradle cache + wrapper dists
        E:\Rust\temp .............. TEMP/TMP for Gradle and the NDK
        C: ........................ dist/, node_modules/, gen/android (Gradle output)

.PARAMETER Verify
    Provision and validate the environment, print every resolved path, then
    exit WITHOUT building. Use this to prove the script works before spending
    minutes on a real build.

.PARAMETER Apk
    Emit an APK. Without it, `tauri android build` produces the Gradle project
    but no package.

.PARAMETER Target
    Android target triple. Defaults to aarch64, the only ABI that matters for
    the SM-N976N (a physical 64-bit ARM phone). armv7 would only add an install
    target for devices we do not have.

.PARAMETER Device
    Install onto a connected device after building. Fails clearly if no device
    is attached rather than pretending.

.EXAMPLE
    .\scripts\android-build.ps1 -Verify
.EXAMPLE
    .\scripts\android-build.ps1 -Apk
.EXAMPLE
    .\scripts\android-build.ps1 -Apk -Device
#>
[CmdletBinding()]
param(
    [switch] $Verify,
    [switch] $Apk,
    [switch] $Device,
    [string] $Target = 'aarch64'
)

# Stop on first error. A partially-provisioned environment that silently
# continues would rebuild into the wrong drive, which is the exact failure this
# script exists to prevent.
$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot
$ApiLevel = 24

function Write-Step { param([string] $Text) Write-Host "`n=== $Text ===" -ForegroundColor Cyan }
function Write-Ok   { param([string] $Text) Write-Host "  [ok]   $Text" -ForegroundColor Green }
function Write-Warn { param([string] $Text) Write-Host "  [warn] $Text" -ForegroundColor Yellow }
function Write-Fail { param([string] $Text) Write-Host "  [FAIL] $Text" -ForegroundColor Red }

function Get-FreeGB {
    param([string] $Path)
    $root = [System.IO.Path]::GetPathRoot((Resolve-Path -LiteralPath $Path -ErrorAction SilentlyContinue).Path)
    if (-not $root) { $root = [System.IO.Path]::GetPathRoot($Path) }
    $drive = Get-PSDrive -Name $root.TrimEnd('\', ':') -ErrorAction SilentlyContinue
    if ($drive) { return [math]::Round($drive.Free / 1GB, 2) }
    return -1
}

# ---------------------------------------------------------------------------
# 1. Redirect the heavy build workspace onto E:
# ---------------------------------------------------------------------------
Write-Step 'Build workspace'

$TargetDir      = 'E:\Rust\targets'
$GradleHome     = 'E:\Gradle'
$TempDir        = 'E:\Rust\temp'
$NpmCache       = 'E:\Rust\npm-cache'

foreach ($dir in @($TargetDir, $GradleHome, $TempDir, $NpmCache)) {
    if (-not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Force -Path $dir | Out-Null
        Write-Ok "created $dir"
    }
}

# Process scope only. No -Scope User, no setx.
$env:CARGO_TARGET_DIR = $TargetDir
$env:GRADLE_USER_HOME = $GradleHome
$env:TEMP = $TempDir
$env:TMP  = $TempDir

# npm's cache is a fourth heavy write path and the audit missed it: on this
# machine it sits on D:, which is exactly the drive being kept free. Gradle's
# Tauri plugin invokes npm during the Android build, so this matters for the
# build and not just for npm usage.
$env:npm_config_cache = $NpmCache

Write-Ok "CARGO_TARGET_DIR = $env:CARGO_TARGET_DIR  ($([math]::Round((Get-ChildItem -LiteralPath $TargetDir -Recurse -File -Force -EA SilentlyContinue | Measure-Object -Sum Length).Sum/1GB,2)) GB, $((Get-FreeGB $TargetDir)) GB free)"
Write-Ok "GRADLE_USER_HOME = $env:GRADLE_USER_HOME"
Write-Ok "TEMP / TMP       = $env:TEMP"
Write-Ok "npm_config_cache = $env:npm_config_cache"
Write-Ok "RUSTUP_HOME      = $env:RUSTUP_HOME"
Write-Ok "CARGO_HOME       = $env:CARGO_HOME"

# ---------------------------------------------------------------------------
# 2. Toolchain locations
# ---------------------------------------------------------------------------
Write-Step 'Android toolchain'

$SdkRoot    = 'D:\Android\Sdk'
$NdkRoot    = Join-Path $SdkRoot 'ndk\28.2.13676358'
$JavaHome   = 'D:\Dev\Java\jdk-17'

$env:ANDROID_HOME     = $SdkRoot
$env:ANDROID_SDK_ROOT = $SdkRoot
$env:ANDROID_NDK_HOME = $NdkRoot
$env:NDK_HOME         = $NdkRoot
$env:JAVA_HOME        = $JavaHome

foreach ($item in @(
    @{ n = 'ANDROID_HOME / SDK'; p = $SdkRoot },
    @{ n = 'ANDROID_NDK_HOME';   p = $NdkRoot },
    @{ n = 'JAVA_HOME';          p = $JavaHome }
)) {
    if (Test-Path -LiteralPath $item.p) { Write-Ok "$($item.n) = $($item.p)" }
    else { Write-Fail "$($item.n) not found at $($item.p)"; exit 1 }
}

# minSdk is asserted after initialization, because until `tauri android init`
# runs there is no generated Gradle project to read the value from.

# ---------------------------------------------------------------------------
# 3. MSVC environment (process-local)
# ---------------------------------------------------------------------------
Write-Step 'MSVC environment'

# Cargo compiles build scripts for the HOST, so an Android build still needs
# link.exe on x86_64-pc-windows-msvc. Without this the build dies on
# "linker `link.exe` not found" before Kotlin is ever reached.
$vcvars = $null
foreach ($candidate in @(
    'C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\VC\Auxiliary\Build\vcvars64.bat',
    'C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat',
    'C:\Program Files\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat'
)) {
    if (Test-Path -LiteralPath $candidate) { $vcvars = $candidate; break }
}

if (-not $vcvars) { Write-Fail 'vcvars64.bat not found; Visual Studio Build Tools required'; exit 1 }

# Capture the environment vcvars produces and replay it into this process.
# `cmd /c "... && set"` is the only reliable way: a .bat cannot export env to
# its parent, so the variables must be read back as text.
$vcEnv = & cmd.exe /c "`"$vcvars`" >nul 2>&1 && set"
if ($LASTEXITCODE -ne 0) { Write-Fail 'vcvars64.bat failed'; exit 1 }
foreach ($line in $vcEnv) {
    if ($line -match '^([^=]+)=(.*)$') {
        [Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process')
    }
}
Write-Ok "vcvars64 loaded ($([System.IO.Path]::GetFileName((Split-Path -Parent $vcvars))))"

if (Get-Command link.exe -ErrorAction SilentlyContinue) { Write-Ok 'link.exe on PATH' }
else { Write-Fail 'link.exe still missing after vcvars'; exit 1 }

# ---------------------------------------------------------------------------
# 4. Rust target
# ---------------------------------------------------------------------------
Write-Step 'Rust toolchain'

if (-not (Get-Command cargo.exe -ErrorAction SilentlyContinue)) { Write-Fail 'cargo not on PATH'; exit 1 }
Write-Ok "cargo $(cargo --version)"
Write-Ok "rustc $(rustc --version)"

$triple = if ($Target -eq 'aarch64') { 'aarch64-linux-android' } else { "$Target-linux-androideabi" }
$installed = rustup target list --installed
if ($installed -contains $triple) { Write-Ok "target $triple installed" }
else { Write-Fail "target $triple NOT installed"; exit 1 }

# The NDK provides the linker cargo invokes for this triple.
$ndkLinker = Join-Path $NdkRoot "toolchains\llvm\prebuilt\windows-x86_64\bin\$triple$ApiLevel-clang.cmd"
if (Test-Path -LiteralPath $ndkLinker) { Write-Ok "NDK linker present ($([System.IO.Path]::GetFileName($ndkLinker)))" }
else { Write-Fail "NDK linker missing: $ndkLinker"; exit 1 }

# ---------------------------------------------------------------------------
# 5. Disk report
# ---------------------------------------------------------------------------
Write-Step 'Disk before build'
Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Used -ne $null } | ForEach-Object {
    $role = switch ($_.Name) {
        'C' { 'dist, node_modules, gen/android' }
        'D' { 'Android SDK + NDK (read-mostly)' }
        'E' { 'cargo artifacts, Gradle cache, TEMP' }
        default { '' }
    }
    Write-Host ("  {0}: {1,7:N2} GB free / {2,6:N1} GB total   {3}" -f $_.Name, ($_.Free/1GB), (($_.Used+$_.Free)/1GB), $role)
}

# Guard the one constraint that cannot recover once it is hit.
$eFree = Get-FreeGB 'E:\'
if ($eFree -lt 12) {
    Write-Fail "E: has only $eFree GB free; a first Android build needs roughly 6 GB of headroom"
    exit 1
}
Write-Ok "E: headroom $eFree GB (need ~6 GB)"

# ---------------------------------------------------------------------------
# 6. Build
# ---------------------------------------------------------------------------
if ($Verify) {
    Write-Step 'VERIFY ONLY'
    Write-Host '  Environment provisioned successfully. No build was started.' -ForegroundColor Green
    Write-Host '  Machine environment untouched (all changes were process-local).' -ForegroundColor Green
    exit 0
}

Write-Step "Building Android debug APK ($Target)"

$GenAndroid = Join-Path $RepoRoot 'src-tauri\gen\android'

# `tauri android build` refuses to run without a generated Gradle project. A
# reproducible script brings the repo to a buildable state instead of failing
# and asking the operator to remember a step.
if (-not (Test-Path -LiteralPath $GenAndroid)) {
    Write-Warn 'gen/android missing; running "tauri android init"'
    Push-Location $RepoRoot
    try {
        & npx tauri android init --ci
        $initCode = $LASTEXITCODE
    } finally {
        Pop-Location
    }
    if ($initCode -ne 0 -or -not (Test-Path -LiteralPath $GenAndroid)) {
        Write-Fail 'tauri android init failed'
        exit 1
    }
    Write-Ok 'gen/android generated'
}

# minSdk is asserted, not assumed. The generated Gradle project must agree with
# the API 24 decision (Gate C D-2); a silent downgrade would target Android 5
# devices that were never tested.
$minSdkPath = Join-Path $GenAndroid 'app\build.gradle.kts'
$declared = (Select-String -LiteralPath $minSdkPath -Pattern 'minSdk\s*=\s*(\d+)' -EA SilentlyContinue |
             Select-Object -First 1).Matches.Groups[1].Value
if ($declared -eq "$ApiLevel") { Write-Ok "gen/android minSdk = $declared (matches Gate C D-2)" }
else { Write-Fail "gen/android minSdk is '$declared', expected $ApiLevel"; exit 1 }

# Kotlin's incremental compiler keeps persistent caches that compare source
# paths as relative offsets. Tauri's Kotlin sources are compiled from the Cargo
# registry on E: while this Gradle project lives on C:, so the comparison
# crosses drive roots and dies:
#
#   Could not close incremental caches ... java.lang.IllegalArgumentException:
#   this and base files have different roots: E:\Rust\cargo\registry\...\AppPlugin.kt
#   and C:\...\src-tauri\gen\android
#
# Those caches exist only to speed up repeat builds, so disabling them costs a
# little build time and removes a failure mode no cache setting can avoid while
# the registry and the project live on different drives.
$gradleProps = Join-Path $GenAndroid 'gradle.properties'
if (-not (Select-String -LiteralPath $gradleProps -Pattern '^\s*kotlin\.incremental' -EA SilentlyContinue)) {
    Add-Content -LiteralPath $gradleProps -Value "`r`n# Added by scripts/android-build.ps1: the cargo registry (E:) and this`r`n# project (C:) are on different drives, which breaks Kotlin's`r`n# relative-path incremental caches.`r`nkotlin.incremental=false`r`n"
    Write-Ok 'gradle.properties: kotlin.incremental=false (cross-drive cache guard)'
} else {
    Write-Ok 'gradle.properties: kotlin.incremental already configured'
}

# Gradle's Tauri plugin spawns the literal command "npm.bat". Node 24 ships only
# npm / npm.cmd / npm.ps1, so on a stock Node 24 machine the frontend build dies
# with "A problem occurred starting process 'command 'npm.bat''".
# The shim is prepended to PATH for this process only; Node's own directory is
# never modified.
$npmShimDir = Join-Path $RepoRoot 'tools'
if (Test-Path -LiteralPath (Join-Path $npmShimDir 'npm.bat')) {
    $env:PATH = "$npmShimDir;$env:PATH"
    Write-Ok "npm.bat shim on PATH ($npmShimDir)"
} else {
    Write-Fail "npm.bat shim missing at $npmShimDir"
    exit 1
}

if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot 'dist\index.html'))) {
    Write-Warn 'dist\index.html missing; running npm run build first'
    Push-Location $RepoRoot
    try { npm run build } finally { Pop-Location }
    if ($LASTEXITCODE -ne 0) { Write-Fail 'npm run build failed'; exit 1 }
}

$buildArgs = @('tauri', 'android', 'build', '--debug', '--target', $Target)
if ($Apk) { $buildArgs += '--apk' }

Push-Location $RepoRoot
try {
    & npx @buildArgs
    $code = $LASTEXITCODE
} finally {
    Pop-Location
}

if ($code -ne 0) { Write-Fail "build failed (exit $code)"; exit $code }

# ---------------------------------------------------------------------------
# 7. Artifact + optional install
# ---------------------------------------------------------------------------
Write-Step 'Artifact'
$apks = Get-ChildItem (Join-Path $RepoRoot 'src-tauri\gen\android\app\build\outputs\apk') -Recurse -Filter '*.apk' -EA SilentlyContinue
if ($apks) {
    $apks | ForEach-Object { Write-Host ("  {0,9:N2} MB  {1}" -f ($_.Length/1MB), $_.FullName.Replace("$RepoRoot\", '')) -ForegroundColor Green }
} else {
    Write-Warn 'no APK found (re-run with -Apk)'
}

if (-not $Device) { exit 0 }

Write-Step 'Install'
$adb = Join-Path $SdkRoot 'platform-tools\adb.exe'
& $adb start-server | Out-Null
$devices = @(& $adb devices | Select-String 'device$')
if ($devices.Count -eq 0) {
    Write-Fail 'no device attached. Connect the SM-N976N, enable USB debugging, accept the RSA prompt.'
    exit 1
}
foreach ($d in $devices) { Write-Ok "device $($d.Line.Trim())" }
if ($apks) {
    & $adb install -r $apks[0].FullName
    if ($LASTEXITCODE -eq 0) { Write-Ok 'installed' } else { Write-Fail 'install failed'; exit 1 }
}