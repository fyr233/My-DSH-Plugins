#!/usr/bin/env pwsh
<#
.SYNOPSIS
  把本仓库中的所有 DSH 插件安装（或重新链接）到指定的 DSH profile。

.DESCRIPTION
  `plugins/` 下每个含 `dsh.bundle.patch` 的 package.json 目录都是一个 DSH 组合包
  （bundle）。本脚本对每个插件执行：

      dsh plugin --profile <profile> add <插件目录的绝对路径>

  这是文档规定的安装方式：pnpm 会链接该目录，而 dsh 因为包声明了
  `dsh.bundle`，会把它追加进 profile 的 `dsh.profile.bundles`。

  重复运行是修复“仓库被移动后插件失效”的正规做法：pnpm 会在新路径重建链接，
  而已在 bundle 列表中的包不会被重复添加。

  脚本可以安全地对已有的 profile 运行。它不会改动 cordis.patch.yml，
  也不会影响其它已安装的 bundle 或插件。

.PARAMETER Profile
  目标 profile。默认取 $env:DSH_PROFILE，再缺省为 "desktop"。
  "desktop" profile 归桌面应用所有，安装前需要完全退出桌面应用。

.PARAMETER Plugin
  只安装指定的插件目录名，可多个。默认安装本仓库中的全部插件。

.PARAMETER DryRun
  只打印将要执行的命令，不实际运行。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install.ps1
  把全部插件装入当前 profile。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install.ps1 -Profile web
  把全部插件装入 "web" profile。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install.ps1 -DryRun
  预览将安装什么。

.NOTES
  需要 Windows PowerShell 5.1 或 PowerShell 7+，以及可用的 `dsh` 命令。

  关于“未对文件进行数字签名”的错误：
  本机执行策略为 RemoteSigned，从网络或克隆得到的 .ps1 没有数字签名时会被拒绝。
  用下面的方式运行即可，不必修改系统执行策略：

      powershell -ExecutionPolicy Bypass -File .\install.ps1

  如果文件带有“来自网络”标记，也可以先解除标记再直接运行：

      Unblock-File .\install.ps1
      .\install.ps1
#>
[CmdletBinding()]
param(
    [string]$Profile,
    [string[]]$Plugin,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot   = $PSScriptRoot
$pluginsDir = Join-Path $repoRoot 'plugins'

function Write-Step([string]$Message)  { Write-Host "==> $Message" -ForegroundColor Cyan }
function Write-Ok([string]$Message)    { Write-Host "  成功  $Message" -ForegroundColor Green }
function Write-Warn2([string]$Message) { Write-Host "  注意  $Message" -ForegroundColor Yellow }

# --- 解析目标 profile -------------------------------------------------------
if ([string]::IsNullOrWhiteSpace($Profile)) {
    if ($env:DSH_PROFILE) { $Profile = $env:DSH_PROFILE } else { $Profile = 'desktop' }
}
Write-Step "目标 profile：$Profile"
if ($Profile -eq 'desktop') {
    Write-Warn2 "desktop profile 归桌面应用所有，请先完全退出 DeepSeek Harness 再继续。"
}

# --- 定位 dsh 命令 ----------------------------------------------------------
function Resolve-DshCommand {
    $found = Get-Command dsh -CommandType Application, ExternalScript -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($found) { return [pscustomobject]@{ Source = $found.Source } }

    # 桌面应用自带的启动器，有时不会加入 PATH。
    $candidates = @(
        (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd')
        (Join-Path $env:ProgramFiles 'DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd')
        (Join-Path ${env:ProgramFiles(x86)} 'DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd')
    )
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path $candidate)) {
            Write-Warn2 "PATH 中没有 dsh，改用桌面应用自带的启动器：$candidate"
            Write-Warn2 "如需长期可用，可把该目录加入 PATH：$(Split-Path $candidate)"
            return [pscustomobject]@{ Source = $candidate }
        }
    }
    return $null
}

$dshCommand = Resolve-DshCommand
if (-not $dshCommand) {
    throw "PATH 中找不到 dsh 命令，也未找到桌面应用自带的启动器。请安装 dsh CLI（或在桌面应用中启用命令行功能）后重试。"
}
Write-Step "使用 dsh：$($dshCommand.Source)"

# --- 发现插件 ---------------------------------------------------------------
if (-not (Test-Path $pluginsDir)) {
    throw "未找到插件目录：$pluginsDir"
}

$all = @(Get-ChildItem -Path $pluginsDir -Directory |
    Where-Object { Test-Path (Join-Path $_.FullName 'package.json') } |
    Sort-Object Name)

if ($Plugin) {
    $missing = @($Plugin | Where-Object { $_ -notin $all.Name })
    if ($missing.Count -gt 0) {
        throw "未知的插件：$($missing -join '、')。可用插件：$(($all.Name) -join '、')"
    }
    $all = @($all | Where-Object { $_.Name -in $Plugin })
}
if ($all.Count -eq 0) { throw "$pluginsDir 下没有任何含 package.json 的插件目录。" }

# --- 校验每个目录确实是 DSH 组合包 ------------------------------------------
$bundles = foreach ($dir in $all) {
    $manifest = Get-Content (Join-Path $dir.FullName 'package.json') -Raw | ConvertFrom-Json

    if (-not ($manifest.PSObject.Properties.Name -contains 'dsh') -or
        -not $manifest.dsh -or -not $manifest.dsh.bundle -or -not $manifest.dsh.bundle.patch) {
        throw "$($dir.Name)/package.json 未声明 dsh.bundle.patch，dsh 只会把它当作普通依赖安装，永远不会启用。"
    }
    if (-not $manifest.name -or -not $manifest.version) {
        throw "$($dir.Name)/package.json 必须同时声明 name 与 version。"
    }

    $patchPath = Join-Path $dir.FullName $manifest.dsh.bundle.patch
    if (-not (Test-Path $patchPath)) {
        throw "$($dir.Name)：dsh.bundle.patch 指向的文件不存在：$patchPath"
    }

    foreach ($entry in $manifest.files) {
        if ($entry -notmatch '[*?]' -and -not (Test-Path (Join-Path $dir.FullName $entry))) {
            Write-Warn2 "$($dir.Name)：files[] 中的 '$entry' 实际不存在。"
        }
    }

    [pscustomobject]@{
        Name    = $manifest.name
        Version = $manifest.version
        Dir     = $dir.FullName
        Engines = if ($manifest.engines -and $manifest.engines.dsh) { $manifest.engines.dsh } else { '(未声明)' }
    }
}

Write-Step "将安装 $($bundles.Count) 个组合包："
$bundles | ForEach-Object { Write-Host ("    {0,-42} {1,-8} dsh {2}" -f $_.Name, $_.Version, $_.Engines) }

# --- 安装 -------------------------------------------------------------------
$failed = @()
foreach ($bundle in $bundles) {
    $arguments = @('plugin', '--profile', $Profile, 'add', $bundle.Dir)
    $rendered = "dsh " + (($arguments | ForEach-Object { if ($_ -match '\s') { "'$_'" } else { $_ } }) -join ' ')

    if ($DryRun) {
        Write-Host "    [预览] $rendered"
        continue
    }

    Write-Step "正在安装 $($bundle.Name)"
    & $dshCommand.Source @arguments
    if ($LASTEXITCODE -ne 0) {
        Write-Warn2 "$($bundle.Name) 失败，退出码 $LASTEXITCODE"
        $failed += $bundle.Name
    } else {
        Write-Ok "$($bundle.Name) 已链接进 profile「$Profile」"
    }
}

# --- 汇总 -------------------------------------------------------------------
if ($DryRun) {
    Write-Step "预览结束，未做任何改动。"
    exit 0
}

Write-Host ''
if ($failed.Count -gt 0) {
    Write-Warn2 "以下插件安装失败：$($failed -join '、')"
    throw "安装未完成。请根据上方的错误修复后重新运行 install.ps1。"
}

Write-Step "全部完成。重启 DSH（或等待 HMR 重新加载 profile）后生效。"
Write-Host "  用下面的命令核对各插件层是否已加载：" -ForegroundColor DarkGray
Write-Host "  dsh --profile $Profile --dump-config | Select-String 'window-capture|input-control|seamless-continue'" -ForegroundColor DarkGray
