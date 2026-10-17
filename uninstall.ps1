#!/usr/bin/env pwsh
<#
.SYNOPSIS
  从 DSH profile 中卸载本仓库的插件。

.DESCRIPTION
  对每个插件目录执行 `dsh plugin --profile <profile> remove <包名>`。
  dsh 会一步删除依赖项与对应的 bundle 层，其它已安装插件不受影响。

.PARAMETER Profile
  目标 profile。默认取 $env:DSH_PROFILE，再缺省为 "desktop"。
  "desktop" profile 归桌面应用所有，卸载前需要完全退出桌面应用。

.PARAMETER Plugin
  只卸载指定的插件目录名，可多个。默认卸载本仓库中的全部插件。

.PARAMETER DryRun
  只打印将要执行的命令，不实际运行。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\uninstall.ps1
  从当前 profile 中卸载本仓库的全部插件。

.NOTES
  需要 Windows PowerShell 5.1 或 PowerShell 7+。
  本机为 RemoteSigned 执行策略，未签名脚本请这样运行：

      powershell -ExecutionPolicy Bypass -File .\uninstall.ps1
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

if ([string]::IsNullOrWhiteSpace($Profile)) {
    if ($env:DSH_PROFILE) { $Profile = $env:DSH_PROFILE } else { $Profile = 'desktop' }
}
Write-Step "目标 profile：$Profile"
if ($Profile -eq 'desktop') {
    Write-Warn2 "desktop profile 归桌面应用所有，请先完全退出 DeepSeek Harness 再继续。"
}

function Resolve-DshCommand {
    $found = Get-Command dsh -CommandType Application, ExternalScript -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($found) { return [pscustomobject]@{ Source = $found.Source } }

    $candidates = @(
        (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd')
        (Join-Path $env:ProgramFiles 'DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd')
        (Join-Path ${env:ProgramFiles(x86)} 'DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd')
    )
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path $candidate)) { return [pscustomobject]@{ Source = $candidate } }
    }
    return $null
}

$dshCommand = Resolve-DshCommand
if (-not $dshCommand) {
    throw "PATH 中找不到 dsh 命令，也未找到桌面应用自带的启动器。"
}
Write-Step "使用 dsh：$($dshCommand.Source)"

if (-not (Test-Path $pluginsDir)) { throw "未找到插件目录：$pluginsDir" }

$dirs = @(Get-ChildItem -Path $pluginsDir -Directory |
    Where-Object { Test-Path (Join-Path $_.FullName 'package.json') } |
    Sort-Object Name)

if ($Plugin) {
    $missing = @($Plugin | Where-Object { $_ -notin $dirs.Name })
    if ($missing.Count -gt 0) {
        throw "未知的插件：$($missing -join '、')。可用插件：$(($dirs.Name) -join '、')"
    }
    $dirs = @($dirs | Where-Object { $_.Name -in $Plugin })
}
if ($dirs.Count -eq 0) { throw "没有可卸载的插件。" }

$failed = @()
foreach ($dir in $dirs) {
    $manifest = Get-Content (Join-Path $dir.FullName 'package.json') -Raw | ConvertFrom-Json
    $arguments = @('plugin', '--profile', $Profile, 'remove', $manifest.name)

    if ($DryRun) {
        Write-Host "    [预览] dsh $($arguments -join ' ')"
        continue
    }

    Write-Step "正在卸载 $($manifest.name)"
    & $dshCommand.Source @arguments
    if ($LASTEXITCODE -ne 0) {
        Write-Warn2 "$($manifest.name) 失败，退出码 $LASTEXITCODE（可能本来就没有安装）"
        $failed += $manifest.name
    } else {
        Write-Ok "$($manifest.name) 已卸载"
    }
}

if ($DryRun) {
    Write-Step "预览结束，未做任何改动。"
    exit 0
}
if ($failed.Count -gt 0) { Write-Warn2 "未卸载成功：$($failed -join '、')" }
Write-Step "完成。重启 DSH 后插件层即被移除。"
