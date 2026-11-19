import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  RefreshCw,
  ShieldAlert,
  Wallet,
} from 'lucide-react';
import type { ClaimableDto, LocalSecretVaultEntry } from './types';
import { explorerTxUrl } from './onchain/config';
import { useFairBatch } from './onchain/useFairBatch';
import { TopCommandBar } from './components/TopCommandBar';
import { AccountPanel } from './components/AccountPanel';
import { BatchConsole } from './components/BatchConsole';
import { OrderTicket } from './components/OrderTicket';
import { LiquidityPanel } from './components/LiquidityPanel';
import { PriceChart } from './components/PriceChart';
import { MevComparison } from './components/MevComparison';
import { ClaimsPanel } from './components/ClaimsPanel';
import { ContractConfigModal } from './components/ContractConfigModal';
import { FeArchitectureModal } from './components/FeArchitectureModal';

export const App: React.FC = () => {
  const fb = useFairBatch();
  const [selectedViewBatchId, setSelectedViewBatchId] = useState<number | 'live'>(
    'live',
  );
  const [isContractModalOpen, setIsContractModalOpen] = useState<boolean>(false);
  const [isFeModalOpen, setIsFeModalOpen] = useState<boolean>(false);

  const snapshot = fb.snapshot;
  const state = snapshot?.state ?? null;

  // If a selection points at a batch that no longer exists (config switch), fall back.
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
      // The controller already surfaced the failure in the notice banner.
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

  return (
    <div className="flex min-h-screen flex-col text-ink">
      <TopCommandBar
        config={fb.config}
        state={state}
        batch={snapshot?.batch ?? null}
        account={fb.account}
        walletChainId={fb.walletChainId}
        wrongNetwork={fb.wrongNetwork}
        loading={fb.loading}
        refreshing={fb.refreshing}
        busyAction={fb.busyAction}
        onRefresh={fb.refresh}
        onSettleBatch={() => void handleSettle()}
        onOpenContractModal={() => setIsContractModalOpen(true)}
        onOpenFeModal={() => setIsFeModalOpen(true)}
      />

      <main className="mx-auto w-full max-w-[1560px] flex-1 px-4 py-5 lg:px-8">
        {notice && (
          <div
            role="status"
            className={`mb-4 flex flex-wrap items-center justify-between gap-3 border-l-2 px-3 py-2 text-[11px] font-medium ${
              notice.kind === 'error'
                ? 'border-vermilion-500 bg-vermilion-50 text-vermilion-800'
                : notice.kind === 'info'
                  ? 'border-cobalt-500 bg-cobalt-50 text-cobalt-800'
                  : 'border-pine-600 bg-pine-50 text-pine-800'
            }`}
          >
            <div className="flex min-w-0 items-center gap-2">
              {notice.kind === 'error' ? (
                <ShieldAlert className="h-3.5 w-3.5 shrink-0 text-vermilion-600" />
              ) : (
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-pine-700" />
              )}
              <span className="min-w-0 break-words">{notice.text}</span>
              {txUrl && notice.hash && (
                <a
                  href={txUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex shrink-0 items-center gap-1 border border-current px-1.5 py-0.5 font-mono text-[8.5px] font-bold uppercase tracking-label opacity-80 transition hover:opacity-100"
                >
                  <span>Tx {notice.hash.slice(0, 8)}…</span>
                  <ExternalLink className="h-2.5 w-2.5" />
                </a>
              )}
            </div>
            <button
              type="button"
              onClick={fb.clearNotice}
              className="shrink-0 border border-current px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-label opacity-60 transition hover:opacity-100"
            >
              Dismiss
            </button>
          </div>
        )}

        {!snapshot && fb.loading && (
          <section className="ledger-panel flex flex-col items-center justify-center gap-3 px-6 py-20 text-center">
            <RefreshCw className="h-6 w-6 animate-spin text-cobalt-600" />
            <h2 className="font-display text-xl font-bold text-ink">
              Syncing the on-chain ledger
            </h2>
            <p className="max-w-md text-[11.5px] leading-relaxed text-ink-muted">
              Reading the current batch, pool reserves and event history from{' '}
              <span className="font-mono text-ink-soft">{fb.config.rpcUrl}</span>.
            </p>
          </section>
        )}

        {!snapshot && !fb.loading && (
          <section className="border border-vermilion-500/40 bg-vermilion-50/60 p-6">
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-vermilion-600" />
              <div className="min-w-0">
                <h2 className="font-display text-xl font-bold text-ink">
                  {fb.configured
                    ? 'Unable to read the FairBatch contract'
                    : 'No FairBatch contract configured'}
                </h2>
                <p className="mt-1 max-w-2xl text-[11.5px] leading-relaxed text-ink-muted">
                  {fb.error ??
                    'Configure a deployed FairBatch address and JSON-RPC endpoint to begin.'}
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={fb.refresh}
                    disabled={fb.refreshing}
                    className="inline-flex items-center gap-1.5 border border-vermilion-600 bg-paper-bright px-3 py-1.5 font-mono text-[9px] font-bold uppercase tracking-[0.06em] text-vermilion-800 transition hover:bg-vermilion-100 disabled:opacity-40"
                  >
                    <RefreshCw className={`h-3 w-3 ${fb.refreshing ? 'animate-spin' : ''}`} />
                    <span>Retry</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setIsContractModalOpen(true)}
                    className="inline-flex items-center gap-1.5 border border-ink bg-ink px-3 py-1.5 font-mono text-[9px] font-bold uppercase tracking-[0.06em] text-paper transition hover:bg-ink-soft"
                  >
                    <Wallet className="h-3 w-3" />
                    <span>Open contract config</span>
                  </button>
                </div>
              </div>
            </div>
          </section>
        )}

        {snapshot && state && displayedSettlement && (
          <>
            <div className="grid items-start gap-5 lg:grid-cols-12">
              <div className="min-w-0 space-y-4 lg:col-span-4">
                <AccountPanel
                  config={fb.config}
                  account={fb.account}
                  walletChainId={fb.walletChainId}
                  wrongNetwork={fb.wrongNetwork}
                  balances={snapshot.balances}
                  allowances={snapshot.allowances}
                  busyAction={fb.busyAction}
                  faucetEnabled={fb.config.tokenFaucetEnabled}
                  onConnect={fb.connect}
                  onDisconnect={fb.disconnect}
                  onFaucet={async (token) => {
                    await fb.faucet(token);
                  }}
                  onApprove={async (token) => {
                    await fb.approve(token);
                  }}
                />

                <OrderTicket
                  state={state}
                  config={fb.config}
                  account={fb.account}
                  localSecrets={fb.secretVault}
                  busyAction={fb.busyAction}
                  minBondWei={snapshot.minBondWei}
                  onConnect={fb.connect}
                  onSubmitDirect={async (params) => {
                    await fb.submitDirect(params);
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

              <div className="min-w-0 space-y-5 lg:col-span-8">
                <BatchConsole
                  batch={snapshot.batch}
                  phase={state.phase}
                  config={fb.config}
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
            </div>

            <div className="mt-5 grid items-start gap-5 lg:grid-cols-12">
              <div className="min-w-0 lg:col-span-5">
                <LiquidityPanel
                  config={fb.config}
                  reserves={snapshot.reserves}
                  balances={snapshot.balances}
                  account={fb.account}
                  busyAction={fb.busyAction}
                  onAddLiquidity={async (amountBase, amountQuote) => {
                    await fb.addLiquidity(amountBase, amountQuote);
                  }}
                  onRemoveLiquidity={async (shares) => {
                    await fb.removeLiquidity(shares);
                  }}
                />
              </div>

              <div className="min-w-0 lg:col-span-7">
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
            </div>
          </>
        )}
      </main>

      <footer className="mt-10 border-t border-ink bg-paper-deep">
        <div className="mx-auto flex max-w-[1560px] flex-col items-center justify-between gap-2 px-4 py-4 text-center font-mono text-[9px] uppercase tracking-[0.12em] text-ink-muted xl:flex-row xl:text-left lg:px-8">
          <span className="text-ink-soft">
            FairBatch Exchange · One price, every order
          </span>
          <span className="normal-case tracking-normal">
            Built natively in{' '}
            <span className="font-bold text-cobalt-700">Fe 26.5.0</span> —{' '}
            <code className="text-ink-soft">clearing::solve_batch</code>,{' '}
            <code className="text-ink-soft">core::fixed::Wad</code>, EIP-1153{' '}
            <code className="text-ink-soft">Mutex</code>,{' '}
            <code className="text-ink-soft">std::evm::eip712</code>
          </span>
          <span>
            {snapshot
              ? `Chain ${fb.config.chainId} · ${fb.config.fairBatch.slice(0, 6)}…${fb.config.fairBatch.slice(-4)} · refreshed ${new Date(snapshot.lastUpdated).toLocaleTimeString()}`
              : 'Read-only until a contract is configured'}
          </span>
        </div>
      </footer>

      <ContractConfigModal
        isOpen={isContractModalOpen}
        config={fb.config}
        account={fb.account}
        walletChainId={fb.walletChainId}
        wrongNetwork={fb.wrongNetwork}
        busyAction={fb.busyAction}
        onClose={() => setIsContractModalOpen(false)}
        onSaveConfig={fb.updateConfig}
        onResetConfig={fb.resetConfig}
        onConnect={fb.connect}
        onDisconnect={fb.disconnect}
      />

      <FeArchitectureModal
        isOpen={isFeModalOpen}
        onClose={() => setIsFeModalOpen(false)}
      />
    </div>
  );
};

export default App;
