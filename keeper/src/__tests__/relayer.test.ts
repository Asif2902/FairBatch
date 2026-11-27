import { describe, expect, it, vi } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { parseUnits, type Address, type Hash, type Hex } from 'viem';
import type { KeeperConfig } from '../config.js';
import type { BatchSnapshot } from '../decision.js';
import {
  IntentRelayer,
  SIGNED_ORDER_TYPES,
  type RelayChainAdapter,
  type SignedOrderStruct,
} from '../relayer.js';
import {
  FairBatchKeeper,
  PendingTxBlockedError,
  PendingTxTimeoutError,
} from '../service.js';

const TRADER_ACCOUNT = privateKeyToAccount(
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
);
const OTHER_ACCOUNT = privateKeyToAccount(
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
);
const FAIR_BATCH: Address = '0x6fA21B7Ada82e8b04FCa51FDC60793c3Fd80265f';
const BASE_TOKEN: Address = '0xE9903189Bf3E418759feb26f11A7d1C99BE0e556';
const QUOTE_TOKEN: Address = '0xBD2c54aF6DD7e5e14D5B97d393EB2C8e2e8eBcca';

function makeConfig(overrides: Partial<KeeperConfig> = {}): KeeperConfig {
  return {
    chainId: 11155111,
    rpcUrls: ['http://127.0.0.1:8545'],
    explorerUrl: 'https://sepolia.etherscan.io',
    fairBatch: FAIR_BATCH,
    baseToken: BASE_TOKEN,
    quoteToken: QUOTE_TOKEN,
    deploymentBlock: 12176751n,
    privateKey: null,
    dryRun: false,
    pollMs: 2_000,
    graceSeconds: 5,
    emptyRoundMinutes: 10,
    slashEnabled: true,
    slashGraceSeconds: 60,
    minBalanceWei: 5_000_000_000_000_000n,
    maxGasPriceWei: 50_000_000_000n,
    settleGasLimit: 12_000_000n,
    slashGasLimit: 600_000n,
    host: '127.0.0.1',
    port: 0,
    corsOrigins: ['http://localhost:5173'],
    relayerEnabled: true,
    relayGraceSeconds: 5,
    relayDeadlineBufferSeconds: 30,
    relayMaxQueue: 16,
    relayRateLimitPerIp: 10,
    relayRateLimitPerTrader: 5,
    relayRateWindowMs: 60_000,
    relayGasLimit: 1_500_000n,
    relayMaxBodyBytes: 16_384,
    ...overrides,
  };
}

async function signOrder(
  order: SignedOrderStruct,
  signer = TRADER_ACCOUNT,
): Promise<{ order: Record<string, string | number>; signature: Hex }> {
  const signature = await signer.signTypedData({
    domain: {
      name: 'FairBatch',
      version: '1',
      chainId: 11155111,
      verifyingContract: FAIR_BATCH,
    },
    types: SIGNED_ORDER_TYPES,
    primaryType: 'SignedOrder',
    message: order,
  });
  return {
    order: {
      trader: order.trader,
      side: order.side,
      amountIn: order.amountIn.toString(),
      limitPrice: order.limitPrice.toString(),
      batchId: order.batchId.toString(),
      nonce: order.nonce.toString(),
      deadline: order.deadline.toString(),
    },
    signature,
  };
}

function makeOrder(overrides: Partial<SignedOrderStruct> = {}): SignedOrderStruct {
  return {
    trader: TRADER_ACCOUNT.address,
    side: 0,
    amountIn: parseUnits('0.5', 18),
    limitPrice: parseUnits('2700', 18),
    batchId: 12n,
    nonce: 3n,
    deadline: 2_000n,
    ...overrides,
  };
}

function makeAdapter(overrides: Partial<RelayChainAdapter> = {}): RelayChainAdapter {
  const batch: BatchSnapshot = {
    batchId: 12n,
    startTime: 1_000n,
    commitDeadline: 1_060n,
    revealDeadline: 1_120n,
    orderCount: 1n,
    commitCount: 0n,
    phase: 0,
  };
  return {
    getLatestTimestamp: vi.fn().mockResolvedValue(1_050n),
    getCurrentBatch: vi.fn().mockResolvedValue(batch),
    getNonce: vi.fn().mockResolvedValue(3n),
    getTokenBalance: vi.fn().mockResolvedValue(parseUnits('5', 18)),
    getTokenAllowance: vi.fn().mockResolvedValue(parseUnits('100', 18)),
    getCode: vi.fn().mockResolvedValue(undefined),
    isLowBalance: vi.fn().mockReturnValue(false),
    simulateSubmitIntent: vi.fn().mockResolvedValue(undefined),
    estimateSubmitIntentGas: vi.fn().mockResolvedValue(750_000n),
    checkGasPrice: vi
      .fn()
      .mockResolvedValue({ maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000n }),
    submitIntentTx: vi.fn().mockResolvedValue({
      txHash: `0x${'ab'.repeat(32)}` as Hash,
      orderId: 4,
      blockNumber: 12177000,
      gasUsed: '763420',
    }),
    withTxLock: vi.fn().mockImplementation((_label, fn) => fn()),
    ...overrides,
  };
}

describe('FairBatch Intent Relayer (Stage D)', () => {
  it('validates, waits 5s grace, and submits a valid EIP-712 signed intent', async () => {
    const sleepFn = vi.fn().mockResolvedValue(undefined);
    const adapter = makeAdapter();
    const relayer = new IntentRelayer(makeConfig(), adapter, vi.fn(), sleepFn);
    const body = await signOrder(makeOrder());

    const result = await relayer.relay(body, '127.0.0.1');
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      status: 'submitted',
      relayed: true,
      batchId: 12,
      nonce: 3,
      orderId: 4,
    });
    expect(sleepFn).toHaveBeenCalledWith(5_000);
    expect(adapter.submitIntentTx).toHaveBeenCalledTimes(1);
  });

  it('skips quietly if another relayer or user submitted the intent during the 5s grace window', async () => {
    const getNonce = vi
      .fn()
      .mockResolvedValueOnce(3n) // pre-send validation passes
      .mockResolvedValueOnce(4n); // post-grace re-check sees nonce incremented!
    const adapter = makeAdapter({ getNonce });
    const relayer = new IntentRelayer(makeConfig(), adapter, vi.fn(), vi.fn().mockResolvedValue(undefined));
    const body = await signOrder(makeOrder());

    const result = await relayer.relay(body, '127.0.0.1');
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      status: 'already_submitted',
      relayed: false,
      batchId: 12,
      nonce: 3,
    });
    expect(adapter.submitIntentTx).not.toHaveBeenCalled();
  });

  it('rejects bad signature, wrong batch, closed phase, expired deadline, bad nonce, low balance/allowance, and revert simulation', async () => {
    const sleepFn = vi.fn().mockResolvedValue(undefined);

    // 1. Bad signature (signed by OTHER_ACCOUNT for TRADER_ACCOUNT)
    {
      const relayer = new IntentRelayer(makeConfig(), makeAdapter(), vi.fn(), sleepFn);
      const body = await signOrder(makeOrder(), OTHER_ACCOUNT);
      const res = await relayer.relay(body, '10.0.0.1');
      expect(res.status).toBe(400);
      expect((res.body as { code: string }).code).toBe('invalid_signature');
    }

    // 2. Wrong batch
    {
      const relayer = new IntentRelayer(makeConfig(), makeAdapter(), vi.fn(), sleepFn);
      const body = await signOrder(makeOrder({ batchId: 99n }));
      const res = await relayer.relay(body, '10.0.0.2');
      expect(res.status).toBe(400);
      expect((res.body as { code: string }).code).toBe('wrong_batch');
    }

    // 3. Closed intent window (blockTimestamp > revealDeadline)
    {
      const adapter = makeAdapter({ getLatestTimestamp: vi.fn().mockResolvedValue(1_125n) });
      const relayer = new IntentRelayer(makeConfig(), adapter, vi.fn(), sleepFn);
      const body = await signOrder(makeOrder());
      const res = await relayer.relay(body, '10.0.0.3');
      expect(res.status).toBe(400);
      expect((res.body as { code: string }).code).toBe('window_closed');
    }

    // 4. Expiring deadline (< blockTimestamp + 30s)
    {
      const relayer = new IntentRelayer(makeConfig(), makeAdapter(), vi.fn(), sleepFn);
      const body = await signOrder(makeOrder({ deadline: 1_065n }));
      const res = await relayer.relay(body, '10.0.0.4');
      expect(res.status).toBe(400);
      expect((res.body as { code: string }).code).toBe('deadline_expired');
    }

    // 5. Wrong nonce
    {
      const relayer = new IntentRelayer(makeConfig(), makeAdapter(), vi.fn(), sleepFn);
      const body = await signOrder(makeOrder({ nonce: 9n }));
      const res = await relayer.relay(body, '10.0.0.5');
      expect(res.status).toBe(400);
      expect((res.body as { code: string }).code).toBe('invalid_nonce');
    }

    // 6. Insufficient input token balance
    {
      const adapter = makeAdapter({ getTokenBalance: vi.fn().mockResolvedValue(parseUnits('0.1', 18)) });
      const relayer = new IntentRelayer(makeConfig(), adapter, vi.fn(), sleepFn);
      const body = await signOrder(makeOrder());
      const res = await relayer.relay(body, '10.0.0.6');
      expect(res.status).toBe(400);
      expect((res.body as { code: string }).code).toBe('insufficient_balance');
    }

    // 7. Insufficient allowance
    {
      const adapter = makeAdapter({ getTokenAllowance: vi.fn().mockResolvedValue(0n) });
      const relayer = new IntentRelayer(makeConfig(), adapter, vi.fn(), sleepFn);
      const body = await signOrder(makeOrder());
      const res = await relayer.relay(body, '10.0.0.7');
      expect(res.status).toBe(400);
      expect((res.body as { code: string }).code).toBe('insufficient_allowance');
    }

    // 8. eth_call simulation failure
    {
      const adapter = makeAdapter({
        simulateSubmitIntent: vi.fn().mockRejectedValue(new Error('Batch order cap reached')),
      });
      const relayer = new IntentRelayer(makeConfig(), adapter, vi.fn(), sleepFn);
      const body = await signOrder(makeOrder());
      const res = await relayer.relay(body, '10.0.0.8');
      expect(res.status).toBe(400);
      expect((res.body as { code: string }).code).toBe('simulation_reverted');
    }

    // 9. Low relayer ETH balance guard -> 503
    {
      const adapter = makeAdapter({ isLowBalance: vi.fn().mockReturnValue(true) });
      const relayer = new IntentRelayer(makeConfig(), adapter, vi.fn(), sleepFn);
      const body = await signOrder(makeOrder());
      const res = await relayer.relay(body, '10.0.0.9');
      expect(res.status).toBe(503);
      expect((res.body as { code: string }).code).toBe('low_balance');
    }
  });

  it('enforces per-IP rate limiting, bounded queue, and HTTP body size limit', async () => {
    const config = makeConfig({
      relayRateLimitPerIp: 2,
      relayMaxQueue: 1,
      relayMaxBodyBytes: 256,
    });

    // Rate limit test
    const adapter = makeAdapter();
    const relayer = new IntentRelayer(config, adapter, vi.fn(), vi.fn().mockResolvedValue(undefined));
    const body = await signOrder(makeOrder());
    expect((await relayer.relay(body, '192.168.1.5')).status).toBe(200);
    expect((await relayer.relay(body, '192.168.1.5')).status).toBe(200);
    const third = await relayer.relay(body, '192.168.1.5');
    expect(third.status).toBe(429);
    expect((third.body as { code: string }).code).toBe('rate_limit_ip');

    // Bounded queue test: hold first request inside sleepFn, verify second gets 429 queue_full
    let releaseFirst!: () => void;
    const heldSleep = () =>
      new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
    const queuedRelayer = new IntentRelayer(
      makeConfig({ relayMaxQueue: 1, relayRateLimitPerIp: 10, relayRateLimitPerTrader: 10 }),
      makeAdapter(),
      vi.fn(),
      heldSleep,
    );
    const bodyA = await signOrder(makeOrder({ nonce: 3n }));
    const bodyB = await signOrder(makeOrder({ trader: OTHER_ACCOUNT.address, nonce: 0n }), OTHER_ACCOUNT);

    const p1 = queuedRelayer.relay(bodyA, '10.1.1.1');
    // Let p1 enter sleepFn
    await new Promise((r) => setTimeout(r, 15));
    const res2 = await queuedRelayer.relay(bodyB, '10.1.1.2');
    expect(res2.status).toBe(429);
    expect((res2.body as { code: string }).code).toBe('queue_full');
    releaseFirst();
    await p1;

    // HTTP 413 body size limit + /health relayer metadata
    const keeper = new FairBatchKeeper(config, vi.fn());
    keeper.registerHttpHandler(relayer.handleHttpRequest);
    keeper.registerHealthAugmenter(() => relayer.getHealthFields());
    const port = await keeper.startHttpServer();
    try {
      const healthResp = await fetch(`http://127.0.0.1:${port}/health`);
      const health = (await healthResp.json()) as Record<string, unknown>;
      expect(health.relayerEnabled).toBe(true);
      expect(health.relayGraceSeconds).toBe(5);

      const bigResp = await fetch(`http://127.0.0.1:${port}/relay/intent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'x'.repeat(500),
      });
      expect(bigResp.status).toBe(413);
    } finally {
      await keeper.stop();
    }
  });

  it('blocks relay submission when keeper already has a pending transaction or receipt times out', async () => {
    const sleepFn = vi.fn().mockResolvedValue(undefined);
    const body = await signOrder(makeOrder());

    // 1. Pre-check rejects with 503 tx_pending if keeper already has a pending tx
    {
      const adapter = makeAdapter({ hasPendingTx: vi.fn().mockReturnValue(true) });
      const relayer = new IntentRelayer(makeConfig(), adapter, vi.fn(), sleepFn);
      const res = await relayer.relay(body, '10.2.0.1');
      expect(res.status).toBe(503);
      expect((res.body as { code: string }).code).toBe('tx_pending');
      expect(adapter.submitIntentTx).not.toHaveBeenCalled();
    }

    // 2. Broadcast-time PendingTxBlockedError (e.g. external mempool pending nonce) -> 503 tx_pending
    {
      const adapter = makeAdapter({
        submitIntentTx: vi
          .fn()
          .mockRejectedValue(new PendingTxBlockedError('wallet already has pending tx')),
      });
      const relayer = new IntentRelayer(makeConfig(), adapter, vi.fn(), sleepFn);
      const res = await relayer.relay(body, '10.2.0.2');
      expect(res.status).toBe(503);
      expect((res.body as { code: string }).code).toBe('tx_pending');
    }

    // 3. Receipt timeout -> 504 tx_pending_confirmation (tx stays tracked on keeper)
    {
      const pendingHash = `0x${'cd'.repeat(32)}` as Hash;
      const adapter = makeAdapter({
        submitIntentTx: vi.fn().mockRejectedValue(new PendingTxTimeoutError(pendingHash, 474)),
      });
      const relayer = new IntentRelayer(makeConfig(), adapter, vi.fn(), sleepFn);
      const res = await relayer.relay(body, '10.2.0.3');
      expect(res.status).toBe(504);
      expect((res.body as { code: string }).code).toBe('tx_pending_confirmation');
    }
  });
});
