import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { BatchPhase, ClaimableDto, OrderDto, StateResponse } from '../types';
import type { FairBatchController } from '../onchain/useFairBatch';
import type { FaucetState, LiquidityLockState, OnchainSnapshot, WalletBalances } from '../onchain/state';
import { DEFAULT_RUNTIME_CONFIG } from '../onchain/config';
import { computeBatchSettlement } from '../lib/clearingMath';
import { formatPrice } from '../lib/format';
import { BatchConsole } from '../components/BatchConsole';
import App from '../App';

const ALICE = '0x9AFe5CeF11fC10756faef213f7A30D9873B5d372';
const BOB = '0x1234567890123456789012345678901234567890';
const BATCH_ID = 8;

const ORDERS: OrderDto[] = [
  {
    order_id: 0,
    trader: ALICE,
    label: '0x9AFe…d372 · direct',
    side: 'SellBase',
    amount_in: 2,
    limit_price: 2650,
    submission_type: 'Direct',
    is_attacker: false,
  },
  {
    order_id: 1,
    trader: BOB,
    label: '0x1234…7890 · signed',
    side: 'BuyBase',
    amount_in: 6000,
    limit_price: 3200,
    submission_type: 'Eip712Intent',
    is_attacker: false,
  },
];

const CLAIMS: ClaimableDto[] = [
  {
    batch_id: 7,
    order_id: 0,
    trader: ALICE,
    label: '0x9AFe…d372 · sealed',
    side: 'SellBase',
    status: 'Filled',
    amount_in: 1.5,
    amount_filled: 1.5,
    payout_out: 4500,
    refund_in: 0,
    effective_price: 3000,
    claimed: false,
  },
  {
    batch_id: 7,
    order_id: 1,
    trader: BOB,
    label: '0x1234…7890 · signed',
    side: 'BuyBase',
    status: 'PartialFill',
    amount_in: 6000,
    amount_filled: 3000,
    payout_out: 1,
    refund_in: 3000,
    effective_price: 3000,
    claimed: false,
  },
];

let controller: FairBatchController;

function makeSnapshot(
  phase: BatchPhase,
  _account: string | null = null,
  overrides: {
    lpLock?: Partial<LiquidityLockState>;
    faucet?: Partial<FaucetState>;
    balances?: Partial<WalletBalances>;
  } = {},
): OnchainSnapshot {
  const balances: WalletBalances = {
    eth: 10n ** 18n,
    base: 5n * 10n ** 18n,
    quote: 20_000n * 10n ** 6n,
    lpShares: 100n * 10n ** 18n,
    ...overrides.balances,
  };
  const lockedShares = overrides.lpLock?.lockedShares ?? 0n;
  const unlockedShares =
    overrides.lpLock?.unlockedShares ??
    (balances.lpShares > lockedShares ? balances.lpShares - lockedShares : 0n);
  const settlement = computeBatchSettlement(BATCH_ID, 100, 300_000, ORDERS);
  const state: StateResponse = {
    batch_id: BATCH_ID,
    phase,
    commit_duration_secs: 60,
    reveal_duration_secs: 60,
    phase_remaining_secs: 30,
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
    commitments: [
      {
        commit_id: 4,
        trader: ALICE,
        commitment_hash: `0x${'11'.repeat(32)}`,
        bond_eth: 0.001,
        revealed: false,
        slashed: false,
      },
    ],
    orders: ORDERS,
    claimable: CLAIMS,
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
      startTime: 1_000n,
      commitDeadline: 1_060n,
      revealDeadline: 1_120n,
      orderCount: 2n,
      commitCount: 1n,
      phase: phase === 'Reveal' ? 1 : phase === 'Ready' ? 2 : phase === 'Settled' ? 3 : 0,
    },
    reserves: {
      reserveBase: 100_000_000_000_000_000_000n,
      reserveQuote: 300_000_000_000n,
      totalShares: 5_477_225_575_051_661_134_569n,
      spotPriceWad: 3_000n * 10n ** 18n,
    },
    balances,
    allowances: { base: 10n ** 24n, quote: 10n ** 24n },
    lpLock: {
      lockedShares,
      unlockTime: overrides.lpLock?.unlockTime ?? 0n,
      unlockedShares,
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
      ...overrides.faucet,
    },
    nonce: 3n,
    domainSeparator: `0x${'22'.repeat(32)}`,
    minBondWei: 100_000_000_000_000n,
    orders: ORDERS.map((order) => ({
      ...order,
      batch_id: BATCH_ID,
      amount_in_raw: 0n,
      limit_price_raw: 0n,
      mode: 0,
    })),
    commitments: [
      {
        batch_id: BATCH_ID,
        commit_id: 4,
        trader: ALICE,
        commitment_hash: `0x${'11'.repeat(32)}`,
        bond_eth: 0.001,
        bond_wei: 100_000_000_000_000n,
        revealed: false,
        slashed: false,
      },
    ],
    allCommitments: [],
    batchSettled: false,
    claimable: CLAIMS,
    settledHistory: [],
    activeSettlement: settlement,
    blockTimestamp: Math.floor(Date.now() / 1000),
    chainTimeOffsetSecs: 0,
    lastUpdated: Date.now(),
  };
}

function makeController(
  overrides: Partial<FairBatchController> = {},
): FairBatchController {
  const account = overrides.account ?? null;
  const snapshot = overrides.snapshot ?? makeSnapshot('Open', account);
  return {
    config: DEFAULT_RUNTIME_CONFIG,
    hasWallet: true,
    account,
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
    submitDirect: vi.fn(async () => ({ hash: '0x', receipt: {}, orderId: 1 })),
    settleAndSubmitDirect: vi.fn(async () => ({ hash: '0x', receipt: {}, orderId: 1 })),
    signAndSubmitIntent: vi.fn(async () => ({ hash: '0x', receipt: {}, orderId: 1 })),
    sealCommit: vi.fn(async () => ({ hash: '0x', receipt: {} })),
    revealCommit: vi.fn(async () => ({ hash: '0x', receipt: {} })),
    signIntent: vi.fn(async () => ({
      trader: ALICE,
      label: 'Signed',
      side: 'SellBase' as const,
      amount_in: 2,
      limit_price: 2650,
      amount_in_raw: '2000000000000000000',
      limit_price_raw: '2650000000000000000000',
      batch_id: BATCH_ID,
      nonce: 0,
      deadline: 1,
      signature: `0x${'33'.repeat(65)}`,
      digest: `0x${'44'.repeat(32)}`,
    })),
    submitIntent: vi.fn(async () => ({ hash: '0x', receipt: {} })),
    relayIntent: vi.fn(async () => ({ status: 'submitted', relayed: true, hash: '0x', orderId: 1 })),
    settle: vi.fn(async () => ({ hash: '0x', batchId: BATCH_ID })),
    slash: vi.fn(async () => ({ hash: '0x', forfeitedBond: 0n })),
    claim: vi.fn(async () => ({ hash: '0x', payoutBase: 0n, payoutQuote: 0n })),
    claimMany: vi.fn(async () => ({ hash: '0x', claimed: 1 })),
    addLiquidity: vi.fn(async () => ({ hash: '0x', receipt: {} })),
    removeLiquidity: vi.fn(async () => ({ hash: '0x', receipt: {} })),
    claimFaucet: vi.fn(async () => ({
      hash: '0x',
      receipt: {},
      baseAmount: 10n ** 18n,
      quoteAmount: 100n * 10n ** 6n,
      nextClaimAt: 0n,
    })),
    approve: vi.fn(async () => null),
    ...overrides,
  } as unknown as FairBatchController;
}

vi.mock('../onchain/useFairBatch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../onchain/useFairBatch')>();
  return {
    ...actual,
    useFairBatch: () => controller,
  };
});

describe('FairBatch on-chain terminal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    try {
      localStorage.clear();
    } catch {
      // ignore if unavailable
    }
    controller = makeController();
  });

  function renderPro() {
    const view = render(<App />);
    fireEvent.click(screen.getByTestId('mode-pro-button'));
    return view;
  }

  it('defaults to Simple mode with progress strip, plain swap card, and Ready-round banner', async () => {
    controller = makeController({
      account: ALICE,
      snapshot: makeSnapshot('Ready', ALICE),
    });
    const { rerender } = render(<App />);

    expect(screen.getByTestId('mode-simple-button')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('simple-progress-strip')).toBeInTheDocument();
    // Alice has an unclaimed receipt in CLAIMS -> Step 4 Collect card is shown first
    expect(screen.getByTestId('simple-collect-card')).toBeInTheDocument();

    // Without unclaimed receipts, Alice sees the Ready banner & Swap card
    const cleanSnap = makeSnapshot('Ready', ALICE);
    cleanSnap.claimable = [];
    cleanSnap.orders = [];
    cleanSnap.state.orders = [];
    cleanSnap.commitments = [];
    controller = makeController({ account: ALICE, snapshot: cleanSnap });
    rerender(<App />);
    expect(screen.getByTestId('simple-ready-banner')).toBeInTheDocument();
    expect(screen.getByTestId('simple-swap-button')).toHaveTextContent(
      /Start next round & Swap/i,
    );
  });

  it('renders the live batch, reserves and clearing preview from chain snapshot', () => {
    renderPro();
    const settlement = computeBatchSettlement(BATCH_ID, 100, 300_000, ORDERS);

    expect(screen.getByTestId('batch-id-badge')).toHaveTextContent(
      `BATCH #${BATCH_ID}`,
    );
    expect(screen.getByTestId('reserve-rx')).toHaveTextContent('100.00 fWETH');
    expect(screen.getByTestId('reserve-ry')).toHaveTextContent('300,000 fUSDC');
    expect(screen.getByTestId('pool-spot-price')).toHaveTextContent('$3,000.00');
    expect(screen.getByTestId('connection-status-badge')).toHaveTextContent(
      'Read-only · live RPC',
    );
    expect(
      screen.getByRole('img', { name: /Batch Supply and Demand Depth Chart/i }),
    ).toBeInTheDocument();
    expect(screen.getByTestId('uniform-clearing-price-readout')).toHaveTextContent(
      `$${formatPrice(settlement.clearing_price, 2)} fUSDC/fWETH`,
    );
    expect(screen.getByTestId('account-connect-button')).toBeInTheDocument();
  });

  it('enables permissionless settlement only for a connected wallet in the ready phase', async () => {
    controller = makeController({
      account: ALICE,
      snapshot: makeSnapshot('Ready', ALICE),
    });
    renderPro();

    const settleButton = screen.getByTestId('settle-batch-button');
    expect(settleButton).not.toBeDisabled();

    fireEvent.click(settleButton);
    await waitFor(() => {
      expect(controller.settle).toHaveBeenCalledTimes(1);
    });
  });

  it('keeps settlement locked while the commit window is still open', () => {
    renderPro();
    expect(screen.queryByTestId('settle-batch-button')).not.toBeInTheDocument();
    expect(
      screen.getByText(/Settlement opens after the reveal window/i),
    ).toBeInTheDocument();
  });

  it('submits a sealed commitment through the connected wallet', async () => {
    controller = makeController({ account: ALICE });
    renderPro();

    fireEvent.click(screen.getByRole('tab', { name: /Commit-Reveal/i }));
    fireEvent.change(screen.getByLabelText(/You pay/i), { target: { value: '2.0' } });
    fireEvent.click(
      screen.getByRole('button', { name: /Seal & lock commitment/i }),
    );

    await waitFor(() => {
      expect(controller.sealCommit).toHaveBeenCalledTimes(1);
    });
    expect(controller.sealCommit).toHaveBeenCalledWith(
      expect.objectContaining({
        side: 'SellBase',
        amountIn: '2.0',
        limitPrice: '2760',
        bondEth: '0.001',
      }),
    );
    expect(
      await screen.findByText(/Sealed commitment confirmed/i),
    ).toBeInTheDocument();
  });

  it('lets only the connected owner claim settled receipts', async () => {
    controller = makeController({ account: ALICE });
    renderPro();

    expect(screen.getByText('Other wallet')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Multicall My Claims \(1\)/i }),
    ).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: /Claim Payout/i }));
    await waitFor(() => {
      expect(controller.claim).toHaveBeenCalledWith(
        expect.objectContaining({ batch_id: 7, order_id: 0, trader: ALICE }),
      );
    });

    fireEvent.click(
      screen.getByRole('button', { name: /Multicall My Claims \(1\)/i }),
    );
    await waitFor(() => {
      expect(controller.claimMany).toHaveBeenCalledWith([
        expect.objectContaining({ batch_id: 7, order_id: 0, trader: ALICE }),
      ]);
    });
  });

  it('claims 1 fWETH + 100 fUSDC from the Sepolia faucet and enforces cooldown display', async () => {
    controller = makeController({ account: ALICE });
    const { rerender } = renderPro();

    const claimBtn = screen.getByTestId('faucet-claim-button');
    expect(claimBtn).toBeEnabled();
    expect(claimBtn).toHaveTextContent(/Claim 1 fWETH \+ 100 fUSDC/i);

    fireEvent.click(claimBtn);
    await waitFor(() => {
      expect(controller.claimFaucet).toHaveBeenCalledTimes(1);
    });

    const futureUnlock = BigInt(Math.floor(Date.now() / 1000) + 3_600);
    controller = makeController({
      account: ALICE,
      snapshot: makeSnapshot('Open', ALICE, {
        faucet: { canClaim: false, nextClaimAt: futureUnlock },
      }),
    });
    rerender(<App />);
    expect(screen.getByTestId('faucet-claim-button')).toBeDisabled();
    expect(screen.getByTestId('faucet-claim-button')).toHaveTextContent(/Next claim in/i);
  });

  it('supports optional liquidity locking when adding liquidity and shows active lock status', async () => {
    const futureUnlock = BigInt(Math.floor(Date.now() / 1000) + 7_200);
    controller = makeController({
      account: ALICE,
      snapshot: makeSnapshot('Open', ALICE, {
        lpLock: {
          lockedShares: 40n * 10n ** 18n,
          unlockTime: futureUnlock,
          unlockedShares: 60n * 10n ** 18n,
        },
      }),
    });
    renderPro();

    expect(screen.getByTestId('lp-lock-banner')).toHaveTextContent(/40\.00 shares locked/i);
    expect(screen.getByTestId('lp-lock-banner')).toHaveTextContent(/60\.00 withdrawable now/i);

    fireEvent.click(screen.getByRole('button', { name: '12 hours' }));
    fireEvent.click(screen.getByTestId('lp-add-submit'));

    await waitFor(() => {
      expect(controller.addLiquidity).toHaveBeenCalledWith(
        '1',
        '3000',
        43_200,
        expect.any(BigInt),
      );
    });
  });

  it('renders the read-only Sepolia deployment modal from config/deployment.json with no local fork controls', () => {
    renderPro();

    fireEvent.click(screen.getByTestId('header-more-menu'));
    fireEvent.click(
      screen.getByRole('menuitem', { name: /Contract & network config/i }),
    );

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText(DEFAULT_RUNTIME_CONFIG.fairBatch)).toBeInTheDocument();
    expect(screen.getByText(DEFAULT_RUNTIME_CONFIG.faucet)).toBeInTheDocument();
    expect(screen.queryByText(/Local Anvil/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Save contract config/i })).not.toBeInTheDocument();
  });

  it('renders transaction notices with an explorer link', () => {
    controller = makeController({
      notice: {
        kind: 'success',
        text: 'Direct order #12 confirmed on-chain.',
        hash: `0x${'ab'.repeat(32)}`,
      },
    });
    render(<App />);

    expect(
      screen.getByText('Direct order #12 confirmed on-chain.'),
    ).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /Tx 0xababab/i });
    expect(link).toHaveAttribute(
      'href',
      `https://sepolia.etherscan.io/tx/0x${'ab'.repeat(32)}`,
    );
  });

  it('displays Pro balance row, per-input Balance + Max, collapsible details, and section tabs', () => {
    controller = makeController({ account: ALICE });
    renderPro();

    // Top balance row with approval status
    expect(screen.getByTestId('pro-balance-row')).toBeInTheDocument();
    expect(screen.getByTestId('pro-balance-eth')).toHaveTextContent('1.00 ETH');
    expect(screen.getByTestId('pro-balance-base')).toHaveTextContent('5.00 fWETH');
    expect(screen.getByTestId('pro-balance-quote')).toHaveTextContent('20,000.00 fUSDC');
    expect(screen.getByTestId('pro-balance-lp')).toHaveTextContent('100.00 shares');
    expect(screen.getByTestId('pro-approval-base')).toHaveTextContent('Approved');
    expect(screen.getByTestId('pro-approval-quote')).toHaveTextContent('Approved');

    // Order slip starts empty (placeholder) and provides 25/50/75/100% + Max balance chips
    const payInput = screen.getByLabelText(/You pay/i) as HTMLInputElement;
    expect(payInput.value).toBe('');
    expect(screen.getByTestId('order-ticket-balance')).toHaveTextContent('Balance: 5.00 fWETH');
    fireEvent.click(screen.getByTestId('order-ticket-pct-25'));
    expect(payInput).toHaveValue(1.25);
    fireEvent.click(screen.getByTestId('order-ticket-pct-50'));
    expect(payInput).toHaveValue(2.5);
    fireEvent.click(screen.getByTestId('order-ticket-pct-75'));
    expect(payInput).toHaveValue(3.75);
    fireEvent.click(screen.getByTestId('order-ticket-pct-100'));
    expect(payInput).toHaveValue(5);
    fireEvent.click(screen.getByTestId('order-ticket-max'));
    expect(payInput).toHaveValue(5);

    // Default minimum price = spot (3000) * (1 - 0.08) = 2760, and label matches the value
    const limitInput = screen.getByLabelText(/Minimum price/i) as HTMLInputElement;
    expect(limitInput).toHaveValue(2760);
    expect(screen.getByTestId('order-ticket-limit-badge')).toHaveTextContent(
      'Spot −8% · $2,760.00',
    );
    // Selecting 5% slippage updates both the limit price (3000 * 0.95 = 2850) and the matching label
    fireEvent.click(screen.getByTestId('order-ticket-slippage-5'));
    expect(limitInput).toHaveValue(2850);
    expect(screen.getByTestId('order-ticket-limit-badge')).toHaveTextContent(
      'Spot −5% · $2,850.00',
    );

    fireEvent.click(screen.getByRole('button', { name: /Buy fWETH/i }));
    expect(screen.getByTestId('order-ticket-balance')).toHaveTextContent('Balance: 20,000.00 fUSDC');

    // Commit-reveal tab shows ETH balance next to 0.0001 ETH deposit
    fireEvent.click(screen.getByRole('tab', { name: /Commit-Reveal/i }));
    expect(screen.getByTestId('order-ticket-eth-balance')).toHaveTextContent('ETH Balance: 1.00 ETH');

    // LP Add shows both balances + Max; LP Remove shows total & unlocked shares
    expect(screen.getByTestId('lp-add-base-balance')).toHaveTextContent('Balance: 5.00');
    expect(screen.getByTestId('lp-add-quote-balance')).toHaveTextContent('Balance: 20,000.00');
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(screen.getByTestId('lp-remove-shares-balance')).toHaveTextContent('Balance: 100.00');
    expect(screen.getByTestId('lp-remove-shares-balance')).toHaveTextContent('Unlocked: 100.00');

    // Secondary details are collapsed by default behind "Show details"
    expect(screen.queryByTestId('pro-reserves-details-panel')).not.toBeInTheDocument();
    expect(screen.queryByTestId('pro-formula-details-panel')).not.toBeInTheDocument();
    expect(screen.queryByTestId('pro-receipts-details-panel')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('pro-reserves-details-toggle'));
    expect(screen.getByTestId('pro-reserves-details-panel')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('pro-formula-details-toggle'));
    expect(screen.getByTestId('pro-formula-details-panel')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('pro-receipts-details-toggle'));
    expect(screen.getByTestId('pro-receipts-details-panel')).toBeInTheDocument();

    // "New here? Switch to Simple" link switches back to Simple mode
    fireEvent.click(screen.getByTestId('pro-switch-to-simple-link'));
    expect(screen.getByTestId('mode-simple-button')).toHaveAttribute('aria-pressed', 'true');
  });

  it('validates balances across Pro order slip, commit bond, LP add/remove, ETH gas, and removes duplicated Settlement Account balances', () => {
    controller = makeController({
      account: ALICE,
      snapshot: makeSnapshot('Open', ALICE, {
        balances: {
          eth: 50_000_000_000_000_000n, // 0.05 ETH
          base: 754_800_000_000_000_000n, // 0.7548 fWETH
          quote: 100_000_000n, // 100 fUSDC
          lpShares: 50n * 10n ** 18n,
        },
      }),
    });
    const { rerender } = renderPro();

    // Top balance row is the single balance source; Settlement Account no longer duplicates balance cells
    expect(screen.getByTestId('pro-balance-base')).toHaveTextContent('0.7548 fWETH');
    expect(screen.queryByTestId('account-balance-base')).not.toBeInTheDocument();
    expect(screen.queryByTestId('account-balance-quote')).not.toBeInTheDocument();
    expect(screen.getByTestId('account-approvals-summary')).toBeInTheDocument();

    // Pro order input starts empty ('') with NO insufficient-balance error before typing
    const payInput = screen.getByLabelText(/You pay/i) as HTMLInputElement;
    expect(payInput.value).toBe('');
    expect(screen.queryByTestId('order-ticket-insufficient-balance')).not.toBeInTheDocument();
    expect(screen.getByTestId('order-ticket-direct-submit')).toBeDisabled();

    // Spot updates default minimum price automatically unless the user edited it
    const limitInput = screen.getByLabelText(/Minimum price/i) as HTMLInputElement;
    expect(limitInput).toHaveValue(2760);
    const updatedSpotSnap = makeSnapshot('Open', ALICE, {
      balances: {
        eth: 50_000_000_000_000_000n,
        base: 754_800_000_000_000_000n,
        quote: 100_000_000n,
        lpShares: 50n * 10n ** 18n,
      },
    });
    updatedSpotSnap.state.reserves.spot_price = 2946.5;
    controller = makeController({ account: ALICE, snapshot: updatedSpotSnap });
    rerender(<App />);
    expect(limitInput).toHaveValue(2710.78);
    expect(screen.getByTestId('order-ticket-limit-badge')).toHaveTextContent(
      'Spot −8% · $2,710.78',
    );

    // Once the user edits the limit price manually, spot changes do NOT overwrite their edit
    fireEvent.change(limitInput, { target: { value: '2680' } });
    const thirdSpotSnap = makeSnapshot('Open', ALICE, {
      balances: {
        eth: 50_000_000_000_000_000n,
        base: 754_800_000_000_000_000n,
        quote: 100_000_000n,
        lpShares: 50n * 10n ** 18n,
      },
    });
    thirdSpotSnap.state.reserves.spot_price = 3100;
    controller = makeController({ account: ALICE, snapshot: thirdSpotSnap });
    rerender(<App />);
    expect(limitInput).toHaveValue(2680);

    // Typing an amount > 0.7548 balance shows the insufficient-balance error and keeps submit disabled
    fireEvent.change(payInput, { target: { value: '2.0' } });
    expect(screen.getByTestId('order-ticket-insufficient-balance')).toHaveTextContent(
      'Insufficient fWETH balance (0.7548)',
    );
    expect(screen.getByTestId('order-ticket-direct-submit')).toBeDisabled();

    // Clicking Max fixes the amount and re-enables submission
    fireEvent.click(screen.getByTestId('order-ticket-max'));
    expect(screen.queryByTestId('order-ticket-insufficient-balance')).not.toBeInTheDocument();
    expect(screen.getByTestId('order-ticket-direct-submit')).toBeEnabled();

    // Commit-Reveal bond exceeding ETH balance shows inline error & disables seal
    fireEvent.click(screen.getByRole('tab', { name: /Commit-Reveal/i }));
    fireEvent.change(screen.getByLabelText(/Reveal bond/i, { selector: 'input' }), {
      target: { value: '0.1' },
    });
    expect(screen.getByTestId('order-ticket-insufficient-bond')).toHaveTextContent(
      'Insufficient ETH balance (0.05)',
    );
    expect(screen.getByTestId('order-ticket-commit-submit')).toBeDisabled();

    // LP Add default inputs (1 fWETH, 3000 fUSDC) exceed balances -> inline errors & disabled button
    expect(screen.getByTestId('lp-add-insufficient-base')).toHaveTextContent(
      'Insufficient fWETH balance (0.7548)',
    );
    expect(screen.getByTestId('lp-add-insufficient-quote')).toHaveTextContent(
      'Insufficient fUSDC balance (100.00)',
    );
    expect(screen.getByTestId('lp-add-submit')).toBeDisabled();

    // Max on both LP Add inputs restores valid state
    fireEvent.click(screen.getByTestId('lp-add-base-max'));
    fireEvent.click(screen.getByTestId('lp-add-quote-max'));
    expect(screen.queryByTestId('lp-add-insufficient-base')).not.toBeInTheDocument();
    expect(screen.queryByTestId('lp-add-insufficient-quote')).not.toBeInTheDocument();
    expect(screen.getByTestId('lp-add-submit')).toBeEnabled();

    // LP Remove exceeding shares shows inline error & disables remove
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    fireEvent.change(screen.getByLabelText(/LP shares to burn/i), { target: { value: '80' } });
    expect(screen.getByTestId('lp-remove-insufficient-shares')).toHaveTextContent(
      'Insufficient LP shares balance (50.00)',
    );
    expect(screen.getByTestId('lp-remove-submit')).toBeDisabled();

    // Zero Sepolia ETH disables on-chain submission with explicit gas notice
    controller = makeController({
      account: ALICE,
      snapshot: makeSnapshot('Open', ALICE, {
        balances: {
          eth: 0n,
          base: 5n * 10n ** 18n,
          quote: 20_000n * 10n ** 6n,
          lpShares: 50n * 10n ** 18n,
        },
      }),
    });
    rerender(<App />);
    expect(screen.getByTestId('order-ticket-insufficient-gas')).toHaveTextContent(
      /Insufficient Sepolia ETH for gas/i,
    );
  });

  it('shows "Settling automatically in about 5s" in Pro Ready panel when keeper is healthy and manual button when offline', () => {
    const snap = makeSnapshot('Ready', ALICE);
    const { rerender } = render(
      <BatchConsole
        batch={snap.batch}
        phase="Ready"
        chainNow={snap.blockTimestamp}
        orderCount={2}
        account={ALICE}
        commitments={[]}
        busyAction={null}
        refreshing={false}
        keeperHealthy={true}
        keeperGraceSeconds={5}
        onSettle={vi.fn(async () => undefined)}
        onSlash={vi.fn(async () => undefined)}
        onRefresh={vi.fn()}
      />,
    );

    expect(screen.getByTestId('pro-keeper-auto-settling')).toHaveTextContent(
      /Settling automatically in about 5s/i,
    );
    expect(screen.queryByTestId('settle-batch-button')).not.toBeInTheDocument();

    rerender(
      <BatchConsole
        batch={snap.batch}
        phase="Ready"
        chainNow={snap.blockTimestamp}
        orderCount={2}
        account={ALICE}
        commitments={[]}
        busyAction={null}
        refreshing={false}
        keeperHealthy={false}
        keeperGraceSeconds={5}
        onSettle={vi.fn(async () => undefined)}
        onSlash={vi.fn(async () => undefined)}
        onRefresh={vi.fn()}
      />,
    );

    expect(screen.queryByTestId('pro-keeper-auto-settling')).not.toBeInTheDocument();
    expect(screen.getByTestId('settle-batch-button')).toHaveTextContent(
      /Settle Batch #8 & open next/i,
    );
  });
});
