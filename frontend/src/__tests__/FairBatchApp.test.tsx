import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { getAddress } from 'viem';
import type { BatchPhase, ClaimableDto, OrderDto, StateResponse } from '../types';
import type { FairBatchController } from '../onchain/useFairBatch';
import type { OnchainSnapshot } from '../onchain/state';
import { DEFAULT_RUNTIME_CONFIG } from '../onchain/config';
import { computeBatchSettlement } from '../lib/fallbackEngine';
import { formatPrice } from '../lib/format';
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
  account: string | null = null,
): OnchainSnapshot {
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
    demo_wallets: account
      ? [{ index: 0, name: 'Connected wallet', address: account }]
      : [],
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
    balances: {
      eth: 10n ** 18n,
      base: 5n * 10n ** 18n,
      quote: 20_000n * 10n ** 6n,
      lpShares: 100n * 10n ** 18n,
    },
    allowances: { base: 10n ** 24n, quote: 10n ** 24n },
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
    lastUpdated: Date.now(),
  };
}

function makeController(
  overrides: Partial<FairBatchController> = {},
): FairBatchController {
  const account = overrides.account ?? null;
  return {
    config: DEFAULT_RUNTIME_CONFIG,
    account,
    walletChainId: DEFAULT_RUNTIME_CONFIG.chainId,
    snapshot: makeSnapshot('Open', account),
    loading: false,
    refreshing: false,
    busyAction: null,
    error: null,
    notice: null,
    secretVault: [],
    configured: true,
    wrongNetwork: false,
    connect: vi.fn(async () => undefined),
    disconnect: vi.fn(),
    refresh: vi.fn(),
    updateConfig: vi.fn(),
    resetConfig: vi.fn(),
    clearNotice: vi.fn(),
    submitDirect: vi.fn(async () => ({ hash: '0x', receipt: {} })),
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
    settle: vi.fn(async () => ({ hash: '0x', batchId: BATCH_ID })),
    slash: vi.fn(async () => ({ hash: '0x', forfeitedBond: 0n })),
    claim: vi.fn(async () => ({ hash: '0x', payoutBase: 0n, payoutQuote: 0n })),
    claimMany: vi.fn(async () => ({ hash: '0x', claimed: 1 })),
    addLiquidity: vi.fn(async () => ({ hash: '0x', receipt: {} })),
    removeLiquidity: vi.fn(async () => ({ hash: '0x', receipt: {} })),
    faucet: vi.fn(async () => ({ hash: '0x', receipt: {} })),
    approve: vi.fn(async () => null),
    ...overrides,
  } as unknown as FairBatchController;
}

vi.mock('../onchain/useFairBatch', () => ({
  useFairBatch: () => controller,
}));

describe('FairBatch on-chain terminal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    controller = makeController();
  });

  it('renders the live batch, reserves and clearing preview from chain snapshot', () => {
    render(<App />);
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
      screen.getByRole('navigation', { name: /Batch Lifecycle Stepper/i }),
    ).toBeInTheDocument();
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
    render(<App />);

    const settleButton = screen.getByTestId('settle-batch-button');
    expect(settleButton).not.toBeDisabled();

    fireEvent.click(settleButton);
    await waitFor(() => {
      expect(controller.settle).toHaveBeenCalledTimes(1);
    });
  });

  it('keeps settlement locked while the commit window is still open', () => {
    render(<App />);
    expect(screen.queryByTestId('settle-batch-button')).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Settlement Locked/i }),
    ).toBeDisabled();
  });

  it('submits a sealed commitment through the connected wallet', async () => {
    controller = makeController({ account: ALICE });
    render(<App />);

    fireEvent.click(screen.getByRole('tab', { name: /Commit-Reveal/i }));
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
        limitPrice: '2650',
        bondEth: '0.001',
      }),
    );
    expect(
      await screen.findByText(/Sealed commitment confirmed/i),
    ).toBeInTheDocument();
  });

  it('lets only the connected owner claim settled receipts', async () => {
    controller = makeController({ account: ALICE });
    render(<App />);

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

  it('saves a validated runtime contract configuration', async () => {
    render(<App />);

    fireEvent.click(
      screen.getByRole('button', { name: /Contract & Network Config/i }),
    );

    fireEvent.change(screen.getByLabelText(/Chain ID/i), {
      target: { value: '11155111' },
    });
    fireEvent.change(screen.getByLabelText(/FairBatch contract address/i), {
      target: { value: '0x1234567890123456789012345678901234567890' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: /Save contract config/i }),
    );

    expect(controller.updateConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        chainId: 11155111,
        fairBatch: getAddress('0x1234567890123456789012345678901234567890'),
      }),
    );
    expect(
      screen.queryByRole('dialog', { name: /Contract & network readiness/i }),
    ).not.toBeInTheDocument();
  });

  it('rejects an invalid contract address before saving', () => {
    render(<App />);
    fireEvent.click(
      screen.getByRole('button', { name: /Contract & Network Config/i }),
    );
    fireEvent.change(screen.getByLabelText(/FairBatch contract address/i), {
      target: { value: '0xnot-an-address' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: /Save contract config/i }),
    );

    expect(controller.updateConfig).not.toHaveBeenCalled();
    expect(
      screen.getByText(/valid FairBatch contract address|deployed FairBatch contract address/i),
    ).toBeInTheDocument();
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
});
