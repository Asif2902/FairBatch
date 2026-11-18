import React, { useMemo, useState } from 'react';
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
import type {
  HealthResponse,
  LocalSecretVaultEntry,
  OrderSide,
  SignedDemoIntentResponse,
  StateResponse,
} from '../types';
import { computeBatchSettlement } from '../lib/fallbackEngine';
import {
  buildEip712TypedData,
  computeLocalCommitmentHash,
  generateRandomSaltHex,
} from '../lib/keccak';
import { formatPrice, formatToken, shortenAddress } from '../lib/format';

type TicketTab = 'direct' | 'commit_reveal' | 'eip712';

interface OrderTicketProps {
  state: StateResponse;
  health: HealthResponse;
  selectedTraderAddress: string;
  localSecrets: LocalSecretVaultEntry[];
  busyAction: string | null;
  onSubmitDirect: (params: {
    trader: string;
    label?: string;
    side: OrderSide;
    amount_in: number;
    limit_price: number;
  }) => Promise<void>;
  onSealCommit: (params: {
    trader: string;
    label: string;
    side: OrderSide;
    amount_in: number;
    limit_price: number;
    salt: string;
    bond_eth: number;
  }) => Promise<void>;
  onRevealCommit: (secret: LocalSecretVaultEntry) => Promise<void>;
  onSignDemoIntent: (params: {
    demo_account_index: number;
    side: OrderSide;
    amount_in: number;
    limit_price: number;
    batch_id: number;
    deadline: number;
  }) => Promise<SignedDemoIntentResponse>;
  onSubmitSignedIntent: (params: {
    trader: string;
    label?: string;
    side: OrderSide;
    amount_in: number;
    limit_price: number;
    batch_id: number;
    nonce: number;
    deadline: number;
    signature: string;
  }) => Promise<void>;
}

export const OrderTicket: React.FC<OrderTicketProps> = ({
  state,
  health,
  selectedTraderAddress,
  localSecrets,
  busyAction,
  onSubmitDirect,
  onSealCommit,
  onRevealCommit,
  onSignDemoIntent,
  onSubmitSignedIntent,
}) => {
  const [activeTab, setActiveTab] = useState<TicketTab>('direct');
  const [side, setSide] = useState<OrderSide>('SellBase');
  const [amountInput, setAmountInput] = useState<string>('2.0');
  const [limitPriceInput, setLimitPriceInput] = useState<string>('2650');

  // Commit-Reveal specific state
  const [salt, setSalt] = useState<string>(() => generateRandomSaltHex());
  const [bondEthInput, setBondEthInput] = useState<string>('0.05');

  // EIP-712 Intent specific state
  const [signedArtifact, setSignedArtifact] =
    useState<SignedDemoIntentResponse | null>(null);
  const [showTypedJson, setShowTypedJson] = useState<boolean>(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [localFeedback, setLocalFeedback] = useState<string | null>(null);

  const amountNum = Number.parseFloat(amountInput) || 0;
  const limitPriceNum = Number.parseFloat(limitPriceInput) || 0;
  const bondEthNum = Number.parseFloat(bondEthInput) || 0.05;

  const activeWallet = useMemo(
    () =>
      state.demo_wallets.find(
        (w) => w.address.toLowerCase() === selectedTraderAddress.toLowerCase(),
      ),
    [state.demo_wallets, selectedTraderAddress],
  );

  const traderLabel = activeWallet
    ? activeWallet.name.split(' ')[0]
    : shortenAddress(selectedTraderAddress);

  const handleFlipSide = (nextSide: OrderSide) => {
    setSide(nextSide);
    setSignedArtifact(null);
    if (nextSide === 'SellBase') {
      setAmountInput('2.0');
      setLimitPriceInput(
        String(Math.max(1000, Math.round(state.reserves.spot_price * 0.9))),
      );
    } else {
      setAmountInput('6000');
      setLimitPriceInput(
        String(Math.round(state.reserves.spot_price * 1.1)),
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
      trader: selectedTraderAddress,
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
    selectedTraderAddress,
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
        trader: selectedTraderAddress,
        side,
        amount_in: amountNum,
        limit_price: limitPriceNum,
        salt,
      }),
    [state.batch_id, selectedTraderAddress, side, amountNum, limitPriceNum, salt],
  );

  const intentDeadline = useMemo(
    () => Math.floor(Date.now() / 1000) + 3600,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.batch_id, side, amountNum, limitPriceNum],
  );

  const eip712Payload = useMemo(
    () =>
      buildEip712TypedData({
        chain_id: health.chain_id || 11155111,
        verifying_contract:
          health.contracts.fair_batch ||
          '0x0000000000000000000000000000000000000000',
        trader: selectedTraderAddress,
        side,
        amount_in: amountNum,
        limit_price: limitPriceNum,
        batch_id: state.batch_id,
        nonce: signedArtifact?.nonce ?? 0,
        deadline: signedArtifact?.deadline ?? intentDeadline,
      }),
    [
      health.chain_id,
      health.contracts.fair_batch,
      selectedTraderAddress,
      side,
      amountNum,
      limitPriceNum,
      state.batch_id,
      signedArtifact,
      intentDeadline,
    ],
  );

  const handleDirectSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError(null);
    setLocalFeedback(null);
    if (amountNum <= 0 || isLimitInvalid) {
      setLocalError(
        side === 'BuyBase'
          ? 'Amount and max buy limit price must be greater than zero.'
          : 'Amount must be > 0 and min sell limit price must be >= 0.',
      );
      return;
    }
    try {
      await onSubmitDirect({
        trader: selectedTraderAddress,
        label: `${traderLabel} (Direct)`,
        side,
        amount_in: amountNum,
        limit_price: limitPriceNum,
      });
      setLocalFeedback('Direct limit order queued in current batch.');
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Order failed');
    }
  };

  const handleCommitSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError(null);
    setLocalFeedback(null);
    if (amountNum <= 0 || isLimitInvalid) {
      setLocalError(
        side === 'BuyBase'
          ? 'Amount and max buy limit price must be greater than zero.'
          : 'Amount must be > 0 and min sell limit price must be >= 0.',
      );
      return;
    }
    try {
      await onSealCommit({
        trader: selectedTraderAddress,
        label: `${traderLabel} (Sealed)`,
        side,
        amount_in: amountNum,
        limit_price: limitPriceNum,
        salt,
        bond_eth: bondEthNum,
      });
      setSalt(generateRandomSaltHex());
      setLocalFeedback(
        'Sealed commitment locked! Advance to Reveal phase to reveal secret.',
      );
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Commit failed');
    }
  };

  const handleSignIntent = async () => {
    setLocalError(null);
    setLocalFeedback(null);
    if (amountNum <= 0 || isLimitInvalid) {
      setLocalError(
        side === 'BuyBase'
          ? 'Amount and max buy limit price must be greater than zero.'
          : 'Amount must be > 0 and min sell limit price must be >= 0.',
      );
      return;
    }
    try {
      if (activeWallet) {
        const res = await onSignDemoIntent({
          demo_account_index: activeWallet.index,
          side,
          amount_in: amountNum,
          limit_price: limitPriceNum,
          batch_id: state.batch_id,
          deadline: intentDeadline,
        });
        setSignedArtifact(res);
        setLocalFeedback('Signed secp256k1 EIP-712 digest with Demo Wallet.');
      } else if (window.ethereum) {
        const sig = (await window.ethereum.request({
          method: 'eth_signTypedData_v4',
          params: [selectedTraderAddress, JSON.stringify(eip712Payload)],
        })) as string;
        setSignedArtifact({
          trader: selectedTraderAddress,
          nonce: 0,
          deadline: intentDeadline,
          signature: sig,
          digest: '0x' + 'e712'.repeat(16),
        });
        setLocalFeedback('Signed EIP-712 TypedData via Browser Wallet.');
      } else {
        const res = await onSignDemoIntent({
          demo_account_index: 0,
          side,
          amount_in: amountNum,
          limit_price: limitPriceNum,
          batch_id: state.batch_id,
          deadline: intentDeadline,
        });
        setSignedArtifact(res);
      }
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'EIP-712 signing failed');
    }
  };

  const handleSubmitIntent = async () => {
    if (!signedArtifact) return;
    setLocalError(null);
    setLocalFeedback(null);
    try {
      await onSubmitSignedIntent({
        trader: signedArtifact.trader,
        label: `${traderLabel} (EIP-712)`,
        side,
        amount_in: amountNum,
        limit_price: limitPriceNum,
        batch_id: signedArtifact.batch_id ?? state.batch_id,
        nonce: signedArtifact.nonce,
        deadline: signedArtifact.deadline,
        signature: signedArtifact.signature,
      });
      setSignedArtifact(null);
      setLocalFeedback('Verified secp256k1 signer & queued EIP-712 intent!');
    } catch (err) {
      setLocalError(
        err instanceof Error ? err.message : 'Intent submission failed',
      );
    }
  };

  const batchSecrets = localSecrets.filter(
    (s) => s.batch_id === state.batch_id,
  );

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
            {side === 'SellBase' ? 'Sell WETH' : 'Buy WETH'}
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
              ? 'SEALED'
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
            <span>Sell WETH → USDC</span>
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
            <span>Buy WETH ← USDC</span>
          </button>
        </div>

        {/* Amount */}
        <div>
          <div className="flex items-baseline justify-between gap-2">
            <label htmlFor="ticket-amount-input" className="eyebrow">
              You pay
            </label>
            <div className="flex gap-1">
              {(side === 'SellBase'
                ? ['1.0', '2.5', '5.0']
                : ['3000', '7500', '15000']
              ).map((presetVal) => (
                <button
                  key={presetVal}
                  type="button"
                  onClick={() => {
                    setAmountInput(presetVal);
                    setSignedArtifact(null);
                  }}
                  className="border border-rule bg-paper-bright px-1.5 py-0.5 font-mono text-[10px] text-ink-muted transition hover:border-ink hover:text-ink"
                >
                  {presetVal}
                </button>
              ))}
            </div>
          </div>
          <div className="mt-1.5 flex items-baseline gap-2 border-b-2 border-ink pb-1">
            <input
              id="ticket-amount-input"
              type="number"
              step="any"
              min="0"
              value={amountInput}
              onChange={(e) => {
                setAmountInput(e.target.value);
                setSignedArtifact(null);
              }}
              className="w-full bg-transparent font-display text-[2.15rem] font-bold leading-none tracking-tight text-ink tabular-nums focus:outline-none"
            />
            <span className="shrink-0 font-mono text-[11px] font-bold uppercase tracking-label text-ink-muted">
              {side === 'SellBase' ? 'WETH' : 'USDC'}
            </span>
          </div>
        </div>

        {/* Limit price */}
        <div className="ledger-inset px-3 py-2.5">
          <div className="flex items-center justify-between gap-2">
            <label htmlFor="ticket-limit-input" className="eyebrow">
              {side === 'SellBase' ? 'Minimum price' : 'Maximum price'}
            </label>
            <button
              type="button"
              onClick={() => {
                const factor = side === 'SellBase' ? 0.92 : 1.08;
                setLimitPriceInput(
                  String(Math.round(state.reserves.spot_price * factor)),
                );
                setSignedArtifact(null);
              }}
              className="font-mono text-[10px] text-vermilion-600 underline decoration-dotted underline-offset-2 transition hover:text-vermilion-700"
            >
              Spot ±8% · ${formatPrice(state.reserves.spot_price, 0)}
            </button>
          </div>
          <div className="mt-1 flex items-baseline gap-2">
            <input
              id="ticket-limit-input"
              type="number"
              step="any"
              min="0"
              value={limitPriceInput}
              onChange={(e) => {
                setLimitPriceInput(e.target.value);
                setSignedArtifact(null);
              }}
              className="w-full bg-transparent font-mono text-lg font-bold text-ink tabular-nums focus:outline-none"
            />
            <span className="shrink-0 font-mono text-[10px] uppercase tracking-label text-ink-muted">
              USDC / WETH
            </span>
          </div>
        </div>

        {/* Clearing preview */}
        {preview && (
          <div className="border-t border-dashed border-rule-strong pt-3">
            <div className="flex items-baseline justify-between gap-2">
              <span className="eyebrow">Projected uniform price</span>
              <span className="font-mono text-base font-bold text-vermilion-600 tabular-nums">
                ${formatPrice(preview.projectedClearingPrice, 2)}
              </span>
            </div>
            <div className="mt-1.5 flex items-baseline justify-between gap-2 text-[11px]">
              <span className="text-ink-muted">Estimated fill</span>
              <span className="text-right font-mono font-semibold text-ink tabular-nums">
                {preview.myFill?.status === 'Filled'
                  ? `100% → ${formatToken(preview.myFill.payout_out, 2)} ${
                      side === 'SellBase' ? 'USDC' : 'WETH'
                    }`
                  : preview.myFill?.status === 'PartialFill'
                    ? `Pro-rata → ${formatToken(preview.myFill.payout_out, 2)} ${
                        side === 'SellBase' ? 'USDC' : 'WETH'
                      }`
                    : 'Out-of-the-money · full refund'}
              </span>
            </div>
            <div className="mt-2 flex items-center gap-2">
              <div className="clearing-line flex-1" />
              <span className="serial shrink-0">
                p* = {formatPrice(preview.projectedClearingPrice, 2)}
              </span>
            </div>
          </div>
        )}

        {/* CHANNEL 01 — Direct limit */}
        {activeTab === 'direct' && (
          <form onSubmit={handleDirectSubmit}>
            <button
              type="submit"
              disabled={state.phase !== 'Open' || busyAction !== null}
              className="group flex w-full items-center justify-between bg-vermilion-500 px-4 py-3 text-left text-paper shadow-glow-vermilion transition hover:bg-vermilion-600 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <span className="font-display text-sm font-bold tracking-tight">
                {state.phase !== 'Open'
                  ? 'Direct orders need the open window'
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
              <div className="border border-brass-500/50 bg-brass-50/60 p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-[10px] font-bold uppercase tracking-label text-brass-700">
                    Salt · 32-byte secret
                  </span>
                  <button
                    type="button"
                    onClick={() => setSalt(generateRandomSaltHex())}
                    className="inline-flex items-center gap-1 font-mono text-[10px] font-semibold text-brass-700 underline decoration-dotted underline-offset-2 hover:text-brass-800"
                  >
                    <RefreshCw className="h-3 w-3" />
                    <span>New salt</span>
                  </button>
                </div>
                <div className="mt-2 truncate border border-brass-500/30 bg-paper-bright px-2.5 py-1.5 font-mono text-[10px] text-ink-soft">
                  {salt}
                </div>

                <div className="mt-2.5 flex items-center justify-between gap-2">
                  <label htmlFor="bond-eth-input" className="text-[11px] text-ink-muted">
                    Reveal bond
                  </label>
                  <div className="flex items-center gap-1.5">
                    <input
                      id="bond-eth-input"
                      type="number"
                      step="0.01"
                      min="0.01"
                      value={bondEthInput}
                      onChange={(e) => setBondEthInput(e.target.value)}
                      className="w-20 border border-rule-strong bg-paper-bright px-2 py-1 text-right font-mono text-xs font-bold text-brass-700"
                    />
                    <span className="font-mono text-[10px] uppercase tracking-label text-ink-muted">
                      ETH
                    </span>
                  </div>
                </div>

                <div className="mt-2.5">
                  <div className="eyebrow">keccak256 commitment</div>
                  <div
                    data-testid="commitment-hash-preview"
                    className="mt-1 truncate border border-rule bg-paper-bright px-2.5 py-1.5 font-mono text-[10px] text-pine-700"
                  >
                    {previewCommitHash}
                  </div>
                </div>
              </div>

              <button
                type="submit"
                disabled={state.phase !== 'Open' || busyAction !== null}
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
                              ? `Sell ${sec.amount_in} WETH`
                              : `Buy ${sec.amount_in} USDC`}{' '}
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
                                ? 'Advance to the reveal window first'
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

                {state.phase === 'Open' &&
                  batchSecrets.some((s) => !s.revealed) && (
                    <p className="mt-1 border-t border-rule/70 pt-2 text-[10px] leading-relaxed text-brass-700">
                      Advance to the reveal window to open the secret — or settle
                      directly to test bond slashing.
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
                <button
                  type="button"
                  onClick={() => setShowTypedJson(!showTypedJson)}
                  className="font-mono text-[10px] font-semibold text-cobalt-700 underline decoration-dotted underline-offset-2 hover:text-cobalt-800"
                >
                  {showTypedJson ? 'Hide JSON' : 'Inspect JSON'}
                </button>
              </div>

              {showTypedJson && (
                <pre className="mt-2 max-h-40 overflow-auto border border-cobalt-500/30 bg-paper-bright p-2 font-mono text-[9px] leading-relaxed text-ink-soft">
                  {JSON.stringify(eip712Payload, null, 2)}
                </pre>
              )}

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
                disabled={busyAction !== null}
                onClick={handleSignIntent}
                className="border border-cobalt-600 px-3 py-2.5 text-[11px] font-bold text-cobalt-700 transition hover:bg-cobalt-50 disabled:opacity-40"
              >
                1. Sign EIP-712 Intent
              </button>
              <button
                type="button"
                disabled={!signedArtifact || busyAction !== null}
                onClick={handleSubmitIntent}
                className="bg-cobalt-600 px-3 py-2.5 text-[11px] font-bold text-paper shadow-glow-cobalt transition hover:bg-cobalt-700 disabled:cursor-not-allowed disabled:opacity-40"
              >
                2. Submit Signed Intent
              </button>
            </div>
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
            <span className="font-mono text-[10px] text-ink-faint tabular-nums">
              {state.orders.length} orders ·{' '}
              {state.commitments.filter((c) => !c.revealed).length} sealed
            </span>
          </div>

          <div className="mt-2 max-h-48 overflow-y-auto">
            {state.orders.length === 0 ? (
              <div className="border border-dashed border-rule-strong py-4 text-center text-[11px] text-ink-faint">
                No revealed orders yet. Load a scenario or submit above.
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
                          ? `−${formatToken(ord.amount_in, 2)} WETH`
                          : `+${formatPrice(ord.amount_in, 0)} USDC`}
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
