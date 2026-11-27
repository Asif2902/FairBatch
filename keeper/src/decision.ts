export interface BatchSnapshot {
  batchId: bigint;
  startTime: bigint;
  commitDeadline: bigint;
  revealDeadline: bigint;
  orderCount: bigint;
  commitCount: bigint;
  phase: number; // 0=Open, 1=Reveal, 2=Ready, 3=Settled
}

export interface PendingCommitment {
  batchId: bigint;
  commitId: bigint;
  revealDeadline: bigint;
  bondWei: bigint;
  revealed: boolean;
  slashed: boolean;
}

export interface SettlementPolicyInput {
  batch: BatchSnapshot;
  blockTimestamp: bigint;
  balanceWei: bigint;
  minBalanceWei: bigint;
  graceSeconds: number;
  emptyRoundMinutes: number;
  lastEmptySettleAtMs: number | null;
  nowMs: number;
  txInFlight: boolean;
}

export type SettlementDecision =
  | { action: 'none'; reason: string }
  | { action: 'wait_grace'; batchId: bigint; waitSeconds: number; empty: boolean }
  | { action: 'skip'; batchId: bigint; reason: 'low_balance' | 'empty_throttled' | 'tx_in_flight' }
  | { action: 'settle'; batchId: bigint; empty: boolean };

/**
 * Pure decision function for permissionless batch settlement (Stage C1).
 *
 * - Non-empty Ready batches wait `graceSeconds` (default 5s) past `revealDeadline`
 *   so any public user can settle first.
 * - Empty Ready batches wait the same grace period; if `emptyRoundMinutes` > 0 they are
 *   additionally throttled to once per that many minutes (default 0 = no throttle)
 *   and only when the keeper balance is >= `minBalanceWei`.
 */
export function decideSettlementAction(input: SettlementPolicyInput): SettlementDecision {
  const {
    batch,
    blockTimestamp,
    balanceWei,
    minBalanceWei,
    graceSeconds,
    emptyRoundMinutes,
    lastEmptySettleAtMs,
    nowMs,
    txInFlight,
  } = input;

  if (txInFlight) {
    return { action: 'skip', batchId: batch.batchId, reason: 'tx_in_flight' };
  }

  // Batch is Ready strictly when blockTimestamp > revealDeadline and not settled (phase !== 3)
  const isReady = batch.phase !== 3 && blockTimestamp > batch.revealDeadline;
  if (!isReady) {
    return { action: 'none', reason: 'not_ready' };
  }

  if (balanceWei < minBalanceWei) {
    return { action: 'skip', batchId: batch.batchId, reason: 'low_balance' };
  }

  const isEmpty = batch.orderCount === 0n && batch.commitCount === 0n;
  const eligibleAt = batch.revealDeadline + BigInt(Math.max(0, graceSeconds));

  if (blockTimestamp < eligibleAt) {
    return {
      action: 'wait_grace',
      batchId: batch.batchId,
      waitSeconds: Number(eligibleAt - blockTimestamp),
      empty: isEmpty,
    };
  }

  if (isEmpty) {
    const cooldownMs = Math.max(0, emptyRoundMinutes) * 60_000;
    if (lastEmptySettleAtMs !== null && nowMs - lastEmptySettleAtMs < cooldownMs) {
      return { action: 'skip', batchId: batch.batchId, reason: 'empty_throttled' };
    }
    return { action: 'settle', batchId: batch.batchId, empty: true };
  }

  return { action: 'settle', batchId: batch.batchId, empty: false };
}

export interface SlashPolicyInput {
  commitments: PendingCommitment[];
  blockTimestamp: bigint;
  balanceWei: bigint;
  minBalanceWei: bigint;
  slashEnabled: boolean;
  slashGraceSeconds: number;
  txInFlight: boolean;
}

export type SlashDecision =
  | { action: 'none'; reason: string }
  | { action: 'skip'; reason: 'low_balance' | 'tx_in_flight' | 'disabled' }
  | { action: 'slash'; batchId: bigint; commitId: bigint; bondWei: bigint };

/**
 * Pure decision function for slashing expired unrevealed commitments (Stage C2).
 * Waits `slashGraceSeconds` (default 60s) past `revealDeadline` before slashing.
 */
export function decideSlashAction(input: SlashPolicyInput): SlashDecision {
  const {
    commitments,
    blockTimestamp,
    balanceWei,
    minBalanceWei,
    slashEnabled,
    slashGraceSeconds,
    txInFlight,
  } = input;

  if (!slashEnabled) return { action: 'skip', reason: 'disabled' };
  if (txInFlight) return { action: 'skip', reason: 'tx_in_flight' };
  if (balanceWei < minBalanceWei) return { action: 'skip', reason: 'low_balance' };

  const grace = BigInt(Math.max(0, slashGraceSeconds));
  for (const commit of commitments) {
    if (commit.revealed || commit.slashed) continue;
    const slashEligibleAt = commit.revealDeadline + grace;
    if (blockTimestamp > commit.revealDeadline && blockTimestamp >= slashEligibleAt) {
      return {
        action: 'slash',
        batchId: commit.batchId,
        commitId: commit.commitId,
        bondWei: commit.bondWei,
      };
    }
  }

  return { action: 'none', reason: 'no_eligible_commitments' };
}

export function isAlreadySettledError(error: unknown): boolean {
  const text = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    text.includes('batch already settled') ||
    text.includes('reveal window still active') ||
    text.includes('already settled')
  );
}

export function isAlreadySlashedError(error: unknown): boolean {
  const text = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    text.includes('already slashed') ||
    text.includes('commitment was revealed') ||
    text.includes('reveal window not expired')
  );
}

export function isReceiptTimeoutError(error: unknown): boolean {
  if (error instanceof Error && error.name === 'WaitForTransactionReceiptTimeoutError') {
    return true;
  }
  const text = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return text.includes('timed out while waiting for transaction');
}

export function isReplacementUnderpricedError(error: unknown): boolean {
  const text = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    text.includes('replacement transaction underpriced') ||
    text.includes('replacement fee too low') ||
    text.includes('transaction underpriced') ||
    text.includes('max fee per gas less than block base fee')
  );
}

export function isNonceTooLowError(error: unknown): boolean {
  const text = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    text.includes('nonce too low') ||
    text.includes('nonce has already been used') ||
    text.includes('already known')
  );
}

export const DEFAULT_MIN_PRIORITY_FEE_WEI = 1_000_000n; // 0.001 gwei
export const DEFAULT_MIN_MAX_FEE_WEI = 250_000_000n; // 0.25 gwei (absorbs Sepolia baseFee spikes safely)

export interface SafeFeeInput {
  baseFeePerGas?: bigint | null;
  estimatedMaxFeePerGas?: bigint | null;
  estimatedPriorityFeePerGas?: bigint | null;
  maxGasPriceWei: bigint;
  minPriorityFeeWei?: bigint;
  minMaxFeeWei?: bigint;
}

export interface FeeQuote {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

function maxBigInt(...values: bigint[]): bigint {
  let out = 0n;
  for (const v of values) {
    if (v > out) out = v;
  }
  return out;
}

/**
 * Computes EIP-1559 fee parameters with headroom against sudden Sepolia baseFee spikes.
 * EIP-1559 only charges `min(maxFeePerGas, baseFee + maxPriorityFeePerGas)`, so providing
 * generous `maxFeePerGas` headroom avoids stranded mempool txs at near-zero extra cost.
 */
export function computeSafeFees(input: SafeFeeInput): FeeQuote | null {
  const cap = input.maxGasPriceWei;
  if (cap <= 0n) return null;

  const minPriority = input.minPriorityFeeWei ?? DEFAULT_MIN_PRIORITY_FEE_WEI;
  const minMaxFee = input.minMaxFeeWei ?? DEFAULT_MIN_MAX_FEE_WEI;

  const effectivePriorityFloor = minPriority < cap ? minPriority : cap;
  const effectiveMaxFeeFloor = minMaxFee < cap ? minMaxFee : cap;

  const priority = maxBigInt(input.estimatedPriorityFeePerGas ?? 0n, effectivePriorityFloor);
  const baseFee = input.baseFeePerGas ?? 0n;
  const rpcMaxFee = input.estimatedMaxFeePerGas ?? 0n;

  const minNeeded = maxBigInt(baseFee + priority, rpcMaxFee);
  if (minNeeded > cap || priority > cap) {
    return null;
  }

  const desiredMaxFee = maxBigInt(baseFee * 3n + priority, rpcMaxFee, effectiveMaxFeeFloor, priority);
  const maxFeePerGas = desiredMaxFee > cap ? cap : desiredMaxFee;
  return { maxFeePerGas, maxPriorityFeePerGas: priority };
}

/**
 * Computes replacement fees for the SAME nonce (at least +25% over previous maxFee & tip,
 * clearing geth/reth/nethermind's >= 10% replacement threshold) capped by `maxGasPriceWei`.
 */
export function computeReplacementFees(
  previous: FeeQuote,
  fresh: FeeQuote,
  maxGasPriceWei: bigint,
): FeeQuote | null {
  const minBumpedPriority = (previous.maxPriorityFeePerGas * 125n + 99n) / 100n + 1n;
  const minBumpedMaxFee = maxBigInt(
    (previous.maxFeePerGas * 125n + 99n) / 100n + 1n,
    minBumpedPriority,
  );
  if (minBumpedMaxFee > maxGasPriceWei || minBumpedPriority > maxGasPriceWei) {
    return null;
  }
  const desiredPriority = maxBigInt(minBumpedPriority, fresh.maxPriorityFeePerGas);
  const maxPriorityFeePerGas =
    desiredPriority > maxGasPriceWei ? maxGasPriceWei : desiredPriority;
  const desiredMaxFee = maxBigInt(minBumpedMaxFee, fresh.maxFeePerGas, maxPriorityFeePerGas);
  const maxFeePerGas = desiredMaxFee > maxGasPriceWei ? maxGasPriceWei : desiredMaxFee;
  return { maxFeePerGas, maxPriorityFeePerGas };
}
