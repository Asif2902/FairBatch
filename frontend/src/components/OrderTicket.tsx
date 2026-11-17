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
  Sparkles,
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
      className="flex flex-col rounded-2xl border border-slate-800/90 bg-[#0D1321]/95 shadow-xl"
    >
      {/* 3-Mode Tab Header */}
      <div
        role="tablist"
        aria-label="Order Submission Modes"
        className="grid grid-cols-3 border-b border-slate-800 bg-[#090D16]/70 p-1.5 rounded-t-2xl gap-1"
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
          className={`flex items-center justify-center gap-1.5 rounded-xl px-2 py-2 text-xs font-bold transition ${
            activeTab === 'direct'
              ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/40'
              : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-200'
          }`}
        >
          <Send className="h-3.5 w-3.5" aria-hidden="true" />
          <span>Direct Limit</span>
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
          className={`flex items-center justify-center gap-1.5 rounded-xl px-2 py-2 text-xs font-bold transition ${
            activeTab === 'commit_reveal'
              ? 'bg-amber-500/15 text-amber-300 border border-amber-500/40'
              : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-200'
          }`}
        >
          <Lock className="h-3.5 w-3.5" aria-hidden="true" />
          <span>Commit-Reveal</span>
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
          className={`flex items-center justify-center gap-1.5 rounded-xl px-2 py-2 text-xs font-bold transition ${
            activeTab === 'eip712'
              ? 'bg-cyan-500/15 text-cyan-300 border border-cyan-500/40'
              : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-200'
          }`}
        >
          <FileSignature className="h-3.5 w-3.5" aria-hidden="true" />
          <span>EIP-712 Intent</span>
        </button>
      </div>

      <div className="space-y-4 p-4">
        {/* Direction Switch */}
        <div className="grid grid-cols-2 gap-2 rounded-xl border border-slate-800 bg-[#090D16] p-1">
          <button
            type="button"
            onClick={() => handleFlipSide('SellBase')}
            aria-pressed={side === 'SellBase'}
            className={`flex items-center justify-center gap-1.5 rounded-lg py-2 text-xs font-bold transition ${
              side === 'SellBase'
                ? 'bg-emerald-500 text-slate-950 shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <ArrowDownUp className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Sell WETH → USDC</span>
          </button>
          <button
            type="button"
            onClick={() => handleFlipSide('BuyBase')}
            aria-pressed={side === 'BuyBase'}
            className={`flex items-center justify-center gap-1.5 rounded-lg py-2 text-xs font-bold transition ${
              side === 'BuyBase'
                ? 'bg-cyan-400 text-slate-950 shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <ArrowDownUp className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Buy WETH ← USDC</span>
          </button>
        </div>

        {/* Shared Amount + Limit Price Inputs */}
        <div className="space-y-3">
          <div>
            <div className="mb-1 flex items-center justify-between text-xs">
              <label htmlFor="ticket-amount-input" className="font-medium text-slate-300">
                Input Amount ({side === 'SellBase' ? 'WETH' : 'USDC'})
              </label>
              <div className="flex gap-1">
                {(side === 'SellBase' ? ['1.0', '2.5', '5.0'] : ['3000', '7500', '15000']).map(
                  (presetVal) => (
                    <button
                      key={presetVal}
                      type="button"
                      onClick={() => {
                        setAmountInput(presetVal);
                        setSignedArtifact(null);
                      }}
                      className="rounded border border-slate-700/80 bg-slate-800/80 px-1.5 py-0.5 font-mono text-[10px] text-slate-300 hover:border-slate-600 hover:text-white"
                    >
                      {presetVal}
                    </button>
                  ),
                )}
              </div>
            </div>
            <div className="relative">
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
                className="w-full rounded-xl border border-slate-700/90 bg-[#090D16] px-3.5 py-2.5 pr-16 font-mono text-sm font-semibold text-white tabular-nums focus:border-emerald-400 focus:outline-none"
              />
              <span className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 font-mono text-xs font-bold text-slate-400">
                {side === 'SellBase' ? 'WETH' : 'USDC'}
              </span>
            </div>
          </div>

          <div>
            <div className="mb-1 flex items-center justify-between text-xs">
              <label htmlFor="ticket-limit-input" className="font-medium text-slate-300">
                {side === 'SellBase'
                  ? 'Min Execution Price (Limit USDC/WETH)'
                  : 'Max Execution Price (Limit USDC/WETH)'}
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
                className="font-mono text-[10px] text-cyan-400 hover:underline"
              >
                ±8% of Spot (${formatPrice(state.reserves.spot_price, 0)})
              </button>
            </div>
            <div className="relative">
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
                className="w-full rounded-xl border border-slate-700/90 bg-[#090D16] px-3.5 py-2.5 pr-24 font-mono text-sm font-semibold text-white tabular-nums focus:border-emerald-400 focus:outline-none"
              />
              <span className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 font-mono text-[11px] font-semibold text-slate-400">
                USDC/WETH
              </span>
            </div>
          </div>
        </div>

        {/* Live Equilibrium Preview Box */}
        {preview && (
          <div className="rounded-xl border border-slate-800 bg-[#111827]/90 p-3 text-xs space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1 text-slate-400">
                <Sparkles className="h-3.5 w-3.5 text-emerald-400" />
                <span>Projected Uniform Price p*:</span>
              </span>
              <span className="font-mono font-bold text-emerald-300 tabular-nums">
                ${formatPrice(preview.projectedClearingPrice, 2)} USDC
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-slate-400">Estimated Fill Outcome:</span>
              <span className="font-mono font-semibold text-slate-100 tabular-nums">
                {preview.myFill?.status === 'Filled'
                  ? `100% Fill → ${formatToken(preview.myFill.payout_out, 2)} ${
                      side === 'SellBase' ? 'USDC' : 'WETH'
                    }`
                  : preview.myFill?.status === 'PartialFill'
                    ? `Pro-Rata Partial → ${formatToken(preview.myFill.payout_out, 2)} ${
                        side === 'SellBase' ? 'USDC' : 'WETH'
                      }`
                    : 'Out-of-the-Money (100% Refunded)'}
              </span>
            </div>
          </div>
        )}

        {/* TAB A: Direct Limit Order */}
        {activeTab === 'direct' && (
          <form onSubmit={handleDirectSubmit} className="space-y-3">
            <button
              type="submit"
              disabled={state.phase !== 'Open' || busyAction !== null}
              className="w-full rounded-xl bg-emerald-500 py-2.5 text-xs font-bold text-slate-950 shadow-glow-emerald transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {state.phase !== 'Open'
                ? 'Direct Orders Require Open Phase (Use Intent or Reveal)'
                : `Submit Direct ${side === 'SellBase' ? 'Sell' : 'Buy'} Order`}
            </button>
          </form>
        )}

        {/* TAB B: Sealed Commit-Reveal */}
        {activeTab === 'commit_reveal' && (
          <div className="space-y-3">
            <form onSubmit={handleCommitSubmit} className="space-y-3">
              <div className="rounded-xl border border-amber-500/25 bg-amber-500/[0.06] p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-semibold text-amber-300">
                    Cryptographic Salt (32-byte secret)
                  </span>
                  <button
                    type="button"
                    onClick={() => setSalt(generateRandomSaltHex())}
                    className="inline-flex items-center gap-1 text-[10px] font-semibold text-amber-300 hover:underline"
                  >
                    <RefreshCw className="h-3 w-3" />
                    <span>New Salt</span>
                  </button>
                </div>
                <div className="truncate rounded bg-[#090D16] px-2.5 py-1.5 font-mono text-[11px] text-slate-300">
                  {salt}
                </div>

                <div className="flex items-center justify-between pt-1">
                  <label
                    htmlFor="bond-eth-input"
                    className="text-[11px] text-slate-400"
                  >
                    Anti-Free-Option Reveal Bond (ETH):
                  </label>
                  <input
                    id="bond-eth-input"
                    type="number"
                    step="0.01"
                    min="0.01"
                    value={bondEthInput}
                    onChange={(e) => setBondEthInput(e.target.value)}
                    className="w-24 rounded border border-slate-700 bg-[#090D16] px-2 py-1 text-right font-mono text-xs text-amber-300"
                  />
                </div>

                <div className="pt-1">
                  <div className="text-[10px] uppercase tracking-wider text-slate-400">
                    keccak256 Commitment Hash
                  </div>
                  <div
                    data-testid="commitment-hash-preview"
                    className="mt-0.5 truncate rounded bg-[#090D16] px-2.5 py-1.5 font-mono text-[11px] text-emerald-300"
                  >
                    {previewCommitHash}
                  </div>
                </div>
              </div>

              <button
                type="submit"
                disabled={state.phase !== 'Open' || busyAction !== null}
                className="w-full rounded-xl border border-amber-400/50 bg-amber-500 py-2.5 text-xs font-bold text-slate-950 shadow-glow-amber transition hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {state.phase === 'Open'
                  ? `Seal & Lock Commitment (${bondEthNum} ETH Bond)`
                  : 'Commit Window Closed (Reveal Phase Active)'}
              </button>
            </form>

            {/* Local Unrevealed Secrets Vault */}
            {(batchSecrets.length > 0 || state.commitments.length > 0) && (
              <div className="rounded-xl border border-slate-800 bg-[#090D16] p-3 space-y-2">
                <div className="flex items-center justify-between text-xs font-bold text-slate-200">
                  <span className="flex items-center gap-1.5">
                    <KeyRound className="h-3.5 w-3.5 text-amber-400" />
                    <span>Sealed Commitments (Batch #{state.batch_id})</span>
                  </span>
                  <span className="font-mono text-[10px] text-slate-400">
                    Phase: {state.phase}
                  </span>
                </div>

                {batchSecrets.map((sec) => {
                  const chainCommit = state.commitments.find(
                    (c) => c.commit_id === sec.commit_id,
                  );
                  const isRevealed = Boolean(chainCommit?.revealed || sec.revealed);
                  return (
                    <div
                      key={sec.commit_id}
                      className="flex items-center justify-between gap-2 rounded-lg border border-slate-800 bg-[#111827] px-2.5 py-2 text-xs"
                    >
                      <div className="min-w-0">
                        <div className="font-semibold text-white">
                          #{sec.commit_id} ·{' '}
                          {sec.side === 'SellBase'
                            ? `Sell ${sec.amount_in} WETH`
                            : `Buy ${sec.amount_in} USDC`}{' '}
                          @ ${sec.limit_price}
                        </div>
                        <div className="truncate font-mono text-[10px] text-slate-400">
                          {sec.commitment_hash.slice(0, 18)}… · Bond {sec.bond_eth} ETH
                        </div>
                      </div>

                      {isRevealed ? (
                        <span className="inline-flex shrink-0 items-center gap-1 rounded bg-emerald-500/15 px-2 py-1 font-mono text-[10px] font-bold text-emerald-300">
                          <CheckCircle2 className="h-3 w-3" />
                          <span>Revealed</span>
                        </span>
                      ) : (
                        <button
                          type="button"
                          disabled={state.phase !== 'Reveal' || busyAction !== null}
                          onClick={() => onRevealCommit(sec)}
                          title={
                            state.phase !== 'Reveal'
                              ? 'Click Advance to Reveal in top bar first'
                              : 'Reveal secret & refund ETH bond'
                          }
                          className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-amber-400 px-2.5 py-1.5 text-[11px] font-bold text-slate-950 transition hover:bg-amber-300 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          <Eye className="h-3 w-3" />
                          <span>Reveal Secret</span>
                        </button>
                      )}
                    </div>
                  );
                })}

                {state.phase === 'Open' && batchSecrets.some((s) => !s.revealed) && (
                  <p className="text-[11px] text-amber-300/90">
                    Tip: Click <strong>&ldquo;Advance to Reveal&rdquo;</strong> in the top bar to open the reveal window (or settle directly to test unrevealed bond slashing!).
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        {/* TAB C: EIP-712 Signed Intent */}
        {activeTab === 'eip712' && (
          <div className="space-y-3">
            <div className="rounded-xl border border-cyan-500/25 bg-cyan-500/[0.06] p-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-semibold text-cyan-300">
                  EIP-712 `SignedOrder` TypedData
                </span>
                <button
                  type="button"
                  onClick={() => setShowTypedJson(!showTypedJson)}
                  className="text-[11px] font-semibold text-cyan-300 hover:underline"
                >
                  {showTypedJson ? 'Hide JSON' : 'Inspect JSON'}
                </button>
              </div>

              {showTypedJson && (
                <pre className="max-h-40 overflow-auto rounded bg-[#090D16] p-2 font-mono text-[10px] text-slate-300">
                  {JSON.stringify(eip712Payload, null, 2)}
                </pre>
              )}

              {signedArtifact && (
                <div
                  data-testid="eip712-signature-box"
                  className="space-y-1 rounded-lg border border-emerald-500/30 bg-[#090D16] p-2.5 font-mono text-[10px]"
                >
                  <div className="flex justify-between text-slate-400">
                    <span>Recovered Signer:</span>
                    <span className="text-emerald-300">
                      {shortenAddress(signedArtifact.trader)} (nonce #{signedArtifact.nonce})
                    </span>
                  </div>
                  <div className="truncate text-cyan-300">
                    Sig: {signedArtifact.signature}
                  </div>
                </div>
              )}
            </div>

            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                disabled={busyAction !== null}
                onClick={handleSignIntent}
                className="rounded-xl border border-cyan-400/50 bg-cyan-500/15 py-2.5 text-xs font-bold text-cyan-200 transition hover:bg-cyan-500/25 disabled:opacity-40"
              >
                1. Sign EIP-712 Intent
              </button>
              <button
                type="button"
                disabled={!signedArtifact || busyAction !== null}
                onClick={handleSubmitIntent}
                className="rounded-xl bg-cyan-400 py-2.5 text-xs font-bold text-slate-950 shadow-glow-cyan transition hover:bg-cyan-300 disabled:cursor-not-allowed disabled:opacity-40"
              >
                2. Submit Signed Intent
              </button>
            </div>
          </div>
        )}

        {localError && (
          <div
            role="alert"
            className="flex items-center gap-2 rounded-xl border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-300"
          >
            <ShieldAlert className="h-4 w-4 shrink-0" />
            <span>{localError}</span>
          </div>
        )}

        {localFeedback && (
          <div className="flex items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-300">
            <CheckCircle2 className="h-4 w-4 shrink-0" />
            <span>{localFeedback}</span>
          </div>
        )}

        {/* Queued Batch Orders Summary */}
        <div className="border-t border-slate-800 pt-3">
          <div className="mb-2 flex items-center justify-between text-xs">
            <span className="font-bold uppercase tracking-wider text-slate-400">
              Queued in Batch #{state.batch_id}
            </span>
            <span className="rounded bg-slate-800 px-2 py-0.5 font-mono text-[11px] text-slate-200 tabular-nums">
              {state.orders.length} Orders · {state.commitments.filter((c) => !c.revealed).length} Sealed
            </span>
          </div>

          <div className="max-h-48 space-y-1.5 overflow-y-auto pr-1">
            {state.orders.length === 0 ? (
              <div className="rounded-lg border border-dashed border-slate-800 py-4 text-center text-xs text-slate-500">
                No revealed orders in Batch #{state.batch_id} yet. Pick a preset or submit above.
              </div>
            ) : (
              state.orders.map((ord, idx) => (
                <div
                  key={ord.order_id}
                  className={`flex items-center justify-between rounded-lg border px-2.5 py-1.5 text-xs ${
                    ord.is_attacker
                      ? 'border-rose-500/40 bg-rose-500/10'
                      : 'border-slate-800/90 bg-[#111827]/70'
                  }`}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="font-mono text-[10px] text-slate-500">
                      #{idx + 1}
                    </span>
                    <span className="truncate font-medium text-slate-200">
                      {ord.label}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0 font-mono text-[11px] tabular-nums">
                    <span
                      className={
                        ord.side === 'SellBase'
                          ? 'text-emerald-300'
                          : 'text-cyan-300'
                      }
                    >
                      {ord.side === 'SellBase'
                        ? `-${formatToken(ord.amount_in, 2)} WETH`
                        : `+Buy ${formatPrice(ord.amount_in, 0)} USDC`}
                    </span>
                    <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400">
                      {ord.submission_type === 'Eip712Intent'
                        ? '712'
                        : ord.submission_type === 'CommitReveal'
                          ? 'C-R'
                          : 'DIR'}
                    </span>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </section>
  );
};
