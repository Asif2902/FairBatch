import { getAddress, isAddress, zeroAddress, type Address, type Chain } from 'viem';
import { sepolia } from 'viem/chains';
import deployment from '../../../config/deployment.json';

export interface RuntimeConfig {
  network: 'sepolia';
  chainId: number;
  rpcUrl: string;
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

function buildSepoliaConfig(): RuntimeConfig {
  const faucet = parseAddress(deployment.contracts.faucet);
  return {
    network: 'sepolia',
    chainId: deployment.chainId,
    rpcUrl: deployment.rpcUrl,
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
    rpcUrls: { default: { http: [config.rpcUrl] } },
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
