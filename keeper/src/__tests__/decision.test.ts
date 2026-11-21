import { describe, expect, it } from 'vitest';
import {
  decideSettlementAction,
  decideSlashAction,
  isAlreadySettledError,
  isAlreadySlashedError,
  type BatchSnapshot,
  type PendingCommitment,
} from '../decision.js';
import { FairBatchKeeper } from '../service.js';

const MIN_BAL = 5_000_000_000_000_000n; // 0.005 ETH
const HEALTHY_BAL = 50_000_000_000_000_000n; // 0.05 ETH

function makeBatch(overrides: Partial<BatchSnapshot> = {}): BatchSnapshot {
  return {
    batchId: 12n,
    startTime: 1_000n,
    commitDeadline: 1_060n,
    revealDeadline: 1_120n,
    orderCount: 2n,
    commitCount: 0n,
    phase: 2,
    ...overrides,
  };
}

describe('FairBatch Keeper settlement decision logic', () => {
  it('waits KEEPER_GRACE_SECONDS (5s) after revealDeadline so the public can settle first', () => {
    const batch = makeBatch({ revealDeadline: 1_120n, orderCount: 2n });

    // Still inside Reveal window -> do nothing
    expect(
      decideSettlementAction({
        batch,
        blockTimestamp: 1_120n,
        balanceWei: HEALTHY_BAL,
        minBalanceWei: MIN_BAL,
        graceSeconds: 5,
        emptyRoundMinutes: 10,
        lastEmptySettleAtMs: null,
        nowMs: 1_120_000,
        txInFlight: false,
      }),
    ).toEqual({ action: 'none', reason: 'not_ready' });

    // 2s after revealDeadline -> still inside 5s grace period
    expect(
      decideSettlementAction({
        batch,
        blockTimestamp: 1_122n,
        balanceWei: HEALTHY_BAL,
        minBalanceWei: MIN_BAL,
        graceSeconds: 5,
        emptyRoundMinutes: 10,
        lastEmptySettleAtMs: null,
        nowMs: 1_122_000,
        txInFlight: false,
      }),
    ).toEqual({ action: 'wait_grace', batchId: 12n, waitSeconds: 3, empty: false });

    // Exactly at revealDeadline + 5s -> settle!
    expect(
      decideSettlementAction({
        batch,
        blockTimestamp: 1_125n,
        balanceWei: HEALTHY_BAL,
        minBalanceWei: MIN_BAL,
        graceSeconds: 5,
        emptyRoundMinutes: 10,
        lastEmptySettleAtMs: null,
        nowMs: 1_125_000,
        txInFlight: false,
      }),
    ).toEqual({ action: 'settle', batchId: 12n, empty: false });
  });

  it('handles public settle race quietly when phase is Settled or contract reports already settled', () => {
    const alreadySettledBatch = makeBatch({ phase: 3 });
    expect(
      decideSettlementAction({
        batch: alreadySettledBatch,
        blockTimestamp: 1_200n,
        balanceWei: HEALTHY_BAL,
        minBalanceWei: MIN_BAL,
        graceSeconds: 5,
        emptyRoundMinutes: 10,
        lastEmptySettleAtMs: null,
        nowMs: 1_200_000,
        txInFlight: false,
      }),
    ).toEqual({ action: 'none', reason: 'not_ready' });

    expect(isAlreadySettledError(new Error('execution reverted: Batch already settled'))).toBe(true);
    expect(isAlreadySettledError(new Error('Reveal window still active'))).toBe(true);
    expect(isAlreadySettledError(new Error('network timeout'))).toBe(false);
  });

  it('throttles empty Ready batches to once per KEEPER_EMPTY_ROUND_MINUTES (10m)', () => {
    const emptyBatch = makeBatch({ orderCount: 0n, commitCount: 0n, revealDeadline: 1_120n });
    const nowMs = 2_000_000;

    // First empty round allowed after 5s grace
    expect(
      decideSettlementAction({
        batch: emptyBatch,
        blockTimestamp: 1_130n,
        balanceWei: HEALTHY_BAL,
        minBalanceWei: MIN_BAL,
        graceSeconds: 5,
        emptyRoundMinutes: 10,
        lastEmptySettleAtMs: null,
        nowMs,
        txInFlight: false,
      }),
    ).toEqual({ action: 'settle', batchId: 12n, empty: true });

    // 4 minutes later -> throttled
    expect(
      decideSettlementAction({
        batch: emptyBatch,
        blockTimestamp: 1_400n,
        balanceWei: HEALTHY_BAL,
        minBalanceWei: MIN_BAL,
        graceSeconds: 5,
        emptyRoundMinutes: 10,
        lastEmptySettleAtMs: nowMs,
        nowMs: nowMs + 4 * 60_000,
        txInFlight: false,
      }),
    ).toEqual({ action: 'skip', batchId: 12n, reason: 'empty_throttled' });

    // 11 minutes later -> allowed again
    expect(
      decideSettlementAction({
        batch: emptyBatch,
        blockTimestamp: 1_900n,
        balanceWei: HEALTHY_BAL,
        minBalanceWei: MIN_BAL,
        graceSeconds: 5,
        emptyRoundMinutes: 10,
        lastEmptySettleAtMs: nowMs,
        nowMs: nowMs + 11 * 60_000,
        txInFlight: false,
      }),
    ).toEqual({ action: 'settle', batchId: 12n, empty: true });
  });

  it('blocks settlement and slashing when balance is below minimum guard', () => {
    const batch = makeBatch({ orderCount: 3n, revealDeadline: 1_120n });
    const lowBal = 1_000_000_000_000_000n; // 0.001 ETH < 0.005 ETH

    expect(
      decideSettlementAction({
        batch,
        blockTimestamp: 1_200n,
        balanceWei: lowBal,
        minBalanceWei: MIN_BAL,
        graceSeconds: 5,
        emptyRoundMinutes: 10,
        lastEmptySettleAtMs: null,
        nowMs: 1_200_000,
        txInFlight: false,
      }),
    ).toEqual({ action: 'skip', batchId: 12n, reason: 'low_balance' });

    const commit: PendingCommitment = {
      batchId: 11n,
      commitId: 0n,
      revealDeadline: 1_000n,
      bondWei: 100_000_000_000_000n,
      revealed: false,
      slashed: false,
    };
    expect(
      decideSlashAction({
        commitments: [commit],
        blockTimestamp: 1_200n,
        balanceWei: lowBal,
        minBalanceWei: MIN_BAL,
        slashEnabled: true,
        slashGraceSeconds: 60,
        txInFlight: false,
      }),
    ).toEqual({ action: 'skip', reason: 'low_balance' });
  });

  it('enforces 60s slash grace and skips revealed or already-slashed commitments', () => {
    const commits: PendingCommitment[] = [
      {
        batchId: 10n,
        commitId: 0n,
        revealDeadline: 1_000n,
        bondWei: 100_000_000_000_000n,
        revealed: true,
        slashed: false,
      },
      {
        batchId: 10n,
        commitId: 1n,
        revealDeadline: 1_000n,
        bondWei: 100_000_000_000_000n,
        revealed: false,
        slashed: true,
      },
      {
        batchId: 10n,
        commitId: 2n,
        revealDeadline: 1_000n,
        bondWei: 100_000_000_000_000n,
        revealed: false,
        slashed: false,
      },
    ];

    // 30s after revealDeadline -> still inside 60s slash grace
    expect(
      decideSlashAction({
        commitments: commits,
        blockTimestamp: 1_030n,
        balanceWei: HEALTHY_BAL,
        minBalanceWei: MIN_BAL,
        slashEnabled: true,
        slashGraceSeconds: 60,
        txInFlight: false,
      }),
    ).toEqual({ action: 'none', reason: 'no_eligible_commitments' });

    // 60s after revealDeadline -> slashes commit #2
    expect(
      decideSlashAction({
        commitments: commits,
        blockTimestamp: 1_060n,
        balanceWei: HEALTHY_BAL,
        minBalanceWei: MIN_BAL,
        slashEnabled: true,
        slashGraceSeconds: 60,
        txInFlight: false,
      }),
    ).toEqual({
      action: 'slash',
      batchId: 10n,
      commitId: 2n,
      bondWei: 100_000_000_000_000n,
    });

    expect(isAlreadySlashedError(new Error('Already slashed'))).toBe(true);
    expect(isAlreadySlashedError(new Error('Commitment was revealed'))).toBe(true);
  });

  it('serves read-only GET /health in dry-run mode without requiring a private key', async () => {
    const logs: Array<{ level: string; event: string; fields?: Record<string, unknown> }> = [];
    const keeper = new FairBatchKeeper(
      {
        chainId: 11155111,
        rpcUrls: ['http://127.0.0.1:8545'],
        explorerUrl: 'https://sepolia.etherscan.io',
        fairBatch: '0x6fA21b7aDa82E8B04fcA51fdc60793c3Fd80265F',
        baseToken: '0xE9903189Bf3E418759feb26f11A7d1C99BE0e556',
        quoteToken: '0xBD2c54aF6DD7e5e14D5B97d393EB2C8e2e8eBcca',
        deploymentBlock: 12176751n,
        privateKey: null,
        dryRun: true,
        pollMs: 2_000,
        graceSeconds: 5,
        emptyRoundMinutes: 10,
        slashEnabled: true,
        slashGraceSeconds: 60,
        minBalanceWei: MIN_BAL,
        maxGasPriceWei: 50_000_000_000n,
        settleGasLimit: 12_000_000n,
        slashGasLimit: 600_000n,
        host: '127.0.0.1',
        port: 0,
        corsOrigins: ['http://localhost:5173'],
      },
      (level, event, fields) => logs.push({ level, event, fields }),
    );

    const boundPort = await keeper.startHttpServer();
    try {
      const resp = await fetch(`http://127.0.0.1:${boundPort}/health`);
      expect(resp.status).toBe(200);
      const data = (await resp.json()) as Record<string, unknown>;
      expect(data.status).toBe('ok');
      expect(data.mode).toBe('dry_run');
      expect(data.dryRun).toBe(true);
      expect(data.graceSeconds).toBe(5);
      expect(data.keeperAddress).toBeNull();
      expect(JSON.stringify(data)).not.toContain('privateKey');
    } finally {
      await keeper.stop();
    }
    expect(logs.some((l) => l.event === 'http_server_started')).toBe(true);
  });
});
