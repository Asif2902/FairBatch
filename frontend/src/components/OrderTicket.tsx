import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowDownUp,
  CheckCircle2,
  Eye,
  FileSignature,
  KeyRound,
  Lock,
  RefreshCw,
  Send,
  ShieldAlert,
} from 'lucide-react';
import { formatUnits } from 'viem';
import type {
  LocalSecretVaultEntry,
  OrderSide,
  SignedIntentArtifact,
  StateResponse,
} from '../types';
import type { RuntimeConfig } from '../onchain/config';
import type { WalletBalances } from '../onchain/state';
import { computeBatchSettlement } from '../lib/clearingMath';
import {
  computeLocalCommitmentHash,
  generateRandomSaltHex,
} from '../lib/keccak';
import {
  formatPrice,
  formatSignedOrderAmount,
  formatTokenAmount,
  pluralize,
  shortenAddress,
} from '../lib/format';
import { PRO_TOOLTIPS } from '../lib/glossary';
import { InfoTooltip } from './InfoTooltip';

type TicketTab = 'direct' | 'commit_reveal' | 'eip712';

interface OrderTicketProps {
  state: StateResponse;
  config: RuntimeConfig;
  account: string | null;
  balances?: WalletBalances | null;
  localSecrets: LocalSecretVaultEntry[];
  busyAction: string | null;
  minBondWei: bigint;
  onConnect: () => Promise<void>;
  onSubmitDirect: (params: {
    side: OrderSide;
    amountIn: string;
    limitPrice: string;
  }) => Promise<void>;
  onSettleAndSubmitDirect?: (params: {
    side: OrderSide;
    amountIn: string;
    limitPrice: string;
  }) => Promise<void>;
  onSealCommit: (params: {
    side: OrderSide;
    amountIn: string;
    limitPrice: string;
    salt: string;
    bondEth: string;
  }) => Promise<void>;
  onRevealCommit: (secret: LocalSecretVaultEntry) => Promise<void>;
  onSignIntent: (params: {
    side: OrderSide;
    amountIn: string;
    limitPrice: string;
  }) => Promise<SignedIntentArtifact>;
  onSubmitIntent: (artifact: SignedIntentArtifact) => Promise<void>;
  relayerHealthy?: boolean;
  relayGraceSeconds?: number;
  onRelayIntent?: (artifact: SignedIntentArtifact) => Promise<void>;
}

const SLIPPAGE_PRESETS = [2, 5, 8, 12] as const;
const QUICK_PCT_CHIPS = [
  { label: '25%', frac: 0.25 },
  { label: '50%', frac: 0.5 },
  { label: '75%', frac: 0.75 },
  { label: '100%', frac: 1 },
] as const;

function computeDefaultLimitNum(spot: number, side: OrderSide, slippagePct: number): number {
  const safeSpot = Number.isFinite(spot) && spot > 0 ? spot : 3000;
  const tol = Math.max(0.5, Math.min(45, slippagePct)) / 100;
  const raw = side === 'SellBase' ? safeSpot * (1 - tol) : safeSpot * (1 + tol);
  return Math.max(0.01, Number(raw.toFixed(2)));
}

function formatLimitValue(val: number): string {
  if (!Number.isFinite(val) || val <= 0) return '0';
  return val.toFixed(2).replace(/\.00$/, '');
}

export const OrderTicket: React.FC<OrderTicketProps> = ({
  state,
  config,
  account,
  balances = null,
  localSecrets,
  busyAction,
  minBondWei,
  onConnect,
  onSubmitDirect,
  onSettleAndSubmitDirect,
  onSealCommit,
  onRevealCommit,
  onSignIntent,
  onSubmitIntent,
  relayerHealthy = false,
  relayGraceSeconds = 5,
  onRelayIntent,
}) => {
  const [activeTab, setActiveTab] = useState<TicketTab>('direct');
  const [side, setSide] = useState<OrderSide>('SellBase');
  const [amountInput, setAmountInput] = useState<string>('');
  const [amountTouched, setAmountTouched] = useState<boolean>(false);
  const [slippagePct, setSlippagePct] = useState<number>(8);
  const [limitEdited, setLimitEdited] = useState<boolean>(false);
  const [limitPriceInput, setLimitPriceInput] = useState<string>(() =>
    formatLimitValue(computeDefaultLimitNum(state.reserves.spot_price, 'SellBase', 8)),
  );

  // Commit-Reveal specific state
  const [salt, setSalt] = useState<string>(() => generateRandomSaltHex());
  const [bondEthInput, setBondEthInput] = useState<string>(() => {
    const minimum = Number(minBondWei) / 1e18;
    return String(Math.max(minimum, 0.001));
  });

  // EIP-712 Intent specific state
  const [signedArtifact, setSignedArtifact] =
    useState<SignedIntentArtifact | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [localFeedback, setLocalFeedback] = useState<string | null>(null);

  const defaultLimitNum = useMemo(
    () => computeDefaultLimitNum(state.reserves.spot_price, side, slippagePct),
    [state.reserves.spot_price, side, slippagePct],
  );

  // Auto-update limit price when spot, side, or slippage tolerance changes unless the user edited it.
  useEffect(() => {
    if (!limitEdited) {
      setLimitPriceInput(formatLimitValue(defaultLimitNum));
    }
  }, [defaultLimitNum, limitEdited]);

  const amountNum = Number.parseFloat(amountInput) || 0;
  const limitPriceNum = Number.parseFloat(limitPriceInput) || 0;
  const bondEthNum = Number.parseFloat(bondEthInput) || 0.001;

  const baseBalanceHuman = balances ? Number(formatUnits(balances.base, config.baseDecimals)) : 0;
  const quoteBalanceHuman = balances ? Number(formatUnits(balances.quote, config.quoteDecimals)) : 0;
  const ethBalanceHuman = balances ? Number(formatUnits(balances.eth, 18)) : 0;
  const activePayBalance = side === 'SellBase' ? baseBalanceHuman : quoteBalanceHuman;
  const activePaySymbol = side === 'SellBase' ? config.baseSymbol : config.quoteSymbol;
  const activePayKind = side === 'SellBase' ? 'base' : 'quote';
  const exceedsPayBalance = Boolean(
    account && balances && amountNum > 0 && amountNum > activePayBalance + 1e-9,
  );
  const showInsufficientPayError = Boolean(
    amountTouched && amountInput.trim() !== '' && exceedsPayBalance,
  );
  const insufficientGasEth = Boolean(account && balances && balances.eth === 0n);
  const insufficientBondEth = Boolean(
    account &&
      balances &&
      bondEthNum > 0 &&
      (bondEthNum > ethBalanceHuman + 1e-9 || ethBalanceHuman <= bondEthNum + 1e-9),
  );

  useEffect(() => {
    if (!localFeedback) return;
    const timer = window.setTimeout(() => setLocalFeedback(null), 8_000);
    return () => window.clearTimeout(timer);
  }, [localFeedback]);

  const applyBalanceFraction = (fraction: number) => {
    if (activePayBalance <= 0) return;
    const maxDecimals = side === 'SellBase' ? 4 : 2;
    const target = activePayBalance * fraction;
    const formatted = target
      .toFixed(maxDecimals)
      .replace(/(\.\d*?)0+$/, '$1')
      .replace(/\.$/, '');
    setAmountTouched(true);
    setAmountInput(formatted);
    setSignedArtifact(null);
  };

  const handleSetMax = () => {
    applyBalanceFraction(1);
  };

  const traderLabel = account ? shortenAddress(account) : 'Wallet not connected';

  const handleFlipSide = (nextSide: OrderSide) => {
    setSide(nextSide);
    setSignedArtifact(null);
    setAmountTouched(false);
    setAmountInput('');
    if (!limitEdited) {
      setLimitPriceInput(
        formatLimitValue(computeDefaultLimitNum(state.reserves.spot_price, nextSide, slippagePct)),
      );
    }
  };

  const isLimitInvalid =
    side === 'BuyBase' ? limitPriceNum <= 0 : limitPriceNum < 0;

  // Live equilibrium preview if this order were added to the active batch
  const preview = useMemo(() => {
    if (amountNum <= 0 || isLimitInvalid) return null;
    const hypotheticalOrder = {
      order_id: 999_999,
      trader: account ?? '0x0000000000000000000000000000000000000000',
      label: traderLabel,
      side,
      amount_in: amountNum,
      limit_price: limitPriceNum,
      submission_type: 'Direct' as const,
      is_attacker: false,
    };
    const sim = computeBatchSettlement(
      state.batch_id,
      state.reserves.rx,
      state.reserves.ry,
      [...state.orders, hypotheticalOrder],
    );
    const myFill = sim.fills.find((f) => f.order_id === 999_999);
    return {
      projectedClearingPrice: sim.clearing_price,
      myFill,
      cowRatioPct: sim.cow_ratio_pct,
    };
  }, [
    amountNum,
    isLimitInvalid,
    limitPriceNum,
    account,
    traderLabel,
    side,
    state.batch_id,
    state.reserves.rx,
    state.reserves.ry,
    state.orders,
  ]);

  const previewCommitHash = useMemo(
    () =>
      computeLocalCommitmentHash({
        batch_id: state.batch_id,
        trader: account ?? '0x0000000000000000000000000000000000000000',
        side,
        amount_in: amountNum,
        limit_price: limitPriceNum,
        salt,
        base_decimals: config.baseDecimals,
        quote_decimals: config.quoteDecimals,
      }),
    [
      state.batch_id,
      account,
      side,
      amountNum,
      limitPriceNum,
      salt,
      config.baseDecimals,
      config.quoteDecimals,
    ],
  );

  const requireWallet = (): boolean => {
    if (account) return true;
    setLocalError('Connect an injected wallet to sign this transaction.');
    return false;
  };

  const handleDirectSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError(null);
    setLocalFeedback(null);
    if (!requireWallet()) return;
    if (amountNum <= 0 || isLimitInvalid) {
      setLocalError(
        side === 'BuyBase'
          ? 'Amount and max buy limit price must be greater than zero.'
          : 'Amount must be > 0 and min sell limit price must be >= 0.',
      );
      return;
    }
    try {
      if (state.phase === 'Ready' && onSettleAndSubmitDirect) {
        await onSettleAndSubmitDirect({
          side,
          amountIn: amountInput,
          limitPrice: limitPriceInput,
        });
        setLocalFeedback('Settled previous batch & placed direct order in new batch.');
      } else {
        await onSubmitDirect({
          side,
          amountIn: amountInput,
          limitPrice: limitPriceInput,
        });
        setLocalFeedback('Direct limit order confirmed on-chain.');
      }
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Order failed');
    }
  };

  const handleCommitSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError(null);
    setLocalFeedback(null);
    if (!requireWallet()) return;
    if (amountNum <= 0 || isLimitInvalid) {
      setLocalError(
        side === 'BuyBase'
          ? 'Amount and max buy limit price must be greater than zero.'
          : 'Amount must be > 0 and min sell limit price must be >= 0.',
      );
      return;
    }
    if (bondEthNum <= 0 || bondEthNum * 1e18 < Number(minBondWei)) {
      setLocalError(
        `Reveal bond must be at least ${(Number(minBondWei) / 1e18).toFixed(4)} ETH.`,
      );
      return;
    }
    try {
      await onSealCommit({
        side,
        amountIn: amountInput,
        limitPrice: limitPriceInput,
        salt,
        bondEth: bondEthInput,
      });
      setSalt(generateRandomSaltHex());
      setLocalFeedback(
        'Sealed commitment confirmed. Reveal it in the reveal window to refund the bond.',
      );
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Commit failed');
    }
  };

  const handleSignIntent = async () => {
    setLocalError(null);
    setLocalFeedback(null);
    if (!requireWallet()) return;
    if (amountNum <= 0 || isLimitInvalid) {
      setLocalError(
        side === 'BuyBase'
          ? 'Amount and max buy limit price must be greater than zero.'
          : 'Amount must be > 0 and min sell limit price must be >= 0.',
      );
      return;
    }
    try {
      const artifact = await onSignIntent({
        side,
        amountIn: amountInput,
        limitPrice: limitPriceInput,
      });
      setSignedArtifact(artifact);
      setLocalFeedback('Signed EIP-712 SignedOrder typed data with the connected wallet.');
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'EIP-712 signing failed');
    }
  };

  const handleSubmitIntent = async () => {
    if (!signedArtifact) return;
    setLocalError(null);
    setLocalFeedback(null);
    try {
      await onSubmitIntent(signedArtifact);
      setSignedArtifact(null);
      setLocalFeedback('Verified signer and accepted the EIP-712 intent on-chain.');
    } catch (err) {
      setLocalError(
        err instanceof Error ? err.message : 'Intent submission failed',
      );
    }
  };

  const handleRelayIntent = async () => {
    if (!signedArtifact || !onRelayIntent) return;
    setLocalError(null);
    setLocalFeedback(null);
    try {
      await onRelayIntent(signedArtifact);
      setSignedArtifact(null);
      setLocalFeedback('Optional relayer submitted your signed EIP-712 intent on-chain.');
    } catch (err) {
      setLocalError(
        err instanceof Error
          ? `${err.message} You can click "Submit it myself" to send directly.`
          : 'Relayer submission failed. Click "Submit it myself" to send directly.',
      );
    }
  };

  const batchSecrets = localSecrets.filter(
    (s) => s.batch_id === state.batch_id,
  );
  const intentOpen = state.phase === 'Open' || state.phase === 'Reveal';

  return (
    <section
      aria-label="Order Entry Ticket"
      className="ledger-panel relative flex flex-col overflow-hidden"
    >
      {/* Slip masthead */}
      <div className="flex items-start justify-between gap-3 border-b border-rule px-4 py-3.5">
        <div className="min-w-0">
          <div className="eyebrow">Order slip · Batch No. {state.batch_id}</div>
          <h2 className="mt-1 font-display text-2xl font-bold leading-none tracking-tight text-ink">
            {side === 'SellBase' ? `Sell ${config.baseSymbol}` : `Buy ${config.baseSymbol}`}
          </h2>
          <p className="mt-1.5 text-[11px] leading-relaxed text-ink-muted">
            Every order in this batch clears at one uniform price.
          </p>
        </div>
        <span
          className={`stamp shrink-0 ${
            state.phase === 'Reveal'
              ? 'stamp-brass'
              : state.phase === 'Settled'
                ? 'stamp-pine'
                : ''
          }`}
        >
          {state.phase === 'Open'
            ? 'OPEN'
            : state.phase === 'Reveal'
              ? 'REVEAL'
              : state.phase === 'Ready'
                ? 'READY'
                : 'CLEARED'}
        </span>
      </div>

      {/* Three submission channels */}
      <div
        role="tablist"
        aria-label="Order Submission Modes"
        className="grid grid-cols-3 border-b border-rule bg-paper-soft/60"
      >
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'direct'}
          onClick={() => {
            setActiveTab('direct');
            setLocalError(null);
            setLocalFeedback(null);
          }}
          className={`relative flex flex-col items-start gap-0.5 px-2 py-2 text-left transition ${
            activeTab === 'direct'
              ? 'bg-paper-bright text-ink'
              : 'text-ink-muted hover:bg-paper-bright/70 hover:text-ink'
          }`}
        >
          {activeTab === 'direct' && (
            <span className="absolute inset-x-0 top-0 h-[2px] bg-vermilion-500" />
          )}
          <span className="flex items-center gap-1 whitespace-nowrap font-mono text-[9px] font-bold uppercase tracking-[0.02em]">
            <Send className="h-3 w-3" aria-hidden="true" />
            Direct
          </span>
          <span className="mt-0.5 font-mono text-[8px] tracking-[0.02em] text-ink-faint">01 · LIMIT</span>
        </button>

        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'commit_reveal'}
          onClick={() => {
            setActiveTab('commit_reveal');
            setLocalError(null);
            setLocalFeedback(null);
          }}
          className={`relative flex flex-col items-start gap-0.5 border-x border-rule px-2 py-2 text-left transition ${
            activeTab === 'commit_reveal'
              ? 'bg-paper-bright text-ink'
              : 'text-ink-muted hover:bg-paper-bright/70 hover:text-ink'
          }`}
        >
          {activeTab === 'commit_reveal' && (
            <span className="absolute inset-x-0 top-0 h-[2px] bg-brass-500" />
          )}
          <span className="flex items-center gap-1 whitespace-nowrap font-mono text-[9px] font-bold uppercase tracking-[0.02em]">
            <Lock className="h-3 w-3" aria-hidden="true" />
            Commit-Reveal
          </span>
          <span className="mt-0.5 font-mono text-[8px] tracking-[0.02em] text-ink-faint">02 · HASH</span>
        </button>

        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'eip712'}
          onClick={() => {
            setActiveTab('eip712');
            setLocalError(null);
            setLocalFeedback(null);
          }}
          className={`relative flex flex-col items-start gap-0.5 px-2 py-2 text-left transition ${
            activeTab === 'eip712'
              ? 'bg-paper-bright text-ink'
              : 'text-ink-muted hover:bg-paper-bright/70 hover:text-ink'
          }`}
        >
          {activeTab === 'eip712' && (
            <span className="absolute inset-x-0 top-0 h-[2px] bg-cobalt-600" />
          )}
          <span className="flex items-center gap-1 whitespace-nowrap font-mono text-[9px] font-bold uppercase tracking-[0.02em]">
            <FileSignature className="h-3 w-3" aria-hidden="true" />
            EIP-712 Intent
          </span>
          <span className="mt-0.5 font-mono text-[8px] tracking-[0.02em] text-ink-faint">03 · SIGNED</span>
        </button>
      </div>

      <div className="space-y-4 p-4">
        {!account && (
          <div className="flex flex-wrap items-center justify-between gap-2 border border-brass-500/50 bg-brass-50/70 px-3 py-2">
            <p className="text-[10.5px] leading-snug text-brass-900">
              Read-only preview. Connect a wallet to sign real orders and commitments.
            </p>
            <button
              type="button"
              onClick={() => void onConnect()}
              disabled={busyAction !== null}
              className="border border-brass-600 bg-paper-bright px-2.5 py-1 font-mono text-[9px] font-bold uppercase tracking-[0.06em] text-brass-800 transition hover:bg-brass-100 disabled:opacity-40"
            >
              Connect
            </button>
          </div>
        )}
        {/* Side switch */}
        <div className="grid grid-cols-2 border border-rule-strong bg-paper-soft p-1">
          <button
            type="button"
            onClick={() => handleFlipSide('SellBase')}
            aria-pressed={side === 'SellBase'}
            className={`flex items-center justify-center gap-1.5 py-2 text-[11px] font-bold transition ${
              side === 'SellBase'
                ? 'bg-vermilion-500 text-paper'
                : 'text-ink-muted hover:text-ink'
            }`}
          >
            <ArrowDownUp className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Sell {config.baseSymbol} → {config.quoteSymbol}</span>
          </button>
          <button
            type="button"
            onClick={() => handleFlipSide('BuyBase')}
            aria-pressed={side === 'BuyBase'}
            className={`flex items-center justify-center gap-1.5 py-2 text-[11px] font-bold transition ${
              side === 'BuyBase'
                ? 'bg-pine-600 text-paper'
                : 'text-ink-muted hover:text-ink'
            }`}
          >
            <ArrowDownUp className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Buy {config.baseSymbol} ← {config.quoteSymbol}</span>
          </button>
        </div>

        {/* Amount */}
        <div>
          <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
            <label htmlFor="ticket-amount-input" className="eyebrow">
              You pay
            </label>
            <span
              data-testid="order-ticket-balance"
              className="font-mono text-[11px] text-ink-muted tabular-nums"
            >
              Balance:{' '}
              <strong className="text-ink">
                {formatTokenAmount(activePayBalance, activePayKind)} {activePaySymbol}
              </strong>
            </span>
          </div>
          <div
            data-testid="order-ticket-quick-chips"
            className="mt-1.5 grid grid-cols-5 gap-1"
          >
            {QUICK_PCT_CHIPS.map((chip) => (
              <button
                key={chip.label}
                type="button"
                data-testid={`order-ticket-pct-${Math.round(chip.frac * 100)}`}
                disabled={activePayBalance <= 0}
                onClick={() => applyBalanceFraction(chip.frac)}
                className="min-h-[28px] whitespace-nowrap border border-rule bg-paper-bright px-1 py-0.5 text-center font-mono text-[10px] text-ink-muted transition hover:border-ink hover:text-ink disabled:opacity-40"
              >
                {chip.label}
              </button>
            ))}
            <button
              type="button"
              data-testid="order-ticket-max"
              onClick={handleSetMax}
              disabled={activePayBalance <= 0}
              className="min-h-[28px] whitespace-nowrap border border-rule-strong bg-paper-bright px-1 py-0.5 text-center font-mono text-[10px] font-bold text-vermilion-700 transition hover:border-vermilion-600 disabled:opacity-40"
            >
              Max
            </button>
          </div>
          <div className="mt-1.5 flex items-baseline gap-2 border-b-2 border-ink pb-1">
            <input
              id="ticket-amount-input"
              type="number"
              step="any"
              min="0"
              placeholder="0.00"
              value={amountInput}
              onChange={(e) => {
                setAmountTouched(true);
                setAmountInput(e.target.value);
                setSignedArtifact(null);
              }}
              className="w-full bg-transparent font-display text-[2.15rem] font-bold leading-none tracking-tight text-ink tabular-nums placeholder:text-ink-faint focus:outline-none"
            />
            <span className="shrink-0 font-mono text-[11px] font-bold uppercase tracking-label text-ink-muted">
              {side === 'SellBase' ? config.baseSymbol : config.quoteSymbol}
            </span>
          </div>
          {showInsufficientPayError && (
            <p
              role="alert"
              data-testid="order-ticket-insufficient-balance"
              className="mt-1.5 font-mono text-xs font-bold text-vermilion-700"
            >
              Insufficient {activePaySymbol} balance ({formatTokenAmount(activePayBalance, activePayKind)})
            </p>
          )}
          {insufficientGasEth && (
            <p
              role="alert"
              data-testid="order-ticket-insufficient-gas"
              className="mt-1 font-mono text-xs font-bold text-vermilion-700"
            >
              Insufficient Sepolia ETH for gas ({formatTokenAmount(ethBalanceHuman, 'eth')} ETH)
            </p>
          )}
        </div>

        {/* Limit price */}
        <div className="ledger-inset px-3 py-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label htmlFor="ticket-limit-input" className="eyebrow">
              {side === 'SellBase' ? 'Minimum price' : 'Maximum price'}
            </label>
            <button
              type="button"
              data-testid="order-ticket-limit-badge"
              onClick={() => {
                setLimitEdited(false);
                setLimitPriceInput(formatLimitValue(defaultLimitNum));
                setSignedArtifact(null);
              }}
              className="font-mono text-[10px] text-vermilion-600 underline decoration-dotted underline-offset-2 transition hover:text-vermilion-700"
            >
              {limitEdited
                ? `Custom ($${formatPrice(limitPriceNum, 2)}) · Reset Spot ${
                    side === 'SellBase' ? '−' : '+'
                  }${slippagePct}% ($${formatPrice(defaultLimitNum, 2)})`
                : `Spot ${side === 'SellBase' ? '−' : '+'}${slippagePct}% · $${formatPrice(
                    limitPriceNum,
                    2,
                  )}`}
            </button>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1">
            {SLIPPAGE_PRESETS.map((pct) => (
              <button
                key={pct}
                type="button"
                data-testid={`order-ticket-slippage-${pct}`}
                aria-pressed={!limitEdited && slippagePct === pct}
                onClick={() => {
                  setSlippagePct(pct);
                  setLimitEdited(false);
                  setLimitPriceInput(
                    formatLimitValue(
                      computeDefaultLimitNum(state.reserves.spot_price, side, pct),
                    ),
                  );
                  setSignedArtifact(null);
                }}
                className={`border px-1.5 py-0.5 font-mono text-[10px] font-bold transition ${
                  !limitEdited && slippagePct === pct
                    ? 'border-ink bg-ink text-paper'
                    : 'border-rule bg-paper-bright text-ink-muted hover:border-ink hover:text-ink'
                }`}
              >
                {side === 'SellBase' ? `−${pct}%` : `+${pct}%`}
              </button>
            ))}
          </div>
          <div className="mt-1.5 flex items-baseline gap-2">
            <input
              id="ticket-limit-input"
              type="number"
              step="any"
              min="0"
              value={limitPriceInput}
              onChange={(e) => {
                setLimitEdited(true);
                setLimitPriceInput(e.target.value);
                setSignedArtifact(null);
              }}
              className="w-full bg-transparent font-mono text-lg font-bold text-ink tabular-nums focus:outline-none"
            />
            <span className="shrink-0 font-mono text-[10px] uppercase tracking-label text-ink-muted">
              {config.quoteSymbol} / {config.baseSymbol}
            </span>
          </div>
        </div>

        {/* Clearing preview (Bug 1d: explicitly labeled With your order vs Current queue) */}
        {preview && (
          <div className="border-t border-dashed border-rule-strong pt-3">
            <div className="flex items-baseline justify-between gap-2">
              <span className="eyebrow flex items-center gap-1">
                <span>With your order (projected p*)</span>
                <InfoTooltip label="Clearing price p*" text={PRO_TOOLTIPS.pStar} />
              </span>
              <span className="font-mono text-base font-bold text-vermilion-600 tabular-nums">
                ${formatPrice(preview.projectedClearingPrice, 2)}
              </span>
            </div>
            <div className="mt-1.5 flex items-baseline justify-between gap-2 text-xs text-ink-muted">
              <span className="flex items-center gap-1">
                <span>Estimated fill</span>
                <InfoTooltip label="Pro-rata fill" text={PRO_TOOLTIPS.proRata} />
              </span>
              <span className="text-right font-mono font-semibold text-ink tabular-nums">
                {preview.myFill?.status === 'Filled'
                  ? `100% → ${formatTokenAmount(
                      preview.myFill.payout_out,
                      side === 'SellBase' ? 'quote' : 'base',
                    )} ${side === 'SellBase' ? config.quoteSymbol : config.baseSymbol}`
                  : preview.myFill?.status === 'PartialFill'
                    ? `Pro-rata → ${formatTokenAmount(
                        preview.myFill.payout_out,
                        side === 'SellBase' ? 'quote' : 'base',
                      )} ${side === 'SellBase' ? config.quoteSymbol : config.baseSymbol}`
                    : 'Out-of-the-money · full refund'}
              </span>
            </div>
            <div className="mt-2 flex items-center gap-2">
              <div className="clearing-line flex-1" />
              <span className="serial shrink-0">
                with order p* = ${formatPrice(preview.projectedClearingPrice, 2)}
              </span>
            </div>
          </div>
        )}

        {/* CHANNEL 01 — Direct limit */}
        {activeTab === 'direct' && (
          <form onSubmit={handleDirectSubmit}>
            <button
              type="submit"
              data-testid="order-ticket-direct-submit"
              disabled={
                (state.phase !== 'Open' &&
                  !(state.phase === 'Ready' && Boolean(onSettleAndSubmitDirect))) ||
                busyAction !== null ||
                amountNum <= 0 ||
                exceedsPayBalance ||
                insufficientGasEth
              }
              className="tap-target group flex w-full items-center justify-between bg-vermilion-500 px-4 py-3 text-left text-[#FBF8F0] transition hover:bg-vermilion-600 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <span className="font-display text-sm font-bold tracking-tight">
                {state.phase === 'Ready' && onSettleAndSubmitDirect
                  ? `Settle & submit direct ${side === 'SellBase' ? 'sell' : 'buy'} order`
                  : state.phase !== 'Open'
                    ? 'Direct orders close during Reveal — use EIP-712 tab'
                    : `Submit direct ${side === 'SellBase' ? 'sell' : 'buy'} order`}
              </span>
              <Send
                className="h-4 w-4 transition-transform group-hover:translate-x-0.5"
                aria-hidden="true"
              />
            </button>
          </form>
        )}

        {/* CHANNEL 02 — Sealed commit-reveal */}
        {activeTab === 'commit_reveal' && (
          <div className="space-y-3">
            <form onSubmit={handleCommitSubmit} className="space-y-3">
              <div className="border border-brass-500/50 bg-brass-50 p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-xs font-bold uppercase tracking-label text-brass-800">
                    Salt · 32-byte secret
                  </span>
                  <button
                    type="button"
                    onClick={() => setSalt(generateRandomSaltHex())}
                    className="inline-flex items-center gap-1 font-mono text-xs font-semibold text-brass-800 underline decoration-dotted underline-offset-2 hover:text-ink"
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                    <span>New salt</span>
                  </button>
                </div>
                <div className="mt-2 truncate border border-brass-500/30 bg-paper-bright px-2.5 py-1.5 font-mono text-xs text-ink-soft">
                  {salt}
                </div>

                <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <label
                      htmlFor="bond-eth-input"
                      className="flex items-center gap-1 text-xs font-bold text-ink-muted"
                    >
                      <span>Reveal bond (min 0.0001 ETH)</span>
                      <InfoTooltip label="Reveal bond" text={PRO_TOOLTIPS.revealBond} />
                    </label>
                    <div
                      data-testid="order-ticket-eth-balance"
                      className="mt-0.5 font-mono text-[10px] text-ink-muted tabular-nums"
                    >
                      ETH Balance:{' '}
                      <strong className="text-ink">{formatTokenAmount(ethBalanceHuman, 'eth')} ETH</strong>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <input
                      id="bond-eth-input"
                      type="number"
                      step="any"
                      min={0}
                      value={bondEthInput}
                      onChange={(e) => setBondEthInput(e.target.value)}
                      className="w-20 border border-rule-strong bg-paper-bright px-2 py-1 text-right font-mono text-xs font-bold text-brass-700"
                    />
                    <span className="font-mono text-[10px] uppercase tracking-label text-ink-muted">
                      ETH
                    </span>
                  </div>
                </div>

                {insufficientBondEth && (
                  <p
                    role="alert"
                    data-testid="order-ticket-insufficient-bond"
                    className="mt-1.5 font-mono text-xs font-bold text-vermilion-700"
                  >
                    {bondEthNum > ethBalanceHuman + 1e-9
                      ? `Insufficient ETH balance (${formatTokenAmount(ethBalanceHuman, 'eth')})`
                      : `Insufficient ETH balance (${formatTokenAmount(ethBalanceHuman, 'eth')}) for deposit + gas`}
                  </p>
                )}

                <div className="mt-2.5">
                  <div className="eyebrow">keccak256 commitment</div>
                  <div
                    data-testid="commitment-hash-preview"
                    className="mt-1 truncate border border-rule bg-paper-bright px-2.5 py-1.5 font-mono text-[10px] text-pine-700"
                  >
                    {account ? previewCommitHash : 'Connect wallet to derive hash'}
                  </div>
                </div>
              </div>

              <button
                type="submit"
                data-testid="order-ticket-commit-submit"
                disabled={
                  state.phase !== 'Open' ||
                  busyAction !== null ||
                  amountNum <= 0 ||
                  exceedsPayBalance ||
                  insufficientBondEth ||
                  insufficientGasEth
                }
                className="flex w-full items-center justify-between bg-brass-500 px-4 py-3 text-left text-paper shadow-glow-brass transition hover:bg-brass-600 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <span className="font-display text-sm font-bold tracking-tight">
                  {state.phase === 'Open'
                    ? `Seal & lock commitment · ${bondEthNum} ETH`
                    : 'Commit window closed'}
                </span>
                <Lock className="h-4 w-4" aria-hidden="true" />
              </button>
            </form>

            {(batchSecrets.length > 0 || state.commitments.length > 0) && (
              <div className="border border-rule bg-paper-soft p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-1.5 font-mono text-[10px] font-bold uppercase tracking-label text-ink-soft">
                    <KeyRound className="h-3.5 w-3.5 text-brass-600" />
                    Sealed commitments · Batch #{state.batch_id}
                  </span>
                  <span className="serial">PHASE {state.phase.toUpperCase()}</span>
                </div>

                <div className="mt-2 divide-y divide-rule/70">
                  {batchSecrets.map((sec) => {
                    const chainCommit = state.commitments.find(
                      (c) => c.commit_id === sec.commit_id,
                    );
                    const isRevealed = Boolean(
                      chainCommit?.revealed || sec.revealed,
                    );
                    return (
                      <div
                        key={sec.commit_id}
                        className="flex items-center justify-between gap-2 py-2"
                      >
                        <div className="min-w-0">
                          <div className="text-[11px] font-semibold text-ink">
                            #{sec.commit_id} ·{' '}
                            {sec.side === 'SellBase'
                              ? `Sell ${sec.amount_in} ${config.baseSymbol}`
                              : `Buy ${sec.amount_in} ${config.quoteSymbol}`}{' '}
                            @ ${sec.limit_price}
                          </div>
                          <div className="truncate font-mono text-[9px] text-ink-faint">
                            {sec.commitment_hash.slice(0, 18)}… · bond {sec.bond_eth} ETH
                          </div>
                        </div>

                        {isRevealed ? (
                          <span className="inline-flex shrink-0 items-center gap-1 border border-pine-600/40 bg-pine-50 px-2 py-1 font-mono text-[9px] font-bold uppercase tracking-label text-pine-700">
                            <CheckCircle2 className="h-3 w-3" />
                            <span>Revealed</span>
                          </span>
                        ) : (
                          <button
                            type="button"
                            disabled={
                              state.phase !== 'Reveal' || busyAction !== null
                            }
                            onClick={() => onRevealCommit(sec)}
                            title={
                              state.phase !== 'Reveal'
                                ? 'The reveal window is not open'
                                : 'Reveal the secret and refund the bond'
                            }
                            className="inline-flex shrink-0 items-center gap-1 bg-brass-500 px-2.5 py-1.5 text-[10px] font-bold text-paper transition hover:bg-brass-600 disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            <Eye className="h-3 w-3" />
                            <span>Reveal Secret</span>
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>

                {(state.phase === 'Open' || state.phase === 'Reveal') &&
                  batchSecrets.some((s) => !s.revealed) && (
                    <p className="mt-1 border-t border-rule/70 pt-2 text-[10px] leading-relaxed text-brass-700">
                      Reveal the secret during the reveal window to refund the bond.
                      Unrevealed commitments can be slashed after the deadline.
                    </p>
                  )}
              </div>
            )}
          </div>
        )}

        {/* CHANNEL 03 — EIP-712 signed intent */}
        {activeTab === 'eip712' && (
          <div className="space-y-3">
            <div className="border border-cobalt-500/40 bg-cobalt-50/60 p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-[10px] font-bold uppercase tracking-label text-cobalt-700">
                  SignedOrder typed data
                </span>
                <span className="border border-cobalt-600/40 bg-paper-bright px-1.5 py-0.5 font-mono text-[8.5px] font-bold uppercase tracking-[0.06em] text-cobalt-700">
                  EIP-712 · v1
                </span>
              </div>

              <div className="mt-2 space-y-1 border border-cobalt-500/30 bg-paper-bright p-2.5 font-mono text-[9px] text-ink-muted">
                <div className="flex justify-between gap-2">
                  <span>Domain</span>
                  <span className="text-ink">FairBatch · chain {config.chainId}</span>
                </div>
                <div className="flex justify-between gap-2">
                  <span>Verifying contract</span>
                  <span className="text-ink">{shortenAddress(config.fairBatch)}</span>
                </div>
                <div className="flex justify-between gap-2">
                  <span>Batch</span>
                  <span className="text-ink">#{state.batch_id}</span>
                </div>
                <div className="flex justify-between gap-2">
                  <span>Deadline</span>
                  <span className="text-ink">1 hour after signing</span>
                </div>
              </div>

              {signedArtifact && (
                <div
                  data-testid="eip712-signature-box"
                  className="mt-2 space-y-1 border border-cobalt-500/30 bg-paper-bright p-2.5 font-mono text-[9px]"
                >
                  <div className="flex justify-between gap-2 text-ink-muted">
                    <span>Recovered signer</span>
                    <span className="text-pine-700">
                      {shortenAddress(signedArtifact.trader)} · nonce #
                      {signedArtifact.nonce}
                    </span>
                  </div>
                  <div className="truncate text-cobalt-700">
                    Sig {signedArtifact.signature}
                  </div>
                </div>
              )}
            </div>

            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                disabled={
                  !intentOpen ||
                  busyAction !== null ||
                  amountNum <= 0 ||
                  exceedsPayBalance
                }
                onClick={handleSignIntent}
                className="border border-cobalt-600 px-3 py-2.5 text-[11px] font-bold text-cobalt-700 transition hover:bg-cobalt-50 disabled:opacity-40"
              >
                1. Sign EIP-712 Intent
              </button>
              {relayerHealthy && onRelayIntent ? (
                <button
                  type="button"
                  data-testid="pro-relay-intent-button"
                  disabled={
                    !signedArtifact ||
                    !intentOpen ||
                    busyAction !== null ||
                    exceedsPayBalance
                  }
                  onClick={handleRelayIntent}
                  className="bg-cobalt-600 px-3 py-2.5 text-[11px] font-bold text-paper shadow-glow-cobalt transition hover:bg-cobalt-700 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  2. Relay Intent (no submission gas)
                </button>
              ) : (
                <button
                  type="button"
                  disabled={
                    !signedArtifact ||
                    !intentOpen ||
                    busyAction !== null ||
                    exceedsPayBalance ||
                    insufficientGasEth
                  }
                  onClick={handleSubmitIntent}
                  className="bg-cobalt-600 px-3 py-2.5 text-[11px] font-bold text-paper shadow-glow-cobalt transition hover:bg-cobalt-700 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  2. Submit Signed Intent
                </button>
              )}
            </div>

            {relayerHealthy && onRelayIntent && (
              <div className="flex flex-wrap items-center justify-between gap-2 border border-cobalt-500/30 bg-paper-soft px-2.5 py-2">
                <span className="font-mono text-[10px] text-ink-soft">
                  Optional relayer waits ~{relayGraceSeconds}s so others can submit first. Cannot alter your signed order.
                </span>
                <button
                  type="button"
                  data-testid="pro-submit-intent-myself"
                  disabled={
                    !signedArtifact ||
                    !intentOpen ||
                    busyAction !== null ||
                    exceedsPayBalance ||
                    insufficientGasEth
                  }
                  onClick={handleSubmitIntent}
                  className="shrink-0 border border-rule-strong bg-paper-bright px-2.5 py-1 font-mono text-[10px] font-bold text-ink transition hover:border-ink disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Submit it myself
                </button>
              </div>
            )}

            <p className="font-mono text-[9.5px] leading-relaxed text-ink-muted">
              {intentOpen
                ? relayerHealthy
                  ? 'Signing is free and the optional relayer pays submission gas. You still pay Sepolia ETH gas for your one-time token approval, collecting payouts (claim), or if you click "Submit it myself".'
                  : 'Signed intents are accepted through the reveal deadline. You pay Sepolia ETH gas for one-time token approval, submission, and collecting payouts.'
                : 'The intent window is closed for this batch. Wait for the next batch after settlement.'}
            </p>
          </div>
        )}

        {localError && (
          <div
            role="alert"
            className="flex items-start gap-2 border-l-2 border-vermilion-500 bg-vermilion-50 px-3 py-2 text-[11px] text-vermilion-700"
          >
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{localError}</span>
          </div>
        )}

        {localFeedback && (
          <div className="flex items-start gap-2 border-l-2 border-pine-600 bg-pine-50 px-3 py-2 text-[11px] text-pine-700">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{localFeedback}</span>
          </div>
        )}

        {/* Queued ledger */}
        <div className="border-t border-rule pt-3">
          <div className="flex items-baseline justify-between gap-2">
            <span className="eyebrow">Queued in Batch #{state.batch_id}</span>
            <span
              data-testid="order-ticket-queued-summary"
              className="font-mono text-[10px] text-ink-faint tabular-nums"
            >
              {pluralize(state.orders.length, 'order')} ·{' '}
              {pluralize(state.commitments.filter((c) => !c.revealed).length, 'sealed commitment')}
            </span>
          </div>

          <div className="mt-2 max-h-48 overflow-y-auto">
            {state.orders.length === 0 ? (
              <div className="border border-dashed border-rule-strong py-4 text-center text-[11px] text-ink-faint">
                No revealed or signed orders in Batch #{state.batch_id} yet.
              </div>
            ) : (
              <div className="divide-y divide-rule/70">
                {state.orders.map((ord, idx) => (
                  <div
                    key={ord.order_id}
                    className={`flex items-center justify-between gap-2 py-1.5 ${
                      ord.is_attacker ? 'bg-vermilion-50/70' : ''
                    }`}
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="w-5 shrink-0 font-mono text-[9px] text-ink-faint">
                        {String(idx + 1).padStart(2, '0')}
                      </span>
                      <span className="truncate text-[11px] font-medium text-ink">
                        {ord.label}
                      </span>
                    </div>
                    <div className="flex shrink-0 items-center gap-2 font-mono text-[10px] tabular-nums">
                      <span
                        className={
                          ord.side === 'SellBase'
                            ? 'text-vermilion-600'
                            : 'text-pine-700'
                        }
                      >
                        {ord.side === 'SellBase'
                          ? `${formatSignedOrderAmount(ord.amount_in, 'base', '-')} ${config.baseSymbol}`
                          : `${formatSignedOrderAmount(ord.amount_in, 'quote', '+')} ${config.quoteSymbol}`}
                      </span>
                      <span className="border border-rule px-1 py-0.5 text-[8px] uppercase tracking-label text-ink-faint">
                        {ord.submission_type === 'Eip712Intent'
                          ? '712'
                          : ord.submission_type === 'CommitReveal'
                            ? 'C-R'
                            : 'DIR'}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="perforation border-t border-rule bg-paper-soft" />
    </section>
  );
};
