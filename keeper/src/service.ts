import http from 'node:http';
import {
  createPublicClient,
  createWalletClient,
  fallback,
  formatEther,
  http as viemHttp,
  type Address,
  type Hash,
  type Hex,
  type TransactionReceipt,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { fairBatchAbi, fairBatchEvents } from './abi.js';
import { maskRpcUrl, type KeeperConfig } from './config.js';
import {
  DEFAULT_MIN_MAX_FEE_WEI,
  DEFAULT_MIN_PRIORITY_FEE_WEI,
  computeReplacementFees,
  computeSafeFees,
  decideSettlementAction,
  decideSlashAction,
  isAlreadySettledError,
  isAlreadySlashedError,
  isNonceTooLowError,
  isReceiptTimeoutError,
  isReplacementUnderpricedError,
  type BatchSnapshot,
  type FeeQuote,
  type PendingCommitment,
} from './decision.js';

export class PendingTxBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PendingTxBlockedError';
  }
}

export class PendingTxTimeoutError extends Error {
  public readonly txHash: Hash;
  public readonly nonce: number;

  constructor(txHash: Hash, nonce: number) {
    super(`Transaction ${txHash} (nonce ${nonce}) is still pending confirmation.`);
    this.name = 'PendingTxTimeoutError';
    this.txHash = txHash;
    this.nonce = nonce;
  }
}

export type PendingTxKind = 'settle' | 'slash' | 'relay' | 'cancel';

export interface TrackedPendingTx {
  nonce: number;
  hash: Hash;
  hashes: Hash[];
  kind: PendingTxKind;
  batchId?: bigint;
  commitId?: bigint;
  empty?: boolean;
  bondWei?: bigint;
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  sentAtMs: number;
  lastBumpedAtMs: number;
  attempts: number;
}

export interface PendingTxHealthSnapshot {
  nonce: number;
  hash: Hash | null;
  kind: PendingTxKind | 'external';
  attempts: number;
  maxFeePerGas: string | null;
  ageSeconds: number;
}

export interface KeeperHealthSnapshot {
  status: 'ok' | 'degraded';
  mode: 'dry_run' | 'live';
  dryRun: boolean;
  chainId: number;
  fairBatch: Address;
  keeperAddress: Address | null;
  balanceEth: string;
  minBalanceEth: string;
  lowBalance: boolean;
  graceSeconds: number;
  slashEnabled: boolean;
  slashGraceSeconds: number;
  pendingTx: PendingTxHealthSnapshot | null;
  currentBatch: {
    batchId: number;
    phase: number;
    orderCount: number;
    commitCount: number;
    revealDeadline: number;
  } | null;
  lastAction: string;
  lastActionAt: string | null;
  lastTxHash: Hash | null;
  uptimeSeconds: number;
}

export interface LogFn {
  (level: 'info' | 'warn' | 'error', event: string, fields?: Record<string, unknown>): void;
}

export const structuredLog: LogFn = (level, event, fields = {}) => {
  const sanitized: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    sanitized[k] = typeof v === 'string' ? maskRpcUrl(v) : v;
  }
  const entry = {
    ts: new Date().toISOString(),
    level,
    event,
    ...sanitized,
  };
  const line = JSON.stringify(entry);
  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
};

export interface ExtraHttpHandler {
  (req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean>;
}

export interface KeeperClientOverrides {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  publicClient?: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  walletClient?: any;
  accountAddress?: Address | null;
}

export class FairBatchKeeper {
  private readonly config: KeeperConfig;
  private readonly log: LogFn;
  private readonly startedAtMs = Date.now();
  private readonly publicClient;
  private readonly walletClient;
  private readonly accountAddress: Address | null;
  private readonly txConfirmTimeoutMs: number;
  private readonly txReplaceAfterMs: number;
  private readonly externalPendingGraceMs: number;
  private readonly minPriorityFeeWei: bigint;
  private readonly minMaxFeeWei: bigint;

  private timer: NodeJS.Timeout | null = null;
  private server: http.Server | null = null;
  private stopping = false;
  private tickInFlight = false;
  private txInFlight = false;
  private txTail: Promise<void> = Promise.resolve();

  private pendingTx: TrackedPendingTx | null = null;
  private externalPendingNonce: number | null = null;
  private externalPendingObservedAtMs: number | null = null;
  private lastPendingLogAtMs = 0;

  private lastBalanceWei = 0n;
  private lastLowBalanceLogAtMs = 0;
  private lastEmptySettleAtMs: number | null = null;
  private lastBatch: BatchSnapshot | null = null;
  private lastSettledBySelfBatchId: bigint | null = null;
  private lastAction = 'initialized';
  private lastActionAt: string | null = null;
  private lastTxHash: Hash | null = null;
  private lastScannedCommitBlock: bigint | null = null;
  private commitLogChunkSize = 2_000n;
  private trackedCommits = new Map<string, PendingCommitment>();
  private batchDeadlines = new Map<string, bigint>();
  private consecutiveRpcErrors = 0;
  private extraHttpHandlers: ExtraHttpHandler[] = [];
  private healthAugmenters: Array<() => Record<string, unknown>> = [];

  constructor(
    config: KeeperConfig,
    log: LogFn = structuredLog,
    clients?: KeeperClientOverrides,
  ) {
    this.config = config;
    this.log = log;
    this.txConfirmTimeoutMs = config.txConfirmTimeoutMs ?? 60_000;
    this.txReplaceAfterMs = config.txReplaceAfterMs ?? 45_000;
    this.externalPendingGraceMs = config.externalPendingGraceMs ?? 15_000;
    this.minPriorityFeeWei = config.minPriorityFeeWei ?? DEFAULT_MIN_PRIORITY_FEE_WEI;
    this.minMaxFeeWei = config.minMaxFeeWei ?? DEFAULT_MIN_MAX_FEE_WEI;

    const transports = config.rpcUrls.map((url) =>
      viemHttp(url, { timeout: 15_000, retryCount: 1, retryDelay: 500 }),
    );
    const transport = transports.length === 1 ? transports[0] : fallback(transports, { rank: false });

    const chain = {
      ...sepolia,
      id: config.chainId,
      rpcUrls: { default: { http: config.rpcUrls } },
    };

    this.publicClient = clients?.publicClient ?? createPublicClient({ chain, transport });

    if (clients && 'walletClient' in clients) {
      this.walletClient = clients.walletClient ?? null;
      this.accountAddress = clients.accountAddress ?? null;
    } else if (config.privateKey) {
      const account = privateKeyToAccount(config.privateKey);
      this.accountAddress = account.address;
      this.walletClient = createWalletClient({ account, chain, transport });
    } else {
      this.accountAddress = null;
      this.walletClient = null;
    }
  }

  public getPublicClient() {
    return this.publicClient;
  }

  public getWalletClient() {
    return this.walletClient;
  }

  public getKeeperAddress(): Address | null {
    return this.accountAddress;
  }

  public getConfig(): KeeperConfig {
    return this.config;
  }

  public isLowBalance(): boolean {
    return !this.config.dryRun && this.lastBalanceWei < this.config.minBalanceWei;
  }

  public hasPendingTx(): boolean {
    return this.pendingTx !== null || this.externalPendingNonce !== null;
  }

  public isTxBusy(): boolean {
    return this.hasPendingTx() || this.txInFlight;
  }

  public getPendingTxSnapshot(): PendingTxHealthSnapshot | null {
    const nowMs = Date.now();
    if (this.pendingTx) {
      return {
        nonce: this.pendingTx.nonce,
        hash: this.pendingTx.hash,
        kind: this.pendingTx.kind,
        attempts: this.pendingTx.attempts,
        maxFeePerGas: this.pendingTx.maxFeePerGas.toString(),
        ageSeconds: Math.max(0, Math.floor((nowMs - this.pendingTx.sentAtMs) / 1000)),
      };
    }
    if (this.externalPendingNonce !== null) {
      return {
        nonce: this.externalPendingNonce,
        hash: null,
        kind: 'external',
        attempts: 0,
        maxFeePerGas: null,
        ageSeconds:
          this.externalPendingObservedAtMs !== null
            ? Math.max(0, Math.floor((nowMs - this.externalPendingObservedAtMs) / 1000))
            : 0,
      };
    }
    return null;
  }

  public registerHttpHandler(handler: ExtraHttpHandler): void {
    this.extraHttpHandlers.push(handler);
  }

  public registerHealthAugmenter(fn: () => Record<string, unknown>): void {
    this.healthAugmenters.push(fn);
  }

  public async withTxLock<T>(_label: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.txTail;
    let release!: () => void;
    this.txTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prev;
    this.txInFlight = true;
    try {
      return await fn();
    } finally {
      this.txInFlight = false;
      release();
    }
  }

  public async checkGasPrice(knownBaseFeePerGas?: bigint | null): Promise<FeeQuote | null> {
    const [fees, blockBaseFee] = await Promise.all([
      this.publicClient.estimateFeesPerGas(),
      knownBaseFeePerGas !== undefined
        ? Promise.resolve(knownBaseFeePerGas)
        : this.publicClient
            .getBlock({ blockTag: 'latest' })
            .then((blk: { baseFeePerGas?: bigint | null }) => blk.baseFeePerGas ?? null)
            .catch(() => null),
    ]);

    const computed = computeSafeFees({
      baseFeePerGas: blockBaseFee,
      estimatedMaxFeePerGas: fees.maxFeePerGas ?? fees.gasPrice ?? null,
      estimatedPriorityFeePerGas: fees.maxPriorityFeePerGas ?? null,
      maxGasPriceWei: this.config.maxGasPriceWei,
      minPriorityFeeWei: this.minPriorityFeeWei,
      minMaxFeeWei: this.minMaxFeeWei,
    });

    if (!computed) {
      const observed = fees.maxFeePerGas ?? fees.gasPrice ?? blockBaseFee ?? 0n;
      this.log('warn', 'gas_price_cap_exceeded', {
        maxFeePerGas: observed.toString(),
        baseFeePerGas: blockBaseFee?.toString() ?? null,
        capWei: this.config.maxGasPriceWei.toString(),
      });
      return null;
    }
    return computed;
  }

  public getHealth(): KeeperHealthSnapshot & Record<string, unknown> {
    const lowBalance = this.isLowBalance();
    const extra: Record<string, unknown> = {};
    for (const augment of this.healthAugmenters) {
      Object.assign(extra, augment());
    }
    return {
      status: lowBalance || this.consecutiveRpcErrors >= 5 ? 'degraded' : 'ok',
      mode: this.config.dryRun ? 'dry_run' : 'live',
      dryRun: this.config.dryRun,
      chainId: this.config.chainId,
      fairBatch: this.config.fairBatch,
      keeperAddress: this.accountAddress,
      balanceEth: formatEther(this.lastBalanceWei),
      minBalanceEth: formatEther(this.config.minBalanceWei),
      lowBalance,
      graceSeconds: this.config.graceSeconds,
      slashEnabled: this.config.slashEnabled,
      slashGraceSeconds: this.config.slashGraceSeconds,
      pendingTx: this.getPendingTxSnapshot(),
      currentBatch: this.lastBatch
        ? {
            batchId: Number(this.lastBatch.batchId),
            phase: this.lastBatch.phase,
            orderCount: Number(this.lastBatch.orderCount),
            commitCount: Number(this.lastBatch.commitCount),
            revealDeadline: Number(this.lastBatch.revealDeadline),
          }
        : null,
      lastAction: this.lastAction,
      lastActionAt: this.lastActionAt,
      lastTxHash: this.lastTxHash,
      uptimeSeconds: Math.floor((Date.now() - this.startedAtMs) / 1000),
      ...extra,
    };
  }

  private recordAction(action: string, txHash?: Hash): void {
    this.lastAction = action;
    this.lastActionAt = new Date().toISOString();
    if (txHash) this.lastTxHash = txHash;
  }

  private noteExternalPending(latestNonce: number, _pendingNonce: number, nowMs = Date.now()): void {
    if (this.externalPendingNonce !== latestNonce) {
      this.externalPendingNonce = latestNonce;
      this.externalPendingObservedAtMs = nowMs;
    }
  }

  private clearExternalPending(): void {
    this.externalPendingNonce = null;
    this.externalPendingObservedAtMs = null;
  }

  private async fetchWalletNonces(): Promise<{ latestNonce: number; pendingNonce: number }> {
    if (!this.accountAddress) {
      return { latestNonce: 0, pendingNonce: 0 };
    }
    const [latestNonce, pendingNonce] = await Promise.all([
      this.publicClient.getTransactionCount({
        address: this.accountAddress,
        blockTag: 'latest',
      }),
      this.publicClient.getTransactionCount({
        address: this.accountAddress,
        blockTag: 'pending',
      }),
    ]);
    return { latestNonce, pendingNonce };
  }

  /**
   * Enforces the strict single-pending-transaction invariant before ANY broadcast:
   * never submits a new tx while either our tracked `pendingTx` or on-chain mempool
   * (`pendingNonce > latestNonce`) already has an unconfirmed transaction.
   * Always returns `latestNonce` (never `pendingNonce` > `latestNonce`).
   */
  private async acquireCleanNonce(label: string): Promise<number | null> {
    if (!this.accountAddress) return null;

    if (this.pendingTx !== null) {
      this.log('info', 'skipped_pending_tx_active', {
        label,
        pendingNonce: this.pendingTx.nonce,
        pendingHash: this.pendingTx.hash,
        pendingKind: this.pendingTx.kind,
      });
      return null;
    }

    const { latestNonce, pendingNonce } = await this.fetchWalletNonces();
    if (pendingNonce > latestNonce) {
      this.noteExternalPending(latestNonce, pendingNonce);
      this.log('warn', 'skipped_external_pending_tx', {
        label,
        latestNonce,
        pendingNonce,
        queuedCount: pendingNonce - latestNonce,
      });
      return null;
    }

    this.clearExternalPending();
    return latestNonce;
  }

  private finalizeTrackedConfirmation(
    pending: TrackedPendingTx,
    receipt: TransactionReceipt | null,
    confirmedHash: Hash,
  ): void {
    const succeeded = receipt ? receipt.status === 'success' : true;
    if (pending.kind === 'settle' && succeeded) {
      if (pending.empty) this.lastEmptySettleAtMs = Date.now();
      if (pending.batchId !== undefined) {
        this.lastSettledBySelfBatchId = pending.batchId;
        this.recordAction(`settled_batch_${pending.batchId.toString()}`, confirmedHash);
      }
    } else if (pending.kind === 'slash' && succeeded) {
      if (pending.batchId !== undefined && pending.commitId !== undefined) {
        const key = `${pending.batchId.toString()}:${pending.commitId.toString()}`;
        const existing = this.trackedCommits.get(key);
        if (existing) existing.slashed = true;
        this.recordAction(
          `slashed_${pending.batchId.toString()}_${pending.commitId.toString()}`,
          confirmedHash,
        );
      }
    } else if (pending.kind === 'cancel') {
      this.recordAction(`cancelled_stuck_nonce_${pending.nonce}`, confirmedHash);
    } else if (pending.kind === 'relay') {
      this.recordAction(`relayed_nonce_${pending.nonce}`, confirmedHash);
    }

    this.log('info', 'pending_tx_confirmed', {
      kind: pending.kind,
      nonce: pending.nonce,
      txHash: confirmedHash,
      batchId: pending.batchId !== undefined ? Number(pending.batchId) : undefined,
      blockNumber: receipt ? Number(receipt.blockNumber) : null,
      gasUsed: receipt ? receipt.gasUsed.toString() : null,
      status: receipt ? receipt.status : 'mined',
      attempts: pending.attempts,
    });
  }

  private async findMinedReceipt(
    hashes: Hash[],
  ): Promise<{ hash: Hash; receipt: TransactionReceipt } | null> {
    for (let i = hashes.length - 1; i >= 0; i -= 1) {
      const candidate = hashes[i];
      try {
        const receipt = await this.publicClient.getTransactionReceipt({ hash: candidate });
        if (receipt) return { hash: candidate, receipt };
      } catch {
        // receipt not yet available on this node
      }
    }
    return null;
  }

  /**
   * Reconciles any tracked or pre-existing mempool pending transaction BEFORE allowing
   * any new transaction. Returns `true` when the wallet still has a pending tx (meaning
   * the caller MUST NOT submit any new transaction on this tick).
   */
  private async reconcilePendingTx(
    block: { baseFeePerGas?: bigint | null },
    rawBatch: BatchSnapshot,
    latestNonce: number,
    pendingNonce: number,
  ): Promise<boolean> {
    if (this.config.dryRun || !this.accountAddress || !this.walletClient) {
      return false;
    }

    const nowMs = Date.now();

    // 1. Reconcile our own tracked pending transaction
    if (this.pendingTx !== null) {
      const pending = this.pendingTx;
      const mined = await this.findMinedReceipt(pending.hashes);
      if (mined || latestNonce > pending.nonce) {
        this.finalizeTrackedConfirmation(
          pending,
          mined?.receipt ?? null,
          mined?.hash ?? pending.hash,
        );
        this.pendingTx = null;
        if (pendingNonce <= latestNonce) {
          this.clearExternalPending();
          return false;
        }
        // Another pre-existing pending tx exists at the new latestNonce; stay blocked
      } else {
        const ageSinceBumpMs = nowMs - pending.lastBumpedAtMs;
        const baseFee = block.baseFeePerGas ?? 0n;
        const underpriced = baseFee > 0n && baseFee > pending.maxFeePerGas;
        const shouldReplace =
          ageSinceBumpMs >= this.txReplaceAfterMs || (underpriced && ageSinceBumpMs >= 15_000);

        if (!shouldReplace) {
          if (nowMs - this.lastPendingLogAtMs >= 15_000) {
            this.lastPendingLogAtMs = nowMs;
            this.log('info', 'waiting_pending_tx', {
              kind: pending.kind,
              nonce: pending.nonce,
              txHash: pending.hash,
              attempts: pending.attempts,
              ageSeconds: Math.floor((nowMs - pending.sentAtMs) / 1000),
              maxFeePerGas: pending.maxFeePerGas.toString(),
              baseFeePerGas: baseFee.toString(),
            });
          }
          return true;
        }

        await this.replaceTrackedPendingTx(block, rawBatch);
        return true;
      }
    }

    // 2. Reconcile pre-existing / external pending mempool tx(s) (pendingNonce > latestNonce)
    if (pendingNonce > latestNonce) {
      this.noteExternalPending(latestNonce, pendingNonce, nowMs);
      const observedAgeMs = Math.max(0, nowMs - (this.externalPendingObservedAtMs ?? nowMs));

      if (observedAgeMs < this.externalPendingGraceMs || this.isLowBalance()) {
        if (nowMs - this.lastPendingLogAtMs >= 15_000) {
          this.lastPendingLogAtMs = nowMs;
          this.log('warn', 'waiting_external_pending_tx', {
            latestNonce,
            pendingNonce,
            queuedCount: pendingNonce - latestNonce,
            observedAgeSeconds: Math.floor(observedAgeMs / 1000),
            lowBalance: this.isLowBalance(),
          });
        }
        return true;
      }

      await this.cancelExternalPendingNonce(block, latestNonce);
      return true;
    }

    this.clearExternalPending();
    return false;
  }

  private async replaceTrackedPendingTx(
    block: { baseFeePerGas?: bigint | null },
    rawBatch: BatchSnapshot,
  ): Promise<void> {
    if (!this.walletClient || !this.accountAddress) return;

    await this.withTxLock('replacePendingTx', async () => {
      const pending = this.pendingTx;
      if (!pending) return;

      const { latestNonce } = await this.fetchWalletNonces();
      if (latestNonce > pending.nonce) {
        const mined = await this.findMinedReceipt(pending.hashes);
        this.finalizeTrackedConfirmation(
          pending,
          mined?.receipt ?? null,
          mined?.hash ?? pending.hash,
        );
        this.pendingTx = null;
        return;
      }

      const freshFees = await this.checkGasPrice(block.baseFeePerGas);
      if (!freshFees) return;

      const replacementFees = computeReplacementFees(
        {
          maxFeePerGas: pending.maxFeePerGas,
          maxPriorityFeePerGas: pending.maxPriorityFeePerGas,
        },
        freshFees,
        this.config.maxGasPriceWei,
      );
      if (!replacementFees) {
        this.log('warn', 'pending_tx_bump_cap_exceeded', {
          nonce: pending.nonce,
          txHash: pending.hash,
          prevMaxFeePerGas: pending.maxFeePerGas.toString(),
          capWei: this.config.maxGasPriceWei.toString(),
        });
        return;
      }

      let replaceAsSettle =
        pending.kind === 'settle' &&
        pending.batchId !== undefined &&
        pending.batchId === rawBatch.batchId &&
        rawBatch.phase !== 3 &&
        pending.attempts < 4;

      if (replaceAsSettle) {
        try {
          await this.publicClient.simulateContract({
            address: this.config.fairBatch,
            abi: fairBatchAbi,
            functionName: 'settleBatch',
            account: this.accountAddress!,
          });
        } catch {
          // Batch already settled or no longer valid; switch to cheap 21k-gas cancel on same nonce
          replaceAsSettle = false;
        }
      }

      let newHash: Hash;
      try {
        if (replaceAsSettle) {
          newHash = await this.walletClient!.writeContract({
            address: this.config.fairBatch,
            abi: fairBatchAbi,
            functionName: 'settleBatch',
            args: [],
            nonce: pending.nonce,
            gas: pending.gas,
            maxFeePerGas: replacementFees.maxFeePerGas,
            maxPriorityFeePerGas: replacementFees.maxPriorityFeePerGas,
          });
        } else {
          newHash = await this.walletClient!.sendTransaction({
            to: this.accountAddress!,
            value: 0n,
            gas: 21_000n,
            nonce: pending.nonce,
            maxFeePerGas: replacementFees.maxFeePerGas,
            maxPriorityFeePerGas: replacementFees.maxPriorityFeePerGas,
          });
        }
      } catch (err) {
        if (isNonceTooLowError(err)) {
          const mined = await this.findMinedReceipt(pending.hashes);
          this.finalizeTrackedConfirmation(
            pending,
            mined?.receipt ?? null,
            mined?.hash ?? pending.hash,
          );
          this.pendingTx = null;
          return;
        }
        if (isReplacementUnderpricedError(err)) {
          pending.maxFeePerGas = replacementFees.maxFeePerGas;
          pending.maxPriorityFeePerGas = replacementFees.maxPriorityFeePerGas;
          pending.lastBumpedAtMs = Date.now();
          this.log('warn', 'pending_tx_replacement_underpriced', {
            nonce: pending.nonce,
            attemptedMaxFeePerGas: replacementFees.maxFeePerGas.toString(),
            attemptedPriorityFeePerGas: replacementFees.maxPriorityFeePerGas.toString(),
          });
          return;
        }
        throw err;
      }

      pending.hash = newHash;
      pending.hashes.push(newHash);
      pending.kind = replaceAsSettle ? 'settle' : 'cancel';
      pending.gas = replaceAsSettle ? pending.gas : 21_000n;
      pending.maxFeePerGas = replacementFees.maxFeePerGas;
      pending.maxPriorityFeePerGas = replacementFees.maxPriorityFeePerGas;
      pending.lastBumpedAtMs = Date.now();
      pending.attempts += 1;

      this.log('info', 'pending_tx_replaced', {
        kind: pending.kind,
        nonce: pending.nonce,
        txHash: newHash,
        attempts: pending.attempts,
        maxFeePerGas: replacementFees.maxFeePerGas.toString(),
        maxPriorityFeePerGas: replacementFees.maxPriorityFeePerGas.toString(),
      });

      try {
        const receipt = await this.publicClient.waitForTransactionReceipt({
          hash: newHash,
          confirmations: 1,
          timeout: this.txConfirmTimeoutMs,
        });
        this.finalizeTrackedConfirmation(pending, receipt, newHash);
        this.pendingTx = null;
      } catch (err) {
        if (isReceiptTimeoutError(err)) {
          this.log('warn', 'tx_confirmation_timeout', {
            kind: pending.kind,
            nonce: pending.nonce,
            txHash: newHash,
            attempts: pending.attempts,
            maxFeePerGas: pending.maxFeePerGas.toString(),
          });
          return;
        }
        // Keep pendingTx set on transient receipt-polling errors so no second nonce is submitted
        this.log('warn', 'pending_tx_receipt_poll_failed', {
          kind: pending.kind,
          nonce: pending.nonce,
          txHash: newHash,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });
  }

  private async cancelExternalPendingNonce(
    block: { baseFeePerGas?: bigint | null },
    targetNonce: number,
  ): Promise<void> {
    if (!this.walletClient || !this.accountAddress) return;

    await this.withTxLock('cancelExternalPendingNonce', async () => {
      if (this.pendingTx !== null) return;
      const { latestNonce, pendingNonce } = await this.fetchWalletNonces();
      if (pendingNonce <= latestNonce || latestNonce !== targetNonce) {
        if (pendingNonce <= latestNonce) this.clearExternalPending();
        return;
      }

      let fees = await this.checkGasPrice(block.baseFeePerGas);
      if (!fees) return;

      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          const hash = await this.walletClient!.sendTransaction({
            to: this.accountAddress!,
            value: 0n,
            gas: 21_000n,
            nonce: targetNonce,
            maxFeePerGas: fees.maxFeePerGas,
            maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
          });

          const tracked: TrackedPendingTx = {
            nonce: targetNonce,
            hash,
            hashes: [hash],
            kind: 'cancel',
            gas: 21_000n,
            maxFeePerGas: fees.maxFeePerGas,
            maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
            sentAtMs: Date.now(),
            lastBumpedAtMs: Date.now(),
            attempts: 1,
          };
          this.pendingTx = tracked;

          this.log('warn', 'cancelling_stuck_nonce', {
            nonce: targetNonce,
            pendingNonce,
            txHash: hash,
            maxFeePerGas: fees.maxFeePerGas.toString(),
            maxPriorityFeePerGas: fees.maxPriorityFeePerGas.toString(),
          });

          try {
            const receipt = await this.publicClient.waitForTransactionReceipt({
              hash,
              confirmations: 1,
              timeout: this.txConfirmTimeoutMs,
            });
            this.finalizeTrackedConfirmation(tracked, receipt, hash);
            this.pendingTx = null;
            this.clearExternalPending();
          } catch (waitErr) {
            if (isReceiptTimeoutError(waitErr)) {
              this.log('warn', 'tx_confirmation_timeout', {
                kind: 'cancel',
                nonce: targetNonce,
                txHash: hash,
                attempts: 1,
                maxFeePerGas: fees.maxFeePerGas.toString(),
              });
            } else {
              this.log('warn', 'pending_tx_receipt_poll_failed', {
                kind: 'cancel',
                nonce: targetNonce,
                txHash: hash,
                error: waitErr instanceof Error ? waitErr.message : String(waitErr),
              });
            }
          }
          return;
        } catch (err) {
          if (isNonceTooLowError(err)) {
            this.clearExternalPending();
            return;
          }
          if (isReplacementUnderpricedError(err) && attempt < 3) {
            const escalated = computeReplacementFees(
              fees,
              {
                maxFeePerGas: fees.maxFeePerGas * 2n,
                maxPriorityFeePerGas: fees.maxPriorityFeePerGas * 2n,
              },
              this.config.maxGasPriceWei,
            );
            if (!escalated) {
              this.log('warn', 'stuck_nonce_cancel_cap_exceeded', {
                nonce: targetNonce,
                capWei: this.config.maxGasPriceWei.toString(),
              });
              return;
            }
            fees = escalated;
            continue;
          }
          throw err;
        }
      }
    });
  }

  /**
   * Broadcasts an EIP-712 signed intent through the keeper's unified single-pending-tx gate.
   * Must be called inside `withTxLock('submitSignedIntent', ...)`.
   */
  public async broadcastSignedIntentTx(
    order: {
      trader: Address;
      side: number;
      amountIn: bigint;
      limitPrice: bigint;
      batchId: bigint;
      nonce: bigint;
      deadline: bigint;
    },
    signature: Hex,
    gas: bigint,
    fees: FeeQuote,
  ): Promise<{ txHash: Hash; receipt: TransactionReceipt }> {
    if (!this.walletClient || !this.accountAddress) {
      throw new Error('Relayer wallet is not configured.');
    }

    const txNonce = await this.acquireCleanNonce('submitSignedIntent');
    if (txNonce === null) {
      throw new PendingTxBlockedError(
        'Relayer wallet already has a transaction pending confirmation.',
      );
    }

    const txHash = await this.walletClient.writeContract({
      address: this.config.fairBatch,
      abi: fairBatchAbi,
      functionName: 'submitSignedIntent',
      args: [order, signature],
      nonce: txNonce,
      gas,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    });

    const tracked: TrackedPendingTx = {
      nonce: txNonce,
      hash: txHash,
      hashes: [txHash],
      kind: 'relay',
      batchId: order.batchId,
      gas,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      sentAtMs: Date.now(),
      lastBumpedAtMs: Date.now(),
      attempts: 1,
    };
    this.pendingTx = tracked;

    try {
      const receipt = await this.publicClient.waitForTransactionReceipt({
        hash: txHash,
        confirmations: 1,
        timeout: this.txConfirmTimeoutMs,
      });
      this.pendingTx = null;
      this.recordAction(`relayed_batch_${order.batchId.toString()}`, txHash);
      return { txHash, receipt };
    } catch (err) {
      if (isReceiptTimeoutError(err)) {
        this.log('warn', 'tx_confirmation_timeout', {
          kind: 'relay',
          batchId: Number(order.batchId),
          nonce: txNonce,
          txHash,
          maxFeePerGas: fees.maxFeePerGas.toString(),
          maxPriorityFeePerGas: fees.maxPriorityFeePerGas.toString(),
        });
        throw new PendingTxTimeoutError(txHash, txNonce);
      }
      // Keep pendingTx tracked so no subsequent tx opens a second nonce before confirmation
      throw err;
    }
  }

  private async withRetry<T>(label: string, fn: () => Promise<T>, maxAttempts = 3): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await fn();
      } catch (err) {
        lastError = err;
        if (attempt < maxAttempts) {
          const delayMs = 400 * 2 ** (attempt - 1);
          this.log('warn', 'rpc_retry', {
            label,
            attempt,
            delayMs,
            error: err instanceof Error ? err.message : String(err),
          });
          await new Promise((r) => setTimeout(r, delayMs));
        }
      }
    }
    throw lastError;
  }

  private async refreshCommitments(latestBlockNumber: bigint, currentBatch: BatchSnapshot): Promise<void> {
    if (!this.config.slashEnabled) return;
    this.batchDeadlines.set(currentBatch.batchId.toString(), currentBatch.revealDeadline);

    // Lag log queries by 1 block to avoid cross-RPC head skew ("block X is beyond latest block Y")
    const safeToBlock = latestBlockNumber > 1n ? latestBlockNumber - 1n : 0n;
    const lookbackFloor = safeToBlock > 5_000n ? safeToBlock - 5_000n : 0n;
    const initialFrom =
      lookbackFloor > this.config.deploymentBlock ? lookbackFloor : this.config.deploymentBlock;
    const fromBlock =
      this.lastScannedCommitBlock !== null ? this.lastScannedCommitBlock + 1n : initialFrom;

    if (fromBlock <= safeToBlock) {
      const toBlock =
        safeToBlock - fromBlock > this.commitLogChunkSize
          ? fromBlock + this.commitLogChunkSize
          : safeToBlock;
      try {
        const logs = await this.publicClient.getLogs({
          address: this.config.fairBatch,
          event: fairBatchEvents[0], // OrderCommitted
          fromBlock,
          toBlock,
        });
        for (const ev of logs) {
          const args = ev.args;
          if (args.batchId === undefined || args.commitId === undefined) continue;
          const key = `${args.batchId.toString()}:${args.commitId.toString()}`;
          if (!this.trackedCommits.has(key)) {
            const deadline =
              this.batchDeadlines.get(args.batchId.toString()) ??
              (args.batchId < currentBatch.batchId ? 0n : currentBatch.revealDeadline);
            this.trackedCommits.set(key, {
              batchId: args.batchId,
              commitId: args.commitId,
              revealDeadline: deadline,
              bondWei: args.bond ?? 0n,
              revealed: false,
              slashed: false,
            });
          }
        }
        this.lastScannedCommitBlock = toBlock;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const lower = msg.toLowerCase();
        // Adapt automatically to Alchemy Free Tier 10-block eth_getLogs limit
        if (
          lower.includes('10 block') ||
          lower.includes('block range') ||
          lower.includes('free tier') ||
          lower.includes('too large')
        ) {
          this.commitLogChunkSize = 9n; // inclusive range of 10 blocks
          if (this.lastScannedCommitBlock === null && safeToBlock > 10n) {
            this.lastScannedCommitBlock = safeToBlock - 10n;
          }
        }
        this.log('warn', 'commit_log_scan_failed', {
          error: maskRpcUrl(msg),
          nextChunkSize: Number(this.commitLogChunkSize + 1n),
        });
      }
    }

    // Refresh live status of tracked pending commitments
    for (const [key, item] of this.trackedCommits.entries()) {
      if (item.revealed || item.slashed) continue;
      try {
        const onchain = (await this.publicClient.readContract({
          address: this.config.fairBatch,
          abi: fairBatchAbi,
          functionName: 'getCommitment',
          args: [item.batchId, item.commitId],
        })) as { revealed: boolean; slashed: boolean; bond: bigint };
        item.revealed = onchain.revealed;
        item.slashed = onchain.slashed;
        item.bondWei = onchain.bond;
        if (item.revealed || item.slashed) {
          this.trackedCommits.set(key, item);
        }
      } catch {
        // ignore transient read failure
      }
    }
  }

  public async tick(): Promise<void> {
    if (this.stopping || this.tickInFlight) return;
    this.tickInFlight = true;

    try {
      const [block, rawBatch, balanceWei, nonces] = await this.withRetry('poll_state', async () => {
        const [blk, b, bal, n] = await Promise.all([
          this.publicClient.getBlock({ blockTag: 'latest' }),
          this.publicClient.readContract({
            address: this.config.fairBatch,
            abi: fairBatchAbi,
            functionName: 'currentBatch',
          }) as Promise<BatchSnapshot>,
          this.accountAddress
            ? this.publicClient.getBalance({ address: this.accountAddress })
            : Promise.resolve(this.config.minBalanceWei),
          this.accountAddress && !this.config.dryRun
            ? this.fetchWalletNonces()
            : Promise.resolve({ latestNonce: 0, pendingNonce: 0 }),
        ]);
        return [blk, b, bal, n] as const;
      });

      this.consecutiveRpcErrors = 0;
      const previousBatch = this.lastBatch;
      this.lastBatch = rawBatch;
      this.lastBalanceWei = balanceWei;

      // Reconcile any pending tx FIRST — never submit another tx while one is pending!
      const pendingBlocked = await this.reconcilePendingTx(
        block,
        rawBatch,
        nonces.latestNonce,
        nonces.pendingNonce,
      );

      if (
        previousBatch &&
        rawBatch.batchId > previousBatch.batchId &&
        this.lastSettledBySelfBatchId !== previousBatch.batchId
      ) {
        this.log('info', 'skipped_public_settled', {
          batchId: Number(previousBatch.batchId),
          newBatchId: Number(rawBatch.batchId),
          previousOrderCount: Number(previousBatch.orderCount),
          reason: 'settled_by_public',
        });
        this.recordAction(`skipped_public_settled_batch_${previousBatch.batchId.toString()}`);
      }

      if (pendingBlocked) {
        return;
      }

      const blockTimestamp = block.timestamp;
      const nowMs = Date.now();
      const txBlocked = this.isTxBusy();

      const decision = decideSettlementAction({
        batch: rawBatch,
        blockTimestamp,
        balanceWei,
        minBalanceWei: this.config.minBalanceWei,
        graceSeconds: this.config.graceSeconds,
        emptyRoundMinutes: this.config.emptyRoundMinutes,
        lastEmptySettleAtMs: this.lastEmptySettleAtMs,
        nowMs,
        txInFlight: txBlocked,
      });

      if (decision.action === 'skip' && decision.reason === 'low_balance') {
        if (nowMs - this.lastLowBalanceLogAtMs > 30_000) {
          this.lastLowBalanceLogAtMs = nowMs;
          this.log('error', 'low_balance_guard_triggered', {
            keeperAddress: this.accountAddress,
            balanceEth: formatEther(balanceWei),
            minBalanceEth: formatEther(this.config.minBalanceWei),
            batchId: Number(decision.batchId),
          });
        }
        this.recordAction('skipped_low_balance');
        return;
      }

      if (decision.action === 'wait_grace') {
        this.log('info', 'waiting_public_grace', {
          batchId: Number(decision.batchId),
          waitSeconds: decision.waitSeconds,
          orderCount: Number(rawBatch.orderCount),
          commitCount: Number(rawBatch.commitCount),
          empty: decision.empty,
        });
        this.recordAction(`waiting_grace_batch_${decision.batchId.toString()}`);
        return;
      }

      if (decision.action === 'settle') {
        await this.executeSettlement(decision.batchId, decision.empty, block.baseFeePerGas);
        return;
      }

      // Check for expired unrevealed commitments to slash (after 60s grace)
      await this.refreshCommitments(block.number, rawBatch);
      const slashDecision = decideSlashAction({
        commitments: Array.from(this.trackedCommits.values()),
        blockTimestamp,
        balanceWei,
        minBalanceWei: this.config.minBalanceWei,
        slashEnabled: this.config.slashEnabled,
        slashGraceSeconds: this.config.slashGraceSeconds,
        txInFlight: this.isTxBusy(),
      });

      if (slashDecision.action === 'slash') {
        await this.executeSlash(
          slashDecision.batchId,
          slashDecision.commitId,
          slashDecision.bondWei,
          block.baseFeePerGas,
        );
      }
    } catch (err) {
      this.consecutiveRpcErrors += 1;
      this.log('error', 'poll_tick_error', {
        consecutiveRpcErrors: this.consecutiveRpcErrors,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.tickInFlight = false;
    }
  }

  private async executeSettlement(
    batchId: bigint,
    empty: boolean,
    baseFeePerGas?: bigint | null,
  ): Promise<void> {
    if (this.config.dryRun) {
      this.log('info', 'dry_run_would_settle', {
        batchId: Number(batchId),
        empty,
        fairBatch: this.config.fairBatch,
      });
      if (empty) this.lastEmptySettleAtMs = Date.now();
      this.recordAction(`dry_run_settle_batch_${batchId.toString()}`);
      return;
    }

    if (!this.walletClient || !this.accountAddress) return;

    await this.withTxLock('settleBatch', async () => {
      const nonce = await this.acquireCleanNonce('settleBatch');
      if (nonce === null) {
        this.recordAction('skipped_pending_tx');
        return;
      }

      // Re-check currentBatch() right before simulating so public settles are respected quietly
      const fresh = (await this.publicClient.readContract({
        address: this.config.fairBatch,
        abi: fairBatchAbi,
        functionName: 'currentBatch',
      })) as BatchSnapshot;

      if (fresh.batchId !== batchId || fresh.phase === 3) {
        this.log('info', 'skipped_public_settled', {
          expectedBatchId: Number(batchId),
          currentBatchId: Number(fresh.batchId),
          currentPhase: fresh.phase,
        });
        this.recordAction(`skipped_public_settled_batch_${batchId.toString()}`);
        return;
      }

      // Simulate settleBatch via eth_call before spending gas
      let estimatedGas: bigint;
      try {
        await this.publicClient.simulateContract({
          address: this.config.fairBatch,
          abi: fairBatchAbi,
          functionName: 'settleBatch',
          account: this.accountAddress!,
        });
        estimatedGas = await this.publicClient.estimateContractGas({
          address: this.config.fairBatch,
          abi: fairBatchAbi,
          functionName: 'settleBatch',
          account: this.accountAddress!,
        });
      } catch (err) {
        if (isAlreadySettledError(err)) {
          this.log('info', 'skipped_public_settled_race', {
            batchId: Number(batchId),
          });
          this.recordAction(`skipped_public_settled_batch_${batchId.toString()}`);
          return;
        }
        throw err;
      }

      const paddedGas = (estimatedGas * 120n) / 100n + 100_000n;
      const gas = paddedGas > this.config.settleGasLimit ? this.config.settleGasLimit : paddedGas;
      const fees = await this.checkGasPrice(baseFeePerGas);
      if (!fees) {
        this.recordAction('skipped_gas_price_cap');
        return;
      }

      this.log('info', 'sending_settle_batch', {
        batchId: Number(batchId),
        empty,
        nonce,
        gas: gas.toString(),
        maxFeePerGas: fees.maxFeePerGas.toString(),
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas.toString(),
      });

      let hash: Hash;
      try {
        hash = await this.walletClient!.writeContract({
          address: this.config.fairBatch,
          abi: fairBatchAbi,
          functionName: 'settleBatch',
          args: [],
          nonce,
          gas,
          maxFeePerGas: fees.maxFeePerGas,
          maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        });
      } catch (err) {
        if (isAlreadySettledError(err)) {
          this.log('info', 'skipped_public_settled_race', { batchId: Number(batchId) });
          this.recordAction(`skipped_public_settled_batch_${batchId.toString()}`);
          return;
        }
        throw err;
      }

      this.pendingTx = {
        nonce,
        hash,
        hashes: [hash],
        kind: 'settle',
        batchId,
        empty,
        gas,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        sentAtMs: Date.now(),
        lastBumpedAtMs: Date.now(),
        attempts: 1,
      };

      try {
        const receipt = await this.publicClient.waitForTransactionReceipt({
          hash,
          confirmations: 1,
          timeout: this.txConfirmTimeoutMs,
        });

        this.pendingTx = null;
        if (empty) this.lastEmptySettleAtMs = Date.now();
        this.lastSettledBySelfBatchId = batchId;
        this.recordAction(`settled_batch_${batchId.toString()}`, hash);
        this.log('info', 'batch_settled', {
          batchId: Number(batchId),
          empty,
          txHash: hash,
          blockNumber: Number(receipt.blockNumber),
          gasUsed: receipt.gasUsed.toString(),
          status: receipt.status,
        });
      } catch (err) {
        if (isReceiptTimeoutError(err)) {
          this.recordAction(`pending_settle_batch_${batchId.toString()}`, hash);
          this.log('warn', 'tx_confirmation_timeout', {
            kind: 'settle',
            batchId: Number(batchId),
            nonce,
            txHash: hash,
            maxFeePerGas: fees.maxFeePerGas.toString(),
            maxPriorityFeePerGas: fees.maxPriorityFeePerGas.toString(),
          });
          return;
        }
        // Keep pendingTx tracked so no subsequent tx opens a second nonce before confirmation
        this.log('warn', 'pending_tx_receipt_poll_failed', {
          kind: 'settle',
          batchId: Number(batchId),
          nonce,
          txHash: hash,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });
  }

  private async executeSlash(
    batchId: bigint,
    commitId: bigint,
    bondWei: bigint,
    baseFeePerGas?: bigint | null,
  ): Promise<void> {
    if (this.config.dryRun) {
      this.log('info', 'dry_run_would_slash', {
        batchId: Number(batchId),
        commitId: Number(commitId),
        bondEth: formatEther(bondWei),
      });
      this.recordAction(`dry_run_slash_${batchId.toString()}_${commitId.toString()}`);
      return;
    }

    if (!this.walletClient || !this.accountAddress) return;

    await this.withTxLock('slashUnrevealed', async () => {
      const nonce = await this.acquireCleanNonce('slashUnrevealed');
      if (nonce === null) {
        this.recordAction('skipped_pending_tx');
        return;
      }

      try {
        await this.publicClient.simulateContract({
          address: this.config.fairBatch,
          abi: fairBatchAbi,
          functionName: 'slashUnrevealed',
          args: [batchId, commitId],
          account: this.accountAddress!,
        });
      } catch (err) {
        if (isAlreadySlashedError(err)) {
          const key = `${batchId.toString()}:${commitId.toString()}`;
          const existing = this.trackedCommits.get(key);
          if (existing) existing.slashed = true;
          this.log('info', 'skipped_already_slashed', {
            batchId: Number(batchId),
            commitId: Number(commitId),
          });
          return;
        }
        throw err;
      }

      const fees = await this.checkGasPrice(baseFeePerGas);
      if (!fees) return;

      const hash = await this.walletClient!.writeContract({
        address: this.config.fairBatch,
        abi: fairBatchAbi,
        functionName: 'slashUnrevealed',
        args: [batchId, commitId],
        nonce,
        gas: this.config.slashGasLimit,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      });

      this.pendingTx = {
        nonce,
        hash,
        hashes: [hash],
        kind: 'slash',
        batchId,
        commitId,
        bondWei,
        gas: this.config.slashGasLimit,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        sentAtMs: Date.now(),
        lastBumpedAtMs: Date.now(),
        attempts: 1,
      };

      try {
        const receipt = await this.publicClient.waitForTransactionReceipt({
          hash,
          confirmations: 1,
          timeout: this.txConfirmTimeoutMs,
        });

        this.pendingTx = null;
        const key = `${batchId.toString()}:${commitId.toString()}`;
        const existing = this.trackedCommits.get(key);
        if (existing) existing.slashed = true;
        this.recordAction(`slashed_${batchId.toString()}_${commitId.toString()}`, hash);
        this.log('info', 'commitment_slashed', {
          batchId: Number(batchId),
          commitId: Number(commitId),
          bountyEth: formatEther(bondWei),
          txHash: hash,
          gasUsed: receipt.gasUsed.toString(),
        });
      } catch (err) {
        if (isReceiptTimeoutError(err)) {
          this.recordAction(`pending_slash_${batchId.toString()}_${commitId.toString()}`, hash);
          this.log('warn', 'tx_confirmation_timeout', {
            kind: 'slash',
            batchId: Number(batchId),
            commitId: Number(commitId),
            nonce,
            txHash: hash,
            maxFeePerGas: fees.maxFeePerGas.toString(),
          });
          return;
        }
        this.log('warn', 'pending_tx_receipt_poll_failed', {
          kind: 'slash',
          batchId: Number(batchId),
          commitId: Number(commitId),
          nonce,
          txHash: hash,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });
  }

  private applyCors(req: http.IncomingMessage, res: http.ServerResponse): void {
    const origin = req.headers.origin;
    if (!origin) return;
    if (this.config.corsOrigins.includes('*') || this.config.corsOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    }
  }

  public async startHttpServer(): Promise<number> {
    if (this.server) return this.config.port;

    this.server = http.createServer(async (req, res) => {
      this.applyCors(req, res);
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      const urlPath = (req.url ?? '/').split('?')[0];
      if (req.method === 'GET' && urlPath === '/health') {
        const body = JSON.stringify(this.getHealth());
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(body);
        return;
      }

      for (const handler of this.extraHttpHandlers) {
        const handled = await handler(req, res);
        if (handled) return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.config.port, this.config.host, () => resolve());
    });

    const address = this.server.address();
    const boundPort = typeof address === 'object' && address ? address.port : this.config.port;
    this.log('info', 'http_server_started', {
      host: this.config.host,
      port: boundPort,
      mode: this.config.dryRun ? 'dry_run' : 'live',
      keeperAddress: this.accountAddress,
    });
    return boundPort;
  }

  private scheduleNextTick(): void {
    if (this.stopping) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick().finally(() => {
        this.scheduleNextTick();
      });
    }, this.config.pollMs);
  }

  public async start(): Promise<void> {
    await this.startHttpServer();
    await this.tick();
    this.scheduleNextTick();
  }

  public async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.server) {
      const srv = this.server;
      this.server = null;
      await new Promise<void>((resolve) => {
        srv.close(() => resolve());
        srv.closeAllConnections?.();
      });
    }
    this.log('info', 'keeper_stopped', { lastAction: this.lastAction });
  }
}
