import React, { useMemo, useState } from 'react';
import {
  CheckCircle2,
  Coins,
  Layers,
  Lock,
  Sparkles,
} from 'lucide-react';
import type { ClaimableDto } from '../types';
import { formatPrice, formatToken, shortenAddress } from '../lib/format';

interface ClaimsPanelProps {
  claimable: ClaimableDto[];
  selectedTraderAddress: string;
  busyAction: string | null;
  onClaimSingle: (item: ClaimableDto) => Promise<void>;
  onMulticallClaimAll: (items: ClaimableDto[], trader: string) => Promise<void>;
}

export const ClaimsPanel: React.FC<ClaimsPanelProps> = ({
  claimable,
  selectedTraderAddress,
  busyAction,
  onClaimSingle,
  onMulticallClaimAll,
}) => {
  const [filterTraderOnly, setFilterTraderOnly] = useState<boolean>(false);
  const [lastClaimToast, setLastClaimToast] = useState<string | null>(null);

  const filteredClaims = useMemo(() => {
    if (!filterTraderOnly) return claimable;
    return claimable.filter(
      (c) => c.trader.toLowerCase() === selectedTraderAddress.toLowerCase(),
    );
  }, [claimable, filterTraderOnly, selectedTraderAddress]);

  const unclaimedForSelected = useMemo(
    () =>
      claimable.filter(
        (c) =>
          !c.claimed &&
          c.trader.toLowerCase() === selectedTraderAddress.toLowerCase(),
      ),
    [claimable, selectedTraderAddress],
  );

  const allUnclaimed = useMemo(
    () => filteredClaims.filter((c) => !c.claimed),
    [filteredClaims],
  );

  const handleMulticall = async () => {
    const targetList =
      unclaimedForSelected.length > 0 ? unclaimedForSelected : allUnclaimed;
    if (targetList.length === 0) return;

    // Group by trader if claiming across demo accounts or single trader
    const targetTrader =
      unclaimedForSelected.length > 0
        ? selectedTraderAddress
        : targetList[0].trader;
    const sameTraderClaims = targetList.filter(
      (c) => c.trader.toLowerCase() === targetTrader.toLowerCase(),
    );

    await onMulticallClaimAll(sameTraderClaims, targetTrader);
    setLastClaimToast(
      `Executed Multicall claim for ${sameTraderClaims.length} settled receipt(s) (${shortenAddress(targetTrader)})`,
    );
  };

  return (
    <section
      aria-label="Pull-Over-Push Settlement Claims Center"
      className="ledger-panel overflow-hidden"
    >
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3 border-b border-rule px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <Coins className="h-3 w-3 text-pine-700" aria-hidden="true" />
            <span className="eyebrow">Claims ledger</span>
          </div>
          <h2 className="mt-1 font-display text-xl font-bold leading-tight tracking-tight text-ink">
            Pull-over-push settlement claims
          </h2>
          <p className="mt-0.5 text-[11px] leading-relaxed text-ink-muted">
            Guarded by EIP-1153 <code className="text-ink-soft">Mutex</code> — isolated
            claims prevent a USDC blacklist DoS on{' '}
            <code className="text-ink-soft">settle_batch()</code>.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => setFilterTraderOnly(!filterTraderOnly)}
            className={`border px-2 py-1.5 font-mono text-[9px] font-bold uppercase tracking-[0.06em] transition ${
              filterTraderOnly
                ? 'border-cobalt-700 bg-cobalt-600 text-paper'
                : 'border-rule-strong bg-paper-bright text-ink-muted hover:border-ink hover:text-ink'
            }`}
          >
            {filterTraderOnly ? 'Showing active trader' : 'Showing all batch claims'}
          </button>

          <button
            type="button"
            disabled={allUnclaimed.length === 0 || busyAction !== null}
            onClick={handleMulticall}
            className="inline-flex items-center gap-1.5 border border-pine-700 bg-pine-600 px-2.5 py-1.5 font-mono text-[9px] font-bold uppercase tracking-[0.06em] text-paper transition hover:bg-pine-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Layers className="h-3 w-3" aria-hidden="true" />
            <span>
              Multicall Batch Claim (
              {unclaimedForSelected.length > 0
                ? unclaimedForSelected.length
                : allUnclaimed.length > 0
                  ? allUnclaimed.filter(
                      (c) =>
                        c.trader.toLowerCase() ===
                        allUnclaimed[0].trader.toLowerCase(),
                    ).length
                  : 0}
              )
            </span>
          </button>
        </div>
      </div>

      {lastClaimToast && (
        <div className="flex items-center gap-2 border-b border-pine-600/30 bg-pine-50 px-4 py-2 font-mono text-[10px] text-pine-800">
          <Sparkles className="h-3 w-3 shrink-0" />
          <span>{lastClaimToast}</span>
        </div>
      )}

      <div className="max-h-64 divide-y divide-rule/70 overflow-y-auto">
        {filteredClaims.length === 0 ? (
          <div className="flex flex-col items-center justify-center px-4 py-8 text-center">
            <Lock className="mb-2 h-4 w-4 text-ink-faint" aria-hidden="true" />
            <p className="max-w-md text-[11px] leading-relaxed text-ink-muted">
              No settled claims yet. Click <strong className="text-ink">&ldquo;Settle Batch Now&rdquo;</strong>{' '}
              in the batch band to generate pull-claimable payouts &amp; refunds.
            </p>
          </div>
        ) : (
          filteredClaims.map((item) => {
            const outUnit = item.side === 'SellBase' ? 'USDC' : 'WETH';
            const inUnit = item.side === 'SellBase' ? 'WETH' : 'USDC';
            return (
              <div
                key={`${item.batch_id}-${item.order_id}`}
                className={`flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-2.5 text-[11px] ${
                  item.claimed ? 'bg-paper-soft/60' : 'bg-paper-bright'
                }`}
              >
                <div className="flex min-w-0 items-center gap-3">
                  <span className="shrink-0 border border-ink bg-ink px-1.5 py-0.5 font-mono text-[9px] font-bold text-paper tabular-nums">
                    B#{item.batch_id} · #{item.order_id}
                  </span>
                  <div className="min-w-0">
                    <div className="font-semibold text-ink">
                      {item.label}{' '}
                      <span className="font-mono text-[9px] font-normal text-ink-faint">
                        ({shortenAddress(item.trader)})
                      </span>
                    </div>
                    <div className="mt-0.5 font-mono text-[10px] text-ink-muted tabular-nums">
                      Payout:{' '}
                      <span className="font-bold text-pine-700">
                        {outUnit === 'USDC'
                          ? formatPrice(item.payout_out, 2)
                          : formatToken(item.payout_out, 4)}{' '}
                        {outUnit}
                      </span>
                      {item.refund_in > 0 && (
                        <>
                          {' '}
                          · Refund:{' '}
                          <span className="font-bold text-brass-700">
                            {formatToken(item.refund_in, 3)} {inUnit}
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                </div>

                <div>
                  {item.claimed ? (
                    <span
                      data-testid={`claimed-badge-${item.batch_id}-${item.order_id}`}
                      className="inline-flex items-center gap-1 border border-pine-600/40 bg-pine-50 px-2 py-1 font-mono text-[9px] font-bold uppercase tracking-[0.06em] text-pine-700"
                    >
                      <CheckCircle2 className="h-3 w-3" />
                      <span>Claimed</span>
                    </span>
                  ) : (
                    <button
                      type="button"
                      disabled={busyAction !== null}
                      onClick={async () => {
                        await onClaimSingle(item);
                        setLastClaimToast(
                          `Claimed Batch #${item.batch_id} Order #${item.order_id} payout.`,
                        );
                      }}
                      className="border border-pine-700 bg-pine-50 px-2.5 py-1 font-mono text-[9px] font-bold uppercase tracking-[0.06em] text-pine-800 transition hover:bg-pine-600 hover:text-paper disabled:opacity-40"
                    >
                      Claim Payout
                    </button>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </section>
  );
};
