import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  BookOpen,
  Code2,
  ExternalLink,
  HelpCircle,
  Play,
  PlayCircle,
  ShieldAlert,
  Sparkles,
} from 'lucide-react';
import { explorerAddressUrl, explorerTxUrl, type RuntimeConfig } from '../../onchain/config';
import {
  buildSandwichSizeTable,
  computeUnattackedBreakEvenSize,
} from '../../lib/clearingMath';
import { formatPrice, formatTokenAmount, formatUsd } from '../../lib/format';
import { UI_LABELS } from '../../lib/uiLabels';
import { DocsAnimations } from './DocsAnimations';

const UiLabel: React.FC<{ text: string }> = ({ text }) => (
  <strong data-ui-label={text}>{text}</strong>
);

export type DocsSectionId = 'user' | 'developer' | 'visuals' | 'security' | 'glossary' | 'demo';

const LIVE_DEMO_VIDEO_ID = 'Qa4dRpZdwE0';
const LIVE_DEMO_YOUTUBE_URL = 'https://youtu.be/Qa4dRpZdwE0?si=tBphjOdlHJYVBnYI';
const LIVE_DEMO_EMBED_URL = `https://www.youtube-nocookie.com/embed/${LIVE_DEMO_VIDEO_ID}?autoplay=1&rel=0`;
const LIVE_DEMO_POSTER_URL = `https://i.ytimg.com/vi/${LIVE_DEMO_VIDEO_ID}/hqdefault.jpg`;

interface DocsPageProps {
  config: RuntimeConfig;
  rx: number;
  ry: number;
  anchor?: string | null;
  onBackToExchange: () => void;
}

export interface GlossaryEntry {
  id: string;
  term: string;
  shortDef: string;
  detail: string;
}

export const GLOSSARY_ENTRIES: ReadonlyArray<GlossaryEntry> = [
  {
    id: 'glossary-round',
    term: 'Round (Batch)',
    shortDef: 'A short time window (60s collecting + 60s finalizing on Sepolia) that groups swap orders together.',
    detail:
      'Instead of executing swaps one-by-one in arrival order, FairBatch collects orders into a numbered round (Batch #N, capped at 64 slots) and clears all eligible orders simultaneously at the end of the round.',
  },
  {
    id: 'glossary-fair-price',
    term: 'Fair price (Uniform clearing price p*)',
    shortDef: 'The single price that every filled buyer and seller in the same round receives.',
    detail:
      'Computed on-chain by pure solve_batch() in src/clearing.fe as p* = (R_y + 2·D_y) / (R_x + 2·S_x) (or pinned to a marginal limit tier with floor pro-rata fills). Because everyone in the round gets p*, transaction ordering inside the round gives zero price advantage.',
  },
  {
    id: 'glossary-slippage',
    term: 'Slippage / Price limit',
    shortDef: 'The worst price you are willing to accept before your order automatically refunds.',
    detail:
      `In Simple mode, choosing an 8% max slippage tolerance sets your minimum sell price to 8% below spot (or maximum buy price to 8% above spot). If the round clears outside your limit, your tokens are not traded and are 100% refundable via "${UI_LABELS.collectTokens}" (or "${UI_LABELS.collectAllOrdersPattern}").`,
  },
  {
    id: 'glossary-deposit',
    term: 'Deposit (Reveal bond · min 0.0001 ETH)',
    shortDef: 'A refundable Sepolia ETH deposit locked when placing a Private (sealed) commitment.',
    detail:
      'When you reveal your sealed order during the 60s Finalizing window, FairBatch immediately refunds your 0.0001 ETH deposit (using a 200,000-gas budget compatible with smart wallets). If you never reveal, anyone can slash the expired commitment after the reveal deadline and collect the deposit.',
  },
  {
    id: 'glossary-collect',
    term: 'Collect (Pull-over-push claim)',
    shortDef: 'The one-click step where you pull your finished swap payout (or refund) into your wallet.',
    detail:
      'settleBatch() writes entitlements to OrderReceipt storage without transferring ERC-20 tokens in a loop. That way, a single blacklisted or reverting token receiver can never block settlement for everyone else. You pull your tokens with claim() or batch-claim with multicall().',
  },
  {
    id: 'glossary-keeper',
    term: 'Keeper (Optional liveness helper)',
    shortDef: 'An optional off-chain script that calls public settleBatch() and slashUnrevealed() after a short grace period.',
    detail:
      'The keeper holds no special privileges: it waits 5 seconds after a non-empty round finishes so any public user can settle first, then calls settleBatch(). After a 60-second grace period, it calls slashUnrevealed() on expired unrevealed commitments. It cannot change prices or move user funds.',
  },
  {
    id: 'glossary-relayer',
    term: 'Relayer (Optional EIP-712 intent submitter)',
    shortDef: 'An optional service that broadcasts your signed EIP-712 order on-chain and pays the submission gas.',
    detail:
      `When you sign an EIP-712 SignedOrder, your signature binds your address, side, amount, limit price, round number, sequential nonce, and deadline. Anyone (including the optional relayer or you via "${UI_LABELS.submitItMyself}") can call submitSignedIntent(order, sig). A relayer can delay or ignore a request, but can never alter the order or move funds without a valid signature.`,
  },
  {
    id: 'glossary-gas',
    term: 'Gas (Sepolia ETH)',
    shortDef: 'The Ethereum network fee paid in Sepolia test ETH to run a transaction.',
    detail:
      'Every on-chain transaction (faucet claim, token approval, direct order, commit, reveal, settle, slash, or collect) costs Sepolia ETH for gas. If your wallet has less than 0.002 Sepolia ETH, FairBatch displays a gas notice with links to free public Sepolia faucets.',
  },
  {
    id: 'glossary-nonce',
    term: 'Nonce (Sequential EIP-712 counter)',
    shortDef: 'A per-wallet counter (0, 1, 2, …) that prevents a signed EIP-712 order from being replayed.',
    detail:
      'FairBatch stores nonces: Map<Address, u256>. Each submitSignedIntent verifies order.nonce == nonces[trader] and increments nonces[trader] = nonce + 1 before external calls. Replaying an old signature or skipping a nonce reverts.',
  },
  {
    id: 'glossary-cow',
    term: 'CoW (Coincidence of Wants)',
    shortDef: 'Matching opposite-side buyers and sellers in the same round directly peer-to-peer.',
    detail:
      'Overlapping buy and sell volume clears directly between traders at p* with zero pool price impact; only the net imbalance trades against the passive FM-AMM reserves.',
  },
  {
    id: 'glossary-fm-amm',
    term: 'FM-AMM (Function-Maximizing AMM)',
    shortDef: 'A passive liquidity pool that clears the net batch imbalance at its post-trade marginal price.',
    detail:
      'Following Canidio & Fritsch (2023), clearing at p* = (R_y + 2·D_y) / (R_x + 2·S_x) ensures the pool invariant k = R_x·R_y never decreases (R_x′·R_y′ ≥ R_x·R_y) and eliminates sequential Loss-Versus-Rebalancing (LVR) within the batch.',
  },
  {
    id: 'glossary-lnd',
    term: 'LND (Liquidity-Nondecreasing Invariant)',
    shortDef: 'The on-chain guarantee that post-batch pool reserves satisfy R_x′ · R_y′ ≥ R_x · R_y.',
    detail:
      'Verified on every batch settlement using 512-bit full_mul arithmetic in src/math.fe (verify_lnd_invariant) and proven across imbalanced regimes by property_lnd_invariant_across_imbalanced_regimes in src/tests.fe.',
  },
];

const SEPOLIA_E2E_TXS = [
  { label: 'Faucet.claim() (1 fWETH + 100 fUSDC)', hash: '0x805bd93c453fca5e130677b3ca235e5270ea49522c298413060d8f3822493344', cancunGas: '116,011', sepoliaGas: '389,271' },
  { label: 'fWETH.approve (new allowance slot)', hash: '0xd0eac67270e7e7a83ed1dd712bd51f97c31be97296d0bb1214e2f4e377c9795b', cancunGas: '44,308', sepoliaGas: '126,228' },
  { label: 'seedReserves(100e18, 300000e6)', hash: '0xfd3f9db3779324372d0b3d3e1dcc79e3a82fa88f930ac5203c9ec931aff12065', cancunGas: '218,438', sepoliaGas: '811,614' },
  { label: 'addLiquidity (0.01 fWETH, 50 fUSDC)', hash: '0x92ba05389e869fb32e5084861b6ab87ac7da0c0e985d734cea8ef4fe4da5014c', cancunGas: '93,299', sepoliaGas: '160,099' },
  { label: 'removeLiquidity', hash: '0x697d7d2406828093010b01283f4c3377a302c7ed49ab3f86b0457e277fd9e6ab', cancunGas: '65,636', sepoliaGas: '139,284' },
  { label: 'Mode 1 — submitDirectOrder', hash: '0x469148bb4bc2d1e8005859b413effad161bf30229cdbfd52cc0f2151a67840f8', cancunGas: '160,463', sepoliaGas: '527,943' },
  { label: 'Mode 2 — commitOrder (0.0001 ETH bond)', hash: '0x633aae5d4953343d12c8d2d58b10d8edade6eb28b94e9da97c5299a3ec6bd6a7', cancunGas: '133,528', sepoliaGas: '485,120' },
  { label: 'Mode 2 — revealOrder (bond refunded)', hash: '0xbe6d1e7e349df0094ac23f6f74c95c6ce84e8e4ee8bf272702a4e0bf74eb2fba', cancunGas: '259,668', sepoliaGas: '989,172' },
  { label: 'Mode 3 — submitSignedIntent (EIP-712)', hash: '0xa9cd90e6b61c4910c7fc6c2e5a8d88d24b9ce81fe5cb1d90b0d4e86e9da27ee5', cancunGas: '212,511', sepoliaGas: '763,208' },
  { label: 'settleBatch() — 3 orders (Batch #3)', hash: '0xf83aac9811913a088ec0b57010b091afb100b3ccdefa66e8bf2efec5e0937bde', cancunGas: '931,005', sepoliaGas: '4,022,905' },
  { label: 'slashUnrevealed(3, 1) (0.0001 ETH bounty)', hash: '0x4f4168b78dffd0c0a87d8f2709e0488e70497892c6db80306b3626e333190554', cancunGas: '67,657', sepoliaGas: '152,361' },
  { label: 'claim(3, 0)', hash: '0x6ed98007cfb48c8bec823865976501895228b9f17feba23b02438c30a2a4ddb1', cancunGas: '66,456', sepoliaGas: '82,456' },
  { label: 'multicall([claim(3, 1), claim(3, 2)])', hash: '0xa6d27d2179434b5e8ac0778e1d8263022ee9a2f78ba0a66debd9d851d811dd3e', cancunGas: '120,150', sepoliaGas: '158,150' },
] as const;

const GUIDE_SLIPPAGE_PRESETS = [0.5, 1, 2, 5, 8, 12] as const;

export const DocsPage: React.FC<DocsPageProps> = ({
  config,
  rx,
  ry,
  anchor,
  onBackToExchange,
}) => {
  const [activeSection, setActiveSection] = useState<DocsSectionId>('user');
  const [guideSlippagePct, setGuideSlippagePct] = useState<number>(5);
  const [demoPlayerLoaded, setDemoPlayerLoaded] = useState<boolean>(false);
  const [demoPosterFailed, setDemoPosterFailed] = useState<boolean>(false);

  useEffect(() => {
    if (!anchor) return;
    if (anchor.startsWith('glossary-')) {
      setActiveSection('glossary');
    } else if (anchor === 'developer') {
      setActiveSection('developer');
    } else if (anchor === 'visuals') {
      setActiveSection('visuals');
    } else if (anchor === 'security') {
      setActiveSection('security');
    } else if (anchor === 'demo' || anchor === 'live-demo') {
      setActiveSection('demo');
    }
    const timer = window.setTimeout(() => {
      const el = document.getElementById(anchor);
      if (el && typeof el.scrollIntoView === 'function') {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }, 60);
    return () => window.clearTimeout(timer);
  }, [anchor]);

  const fairBatchUrl = explorerAddressUrl(config, config.fairBatch);
  const faucetUrl = explorerAddressUrl(config, config.faucet);
  const baseTokenUrl = explorerAddressUrl(config, config.baseToken);
  const quoteTokenUrl = explorerAddressUrl(config, config.quoteToken);

  const liveSizeTable = useMemo(
    () =>
      buildSandwichSizeTable({
        rx: Math.max(1, rx),
        ry: Math.max(1, ry),
        side: 'SellBase',
        slippagePct: guideSlippagePct,
      }),
    [rx, ry, guideSlippagePct],
  );
  const liveBreakEven = useMemo(
    () => computeUnattackedBreakEvenSize(Math.max(1, rx)),
    [rx],
  );

  return (
    <div data-testid="docs-page" className="mx-auto w-full max-w-5xl space-y-6 pb-12">
      {/* Top masthead */}
      <section className="ledger-panel p-5">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-rule pb-4">
          <div>
            <span className="eyebrow">FairBatch Documentation · /docs</span>
            <h1 className="mt-1 font-display text-2xl font-bold text-ink sm:text-3xl">
              User Guide, Developer Reference &amp; Visual Walkthroughs
            </h1>
            <p className="mt-1 text-sm text-ink-soft">
              Plain-English guide for first-time swap users and complete technical reference for
              Fe 26.5.0 contract reviewers.
            </p>
          </div>
          <button
            type="button"
            data-testid="docs-back-button"
            onClick={onBackToExchange}
            className="tap-target inline-flex items-center gap-2 border border-ink bg-ink px-4 font-display text-sm font-bold text-paper transition hover:bg-ink-soft"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            <span>Back to Exchange</span>
          </button>
        </div>

        {/* Section switcher */}
        <div
          role="tablist"
          aria-label="Documentation sections"
          className="mt-4 flex flex-wrap gap-1.5"
        >
          {(
            [
              { id: 'user', label: '1. User Guide', icon: BookOpen },
              { id: 'developer', label: '2. Developer Guide', icon: Code2 },
              { id: 'visuals', label: '3. Visuals & Animations', icon: Sparkles },
              { id: 'security', label: '4. Threat Model', icon: ShieldAlert },
              { id: 'glossary', label: '5. Glossary', icon: HelpCircle },
              { id: 'demo', label: '6. Live Demo', icon: PlayCircle },
            ] as const
          ).map((tab) => {
            const Icon = tab.icon;
            const selected = activeSection === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                data-testid={`docs-tab-${tab.id}`}
                aria-selected={selected}
                onClick={() => setActiveSection(tab.id)}
                className={`min-h-[38px] inline-flex items-center gap-1.5 border px-3.5 font-sans text-xs font-bold transition ${
                  selected
                    ? 'border-ink bg-ink text-paper'
                    : 'border-rule-strong bg-paper-soft text-ink-soft hover:border-ink hover:text-ink'
                }`}
              >
                <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                <span>{tab.label}</span>
              </button>
            );
          })}
        </div>
      </section>

      {/* =====================================================================
          B1. USER GUIDE
         ===================================================================== */}
      {activeSection === 'user' && (
        <div data-testid="docs-user-guide" className="space-y-6">
          {/* FairBatch in 60 seconds */}
          <section className="ledger-panel p-5 space-y-3">
            <span className="eyebrow text-vermilion-700">Part 1 · User Guide</span>
            <h2 className="font-display text-xl font-bold text-ink">
              FairBatch in 60 seconds
            </h2>
            <p className="text-sm leading-relaxed text-ink-soft">
              On a normal crypto exchange (an <strong>AMM</strong>, or Automated Market Maker),
              trades run one after another in the exact order they land in a block. Fast trading
              bots watch pending transactions, pay a higher fee to jump ahead of you, and push the
              price against you before your swap runs.
            </p>
            <p className="text-sm leading-relaxed text-ink-soft">
              <strong>FairBatch</strong> fixes ordering attacks inside a round by grouping orders
              into short <strong>rounds</strong> (batches). When the round timer ends, the smart
              contract calculates <strong>one fair price</strong> (the uniform clearing price{' '}
              <code>p*</code>) and gives every filled order in that round the exact same price.
              Whether your order arrived first or last in the round makes zero difference.
            </p>
          </section>

          {/* Step-by-step: Your first swap */}
          <section className="ledger-panel p-5 space-y-4">
            <h2 className="font-display text-xl font-bold text-ink">
              Step-by-step: Your first swap (matches Simple mode)
            </h2>
            <ol className="grid gap-3 sm:grid-cols-2">
              <li className="border border-rule bg-paper-soft p-3.5">
                <div className="font-mono text-xs font-bold uppercase text-vermilion-700">
                  Step 1 · Connect
                </div>
                <div className="mt-1 font-display text-base font-bold text-ink">
                  Connect your wallet on Ethereum Sepolia
                </div>
                <p className="mt-1 text-xs leading-relaxed text-ink-soft">
                  Click <UiLabel text={UI_LABELS.connectWallet} /> (MetaMask or Rabby). If your
                  wallet is on another network, click <UiLabel text={UI_LABELS.switchToSepolia} />.
                  You also need a tiny amount of free Sepolia ETH (at least ~0.002 ETH) to pay
                  network gas.
                </p>
              </li>
              <li className="border border-rule bg-paper-soft p-3.5">
                <div className="font-mono text-xs font-bold uppercase text-vermilion-700">
                  Step 2 · Get test tokens
                </div>
                <div className="mt-1 font-display text-base font-bold text-ink">
                  Claim free {config.baseSymbol} and {config.quoteSymbol}
                </div>
                <p className="mt-1 text-xs leading-relaxed text-ink-soft">
                  Click <UiLabel text={UI_LABELS.getFreeTestTokens} /> to receive{' '}
                  <strong>1 {config.baseSymbol} + 100 {config.quoteSymbol}</strong> from the
                  on-chain Sepolia faucet (available once every 12 hours per wallet). If you
                  already hold test tokens, Simple mode skips straight to Step 3.
                </p>
              </li>
              <li className="border border-rule bg-paper-soft p-3.5">
                <div className="font-mono text-xs font-bold uppercase text-vermilion-700">
                  Step 3 · Swap
                </div>
                <div className="mt-1 font-display text-base font-bold text-ink">
                  Enter an amount and join the round
                </div>
                <p className="mt-1 text-xs leading-relaxed text-ink-soft">
                  Pick how much to pay (or click <strong>25% / 50% / 75% / 100% / Max</strong>) and
                  press <UiLabel text={UI_LABELS.swap} /> (or{' '}
                  <UiLabel text={UI_LABELS.startNextRoundAndSwap} /> if the previous round is ready).
                  On your very first trade of a token, your wallet asks for a one-time token
                  approval first, then sends your order into the round.
                </p>
              </li>
              <li className="border border-rule bg-paper-soft p-3.5">
                <div className="font-mono text-xs font-bold uppercase text-pine-700">
                  Step 4 · Collect
                </div>
                <div className="mt-1 font-display text-base font-bold text-ink">
                  Finish the round &amp; collect your tokens
                </div>
                <p className="mt-1 text-xs leading-relaxed text-ink-soft">
                  When the timer hits zero, click <UiLabel text={UI_LABELS.startNextRound} /> (or in
                  Pro mode <UiLabel text={UI_LABELS.settleBatchAndOpenNextPattern} />, or let the
                  optional keeper settle automatically after ~5 seconds). Then click{' '}
                  <UiLabel text={UI_LABELS.collectTokens} /> (or{' '}
                  <UiLabel text={UI_LABELS.collectAllOrdersPattern} />) to pull your payout into
                  your wallet.
                </p>
              </li>
            </ol>
          </section>

          {/* Honest comparison table */}
          <section className="ledger-panel p-5 space-y-3">
            <h2 className="font-display text-xl font-bold text-ink">
              Why FairBatch instead of a normal swap (honest comparison &amp; trade-offs)
            </h2>
            <div className="overflow-x-auto border border-rule">
              <table className="w-full min-w-[600px] border-collapse text-left text-xs">
                <thead className="bg-ink text-paper font-mono uppercase">
                  <tr>
                    <th className="px-3 py-2.5">Property</th>
                    <th className="px-3 py-2.5">Normal Sequential Swap (x·y=k AMM)</th>
                    <th className="px-3 py-2.5">FairBatch Uniform Round</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-rule bg-paper-bright">
                  <tr>
                    <td className="px-3 py-2.5 font-bold">Execution speed</td>
                    <td className="px-3 py-2.5 text-pine-800 font-semibold">
                      Immediate (1 block, ~12 seconds)
                    </td>
                    <td className="px-3 py-2.5 text-brass-900">
                      Wait for round to close (~60s collecting + ~60s finalizing on Sepolia)
                    </td>
                  </tr>
                  <tr>
                    <td className="px-3 py-2.5 font-bold">Price within a block/round</td>
                    <td className="px-3 py-2.5 text-vermilion-800">
                      Each trade shifts the price; later orders get worse rates
                    </td>
                    <td className="px-3 py-2.5 text-pine-800 font-semibold">
                      Every filled order in the round gets the exact same fair price p*
                    </td>
                  </tr>
                  <tr>
                    <td className="px-3 py-2.5 font-bold">Intra-round sandwich bots</td>
                    <td className="px-3 py-2.5 text-vermilion-800">
                      Bot front-runs before you and back-runs after you for profit
                    </td>
                    <td className="px-3 py-2.5 text-pine-800 font-semibold">
                      $0.00 intra-round sandwich profit (both legs clear at p*)
                    </td>
                  </tr>
                  <tr>
                    <td className="px-3 py-2.5 font-bold">Price vs an unattacked swap</td>
                    <td className="px-3 py-2.5 text-pine-800 font-semibold">
                      Average execution along the x·y=k curve minus 0.30% fee (better on large
                      one-sided trades when no bot attacks)
                    </td>
                    <td className="px-3 py-2.5 text-brass-900">
                      0% swap fee, but large one-sided orders clear near the post-trade marginal
                      price p* (can be ~1–2% worse than an unattacked AMM so LPs keep the surplus);
                      tiny orders (&lt;0.30% impact) are about equal or slightly better, and
                      opposite-side flow matches P2P at zero impact
                    </td>
                  </tr>
                  <tr>
                    <td className="px-3 py-2.5 font-bold">Opposite buyer/seller flow</td>
                    <td className="px-3 py-2.5">
                      Each trader pays pool spread and fees separately
                    </td>
                    <td className="px-3 py-2.5 text-pine-800 font-semibold">
                      Matched directly peer-to-peer (CoW) with zero pool impact
                    </td>
                  </tr>
                  <tr>
                    <td className="px-3 py-2.5 font-bold">Steps to receive tokens</td>
                    <td className="px-3 py-2.5 text-pine-800 font-semibold">
                      1 transaction (pushed immediately)
                    </td>
                    <td className="px-3 py-2.5 text-brass-900">
                      2 steps: place order, then click <UiLabel text={UI_LABELS.collectTokens} />{' '}
                      (or <UiLabel text={UI_LABELS.collectAllOrdersPattern} />) after the round
                      settles
                    </td>
                  </tr>
                  <tr>
                    <td className="px-3 py-2.5 font-bold">Capacity &amp; audit status</td>
                    <td className="px-3 py-2.5">Unlimited orders per block</td>
                    <td className="px-3 py-2.5 text-brass-900">
                      64-order cap per round; Sepolia testnet demo (unaudited)
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            {/* Live trade-size payout table computed directly from current on-chain reserves */}
            <div className="space-y-2 pt-2">
              <h3 className="font-display text-base font-bold text-ink">
                Live trade-size comparison (computed from current Sepolia reserves)
              </h3>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs text-ink-soft">
                  One-sided {config.baseSymbol} sells into current reserves (
                  {formatTokenAmount(rx, 'base')} {config.baseSymbol} / {formatPrice(ry, 0)}{' '}
                  {config.quoteSymbol}), comparing an unattacked 0.30% x·y=k AMM, the same AMM under
                  a sandwich bot capped at {guideSlippagePct}% slippage, and FairBatch uniform
                  clearing:
                </p>
                <div className="flex flex-wrap items-center gap-1">
                  <span className="font-mono text-[11px] font-bold text-ink-muted">
                    Slippage:
                  </span>
                  {GUIDE_SLIPPAGE_PRESETS.map((pct) => (
                    <button
                      key={pct}
                      type="button"
                      data-testid={`docs-guide-slippage-${pct}`}
                      aria-pressed={guideSlippagePct === pct}
                      onClick={() => setGuideSlippagePct(pct)}
                      className={`min-h-[28px] border px-2 font-mono text-[11px] font-bold transition ${
                        guideSlippagePct === pct
                          ? 'border-ink bg-ink text-paper'
                          : 'border-rule-strong bg-paper-soft text-ink-soft hover:border-ink'
                      }`}
                    >
                      {pct}%
                    </button>
                  ))}
                </div>
              </div>
              <div className="overflow-x-auto border border-rule">
                <table
                  data-testid="docs-size-table"
                  className="w-full min-w-[600px] border-collapse text-left font-mono text-xs tabular-nums"
                >
                  <thead className="bg-ink text-paper uppercase">
                    <tr>
                      <th className="px-3 py-2">Sell size ({config.baseSymbol})</th>
                      <th className="px-3 py-2 text-right">Normal AMM (no attacker)</th>
                      <th className="px-3 py-2 text-right">
                        AMM + capped bot ({guideSlippagePct}%)
                      </th>
                      <th className="px-3 py-2 text-right">FairBatch</th>
                      <th className="px-3 py-2 text-right">FB vs no-attack</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-rule bg-paper-bright">
                    {liveSizeTable.map((row) => (
                      <tr key={row.size}>
                        <td className="px-3 py-2 font-bold text-ink">
                          {row.size} {config.baseSymbol}{' '}
                          <span className="font-normal text-[10px] text-ink-muted">
                            ({row.poolPct.toFixed(2)}% of pool)
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right text-ink">
                          {row.sim.victimExceedsSlippageWithoutAttack ? (
                            <span className="text-brass-900">Reverts (&gt;{guideSlippagePct}%)</span>
                          ) : (
                            <>
                              {formatTokenAmount(row.sim.ammPlainOut, 'quote')}{' '}
                              {config.quoteSymbol}
                            </>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right text-vermilion-800">
                          {row.sim.victimExceedsSlippageWithoutAttack ? (
                            <span className="text-brass-900">Reverts (no bot)</span>
                          ) : (
                            <>
                              {formatTokenAmount(row.sim.ammSandwichedOut, 'quote')}{' '}
                              {config.quoteSymbol}
                              {row.sim.ammBotProfitQuote > 0 && (
                                <span className="ml-1 text-[10px] text-ink-muted">
                                  (bot {formatUsd(row.sim.ammBotProfitQuote, 0)})
                                </span>
                              )}
                            </>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right font-bold text-pine-800">
                          {formatTokenAmount(row.sim.fairbatchOut, 'quote')} {config.quoteSymbol}
                        </td>
                        <td
                          className={`px-3 py-2 text-right ${
                            row.sim.fairbatchVsPlainQuote >= 0
                              ? 'text-pine-800'
                              : 'text-brass-900'
                          }`}
                        >
                          {row.sim.fairbatchVsPlainQuote >= 0 ? '+' : ''}
                          {formatUsd(row.sim.fairbatchVsPlainQuote, 2)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p
                data-testid="docs-guide-sensitivity-note"
                className="text-xs leading-relaxed text-ink-soft"
              >
                Sandwich profit depends on trade size and slippage tolerance; with tight tolerance
                small trades are not profitable to attack, and large trades may revert even without
                a bot.
              </p>
              <p data-testid="docs-breakeven-note" className="text-xs leading-relaxed text-ink-muted">
                <strong>Break-even size note:</strong> For a one-sided swap with no opposing CoW
                orders, FairBatch&apos;s uniform clearing output{' '}
                <code>R_y·Δx / (R_x + 2·Δx)</code> equals an unattacked 0.30% x·y=k AMM&apos;s
                output at exactly{' '}
                <code>Δx / R_x = γ / (1 − γ) = {liveBreakEven.poolPct.toFixed(2)}%</code> of the
                pool reserve (<strong>{formatTokenAmount(liveBreakEven.size, 'base')} {config.baseSymbol}</strong>{' '}
                today). Smaller retail swaps beat even an unattacked 0.30% AMM; larger one-sided
                swaps pay slightly less than an unattacked AMM while eliminating intra-round
                sandwich extraction.
              </p>
            </div>
          </section>

          {/* How it fights bots: what IS and IS NOT protected */}
          <section className="ledger-panel p-5 space-y-3">
            <h2 className="font-display text-xl font-bold text-ink">
              How it fights bots: what is protected and what is NOT
            </h2>
            <p className="text-sm leading-relaxed text-ink-soft">
              A <strong>front-run</strong> happens when a bot sees your pending order and jumps
              ahead of you. A <strong>back-run</strong> happens when a bot trades right after you.
              A <strong>sandwich attack</strong> combines both: the bot buys before you to push the
              price up, lets your buy push it even higher, and sells right after you to pocket the
              difference.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="border-l-2 border-pine-600 bg-pine-50 p-3.5 text-xs leading-relaxed">
                <div className="font-mono text-xs font-bold uppercase text-pine-800">
                  What IS protected
                </div>
                <ul className="mt-2 list-disc space-y-1 pl-4 text-ink">
                  <li>
                    <strong>Ordering attacks inside a round:</strong> All orders in the round clear
                    at one shared price <code>p*</code>. Arriving earlier or later inside the same
                    round gives zero price advantage.
                  </li>
                  <li>
                    <strong>Same-round sandwiching:</strong> A bot that places both a front-run and
                    a back-run inside the same round buys and sells at the identical price{' '}
                    <code>p*</code>, earning <strong>$0.00</strong> profit.
                  </li>
                  <li>
                    <strong>Pre-reveal snooping (when using Private sealed orders):</strong> Your
                    side, amount, and limit price stay hidden behind a <code>keccak256</code> hash
                    until the Collecting window closes.
                  </li>
                </ul>
              </div>
              <div className="border-l-2 border-vermilion-500 bg-vermilion-50 p-3.5 text-xs leading-relaxed">
                <div className="font-mono text-xs font-bold uppercase text-vermilion-800">
                  What is NOT protected (FairBatch does not eliminate all MEV)
                </div>
                <ul className="mt-2 list-disc space-y-1 pl-4 text-ink">
                  <li>
                    <strong>Transaction censorship / non-inclusion:</strong> A block builder or
                    relayer can choose not to include your transaction before a window closes.
                  </li>
                  <li>
                    <strong>64-slot spam filling:</strong> Because each round is capped at 64 slots
                    and <code>MIN_ORDER_AMOUNT = 1,000</code> raw atoms is small, a spammer could
                    fill a round’s 64 slots on a low-fee network.
                  </li>
                  <li>
                    <strong>Cross-round price moves &amp; unsealed visibility:</strong> Standard and
                    EIP-712 orders are visible once submitted, so another trader can trade in the
                    same or next round in response.
                  </li>
                  <li>
                    <strong>Slasher bounty competition:</strong> Automated bots can front-run human
                    callers on public <code>slashUnrevealed</code> transactions to take the 0.0001
                    ETH bounty.
                  </li>
                </ul>
              </div>
            </div>
          </section>

          {/* The three order types in plain words */}
          <section className="ledger-panel p-5 space-y-4">
            <h2 className="font-display text-xl font-bold text-ink">
              The three order types in plain words
            </h2>
            <div className="grid gap-3 md:grid-cols-3">
              <div className="border border-rule bg-paper-soft p-4 text-xs leading-relaxed">
                <div className="font-mono text-xs font-bold uppercase text-vermilion-700">
                  1. Standard (Direct)
                </div>
                <h3 className="mt-1 font-display text-base font-bold text-ink">
                  One-click swap during Collecting
                </h3>
                <p className="mt-1.5 text-ink-soft">
                  Sends your tokens and price limit directly into the active round in one
                  transaction (<code>submitDirectOrder</code>) during the 60s Collecting window.
                </p>
                <p className="mt-2 font-mono text-[11px] text-ink">
                  <strong>You pay gas for:</strong> One-time token approval + 1 order transaction +
                  Collect.
                </p>
              </div>

              <div className="border border-brass-600/60 bg-brass-50 p-4 text-xs leading-relaxed">
                <div className="font-mono text-xs font-bold uppercase text-brass-900">
                  2. Private / Sealed (Commit-Reveal)
                </div>
                <h3 className="mt-1 font-display text-base font-bold text-ink">
                  Locked box + refundable 0.0001 ETH deposit
                </h3>
                <p className="mt-1.5 text-ink-soft">
                  Locks a <code>keccak256</code> hash of your order during Collecting along with a
                  refundable <strong>0.0001 ETH deposit</strong>. During the 60s Finalizing window,
                  you click <UiLabel text={UI_LABELS.revealNow} /> to open the box and get your
                  0.0001 ETH deposit back immediately.
                </p>
                <p className="mt-2 border-t border-brass-600/30 pt-2 font-bold text-brass-900">
                  Warning: Do not clear your browser data or switch browsers before revealing! Your
                  secret salt is saved only in this browser’s localStorage.
                </p>
              </div>

              <div className="border border-cobalt-600/50 bg-cobalt-50 p-4 text-xs leading-relaxed">
                <div className="font-mono text-xs font-bold uppercase text-cobalt-800">
                  3. Gasless Signing (EIP-712 Intent)
                </div>
                <h3 className="mt-1 font-display text-base font-bold text-ink">
                  Sign for free off-chain; works in Collecting &amp; Finalizing
                </h3>
                <p className="mt-1.5 text-ink-soft">
                  You sign a structured <code>SignedOrder</code> message in your wallet (signing is
                  off-chain and costs 0 gas). The signed order can be submitted on-chain during
                  either Collecting or Finalizing.
                </p>
                <p className="mt-2 border-t border-cobalt-600/30 pt-2 text-ink">
                  <strong>Not fully free — what you still pay gas for:</strong> You still pay gas
                  for the one-time token <code>approve()</code> (the testnet tokens do not implement
                  EIP-2612 permit), for <code>claim()</code> when collecting payouts, and for
                  submitting the intent yourself if you click{' '}
                  <UiLabel text={UI_LABELS.submitItMyself} /> instead of using an active relayer.
                </p>
              </div>
            </div>
          </section>

          {/* Liquidity, Collecting, Slashing, Faucet, Gas */}
          <section className="ledger-panel p-5 space-y-3">
            <h2 className="font-display text-xl font-bold text-ink">
              Liquidity, Collecting, Slashing, Faucet &amp; Sepolia Gas
            </h2>
            <div className="grid gap-3 sm:grid-cols-2 text-xs leading-relaxed text-ink-soft">
              <div className="border border-rule bg-paper-soft p-3.5">
                <strong className="font-display text-sm text-ink">
                  Providing liquidity &amp; optional lock (Earn tab)
                </strong>
                <p className="mt-1">
                  Deposit {config.baseSymbol} and {config.quoteSymbol} into the passive FM-AMM pool.
                  FairBatch pulls only the exact pool ratio (leaving any extra on the over-supplied
                  side untouched in your wallet) and mints LP shares guarded by your slippage limit.
                  You can leave shares unlocked to withdraw anytime, or optionally lock them for a
                  custom duration (<code>addLiquidityLocked</code>).
                </p>
              </div>
              <div className="border border-rule bg-paper-soft p-3.5">
                <strong className="font-display text-sm text-ink">
                  Why you click Collect (Pull-over-push safety)
                </strong>
                <p className="mt-1">
                  If <code>settleBatch()</code> pushed tokens directly to every trader in a loop,
                  one blacklisted or broken address could make the whole batch revert and freeze
                  everyone else’s funds. Instead, settlement records a receipt, and you click{' '}
                  <UiLabel text={UI_LABELS.collectTokens} /> (or{' '}
                  <UiLabel text={UI_LABELS.collectAllOrdersPattern} /> via <code>multicall</code>;
                  in Pro mode <UiLabel text={UI_LABELS.multicallMyClaimsPattern} />) to pull your
                  tokens safely.
                </p>
              </div>
              <div className="border border-rule bg-paper-soft p-3.5">
                <strong className="font-display text-sm text-ink">
                  Slashing &amp; the 0.0001 ETH keeper bounty
                </strong>
                <p className="mt-1">
                  If someone locks a Private (sealed) order and fails to reveal it before the
                  Finalizing window ends, anyone can call <code>slashUnrevealed(batchId, commitId)</code>.
                  The forfeited 0.0001 ETH deposit is paid directly to the caller so no funds ever
                  get stuck in the contract.
                </p>
              </div>
              <div className="border border-rule bg-paper-soft p-3.5">
                <strong className="font-display text-sm text-ink">
                  Testnet Faucet &amp; Sepolia ETH for gas
                </strong>
                <p className="mt-1">
                  The on-chain Faucet drips <strong>1 {config.baseSymbol} + 100 {config.quoteSymbol}</strong>{' '}
                  every 12 hours. To pay network gas on Ethereum Sepolia (and the 0.0001 ETH deposit
                  for sealed orders), keep at least ~0.002 Sepolia ETH in your wallet from a free
                  public Sepolia faucet.
                </p>
              </div>
            </div>
          </section>

          {/* FAQ & Troubleshooting */}
          <section className="ledger-panel p-5 space-y-3">
            <h2 className="font-display text-xl font-bold text-ink">
              FAQ &amp; Troubleshooting
            </h2>
            <div className="divide-y divide-rule text-xs leading-relaxed">
              <div className="py-2.5">
                <strong className="text-sm text-ink">Is FairBatch always cheaper?</strong>
                <p className="mt-1 text-ink-soft">
                  <strong>No — and here is the honest trade-off:</strong> FairBatch eliminates
                  ordering attacks inside a round ($0.00 intra-round sandwich profit) and matches
                  opposite-side buyers and sellers peer-to-peer (CoW) with zero pool impact and zero
                  swap fee. However, for a <strong>large one-sided order</strong> with no opposing
                  traders, FairBatch&apos;s FM-AMM equation{' '}
                  <code>p* = (R_y + 2·D_y) / (R_x + 2·S_x)</code> prices near the post-trade
                  marginal price so passive LPs capture the rebalancing surplus — which can give a
                  slightly worse payout than an <em>unattacked</em> 0.30% x·y=k swap (for example,
                  ~1.6% lower on a 2 fWETH sell into a ~101.5 fWETH pool). For tiny trades (below
                  ~0.30% pool impact), FairBatch&apos;s 0% swap fee makes it roughly equal to or
                  slightly better than an unattacked 0.30% AMM.
                </p>
              </div>
              <div className="py-2.5">
                <strong className="text-sm text-ink">Why do I wait ~1 minute for a round?</strong>
                <p className="mt-1 text-ink-soft">
                  Grouping orders over a 60s Collecting window + 60s Finalizing window is what lets
                  everyone share one uniform price <code>p*</code> and match peer-to-peer (CoW)
                  instead of being picked off one-by-one in arrival order.
                </p>
              </div>
              <div className="py-2.5">
                <strong className="text-sm text-ink">
                  What if I lose my secret or clear browser data before revealing a sealed order?
                </strong>
                <p className="mt-1 text-ink-soft">
                  Wait only applies to the 0.0001 ETH reveal deposit: because no tokens are pulled
                  during <code>commitOrder</code>, your {config.baseSymbol} and {config.quoteSymbol}{' '}
                  stay safely in your wallet! Only the 0.0001 ETH deposit is forfeited when the
                  unrevealed commitment is slashed after the reveal deadline.
                </p>
              </div>
              <div className="py-2.5">
                <strong className="text-sm text-ink">Why did my order refund?</strong>
                <p className="mt-1 text-ink-soft">
                  If the round’s uniform fair price <code>p*</code> cleared worse than your price
                  limit (or if no opposite-side liquidity was available in pure P2P mode), FairBatch
                  marks your receipt as <em>Refunded (Out-of-the-Money)</em> so you can collect back
                  100% of your escrowed input tokens.
                </p>
              </div>
              <div className="py-2.5">
                <strong className="text-sm text-ink">Why did the Swap button label change?</strong>
                <p className="mt-1 text-ink-soft">
                  Simple mode adapts automatically to the current round phase so you never hit a
                  dead end: during Collecting it says <UiLabel text={UI_LABELS.swap} /> (direct
                  order); during Finalizing it says <UiLabel text={UI_LABELS.swapNowSignAndSend} />{' '}
                  (or <UiLabel text={UI_LABELS.signAndRelaySwap} /> when an optional relayer is
                  active); and when a round is Ready it says{' '}
                  <UiLabel text={UI_LABELS.startNextRoundAndSwap} /> (combines{' '}
                  <code>settleBatch()</code> + <code>submitDirectOrder()</code> in one atomic{' '}
                  <code>multicall</code>). In Pro mode, the settlement console button reads{' '}
                  <UiLabel text={UI_LABELS.settleBatchAndOpenNextPattern} />.
                </p>
              </div>
              <div className="py-2.5">
                <strong className="text-sm text-ink">
                  My wallet says &ldquo;Wrong network&rdquo; or &ldquo;Insufficient funds for gas&rdquo;
                </strong>
                <p className="mt-1 text-ink-soft">
                  Click <UiLabel text={UI_LABELS.switchToSepolia} /> to switch your wallet to
                  Ethereum Sepolia (Chain ID <code>11155111</code>). If your Sepolia ETH balance is
                  below 0.002 ETH, use the public Sepolia faucet link in the gas banner to get free
                  test ETH.
                </p>
              </div>
            </div>
          </section>
        </div>
      )}

      {/* =====================================================================
          B2. DEVELOPER GUIDE
         ===================================================================== */}
      {activeSection === 'developer' && (
        <div data-testid="docs-developer-guide" className="space-y-6">
          {/* Architecture & Who can call what */}
          <section className="ledger-panel p-5 space-y-4">
            <span className="eyebrow text-cobalt-700">Part 2 · Developer Guide</span>
            <h2 className="font-display text-xl font-bold text-ink">
              Architecture &amp; Permission Matrix (Who Can Call What)
            </h2>
            <p className="text-sm leading-relaxed text-ink-soft">
              FairBatch’s core technical contribution is the <strong>Fe 26.5.0</strong> smart
              contract suite under <code>src/*.fe</code>. The React + TypeScript + <code>viem</code>{' '}
              frontend connects directly to Ethereum Sepolia using{' '}
              <code>config/deployment.json</code> as the single source of truth. The optional TypeScript
              keeper/relayer (<code>keeper/</code>) and optional Rust reference parity solver (
              <code>backend/</code>) are off-chain utilities.
            </p>

            <div className="overflow-x-auto border border-rule">
              <table className="w-full min-w-[680px] border-collapse text-left text-xs">
                <thead className="bg-ink text-paper font-mono uppercase">
                  <tr>
                    <th className="px-3 py-2.5">Contract / Entrypoint</th>
                    <th className="px-3 py-2.5">Parameters</th>
                    <th className="px-3 py-2.5">Who Can Call</th>
                    <th className="px-3 py-2.5">Phase / Revert Guards</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-rule bg-paper-bright font-mono text-[11px]">
                  <tr>
                    <td className="px-3 py-2 font-bold">FairBatch.submitDirectOrder</td>
                    <td className="px-3 py-2">(side: u8, amount_in: u256, limit_price: u256)</td>
                    <td className="px-3 py-2">Any trader (EOA / contract)</td>
                    <td className="px-3 py-2">Phase ==OPEN; orders+pendingCommits &lt; 64; amount_in &ge; 1000; Mutex</td>
                  </tr>
                  <tr>
                    <td className="px-3 py-2 font-bold">FairBatch.commitOrder (payable)</td>
                    <td className="px-3 py-2">(commitment_hash: u256) + msg.value</td>
                    <td className="px-3 py-2">Any trader</td>
                    <td className="px-3 py-2">Phase == OPEN; msg.value &ge; min_bond; hash != 0; slots &lt; 64; Mutex</td>
                  </tr>
                  <tr>
                    <td className="px-3 py-2 font-bold">FairBatch.revealOrder</td>
                    <td className="px-3 py-2">(commit_id, side, amount_in, limit_price, salt)</td>
                    <td className="px-3 py-2">Commitment owner only</td>
                    <td className="px-3 py-2">Phase == REVEAL; !revealed &amp;&amp; !slashed; hash match; refunds bond (200k gas)</td>
                  </tr>
                  <tr>
                    <td className="px-3 py-2 font-bold">FairBatch.submitSignedIntent</td>
                    <td className="px-3 py-2">(order: SignedOrder, signature: Bytes)</td>
                    <td className="px-3 py-2">Anyone (trader or relayer)</td>
                    <td className="px-3 py-2">Phase in &#123;OPEN, REVEAL&#125;; batch_id match; nonce == nonces[trader]; now &le; deadline; EOA/ERC-1271 sig</td>
                  </tr>
                  <tr>
                    <td className="px-3 py-2 font-bold">FairBatch.settleBatch</td>
                    <td className="px-3 py-2">()</td>
                    <td className="px-3 py-2">Anyone (permissionless)</td>
                    <td className="px-3 py-2">Phase == READY_TO_SETTLE (now &gt; reveal_deadline &amp;&amp; !settled); 512-bit LND check</td>
                  </tr>
                  <tr>
                    <td className="px-3 py-2 font-bold">FairBatch.slashUnrevealed</td>
                    <td className="px-3 py-2">(batch_id: u256, commit_id: u256)</td>
                    <td className="px-3 py-2">Anyone (permissionless)</td>
                    <td className="px-3 py-2">now &gt; batch.reveal_deadline; !revealed &amp;&amp; !slashed; pays bond to caller</td>
                  </tr>
                  <tr>
                    <td className="px-3 py-2 font-bold">FairBatch.claim</td>
                    <td className="px-3 py-2">(batch_id: u256, order_id: u256)</td>
                    <td className="px-3 py-2">Order owner only</td>
                    <td className="px-3 py-2">receipt.settled &amp;&amp; !receipt.claimed &amp;&amp; caller == receipt.trader; Mutex</td>
                  </tr>
                  <tr>
                    <td className="px-3 py-2 font-bold">FairBatch.addLiquidity / Locked</td>
                    <td className="px-3 py-2">(amount_base, amount_quote, [lock_duration], min_shares)</td>
                    <td className="px-3 py-2">Any LP</td>
                    <td className="px-3 py-2">shares &ge; min_shares; first deposit burns MINIMUM_LIQUIDITY = 1000; unused side untouched</td>
                  </tr>
                  <tr>
                    <td className="px-3 py-2 font-bold">FairBatch.removeLiquidity</td>
                    <td className="px-3 py-2">(shares: u256, min_base: u256, min_quote: u256)</td>
                    <td className="px-3 py-2">LP owner only</td>
                    <td className="px-3 py-2">shares &le; unlocked shares (if lock active); floor outputs &ge; min_base, min_quote</td>
                  </tr>
                  <tr>
                    <td className="px-3 py-2 font-bold">FairBatch.multicall</td>
                    <td className="px-3 py-2">(data: DynArray&lt;Bytes&gt;)</td>
                    <td className="px-3 py-2">Anyone (DELEGATECALL batch)</td>
                    <td className="px-3 py-2">Non-payable (rejects msg.value reuse across calls)</td>
                  </tr>
                  <tr>
                    <td className="px-3 py-2 font-bold">Faucet.claim</td>
                    <td className="px-3 py-2">()</td>
                    <td className="px-3 py-2">Any wallet</td>
                    <td className="px-3 py-2">12h (43,200s) per-wallet cooldown via BatchClock; EIP-1153 Mutex</td>
                  </tr>
                  <tr>
                    <td className="px-3 py-2 font-bold">MockERC20.mint / setBlacklisted</td>
                    <td className="px-3 py-2">(to, amount) / (account, blacklisted)</td>
                    <td className="px-3 py-2">Owner (+ Faucet for mint)</td>
                    <td className="px-3 py-2">Reverts for unauthorized callers</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          {/* Clearing Algorithm & Security Design with File Paths + Verified Fe Tests */}
          <section className="ledger-panel p-5 space-y-4">
            <h2 className="font-display text-xl font-bold text-ink">
              Clearing Math &amp; Security Mechanisms (Files &amp; Verified Fe Tests)
            </h2>
            <p className="text-xs leading-relaxed text-ink-soft">
              Every core invariant is implemented in Fe 26.5.0 and proven by unit, property,{' '}
              <code>MockClock</code> effect, and full-EVM tests in <code>src/tests.fe</code> (69
              tests total):
            </p>
            <div className="overflow-x-auto border border-rule">
              <table className="w-full min-w-[680px] border-collapse text-left text-xs">
                <thead className="bg-ink text-paper font-mono uppercase">
                  <tr>
                    <th className="px-3 py-2.5">Mechanism / Property</th>
                    <th className="px-3 py-2.5">Fe Source File(s)</th>
                    <th className="px-3 py-2.5">Verified Test Name(s) in src/tests.fe</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-rule bg-paper-bright">
                  <tr>
                    <td className="px-3 py-2.5 font-bold">
                      Zero-effect pure clearing (<code>uses ()</code>) &amp; $0 sandwich profit
                    </td>
                    <td className="px-3 py-2.5 font-mono text-[11px]">src/clearing.fe, src/math.fe</td>
                    <td className="px-3 py-2.5 font-mono text-[11px] text-pine-800">
                      proof_mev_sandwich_zero_profit
                    </td>
                  </tr>
                  <tr>
                    <td className="px-3 py-2.5 font-bold">
                      Canonical order-permutation invariance
                    </td>
                    <td className="px-3 py-2.5 font-mono text-[11px]">src/clearing.fe</td>
                    <td className="px-3 py-2.5 font-mono text-[11px] text-pine-800">
                      property_order_permutation_invariance
                    </td>
                  </tr>
                  <tr>
                    <td className="px-3 py-2.5 font-bold">
                      512-bit Liquidity-Nondecreasing invariant (R_x′·R_y′ &ge; R_x·R_y)
                    </td>
                    <td className="px-3 py-2.5 font-mono text-[11px]">src/math.fe, src/clearing.fe</td>
                    <td className="px-3 py-2.5 font-mono text-[11px] text-pine-800">
                      property_lnd_invariant_across_imbalanced_regimes
                    </td>
                  </tr>
                  <tr>
                    <td className="px-3 py-2.5 font-bold">
                      Custom <code>BatchClock</code> effect &amp; deterministic <code>MockClock</code>
                    </td>
                    <td className="px-3 py-2.5 font-mono text-[11px]">src/lib.fe, src/faucet.fe</td>
                    <td className="px-3 py-2.5 font-mono text-[11px] text-pine-800">
                      effect_mocked_clock_transitions, effect_lp_lock_expiry_before_and_after_unlock,
                      effect_faucet_cooldown_before_and_after_with_mock_clock,
                      effect_slashable_window_mock_clock
                    </td>
                  </tr>
                  <tr>
                    <td className="px-3 py-2.5 font-bold">
                      EIP-1153 transient-storage reentrancy <code>Mutex</code> (TLOAD/TSTORE)
                    </td>
                    <td className="px-3 py-2.5 font-mono text-[11px]">src/lib.fe, src/faucet.fe</td>
                    <td className="px-3 py-2.5 font-mono text-[11px] text-pine-800">
                      evm_reentrancy_mutex_blocks_malicious_token_callback
                    </td>
                  </tr>
                  <tr>
                    <td className="px-3 py-2.5 font-bold">
                      Std EIP-712 &amp; ERC-1271 intents, sequential nonces &amp; replay guards
                    </td>
                    <td className="px-3 py-2.5 font-mono text-[11px]">src/intent.fe, src/lib.fe</td>
                    <td className="px-3 py-2.5 font-mono text-[11px] text-pine-800">
                      evm_eip712_eoa_signed_intent_gasless_relayer,
                      evm_eip712_erc1271_smart_wallet_intent, evm_revert_replayed_eip712_intent,
                      evm_revert_eip712_skipped_nonce, evm_revert_eip712_wrong_batch_id
                    </td>
                  </tr>
                  <tr>
                    <td className="px-3 py-2.5 font-bold">
                      Pull-over-push claims &amp; atomic <code>MulticallMsg</code>
                    </td>
                    <td className="px-3 py-2.5 font-mono text-[11px]">src/lib.fe</td>
                    <td className="px-3 py-2.5 font-mono text-[11px] text-pine-800">
                      evm_blacklisted_usdc_user_never_blocks_settlement,
                      evm_multicall_batch_claim_across_orders,
                      evm_revert_payable_multicall_double_value_attack
                    </td>
                  </tr>
                  <tr>
                    <td className="px-3 py-2.5 font-bold">
                      Slashing guards &amp; permissionless slasher bounty payout
                    </td>
                    <td className="px-3 py-2.5 font-mono text-[11px]">src/lib.fe</td>
                    <td className="px-3 py-2.5 font-mono text-[11px] text-pine-800">
                      evm_commit_reveal_bond_refund_and_unrevealed_slashing,
                      evm_revert_slash_before_reveal_expiry, evm_revert_slash_already_slashed,
                      evm_revert_slash_revealed_commit
                    </td>
                  </tr>
                  <tr>
                    <td className="px-3 py-2.5 font-bold">
                      LP slippage bounds, unused-side retention &amp; MINIMUM_LIQUIDITY burn
                    </td>
                    <td className="px-3 py-2.5 font-mono text-[11px]">src/lib.fe, src/math.fe</td>
                    <td className="px-3 py-2.5 font-mono text-[11px] text-pine-800">
                      evm_liquidity_first_deposit_min_liquidity_and_unused_side_refund,
                      evm_revert_add_liquidity_slippage_min_shares,
                      evm_revert_remove_liquidity_slippage_min_base
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          {/* Live Addresses from config/deployment.json & Cancun vs Sepolia Gas */}
          <section className="ledger-panel p-5 space-y-4">
            <h2 className="font-display text-xl font-bold text-ink">
              Deployed Sepolia Contracts (from config/deployment.json) &amp; Gas Analysis
            </h2>
            <div className="grid gap-3 sm:grid-cols-2 font-mono text-xs">
              <div className="border border-rule bg-paper-soft p-3">
                <div className="text-ink-muted">FairBatch Exchange (23,038 / 24,576 B EIP-170)</div>
                <a
                  href={fairBatchUrl ?? '#'}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-1 inline-flex items-center gap-1 font-bold text-cobalt-700 underline decoration-dotted break-all"
                >
                  <span>{config.fairBatch}</span>
                  <ExternalLink className="h-3 w-3 shrink-0" />
                </a>
              </div>
              <div className="border border-rule bg-paper-soft p-3">
                <div className="text-ink-muted">Sepolia Faucet (1,346 B runtime)</div>
                <a
                  href={faucetUrl ?? '#'}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-1 inline-flex items-center gap-1 font-bold text-cobalt-700 underline decoration-dotted break-all"
                >
                  <span>{config.faucet}</span>
                  <ExternalLink className="h-3 w-3 shrink-0" />
                </a>
              </div>
              <div className="border border-rule bg-paper-soft p-3">
                <div className="text-ink-muted">
                  Base Token · {config.baseSymbol} ({config.baseDecimals} decimals)
                </div>
                <a
                  href={baseTokenUrl ?? '#'}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-1 inline-flex items-center gap-1 font-bold text-cobalt-700 underline decoration-dotted break-all"
                >
                  <span>{config.baseToken}</span>
                  <ExternalLink className="h-3 w-3 shrink-0" />
                </a>
              </div>
              <div className="border border-rule bg-paper-soft p-3">
                <div className="text-ink-muted">
                  Quote Token · {config.quoteSymbol} ({config.quoteDecimals} decimals)
                </div>
                <a
                  href={quoteTokenUrl ?? '#'}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-1 inline-flex items-center gap-1 font-bold text-cobalt-700 underline decoration-dotted break-all"
                >
                  <span>{config.quoteToken}</span>
                  <ExternalLink className="h-3 w-3 shrink-0" />
                </a>
              </div>
            </div>

            <div className="border-l-2 border-brass-600 bg-brass-50 p-3.5 text-xs leading-relaxed text-brass-900">
              <strong>Why Live Sepolia Gas Exceeds Local Cancun EVM (EIP-8037 Note):</strong> Both
              benchmarks below measure cold EIP-2929 storage across separate transactions. However,
              live Ethereum Sepolia currently runs the <strong>200,000,000 block gas limit</strong>{' '}
              with <strong>Glamsterdam / EIP-8037 (&ldquo;State Creation Gas Cost Increase&rdquo;)</strong>,
              where initializing a brand-new storage slot (<code>0 -&gt; non-zero</code>) costs{' '}
              <strong>+98,656 gas</strong> (measured via <code>eth_estimateGas</code> on Sepolia
              block 12,182,495: new-slot <code>approve</code> = 126,950 vs. existing-slot update =
              28,294), compared to <strong>+17,328 gas</strong> on standard Cancun EVM (44,308 vs.
              26,980). Thus, Sepolia receipts are <strong>not</strong> standard Cancun mainnet gas
              estimates.
            </div>

            <div className="overflow-x-auto border border-rule">
              <table className="w-full min-w-[640px] border-collapse text-left text-xs">
                <thead className="bg-ink text-paper font-mono uppercase">
                  <tr>
                    <th className="px-3 py-2">Operation</th>
                    <th className="px-3 py-2 text-right">Local Cancun (Cold Tx)</th>
                    <th className="px-3 py-2 text-right">Live Sepolia (EIP-8037)</th>
                    <th className="px-3 py-2">Verified Sepolia Tx</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-rule bg-paper-bright font-mono text-[11px] tabular-nums">
                  {SEPOLIA_E2E_TXS.map((row) => {
                    const url = explorerTxUrl(config, row.hash);
                    return (
                      <tr key={row.hash}>
                        <td className="px-3 py-2 font-bold text-ink">{row.label}</td>
                        <td className="px-3 py-2 text-right">{row.cancunGas}</td>
                        <td className="px-3 py-2 text-right text-ink-soft">{row.sepoliaGas}</td>
                        <td className="px-3 py-2">
                          <a
                            href={url ?? '#'}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 text-cobalt-700 underline decoration-dotted"
                          >
                            <span>{row.hash.slice(0, 10)}…</span>
                            <ExternalLink className="h-3 w-3" />
                          </a>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          {/* How to run and test locally */}
          <section className="ledger-panel p-5 space-y-3">
            <h2 className="font-display text-xl font-bold text-ink">
              How to Run &amp; Test Locally
            </h2>
            <pre className="overflow-x-auto border border-rule bg-paper-soft p-3.5 font-mono text-xs text-ink">
{`# 1. Fe 26.5.0 Smart Contracts (69 tests)
fe fmt --check && fe check && fe test && fe build

# 2. Frontend Exchange Terminal (Vitest + Vite build)
cd frontend && npm ci && npm test && npm run build && npm run dev

# 3. Optional Keeper & Intent Relayer Service
cd keeper && npm ci && npm test && npm run start -- --dry-run`}
            </pre>
          </section>
        </div>
      )}

      {/* =====================================================================
          B3. VISUALS & ANIMATIONS
         ===================================================================== */}
      {activeSection === 'visuals' && (
        <DocsAnimations
          rx={rx}
          ry={ry}
          baseSymbol={config.baseSymbol}
          quoteSymbol={config.quoteSymbol}
        />
      )}

      {/* =====================================================================
          B4. SECURITY THREAT TABLE
         ===================================================================== */}
      {activeSection === 'security' && (
        <section
          aria-label="Security threat model table"
          data-testid="docs-threat-table"
          className="ledger-panel p-5 space-y-4"
        >
          <div>
            <span className="eyebrow text-vermilion-700">Part 4 · Threat Model</span>
            <h2 className="mt-1 font-display text-xl font-bold text-ink">
              Security Threat Matrix: Normal AMM vs. FairBatch vs. Residual Risk
            </h2>
          </div>

          <div className="overflow-x-auto border border-rule">
            <table className="w-full min-w-[740px] border-collapse text-left text-xs">
              <thead className="bg-ink text-paper font-mono uppercase">
                <tr>
                  <th className="px-3 py-2.5">Threat</th>
                  <th className="px-3 py-2.5">What Happens on a Normal AMM</th>
                  <th className="px-3 py-2.5">What FairBatch Does</th>
                  <th className="px-3 py-2.5">Residual Risk</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-rule bg-paper-bright leading-relaxed">
                <tr>
                  <td className="px-3 py-2.5 font-bold">Intra-round sandwich attack</td>
                  <td className="px-3 py-2.5 text-vermilion-800">
                    Searcher front-runs before victim and back-runs after victim in the same block,
                    extracting price impact.
                  </td>
                  <td className="px-3 py-2.5 text-pine-800">
                    All orders in the batch clear at one uniform price <code>p*</code> (proven by{' '}
                    <code>proof_mev_sandwich_zero_profit</code>). Same-round buy+sell legs earn $0.00.
                  </td>
                  <td className="px-3 py-2.5 text-ink-soft">
                    Cross-round trading across separate rounds remains possible if market prices move.
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2.5 font-bold">Pre-trade copy-trading / snooping</td>
                  <td className="px-3 py-2.5 text-vermilion-800">
                    Calldata is visible in the public mempool immediately.
                  </td>
                  <td className="px-3 py-2.5 text-pine-800">
                    Sealed Commit-Reveal hides side, amount, and limit price behind{' '}
                    <code>keccak256</code> until Collecting closes.
                  </td>
                  <td className="px-3 py-2.5 text-ink-soft">
                    Standard (direct) and EIP-712 orders are visible once submitted; ETH bond value
                    is public.
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2.5 font-bold">Commit-slot griefing / abandonment</td>
                  <td className="px-3 py-2.5 text-ink-muted">N/A (no commit phase)</td>
                  <td className="px-3 py-2.5 text-pine-800">
                    Requires 0.0001 ETH deposit and reserves 1 of 64 slots; unrevealed commits are
                    slashable after <code>reveal_deadline</code>, paying the deposit to the slasher.
                  </td>
                  <td className="px-3 py-2.5 text-ink-soft">
                    An attacker willing to forfeit 0.0001 ETH per slot (0.0064 ETH for 64 slots) can
                    still consume a round’s capacity.
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2.5 font-bold">Blacklisted / reverting token receiver</td>
                  <td className="px-3 py-2.5 text-vermilion-800">
                    Push-based batch settlement would revert the entire batch for all traders.
                  </td>
                  <td className="px-3 py-2.5 text-pine-800">
                    <code>settleBatch()</code> writes pull-based <code>OrderReceipt</code> storage
                    with zero external token transfers (<code>evm_blacklisted_usdc_user_never_blocks_settlement</code>).
                  </td>
                  <td className="px-3 py-2.5 text-ink-soft">
                    The blacklisted user’s own <code>claim()</code> will revert until un-blacklisted.
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2.5 font-bold">Token callback reentrancy</td>
                  <td className="px-3 py-2.5 text-vermilion-800">
                    Malicious ERC-20 / ETH callback re-enters state-mutating functions before state updates.
                  </td>
                  <td className="px-3 py-2.5 text-pine-800">
                    Checks-Effects-Interactions ordering plus EIP-1153 transient storage{' '}
                    <code>std::evm::mutex::Mutex</code> on all external entrypoints.
                  </td>
                  <td className="px-3 py-2.5 text-ink-soft">
                    Requires Cancun+ EVM hardfork supporting <code>TLOAD</code>/<code>TSTORE</code>.
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2.5 font-bold">EIP-712 signature replay / cross-batch reuse</td>
                  <td className="px-3 py-2.5 text-vermilion-800">
                    Unbound signatures can be replayed across chains, contracts, or rounds.
                  </td>
                  <td className="px-3 py-2.5 text-pine-800">
                    Domain binds chainId &amp; contract; struct binds <code>batch_id</code>,
                    sequential <code>nonce</code>, and <code>deadline</code>.
                  </td>
                  <td className="px-3 py-2.5 text-ink-soft">
                    Sequential nonces cannot be submitted out of order; no standalone cancelNonce call.
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2.5 font-bold">LP first-deposit share inflation &amp; slippage</td>
                  <td className="px-3 py-2.5 text-vermilion-800">
                    Attacker donates tokens to inflate share price and round victim shares to zero.
                  </td>
                  <td className="px-3 py-2.5 text-pine-800">
                    First deposit permanently burns <code>MINIMUM_LIQUIDITY = 1,000</code> shares to{' '}
                    <code>Address::zero()</code> and enforces <code>min_shares</code> /{' '}
                    <code>min_base</code> / <code>min_quote</code>.
                  </td>
                  <td className="px-3 py-2.5 text-ink-soft">
                    1,000 wei of initial LP shares remain permanently locked at the zero address.
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2.5 font-bold">Keeper / Relayer downtime or censorship</td>
                  <td className="px-3 py-2.5 text-ink-muted">N/A</td>
                  <td className="px-3 py-2.5 text-pine-800">
                    Keeper and relayer are 100% optional. Any user can click{' '}
                    <UiLabel text={UI_LABELS.startNextRound} /> (Pro:{' '}
                    <UiLabel text={UI_LABELS.settleBatchAndOpenNextPattern} />) to call{' '}
                    <code>settleBatch</code>, or <UiLabel text={UI_LABELS.submitItMyself} /> to call{' '}
                    <code>submitSignedIntent</code>.
                  </td>
                  <td className="px-3 py-2.5 text-ink-soft">
                    If the keeper is offline, a user must click once to settle the finished round.
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* =====================================================================
          B5. GLOSSARY (STABLE ANCHORS)
         ===================================================================== */}
      {activeSection === 'glossary' && (
        <section
          aria-label="FairBatch Glossary"
          data-testid="docs-glossary"
          className="ledger-panel p-5 space-y-4"
        >
          <div>
            <span className="eyebrow text-plum-700">Part 5 · Anchored Glossary</span>
            <h2 className="mt-1 font-display text-xl font-bold text-ink">
              Plain-Language Glossary
            </h2>
            <p className="mt-1 text-xs text-ink-soft">
              Every &ldquo;?&rdquo; tooltip in the exchange links directly to its stable anchor
              below.
            </p>
          </div>

          <div className="divide-y divide-rule">
            {GLOSSARY_ENTRIES.map((entry) => (
              <article
                key={entry.id}
                id={entry.id}
                data-testid={entry.id}
                className="py-3.5 scroll-mt-20"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h3 className="font-display text-base font-bold text-ink">{entry.term}</h3>
                  <a
                    href={`#/docs#${entry.id}`}
                    className="font-mono text-[11px] text-cobalt-700 underline decoration-dotted"
                  >
                    #{entry.id}
                  </a>
                </div>
                <p className="mt-1 text-xs font-semibold text-ink-soft">{entry.shortDef}</p>
                <p className="mt-1 text-xs leading-relaxed text-ink-muted">{entry.detail}</p>
              </article>
            ))}
          </div>
        </section>
      )}

      {/* =====================================================================
          B6. LIVE DEMO
         ===================================================================== */}
      {activeSection === 'demo' && (
        <section
          id="live-demo"
          aria-label="FairBatch Live Demo"
          data-testid="docs-live-demo"
          className="ledger-panel p-5 space-y-5 scroll-mt-20"
        >
          <div className="flex flex-wrap items-start justify-between gap-4 border-b border-rule pb-4">
            <div className="min-w-0">
              <span className="eyebrow text-vermilion-700">Part 6 · Live Demo</span>
              <h2 className="mt-1 font-display text-xl font-bold text-ink sm:text-2xl">
                Live Demo Walkthrough
              </h2>
              <p className="mt-1 max-w-2xl text-sm leading-relaxed text-ink-soft">
                Watch the end-to-end FairBatch walkthrough on Ethereum Sepolia — wallet connection,
                free testnet faucet claim, uniform-price batch swap, settlement, and token
                collection.
              </p>
            </div>
            <a
              href={LIVE_DEMO_YOUTUBE_URL}
              target="_blank"
              rel="noopener noreferrer"
              data-testid="docs-live-demo-link"
              className="tap-target inline-flex shrink-0 items-center gap-2 bg-vermilion-500 px-4 font-display text-sm font-bold text-[#FBF8F0] transition hover:bg-vermilion-600"
            >
              <PlayCircle className="h-4 w-4" aria-hidden="true" />
              <span>Watch on YouTube</span>
              <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
            </a>
          </div>

          {/* Privacy-first YouTube facade: loads youtube-nocookie iframe only after explicit user click */}
          <div
            data-testid="docs-live-demo-player"
            className="relative aspect-video w-full overflow-hidden border border-ink bg-ink"
          >
            {demoPlayerLoaded ? (
              <iframe
                src={LIVE_DEMO_EMBED_URL}
                title="FairBatch Live Demo Walkthrough"
                width={1280}
                height={720}
                loading="lazy"
                referrerPolicy="strict-origin-when-cross-origin"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                allowFullScreen
                className="h-full w-full border-0"
              />
            ) : (
              <button
                type="button"
                data-testid="docs-live-demo-play"
                onClick={() => setDemoPlayerLoaded(true)}
                aria-label="Play FairBatch Live Demo video"
                className="group relative flex h-full w-full items-center justify-center bg-ink text-left text-paper focus-visible:outline-2"
              >
                {!demoPosterFailed && (
                  <img
                    src={LIVE_DEMO_POSTER_URL}
                    alt="FairBatch Live Demo video thumbnail"
                    width={1280}
                    height={720}
                    loading="lazy"
                    onError={() => setDemoPosterFailed(true)}
                    className="absolute inset-0 h-full w-full object-cover opacity-55 transition duration-300 group-hover:scale-[1.01] group-hover:opacity-65"
                  />
                )}
                <div className="absolute inset-0 bg-gradient-to-t from-black/75 via-black/35 to-black/25" />
                <div className="relative z-10 flex flex-col items-center gap-3 px-6 text-center">
                  <span className="flex h-16 w-16 items-center justify-center border-2 border-[#FBF8F0] bg-vermilion-500 text-[#FBF8F0] shadow-lg transition group-hover:scale-105 group-hover:bg-vermilion-600">
                    <Play className="ml-1 h-7 w-7 fill-current" aria-hidden="true" />
                  </span>
                  <div>
                    <div className="font-mono text-xs font-bold uppercase tracking-label text-[#FBF8F0]/85">
                      Ethereum Sepolia · Privacy-Enhanced Embed
                    </div>
                    <div className="mt-1 font-display text-lg font-bold text-[#FBF8F0] sm:text-xl">
                      Play FairBatch Live Demo
                    </div>
                  </div>
                </div>
              </button>
            )}
          </div>

          {/* Direct link & contract reference */}
          <div className="flex flex-wrap items-center justify-between gap-3 border border-rule bg-paper-soft px-4 py-3 text-xs">
            <div className="min-w-0 space-y-0.5">
              <div className="font-mono font-bold uppercase tracking-label text-ink-muted">
                Direct Live Demo Link
              </div>
              <a
                href={LIVE_DEMO_YOUTUBE_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 break-all font-mono text-xs font-bold text-cobalt-700 underline decoration-dotted underline-offset-2 hover:text-ink"
              >
                <span>{LIVE_DEMO_YOUTUBE_URL}</span>
                <ExternalLink className="h-3 w-3 shrink-0" aria-hidden="true" />
              </a>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {fairBatchUrl && (
                <a
                  href={fairBatchUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex min-h-[36px] items-center gap-1.5 border border-rule-strong bg-paper-bright px-3 font-mono text-xs font-bold text-ink transition hover:border-ink"
                >
                  <span>Sepolia Contract</span>
                  <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                </a>
              )}
              <button
                type="button"
                onClick={onBackToExchange}
                className="inline-flex min-h-[36px] items-center gap-1.5 border border-ink bg-ink px-3 font-mono text-xs font-bold text-paper transition hover:bg-ink-soft"
              >
                <span>Try Live Exchange</span>
              </button>
            </div>
          </div>

          {/* Demo highlights */}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="border border-rule bg-paper-soft p-3.5 text-xs leading-relaxed">
              <div className="font-mono font-bold uppercase text-vermilion-700">
                01 · Wallet &amp; Faucet
              </div>
              <p className="mt-1 text-ink-soft">
                Connects on Ethereum Sepolia and claims free test {config.baseSymbol} and{' '}
                {config.quoteSymbol} from the on-chain faucet contract.
              </p>
            </div>
            <div className="border border-rule bg-paper-soft p-3.5 text-xs leading-relaxed">
              <div className="font-mono font-bold uppercase text-vermilion-700">
                02 · Batch Order Flow
              </div>
              <p className="mt-1 text-ink-soft">
                Demonstrates placing orders into an active uniform-price round alongside live
                countdown synchronization.
              </p>
            </div>
            <div className="border border-rule bg-paper-soft p-3.5 text-xs leading-relaxed">
              <div className="font-mono font-bold uppercase text-pine-700">
                03 · Uniform Clearing &amp; MEV Defense
              </div>
              <p className="mt-1 text-ink-soft">
                Settles the batch on-chain at one shared price <code>p*</code> using the pure Fe
                26.5.0 clearing kernel (<code>uses ()</code>).
              </p>
            </div>
            <div className="border border-rule bg-paper-soft p-3.5 text-xs leading-relaxed">
              <div className="font-mono font-bold uppercase text-pine-700">
                04 · Pull Claims &amp; Verification
              </div>
              <p className="mt-1 text-ink-soft">
                Collects settled payouts via pull-over-push receipts and verifies live state on
                Sepolia Etherscan.
              </p>
            </div>
          </div>
        </section>
      )}
    </div>
  );
};

export default DocsPage;
