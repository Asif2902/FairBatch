import http from 'node:http';
import {
  createPublicClient,
  createWalletClient,
  fallback,
  formatEther,
  http as viemHttp,
  type Address,
  type Hash,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { fairBatchAbi, fairBatchEvents } from './abi.js';
import type { KeeperConfig } from './config.js';
import {
  decideSettlementAction,
  decideSlashAction,
  isAlreadySettledError,
  isAlreadySlashedError,
  type BatchSnapshot,
  type PendingCommitment,
} from './decision.js';

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
  const entry = {
    ts: new Date().toISOString(),
    level,
    event,
    ...fields,
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

export class FairBatchKeeper {
  private readonly config: KeeperConfig;
  private readonly log: LogFn;
  private readonly startedAtMs = Date.now();
  private readonly publicClient;
  private readonly walletClient;
  private readonly accountAddress: Address | null;

  private timer: NodeJS.Timeout | null = null;
  private server: http.Server | null = null;
  private stopping = false;
  private txInFlight = false;
  private txTail: Promise<void> = Promise.resolve();

  private lastBalanceWei = 0n;
  private lastLowBalanceLogAtMs = 0;
  private lastEmptySettleAtMs: number | null = null;
  private lastBatch: BatchSnapshot | null = null;
  private lastSettledBySelfBatchId: bigint | null = null;
  private lastAction = 'initialized';
  private lastActionAt: string | null = null;
  private lastTxHash: Hash | null = null;
  private lastScannedCommitBlock: bigint | null = null;
  private trackedCommits = new Map<string, PendingCommitment>();
  private batchDeadlines = new Map<string, bigint>();
  private consecutiveRpcErrors = 0;
  private extraHttpHandlers: ExtraHttpHandler[] = [];
  private healthAugmenters: Array<() => Record<string, unknown>> = [];

  constructor(config: KeeperConfig, log: LogFn = structuredLog) {
    this.config = config;
    this.log = log;

    const transports = config.rpcUrls.map((url) =>
      viemHttp(url, { timeout: 15_000, retryCount: 1, retryDelay: 500 }),
    );
    const transport = transports.length === 1 ? transports[0] : fallback(transports, { rank: false });

    const chain = {
      ...sepolia,
      id: config.chainId,
      rpcUrls: { default: { http: config.rpcUrls } },
    };

    this.publicClient = createPublicClient({ chain, transport });

    if (config.privateKey) {
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

  public async checkGasPrice(): Promise<{
    maxFeePerGas: bigint;
    maxPriorityFeePerGas: bigint;
  } | null> {
    const fees = await this.publicClient.estimateFeesPerGas();
    const maxFee = fees.maxFeePerGas ?? fees.gasPrice ?? 0n;
    const priority = fees.maxPriorityFeePerGas ?? 1_000_000n;
    if (maxFee > this.config.maxGasPriceWei) {
      this.log('warn', 'gas_price_cap_exceeded', {
        maxFeePerGas: maxFee.toString(),
        capWei: this.config.maxGasPriceWei.toString(),
      });
      return null;
    }
    return { maxFeePerGas: maxFee, maxPriorityFeePerGas: priority };
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

    const fromBlock =
      this.lastScannedCommitBlock !== null
        ? this.lastScannedCommitBlock + 1n
        : latestBlockNumber > 5_000n
          ? latestBlockNumber - 5_000n
          : this.config.deploymentBlock;

    if (fromBlock <= latestBlockNumber) {
      try {
        const logs = await this.publicClient.getLogs({
          address: this.config.fairBatch,
          event: fairBatchEvents[0], // OrderCommitted
          fromBlock,
          toBlock: latestBlockNumber,
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
        this.lastScannedCommitBlock = latestBlockNumber;
      } catch (err) {
        this.log('warn', 'commit_log_scan_failed', {
          error: err instanceof Error ? err.message : String(err),
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
    if (this.stopping) return;

    try {
      const [block, rawBatch, balanceWei] = await this.withRetry('poll_state', async () => {
        const [blk, b, bal] = await Promise.all([
          this.publicClient.getBlock({ blockTag: 'latest' }),
          this.publicClient.readContract({
            address: this.config.fairBatch,
            abi: fairBatchAbi,
            functionName: 'currentBatch',
          }) as Promise<BatchSnapshot>,
          this.accountAddress
            ? this.publicClient.getBalance({ address: this.accountAddress })
            : Promise.resolve(this.config.minBalanceWei),
        ]);
        return [blk, b, bal] as const;
      });

      this.consecutiveRpcErrors = 0;
      const previousBatch = this.lastBatch;
      this.lastBatch = rawBatch;
      this.lastBalanceWei = balanceWei;

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

      const blockTimestamp = block.timestamp;
      const nowMs = Date.now();

      const decision = decideSettlementAction({
        batch: rawBatch,
        blockTimestamp,
        balanceWei,
        minBalanceWei: this.config.minBalanceWei,
        graceSeconds: this.config.graceSeconds,
        emptyRoundMinutes: this.config.emptyRoundMinutes,
        lastEmptySettleAtMs: this.lastEmptySettleAtMs,
        nowMs,
        txInFlight: this.txInFlight,
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
        await this.executeSettlement(decision.batchId, decision.empty);
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
        txInFlight: this.txInFlight,
      });

      if (slashDecision.action === 'slash') {
        await this.executeSlash(slashDecision.batchId, slashDecision.commitId, slashDecision.bondWei);
      }
    } catch (err) {
      this.consecutiveRpcErrors += 1;
      this.log('error', 'poll_tick_error', {
        consecutiveRpcErrors: this.consecutiveRpcErrors,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async executeSettlement(batchId: bigint, empty: boolean): Promise<void> {
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
      const fees = await this.checkGasPrice();
      if (!fees) {
        this.recordAction('skipped_gas_price_cap');
        return;
      }

      const nonce = await this.publicClient.getTransactionCount({
        address: this.accountAddress!,
        blockTag: 'pending',
      });

      this.log('info', 'sending_settle_batch', {
        batchId: Number(batchId),
        empty,
        nonce,
        gas: gas.toString(),
        maxFeePerGas: fees.maxFeePerGas.toString(),
      });

      try {
        const hash = await this.walletClient!.writeContract({
          address: this.config.fairBatch,
          abi: fairBatchAbi,
          functionName: 'settleBatch',
          args: [],
          nonce,
          gas,
          maxFeePerGas: fees.maxFeePerGas,
          maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        });

        const receipt = await this.publicClient.waitForTransactionReceipt({
          hash,
          confirmations: 1,
          timeout: 120_000,
        });

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
        if (isAlreadySettledError(err)) {
          this.log('info', 'skipped_public_settled_race', { batchId: Number(batchId) });
          this.recordAction(`skipped_public_settled_batch_${batchId.toString()}`);
          return;
        }
        throw err;
      }
    });
  }

  private async executeSlash(batchId: bigint, commitId: bigint, bondWei: bigint): Promise<void> {
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

      const fees = await this.checkGasPrice();
      if (!fees) return;

      const nonce = await this.publicClient.getTransactionCount({
        address: this.accountAddress!,
        blockTag: 'pending',
      });

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

      const receipt = await this.publicClient.waitForTransactionReceipt({
        hash,
        confirmations: 1,
        timeout: 120_000,
      });

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

  public async start(): Promise<void> {
    await this.startHttpServer();
    await this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, this.config.pollMs);
  }

  public async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) {
      clearInterval(this.timer);
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
