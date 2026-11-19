import React, { useEffect, useRef } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Gavel,
  RefreshCw,
  ShieldAlert,
  Timer,
} from 'lucide-react';
import type { BatchPhase } from '../types';
import type { ChainCommitment, RawBatchInfo } from '../onchain/state';
import { phaseLabel } from '../onchain/state';
import type { RuntimeConfig } from '../onchain/config';
import { formatToken, shortenAddress } from '../lib/format';
import { useNow } from '../lib/useNow';

interface BatchConsoleProps {
  batch: RawBatchInfo;
  phase: BatchPhase;
  config: RuntimeConfig;
  account: string | null;
  commitments: ChainCommitment[];
  busyAction: string | null;
  refreshing: boolean;
  onSettle: () => Promise<void>;
  onSlash: (batchId: number, commitId: number) => Promise<void>;
  onRefresh: () => void;
}

function formatCountdown(totalSeconds: number): string {
  const safe = Math.max(0, totalSeconds);
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export const BatchConsole: React.FC<BatchConsoleProps> = ({
  batch,
  phase,
  config,
  account,
  commitments,
  busyAction,
  refreshing,
  onSettle,
  onSlash,
  onRefresh,
}) => {
  const now = useNow();
  const busy = busyAction !== null;

  const deadline =
    phase === 'Open'
      ? Number(batch.commitDeadline)
      : phase === 'Reveal'
        ? Number(batch.revealDeadline)
        : null;
  const remaining = deadline === null ? 0 : Math.max(0, deadline - now);
  const windowSeconds =
    phase === 'Open'
      ? Number(batch.commitDeadline - batch.startTime)
      : phase === 'Reveal'
        ? Number(batch.revealDeadline - batch.commitDeadline)
        : 1;
  const progress =
    deadline === null
      ? 1
      : Math.min(1, Math.max(0, 1 - remaining / Math.max(1, windowSeconds)));

  const refreshedDeadlineRef = useRef<string>('');
  useEffect(() => {
    if (deadline === null) return;
    if (now < deadline) return;
    const key = `${batch.batchId}:${deadline}`;
    if (refreshedDeadlineRef.current === key) return;
    refreshedDeadlineRef.current = key;
    onRefresh();
  }, [batch.batchId, deadline, now, onRefresh]);

  const slashable = commitments.filter(
    (commitment) =>
      !commitment.revealed &&
      !commitment.slashed &&
      (commitment.batch_id < Number(batch.batchId) || phase === 'Ready'),
  );

  const phaseTone =
    phase === 'Open'
      ? 'border-ink bg-ink text-paper'
      : phase === 'Reveal'
        ? 'border-brass-600 bg-brass-500 text-paper'
        : phase === 'Ready'
          ? 'border-vermilion-600 bg-vermilion-500 text-paper'
          : 'border-pine-700 bg-pine-600 text-paper';

  return (
    <section aria-label="Batch clock and settlement console" className="ledger-panel overflow-hidden">
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-rule px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <Timer className="h-3 w-3 text-vermilion-600" aria-hidden="true" />
            <span className="eyebrow">Auction clock</span>
          </div>
          <h2 className="mt-1 font-display text-xl font-bold leading-tight tracking-tight text-ink">
            Batch #{Number(batch.batchId)} · {phaseLabel(phase)}
          </h2>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing}
          className="inline-flex items-center gap-1 border border-rule-strong px-2 py-1 font-mono text-[9px] font-bold uppercase tracking-[0.06em] text-ink-muted transition hover:border-ink hover:text-ink disabled:opacity-40"
        >
          <RefreshCw className={`h-3 w-3 ${refreshing ? 'animate-spin' : ''}`} />
          <span>{refreshing ? 'Syncing' : 'Refresh'}</span>
        </button>
      </div>

      <div className="space-y-3 p-4">
        <div className={`border px-3 py-2.5 ${phaseTone}`}>
          <div className="flex items-baseline justify-between gap-2">
            <span className="font-mono text-[9px] font-bold uppercase tracking-label opacity-80">
              {phase === 'Open'
                ? 'Commit window closes in'
                : phase === 'Reveal'
                  ? 'Reveal window closes in'
                  : phase === 'Ready'
                    ? 'Reveal window closed'
                    : 'Batch settled'}
            </span>
            {deadline !== null ? (
              <span className="font-mono text-lg font-bold tabular-nums">
                {formatCountdown(remaining)}
              </span>
            ) : (
              <CheckCircle2 className="h-4 w-4" />
            )}
          </div>
          <div className="mt-2 h-1 w-full bg-paper/25">
            <div
              className="h-1 bg-paper transition-[width] duration-1000"
              style={{ width: `${progress * 100}%` }}
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-px border border-rule bg-rule">
          <div className="bg-paper-bright p-2.5">
            <div className="font-mono text-[8px] uppercase tracking-label text-ink-faint">
              Orders queued
            </div>
            <div className="mt-1 font-mono text-lg font-bold text-ink tabular-nums">
              {Number(batch.orderCount)}
            </div>
          </div>
          <div className="bg-paper-bright p-2.5">
            <div className="font-mono text-[8px] uppercase tracking-label text-ink-faint flex items-center gap-1">
              <Gavel className="h-3 w-3 text-brass-600" />
              Commitments
            </div>
            <div className="mt-1 font-mono text-lg font-bold text-brass-700 tabular-nums">
              {Number(batch.commitCount)}
            </div>
          </div>
        </div>

        {phase === 'Ready' ? (
          <div className="space-y-2 border-l-2 border-vermilion-500 bg-vermilion-50 px-3 py-2.5">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-vermilion-600" />
              <p className="text-[10.5px] leading-relaxed text-vermilion-900">
                The window is closed. Settlement is permissionless: any connected wallet can
                compute the uniform clearing price and open Batch #{Number(batch.batchId) + 1}.
              </p>
            </div>
            <button
              type="button"
              data-testid="settle-batch-button"
              disabled={!account || busy}
              onClick={() => void onSettle()}
              className="inline-flex w-full items-center justify-center gap-2 border border-pine-700 bg-pine-600 px-3 py-2.5 font-display text-sm font-bold text-paper transition hover:bg-pine-700 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
              <span>
                {!account
                  ? 'Connect a wallet to settle'
                  : busyAction === 'settle'
                    ? 'Settling batch…'
                    : `Settle Batch #${Number(batch.batchId)} & open next`}
              </span>
            </button>
          </div>
        ) : phase === 'Settled' ? (
          <div className="flex items-start gap-2 border-l-2 border-pine-600 bg-pine-50 px-3 py-2.5 text-[10.5px] leading-relaxed text-pine-800">
            <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>Batch #{Number(batch.batchId)} is settled. Pull claims are in the claims ledger.</span>
          </div>
        ) : (
          <div className="flex items-start gap-2 border-l-2 border-brass-500 bg-brass-50 px-3 py-2.5 text-[10.5px] leading-relaxed text-brass-900">
            <Clock3 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              {phase === 'Open'
                ? 'Submit direct orders, seal commitments, or sign an EIP-712 intent. Settlement opens after the reveal window.'
                : 'Reveal sealed commitments or submit a signed intent. Settlement opens when this window closes.'}
            </span>
          </div>
        )}

        {slashable.length > 0 && (
          <div className="border border-rule bg-paper-soft p-2.5">
            <div className="flex items-center gap-1.5 font-mono text-[9px] font-bold uppercase tracking-label text-ink-soft">
              <ShieldAlert className="h-3 w-3 text-vermilion-600" />
              Unrevealed bonds · slashable
            </div>
            <div className="mt-2 divide-y divide-rule/70">
              {slashable.slice(0, 5).map((commitment) => (
                <div
                  key={`${commitment.batch_id}-${commitment.commit_id}`}
                  className="flex items-center justify-between gap-2 py-1.5"
                >
                  <span className="min-w-0 truncate font-mono text-[9.5px] text-ink-muted">
                    B#{commitment.batch_id} · #{commitment.commit_id} ·{' '}
                    {shortenAddress(commitment.trader)} · {formatToken(commitment.bond_eth, 4, 4)} ETH
                  </span>
                  <button
                    type="button"
                    disabled={!account || busy}
                    onClick={() =>
                      void onSlash(commitment.batch_id, commitment.commit_id)
                    }
                    className="shrink-0 border border-vermilion-600/50 bg-vermilion-50 px-2 py-1 font-mono text-[8.5px] font-bold uppercase tracking-[0.06em] text-vermilion-700 transition hover:bg-vermilion-500 hover:text-paper disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Slash
                  </button>
                </div>
              ))}
            </div>
            <p className="mt-1.5 border-t border-rule/70 pt-1.5 font-mono text-[8.5px] leading-relaxed text-ink-faint">
              Permissionless after the reveal deadline. Forfeited bond accrues to {config.baseSymbol}/
              {config.quoteSymbol} LPs.
            </p>
          </div>
        )}
      </div>
    </section>
  );
};
