#Requires -Version 5.1
<#
.SYNOPSIS
    donger 一键构建并启动脚本（放在项目根目录执行）
.DESCRIPTION
    全自动流程：读取 .env 端口配置 → 停掉占用服务端口的旧实例 → 就地构建前端+后端 →
    后台启动服务 → 健康检查并输出访问地址与日志位置。
    与 scripts/deploy.ps1 的区别：本脚本在当前项目目录就地构建运行，不做 .deploy 副本。
.PARAMETER NoBuild
    跳过构建，仅停止旧实例并启动（快速重启用）
.EXAMPLE
    .\runner.ps1
.EXAMPLE
    .\runner.ps1 -NoBuild
#>
[CmdletBinding()]
param(
    [switch]$NoBuild
)

Set-StrictMode -Version Latest

function Invoke-Npm {
    param([string]$Dir, [string[]]$NpmArgs)
    Push-Location -LiteralPath $Dir
    try {
        & npm @NpmArgs
        if ($LASTEXITCODE -ne 0) {
            Write-Host "❌ 错误：npm $($NpmArgs -join ' ') 失败（退出码 $LASTEXITCODE）" -ForegroundColor Red
            exit $LASTEXITCODE
        }
    }
    finally { Pop-Location }
}

$ProjectDir = $PSScriptRoot

# 1. 读取 .env 的端口配置
$cfgPort = 3330
$cfgHost = "0.0.0.0"
$envFile = Join-Path $ProjectDir ".env"
if (Test-Path -LiteralPath $envFile) {
    foreach ($line in Get-Content -LiteralPath $envFile) {
        if ($line -match '^\s*PORT\s*=\s*"?(\d+)"?\s*$') { $cfgPort = $Matches[1] }
        elseif ($line -match '^\s*HOST\s*=\s*"?([^"#]+)"?\s*$') { $cfgHost = $Matches[1].Trim() }
    }
}

Write-Host "=== donger runner ==="
Write-Host "项目目录: $ProjectDir"
Write-Host "服务端口: $cfgPort（来自 .env）"

# 2. 停掉占用服务端口的旧实例
$conns = Get-NetTCPConnection -LocalPort $cfgPort -State Listen -ErrorAction SilentlyContinue
if ($conns) {
    foreach ($procId in ($conns | Select-Object -ExpandProperty OwningProcess -Unique)) {
        $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
        if ($p) {
            Write-Host ">>> 停止旧实例：$($p.ProcessName)（PID $procId）"
            Stop-Process -Id $procId -Force -ErrorAction Stop
        }
    }
    Start-Sleep -Seconds 1
}

# 3. 构建（原生模块预编译走 npmmirror 镜像，避免 GitHub 直连超时）
$env:npm_config_better_sqlite3_binary_host_mirror = "https://registry.npmmirror.com/-/binary/better-sqlite3"
if (-not $NoBuild) {
    if (-not (Test-Path -LiteralPath (Join-Path $ProjectDir "node_modules"))) {
        Write-Host ">>> 安装后端依赖..."
        Invoke-Npm $ProjectDir @("install", "--no-audit", "--no-fund")
    }
    if (-not (Test-Path -LiteralPath (Join-Path $ProjectDir "web\node_modules"))) {
        Write-Host ">>> 安装前端依赖..."
        Invoke-Npm (Join-Path $ProjectDir "web") @("install", "--no-audit", "--no-fund")
    }
    Write-Host ">>> 构建前端..."
    Invoke-Npm (Join-Path $ProjectDir "web") @("run", "build")
    Write-Host ">>> 构建后端..."
    Invoke-Npm $ProjectDir @("run", "build")
} else {
    Write-Host ">>> 跳过构建（-NoBuild）"
}

# 4. 后台启动服务
# 经 cmd start 中转：ShellExecute 启动链不继承调用方句柄，避免 node 子进程持有
# 调用方的 stdout 管道，导致非交互调用方（CI/管道捕获输出）永远等待不退出
$logsDir = Join-Path $ProjectDir "logs"
New-Item -ItemType Directory -Path $logsDir -Force -ErrorAction Stop | Out-Null
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$outLog = Join-Path $logsDir "runner-$stamp.out.log"
$errLog = Join-Path $logsDir "runner-$stamp.err.log"

Write-Host ">>> 启动服务..."
$cmdLine = '/c start "" /b node dist/index.js > "' + $outLog + '" 2> "' + $errLog + '"'
Start-Process -FilePath "cmd.exe" -ArgumentList $cmdLine -WorkingDirectory $ProjectDir -WindowStyle Hidden | Out-Null

# 5. 等待端口监听，反查真实服务 PID
$srvPid = 0
for ($i = 1; $i -le 15; $i++) {
    Start-Sleep -Seconds 1
    $conn = Get-NetTCPConnection -LocalPort $cfgPort -State Listen -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($conn) { $srvPid = $conn.OwningProcess; break }
}
if (-not $srvPid) {
    Write-Host "❌ 错误：服务未能在 15 秒内监听端口 $cfgPort，最近错误日志：" -ForegroundColor Red
    Get-Content -LiteralPath $errLog -Tail 30 -ErrorAction SilentlyContinue
    exit 1
}

# 5. 健康检查：协议按 .env 的 HTTPS 证书配置判定；用 HttpWebRequest 显式双超时，
#    避免 Invoke-WebRequest 对协议错配的读停滞不超时导致脚本卡死
function Test-ServiceReady {
    param([string]$Url)
    try {
        # PS 5.1 的 .NET 默认不含 TLS 1.2，Node 服务端默认拒绝旧协议，须显式开启
        [System.Net.ServicePointManager]::SecurityProtocol =
            [System.Net.ServicePointManager]::SecurityProtocol -bor [System.Net.SecurityProtocolType]::Tls12
        $prevCallback = [System.Net.ServicePointManager]::ServerCertificateValidationCallback
        [System.Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }
        try {
            $req = [System.Net.HttpWebRequest]::Create($Url)
            $req.Timeout = 2000
            $req.ReadWriteTimeout = 2000
            $req.AllowAutoRedirect = $false
            $resp = $req.GetResponse()
            $resp.Close()
            return $true
        } catch [System.Net.WebException] {
            return ($null -ne $_.Exception.Response)  # 404/302 等状态码同样说明服务在监听
        } finally {
            [System.Net.ServicePointManager]::ServerCertificateValidationCallback = $prevCallback
        }
    } catch {
        return $false
    }
}

# HTTPS 与否取决于是否同时配置了证书与私钥（与 src/config.ts parseHttpsConfig 一致）
$useHttps = $false
if (Test-Path -LiteralPath $envFile) {
    $certPath = ""
    $keyPath = ""
    foreach ($line in Get-Content -LiteralPath $envFile) {
        if ($line -match '^\s*HTTPS_CERT_PATH\s*=\s*"?([^"#]+)"?\s*$') { $certPath = $Matches[1].Trim() }
        elseif ($line -match '^\s*HTTPS_KEY_PATH\s*=\s*"?([^"#]+)"?\s*$') { $keyPath = $Matches[1].Trim() }
    }
    $useHttps = ($certPath -ne "" -and $keyPath -ne "")
}
$scheme = if ($useHttps) { "https" } else { "http" }
$checkHost = if ($cfgHost -eq "0.0.0.0" -or $cfgHost -eq "::") { "127.0.0.1" } else { $cfgHost }
$baseUrl = "${scheme}://${checkHost}:$cfgPort"
Write-Host ">>> 等待服务就绪（$baseUrl）..."
$ready = $false
for ($i = 1; $i -le 30; $i++) {
    if (-not (Get-Process -Id $srvPid -ErrorAction SilentlyContinue)) {
        Write-Host "❌ 错误：服务进程（PID $srvPid）中途退出，最近错误日志：" -ForegroundColor Red
        Get-Content -LiteralPath $errLog -Tail 30 -ErrorAction SilentlyContinue
        exit 1
    }
    Start-Sleep -Seconds 1
    if (Test-ServiceReady $baseUrl) { $ready = $true; break }
}

Write-Host ""
if ($ready) {
    Write-Host "=== ✅ donger 已启动 ===" -ForegroundColor Green
    Write-Host "进程:   node（PID $srvPid）"
    Write-Host "本机:   $baseUrl"
    if ($cfgHost -ne "0.0.0.0" -and $cfgHost -ne "127.0.0.1") {
        Write-Host "远程:   ${scheme}://${cfgHost}:$cfgPort"
    }
    Write-Host "日志:   $outLog"
    Write-Host "        $errLog"
    Write-Host "停止:   Stop-Process -Id $srvPid"
} else {
    Write-Host "⚠️  30 秒内未就绪，最近日志：" -ForegroundColor Yellow
    Get-Content -LiteralPath $errLog -Tail 30 -ErrorAction SilentlyContinue
    Get-Content -LiteralPath $outLog -Tail 10 -ErrorAction SilentlyContinue
    exit 1
}
