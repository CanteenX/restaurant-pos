# Nventra POS Windows setup: checks Docker/WSL2, writes .env, starts services.
# Called by the Inno Setup installer (nventra.iss) and safe to re-run.
# Usage: setup-nventra.ps1 -AppDir <install dir> [-Action install|start|stop|down]
param(
    [Parameter(Mandatory)][string]$AppDir,
    [ValidateSet('install', 'start', 'stop', 'down')][string]$Action = 'install'
)
$ErrorActionPreference = 'Stop'
$log = Join-Path $env:ProgramData 'NventraPOS\setup.log'
New-Item -ItemType Directory -Force -Path (Split-Path $log) | Out-Null
function Log($m) { $line = "$(Get-Date -Format s) $m"; Add-Content $log $line; Write-Host $line }

function New-Secret([int]$bytes = 32) {
    $b = New-Object byte[] $bytes
    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
    ([BitConverter]::ToString($b) -replace '-', '').ToLower()
}

function Test-DockerReady {
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { return $false }
    docker info *> $null
    return ($LASTEXITCODE -eq 0)
}

function Assert-Prerequisites {
    $wslOk = $false
    try { wsl.exe --status *> $null; $wslOk = ($LASTEXITCODE -eq 0) } catch { }
    if (-not $wslOk) {
        Log 'WSL2 is not enabled.'
        Write-Host 'WSL2 is required. Run "wsl --install" in an admin PowerShell, restart, then run this installer again.' -ForegroundColor Yellow
        exit 2
    }
    if (-not (Test-DockerReady)) {
        Log 'Docker is not installed or not running.'
        Write-Host 'Docker Desktop (or a Docker engine inside WSL2) must be installed and running. Opening the download page.' -ForegroundColor Yellow
        Start-Process 'https://docs.docker.com/desktop/setup/install/windows-install/'
        exit 3
    }
}

function Write-EnvFile {
    $envPath = Join-Path $AppDir '.env'
    if (Test-Path $envPath) { Log '.env exists, keeping it.'; return }
    $text = Get-Content (Join-Path $AppDir '.env.example') -Raw
    $text = $text -replace '(?m)^POSTGRES_PASSWORD=.*$', "POSTGRES_PASSWORD=$(New-Secret 16)"
    $text = $text -replace '(?m)^JWT_SECRET=.*$', "JWT_SECRET=$(New-Secret 32)"
    Set-Content -Path $envPath -Value $text -Encoding ascii
    Log 'Wrote .env with generated secrets.'
}

function Invoke-Compose([string[]]$composeArgs) {
    Push-Location $AppDir
    try { docker compose @composeArgs; if ($LASTEXITCODE -ne 0) { throw "docker compose $composeArgs failed" } }
    finally { Pop-Location }
}

switch ($Action) {
    'install' { Assert-Prerequisites; Write-EnvFile; Invoke-Compose @('up', '-d'); Log 'Nventra POS started on http://localhost:1995' }
    'start'   { Assert-Prerequisites; Invoke-Compose @('up', '-d') }
    'stop'    { Invoke-Compose @('stop') }
    'down'    { if (Test-DockerReady) { Invoke-Compose @('down') } }
}
