import {
  createPublicClient,
  createWalletClient,
  custom,
  fallback,
  getAddress,
  http,
  type Address,
  type EIP1193Provider,
  type PublicClient,
} from 'viem';
import { getChain, type RuntimeConfig } from './config';

type ConfiguredWalletClient = ReturnType<typeof createWalletClient>;

export interface EIP6963ProviderInfo {
  uuid: string;
  name: string;
  icon: string;
  rdns: string;
}

export interface EIP6963ProviderDetail {
  info: EIP6963ProviderInfo;
  provider: EIP1193Provider;
}

export interface DetectedWallet {
  id: string;
  rdns: string;
  name: string;
  icon: string | null;
  provider: EIP1193Provider;
  source: 'eip6963' | 'injected';
}

interface EIP6963AnnounceEvent extends Event {
  detail?: EIP6963ProviderDetail;
}

interface FlaggedProvider extends EIP1193Provider {
  isMetaMask?: boolean;
  isRabby?: boolean;
  isCoinbaseWallet?: boolean;
  isBraveWallet?: boolean;
  isPhantom?: boolean;
  isRainbow?: boolean;
  isOkxWallet?: boolean;
  isTrust?: boolean;
  providers?: FlaggedProvider[];
}

const LAST_WALLET_RDNS_KEY = 'fairbatch.walletRdns.v1';

let cachedPublic:
  | { key: string; client: PublicClient }
  | null = null;

const announcedWallets = new Map<string, DetectedWallet>();
const discoverySubscribers = new Set<(wallets: DetectedWallet[]) => void>();
let discoveryListenerAttached = false;
let activeWallet: DetectedWallet | null = null;

function readSavedWalletRdns(): string | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const saved = localStorage.getItem(LAST_WALLET_RDNS_KEY);
    return saved && saved.trim().length > 0 ? saved.trim() : null;
  } catch {
    return null;
  }
}

function writeSavedWalletRdns(rdns: string | null): void {
  try {
    if (typeof localStorage === 'undefined') return;
    if (rdns) {
      localStorage.setItem(LAST_WALLET_RDNS_KEY, rdns);
    } else {
      localStorage.removeItem(LAST_WALLET_RDNS_KEY);
    }
  } catch {
    // ignore storage errors
  }
}

function inferInjectedWalletMeta(provider: FlaggedProvider): { name: string; rdns: string } {
  if (provider.isRabby) return { name: 'Rabby Wallet', rdns: 'io.rabby' };
  if (provider.isCoinbaseWallet) return { name: 'Coinbase Wallet', rdns: 'com.coinbase.wallet' };
  if (provider.isRainbow) return { name: 'Rainbow', rdns: 'me.rainbow' };
  if (provider.isPhantom) return { name: 'Phantom', rdns: 'app.phantom' };
  if (provider.isBraveWallet) return { name: 'Brave Wallet', rdns: 'com.brave.wallet' };
  if (provider.isOkxWallet) return { name: 'OKX Wallet', rdns: 'com.okex.wallet' };
  if (provider.isTrust) return { name: 'Trust Wallet', rdns: 'com.trustwallet.app' };
  if (provider.isMetaMask) return { name: 'MetaMask', rdns: 'io.metamask' };
  return { name: 'Browser Wallet', rdns: 'injected.browser' };
}

function notifyDiscoverySubscribers(): void {
  const snapshot = discoverInjectedWallets();
  for (const listener of discoverySubscribers) {
    listener(snapshot);
  }
}

function handleEip6963Announce(rawEvent: Event): void {
  const event = rawEvent as EIP6963AnnounceEvent;
  const detail = event.detail;
  if (!detail?.info || !detail.provider) return;
  const rdns = (detail.info.rdns || detail.info.uuid || detail.info.name || '').trim();
  const name = (detail.info.name || 'Ethereum Wallet').trim();
  if (!rdns) return;

  const entry: DetectedWallet = {
    id: rdns,
    rdns,
    name,
    icon: detail.info.icon?.trim() ? detail.info.icon : null,
    provider: detail.provider,
    source: 'eip6963',
  };

  announcedWallets.set(rdns, entry);
  if (activeWallet && (activeWallet.rdns === rdns || activeWallet.provider === detail.provider)) {
    activeWallet = entry;
  }
  notifyDiscoverySubscribers();
}

function ensureDiscoveryListener(): void {
  if (typeof window === 'undefined' || discoveryListenerAttached) return;
  window.addEventListener('eip6963:announceProvider', handleEip6963Announce);
  discoveryListenerAttached = true;
}

export function requestInjectedWallets(): DetectedWallet[] {
  if (typeof window === 'undefined') return [];
  ensureDiscoveryListener();
  try {
    window.dispatchEvent(new Event('eip6963:requestProvider'));
  } catch {
    // ignore dispatch failures in constrained runtimes
  }
  const wallets = discoverInjectedWallets();
  notifyDiscoverySubscribers();
  return wallets;
}

export function discoverInjectedWallets(): DetectedWallet[] {
  if (typeof window === 'undefined') return [];
  ensureDiscoveryListener();

  const list: DetectedWallet[] = Array.from(announcedWallets.values());
  const seenProviders = new Set<EIP1193Provider>(list.map((w) => w.provider));
  const seenRdns = new Set<string>(list.map((w) => w.rdns.toLowerCase()));

  const root = window.ethereum as unknown as FlaggedProvider | undefined;
  if (root) {
    const legacyProviders = Array.isArray(root.providers) && root.providers.length > 0
      ? root.providers
      : [root];

    for (const prov of legacyProviders) {
      if (!prov || typeof prov.request !== 'function') continue;
      if (seenProviders.has(prov)) continue;
      const meta = inferInjectedWalletMeta(prov);
      if (seenRdns.has(meta.rdns.toLowerCase())) continue;

      seenProviders.add(prov);
      seenRdns.add(meta.rdns.toLowerCase());
      list.push({
        id: `injected:${meta.rdns}`,
        rdns: meta.rdns,
        name: meta.name,
        icon: null,
        provider: prov,
        source: 'injected',
      });
    }
  }

  return list.sort((a, b) => {
    if (a.source !== b.source) return a.source === 'eip6963' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

export function subscribeInjectedWallets(
  listener: (wallets: DetectedWallet[]) => void,
): () => void {
  discoverySubscribers.add(listener);
  const current = requestInjectedWallets();
  listener(current);
  return () => {
    discoverySubscribers.delete(listener);
  };
}

export function getActiveWallet(): DetectedWallet | null {
  return activeWallet;
}

export function setActiveWallet(wallet: DetectedWallet | null): void {
  activeWallet = wallet;
  writeSavedWalletRdns(wallet?.rdns ?? null);
}

export function clearActiveWallet(): void {
  activeWallet = null;
  writeSavedWalletRdns(null);
}

export function resetWalletDiscoveryForTests(): void {
  if (typeof window !== 'undefined' && discoveryListenerAttached) {
    window.removeEventListener('eip6963:announceProvider', handleEip6963Announce);
  }
  announcedWallets.clear();
  discoverySubscribers.clear();
  discoveryListenerAttached = false;
  activeWallet = null;
}

export function getPublicClient(config: RuntimeConfig): PublicClient {
  const urls = config.rpcUrls?.length ? config.rpcUrls : [config.rpcUrl];
  const key = `${config.chainId}:${urls.join('|')}`;
  if (cachedPublic?.key === key) return cachedPublic.client;

  const transports = urls.map((url) =>
    http(url, {
      timeout: 20_000,
      retryCount: 2,
      retryDelay: 500,
    }),
  );

  const transport =
    transports.length > 1
      ? fallback(transports, { rank: false, retryCount: 2, retryDelay: 600 })
      : transports[0];

  const client = createPublicClient({
    chain: getChain(config),
    transport,
  });
  cachedPublic = { key, client };
  return client;
}

export function clearPublicClientCache(): void {
  cachedPublic = null;
}

function resolveDefaultWallet(): DetectedWallet | null {
  if (activeWallet) return activeWallet;
  const wallets = discoverInjectedWallets();
  const savedRdns = readSavedWalletRdns();
  if (savedRdns) {
    const matched = wallets.find(
      (w) => w.rdns.toLowerCase() === savedRdns.toLowerCase(),
    );
    if (matched) return matched;
  }
  return wallets[0] ?? null;
}

export function getInjectedProvider(): EIP1193Provider | null {
  if (typeof window === 'undefined') return null;
  if (activeWallet) return activeWallet.provider;
  const resolved = resolveDefaultWallet();
  if (resolved) return resolved.provider;
  return (window.ethereum as unknown as EIP1193Provider | undefined) ?? null;
}

export function hasInjectedWallet(): boolean {
  return discoverInjectedWallets().length > 0 || Boolean(getInjectedProvider());
}

function walletClientFor(
  config: RuntimeConfig,
  account?: Address,
  providerOverride?: EIP1193Provider | null,
): ConfiguredWalletClient {
  const provider = providerOverride ?? getInjectedProvider();
  if (!provider) {
    throw new Error(
      'No Ethereum wallet detected. Install MetaMask, Rabby, Coinbase Wallet, or Rainbow to trade on Ethereum Sepolia.',
    );
  }
  return createWalletClient({
    account,
    chain: getChain(config),
    transport: custom(provider),
  });
}

async function ensureWalletChain(
  client: ConfiguredWalletClient,
  config: RuntimeConfig,
): Promise<void> {
  const current = await client.getChainId();
  if (current === config.chainId) return;
  const chain = getChain(config);
  try {
    await client.switchChain({ id: config.chainId });
  } catch {
    try {
      await client.addChain({ chain });
    } catch {
      // Some wallets report the chain as already known; retry switch below.
    }
    await client.switchChain({ id: config.chainId });
  }
}

export async function switchWalletToSepolia(config: RuntimeConfig): Promise<number> {
  const client = walletClientFor(config);
  await ensureWalletChain(client, config);
  return client.getChainId();
}

export async function connectInjectedWallet(
  config: RuntimeConfig,
  wallet?: DetectedWallet,
): Promise<Address> {
  const targetWallet = wallet ?? resolveDefaultWallet();
  const provider = targetWallet?.provider ?? getInjectedProvider();
  const client = walletClientFor(config, undefined, provider);
  const accounts = await client.requestAddresses();
  if (!accounts[0]) throw new Error('Wallet returned no accounts.');
  await ensureWalletChain(client, config);
  if (targetWallet) {
    setActiveWallet(targetWallet);
  }
  return getAddress(accounts[0]);
}

export async function restoreInjectedAccount(config: RuntimeConfig): Promise<Address | null> {
  const wallets = discoverInjectedWallets();
  const savedRdns = readSavedWalletRdns();
  const candidates: DetectedWallet[] = [];

  if (savedRdns) {
    const preferred = wallets.find(
      (w) => w.rdns.toLowerCase() === savedRdns.toLowerCase(),
    );
    if (preferred) candidates.push(preferred);
  }
  for (const w of wallets) {
    if (!candidates.includes(w)) candidates.push(w);
  }

  for (const candidate of candidates) {
    try {
      const client = walletClientFor(config, undefined, candidate.provider);
      const accounts = await client.getAddresses();
      if (accounts[0]) {
        activeWallet = candidate;
        return getAddress(accounts[0]);
      }
    } catch {
      // try next discovered wallet
    }
  }

  const fallbackProvider = getInjectedProvider();
  if (!fallbackProvider) return null;
  try {
    const client = walletClientFor(config, undefined, fallbackProvider);
    const accounts = await client.getAddresses();
    return accounts[0] ? getAddress(accounts[0]) : null;
  } catch {
    return null;
  }
}

export async function getWalletChainId(config: RuntimeConfig): Promise<number | null> {
  if (!getInjectedProvider()) return null;
  try {
    return await walletClientFor(config).getChainId();
  } catch {
    return null;
  }
}

export async function ensureWalletReady(
  config: RuntimeConfig,
  account: Address,
): Promise<ConfiguredWalletClient> {
  const client = walletClientFor(config, account);
  await ensureWalletChain(client, config);
  return client;
}

export function watchInjectedWallet(
  handlers: {
    onAccountsChanged: (accounts: Address[]) => void;
    onChainChanged: (chainId: number) => void;
    onDisconnect: () => void;
  },
  providerOverride?: EIP1193Provider | null,
): () => void {
  const provider = providerOverride ?? getInjectedProvider();
  if (!provider?.on || !provider.removeListener) return () => undefined;

  const handleAccounts = (...args: unknown[]) => {
    const accounts = Array.isArray(args[0]) ? (args[0] as string[]) : [];
    handlers.onAccountsChanged(accounts.filter(Boolean).map((a) => getAddress(a)));
  };
  const handleChain = (...args: unknown[]) => {
    const raw = args[0];
    if (typeof raw === 'string') {
      handlers.onChainChanged(Number.parseInt(raw, 16));
    } else if (typeof raw === 'number') {
      handlers.onChainChanged(raw);
    }
  };
  const handleDisconnect = () => handlers.onDisconnect();

  provider.on('accountsChanged', handleAccounts);
  provider.on('chainChanged', handleChain);
  provider.on('disconnect', handleDisconnect);

  return () => {
    provider.removeListener?.('accountsChanged', handleAccounts);
    provider.removeListener?.('chainChanged', handleChain);
    provider.removeListener?.('disconnect', handleDisconnect);
  };
}
