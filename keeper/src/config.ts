import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAddress, parseEther, parseGwei, type Address, type Hex } from 'viem';

export interface DeploymentConfig {
  network: string;
  chainId: number;
  rpcUrl: string;
  explorerUrl: string;
  deploymentBlock: number;
  contracts: {
    fairBatch: string;
    baseToken: string;
    quoteToken: string;
    faucet: string;
  };
  market: {
    commitWindowSecs: number;
    revealWindowSecs: number;
    minBondWei: string;
  };
}

export interface NetworksConfig {
  networks?: {
    sepolia?: {
      default_rpc_url?: string;
      fallback_rpc_urls?: string[];
    };
  };
}

export interface KeeperConfig {
  chainId: number;
  rpcUrls: string[];
  explorerUrl: string;
  fairBatch: Address;
  baseToken: Address;
  quoteToken: Address;
  deploymentBlock: bigint;
  privateKey: Hex | null;
  dryRun: boolean;
  pollMs: number;
  graceSeconds: number;
  emptyRoundMinutes: number;
  slashEnabled: boolean;
  slashGraceSeconds: number;
  minBalanceWei: bigint;
  maxGasPriceWei: bigint;
  settleGasLimit: bigint;
  slashGasLimit: bigint;
  host: string;
  port: number;
  corsOrigins: string[];
}

function locateRepoRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, '..', '..'),
    path.resolve(process.cwd(), '..'),
    process.cwd(),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'config', 'deployment.json'))) {
      return dir;
    }
  }
  throw new Error('Could not locate config/deployment.json from keeper workspace.');
}

function loadDotEnvIfPresent(repoRoot: string): void {
  const envCandidates = [
    path.join(repoRoot, 'keeper', '.env'),
    path.join(process.cwd(), '.env'),
  ];
  for (const filePath of envCandidates) {
    if (!fs.existsSync(filePath)) continue;
    const raw = fs.readFileSync(filePath, 'utf8');
    for (const rawLine of raw.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 1) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined && val.length > 0) {
        process.env[key] = val;
      }
    }
    break;
  }
}

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(raw.trim().toLowerCase());
}

function parseNumber(raw: string | undefined, fallback: number, min: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min) return fallback;
  return n;
}

function normalizePrivateKey(raw: string | undefined): Hex | null {
  if (!raw || !raw.trim()) return null;
  const trimmed = raw.trim();
  const prefixed = trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(prefixed)) {
    throw new Error('KEEPER_PRIVATE_KEY must be a 64-hex-character private key (with or without 0x prefix).');
  }
  return prefixed as Hex;
}

export function loadKeeperConfig(argv: string[] = process.argv.slice(2)): KeeperConfig {
  const repoRoot = locateRepoRoot();
  loadDotEnvIfPresent(repoRoot);

  const deployment: DeploymentConfig = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'config', 'deployment.json'), 'utf8'),
  );
  const networksPath = path.join(repoRoot, 'config', 'networks.json');
  const networks: NetworksConfig = fs.existsSync(networksPath)
    ? JSON.parse(fs.readFileSync(networksPath, 'utf8'))
    : {};

  const dryRun =
    argv.includes('--dry-run') || parseBool(process.env.KEEPER_DRY_RUN, false);
  const privateKey = normalizePrivateKey(process.env.KEEPER_PRIVATE_KEY);
  if (!dryRun && !privateKey) {
    throw new Error(
      'KEEPER_PRIVATE_KEY is required unless running with --dry-run (or KEEPER_DRY_RUN=true).',
    );
  }

  const rpcCandidates = [
    process.env.KEEPER_RPC_URL,
    deployment.rpcUrl,
    ...(networks.networks?.sepolia?.fallback_rpc_urls ?? []),
  ]
    .map((u) => u?.trim() ?? '')
    .filter((u) => u.length > 0);
  const rpcUrls = Array.from(new Set(rpcCandidates));

  const corsRaw = process.env.KEEPER_CORS_ORIGIN ?? 'http://localhost:5173';
  const corsOrigins = corsRaw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  return {
    chainId: deployment.chainId,
    rpcUrls,
    explorerUrl: deployment.explorerUrl,
    fairBatch: getAddress(deployment.contracts.fairBatch),
    baseToken: getAddress(deployment.contracts.baseToken),
    quoteToken: getAddress(deployment.contracts.quoteToken),
    deploymentBlock: BigInt(deployment.deploymentBlock),
    privateKey,
    dryRun,
    pollMs: Math.floor(parseNumber(process.env.KEEPER_POLL_MS, 2_000, 500)),
    graceSeconds: Math.floor(parseNumber(process.env.KEEPER_GRACE_SECONDS, 5, 0)),
    emptyRoundMinutes: parseNumber(process.env.KEEPER_EMPTY_ROUND_MINUTES, 10, 0),
    slashEnabled: parseBool(process.env.KEEPER_SLASH, true),
    slashGraceSeconds: Math.floor(parseNumber(process.env.KEEPER_SLASH_GRACE_SECONDS, 60, 0)),
    minBalanceWei: parseEther(String(parseNumber(process.env.KEEPER_MIN_BALANCE_ETH, 0.005, 0))),
    maxGasPriceWei: parseGwei(String(parseNumber(process.env.KEEPER_MAX_GAS_PRICE_GWEI, 50, 0.1))),
    settleGasLimit: BigInt(Math.floor(parseNumber(process.env.KEEPER_SETTLE_GAS_LIMIT, 12_000_000, 500_000))),
    slashGasLimit: BigInt(Math.floor(parseNumber(process.env.KEEPER_SLASH_GAS_LIMIT, 600_000, 100_000))),
    host: process.env.KEEPER_HOST ?? '0.0.0.0',
    port: Math.floor(parseNumber(process.env.KEEPER_PORT, 3002, 1)),
    corsOrigins,
  };
}
