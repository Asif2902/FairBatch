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
import { formatPrice, formatToken, formatUsd } from '../../lib/format';
import { PRO_TOOLTIPS } from '../../lib/glossary';
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

function summarizeSingleReceipt(item: ClaimableDto, config: RuntimeConfig): string {
  if (item.status === 'OutOfMoneyRefund') {
    const inSym = item.side === 'SellBase' ? config.baseSymbol : config.quoteSymbol;
    const refunded =
      item.side === 'SellBase'
        ? formatToken(item.refund_in, 4)
        : formatPrice(item.refund_in, 2);
    return `Round #${item.batch_id} cleared outside your price limit, so your full ${refunded} ${inSym} is ready to collect back.`;
  }

  if (item.side === 'SellBase') {
    return `You sold ${formatToken(item.amount_filled, 4)} ${config.baseSymbol}, received ${formatPrice(
      item.payout_out,
      2,
    )} ${config.quoteSymbol} at fair price $${formatPrice(
      item.effective_price,
      2,
    )}. Everyone in this round got the same price.`;
  }

  return `You spent ${formatPrice(item.amount_filled, 2)} ${config.quoteSymbol}, received ${formatToken(
    item.payout_out,
    4,
  )} ${config.baseSymbol} at fair price $${formatPrice(
    item.effective_price,
    2,
  )}. Everyone in this round got the same price.`;
}

function summarizeRoundReceipts(items: ClaimableDto[], config: RuntimeConfig): string {
  if (items.length === 1) {
    return summarizeSingleReceipt(items[0], config);
  }

  const filledSells = items.filter(
    (i) => i.side === 'SellBase' && i.status !== 'OutOfMoneyRefund' && i.amount_filled > 0,
  );
  const filledBuys = items.filter(
    (i) => i.side === 'BuyBase' && i.status !== 'OutOfMoneyRefund' && i.amount_filled > 0,
  );

  if (filledSells.length > 0 && filledBuys.length === 0) {
    const totalSold = filledSells.reduce((acc, i) => acc + i.amount_filled, 0);
    const totalReceived = filledSells.reduce((acc, i) => acc + i.payout_out, 0);
    const parts = filledSells.map((i) => formatToken(i.amount_filled, 4, 2)).join(' + ');
    const fairPrice = filledSells[0].effective_price;
    return `You sold ${formatToken(totalSold, 4, 2)} ${config.baseSymbol} total, received ${formatPrice(
      totalReceived,
      2,
    )} ${config.quoteSymbol} total (${parts} ${config.baseSymbol} → ${formatPrice(
      totalReceived,
      2,
    )} ${config.quoteSymbol}) at fair price $${formatPrice(
      fairPrice,
      2,
    )}. Everyone in this round got the same price.`;
  }

  if (filledBuys.length > 0 && filledSells.length === 0) {
    const totalSoldQuote = filledBuys.reduce((acc, i) => acc + i.amount_filled, 0);
    const totalReceivedBase = filledBuys.reduce((acc, i) => acc + i.payout_out, 0);
    const parts = filledBuys.map((i) => formatPrice(i.amount_filled, 2)).join(' + ');
    const fairPrice = filledBuys[0].effective_price;
    return `You sold ${formatPrice(totalSoldQuote, 2)} ${config.quoteSymbol} total, received ${formatToken(
      totalReceivedBase,
      4,
      2,
    )} ${config.baseSymbol} total (${parts} ${config.quoteSymbol} → ${formatToken(
      totalReceivedBase,
      4,
      2,
    )} ${config.baseSymbol}) at fair price $${formatPrice(
      fairPrice,
      2,
    )}. Everyone in this round got the same price.`;
  }

  const totalBaseOut = items.reduce(
    (acc, i) => acc + (i.side === 'BuyBase' ? i.payout_out : i.refund_in),
    0,
  );
  const totalQuoteOut = items.reduce(
    (acc, i) => acc + (i.side === 'SellBase' ? i.payout_out : i.refund_in),
    0,
  );
  return `You have ${items.length} completed orders ready to collect (${formatToken(
    totalBaseOut,
    4,
  )} ${config.baseSymbol} + ${formatPrice(totalQuoteOut, 2)} ${config.quoteSymbol} total).`;
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
              ? `Collected ${formatToken(totalBase, 4)} ${config.baseSymbol} and ${formatPrice(totalQuote, 2)} ${config.quoteSymbol}.`
              : totalQuote > 0
                ? `Collected ${formatPrice(totalQuote, 2)} ${config.quoteSymbol}.`
                : `Collected ${formatToken(totalBase, 4)} ${config.baseSymbol}.`}
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

  const primary = unclaimed[0];
  const sameRoundItems = unclaimed.filter((i) => i.batch_id === primary.batch_id);
  const aggregatedItems = sameRoundItems.length > 1 ? sameRoundItems : unclaimed;
  const distinctRounds = Array.from(new Set(unclaimed.map((i) => i.batch_id)));

  const primaryBatch = settledHistory.find((s) => s.batch_id === primary.batch_id);
  // Show savings line ONLY when the signed comparison math shows a real positive saving (> $0.01).
  const realSavingsQuote =
    primaryBatch && primaryBatch.comparison.user_value_saved_quote > 0.01
      ? primaryBatch.comparison.user_value_saved_quote
      : null;

  const handleCollect = async () => {
    if (unclaimed.length === 1) {
      await onCollectOne(unclaimed[0]);
    } else {
      await onCollectAll(unclaimed);
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
            Ready to collect · {unclaimed.length} completed order
            {unclaimed.length === 1 ? '' : 's'}
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
          {summarizeRoundReceipts(aggregatedItems, config)}
        </p>

        {realSavingsQuote !== null && (
          <div
            data-testid="simple-simulated-saving"
            className="mt-3 inline-flex flex-wrap items-center gap-1.5 border border-pine-600/50 bg-paper-bright px-3 py-1.5 text-xs font-bold text-pine-800 sm:text-sm"
          >
            <ShieldCheck className="h-4 w-4 shrink-0 text-pine-700" aria-hidden="true" />
            <span>
              Simulated saving vs a normal swap (0.30% x·y=k baseline):{' '}
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
            {unclaimed.length > 1 ? 'All ready orders' : 'Order receipt'}
          </div>
          {unclaimed.map((item) => {
            const outSym =
              item.side === 'SellBase' ? config.quoteSymbol : config.baseSymbol;
            const inSym =
              item.side === 'SellBase' ? config.baseSymbol : config.quoteSymbol;
            const soldAmount =
              item.amount_filled > 0 ? item.amount_filled : item.amount_in;
            const formattedSold =
              inSym === config.quoteSymbol
                ? formatPrice(soldAmount, 2)
                : formatToken(soldAmount, 4, 2);

            return (
              <div
                key={`${item.batch_id}-${item.order_id}`}
                data-testid={`simple-collect-row-${item.batch_id}-${item.order_id}`}
                className="flex flex-wrap items-center justify-between gap-2 border border-rule bg-paper-soft px-3.5 py-2.5 text-sm"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-bold text-ink">
                    Round #{item.batch_id} · Order #{item.order_id}
                  </span>
                  <span className="font-mono text-xs text-ink-soft tabular-nums">
                    Sold {formattedSold} {inSym}
                  </span>
                </div>
                <span className="font-mono text-sm font-bold text-pine-800 tabular-nums">
                  →{' '}
                  {item.payout_out > 0
                    ? `${
                        outSym === config.quoteSymbol
                          ? formatPrice(item.payout_out, 2)
                          : formatToken(item.payout_out, 4)
                      } ${outSym}`
                    : ''}
                  {item.refund_in > 0
                    ? `${item.payout_out > 0 ? ' + ' : ''}${
                        inSym === config.quoteSymbol
                          ? formatPrice(item.refund_in, 2)
                          : formatToken(item.refund_in, 4)
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
                  ? 'Collect tokens'
                  : `Collect all ${unclaimed.length} orders (one click)`}
              </span>
            </>
          )}
        </button>
      </div>
    </section>
  );
};
