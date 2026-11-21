import React, { Suspense, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Wallet,
} from 'lucide-react';
import { formatUnits } from 'viem';
import type { ClaimableDto, LocalSecretVaultEntry } from './types';
import { explorerTxUrl } from './onchain/config';
import { useFairBatch } from './onchain/useFairBatch';
import { TopCommandBar, type UiMode } from './components/TopCommandBar';
import { SimpleExperience } from './components/SimpleExperience';
import { ProStatsRow } from './components/ProStatsRow';
import { AccountPanel } from './components/AccountPanel';
import { BatchConsole } from './components/BatchConsole';
import { OrderTicket } from './components/OrderTicket';
import { LiquidityPanel } from './components/LiquidityPanel';
import { PriceChart } from './components/PriceChart';
import { MevComparison } from './components/MevComparison';
import { ClaimsPanel } from './components/ClaimsPanel';
import { ContractConfigModal } from './components/ContractConfigModal';
import { FeArchitectureModal } from './components/FeArchitectureModal';
import { HowItWorksModal } from './components/HowItWorksModal';
import { SandwichSimulationModal } from './components/SandwichSimulationModal';
import { formatPrice, formatToken } from './lib/format';
import {
  LOW_GAS_THRESHOLD_WEI,
  PUBLIC_SEPOLIA_FAUCETS,
  SIMPLE_COPY,
} from './lib/glossary';

const DocsPage = React.lazy(() => import('./components/docs/DocsPage'));

const MODE_STORAGE_KEY = 'fairbatch.uiMode.v1';

export type ProSectionTab = 'all' | 'trade' | 'liquidity' | 'audit' | 'claims';

function parseDocsLocation(): { inDocs: boolean; anchor: string | null } {
  if (typeof window === 'undefined') return { inDocs: false, anchor: null };
  const path = window.location.pathname || '';
  const hash = window.location.hash || '';
  if (hash.startsWith('#/docs')) {
    const sub = hash.slice('#/docs'.length);
    const anchor = sub.startsWith('#') ? sub.slice(1) : null;
    return { inDocs: true, anchor: anchor || null };
  }
  if (path === '/docs' || path.endsWith('/docs')) {
    const anchor = hash.startsWith('#') ? hash.slice(1) : null;
    return { inDocs: true, anchor: anchor || null };
  }
  return { inDocs: false, anchor: null };
}

function readInitialMode(defaultMode: UiMode): UiMode {
  try {
    if (typeof localStorage === 'undefined') return defaultMode;
    const saved = localStorage.getItem(MODE_STORAGE_KEY);
    if (saved === 'simple' || saved === 'pro') return saved;
  } catch {
    // storage unavailable
  }
  return defaultMode;
}

function human(raw: bigint | undefined, decimals: number): number {
  if (raw === undefined) return 0;
  return Number(formatUnits(raw, decimals));
}

export const App: React.FC = () => {
  const fb = useFairBatch();
  const [mode, setMode] = useState<UiMode>(() => readInitialMode('simple'));
  const [proSection, setProSection] = useState<ProSectionTab>('all');
  const [selectedViewBatchId, setSelectedViewBatchId] = useState<number | 'live'>('live');
  const [isContractModalOpen, setIsContractModalOpen] = useState<boolean>(false);
  const [isFeModalOpen, setIsFeModalOpen] = useState<boolean>(false);
  const [isHowItWorksOpen, setIsHowItWorksOpen] = useState<boolean>(false);
  const [isSimulationModalOpen, setIsSimulationModalOpen] = useState<boolean>(false);
  const [docsRoute, setDocsRoute] = useState<{ inDocs: boolean; anchor: string | null }>(() =>
    parseDocsLocation(),
  );

  useEffect(() => {
    const onLocationChange = () => {
      setDocsRoute(parseDocsLocation());
    };
    window.addEventListener('hashchange', onLocationChange);
    window.addEventListener('popstate', onLocationChange);
    return () => {
      window.removeEventListener('hashchange', onLocationChange);
      window.removeEventListener('popstate', onLocationChange);
    };
  }, []);

  const openDocs = (anchor?: string) => {
    const nextHash = anchor ? `#/docs#${anchor}` : '#/docs';
    try {
      window.history.pushState(null, '', nextHash);
    } catch {
      window.location.hash = nextHash;
    }
    setDocsRoute({ inDocs: true, anchor: anchor ?? null });
  };

  const closeDocs = () => {
    try {
      const cleanPath =
        window.location.pathname === '/docs' ? '/' : window.location.pathname || '/';
      window.history.pushState(null, '', cleanPath);
    } catch {
      window.location.hash = '';
    }
    setDocsRoute({ inDocs: false, anchor: null });
  };

  const handleModeChange = (next: UiMode) => {
    setMode(next);
    if (docsRoute.inDocs) {
      closeDocs();
    }
    if (fb.notice && fb.notice.kind !== 'error') {
      fb.clearNotice();
    }
    try {
      localStorage.setItem(MODE_STORAGE_KEY, next);
    } catch {
      // ignore storage failure
    }
  };

  const handleProSectionChange = (next: ProSectionTab) => {
    setProSection(next);
    if (fb.notice && fb.notice.kind !== 'error') {
      fb.clearNotice();
    }
  };

  const snapshot = fb.snapshot;
  const state = snapshot?.state ?? null;

  useEffect(() => {
    if (!snapshot || selectedViewBatchId === 'live') return;
    const exists = snapshot.settledHistory.some(
      (record) => record.batch_id === selectedViewBatchId,
    );
    if (!exists) setSelectedViewBatchId('live');
  }, [snapshot, selectedViewBatchId]);

  const displayedSettlement = useMemo(() => {
    if (!snapshot) return null;
    if (selectedViewBatchId !== 'live') {
      const found = snapshot.settledHistory.find(
        (record) => record.batch_id === selectedViewBatchId,
      );
      if (found) return found;
    }
    return snapshot.activeSettlement;
  }, [snapshot, selectedViewBatchId]);

  const handleSettle = async () => {
    const settlingBatch = snapshot?.state.batch_id ?? null;
    try {
      const result = await fb.settle();
      setSelectedViewBatchId(
        result.batchId >= 0 ? result.batchId : (settlingBatch ?? 'live'),
      );
    } catch {
      // surfaced via notice
    }
  };

  const handleSettleMany = async (items: ClaimableDto[]) => {
    await fb.claimMany(items);
  };

  const handleClaimSingle = async (item: ClaimableDto) => {
    await fb.claim(item);
  };

  const handleReveal = async (secret: LocalSecretVaultEntry) => {
    await fb.revealCommit(secret);
  };

  const notice = fb.notice;
  const txUrl = notice?.hash ? explorerTxUrl(fb.config, notice.hash) : null;
  const lowGas = Boolean(
    fb.account &&
    !fb.wrongNetwork &&
    snapshot &&
    snapshot.balances.eth < LOW_GAS_THRESHOLD_WEI,
  );
  const ethHuman = human(snapshot?.balances.eth, 18);
  const baseHuman = human(snapshot?.balances.base, fb.config.baseDecimals);
  const quoteHuman = human(snapshot?.balances.quote, fb.config.quoteDecimals);
  const lpSharesHuman = human(snapshot?.balances.lpShares, 18);
  const baseApproved = Boolean(snapshot?.allowances && snapshot.allowances.base > 0n);
  const quoteApproved = Boolean(snapshot?.allowances && snapshot.allowances.quote > 0n);

  const showTradeSection = proSection === 'all' || proSection === 'trade';
  const showLiquiditySection = proSection === 'all' || proSection === 'liquidity';
  const showAuditSection = proSection === 'all' || proSection === 'audit';
  const showClaimsSection = proSection === 'all' || proSection === 'claims';

  return (
    <div className="flex min-h-screen flex-col text-ink">
      <TopCommandBar
        mode={mode}
        onModeChange={handleModeChange}
        config={fb.config}
        batch={snapshot?.batch ?? null}
        livePhase={fb.livePhase}
        chainNow={fb.chainNow}
        account={fb.account}
        balances={snapshot?.balances ?? null}
        walletChainId={fb.walletChainId}
        wrongNetwork={fb.wrongNetwork}
        loading={fb.loading}
        refreshing={fb.refreshing}
        busyAction={fb.busyAction}
        onConnect={fb.connect}
        onSwitchNetwork={fb.switchNetwork}
        onDisconnect={fb.disconnect}
        onRefresh={fb.refresh}
        onOpenHowItWorks={() => setIsHowItWorksOpen(true)}
        onOpenFeModal={() => setIsFeModalOpen(true)}
        onOpenContractModal={() => setIsContractModalOpen(true)}
        onOpenSimulationModal={() => setIsSimulationModalOpen(true)}
        onOpenDocs={() => openDocs()}
        isDocsActive={docsRoute.inDocs}
      />

      <main className="mx-auto w-full max-w-[1560px] flex-1 px-4 py-5 lg:px-8">
        {notice && (
          <div
            role="status"
            data-testid="app-notice-banner"
            className={`mb-4 flex flex-wrap items-center justify-between gap-3 border-l-2 px-3.5 py-2.5 text-sm font-medium ${notice.kind === 'error'
              ? 'border-vermilion-500 bg-vermilion-50 text-vermilion-800'
              : notice.kind === 'info'
                ? 'border-cobalt-500 bg-cobalt-50 text-cobalt-800'
                : 'border-pine-600 bg-pine-50 text-pine-800'
              }`}
          >
            <div className="flex min-w-0 items-center gap-2">
              {notice.kind === 'error' ? (
                <ShieldAlert className="h-4 w-4 shrink-0 text-vermilion-600" />
              ) : (
                <CheckCircle2 className="h-4 w-4 shrink-0 text-pine-700" />
              )}
              <span className="min-w-0 break-words">{notice.text}</span>
              {txUrl && notice.hash && (
                <a
                  href={txUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex shrink-0 items-center gap-1 border border-current px-2 py-0.5 font-mono text-xs font-bold opacity-85 transition hover:opacity-100"
                >
                  <span>Tx {notice.hash.slice(0, 8)}…</span>
                  <ExternalLink className="h-3 w-3" />
                </a>
              )}
            </div>
            <button
              type="button"
              onClick={fb.clearNotice}
              className="shrink-0 border border-current px-2 py-0.5 font-mono text-xs font-bold opacity-75 transition hover:opacity-100"
            >
              Dismiss
            </button>
          </div>
        )}

        {docsRoute.inDocs ? (
          <Suspense
            fallback={
              <section className="ledger-panel flex items-center justify-center gap-2 px-6 py-16 text-sm text-ink-muted">
                <RefreshCw className="h-4 w-4 animate-spin text-cobalt-600" />
                <span>Loading documentation…</span>
              </section>
            }
          >
            <DocsPage
              config={fb.config}
              rx={state?.reserves.rx ?? 100}
              ry={state?.reserves.ry ?? 300_000}
              anchor={docsRoute.anchor}
              onBackToExchange={closeDocs}
            />
          </Suspense>
        ) : (
          <>
            {!snapshot && fb.loading && (
              <section className="ledger-panel flex flex-col items-center justify-center gap-3 px-6 py-20 text-center">
                <RefreshCw className="h-6 w-6 animate-spin text-cobalt-600" />
                <h2 className="font-display text-xl font-bold text-ink">
                  Loading Ethereum Sepolia state
                </h2>
                <p className="max-w-md text-sm leading-relaxed text-ink-muted">
                  Reading the current round, pool reserves, and recent orders from Ethereum Sepolia.
                </p>
              </section>
            )}

            {!snapshot && !fb.loading && (
              <section className="border border-vermilion-500/40 bg-vermilion-50 p-6">
                <div className="flex items-start gap-3">
                  <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-vermilion-600" />
                  <div className="min-w-0">
                    <h2 className="font-display text-xl font-bold text-ink">
                      {fb.configured
                        ? 'Unable to reach Ethereum Sepolia right now'
                        : 'No FairBatch contract configured'}
                    </h2>
                    <p className="mt-1 max-w-2xl text-sm leading-relaxed text-ink-muted">
                      {fb.error ??
                        'Configure a deployed FairBatch address and JSON-RPC endpoint to begin.'}
                    </p>
                    <div className="mt-4 flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={fb.refresh}
                        disabled={fb.refreshing}
                        className="tap-target inline-flex items-center gap-1.5 border border-vermilion-600 bg-paper-bright px-4 font-sans text-sm font-bold text-vermilion-800 transition hover:bg-vermilion-100 disabled:opacity-40"
                      >
                        <RefreshCw className={`h-4 w-4 ${fb.refreshing ? 'animate-spin' : ''}`} />
                        <span>Retry</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setIsContractModalOpen(true)}
                        className="tap-target inline-flex items-center gap-1.5 border border-ink bg-ink px-4 font-sans text-sm font-bold text-paper transition hover:bg-ink-soft"
                      >
                        <Wallet className="h-4 w-4" />
                        <span>Contract &amp; network config</span>
                      </button>
                    </div>
                  </div>
                </div>
              </section>
            )}

            {snapshot && state && displayedSettlement && mode === 'simple' && (
              <SimpleExperience
                controller={fb}
                onOpenHowItWorks={() => setIsHowItWorksOpen(true)}
              />
            )}

            {snapshot && state && displayedSettlement && mode === 'pro' && (
              <>
                {/* Always-visible Pro balance row + approval status + "New here? Switch to Simple" */}
                <section
                  aria-label="Wallet balances and token approvals"
                  data-testid="pro-balance-row"
                  className="mb-4 border border-ink bg-paper-bright shadow-slip"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-rule bg-paper-soft px-3.5 py-2 sm:px-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="eyebrow">Wallet balances &amp; approvals</span>
                      {!fb.account && (
                        <span className="font-mono text-xs text-ink-muted">
                          (Connect wallet to view live balances)
                        </span>
                      )}
                    </div>
                    <button
                      type="button"
                      data-testid="pro-switch-to-simple-link"
                      onClick={() => handleModeChange('simple')}
                      className="inline-flex items-center gap-1 font-sans text-xs font-bold text-cobalt-700 underline decoration-dotted underline-offset-4 transition hover:text-ink"
                    >
                      <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
                      <span>New here? Switch to Simple</span>
                    </button>
                  </div>

                  <div className="grid grid-cols-2 gap-px bg-rule sm:grid-cols-4">
                    <div className="bg-paper-bright px-3.5 py-2.5">
                      <div className="font-mono text-[11px] uppercase tracking-label text-ink-muted">
                        Sepolia ETH
                      </div>
                      <div
                        data-testid="pro-balance-eth"
                        className="mt-0.5 font-mono text-sm font-bold text-ink tabular-nums"
                      >
                        {formatToken(ethHuman, 4)} ETH
                      </div>
                      <div className="mt-0.5 font-mono text-[10px] text-ink-muted">
                        {lowGas ? 'Low gas (< 0.002 ETH)' : 'Gas & 0.0001 ETH deposit'}
                      </div>
                    </div>

                    <div className="bg-paper-bright px-3.5 py-2.5">
                      <div className="font-mono text-[11px] uppercase tracking-label text-ink-muted">
                        {fb.config.baseSymbol}
                      </div>
                      <div
                        data-testid="pro-balance-base"
                        className="mt-0.5 font-mono text-sm font-bold text-ink tabular-nums"
                      >
                        {formatToken(baseHuman, 4)} {fb.config.baseSymbol}
                      </div>
                      <div className="mt-0.5 flex items-center gap-1 font-mono text-[11px] text-ink-muted">
                        {baseApproved ? (
                          <>
                            <CheckCircle2 className="h-3 w-3 text-pine-600" aria-hidden="true" />
                            <span data-testid="pro-approval-base" className="text-pine-700 font-bold">
                              Approved
                            </span>
                          </>
                        ) : (
                          <>
                            <ShieldCheck className="h-3 w-3 text-brass-600" aria-hidden="true" />
                            <span data-testid="pro-approval-base">Not approved</span>
                            {fb.account && (
                              <button
                                type="button"
                                disabled={fb.busyAction !== null}
                                onClick={() => void fb.approve('base')}
                                className="ml-1 font-bold text-cobalt-700 underline decoration-dotted hover:text-ink disabled:opacity-40"
                              >
                                Approve
                              </button>
                            )}
                          </>
                        )}
                      </div>
                    </div>

                    <div className="bg-paper-bright px-3.5 py-2.5">
                      <div className="font-mono text-[11px] uppercase tracking-label text-ink-muted">
                        {fb.config.quoteSymbol}
                      </div>
                      <div
                        data-testid="pro-balance-quote"
                        className="mt-0.5 font-mono text-sm font-bold text-ink tabular-nums"
                      >
                        {formatPrice(quoteHuman, 2)} {fb.config.quoteSymbol}
                      </div>
                      <div className="mt-0.5 flex items-center gap-1 font-mono text-[11px] text-ink-muted">
                        {quoteApproved ? (
                          <>
                            <CheckCircle2 className="h-3 w-3 text-pine-600" aria-hidden="true" />
                            <span data-testid="pro-approval-quote" className="text-pine-700 font-bold">
                              Approved
                            </span>
                          </>
                        ) : (
                          <>
                            <ShieldCheck className="h-3 w-3 text-brass-600" aria-hidden="true" />
                            <span data-testid="pro-approval-quote">Not approved</span>
                            {fb.account && (
                              <button
                                type="button"
                                disabled={fb.busyAction !== null}
                                onClick={() => void fb.approve('quote')}
                                className="ml-1 font-bold text-cobalt-700 underline decoration-dotted hover:text-ink disabled:opacity-40"
                              >
                                Approve
                              </button>
                            )}
                          </>
                        )}
                      </div>
                    </div>

                    <div className="bg-paper-bright px-3.5 py-2.5">
                      <div className="font-mono text-[11px] uppercase tracking-label text-ink-muted">
                        LP Shares
                      </div>
                      <div
                        data-testid="pro-balance-lp"
                        className="mt-0.5 font-mono text-sm font-bold text-plum-700 tabular-nums"
                      >
                        {formatToken(lpSharesHuman, 2)} shares
                      </div>
                      <div className="mt-0.5 font-mono text-[10px] text-ink-muted">
                        FM-AMM passive pool
                      </div>
                    </div>
                  </div>

                  {lowGas && (
                    <div
                      data-testid="low-gas-notice"
                      className="flex flex-wrap items-center justify-between gap-2 border-t border-rule bg-brass-50 px-3.5 py-2 text-xs text-brass-900"
                    >
                      <span className="flex items-center gap-1.5 font-medium">
                        <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-brass-700" />
                        <span>
                          You need a little Sepolia ETH for gas (and 0.0001 ETH deposit for sealed
                          orders).
                        </span>
                      </span>
                      <div className="flex flex-wrap items-center gap-2">
                        {PUBLIC_SEPOLIA_FAUCETS.map((f) => (
                          <a
                            key={f.url}
                            href={f.url}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 border border-brass-700 bg-paper-bright px-2 py-0.5 font-mono text-[11px] font-bold text-brass-900 hover:bg-brass-100"
                          >
                            <span>{f.name}</span>
                            <ExternalLink className="h-3 w-3" />
                          </a>
                        ))}
                      </div>
                    </div>
                  )}
                </section>

                <ProStatsRow
                  config={fb.config}
                  state={state}
                  batch={snapshot.batch}
                  livePhase={fb.livePhase}
                  account={fb.account}
                  walletChainId={fb.walletChainId}
                  wrongNetwork={fb.wrongNetwork}
                  loading={fb.loading}
                />

                {/* Pro workspace section tabs: Trade | Liquidity | Round audit | Claims & slashing */}
                <div
                  role="tablist"
                  aria-label="Pro workspace sections"
                  data-testid="pro-section-tabs"
                  className="mb-4 flex flex-wrap gap-1 border border-rule-strong bg-paper-soft p-1"
                >
                  {(
                    [
                      { id: 'all', label: 'All panels' },
                      { id: 'trade', label: 'Trade' },
                      { id: 'liquidity', label: 'Liquidity' },
                      { id: 'audit', label: 'Round audit' },
                      { id: 'claims', label: 'Claims & slashing' },
                    ] as ReadonlyArray<{ id: ProSectionTab; label: string }>
                  ).map((tab) => (
                    <button
                      key={tab.id}
                      type="button"
                      role="tab"
                      data-testid={`pro-tab-${tab.id}`}
                      aria-selected={proSection === tab.id}
                      onClick={() => handleProSectionChange(tab.id)}
                      className={`min-h-[34px] px-3 font-mono text-xs font-bold uppercase transition ${proSection === tab.id
                        ? 'bg-ink text-paper'
                        : 'text-ink-muted hover:bg-paper-bright hover:text-ink'
                        }`}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>

                {/* SECTION 1 — TRADE: Order slip and Round clock first, compact Wallet & Faucet card */}
                {showTradeSection && (
                  <div className="grid items-start gap-5 lg:grid-cols-12">
                    <div className="min-w-0 space-y-4 lg:col-span-5">
                      <OrderTicket
                        state={{ ...state, phase: fb.livePhase }}
                        config={fb.config}
                        account={fb.account}
                        balances={snapshot.balances}
                        localSecrets={fb.secretVault}
                        busyAction={fb.busyAction}
                        minBondWei={snapshot.minBondWei}
                        onConnect={fb.connect}
                        onSubmitDirect={async (params) => {
                          await fb.submitDirect(params);
                        }}
                        onSettleAndSubmitDirect={async (params) => {
                          await fb.settleAndSubmitDirect(params);
                        }}
                        onSealCommit={async (params) => {
                          await fb.sealCommit(params);
                        }}
                        onRevealCommit={handleReveal}
                        onSignIntent={fb.signIntent}
                        onSubmitIntent={async (artifact) => {
                          await fb.submitIntent(artifact);
                        }}
                      />
                    </div>

                    <div className="min-w-0 space-y-4 lg:col-span-7">
                      <BatchConsole
                        batch={snapshot.batch}
                        phase={fb.livePhase}
                        chainNow={fb.chainNow}
                        orderCount={state.orders.length}
                        account={fb.account}
                        commitments={snapshot.allCommitments}
                        busyAction={fb.busyAction}
                        refreshing={fb.refreshing}
                        onSettle={async () => {
                          await handleSettle();
                        }}
                        onSlash={async (batchId, commitId) => {
                          await fb.slash(batchId, commitId);
                        }}
                        onRefresh={fb.refresh}
                      />

                      <AccountPanel
                        config={fb.config}
                        account={fb.account}
                        walletChainId={fb.walletChainId}
                        wrongNetwork={fb.wrongNetwork}
                        balances={snapshot.balances}
                        allowances={snapshot.allowances}
                        faucet={snapshot.faucet}
                        busyAction={fb.busyAction}
                        faucetEnabled={fb.config.tokenFaucetEnabled}
                        onConnect={fb.connect}
                        onDisconnect={fb.disconnect}
                        onClaimFaucet={async () => {
                          await fb.claimFaucet();
                        }}
                        onApprove={async (token) => {
                          await fb.approve(token);
                        }}
                      />
                    </div>
                  </div>
                )}

                {/* SECTION 2 — ROUND AUDIT: Clearing chart & MEV comparison */}
                {showAuditSection && (
                  <div className="mt-5 space-y-5">
                    <PriceChart
                      settlement={displayedSettlement}
                      isLivePreview={selectedViewBatchId === 'live'}
                      baseSymbol={fb.config.baseSymbol}
                      quoteSymbol={fb.config.quoteSymbol}
                    />

                    <MevComparison
                      settlement={displayedSettlement}
                      settledHistory={snapshot.settledHistory}
                      selectedViewBatchId={selectedViewBatchId}
                      activeBatchId={state.batch_id}
                      baseSymbol={fb.config.baseSymbol}
                      quoteSymbol={fb.config.quoteSymbol}
                      onSelectViewBatch={setSelectedViewBatchId}
                    />
                  </div>
                )}

                {/* SECTION 3 & 4 — LIQUIDITY + CLAIMS & SLASHING */}
                {(showLiquiditySection || showClaimsSection) && (
                  <div className="mt-5 grid items-start gap-5 lg:grid-cols-12">
                    {showLiquiditySection && (
                      <div
                        className={`min-w-0 ${showClaimsSection ? 'lg:col-span-5' : 'lg:col-span-12'
                          }`}
                      >
                        <LiquidityPanel
                          config={fb.config}
                          reserves={snapshot.reserves}
                          balances={snapshot.balances}
                          lpLock={snapshot.lpLock}
                          account={fb.account}
                          busyAction={fb.busyAction}
                          onAddLiquidity={async (
                            amountBase,
                            amountQuote,
                            lockDurationSecs,
                            minShares,
                          ) => {
                            await fb.addLiquidity(
                              amountBase,
                              amountQuote,
                              lockDurationSecs,
                              minShares,
                            );
                          }}
                          onRemoveLiquidity={async (shares, minBase, minQuote) => {
                            await fb.removeLiquidity(shares, minBase, minQuote);
                          }}
                        />
                      </div>
                    )}

                    {showClaimsSection && (
                      <div
                        className={`min-w-0 ${showLiquiditySection ? 'lg:col-span-7' : 'lg:col-span-12'
                          }`}
                      >
                        {proSection === 'claims' && (
                          <div className="mb-5">
                            <BatchConsole
                              batch={snapshot.batch}
                              phase={fb.livePhase}
                              chainNow={fb.chainNow}
                              orderCount={state.orders.length}
                              account={fb.account}
                              commitments={snapshot.allCommitments}
                              busyAction={fb.busyAction}
                              refreshing={fb.refreshing}
                              onSettle={async () => {
                                await handleSettle();
                              }}
                              onSlash={async (batchId, commitId) => {
                                await fb.slash(batchId, commitId);
                              }}
                              onRefresh={fb.refresh}
                            />
                          </div>
                        )}
                        <ClaimsPanel
                          claimable={snapshot.claimable}
                          config={fb.config}
                          account={fb.account}
                          busyAction={fb.busyAction}
                          onClaimSingle={handleClaimSingle}
                          onClaimMany={handleSettleMany}
                          onConnect={fb.connect}
                        />
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </>
        )}
      </main>

      <footer className="mt-10 border-t border-ink bg-paper-deep">
        <div className="mx-auto flex max-w-[1560px] flex-col items-center justify-between gap-2 px-4 py-4 text-center font-mono text-xs text-ink-muted xl:flex-row xl:text-left lg:px-8">
          <span className="font-bold text-ink-soft">
            FairBatch Exchange · One price, every order
          </span>
          <span>{SIMPLE_COPY.footerVerified}</span>
          <div className="flex flex-wrap items-center justify-center gap-3">
            <a
              href="#/docs"
              data-testid="footer-docs-link"
              onClick={(e) => {
                e.preventDefault();
                openDocs();
              }}
              className="font-bold text-cobalt-700 underline decoration-dotted underline-offset-4 hover:text-ink"
            >
              Docs (/docs)
            </a>
            <span>
              {snapshot
                ? `Sepolia · ${fb.config.fairBatch.slice(0, 6)}…${fb.config.fairBatch.slice(-4)}`
                : 'Ethereum Sepolia'}
            </span>
          </div>
        </div>
      </footer>

      <HowItWorksModal
        isOpen={isHowItWorksOpen}
        onClose={() => setIsHowItWorksOpen(false)}
        onOpenDocs={() => openDocs()}
      />

      <ContractConfigModal
        isOpen={isContractModalOpen}
        config={fb.config}
        account={fb.account}
        walletChainId={fb.walletChainId}
        wrongNetwork={fb.wrongNetwork}
        busyAction={fb.busyAction}
        onClose={() => setIsContractModalOpen(false)}
        onConnect={fb.connect}
        onDisconnect={fb.disconnect}
      />

      <FeArchitectureModal
        isOpen={isFeModalOpen}
        onClose={() => setIsFeModalOpen(false)}
      />

      <SandwichSimulationModal
        isOpen={isSimulationModalOpen}
        rx={state?.reserves.rx ?? 100}
        ry={state?.reserves.ry ?? 300_000}
        baseSymbol={fb.config.baseSymbol}
        quoteSymbol={fb.config.quoteSymbol}
        onClose={() => setIsSimulationModalOpen(false)}
      />
    </div>
  );
};

export default App;
