# 镜构建备料：把非 git 资产拷入 deploy/assets/（gitignored）
# - zcode CLI：纯 JS（C:\Program Files\ZCode\resources\glm，约 86MB），容器内经 DONGER_ZCODE_CLI_PATH 使用
# - superpowers：遗留插件目录（生产根 .superpowers，仓库无此目录）
# ZCode 桌面端升级后重跑本脚本 + 重建镜像即可同步。
param(
    [string]$ZcodeCliSource = "C:\Program Files\ZCode\resources\glm",
    [string]$SuperpowersSource = "D:\deploy\donger\.superpowers",
    [string]$AssetsDir = (Join-Path $PSScriptRoot "assets")
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path (Join-Path $ZcodeCliSource "zcode.cjs"))) {
    throw "zcode CLI 不存在或缺少 zcode.cjs：$ZcodeCliSource"
}

New-Item -ItemType Directory -Force -Path $AssetsDir | Out-Null

Write-Host "== 备料 zcode CLI -> $AssetsDir\zcode-cli"
robocopy $ZcodeCliSource (Join-Path $AssetsDir "zcode-cli") /MIR /NFL /NDL /NJH /NJS | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy zcode-cli 失败，code=$LASTEXITCODE" }

if (Test-Path $SuperpowersSource) {
    Write-Host "== 备料 superpowers -> $AssetsDir\superpowers"
    robocopy $SuperpowersSource (Join-Path $AssetsDir "superpowers") /MIR /NFL /NDL /NJH /NJS | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy superpowers 失败，code=$LASTEXITCODE" }
} else {
    Write-Warning "superpowers 源不存在，跳过：$SuperpowersSource"
}

foreach ($d in @("zcode-cli", "superpowers")) {
    $p = Join-Path $AssetsDir $d
    if (Test-Path $p) {
        $size = (Get-ChildItem $p -Recurse -File | Measure-Object Length -Sum).Sum / 1MB
        Write-Host ("   {0}: {1:N1} MB" -f $d, $size)
    }
}
Write-Host "备料完成。"
