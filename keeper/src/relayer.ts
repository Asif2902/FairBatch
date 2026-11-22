import type http from 'node:http';
import {
  getAddress,
  isAddress,
  parseEventLogs,
  recoverTypedDataAddress,
  type Address,
  type Hash,
  type Hex,
} from 'viem';
import { erc20Abi, fairBatchAbi, fairBatchEvents } from './abi.js';
import type { KeeperConfig } from './config.js';
import type { BatchSnapshot } from './decision.js';
import type { FairBatchKeeper, LogFn } from './service.js';

export interface SignedOrderStruct {
  trader: Address;
  side: number; // 0 = SellBase, 1 = BuyBase
  amountIn: bigint;
  limitPrice: bigint;
  batchId: bigint;
  nonce: bigint;
  deadline: bigint;
}

export interface RelayIntentPayload {
  order: SignedOrderStruct;
  signature: Hex;
}

export interface RelayValidationError {
  status: number;
  code: string;
  error: string;
}

export interface RelaySuccessResponse {
  status: 'submitted' | 'already_submitted' | 'dry_run';
  relayed: boolean;
  batchId: number;
  nonce: number;
  txHash?: Hash;
  orderId?: number;
  blockNumber?: number;
  gasUsed?: string;
}

export interface RelayChainAdapter {
  getLatestTimestamp(): Promise<bigint>;
  getCurrentBatch(): Promise<BatchSnapshot>;
  getNonce(trader: Address): Promise<bigint>;
  getTokenBalance(token: Address, owner: Address): Promise<bigint>;
  getTokenAllowance(token: Address, owner: Address, spender: Address): Promise<bigint>;
  getCode(address: Address): Promise<Hex | undefined>;
  isLowBalance(): boolean;
  simulateSubmitIntent(order: SignedOrderStruct, signature: Hex): Promise<void>;
  estimateSubmitIntentGas(order: SignedOrderStruct, signature: Hex): Promise<bigint>;
  checkGasPrice(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } | null>;
  submitIntentTx(
    order: SignedOrderStruct,
    signature: Hex,
    gas: bigint,
    fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint },
  ): Promise<{ txHash: Hash; orderId: number; blockNumber: number; gasUsed: string }>;
  withTxLock<T>(label: string, fn: () => Promise<T>): Promise<T>;
}

export const SIGNED_ORDER_TYPES = {
  SignedOrder: [
    { name: 'trader', type: 'address' },
    { name: 'side', type: 'uint8' },
    { name: 'amountIn', type: 'uint256' },
    { name: 'limitPrice', type: 'uint256' },
    { name: 'batchId', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const;

export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  public allow(key: string, nowMs = Date.now()): boolean {
    const cutoff = nowMs - this.windowMs;
    const prev = this.hits.get(key) ?? [];
    const recent = prev.filter((ts) => ts > cutoff);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(nowMs);
    this.hits.set(key, recent);
    // Prune stale keys opportunistically to keep memory bounded
    if (this.hits.size > 2_000) {
      for (const [k, list] of this.hits.entries()) {
        if (list.length === 0 || list[list.length - 1] <= cutoff) {
          this.hits.delete(k);
        }
      }
    }
    return true;
  }
}

function parseUnsignedBigInt(value: unknown, field: string): bigint {
  if (typeof value === 'bigint') {
    if (value < 0n) throw new Error(`${field} must be non-negative.`);
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`${field} must be a non-negative integer.`);
    }
    return BigInt(value);
  }
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    return BigInt(value.trim());
  }
  throw new Error(`${field} must be a non-negative integer string.`);
}

export function parseRelayRequest(raw: unknown): RelayIntentPayload {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Request body must be a JSON object.');
  }
  const obj = raw as Record<string, unknown>;
  const rawOrder = obj.order;
  if (!rawOrder || typeof rawOrder !== 'object') {
    throw new Error('Missing "order" object.');
  }
  const o = rawOrder as Record<string, unknown>;
  if (typeof o.trader !== 'string' || !isAddress(o.trader)) {
    throw new Error('order.trader must be a valid EVM address.');
  }
  const sideNum = Number(o.side);
  if (sideNum !== 0 && sideNum !== 1) {
    throw new Error('order.side must be 0 (SellBase) or 1 (BuyBase).');
  }
  const amountIn = parseUnsignedBigInt(o.amountIn, 'order.amountIn');
  if (amountIn <= 0n) {
    throw new Error('order.amountIn must be greater than zero.');
  }
  const limitPrice = parseUnsignedBigInt(o.limitPrice, 'order.limitPrice');
  if (sideNum === 1 && limitPrice <= 0n) {
    throw new Error('order.limitPrice must be greater than zero for BuyBase orders.');
  }
  const batchId = parseUnsignedBigInt(o.batchId, 'order.batchId');
  const nonce = parseUnsignedBigInt(o.nonce, 'order.nonce');
  const deadline = parseUnsignedBigInt(o.deadline, 'order.deadline');
  if (deadline <= 0n) {
    throw new Error('order.deadline must be greater than zero.');
  }

  if (typeof obj.signature !== 'string' || !/^0x[0-9a-fA-F]{130,}$/.test(obj.signature)) {
    throw new Error('signature must be a valid hex string (>= 65 bytes).');
  }

  return {
    order: {
      trader: getAddress(o.trader),
      side: sideNum,
      amountIn,
      limitPrice,
      batchId,
      nonce,
      deadline,
    },
    signature: obj.signature as Hex,
  };
}

export function createKeeperRelayAdapter(keeper: FairBatchKeeper): RelayChainAdapter {
  const config = keeper.getConfig();
  const publicClient = keeper.getPublicClient();

  return {
    async getLatestTimestamp() {
      const blk = await publicClient.getBlock({ blockTag: 'latest' });
      return blk.timestamp;
    },
    async getCurrentBatch() {
      return (await publicClient.readContract({
        address: config.fairBatch,
        abi: fairBatchAbi,
        functionName: 'currentBatch',
      })) as BatchSnapshot;
    },
    async getNonce(trader) {
      return (await publicClient.readContract({
        address: config.fairBatch,
        abi: fairBatchAbi,
        functionName: 'getNonce',
        args: [trader],
      })) as bigint;
    },
    async getTokenBalance(token, owner) {
      return (await publicClient.readContract({
        address: token,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [owner],
      })) as bigint;
    },
    async getTokenAllowance(token, owner, spender) {
      return (await publicClient.readContract({
        address: token,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [owner, spender],
      })) as bigint;
    },
    async getCode(address) {
      return publicClient.getCode({ address });
    },
    isLowBalance() {
      return keeper.isLowBalance();
    },
    async simulateSubmitIntent(order, signature) {
      const account = keeper.getKeeperAddress() ?? order.trader;
      await publicClient.simulateContract({
        address: config.fairBatch,
        abi: fairBatchAbi,
        functionName: 'submitSignedIntent',
        args: [order, signature],
        account,
      });
    },
    async estimateSubmitIntentGas(order, signature) {
      const account = keeper.getKeeperAddress() ?? order.trader;
      return publicClient.estimateContractGas({
        address: config.fairBatch,
        abi: fairBatchAbi,
        functionName: 'submitSignedIntent',
        args: [order, signature],
        account,
      });
    },
    checkGasPrice() {
      return keeper.checkGasPrice();
    },
    async submitIntentTx(order, signature, gas, fees) {
      const walletClient = keeper.getWalletClient();
      const keeperAddress = keeper.getKeeperAddress();
      if (!walletClient || !keeperAddress) {
        throw new Error('Relayer wallet is not configured.');
      }
      const nonce = await publicClient.getTransactionCount({
        address: keeperAddress,
        blockTag: 'pending',
      });
      const txHash = await walletClient.writeContract({
        address: config.fairBatch,
        abi: fairBatchAbi,
        functionName: 'submitSignedIntent',
        args: [order, signature],
        nonce,
        gas,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      });
      const receipt = await publicClient.waitForTransactionReceipt({
        hash: txHash,
        confirmations: 1,
        timeout: 120_000,
      });
      if (receipt.status !== 'success') {
        throw new Error(`Relayed transaction reverted on-chain (${txHash}).`);
      }
      let orderId = -1;
      try {
        const parsed = parseEventLogs({
          abi: fairBatchEvents,
          logs: receipt.logs,
          eventName: 'OrderSubmitted',
        }) as unknown as Array<{ args: { orderId?: bigint } }>;
        if (parsed[0]?.args.orderId !== undefined) {
          orderId = Number(parsed[0].args.orderId);
        }
      } catch {
        // leave -1 if event decoding skipped
      }
      return {
        txHash,
        orderId,
        blockNumber: Number(receipt.blockNumber),
        gasUsed: receipt.gasUsed.toString(),
      };
    },
    withTxLock(label, fn) {
      return keeper.withTxLock(label, fn);
    },
  };
}

export class IntentRelayer {
  private readonly ipLimiter: SlidingWindowLimiter;
  private readonly traderLimiter: SlidingWindowLimiter;
  private readonly inflightKeys = new Set<string>();
  private readonly sleepFn: (ms: number) => Promise<void>;

  constructor(
    private readonly config: KeeperConfig,
    private readonly adapter: RelayChainAdapter,
    private readonly log: LogFn,
    sleepFn: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {
    this.ipLimiter = new SlidingWindowLimiter(
      config.relayRateLimitPerIp,
      config.relayRateWindowMs,
    );
    this.traderLimiter = new SlidingWindowLimiter(
      config.relayRateLimitPerTrader,
      config.relayRateWindowMs,
    );
    this.sleepFn = sleepFn;
  }

  public getHealthFields(): Record<string, unknown> {
    return {
      relayerEnabled: this.config.relayerEnabled,
      relayGraceSeconds: this.config.relayGraceSeconds,
      relayQueueSize: this.inflightKeys.size,
      relayMaxQueue: this.config.relayMaxQueue,
    };
  }

  public async validatePayload(payload: RelayIntentPayload): Promise<RelayValidationError | null> {
    if (!this.config.relayerEnabled) {
      return {
        status: 503,
        code: 'relayer_disabled',
        error: 'Intent relayer is disabled on this server. Click "Submit it myself" to send directly.',
      };
    }

    if (this.adapter.isLowBalance()) {
      return {
        status: 503,
        code: 'low_balance',
        error: 'Relayer wallet ETH balance is below the safety minimum. Click "Submit it myself" instead.',
      };
    }

    const { order, signature } = payload;

    // 1. Verify EIP-712 signer matches order.trader (or ERC-1271 smart wallet bytecode is present)
    let eoaMatches = false;
    try {
      const recovered = await recoverTypedDataAddress({
        domain: {
          name: 'FairBatch',
          version: '1',
          chainId: this.config.chainId,
          verifyingContract: this.config.fairBatch,
        },
        types: SIGNED_ORDER_TYPES,
        primaryType: 'SignedOrder',
        message: order,
        signature,
      });
      eoaMatches = getAddress(recovered) === order.trader;
    } catch {
      eoaMatches = false;
    }

    if (!eoaMatches) {
      const code = await this.adapter.getCode(order.trader);
      const isContractWallet = Boolean(code && code !== '0x');
      if (!isContractWallet) {
        return {
          status: 400,
          code: 'invalid_signature',
          error: 'Invalid EIP-712 signature: recovered signer does not match order.trader.',
        };
      }
    }

    // 2. Fetch live chain state in parallel
    const inputToken = order.side === 0 ? this.config.baseToken : this.config.quoteToken;
    const [blockTimestamp, batch, onchainNonce, balance, allowance] = await Promise.all([
      this.adapter.getLatestTimestamp(),
      this.adapter.getCurrentBatch(),
      this.adapter.getNonce(order.trader),
      this.adapter.getTokenBalance(inputToken, order.trader),
      this.adapter.getTokenAllowance(inputToken, order.trader, this.config.fairBatch),
    ]);

    // 3. Batch ID & active phase check
    if (order.batchId !== batch.batchId) {
      return {
        status: 400,
        code: 'wrong_batch',
        error: `Batch mismatch: intent targets batch #${order.batchId}, but active batch is #${batch.batchId}.`,
      };
    }

    const intentWindowOpen = batch.phase !== 3 && blockTimestamp <= batch.revealDeadline;
    if (!intentWindowOpen) {
      return {
        status: 400,
        code: 'window_closed',
        error: 'The intent window is closed for this batch. Wait for the next round.',
      };
    }

    // 4. Deadline expiry & buffer check
    const minDeadline = blockTimestamp + BigInt(this.config.relayDeadlineBufferSeconds);
    if (order.deadline < minDeadline) {
      return {
        status: 400,
        code: 'deadline_expired',
        error: `Order deadline is expired or within ${this.config.relayDeadlineBufferSeconds}s of expiry.`,
      };
    }

    // 5. Sequential nonce check
    if (order.nonce !== onchainNonce) {
      return {
        status: 400,
        code: 'invalid_nonce',
        error: `Nonce mismatch: expected ${onchainNonce}, received ${order.nonce}.`,
      };
    }

    // 6. Balance & allowance checks
    if (balance < order.amountIn) {
      return {
        status: 400,
        code: 'insufficient_balance',
        error: 'Insufficient input token balance for this signed order.',
      };
    }
    if (allowance < order.amountIn) {
      return {
        status: 400,
        code: 'insufficient_allowance',
        error: 'Insufficient token allowance for FairBatch. Approve the token first.',
      };
    }

    // 7. Full eth_call simulation before queuing or spending gas
    try {
      await this.adapter.simulateSubmitIntent(order, signature);
    } catch (err) {
      return {
        status: 400,
        code: 'simulation_reverted',
        error: `Contract simulation reverted: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    return null;
  }

  public async relay(
    rawBody: unknown,
    clientIp: string,
  ): Promise<{ status: number; body: RelaySuccessResponse | RelayValidationError }> {
    if (!this.ipLimiter.allow(clientIp)) {
      return {
        status: 429,
        body: {
          status: 429,
          code: 'rate_limit_ip',
          error: 'Too many relay requests from this IP. Retry shortly or click "Submit it myself".',
        },
      };
    }

    let payload: RelayIntentPayload;
    try {
      payload = parseRelayRequest(rawBody);
    } catch (err) {
      return {
        status: 400,
        body: {
          status: 400,
          code: 'invalid_payload',
          error: err instanceof Error ? err.message : 'Invalid JSON payload.',
        },
      };
    }

    if (!this.traderLimiter.allow(payload.order.trader)) {
      return {
        status: 429,
        body: {
          status: 429,
          code: 'rate_limit_trader',
          error: 'Too many relay requests for this wallet. Retry shortly or click "Submit it myself".',
        },
      };
    }

    const dedupeKey = `${payload.order.trader}:${payload.order.nonce.toString()}`;
    if (this.inflightKeys.has(dedupeKey)) {
      return {
        status: 409,
        body: {
          status: 409,
          code: 'already_in_flight',
          error: 'This signed order is already queued for relay.',
        },
      };
    }

    if (this.inflightKeys.size >= this.config.relayMaxQueue) {
      return {
        status: 429,
        body: {
          status: 429,
          code: 'queue_full',
          error: 'Relayer queue is full. Please retry shortly or click "Submit it myself".',
        },
      };
    }

    this.inflightKeys.add(dedupeKey);
    try {
      const validationErr = await this.validatePayload(payload);
      if (validationErr) {
        this.log('warn', 'relay_rejected', {
          trader: payload.order.trader,
          batchId: Number(payload.order.batchId),
          nonce: Number(payload.order.nonce),
          code: validationErr.code,
        });
        return { status: validationErr.status, body: validationErr };
      }

      if (this.config.dryRun) {
        this.log('info', 'relay_dry_run_accepted', {
          trader: payload.order.trader,
          batchId: Number(payload.order.batchId),
          nonce: Number(payload.order.nonce),
        });
        return {
          status: 200,
          body: {
            status: 'dry_run',
            relayed: false,
            batchId: Number(payload.order.batchId),
            nonce: Number(payload.order.nonce),
          },
        };
      }

      // Wait grace period so third-party relayers or user self-submission can land first
      if (this.config.relayGraceSeconds > 0) {
        this.log('info', 'relay_waiting_grace', {
          trader: payload.order.trader,
          batchId: Number(payload.order.batchId),
          nonce: Number(payload.order.nonce),
          graceSeconds: this.config.relayGraceSeconds,
        });
        await this.sleepFn(this.config.relayGraceSeconds * 1_000);
      }

      // Re-check nonce after grace: if already incremented, skip silently without spending gas
      const freshNonce = await this.adapter.getNonce(payload.order.trader);
      if (freshNonce > payload.order.nonce) {
        this.log('info', 'relay_skipped_already_submitted', {
          trader: payload.order.trader,
          batchId: Number(payload.order.batchId),
          nonce: Number(payload.order.nonce),
          onchainNonce: Number(freshNonce),
        });
        return {
          status: 200,
          body: {
            status: 'already_submitted',
            relayed: false,
            batchId: Number(payload.order.batchId),
            nonce: Number(payload.order.nonce),
          },
        };
      }

      return await this.adapter.withTxLock('submitSignedIntent', async () => {
        // Re-check nonce & low-balance right before broadcast
        if (this.adapter.isLowBalance()) {
          const err: RelayValidationError = {
            status: 503,
            code: 'low_balance',
            error: 'Relayer ETH balance dropped below safety minimum. Click "Submit it myself".',
          };
          return { status: 503, body: err };
        }
        const nonceBeforeSend = await this.adapter.getNonce(payload.order.trader);
        if (nonceBeforeSend > payload.order.nonce) {
          this.log('info', 'relay_skipped_already_submitted', {
            trader: payload.order.trader,
            batchId: Number(payload.order.batchId),
            nonce: Number(payload.order.nonce),
            onchainNonce: Number(nonceBeforeSend),
          });
          return {
            status: 200,
            body: {
              status: 'already_submitted',
              relayed: false,
              batchId: Number(payload.order.batchId),
              nonce: Number(payload.order.nonce),
            },
          };
        }

        try {
          await this.adapter.simulateSubmitIntent(payload.order, payload.signature);
        } catch (simErr) {
          const err: RelayValidationError = {
            status: 400,
            code: 'simulation_reverted',
            error: `Intent became invalid during grace wait: ${simErr instanceof Error ? simErr.message : String(simErr)}`,
          };
          return { status: 400, body: err };
        }

        const fees = await this.adapter.checkGasPrice();
        if (!fees) {
          const err: RelayValidationError = {
            status: 503,
            code: 'gas_price_cap',
            error: 'Network gas price exceeds relayer cap. Click "Submit it myself" to proceed.',
          };
          return { status: 503, body: err };
        }

        const estimatedGas = await this.adapter.estimateSubmitIntentGas(
          payload.order,
          payload.signature,
        );
        const paddedGas = (estimatedGas * 120n) / 100n + 60_000n;
        const gas = paddedGas > this.config.relayGasLimit ? this.config.relayGasLimit : paddedGas;

        const submitted = await this.adapter.submitIntentTx(
          payload.order,
          payload.signature,
          gas,
          fees,
        );
        this.log('info', 'relay_submitted', {
          trader: payload.order.trader,
          batchId: Number(payload.order.batchId),
          nonce: Number(payload.order.nonce),
          orderId: submitted.orderId,
          txHash: submitted.txHash,
          blockNumber: submitted.blockNumber,
          gasUsed: submitted.gasUsed,
        });
        return {
          status: 200,
          body: {
            status: 'submitted',
            relayed: true,
            batchId: Number(payload.order.batchId),
            nonce: Number(payload.order.nonce),
            txHash: submitted.txHash,
            orderId: submitted.orderId,
            blockNumber: submitted.blockNumber,
            gasUsed: submitted.gasUsed,
          },
        };
      });
    } finally {
      this.inflightKeys.delete(dedupeKey);
    }
  }

  public handleHttpRequest = async (
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<boolean> => {
    const urlPath = (req.url ?? '/').split('?')[0];
    if (req.method !== 'POST' || urlPath !== '/relay/intent') {
      return false;
    }

    const clientIp =
      (typeof req.headers['x-forwarded-for'] === 'string'
        ? req.headers['x-forwarded-for'].split(',')[0].trim()
        : null) ??
      req.socket.remoteAddress ??
      'unknown';

    let bodyStr = '';
    try {
      bodyStr = await readBoundedBody(req, this.config.relayMaxBodyBytes);
    } catch (err) {
      const tooLarge = err instanceof Error && err.message === 'PAYLOAD_TOO_LARGE';
      res.writeHead(tooLarge ? 413 : 400, {
        'Content-Type': 'application/json',
        Connection: 'close',
      });
      res.end(
        JSON.stringify({
          status: tooLarge ? 413 : 400,
          code: tooLarge ? 'payload_too_large' : 'body_read_error',
          error: tooLarge
            ? `Request body exceeds ${this.config.relayMaxBodyBytes} bytes.`
            : 'Could not read request body.',
        }),
      );
      return true;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyStr);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 400,
          code: 'invalid_json',
          error: 'Malformed JSON body.',
        }),
      );
      return true;
    }

    try {
      const outcome = await this.relay(parsed, clientIp);
      res.writeHead(outcome.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(outcome.body));
    } catch (err) {
      this.log('error', 'relay_unexpected_error', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 500,
          code: 'relay_failed',
          error: 'Relayer encountered an error. Click "Submit it myself" to send directly.',
        }),
      );
    }
    return true;
  };
}

function readBoundedBody(req: http.IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let total = 0;
    let settled = false;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        if (!settled) {
          settled = true;
          reject(new Error('PAYLOAD_TOO_LARGE'));
        }
        return;
      }
      if (!settled) chunks.push(chunk);
    });
    req.on('end', () => {
      if (!settled) {
        settled = true;
        resolve(Buffer.concat(chunks).toString('utf8'));
      }
    });
    req.on('error', (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
  });
}
