import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Flame,
  FlaskConical,
  Scale,
  ShieldCheck,
  X,
} from 'lucide-react';
import type { OrderSide } from '../types';
import { runSandwichSimulation } from '../lib/clearingMath';
import { formatPrice, formatTokenAmount, formatUsd } from '../lib/format';

interface SandwichSimulationModalProps {
  isOpen: boolean;
  rx: number;
  ry: number;
  baseSymbol: string;
  quoteSymbol: string;
  onClose: () => void;
}

const SLIPPAGE_PRESETS = [2, 5, 8, 12] as const;

export const SandwichSimulationModal: React.FC<SandwichSimulationModalProps> = ({
  isOpen,
  rx,
  ry,
  baseSymbol,
  quoteSymbol,
  onClose,
}) => {
  const [side, setSide] = useState<OrderSide>('SellBase');
  const [amountInput, setAmountInput] = useState<string>('2');
  const [slippagePct, setSlippagePct] = useState<number>(8);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [isOpen, onClose]);

  const parsedAmount = Number(amountInput);
  const safeAmount =
    Number.isFinite(parsedAmount) && parsedAmount > 0
      ? parsedAmount
      : side === 'SellBase'
        ? 2
        : 6000;

  const sim = useMemo(
    () =>
      runSandwichSimulation({
        rx: Math.max(1, rx),
        ry: Math.max(1, ry),
        side,
        amountIn: safeAmount,
        slippagePct,
      }),
    [rx, ry, side, safeAmount, slippagePct],
  );

  if (!isOpen) return null;

  const outSym = side === 'SellBase' ? quoteSymbol : baseSymbol;
  const outKind = side === 'SellBase' ? 'quote' : 'base';
  const inSym = side === 'SellBase' ? baseSymbol : quoteSymbol;
  const botUnit = sim.frontRunIsBase ? baseSymbol : quoteSymbol;
  const botKind = sim.frontRunIsBase ? 'base' : 'quote';

  const fmtSignedUsd = (val: number) => `${val >= 0 ? '+' : ''}${formatUsd(val, 2)}`;
  const fmtSignedPct = (val: number) => `${val >= 0 ? '+' : ''}${val.toFixed(2)}%`;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="sandwich-sim-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-3 sm:p-4"
      onClick={onClose}
    >
      <div
        className="max-h-[92vh] w-full max-w-4xl overflow-y-auto border border-ink bg-paper-bright shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b-2 border-ink bg-paper px-5 py-4">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center border border-ink bg-plum-600 text-[#FBF8F0]">
              <FlaskConical className="h-5 w-5" aria-hidden="true" />
            </div>
            <div>
              <div className="eyebrow text-plum-700">Client-side simulation</div>
              <h2
                id="sandwich-sim-title"
                className="mt-1 font-display text-xl font-bold leading-tight text-ink"
              >
                Sandwich attack &amp; baseline comparison
              </h2>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close sandwich simulation modal"
            className="tap-target inline-flex w-11 items-center justify-center border border-rule-strong text-ink-muted transition hover:border-ink hover:text-ink"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-4 p-5">
          {/* Honest disclosure banner */}
          <div className="flex items-start gap-2.5 border-l-2 border-brass-600 bg-brass-50 px-3.5 py-2.5 text-sm text-brass-900">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-brass-700" />
            <div>
              <strong>Client-side simulation — not an on-chain result.</strong> Uses live Sepolia
              pool reserves ({formatTokenAmount(rx, 'base')} {baseSymbol} /{' '}
              {formatPrice(ry, 0)} {quoteSymbol}, spot ${formatPrice(sim.spot, 2)}) to compare a{' '}
              <strong>0.30% x·y=k AMM without an attacker</strong>, the same AMM under a{' '}
              <strong>slippage-capped sandwich bot</strong>, and{' '}
              <strong>FairBatch uniform clearing</strong> (<code>p* = (R_y + 2·D_y)/(R_x + 2·S_x)</code>).
            </div>
          </div>

          {/* Controls: Direction, Size, Slippage cap */}
          <div className="grid gap-3 md:grid-cols-3">
            <div className="border border-rule bg-paper-soft p-3">
              <span className="eyebrow block">Trade direction</span>
              <div className="mt-2 grid grid-cols-2 gap-1.5">
                <button
                  type="button"
                  aria-pressed={side === 'SellBase'}
                  onClick={() => {
                    setSide('SellBase');
                    setAmountInput('2');
                  }}
                  className={`tap-target border font-sans text-xs font-bold transition ${
                    side === 'SellBase'
                      ? 'border-vermilion-600 bg-vermilion-500 text-[#FBF8F0]'
                      : 'border-rule-strong bg-paper-bright text-ink-soft'
                  }`}
                >
                  Sell {baseSymbol}
                </button>
                <button
                  type="button"
                  aria-pressed={side === 'BuyBase'}
                  onClick={() => {
                    setSide('BuyBase');
                    setAmountInput('6000');
                  }}
                  className={`tap-target border font-sans text-xs font-bold transition ${
                    side === 'BuyBase'
                      ? 'border-pine-700 bg-pine-600 text-[#FBF8F0]'
                      : 'border-rule-strong bg-paper-bright text-ink-soft'
                  }`}
                >
                  Buy {baseSymbol}
                </button>
              </div>
            </div>

            <div className="border border-rule bg-paper-soft p-3">
              <label htmlFor="sim-amount-input" className="eyebrow block">
                Simulated trade size ({inSym})
              </label>
              <input
                id="sim-amount-input"
                type="number"
                step="any"
                min="0"
                value={amountInput}
                onChange={(e) => setAmountInput(e.target.value)}
                className="tap-target mt-1.5 w-full border border-rule-strong bg-paper-bright px-3 font-mono text-base font-bold text-ink tabular-nums"
              />
            </div>

            <div className="border border-rule bg-paper-soft p-3">
              <span className="eyebrow block">
                Slippage cap ({sim.slippagePct}% · {side === 'SellBase' ? 'min' : 'max'} $
                {formatPrice(sim.limitPrice, 2)})
              </span>
              <div className="mt-2 grid grid-cols-4 gap-1">
                {SLIPPAGE_PRESETS.map((pct) => (
                  <button
                    key={pct}
                    type="button"
                    data-testid={`sim-slippage-${pct}`}
                    aria-pressed={slippagePct === pct}
                    onClick={() => setSlippagePct(pct)}
                    className={`min-h-[38px] border font-mono text-xs font-bold transition ${
                      slippagePct === pct
                        ? 'border-ink bg-ink text-paper'
                        : 'border-rule-strong bg-paper-bright text-ink-soft hover:border-ink'
                    }`}
                  >
                    {pct}%
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* 3-column comparison: Plain AMM vs Sandwiched AMM vs FairBatch */}
          <div className="grid gap-3 md:grid-cols-3">
            {/* Column 1: Normal AMM, no attacker */}
            <div
              data-testid="sim-col-plain"
              className="border-2 border-cobalt-600/50 bg-cobalt-50/60 p-4"
            >
              <div className="flex items-center gap-2 font-mono text-xs font-bold uppercase text-cobalt-800">
                <Scale className="h-4 w-4 shrink-0 text-cobalt-700" />
                <span>Normal AMM, no attacker</span>
              </div>
              <div className="mt-1 font-mono text-[11px] text-ink-muted">
                0.30% fee · constant-product x·y=k
              </div>
              <dl className="mt-3 space-y-2 text-sm">
                <div className="flex justify-between gap-2">
                  <dt className="text-ink-muted">Effective price</dt>
                  <dd className="font-mono font-bold text-ink tabular-nums">
                    ${formatPrice(sim.ammPlainPrice, 2)}
                  </dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-ink-muted">You receive</dt>
                  <dd className="font-mono font-bold text-ink tabular-nums">
                    {formatTokenAmount(sim.ammPlainOut, outKind)} {outSym}
                  </dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-ink-muted">Baseline LP fee (0.30%)</dt>
                  <dd className="font-mono font-semibold text-ink-soft tabular-nums">
                    {formatUsd(sim.ammPlainLpFeeQuote, 2)}
                  </dd>
                </div>
                <div className="flex justify-between gap-2 border-t border-cobalt-600/25 pt-2">
                  <dt className="font-bold text-cobalt-900">Bot profit</dt>
                  <dd className="font-mono font-bold text-cobalt-900 tabular-nums">$0.00</dd>
                </div>
              </dl>
            </div>

            {/* Column 2: Normal AMM + slippage-capped sandwich bot */}
            <div
              data-testid="sim-col-attacked"
              className="border-2 border-vermilion-500/60 bg-vermilion-50 p-4"
            >
              <div className="flex items-center gap-2 font-mono text-xs font-bold uppercase text-vermilion-800">
                <Flame className="h-4 w-4 shrink-0 text-vermilion-600" />
                <span>Normal AMM + sandwich bot</span>
              </div>
              <div className="mt-1 font-mono text-[11px] text-ink-muted tabular-nums">
                Capped at {sim.slippagePct}% limit · bot size:{' '}
                {sim.botProfitable
                  ? `${formatTokenAmount(sim.frontRunAmount, botKind)} ${botUnit}`
                  : `0 ${botUnit} (unprofitable)`}
              </div>
              <dl className="mt-3 space-y-2 text-sm">
                <div className="flex justify-between gap-2">
                  <dt className="text-ink-muted">Your effective price</dt>
                  <dd className="font-mono font-bold text-ink tabular-nums">
                    ${formatPrice(sim.ammSandwichedPrice, 2)}
                  </dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-ink-muted">You receive</dt>
                  <dd className="font-mono font-bold text-ink tabular-nums">
                    {formatTokenAmount(sim.ammSandwichedOut, outKind)} {outSym}
                  </dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-ink-muted">Loss vs no-attack AMM</dt>
                  <dd className="font-mono font-semibold text-vermilion-800 tabular-nums">
                    {sim.victimLossVsPlainQuote > 0
                      ? `-${formatUsd(sim.victimLossVsPlainQuote, 2)}`
                      : '$0.00'}
                  </dd>
                </div>
                <div className="flex justify-between gap-2 border-t border-vermilion-500/30 pt-2">
                  <dt className="font-bold text-vermilion-800">Bot profit (pre-gas)</dt>
                  <dd className="font-mono font-bold text-vermilion-700 tabular-nums">
                    {formatUsd(sim.ammBotProfitQuote, 2)}
                  </dd>
                </div>
              </dl>
            </div>

            {/* Column 3: FairBatch uniform round */}
            <div
              data-testid="sim-col-fairbatch"
              className="border-2 border-pine-600/60 bg-pine-50 p-4"
            >
              <div className="flex items-center gap-2 font-mono text-xs font-bold uppercase text-pine-800">
                <ShieldCheck className="h-4 w-4 shrink-0 text-pine-700" />
                <span>FairBatch uniform round</span>
              </div>
              <div className="mt-1 font-mono text-[11px] text-ink-muted">
                0% swap fee · FM-AMM marginal price p*
              </div>
              <dl className="mt-3 space-y-2 text-sm">
                <div className="flex justify-between gap-2">
                  <dt className="text-ink-muted">Uniform fair price p*</dt>
                  <dd className="font-mono font-bold text-pine-800 tabular-nums">
                    ${formatPrice(sim.fairbatchPrice, 2)}
                  </dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-ink-muted">You receive</dt>
                  <dd className="font-mono font-bold text-pine-800 tabular-nums">
                    {formatTokenAmount(sim.fairbatchOut, outKind)} {outSym}
                  </dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-ink-muted">Vs no-attack AMM</dt>
                  <dd
                    className={`font-mono font-semibold tabular-nums ${
                      sim.fairbatchVsPlainQuote >= 0 ? 'text-pine-800' : 'text-brass-900'
                    }`}
                  >
                    {fmtSignedUsd(sim.fairbatchVsPlainQuote)} ({fmtSignedPct(sim.fairbatchVsPlainPct)})
                  </dd>
                </div>
                <div className="flex justify-between gap-2 border-t border-pine-600/30 pt-2">
                  <dt className="font-bold text-pine-800">Bot profit</dt>
                  <dd className="font-mono font-bold text-pine-800 tabular-nums">$0.00</dd>
                </div>
              </dl>
            </div>
          </div>

          {/* Exact reconciliation ledger */}
          <div
            data-testid="sandwich-reconciliation"
            className="space-y-2.5 border border-rule bg-paper-soft px-4 py-3.5 text-xs sm:text-sm"
          >
            <div className="eyebrow">Exact accounting breakdown{side === 'BuyBase' ? ' (valued at unattacked AMM price)' : ''}</div>

            {sim.victimExceedsSlippageWithoutAttack ? (
              <p className="text-brass-900">
                At this size, even an unattacked 0.30% AMM moves past your {sim.slippagePct}% limit
                (${formatPrice(sim.limitPrice, 2)}), so the AMM swap would revert and no sandwich
                fits. Lower the size or raise the slippage cap to inspect an executable attack.
              </p>
            ) : !sim.botProfitable ? (
              <p className="text-ink-soft">
                At this small trade size, the price impact is smaller than a bot&apos;s 0.60%
                round-trip AMM fees, so a sandwich bot earns <strong>$0.00</strong> (assumed front-run:{' '}
                <code>0 {botUnit}</code>). Notice FairBatch still charges 0% swap fee, giving{' '}
                <strong className="font-mono text-pine-800">
                  {fmtSignedUsd(sim.fairbatchVsPlainQuote)} ({fmtSignedPct(sim.fairbatchVsPlainPct)})
                </strong>{' '}
                vs. the unattacked 0.30% AMM.
              </p>
            ) : (
              <dl className="grid gap-1.5 font-mono text-xs tabular-nums">
                <div className="flex flex-wrap justify-between gap-2">
                  <dt className="font-sans text-ink-soft">
                    User loss to sandwich vs. no-attack AMM
                  </dt>
                  <dd className="font-bold text-vermilion-800">
                    -{formatUsd(sim.victimLossVsPlainQuote, 2)}
                  </dd>
                </div>
                <div className="flex flex-wrap justify-between gap-2 pl-4 text-ink-muted">
                  <dt className="font-sans">↳ Bot profit (before gas, front-run {formatTokenAmount(sim.frontRunAmount, botKind)} {botUnit})</dt>
                  <dd className="font-semibold text-vermilion-700">
                    {formatUsd(sim.ammBotProfitQuote, 2)}
                  </dd>
                </div>
                <div className="flex flex-wrap justify-between gap-2 pl-4 text-ink-muted">
                  <dt className="font-sans">
                    ↳ Extra LP fees / pool surplus from bot legs (+ {formatUsd(sim.ammPlainLpFeeQuote, 2)} baseline fee = {formatUsd(sim.totalSandwichedLpFeesQuote, 2)} total LP fees)
                  </dt>
                  <dd className="font-semibold text-ink">
                    {formatUsd(sim.extraLpFeesQuote, 2)}
                  </dd>
                </div>
                <div className="mt-1 flex flex-wrap justify-between gap-2 border-t border-rule pt-2">
                  <dt className="font-sans font-bold text-ink">
                    FairBatch payout minus attacked-AMM payout
                  </dt>
                  <dd
                    className={`font-bold ${
                      sim.fairbatchVsAttackedQuote >= 0 ? 'text-pine-800' : 'text-brass-900'
                    }`}
                  >
                    {fmtSignedUsd(sim.fairbatchVsAttackedQuote)}
                  </dd>
                </div>
                <div className="flex flex-wrap justify-between gap-2">
                  <dt className="font-sans font-bold text-ink">
                    FairBatch payout minus unattacked-AMM payout
                  </dt>
                  <dd
                    className={`font-bold ${
                      sim.fairbatchVsPlainQuote >= 0 ? 'text-pine-800' : 'text-brass-900'
                    }`}
                  >
                    {fmtSignedUsd(sim.fairbatchVsPlainQuote)} ({fmtSignedPct(sim.fairbatchVsPlainPct)})
                  </dd>
                </div>
              </dl>
            )}

            <p className="border-t border-rule pt-2 text-xs leading-relaxed text-ink-muted">
              <strong>Why FairBatch can be slightly lower than an unattacked AMM on a large
              one-sided swap:</strong> FairBatch&apos;s FM-AMM clears net one-sided flow at the
              post-trade marginal price <code>p* = (R_y + 2·D_y) / (R_x + 2·S_x)</code> so passive
              LPs capture the rebalancing surplus instead of arbitrageurs. When opposite-side orders
              join the same round, they match peer-to-peer (CoW) with zero price impact; on very
              small trades (&lt;0.30% impact), FairBatch&apos;s 0% swap fee beats the unattacked
              0.30% AMM.
            </p>
          </div>

          <div className="flex justify-end border-t border-rule pt-3">
            <button
              type="button"
              onClick={onClose}
              className="tap-target border border-ink bg-ink px-5 font-display text-sm font-bold text-paper transition hover:bg-ink-soft"
            >
              Close simulation
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
