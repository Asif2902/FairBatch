import React from 'react';
import {
  Flame,
  GitMerge,
  Layers,
  ShieldAlert,
  Sparkles,
  TrendingUp,
  Users,
} from 'lucide-react';
import type { PresetId } from '../types';

interface PresetScenarioProps {
  activePreset: PresetId;
  includeSandwichBot: boolean;
  busy: boolean;
  onSelectPreset: (preset: PresetId) => void;
  onToggleSandwichBot: (enabled: boolean) => void;
}

interface PresetMeta {
  id: PresetId;
  title: string;
  subtitle: string;
  badge: string;
  callout: string;
  icon: React.ReactNode;
}

const PRESETS: PresetMeta[] = [
  {
    id: 'five_sellers',
    title: '5 Users Swap ETH → USDC',
    subtitle: '5 × 1.0 WETH into 100 WETH / 300k USDC',
    badge: 'Flagship Proof',
    callout:
      'Order-Permutation Invariance: All 5 sellers clear at the identical uniform price p* = 2,727.27 USDC/WETH regardless of tx arrival position (#1 through #5).',
    icon: <Users className="h-4 w-4 text-emerald-400" aria-hidden="true" />,
  },
  {
    id: 'cow_balanced',
    title: 'Balanced CoW Crossing (0% Slippage)',
    subtitle: '5 WETH Sell × 15,000 USDC Buy',
    badge: '100% P2P Match',
    callout:
      'Zero Pool Impact: Opposing flow crosses 100% peer-to-peer at spot p* = 3,000.00 USDC/WETH with 0% price impact, $0 AMM fee, and untouched reserves.',
    icon: <GitMerge className="h-4 w-4 text-cyan-400" aria-hidden="true" />,
  },
  {
    id: 'marginal_pro_rata',
    title: 'Marginal Limit Tier (Pro-Rata Fill)',
    subtitle: 'ITM + Pinned $2,800 Tier + OTM Refund',
    badge: 'Limit Pinning',
    callout:
      'Exact Limit Equilibrium: Clearing pins p* = 2,800.00 USDC/WETH — strict ITM orders fill 100%, marginal $2,800 sellers fill pro-rata (floor-rounded), OTM Dave gets 100% refund.',
    icon: <Layers className="h-4 w-4 text-amber-400" aria-hidden="true" />,
  },
  {
    id: 'whale_imbalance',
    title: 'Whale Imbalance (LND Reserve Growth)',
    subtitle: '25 WETH Directional Sweep vs Counter-Buy',
    badge: 'LP Protection',
    callout:
      'Liquidity-Nondecreasing (LND) Invariant: FM-AMM clears net imbalance at post-trade marginal price so R_x′ · R_y′ > R_x · R_y, capturing surplus for LPs instead of LVR arbitrageurs.',
    icon: <TrendingUp className="h-4 w-4 text-violet-400" aria-hidden="true" />,
  },
];

export const PresetScenario: React.FC<PresetScenarioProps> = ({
  activePreset,
  includeSandwichBot,
  busy,
  onSelectPreset,
  onToggleSandwichBot,
}) => {
  const currentMeta =
    PRESETS.find((p) => p.id === activePreset) ?? PRESETS[0];

  return (
    <section
      aria-label="Judge Scenario Presets and MEV Attack Simulator"
      className="rounded-2xl border border-slate-800/90 bg-[#0D1321]/90 p-4 shadow-xl"
    >
      <div className="flex flex-col justify-between gap-3 lg:flex-row lg:items-center">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-emerald-400" aria-hidden="true" />
          <h2 className="text-xs font-bold uppercase tracking-wider text-slate-300">
            1-Click Interactive Judge Scenarios
          </h2>
        </div>

        {/* MEV Sandwich Bot Toggle */}
        <div
          className={`flex items-center justify-between gap-3 rounded-xl border px-3.5 py-2 transition ${
            includeSandwichBot
              ? 'border-rose-500/50 bg-rose-500/15 shadow-glow-rose'
              : 'border-slate-700/80 bg-[#111827]'
          }`}
        >
          <div className="flex items-center gap-2">
            {includeSandwichBot ? (
              <Flame className="h-4 w-4 text-rose-400" aria-hidden="true" />
            ) : (
              <ShieldAlert className="h-4 w-4 text-slate-400" aria-hidden="true" />
            )}
            <div>
              <div className="text-xs font-bold text-white">
                Inject MEV Sandwich Bot
              </div>
              <div className="text-[11px] text-slate-400">
                {includeSandwichBot
                  ? 'Attacker Front-Run + Back-Run Active ($0.00 profit on FairBatch!)'
                  : 'Toggle to inject attacker front-run + back-run into batch'}
              </div>
            </div>
          </div>

          <button
            type="button"
            role="switch"
            aria-checked={includeSandwichBot}
            aria-label="Inject MEV Sandwich Bot"
            disabled={busy}
            onClick={() => onToggleSandwichBot(!includeSandwichBot)}
            className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-rose-400/60 disabled:opacity-50 ${
              includeSandwichBot ? 'bg-rose-500' : 'bg-slate-700'
            }`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                includeSandwichBot ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </button>
        </div>
      </div>

      {/* 4 Scenario Buttons */}
      <div className="mt-3.5 grid gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
        {PRESETS.map((preset) => {
          const isSelected = preset.id === activePreset;
          return (
            <button
              key={preset.id}
              type="button"
              disabled={busy}
              onClick={() => onSelectPreset(preset.id)}
              aria-pressed={isSelected}
              className={`group flex flex-col justify-between rounded-xl border p-3 text-left transition ${
                isSelected
                  ? 'border-emerald-500/60 bg-gradient-to-br from-emerald-500/15 via-[#111827] to-[#111827] shadow-glow-emerald'
                  : 'border-slate-800 bg-[#111827]/80 hover:border-slate-700 hover:bg-[#151E31]'
              }`}
            >
              <div className="flex w-full items-start justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="rounded-lg border border-slate-700/80 bg-[#090D16] p-1.5">
                    {preset.icon}
                  </span>
                  <span className="text-xs font-bold text-white group-hover:text-emerald-200">
                    {preset.title}
                  </span>
                </div>
                <span
                  className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold ${
                    isSelected
                      ? 'bg-emerald-500/20 text-emerald-300'
                      : 'bg-slate-800 text-slate-400'
                  }`}
                >
                  {preset.badge}
                </span>
              </div>
              <p className="mt-2 font-mono text-[11px] text-slate-400">
                {preset.subtitle}
              </p>
            </button>
          );
        })}
      </div>

      {/* Interactive Judge Walkthrough Callout */}
      <div
        data-testid="scenario-walkthrough-callout"
        className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-emerald-500/20 bg-emerald-500/[0.06] px-3.5 py-2 text-xs text-slate-200"
      >
        <div>
          <span className="mr-2 rounded bg-emerald-500/20 px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase text-emerald-300">
            Mechanism Proof
          </span>
          <span>{currentMeta.callout}</span>
        </div>
        {includeSandwichBot && (
          <span className="rounded-md border border-rose-500/40 bg-rose-500/15 px-2 py-0.5 font-mono text-[11px] font-semibold text-rose-300">
            Sandwich Attack Active: Compare Sequential AMM vs FairBatch below
          </span>
        )}
      </div>
    </section>
  );
};
