<#
.SYNOPSIS
    FairBatch Offline Deployment Readiness & Calldata Builder (Strictly Dry-Run).

.DESCRIPTION
    Prepares ABI-encoded constructor arguments, creation payload inspection,
    Cancun/Shanghai EVM opcode verification (`cast disassemble`), and ERC-20 /
    reserve-seeding calldata for FairBatch WITHOUT ever connecting to an RPC
    endpoint or broadcasting any transaction.

    STRICT SAFETY POLICY:
      - Zero network requests are performed.
      - `SOLVER_PRIVATE_KEY` is never read or accepted.
      - No `cast send` or `forge create` command is ever executed.
#>
[CmdletBinding()]
param(
    [ValidateSet("anvil", "sepolia", "hoodi", "mainnet")]
    [string]$Network = "sepolia",

    [string]$BaseToken = "",
    [string]$QuoteToken = "",
    [int]$BaseDecimals = 18,
    [int]$QuoteDecimals = 6,
    [uint64]$CommitWindowSecs = 24,
    [uint64]$RevealWindowSecs = 24,
    [string]$MinBondWei = "10000000000000000",          # 0.01 ETH reveal bond
    [string]$SeedBaseRaw = "100000000000000000000",     # 100 WETH (18 decimals)
    [string]$SeedQuoteRaw = "300000000000",             # 300,000 USDC (6 decimals)
    [string]$OutDir = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$RepoRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($OutDir)) {
    $OutDir = Join-Path $RepoRoot "out"
}

# Locate Foundry `cast`
$CastBin = "cast"
if (-not (Get-Command $CastBin -ErrorAction SilentlyContinue)) {
    $CargoCast = Join-Path $env:USERPROFILE ".cargo\bin\cast.exe"
    if (Test-Path $CargoCast) {
        $CastBin = $CargoCast
    } else {
        throw "Foundry 'cast' binary not found in PATH or ~/.cargo/bin."
    }
}

# Canonical network presets (Cancun / EIP-1153 compatible networks only)
$NetworkMeta = switch ($Network) {
    "anvil" {
        @{
            ChainId      = 31337
            Label        = "Local Foundry Anvil (Ephemeral Loopback)"
            DefaultBase  = "0x5FbDB2315678afecb367f032d93F642f64180aa3"
            DefaultQuote = "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512"
            EvmFork      = "Cancun / Prague"
        }
    }
    "sepolia" {
        @{
            ChainId      = 11155111
            Label        = "Ethereum Sepolia Testnet"
            DefaultBase  = "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14" # Canonical Sepolia WETH9 (18 dec)
            DefaultQuote = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" # Circle Sepolia USDC (6 dec)
            EvmFork      = "Cancun / Pectra (EIP-1153 TLOAD/TSTORE active)"
        }
    }
    "hoodi" {
        @{
            ChainId      = 560048
            Label        = "Ethereum Hoodi Testnet"
            DefaultBase  = "0x0000000000000000000000000000000000000001" # Replace with Hoodi WETH deployment
            DefaultQuote = "0x0000000000000000000000000000000000000002" # Replace with Hoodi USDC deployment
            EvmFork      = "Cancun / Pectra (EIP-1153 TLOAD/TSTORE active)"
        }
    }
    "mainnet" {
        @{
            ChainId      = 1
            Label        = "Ethereum Mainnet (Requires Audit Sign-Off)"
            DefaultBase  = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" # Canonical WETH9 (18 dec)
            DefaultQuote = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" # Canonical Circle USDC (6 dec)
            EvmFork      = "Cancun / Pectra (EIP-1153 TLOAD/TSTORE active)"
        }
    }
}

if ([string]::IsNullOrWhiteSpace($BaseToken))  { $BaseToken  = $NetworkMeta.DefaultBase }
if ([string]::IsNullOrWhiteSpace($QuoteToken)) { $QuoteToken = $NetworkMeta.DefaultQuote }

Write-Host "========================================================================" -ForegroundColor Cyan
Write-Host " FairBatch Deployment Readiness & Calldata Builder (OFFLINE DRY-RUN)" -ForegroundColor Cyan
Write-Host " Safety Mode : STRICTLY OFFLINE — ZERO RPC CALLS OR BROADCASTS" -ForegroundColor Green
Write-Host "========================================================================" -ForegroundColor Cyan
Write-Host (" Target Preset     : {0} (Chain ID: {1})" -f $NetworkMeta.Label, $NetworkMeta.ChainId)
Write-Host (" Required EVM Fork : {0}" -f $NetworkMeta.EvmFork)
Write-Host (" Base Token (X)    : {0} ({1} decimals)" -f $BaseToken, $BaseDecimals)
Write-Host (" Quote Token (Y)   : {0} ({1} decimals)" -f $QuoteToken, $QuoteDecimals)
Write-Host (" Commit / Reveal   : {0}s / {1}s | Min Reveal Bond: {2} wei" -f $CommitWindowSecs, $RevealWindowSecs, $MinBondWei)
Write-Host (" Initial Seed Plan : {0} raw Base + {1} raw Quote" -f $SeedBaseRaw, $SeedQuoteRaw)
Write-Host ""

# Inspect `./out/` read-only for compiled Fe 26.5.0 artifacts
$FairBatchBinPath     = Join-Path $OutDir "FairBatch.bin"
$FairBatchRuntimePath = Join-Path $OutDir "FairBatch.runtime.bin"
$FairBatchAbiPath     = Join-Path $OutDir "FairBatch.abi.json"

$CtorSignature = "constructor(address,address,uint8,uint8,uint256,uint256,uint256)"
$CtorArgs      = @($BaseToken, $QuoteToken, "$BaseDecimals", "$QuoteDecimals", "$CommitWindowSecs", "$RevealWindowSecs", $MinBondWei)
$SeedSignature = "seedReserves(uint256,uint256)"

if (Test-Path $FairBatchAbiPath) {
    $AbiItems = Get-Content -Raw $FairBatchAbiPath | ConvertFrom-Json
    $CtorItem = $AbiItems | Where-Object { $_.type -eq "constructor" } | Select-Object -First 1
    if ($null -ne $CtorItem -and $CtorItem.inputs.Count -gt 0) {
        $ParamTypes = ($CtorItem.inputs | ForEach-Object { $_.type }) -join ","
        $CtorSignature = "constructor($ParamTypes)"
        $DynamicArgs = @()
        foreach ($inp in $CtorItem.inputs) {
            switch -Regex ($inp.name) {
                "base.*token"    { $DynamicArgs += $BaseToken; break }
                "quote.*token"   { $DynamicArgs += $QuoteToken; break }
                "base.*dec"      { $DynamicArgs += "$BaseDecimals"; break }
                "quote.*dec"     { $DynamicArgs += "$QuoteDecimals"; break }
                "commit"         { $DynamicArgs += "$CommitWindowSecs"; break }
                "reveal"         { $DynamicArgs += "$RevealWindowSecs"; break }
                "bond"           { $DynamicArgs += $MinBondWei; break }
                default          { $DynamicArgs += "0" }
            }
        }
        if ($DynamicArgs.Count -eq $CtorItem.inputs.Count) {
            $CtorArgs = $DynamicArgs
        }
    }

    $SeedCandidates = @("seedReserves", "seed_reserves", "addLiquidity", "add_liquidity")
    $SeedItem = $AbiItems | Where-Object { $_.type -eq "function" -and ($SeedCandidates -contains $_.name) } | Select-Object -First 1
    if ($null -ne $SeedItem) {
        $SeedTypes = ($SeedItem.inputs | ForEach-Object { $_.type }) -join ","
        $SeedSignature = "$($SeedItem.name)($SeedTypes)"
    }
}

Write-Host "[1/3] Artifact & Cancun Bytecode Inspection ($OutDir)" -ForegroundColor Yellow
if ((Test-Path $FairBatchBinPath) -and (Test-Path $FairBatchRuntimePath)) {
    $InitHex    = (Get-Content -Raw $FairBatchBinPath).Trim() -replace "^0x", ""
    $RuntimeHex = (Get-Content -Raw $FairBatchRuntimePath).Trim() -replace "^0x", ""
    $InitBytes    = [int]($InitHex.Length / 2)
    $RuntimeBytes = [int]($RuntimeHex.Length / 2)
    $Eip170Pct    = [math]::Round(($RuntimeBytes / 24576.0) * 100.0, 2)

    Write-Host ("  FairBatch.bin         : {0} bytes" -f $InitBytes)
    Write-Host ("  FairBatch.runtime.bin : {0} bytes ({1}% of 24,576-byte EIP-170 limit)" -f $RuntimeBytes, $Eip170Pct)

    # Pipe via stdin so >32KB hex strings bypass Windows Win32 CreateProcess CLI length limits
    $Disasm = ($RuntimeHex | & $CastBin disassemble) -split "`r?`n"
    $Push0Count  = ($Disasm | Select-String -Pattern "\bPUSH0\b").Count
    $McopyCount  = ($Disasm | Select-String -Pattern "\bMCOPY\b").Count
    $TloadCount  = ($Disasm | Select-String -Pattern "\bTLOAD\b").Count
    $TstoreCount = ($Disasm | Select-String -Pattern "\bTSTORE\b").Count
    Write-Host ("  Verified Opcodes      : PUSH0={0} (Shanghai) | MCOPY={1}, TLOAD={2}, TSTORE={3} (Cancun)" -f $Push0Count, $McopyCount, $TloadCount, $TstoreCount)
} else {
    $ExistingBins = Get-ChildItem -Path $OutDir -Filter "*.runtime.bin" -ErrorAction SilentlyContinue
    Write-Host "  FairBatch.bin not yet generated in ./out/ (run 'fe build' first for full creation payload)." -ForegroundColor DarkYellow
    foreach ($b in $ExistingBins) {
        $hex = (Get-Content -Raw $b.FullName).Trim() -replace "^0x", ""
        Write-Host ("  Detected artifact     : {0} ({1} bytes)" -f $b.Name, [int]($hex.Length / 2))
    }
}

Write-Host ""
Write-Host "[2/3] Offline ABI-Encoded Constructor & Seeding Calldata" -ForegroundColor Yellow
$EncodedCtor = (& $CastBin abi-encode $CtorSignature @CtorArgs).Trim()
$ApprovePlaceholderFairBatch = "0x000000000000000000000000000000000000fA1B"
$ApproveBaseCalldata  = (& $CastBin calldata "approve(address,uint256)" $ApprovePlaceholderFairBatch $SeedBaseRaw).Trim()
$ApproveQuoteCalldata = (& $CastBin calldata "approve(address,uint256)" $ApprovePlaceholderFairBatch $SeedQuoteRaw).Trim()
$SeedCalldata         = (& $CastBin calldata $SeedSignature $SeedBaseRaw $SeedQuoteRaw).Trim()

Write-Host ("  Constructor Signature : {0}" -f $CtorSignature)
Write-Host ("  Encoded Ctor Args     : {0}" -f $EncodedCtor)
if (Test-Path $FairBatchBinPath) {
    $CreationHex = "0x" + ((Get-Content -Raw $FairBatchBinPath).Trim() -replace "^0x", "") + ($EncodedCtor -replace "^0x", "")
    Write-Host ("  Full Creation Payload : {0} bytes (0x{1}...)" -f ([int](($CreationHex.Length - 2) / 2)), $CreationHex.Substring(2, [Math]::Min(48, $CreationHex.Length - 2)))
}
Write-Host ("  Base approve() Data   : {0} (replace placeholder {1} with deployed FairBatch)" -f $ApproveBaseCalldata, $ApprovePlaceholderFairBatch)
Write-Host ("  Quote approve() Data  : {0} (replace placeholder {1} with deployed FairBatch)" -f $ApproveQuoteCalldata, $ApprovePlaceholderFairBatch)
Write-Host ("  Reserve Seed Sig      : {0}" -f $SeedSignature)
Write-Host ("  Reserve Seed Data     : {0}" -f $SeedCalldata)

Write-Host ""
Write-Host "[3/3] Post-Deployment .env Configuration Template" -ForegroundColor Yellow
Write-Host "  CHAIN_ID=$($NetworkMeta.ChainId)"
Write-Host "  BASE_TOKEN_ADDRESS=$BaseToken"
Write-Host "  QUOTE_TOKEN_ADDRESS=$QuoteToken"
Write-Host "  FAIRBATCH_ADDRESS=<fill_after_authorized_deployment>"
Write-Host ""
Write-Host "Dry-run complete. Zero external network calls were made." -ForegroundColor Green
