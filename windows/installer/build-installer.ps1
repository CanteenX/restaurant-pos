# Builds out\NventraPOS-Setup-<version>.exe. Requires Inno Setup 6 (iscc.exe).
# Local only; no CI workflow is involved.
param([string]$Version = '0.0.0-dev')
$ErrorActionPreference = 'Stop'
$iscc = (Get-Command iscc.exe -ErrorAction SilentlyContinue).Source
if (-not $iscc) { $iscc = "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe" }
if (-not (Test-Path $iscc)) { throw 'Inno Setup 6 not found. Install with: winget install JRSoftware.InnoSetup' }
$env:NVENTRA_VERSION = $Version
& $iscc (Join-Path $PSScriptRoot 'nventra.iss')
if ($LASTEXITCODE -ne 0) { throw 'iscc failed' }
Write-Host "Built $PSScriptRoot\out\NventraPOS-Setup-$Version.exe"
