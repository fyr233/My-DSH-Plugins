#!/usr/bin/env pwsh
<#
.SYNOPSIS
  Remove the plugins in this repository from a DSH profile.

.DESCRIPTION
  Runs `dsh plugin --profile <profile> remove <package-name>` for each bundle
  directory. dsh deletes the dependency entry and the matching bundle layer in
  one step, leaving every other installed plugin untouched.

.PARAMETER Profile
  Profile to remove from. Defaults to $env:DSH_PROFILE, then "desktop".

.PARAMETER Plugin
  One or more plugin directory names. Defaults to every bundle in the repo.

.PARAMETER DryRun
  Print the commands that would run, without executing them.

.EXAMPLE
  ./uninstall.ps1
  Remove every plugin in this repository from the active profile.

.NOTES
  Requires Windows PowerShell 5.1 or PowerShell 7+. Under the default
  RemoteSigned policy run it with:

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

$repoRoot = $PSScriptRoot

function Write-Step([string]$Message) { Write-Host "==> $Message" -ForegroundColor Cyan }
function Write-Ok([string]$Message)   { Write-Host "  ok  $Message" -ForegroundColor Green }
function Write-Warn2([string]$Message) { Write-Host "  !   $Message" -ForegroundColor Yellow }

if ([string]::IsNullOrWhiteSpace($Profile)) {
    $Profile = if ($env:DSH_PROFILE) { $env:DSH_PROFILE } else { 'desktop' }
}
Write-Step "Target profile: $Profile"
if ($Profile -eq 'desktop') {
    Write-Warn2 "The 'desktop' profile is owned by the Desktop app; quit it fully before continuing."
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
if (-not $dshCommand) { throw "No 'dsh' command found on PATH, and no bundled Desktop launcher was found." }
Write-Step "Using dsh: $($dshCommand.Source)"

$dirs = @(Get-ChildItem -Path $repoRoot -Directory |
    Where-Object { Test-Path (Join-Path $_.FullName 'package.json') } |
    Sort-Object Name)
if ($Plugin) {
    $dirs = @($dirs | Where-Object { $_.Name -in $Plugin })
}
if ($dirs.Count -eq 0) { throw "Nothing to remove." }

$failed = @()
foreach ($dir in $dirs) {
    $manifest = Get-Content (Join-Path $dir.FullName 'package.json') -Raw | ConvertFrom-Json
    $arguments = @('plugin', '--profile', $Profile, 'remove', $manifest.name)

    if ($DryRun) {
        Write-Host "  [dry-run] dsh $($arguments -join ' ')"
        continue
    }

    Write-Step "Removing $($manifest.name)"
    & $dshCommand.Source @arguments
    if ($LASTEXITCODE -ne 0) {
        Write-Warn2 "$($manifest.name) failed with exit code $LASTEXITCODE (already absent?)"
        $failed += $manifest.name
    } else {
        Write-Ok "$($manifest.name) removed"
    }
}

if ($DryRun) { Write-Step "Dry run complete; nothing was removed."; exit 0 }
if ($failed.Count -gt 0) { Write-Warn2 "Not removed: $($failed -join ', ')" }
Write-Step "Done. Restart DSH to drop the plugin layers."
