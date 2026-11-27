import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { EIP1193Provider } from 'viem';
import type { BatchPhase, StateResponse } from '../types';
import type { FairBatchController } from '../onchain/useFairBatch';
import type { OnchainSnapshot } from '../onchain/state';
import {
  connectInjectedWallet,
  discoverInjectedWallets,
  getActiveWallet,
  resetWalletDiscoveryForTests,
  subscribeInjectedWallets,
  type DetectedWallet,
} from '../onchain/client';
import { buildSepoliaConfig, DEFAULT_RUNTIME_CONFIG } from '../onchain/config';
import { computeBatchSettlement } from '../lib/clearingMath';
import App from '../App';

const ALICE = '0x9AFe5CeF11fC10756faef213f7A30D9873B5d372';

let controller: FairBatchController;

vi.mock('../onchain/useFairBatch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../onchain/useFairBatch')>();
  return {
    ...actual,
    useFairBatch: () => controller,
  };
});

function makeMockProvider(address: string = ALICE, chainIdHex = '0xaa36a7'): EIP1193Provider {
  return {
    request: vi.fn(async ({ method }: { method: string }) => {
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [address];
      if (method === 'eth_chainId') return chainIdHex;
      if (method === 'wallet_switchEthereumChain') return null;
      return null;
    }),
    on: vi.fn(),
    removeListener: vi.fn(),
  } as unknown as EIP1193Provider;
}

function makeDetectedWallet(
  rdns: string,
  name: string,
  source: 'eip6963' | 'injected' = 'eip6963',
): DetectedWallet {
  return {
    id: rdns,
    rdns,
    name,
    icon: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg"/>',
    provider: makeMockProvider(),
    source,
  };
}

function buildSnapshot(phase: BatchPhase = 'Open'): OnchainSnapshot {
  const nowSecs = Math.floor(Date.now() / 1000);
  const settlement = computeBatchSettlement(10, 100, 300_000, []);
  const state: StateResponse = {
    batch_id: 10,
    phase,
    commit_duration_secs: 60,
    reveal_duration_secs: 60,
    phase_remaining_secs: 45,
    reserves: {
      rx: 100,
      ry: 300_000,
      spot_price: 3000,
      k_invariant: 30_000_000,
      base_symbol: 'fWETH',
      quote_symbol: 'fUSDC',
      base_decimals: 18,
      quote_decimals: 6,
    },
    commitments: [],
    orders: [],
    claimable: [],
    settled_history: [],
  };
  return {
    config: DEFAULT_RUNTIME_CONFIG,
    health: {
      status: 'ok',
      execution_mode: 'rpc_connected',
      rpc_url: DEFAULT_RUNTIME_CONFIG.rpcUrl,
      chain_id: DEFAULT_RUNTIME_CONFIG.chainId,
      contracts: {
        fair_batch: DEFAULT_RUNTIME_CONFIG.fairBatch,
        base_token: DEFAULT_RUNTIME_CONFIG.baseToken,
        quote_token: DEFAULT_RUNTIME_CONFIG.quoteToken,
        faucet: DEFAULT_RUNTIME_CONFIG.faucet,
        deployed: true,
      },
      fe_artifacts_present: false,
      fe_artifacts: [],
    },
    state,
    batch: {
      batchId: 10n,
      startTime: BigInt(nowSecs - 15),
      commitDeadline: BigInt(nowSecs + 45),
      revealDeadline: BigInt(nowSecs + 105),
      orderCount: 0n,
      commitCount: 0n,
      phase: 0,
    },
    reserves: {
      reserveBase: 100n * 10n ** 18n,
      reserveQuote: 300_000n * 10n ** 6n,
      totalShares: 5_477n * 10n ** 18n,
      spotPriceWad: 3_000n * 10n ** 18n,
    },
    balances: {
      eth: 250_000_000_000_000_000n, // 0.25 ETH
      base: 2n * 10n ** 18n,
      quote: 4_500n * 10n ** 6n,
      lpShares: 12n * 10n ** 18n,
    },
    allowances: { base: 0n, quote: 0n },
    lpLock: { lockedShares: 0n, unlockTime: 0n, unlockedShares: 12n * 10n ** 18n },
    faucet: {
      address: DEFAULT_RUNTIME_CONFIG.faucet,
      baseBalance: 2_000n * 10n ** 18n,
      quoteBalance: 1_000_000n * 10n ** 6n,
      claimBaseAmount: 1n * 10n ** 18n,
      claimQuoteAmount: 100n * 10n ** 6n,
      cooldownSecs: 43_200,
      lastClaim: 0n,
      nextClaimAt: 0n,
      canClaim: true,
    },
    nonce: 0n,
    domainSeparator: `0x${'22'.repeat(32)}`,
    minBondWei: 100_000_000_000_000n,
    orders: [],
    commitments: [],
    allCommitments: [],
    batchSettled: false,
    claimable: [],
    settledHistory: [],
    activeSettlement: settlement,
    blockTimestamp: nowSecs,
    chainTimeOffsetSecs: 0,
    lastUpdated: Date.now(),
  };
}

function makeController(overrides: Partial<FairBatchController> = {}): FairBatchController {
  const snapshot = overrides.snapshot ?? buildSnapshot();
  return {
    config: buildSepoliaConfig({ alchemyApiKey: 'secret_demo_alchemy_key_999' }),
    hasWallet: true,
    detectedWallets: [],
    activeWallet: null,
    account: null,
    walletChainId: DEFAULT_RUNTIME_CONFIG.chainId,
    snapshot,
    livePhase: 'Open',
    chainNow: Math.floor(Date.now() / 1000),
    loading: false,
    refreshing: false,
    busyAction: null,
    txStatus: null,
    error: null,
    notice: null,
    secretVault: [],
    configured: true,
    wrongNetwork: false,
    connect: vi.fn(async () => undefined),
    rescanWallets: vi.fn(() => []),
    switchNetwork: vi.fn(async () => undefined),
    disconnect: vi.fn(),
    refresh: vi.fn(),
    clearNotice: vi.fn(),
    submitDirect: vi.fn(),
    settleAndSubmitDirect: vi.fn(),
    signAndSubmitIntent: vi.fn(),
    sealCommit: vi.fn(),
    revealCommit: vi.fn(),
    signIntent: vi.fn(),
    submitIntent: vi.fn(),
    relayIntent: vi.fn(),
    settle: vi.fn(),
    slash: vi.fn(),
    claim: vi.fn(),
    claimMany: vi.fn(),
    addLiquidity: vi.fn(),
    removeLiquidity: vi.fn(),
    claimFaucet: vi.fn(),
    approve: vi.fn(),
    ...overrides,
  } as unknown as FairBatchController;
}

describe('EIP-6963 multi-wallet discovery (client.ts)', () => {
  const originalEthereum = window.ethereum;

  beforeEach(() => {
    resetWalletDiscoveryForTests();
    localStorage.clear();
    delete window.ethereum;
  });

  afterEach(() => {
    resetWalletDiscoveryForTests();
    window.ethereum = originalEthereum;
  });

  it('discovers announced EIP-6963 wallets, deduplicates window.ethereum, and connects to the chosen provider', async () => {
    const metamaskProvider = makeMockProvider(ALICE);
    const rabbyProvider = makeMockProvider('0x1234567890123456789012345678901234567890');

    // Expose MetaMask also on legacy window.ethereum to confirm deduplication.
    window.ethereum = metamaskProvider as unknown as Window['ethereum'];

    const received: DetectedWallet[][] = [];
    const unsubscribe = subscribeInjectedWallets((list) => received.push(list));

    window.dispatchEvent(
      new CustomEvent('eip6963:announceProvider', {
        detail: {
          info: {
            uuid: 'uuid-mm',
            name: 'MetaMask',
            icon: 'data:image/svg+xml;utf8,<svg/>',
            rdns: 'io.metamask',
          },
          provider: metamaskProvider,
        },
      }),
    );
    window.dispatchEvent(
      new CustomEvent('eip6963:announceProvider', {
        detail: {
          info: {
            uuid: 'uuid-rabby',
            name: 'Rabby Wallet',
            icon: 'data:image/svg+xml;utf8,<svg/>',
            rdns: 'io.rabby',
          },
          provider: rabbyProvider,
        },
      }),
    );

    const wallets = discoverInjectedWallets();
    expect(wallets.map((w) => w.rdns)).toEqual(['io.metamask', 'io.rabby']);
    expect(received[received.length - 1]).toHaveLength(2);

    const rabby = wallets.find((w) => w.rdns === 'io.rabby')!;
    const addr = await connectInjectedWallet(DEFAULT_RUNTIME_CONFIG, rabby);
    expect(addr).toBe('0x1234567890123456789012345678901234567890');
    expect(getActiveWallet()?.rdns).toBe('io.rabby');
    expect(localStorage.getItem('fairbatch.walletRdns.v1')).toBe('io.rabby');

    unsubscribe();
  });
});

describe('Connect Wallet modal Web UI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('opens a native <dialog> from the header Connect button, connects a chosen wallet, and masks Alchemy RPC', async () => {
    const metamask = makeDetectedWallet('io.metamask', 'MetaMask');
    const rabby = makeDetectedWallet('io.rabby', 'Rabby Wallet');

    controller = makeController({
      detectedWallets: [metamask, rabby],
      rescanWallets: vi.fn(() => [metamask, rabby]),
    });

    render(<App />);

    const dialog = screen.getByTestId('wallet-connect-dialog') as HTMLDialogElement;
    expect(dialog.tagName).toBe('DIALOG');
    expect(dialog.open).toBe(false);
    // Strict native <dialog> compliance: no redundant role="dialog" or aria-modal, uses closedby="any"
    expect(dialog.getAttribute('role')).toBeNull();
    expect(dialog.getAttribute('aria-modal')).toBeNull();
    expect(dialog.getAttribute('closedby')).toBe('any');

    fireEvent.click(screen.getByTestId('header-wallet-button'));
    expect(dialog.open).toBe(true);
    expect(controller.rescanWallets).toHaveBeenCalledTimes(1);

    // Detected wallets & badge rendered; already-detected wallets filtered from install grid
    expect(screen.getByTestId('wallet-modal-detected-count')).toHaveTextContent('2 ready');
    expect(screen.getByTestId('wallet-option-io.metamask')).toBeInTheDocument();
    expect(screen.getByTestId('wallet-option-io.rabby')).toBeInTheDocument();
    expect(screen.getByTestId('wallet-modal-install-grid')).not.toHaveTextContent('MetaMask');
    expect(screen.getByTestId('wallet-modal-install-grid')).toHaveTextContent('Coinbase Wallet');

    // Network strip shows masked Alchemy RPC and NEVER exposes the raw secret key
    const networkStrip = screen.getByTestId('wallet-modal-network-strip');
    expect(networkStrip).toHaveTextContent(/Ethereum Sepolia · Chain ID 11155111/i);
    expect(networkStrip).toHaveTextContent(/Alchemy RPC/i);
    expect(networkStrip).toHaveTextContent('https://eth-sepolia.g.alchemy.com/v2/••••');
    expect(networkStrip.textContent).not.toContain('secret_demo_alchemy_key_999');

    // Clicking Rabby Wallet connects to that specific wallet and closes the dialog
    fireEvent.click(screen.getByTestId('wallet-option-io.rabby'));
    await waitFor(() => {
      expect(controller.connect).toHaveBeenCalledWith(rabby);
    });
    await waitFor(() => {
      expect(dialog.open).toBe(false);
    });
  });

  it('opens the Connect Wallet modal from Simple mode and surfaces inline rejection errors', async () => {
    const metamask = makeDetectedWallet('io.metamask', 'MetaMask');
    const failingConnect = vi.fn(async () => {
      throw new Error('User rejected the connection request.');
    });

    controller = makeController({
      detectedWallets: [metamask],
      connect: failingConnect,
    });

    render(<App />);

    fireEvent.click(screen.getByTestId('simple-connect-button'));
    const dialog = screen.getByTestId('wallet-connect-dialog') as HTMLDialogElement;
    expect(dialog.open).toBe(true);

    fireEvent.click(screen.getByTestId('wallet-option-io.metamask'));
    expect(await screen.findByTestId('wallet-modal-error')).toHaveTextContent(
      'User rejected the connection request.',
    );
    // Dialog stays open so user can retry or pick another wallet
    expect(dialog.open).toBe(true);
  });

  it('shows empty state, install links, and Re-scan when no wallets are detected', () => {
    const rescanWallets = vi.fn(() => []);
    controller = makeController({
      hasWallet: false,
      detectedWallets: [],
      rescanWallets,
    });

    render(<App />);

    fireEvent.click(screen.getByTestId('header-wallet-button'));
    expect(screen.getByTestId('wallet-modal-empty-state')).toBeInTheDocument();
    expect(screen.getByTestId('wallet-modal-detected-count')).toHaveTextContent('0 ready');

    const installGrid = screen.getByTestId('wallet-modal-install-grid');
    expect(installGrid).toHaveTextContent('MetaMask');
    expect(installGrid).toHaveTextContent('Rabby Wallet');
    expect(installGrid).toHaveTextContent('Coinbase Wallet');
    expect(installGrid).toHaveTextContent('Rainbow');

    fireEvent.click(screen.getByTestId('wallet-modal-rescan'));
    expect(rescanWallets).toHaveBeenCalledTimes(2);
  });

  it('opens connected account view with balances, wrong-network switch, switch wallet, and disconnect', async () => {
    const rabby = makeDetectedWallet('io.rabby', 'Rabby Wallet');
    const metamask = makeDetectedWallet('io.metamask', 'MetaMask');

    controller = makeController({
      account: ALICE,
      activeWallet: rabby,
      detectedWallets: [metamask, rabby],
      wrongNetwork: true,
      walletChainId: 1,
    });

    render(<App />);

    // Open header dropdown -> Wallet details
    fireEvent.click(screen.getByTestId('header-wallet-button'));
    fireEvent.click(screen.getByTestId('header-wallet-details-button'));

    const dialog = screen.getByTestId('wallet-connect-dialog') as HTMLDialogElement;
    expect(dialog.open).toBe(true);
    expect(screen.getByTestId('wallet-modal-account-view')).toBeInTheDocument();
    expect(screen.getByText(ALICE)).toBeInTheDocument();
    expect(screen.getByTestId('wallet-modal-account-view')).toHaveTextContent('0.25 ETH');
    expect(screen.getByTestId('wallet-modal-account-view')).toHaveTextContent('2.00 fWETH');

    // Wrong network CTA invokes switchNetwork
    fireEvent.click(screen.getByTestId('wallet-modal-switch-network'));
    await waitFor(() => {
      expect(controller.switchNetwork).toHaveBeenCalledTimes(1);
    });

    // Switch wallet flips to picker view with Active badge on Rabby
    fireEvent.click(screen.getByTestId('wallet-modal-switch-wallet'));
    expect(screen.getByTestId('wallet-modal-picker-view')).toBeInTheDocument();
    expect(screen.getByTestId('wallet-option-io.rabby')).toHaveTextContent('Active');

    // Back to account & Disconnect
    fireEvent.click(screen.getByRole('button', { name: /Back to account/i }));
    fireEvent.click(screen.getByTestId('wallet-modal-disconnect'));
    expect(controller.disconnect).toHaveBeenCalledTimes(1);
    expect(dialog.open).toBe(false);
  });
});
