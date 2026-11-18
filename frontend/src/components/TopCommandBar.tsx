import React from 'react';
import {
  Activity,
  ArrowRight,
  CheckCircle2,
  Code2,
  Cpu,
  ExternalLink,
  Play,
  RotateCcw,
  Settings2,
  ShieldCheck,
  Wallet,
} from 'lucide-react';
import type {
  DemoWalletDto,
  HealthResponse,
  StateResponse,
} from '../types';
import {
  formatInvariant,
  formatPrice,
  formatToken,
  getChainLabel,
  shortenAddress,
} from '../lib/format';

interface TopCommandBarProps {
  state: StateResponse;
  health: HealthResponse;
  isLiveBackend: boolean;
  selectedTraderAddress: string;
  browserWalletAddress: string | null;
  busyAction: string | null;
  onSelectTrader: (address: string) => void;
  onAdvancePhase: () => void;
  onSettleBatch: () => void;
  onResetPool: () => void;
  onOpenContractModal: () => void;
  onOpenFeModal: () => void;
}

export const TopCommandBar: React.FC<TopCommandBarProps> = ({
  state,
  health,
  isLiveBackend,
  selectedTraderAddress,
  browserWalletAddress,
  busyAction,
  onSelectTrader,
  onAdvancePhase,
  onSettleBatch,
  onResetPool,
  onOpenContractModal,
  onOpenFeModal,
}) => {
  const connectionBadge = (() => {
    if (!isLiveBackend || health.execution_mode === 'browser_fallback') {
      return {
        label: 'Standalone Browser Engine',
        dotClass: 'bg-brass-500',
        pillClass: 'border-brass-600/50 bg-brass-50 text-brass-700',
      };
    }
    if (health.execution_mode === 'rpc_connected') {
      return {
        label: 'Connected: RPC Chain',
        dotClass: 'bg-cobalt-500 animate-pulse',
        pillClass: 'border-cobalt-600/40 bg-cobalt-50 text-cobalt-700',
      };
    }
    return {
      label: health.fe_artifacts_present
        ? 'Connected: Rust Solver + Fe Artifacts'
        : 'Connected: Rust Solver Engine',
      dotClass: 'bg-pine-500 animate-pulse',
      pillClass: 'border-pine-600/40 bg-pine-50 text-pine-700',
    };
  })();

  const stages = [
    {
      id: 'Open',
      step: '1',
      title: 'Open / Collect',
      active: state.phase === 'Open',
      done: state.phase === 'Reveal' || state.phase === 'Settled',
    },
    {
      id: 'Reveal',
      step: '2',
      title: 'Reveal / Intent',
      active: state.phase === 'Reveal',
      done: state.phase === 'Settled',
    },
    {
      id: 'Settled',
      step: '3',
      title: 'Settled → Next Batch',
      active: state.phase === 'Settled',
      done: state.settled_history.length > 0,
    },
  ];

  const walletOptions: DemoWalletDto[] = browserWalletAddress
    ? [
        {
          index: -1,
          name: `Browser Wallet (${shortenAddress(browserWalletAddress)})`,
          address: browserWalletAddress,
        },
        ...state.demo_wallets,
      ]
    : state.demo_wallets;

  return (
    <header className="relative z-30 border-b-2 border-ink bg-paper/95 backdrop-blur-sm lg:sticky lg:top-0">
      {/* Edition rule */}
      <div className="border-b border-rule bg-paper-deep/70">
        <div className="mx-auto flex max-w-[1560px] flex-wrap items-center justify-between gap-x-3 gap-y-1.5 px-4 py-1.5 lg:px-8">
          <span className="hidden font-mono text-[8.5px] font-bold uppercase tracking-wide2 text-ink-muted sm:block">
            FairBatch Clearing House · Public auction ledger
          </span>

          <div className="flex flex-wrap items-center gap-1.5">
            <div
              data-testid="connection-status-badge"
              className={`inline-flex items-center gap-1.5 border px-2 py-1 font-mono text-[8.5px] font-bold uppercase tracking-[0.1em] ${connectionBadge.pillClass}`}
            >
              <span className={`h-1.5 w-1.5 ${connectionBadge.dotClass}`} />
              <span>{connectionBadge.label}</span>
            </div>

            <span className="hidden border border-rule bg-paper-soft px-2 py-1 font-mono text-[8.5px] uppercase tracking-[0.1em] text-ink-muted lg:inline-flex">
              {getChainLabel(health.chain_id)}
            </span>

            {health.contracts.deployed && (
              <a
                href={
                  health.chain_id === 11155111
                    ? `https://sepolia.etherscan.io/address/${health.contracts.fair_batch}`
                    : health.chain_id === 1
                      ? `https://etherscan.io/address/${health.contracts.fair_batch}`
                      : health.chain_id === 560048
                        ? `https://hoodi.etherscan.io/address/${health.contracts.fair_batch}`
                        : `#${health.contracts.fair_batch}`
                }
                target="_blank"
                rel="noreferrer"
                data-testid="deployed-contract-badge"
                className="hidden items-center gap-1 border border-pine-600/40 bg-pine-50 px-2 py-1 font-mono text-[8.5px] font-bold uppercase tracking-[0.08em] text-pine-700 transition hover:bg-pine-100 xl:inline-flex"
              >
                <span>Contract {shortenAddress(health.contracts.fair_batch)}</span>
                <ExternalLink className="h-2.5 w-2.5" aria-hidden="true" />
              </a>
            )}
          </div>
        </div>
      </div>

      {/* Masthead */}
      <div className="mx-auto max-w-[1560px] px-4 lg:px-8">
        <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4 py-4 lg:py-5">
          <div className="flex min-w-0 items-start gap-3.5">
            <div className="hidden h-12 w-12 shrink-0 items-center justify-center border border-ink bg-ink text-paper sm:flex">
              <ShieldCheck className="h-6 w-6" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="font-display text-[2rem] font-bold leading-none tracking-[-0.04em] text-ink sm:text-[2.4rem]">
                  FairBatch
                </span>
                <span className="border border-cobalt-600/50 px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-label text-cobalt-700">
                  Fe 26.5.0
                </span>
              </div>
              <p className="mt-1.5 font-serif text-[13px] italic leading-none text-ink-muted">
                Uniform-price batch exchange — many orders, one clearing price.
              </p>
            </div>
          </div>

          {/* Centred motto fills the masthead's middle column on wide screens */}
          <div className="hidden flex-1 flex-col items-center justify-end pb-1.5 text-center 2xl:flex">
            <span className="font-serif text-[16px] italic leading-none text-ink-soft">
              Many orders. One price.
            </span>
            <span className="mt-2 flex items-center gap-2 whitespace-nowrap font-mono text-[8px] uppercase tracking-wide2 text-ink-faint">
              <span className="h-px w-5 bg-rule-strong" />
              CoW · FM-AMM · one clearing price
              <span className="h-px w-5 bg-rule-strong" />
            </span>
          </div>

          <div className="ml-auto flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1.5 border border-rule-strong bg-paper-bright px-2 py-1">
              <Wallet className="h-3 w-3 text-ink-faint" aria-hidden="true" />
              <label htmlFor="active-trader-select" className="sr-only">
                Active Trader Account
              </label>
              <select
                id="active-trader-select"
                aria-label="Active Trader Account"
                value={selectedTraderAddress}
                onChange={(e) => onSelectTrader(e.target.value)}
                className="max-w-[190px] bg-transparent font-mono text-[10px] font-medium text-ink focus:outline-none"
              >
                {walletOptions.map((w) => (
                  <option
                    key={w.address}
                    value={w.address}
                    className="bg-paper-bright text-ink"
                  >
                    {w.name} · {shortenAddress(w.address)}
                  </option>
                ))}
              </select>
            </div>

            <button
              type="button"
              onClick={onOpenFeModal}
              className="inline-flex items-center gap-1.5 border border-cobalt-600/40 px-2.5 py-1.5 font-mono text-[9px] font-bold uppercase tracking-[0.08em] text-cobalt-700 transition hover:bg-cobalt-50"
            >
              <Code2 className="h-3 w-3" aria-hidden="true" />
              <span>Why Fe 26.5?</span>
            </button>

            <button
              type="button"
              onClick={onOpenContractModal}
              className="inline-flex items-center gap-1.5 border border-rule-strong px-2.5 py-1.5 font-mono text-[9px] font-bold uppercase tracking-[0.08em] text-ink-soft transition hover:border-ink hover:text-ink"
            >
              <Settings2 className="h-3 w-3 text-ink-faint" aria-hidden="true" />
              <span>Contract &amp; Network Config</span>
            </button>
          </div>
        </div>
      </div>

      {/* Batch band: identity, lifecycle, reserves, actions */}
      <div className="border-t border-rule bg-paper-soft/80">
        <div className="mx-auto max-w-[1560px] px-4 py-2.5 lg:px-8">
          <div className="flex flex-wrap items-center justify-between gap-x-5 gap-y-2">
            <div className="flex flex-wrap items-center gap-3">
            <div
              data-testid="batch-id-badge"
              className="flex items-center gap-2 border-r border-rule-strong pr-3"
            >
              <Cpu className="h-3.5 w-3.5 text-vermilion-600" aria-hidden="true" />
              <span className="font-display text-lg font-bold leading-none tracking-tight text-ink tabular-nums">
                BATCH #{state.batch_id}
              </span>
            </div>

            <nav
              aria-label="Batch Lifecycle Stepper"
              className="flex flex-wrap items-center gap-1"
            >
              {stages.map((st, idx) => (
                <React.Fragment key={st.id}>
                  <div
                    className={`flex items-center gap-1.5 border px-2 py-1 font-mono text-[9px] font-bold uppercase tracking-[0.08em] transition ${
                      st.active
                        ? st.id === 'Reveal'
                          ? 'border-brass-600 bg-brass-500 text-paper'
                          : st.id === 'Settled'
                            ? 'border-pine-700 bg-pine-600 text-paper'
                            : 'border-ink bg-ink text-paper'
                        : st.done
                          ? 'border-pine-600/40 bg-pine-50 text-pine-700'
                          : 'border-rule bg-paper-bright text-ink-faint'
                    }`}
                  >
                    {st.done && !st.active ? (
                      <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
                    ) : (
                      <span
                        className={`flex h-3.5 w-3.5 items-center justify-center border text-[8px] ${
                          st.active
                            ? 'border-paper/40 text-paper'
                            : 'border-current text-ink-faint'
                        }`}
                      >
                        {st.step}
                      </span>
                    )}
                    <span>{st.title}</span>
                  </div>
                  {idx < stages.length - 1 && (
                    <ArrowRight
                      className="h-2.5 w-2.5 text-ink-faint"
                      aria-hidden="true"
                    />
                  )}
                </React.Fragment>
              ))}
            </nav>
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <div className="flex flex-col">
              <span className="font-mono text-[8px] uppercase tracking-label text-ink-faint">
                Reserve R_x
              </span>
              <span
                data-testid="reserve-rx"
                className="font-mono text-[11px] font-bold text-ink tabular-nums"
              >
                {formatToken(state.reserves.rx, 2)} {state.reserves.base_symbol}
              </span>
            </div>
            <div className="hidden h-7 w-px bg-rule sm:block" />
            <div className="flex flex-col">
              <span className="font-mono text-[8px] uppercase tracking-label text-ink-faint">
                Reserve R_y
              </span>
              <span
                data-testid="reserve-ry"
                className="font-mono text-[11px] font-bold text-ink tabular-nums"
              >
                {formatPrice(state.reserves.ry, 0)} {state.reserves.quote_symbol}
              </span>
            </div>
            <div className="hidden h-7 w-px bg-rule sm:block" />
            <div className="flex flex-col">
              <span className="flex items-center gap-1 font-mono text-[8px] uppercase tracking-label text-ink-faint">
                <Activity className="h-2.5 w-2.5 text-vermilion-600" aria-hidden="true" />
                Pool spot
              </span>
              <span
                data-testid="pool-spot-price"
                className="font-mono text-[11px] font-bold text-vermilion-700 tabular-nums"
              >
                ${formatPrice(state.reserves.spot_price, 2)}
              </span>
            </div>
            <div className="hidden h-7 w-px bg-rule sm:block" />
            <div className="flex flex-col">
              <span className="font-mono text-[8px] uppercase tracking-label text-ink-faint">
                LND invariant k
              </span>
              <span
                data-testid="pool-k-invariant"
                className="font-mono text-[11px] font-bold text-pine-700 tabular-nums"
              >
                {formatInvariant(state.reserves.k_invariant)}
              </span>
            </div>
          </div>
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-rule pt-2 sm:justify-end">
            <button
              type="button"
              onClick={onAdvancePhase}
              disabled={state.phase !== 'Open' || busyAction !== null}
              className="inline-flex items-center gap-1.5 border border-brass-600 bg-brass-50 px-2.5 py-1.5 font-mono text-[9px] font-bold uppercase tracking-[0.08em] text-brass-800 transition hover:bg-brass-100 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Play className="h-3 w-3" aria-hidden="true" />
              <span>Advance to Reveal</span>
            </button>

            <button
              type="button"
              onClick={onSettleBatch}
              disabled={
                (state.orders.length === 0 && state.commitments.length === 0) ||
                busyAction !== null
              }
              className="inline-flex items-center gap-1.5 border border-pine-700 bg-pine-600 px-3 py-1.5 font-mono text-[9px] font-bold uppercase tracking-[0.08em] text-paper transition hover:bg-pine-700 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
              <span>Settle Batch Now</span>
            </button>

            <button
              type="button"
              onClick={onResetPool}
              disabled={busyAction !== null}
              aria-label="Reset Pool"
              className="inline-flex items-center gap-1 border border-rule-strong px-2.5 py-1.5 font-mono text-[9px] font-bold uppercase tracking-[0.08em] text-ink-muted transition hover:border-ink hover:text-ink disabled:opacity-40"
            >
              <RotateCcw className="h-3 w-3" aria-hidden="true" />
              <span>Reset Pool</span>
            </button>
          </div>
        </div>
      </div>
    </header>
  );
};
