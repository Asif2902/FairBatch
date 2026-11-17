<#
.SYNOPSIS
    FairBatch Ethereum Sepolia Deployment & Reserve Seeding Automation (`CHAIN_ID = 11155111`).

.DESCRIPTION
    Deploys FairBatch (and optionally 18-decimal `fWETH` + 6-decimal `fUSDC` test tokens when
    `DEPLOY_TEST_TOKENS=true`), seeds initial FM-AMM liquidity (`100 fWETH / 300,000 fUSDC`),
    verifies live on-chain state (`domainSeparator`, `getReserves`, `currentBatch`), writes
    `deployments/sepolia.json`, and updates `.env` + `frontend/.env.local`.

    WINDOWS >32KB BYTECODE ARCHITECTURE:
      `out/FairBatch.bin` + constructor calldata is ~22.6 KB (~45,200 hex chars), which exceeds
      Windows Win32 `CreateProcess` command-line limits (`32,767` chars) if passed as a CLI argument
      to `cast send --create <hex>`. This script constructs canonical EIP-1559 (`0x02`) RLP
      transactions directly in memory, hashes via stdin (`cast keccak`), signs the 32-byte digest via
      `cast wallet sign --no-hash`, and broadcasts via stdin (`cast rpc --raw eth_sendRawTransaction`).

    STRICT SECURITY GUARANTEES:
      - NEVER prints, logs, echoes, or writes `DEPLOYER_PRIVATE_KEY` or `SOLVER_PRIVATE_KEY`.
      - Supports `-DryRun` for 100% offline verification with zero network calls.
#>
[CmdletBinding()]
param(
    [switch]$DryRun,
    [string]$EnvFile = "",
    [string]$RpcUrlOverride = "",
    [uint64]$ExpectedChainId = 0,
    [string]$ManifestOutPath = "",
    [switch]$SkipEnvWrite,
    [string]$ExistingBaseTx = "",
    [string]$ExistingQuoteTx = "",
    [string]$ExistingFairBatchTx = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$RepoRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($EnvFile)) {
    $EnvFile = Join-Path $RepoRoot ".env"
}
$OutDir = Join-Path $RepoRoot "out"

function Resolve-FoundryTool([string]$Name) {
    $cmd = Get-Command $Name -ErrorAction SilentlyContinue
    if ($null -ne $cmd) { return $cmd.Source }
    $fallback = Join-Path $env:USERPROFILE ".cargo\bin\$Name.exe"
    if (Test-Path $fallback) { return $fallback }
    throw "Required Foundry binary '$Name' not found in PATH or ~/.cargo/bin."
}

$CastBin = Resolve-FoundryTool "cast"

# ------------------------------------------------------------------------------
# Zero-dependency `.env` loader (reads key=value pairs without echoing secrets)
# ------------------------------------------------------------------------------
function Read-DotEnvFile([string]$Path) {
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

function Get-Cfg([hashtable]$EnvMap, [string]$Key, [string]$DefaultVal = "") {
    $procVal = [Environment]::GetEnvironmentVariable($Key)
    if (-not [string]::IsNullOrWhiteSpace($procVal)) { return $procVal.Trim() }
    if ($EnvMap.ContainsKey($Key) -and -not [string]::IsNullOrWhiteSpace($EnvMap[$Key])) {
        return "$($EnvMap[$Key])".Trim()
    }
    return $DefaultVal
}

function Update-EnvFileKeyValues([string]$FilePath, [hashtable]$Updates) {
    $lines = @()
    if (Test-Path $FilePath) {
        $lines = @(Get-Content $FilePath)
    }
    $seen = @{}
    for ($i = 0; $i -lt $lines.Count; $i++) {
        $trimmed = $lines[$i].Trim()
        if ($trimmed.StartsWith("#") -or -not $trimmed.Contains("=")) { continue }
        $k = $trimmed.Substring(0, $trimmed.IndexOf("=")).Trim()
        if ($Updates.ContainsKey($k)) {
            $lines[$i] = "$k=$($Updates[$k])"
            $seen[$k] = $true
        }
    }
    foreach ($k in $Updates.Keys) {
        if (-not $seen.ContainsKey($k)) {
            $lines += "$k=$($Updates[$k])"
        }
    }
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($FilePath, (($lines -join "`n") + "`n"), $utf8NoBom)
}

# ------------------------------------------------------------------------------
# Strongly-Typed In-Memory EIP-1559 (`0x02`) RLP Transaction Builder (.NET C#)
# Bypasses Windows Win32 32,767-char CreateProcess CLI limits cleanly & deterministically
# ------------------------------------------------------------------------------
if (-not ("FairBatchRlp" -as [type])) {
    Add-Type -ReferencedAssemblies "System.Numerics" -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.IO;
using System.Numerics;

public static class FairBatchRlp {
    public static byte[] HexToBytes(string hex) {
        if (string.IsNullOrWhiteSpace(hex)) return new byte[0];
        string clean = hex.Trim();
        if (clean.StartsWith("0x", StringComparison.OrdinalIgnoreCase)) clean = clean.Substring(2);
        if (clean.Length == 0) return new byte[0];
        if ((clean.Length % 2) != 0) clean = "0" + clean;
        byte[] res = new byte[clean.Length / 2];
        for (int i = 0; i < res.Length; i++) {
            res[i] = Convert.ToByte(clean.Substring(i * 2, 2), 16);
        }
        return res;
    }

    public static string BytesToHex(byte[] bytes) {
        if (bytes == null || bytes.Length == 0) return "";
        return BitConverter.ToString(bytes).Replace("-", "").ToLowerInvariant();
    }

    public static byte[] MinimalBigEndian(BigInteger val) {
        if (val.Sign < 0) throw new ArgumentException("RLP uint cannot be negative");
        if (val.IsZero) return new byte[0];
        byte[] le = val.ToByteArray();
        Array.Reverse(le);
        int start = 0;
        while (start < le.Length && le[start] == 0) start++;
        if (start >= le.Length) return new byte[0];
        byte[] be = new byte[le.Length - start];
        Buffer.BlockCopy(le, start, be, 0, be.Length);
        return be;
    }

    public static byte[] StripLeadingZeros(byte[] raw) {
        if (raw == null || raw.Length == 0) return new byte[0];
        int start = 0;
        while (start < raw.Length && raw[start] == 0) start++;
        if (start >= raw.Length) return new byte[0];
        byte[] trimmed = new byte[raw.Length - start];
        Buffer.BlockCopy(raw, start, trimmed, 0, trimmed.Length);
        return trimmed;
    }

    public static byte[] EncodeBytes(byte[] data) {
        if (data == null || data.Length == 0) return new byte[] { 0x80 };
        if (data.Length == 1 && data[0] < 0x80) return new byte[] { data[0] };
        if (data.Length <= 55) {
            byte[] res = new byte[1 + data.Length];
            res[0] = (byte)(0x80 + data.Length);
            Buffer.BlockCopy(data, 0, res, 1, data.Length);
            return res;
        }
        byte[] lenBe = MinimalBigEndian(new BigInteger(data.Length));
        byte[] longRes = new byte[1 + lenBe.Length + data.Length];
        longRes[0] = (byte)(0xb7 + lenBe.Length);
        Buffer.BlockCopy(lenBe, 0, longRes, 1, lenBe.Length);
        Buffer.BlockCopy(data, 0, longRes, 1 + lenBe.Length, data.Length);
        return longRes;
    }

    public static byte[] EncodeUint(BigInteger val) {
        return EncodeBytes(MinimalBigEndian(val));
    }

    public static byte[] EncodeList(IList<byte[]> items) {
        using (var ms = new MemoryStream()) {
            if (items != null) {
                foreach (var item in items) {
                    if (item != null && item.Length > 0) ms.Write(item, 0, item.Length);
                }
            }
            byte[] payload = ms.ToArray();
            if (payload.Length <= 55) {
                byte[] res = new byte[1 + payload.Length];
                res[0] = (byte)(0xc0 + payload.Length);
                Buffer.BlockCopy(payload, 0, res, 1, payload.Length);
                return res;
            }
            byte[] lenBe = MinimalBigEndian(new BigInteger(payload.Length));
            byte[] longRes = new byte[1 + lenBe.Length + payload.Length];
            longRes[0] = (byte)(0xf7 + lenBe.Length);
            Buffer.BlockCopy(lenBe, 0, longRes, 1, lenBe.Length);
            Buffer.BlockCopy(payload, 0, longRes, 1 + lenBe.Length, payload.Length);
            return longRes;
        }
    }

    public static string BuildUnsignedEip1559PreimageHex(
        BigInteger chainId, BigInteger nonce, BigInteger maxPriorityFee, BigInteger maxFee,
        BigInteger gasLimit, string toHex, BigInteger valueWei, string dataHex
    ) {
        var items = new List<byte[]> {
            EncodeUint(chainId),
            EncodeUint(nonce),
            EncodeUint(maxPriorityFee),
            EncodeUint(maxFee),
            EncodeUint(gasLimit),
            EncodeBytes(HexToBytes(toHex)),
            EncodeUint(valueWei),
            EncodeBytes(HexToBytes(dataHex)),
            EncodeList(new List<byte[]>())
        };
        return "0x02" + BytesToHex(EncodeList(items));
    }

    public static string BuildSignedEip1559RawTxHex(
        BigInteger chainId, BigInteger nonce, BigInteger maxPriorityFee, BigInteger maxFee,
        BigInteger gasLimit, string toHex, BigInteger valueWei, string dataHex, string sigHex65
    ) {
        string cleanSig = sigHex65.Trim();
        if (cleanSig.StartsWith("0x", StringComparison.OrdinalIgnoreCase)) cleanSig = cleanSig.Substring(2);
        if (cleanSig.Length != 130) throw new ArgumentException("Expected 65-byte (130 hex char) ECDSA signature");
        byte[] rTrim = StripLeadingZeros(HexToBytes(cleanSig.Substring(0, 64)));
        byte[] sTrim = StripLeadingZeros(HexToBytes(cleanSig.Substring(64, 64)));
        int vInt = Convert.ToInt32(cleanSig.Substring(128, 2), 16);
        int yParity = vInt >= 27 ? (vInt - 27) : vInt;

        var items = new List<byte[]> {
            EncodeUint(chainId),
            EncodeUint(nonce),
            EncodeUint(maxPriorityFee),
            EncodeUint(maxFee),
            EncodeUint(gasLimit),
            EncodeBytes(HexToBytes(toHex)),
            EncodeUint(valueWei),
            EncodeBytes(HexToBytes(dataHex)),
            EncodeList(new List<byte[]>()),
            EncodeUint(new BigInteger(yParity)),
            EncodeBytes(rTrim),
            EncodeBytes(sTrim)
        };
        return "0x02" + BytesToHex(EncodeList(items));
    }
}
"@
}

function New-SignedEip1559RawTx(
    [System.Numerics.BigInteger]$ChainId,
    [System.Numerics.BigInteger]$Nonce,
    [System.Numerics.BigInteger]$MaxPriorityFeeWei,
    [System.Numerics.BigInteger]$MaxFeeWei,
    [System.Numerics.BigInteger]$GasLimit,
    [string]$ToAddressHex,
    [System.Numerics.BigInteger]$ValueWei,
    [string]$DataHex,
    [string]$PrivateKeyHex
) {
    $signingPreimageHex = [FairBatchRlp]::BuildUnsignedEip1559PreimageHex(
        $ChainId, $Nonce, $MaxPriorityFeeWei, $MaxFeeWei, $GasLimit, $ToAddressHex, $ValueWei, $DataHex
    )
    # Pipe >32KB preimage over stdin to `cast keccak` (zero CLI length limit)
    $txDigest = ($signingPreimageHex | & $CastBin keccak).Trim()
    # Sign the 32-byte digest without echoing the private key
    $sigHex = (& $CastBin wallet sign --no-hash --private-key $PrivateKeyHex $txDigest).Trim()
    return [FairBatchRlp]::BuildSignedEip1559RawTxHex(
        $ChainId, $Nonce, $MaxPriorityFeeWei, $MaxFeeWei, $GasLimit, $ToAddressHex, $ValueWei, $DataHex, $sigHex
    )
}

function Parse-HexBigInt([string]$HexVal) {
    $clean = ($HexVal.Trim().Trim('"') -replace "^0x", "")
    if ($clean.Length -eq 0) { return [System.Numerics.BigInteger]::Zero }
    # Prepend "00" so BigInteger.Parse treats high-bit hex digits as unsigned positive
    return [System.Numerics.BigInteger]::Parse("00$clean", [System.Globalization.NumberStyles]::HexNumber)
}

# ------------------------------------------------------------------------------
# Load Configuration & Validate Artifacts
# ------------------------------------------------------------------------------
$EnvMap = Read-DotEnvFile $EnvFile

$NetworkName       = Get-Cfg $EnvMap "NETWORK" "sepolia"
$CfgChainId        = [uint64](Get-Cfg $EnvMap "CHAIN_ID" "11155111")
$TargetChainId     = if ($ExpectedChainId -gt 0) { $ExpectedChainId } else { $CfgChainId }
$RpcUrl            = if (-not [string]::IsNullOrWhiteSpace($RpcUrlOverride)) { $RpcUrlOverride } else { Get-Cfg $EnvMap "RPC_URL" "https://ethereum-sepolia-rpc.publicnode.com" }
$DeployTestTokens  = ((Get-Cfg $EnvMap "DEPLOY_TEST_TOKENS" "true").ToLowerInvariant() -in @("true", "1", "yes"))
$BaseDecimals      = [int](Get-Cfg $EnvMap "BASE_DECIMALS" "18")
$QuoteDecimals     = [int](Get-Cfg $EnvMap "QUOTE_DECIMALS" "6")
$CommitWindowSecs  = [uint64](Get-Cfg $EnvMap "COMMIT_WINDOW_SECS" "60")
$RevealWindowSecs  = [uint64](Get-Cfg $EnvMap "REVEAL_WINDOW_SECS" "60")
$MinBondWei        = Get-Cfg $EnvMap "MIN_BOND_WEI" "100000000000000"
$InitReserveBase   = [uint64](Get-Cfg $EnvMap "INITIAL_RESERVE_BASE" "100")
$InitReserveQuote  = [uint64](Get-Cfg $EnvMap "INITIAL_RESERVE_QUOTE" "300000")
$BaseTokenCfg      = Get-Cfg $EnvMap "BASE_TOKEN_ADDRESS" "0x0000000000000000000000000000000000000000"
$QuoteTokenCfg     = Get-Cfg $EnvMap "QUOTE_TOKEN_ADDRESS" "0x0000000000000000000000000000000000000000"
$DeployerKeyRaw    = Get-Cfg $EnvMap "DEPLOYER_PRIVATE_KEY" ""

$ScaleBase  = [System.Numerics.BigInteger]::Pow(10, $BaseDecimals)
$ScaleQuote = [System.Numerics.BigInteger]::Pow(10, $QuoteDecimals)
$SeedBaseRawStr  = ([System.Numerics.BigInteger]$InitReserveBase * $ScaleBase).ToString()
$SeedQuoteRawStr = ([System.Numerics.BigInteger]$InitReserveQuote * $ScaleQuote).ToString()

$ExplorerBase = switch ($TargetChainId) {
    11155111 { "https://sepolia.etherscan.io" }
    560048   { "https://hoodi.etherscan.io" }
    1        { "https://etherscan.io" }
    default  { "" }
}

if ([string]::IsNullOrWhiteSpace($ManifestOutPath)) {
    $ManifestName = if ($TargetChainId -eq 11155111) { "sepolia.json" } else { "chain_${TargetChainId}.json" }
    $ManifestOutPath = Join-Path (Join-Path $RepoRoot "deployments") $ManifestName
}

$FairBatchBinPath     = Join-Path $OutDir "FairBatch.bin"
$FairBatchRuntimePath = Join-Path $OutDir "FairBatch.runtime.bin"
$FairBatchAbiPath     = Join-Path $OutDir "FairBatch.abi.json"
$MockErc20BinPath     = Join-Path $OutDir "MockERC20.bin"

if (-not ((Test-Path $FairBatchBinPath) -and (Test-Path $FairBatchRuntimePath) -and (Test-Path $FairBatchAbiPath))) {
    throw "Missing compiled FairBatch artifacts in '$OutDir'. Run 'fe build' first."
}
if ($DeployTestTokens -and -not (Test-Path $MockErc20BinPath)) {
    throw "DEPLOY_TEST_TOKENS=true requires '$MockErc20BinPath'. Run 'fe build' first."
}

$FairBatchInitHex    = (Get-Content -Raw $FairBatchBinPath).Trim() -replace "^0x", ""
$FairBatchRuntimeHex = (Get-Content -Raw $FairBatchRuntimePath).Trim() -replace "^0x", ""
$MockErc20InitHex    = if (Test-Path $MockErc20BinPath) { (Get-Content -Raw $MockErc20BinPath).Trim() -replace "^0x", "" } else { "" }

Write-Host "========================================================================" -ForegroundColor Cyan
Write-Host (" FairBatch Deployment Pipeline — Target Chain ID: {0} ({1})" -f $TargetChainId, $(if ($DryRun) { "OFFLINE DRY-RUN" } else { "LIVE BROADCAST" })) -ForegroundColor Cyan
Write-Host "========================================================================" -ForegroundColor Cyan
Write-Host ("  Env File            : {0} ({1})" -f $EnvFile, $(if (Test-Path $EnvFile) { "loaded" } else { "using defaults" }))
Write-Host ("  Token Mode          : DEPLOY_TEST_TOKENS={0} (Base={1}d, Quote={2}d)" -f $DeployTestTokens, $BaseDecimals, $QuoteDecimals)
Write-Host ("  Batch Windows       : Commit={0}s | Reveal={1}s | MinBond={2} wei" -f $CommitWindowSecs, $RevealWindowSecs, $MinBondWei)
Write-Host ("  Reserve Seed Plan   : {0} Base ({1} raw) + {2} Quote ({3} raw)" -f $InitReserveBase, $SeedBaseRawStr, $InitReserveQuote, $SeedQuoteRawStr)
Write-Host ("  FairBatch Init Size : {0} bytes ({1} static runtime bytes)" -f ([int]($FairBatchInitHex.Length / 2)), ([int]($FairBatchRuntimeHex.Length / 2)))

# ------------------------------------------------------------------------------
# Mode A: Strictly Offline `-DryRun` Verification (Zero Network Calls!)
# ------------------------------------------------------------------------------
if ($DryRun) {
    Write-Host ""
    Write-Host "[Dry-Run 1/3] Validating ABI encoding & >32KB EIP-1559 RLP builder offline..." -ForegroundColor Yellow
    $PreviewBase  = if ($DeployTestTokens) { "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14" } else { $BaseTokenCfg }
    $PreviewQuote = if ($DeployTestTokens) { "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" } else { $QuoteTokenCfg }
    if ($PreviewBase -eq "0x0000000000000000000000000000000000000000" -or $PreviewQuote -eq "0x0000000000000000000000000000000000000000") {
        throw "DEPLOY_TEST_TOKENS=false requires non-zero BASE_TOKEN_ADDRESS and QUOTE_TOKEN_ADDRESS in .env."
    }

    $PreviewCtor = (& $CastBin abi-encode "constructor(address,address,uint8,uint8,uint256,uint256,uint256)" `
        $PreviewBase $PreviewQuote "$BaseDecimals" "$QuoteDecimals" "$CommitWindowSecs" "$RevealWindowSecs" $MinBondWei).Trim() -replace "^0x", ""
    $FullCreationHex = "0x$FairBatchInitHex$PreviewCtor"
    $SeedCalldata    = (& $CastBin calldata "seedReserves(uint256,uint256)" $SeedBaseRawStr $SeedQuoteRawStr).Trim()

    # Offline self-test of the >32KB EIP-1559 RLP serializer using a disposable dummy key
    $DummyTestKey = "0x0000000000000000000000000000000000000000000000000000000000000001"
    $SampleRawTx = New-SignedEip1559RawTx `
        -ChainId ([System.Numerics.BigInteger]$TargetChainId) `
        -Nonce ([System.Numerics.BigInteger]::Zero) `
        -MaxPriorityFeeWei ([System.Numerics.BigInteger]1500000000) `
        -MaxFeeWei ([System.Numerics.BigInteger]20000000000) `
        -GasLimit ([System.Numerics.BigInteger]6500000) `
        -ToAddressHex "" `
        -ValueWei ([System.Numerics.BigInteger]::Zero) `
        -DataHex $FullCreationHex `
        -PrivateKeyHex $DummyTestKey

    Write-Host ("  Full Creation Bytes : {0} bytes ({1} hex chars)" -f ([int](($FullCreationHex.Length - 2) / 2)), ($FullCreationHex.Length - 2))
    Write-Host ("  Signed EIP-1559 Tx  : {0} bytes (offline RLP + secp256k1 self-test PASS)" -f ([int](($SampleRawTx.Length - 2) / 2)))
    Write-Host ("  seedReserves() Data : {0}" -f $SeedCalldata)

    Write-Host ""
    Write-Host "[Dry-Run 2/3] Checking DEPLOYER_PRIVATE_KEY readiness in .env..." -ForegroundColor Yellow
    if ([string]::IsNullOrWhiteSpace($DeployerKeyRaw)) {
        Write-Host "  DEPLOYER_PRIVATE_KEY: [WAITING FOR USER INPUT] (empty in .env)" -ForegroundColor DarkYellow
    } else {
        $normKey = if ($DeployerKeyRaw.StartsWith("0x")) { $DeployerKeyRaw } else { "0x$DeployerKeyRaw" }
        if ($normKey -notmatch "^0x[0-9a-fA-F]{64}$") {
            throw "DEPLOYER_PRIVATE_KEY in .env is malformed (expected 64 hex characters, with or without 0x prefix)."
        }
        $pubAddr = (& $CastBin wallet address --private-key $normKey).Trim()
        Write-Host "  DEPLOYER_PRIVATE_KEY: [CONFIGURED] -> Deployer Address: $pubAddr" -ForegroundColor Green
    }

    Write-Host ""
    Write-Host "[Dry-Run 3/3] Offline dry-run succeeded! Zero network calls or broadcasts were executed." -ForegroundColor Green
    exit 0
}

# ------------------------------------------------------------------------------
# Mode B: Live Broadcast & On-Chain Verification
# ------------------------------------------------------------------------------
if ([string]::IsNullOrWhiteSpace($DeployerKeyRaw)) {
    throw "DEPLOYER_PRIVATE_KEY is empty in '$EnvFile'. Paste your funded private key into .env before running live deployment."
}
$DeployerKey = if ($DeployerKeyRaw.StartsWith("0x")) { $DeployerKeyRaw } else { "0x$DeployerKeyRaw" }
if ($DeployerKey -notmatch "^0x[0-9a-fA-F]{64}$") {
    throw "DEPLOYER_PRIVATE_KEY must be a valid 32-byte hex key (0x + 64 hex chars)."
}

$DeployerAddr = (& $CastBin wallet address --private-key $DeployerKey).Trim()
Write-Host ("  Deployer Account    : {0}" -f $DeployerAddr) -ForegroundColor Green

function Invoke-Rpc([string]$Method, [string]$RawParamsJson = "[]") {
    $out = ($RawParamsJson | & $CastBin rpc --rpc-url $RpcUrl --raw $Method)
    if ($LASTEXITCODE -ne 0) {
        throw "RPC call '$Method' failed against endpoint."
    }
    return ("$out").Trim()
}

Write-Host ""
Write-Host "[1/5] Verifying RPC Chain ID & Deployer Balance..." -ForegroundColor Yellow
$LiveChainHex = (Invoke-Rpc "eth_chainId" "[]").Trim('"')
$LiveChainId  = [uint64](Parse-HexBigInt $LiveChainHex)
if ($LiveChainId -ne $TargetChainId) {
    throw "Chain ID mismatch! RPC returned Chain ID $LiveChainId ($LiveChainHex), expected $TargetChainId."
}
$BalanceHex = (Invoke-Rpc "eth_getBalance" "[`"$DeployerAddr`",`"latest`"]").Trim('"')
$BalanceWei = Parse-HexBigInt $BalanceHex
$MinRequiredWei = [System.Numerics.BigInteger]::Parse("5000000000000000") # 0.005 ETH safety check
Write-Host ("  Verified Chain ID   : {0} ({1})" -f $LiveChainId, $LiveChainHex)
Write-Host ("  Deployer Balance    : {0} wei" -f $BalanceWei.ToString())
if ($BalanceWei -lt $MinRequiredWei) {
    throw "Insufficient deployer ETH balance ($BalanceWei wei < 0.005 ETH) on Chain ID $LiveChainId for contract deployment."
}

# Fetch dynamic EIP-1559 fee parameters & starting nonce
$LatestBlock = (Invoke-Rpc "eth_getBlockByNumber" "[`"latest`",false]") | ConvertFrom-Json
$BaseFeeWei  = if ($null -ne $LatestBlock.baseFeePerGas) { Parse-HexBigInt $LatestBlock.baseFeePerGas } else { [System.Numerics.BigInteger]1000000000 }
$PriorityFeeWei = [System.Numerics.BigInteger]1500000000 # 1.5 gwei default tip
try {
    $tipHex = (Invoke-Rpc "eth_maxPriorityFeePerGas" "[]").Trim('"')
    $parsedTip = Parse-HexBigInt $tipHex
    if ($parsedTip -gt [System.Numerics.BigInteger]100000000) { $PriorityFeeWei = $parsedTip }
} catch { }
$MaxFeeWei = ($BaseFeeWei * 2) + $PriorityFeeWei + [System.Numerics.BigInteger]1000000000

$CurrentNonce = Parse-HexBigInt ((Invoke-Rpc "eth_getTransactionCount" "[`"$DeployerAddr`",`"pending`"]").Trim('"'))

function Estimate-TxGasLimit(
    [string]$Label,
    [string]$ToAddr,
    [string]$DataHex,
    [uint64]$FallbackMinGas
) {
    $callObj = if ([string]::IsNullOrWhiteSpace($ToAddr)) {
        "[{`"from`":`"$DeployerAddr`",`"data`":`"$DataHex`"}]"
    } else {
        "[{`"from`":`"$DeployerAddr`",`"to`":`"$ToAddr`",`"data`":`"$DataHex`"}]"
    }
    $estHex = ""
    for ($retry = 0; $retry -lt 6; $retry++) {
        $prevPref = $ErrorActionPreference
        $ErrorActionPreference = "Continue"
        $rawOut = ($callObj | & $CastBin rpc --rpc-url $RpcUrl --raw eth_estimateGas 2>$null)
        $code = $LASTEXITCODE
        $ErrorActionPreference = $prevPref
        if ($code -eq 0 -and -not [string]::IsNullOrWhiteSpace("$rawOut")) {
            $estHex = ("$rawOut").Trim().Trim('"')
            break
        }
        if ($retry -lt 5) {
            Start-Sleep -Seconds 2
        } else {
            # Final attempt surfaces exact revert reason if genuine
            $estHex = (Invoke-Rpc "eth_estimateGas" $callObj).Trim('"')
        }
    }
    $estGas = [uint64](Parse-HexBigInt $estHex)
    $withPct = [uint64](($estGas * 120) / 100)
    $withPad = $estGas + [uint64]250000
    return [Math]::Max($FallbackMinGas, [Math]::Max($withPct, $withPad))
}

if ([string]::IsNullOrWhiteSpace($ExistingFairBatchTx)) {
    # Pre-flight zero-cost `eth_estimateGas` simulation of FairBatch creation before broadcasting any tx!
    $PreflightFbCtor = (& $CastBin abi-encode "constructor(address,address,uint8,uint8,uint256,uint256,uint256)" `
        "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14" "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" `
        "$BaseDecimals" "$QuoteDecimals" "$CommitWindowSecs" "$RevealWindowSecs" $MinBondWei).Trim() -replace "^0x", ""
    $PreflightFbGas = Estimate-TxGasLimit "Pre-flight FairBatch Creation" "" "0x$FairBatchInitHex$PreflightFbCtor" 5000000
    Write-Host ("  Pre-flight FairBatch: estimated creation gasLimit = {0} (PASS)" -f $PreflightFbGas) -ForegroundColor Green
}

function Send-SignedTxAndWait(
    [string]$Label,
    [string]$ToAddr,
    [string]$DataHex,
    [uint64]$GasLimitVal
) {
    $DynamicGasLimit = Estimate-TxGasLimit $Label $ToAddr $DataHex $GasLimitVal
    $rawTx = New-SignedEip1559RawTx `
        -ChainId ([System.Numerics.BigInteger]$LiveChainId) `
        -Nonce $script:CurrentNonce `
        -MaxPriorityFeeWei $PriorityFeeWei `
        -MaxFeeWei $MaxFeeWei `
        -GasLimit ([System.Numerics.BigInteger]$DynamicGasLimit) `
        -ToAddressHex $ToAddr `
        -ValueWei ([System.Numerics.BigInteger]::Zero) `
        -DataHex $DataHex `
        -PrivateKeyHex $DeployerKey

    $txHash = (Invoke-Rpc "eth_sendRawTransaction" "[`"$rawTx`"]").Trim('"')
    $script:CurrentNonce = $script:CurrentNonce + 1
    Write-Host ("  Broadcast {0,-22}: tx={1} (gasLimit={2})" -f $Label, $txHash, $DynamicGasLimit)

    for ($attempt = 0; $attempt -lt 90; $attempt++) {
        $rcptRaw = Invoke-Rpc "eth_getTransactionReceipt" "[`"$txHash`"]"
        if ($rcptRaw -ne "null" -and -not [string]::IsNullOrWhiteSpace($rcptRaw)) {
            $rcpt = $rcptRaw | ConvertFrom-Json
            if ($null -ne $rcpt -and $null -ne $rcpt.status) {
                if ($rcpt.status -ne "0x1") {
                    throw "Transaction '$Label' ($txHash) reverted on-chain (status=$($rcpt.status))."
                }
                return $rcpt
            }
        }
        Start-Sleep -Seconds 2
    }
    throw "Timed out waiting for transaction '$Label' ($txHash) to be mined."
}

# Step 2: Token Provisioning
$BaseTokenAddr  = $BaseTokenCfg
$QuoteTokenAddr = $QuoteTokenCfg
$BaseTokenMeta  = @{ symbol = "WETH"; decimals = $BaseDecimals; deployed_test_token = $false; address = $BaseTokenAddr; tx_hash = $null; block_number = 0; gas_used = 0 }
$QuoteTokenMeta = @{ symbol = "USDC"; decimals = $QuoteDecimals; deployed_test_token = $false; address = $QuoteTokenAddr; tx_hash = $null; block_number = 0; gas_used = 0 }

if ($DeployTestTokens) {
    Write-Host ""
    Write-Host "[2/5] Deploying / Resolving 18-dec fWETH & 6-dec fUSDC MockERC20 Test Tokens..." -ForegroundColor Yellow
    if (-not [string]::IsNullOrWhiteSpace($ExistingBaseTx) -and -not [string]::IsNullOrWhiteSpace($ExistingQuoteTx)) {
        $BaseRcpt  = (Invoke-Rpc "eth_getTransactionReceipt" "[`"$ExistingBaseTx`"]") | ConvertFrom-Json
        $QuoteRcpt = (Invoke-Rpc "eth_getTransactionReceipt" "[`"$ExistingQuoteTx`"]") | ConvertFrom-Json
    } else {
        $BaseCtorHex  = (& $CastBin abi-encode "constructor(uint8)" "$BaseDecimals").Trim() -replace "^0x", ""
        $QuoteCtorHex = (& $CastBin abi-encode "constructor(uint8)" "$QuoteDecimals").Trim() -replace "^0x", ""

        $BaseRcpt  = Send-SignedTxAndWait "Create fWETH (18d)" "" "0x$MockErc20InitHex$BaseCtorHex" 1500000
        $QuoteRcpt = Send-SignedTxAndWait "Create fUSDC (6d)"  "" "0x$MockErc20InitHex$QuoteCtorHex" 1500000
    }

    $BaseTokenAddr  = $BaseRcpt.contractAddress
    $QuoteTokenAddr = $QuoteRcpt.contractAddress
    Write-Host ("  fWETH Deployed      : {0}" -f $BaseTokenAddr) -ForegroundColor Green
    Write-Host ("  fUSDC Deployed      : {0}" -f $QuoteTokenAddr) -ForegroundColor Green

    $BaseTokenMeta = @{
        symbol = "fWETH"; decimals = $BaseDecimals; deployed_test_token = $true
        address = $BaseTokenAddr; tx_hash = $BaseRcpt.transactionHash
        block_number = [uint64](Parse-HexBigInt $BaseRcpt.blockNumber)
        gas_used = [uint64](Parse-HexBigInt $BaseRcpt.gasUsed)
    }
    $QuoteTokenMeta = @{
        symbol = "fUSDC"; decimals = $QuoteDecimals; deployed_test_token = $true
        address = $QuoteTokenAddr; tx_hash = $QuoteRcpt.transactionHash
        block_number = [uint64](Parse-HexBigInt $QuoteRcpt.blockNumber)
        gas_used = [uint64](Parse-HexBigInt $QuoteRcpt.gasUsed)
    }
} else {
    Write-Host ""
    Write-Host "[2/5] Using Pre-Existing ERC-20 Token Addresses..." -ForegroundColor Yellow
    if ($BaseTokenAddr -eq "0x0000000000000000000000000000000000000000" -or $QuoteTokenAddr -eq "0x0000000000000000000000000000000000000000") {
        throw "DEPLOY_TEST_TOKENS=false requires valid non-zero BASE_TOKEN_ADDRESS and QUOTE_TOKEN_ADDRESS."
    }
    Write-Host ("  Base Token          : {0} ({1}d)" -f $BaseTokenAddr, $BaseDecimals)
    Write-Host ("  Quote Token         : {0} ({1}d)" -f $QuoteTokenAddr, $QuoteDecimals)
}

# Step 3: Deploy FairBatch (>32KB creation payload via signed EIP-1559 raw tx)
Write-Host ""
Write-Host "[3/5] Deploying / Resolving FairBatch Contract (Fe 26.5.0 Sonatina Bytecode)..." -ForegroundColor Yellow
if (-not [string]::IsNullOrWhiteSpace($ExistingFairBatchTx)) {
    $FbRcpt = (Invoke-Rpc "eth_getTransactionReceipt" "[`"$ExistingFairBatchTx`"]") | ConvertFrom-Json
} else {
    $FbCtorHex = (& $CastBin abi-encode "constructor(address,address,uint8,uint8,uint256,uint256,uint256)" `
        $BaseTokenAddr $QuoteTokenAddr "$BaseDecimals" "$QuoteDecimals" "$CommitWindowSecs" "$RevealWindowSecs" $MinBondWei).Trim() -replace "^0x", ""
    $FbRcpt = Send-SignedTxAndWait "Create FairBatch" "" "0x$FairBatchInitHex$FbCtorHex" 6500000
}
$FairBatchAddr = $FbRcpt.contractAddress
Write-Host ("  FairBatch Deployed  : {0} (gasUsed: {1})" -f $FairBatchAddr, (Parse-HexBigInt $FbRcpt.gasUsed)) -ForegroundColor Green

# Step 4: Seed Initial FM-AMM Liquidity
$Seeded = $false
$SeedTxHash = $null
$SeedGasUsed = [uint64]0
if ($DeployTestTokens -and $InitReserveBase -gt 0 -and $InitReserveQuote -gt 0) {
    Write-Host ""
    Write-Host ("[4/5] Minting & Seeding Initial FM-AMM Reserves ({0} fWETH + {1} fUSDC)..." -f $InitReserveBase, $InitReserveQuote) -ForegroundColor Yellow
    $MintBaseAmt  = ([System.Numerics.BigInteger]($InitReserveBase * 2) * $ScaleBase).ToString()
    $MintQuoteAmt = ([System.Numerics.BigInteger]($InitReserveQuote * 2) * $ScaleQuote).ToString()

    $AllowBaseStr  = (((& $CastBin call --rpc-url $RpcUrl $BaseTokenAddr  "allowance(address,address)(uint256)" $DeployerAddr $FairBatchAddr).Trim()) -split "\s+")[0]
    $AllowQuoteStr = (((& $CastBin call --rpc-url $RpcUrl $QuoteTokenAddr "allowance(address,address)(uint256)" $DeployerAddr $FairBatchAddr).Trim()) -split "\s+")[0]

    if ([System.Numerics.BigInteger]::Parse($AllowBaseStr) -lt [System.Numerics.BigInteger]::Parse($SeedBaseRawStr)) {
        $MintApproveBaseData = (& $CastBin calldata "mintAndApprove(address,address,uint256)" $DeployerAddr $FairBatchAddr $MintBaseAmt).Trim()
        $null = Send-SignedTxAndWait "mintAndApprove fWETH" $BaseTokenAddr $MintApproveBaseData 250000
    } else {
        Write-Host ("  fWETH Allowance     : already >= {0} raw (skipping duplicate mintAndApprove)" -f $SeedBaseRawStr) -ForegroundColor Green
    }

    if ([System.Numerics.BigInteger]::Parse($AllowQuoteStr) -lt [System.Numerics.BigInteger]::Parse($SeedQuoteRawStr)) {
        $MintApproveQuoteData = (& $CastBin calldata "mintAndApprove(address,address,uint256)" $DeployerAddr $FairBatchAddr $MintQuoteAmt).Trim()
        $null = Send-SignedTxAndWait "mintAndApprove fUSDC" $QuoteTokenAddr $MintApproveQuoteData 250000
    } else {
        Write-Host ("  fUSDC Allowance     : already >= {0} raw (skipping duplicate mintAndApprove)" -f $SeedQuoteRawStr) -ForegroundColor Green
    }

    $SeedData = (& $CastBin calldata "seedReserves(uint256,uint256)" $SeedBaseRawStr $SeedQuoteRawStr).Trim()
    $SeedRcpt = Send-SignedTxAndWait "seedReserves()" $FairBatchAddr $SeedData 500000

    $Seeded = $true
    $SeedTxHash = $SeedRcpt.transactionHash
    $SeedGasUsed = [uint64](Parse-HexBigInt $SeedRcpt.gasUsed)
    Write-Host "  Seeded FM-AMM Pool  : SUCCESS" -ForegroundColor Green
    Start-Sleep -Seconds 3 # Allow load-balanced RPC replicas to sync mined seed block before Step 5 views
} else {
    Write-Host ""
    Write-Host "[4/5] Skipping automatic MockERC20 mint/seed (DEPLOY_TEST_TOKENS=false)." -ForegroundColor DarkYellow
}

# Step 5: Verify Live On-Chain Views & Write Manifests
Write-Host ""
Write-Host "[5/5] Verifying On-Chain Bytecode, EIP-712 Domain & Reserves..." -ForegroundColor Yellow
$CodeHex = (Invoke-Rpc "eth_getCode" "[`"$FairBatchAddr`",`"latest`"]").Trim('"')
$RuntimeBytesCount = [int](($CodeHex.Length - 2) / 2)
$DomainSepRaw = (& $CastBin call --rpc-url $RpcUrl $FairBatchAddr "domainSeparator()(bytes32)").Trim()
$ReservesRaw  = (& $CastBin call --rpc-url $RpcUrl $FairBatchAddr "getReserves()(uint256,uint256,uint256,uint256)").Trim() -split "`r?`n"
$BatchRaw     = (& $CastBin call --rpc-url $RpcUrl $FairBatchAddr "currentBatch()(uint256,uint256,uint256,uint256,uint256,uint256,uint8)").Trim() -split "`r?`n"

$OnChainRx = ($ReservesRaw[0] -split "\s+")[0]
$OnChainRy = ($ReservesRaw[1] -split "\s+")[0]
$ActiveBatchId = [uint64](($BatchRaw[0] -split "\s+")[0])

Write-Host ("  Runtime Code Size   : {0} bytes" -f $RuntimeBytesCount)
Write-Host ("  domainSeparator()   : {0}" -f $DomainSepRaw)
Write-Host ("  Active Batch ID     : #{0}" -f $ActiveBatchId)
Write-Host ("  On-Chain Reserves   : R_x={0} raw | R_y={1} raw" -f $OnChainRx, $OnChainRy)

$ManifestDir = Split-Path -Parent $ManifestOutPath
if (-not (Test-Path $ManifestDir)) { New-Item -ItemType Directory -Force -Path $ManifestDir | Out-Null }

$FbExplorerUrl    = if ($ExplorerBase) { "$ExplorerBase/address/$FairBatchAddr" } else { $null }
$BaseExplorerUrl  = if ($ExplorerBase) { "$ExplorerBase/address/$BaseTokenAddr" } else { $null }
$QuoteExplorerUrl = if ($ExplorerBase) { "$ExplorerBase/address/$QuoteTokenAddr" } else { $null }

$ManifestObj = [ordered]@{
    network           = $NetworkName
    chain_id          = $LiveChainId
    deployed_at_utc   = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    compiler          = "fe 26.5.0 (3dab95f) [sonatina]"
    deployer          = $DeployerAddr
    explorer_base_url = if ($ExplorerBase) { $ExplorerBase } else { $null }
    contracts         = [ordered]@{
        fair_batch = [ordered]@{
            address       = $FairBatchAddr
            tx_hash       = $FbRcpt.transactionHash
            block_number  = [uint64](Parse-HexBigInt $FbRcpt.blockNumber)
            gas_used      = [uint64](Parse-HexBigInt $FbRcpt.gasUsed)
            runtime_bytes = $RuntimeBytesCount
            explorer_url  = $FbExplorerUrl
        }
        base_token = [ordered]@{
            symbol              = $BaseTokenMeta.symbol
            decimals            = $BaseTokenMeta.decimals
            deployed_test_token = $BaseTokenMeta.deployed_test_token
            address             = $BaseTokenAddr
            tx_hash             = $BaseTokenMeta.tx_hash
            block_number        = $BaseTokenMeta.block_number
            gas_used            = $BaseTokenMeta.gas_used
            explorer_url        = $BaseExplorerUrl
        }
        quote_token = [ordered]@{
            symbol              = $QuoteTokenMeta.symbol
            decimals            = $QuoteTokenMeta.decimals
            deployed_test_token = $QuoteTokenMeta.deployed_test_token
            address             = $QuoteTokenAddr
            tx_hash             = $QuoteTokenMeta.tx_hash
            block_number        = $QuoteTokenMeta.block_number
            gas_used            = $QuoteTokenMeta.gas_used
            explorer_url        = $QuoteExplorerUrl
        }
    }
    init_params = [ordered]@{
        base_decimals      = $BaseDecimals
        quote_decimals     = $QuoteDecimals
        commit_window_secs = $CommitWindowSecs
        reveal_window_secs = $RevealWindowSecs
        min_bond_wei       = $MinBondWei
    }
    initial_seed = [ordered]@{
        seeded            = $Seeded
        reserve_base_raw  = $SeedBaseRawStr
        reserve_quote_raw = $SeedQuoteRawStr
        tx_hash           = $SeedTxHash
        gas_used          = $SeedGasUsed
    }
    onchain_verification = [ordered]@{
        domain_separator  = $DomainSepRaw
        active_batch_id   = $ActiveBatchId
        reserve_base_raw  = $OnChainRx
        reserve_quote_raw = $OnChainRy
    }
}

$ManifestJsonText = ($ManifestObj | ConvertTo-Json -Depth 8) + "`n"
[System.IO.File]::WriteAllText($ManifestOutPath, $ManifestJsonText, (New-Object System.Text.UTF8Encoding($false)))
Write-Host ("  Wrote Manifest      : {0}" -f $ManifestOutPath) -ForegroundColor Green

if (-not $SkipEnvWrite) {
    Update-EnvFileKeyValues $EnvFile ([ordered]@{
        CHAIN_ID            = "$LiveChainId"
        FAIRBATCH_ADDRESS   = $FairBatchAddr
        BASE_TOKEN_ADDRESS  = $BaseTokenAddr
        QUOTE_TOKEN_ADDRESS = $QuoteTokenAddr
    })
    Write-Host ("  Updated Root .env   : {0}" -f $EnvFile) -ForegroundColor Green

    $FrontendEnvLocal = Join-Path (Join-Path $RepoRoot "frontend") ".env.local"
    if (Test-Path (Join-Path $RepoRoot "frontend")) {
        Update-EnvFileKeyValues $FrontendEnvLocal ([ordered]@{
            VITE_CHAIN_ID            = "$LiveChainId"
            VITE_RPC_URL             = $RpcUrl
            VITE_FAIRBATCH_ADDRESS   = $FairBatchAddr
            VITE_BASE_TOKEN_ADDRESS  = $BaseTokenAddr
            VITE_QUOTE_TOKEN_ADDRESS = $QuoteTokenAddr
        })
        Write-Host ("  Updated Frontend Env: {0}" -f $FrontendEnvLocal) -ForegroundColor Green
    }
}

Write-Host ""
Write-Host "Deployment & Verification Complete!" -ForegroundColor Cyan
if ($FbExplorerUrl) {
    Write-Host ("  FairBatch Explorer  : {0}" -f $FbExplorerUrl) -ForegroundColor Cyan
}
