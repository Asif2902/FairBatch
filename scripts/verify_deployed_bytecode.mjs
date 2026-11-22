#!/usr/bin/env node
/**
 * Bytecode Verification Script for FairBatch (Fe 26.5.0 / Sonatina)
 *
 * Compares the locally compiled runtime bytecode (`out/*.runtime.bin`) from the
 * current commit against live Ethereum Sepolia bytecode (`eth_getCode`) for
 * every contract listed in `config/deployment.json`.
 *
 * Explicit immutable-handling strategy:
 *   Fe 26.5.0 (Sonatina) appends constructor immutable values as a contiguous
 *   trailer immediately AFTER the static runtime bytecode (`out/*.runtime.bin`).
 *   This script verifies BOTH:
 *     1. Exact byte-for-byte static prefix equality:
 *          onchain[0 .. staticLen) === out/<Contract>.runtime.bin
 *     2. Exact byte-for-byte immutable trailer equality:
 *          onchain[staticLen .. totalLen) === reconstructed immutables from
 *          config/deployment.json (addresses, decimals, windows, bond, faucet
 *          params, and EIP-712 Domain + domainSeparator).
 *   Zero bytes are masked or skipped — 100% of every deployed byte is verified.
 *   Exits non-zero loudly on any mismatch, missing artifact, or RPC failure.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Minimal zero-dependency Keccak-256 (Ethereum / FIPS-202 pre-SHA3 padding 0x01)
// ---------------------------------------------------------------------------
const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
const RHO = [
  [0, 36, 3, 41, 18],
  [1, 44, 10, 45, 2],
  [62, 6, 43, 15, 61],
  [28, 55, 25, 21, 56],
  [27, 20, 39, 8, 14],
];
const MASK64 = 0xffffffffffffffffn;

function rotl64(x, n) {
  if (n === 0) return x;
  return ((x << BigInt(n)) | (x >> BigInt(64 - n))) & MASK64;
}

function keccakF1600(state) {
  for (let round = 0; round < 24; round += 1) {
    const c = new Array(5);
    for (let x = 0; x < 5; x += 1) {
      c[x] =
        state[x] ^
        state[x + 5] ^
        state[x + 10] ^
        state[x + 15] ^
        state[x + 20];
    }
    for (let x = 0; x < 5; x += 1) {
      const d = c[(x + 4) % 5] ^ rotl64(c[(x + 1) % 5], 1);
      for (let y = 0; y < 5; y += 1) state[x + 5 * y] ^= d;
    }
    const b = new Array(25);
    for (let x = 0; x < 5; x += 1) {
      for (let y = 0; y < 5; y += 1) {
        b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl64(state[x + 5 * y], RHO[x][y]);
      }
    }
    for (let x = 0; x < 5; x += 1) {
      for (let y = 0; y < 5; y += 1) {
        state[x + 5 * y] =
          b[x + 5 * y] ^ (~b[((x + 1) % 5) + 5 * y] & b[((x + 2) % 5) + 5 * y]);
      }
    }
    state[0] ^= RC[round];
  }
}

function keccak256Bytes(input) {
  const rate = 136; // 1088 bits
  const rem = input.length % rate;
  const padLen = rate - rem;
  const padded = new Uint8Array(input.length + padLen);
  padded.set(input);
  padded[input.length] ^= 0x01;
  padded[padded.length - 1] ^= 0x80;

  const state = new Array(25).fill(0n);
  for (let offset = 0; offset < padded.length; offset += rate) {
    for (let i = 0; i < rate / 8; i += 1) {
      let lane = 0n;
      for (let b = 0; b < 8; b += 1) {
        lane |= BigInt(padded[offset + i * 8 + b]) << BigInt(8 * b);
      }
      state[i] ^= lane;
    }
    keccakF1600(state);
  }

  const out = new Uint8Array(32);
  for (let i = 0; i < 4; i += 1) {
    let lane = state[i];
    for (let b = 0; b < 8; b += 1) {
      out[i * 8 + b] = Number((lane >> BigInt(8 * b)) & 0xffn);
    }
  }
  return Buffer.from(out).toString('hex');
}

function keccak256Utf8(text) {
  return keccak256Bytes(new TextEncoder().encode(text));
}

function keccak256Hex(hexNoPrefix) {
  return keccak256Bytes(Buffer.from(hexNoPrefix, 'hex'));
}

// ---------------------------------------------------------------------------
// Immutable trailer builders (matching Fe 26.5.0 Sonatina layout)
// ---------------------------------------------------------------------------
function padUint256(value) {
  const bi = BigInt(value);
  if (bi < 0n) throw new Error(`Negative uint256: ${value}`);
  return bi.toString(16).padStart(64, '0');
}

function padAddress(addr) {
  const clean = addr.toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{40}$/.test(clean)) {
    throw new Error(`Invalid Ethereum address: ${addr}`);
  }
  return clean.padStart(64, '0');
}

function byteHex(num) {
  const n = Number(num);
  if (!Number.isInteger(n) || n < 0 || n > 255) {
    throw new Error(`Invalid u8: ${num}`);
  }
  return n.toString(16).padStart(2, '0');
}

function buildMockErc20Trailer(decimals, owner) {
  // Fe layout: u8 decimals left-aligned in 32-byte slot + 32-byte owner address (64 bytes total)
  return byteHex(decimals) + '00'.repeat(31) + padAddress(owner);
}

function buildFaucetTrailer(cfg) {
  // Fe layout: 5 x 32-byte words (160 bytes total)
  return [
    padAddress(cfg.contracts.baseToken),
    padAddress(cfg.contracts.quoteToken),
    padUint256(cfg.faucet.claimBaseAmount),
    padUint256(cfg.faucet.claimQuoteAmount),
    padUint256(cfg.faucet.cooldownSecs),
  ].join('');
}

function buildFairBatchTrailer(cfg) {
  // Fe layout (352 bytes total):
  //   [0..32)    base_token (Address, 32B)
  //   [32..64)   quote_token (Address, 32B)
  //   [64..65)   base_decimals (u8, 1B)
  //   [65..66)   quote_decimals (u8, 1B)
  //   [66..98)   commit_duration (Duration / u256, 32B)
  //   [98..130)  reveal_duration (Duration / u256, 32B)
  //   [130..162) min_bond (Wei / u256, 32B)
  //   [162..192) 30 zero padding bytes (aligning EIP-712 Domain to 32B boundary)
  //   [192..224) Domain.name_hash    = keccak256("FairBatch")
  //   [224..256) Domain.version_hash = keccak256("1")
  //   [256..288) Domain.chain_id     = uint256(chainId)
  //   [288..320) Domain.verifying_contract = address(fairBatch)
  //   [320..352) Domain.separator    = keccak256(abi.encode(EIP712_DOMAIN_TYPEHASH, nameHash, versionHash, chainId, fairBatch))
  const domainTypehash = keccak256Utf8(
    'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)',
  );
  const nameHash = keccak256Utf8('FairBatch');
  const versionHash = keccak256Utf8('1');
  const chainIdWord = padUint256(cfg.chainId);
  const verifyingContractWord = padAddress(cfg.contracts.fairBatch);
  const domainSeparator = keccak256Hex(
    domainTypehash + nameHash + versionHash + chainIdWord + verifyingContractWord,
  );

  const hex = [
    padAddress(cfg.contracts.baseToken),
    padAddress(cfg.contracts.quoteToken),
    byteHex(cfg.tokens.base.decimals),
    byteHex(cfg.tokens.quote.decimals),
    padUint256(cfg.market.commitWindowSecs),
    padUint256(cfg.market.revealWindowSecs),
    padUint256(cfg.market.minBondWei),
    '00'.repeat(30),
    nameHash,
    versionHash,
    chainIdWord,
    verifyingContractWord,
    domainSeparator,
  ].join('');

  return { hex, domainSeparator: `0x${domainSeparator}` };
}

// ---------------------------------------------------------------------------
// JSON-RPC helpers with fallback
// ---------------------------------------------------------------------------
async function rpcCall(rpcUrls, method, params) {
  let lastError = null;
  for (const url of rpcUrls) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15_000);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} from ${url}`);
      }
      const payload = await res.json();
      if (payload.error) {
        throw new Error(`RPC error from ${url}: ${payload.error.message || JSON.stringify(payload.error)}`);
      }
      return { result: payload.result, rpcUrl: url };
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`All RPC endpoints failed for ${method}: ${lastError?.message || lastError}`);
}

function sha256Hex(hexNoPrefix) {
  return crypto.createHash('sha256').update(Buffer.from(hexNoPrefix, 'hex')).digest('hex');
}

function findFirstByteDiff(aHex, bHex) {
  const minNibbles = Math.min(aHex.length, bHex.length);
  for (let i = 0; i < minNibbles; i += 2) {
    if (aHex.slice(i, i + 2) !== bHex.slice(i, i + 2)) {
      return i / 2;
    }
  }
  if (aHex.length !== bHex.length) {
    return minNibbles / 2;
  }
  return -1;
}

export function compareContractBytecode({
  label,
  artifactName,
  address,
  staticHex,
  expectedTrailerHex,
  onchainHex,
}) {
  const cleanStatic = staticHex.trim().replace(/^0x/i, '').toLowerCase();
  const cleanTrailer = expectedTrailerHex.trim().replace(/^0x/i, '').toLowerCase();
  const cleanChain = onchainHex.trim().replace(/^0x/i, '').toLowerCase();

  const staticBytes = cleanStatic.length / 2;
  const trailerBytes = cleanTrailer.length / 2;
  const expectedFull = cleanStatic + cleanTrailer;
  const expectedBytes = expectedFull.length / 2;
  const onchainBytes = cleanChain.length / 2;

  if (onchainBytes === 0) {
    return {
      ok: false,
      label,
      artifactName,
      address,
      reason: 'No bytecode deployed at address (eth_getCode returned 0x).',
    };
  }

  const chainPrefix = cleanChain.slice(0, cleanStatic.length);
  const chainTrailer = cleanChain.slice(cleanStatic.length);
  const prefixDiffOffset = findFirstByteDiff(cleanStatic, chainPrefix);
  const trailerDiffOffset = findFirstByteDiff(cleanTrailer, chainTrailer);
  const lengthMatch = onchainBytes === expectedBytes;
  const staticPrefixMatch = prefixDiffOffset === -1 && onchainBytes >= staticBytes;
  const immutableTrailerMatch = trailerDiffOffset === -1 && lengthMatch;
  const ok = staticPrefixMatch && immutableTrailerMatch;

  let reason = null;
  if (!staticPrefixMatch) {
    const off = prefixDiffOffset;
    reason = `Static runtime prefix mismatch at byte offset ${off}: local=0x${cleanStatic.slice(off * 2, off * 2 + 16)} vs on-chain=0x${chainPrefix.slice(off * 2, off * 2 + 16)}`;
  } else if (!lengthMatch) {
    reason = `Bytecode length mismatch: expected ${expectedBytes} bytes (${staticBytes} static + ${trailerBytes} immutables), got ${onchainBytes} bytes on-chain`;
  } else if (!immutableTrailerMatch) {
    const off = trailerDiffOffset;
    reason = `Immutable trailer mismatch at trailer offset ${off} (deployed offset ${staticBytes + off}): expected=0x${cleanTrailer.slice(off * 2, off * 2 + 16)} vs on-chain=0x${chainTrailer.slice(off * 2, off * 2 + 16)}`;
  }

  return {
    ok,
    label,
    artifactName,
    address,
    staticBytes,
    immutableBytes: trailerBytes,
    deployedBytes: onchainBytes,
    staticPrefixMatch,
    immutableTrailerMatch,
    staticSha256: sha256Hex(cleanStatic),
    deployedSha256: sha256Hex(cleanChain),
    reason,
  };
}

// ---------------------------------------------------------------------------
// Main CLI
// ---------------------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2);
  let customRpc = null;
  let outDir = path.join(REPO_ROOT, 'out');
  let configPath = path.join(REPO_ROOT, 'config', 'deployment.json');
  let jsonOutput = false;

  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--rpc' && args[i + 1]) {
      customRpc = args[++i];
    } else if (args[i] === '--out' && args[i + 1]) {
      outDir = path.resolve(args[++i]);
    } else if (args[i] === '--config' && args[i + 1]) {
      configPath = path.resolve(args[++i]);
    } else if (args[i] === '--json') {
      jsonOutput = true;
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.log(
        'Usage: node scripts/verify_deployed_bytecode.mjs [--rpc <url>] [--out <dir>] [--config <path>] [--json]',
      );
      process.exit(0);
    }
  }

  if (!fs.existsSync(configPath)) {
    console.error(`ERROR: Missing deployment config: ${configPath}`);
    process.exit(1);
  }
  const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));

  const rpcUrls = [
    ...(customRpc ? [customRpc] : []),
    ...(process.env.SEPOLIA_RPC_URL ? [process.env.SEPOLIA_RPC_URL] : []),
    cfg.rpcUrl,
    'https://sepolia.drpc.org',
    'https://rpc.sepolia.org',
  ].filter(Boolean);

  // 1. Verify RPC chainId matches config/deployment.json
  const { result: chainIdHex, rpcUrl: activeRpc } = await rpcCall(rpcUrls, 'eth_chainId', []);
  const actualChainId = Number(BigInt(chainIdHex));
  if (actualChainId !== Number(cfg.chainId)) {
    console.error(
      `ERROR: RPC chainId mismatch: expected ${cfg.chainId} (${cfg.name}), got ${actualChainId} from ${activeRpc}`,
    );
    process.exit(1);
  }

  // 2. Build contract verification matrix with explicit immutable trailers
  const fairBatchTrailer = buildFairBatchTrailer(cfg);
  const targets = [
    {
      label: 'FairBatch',
      artifactName: 'FairBatch',
      address: cfg.contracts.fairBatch,
      expectedTrailerHex: fairBatchTrailer.hex,
      immutableSummary: `base/quote tokens, decimals (${cfg.tokens.base.decimals}/${cfg.tokens.quote.decimals}), windows (${cfg.market.commitWindowSecs}s/${cfg.market.revealWindowSecs}s), minBond (${cfg.market.minBondWei} wei), EIP-712 Domain + domainSeparator ${fairBatchTrailer.domainSeparator}`,
    },
    {
      label: `baseToken (${cfg.tokens.base.symbol})`,
      artifactName: 'MockERC20',
      address: cfg.contracts.baseToken,
      expectedTrailerHex: buildMockErc20Trailer(cfg.tokens.base.decimals, cfg.deployer),
      immutableSummary: `decimals=${cfg.tokens.base.decimals}, owner=${cfg.deployer}`,
    },
    {
      label: `quoteToken (${cfg.tokens.quote.symbol})`,
      artifactName: 'MockERC20',
      address: cfg.contracts.quoteToken,
      expectedTrailerHex: buildMockErc20Trailer(cfg.tokens.quote.decimals, cfg.deployer),
      immutableSummary: `decimals=${cfg.tokens.quote.decimals}, owner=${cfg.deployer}`,
    },
    {
      label: 'Faucet',
      artifactName: 'Faucet',
      address: cfg.contracts.faucet,
      expectedTrailerHex: buildFaucetTrailer(cfg),
      immutableSummary: `base/quote tokens, drip=${cfg.faucet.claimBaseAmount}/${cfg.faucet.claimQuoteAmount}, cooldown=${cfg.faucet.cooldownSecs}s`,
    },
  ];

  const results = [];
  let failures = 0;

  for (const target of targets) {
    const binPath = path.join(outDir, `${target.artifactName}.runtime.bin`);
    if (!fs.existsSync(binPath)) {
      console.error(
        `ERROR: Missing compiled artifact ${binPath}. Run \`fe build\` first before verifying bytecode.`,
      );
      process.exit(1);
    }
    const staticHex = fs.readFileSync(binPath, 'utf8');
    const { result: onchainHex } = await rpcCall([activeRpc, ...rpcUrls], 'eth_getCode', [
      target.address,
      'latest',
    ]);
    const verdict = compareContractBytecode({
      label: target.label,
      artifactName: target.artifactName,
      address: target.address,
      staticHex,
      expectedTrailerHex: target.expectedTrailerHex,
      onchainHex,
    });
    results.push({ ...verdict, immutableSummary: target.immutableSummary });
    if (!verdict.ok) {
      failures += 1;
    }
  }

  if (jsonOutput) {
    console.log(
      JSON.stringify(
        {
          ok: failures === 0,
          network: cfg.name,
          chainId: actualChainId,
          rpcUrl: activeRpc,
          strategy:
            'Exact byte-for-byte static prefix match (out/*.runtime.bin) + exact byte-for-byte Sonatina immutable trailer match reconstructed from config/deployment.json (0 masked bytes)',
          results,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(`FairBatch Deployed Bytecode Verification (${cfg.name}, chainId=${actualChainId})`);
    console.log(`RPC: ${activeRpc}`);
    console.log(
      'Method: Exact static prefix comparison (out/*.runtime.bin) + exact immutable trailer reconstruction from config/deployment.json (0 bytes masked).',
    );
    console.log('');
    for (const r of results) {
      if (r.ok) {
        console.log(
          `[PASS] ${r.label} (${r.address}) -> ${r.deployedBytes} B = ${r.staticBytes} B static prefix + ${r.immutableBytes} B immutables`,
        );
        console.log(`       static sha256:   ${r.staticSha256}`);
        console.log(`       deployed sha256: ${r.deployedSha256}`);
        console.log(`       immutables:      ${r.immutableSummary}`);
      } else {
        console.error(`[FAIL] ${r.label} (${r.address}) -> ${r.reason}`);
      }
    }
    console.log('');
    if (failures === 0) {
      console.log(
        `VERIFIED: All ${results.length}/${results.length} deployed Sepolia contracts match this commit byte-for-byte (static runtime + immutable trailer).`,
      );
    } else {
      console.error(
        `FAILED: ${failures}/${results.length} contract(s) did NOT match compiled bytecode.`,
      );
    }
  }

  if (failures > 0) {
    process.exit(1);
  }
}

const isEntrypoint =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename);
if (isEntrypoint) {
  main().catch((err) => {
    console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
