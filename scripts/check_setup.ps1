<#
.SYNOPSIS
    FairBatch Workspace, Artifact & Sepolia `.env` Readiness Inspector.

.DESCRIPTION
    Verifies project folder organization, local compiler/foundry/rust/node toolchains,
    compiled Fe 26.5.0 artifacts in `./out/`, Rust backend & React frontend build
    readiness, and `.env` Sepolia configuration status WITHOUT ever printing secrets.
#>
[CmdletBinding()]
param(
    [string]$EnvFile = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$RepoRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($EnvFile)) {
    $EnvFile = Join-Path $RepoRoot ".env"
}

function Resolve-Tool([string]$Name) {
    $cmd = Get-Command $Name -ErrorAction SilentlyContinue
    if ($null -ne $cmd) { return $cmd.Source }
    $cargoBin = Join-Path $env:USERPROFILE ".cargo\bin\$Name.exe"
    if (Test-Path $cargoBin) { return $cargoBin }
    return $null
}

function Read-DotEnv([string]$Path) {
    $map = @{}
    if (-not (Test-Path $Path)) { return $map }
    foreach ($rawLine in (Get-Content $Path)) {
        $line = $rawLine.Trim()
        if ($line.Length -eq 0 -or $line.StartsWith("#")) { continue }
        $eqIdx = $line.IndexOf("=")
        if ($eqIdx -lt 1) { continue }
        $k = $line.Substring(0, $eqIdx).Trim()
        $v = $line.Substring($eqIdx + 1).Trim()
        if (($v.StartsWith('"') -and $v.EndsWith('"')) -or ($v.StartsWith("'") -and $v.EndsWith("'"))) {
            $v = $v.Substring(1, $v.Length - 2)
        }
        $map[$k] = $v
    }
    return $map
}

Write-Host "========================================================================" -ForegroundColor Cyan
Write-Host " FairBatch Workspace & Ethereum Sepolia Readiness Check" -ForegroundColor Cyan
Write-Host "========================================================================" -ForegroundColor Cyan

# 1. Directory Organization Check
Write-Host "[1/5] Project Directory Structure ($RepoRoot)" -ForegroundColor Yellow
$RequiredDirs = @("src", "out", "backend", "frontend", "config", "deployments", "scripts", "docs")
foreach ($d in $RequiredDirs) {
    $p = Join-Path $RepoRoot $d
    $exists = Test-Path $p
    Write-Host ("  {0,-16} : {1}" -f "$d/", $(if ($exists) { "OK" } else { "MISSING" })) `
        -ForegroundColor $(if ($exists) { "Green" } else { "Red" })
    if (-not $exists) { throw "Missing required project directory: $p" }
}

# 2. Toolchain Check
Write-Host ""
Write-Host "[2/5] Local Toolchains" -ForegroundColor Yellow
$FeBin    = Resolve-Tool "fe"
$CastBin  = Resolve-Tool "cast"
$AnvilBin = Resolve-Tool "anvil"
$CargoBin = Resolve-Tool "cargo"
$NodeBin  = Resolve-Tool "node"

if ($FeBin)    { Write-Host ("  fe               : {0}" -f (& $FeBin --version).Trim()) } else { throw "Missing 'fe' compiler" }
if ($CastBin)  { Write-Host ("  cast             : {0}" -f ((& $CastBin --version | Select-Object -First 1).Trim())) } else { throw "Missing Foundry 'cast'" }
if ($AnvilBin) { Write-Host ("  anvil            : {0}" -f ((& $AnvilBin --version | Select-Object -First 1).Trim())) } else { throw "Missing Foundry 'anvil'" }
if ($CargoBin) { Write-Host ("  cargo            : {0}" -f (& $CargoBin --version).Trim()) } else { throw "Missing Rust 'cargo'" }
if ($NodeBin)  { Write-Host ("  node             : {0}" -f (& $NodeBin --version).Trim()) } else { throw "Missing 'node'" }

# 3. Compiled Fe 26.5.0 Artifacts Check
Write-Host ""
Write-Host "[3/5] Compiled Fe 26.5.0 Contract Artifacts (./out/)" -ForegroundColor Yellow
$RequiredArtifacts = @(
    "FairBatch.bin",
    "FairBatch.runtime.bin",
    "FairBatch.abi.json",
    "MockERC20.bin",
    "MockERC20.abi.json"
)
foreach ($art in $RequiredArtifacts) {
    $ap = Join-Path (Join-Path $RepoRoot "out") $art
    if (-not (Test-Path $ap)) {
        throw "Missing compiled artifact '$ap'. Run 'fe build' first."
    }
    $len = (Get-Item $ap).Length
    Write-Host ("  {0,-24} : PRESENT ({1} file bytes)" -f $art, $len) -ForegroundColor Green
}

# 4. Backend & Frontend Build Readiness
Write-Host ""
Write-Host "[4/5] Backend Solver & Frontend Terminal Readiness" -ForegroundColor Yellow
$BackendCargoToml = Join-Path $RepoRoot "backend\Cargo.toml"
$FrontendPkgJson  = Join-Path $RepoRoot "frontend\package.json"
$FrontendNodeMods = Join-Path $RepoRoot "frontend\node_modules"
$FrontendDist     = Join-Path $RepoRoot "frontend\dist"

Write-Host ("  backend/Cargo.toml       : {0}" -f $(if (Test-Path $BackendCargoToml) { "OK" } else { "MISSING" }))
Write-Host ("  frontend/package.json    : {0}" -f $(if (Test-Path $FrontendPkgJson)  { "OK" } else { "MISSING" }))
Write-Host ("  frontend/node_modules    : {0}" -f $(if (Test-Path $FrontendNodeMods) { "INSTALLED" } else { "NOT INSTALLED (run 'npm install' in frontend/)" }))
Write-Host ("  frontend/dist            : {0}" -f $(if (Test-Path $FrontendDist)     { "BUILT" } else { "NOT BUILT (run 'npm run build' in frontend/)" }))

# 5. Root `.env` & Sepolia Key Readiness (NEVER prints private keys!)
Write-Host ""
Write-Host "[5/5] Root .env & Sepolia Deployment Readiness" -ForegroundColor Yellow
if (-not (Test-Path $EnvFile)) {
    throw "Root .env file missing at '$EnvFile'."
}
$EnvMap = Read-DotEnv $EnvFile
$NetName    = if ($EnvMap.ContainsKey("NETWORK"))            { $EnvMap["NETWORK"] }            else { "(unset)" }
$ChainId    = if ($EnvMap.ContainsKey("CHAIN_ID"))           { $EnvMap["CHAIN_ID"] }           else { "(unset)" }
$RpcUrl     = if ($EnvMap.ContainsKey("RPC_URL"))            { $EnvMap["RPC_URL"] }            else { "(unset)" }
$TestTokens = if ($EnvMap.ContainsKey("DEPLOY_TEST_TOKENS")) { $EnvMap["DEPLOY_TEST_TOKENS"] } else { "(unset)" }
$FbAddr     = if ($EnvMap.ContainsKey("FAIRBATCH_ADDRESS"))  { $EnvMap["FAIRBATCH_ADDRESS"] }  else { "0x0000000000000000000000000000000000000000" }
$RawKey     = if ($EnvMap.ContainsKey("DEPLOYER_PRIVATE_KEY")) { $EnvMap["DEPLOYER_PRIVATE_KEY"] } else { "" }

Write-Host ("  .env File Path           : {0} (git-ignored)" -f $EnvFile)
Write-Host ("  NETWORK / CHAIN_ID       : {0} / {1}" -f $NetName, $ChainId)
Write-Host ("  RPC_URL                  : {0}" -f $RpcUrl)
Write-Host ("  DEPLOY_TEST_TOKENS       : {0}" -f $TestTokens)
Write-Host ("  FAIRBATCH_ADDRESS        : {0}" -f $FbAddr)

$SepoliaManifest = Join-Path $RepoRoot "deployments\sepolia.json"
Write-Host ("  deployments/sepolia.json : {0}" -f $(if (Test-Path $SepoliaManifest) { "DEPLOYED MANIFEST PRESENT" } else { "Pending live Sepolia deploy" }))

if ([string]::IsNullOrWhiteSpace($RawKey)) {
    Write-Host "  DEPLOYER_PRIVATE_KEY     : [WAITING FOR USER INPUT] -> Paste your funded Sepolia key into .env" -ForegroundColor DarkYellow
} else {
    $normKey = if ($RawKey.StartsWith("0x")) { $RawKey } else { "0x$RawKey" }
    if ($normKey -match "^0x[0-9a-fA-F]{64}$") {
        $DerivedAddr = (& $CastBin wallet address --private-key $normKey).Trim()
        Write-Host ("  DEPLOYER_PRIVATE_KEY     : [READY] -> Public Deployer Address: {0}" -f $DerivedAddr) -ForegroundColor Green
    } else {
        Write-Host "  DEPLOYER_PRIVATE_KEY     : [INVALID FORMAT] -> Expected 64 hex chars (0x...)" -ForegroundColor Red
        throw "Malformed DEPLOYER_PRIVATE_KEY in .env."
    }
}

Write-Host ""
Write-Host "Setup verification complete!" -ForegroundColor Green
