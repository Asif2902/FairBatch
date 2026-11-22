import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { BatchPhase, ClaimableDto, OrderDto, StateResponse } from '../types';
import type { FairBatchController } from '../onchain/useFairBatch';
import type { OnchainSnapshot } from '../onchain/state';
import { DEFAULT_RUNTIME_CONFIG } from '../onchain/config';
import { computeBatchSettlement } from '../lib/clearingMath';
import App from '../App';
import { SimpleExperience } from '../components/SimpleExperience';
import { useKeeperStatus } from '../onchain/useKeeperStatus';

const ALICE = '0x9AFe5CeF11fC10756faef213f7A30D9873B5d372';
const BATCH_ID = 10;

let controller: FairBatchController;

vi.mock('../onchain/useFairBatch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../onchain/useFairBatch')>();
  return {
    ...actual,
    useFairBatch: () => controller,
  };
});

function buildSnapshot(options: {
  phase?: BatchPhase;
  orders?: OrderDto[];
  claimable?: ClaimableDto[];
  baseBal?: bigint;
  quoteBal?: bigint;
  lpShares?: bigint;
  lockedShares?: bigint;
  unlockTime?: bigint;
} = {}): OnchainSnapshot {
  const phase = options.phase ?? 'Open';
  const orders = options.orders ?? [];
  const claimable = options.claimable ?? [];
  const settlement = computeBatchSettlement(BATCH_ID, 100, 300_000, orders);
  const nowSecs = Math.floor(Date.now() / 1000);

  const state: StateResponse = {
    batch_id: BATCH_ID,
    phase,
    commit_duration_secs: 60,
    reveal_duration_secs: 60,
    phase_remaining_secs: 42,
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
    orders,
    claimable,
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
      batchId: BigInt(BATCH_ID),
      startTime: BigInt(nowSecs - 20),
      commitDeadline: BigInt(nowSecs + 40),
      revealDeadline: BigInt(nowSecs + 100),
      orderCount: BigInt(orders.length),
      commitCount: 0n,
      phase: phase === 'Reveal' ? 1 : phase === 'Ready' ? 2 : 0,
    },
    reserves: {
      reserveBase: 100n * 10n ** 18n,
      reserveQuote: 300_000n * 10n ** 6n,
      totalShares: 5_477n * 10n ** 18n,
      spotPriceWad: 3_000n * 10n ** 18n,
    },
    balances: {
      eth: 10n ** 17n,
      base: options.baseBal ?? 1n * 10n ** 18n,
      quote: options.quoteBal ?? 100n * 10n ** 6n,
      lpShares: options.lpShares ?? 50n * 10n ** 18n,
    },
    allowances: { base: 0n, quote: 0n },
    lpLock: {
      lockedShares: options.lockedShares ?? 0n,
      unlockTime: options.unlockTime ?? 0n,
      unlockedShares: (options.lpShares ?? 50n * 10n ** 18n) - (options.lockedShares ?? 0n),
    },
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
    orders: orders.map((o) => ({
      ...o,
      batch_id: BATCH_ID,
      amount_in_raw: 0n,
      limit_price_raw: 0n,
      mode: 0,
    })),
    commitments: [],
    allCommitments: [],
    batchSettled: false,
    claimable,
    settledHistory: [],
    activeSettlement: settlement,
    blockTimestamp: nowSecs,
    chainTimeOffsetSecs: 0,
    lastUpdated: Date.now(),
  };
}

function makeCtrl(overrides: Partial<FairBatchController> = {}): FairBatchController {
  const snapshot = overrides.snapshot ?? buildSnapshot();
  return {
    config: DEFAULT_RUNTIME_CONFIG,
    hasWallet: true,
    account: null,
    walletChainId: DEFAULT_RUNTIME_CONFIG.chainId,
    snapshot,
    livePhase: overrides.livePhase ?? snapshot.state.phase,
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
    switchNetwork: vi.fn(async () => undefined),
    disconnect: vi.fn(),
    refresh: vi.fn(),
    clearNotice: vi.fn(),
    submitDirect: vi.fn(async () => ({ hash: `0x${'11'.repeat(32)}`, receipt: {}, orderId: 0 })),
    settleAndSubmitDirect: vi.fn(async () => ({
      hash: `0x${'22'.repeat(32)}`,
      receipt: {},
      orderId: 0,
      settledPreviousBatchId: BATCH_ID,
    })),
    signAndSubmitIntent: vi.fn(async () => ({
      hash: `0x${'33'.repeat(32)}`,
      receipt: {},
      orderId: 0,
    })),
    sealCommit: vi.fn(async () => ({ hash: '0x', receipt: {}, commitId: 0 })),
    revealCommit: vi.fn(async () => ({ hash: '0x', receipt: {}, orderId: 0 })),
    signIntent: vi.fn(async () => ({
      trader: ALICE,
      label: 'Signed',
      side: 'SellBase' as const,
      amount_in: 0.5,
      limit_price: 2760,
      amount_in_raw: '500000000000000000',
      limit_price_raw: '2760000000000000000000',
      batch_id: BATCH_ID,
      nonce: 0,
      deadline: Math.floor(Date.now() / 1000) + 3600,
      signature: `0x${'ab'.repeat(65)}`,
      digest: `0x${'cd'.repeat(32)}`,
    })),
    submitIntent: vi.fn(async () => ({ hash: `0x${'34'.repeat(32)}`, receipt: {}, orderId: 0 })),
    relayIntent: vi.fn(async () => ({
      status: 'submitted' as const,
      relayed: true,
      hash: `0x${'35'.repeat(32)}`,
      orderId: 0,
    })),
    settle: vi.fn(async () => ({ hash: `0x${'44'.repeat(32)}`, batchId: BATCH_ID })),
    slash: vi.fn(async () => ({ hash: '0x', forfeitedBond: 0n })),
    claim: vi.fn(async () => ({
      hash: `0x${'55'.repeat(32)}`,
      payoutBase: 0n,
      payoutQuote: 1_500n * 10n ** 6n,
    })),
    claimMany: vi.fn(async () => ({ hash: `0x${'66'.repeat(32)}`, claimed: 2 })),
    addLiquidity: vi.fn(async () => ({ hash: `0x${'77'.repeat(32)}`, receipt: {} })),
    removeLiquidity: vi.fn(async () => ({ hash: `0x${'88'.repeat(32)}`, receipt: {} })),
    claimFaucet: vi.fn(async () => ({
      hash: `0x${'99'.repeat(32)}`,
      receipt: {},
      baseAmount: 1n * 10n ** 18n,
      quoteAmount: 100n * 10n ** 6n,
      nextClaimAt: 0n,
    })),
    approve: vi.fn(async () => null),
    ...overrides,
  } as unknown as FairBatchController;
}

describe('Simple mode end-to-end flows', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    try {
      localStorage.clear();
    } catch {
      // ignore
    }
  });

  it('shows install links when no Ethereum wallet exists', () => {
    controller = makeCtrl({ hasWallet: false, account: null });
    render(<App />);
    expect(screen.getByText(/No Ethereum wallet detected/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Install MetaMask/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Install Rabby/i })).toBeInTheDocument();
  });

  it('shows Switch to Sepolia on wrong network and invokes switchNetwork', async () => {
    controller = makeCtrl({ account: ALICE, wrongNetwork: true, walletChainId: 1 });
    render(<App />);
    const btn = screen.getByTestId('simple-switch-network-button');
    fireEvent.click(btn);
    await waitFor(() => {
      expect(controller.switchNetwork).toHaveBeenCalledTimes(1);
    });
  });

  it('shows Step 2 Faucet when user holds 0 test tokens and calls claimFaucet', async () => {
    controller = makeCtrl({
      account: ALICE,
      snapshot: buildSnapshot({ baseBal: 0n, quoteBal: 0n }),
    });
    render(<App />);
    const faucetBtn = screen.getByTestId('simple-faucet-button');
    expect(faucetBtn).toHaveTextContent(/Get free test tokens/i);
    fireEvent.click(faucetBtn);
    await waitFor(() => {
      expect(controller.claimFaucet).toHaveBeenCalledTimes(1);
    });
  });

  it('auto-routes via EIP-712 signed swap during Finalizing (Reveal) phase', async () => {
    controller = makeCtrl({
      account: ALICE,
      livePhase: 'Reveal',
      snapshot: buildSnapshot({ phase: 'Reveal' }),
    });
    render(<App />);
    expect(screen.getByTestId('simple-finalizing-notice')).toBeInTheDocument();
    const swapBtn = screen.getByTestId('simple-swap-button');
    expect(swapBtn).toHaveTextContent(/Swap now \(sign & send\)/i);

    fireEvent.click(swapBtn);
    await waitFor(() => {
      expect(controller.signAndSubmitIntent).toHaveBeenCalledTimes(1);
    });
  });

  it('combines settle + direct order into one multicall when round is Ready', async () => {
    controller = makeCtrl({
      account: ALICE,
      livePhase: 'Ready',
      snapshot: buildSnapshot({ phase: 'Ready' }),
    });
    render(<App />);
    expect(screen.getByTestId('simple-ready-banner')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('simple-swap-button'));
    await waitFor(() => {
      expect(controller.settleAndSubmitDirect).toHaveBeenCalledTimes(1);
    });
  });

  it('shows Waiting card when the connected wallet has a live order in the active round', () => {
    controller = makeCtrl({
      account: ALICE,
      livePhase: 'Open',
      snapshot: buildSnapshot({
        phase: 'Open',
        orders: [
          {
            order_id: 0,
            trader: ALICE,
            label: 'Alice',
            side: 'SellBase',
            amount_in: 0.5,
            limit_price: 2760,
            submission_type: 'Direct',
            is_attacker: false,
          },
        ],
      }),
    });
    render(<App />);
    expect(screen.getByTestId('simple-waiting-card')).toBeInTheDocument();
    expect(screen.getByText(/Waiting for this round to close/i)).toBeInTheDocument();
  });

  it('collects multiple settled receipts in one multicall and opens Earn tab with custom lock', async () => {
    const receipts: ClaimableDto[] = [
      {
        batch_id: 8,
        order_id: 0,
        trader: ALICE,
        label: 'Alice',
        side: 'SellBase',
        status: 'Filled',
        amount_in: 0.5,
        amount_filled: 0.5,
        payout_out: 1475,
        refund_in: 0,
        effective_price: 2950,
        claimed: false,
      },
      {
        batch_id: 9,
        order_id: 0,
        trader: ALICE,
        label: 'Alice',
        side: 'SellBase',
        status: 'Filled',
        amount_in: 0.5,
        amount_filled: 0.5,
        payout_out: 1460,
        refund_in: 0,
        effective_price: 2920,
        claimed: false,
      },
    ];
    controller = makeCtrl({
      account: ALICE,
      snapshot: buildSnapshot({ claimable: receipts }),
    });
    render(<App />);

    const collectBtn = screen.getByTestId('simple-collect-button');
    expect(collectBtn).toHaveTextContent(/Collect all 2 orders/i);
    fireEvent.click(collectBtn);
    await waitFor(() => {
      expect(controller.claimMany).toHaveBeenCalledWith(receipts);
    });

    // Switch to Earn tab and test custom lock duration + Add liquidity
    fireEvent.click(screen.getByTestId('simple-tab-earn'));
    expect(screen.getByTestId('simple-earn-view')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('simple-earn-lock-toggle'));
    fireEvent.click(screen.getByRole('button', { name: 'Custom' }));
    fireEvent.change(screen.getByTestId('simple-custom-lock-input'), {
      target: { value: '45' },
    });
    fireEvent.click(screen.getByTestId('simple-earn-add-button'));
    await waitFor(() => {
      expect(controller.addLiquidity).toHaveBeenCalledWith(
        '0.02',
        '60',
        2700, // 45 minutes in seconds
        expect.any(BigInt),
      );
    });
  });

  it('opens How it works, Why Fe, and MEV Sandwich Simulation modals cleanly', () => {
    controller = makeCtrl({ account: ALICE });
    render(<App />);

    fireEvent.click(screen.getByTestId('simple-how-it-works-link'));
    expect(screen.getByText(/How FairBatch works/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Got it/i }));

    fireEvent.click(screen.getByTestId('header-more-menu'));
    fireEvent.click(screen.getByRole('menuitem', { name: /Why Fe/i }));
    expect(screen.getByText(/Verified Fe 26\.5\.0 contracts/i)).toBeInTheDocument();
    expect(screen.getAllByText(/src\/clearing\.fe/i).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: /Close Why Fe modal/i }));

    fireEvent.click(screen.getByTestId('header-more-menu'));
    fireEvent.click(screen.getByRole('menuitem', { name: /MEV sandwich simulation/i }));
    expect(
      screen.getByText(/Client-side simulation — not an on-chain result/i),
    ).toBeInTheDocument();
  });

  it('aggregates multiple ready orders in the same round and shows sold amount on each row', () => {
    const sameRoundReceipts: ClaimableDto[] = [
      {
        batch_id: 11,
        order_id: 0,
        trader: ALICE,
        label: 'Alice #1',
        side: 'SellBase',
        status: 'Filled',
        amount_in: 0.1,
        amount_filled: 0.1,
        payout_out: 297.6,
        refund_in: 0,
        effective_price: 2976,
        claimed: false,
      },
      {
        batch_id: 11,
        order_id: 1,
        trader: ALICE,
        label: 'Alice #2',
        side: 'SellBase',
        status: 'Filled',
        amount_in: 0.05,
        amount_filled: 0.05,
        payout_out: 148.8,
        refund_in: 0,
        effective_price: 2976,
        claimed: false,
      },
    ];
    controller = makeCtrl({
      account: ALICE,
      snapshot: buildSnapshot({ claimable: sameRoundReceipts }),
    });
    render(<App />);

    const summary = screen.getByTestId('simple-collect-summary');
    expect(summary).toHaveTextContent(
      /You sold 0\.15 fWETH total, received 446\.40 fUSDC total \(0\.10 \+ 0\.05 fWETH → 446\.40 fUSDC\)/i,
    );
    expect(screen.getByTestId('simple-collect-row-11-0')).toHaveTextContent(/Sold 0\.10 fWETH/i);
    expect(screen.getByTestId('simple-collect-row-11-1')).toHaveTextContent(/Sold 0\.05 fWETH/i);
  });

  it('shows low Sepolia ETH gas onboarding notice (< 0.002 ETH) and clears non-error banners on tab switch', () => {
    const lowEthSnap = buildSnapshot();
    lowEthSnap.balances.eth = 500_000_000_000_000n; // 0.0005 ETH (< 0.002 ETH)
    controller = makeCtrl({
      account: ALICE,
      snapshot: lowEthSnap,
      notice: { kind: 'success', text: 'Order confirmed.' },
    });
    render(<App />);

    const gasNotice = screen.getByTestId('low-gas-notice');
    expect(gasNotice).toHaveTextContent(/You need a little Sepolia ETH for gas/i);
    expect(gasNotice).toHaveTextContent(/0\.0001 ETH/i);

    // Switching Swap -> Earn clears non-error notice
    fireEvent.click(screen.getByTestId('simple-tab-earn'));
    expect(controller.clearNotice).toHaveBeenCalledTimes(1);
  });

  it('opens in-app /docs route from header, modal, and footer with User Guide, Developer Guide, Visuals, Threat Table, and Glossary', async () => {
    controller = makeCtrl({ account: ALICE });
    render(<App />);

    // Open from header Docs link
    fireEvent.click(screen.getByTestId('header-docs-link'));
    expect(await screen.findByTestId('docs-page')).toBeInTheDocument();

    // User guide content
    expect(screen.getByTestId('docs-user-guide')).toBeInTheDocument();
    expect(screen.getByText(/FairBatch in 60 seconds/i)).toBeInTheDocument();
    expect(screen.getByText(/Not fully free — what you still pay gas for/i)).toBeInTheDocument();

    // Developer guide content with verified Fe test names and live addresses
    fireEvent.click(screen.getByTestId('docs-tab-developer'));
    expect(screen.getByTestId('docs-developer-guide')).toBeInTheDocument();
    expect(screen.getByText(/proof_mev_sandwich_zero_profit/i)).toBeInTheDocument();
    expect(screen.getByText(/property_order_permutation_invariance/i)).toBeInTheDocument();
    expect(screen.getByText(/property_lnd_invariant_across_imbalanced_regimes/i)).toBeInTheDocument();
    expect(screen.getByText(DEFAULT_RUNTIME_CONFIG.fairBatch)).toBeInTheDocument();

    // Visuals & Animations (5 diagrams)
    fireEvent.click(screen.getByTestId('docs-tab-visuals'));
    expect(screen.getByTestId('docs-anim-sandwich')).toBeInTheDocument();
    expect(screen.getByTestId('docs-anim-lifecycle')).toBeInTheDocument();
    expect(screen.getByTestId('docs-anim-one-price')).toBeInTheDocument();
    expect(screen.getByTestId('docs-anim-sealed')).toBeInTheDocument();
    expect(screen.getByTestId('docs-anim-roles')).toBeInTheDocument();

    // Threat model table
    fireEvent.click(screen.getByTestId('docs-tab-security'));
    expect(screen.getByTestId('docs-threat-table')).toBeInTheDocument();

    // Glossary with stable anchors
    fireEvent.click(screen.getByTestId('docs-tab-glossary'));
    expect(screen.getByTestId('docs-glossary')).toBeInTheDocument();
    expect(screen.getByTestId('glossary-round')).toBeInTheDocument();
    expect(screen.getByTestId('glossary-fair-price')).toBeInTheDocument();

    // Back to exchange
    fireEvent.click(screen.getByTestId('docs-back-button'));
    expect(screen.getByTestId('simple-swap-card')).toBeInTheDocument();
  });

  it('shows auto-settling keeper message when keeper is healthy and falls back to Start next round when offline', () => {
    const readyCtrl = makeCtrl({
      account: ALICE,
      livePhase: 'Ready',
      snapshot: buildSnapshot({ phase: 'Ready' }),
    });

    const { rerender } = render(
      <SimpleExperience
        controller={readyCtrl}
        keeperHealthy={true}
        keeperGraceSeconds={5}
        onOpenHowItWorks={() => undefined}
      />,
    );
    expect(screen.getByTestId('simple-ready-banner')).toHaveTextContent(
      /Round closes, settling automatically in about 5s/i,
    );
    expect(screen.queryByTestId('simple-start-next-round')).not.toBeInTheDocument();

    rerender(
      <SimpleExperience
        controller={readyCtrl}
        keeperHealthy={false}
        keeperGraceSeconds={5}
        onOpenHowItWorks={() => undefined}
      />,
    );
    expect(screen.getByTestId('simple-start-next-round')).toHaveTextContent(/Start next round/i);
  });

  it('supports optional intent relayer in Simple mode with gas disclosure and Submit it myself fallback', async () => {
    const relayIntent = vi
      .fn()
      .mockRejectedValueOnce(new Error('Relayer queue is full.'))
      .mockResolvedValue({ status: 'submitted', relayed: true, hash: `0x${'35'.repeat(32)}`, orderId: 1 });
    const submitIntent = vi.fn(async () => ({
      hash: `0x${'34'.repeat(32)}`,
      receipt: {},
      orderId: 1,
    }));
    const ctrl = makeCtrl({
      account: ALICE,
      snapshot: buildSnapshot({ phase: 'Reveal', baseBal: 1n * 10n ** 18n }),
      livePhase: 'Reveal',
      relayIntent: relayIntent as unknown as FairBatchController['relayIntent'],
      submitIntent: submitIntent as unknown as FairBatchController['submitIntent'],
    });

    render(
      <SimpleExperience
        controller={ctrl}
        keeperHealthy={true}
        keeperGraceSeconds={5}
        relayerHealthy={true}
        relayGraceSeconds={5}
        keeperUrl="http://localhost:3002"
        onOpenHowItWorks={() => undefined}
      />,
    );

    // Reveal auto-selects signed flow and shows relayer info + clear gas disclosure
    const relayerBox = screen.getByTestId('simple-relayer-info');
    expect(relayerBox).toHaveTextContent(/no submission gas/i);
    expect(relayerBox).toHaveTextContent(/one-time token approval/i);
    expect(relayerBox).toHaveTextContent(/collecting payouts/i);
    expect(screen.getByTestId('simple-swap-button')).toHaveTextContent(/Sign & relay swap/i);

    // Trigger relay; first call rejects -> "Submit it myself" retry button appears without re-signing
    fireEvent.click(screen.getByTestId('simple-swap-button'));
    await waitFor(() => expect(relayIntent).toHaveBeenCalledTimes(1));
    expect(ctrl.signIntent).toHaveBeenCalledTimes(1);
    const retryBtn = await screen.findByTestId('simple-submit-signed-myself-retry');
    expect(retryBtn).toHaveTextContent(/Submit it myself/i);

    fireEvent.click(retryBtn);
    await waitFor(() => expect(submitIntent).toHaveBeenCalledTimes(1));
  });

  it('supports same-origin relative /keeper proxy path in useKeeperStatus without CORS or domain rebuild', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: 'ok',
          lowBalance: false,
          dryRun: false,
          graceSeconds: 5,
          relayerEnabled: true,
          relayGraceSeconds: 5,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const Probe = () => {
      const ks = useKeeperStatus('/keeper');
      return (
        <div data-testid="keeper-probe">
          {ks.keeperUrl}|{String(ks.healthy)}|{String(ks.relayerHealthy)}
        </div>
      );
    };

    render(<Probe />);
    await waitFor(() =>
      expect(screen.getByTestId('keeper-probe')).toHaveTextContent('/keeper|true|true'),
    );
    expect(fetchSpy).toHaveBeenCalledWith(
      '/keeper/health',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    fetchSpy.mockRestore();
  });

  it('validates balances, sealed deposit, and gas in Simple Swap and Simple Earn while keeping Max working', () => {
    const lowBaseSnap = buildSnapshot({
      baseBal: 754_800_000_000_000_000n, // 0.7548 fWETH
      quoteBal: 50n * 10n ** 6n,
      lpShares: 10n * 10n ** 18n,
    });
    controller = makeCtrl({
      account: ALICE,
      snapshot: lowBaseSnap,
    });
    const { rerender } = render(<App />);

    // Enter amount > balance on Simple Swap
    const swapInput = screen.getByTestId('simple-pay-input');
    fireEvent.change(swapInput, { target: { value: '2' } });
    expect(screen.getByTestId('simple-insufficient-balance')).toHaveTextContent(
      'Insufficient fWETH balance (0.7548)',
    );
    expect(screen.getByTestId('simple-swap-button')).toBeDisabled();

    // Clicking Max fills 0.7548 and re-enables swap button
    fireEvent.click(screen.getByRole('button', { name: 'Max' }));
    expect(screen.queryByTestId('simple-insufficient-balance')).not.toBeInTheDocument();
    expect(screen.getByTestId('simple-swap-button')).toBeEnabled();

    // Sealed order with insufficient ETH for bond + gas disables button
    const tinyEthSnap = buildSnapshot({
      baseBal: 754_800_000_000_000_000n,
      quoteBal: 50n * 10n ** 6n,
      lpShares: 10n * 10n ** 18n,
    });
    tinyEthSnap.balances.eth = 50_000_000_000_000n; // 0.00005 ETH (< 0.0001 bond)
    controller = makeCtrl({
      account: ALICE,
      snapshot: tinyEthSnap,
    });
    rerender(<App />);
    fireEvent.click(screen.getByRole('button', { name: /More privacy options/i }));
    fireEvent.click(screen.getByRole('button', { name: /Private \(sealed\)/i }));
    expect(screen.getByTestId('simple-insufficient-bond')).toHaveTextContent(
      /Insufficient ETH balance/i,
    );
    expect(screen.getByTestId('simple-swap-button')).toBeDisabled();

    // Zero ETH shows explicit gas warning and disables swap
    const zeroEthSnap = buildSnapshot({
      baseBal: 754_800_000_000_000_000n,
      quoteBal: 50n * 10n ** 6n,
      lpShares: 10n * 10n ** 18n,
    });
    zeroEthSnap.balances.eth = 0n;
    controller = makeCtrl({
      account: ALICE,
      snapshot: zeroEthSnap,
    });
    rerender(<App />);
    expect(screen.getByTestId('simple-insufficient-gas')).toHaveTextContent(
      /Insufficient Sepolia ETH for gas/i,
    );
    expect(screen.getByTestId('simple-swap-button')).toBeDisabled();

    // Switch to Simple Earn with healthy ETH and validate add/withdraw inputs
    controller = makeCtrl({
      account: ALICE,
      snapshot: lowBaseSnap,
    });
    rerender(<App />);
    fireEvent.click(screen.getByTestId('simple-tab-earn'));

    // Default add inputs are 0.02 fWETH / 60 fUSDC, while quote balance is 50 fUSDC -> quote insufficient!
    expect(screen.getByTestId('simple-earn-insufficient-quote')).toHaveTextContent(
      'Insufficient fUSDC balance (50.00)',
    );
    expect(screen.getByTestId('simple-earn-add-button')).toBeDisabled();

    // Enter 2 fWETH -> base insufficient too
    fireEvent.change(screen.getByTestId('simple-earn-base-input'), { target: { value: '2' } });
    expect(screen.getByTestId('simple-earn-insufficient-base')).toHaveTextContent(
      'Insufficient fWETH balance (0.7548)',
    );

    // Withdraw section is visible below on Simple Earn; enter > 10 shares
    fireEvent.change(screen.getByTestId('simple-earn-withdraw-input'), {
      target: { value: '25' },
    });
    expect(screen.getByTestId('simple-earn-insufficient-withdraw')).toHaveTextContent(
      'Insufficient LP shares balance (10.00)',
    );
    expect(screen.getByTestId('simple-earn-withdraw-button')).toBeDisabled();
  });
});
