<#
.SYNOPSIS
    FairBatch Full-Stack Launcher (`fairbatch-backend` + React Vite Terminal).

.DESCRIPTION
    Reads deployed Ethereum Sepolia addresses from `config/deployment.json`, loads
    optional runtime settings (`HOST`, `PORT`) from `.env`, and launches both the
    Rust Axum backend (`http://127.0.0.1:3001`) and the React Vite terminal
    (`http://localhost:5173`).

    Pass `-CheckOnly` to validate configuration without starting processes.
#>
[CmdletBinding()]
param(
    [string]$EnvFile = "",
    [switch]$CheckOnly
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$RepoRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($EnvFile)) {
    $EnvFile = Join-Path $RepoRoot ".env"
}

if (Test-Path $EnvFile) {
    foreach ($rawLine in (Get-Content $EnvFile)) {
        $line = $rawLine.Trim()
        if ($line.Length -eq 0 -or $line.StartsWith("#")) { continue }
        $eqIdx = $line.IndexOf("=")
        if ($eqIdx -lt 1) { continue }
        $k = $line.Substring(0, $eqIdx).Trim()
        $v = $line.Substring($eqIdx + 1).Trim()
        if (($v.StartsWith('"') -and $v.EndsWith('"')) -or ($v.StartsWith("'") -and $v.EndsWith("'"))) {
            $v = $v.Substring(1, $v.Length - 2)
        }
        if (-not [string]::IsNullOrWhiteSpace($v) -and [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($k))) {
            [Environment]::SetEnvironmentVariable($k, $v, "Process")
        }
    }
}

$GlobalConfigPath = Join-Path $RepoRoot "config\deployment.json"
$ChainId = 11155111
$FbAddr  = "0x0000000000000000000000000000000000000000"
$FaucetAddr = "0x0000000000000000000000000000000000000000"
if (Test-Path $GlobalConfigPath) {
    $cfg = Get-Content -Raw $GlobalConfigPath | ConvertFrom-Json
    $ChainId = $cfg.chainId
    $FbAddr = $cfg.contracts.fairBatch
    $FaucetAddr = $cfg.contracts.faucet
}

$HostAddr = if ($env:HOST) { $env:HOST } else { "127.0.0.1" }
$PortNum  = if ($env:PORT) { $env:PORT } else { "3001" }

Write-Host "========================================================================" -ForegroundColor Cyan
Write-Host " FairBatch Full-Stack Launcher (Ethereum Sepolia)" -ForegroundColor Cyan
Write-Host "========================================================================" -ForegroundColor Cyan
Write-Host ("  Backend API       : http://{0}:{1}" -f $HostAddr, $PortNum)
Write-Host ("  Frontend Terminal : http://localhost:5173" )
Write-Host ("  Network           : Ethereum Sepolia (Chain ID {0})" -f $ChainId)
Write-Host ("  FairBatch         : {0}" -f $FbAddr)
Write-Host ("  Faucet            : {0}" -f $FaucetAddr)

if ($CheckOnly) {
    Write-Host "  CheckOnly mode    : configuration & paths validated cleanly." -ForegroundColor Green
    exit 0
}

$BackendDir  = Join-Path $RepoRoot "backend"
$FrontendDir = Join-Path $RepoRoot "frontend"

$BackendProc  = $null
$FrontendProc = $null
try {
    Write-Host ""
    Write-Host "Starting Rust solver backend (cargo run)..." -ForegroundColor Yellow
    $BackendProc = Start-Process -FilePath "cargo" -ArgumentList @("run") -WorkingDirectory $BackendDir -PassThru

    Write-Host "Starting Vite frontend dev server (npm run dev)..." -ForegroundColor Yellow
    $NpmCmd = if ($IsWindows -or $env:OS -match "Windows") { "npm.cmd" } else { "npm" }
    $FrontendProc = Start-Process -FilePath $NpmCmd -ArgumentList @("run", "dev") -WorkingDirectory $FrontendDir -PassThru

    Write-Host ""
    Write-Host "FairBatch stack is running! Press Ctrl+C to stop both processes." -ForegroundColor Green
    while (-not $BackendProc.HasExited -and -not $FrontendProc.HasExited) {
        Start-Sleep -Seconds 1
    }
} finally {
    if ($null -ne $FrontendProc -and -not $FrontendProc.HasExited) {
        Stop-Process -Id $FrontendProc.Id -Force -ErrorAction SilentlyContinue
    }
    if ($null -ne $BackendProc -and -not $BackendProc.HasExited) {
        Stop-Process -Id $BackendProc.Id -Force -ErrorAction SilentlyContinue
    }
}
