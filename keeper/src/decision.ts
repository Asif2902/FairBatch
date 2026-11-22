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
 * - Empty Ready batches settle at most once per `emptyRoundMinutes` (default 10m)
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
