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
      className="rounded-2xl border border-slate-800/90 bg-[#0D1321]/95 p-4 shadow-xl"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 pb-3">
        <div>
          <div className="flex items-center gap-2">
            <Coins className="h-4 w-4 text-emerald-400" aria-hidden="true" />
            <h2 className="text-sm font-bold text-white">
              Pull-Over-Push Settlement Claims (`std::evm::multicall`)
            </h2>
          </div>
          <p className="mt-0.5 text-xs text-slate-400">
            Guarded by EIP-1153 `Mutex` — isolated claims prevent USDC blacklist DoS on `settle_batch()`
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setFilterTraderOnly(!filterTraderOnly)}
            className={`rounded-lg border px-2.5 py-1.5 text-xs font-medium transition ${
              filterTraderOnly
                ? 'border-cyan-500/50 bg-cyan-500/15 text-cyan-300'
                : 'border-slate-700 bg-[#111827] text-slate-300 hover:bg-slate-800'
            }`}
          >
            {filterTraderOnly ? 'Showing Active Trader' : 'Showing All Batch Claims'}
          </button>

          <button
            type="button"
            disabled={allUnclaimed.length === 0 || busyAction !== null}
            onClick={handleMulticall}
            className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-bold text-slate-950 shadow-glow-emerald transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Layers className="h-3.5 w-3.5" aria-hidden="true" />
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
        <div className="mt-3 flex items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-300">
          <Sparkles className="h-3.5 w-3.5 shrink-0" />
          <span>{lastClaimToast}</span>
        </div>
      )}

      <div className="mt-3 max-h-60 overflow-y-auto space-y-2 pr-1">
        {filteredClaims.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-slate-800 py-6 text-center">
            <Lock className="mb-1.5 h-5 w-5 text-slate-600" aria-hidden="true" />
            <p className="text-xs font-medium text-slate-400">
              No settled claims yet. Click <strong>&ldquo;Settle Batch Now&rdquo;</strong> in the top bar to generate pull-claimable payouts &amp; refunds.
            </p>
          </div>
        ) : (
          filteredClaims.map((item) => {
            const outUnit = item.side === 'SellBase' ? 'USDC' : 'WETH';
            const inUnit = item.side === 'SellBase' ? 'WETH' : 'USDC';
            return (
              <div
                key={`${item.batch_id}-${item.order_id}`}
                className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-800 bg-[#090D16] px-3.5 py-2.5 text-xs"
              >
                <div className="flex items-center gap-2.5">
                  <span className="rounded border border-slate-700 bg-[#111827] px-2 py-0.5 font-mono text-[11px] font-bold text-slate-300">
                    B#{item.batch_id} · #{item.order_id}
                  </span>
                  <div>
                    <div className="font-semibold text-white">
                      {item.label}{' '}
                      <span className="font-mono text-[11px] font-normal text-slate-400">
                        ({shortenAddress(item.trader)})
                      </span>
                    </div>
                    <div className="font-mono text-[11px] text-slate-400 tabular-nums">
                      Payout:{' '}
                      <span className="font-semibold text-emerald-300">
                        {outUnit === 'USDC'
                          ? formatPrice(item.payout_out, 2)
                          : formatToken(item.payout_out, 4)}{' '}
                        {outUnit}
                      </span>
                      {item.refund_in > 0 && (
                        <>
                          {' '}
                          · Refund:{' '}
                          <span className="font-semibold text-amber-300">
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
                      className="inline-flex items-center gap-1 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 font-mono text-[11px] font-semibold text-emerald-300"
                    >
                      <CheckCircle2 className="h-3.5 w-3.5" />
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
                      className="rounded-lg border border-emerald-400/50 bg-emerald-500/20 px-3 py-1.5 text-xs font-bold text-emerald-200 transition hover:bg-emerald-500 hover:text-slate-950 disabled:opacity-40"
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
