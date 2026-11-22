import React, { useState } from 'react';
import { ChevronDown, ChevronUp, ExternalLink } from 'lucide-react';
import type { BatchPhase, StateResponse } from '../types';
import type { RawBatchInfo } from '../onchain/state';
import { explorerAddressUrl, type RuntimeConfig } from '../onchain/config';
import {
  formatInvariant,
  formatPrice,
  formatToken,
  getChainLabel,
  pluralize,
  shortenAddress,
} from '../lib/format';
import { PRO_TOOLTIPS, proPhaseName } from '../lib/glossary';
import { InfoTooltip } from './InfoTooltip';

interface ProStatsRowProps {
  config: RuntimeConfig;
  state: StateResponse;
  batch: RawBatchInfo;
  livePhase: BatchPhase;
  account: string | null;
  walletChainId: number | null;
  wrongNetwork: boolean;
  loading: boolean;
}

export const ProStatsRow: React.FC<ProStatsRowProps> = ({
  config,
  state,
  batch,
  livePhase,
  account,
  walletChainId,
  wrongNetwork,
  loading,
}) => {
  const [showDetails, setShowDetails] = useState(false);

  const connectionLabel = loading
    ? 'Syncing on-chain ledger'
    : wrongNetwork
      ? `Wrong network · chain #${walletChainId ?? '?'}`
      : account
        ? `Connected · ${getChainLabel(config.chainId)}`
        : 'Read-only · live RPC';

  const contractUrl = explorerAddressUrl(config, config.fairBatch);

  return (
    <section
      aria-label="Pool reserves and batch overview"
      className="mb-4 border border-rule bg-paper-bright shadow-slip"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-2.5 sm:px-4">
        <div className="flex flex-wrap items-center gap-2">
          <span
            data-testid="batch-id-badge"
            className="border border-ink bg-ink px-2 py-0.5 font-mono text-xs font-bold uppercase tracking-label text-paper"
          >
            BATCH #{state.batch_id}
          </span>
          <span className="font-mono text-xs font-bold text-ink">
            {proPhaseName(livePhase)}
          </span>
          <span
            data-testid="pro-stats-counts"
            className="font-mono text-xs text-ink-muted tabular-nums"
          >
            · {pluralize(state.orders.length, 'order')} ·{' '}
            {pluralize(Number(batch.commitCount), 'commitment')}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1 border border-rule bg-paper-soft px-2 py-0.5 font-mono text-xs tabular-nums">
            <span className="text-ink-muted">R_x:</span>
            <strong data-testid="reserve-rx" className="text-ink">
              {formatToken(state.reserves.rx, 2)} {config.baseSymbol}
            </strong>
            <InfoTooltip label="Reserve R_x" text={PRO_TOOLTIPS.rx} />
          </span>

          <span className="inline-flex items-center gap-1 border border-rule bg-paper-soft px-2 py-0.5 font-mono text-xs tabular-nums">
            <span className="text-ink-muted">R_y:</span>
            <strong data-testid="reserve-ry" className="text-ink">
              {formatPrice(state.reserves.ry, 0)} {config.quoteSymbol}
            </strong>
            <InfoTooltip label="Reserve R_y" text={PRO_TOOLTIPS.ry} />
          </span>

          <span className="inline-flex items-center gap-1 border border-rule bg-paper-soft px-2 py-0.5 font-mono text-xs tabular-nums">
            <span className="text-ink-muted">Spot:</span>
            <strong data-testid="pool-spot-price" className="text-vermilion-700">
              ${formatPrice(state.reserves.spot_price, 2)}
            </strong>
            <InfoTooltip label="Pool Spot" text={PRO_TOOLTIPS.spot} />
          </span>

          <span
            data-testid="connection-status-badge"
            className={`inline-flex items-center gap-1.5 border px-2 py-0.5 font-mono text-xs font-bold ${
              wrongNetwork
                ? 'border-vermilion-500/60 bg-vermilion-50 text-vermilion-800'
                : account
                  ? 'border-pine-600/50 bg-pine-50 text-pine-800'
                  : 'border-cobalt-600/50 bg-cobalt-50 text-cobalt-800'
            }`}
          >
            <span
              className={`h-2 w-2 rounded-full ${
                wrongNetwork
                  ? 'bg-vermilion-500'
                  : account
                    ? 'bg-pine-500'
                    : 'bg-cobalt-500'
              }`}
            />
            <span>{connectionLabel}</span>
          </span>

          {contractUrl && (
            <a
              href={contractUrl}
              target="_blank"
              rel="noreferrer"
              data-testid="deployed-contract-badge"
              className="inline-flex items-center gap-1 border border-rule-strong bg-paper-bright px-2 py-0.5 font-mono text-xs font-bold text-ink-soft transition hover:border-ink hover:text-ink"
            >
              <span>Contract {shortenAddress(config.fairBatch)}</span>
              <ExternalLink className="h-3 w-3" aria-hidden="true" />
            </a>
          )}

          <button
            type="button"
            data-testid="pro-reserves-details-toggle"
            aria-expanded={showDetails}
            onClick={() => setShowDetails((v) => !v)}
            className="inline-flex items-center gap-1 border border-rule-strong bg-paper-soft px-2 py-0.5 font-mono text-xs font-bold text-ink-soft transition hover:border-ink hover:text-ink"
          >
            <span>{showDetails ? 'Hide details' : 'Show details'}</span>
            {showDetails ? (
              <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" />
            ) : (
              <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
            )}
          </button>
        </div>
      </div>

      {showDetails && (
        <div
          data-testid="pro-reserves-details-panel"
          className="grid grid-cols-2 gap-px border-t border-rule bg-rule lg:grid-cols-4"
        >
          <div className="bg-paper-bright px-4 py-2.5">
            <div className="flex items-center gap-1 font-mono text-xs font-bold uppercase tracking-label text-ink-muted">
              <span>LP Invariant k</span>
              <InfoTooltip label="LP Invariant k" text={PRO_TOOLTIPS.k} />
            </div>
            <div className="mt-0.5 font-mono text-sm font-bold text-plum-700 tabular-nums">
              {formatInvariant(state.reserves.k_invariant)}
            </div>
          </div>

          <div className="bg-paper-bright px-4 py-2.5">
            <div className="font-mono text-xs font-bold uppercase tracking-label text-ink-muted">
              Commit / Reveal Windows
            </div>
            <div className="mt-0.5 font-mono text-sm font-bold text-ink tabular-nums">
              {state.commit_duration_secs}s / {state.reveal_duration_secs}s
            </div>
          </div>

          <div className="bg-paper-bright px-4 py-2.5">
            <div className="flex items-center gap-1 font-mono text-xs font-bold uppercase tracking-label text-ink-muted">
              <span>Min Reveal Bond</span>
              <InfoTooltip label="Reveal bond" text={PRO_TOOLTIPS.revealBond} />
            </div>
            <div className="mt-0.5 font-mono text-sm font-bold text-brass-800 tabular-nums">
              {(Number(config.minBondWei) / 1e18).toFixed(4)} ETH
            </div>
          </div>

          <div className="bg-paper-bright px-4 py-2.5">
            <div className="font-mono text-xs font-bold uppercase tracking-label text-ink-muted">
              Max Batch Capacity
            </div>
            <div className="mt-0.5 font-mono text-sm font-bold text-ink tabular-nums">
              {state.orders.length + Number(batch.commitCount)} / 64 slots
            </div>
          </div>
        </div>
      )}
    </section>
  );
};
