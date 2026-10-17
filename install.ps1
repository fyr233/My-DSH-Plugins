#!/usr/bin/env pwsh
<#
.SYNOPSIS
  Install (or re-link) every dsh plugin in this repository into a DSH profile.

.DESCRIPTION
  Each subdirectory containing a package.json with `dsh.bundle.patch` is a DSH
  bundle. This script registers each one into a profile with

      dsh plugin --profile <profile> add <absolute-path-to-plugin-dir>

  which is the documented install path: pnpm links the checkout, and dsh
  appends the package to `dsh.profile.bundles` because the package declares
  `dsh.bundle`.

  Re-running is the supported way to repair a profile after this repository
  was moved: pnpm re-creates the links at the new absolute paths and the
  bundle list is de-duplicated (a bundle is only ever listed once).

  The script is safe to run against an existing profile. It does not edit
  cordis.patch.yml and does not touch other installed bundles or plugins.

.PARAMETER Profile
  Profile to install into. Defaults to $env:DSH_PROFILE, then "desktop".
  The Desktop application owns the "desktop" profile, so it must be fully
  quit before installing into it.

.PARAMETER Plugin
  One or more plugin directory names to install. Defaults to every bundle
  found in this repository.

.PARAMETER DryRun
  Print the commands that would run, without executing them.

.EXAMPLE
  ./install.ps1
  Install every plugin into the active profile.

.EXAMPLE
  ./install.ps1 -Profile web
  Install every plugin into the "web" profile.

.EXAMPLE
  ./install.ps1 -DryRun
  Show what would be installed.

.NOTES
  Requires: Windows PowerShell 5.1 or PowerShell 7+, and a `dsh` command on
  PATH. Written in 5.1-compatible syntax so it runs out of the box, where the
  default execution policy (RemoteSigned) blocks unsigned scripts:

      powershell -ExecutionPolicy Bypass -File .\install.ps1

  or, from an already-running session:

      Unblock-File .\install.ps1; .\install.ps1
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

# --- resolve profile -------------------------------------------------------
if ([string]::IsNullOrWhiteSpace($Profile)) {
    $Profile = if ($env:DSH_PROFILE) { $env:DSH_PROFILE } else { 'desktop' }
}
Write-Step "Target profile: $Profile"
if ($Profile -eq 'desktop') {
    Write-Warn2 "The 'desktop' profile is owned by the Desktop app; quit it fully before continuing."
}

# --- locate dsh ------------------------------------------------------------
function Resolve-DshCommand {
    $found = Get-Command dsh -CommandType Application, ExternalScript -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($found) { return [pscustomobject]@{ Source = $found.Source } }

    # The Desktop app ships a launcher that it does not always add to PATH.
    $candidates = @(
        (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd')
        (Join-Path $env:ProgramFiles 'DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd')
        (Join-Path ${env:ProgramFiles(x86)} 'DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd')
    )
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path $candidate)) {
            Write-Warn2 "dsh is not on PATH; using the bundled launcher: $candidate"
            Write-Warn2 "To make it permanent on this machine, add this directory to PATH: $(Split-Path $candidate)"
            return [pscustomobject]@{ Source = $candidate }
        }
    }
    return $null
}

$dshCommand = Resolve-DshCommand
if (-not $dshCommand) {
    throw "No 'dsh' command found on PATH, and no bundled Desktop launcher was found. Install the dsh CLI (or enable the Desktop app's command-line option) and retry."
}
Write-Step "Using dsh: $($dshCommand.Source)"

# --- discover bundles ------------------------------------------------------
function Get-BundleDirs {
    Get-ChildItem -Path $repoRoot -Directory |
        Where-Object { Test-Path (Join-Path $_.FullName 'package.json') } |
        Sort-Object Name
}

$all = @(Get-BundleDirs)
if ($Plugin) {
    $missing = @($Plugin | Where-Object { $_ -notin $all.Name })
    if ($missing.Count -gt 0) {
        throw "Unknown plugin(s): $($missing -join ', '). Found: $($all.Name -join ', ')"
    }
    $all = @($all | Where-Object { $_.Name -in $Plugin })
}
if ($all.Count -eq 0) { throw "No plugin directories with a package.json were found under $repoRoot." }

# --- validate that each directory really is a dsh bundle -------------------
$bundles = foreach ($dir in $all) {
    $manifest = Get-Content (Join-Path $dir.FullName 'package.json') -Raw | ConvertFrom-Json
    if (-not ($manifest.PSObject.Properties.Name -contains 'dsh') -or
        -not $manifest.dsh -or -not $manifest.dsh.bundle -or -not $manifest.dsh.bundle.patch) {
        throw "$($dir.Name)/package.json does not declare dsh.bundle.patch, so dsh would install it as a plain dependency and never activate it."
    }
    if (-not $manifest.name -or -not $manifest.version) {
        throw "$($dir.Name)/package.json must declare both name and version."
    }
    $patchPath = Join-Path $dir.FullName $manifest.dsh.bundle.patch
    if (-not (Test-Path $patchPath)) { throw "$($dir.Name): dsh.bundle.patch points at a missing file: $patchPath" }
    foreach ($entry in $manifest.files) {
        if ($entry -notmatch '[*?]' -and -not (Test-Path (Join-Path $dir.FullName $entry))) {
            Write-Warn2 "$($dir.Name): files[] lists '$entry' but it does not exist."
        }
    }
    [pscustomobject]@{
        Name    = $manifest.name
        Version = $manifest.version
        Dir     = $dir.FullName
        Engines = if ($manifest.engines -and $manifest.engines.dsh) { $manifest.engines.dsh } else { '(undeclared)' }
    }
}

Write-Step "Bundles to install ($($bundles.Count)):"
$bundles | ForEach-Object { Write-Host ("  {0,-42} {1,-8} dsh {2}" -f $_.Name, $_.Version, $_.Engines) }

# --- install ---------------------------------------------------------------
$failed = @()
foreach ($bundle in $bundles) {
    $arguments = @('plugin', '--profile', $Profile, 'add', $bundle.Dir)
    $rendered = "dsh " + (($arguments | ForEach-Object { if ($_ -match '\s') { "'$_'" } else { $_ } }) -join ' ')

    if ($DryRun) {
        Write-Host "  [dry-run] $rendered"
        continue
    }

    Write-Step "Installing $($bundle.Name)"
    & $dshCommand.Source @arguments
    if ($LASTEXITCODE -ne 0) {
        Write-Warn2 "$($bundle.Name) failed with exit code $LASTEXITCODE"
        $failed += $bundle.Name
    } else {
        Write-Ok "$($bundle.Name) linked into profile '$Profile'"
    }
}

# --- summary ---------------------------------------------------------------
if ($DryRun) {
    Write-Step "Dry run complete; nothing was installed."
    exit 0
}

Write-Host ''
if ($failed.Count -gt 0) {
    Write-Warn2 "These bundles failed: $($failed -join ', ')"
    throw "Install incomplete. Fix the errors above and re-run install.ps1."
}

Write-Step "Done. Restart DSH (or let HMR reload the profile) to activate the plugins."
Write-Host "  Verify the layers with: dsh --profile $Profile --dump-config" -ForegroundColor DarkGray
