import React from 'react';
import {
  ArrowRight,
  CheckCircle2,
  Coins,
  ExternalLink,
  Loader2,
  ShieldCheck,
} from 'lucide-react';
import type { BatchSettlementDto, ClaimableDto } from '../../types';
import { explorerTxUrl, type RuntimeConfig } from '../../onchain/config';
import {
  formatPrice,
  formatToken,
  formatTokenAmount,
  formatUsd,
  pickReconciledDecimals,
} from '../../lib/format';
import { PRO_TOOLTIPS } from '../../lib/glossary';
import { UI_LABELS } from '../../lib/uiLabels';
import { InfoTooltip } from '../InfoTooltip';

export interface CollectedReceiptSummary {
  hash: string;
  items: ClaimableDto[];
}

interface SimpleCollectCardProps {
  config: RuntimeConfig;
  unclaimed: ClaimableDto[];
  settledHistory: BatchSettlementDto[];
  lastCollected: CollectedReceiptSummary | null;
  busyAction: string | null;
  txStatus: string | null;
  onCollectOne: (item: ClaimableDto) => Promise<void>;
  onCollectAll: (items: ClaimableDto[]) => Promise<void>;
  onSwapAgain: () => void;
}

function fmtFixed(value: number, decimals: number): string {
  return formatToken(value, decimals, decimals);
}

function summarizeSingleReceipt(
  item: ClaimableDto,
  config: RuntimeConfig,
  baseDecimals: number,
  quoteDecimals: number,
): string {
  if (item.status === 'OutOfMoneyRefund') {
    const inSym = item.side === 'SellBase' ? config.baseSymbol : config.quoteSymbol;
    const refunded =
      item.side === 'SellBase'
        ? fmtFixed(item.refund_in, baseDecimals)
        : fmtFixed(item.refund_in, quoteDecimals);
    return `Round #${item.batch_id} cleared outside your price limit, so your full ${refunded} ${inSym} is ready to collect back.`;
  }

  if (item.side === 'SellBase') {
    return `You sold ${fmtFixed(item.amount_filled, baseDecimals)} ${config.baseSymbol}, received ${fmtFixed(
      item.payout_out,
      quoteDecimals,
    )} ${config.quoteSymbol} at fair price $${formatPrice(
      item.effective_price,
      2,
    )}. Everyone in Round #${item.batch_id} got the same price.`;
  }

  return `You spent ${fmtFixed(item.amount_filled, quoteDecimals)} ${config.quoteSymbol}, received ${fmtFixed(
    item.payout_out,
    baseDecimals,
  )} ${config.baseSymbol} at fair price $${formatPrice(
    item.effective_price,
    2,
  )}. Everyone in Round #${item.batch_id} got the same price.`;
}

function summarizeReceipts(
  items: ClaimableDto[],
  config: RuntimeConfig,
  baseDecimals: number,
  quoteDecimals: number,
): string {
  if (items.length === 1) {
    return summarizeSingleReceipt(items[0], config, baseDecimals, quoteDecimals);
  }

  const distinctRounds = Array.from(new Set(items.map((i) => i.batch_id))).sort((a, b) => a - b);
  const isMultiRound = distinctRounds.length > 1;

  const filledSells = items.filter(
    (i) => i.side === 'SellBase' && i.status !== 'OutOfMoneyRefund' && i.amount_filled > 0,
  );
  const filledBuys = items.filter(
    (i) => i.side === 'BuyBase' && i.status !== 'OutOfMoneyRefund' && i.amount_filled > 0,
  );
  const hasRefundOnly = items.some((i) => i.status === 'OutOfMoneyRefund');

  if (filledSells.length > 0 && filledBuys.length === 0 && !hasRefundOnly) {
    const totalSold = filledSells.reduce((acc, i) => acc + i.amount_filled, 0);
    const totalReceived = filledSells.reduce((acc, i) => acc + i.payout_out, 0);
    const parts = filledSells.map((i) => fmtFixed(i.amount_filled, baseDecimals)).join(' + ');
    const weightedAvgPrice =
      totalSold > 0 ? totalReceived / totalSold : filledSells[0].effective_price;
    const prices = filledSells.map((i) => i.effective_price);
    const pricesDiffer = Math.max(...prices) - Math.min(...prices) >= 0.005;

    if (!isMultiRound) {
      return `You sold ${fmtFixed(totalSold, baseDecimals)} ${config.baseSymbol} total, received ${fmtFixed(
        totalReceived,
        quoteDecimals,
      )} ${config.quoteSymbol} total (${parts} ${config.baseSymbol} → ${fmtFixed(
        totalReceived,
        quoteDecimals,
      )} ${config.quoteSymbol}) at fair price $${formatPrice(
        weightedAvgPrice,
        2,
      )}. Everyone in Round #${distinctRounds[0]} got the same price.`;
    }

    return `You sold ${fmtFixed(totalSold, baseDecimals)} ${config.baseSymbol} total, received ${fmtFixed(
      totalReceived,
      quoteDecimals,
    )} ${config.quoteSymbol} total across ${distinctRounds.length} rounds (${parts} ${config.baseSymbol} → ${fmtFixed(
      totalReceived,
      quoteDecimals,
    )} ${config.quoteSymbol}) at weighted average price $${formatPrice(
      weightedAvgPrice,
      2,
    )}${pricesDiffer ? ' (prices differ by round)' : ' (per-round prices shown below)'}.`;
  }

  if (filledBuys.length > 0 && filledSells.length === 0 && !hasRefundOnly) {
    const totalSoldQuote = filledBuys.reduce((acc, i) => acc + i.amount_filled, 0);
    const totalReceivedBase = filledBuys.reduce((acc, i) => acc + i.payout_out, 0);
    const parts = filledBuys.map((i) => fmtFixed(i.amount_filled, quoteDecimals)).join(' + ');
    const weightedAvgPrice =
      totalReceivedBase > 0 ? totalSoldQuote / totalReceivedBase : filledBuys[0].effective_price;
    const prices = filledBuys.map((i) => i.effective_price);
    const pricesDiffer = Math.max(...prices) - Math.min(...prices) >= 0.005;

    if (!isMultiRound) {
      return `You sold ${fmtFixed(totalSoldQuote, quoteDecimals)} ${config.quoteSymbol} total, received ${fmtFixed(
        totalReceivedBase,
        baseDecimals,
      )} ${config.baseSymbol} total (${parts} ${config.quoteSymbol} → ${fmtFixed(
        totalReceivedBase,
        baseDecimals,
      )} ${config.baseSymbol}) at fair price $${formatPrice(
        weightedAvgPrice,
        2,
      )}. Everyone in Round #${distinctRounds[0]} got the same price.`;
    }

    return `You sold ${fmtFixed(totalSoldQuote, quoteDecimals)} ${config.quoteSymbol} total, received ${fmtFixed(
      totalReceivedBase,
      baseDecimals,
    )} ${config.baseSymbol} total across ${distinctRounds.length} rounds (${parts} ${config.quoteSymbol} → ${fmtFixed(
      totalReceivedBase,
      baseDecimals,
    )} ${config.baseSymbol}) at weighted average price $${formatPrice(
      weightedAvgPrice,
      2,
    )}${pricesDiffer ? ' (prices differ by round)' : ' (per-round prices shown below)'}.`;
  }

  const totalBaseOut = items.reduce(
    (acc, i) => acc + (i.side === 'BuyBase' ? i.payout_out : i.refund_in),
    0,
  );
  const totalQuoteOut = items.reduce(
    (acc, i) => acc + (i.side === 'SellBase' ? i.payout_out : i.refund_in),
    0,
  );
  return `You have ${items.length} completed orders ${
    isMultiRound
      ? `across ${distinctRounds.length} rounds (prices differ by round)`
      : `in Round #${distinctRounds[0]}`
  } ready to collect (${fmtFixed(totalBaseOut, baseDecimals)} ${config.baseSymbol} + ${fmtFixed(
    totalQuoteOut,
    quoteDecimals,
  )} ${config.quoteSymbol} total).`;
}

export const SimpleCollectCard: React.FC<SimpleCollectCardProps> = ({
  config,
  unclaimed,
  settledHistory,
  lastCollected,
  busyAction,
  txStatus,
  onCollectOne,
  onCollectAll,
  onSwapAgain,
}) => {
  const busy = busyAction !== null;

  if (unclaimed.length === 0 && lastCollected) {
    const txUrl = explorerTxUrl(config, lastCollected.hash);
    const totalBase = lastCollected.items.reduce(
      (acc, i) => acc + (i.side === 'BuyBase' ? i.payout_out : i.refund_in),
      0,
    );
    const totalQuote = lastCollected.items.reduce(
      (acc, i) => acc + (i.side === 'SellBase' ? i.payout_out : i.refund_in),
      0,
    );

    return (
      <section
        aria-label="Swap complete"
        data-testid="simple-collect-success"
        className="ledger-panel overflow-hidden"
      >
        <div className="border-b border-rule bg-pine-50 px-5 py-5">
          <div className="flex items-center gap-2 font-mono text-xs font-bold uppercase tracking-label text-pine-800">
            <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
            <span>Swap complete</span>
          </div>
          <h2 className="mt-2 font-display text-2xl font-bold text-ink">
            Your tokens are in your wallet
          </h2>
          <p className="mt-1 text-sm text-ink-soft">
            {totalBase > 0 && totalQuote > 0
              ? `Collected ${formatTokenAmount(totalBase, 'base')} ${config.baseSymbol} and ${formatTokenAmount(totalQuote, 'quote')} ${config.quoteSymbol}.`
              : totalQuote > 0
                ? `Collected ${formatTokenAmount(totalQuote, 'quote')} ${config.quoteSymbol}.`
                : `Collected ${formatTokenAmount(totalBase, 'base')} ${config.baseSymbol}.`}
          </p>
        </div>

        <div className="space-y-4 p-5">
          {txUrl && (
            <a
              href={txUrl}
              target="_blank"
              rel="noreferrer"
              className="tap-target inline-flex w-full items-center justify-center gap-2 border border-rule-strong bg-paper-soft px-4 font-sans text-sm font-bold text-ink transition hover:border-ink"
            >
              <span>View transaction on Sepolia Etherscan</span>
              <ExternalLink className="h-4 w-4" aria-hidden="true" />
            </a>
          )}

          <button
            type="button"
            data-testid="simple-swap-again-button"
            onClick={onSwapAgain}
            className="tap-target inline-flex w-full items-center justify-center gap-2 bg-ink px-5 py-3.5 font-display text-base font-bold text-paper transition hover:bg-ink-soft"
          >
            <span>Swap again</span>
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      </section>
    );
  }

  if (unclaimed.length === 0) return null;

  // Sort ready orders ascending by (batch_id, order_id) so rows always match the headline round order.
  const orderedUnclaimed = [...unclaimed].sort(
    (a, b) => a.batch_id - b.batch_id || a.order_id - b.order_id,
  );
  const primary = orderedUnclaimed[0];
  const distinctRounds = Array.from(new Set(orderedUnclaimed.map((i) => i.batch_id)));

  // Pick reconciled precision so individually displayed row amounts always sum to the headline total.
  const baseValues = orderedUnclaimed.flatMap((i) => {
    const arr: number[] = [];
    if (i.side === 'SellBase') {
      arr.push(i.amount_filled > 0 ? i.amount_filled : i.amount_in);
      if (i.refund_in > 0) arr.push(i.refund_in);
    } else if (i.payout_out > 0) {
      arr.push(i.payout_out);
    }
    return arr;
  });
  const quoteValues = orderedUnclaimed.flatMap((i) => {
    const arr: number[] = [];
    if (i.side === 'SellBase') {
      if (i.payout_out > 0) arr.push(i.payout_out);
    } else {
      arr.push(i.amount_filled > 0 ? i.amount_filled : i.amount_in);
      if (i.refund_in > 0) arr.push(i.refund_in);
    }
    return arr;
  });
  const baseDecimals = pickReconciledDecimals(baseValues, 2, 6);
  const quoteDecimals = pickReconciledDecimals(quoteValues, 2, 6);

  const primaryBatch =
    distinctRounds.length === 1
      ? settledHistory.find((s) => s.batch_id === primary.batch_id)
      : undefined;
  // Show comparison badge ONLY for a single round when signed diff vs unattacked AMM is strictly positive (> $0.01).
  const realSavingsQuote =
    primaryBatch && primaryBatch.comparison.user_value_saved_quote > 0.01
      ? primaryBatch.comparison.user_value_saved_quote
      : null;

  const handleCollect = async () => {
    if (orderedUnclaimed.length === 1) {
      await onCollectOne(orderedUnclaimed[0]);
    } else {
      await onCollectAll(orderedUnclaimed);
    }
  };

  return (
    <section
      aria-label="Collect completed swap"
      data-testid="simple-collect-card"
      className="ledger-panel overflow-hidden"
    >
      <div className="border-b border-rule bg-pine-50 px-5 py-4">
        <div className="flex items-center gap-2 font-mono text-xs font-bold uppercase tracking-label text-pine-800">
          <Coins className="h-4 w-4" aria-hidden="true" />
          <span>
            Ready to collect · {orderedUnclaimed.length} completed order
            {orderedUnclaimed.length === 1 ? '' : 's'}
          </span>
        </div>
        <h2 className="mt-2 font-display text-2xl font-bold text-ink">
          {distinctRounds.length === 1
            ? `Round #${primary.batch_id} finished!`
            : `Rounds ${distinctRounds.map((id) => `#${id}`).join(', ')} finished!`}
        </h2>
        <p
          data-testid="simple-collect-summary"
          className="mt-1.5 text-base leading-relaxed text-ink"
        >
          {summarizeReceipts(orderedUnclaimed, config, baseDecimals, quoteDecimals)}
        </p>

        {realSavingsQuote !== null && (
          <div
            data-testid="simple-simulated-saving"
            className="mt-3 inline-flex flex-wrap items-center gap-1.5 border border-pine-600/50 bg-paper-bright px-3 py-1.5 text-xs font-bold text-pine-800 sm:text-sm"
          >
            <ShieldCheck className="h-4 w-4 shrink-0 text-pine-700" aria-hidden="true" />
            <span>
              Simulated vs unattacked 0.30% x·y=k AMM (Round #{primary.batch_id}): +
              {formatUsd(realSavingsQuote)}
            </span>
            <InfoTooltip
              label="Simulated saving baseline"
              text={PRO_TOOLTIPS.simulatedSaving}
            />
          </div>
        )}
      </div>

      <div className="space-y-4 p-5">
        <div className="space-y-2">
          <div className="eyebrow">
            {orderedUnclaimed.length > 1 ? 'All ready orders (per-round details)' : 'Order receipt'}
          </div>
          {orderedUnclaimed.map((item) => {
            const outSym =
              item.side === 'SellBase' ? config.quoteSymbol : config.baseSymbol;
            const inSym =
              item.side === 'SellBase' ? config.baseSymbol : config.quoteSymbol;
            const soldAmount =
              item.amount_filled > 0 ? item.amount_filled : item.amount_in;
            const formattedSold =
              inSym === config.quoteSymbol
                ? fmtFixed(soldAmount, quoteDecimals)
                : fmtFixed(soldAmount, baseDecimals);

            return (
              <div
                key={`${item.batch_id}-${item.order_id}`}
                data-testid={`simple-collect-row-${item.batch_id}-${item.order_id}`}
                className="flex flex-wrap items-center justify-between gap-2 border border-rule bg-paper-soft px-3.5 py-2.5 text-sm"
              >
                <div className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5">
                  <span className="font-bold text-ink">
                    Round #{item.batch_id} · Order #{item.order_id}
                  </span>
                  <span className="font-mono text-xs text-ink-soft tabular-nums">
                    {item.status === 'OutOfMoneyRefund'
                      ? `Unfilled ${formattedSold} ${inSym}`
                      : `Sold ${formattedSold} ${inSym} @ $${formatPrice(item.effective_price, 2)}`}
                  </span>
                </div>
                <span className="font-mono text-sm font-bold text-pine-800 tabular-nums">
                  →{' '}
                  {item.payout_out > 0
                    ? `${
                        outSym === config.quoteSymbol
                          ? fmtFixed(item.payout_out, quoteDecimals)
                          : fmtFixed(item.payout_out, baseDecimals)
                      } ${outSym}`
                    : ''}
                  {item.refund_in > 0
                    ? `${item.payout_out > 0 ? ' + ' : ''}${
                        inSym === config.quoteSymbol
                          ? fmtFixed(item.refund_in, quoteDecimals)
                          : fmtFixed(item.refund_in, baseDecimals)
                      } ${inSym} refund`
                    : ''}
                </span>
              </div>
            );
          })}
        </div>

        <button
          type="button"
          data-testid="simple-collect-button"
          disabled={busy}
          onClick={() => void handleCollect()}
          className="tap-target inline-flex w-full items-center justify-center gap-2 bg-pine-600 px-5 py-3.5 font-display text-base font-bold text-[#FBF8F0] transition hover:bg-pine-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? (
            <>
              <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
              <span>{txStatus ?? 'Collecting tokens…'}</span>
            </>
          ) : (
            <>
              <Coins className="h-5 w-5" aria-hidden="true" />
              <span>
                {unclaimed.length === 1
                  ? UI_LABELS.collectTokens
                  : UI_LABELS.collectAllOrders(unclaimed.length)}
              </span>
            </>
          )}
        </button>
      </div>
    </section>
  );
};
