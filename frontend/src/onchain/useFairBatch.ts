import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Address, Hash } from 'viem';
import type {
  ClaimableDto,
  LocalSecretVaultEntry,
  OrderSide,
  SignedIntentArtifact,
} from '../types';
import {
  addLiquidity as addLiquidityAction,
  approveFairBatch,
  claimMany as claimManyAction,
  claimOrder,
  commitOrder,
  describeTxError,
  mintTestTokens,
  removeLiquidity as removeLiquidityAction,
  revealOrder,
  settleBatch as settleBatchAction,
  signIntent as signIntentAction,
  slashUnrevealed,
  submitDirectOrder,
  submitSignedIntent,
  type CommitResult,
  type DirectOrderResult,
  type IntentResult,
  type LiquidityResult,
  type RevealResult,
  type TxResult,
} from './actions';
import {
  clearPublicClientCache,
  connectInjectedWallet,
  getWalletChainId,
  restoreInjectedAccount,
  watchInjectedWallet,
} from './client';
import {
  DEFAULT_RUNTIME_CONFIG,
  isContractConfigured,
  loadRuntimeConfig,
  resetRuntimeConfig,
  saveRuntimeConfig,
  type RuntimeConfig,
} from './config';
import { resetEventCache } from './events';
import {
  clearReceiptCache,
  loadOnchainSnapshot,
  type OnchainSnapshot,
} from './state';
import {
  loadSecretVault,
  markSecretRevealed,
  upsertSecret,
} from './secretVault';

const AUTOCONNECT_KEY = 'fairbatch.autoconnect.v1';

export interface Notice {
  kind: 'success' | 'error' | 'info';
  text: string;
  hash?: Hash;
}

export interface FairBatchController {
  config: RuntimeConfig;
  account: Address | null;
  walletChainId: number | null;
  snapshot: OnchainSnapshot | null;
  loading: boolean;
  refreshing: boolean;
  busyAction: string | null;
  error: string | null;
  notice: Notice | null;
  secretVault: LocalSecretVaultEntry[];
  configured: boolean;
  wrongNetwork: boolean;
  connect: () => Promise<void>;
  disconnect: () => void;
  refresh: () => void;
  updateConfig: (partial: Partial<RuntimeConfig>) => void;
  resetConfig: () => void;
  clearNotice: () => void;
  submitDirect: (params: {
    side: OrderSide;
    amountIn: string;
    limitPrice: string;
  }) => Promise<DirectOrderResult>;
  sealCommit: (params: {
    side: OrderSide;
    amountIn: string;
    limitPrice: string;
    salt: string;
    bondEth: string;
  }) => Promise<CommitResult>;
  revealCommit: (secret: LocalSecretVaultEntry) => Promise<RevealResult>;
  signIntent: (params: {
    side: OrderSide;
    amountIn: string;
    limitPrice: string;
  }) => Promise<IntentResult>;
  submitIntent: (artifact: SignedIntentArtifact) => Promise<DirectOrderResult>;
  settle: () => Promise<{ hash: Hash; batchId: number }>;
  slash: (batchId: number, commitId: number) => Promise<{ hash: Hash; forfeitedBond: bigint }>;
  claim: (item: ClaimableDto) => Promise<{ hash: Hash; payoutBase: bigint; payoutQuote: bigint }>;
  claimMany: (items: ClaimableDto[]) => Promise<{ hash: Hash; claimed: number }>;
  addLiquidity: (amountBase: string, amountQuote: string) => Promise<LiquidityResult>;
  removeLiquidity: (shares: string) => Promise<LiquidityResult>;
  faucet: (token: 'base' | 'quote') => Promise<TxResult>;
  approve: (token: 'base' | 'quote') => Promise<Hash | null>;
}

function toMessage(hash: Hash, text: string): Notice {
  return { kind: 'success', text, hash };
}

export function useFairBatch(): FairBatchController {
  const [config, setConfig] = useState<RuntimeConfig>(() => loadRuntimeConfig());
  const [account, setAccount] = useState<Address | null>(null);
  const [walletChainId, setWalletChainId] = useState<number | null>(null);
  const [snapshot, setSnapshot] = useState<OnchainSnapshot | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [secretVault, setSecretVault] = useState<LocalSecretVaultEntry[]>(() =>
    loadSecretVault(),
  );
  const [refreshNonce, setRefreshNonce] = useState<number>(0);

  const busyRef = useRef<string | null>(null);
  busyRef.current = busyAction;
  const requestIdRef = useRef<number>(0);
  const accountRef = useRef<Address | null>(null);
  accountRef.current = account;
  const configRef = useRef<RuntimeConfig>(config);
  configRef.current = config;

  const refresh = useCallback(() => {
    setRefreshNonce((value) => value + 1);
  }, []);

  // Restore an already-authorised injected wallet on first load.
  useEffect(() => {
    let cancelled = false;
    const initial = loadRuntimeConfig();
    setConfig(initial);
    let auto = '1';
    try {
      auto = localStorage.getItem(AUTOCONNECT_KEY) ?? '1';
    } catch {
      auto = '1';
    }
    if (auto === '0') return () => { cancelled = true; };
    void (async () => {
      const restored = await restoreInjectedAccount(initial);
      if (cancelled || !restored) return;
      setAccount(restored);
      setWalletChainId(await getWalletChainId(initial));
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Wallet events.
  useEffect(() => {
    return watchInjectedWallet({
      onAccountsChanged: (accounts) => {
        setAccount(accounts[0] ?? null);
        setWalletChainId(configRef.current.chainId);
        refresh();
      },
      onChainChanged: (chainId) => {
        setWalletChainId(chainId);
        refresh();
      },
      onDisconnect: () => {
        setAccount(null);
        setWalletChainId(null);
      },
    });
  }, [refresh]);

  // Snapshot polling + explicit refresh.
  useEffect(() => {
    let cancelled = false;
    if (!isContractConfigured(config)) {
      setError('No FairBatch contract address is configured.');
      setLoading(false);
      setSnapshot(null);
      return () => { cancelled = true; };
    }
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    if (!snapshot) setLoading(true);
    else setRefreshing(true);

    void (async () => {
      try {
        const next = await loadOnchainSnapshot(config, account);
        if (cancelled || requestId !== requestIdRef.current) return;
        setSnapshot(next);
        setError(null);
      } catch (err) {
        if (cancelled || requestId !== requestIdRef.current) return;
        setError(describeTxError(err));
      } finally {
        if (!cancelled && requestId === requestIdRef.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
    // snapshot intentionally excluded: it would re-run after every read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config, account, refreshNonce]);

  useEffect(() => {
    const id = window.setInterval(() => {
      if (busyRef.current === null) refresh();
    }, 10_000);
    return () => window.clearInterval(id);
  }, [refresh]);

  const requireAccount = useCallback((): Address => {
    const active = accountRef.current;
    if (!active) {
      throw new Error('Connect an injected wallet to sign on-chain transactions.');
    }
    return active;
  }, []);

  const runAction = useCallback(
    async <T,>(
      name: string,
      fn: (active: Address) => Promise<T>,
      successText: (result: T) => Notice,
    ): Promise<T> => {
      const active = requireAccount();
      setBusyAction(name);
      setError(null);
      setNotice(null);
      try {
        const result = await fn(active);
        setNotice(successText(result));
        refresh();
        return result;
      } catch (err) {
        const message = describeTxError(err);
        setError(message);
        setNotice({ kind: 'error', text: message });
        throw new Error(message);
      } finally {
        setBusyAction(null);
      }
    },
    [refresh, requireAccount],
  );

  const connect = useCallback(async () => {
    setBusyAction('connect');
    setError(null);
    try {
      const connected = await connectInjectedWallet(config);
      setAccount(connected);
      setWalletChainId(await getWalletChainId(config));
      try {
        localStorage.setItem(AUTOCONNECT_KEY, '1');
      } catch {
        // ignore
      }
      setNotice({ kind: 'success', text: `Connected wallet ${connected}.` });
      refresh();
    } catch (err) {
      const message = describeTxError(err);
      setError(message);
      setNotice({ kind: 'error', text: message });
      throw new Error(message);
    } finally {
      setBusyAction(null);
    }
  }, [config, refresh]);

  const disconnect = useCallback(() => {
    setAccount(null);
    setWalletChainId(null);
    try {
      localStorage.setItem(AUTOCONNECT_KEY, '0');
    } catch {
      // ignore
    }
    setNotice({ kind: 'info', text: 'Wallet disconnected from this terminal.' });
  }, []);

  const updateConfig = useCallback((partial: Partial<RuntimeConfig>) => {
    const next = saveRuntimeConfig({ ...configRef.current, ...partial });
    clearPublicClientCache();
    resetEventCache();
    clearReceiptCache();
    setSnapshot(null);
    setConfig(next);
    setError(null);
    setNotice({
      kind: 'success',
      text: 'Runtime contract, RPC, and token configuration updated.',
    });
  }, []);

  const resetConfig = useCallback(() => {
    const next = resetRuntimeConfig();
    saveRuntimeConfig(next);
    clearPublicClientCache();
    resetEventCache();
    clearReceiptCache();
    setSnapshot(null);
    setConfig({ ...next });
    setNotice({ kind: 'info', text: 'Configuration reset to the Sepolia deployment.' });
  }, []);

  const submitDirect = useCallback(
    (params: { side: OrderSide; amountIn: string; limitPrice: string }) =>
      runAction(
        'direct',
        (active) =>
          submitDirectOrder(configRef.current, active, {
            side: params.side,
            amountIn: params.amountIn,
            limitPrice: params.limitPrice,
          }),
        (result) =>
          toMessage(
            result.hash,
            `Direct order ${result.orderId >= 0 ? `#${result.orderId}` : ''} confirmed on-chain.`,
          ),
      ),
    [runAction],
  );

  const sealCommit = useCallback(
    async (params: {
      side: OrderSide;
      amountIn: string;
      limitPrice: string;
      salt: string;
      bondEth: string;
    }): Promise<CommitResult> => {
      const active = requireAccount();
      const currentSnapshot = snapshot;
      if (!currentSnapshot) throw new Error('Batch state is still loading.');
      const batchId = currentSnapshot.state.batch_id;
      const result = await runAction(
        'commit',
        (walletAddress) =>
          commitOrder(configRef.current, walletAddress, {
            ...params,
            batchId,
          }),
        (res) => toMessage(res.hash, `Sealed commitment confirmed in Batch #${batchId}.`),
      );

      let commitId = result.commitId;
      if (commitId < 0) {
        const fresh = await loadOnchainSnapshot(configRef.current, active);
        const found = fresh.commitments.find(
          (commit) =>
            commit.commitment_hash.toLowerCase() === result.commitmentHash.toLowerCase() &&
            commit.trader.toLowerCase() === active.toLowerCase(),
        );
        commitId = found?.commit_id ?? -1;
      }

      if (commitId >= 0) {
        setSecretVault(
          upsertSecret({
            commit_id: commitId,
            batch_id: batchId,
            trader: active,
            label: `${active.slice(0, 6)}…${active.slice(-4)} (Sealed)`,
            side: params.side,
            amount_in: Number(params.amountIn),
            limit_price: Number(params.limitPrice),
            salt: params.salt,
            commitment_hash: result.commitmentHash,
            bond_eth: Number(params.bondEth),
            bond_wei: result.bondWei.toString(),
            amount_in_raw: result.amountInRaw.toString(),
            limit_price_raw: result.limitPriceRaw.toString(),
            revealed: false,
          }),
        );
      }
      return result;
    },
    [requireAccount, runAction, snapshot],
  );

  const revealCommit = useCallback(
    (secret: LocalSecretVaultEntry) =>
      runAction(
        'reveal',
        (active) => revealOrder(configRef.current, active, secret),
        (result) => {
          setSecretVault(markSecretRevealed(secret.batch_id, secret.commit_id));
          return toMessage(
            result.hash,
            `Reveal confirmed for commitment #${secret.commit_id}${
              result.orderId >= 0 ? ` → order #${result.orderId}` : ''
            }.`,
          );
        },
      ),
    [runAction],
  );

  const signIntent = useCallback(
    async (params: {
      side: OrderSide;
      amountIn: string;
      limitPrice: string;
    }): Promise<IntentResult> => {
      const active = requireAccount();
      setBusyAction('sign-intent');
      setError(null);
      setNotice(null);
      try {
        return await signIntentAction(configRef.current, active, {
          ...params,
          label: `${active.slice(0, 6)}…${active.slice(-4)} (Signed)`,
        });
      } catch (err) {
        const message = describeTxError(err);
        setError(message);
        throw new Error(message);
      } finally {
        setBusyAction(null);
      }
    },
    [requireAccount],
  );

  const submitIntent = useCallback(
    (artifact: SignedIntentArtifact) =>
      runAction(
        'submit-intent',
        (active) => submitSignedIntent(configRef.current, active, artifact),
        (result) =>
          toMessage(
            result.hash,
            `Signed intent accepted as order ${
              result.orderId >= 0 ? `#${result.orderId}` : ''
            } (nonce #${artifact.nonce}).`,
          ),
      ),
    [runAction],
  );

  const settle = useCallback(
    () =>
      runAction(
        'settle',
        (active) => settleBatchAction(configRef.current, active),
        (result) =>
          toMessage(
            result.hash,
            `Batch #${result.batchId >= 0 ? result.batchId : '?'} settled at one uniform clearing price.`,
          ),
      ),
    [runAction],
  );

  const slash = useCallback(
    (batchId: number, commitId: number) =>
      runAction(
        'slash',
        (active) => slashUnrevealed(configRef.current, active, batchId, commitId),
        (result) =>
          toMessage(
            result.hash,
            `Commitment #${commitId} slashed; ${Number(result.forfeitedBond) / 1e18} ETH forfeited.`,
          ),
      ),
    [runAction],
  );

  const claim = useCallback(
    (item: ClaimableDto) =>
      runAction(
        'claim',
        (active) =>
          claimOrder(configRef.current, active, item.batch_id, item.order_id),
        (result) =>
          toMessage(
            result.hash,
            `Claimed Batch #${item.batch_id} Order #${item.order_id}.`,
          ),
      ),
    [runAction],
  );

  const claimMany = useCallback(
    (items: ClaimableDto[]) =>
      runAction(
        'multicall-claim',
        (active) =>
          claimManyAction(
            configRef.current,
            active,
            items.map((item) => ({
              batchId: item.batch_id,
              orderId: item.order_id,
            })),
          ),
        (result) =>
          toMessage(
            result.hash,
            `Executed Multicall claim for ${result.claimed} settled receipt(s).`,
          ),
      ),
    [runAction],
  );

  const addLiquidity = useCallback(
    (amountBase: string, amountQuote: string) =>
      runAction(
        'add-liquidity',
        (active) => addLiquidityAction(configRef.current, active, amountBase, amountQuote),
        (result) =>
          toMessage(
            result.hash,
            `Liquidity added${
              result.sharesMinted ? ` · ${Number(result.sharesMinted) / 1e18} LP shares minted` : ''
            }.`,
          ),
      ),
    [runAction],
  );

  const removeLiquidity = useCallback(
    (shares: string) =>
      runAction(
        'remove-liquidity',
        (active) => removeLiquidityAction(configRef.current, active, shares),
        (result) => toMessage(result.hash, 'Liquidity removed from the pool.'),
      ),
    [runAction],
  );

  const faucet = useCallback(
    (token: 'base' | 'quote') =>
      runAction(
        'faucet',
        (active) =>
          mintTestTokens(
            configRef.current,
            active,
            token,
            token === 'base' ? '10' : '30000',
          ),
        (result) =>
          toMessage(
            result.hash,
            `Minted ${
              token === 'base'
                ? `10 ${configRef.current.baseSymbol}`
                : `30,000 ${configRef.current.quoteSymbol}`
            } and approved FairBatch.`,
          ),
      ),
    [runAction],
  );

  const approve = useCallback(
    (token: 'base' | 'quote') =>
      runAction(
        'approve',
        (active) => approveFairBatch(configRef.current, active, token),
        (result) =>
          result
            ? toMessage(
                result,
                `Approved FairBatch to spend ${
                  token === 'base'
                    ? configRef.current.baseSymbol
                    : configRef.current.quoteSymbol
                }.`,
              )
            : { kind: 'info', text: 'Allowance is already sufficient.' },
      ),
    [runAction],
  );

  const wrongNetwork = useMemo(
    () => walletChainId !== null && walletChainId !== config.chainId,
    [walletChainId, config.chainId],
  );

  return {
    config,
    account,
    walletChainId,
    snapshot,
    loading,
    refreshing,
    busyAction,
    error,
    notice,
    secretVault,
    configured: isContractConfigured(config),
    wrongNetwork,
    connect,
    disconnect,
    refresh,
    updateConfig,
    resetConfig,
    clearNotice: () => setNotice(null),
    submitDirect,
    sealCommit,
    revealCommit,
    signIntent,
    submitIntent,
    settle,
    slash,
    claim,
    claimMany,
    addLiquidity,
    removeLiquidity,
    faucet,
    approve,
  };
}

export { DEFAULT_RUNTIME_CONFIG };
