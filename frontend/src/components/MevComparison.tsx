import React, { useMemo, useState } from 'react';
import {
  Award,
  ChevronDown,
  ChevronUp,
  Flame,
  FlaskConical,
  GitMerge,
  ShieldCheck,
  TrendingUp,
} from 'lucide-react';
import type { BatchSettlementDto, ExecutionReceiptDto } from '../types';
import { formatPrice, formatToken, formatUsd } from '../lib/format';
import { PRO_TOOLTIPS } from '../lib/glossary';
import { InfoTooltip } from './InfoTooltip';

interface MevComparisonProps {
  settlement: BatchSettlementDto;
  settledHistory: BatchSettlementDto[];
  selectedViewBatchId: number | 'live';
  activeBatchId: number;
  baseSymbol: string;
  quoteSymbol: string;
  onSelectViewBatch: (batchId: number | 'live') => void;
  onOpenSimulationModal?: () => void;
}

function formatStatusBadge(status: string): {
  label: string;
  className: string;
} {
  if (status === 'Filled' || status.includes('100%')) {
    return {
      label: '100% Filled',
      className: 'border-pine-600/40 bg-pine-50 text-pine-800',
    };
  }
  if (status === 'PartialFill' || status.includes('Partial')) {
    return {
      label: 'Pro-Rata Partial',
      className: 'border-brass-600/40 bg-brass-50 text-brass-900',
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
  baseSymbol,
  quoteSymbol,
  onSelectViewBatch,
  onOpenSimulationModal,
}) => {
  const { comparison } = settlement;
  const [showReceiptsTable, setShowReceiptsTable] = useState<boolean>(false);

  // Defensive deduplication of historical settled batch tabs (fixes 1b).
  const uniqueSettledTabs = useMemo(() => {
    const seen = new Set<number>();
    const out: BatchSettlementDto[] = [];
    for (const hist of settledHistory) {
      if (!seen.has(hist.batch_id)) {
        seen.add(hist.batch_id);
        out.push(hist);
      }
    }
    return out.slice(0, 5);
  }, [settledHistory]);

  // Match sequential AMM receipts by exact arrival position when order_ids align,
  // avoiding duplicate-key collisions (fixes 1e).
  const matchedAmm = useMemo(() => {
    const byId = new Map<number, ExecutionReceiptDto[]>();
    for (const r of comparison.amm_receipts) {
      const list = byId.get(r.order_id) ?? [];
      list.push(r);
      byId.set(r.order_id, list);
    }
    const used = new Map<number, number>();
    return comparison.fairbatch_receipts.map((fb, idx) => {
      const candidates = byId.get(fb.order_id);
      if (candidates && candidates.length > 0) {
        const take = used.get(fb.order_id) ?? 0;
        used.set(fb.order_id, take + 1);
        return candidates[take] ?? candidates[candidates.length - 1];
      }
      return comparison.amm_receipts[idx];
    });
  }, [comparison.amm_receipts, comparison.fairbatch_receipts]);

  const signedDiff = comparison.user_value_saved_quote;
  const isPositiveSaving = signedDiff > 0.01;
  const isNegativeDiff = signedDiff < -0.01;
  const isLive = selectedViewBatchId === 'live';

  return (
    <section
      aria-label="Sequential AMM vs FairBatch Execution Receipts"
      className="ledger-panel overflow-hidden"
    >
      {/* Header + batch selector */}
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3 border-b border-rule px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <Award className="h-3.5 w-3.5 text-cobalt-700" aria-hidden="true" />
            <span className="eyebrow">Execution audit</span>
          </div>
          <h2 className="mt-1 font-display text-xl font-bold leading-tight text-ink">
            Sequential AMM vs. FairBatch
          </h2>
          <p className="mt-0.5 text-sm text-ink-muted">
            Simulated 0.30% sequential x·y=k baseline in arrival order vs. uniform batch clearing.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => onSelectViewBatch('live')}
            className={`min-h-[36px] border px-2.5 font-mono text-xs font-bold uppercase transition ${selectedViewBatchId === 'live'
              ? 'border-ink bg-ink text-paper'
              : 'border-rule bg-paper-bright text-ink-muted hover:border-ink hover:text-ink'
              }`}
          >
            Current queue (#{activeBatchId})
          </button>
          {uniqueSettledTabs.map((hist) => (
            <button
              key={hist.batch_id}
              type="button"
              onClick={() => onSelectViewBatch(hist.batch_id)}
              className={`min-h-[36px] border px-2.5 font-mono text-xs font-bold uppercase transition ${selectedViewBatchId === hist.batch_id
                ? 'border-pine-700 bg-pine-600 text-[#FBF8F0]'
                : 'border-rule bg-paper-bright text-ink-muted hover:border-ink hover:text-ink'
                }`}
            >
              Settled #{hist.batch_id}
            </button>
          ))}
          {onOpenSimulationModal && (
            <button
              type="button"
              onClick={onOpenSimulationModal}
              className="inline-flex min-h-[36px] items-center gap-1 border border-plum-600/50 bg-plum-50 px-2.5 font-mono text-xs font-bold text-plum-700 transition hover:border-plum-700"
            >
              <FlaskConical className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Sandwich sim</span>
            </button>
          )}
        </div>
      </div>

      {/* Four executive KPI cells */}
      <div className="grid gap-px bg-rule sm:grid-cols-2 xl:grid-cols-4">
        <div className="relative bg-paper-bright p-3.5">
          <span className="absolute inset-x-0 top-0 h-[2px] bg-vermilion-500" />
          <div className="flex items-center justify-between gap-2">
            <span className="eyebrow">MEV sandwich profit</span>
            <Flame className="h-4 w-4 text-vermilion-600" aria-hidden="true" />
          </div>
          <div className="mt-2.5 flex items-end justify-between gap-2 font-mono tabular-nums">
            <div>
              <div className="serial">SEQ. AMM</div>
              <div
                data-testid="amm-mev-profit"
                className={`font-display text-xl font-bold leading-none ${comparison.amm_sandwich_profit_quote > 0.01
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

        <div className="relative bg-paper-bright p-3.5">
          <span
            className={`absolute inset-x-0 top-0 h-[2px] ${isPositiveSaving
              ? 'bg-pine-600'
              : isNegativeDiff
                ? 'bg-brass-600'
                : 'bg-rule-strong'
              }`}
          />
          <div className="flex items-center justify-between gap-1">
            <span className="eyebrow flex items-center gap-1">
              <span>Simulated saving vs a normal swap (0.30% x·y=k baseline)</span>
              <InfoTooltip
                label="Simulated saving baseline"
                text={PRO_TOOLTIPS.simulatedSaving}
              />
            </span>
            <Award className="h-4 w-4 shrink-0 text-pine-700" aria-hidden="true" />
          </div>
          <div
            data-testid="user-value-saved"
            className={`mt-2.5 font-display text-2xl font-bold leading-none tabular-nums ${
              isPositiveSaving
                ? 'text-pine-700'
                : isNegativeDiff
                  ? 'text-brass-800'
                  : 'text-ink-muted'
            }`}
          >
            {isPositiveSaving
              ? `+${formatUsd(signedDiff, 2)}`
              : isNegativeDiff
                ? `Δ ${formatUsd(signedDiff, 2)} (no net saving)`
                : 'No difference ($0.00)'}
          </div>
          <div className="mt-1.5 font-mono text-xs leading-snug text-ink-muted tabular-nums">
            {isLive ? 'Current queue p*' : 'Settled p*'} $
            {formatPrice(comparison.fairbatch_uniform_price, 2)} vs AMM avg $
            {formatPrice(comparison.amm_victim_avg_price, 2)}
          </div>
          {!isPositiveSaving && (
            <p className="mt-1 text-xs leading-snug text-ink-muted">
              {isNegativeDiff
                ? 'One-sided flow without a sandwich bot: FM-AMM clears at the post-trade marginal price so LPs retain LVR and all traders share one uniform price.'
                : 'No saving on this round against a 0.30% sequential swap without a sandwich attacker.'}
            </p>
          )}
        </div>

        <div className="relative bg-paper-bright p-3.5">
          <span className="absolute inset-x-0 top-0 h-[2px] bg-cobalt-600" />
          <div className="flex items-center justify-between gap-1">
            <span className="eyebrow flex items-center gap-1">
              <span>CoW peer-to-peer</span>
              <InfoTooltip label="CoW" text={PRO_TOOLTIPS.cow} />
            </span>
            <GitMerge className="h-4 w-4 text-cobalt-700" aria-hidden="true" />
          </div>
          <div
            data-testid="cow-ratio-kpi"
            className="mt-2.5 font-display text-2xl font-bold leading-none text-cobalt-700 tabular-nums"
          >
            {formatPrice(settlement.cow_ratio_pct, 1)}%
          </div>
          <div className="mt-1.5 font-mono text-xs leading-snug text-ink-muted tabular-nums">
            {formatToken(settlement.cow_matched_base, 2)} {baseSymbol} (
            {formatUsd(settlement.cow_matched_quote, 0)}) · 0 fee
          </div>
        </div>

        <div className="relative bg-paper-bright p-3.5">
          <span className="absolute inset-x-0 top-0 h-[2px] bg-plum-500" />
          <div className="flex items-center justify-between gap-1">
            <span className="eyebrow flex items-center gap-1">
              <span>LP invariant growth</span>
              <InfoTooltip label="LND invariant" text={PRO_TOOLTIPS.lnd} />
            </span>
            <TrendingUp className="h-4 w-4 text-plum-600" aria-hidden="true" />
          </div>
          <div
            data-testid="lnd-growth-kpi"
            className="mt-2.5 font-display text-2xl font-bold leading-none text-plum-700 tabular-nums"
          >
            +{formatPrice(settlement.k_invariant_growth_pct, 3)}%
          </div>
          <div className="mt-1.5 flex items-center justify-between gap-2 font-mono text-xs text-ink-muted tabular-nums">
            <span>Δk = +{formatPrice(settlement.k_invariant_growth, 0)}</span>
            {settlement.slashed_bonds_count > 0 && (
              <span className="border border-brass-600/40 bg-brass-50 px-1.5 py-0.5 text-xs font-bold uppercase text-brass-800">
                {settlement.slashed_bonds_count} slashed
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Collapsible per-trader comparison table in its own overflow-x scroll container */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-rule bg-paper-soft px-4 py-2 font-mono text-xs">
        <span className="uppercase tracking-label text-ink-muted">
          Execution receipts ({comparison.fairbatch_receipts.length})
        </span>
        <button
          type="button"
          data-testid="pro-receipts-details-toggle"
          aria-expanded={showReceiptsTable}
          onClick={() => setShowReceiptsTable((v) => !v)}
          className="inline-flex items-center gap-1 border border-rule-strong bg-paper-bright px-2.5 py-1 font-mono text-xs font-bold text-ink-soft transition hover:border-ink hover:text-ink"
        >
          <span>{showReceiptsTable ? 'Hide details' : 'Show details'}</span>
          {showReceiptsTable ? (
            <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
          )}
        </button>
      </div>
      {showReceiptsTable && (
      <div data-testid="pro-receipts-details-panel" className="overflow-x-auto border-t border-rule">
        <table className="w-full min-w-[780px] border-collapse text-left text-xs">
          <thead className="bg-ink text-paper">
            <tr className="font-mono text-xs uppercase tracking-label">
              <th className="px-3 py-2.5 font-bold">Pos</th>
              <th className="px-3 py-2.5 font-bold">Trader / Role</th>
              <th className="px-3 py-2.5 font-bold">Order Input</th>
              <th className="px-3 py-2.5 text-right font-bold text-vermilion-200">
                Seq. AMM Price
              </th>
              <th className="px-3 py-2.5 text-right font-bold text-vermilion-200">
                Seq. AMM Out
              </th>
              <th className="px-3 py-2.5 text-right font-bold text-pine-200">
                FairBatch p*
              </th>
              <th className="px-3 py-2.5 text-center font-bold">Fill Status</th>
              <th className="px-3 py-2.5 text-right font-bold text-pine-200">
                FairBatch Payout
              </th>
              <th className="px-3 py-2.5 text-right font-bold">Refund</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-rule/70 font-mono tabular-nums">
            {comparison.fairbatch_receipts.length === 0 ? (
              <tr>
                <td
                  colSpan={9}
                  className="px-4 py-8 text-center font-sans text-sm text-ink-muted"
                >
                  No orders in the selected view. Execution receipts appear once this batch has
                  on-chain orders or has been settled.
                </td>
              </tr>
            ) : (
              comparison.fairbatch_receipts.map((fb, idx) => {
                const amm = matchedAmm[idx];
                const badge = formatStatusBadge(fb.status);
                const inUnit = fb.side === 'SellBase' ? baseSymbol : quoteSymbol;
                const outUnit = fb.side === 'SellBase' ? quoteSymbol : baseSymbol;

                return (
                  <tr
                    key={`${fb.order_id}-${idx}`}
                    className={
                      fb.is_attacker
                        ? 'bg-vermilion-50 hover:bg-vermilion-100'
                        : 'bg-paper-bright hover:bg-paper-soft'
                    }
                  >
                    <td className="px-3 py-2.5 text-ink-muted">
                      #{fb.arrival_index ?? idx + 1}
                    </td>
                    <td className="px-3 py-2.5 font-sans text-sm">
                      <div className="flex items-center gap-1.5">
                        {fb.is_attacker ? (
                          <Flame className="h-3.5 w-3.5 shrink-0 text-vermilion-600" />
                        ) : (
                          <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-pine-600" />
                        )}
                        <span
                          className={`font-semibold ${fb.is_attacker ? 'text-vermilion-800' : 'text-ink'
                            }`}
                        >
                          {fb.label}
                        </span>
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-ink-soft">
                      {fb.side === 'SellBase'
                        ? `Sell ${formatToken(fb.amount_in, 3)} ${baseSymbol}`
                        : `Buy ${formatPrice(fb.amount_in, 2)} ${quoteSymbol}`}
                    </td>
                    <td className="px-3 py-2.5 text-right text-ink-muted">
                      {amm && amm.effective_price > 0
                        ? `$${formatPrice(amm.effective_price, 2)}`
                        : '—'}
                    </td>
                    <td className="px-3 py-2.5 text-right text-ink-muted">
                      {amm && amm.amount_out > 0
                        ? `${outUnit === quoteSymbol
                          ? formatPrice(amm.amount_out, 2)
                          : formatToken(amm.amount_out, 4)
                        } ${outUnit}`
                        : '—'}
                    </td>
                    <td className="px-3 py-2.5 text-right font-bold text-pine-700">
                      {fb.effective_price > 0
                        ? `$${formatPrice(fb.effective_price, 2)}`
                        : '—'}
                    </td>
                    <td className="px-3 py-2.5 text-center font-sans">
                      <span
                        className={`inline-block border px-2 py-0.5 font-mono text-xs font-bold uppercase ${badge.className}`}
                      >
                        {badge.label}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-right font-semibold text-ink">
                      {fb.amount_out > 0
                        ? `${outUnit === quoteSymbol
                          ? formatPrice(fb.amount_out, 2)
                          : formatToken(fb.amount_out, 4)
                        } ${outUnit}`
                        : `0.00 ${outUnit}`}
                    </td>
                    <td className="px-3 py-2.5 text-right text-brass-700">
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
      )}
    </section>
  );
};
