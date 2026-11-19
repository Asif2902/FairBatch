import { formatUnits, type Address } from 'viem';
import type {
  BatchPhase,
  BatchSettlementDto,
  ClaimableDto,
  CommitmentDto,
  ComparisonDto,
  ExecutionReceiptDto,
  FillOutcomeDto,
  FillStatus,
  HealthResponse,
  OrderDto,
  OrderSide,
  StateResponse,
} from '../types';
import {
  buildSupplyDemandCurves,
  computeBatchSettlement,
} from '../lib/fallbackEngine';
import { shortenAddress } from '../lib/format';
import { erc20Abi, fairBatchAbi } from './abi';
import { getPublicClient } from './client';
import type { RuntimeConfig } from './config';
import { loadFairBatchEvents, type FairBatchEvent } from './events';

export interface RawBatchInfo {
  batchId: bigint;
  startTime: bigint;
  commitDeadline: bigint;
  revealDeadline: bigint;
  orderCount: bigint;
  commitCount: bigint;
  phase: number;
}

export interface RawReserves {
  reserveBase: bigint;
  reserveQuote: bigint;
  totalShares: bigint;
  spotPriceWad: bigint;
}

export interface RawReceipt {
  orderId: bigint;
  trader: Address;
  side: number;
  amountIn: bigint;
  limitPrice: bigint;
  amountFilled: bigint;
  payoutBase: bigint;
  payoutQuote: bigint;
  settled: boolean;
  claimed: boolean;
}

export interface ChainOrder extends OrderDto {
  batch_id: number;
  amount_in_raw: bigint;
  limit_price_raw: bigint;
  mode: number;
}

export interface ChainCommitment extends CommitmentDto {
  batch_id: number;
  bond_wei: bigint;
}

export interface WalletBalances {
  eth: bigint;
  base: bigint;
  quote: bigint;
  lpShares: bigint;
}

export interface WalletAllowances {
  base: bigint;
  quote: bigint;
}

export interface OnchainSnapshot {
  config: RuntimeConfig;
  health: HealthResponse;
  state: StateResponse;
  batch: RawBatchInfo;
  reserves: RawReserves;
  balances: WalletBalances;
  allowances: WalletAllowances;
  nonce: bigint;
  domainSeparator: `0x${string}`;
  minBondWei: bigint;
  orders: ChainOrder[];
  commitments: ChainCommitment[];
  allCommitments: ChainCommitment[];
  batchSettled: boolean;
  claimable: ClaimableDto[];
  settledHistory: BatchSettlementDto[];
  activeSettlement: BatchSettlementDto;
  lastUpdated: number;
}

const receiptCache = new Map<string, RawReceipt>();

export function clearReceiptCache(): void {
  receiptCache.clear();
}

export function clearReceiptCacheForBatch(batchId: number): void {
  const prefix = `:${batchId}:`;
  for (const key of receiptCache.keys()) {
    if (key.includes(prefix)) receiptCache.delete(key);
  }
}

export function mapPhase(rawPhase: number): BatchPhase {
  switch (rawPhase) {
    case 1:
      return 'Reveal';
    case 2:
      return 'Ready';
    case 3:
      return 'Settled';
    default:
      return 'Open';
  }
}

export function phaseLabel(phase: BatchPhase): string {
  switch (phase) {
    case 'Open':
      return 'Open / Collect';
    case 'Reveal':
      return 'Reveal / Intent';
    case 'Ready':
      return 'Ready to settle';
    default:
      return 'Settled';
  }
}

export function sideToU8(side: OrderSide): number {
  return side === 'SellBase' ? 0 : 1;
}

export function u8ToSide(side: number): OrderSide {
  return side === 0 ? 'SellBase' : 'BuyBase';
}

export function modeToSubmission(mode: number): OrderDto['submission_type'] {
  if (mode === 1) return 'CommitReveal';
  if (mode === 2) return 'Eip712Intent';
  return 'Direct';
}

function modeLabel(mode: number): string {
  if (mode === 1) return 'sealed';
  if (mode === 2) return 'signed';
  return 'direct';
}

function toHuman(raw: bigint, decimals: number): number {
  return Number(formatUnits(raw, decimals));
}

function wadToHuman(raw: bigint): number {
  return Number(formatUnits(raw, 18));
}

function hex32(value: bigint): `0x${string}` {
  return `0x${value.toString(16).padStart(64, '0')}`;
}

function asBig(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(value);
  if (typeof value === 'string') return BigInt(value);
  return 0n;
}

function asNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') return Number(value);
  return 0;
}

function asAddress(value: unknown): Address {
  return (typeof value === 'string' ? value : '0x0000000000000000000000000000000000000000') as Address;
}

function sideFromContract(value: unknown): OrderSide {
  return u8ToSide(asNumber(value));
}

function orderLabel(trader: Address, mode: number): string {
  return `${shortenAddress(trader)} · ${modeLabel(mode)}`;
}

function buildOrder(
  config: RuntimeConfig,
  event: FairBatchEvent,
  mode: number,
): ChainOrder {
  const args = event.args;
  const side = sideFromContract(args.side);
  const amountIn = asBig(args.amountIn);
  const limitPrice = asBig(args.limitPrice);
  const trader = asAddress(args.trader);
  const decimals = side === 'SellBase' ? config.baseDecimals : config.quoteDecimals;
  return {
    batch_id: Number(asBig(args.batchId)),
    order_id: Number(asBig(args.orderId)),
    trader,
    label: orderLabel(trader, mode),
    side,
    amount_in: toHuman(amountIn, decimals),
    limit_price: wadToHuman(limitPrice),
    submission_type: modeToSubmission(mode),
    is_attacker: false,
    amount_in_raw: amountIn,
    limit_price_raw: limitPrice,
    mode,
  };
}

function receiptKey(config: RuntimeConfig, batchId: number, orderId: number): string {
  return `${config.chainId}:${config.fairBatch}:${batchId}:${orderId}`;
}

async function fetchReceipt(
  config: RuntimeConfig,
  batchId: number,
  orderId: number,
): Promise<RawReceipt> {
  const key = receiptKey(config, batchId, orderId);
  const cached = receiptCache.get(key);
  if (cached) return cached;

  const client = getPublicClient(config);
  const raw = (await client.readContract({
    address: config.fairBatch,
    abi: fairBatchAbi,
    functionName: 'getOrderReceipt',
    args: [BigInt(batchId), BigInt(orderId)],
  })) as unknown as RawReceipt;
  receiptCache.set(key, raw);
  return raw;
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await fn(items[index]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  return results;
}

function fillStatus(receipt: RawReceipt): FillStatus {
  if (receipt.amountFilled === 0n) return 'OutOfMoneyRefund';
  if (receipt.amountFilled >= receipt.amountIn) return 'Filled';
  return 'PartialFill';
}

function effectivePrice(receipt: RawReceipt, config: RuntimeConfig): number {
  if (receipt.amountFilled === 0n) return 0;
  if (receipt.side === 0) {
    const base = toHuman(receipt.amountFilled, config.baseDecimals);
    const quote = toHuman(receipt.payoutQuote, config.quoteDecimals);
    return base > 0 ? quote / base : 0;
  }
  const base = toHuman(receipt.payoutBase, config.baseDecimals);
  const quote = toHuman(receipt.amountFilled, config.quoteDecimals);
  return base > 0 ? quote / base : 0;
}

function receiptPayout(receipt: RawReceipt, side: OrderSide, config: RuntimeConfig): {
  payoutOut: number;
  refundIn: number;
} {
  if (side === 'SellBase') {
    return {
      payoutOut: toHuman(receipt.payoutQuote, config.quoteDecimals),
      refundIn: toHuman(receipt.payoutBase, config.baseDecimals),
    };
  }
  return {
    payoutOut: toHuman(receipt.payoutBase, config.baseDecimals),
    refundIn: toHuman(receipt.payoutQuote, config.quoteDecimals),
  };
}

function receiptToExecution(
  receipt: RawReceipt,
  order: ChainOrder | undefined,
  config: RuntimeConfig,
): ExecutionReceiptDto {
  const side = u8ToSide(receipt.side);
  const payout = receiptPayout(receipt, side, config);
  const status = fillStatus(receipt);
  return {
    order_id: Number(receipt.orderId),
    trader: receipt.trader,
    label: order?.label ?? shortenAddress(receipt.trader),
    side,
    amount_in:
      order?.amount_in ??
      toHuman(
        receipt.amountIn,
        side === 'SellBase' ? config.baseDecimals : config.quoteDecimals,
      ),
    amount_filled: toHuman(
      receipt.amountFilled,
      side === 'SellBase' ? config.baseDecimals : config.quoteDecimals,
    ),
    amount_out: payout.payoutOut,
    refund_in: payout.refundIn,
    effective_price: effectivePrice(receipt, config),
    status:
      status === 'Filled'
        ? '100% Filled'
        : status === 'PartialFill'
          ? 'Pro-Rata Partial'
          : 'Refunded (OTM)',
    is_attacker: false,
  };
}

function receiptToFill(
  receipt: RawReceipt,
  order: ChainOrder | undefined,
  config: RuntimeConfig,
): FillOutcomeDto {
  const side = u8ToSide(receipt.side);
  const payout = receiptPayout(receipt, side, config);
  return {
    order_id: Number(receipt.orderId),
    trader: receipt.trader,
    label: order?.label ?? shortenAddress(receipt.trader),
    side,
    status: fillStatus(receipt),
    amount_in:
      order?.amount_in ??
      toHuman(
        receipt.amountIn,
        side === 'SellBase' ? config.baseDecimals : config.quoteDecimals,
      ),
    amount_filled: toHuman(
      receipt.amountFilled,
      side === 'SellBase' ? config.baseDecimals : config.quoteDecimals,
    ),
    payout_out: payout.payoutOut,
    refund_in: payout.refundIn,
    limit_price:
      order?.limit_price ??
      wadToHuman(receipt.limitPrice),
    effective_price: effectivePrice(receipt, config),
    is_attacker: false,
  };
}

function emptyComparison(clearingPrice: number): ComparisonDto {
  return {
    fee_bps: 0,
    amm_victim_avg_price: 0,
    fairbatch_uniform_price: clearingPrice,
    user_value_saved_quote: 0,
    amm_sandwich_profit_quote: 0,
    fairbatch_sandwich_profit_quote: 0,
    amm_lvr_loss_quote: 0,
    amm_receipts: [],
    fairbatch_receipts: [],
  };
}

function remainingSeconds(batch: RawBatchInfo, phase: BatchPhase): number {
  const now = Math.floor(Date.now() / 1000);
  if (phase === 'Open') return Math.max(0, Number(batch.commitDeadline) - now);
  if (phase === 'Reveal') return Math.max(0, Number(batch.revealDeadline) - now);
  return 0;
}

export async function loadOnchainSnapshot(
  config: RuntimeConfig,
  account: Address | null,
): Promise<OnchainSnapshot> {
  const client = getPublicClient(config);
  const [batchRaw, reservesRaw, domainRaw, events] = await Promise.all([
    client.readContract({
      address: config.fairBatch,
      abi: fairBatchAbi,
      functionName: 'currentBatch',
    }),
    client.readContract({
      address: config.fairBatch,
      abi: fairBatchAbi,
      functionName: 'getReserves',
    }),
    client.readContract({
      address: config.fairBatch,
      abi: fairBatchAbi,
      functionName: 'domainSeparator',
    }),
    loadFairBatchEvents(client, config),
  ]);

  const batch = batchRaw as unknown as RawBatchInfo;
  const reserves = reservesRaw as unknown as RawReserves;
  const domainSeparator = hex32(domainRaw as bigint);

  let balances: WalletBalances = { eth: 0n, base: 0n, quote: 0n, lpShares: 0n };
  let allowances: WalletAllowances = { base: 0n, quote: 0n };
  let nonce = 0n;

  if (account) {
    const [eth, base, quote, lpShares, baseAllowance, quoteAllowance, accountNonce] =
      await Promise.all([
        client.getBalance({ address: account }).catch(() => 0n),
        client
          .readContract({
            address: config.baseToken,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [account],
          })
          .catch(() => 0n),
        client
          .readContract({
            address: config.quoteToken,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [account],
          })
          .catch(() => 0n),
        client
          .readContract({
            address: config.fairBatch,
            abi: fairBatchAbi,
            functionName: 'getLpShares',
            args: [account],
          })
          .catch(() => 0n),
        client
          .readContract({
            address: config.baseToken,
            abi: erc20Abi,
            functionName: 'allowance',
            args: [account, config.fairBatch],
          })
          .catch(() => 0n),
        client
          .readContract({
            address: config.quoteToken,
            abi: erc20Abi,
            functionName: 'allowance',
            args: [account, config.fairBatch],
          })
          .catch(() => 0n),
        client
          .readContract({
            address: config.fairBatch,
            abi: fairBatchAbi,
            functionName: 'getNonce',
            args: [account],
          })
          .catch(() => 0n),
      ]);
    balances = { eth, base, quote, lpShares };
    allowances = { base: baseAllowance, quote: quoteAllowance };
    nonce = accountNonce;
  }

  const ordersByBatch = new Map<number, ChainOrder[]>();
  const commitmentsByBatch = new Map<number, ChainCommitment[]>();
  const revealedCommits = new Set<string>();
  const slashedCommits = new Set<string>();
  const claimedOrders = new Set<string>();
  const settledEvents: FairBatchEvent[] = [];

  for (const event of events) {
    if (event.eventName === 'OrderSubmitted') {
      const order = buildOrder(config, event, asNumber(event.args.mode));
      const list = ordersByBatch.get(order.batch_id) ?? [];
      list.push(order);
      ordersByBatch.set(order.batch_id, list);
    } else if (event.eventName === 'OrderRevealed') {
      const order = buildOrder(config, event, 1);
      const list = ordersByBatch.get(order.batch_id) ?? [];
      list.push(order);
      ordersByBatch.set(order.batch_id, list);
      const commitId = asBig(event.args.commitId);
      revealedCommits.add(`${order.batch_id}:${commitId}`);
    } else if (event.eventName === 'OrderCommitted') {
      const batchId = Number(asBig(event.args.batchId));
      const commitId = Number(asBig(event.args.commitId));
      const trader = asAddress(event.args.trader);
      const bond = asBig(event.args.bond);
      const list = commitmentsByBatch.get(batchId) ?? [];
      list.push({
        batch_id: batchId,
        commit_id: commitId,
        trader,
        commitment_hash: hex32(asBig(event.args.commitmentHash)),
        bond_eth: toHuman(bond, 18),
        bond_wei: bond,
        revealed: false,
        slashed: false,
      });
      commitmentsByBatch.set(batchId, list);
    } else if (event.eventName === 'CommitmentSlashed') {
      const batchId = Number(asBig(event.args.batchId));
      const commitId = asBig(event.args.commitId);
      slashedCommits.add(`${batchId}:${commitId}`);
    } else if (event.eventName === 'OrderClaimed') {
      claimedOrders.add(
        `${Number(asBig(event.args.batchId))}:${Number(asBig(event.args.orderId))}`,
      );
    } else if (event.eventName === 'BatchSettled') {
      settledEvents.push(event);
    }
  }

  for (const [batchId, list] of commitmentsByBatch.entries()) {
    for (const commit of list) {
      const key = `${batchId}:${commit.commit_id}`;
      if (revealedCommits.has(key)) commit.revealed = true;
      if (slashedCommits.has(key)) commit.slashed = true;
    }
  }

  // Resolve receipts for every settled batch (cached across refreshes).
  const receiptEntries = new Map<string, RawReceipt>();
  for (const settled of settledEvents) {
    const batchId = Number(asBig(settled.args.batchId));
    const orders = ordersByBatch.get(batchId) ?? [];
    const missing = orders.filter(
      (order) => !receiptCache.has(receiptKey(config, batchId, order.order_id)),
    );
    if (missing.length > 0) {
      await mapLimit(missing, 8, (order) => fetchReceipt(config, batchId, order.order_id));
    }
    for (const order of orders) {
      const receipt = await fetchReceipt(config, batchId, order.order_id);
      receiptEntries.set(`${batchId}:${order.order_id}`, receipt);
    }
  }

  const activeBatchId = Number(batch.batchId);
  const activeOrders = (ordersByBatch.get(activeBatchId) ?? []).sort(
    (a, b) => a.order_id - b.order_id,
  );
  const activeCommitments = (commitmentsByBatch.get(activeBatchId) ?? []).sort(
    (a, b) => a.commit_id - b.commit_id,
  );
  const allCommitments = Array.from(commitmentsByBatch.values())
    .flat()
    .sort((a, b) => b.batch_id - a.batch_id || b.commit_id - a.commit_id);

  const claimable: ClaimableDto[] = [];
  for (const [key, receipt] of receiptEntries.entries()) {
    if (!receipt.settled) continue;
    const [batchIdStr, orderIdStr] = key.split(':');
    const batchId = Number(batchIdStr);
    const orderId = Number(orderIdStr);
    const order = (ordersByBatch.get(batchId) ?? []).find((o) => o.order_id === orderId);
    const side = u8ToSide(receipt.side);
    const payout = receiptPayout(receipt, side, config);
    claimable.push({
      batch_id: batchId,
      order_id: orderId,
      trader: receipt.trader,
      label: order?.label ?? shortenAddress(receipt.trader),
      side,
      status: fillStatus(receipt),
      amount_in:
        order?.amount_in ??
        toHuman(
          receipt.amountIn,
          side === 'SellBase' ? config.baseDecimals : config.quoteDecimals,
        ),
      amount_filled: toHuman(
        receipt.amountFilled,
        side === 'SellBase' ? config.baseDecimals : config.quoteDecimals,
      ),
      payout_out: payout.payoutOut,
      refund_in: payout.refundIn,
      effective_price: effectivePrice(receipt, config),
      claimed: receipt.claimed || claimedOrders.has(key),
    });
  }
  claimable.sort((a, b) => b.batch_id - a.batch_id || b.order_id - a.order_id);

  // Reconstruct reserve history and produce real settled-batch records.
  // The deployment is constructor-seeded, so the tracked baseline starts from the
  // configured initial reserves; only later LiquidityAdded/Removed events move it.
  let trackedBase = config.initialReserveBase;
  let trackedQuote = config.initialReserveQuote;
  const beforeByBatch = new Map<number, { base: bigint; quote: bigint }>();
  for (const event of events) {
    if (event.eventName === 'LiquidityAdded') {
      trackedBase += asBig(event.args.amountBase);
      trackedQuote += asBig(event.args.amountQuote);
    } else if (event.eventName === 'LiquidityRemoved') {
      const base = asBig(event.args.amountBase);
      const quote = asBig(event.args.amountQuote);
      trackedBase = trackedBase > base ? trackedBase - base : 0n;
      trackedQuote = trackedQuote > quote ? trackedQuote - quote : 0n;
    } else if (event.eventName === 'BatchSettled') {
      const batchId = Number(asBig(event.args.batchId));
      beforeByBatch.set(batchId, { base: trackedBase, quote: trackedQuote });
      trackedBase = asBig(event.args.reserveBaseAfter);
      trackedQuote = asBig(event.args.reserveQuoteAfter);
    }
  }

  const settledHistory: BatchSettlementDto[] = [];
  for (const settled of settledEvents) {
    const batchId = Number(asBig(settled.args.batchId));
    const orders = (ordersByBatch.get(batchId) ?? []).sort(
      (a, b) => a.order_id - b.order_id,
    );
    const receipts = orders
      .map((order) => receiptEntries.get(`${batchId}:${order.order_id}`))
      .filter((receipt): receipt is RawReceipt => Boolean(receipt?.settled));

    const clearingPrice = wadToHuman(asBig(settled.args.clearingPrice));
    const reserveBaseAfter = asBig(settled.args.reserveBaseAfter);
    const reserveQuoteAfter = asBig(settled.args.reserveQuoteAfter);
    const before = beforeByBatch.get(batchId) ?? {
      base: reserveBaseAfter,
      quote: reserveQuoteAfter,
    };
    const rxBefore = toHuman(before.base, config.baseDecimals);
    const ryBefore = toHuman(before.quote, config.quoteDecimals);
    const rxAfter = toHuman(reserveBaseAfter, config.baseDecimals);
    const ryAfter = toHuman(reserveQuoteAfter, config.quoteDecimals);

    const orderMap = new Map(orders.map((order) => [order.order_id, order]));
    const fills = receipts.map((receipt) =>
      receiptToFill(receipt, orderMap.get(Number(receipt.orderId)), config),
    );
    const executionReceipts = receipts.map((receipt) =>
      receiptToExecution(receipt, orderMap.get(Number(receipt.orderId)), config),
    );

    let comparison = emptyComparison(clearingPrice);
    try {
      const simulated = computeBatchSettlement(
        batchId,
        rxBefore,
        ryBefore,
        orders,
      );
      comparison = {
        ...simulated.comparison,
        fairbatch_uniform_price: clearingPrice,
        fairbatch_receipts: executionReceipts,
      };
    } catch {
      comparison = {
        ...comparison,
        fairbatch_receipts: executionReceipts,
      };
    }

    const { supply_curve, demand_curve } = buildSupplyDemandCurves(
      orders,
      rxBefore > 0 ? ryBefore / rxBefore : clearingPrice,
    );

    const totalSellBase = toHuman(asBig(settled.args.totalSellBase), config.baseDecimals);
    const totalBuyQuote = toHuman(asBig(settled.args.totalBuyQuote), config.quoteDecimals);
    const cowBase = toHuman(asBig(settled.args.cowMatchedBase), config.baseDecimals);
    const cowQuote = toHuman(asBig(settled.args.cowMatchedQuote), config.quoteDecimals);
    const grossBase = totalSellBase + (clearingPrice > 0 ? totalBuyQuote / clearingPrice : 0);
    const cowRatio = grossBase > 0 ? Math.min(100, ((2 * cowBase) / grossBase) * 100) : 0;
    const kBefore = rxBefore * ryBefore;
    const kAfter = rxAfter * ryAfter;
    const kGrowth = Math.max(0, kAfter - kBefore);

    settledHistory.push({
      batch_id: batchId,
      clearing_price: clearingPrice,
      total_sell_base_eligible: totalSellBase,
      total_buy_quote_eligible: totalBuyQuote,
      cow_matched_base: cowBase,
      cow_matched_quote: cowQuote,
      cow_ratio_pct: cowRatio,
      pool_delta_base: rxAfter - rxBefore,
      pool_delta_quote: ryAfter - ryBefore,
      reserves_before: {
        rx: rxBefore,
        ry: ryBefore,
        spot_price: rxBefore > 0 ? ryBefore / rxBefore : 0,
        k_invariant: kBefore,
      },
      reserves_after: {
        rx: rxAfter,
        ry: ryAfter,
        spot_price: rxAfter > 0 ? ryAfter / rxAfter : 0,
        k_invariant: kAfter,
      },
      k_invariant_growth: kGrowth,
      k_invariant_growth_pct: kBefore > 0 ? (kGrowth / kBefore) * 100 : 0,
      slashed_bonds_count: Array.from(slashedCommits).filter((key) =>
        key.startsWith(`${batchId}:`),
      ).length,
      fills,
      supply_curve,
      demand_curve,
      comparison,
    });
  }
  settledHistory.sort((a, b) => b.batch_id - a.batch_id);

  const phase = mapPhase(batch.phase);
  const rx = toHuman(reserves.reserveBase, config.baseDecimals);
  const ry = toHuman(reserves.reserveQuote, config.quoteDecimals);
  const spot = wadToHuman(reserves.spotPriceWad);
  const activeSettlement = computeBatchSettlement(
    activeBatchId,
    rx,
    ry,
    activeOrders,
    activeCommitments.filter((c) => c.slashed).length,
  );

  const state: StateResponse = {
    batch_id: activeBatchId,
    phase,
    commit_duration_secs: Number(batch.commitDeadline - batch.startTime),
    reveal_duration_secs: Number(batch.revealDeadline - batch.commitDeadline),
    phase_remaining_secs: remainingSeconds(batch, phase),
    reserves: {
      rx,
      ry,
      spot_price: spot,
      k_invariant: rx * ry,
      base_symbol: config.baseSymbol,
      quote_symbol: config.quoteSymbol,
      base_decimals: config.baseDecimals,
      quote_decimals: config.quoteDecimals,
    },
    demo_wallets: account
      ? [{ index: 0, name: 'Connected wallet', address: account }]
      : [],
    commitments: activeCommitments,
    orders: activeOrders,
    claimable,
    settled_history: settledHistory,
  };

  const health: HealthResponse = {
    status: 'ok',
    execution_mode: 'rpc_connected',
    rpc_url: config.rpcUrl,
    chain_id: config.chainId,
    contracts: {
      fair_batch: config.fairBatch,
      base_token: config.baseToken,
      quote_token: config.quoteToken,
      deployed: true,
    },
    fe_artifacts_present: false,
    fe_artifacts: [],
  };

  return {
    config,
    health,
    state,
    batch,
    reserves,
    balances,
    allowances,
    nonce,
    domainSeparator,
    minBondWei: config.minBondWei,
    orders: activeOrders,
    commitments: activeCommitments,
    allCommitments,
    batchSettled: settledEvents.some(
      (event) => Number(asBig(event.args.batchId)) === activeBatchId,
    ),
    claimable,
    settledHistory,
    activeSettlement,
    lastUpdated: Date.now(),
  };
}
