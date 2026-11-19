import React, { useMemo, useState } from 'react';
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Coins,
  Droplets,
  Scale,
} from 'lucide-react';
import { formatUnits } from 'viem';
import type { RuntimeConfig } from '../onchain/config';
import type { RawReserves, WalletBalances } from '../onchain/state';
import { formatPrice, formatToken } from '../lib/format';

type LiquidityMode = 'add' | 'remove';

interface LiquidityPanelProps {
  config: RuntimeConfig;
  reserves: RawReserves;
  balances: WalletBalances | null;
  account: string | null;
  busyAction: string | null;
  onAddLiquidity: (amountBase: string, amountQuote: string) => Promise<void>;
  onRemoveLiquidity: (shares: string) => Promise<void>;
}

function human(raw: bigint, decimals: number): number {
  return Number(formatUnits(raw, decimals));
}

function trimAmount(value: number, decimals: number): string {
  if (!Number.isFinite(value) || value <= 0) return '';
  const fixed = value.toFixed(decimals);
  return fixed.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}

export const LiquidityPanel: React.FC<LiquidityPanelProps> = ({
  config,
  reserves,
  balances,
  account,
  busyAction,
  onAddLiquidity,
  onRemoveLiquidity,
}) => {
  const [mode, setMode] = useState<LiquidityMode>('add');
  const [baseInput, setBaseInput] = useState<string>('1');
  const [quoteInput, setQuoteInput] = useState<string>('3000');
  const [sharesInput, setSharesInput] = useState<string>('');
  const [localError, setLocalError] = useState<string | null>(null);

  const rx = human(reserves.reserveBase, config.baseDecimals);
  const ry = human(reserves.reserveQuote, config.quoteDecimals);
  const totalShares = human(reserves.totalShares, 18);
  const userShares = human(balances?.lpShares ?? 0n, 18);
  const spot = rx > 0 ? ry / rx : 0;
  const poolSharePct = totalShares > 0 ? (userShares / totalShares) * 100 : 0;

  const baseNum = Number(baseInput) || 0;
  const quoteNum = Number(quoteInput) || 0;
  const sharesNum = Number(sharesInput) || 0;

  const estimatedShares = useMemo(() => {
    if (totalShares <= 0 || rx <= 0 || ry <= 0) return null;
    if (baseNum <= 0 || quoteNum <= 0) return null;
    return Math.min(baseNum / rx, quoteNum / ry) * totalShares;
  }, [baseNum, quoteNum, rx, ry, totalShares]);

  const removePreview = useMemo(() => {
    if (sharesNum <= 0 || totalShares <= 0) return null;
    const fraction = Math.min(1, sharesNum / totalShares);
    return {
      base: fraction * rx,
      quote: fraction * ry,
      pct: fraction * 100,
    };
  }, [sharesNum, totalShares, rx, ry]);

  const busy = busyAction !== null;

  const matchPoolRatio = () => {
    if (spot <= 0) return;
    setQuoteInput(trimAmount(baseNum * spot, config.quoteDecimals));
  };

  const handleAdd = async (event: React.FormEvent) => {
    event.preventDefault();
    setLocalError(null);
    if (!account) {
      setLocalError('Connect a wallet to provide liquidity.');
      return;
    }
    if (baseNum <= 0 || quoteNum <= 0) {
      setLocalError(`Both ${config.baseSymbol} and ${config.quoteSymbol} amounts must be positive.`);
      return;
    }
    try {
      await onAddLiquidity(baseInput, quoteInput);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Add liquidity failed');
    }
  };

  const handleRemove = async (event: React.FormEvent) => {
    event.preventDefault();
    setLocalError(null);
    if (!account) {
      setLocalError('Connect a wallet to withdraw liquidity.');
      return;
    }
    if (sharesNum <= 0) {
      setLocalError('Enter a positive LP share amount.');
      return;
    }
    try {
      await onRemoveLiquidity(sharesInput);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Remove liquidity failed');
    }
  };

  return (
    <section aria-label="Liquidity provision" className="ledger-panel overflow-hidden">
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3 border-b border-rule px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <Droplets className="h-3 w-3 text-plum-600" aria-hidden="true" />
            <span className="eyebrow">Passive reserves</span>
          </div>
          <h2 className="mt-1 font-display text-xl font-bold leading-tight tracking-tight text-ink">
            FM-AMM liquidity desk
          </h2>
          <p className="mt-0.5 text-[11px] leading-relaxed text-ink-muted">
            Internal, non-transferable LP shares earn the invariant surplus and slashed bonds.
          </p>
        </div>
        <div className="flex border border-rule-strong bg-paper-soft p-0.5">
          <button
            type="button"
            onClick={() => setMode('add')}
            aria-pressed={mode === 'add'}
            className={`px-2.5 py-1 font-mono text-[9px] font-bold uppercase tracking-[0.06em] transition ${
              mode === 'add' ? 'bg-ink text-paper' : 'text-ink-muted hover:text-ink'
            }`}
          >
            Add
          </button>
          <button
            type="button"
            onClick={() => setMode('remove')}
            aria-pressed={mode === 'remove'}
            className={`px-2.5 py-1 font-mono text-[9px] font-bold uppercase tracking-[0.06em] transition ${
              mode === 'remove' ? 'bg-ink text-paper' : 'text-ink-muted hover:text-ink'
            }`}
          >
            Remove
          </button>
        </div>
      </div>

      <div className="grid gap-px border-b border-rule bg-rule sm:grid-cols-4">
        <div className="bg-paper-bright p-3">
          <div className="font-mono text-[8px] uppercase tracking-label text-ink-faint">
            Pool {config.baseSymbol}
          </div>
          <div className="mt-1 font-mono text-sm font-bold text-ink tabular-nums">
            {formatToken(rx, 3)}
          </div>
        </div>
        <div className="bg-paper-bright p-3">
          <div className="font-mono text-[8px] uppercase tracking-label text-ink-faint">
            Pool {config.quoteSymbol}
          </div>
          <div className="mt-1 font-mono text-sm font-bold text-ink tabular-nums">
            {formatPrice(ry, 0)}
          </div>
        </div>
        <div className="bg-paper-bright p-3">
          <div className="font-mono text-[8px] uppercase tracking-label text-ink-faint">
            Spot
          </div>
          <div className="mt-1 font-mono text-sm font-bold text-vermilion-700 tabular-nums">
            ${formatPrice(spot, 2)}
          </div>
        </div>
        <div className="bg-paper-bright p-3">
          <div className="font-mono text-[8px] uppercase tracking-label text-ink-faint">
            Your LP share
          </div>
          <div className="mt-1 font-mono text-sm font-bold text-plum-700 tabular-nums">
            {formatToken(userShares, 2)} · {formatPrice(poolSharePct, 2)}%
          </div>
        </div>
      </div>

      <div className="p-4">
        {mode === 'add' ? (
          <form onSubmit={handleAdd} className="space-y-3">
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="ledger-inset px-3 py-2">
                <label
                  htmlFor="lp-base-input"
                  className="eyebrow block"
                >
                  {config.baseSymbol} deposit
                </label>
                <div className="mt-1 flex items-baseline gap-1.5">
                  <input
                    id="lp-base-input"
                    type="number"
                    step="any"
                    min="0"
                    value={baseInput}
                    onChange={(e) => setBaseInput(e.target.value)}
                    className="w-full bg-transparent font-mono text-lg font-bold text-ink tabular-nums focus:outline-none"
                  />
                  <span className="font-mono text-[9px] uppercase tracking-label text-ink-muted">
                    {config.baseSymbol}
                  </span>
                </div>
              </div>
              <div className="ledger-inset px-3 py-2">
                <label
                  htmlFor="lp-quote-input"
                  className="eyebrow block"
                >
                  {config.quoteSymbol} deposit
                </label>
                <div className="mt-1 flex items-baseline gap-1.5">
                  <input
                    id="lp-quote-input"
                    type="number"
                    step="any"
                    min="0"
                    value={quoteInput}
                    onChange={(e) => setQuoteInput(e.target.value)}
                    className="w-full bg-transparent font-mono text-lg font-bold text-ink tabular-nums focus:outline-none"
                  />
                  <span className="font-mono text-[9px] uppercase tracking-label text-ink-muted">
                    {config.quoteSymbol}
                  </span>
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2">
              <button
                type="button"
                onClick={matchPoolRatio}
                className="inline-flex items-center gap-1 font-mono text-[9px] font-bold uppercase tracking-[0.06em] text-cobalt-700 underline decoration-dotted underline-offset-2 transition hover:text-cobalt-800"
              >
                <Scale className="h-3 w-3" />
                Match pool ratio
              </button>
              <span className="font-mono text-[9px] text-ink-muted tabular-nums">
                {estimatedShares !== null
                  ? `≈ ${formatToken(estimatedShares, 4)} LP shares`
                  : 'LP shares mint pro-rata'}
              </span>
            </div>

            <button
              type="submit"
              disabled={!account || busy}
              className="inline-flex w-full items-center justify-center gap-2 bg-plum-600 px-3 py-2.5 font-display text-sm font-bold text-paper transition hover:bg-plum-700 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <ArrowDownToLine className="h-4 w-4" aria-hidden="true" />
              <span>
                {!account
                  ? 'Connect a wallet to add liquidity'
                  : busyAction === 'add-liquidity'
                    ? 'Adding liquidity…'
                    : 'Add liquidity'}
              </span>
            </button>
            <p className="font-mono text-[8.5px] leading-relaxed text-ink-faint">
              FairBatch mints min(sharesX, sharesY). Matching the pool ratio avoids donating the
              excess side to existing LPs.
            </p>
          </form>
        ) : (
          <form onSubmit={handleRemove} className="space-y-3">
            <div className="ledger-inset px-3 py-2">
              <div className="flex items-baseline justify-between gap-2">
                <label htmlFor="lp-shares-input" className="eyebrow">
                  LP shares to burn
                </label>
                <button
                  type="button"
                  onClick={() => setSharesInput(trimAmount(userShares, 18))}
                  className="font-mono text-[9px] font-bold uppercase tracking-[0.06em] text-plum-700 underline decoration-dotted underline-offset-2"
                >
                  Max
                </button>
              </div>
              <div className="mt-1 flex items-baseline gap-1.5">
                <input
                  id="lp-shares-input"
                  type="number"
                  step="any"
                  min="0"
                  value={sharesInput}
                  onChange={(e) => setSharesInput(e.target.value)}
                  placeholder="0.0"
                  className="w-full bg-transparent font-mono text-lg font-bold text-ink tabular-nums focus:outline-none"
                />
                <span className="font-mono text-[9px] uppercase tracking-label text-ink-muted">
                  Shares
                </span>
              </div>
            </div>

            <div className="flex items-center justify-between gap-2 border border-rule bg-paper-soft px-3 py-2 text-[10.5px]">
              <span className="flex items-center gap-1.5 font-mono text-[8.5px] uppercase tracking-label text-ink-faint">
                <Coins className="h-3 w-3" />
                Receive
              </span>
              <span className="text-right font-mono font-bold text-ink tabular-nums">
                {removePreview
                  ? `${formatToken(removePreview.base, 3)} ${config.baseSymbol} + ${formatPrice(
                      removePreview.quote,
                      2,
                    )} ${config.quoteSymbol}`
                  : '—'}
              </span>
            </div>

            <button
              type="submit"
              disabled={!account || busy}
              className="inline-flex w-full items-center justify-center gap-2 bg-ink px-3 py-2.5 font-display text-sm font-bold text-paper transition hover:bg-ink-soft disabled:cursor-not-allowed disabled:opacity-40"
            >
              <ArrowUpFromLine className="h-4 w-4" aria-hidden="true" />
              <span>
                {!account
                  ? 'Connect a wallet to remove liquidity'
                  : busyAction === 'remove-liquidity'
                    ? 'Removing liquidity…'
                    : 'Remove liquidity'}
              </span>
            </button>
          </form>
        )}

        {localError && (
          <div className="mt-3 border-l-2 border-vermilion-500 bg-vermilion-50 px-3 py-2 text-[10.5px] text-vermilion-800">
            {localError}
          </div>
        )}
      </div>
    </section>
  );
};
