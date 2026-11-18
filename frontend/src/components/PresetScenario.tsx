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
    icon: <Users className="h-3.5 w-3.5" aria-hidden="true" />,
  },
  {
    id: 'cow_balanced',
    title: 'Balanced CoW Crossing (0% Slippage)',
    subtitle: '5 WETH Sell × 15,000 USDC Buy',
    badge: '100% P2P Match',
    callout:
      'Zero Pool Impact: Opposing flow crosses 100% peer-to-peer at spot p* = 3,000.00 USDC/WETH with 0% price impact, $0 AMM fee, and untouched reserves.',
    icon: <GitMerge className="h-3.5 w-3.5" aria-hidden="true" />,
  },
  {
    id: 'marginal_pro_rata',
    title: 'Marginal Limit Tier (Pro-Rata Fill)',
    subtitle: 'ITM + Pinned $2,800 Tier + OTM Refund',
    badge: 'Limit Pinning',
    callout:
      'Exact Limit Equilibrium: Clearing pins p* = 2,800.00 USDC/WETH — strict ITM orders fill 100%, marginal $2,800 sellers fill pro-rata (floor-rounded), OTM Dave gets 100% refund.',
    icon: <Layers className="h-3.5 w-3.5" aria-hidden="true" />,
  },
  {
    id: 'whale_imbalance',
    title: 'Whale Imbalance (LND Reserve Growth)',
    subtitle: '25 WETH Directional Sweep vs Counter-Buy',
    badge: 'LP Protection',
    callout:
      'Liquidity-Nondecreasing (LND) Invariant: FM-AMM clears net imbalance at post-trade marginal price so R_x′ · R_y′ > R_x · R_y, capturing surplus for LPs instead of LVR arbitrageurs.',
    icon: <TrendingUp className="h-3.5 w-3.5" aria-hidden="true" />,
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
      className="ledger-panel overflow-hidden"
    >
      <div className="flex items-center justify-between gap-2 border-b border-rule px-3 py-2">
        <h2 className="flex items-center gap-1.5 font-mono text-[10px] font-bold uppercase tracking-label text-ink-soft">
          <Sparkles className="h-3.5 w-3.5 text-vermilion-600" aria-hidden="true" />
          Scenario book
        </h2>
        <span className="serial">04 proofs</span>
      </div>

      {/* Four indexed proofs, set as a ruled table */}
      <div className="grid grid-cols-2 gap-px bg-rule">
        {PRESETS.map((preset, idx) => {
          const isSelected = preset.id === activePreset;
          return (
            <button
              key={preset.id}
              type="button"
              disabled={busy}
              onClick={() => onSelectPreset(preset.id)}
              aria-pressed={isSelected}
              className={`group relative flex min-h-[92px] flex-col justify-between gap-2 p-2.5 text-left transition disabled:opacity-50 ${
                isSelected
                  ? 'bg-ink text-paper'
                  : 'bg-paper-bright text-ink hover:bg-paper-soft'
              }`}
            >
              {isSelected && (
                <span className="absolute inset-x-0 top-0 h-[2px] bg-vermilion-500" />
              )}
              <div className="flex w-full items-start justify-between gap-1.5">
                <span
                  className={`flex items-center gap-1.5 font-mono text-[9px] font-bold uppercase tracking-label ${
                    isSelected ? 'text-paper/60' : 'text-ink-faint'
                  }`}
                >
                  <span
                    className={`flex h-5 w-5 items-center justify-center border ${
                      isSelected
                        ? 'border-paper/30 text-paper'
                        : 'border-rule text-ink-muted'
                    }`}
                  >
                    {preset.icon}
                  </span>
                  {String(idx + 1).padStart(2, '0')}
                </span>
                <span
                  className={`shrink-0 border px-1 py-0.5 font-mono text-[8px] font-bold uppercase tracking-[0.08em] ${
                    isSelected
                      ? 'border-vermilion-400/60 bg-vermilion-500/20 text-vermilion-200'
                      : 'border-rule bg-paper-soft text-ink-muted'
                  }`}
                >
                  {preset.badge}
                </span>
              </div>

              <div>
                <span className="block text-[11.5px] font-bold leading-[1.25]">
                  {preset.title}
                </span>
                <span
                  className={`mt-1 block font-mono text-[9px] leading-snug ${
                    isSelected ? 'text-paper/55' : 'text-ink-faint'
                  }`}
                >
                  {preset.subtitle}
                </span>
              </div>
            </button>
          );
        })}
      </div>

      {/* Mechanism proof footnote for the loaded scenario */}
      <div
        data-testid="scenario-walkthrough-callout"
        className="border-t border-rule bg-paper-soft px-3 py-2 text-[10.5px] leading-relaxed text-ink-soft"
      >
        <span className="mr-1.5 border border-pine-600/40 bg-pine-50 px-1 py-0.5 font-mono text-[8.5px] font-bold uppercase tracking-label text-pine-700">
          Mechanism proof
        </span>
        <span>{currentMeta.callout}</span>
        {includeSandwichBot && (
          <span className="mt-1.5 block border-l-2 border-vermilion-500 bg-vermilion-50 px-2 py-1 font-mono text-[9px] font-semibold text-vermilion-700">
            Sandwich attack active — compare sequential AMM vs FairBatch below.
          </span>
        )}
      </div>

      {/* MEV attacker injection */}
      <div
        className={`flex items-center justify-between gap-3 border-t px-3 py-2.5 transition ${
          includeSandwichBot
            ? 'border-vermilion-500/50 bg-vermilion-50/70'
            : 'border-rule bg-paper-bright'
        }`}
      >
        <div className="flex min-w-0 items-start gap-2">
          {includeSandwichBot ? (
            <Flame
              className="mt-0.5 h-3.5 w-3.5 shrink-0 text-vermilion-600"
              aria-hidden="true"
            />
          ) : (
            <ShieldAlert
              className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-faint"
              aria-hidden="true"
            />
          )}
          <div className="min-w-0">
            <div className="text-[11px] font-bold leading-tight text-ink">
              Inject MEV Sandwich Bot
            </div>
            <div className="mt-0.5 text-[9.5px] leading-snug text-ink-muted">
              {includeSandwichBot
                ? 'Attacker front-run + back-run active — $0.00 profit on FairBatch.'
                : 'Inject an attacker front-run + back-run into the batch.'}
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
          className={`relative inline-flex h-5 w-10 shrink-0 cursor-pointer items-center border transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-vermilion-500 disabled:opacity-50 ${
            includeSandwichBot
              ? 'border-vermilion-600 bg-vermilion-500'
              : 'border-rule-strong bg-paper-deep'
          }`}
        >
          <span
            className={`inline-block h-3.5 w-3.5 transform bg-paper-bright shadow-sm transition-transform ${
              includeSandwichBot ? 'translate-x-[22px]' : 'translate-x-[3px]'
            }`}
          />
        </button>
      </div>
    </section>
  );
};
