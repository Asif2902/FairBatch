import {
  encodeFunctionData,
  getAddress,
  hashTypedData,
  maxUint256,
  parseEventLogs,
  parseUnits,
  type Address,
  type Hash,
  type TransactionReceipt,
} from 'viem';
import type { LocalSecretVaultEntry, OrderSide, SignedIntentArtifact } from '../types';
import { keccak256Utf8 } from '../lib/keccak';
import { erc20Abi, fairBatchAbi, fairBatchEvents } from './abi';
import { ensureWalletReady, getPublicClient } from './client';
import { getChain, type RuntimeConfig } from './config';

export interface TxResult {
  hash: Hash;
  receipt: TransactionReceipt;
}

export interface DirectOrderResult extends TxResult {
  orderId: number;
}

export interface CommitResult extends TxResult {
  commitId: number;
  commitmentHash: `0x${string}`;
  bondWei: bigint;
  amountInRaw: bigint;
  limitPriceRaw: bigint;
  salt: string;
}

export interface RevealResult extends TxResult {
  orderId: number;
}

export interface IntentResult extends SignedIntentArtifact {
  digest: `0x${string}`;
}

export interface LiquidityResult extends TxResult {
  sharesMinted?: bigint;
  amountBase?: bigint;
  amountQuote?: bigint;
}

function decimalString(value: string | number): string {
  const raw = typeof value === 'number' ? String(value) : value.trim();
  if (!raw) throw new Error('Amount is required.');
  if (!/^\d+(\.\d+)?$/.test(raw)) {
    const numeric = Number(raw);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      throw new Error(`Invalid positive amount: ${raw}`);
    }
    return numeric.toFixed(18).replace(/0+$/, '').replace(/\.$/, '');
  }
  return raw;
}

export function toRawAmount(value: string | number, decimals: number): bigint {
  const clean = decimalString(value);
  const parsed = parseUnits(clean, decimals);
  if (parsed <= 0n) throw new Error('Amount must be greater than zero.');
  return parsed;
}

export function toWadPrice(value: string | number): bigint {
  const parsed = parseUnits(decimalString(value), 18);
  if (parsed <= 0n) throw new Error('Limit price must be greater than zero.');
  return parsed;
}

export function saltToBigInt(salt: string): bigint {
  const trimmed = salt.trim();
  if (/^0x[0-9a-fA-F]{1,64}$/.test(trimmed)) {
    return BigInt(trimmed);
  }
  // Compatibility for legacy vault entries: fold arbitrary text into a u256.
  return BigInt(keccak256Utf8(trimmed));
}

function inputToken(config: RuntimeConfig, side: OrderSide): Address {
  return side === 'SellBase' ? config.baseToken : config.quoteToken;
}

function inputDecimals(config: RuntimeConfig, side: OrderSide): number {
  return side === 'SellBase' ? config.baseDecimals : config.quoteDecimals;
}

function sideU8(side: OrderSide): number {
  return side === 'SellBase' ? 0 : 1;
}

function eventBig(args: Record<string, unknown>, key: string): bigint {
  const value = args[key];
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(value);
  if (typeof value === 'string') return BigInt(value);
  return 0n;
}

function decodeEvents(
  receipt: TransactionReceipt,
  eventName: string,
): Array<Record<string, unknown>> {
  try {
    const parsed = parseEventLogs({
      abi: fairBatchEvents,
      logs: receipt.logs,
      eventName: eventName as never,
    }) as unknown as Array<{ args: Record<string, unknown> }>;
    return parsed.map((event) => event.args);
  } catch {
    return [];
  }
}

async function waitForSuccess(config: RuntimeConfig, hash: Hash): Promise<TransactionReceipt> {
  const client = getPublicClient(config);
  const receipt = await client.waitForTransactionReceipt({
    hash,
    confirmations: 1,
    timeout: 180_000,
  });
  if (receipt.status !== 'success') {
    throw new Error(`Transaction reverted on-chain: ${hash}`);
  }
  return receipt;
}

async function approveToken(
  config: RuntimeConfig,
  account: Address,
  token: Address,
  spender: Address,
  amount: bigint = maxUint256,
): Promise<Hash | null> {
  const client = getPublicClient(config);
  const current = await client.readContract({
    address: token,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [account, spender],
  });
  if (current >= amount) return null;

  const wallet = await ensureWalletReady(config, account);
  const hash = await wallet.writeContract({
    address: token,
    abi: erc20Abi,
    functionName: 'approve',
    args: [spender, maxUint256],
    account,
    chain: getChain(config),
  });
  await waitForSuccess(config, hash);
  return hash;
}

export async function ensureInputAllowance(
  config: RuntimeConfig,
  account: Address,
  side: OrderSide,
  amount: bigint,
): Promise<Hash | null> {
  return approveToken(config, account, inputToken(config, side), config.fairBatch, amount);
}

export async function mintTestTokens(
  config: RuntimeConfig,
  account: Address,
  token: 'base' | 'quote',
  amount: string,
): Promise<TxResult> {
  const tokenAddress = token === 'base' ? config.baseToken : config.quoteToken;
  const decimals = token === 'base' ? config.baseDecimals : config.quoteDecimals;
  const raw = toRawAmount(amount, decimals);
  const wallet = await ensureWalletReady(config, account);
  const hash = await wallet.writeContract({
    address: tokenAddress,
    abi: erc20Abi,
    functionName: 'mintAndApprove',
    args: [account, config.fairBatch, raw],
    account,
    chain: getChain(config),
  });
  const receipt = await waitForSuccess(config, hash);
  return { hash, receipt };
}

export async function submitDirectOrder(
  config: RuntimeConfig,
  account: Address,
  params: { side: OrderSide; amountIn: string; limitPrice: string },
): Promise<DirectOrderResult> {
  const amountRaw = toRawAmount(params.amountIn, inputDecimals(config, params.side));
  const limitRaw = toWadPrice(params.limitPrice);
  await ensureInputAllowance(config, account, params.side, amountRaw);

  const wallet = await ensureWalletReady(config, account);
  const hash = await wallet.writeContract({
    address: config.fairBatch,
    abi: fairBatchAbi,
    functionName: 'submitDirectOrder',
    args: [sideU8(params.side), amountRaw, limitRaw],
    account,
    chain: getChain(config),
  });
  const receipt = await waitForSuccess(config, hash);
  const events = decodeEvents(receipt, 'OrderSubmitted');
  const orderId = events[0] ? Number(eventBig(events[0], 'orderId')) : -1;
  return { hash, receipt, orderId };
}

export async function commitOrder(
  config: RuntimeConfig,
  account: Address,
  params: {
    side: OrderSide;
    amountIn: string;
    limitPrice: string;
    salt: string;
    bondEth: string;
    batchId: number;
  },
): Promise<CommitResult> {
  const amountRaw = toRawAmount(params.amountIn, inputDecimals(config, params.side));
  const limitRaw = toWadPrice(params.limitPrice);
  const bondWei = toRawAmount(params.bondEth, 18);
  if (bondWei < config.minBondWei) {
    throw new Error(
      `Reveal bond must be at least ${Number(config.minBondWei) / 1e18} ETH.`,
    );
  }
  const client = getPublicClient(config);
  const ethBalance = await client.getBalance({ address: account });
  if (ethBalance < bondWei) {
    throw new Error(
      `Insufficient Sepolia ETH for the reveal bond. Need ${Number(bondWei) / 1e18} ETH plus gas.`,
    );
  }

  const saltBig = saltToBigInt(params.salt);
  const commitmentHash = (await client.readContract({
    address: config.fairBatch,
    abi: fairBatchAbi,
    functionName: 'computeCommitmentHash',
    args: [
      BigInt(params.batchId),
      account,
      sideU8(params.side),
      amountRaw,
      limitRaw,
      saltBig,
    ],
  })) as bigint;

  const wallet = await ensureWalletReady(config, account);
  const hash = await wallet.writeContract({
    address: config.fairBatch,
    abi: fairBatchAbi,
    functionName: 'commitOrder',
    args: [commitmentHash],
    value: bondWei,
    account,
    chain: getChain(config),
  });
  const receipt = await waitForSuccess(config, hash);
  const events = decodeEvents(receipt, 'OrderCommitted');
  const commitId = events[0] ? Number(eventBig(events[0], 'commitId')) : -1;
  return {
    hash,
    receipt,
    commitId,
    commitmentHash: `0x${commitmentHash.toString(16).padStart(64, '0')}`,
    bondWei,
    amountInRaw: amountRaw,
    limitPriceRaw: limitRaw,
    salt: params.salt,
  };
}

export async function revealOrder(
  config: RuntimeConfig,
  account: Address,
  secret: LocalSecretVaultEntry,
): Promise<RevealResult> {
  const amountRaw = secret.amount_in_raw
    ? BigInt(secret.amount_in_raw)
    : toRawAmount(secret.amount_in, inputDecimals(config, secret.side));
  const limitRaw = secret.limit_price_raw
    ? BigInt(secret.limit_price_raw)
    : toWadPrice(secret.limit_price);
  const saltBig = saltToBigInt(secret.salt);
  await ensureInputAllowance(config, account, secret.side, amountRaw);

  const wallet = await ensureWalletReady(config, account);
  const hash = await wallet.writeContract({
    address: config.fairBatch,
    abi: fairBatchAbi,
    functionName: 'revealOrder',
    args: [BigInt(secret.commit_id), sideU8(secret.side), amountRaw, limitRaw, saltBig],
    account,
    chain: getChain(config),
  });
  const receipt = await waitForSuccess(config, hash);
  const events = decodeEvents(receipt, 'OrderRevealed');
  const orderId = events[0] ? Number(eventBig(events[0], 'orderId')) : -1;
  return { hash, receipt, orderId };
}

export async function signIntent(
  config: RuntimeConfig,
  account: Address,
  params: { side: OrderSide; amountIn: string; limitPrice: string; label: string },
): Promise<IntentResult> {
  const client = getPublicClient(config);
  const [nonce, currentBatch] = await Promise.all([
    client.readContract({
      address: config.fairBatch,
      abi: fairBatchAbi,
      functionName: 'getNonce',
      args: [account],
    }),
    client.readContract({
      address: config.fairBatch,
      abi: fairBatchAbi,
      functionName: 'currentBatch',
    }),
  ]);
  const amountRaw = toRawAmount(params.amountIn, inputDecimals(config, params.side));
  const limitRaw = toWadPrice(params.limitPrice);
  const deadline = Math.floor(Date.now() / 1000) + 3600;
  const domain = {
    name: 'FairBatch',
    version: '1',
    chainId: config.chainId,
    verifyingContract: config.fairBatch,
  } as const;
  const types = {
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
  const message = {
    trader: account,
    side: sideU8(params.side),
    amountIn: amountRaw,
    limitPrice: limitRaw,
    batchId: currentBatch.batchId,
    nonce,
    deadline: BigInt(deadline),
  } as const;

  const wallet = await ensureWalletReady(config, account);
  const signature = await wallet.signTypedData({
    account,
    domain,
    types,
    primaryType: 'SignedOrder',
    message,
  });
  const digest = hashTypedData({
    domain,
    types,
    primaryType: 'SignedOrder',
    message,
  });

  return {
    trader: account,
    label: params.label,
    side: params.side,
    amount_in: Number(params.amountIn),
    limit_price: Number(params.limitPrice),
    amount_in_raw: amountRaw.toString(),
    limit_price_raw: limitRaw.toString(),
    batch_id: Number(currentBatch.batchId),
    nonce: Number(nonce),
    deadline,
    signature,
    digest,
  };
}

export async function submitSignedIntent(
  config: RuntimeConfig,
  account: Address,
  artifact: SignedIntentArtifact,
): Promise<DirectOrderResult> {
  if (getAddress(artifact.trader) !== getAddress(account)) {
    throw new Error('The connected wallet must be the signed intent trader.');
  }
  const amountRaw = BigInt(artifact.amount_in_raw);
  const limitRaw = BigInt(artifact.limit_price_raw);
  await ensureInputAllowance(config, account, artifact.side, amountRaw);

  const wallet = await ensureWalletReady(config, account);
  const hash = await wallet.writeContract({
    address: config.fairBatch,
    abi: fairBatchAbi,
    functionName: 'submitSignedIntent',
    args: [
      {
        trader: getAddress(artifact.trader),
        side: sideU8(artifact.side),
        amountIn: amountRaw,
        limitPrice: limitRaw,
        batchId: BigInt(artifact.batch_id),
        nonce: BigInt(artifact.nonce),
        deadline: BigInt(artifact.deadline),
      },
      artifact.signature as `0x${string}`,
    ],
    account,
    chain: getChain(config),
  });
  const receipt = await waitForSuccess(config, hash);
  const events = decodeEvents(receipt, 'OrderSubmitted');
  const orderId = events[0] ? Number(eventBig(events[0], 'orderId')) : -1;
  return { hash, receipt, orderId };
}

export async function settleBatch(
  config: RuntimeConfig,
  account: Address,
): Promise<{ hash: Hash; batchId: number }> {
  const wallet = await ensureWalletReady(config, account);
  const hash = await wallet.writeContract({
    address: config.fairBatch,
    abi: fairBatchAbi,
    functionName: 'settleBatch',
    args: [],
    account,
    chain: getChain(config),
  });
  const receipt = await waitForSuccess(config, hash);
  const events = decodeEvents(receipt, 'BatchSettled');
  return {
    hash,
    batchId: events[0] ? Number(eventBig(events[0], 'batchId')) : -1,
  };
}

export async function slashUnrevealed(
  config: RuntimeConfig,
  account: Address,
  batchId: number,
  commitId: number,
): Promise<{ hash: Hash; forfeitedBond: bigint }> {
  const wallet = await ensureWalletReady(config, account);
  const hash = await wallet.writeContract({
    address: config.fairBatch,
    abi: fairBatchAbi,
    functionName: 'slashUnrevealed',
    args: [BigInt(batchId), BigInt(commitId)],
    account,
    chain: getChain(config),
  });
  const receipt = await waitForSuccess(config, hash);
  const events = decodeEvents(receipt, 'CommitmentSlashed');
  return {
    hash,
    forfeitedBond: events[0] ? eventBig(events[0], 'forfeitedBond') : 0n,
  };
}

export async function claimOrder(
  config: RuntimeConfig,
  account: Address,
  batchId: number,
  orderId: number,
): Promise<{ hash: Hash; payoutBase: bigint; payoutQuote: bigint }> {
  const wallet = await ensureWalletReady(config, account);
  const hash = await wallet.writeContract({
    address: config.fairBatch,
    abi: fairBatchAbi,
    functionName: 'claim',
    args: [BigInt(batchId), BigInt(orderId)],
    account,
    chain: getChain(config),
  });
  const receipt = await waitForSuccess(config, hash);
  const events = decodeEvents(receipt, 'OrderClaimed');
  const claimed = events[0];
  return {
    hash,
    payoutBase: claimed ? eventBig(claimed, 'payoutBase') : 0n,
    payoutQuote: claimed ? eventBig(claimed, 'payoutQuote') : 0n,
  };
}

export async function claimMany(
  config: RuntimeConfig,
  account: Address,
  items: Array<{ batchId: number; orderId: number }>,
): Promise<{ hash: Hash; claimed: number }> {
  if (items.length === 0) throw new Error('No claims selected.');
  const calls = items.map((item) =>
    encodeFunctionData({
      abi: fairBatchAbi,
      functionName: 'claim',
      args: [BigInt(item.batchId), BigInt(item.orderId)],
    }),
  );
  const wallet = await ensureWalletReady(config, account);
  const hash = await wallet.writeContract({
    address: config.fairBatch,
    abi: fairBatchAbi,
    functionName: 'multicall',
    args: [calls],
    account,
    chain: getChain(config),
  });
  const receipt = await waitForSuccess(config, hash);
  const events = decodeEvents(receipt, 'OrderClaimed');
  return { hash, claimed: events.length };
}

export async function addLiquidity(
  config: RuntimeConfig,
  account: Address,
  amountBase: string,
  amountQuote: string,
): Promise<LiquidityResult> {
  const baseRaw = toRawAmount(amountBase, config.baseDecimals);
  const quoteRaw = toRawAmount(amountQuote, config.quoteDecimals);
  await approveToken(config, account, config.baseToken, config.fairBatch, baseRaw);
  await approveToken(config, account, config.quoteToken, config.fairBatch, quoteRaw);

  const wallet = await ensureWalletReady(config, account);
  const hash = await wallet.writeContract({
    address: config.fairBatch,
    abi: fairBatchAbi,
    functionName: 'addLiquidity',
    args: [baseRaw, quoteRaw],
    account,
    chain: getChain(config),
  });
  const receipt = await waitForSuccess(config, hash);
  const events = decodeEvents(receipt, 'LiquidityAdded');
  return {
    hash,
    receipt,
    sharesMinted: events[0] ? eventBig(events[0], 'sharesMinted') : undefined,
    amountBase: baseRaw,
    amountQuote: quoteRaw,
  };
}

export async function removeLiquidity(
  config: RuntimeConfig,
  account: Address,
  shares: string,
): Promise<LiquidityResult> {
  const sharesRaw = toRawAmount(shares, 18);
  const wallet = await ensureWalletReady(config, account);
  const hash = await wallet.writeContract({
    address: config.fairBatch,
    abi: fairBatchAbi,
    functionName: 'removeLiquidity',
    args: [sharesRaw],
    account,
    chain: getChain(config),
  });
  const receipt = await waitForSuccess(config, hash);
  const events = decodeEvents(receipt, 'LiquidityRemoved');
  return {
    hash,
    receipt,
    amountBase: events[0] ? eventBig(events[0], 'amountBase') : undefined,
    amountQuote: events[0] ? eventBig(events[0], 'amountQuote') : undefined,
  };
}

export async function approveFairBatch(
  config: RuntimeConfig,
  account: Address,
  token: 'base' | 'quote',
): Promise<Hash | null> {
  const tokenAddress = token === 'base' ? config.baseToken : config.quoteToken;
  return approveToken(config, account, tokenAddress, config.fairBatch);
}

export function describeTxError(error: unknown): string {
  if (error instanceof Error) {
    const raw = error.message;
    const known: Array<[string, string]> = [
      ['Commit window closed', 'The commit window has closed. Wait for the next batch.'],
      ['Reveal window not open yet', 'The reveal window has not opened yet.'],
      ['Reveal window closed', 'The reveal window has closed. This commitment can be slashed.'],
      ['Intent window closed', 'Signed intents are closed for this batch.'],
      ['Reveal window still active', 'The reveal window is still active. Settle after it closes.'],
      ['Insufficient allowance', 'Token allowance is too low. Approve the token and retry.'],
      ['Insufficient balance', 'Wallet balance is too low for this amount.'],
      ['Insufficient reveal bond', 'The reveal bond is below the contract minimum.'],
      ['Insufficient Sepolia ETH', 'You need Sepolia ETH for the reveal bond and gas.'],
      ['Commitment hash mismatch', 'The reveal data does not match the sealed commitment.'],
      ['Already revealed', 'This commitment has already been revealed.'],
      ['Commitment slashed', 'This commitment was slashed and can no longer be revealed.'],
      ['Not commitment owner', 'Only the wallet that committed can reveal it.'],
      ['Not order owner', 'Only the order owner can claim this receipt.'],
      ['Order already claimed', 'This receipt has already been claimed.'],
      ['user rejected', 'Transaction rejected in the wallet.'],
      ['User rejected', 'Transaction rejected in the wallet.'],
    ];
    for (const [needle, message] of known) {
      if (raw.includes(needle)) return message;
    }
    if (raw.includes('returned no data') || raw.includes('is not a contract')) {
      return 'The configured RPC or contract address is not responding as a FairBatch contract.';
    }
    const short = (error as { shortMessage?: string }).shortMessage;
    if (short) return short;
    return raw.split('\n')[0].slice(0, 240);
  }
  return 'Transaction failed.';
}
