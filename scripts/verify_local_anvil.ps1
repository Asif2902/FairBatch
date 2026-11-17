<#
.SYNOPSIS
    Self-Contained Local Ephemeral Anvil EVM Verification for Compiled Fe 26.5.0 Bytecode.

.DESCRIPTION
    Spins up an isolated, ephemeral local Foundry `anvil` instance bound strictly to
    `127.0.0.1` (Chain ID 31337, Cancun hardfork), deploys compiled Fe bytecode from
    `./out/` via `cast send --create`, executes live JSON-RPC calls against the deployed
    contract, and tears down the `anvil` process cleanly in a `finally` block.

    STRICT SAFETY POLICY:
      - Hardcoded to `127.0.0.1` loopback and Chain ID `31337` ONLY.
      - Never connects to any external testnet or mainnet RPC.
      - Always terminates the child `anvil` process before exiting.
#>
[CmdletBinding()]
param(
    [ValidateRange(1024, 65535)]
    [int]$Port = 18545,

    [string]$OutDir = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$RepoRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($OutDir)) {
    $OutDir = Join-Path $RepoRoot "out"
}

# Locate `anvil` and `cast`
function Resolve-FoundryTool([string]$Name) {
    $cmd = Get-Command $Name -ErrorAction SilentlyContinue
    if ($null -ne $cmd) { return $cmd.Source }
    $fallback = Join-Path $env:USERPROFILE ".cargo\bin\$Name.exe"
    if (Test-Path $fallback) { return $fallback }
    throw "Required Foundry binary '$Name' not found."
}

$AnvilBin = Resolve-FoundryTool "anvil"
$CastBin  = Resolve-FoundryTool "cast"

# Strictly loopback local RPC + Windows Named Pipe IPC (works in restricted sandboxes too!)
$LocalHostAddr = "127.0.0.1"
$HttpRpcUrl    = "http://${LocalHostAddr}:${Port}"
$IpcPipePath   = "\\.\pipe\fairbatch_anvil_${PID}_${Port}"
$RpcUrl        = $IpcPipePath
$AnvilDevKey0  = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
$AnvilDevAddr0 = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
# Deploys creation bytecode of arbitrary size (e.g. 21.5KB FairBatch.bin = 43K hex chars)
# by piping JSON-RPC params via stdin to `cast rpc --raw`, bypassing Windows's 32,767-char CLI limit!
function Deploy-LocalBytecode([string]$HexData) {
    $paramsJson = "[{`"from`":`"$AnvilDevAddr0`",`"data`":`"$HexData`",`"gas`":`"0x1c9c380`"}]"
    $txHashRaw  = ($paramsJson | & $CastBin rpc --rpc-url $RpcUrl --raw eth_sendTransaction).Trim()
    $txHash     = $txHashRaw.Trim('"')
    $receipt    = (& $CastBin rpc --rpc-url $RpcUrl eth_getTransactionReceipt $txHash) | ConvertFrom-Json
    if ($receipt.status -ne "0x1") {
        throw "Contract creation reverted on local Anvil (tx: $txHash)."
    }
    return $receipt
}

Write-Host "========================================================================" -ForegroundColor Cyan
Write-Host " FairBatch Ephemeral Local Anvil EVM Bytecode Verifier (LOCAL ONLY)" -ForegroundColor Cyan
Write-Host "========================================================================" -ForegroundColor Cyan

$AnvilProc = $null
try {
    Write-Host "[1/4] Starting ephemeral Cancun Anvil (127.0.0.1:$Port + IPC $IpcPipePath, Chain ID 31337)..." -ForegroundColor Yellow
    $AnvilProc = Start-Process -FilePath $AnvilBin `
        -ArgumentList @("--host", $LocalHostAddr, "--port", "$Port", "--ipc", $IpcPipePath, "--chain-id", "31337", "--hardfork", "cancun", "--silent") `
        -PassThru -NoNewWindow

    # Poll local IPC / loopback until Anvil responds (up to 6 seconds)
    $Ready = $false
    for ($i = 0; $i -lt 25; $i++) {
        Start-Sleep -Milliseconds 250
        if ($AnvilProc.HasExited) {
            throw "Anvil exited unexpectedly with code $($AnvilProc.ExitCode)."
        }
        $prevPref = $ErrorActionPreference
        $ErrorActionPreference = "Continue"
        $cidOut = & $CastBin chain-id --rpc-url $RpcUrl 2>$null
        $exitCode = $LASTEXITCODE
        $ErrorActionPreference = $prevPref
        if ($exitCode -eq 0 -and $null -ne $cidOut -and ("$cidOut").Trim() -eq "31337") {
            $Ready = $true
            break
        }
    }
    if (-not $Ready) {
        throw "Timed out waiting for local Anvil on $RpcUrl ($HttpRpcUrl)."
    }
    Write-Host "  Verified local Chain ID : 31337 (loopback isolated)" -ForegroundColor Green

    $FairBatchBin = Join-Path $OutDir "FairBatch.bin"
    $FairBatchAbi = Join-Path $OutDir "FairBatch.abi.json"
    $MockErc20Bin = Join-Path $OutDir "MockERC20.bin"
    $MockErc20Abi = Join-Path $OutDir "MockERC20.abi.json"
    $VaultBin     = Join-Path $OutDir "Vault.bin"

    if ((Test-Path $FairBatchBin) -and (Test-Path $FairBatchAbi)) {
        Write-Host "[2/4] Deploying MockERC20 (18-dec WETH & 6-dec USDC) + FairBatch from ./out/..." -ForegroundColor Yellow
        $AbiItems = Get-Content -Raw $FairBatchAbi | ConvertFrom-Json

        $BaseTokenAddr  = "0x0000000000000000000000000000000000000bA5"
        $QuoteTokenAddr = "0x0000000000000000000000000000000000000900"

        if ((Test-Path $MockErc20Bin) -and (Test-Path $MockErc20Abi)) {
            $MockHex = (Get-Content -Raw $MockErc20Bin).Trim() -replace "^0x", ""
            $MockAbiItems = Get-Content -Raw $MockErc20Abi | ConvertFrom-Json
            $MockCtor = $MockAbiItems | Where-Object { $_.type -eq "constructor" } | Select-Object -First 1

            function Deploy-MockToken([int]$Dec) {
                $payload = "0x$MockHex"
                if ($null -ne $MockCtor -and $MockCtor.inputs.Count -gt 0) {
                    $mTypes = ($MockCtor.inputs | ForEach-Object { $_.type }) -join ","
                    $mArgs = @()
                    foreach ($inp in $MockCtor.inputs) {
                        if ($inp.type -match "^uint") { $mArgs += "$Dec" }
                        elseif ($inp.type -eq "address") { $mArgs += $AnvilDevAddr0 }
                        elseif ($inp.type -eq "string") { $mArgs += "Mock" }
                        else { $mArgs += "0" }
                    }
                    $enc = (& $CastBin abi-encode "constructor($mTypes)" @mArgs).Trim() -replace "^0x", ""
                    $payload = "0x$MockHex$enc"
                }
                $deployJson = Deploy-LocalBytecode $payload
                return $deployJson.contractAddress
            }

            $BaseTokenAddr  = Deploy-MockToken 18
            $QuoteTokenAddr = Deploy-MockToken 6
            Write-Host "  Deployed Mock WETH (18d): $BaseTokenAddr"
            Write-Host "  Deployed Mock USDC (6d) : $QuoteTokenAddr"
        }

        $FbHex = (Get-Content -Raw $FairBatchBin).Trim() -replace "^0x", ""
        $CtorItem = $AbiItems | Where-Object { $_.type -eq "constructor" } | Select-Object -First 1
        $CreatePayload = "0x$FbHex"
        if ($null -ne $CtorItem -and $CtorItem.inputs.Count -gt 0) {
            $ParamTypes = ($CtorItem.inputs | ForEach-Object { $_.type }) -join ","
            $CtorArgs = @()
            foreach ($inp in $CtorItem.inputs) {
                switch -Regex ($inp.name) {
                    "base.*token"  { $CtorArgs += $BaseTokenAddr; break }
                    "quote.*token" { $CtorArgs += $QuoteTokenAddr; break }
                    "base.*dec"    { $CtorArgs += "18"; break }
                    "quote.*dec"   { $CtorArgs += "6"; break }
                    "commit"       { $CtorArgs += "60"; break }
                    "reveal"       { $CtorArgs += "60"; break }
                    "bond"         { $CtorArgs += "10000000000000000"; break }
                    default        { $CtorArgs += "0" }
                }
            }
            $EncodedCtor = (& $CastBin abi-encode "constructor($ParamTypes)" @CtorArgs).Trim() -replace "^0x", ""
            $CreatePayload = "0x$FbHex$EncodedCtor"
        }

        $FbReceipt = Deploy-LocalBytecode $CreatePayload
        $FairBatchAddr = $FbReceipt.contractAddress
        if ([string]::IsNullOrWhiteSpace($FairBatchAddr)) {
            throw "FairBatch deployment failed on local Anvil."
        }
        Write-Host "  Deployed FairBatch      : $FairBatchAddr (gasUsed: $($FbReceipt.gasUsed))" -ForegroundColor Green

        Write-Host "[3/4] Probing deployed FairBatch runtime bytecode, reserve seeding & 5-Seller Uniform Clearing..." -ForegroundColor Yellow
        $DeployedCode = (& $CastBin code --rpc-url $RpcUrl $FairBatchAddr).Trim()
        $CodeBytes = [int](($DeployedCode.Length - 2) / 2)
        if ($CodeBytes -le 0) { throw "Deployed FairBatch code is empty!" }
        Write-Host "  On-chain runtime size   : $CodeBytes bytes"

        $DomainSep = (& $CastBin call --rpc-url $RpcUrl $FairBatchAddr "domainSeparator()(uint256)").Trim()
        Write-Host "  EIP-712 domainSeparator : $DomainSep"

        if ((Test-Path $MockErc20Bin) -and (Test-Path $MockErc20Abi)) {
            # Mint & approve 105 WETH (18d) + 300,000 USDC (6d), seed 100 WETH / 300,000 USDC,
            # submit 5 x 1 WETH direct sell orders, settle Batch #1, and verify uniform 2,727.272727 USDC payouts!
            $null = & $CastBin send --rpc-url $RpcUrl --private-key $AnvilDevKey0 $BaseTokenAddr "mintAndApprove(address,address,uint256)" $AnvilDevAddr0 $FairBatchAddr "105000000000000000000"
            $null = & $CastBin send --rpc-url $RpcUrl --private-key $AnvilDevKey0 $QuoteTokenAddr "mintAndApprove(address,address,uint256)" $AnvilDevAddr0 $FairBatchAddr "300000000000"
            $null = & $CastBin send --rpc-url $RpcUrl --private-key $AnvilDevKey0 $FairBatchAddr "seedReserves(uint256,uint256)" "100000000000000000000" "300000000000"
            Write-Host "  Seeded FM-AMM Reserves  : 100 WETH (18d) + 300,000 USDC (6d)"

            for ($ord = 0; $ord -lt 5; $ord++) {
                $null = & $CastBin send --rpc-url $RpcUrl --private-key $AnvilDevKey0 $FairBatchAddr "submitDirectOrder(uint8,uint256,uint256)" "0" "1000000000000000000" "0"
            }
            # Advance local Anvil clock past commit_window (60s) + reveal_window (60s)
            $null = & $CastBin rpc --rpc-url $RpcUrl evm_increaseTime 125
            $null = & $CastBin rpc --rpc-url $RpcUrl evm_mine
            $SettleTx = (& $CastBin send --rpc-url $RpcUrl --private-key $AnvilDevKey0 --json $FairBatchAddr "settleBatch()") | ConvertFrom-Json
            Write-Host "  Settled 5-Seller Batch  : status=$($SettleTx.status), gasUsed=$($SettleTx.gasUsed)"

            $BeforeQuote = [bigint]::Parse(((& $CastBin call --rpc-url $RpcUrl $QuoteTokenAddr "balanceOf(address)(uint256)" $AnvilDevAddr0).Trim() -split "\s+")[0])
            for ($ord = 0; $ord -lt 5; $ord++) {
                $null = & $CastBin send --rpc-url $RpcUrl --private-key $AnvilDevKey0 $FairBatchAddr "claim(uint256,uint256)" "1" "$ord"
            }
            $AfterQuote = [bigint]::Parse(((& $CastBin call --rpc-url $RpcUrl $QuoteTokenAddr "balanceOf(address)(uint256)" $AnvilDevAddr0).Trim() -split "\s+")[0])
            $TotalQuoteClaimed = $AfterQuote - $BeforeQuote
            $ExpectedTotalQuote = [bigint]::Parse("13636363635") # 5 * 2,727,272,727 raw USDC (6 decimals)
            Write-Host "  Claimed 5x1 WETH Payout : $TotalQuoteClaimed raw USDC (expected $ExpectedTotalQuote = 5 * 2,727.272727 USDC)"
            if ($TotalQuoteClaimed -ne $ExpectedTotalQuote) {
                throw "Unexpected total USDC payout: got $TotalQuoteClaimed, expected $ExpectedTotalQuote"
            }
        }
    } elseif (Test-Path $VaultBin) {
        Write-Host "[2/4] FairBatch.bin not yet built; verifying Fe 26.5.0 starter Vault.bin on local Anvil..." -ForegroundColor Yellow
        $VaultHex = (Get-Content -Raw $VaultBin).Trim() -replace "^0x", ""
        $CtorEnc  = (& $CastBin abi-encode "constructor(uint256)" "0").Trim() -replace "^0x", ""
        $Receipt  = (& $CastBin send --rpc-url $RpcUrl --private-key $AnvilDevKey0 --json --create "0x$VaultHex$CtorEnc") | ConvertFrom-Json
        $VaultAddr = $Receipt.contractAddress
        Write-Host "  Deployed starter Vault  : $VaultAddr (gasUsed: $($Receipt.gasUsed))" -ForegroundColor Green

        Write-Host "[3/4] Executing live deposit() & balanceOf() RPC check on local Anvil..." -ForegroundColor Yellow
        $null = & $CastBin send --rpc-url $RpcUrl --private-key $AnvilDevKey0 --value 1ether $VaultAddr "deposit()"
        $Bal = (& $CastBin call --rpc-url $RpcUrl $VaultAddr "balanceOf(address)(uint256)" $AnvilDevAddr0).Trim()
        Write-Host "  cast call balanceOf()   : $Bal"
    } else {
        throw "No compiled .bin artifacts found in $OutDir. Run 'fe build' first."
    }

    Write-Host "[4/4] Local Anvil verification succeeded!" -ForegroundColor Green
} finally {
    if ($null -ne $AnvilProc -and -not $AnvilProc.HasExited) {
        Stop-Process -Id $AnvilProc.Id -Force -ErrorAction SilentlyContinue
        Write-Host "Stopped ephemeral local Anvil process (PID $($AnvilProc.Id))." -ForegroundColor DarkGray
    }
}
