import React from 'react';
import {
  Award,
  Flame,
  GitMerge,
  ShieldCheck,
  TrendingUp,
} from 'lucide-react';
import type { BatchSettlementDto, ExecutionReceiptDto } from '../types';
import { formatPrice, formatToken, formatUsd } from '../lib/format';

interface MevComparisonProps {
  settlement: BatchSettlementDto;
  settledHistory: BatchSettlementDto[];
  selectedViewBatchId: number | 'live';
  activeBatchId: number;
  onSelectViewBatch: (batchId: number | 'live') => void;
}

function formatStatusBadge(status: string): {
  label: string;
  className: string;
} {
  if (status === 'Filled' || status.includes('100%')) {
    return {
      label: '100% Filled',
      className:
        'border-emerald-500/30 bg-emerald-500/15 text-emerald-300',
    };
  }
  if (status === 'PartialFill' || status.includes('Partial')) {
    return {
      label: 'Pro-Rata Partial',
      className: 'border-amber-500/30 bg-amber-500/15 text-amber-300',
    };
  }
  return {
    label: 'Refunded (OTM)',
    className: 'border-slate-600/40 bg-slate-700/30 text-slate-300',
  };
}

export const MevComparison: React.FC<MevComparisonProps> = ({
  settlement,
  settledHistory,
  selectedViewBatchId,
  activeBatchId,
  onSelectViewBatch,
}) => {
  const { comparison } = settlement;

  // Match receipts by order_id or index for side-by-side comparison
  const ammByOrderId = new Map<number, ExecutionReceiptDto>();
  comparison.amm_receipts.forEach((r) => ammByOrderId.set(r.order_id, r));

  return (
    <section
      aria-label="Sequential AMM vs FairBatch Execution Receipts"
      className="rounded-2xl border border-slate-800/90 bg-[#0D1321]/95 p-4 shadow-xl"
    >
      {/* Header + Batch Selector Tabs */}
      <div className="flex flex-wrap items-center justify-between gap-3 pb-3.5">
        <div>
          <h2 className="text-sm font-bold text-white">
            Side-by-Side Execution Audit: Sequential AMM (Uniswap v2) vs. FairBatch
          </h2>
          <p className="text-xs text-slate-400">
            Proving order-arrival fairness, zero sandwich extraction, and LND LP surplus
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => onSelectViewBatch('live')}
            className={`rounded-lg border px-2.5 py-1 font-mono text-xs font-semibold transition ${
              selectedViewBatchId === 'live'
                ? 'border-cyan-400/50 bg-cyan-500/15 text-cyan-300'
                : 'border-slate-800 bg-[#111827] text-slate-400 hover:text-slate-200'
            }`}
          >
            Live Batch #{activeBatchId}
          </button>
          {settledHistory.slice(0, 4).map((hist) => (
            <button
              key={hist.batch_id}
              type="button"
              onClick={() => onSelectViewBatch(hist.batch_id)}
              className={`rounded-lg border px-2.5 py-1 font-mono text-xs font-semibold transition ${
                selectedViewBatchId === hist.batch_id
                  ? 'border-emerald-400/50 bg-emerald-500/15 text-emerald-300'
                  : 'border-slate-800 bg-[#111827] text-slate-400 hover:text-slate-200'
              }`}
            >
              Settled #{hist.batch_id}
            </button>
          ))}
        </div>
      </div>

      {/* 4 Executive KPI Delta Cards */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {/* Card 1: MEV Bot Profit */}
        <div className="rounded-xl border border-slate-800 bg-[#090D16] p-3.5">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>MEV Sandwich Profit</span>
            <Flame className="h-4 w-4 text-rose-400" aria-hidden="true" />
          </div>
          <div className="mt-2 flex items-baseline justify-between gap-2 font-mono tabular-nums">
            <div>
              <div className="text-[10px] uppercase text-slate-500">Seq. AMM</div>
              <div
                data-testid="amm-mev-profit"
                className={`text-sm font-bold ${
                  comparison.amm_sandwich_profit_quote > 0.01
                    ? 'text-rose-400'
                    : 'text-slate-300'
                }`}
              >
                {formatUsd(comparison.amm_sandwich_profit_quote, 2)}
              </div>
            </div>
            <div className="text-right">
              <div className="text-[10px] uppercase text-emerald-400">FairBatch</div>
              <div
                data-testid="fairbatch-mev-profit"
                className="text-base font-extrabold text-emerald-400"
              >
                {formatUsd(Math.max(0, comparison.fairbatch_sandwich_profit_quote), 2)}
              </div>
            </div>
          </div>
        </div>

        {/* Card 2: User Value Saved */}
        <div className="rounded-xl border border-slate-800 bg-[#090D16] p-3.5">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>Trader Value Protected</span>
            <Award className="h-4 w-4 text-emerald-400" aria-hidden="true" />
          </div>
          <div
            data-testid="user-value-saved"
            className="mt-2 font-mono text-lg font-extrabold text-emerald-300 tabular-nums"
          >
            +{formatUsd(comparison.user_value_saved_quote, 2)}
          </div>
          <div className="mt-0.5 font-mono text-[11px] text-slate-400 tabular-nums">
            Uniform p* ${formatPrice(comparison.fairbatch_uniform_price, 2)} vs AMM Avg $
            {formatPrice(comparison.amm_victim_avg_price, 2)}
          </div>
        </div>

        {/* Card 3: CoW P2P Match % */}
        <div className="rounded-xl border border-slate-800 bg-[#090D16] p-3.5">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>CoW Peer-to-Peer Cross</span>
            <GitMerge className="h-4 w-4 text-cyan-400" aria-hidden="true" />
          </div>
          <div
            data-testid="cow-ratio-kpi"
            className="mt-2 font-mono text-lg font-extrabold text-cyan-300 tabular-nums"
          >
            {formatPrice(settlement.cow_ratio_pct, 1)}%
          </div>
          <div className="mt-0.5 font-mono text-[11px] text-slate-400 tabular-nums">
            {formatToken(settlement.cow_matched_base, 2)} WETH ({formatUsd(settlement.cow_matched_quote, 0)}) · 0 Fee
          </div>
        </div>

        {/* Card 4: LP LND Invariant Growth */}
        <div className="rounded-xl border border-slate-800 bg-[#090D16] p-3.5">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>LP Invariant Growth (Δk ≥ 0)</span>
            <TrendingUp className="h-4 w-4 text-violet-400" aria-hidden="true" />
          </div>
          <div
            data-testid="lnd-growth-kpi"
            className="mt-2 font-mono text-lg font-extrabold text-violet-300 tabular-nums"
          >
            +{formatPrice(settlement.k_invariant_growth_pct, 3)}%
          </div>
          <div className="mt-0.5 flex items-center justify-between font-mono text-[11px] text-slate-400 tabular-nums">
            <span>Δk = +{formatPrice(settlement.k_invariant_growth, 0)}</span>
            {settlement.slashed_bonds_count > 0 && (
              <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-bold text-amber-300">
                {settlement.slashed_bonds_count} Slashed
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Per-Trader Comparison Table */}
      <div className="mt-4 overflow-x-auto rounded-xl border border-slate-800 bg-[#090D16]">
        <table className="w-full border-collapse text-left text-xs">
          <thead>
            <tr className="border-b border-slate-800 bg-[#111827]/90 text-[11px] font-bold uppercase tracking-wider text-slate-400">
              <th className="px-3 py-2.5">Pos</th>
              <th className="px-3 py-2.5">Trader / Role</th>
              <th className="px-3 py-2.5">Order Input</th>
              <th className="px-3 py-2.5 text-right text-rose-300/90">
                Seq. AMM Price
              </th>
              <th className="px-3 py-2.5 text-right text-rose-300/90">
                Seq. AMM Out
              </th>
              <th className="px-3 py-2.5 text-right text-emerald-300">
                FairBatch p*
              </th>
              <th className="px-3 py-2.5 text-center">Fill Status</th>
              <th className="px-3 py-2.5 text-right text-emerald-300">
                FairBatch Payout
              </th>
              <th className="px-3 py-2.5 text-right">Refund</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/80 font-mono tabular-nums">
            {comparison.fairbatch_receipts.length === 0 ? (
              <tr>
                <td
                  colSpan={9}
                  className="px-4 py-6 text-center font-sans text-xs text-slate-500"
                >
                  No orders in selected view. Load a scenario preset above to inspect execution receipts.
                </td>
              </tr>
            ) : (
              comparison.fairbatch_receipts.map((fb, idx) => {
                const amm =
                  ammByOrderId.get(fb.order_id) ?? comparison.amm_receipts[idx];
                const badge = formatStatusBadge(fb.status);
                const inUnit = fb.side === 'SellBase' ? 'WETH' : 'USDC';
                const outUnit = fb.side === 'SellBase' ? 'USDC' : 'WETH';

                return (
                  <tr
                    key={`${fb.order_id}-${idx}`}
                    className={
                      fb.is_attacker
                        ? 'bg-rose-500/[0.07] hover:bg-rose-500/10'
                        : 'hover:bg-slate-800/40'
                    }
                  >
                    <td className="px-3 py-2.5 text-slate-400">
                      #{fb.arrival_index ?? idx + 1}
                    </td>
                    <td className="px-3 py-2.5 font-sans">
                      <div className="flex items-center gap-1.5">
                        {fb.is_attacker ? (
                          <Flame className="h-3.5 w-3.5 text-rose-400 shrink-0" />
                        ) : (
                          <ShieldCheck className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
                        )}
                        <span
                          className={`font-semibold ${
                            fb.is_attacker ? 'text-rose-200' : 'text-slate-100'
                          }`}
                        >
                          {fb.label}
                        </span>
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-slate-200">
                      {fb.side === 'SellBase'
                        ? `Sell ${formatToken(fb.amount_in, 2)} WETH`
                        : `Buy ${formatPrice(fb.amount_in, 0)} USDC`}
                    </td>
                    <td className="px-3 py-2.5 text-right text-slate-300">
                      {amm && amm.effective_price > 0
                        ? `$${formatPrice(amm.effective_price, 2)}`
                        : '—'}
                    </td>
                    <td className="px-3 py-2.5 text-right text-slate-400">
                      {amm && amm.amount_out > 0
                        ? `${
                            outUnit === 'USDC'
                              ? formatPrice(amm.amount_out, 2)
                              : formatToken(amm.amount_out, 4)
                          } ${outUnit}`
                        : '—'}
                    </td>
                    <td className="px-3 py-2.5 text-right font-bold text-emerald-300">
                      {fb.effective_price > 0
                        ? `$${formatPrice(fb.effective_price, 2)}`
                        : '—'}
                    </td>
                    <td className="px-3 py-2.5 text-center font-sans">
                      <span
                        className={`inline-block rounded border px-2 py-0.5 text-[10px] font-bold ${badge.className}`}
                      >
                        {badge.label}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-right font-semibold text-white">
                      {fb.amount_out > 0
                        ? `${
                            outUnit === 'USDC'
                              ? formatPrice(fb.amount_out, 2)
                              : formatToken(fb.amount_out, 4)
                          } ${outUnit}`
                        : `0.00 ${outUnit}`}
                    </td>
                    <td className="px-3 py-2.5 text-right text-amber-300">
                      {(fb.refund_in ?? 0) > 0
                        ? `${formatToken(fb.refund_in ?? 0, 3)} ${inUnit}`
                        : '—'}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
};
