import React, { useMemo, useState } from 'react';
import {
  ArrowRight,
  CheckCircle2,
  Flame,
  Lock,
  Scale,
  ShieldCheck,
  Unlock,
} from 'lucide-react';
import { runSandwichSimulation } from '../../lib/clearingMath';
import { formatPrice, formatTokenAmount, formatUsd } from '../../lib/format';

interface DocsAnimationsProps {
  rx: number;
  ry: number;
  baseSymbol: string;
  quoteSymbol: string;
}

const SANDWICH_STEPS = [
  {
    step: 1,
    title: '1. You click Swap (2 fWETH → fUSDC)',
    normalDesc:
      'Your transaction sits in the public waiting room (mempool). A searching bot spots your 2 fWETH sell before it runs.',
    fairbatchDesc:
      'Your 2 fWETH order joins the active 60-second round. Arrival position inside the round gives zero price priority.',
  },
  {
    step: 2,
    title: '2. Bot tries to front-run ahead of you',
    normalDesc:
      'On a normal sequential AMM, the bot pays a higher gas tip to sell fWETH right before you, pushing the pool price down before your trade executes.',
    fairbatchDesc:
      'In FairBatch, even if a bot submits an order earlier in the same round, all orders in the round are pooled together and sorted canonically.',
  },
  {
    step: 3,
    title: '3. Your swap executes',
    normalDesc:
      'Your 2 fWETH swap executes at the worse, pushed-down price caused by the bot’s front-run.',
    fairbatchDesc:
      'Every filled order in the round — yours and the bot’s — receives the exact same uniform clearing price p*.',
  },
  {
    step: 4,
    title: '4. Bot tries to back-run after you',
    normalDesc:
      'On a normal AMM, the bot buys fWETH back cheaper right after your trade and pockets the price difference from your slippage.',
    fairbatchDesc:
      'If the bot submits both a sell leg and a buy leg in the same FairBatch round, both legs clear at the exact same price p*, yielding $0.00 sandwich profit.',
  },
] as const;

const LIFECYCLE_STAGES = [
  {
    id: 'open',
    phase: '1. Collecting (Open · 60s)',
    who: 'Traders',
    summary:
      'Submit Standard (direct) orders, lock Private (sealed) commitments with a 0.0001 ETH refundable deposit, or submit EIP-712 signed intents.',
    rule: 'clock.now() <= commit_deadline',
  },
  {
    id: 'reveal',
    phase: '2. Finalizing (Reveal · 60s)',
    who: 'Sealed traders & intent relayers',
    summary:
      'Traders reveal sealed commitments (receiving their 0.0001 ETH deposit back immediately). EIP-712 signed intents remain open through the reveal deadline.',
    rule: 'commit_deadline < clock.now() <= reveal_deadline',
  },
  {
    id: 'ready',
    phase: '3. Ready to settle',
    who: 'Anyone (Public or Keeper)',
    summary:
      'Windows are closed. Any wallet (or the optional keeper after a 5s grace period) calls settleBatch() to compute one uniform price p* and open the next round.',
    rule: 'clock.now() > reveal_deadline && !settled',
  },
  {
    id: 'collect',
    phase: '4. Settled & Collect',
    who: 'Order owners & slashers',
    summary:
      'Order owners pull payouts via claim() or multicall(). Anyone can call slashUnrevealed() on expired unrevealed commitments to claim their forfeited 0.0001 ETH deposit.',
    rule: 'settled == true (pull-over-push receipts)',
  },
] as const;

const SEALED_STEPS = [
  {
    step: 1,
    badge: 'LOCK (OPEN WINDOW)',
    title: 'Lock your order in a sealed hash box',
    detail:
      'Your browser combines (round, wallet, side, amount, price limit, random 32-byte secret salt) into a keccak256 hash and sends commitOrder(hash) with a refundable 0.0001 ETH deposit.',
    onChainSees: '0x7f8c…91a4 (opaque hash) + 0.0001 ETH deposit',
  },
  {
    step: 2,
    badge: 'WAIT (COLLECTING CLOSES)',
    title: 'Nobody can see your side, size, or limit price',
    detail:
      'While the round is collecting orders, observers only see the 32-byte hash. Meanwhile, FairBatch reserves 1 of the 64 batch slots for your commitment so you cannot be crowded out.',
    onChainSees: 'Slot reserved · secret stays in your browser localStorage',
  },
  {
    step: 3,
    badge: 'REVEAL (FINALIZING WINDOW)',
    title: 'Open the box & get your 0.0001 ETH deposit back',
    detail:
      'During the 60s Finalizing window, you click Reveal. The contract verifies keccak256(...) == commitment_hash, pulls your tokens into the round, and immediately refunds your 0.0001 ETH deposit.',
    onChainSees: 'Verified order enters round + 0.0001 ETH refunded (or slashed if unrevealed)',
  },
] as const;

export const DocsAnimations: React.FC<DocsAnimationsProps> = ({
  rx,
  ry,
  baseSymbol,
  quoteSymbol,
}) => {
  const [sandwichStep, setSandwichStep] = useState<number>(0);
  const [lifecycleIdx, setLifecycleIdx] = useState<number>(0);
  const [sealedIdx, setSealedIdx] = useState<number>(0);

  const sim = useMemo(
    () =>
      runSandwichSimulation({
        rx: Math.max(1, rx),
        ry: Math.max(1, ry),
        side: 'SellBase',
        amountIn: 2,
      }),
    [rx, ry],
  );

  const currentSandwich = SANDWICH_STEPS[sandwichStep];
  const currentLifecycle = LIFECYCLE_STAGES[lifecycleIdx];
  const currentSealed = SEALED_STEPS[sealedIdx];

  return (
    <div className="space-y-6" data-testid="docs-animations-section">
      {/* 1. Normal swap with a sandwich attacker vs FairBatch */}
      <article
        aria-label="Sandwich attacker vs FairBatch interactive walkthrough"
        data-testid="docs-anim-sandwich"
        className="ledger-panel overflow-hidden"
      >
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-rule bg-paper-soft px-4 py-3">
          <div>
            <span className="eyebrow text-vermilion-700">
              Visual 1 · Interactive step-through
            </span>
            <h3 className="mt-0.5 font-display text-lg font-bold text-ink">
              Normal swap with a sandwich attacker vs. FairBatch
            </h3>
          </div>
          <span className="border border-brass-600/50 bg-brass-50 px-2 py-0.5 font-mono text-xs font-bold text-brass-900">
            Illustrative example (2 {baseSymbol} sell · live reserves)
          </span>
        </div>

        <div className="space-y-4 p-4">
          <div
            role="tablist"
            aria-label="Sandwich comparison steps"
            className="grid grid-cols-2 gap-1.5 sm:grid-cols-4"
          >
            {SANDWICH_STEPS.map((s, idx) => (
              <button
                key={s.step}
                type="button"
                role="tab"
                aria-selected={sandwichStep === idx}
                onClick={() => setSandwichStep(idx)}
                className={`min-h-[38px] border px-2.5 py-1.5 text-left font-mono text-xs font-bold transition motion-reduce:transition-none ${
                  sandwichStep === idx
                    ? 'border-ink bg-ink text-paper'
                    : 'border-rule-strong bg-paper-soft text-ink-soft hover:border-ink'
                }`}
              >
                Step {s.step}
              </button>
            ))}
          </div>

          <div className="border border-rule bg-paper-soft p-3.5">
            <div className="font-display text-base font-bold text-ink">
              {currentSandwich.title}
            </div>
            <div className="mt-3 grid gap-3 lg:grid-cols-3">
              <div className="border-l-2 border-cobalt-600 bg-cobalt-50/70 p-3">
                <div className="flex items-center gap-1.5 font-mono text-xs font-bold uppercase text-cobalt-800">
                  <Scale className="h-3.5 w-3.5 text-cobalt-700" />
                  <span>Normal AMM, no attacker</span>
                </div>
                <p className="mt-1.5 text-xs leading-relaxed text-ink">
                  Baseline 0.30% x·y=k swap executing alone with no bot in the block. Pays{' '}
                  {formatUsd(sim.ammPlainLpFeeQuote, 2)} in baseline 0.30% LP fees at effective
                  price ${formatPrice(sim.ammPlainPrice, 2)}.
                </p>
                <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 border-t border-cobalt-600/25 pt-2 font-mono text-xs tabular-nums">
                  <span>
                    You get:{' '}
                    <strong>
                      {formatTokenAmount(sim.ammPlainOut, 'quote')} {quoteSymbol}
                    </strong>
                  </span>
                  <span className="font-bold text-cobalt-800">Bot profit: $0.00</span>
                </div>
              </div>

              <div className="border-l-2 border-vermilion-500 bg-vermilion-50 p-3">
                <div className="flex items-center gap-1.5 font-mono text-xs font-bold uppercase text-vermilion-800">
                  <Flame className="h-3.5 w-3.5 text-vermilion-600" />
                  <span>Normal AMM + bot ({sim.slippagePct}% cap)</span>
                </div>
                <p className="mt-1.5 text-xs leading-relaxed text-ink">
                  {currentSandwich.normalDesc} (Assumed front-run:{' '}
                  {formatTokenAmount(sim.frontRunAmount, 'base')} {baseSymbol}, capped so your
                  price stays ≥ ${formatPrice(sim.limitPrice, 2)}.)
                </p>
                <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 border-t border-vermilion-500/30 pt-2 font-mono text-xs tabular-nums">
                  <span>
                    You get:{' '}
                    <strong>
                      {formatTokenAmount(sim.ammSandwichedOut, 'quote')} {quoteSymbol}
                    </strong>
                  </span>
                  <span className="font-bold text-vermilion-700">
                    Bot profit: {formatUsd(sim.ammBotProfitQuote, 2)}
                  </span>
                </div>
              </div>

              <div className="border-l-2 border-pine-600 bg-pine-50 p-3">
                <div className="flex items-center gap-1.5 font-mono text-xs font-bold uppercase text-pine-800">
                  <ShieldCheck className="h-3.5 w-3.5 text-pine-700" />
                  <span>FairBatch uniform round</span>
                </div>
                <p className="mt-1.5 text-xs leading-relaxed text-ink">
                  {currentSandwich.fairbatchDesc}
                </p>
                <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 border-t border-pine-600/30 pt-2 font-mono text-xs tabular-nums">
                  <span>
                    You get:{' '}
                    <strong>
                      {formatTokenAmount(sim.fairbatchOut, 'quote')} {quoteSymbol}
                    </strong>
                  </span>
                  <span className="font-bold text-pine-800">Bot profit: $0.00</span>
                </div>
              </div>
            </div>
          </div>

          <p className="text-xs leading-relaxed text-ink-muted">
            <strong>Caption (Illustrative example):</strong> Computed from current pool reserves (
            {formatTokenAmount(rx, 'base')} {baseSymbol} / {formatPrice(ry, 0)} {quoteSymbol}, spot $
            {formatPrice(sim.spot, 2)}) with an {sim.slippagePct}% slippage cap. Against the
            attacked AMM, FairBatch pays{' '}
            <strong>
              {sim.fairbatchVsAttackedQuote >= 0 ? '+' : ''}
              {formatUsd(sim.fairbatchVsAttackedQuote, 2)}
            </strong>{' '}
            more (bot profit {formatUsd(sim.ammBotProfitQuote, 2)} + extra LP fees{' '}
            {formatUsd(sim.extraLpFeesQuote, 2)} = {formatUsd(sim.victimLossVsPlainQuote, 2)} user
            loss). Against an unattacked AMM on a large one-sided order, FairBatch pays{' '}
            <strong>
              {sim.fairbatchVsPlainQuote >= 0 ? '+' : ''}
              {formatUsd(sim.fairbatchVsPlainQuote, 2)} ({sim.fairbatchVsPlainPct.toFixed(2)}%)
            </strong>{' '}
            because FM-AMM clears one-sided imbalance near the post-trade marginal price p* ($
            {formatPrice(sim.fairbatchPrice, 2)}) so LPs capture the rebalancing surplus.
          </p>
        </div>
      </article>

      {/* 2. The round lifecycle: Collecting -> Finalizing -> Ready -> Collect */}
      <article
        aria-label="Round lifecycle diagram"
        data-testid="docs-anim-lifecycle"
        className="ledger-panel overflow-hidden"
      >
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-rule bg-paper-soft px-4 py-3">
          <div>
            <span className="eyebrow text-cobalt-700">Visual 2 · Round state machine</span>
            <h3 className="mt-0.5 font-display text-lg font-bold text-ink">
              The round lifecycle: Collecting → Finalizing → Ready → Collect
            </h3>
          </div>
          <span className="border border-rule-strong bg-paper-bright px-2 py-0.5 font-mono text-xs font-bold text-ink-soft">
            Illustrative example (60s + 60s windows)
          </span>
        </div>

        <div className="space-y-4 p-4">
          <svg
            role="img"
            aria-label="FairBatch four-stage round lifecycle SVG"
            viewBox="0 0 760 110"
            className="h-auto w-full border border-rule bg-paper-bright"
          >
            {[
              { x: 16, label: '1. Collecting', sub: 'Open (60s)', color: '#1A1815' },
              { x: 204, label: '2. Finalizing', sub: 'Reveal (60s)', color: '#B57B24' },
              { x: 392, label: '3. Ready', sub: 'Settle round', color: '#C6462B' },
              { x: 580, label: '4. Collect', sub: 'Pull payout', color: '#2E6A4F' },
            ].map((node, idx) => {
              const active = lifecycleIdx === idx;
              return (
                <g
                  key={node.label}
                  onClick={() => setLifecycleIdx(idx)}
                  className="cursor-pointer"
                >
                  <rect
                    x={node.x}
                    y={20}
                    width={164}
                    height={68}
                    fill={active ? node.color : '#F5F0E3'}
                    stroke="#1A1815"
                    strokeWidth={active ? '2.5' : '1'}
                  />
                  <text
                    x={node.x + 82}
                    y={48}
                    textAnchor="middle"
                    fill={active ? '#FBF8F0' : '#1A1815'}
                    className="font-mono text-[12px] font-bold"
                  >
                    {node.label}
                  </text>
                  <text
                    x={node.x + 82}
                    y={68}
                    textAnchor="middle"
                    fill={active ? '#FBF8F0' : '#6A6254'}
                    className="font-mono text-[10px]"
                  >
                    {node.sub}
                  </text>
                  {idx < 3 && (
                    <text
                      x={node.x + 174}
                      y={58}
                      textAnchor="middle"
                      fill="#1A1815"
                      className="font-mono text-[14px] font-bold"
                    >
                      →
                    </text>
                  )}
                </g>
              );
            })}
          </svg>

          <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
            {LIFECYCLE_STAGES.map((stage, idx) => (
              <button
                key={stage.id}
                type="button"
                aria-pressed={lifecycleIdx === idx}
                onClick={() => setLifecycleIdx(idx)}
                className={`min-h-[36px] border px-2.5 py-1 font-mono text-xs font-bold transition motion-reduce:transition-none ${
                  lifecycleIdx === idx
                    ? 'border-ink bg-ink text-paper'
                    : 'border-rule-strong bg-paper-soft text-ink-soft hover:border-ink'
                }`}
              >
                {stage.phase.split(' (')[0]}
              </button>
            ))}
          </div>

          <div className="border border-rule bg-paper-soft p-3.5 text-xs leading-relaxed">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <strong className="font-display text-sm text-ink">{currentLifecycle.phase}</strong>
              <span className="border border-rule-strong bg-paper-bright px-2 py-0.5 font-mono text-[11px] text-ink-soft">
                Guard: {currentLifecycle.rule}
              </span>
            </div>
            <p className="mt-1.5 text-ink-soft">{currentLifecycle.summary}</p>
          </div>

          <p className="text-xs leading-relaxed text-ink-muted">
            <strong>Caption (Illustrative example):</strong> Every round moves forward through four
            phases enforced on-chain by <code>evaluate_batch_phase</code> in <code>src/lib.fe</code>.
            Calling <code>settleBatch()</code> in stage 3 atomically finalizes the current round and
            opens the next round in stage 1.
          </p>
        </div>
      </article>

      {/* 3. "One fair price": supply and demand curves crossing at p* */}
      <article
        aria-label="One fair price supply and demand curves"
        data-testid="docs-anim-one-price"
        className="ledger-panel overflow-hidden"
      >
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-rule bg-paper-soft px-4 py-3">
          <div>
            <span className="eyebrow text-pine-700">Visual 3 · Uniform clearing chart</span>
            <h3 className="mt-0.5 font-display text-lg font-bold text-ink">
              &ldquo;One fair price&rdquo;: supply and demand curves crossing at p*
            </h3>
          </div>
          <span className="border border-pine-600/50 bg-pine-50 px-2 py-0.5 font-mono text-xs font-bold text-pine-800">
            Illustrative example
          </span>
        </div>

        <div className="space-y-3 p-4">
          <svg
            role="img"
            aria-label="Illustrative supply and demand curves crossing at one fair price"
            viewBox="0 0 760 230"
            className="h-auto w-full border border-rule bg-paper-bright"
          >
            {/* Axes */}
            <line x1="65" y1="24" x2="65" y2="188" stroke="#1A1815" strokeWidth="1.5" />
            <line x1="65" y1="188" x2="680" y2="188" stroke="#1A1815" strokeWidth="1.5" />
            <text x="20" y="110" className="fill-ink-muted font-mono text-[10px]">
              Price
            </text>
            <text x="360" y="214" textAnchor="middle" className="fill-ink-muted font-mono text-[10px]">
              Cumulative volume ({baseSymbol})
            </text>

            {/* CoW P2P zone */}
            <rect x="65" y="24" width="255" height="164" fill="#3A7757" fillOpacity="0.12" />
            <text x="192" y="42" textAnchor="middle" className="fill-pine-800 font-mono text-[10px] font-bold">
              Peer-to-peer CoW match (0 pool impact)
            </text>

            {/* FM-AMM zone */}
            <rect x="320" y="24" width="120" height="164" fill="#715494" fillOpacity="0.11" />
            <text x="380" y="58" textAnchor="middle" className="fill-plum-800 font-mono text-[10px] font-bold">
              Pool absorbs net
            </text>

            {/* Seller supply step curve (upward) */}
            <path
              d="M 65 162 L 190 162 L 190 132 L 320 132 L 320 105 L 440 105 L 440 66 L 600 66"
              fill="none"
              stroke="#2E6A4F"
              strokeWidth="3"
            />
            <text x="608" y="69" className="fill-pine-800 font-mono text-[11px] font-bold">
              Supply S(p)
            </text>

            {/* Buyer demand + FM-AMM curve (downward) */}
            <path
              d="M 65 48 L 220 48 L 220 82 L 360 82 L 360 105 L 490 105 L 490 154 L 600 154"
              fill="none"
              stroke="#2C4A8A"
              strokeWidth="3"
            />
            <text x="608" y="157" className="fill-cobalt-800 font-mono text-[11px] font-bold">
              Demand D(p) + Pool
            </text>

            {/* Uniform clearing price line p* */}
            <line
              x1="65"
              y1="105"
              x2="680"
              y2="105"
              stroke="#C6462B"
              strokeWidth="2"
              strokeDasharray="6 4"
            />
            <circle cx="440" cy="105" r="7" fill="#C6462B" stroke="#FBF8F0" strokeWidth="2" />
            <rect x="454" y="91" width="210" height="26" fill="#C6462B" />
            <text x="559" y="108" textAnchor="middle" fill="#FBF8F0" className="font-mono text-[11px] font-bold">
              One fair price p* for everyone
            </text>
          </svg>

          <p className="text-xs leading-relaxed text-ink-muted">
            <strong>Caption (Illustrative example):</strong> Sellers willing to accept at most p* and
            buyers willing to pay at least p* cross directly peer-to-peer (Coincidence of Wants),
            while the passive FM-AMM pool absorbs only the leftover imbalance at{' '}
            <code>p* = (R_y + 2·D_y) / (R_x + 2·S_x)</code>. Orders outside their price limit remain
            unfilled and receive a 100% refund.
          </p>
        </div>
      </article>

      {/* 4. Sealed order: lock -> wait -> reveal */}
      <article
        aria-label="Sealed order lock wait reveal walkthrough"
        data-testid="docs-anim-sealed"
        className="ledger-panel overflow-hidden"
      >
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-rule bg-paper-soft px-4 py-3">
          <div>
            <span className="eyebrow text-brass-800">Visual 4 · Commit-Reveal privacy</span>
            <h3 className="mt-0.5 font-display text-lg font-bold text-ink">
              Sealed order: Lock → Wait → Reveal
            </h3>
          </div>
          <span className="border border-brass-600/50 bg-brass-50 px-2 py-0.5 font-mono text-xs font-bold text-brass-900">
            Illustrative example
          </span>
        </div>

        <div className="space-y-3 p-4">
          <div className="grid grid-cols-3 gap-2">
            {SEALED_STEPS.map((s, idx) => (
              <button
                key={s.step}
                type="button"
                aria-pressed={sealedIdx === idx}
                onClick={() => setSealedIdx(idx)}
                className={`min-h-[40px] border px-3 py-2 text-left font-mono text-xs font-bold transition motion-reduce:transition-none ${
                  sealedIdx === idx
                    ? 'border-brass-700 bg-brass-600 text-paper'
                    : 'border-rule-strong bg-paper-soft text-ink-soft hover:border-ink'
                }`}
              >
                {s.step}. {s.badge.split(' ')[0]}
              </button>
            ))}
          </div>

          <div className="border border-brass-600/50 bg-brass-50 p-4 text-xs leading-relaxed">
            <div className="flex items-center gap-2 font-mono text-xs font-bold uppercase text-brass-900">
              {sealedIdx < 2 ? (
                <Lock className="h-4 w-4 text-brass-700" />
              ) : (
                <Unlock className="h-4 w-4 text-pine-700" />
              )}
              <span>{currentSealed.badge}</span>
            </div>
            <h4 className="mt-1 font-display text-base font-bold text-ink">
              {currentSealed.title}
            </h4>
            <p className="mt-1 text-ink-soft">{currentSealed.detail}</p>
            <div className="mt-2.5 border border-brass-600/30 bg-paper-bright px-3 py-2 font-mono text-[11px] text-ink">
              <strong>What the blockchain sees:</strong> {currentSealed.onChainSees}
            </div>
          </div>

          <p className="text-xs leading-relaxed text-ink-muted">
            <strong>Caption (Illustrative example):</strong> Your secret salt is stored in your
            browser’s <code>localStorage</code> under <code>fairbatch.secretVault.v2</code>. Do not
            clear browser data or switch browsers before revealing, or you will not be able to reveal
            and anyone can slash the expired 0.0001 ETH deposit after the reveal deadline.
          </p>
        </div>
      </article>

      {/* 5. Who does what: user, public, keeper, contract */}
      <article
        aria-label="Who does what role diagram"
        data-testid="docs-anim-roles"
        className="ledger-panel overflow-hidden"
      >
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-rule bg-paper-soft px-4 py-3">
          <div>
            <span className="eyebrow text-plum-700">Visual 5 · Permission &amp; trust boundaries</span>
            <h3 className="mt-0.5 font-display text-lg font-bold text-ink">
              Who does what: User, Public, Keeper / Relayer, and Smart Contract
            </h3>
          </div>
          <span className="border border-rule-strong bg-paper-bright px-2 py-0.5 font-mono text-xs font-bold text-ink-soft">
            Architecture map
          </span>
        </div>

        <div className="space-y-3 p-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="border border-ink bg-paper-soft p-3">
              <div className="font-mono text-xs font-bold uppercase text-ink">
                1. User (Trader / LP)
              </div>
              <ul className="mt-2 space-y-1.5 text-xs text-ink-soft">
                <li className="flex items-start gap-1.5">
                  <ArrowRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-vermilion-600" />
                  <span>Claims free test tokens from Faucet</span>
                </li>
                <li className="flex items-start gap-1.5">
                  <ArrowRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-vermilion-600" />
                  <span>Approves fWETH / fUSDC once</span>
                </li>
                <li className="flex items-start gap-1.5">
                  <ArrowRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-vermilion-600" />
                  <span>Places Direct, Sealed, or EIP-712 orders</span>
                </li>
                <li className="flex items-start gap-1.5">
                  <ArrowRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-vermilion-600" />
                  <span>Only owner can call claim() or removeLiquidity()</span>
                </li>
              </ul>
            </div>

            <div className="border border-ink bg-paper-soft p-3">
              <div className="font-mono text-xs font-bold uppercase text-pine-800">
                2. Public (Any Wallet)
              </div>
              <ul className="mt-2 space-y-1.5 text-xs text-ink-soft">
                <li className="flex items-start gap-1.5">
                  <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-pine-700" />
                  <span>Anyone can call settleBatch() once Ready</span>
                </li>
                <li className="flex items-start gap-1.5">
                  <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-pine-700" />
                  <span>Anyone can call slashUnrevealed() after reveal deadline to earn the 0.0001 ETH bounty</span>
                </li>
                <li className="flex items-start gap-1.5">
                  <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-pine-700" />
                  <span>Anyone can relay a valid EIP-712 SignedOrder</span>
                </li>
              </ul>
            </div>

            <div className="border border-ink bg-paper-soft p-3">
              <div className="font-mono text-xs font-bold uppercase text-cobalt-800">
                3. Optional Keeper / Relayer
              </div>
              <ul className="mt-2 space-y-1.5 text-xs text-ink-soft">
                <li className="flex items-start gap-1.5">
                  <ArrowRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-cobalt-700" />
                  <span>Waits 5s grace so public can settle first, then calls settleBatch()</span>
                </li>
                <li className="flex items-start gap-1.5">
                  <ArrowRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-cobalt-700" />
                  <span>Slashes expired unrevealed commits after 60s grace</span>
                </li>
                <li className="flex items-start gap-1.5">
                  <ArrowRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-cobalt-700" />
                  <span>Relays signed EIP-712 intents — adds liveness only, cannot alter prices or move user funds</span>
                </li>
              </ul>
            </div>

            <div className="border border-ink bg-paper-soft p-3">
              <div className="font-mono text-xs font-bold uppercase text-plum-800">
                4. FairBatch Contract (Fe)
              </div>
              <ul className="mt-2 space-y-1.5 text-xs text-ink-soft">
                <li className="flex items-start gap-1.5">
                  <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-plum-700" />
                  <span>Pure solve_batch() (0 uses clauses) computes p*</span>
                </li>
                <li className="flex items-start gap-1.5">
                  <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-plum-700" />
                  <span>Verifies 512-bit LND invariant R_x′·R_y′ ≥ R_x·R_y</span>
                </li>
                <li className="flex items-start gap-1.5">
                  <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-plum-700" />
                  <span>Records pull-over-push receipts guarded by EIP-1153 transient Mutex</span>
                </li>
              </ul>
            </div>
          </div>

          <p className="text-xs leading-relaxed text-ink-muted">
            <strong>Caption:</strong> FairBatch never relies on a privileged admin or trusted solver
            to set prices. Settlement and slashing are 100% permissionless on-chain; the optional
            keeper and intent relayer only automate clicking those public functions.
          </p>
        </div>
      </article>
    </div>
  );
};
