import { getAddress, isAddress, zeroAddress, type Address, type Chain } from 'viem';
import { sepolia } from 'viem/chains';

export interface RuntimeConfig {
  chainId: number;
  rpcUrl: string;
  explorerUrl: string;
  fairBatch: Address;
  baseToken: Address;
  quoteToken: Address;
  baseSymbol: string;
  quoteSymbol: string;
  baseDecimals: number;
  quoteDecimals: number;
  deploymentBlock: bigint;
  commitWindowSecs: number;
  revealWindowSecs: number;
  minBondWei: bigint;
  initialReserveBase: bigint;
  initialReserveQuote: bigint;
  tokenFaucetEnabled: boolean;
}

const SEPOLIA_FAIRBATCH = getAddress('0x60122518eccbeeb247cd42b0201f244432c7600d');
const SEPOLIA_FWETH = getAddress('0xe72678fb21267fbb5c02c59496f04a86a7d8d56b');
const SEPOLIA_FUSDC = getAddress('0x0384fb6158fb2e5ea021af6f8fa3e81daeb075f0');

const STORAGE_KEY = 'fairbatch.runtime.v1';

function envString(key: string): string | undefined {
  const value = (import.meta.env as Record<string, unknown>)[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function envNumber(key: string): number | undefined {
  const raw = envString(key);
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function envBigInt(key: string): bigint | undefined {
  const raw = envString(key);
  if (!raw) return undefined;
  try {
    const parsed = BigInt(raw);
    return parsed > 0n ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function envAddress(key: string, fallback: Address): Address {
  const raw = envString(key);
  if (raw && isAddress(raw)) {
    try {
      const parsed = getAddress(raw);
      if (parsed !== zeroAddress) return parsed;
    } catch {
      // fall through to the deployment default
    }
  }
  return fallback;
}

function defaultExplorer(chainId: number): string {
  switch (chainId) {
    case 1:
      return 'https://etherscan.io';
    case 11155111:
      return 'https://sepolia.etherscan.io';
    case 560048:
      return 'https://hoodi.etherscan.io';
    default:
      return '';
  }
}

function defaultConfig(): RuntimeConfig {
  const chainId = envNumber('VITE_CHAIN_ID') ?? 11155111;
  return {
    chainId,
    rpcUrl:
      envString('VITE_RPC_URL') ??
      (chainId === 11155111
        ? 'https://ethereum-sepolia-rpc.publicnode.com'
        : 'http://127.0.0.1:8545'),
    explorerUrl: envString('VITE_EXPLORER_URL') ?? defaultExplorer(chainId),
    fairBatch: envAddress('VITE_FAIRBATCH_ADDRESS', SEPOLIA_FAIRBATCH),
    baseToken: envAddress('VITE_BASE_TOKEN_ADDRESS', SEPOLIA_FWETH),
    quoteToken: envAddress('VITE_QUOTE_TOKEN_ADDRESS', SEPOLIA_FUSDC),
    baseSymbol: 'fWETH',
    quoteSymbol: 'fUSDC',
    baseDecimals: 18,
    quoteDecimals: 6,
    deploymentBlock: envBigInt('VITE_DEPLOYMENT_BLOCK') ?? 12156617n,
    commitWindowSecs: envNumber('VITE_COMMIT_WINDOW_SECS') ?? 60,
    revealWindowSecs: envNumber('VITE_REVEAL_WINDOW_SECS') ?? 60,
    minBondWei: envBigInt('VITE_MIN_BOND_WEI') ?? 100_000_000_000_000n,
    initialReserveBase: envBigInt('VITE_INITIAL_RESERVE_BASE') ?? 100_000_000_000_000_000_000n,
    initialReserveQuote: envBigInt('VITE_INITIAL_RESERVE_QUOTE') ?? 300_000_000_000n,
    tokenFaucetEnabled: true,
  };
}

export const DEFAULT_RUNTIME_CONFIG: RuntimeConfig = defaultConfig();

function readStoredOverrides(): Partial<RuntimeConfig> {
  try {
    if (typeof localStorage === 'undefined') return {};
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const next: Partial<RuntimeConfig> = {};
    if (typeof parsed.rpcUrl === 'string' && parsed.rpcUrl.trim()) next.rpcUrl = parsed.rpcUrl.trim();
    if (typeof parsed.explorerUrl === 'string') next.explorerUrl = parsed.explorerUrl;
    if (typeof parsed.chainId === 'number' && Number.isFinite(parsed.chainId)) {
      next.chainId = parsed.chainId;
    }
    for (const key of ['fairBatch', 'baseToken', 'quoteToken'] as const) {
      const value = parsed[key];
      if (typeof value === 'string' && isAddress(value)) {
        next[key] = getAddress(value);
      }
    }
    return next;
  } catch {
    return {};
  }
}

export function loadRuntimeConfig(): RuntimeConfig {
  const stored = readStoredOverrides();
  const merged: RuntimeConfig = { ...DEFAULT_RUNTIME_CONFIG, ...stored };
  if (stored.chainId && stored.chainId !== DEFAULT_RUNTIME_CONFIG.chainId) {
    merged.explorerUrl = stored.explorerUrl ?? defaultExplorer(stored.chainId);
    merged.tokenFaucetEnabled = stored.chainId === DEFAULT_RUNTIME_CONFIG.chainId;
  }
  return merged;
}

export function saveRuntimeConfig(next: RuntimeConfig): RuntimeConfig {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        chainId: next.chainId,
        rpcUrl: next.rpcUrl,
        explorerUrl: next.explorerUrl,
        fairBatch: next.fairBatch,
        baseToken: next.baseToken,
        quoteToken: next.quoteToken,
      }));
    }
  } catch {
    // Configuration still applies for this session when storage is unavailable.
  }
  return next;
}

export function resetRuntimeConfig(): RuntimeConfig {
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore storage failures
  }
  return { ...DEFAULT_RUNTIME_CONFIG };
}

export function isContractConfigured(config: RuntimeConfig): boolean {
  return config.fairBatch !== zeroAddress && isAddress(config.fairBatch);
}

export function getChain(config: RuntimeConfig): Chain {
  if (config.chainId === sepolia.id) {
    return {
      ...sepolia,
      rpcUrls: { default: { http: [config.rpcUrl] } },
    };
  }
  return {
    id: config.chainId,
    name: `FairBatch Chain ${config.chainId}`,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [config.rpcUrl] } },
    blockExplorers: config.explorerUrl
      ? { default: { name: 'Explorer', url: config.explorerUrl } }
      : undefined,
  };
}

export function explorerAddressUrl(config: RuntimeConfig, address: string): string | null {
  if (!config.explorerUrl) return null;
  return `${config.explorerUrl}/address/${address}`;
}

export function explorerTxUrl(config: RuntimeConfig, hash: string): string | null {
  if (!config.explorerUrl) return null;
  return `${config.explorerUrl}/tx/${hash}`;
}
