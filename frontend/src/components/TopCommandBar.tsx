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
        dotClass: 'bg-amber-400',
        pillClass:
          'border-amber-500/30 bg-amber-500/10 text-amber-300',
      };
    }
    if (health.execution_mode === 'rpc_connected') {
      return {
        label: 'Connected: RPC Chain',
        dotClass: 'bg-cyan-400 animate-pulse',
        pillClass: 'border-cyan-500/30 bg-cyan-500/10 text-cyan-300',
      };
    }
    return {
      label: health.fe_artifacts_present
        ? 'Connected: Rust Solver + Fe Artifacts'
        : 'Connected: Rust Solver Engine',
      dotClass: 'bg-emerald-400 animate-pulse',
      pillClass:
        'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
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
    <header className="sticky top-0 z-30 border-b border-slate-800/90 bg-[#090D16]/95 backdrop-blur-md">
      {/* Upper institutional bar */}
      <div className="mx-auto flex max-w-[1600px] flex-wrap items-center justify-between gap-3 px-4 py-2.5 lg:px-6">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-emerald-500/40 bg-gradient-to-br from-emerald-500/20 to-cyan-500/10 shadow-glow-emerald">
              <ShieldCheck className="h-5 w-5 text-emerald-400" aria-hidden="true" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-base font-bold tracking-tight text-white">
                  FairBatch
                </span>
                <span className="rounded border border-cyan-500/30 bg-cyan-500/10 px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-cyan-300">
                  Fe 26.5.0
                </span>
              </div>
              <p className="text-[11px] text-slate-400">
                Hybrid CoW + FM-AMM Uniform Batch Exchange
              </p>
            </div>
          </div>

          <div
            data-testid="connection-status-badge"
            className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium ${connectionBadge.pillClass}`}
          >
            <span className={`h-2 w-2 rounded-full ${connectionBadge.dotClass}`} />
            <span>{connectionBadge.label}</span>
          </div>

          <span className="hidden rounded-md border border-slate-800 bg-slate-900/80 px-2.5 py-1 font-mono text-xs text-slate-300 xl:inline-flex">
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
              className="hidden items-center gap-1 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 font-mono text-[11px] font-medium text-emerald-300 transition hover:border-emerald-400/60 hover:bg-emerald-500/20 lg:inline-flex"
            >
              <span>FairBatch {shortenAddress(health.contracts.fair_batch)}</span>
              <ExternalLink className="h-3 w-3" aria-hidden="true" />
            </a>
          )}
        </div>

        {/* Trader Selector + Architecture & Network Modals */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1.5 rounded-lg border border-slate-800 bg-[#111827] px-2.5 py-1.5">
            <Wallet className="h-3.5 w-3.5 text-cyan-400" aria-hidden="true" />
            <label htmlFor="active-trader-select" className="sr-only">
              Active Trader Account
            </label>
            <select
              id="active-trader-select"
              aria-label="Active Trader Account"
              value={selectedTraderAddress}
              onChange={(e) => onSelectTrader(e.target.value)}
              className="bg-transparent font-mono text-xs font-medium text-slate-200 focus:outline-none"
            >
              {walletOptions.map((w) => (
                <option
                  key={w.address}
                  value={w.address}
                  className="bg-[#111827] text-slate-100"
                >
                  {w.name} · {shortenAddress(w.address)}
                </option>
              ))}
            </select>
          </div>

          <button
            type="button"
            onClick={onOpenFeModal}
            className="inline-flex items-center gap-1.5 rounded-lg border border-cyan-500/30 bg-cyan-500/10 px-3 py-1.5 text-xs font-semibold text-cyan-300 transition hover:border-cyan-400/60 hover:bg-cyan-500/20"
          >
            <Code2 className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Why Fe 26.5?</span>
          </button>

          <button
            type="button"
            onClick={onOpenContractModal}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-[#111827] px-3 py-1.5 text-xs font-medium text-slate-200 transition hover:border-slate-600 hover:bg-slate-800"
          >
            <Settings2 className="h-3.5 w-3.5 text-slate-400" aria-hidden="true" />
            <span>Contract &amp; Network Config</span>
          </button>
        </div>
      </div>

      {/* Lower Batch Lifecycle & Reserve Pool KPI Strip */}
      <div className="border-t border-slate-800/80 bg-[#0B101B]">
        <div className="mx-auto flex max-w-[1600px] flex-wrap items-center justify-between gap-3 px-4 py-2 lg:px-6">
          {/* Batch ID + 3-stage State Machine */}
          <div className="flex flex-wrap items-center gap-2.5">
            <div
              data-testid="batch-id-badge"
              className="inline-flex items-center gap-1.5 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 font-mono text-xs font-bold text-emerald-300 tabular-nums"
            >
              <Cpu className="h-3.5 w-3.5" aria-hidden="true" />
              <span>BATCH #{state.batch_id}</span>
            </div>

            <nav
              aria-label="Batch Lifecycle Stepper"
              className="flex items-center gap-1 rounded-lg border border-slate-800/90 bg-[#090D16] p-1"
            >
              {stages.map((st, idx) => (
                <React.Fragment key={st.id}>
                  <div
                    className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition ${
                      st.active
                        ? st.id === 'Reveal'
                          ? 'border border-amber-500/40 bg-amber-500/15 text-amber-300'
                          : 'border border-emerald-500/40 bg-emerald-500/15 text-emerald-300'
                        : st.done
                          ? 'text-slate-300'
                          : 'text-slate-500'
                    }`}
                  >
                    {st.done && !st.active ? (
                      <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" aria-hidden="true" />
                    ) : (
                      <span className="flex h-4 w-4 items-center justify-center rounded-full bg-slate-800 font-mono text-[10px] font-bold">
                        {st.step}
                      </span>
                    )}
                    <span>{st.title}</span>
                  </div>
                  {idx < stages.length - 1 && (
                    <ArrowRight className="h-3 w-3 text-slate-600" aria-hidden="true" />
                  )}
                </React.Fragment>
              ))}
            </nav>
          </div>

          {/* Reserve Pool KPI Strip */}
          <div className="flex flex-wrap items-center gap-4 text-xs">
            <div className="flex items-center gap-1.5">
              <span className="text-slate-400">Reserve R_x:</span>
              <span
                data-testid="reserve-rx"
                className="font-mono font-semibold text-slate-100 tabular-nums"
              >
                {formatToken(state.reserves.rx, 2)} {state.reserves.base_symbol}
              </span>
            </div>
            <div className="h-3.5 w-px bg-slate-800" />
            <div className="flex items-center gap-1.5">
              <span className="text-slate-400">Reserve R_y:</span>
              <span
                data-testid="reserve-ry"
                className="font-mono font-semibold text-slate-100 tabular-nums"
              >
                {formatPrice(state.reserves.ry, 0)} {state.reserves.quote_symbol}
              </span>
            </div>
            <div className="h-3.5 w-px bg-slate-800" />
            <div className="flex items-center gap-1.5">
              <Activity className="h-3.5 w-3.5 text-cyan-400" aria-hidden="true" />
              <span className="text-slate-400">Pool Spot:</span>
              <span
                data-testid="pool-spot-price"
                className="font-mono font-semibold text-cyan-300 tabular-nums"
              >
                ${formatPrice(state.reserves.spot_price, 2)}
              </span>
            </div>
            <div className="h-3.5 w-px bg-slate-800" />
            <div className="flex items-center gap-1.5">
              <span className="text-slate-400">LND Invariant k:</span>
              <span
                data-testid="pool-k-invariant"
                className="font-mono font-semibold text-emerald-300 tabular-nums"
              >
                {formatInvariant(state.reserves.k_invariant)}
              </span>
            </div>
          </div>

          {/* Lifecycle Action Controls */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onAdvancePhase}
              disabled={state.phase !== 'Open' || busyAction !== null}
              className="inline-flex items-center gap-1.5 rounded-lg border border-amber-500/40 bg-amber-500/15 px-3 py-1.5 text-xs font-semibold text-amber-300 transition hover:bg-amber-500/25 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Play className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Advance to Reveal</span>
            </button>

            <button
              type="button"
              onClick={onSettleBatch}
              disabled={
                (state.orders.length === 0 && state.commitments.length === 0) ||
                busyAction !== null
              }
              className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-400/50 bg-emerald-500 px-3.5 py-1.5 text-xs font-bold text-slate-950 shadow-glow-emerald transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Settle Batch Now</span>
            </button>

            <button
              type="button"
              onClick={onResetPool}
              disabled={busyAction !== null}
              aria-label="Reset Pool"
              className="inline-flex items-center gap-1 rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-xs font-medium text-slate-300 transition hover:border-slate-600 hover:bg-slate-800 disabled:opacity-40"
            >
              <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Reset Pool</span>
            </button>
          </div>
        </div>
      </div>
    </header>
  );
};
