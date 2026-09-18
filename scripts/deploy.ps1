#Requires -Version 5.1
<#
.SYNOPSIS
    donger 部署脚本（PowerShell 版，兼容 Windows PowerShell 5.1 与 pwsh 7+）
.DESCRIPTION
    从 master 分支的 HEAD 导出独立部署副本到 <部署根>/donger，安装依赖、构建前后端、
    生成生产 .env，产出可直接 npm start 的运行目录。逻辑与 scripts/deploy.sh 对齐，
    另有三处适配：
      1. 部署目录默认 <项目>/.deploy/donger（与线上实际布局一致，
         避免清理 .deploy 根目录时波及部署本体）；
      2. 后端先全量安装依赖、构建完成后再裁剪 dev 依赖
         （tsc 在 devDependencies，若先 --production 安装会导致构建失败）；
      3. 重新部署前自动把部署目录内已有的 .env 备份到部署根
         （线上 .env 常含手工调整，如 HOST/LOG_LEVEL）。
.EXAMPLE
    pwsh scripts/deploy.ps1
.EXAMPLE
    pwsh scripts/deploy.ps1 -Port 3330 -WebPort 3333
#>
[CmdletBinding()]
param(
    [int]$Port = 3330,
    [int]$WebPort = 3333,
    # 部署根目录；实际部署到 <DeployRoot>/donger
    [string]$DeployRoot = ""
)

Set-StrictMode -Version Latest

function Assert-LastExitCode {
    param([string]$Step)
    if ($LASTEXITCODE -ne 0) {
        Write-Host "❌ 错误：$Step 失败（退出码 $LASTEXITCODE）" -ForegroundColor Red
        exit $LASTEXITCODE
    }
}

function Invoke-Npm {
    param([string]$Dir, [string[]]$NpmArgs, [string]$Hint = "")
    Push-Location -LiteralPath $Dir
    try {
        & npm @NpmArgs
        if ($LASTEXITCODE -ne 0) {
            if ($Hint) { Write-Host "💡 提示：$Hint" -ForegroundColor Yellow }
            exit $LASTEXITCODE
        }
    }
    finally { Pop-Location }
}

# 0. 校验 Node 版本（>= 20，与 package.json engines 对齐）
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    Write-Host "❌ 错误：未检测到 Node.js，需要 Node >= 20" -ForegroundColor Red
    exit 1
}
$nodeVersion = (& node -v).Trim()
$nodeMajor = [int]($nodeVersion -replace "^v(\d+).*", '$1')
if ($nodeMajor -lt 20) {
    Write-Host "❌ 错误：需要 Node >= 20，当前为 $nodeVersion" -ForegroundColor Red
    exit 1
}

$ProjectDir = Split-Path -Parent $PSScriptRoot
if (-not $DeployRoot) { $DeployRoot = Join-Path $ProjectDir ".deploy" }
$DeployDir = Join-Path $DeployRoot "donger"

Write-Host "=== donger 部署脚本 ==="
Write-Host "源目录:     $ProjectDir"
Write-Host "部署目录:   $DeployDir"
Write-Host "后端端口:   $Port"
Write-Host "前端端口:   $WebPort"

# 1. 检查 git 状态（只允许从 master 分支部署）
$branch = (& git -C $ProjectDir rev-parse --abbrev-ref HEAD)
Assert-LastExitCode "读取 git 分支"
$branch = "$branch".Trim()
if ($branch -ne "master") {
    Write-Host "❌ 错误：只能在 master 分支部署，当前分支为 $branch" -ForegroundColor Red
    Write-Host "   请先合并到 master 后再试"
    exit 1
}

$dirty = & git -C $ProjectDir status --porcelain
if ($dirty) {
    Write-Host "⚠️  警告：工作区有未提交的更改（部署内容取自 HEAD，未提交改动不会进入部署包）" -ForegroundColor Yellow
    Write-Host "   建议先提交或 stash 后再部署"
}

# 2. 清空并创建部署目录
Write-Host ""
Write-Host ">>> 清理部署目录..."
if (Test-Path -LiteralPath $DeployDir) {
    # 备份部署目录内已有的 .env（常含手工调整）
    $existingEnv = Join-Path $DeployDir ".env"
    if (Test-Path -LiteralPath $existingEnv) {
        $envBackup = Join-Path $DeployRoot ("donger.env.bak-" + (Get-Date -Format "yyyyMMdd-HHmmss"))
        Copy-Item -LiteralPath $existingEnv -Destination $envBackup -Force -ErrorAction Stop
        Write-Host "    已备份原 .env → $envBackup" -ForegroundColor DarkGray
    }
    if (Test-Path -LiteralPath (Join-Path $DeployDir "data")) {
        Write-Host "⚠️  注意：部署目录内存在运行数据 data/，本次清理将一并删除" -ForegroundColor Yellow
    }
    # 尝试直接删除目录，若因句柄占用失败则清空内容
    try {
        Remove-Item -LiteralPath $DeployDir -Recurse -Force -ErrorAction Stop
    } catch {
        Write-Host "⚠️  无法删除目录（可能有句柄占用），改为清空内容..." -ForegroundColor Yellow
        Get-ChildItem -LiteralPath $DeployDir -Force -ErrorAction SilentlyContinue |
            Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
    }
}
New-Item -ItemType Directory -Path $DeployDir -Force -ErrorAction Stop | Out-Null

# 3. 复制项目文件（只取 HEAD 已提交内容，天然排除 node_modules、.git、data 等）
#    注意：git archive 输出是二进制 tar 流，PowerShell 管道会按文本解码导致损坏，
#    因此先落临时文件再解包。
Write-Host ">>> 复制项目文件..."
# 显式用 Windows 自带的 bsdtar：PATH 里的 tar 可能是 Git 自带的 GNU tar，
# 它会把 "C:\..." 中的冒号解析为远程主机（Cannot connect to C: resolve failed）
$tarExe = Join-Path $env:SystemRoot "System32\tar.exe"
if (-not (Test-Path -LiteralPath $tarExe)) { $tarExe = "tar" }
$tarFile = Join-Path $env:TEMP ("donger-deploy-$PID.tar")
try {
    & git -C $ProjectDir archive --format=tar -o $tarFile HEAD
    Assert-LastExitCode "git archive 导出"
    & $tarExe -xf $tarFile -C $DeployDir
    Assert-LastExitCode "解包部署文件"
    # .certs 已被 .gitignore 忽略，git archive 带不过去；本地证书中转站存在则搬运
    $certsDir = Join-Path $ProjectDir ".certs"
    if (Test-Path -LiteralPath $certsDir) {
        Copy-Item -LiteralPath $certsDir -Destination (Join-Path $DeployDir ".certs") -Recurse -Force
        Write-Host "    已复制 .certs 证书到部署目录" -ForegroundColor DarkGray
    }
}
finally {
    if (Test-Path -LiteralPath $tarFile) {
        Remove-Item -LiteralPath $tarFile -Force -ErrorAction SilentlyContinue
    }
}

# 4. 安装依赖（tsc 属 devDependencies，须全量安装才能构建，最后统一裁剪）
# better-sqlite3 的预编译二进制托管在 GitHub Releases，直连常超时，回退源码编译
# 又会因本机 VS BuildTools 缺 Windows SDK 而失败；指到 npmmirror 二进制镜像
$env:npm_config_better_sqlite3_binary_host_mirror = "https://registry.npmmirror.com/-/binary/better-sqlite3"
Write-Host ">>> 安装后端依赖..."
Invoke-Npm $DeployDir @("install") -Hint "npm install 失败常见原因：① 原生模块预编译包下载超时（本脚本已配置 npmmirror 镜像，仍失败请检查网络/代理）；② 源码编译缺 Windows SDK（VS Installer 中为 BuildTools 勾选 Windows 11 SDK 后可本地编译兜底）"

Write-Host ">>> 安装前端依赖..."
Invoke-Npm (Join-Path $DeployDir "web") @("install")

# 5. 构建前端
Write-Host ">>> 构建前端..."
Invoke-Npm (Join-Path $DeployDir "web") @("run", "build")

# 6. 构建后端
Write-Host ">>> 构建后端..."
Invoke-Npm $DeployDir @("run", "build")

Write-Host ">>> 裁剪开发依赖（仅保留生产依赖）..."
Invoke-Npm $DeployDir @("prune", "--omit=dev")

# 7. 创建 .env 部署配置
Write-Host ">>> 创建部署配置..."
$envLines = [System.Collections.Generic.List[string]]::new()
$envLines.Add("# === donger 部署配置（自动生成）===")
$envLines.Add("# 后端端口")
$envLines.Add("PORT=$Port")
$envLines.Add("# 前端 dev 端口（仅开发期，生产期由后端托管 web/dist）")
$envLines.Add("WEB_PORT=$WebPort")
$envLines.Add("# 监听地址（0.0.0.0=全网卡可外部访问；配合 DDNS/端口转发用于远程访问）")
$envLines.Add("HOST=0.0.0.0")
$envLines.Add("")
$envLines.Add("# 数据目录（相对部署目录；运行时 cwd 须在部署目录内，便于整体搬迁）")
$envLines.Add("WORKSPACE_DIR=./data/workspace")
$envLines.Add("DB_PATH=./data/donger.db")
$envLines.Add("MEMORY_DIR=./data/memory")
$envLines.Add("REPO_ROOT=./data/repos")
$envLines.Add("")
$envLines.Add("# 日志级别")
$envLines.Add("LOG_LEVEL=info")

# 8. 继承源 .env 中的关键配置（LLM、钉钉等）
$keys = @(
    "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "LLM_MODEL",
    "DINGTALK_APP_KEY", "DINGTALK_APP_SECRET", "DINGTALK_ROBOT_CODE", "DINGTALK_CARD_TEMPLATE_ID",
    "DINGTALK_LOGIN_REDIRECT_URI",
    "ADMIN_STAFF_IDS", "SUPERPOWERS_PLUGIN_PATH", "JWT_SECRET", "JWT_TTL_DAYS"
)
$sourceEnv = Join-Path $ProjectDir ".env"
if (Test-Path -LiteralPath $sourceEnv) {
    Write-Host ">>> 继承关键配置..."
    foreach ($key in $keys) {
        $match = Select-String -LiteralPath $sourceEnv -Pattern ("^" + [regex]::Escape($key) + "=") |
            Select-Object -First 1
        if ($match) { $envLines.Add($match.Line) }
    }
} else {
    Write-Host "⚠️  源目录未找到 .env，跳过关键配置继承" -ForegroundColor Yellow
}

# UTF-8 无 BOM 写入（带 BOM 会让 dotenv 读坏首个键名）
$deployEnv = Join-Path $DeployDir ".env"
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllLines($deployEnv, [string[]]$envLines, $utf8NoBom)

Write-Host ""
Write-Host "=== ✅ 部署完成 ===" -ForegroundColor Green
Write-Host "部署目录: $DeployDir"
Write-Host ""
Write-Host "启动命令（须在该目录下执行，相对路径才能正确解析）："
Write-Host "  cd $DeployDir"
Write-Host "  npm start"
Write-Host ""
Write-Host "访问："
Write-Host "  本机：  http://localhost:$Port"
Write-Host "  远程：  http://<域名或公网IP>:<公网端口>"
Write-Host "          远程访问配置（DDNS + 端口转发 + 钉钉回调白名单）见："
Write-Host "          docs/deploy-remote-access.md"
