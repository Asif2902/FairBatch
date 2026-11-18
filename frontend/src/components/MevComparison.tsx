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
      className: 'border-pine-600/40 bg-pine-50 text-pine-700',
    };
  }
  if (status === 'PartialFill' || status.includes('Partial')) {
    return {
      label: 'Pro-Rata Partial',
      className: 'border-brass-600/40 bg-brass-50 text-brass-700',
    };
  }
  return {
    label: 'Refunded (OTM)',
    className: 'border-rule-strong bg-paper-soft text-ink-muted',
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
      className="ledger-panel overflow-hidden"
    >
      {/* Header + batch selector */}
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3 border-b border-rule px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <Award className="h-3 w-3 text-cobalt-600" aria-hidden="true" />
            <span className="eyebrow">Execution audit</span>
          </div>
          <h2 className="mt-1 font-display text-xl font-bold leading-tight tracking-tight text-ink">
            Sequential AMM vs. FairBatch
          </h2>
          <p className="mt-0.5 text-[11px] text-ink-muted">
            Order-arrival fairness, zero sandwich extraction, and LND surplus for LPs.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-1">
          <span className="mr-1 font-mono text-[8.5px] uppercase tracking-label text-ink-faint">
            View
          </span>
          <button
            type="button"
            onClick={() => onSelectViewBatch('live')}
            className={`border px-2 py-1 font-mono text-[9px] font-bold uppercase tracking-[0.08em] transition ${
              selectedViewBatchId === 'live'
                ? 'border-ink bg-ink text-paper'
                : 'border-rule bg-paper-bright text-ink-muted hover:border-ink hover:text-ink'
            }`}
          >
            Live Batch #{activeBatchId}
          </button>
          {settledHistory.slice(0, 4).map((hist) => (
            <button
              key={hist.batch_id}
              type="button"
              onClick={() => onSelectViewBatch(hist.batch_id)}
              className={`border px-2 py-1 font-mono text-[9px] font-bold uppercase tracking-[0.08em] transition ${
                selectedViewBatchId === hist.batch_id
                  ? 'border-pine-700 bg-pine-600 text-paper'
                  : 'border-rule bg-paper-bright text-ink-muted hover:border-ink hover:text-ink'
              }`}
            >
              Settled #{hist.batch_id}
            </button>
          ))}
        </div>
      </div>

      {/* Four executive KPI cells, ruled like a ledger summary */}
      <div className="grid gap-px bg-rule sm:grid-cols-2 xl:grid-cols-4">
        <div className="relative bg-paper-bright p-3">
          <span className="absolute inset-x-0 top-0 h-[2px] bg-vermilion-500" />
          <div className="flex items-center justify-between gap-2">
            <span className="eyebrow">MEV sandwich profit</span>
            <Flame className="h-3.5 w-3.5 text-vermilion-600" aria-hidden="true" />
          </div>
          <div className="mt-2.5 flex items-end justify-between gap-2 font-mono tabular-nums">
            <div>
              <div className="serial">SEQ. AMM</div>
              <div
                data-testid="amm-mev-profit"
                className={`font-display text-xl font-bold leading-none ${
                  comparison.amm_sandwich_profit_quote > 0.01
                    ? 'text-vermilion-700'
                    : 'text-ink-muted'
                }`}
              >
                {formatUsd(comparison.amm_sandwich_profit_quote, 2)}
              </div>
            </div>
            <div className="text-right">
              <div className="serial text-pine-700">FAIRBATCH</div>
              <div
                data-testid="fairbatch-mev-profit"
                className="font-display text-2xl font-bold leading-none text-pine-700"
              >
                {formatUsd(Math.max(0, comparison.fairbatch_sandwich_profit_quote), 2)}
              </div>
            </div>
          </div>
        </div>

        <div className="relative bg-paper-bright p-3">
          <span className="absolute inset-x-0 top-0 h-[2px] bg-pine-600" />
          <div className="flex items-center justify-between gap-2">
            <span className="eyebrow">Trader value protected</span>
            <Award className="h-3.5 w-3.5 text-pine-700" aria-hidden="true" />
          </div>
          <div
            data-testid="user-value-saved"
            className="mt-2.5 font-display text-2xl font-bold leading-none text-pine-700 tabular-nums"
          >
            +{formatUsd(comparison.user_value_saved_quote, 2)}
          </div>
          <div className="mt-1 font-mono text-[9px] leading-snug text-ink-muted tabular-nums">
            p* ${formatPrice(comparison.fairbatch_uniform_price, 2)} vs AMM avg $
            {formatPrice(comparison.amm_victim_avg_price, 2)}
          </div>
        </div>

        <div className="relative bg-paper-bright p-3">
          <span className="absolute inset-x-0 top-0 h-[2px] bg-cobalt-600" />
          <div className="flex items-center justify-between gap-2">
            <span className="eyebrow">CoW peer-to-peer</span>
            <GitMerge className="h-3.5 w-3.5 text-cobalt-700" aria-hidden="true" />
          </div>
          <div
            data-testid="cow-ratio-kpi"
            className="mt-2.5 font-display text-2xl font-bold leading-none text-cobalt-700 tabular-nums"
          >
            {formatPrice(settlement.cow_ratio_pct, 1)}%
          </div>
          <div className="mt-1 font-mono text-[9px] leading-snug text-ink-muted tabular-nums">
            {formatToken(settlement.cow_matched_base, 2)} WETH (
            {formatUsd(settlement.cow_matched_quote, 0)}) · 0 fee
          </div>
        </div>

        <div className="relative bg-paper-bright p-3">
          <span className="absolute inset-x-0 top-0 h-[2px] bg-plum-500" />
          <div className="flex items-center justify-between gap-2">
            <span className="eyebrow">LP invariant growth</span>
            <TrendingUp className="h-3.5 w-3.5 text-plum-600" aria-hidden="true" />
          </div>
          <div
            data-testid="lnd-growth-kpi"
            className="mt-2.5 font-display text-2xl font-bold leading-none text-plum-700 tabular-nums"
          >
            +{formatPrice(settlement.k_invariant_growth_pct, 3)}%
          </div>
          <div className="mt-1 flex items-center justify-between gap-2 font-mono text-[9px] text-ink-muted tabular-nums">
            <span>Δk = +{formatPrice(settlement.k_invariant_growth, 0)}</span>
            {settlement.slashed_bonds_count > 0 && (
              <span className="border border-brass-600/40 bg-brass-50 px-1 py-0.5 text-[8px] font-bold uppercase tracking-[0.06em] text-brass-700">
                {settlement.slashed_bonds_count} slashed
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Per-trader comparison table */}
      <div className="flex items-center justify-between gap-2 border-t border-rule bg-paper-soft px-4 py-1 font-mono text-[8px] uppercase tracking-label text-ink-faint xl:hidden">
        <span>Execution receipts</span>
        <span className="text-vermilion-700">Swipe table →</span>
      </div>
      <div className="overflow-x-auto border-t border-rule">
        <table className="w-full min-w-[760px] border-collapse text-left text-[10.5px]">
          <thead className="bg-ink text-paper">
            <tr className="font-mono text-[8.5px] uppercase tracking-[0.08em]">
              <th className="px-2.5 py-2.5 font-bold">Pos</th>
              <th className="px-2.5 py-2.5 font-bold">Trader / Role</th>
              <th className="px-2.5 py-2.5 font-bold">Order Input</th>
              <th className="px-2.5 py-2.5 text-right font-bold text-vermilion-200">
                Seq. AMM Price
              </th>
              <th className="px-2.5 py-2.5 text-right font-bold text-vermilion-200">
                Seq. AMM Out
              </th>
              <th className="px-2.5 py-2.5 text-right font-bold text-pine-200">
                FairBatch p*
              </th>
              <th className="px-2.5 py-2.5 text-center font-bold">Fill Status</th>
              <th className="px-2.5 py-2.5 text-right font-bold text-pine-200">
                FairBatch Payout
              </th>
              <th className="px-2.5 py-2.5 text-right font-bold">Refund</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-rule/70 font-mono tabular-nums">
            {comparison.fairbatch_receipts.length === 0 ? (
              <tr>
                <td
                  colSpan={9}
                  className="px-4 py-8 text-center font-sans text-[11px] text-ink-faint"
                >
                  No orders in selected view. Load a scenario from the scenario book to inspect execution receipts.
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
                        ? 'bg-vermilion-50/80 hover:bg-vermilion-50'
                        : 'bg-paper-bright hover:bg-paper-soft'
                    }
                  >
                    <td className="px-2.5 py-2.5 text-ink-faint">
                      #{fb.arrival_index ?? idx + 1}
                    </td>
                    <td className="px-2.5 py-2.5 font-sans">
                      <div className="flex items-center gap-1.5">
                        {fb.is_attacker ? (
                          <Flame className="h-3 w-3 shrink-0 text-vermilion-600" />
                        ) : (
                          <ShieldCheck className="h-3 w-3 shrink-0 text-pine-600" />
                        )}
                        <span
                          className={`font-semibold ${
                            fb.is_attacker ? 'text-vermilion-800' : 'text-ink'
                          }`}
                        >
                          {fb.label}
                        </span>
                      </div>
                    </td>
                    <td className="px-2.5 py-2.5 text-ink-soft">
                      {fb.side === 'SellBase'
                        ? `Sell ${formatToken(fb.amount_in, 2)} WETH`
                        : `Buy ${formatPrice(fb.amount_in, 0)} USDC`}
                    </td>
                    <td className="px-2.5 py-2.5 text-right text-ink-muted">
                      {amm && amm.effective_price > 0
                        ? `$${formatPrice(amm.effective_price, 2)}`
                        : '—'}
                    </td>
                    <td className="px-2.5 py-2.5 text-right text-ink-muted">
                      {amm && amm.amount_out > 0
                        ? `${
                            outUnit === 'USDC'
                              ? formatPrice(amm.amount_out, 2)
                              : formatToken(amm.amount_out, 4)
                          } ${outUnit}`
                        : '—'}
                    </td>
                    <td className="px-2.5 py-2.5 text-right font-bold text-pine-700">
                      {fb.effective_price > 0
                        ? `$${formatPrice(fb.effective_price, 2)}`
                        : '—'}
                    </td>
                    <td className="px-2.5 py-2.5 text-center font-sans">
                      <span
                        className={`inline-block border px-1.5 py-0.5 font-mono text-[8.5px] font-bold uppercase tracking-[0.04em] ${badge.className}`}
                      >
                        {badge.label}
                      </span>
                    </td>
                    <td className="px-2.5 py-2.5 text-right font-semibold text-ink">
                      {fb.amount_out > 0
                        ? `${
                            outUnit === 'USDC'
                              ? formatPrice(fb.amount_out, 2)
                              : formatToken(fb.amount_out, 4)
                          } ${outUnit}`
                        : `0.00 ${outUnit}`}
                    </td>
                    <td className="px-2.5 py-2.5 text-right text-brass-700">
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
