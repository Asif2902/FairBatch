import { getAddress, isAddress, zeroAddress, type Address, type Chain } from 'viem';
import { sepolia } from 'viem/chains';
import deployment from '../../../config/deployment.json';
import networks from '../../../config/networks.json';

export const ALCHEMY_SEPOLIA_BASE_URL = 'https://eth-sepolia.g.alchemy.com/v2/';

export interface RuntimeConfig {
  network: 'sepolia';
  chainId: number;
  rpcUrl: string;
  fallbackRpcUrls: string[];
  rpcUrls: string[];
  explorerUrl: string;
  deployer: Address;
  fairBatch: Address;
  baseToken: Address;
  quoteToken: Address;
  faucet: Address;
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
  faucetClaimBase: bigint;
  faucetClaimQuote: bigint;
  faucetCooldownSecs: number;
  tokenFaucetEnabled: boolean;
}

function parseAddress(raw: string | undefined): Address {
  if (!raw || !isAddress(raw)) return zeroAddress;
  return getAddress(raw);
}

/**
 * Resolves an Alchemy Sepolia RPC URL from either a bare API key or a full URL.
 * Returns null if empty or if an incomplete base URL (`.../v2/` with no key) is supplied.
 */
export function resolveAlchemySepoliaUrl(raw?: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) {
    if (isIncompleteAlchemyUrl(trimmed)) return null;
    return trimmed;
  }
  const cleanKey = trimmed.replace(/^\/+/, '');
  if (!cleanKey) return null;
  return `${ALCHEMY_SEPOLIA_BASE_URL}${cleanKey}`;
}

export function isIncompleteAlchemyUrl(url: string): boolean {
  return /^https?:\/\/[^/]*alchemy\.com\/v2\/?$/i.test(url.trim());
}

/**
 * Redacts API keys embedded in Alchemy/Infura RPC URLs before rendering in UI or logs.
 */
export function maskRpcUrl(url: string): string {
  return url
    .replace(/(alchemy\.com\/v2\/)([^/?#\s]+)/i, '$1••••')
    .replace(/(infura\.io\/v3\/)([^/?#\s]+)/i, '$1••••');
}

function collectRpcUrls(candidates: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const candidate of candidates) {
    const trimmed = candidate?.trim() ?? '';
    if (!trimmed || isIncompleteAlchemyUrl(trimmed) || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

export interface RpcEnvOverrides {
  alchemyApiKey?: string;
  rpcUrl?: string;
}

export function buildSepoliaConfig(overrides?: RpcEnvOverrides): RuntimeConfig {
  const faucet = parseAddress(deployment.contracts.faucet);
  const env = (import.meta.env ?? {}) as {
    VITE_ALCHEMY_API_KEY?: string;
    VITE_RPC_URL?: string;
  };
  const alchemyUrl = resolveAlchemySepoliaUrl(overrides?.alchemyApiKey ?? env.VITE_ALCHEMY_API_KEY);
  const customRpc = resolveAlchemySepoliaUrl(overrides?.rpcUrl ?? env.VITE_RPC_URL);
  const rawFallbacks = networks.networks?.sepolia?.fallback_rpc_urls ?? [];
  const rpcUrls = collectRpcUrls([alchemyUrl, customRpc, deployment.rpcUrl, ...rawFallbacks]);
  const fallbackRpcUrls = rpcUrls.slice(1);
  return {
    network: 'sepolia',
    chainId: deployment.chainId,
    rpcUrl: rpcUrls[0] ?? deployment.rpcUrl,
    fallbackRpcUrls,
    rpcUrls,
    explorerUrl: deployment.explorerUrl,
    deployer: parseAddress(deployment.deployer),
    fairBatch: parseAddress(deployment.contracts.fairBatch),
    baseToken: parseAddress(deployment.contracts.baseToken),
    quoteToken: parseAddress(deployment.contracts.quoteToken),
    faucet,
    baseSymbol: deployment.tokens.base.symbol,
    quoteSymbol: deployment.tokens.quote.symbol,
    baseDecimals: deployment.tokens.base.decimals,
    quoteDecimals: deployment.tokens.quote.decimals,
    deploymentBlock: BigInt(deployment.deploymentBlock),
    commitWindowSecs: deployment.market.commitWindowSecs,
    revealWindowSecs: deployment.market.revealWindowSecs,
    minBondWei: BigInt(deployment.market.minBondWei),
    initialReserveBase: BigInt(deployment.market.initialReserveBase),
    initialReserveQuote: BigInt(deployment.market.initialReserveQuote),
    faucetClaimBase: BigInt(deployment.faucet.claimBaseAmount),
    faucetClaimQuote: BigInt(deployment.faucet.claimQuoteAmount),
    faucetCooldownSecs: deployment.faucet.cooldownSecs,
    tokenFaucetEnabled: faucet !== zeroAddress,
  };
}

export const DEFAULT_RUNTIME_CONFIG: RuntimeConfig = buildSepoliaConfig();

export function loadRuntimeConfig(): RuntimeConfig {
  return DEFAULT_RUNTIME_CONFIG;
}

export function isContractConfigured(config: RuntimeConfig): boolean {
  return config.fairBatch !== zeroAddress && isAddress(config.fairBatch);
}

export function getChain(config: RuntimeConfig): Chain {
  return {
    ...sepolia,
    rpcUrls: { default: { http: config.rpcUrls } },
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
