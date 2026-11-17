import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, ShieldAlert } from 'lucide-react';
import type {
  BatchSettlementDto,
  ClaimableDto,
  ContractConfigUpdatePayload,
  HealthResponse,
  LocalSecretVaultEntry,
  OrderSide,
  PresetId,
  SignedDemoIntentResponse,
  StateResponse,
} from './types';
import { fairBatchApi } from './api';
import { computeBatchSettlement, fallbackStore } from './lib/fallbackEngine';
import { formatPrice } from './lib/format';
import { TopCommandBar } from './components/TopCommandBar';
import { PresetScenario } from './components/PresetScenario';
import { OrderTicket } from './components/OrderTicket';
import { PriceChart } from './components/PriceChart';
import { MevComparison } from './components/MevComparison';
import { ClaimsPanel } from './components/ClaimsPanel';
import { ContractConfigModal } from './components/ContractConfigModal';
import { FeArchitectureModal } from './components/FeArchitectureModal';

export const App: React.FC = () => {
  const [state, setState] = useState<StateResponse>(() =>
    fallbackStore.getState(),
  );
  const [health, setHealth] = useState<HealthResponse>(() =>
    fallbackStore.getHealth(),
  );
  const [isLiveBackend, setIsLiveBackend] = useState<boolean>(false);

  const [selectedTraderAddress, setSelectedTraderAddress] = useState<string>(
    () => fallbackStore.getState().demo_wallets[0]?.address ?? '',
  );
  const [browserWalletAddress, setBrowserWalletAddress] = useState<
    string | null
  >(null);

  const [activePreset, setActivePreset] = useState<PresetId>('five_sellers');
  const [includeSandwichBot, setIncludeSandwichBot] = useState<boolean>(false);
  const [localSecrets, setLocalSecrets] = useState<LocalSecretVaultEntry[]>([]);

  const [livePreviewSettlement, setLivePreviewSettlement] =
    useState<BatchSettlementDto | null>(null);
  const [selectedViewBatchId, setSelectedViewBatchId] = useState<
    number | 'live'
  >('live');

  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [bannerMsg, setBannerMsg] = useState<{
    kind: 'success' | 'error';
    text: string;
  } | null>(null);

  const [isContractModalOpen, setIsContractModalOpen] =
    useState<boolean>(false);
  const [isFeModalOpen, setIsFeModalOpen] = useState<boolean>(false);
  const userInteractedRef = useRef<boolean>(false);

  // Initial sync with Rust solver backend (graceful fallback if offline)
  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      try {
        const [healthRes, stateRes] = await Promise.all([
          fairBatchApi.getHealth(),
          fairBatchApi.getState(),
        ]);
        if (cancelled) return;

        setHealth(healthRes.health);
        setIsLiveBackend(healthRes.isLiveBackend && stateRes.isLiveBackend);

        if (userInteractedRef.current) return;

        let nextState = stateRes.state;
        // If fresh empty Batch #1 on live backend, populate flagship 5-sellers scenario
        if (
          nextState.batch_id === 1 &&
          nextState.orders.length === 0 &&
          nextState.commitments.length === 0 &&
          nextState.settled_history.length === 0
        ) {
          nextState = await fairBatchApi.loadPreset({
            preset: 'five_sellers',
            include_sandwich_bot: false,
          });
        }
        if (cancelled || userInteractedRef.current) return;
        setState(nextState);
        if (nextState.demo_wallets[0]?.address) {
          setSelectedTraderAddress(nextState.demo_wallets[0].address);
        }
      } catch (err) {
        if (!cancelled) {
          setBannerMsg({
            kind: 'error',
            text:
              err instanceof Error
                ? err.message
                : 'Failed to initialize application state',
          });
        }
      }
    }

    void bootstrap();
    return () => {
      cancelled = true;
    };
  }, []);

  // Recompute live pending batch preview via backend `/api/compare` when connected
  useEffect(() => {
    let cancelled = false;

    if (!isLiveBackend) {
      setLivePreviewSettlement(null);
      return () => {
        cancelled = true;
      };
    }

    async function syncLiveCompare() {
      try {
        const res = await fairBatchApi.compareStateless({
          rx: state.reserves.rx,
          ry: state.reserves.ry,
          fee_bps: 30,
          include_sandwich_bot: includeSandwichBot,
          orders: state.orders,
        });
        if (!cancelled) {
          setLivePreviewSettlement(res.settlement);
        }
      } catch {
        if (!cancelled) {
          setLivePreviewSettlement(null);
        }
      }
    }

    void syncLiveCompare();
    return () => {
      cancelled = true;
    };
  }, [
    isLiveBackend,
    state.reserves.rx,
    state.reserves.ry,
    state.orders,
    includeSandwichBot,
  ]);

  const localComputedLiveSettlement = useMemo(
    () =>
      computeBatchSettlement(
        state.batch_id,
        state.reserves.rx,
        state.reserves.ry,
        state.orders,
        0,
        30,
        includeSandwichBot,
      ),
    [
      state.batch_id,
      state.reserves.rx,
      state.reserves.ry,
      state.orders,
      includeSandwichBot,
    ],
  );

  const displayedSettlement = useMemo(() => {
    if (selectedViewBatchId !== 'live') {
      const found = state.settled_history.find(
        (h) => h.batch_id === selectedViewBatchId,
      );
      if (found) return found;
    }
    return livePreviewSettlement ?? localComputedLiveSettlement;
  }, [
    selectedViewBatchId,
    state.settled_history,
    livePreviewSettlement,
    localComputedLiveSettlement,
  ]);

  const handleLoadPreset = useCallback(
    async (preset: PresetId, sandwichOverride?: boolean) => {
      userInteractedRef.current = true;
      const nextSandwich =
        sandwichOverride !== undefined ? sandwichOverride : includeSandwichBot;
      setBusyAction('preset');
      setBannerMsg(null);
      try {
        const nextState = await fairBatchApi.loadPreset({
          preset,
          include_sandwich_bot: nextSandwich,
        });
        setActivePreset(preset);
        setIncludeSandwichBot(nextSandwich);
        setState(nextState);
        setSelectedViewBatchId('live');
      } catch (err) {
        setBannerMsg({
          kind: 'error',
          text: err instanceof Error ? err.message : 'Failed to load preset',
        });
      } finally {
        setBusyAction(null);
      }
    },
    [includeSandwichBot],
  );

  const handleAdvancePhase = async () => {
    userInteractedRef.current = true;
    setBusyAction('advance');
    setBannerMsg(null);
    try {
      const nextState = await fairBatchApi.advanceBatch();
      setState(nextState);
      setBannerMsg({
        kind: 'success',
        text: `Batch #${nextState.batch_id} transitioned to Reveal / Signed Intent phase.`,
      });
    } catch (err) {
      setBannerMsg({
        kind: 'error',
        text: err instanceof Error ? err.message : 'Failed to advance phase',
      });
    } finally {
      setBusyAction(null);
    }
  };

  const handleSettleBatch = async () => {
    userInteractedRef.current = true;
    setBusyAction('settle');
    setBannerMsg(null);
    try {
      const res = await fairBatchApi.settleBatch();
      setState(res.state);
      setSelectedViewBatchId(res.settlement.batch_id);
      setBannerMsg({
        kind: 'success',
        text: `Settled Batch #${res.settlement.batch_id} at Uniform Clearing Price p* = $${formatPrice(
          res.settlement.clearing_price,
          2,
        )} USDC/WETH. Pull claims unlocked below!`,
      });
    } catch (err) {
      setBannerMsg({
        kind: 'error',
        text: err instanceof Error ? err.message : 'Batch settlement failed',
      });
    } finally {
      setBusyAction(null);
    }
  };

  const handleResetPool = async () => {
    setBusyAction('reset');
    setBannerMsg(null);
    try {
      await fairBatchApi.resetPool({ rx: 100, ry: 300_000 });
      const freshState = await fairBatchApi.loadPreset({
        preset: 'five_sellers',
        include_sandwich_bot: false,
        reset_reserves: { rx: 100, ry: 300_000 },
      });
      setActivePreset('five_sellers');
      setIncludeSandwichBot(false);
      setLocalSecrets([]);
      setState(freshState);
      setSelectedViewBatchId('live');
      setBannerMsg({
        kind: 'success',
        text: 'Reset pool to 100.00 WETH / 300,000 USDC ($3,000.00 spot).',
      });
    } catch (err) {
      setBannerMsg({
        kind: 'error',
        text: err instanceof Error ? err.message : 'Failed to reset pool',
      });
    } finally {
      setBusyAction(null);
    }
  };

  const handleSubmitDirect = async (params: {
    trader: string;
    label?: string;
    side: OrderSide;
    amount_in: number;
    limit_price: number;
  }) => {
    setBusyAction('direct');
    try {
      const nextState = await fairBatchApi.submitDirectOrder(params);
      setState(nextState);
      setSelectedViewBatchId('live');
    } finally {
      setBusyAction(null);
    }
  };

  const handleSealCommit = async (params: {
    trader: string;
    label: string;
    side: OrderSide;
    amount_in: number;
    limit_price: number;
    salt: string;
    bond_eth: number;
  }) => {
    userInteractedRef.current = true;
    setBusyAction('commit');
    try {
      const { commitment_hash } = await fairBatchApi.computeCommitmentHash({
        trader: params.trader,
        batch_id: state.batch_id,
        side: params.side,
        amount_in: params.amount_in,
        limit_price: params.limit_price,
        salt: params.salt,
      });

      const res = await fairBatchApi.commitOrder({
        trader: params.trader,
        commitment_hash,
        bond_eth: params.bond_eth,
      });

      setLocalSecrets((prev) => [
        ...prev,
        {
          commit_id: res.commit_id,
          batch_id: state.batch_id,
          trader: params.trader,
          label: params.label,
          side: params.side,
          amount_in: params.amount_in,
          limit_price: params.limit_price,
          salt: params.salt,
          commitment_hash,
          bond_eth: params.bond_eth,
          revealed: false,
        },
      ]);
      setState(res.state);
      setSelectedViewBatchId('live');
    } finally {
      setBusyAction(null);
    }
  };

  const handleRevealCommit = async (secret: LocalSecretVaultEntry) => {
    setBusyAction('reveal');
    try {
      const nextState = await fairBatchApi.revealOrder({
        commit_id: secret.commit_id,
        trader: secret.trader,
        side: secret.side,
        amount_in: secret.amount_in,
        limit_price: secret.limit_price,
        salt: secret.salt,
        label: secret.label,
      });
      setLocalSecrets((prev) =>
        prev.map((item) =>
          item.commit_id === secret.commit_id && item.batch_id === secret.batch_id
            ? { ...item, revealed: true }
            : item,
        ),
      );
      setState(nextState);
      setSelectedViewBatchId('live');
    } finally {
      setBusyAction(null);
    }
  };

  const handleSignDemoIntent = async (params: {
    demo_account_index: number;
    side: OrderSide;
    amount_in: number;
    limit_price: number;
    batch_id: number;
    deadline: number;
  }): Promise<SignedDemoIntentResponse> => {
    setBusyAction('sign-intent');
    try {
      return await fairBatchApi.signDemoIntent(params);
    } finally {
      setBusyAction(null);
    }
  };

  const handleSubmitSignedIntent = async (params: {
    trader: string;
    label?: string;
    side: OrderSide;
    amount_in: number;
    limit_price: number;
    batch_id: number;
    nonce: number;
    deadline: number;
    signature: string;
  }) => {
    userInteractedRef.current = true;
    setBusyAction('submit-intent');
    try {
      const nextState = await fairBatchApi.submitSignedIntent(params);
      setState(nextState);
      setSelectedViewBatchId('live');
    } finally {
      setBusyAction(null);
    }
  };

  const handleClaimSingle = async (item: ClaimableDto) => {
    setBusyAction('claim');
    try {
      const res = await fairBatchApi.claimBatch({
        trader: item.trader,
        claims: [{ batch_id: item.batch_id, order_id: item.order_id }],
      });
      setState(res.state);
    } finally {
      setBusyAction(null);
    }
  };

  const handleMulticallClaimAll = async (
    items: ClaimableDto[],
    trader: string,
  ) => {
    setBusyAction('multicall-claim');
    try {
      const res = await fairBatchApi.claimBatch({
        trader,
        claims: items.map((i) => ({
          batch_id: i.batch_id,
          order_id: i.order_id,
        })),
      });
      setState(res.state);
    } finally {
      setBusyAction(null);
    }
  };

  const handleSaveContractConfig = async (
    payload: ContractConfigUpdatePayload,
  ) => {
    const updatedHealth = await fairBatchApi.updateContractConfig(payload);
    setHealth(updatedHealth);
  };

  return (
    <div className="min-h-screen flex flex-col text-slate-100">
      <TopCommandBar
        state={state}
        health={health}
        isLiveBackend={isLiveBackend}
        selectedTraderAddress={selectedTraderAddress}
        browserWalletAddress={browserWalletAddress}
        busyAction={busyAction}
        onSelectTrader={setSelectedTraderAddress}
        onAdvancePhase={handleAdvancePhase}
        onSettleBatch={handleSettleBatch}
        onResetPool={handleResetPool}
        onOpenContractModal={() => setIsContractModalOpen(true)}
        onOpenFeModal={() => setIsFeModalOpen(true)}
      />

      <main className="mx-auto w-full max-w-[1600px] flex-1 space-y-4 px-4 py-4 lg:px-6">
        {bannerMsg && (
          <div
            role="status"
            className={`flex items-center justify-between gap-3 rounded-xl border px-4 py-2.5 text-xs font-medium ${
              bannerMsg.kind === 'error'
                ? 'border-rose-500/40 bg-rose-500/15 text-rose-200'
                : 'border-emerald-500/40 bg-emerald-500/15 text-emerald-200'
            }`}
          >
            <div className="flex items-center gap-2">
              {bannerMsg.kind === 'error' ? (
                <ShieldAlert className="h-4 w-4 text-rose-400 shrink-0" />
              ) : (
                <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
              )}
              <span>{bannerMsg.text}</span>
            </div>
            <button
              type="button"
              onClick={() => setBannerMsg(null)}
              className="text-[11px] opacity-75 hover:opacity-100"
            >
              Dismiss
            </button>
          </div>
        )}

        {/* 1-Click Scenario Bar + MEV Sandwich Toggle */}
        <PresetScenario
          activePreset={activePreset}
          includeSandwichBot={includeSandwichBot}
          busy={busyAction !== null}
          onSelectPreset={(preset) => void handleLoadPreset(preset)}
          onToggleSandwichBot={(enabled) =>
            void handleLoadPreset(activePreset, enabled)
          }
        />

        {/* Core 12-Column Exchange Terminal Grid */}
        <div className="grid gap-4 lg:grid-cols-12 items-start">
          {/* Left 4 Columns: 3-Mode Order Entry Ticket & Active Batch Queue */}
          <div className="lg:col-span-4 space-y-4">
            <OrderTicket
              state={state}
              health={health}
              selectedTraderAddress={selectedTraderAddress}
              localSecrets={localSecrets}
              busyAction={busyAction}
              onSubmitDirect={handleSubmitDirect}
              onSealCommit={handleSealCommit}
              onRevealCommit={handleRevealCommit}
              onSignDemoIntent={handleSignDemoIntent}
              onSubmitSignedIntent={handleSubmitSignedIntent}
            />
          </div>

          {/* Right 8 Columns: Supply/Demand Visualizer, MEV Receipt Audit, Pull Claims */}
          <div className="lg:col-span-8 space-y-4">
            <PriceChart
              settlement={displayedSettlement}
              isLivePreview={selectedViewBatchId === 'live'}
            />

            <MevComparison
              settlement={displayedSettlement}
              settledHistory={state.settled_history}
              selectedViewBatchId={selectedViewBatchId}
              activeBatchId={state.batch_id}
              onSelectViewBatch={setSelectedViewBatchId}
            />

            <ClaimsPanel
              claimable={state.claimable}
              selectedTraderAddress={selectedTraderAddress}
              busyAction={busyAction}
              onClaimSingle={handleClaimSingle}
              onMulticallClaimAll={handleMulticallClaimAll}
            />
          </div>
        </div>
      </main>

      <footer className="mt-8 border-t border-slate-800/80 bg-[#070A12] py-3 text-center text-[11px] text-slate-500">
        FairBatch Exchange · Built natively in{' '}
        <span className="font-mono text-cyan-400">Fe 26.5.0</span> (Zero-effect{' '}
        <code className="text-emerald-400">clearing::solve_batch</code>,{' '}
        <code className="text-slate-300">core::fixed::Wad</code>, EIP-1153{' '}
        <code className="text-slate-300">Mutex</code>,{' '}
        <code className="text-slate-300">std::evm::eip712</code>) · Ready for
        Ethereum Mainnet, Sepolia &amp; Hoodi
      </footer>

      <ContractConfigModal
        isOpen={isContractModalOpen}
        health={health}
        browserWalletAddress={browserWalletAddress}
        onClose={() => setIsContractModalOpen(false)}
        onSaveConfig={handleSaveContractConfig}
        onConnectBrowserWallet={(addr) => {
          setBrowserWalletAddress(addr);
          setSelectedTraderAddress(addr);
        }}
      />

      <FeArchitectureModal
        isOpen={isFeModalOpen}
        onClose={() => setIsFeModalOpen(false)}
      />
    </div>
  );
};

export default App;
