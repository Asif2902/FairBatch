import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Check,
  Copy,
  ExternalLink,
  Fuel,
  Loader2,
  LogOut,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Wallet,
  X,
} from 'lucide-react';
import { formatUnits } from 'viem';
import type { DetectedWallet } from '../onchain/client';
import {
  explorerAddressUrl,
  maskRpcUrl,
  type RuntimeConfig,
} from '../onchain/config';
import type { WalletBalances } from '../onchain/state';
import {
  formatTokenAmount,
  getChainLabel,
  shortenAddress,
} from '../lib/format';
import {
  LOW_GAS_THRESHOLD_WEI,
  PUBLIC_SEPOLIA_FAUCETS,
} from '../lib/glossary';
import { UI_LABELS } from '../lib/uiLabels';

export type WalletModalView = 'connect' | 'account';

interface WalletConnectModalProps {
  isOpen: boolean;
  initialView?: WalletModalView;
  config: RuntimeConfig;
  detectedWallets: DetectedWallet[];
  activeWallet: DetectedWallet | null;
  account: string | null;
  balances: WalletBalances | null;
  walletChainId: number | null;
  wrongNetwork: boolean;
  busyAction: string | null;
  onClose: () => void;
  onConnectWallet: (wallet?: DetectedWallet) => Promise<void>;
  onRescanWallets: () => DetectedWallet[];
  onSwitchNetwork: () => Promise<void>;
  onDisconnect: () => void;
}

interface RecommendedWallet {
  id: string;
  rdnsHints: string[];
  name: string;
  tagline: string;
  url: string;
  accentClass: string;
  monogram: string;
}

const RECOMMENDED_WALLETS: ReadonlyArray<RecommendedWallet> = [
  {
    id: 'metamask',
    rdnsHints: ['io.metamask', 'io.metamask.flask'],
    name: 'MetaMask',
    tagline: 'Most widely used Ethereum extension',
    url: 'https://metamask.io/download/',
    accentClass: 'border-vermilion-500/50 bg-vermilion-50 text-vermilion-700',
    monogram: 'MM',
  },
  {
    id: 'rabby',
    rdnsHints: ['io.rabby'],
    name: 'Rabby Wallet',
    tagline: 'Pre-sign simulation & security checks',
    url: 'https://rabby.io/',
    accentClass: 'border-cobalt-600/50 bg-cobalt-50 text-cobalt-700',
    monogram: 'RB',
  },
  {
    id: 'coinbase',
    rdnsHints: ['com.coinbase.wallet'],
    name: 'Coinbase Wallet',
    tagline: 'Smart wallet & browser extension',
    url: 'https://www.coinbase.com/wallet/downloads',
    accentClass: 'border-cobalt-600/50 bg-cobalt-50 text-cobalt-800',
    monogram: 'CB',
  },
  {
    id: 'rainbow',
    rdnsHints: ['me.rainbow'],
    name: 'Rainbow',
    tagline: 'Ethereum-native browser extension',
    url: 'https://rainbow.me/download',
    accentClass: 'border-plum-600/50 bg-plum-50 text-plum-700',
    monogram: 'RN',
  },
];

let cachedDisplayTransitionSupport: boolean | undefined;

function canTransitionDisplay(): boolean {
  if (cachedDisplayTransitionSupport !== undefined) {
    return cachedDisplayTransitionSupport;
  }
  if (
    typeof window === 'undefined' ||
    typeof document === 'undefined' ||
    !document.body ||
    typeof window.CSS?.supports !== 'function' ||
    !window.CSS.supports('transition-behavior', 'allow-discrete')
  ) {
    return false;
  }
  const probe = document.createElement('div');
  probe.style.cssText = 'transition: display 1s allow-discrete !important; display: block;';
  document.body.appendChild(probe);
  window.getComputedStyle(probe).display;
  probe.style.display = 'none';
  cachedDisplayTransitionSupport = window.getComputedStyle(probe).display === 'block';
  probe.remove();
  return cachedDisplayTransitionSupport;
}

function supportsTopLayerExit(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.CSS?.supports === 'function' &&
    window.CSS.supports('overlay', 'auto') &&
    canTransitionDisplay()
  );
}

async function closeTopLayerDialog(dialog: HTMLDialogElement): Promise<void> {
  if (!dialog.open) return;
  if (!supportsTopLayerExit()) {
    dialog.setAttribute('data-closing', '');
    const animations =
      typeof dialog.getAnimations === 'function'
        ? dialog.getAnimations({ subtree: true })
        : [];
    if (animations.length > 0) {
      await Promise.race([
        Promise.allSettled(animations.map((a) => a.finished)),
        new Promise((resolve) => window.setTimeout(resolve, 400)),
      ]);
    }
    if (!dialog.hasAttribute('data-closing')) return;
    dialog.removeAttribute('data-closing');
  }
  if (dialog.open) {
    dialog.close();
  }
}

function isSafeImageSrc(src: string | null | undefined): src is string {
  if (!src) return false;
  const trimmed = src.trim();
  return /^data:image\/(png|jpeg|jpg|webp|svg\+xml|gif);/i.test(trimmed) || /^https:\/\//i.test(trimmed);
}

function human(raw: bigint | undefined, decimals: number): number {
  if (raw === undefined) return 0;
  return Number(formatUnits(raw, decimals));
}

function WalletBadgeIcon({
  wallet,
  size = 'md',
}: {
  wallet: DetectedWallet | null;
  size?: 'sm' | 'md';
}) {
  const [imgFailed, setImgFailed] = useState(false);
  const dim = size === 'sm' ? 'h-7 w-7' : 'h-9 w-9';

  if (wallet && isSafeImageSrc(wallet.icon) && !imgFailed) {
    return (
      <span
        className={`flex ${dim} shrink-0 items-center justify-center border border-rule bg-paper p-1`}
      >
        <img
          src={wallet.icon}
          alt=""
          className="h-full w-full object-contain"
          onError={() => setImgFailed(true)}
        />
      </span>
    );
  }

  const initials = wallet
    ? wallet.name
        .split(/\s+/)
        .map((part) => part[0] ?? '')
        .join('')
        .slice(0, 2)
        .toUpperCase()
    : 'W3';

  return (
    <span
      className={`flex ${dim} shrink-0 items-center justify-center border border-ink bg-ink font-mono text-xs font-bold text-paper`}
      aria-hidden="true"
    >
      {initials || <Wallet className="h-4 w-4" />}
    </span>
  );
}

export const WalletConnectModal: React.FC<WalletConnectModalProps> = ({
  isOpen,
  initialView = 'connect',
  config,
  detectedWallets,
  activeWallet,
  account,
  balances,
  walletChainId,
  wrongNetwork,
  busyAction,
  onClose,
  onConnectWallet,
  onRescanWallets,
  onSwitchNetwork,
  onDisconnect,
}) => {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const onRescanRef = useRef(onRescanWallets);
  onRescanRef.current = onRescanWallets;

  const [view, setView] = useState<WalletModalView>(initialView);
  const [connectingWalletId, setConnectingWalletId] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [copied, setCopied] = useState<boolean>(false);
  const [rescanning, setRescanning] = useState<boolean>(false);

  // Sync view and clear transient errors whenever the dialog opens.
  useEffect(() => {
    if (!isOpen) return;
    setView(account && initialView === 'account' ? 'account' : 'connect');
    setConnectError(null);
    setConnectingWalletId(null);
    setCopied(false);
    onRescanRef.current();
  }, [isOpen, initialView, account]);

  // Open / close the native <dialog> via showModal() / closeTopLayerDialog().
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (isOpen) {
      dialog.removeAttribute('data-closing');
      if (!dialog.open) {
        dialog.showModal();
      }
    } else if (dialog.open) {
      void closeTopLayerDialog(dialog);
    }
  }, [isOpen]);

  // Listen to native `close`, `cancel`, and progressive-enhancement light-dismiss fallback.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    const handleClose = () => {
      dialog.removeAttribute('data-closing');
      dialog.returnValue = '';
      onCloseRef.current();
    };

    const handleCancel = (event: Event) => {
      if (!supportsTopLayerExit()) {
        event.preventDefault();
        void closeTopLayerDialog(dialog);
      }
    };

    dialog.addEventListener('close', handleClose);
    dialog.addEventListener('cancel', handleCancel);

    // Fallback light-dismiss ONLY for browsers without native `closedBy` (e.g. Safari).
    const supportsClosedBy =
      typeof HTMLDialogElement !== 'undefined' &&
      'closedBy' in HTMLDialogElement.prototype;

    let cleanupPointerFallback: (() => void) | null = null;
    if (!supportsClosedBy) {
      let pressedOutside = false;
      const isOutside = (e: PointerEvent): boolean => {
        const r = dialog.getBoundingClientRect();
        return (
          e.clientX < r.left ||
          e.clientX > r.right ||
          e.clientY < r.top ||
          e.clientY > r.bottom
        );
      };
      const onPointerDown = (e: PointerEvent) => {
        pressedOutside = isOutside(e);
      };
      const onPointerUp = (e: PointerEvent) => {
        if (pressedOutside && isOutside(e)) {
          void closeTopLayerDialog(dialog);
        }
        pressedOutside = false;
      };
      dialog.addEventListener('pointerdown', onPointerDown);
      dialog.addEventListener('pointerup', onPointerUp);
      cleanupPointerFallback = () => {
        dialog.removeEventListener('pointerdown', onPointerDown);
        dialog.removeEventListener('pointerup', onPointerUp);
      };
    }

    return () => {
      dialog.removeEventListener('close', handleClose);
      dialog.removeEventListener('cancel', handleCancel);
      cleanupPointerFallback?.();
    };
  }, []);

  const requestClose = useCallback(() => {
    const dialog = dialogRef.current;
    if (dialog?.open) {
      void closeTopLayerDialog(dialog);
    } else {
      onClose();
    }
  }, [onClose]);

  const handleSelectWallet = async (wallet?: DetectedWallet) => {
    setConnectError(null);
    setConnectingWalletId(wallet?.id ?? 'default');
    try {
      await onConnectWallet(wallet);
      requestClose();
    } catch (err) {
      setConnectError(
        err instanceof Error
          ? err.message
          : 'Could not connect wallet. Check your wallet extension and try again.',
      );
    } finally {
      setConnectingWalletId(null);
    }
  };

  const handleRescan = () => {
    setRescanning(true);
    setConnectError(null);
    onRescanWallets();
    window.setTimeout(() => setRescanning(false), 450);
  };

  const handleCopyAddress = async () => {
    if (!account) return;
    try {
      await navigator.clipboard.writeText(account);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      // clipboard unavailable
    }
  };

  const handleSwitchNetwork = async () => {
    setConnectError(null);
    try {
      await onSwitchNetwork();
    } catch (err) {
      setConnectError(
        err instanceof Error ? err.message : 'Failed to switch network to Ethereum Sepolia.',
      );
    }
  };

  const handleDisconnect = () => {
    onDisconnect();
    requestClose();
  };

  const undetectedRecommended = useMemo(() => {
    if (detectedWallets.length === 0) return RECOMMENDED_WALLETS;
    const detectedKeys = new Set(
      detectedWallets.flatMap((w) => [w.rdns.toLowerCase(), w.name.toLowerCase()]),
    );
    return RECOMMENDED_WALLETS.filter(
      (rec) =>
        !rec.rdnsHints.some((hint) => detectedKeys.has(hint.toLowerCase())) &&
        !detectedKeys.has(rec.name.toLowerCase()),
    );
  }, [detectedWallets]);

  const isConnecting = connectingWalletId !== null || busyAction === 'connect';
  const isSwitchingNet = busyAction === 'switch-network';
  const showingAccount = Boolean(account && view === 'account');
  const isAlchemyRpc = /alchemy\.com/i.test(config.rpcUrl);
  const maskedPrimaryRpc = maskRpcUrl(config.rpcUrl);
  const explorerAccountUrl = account ? explorerAddressUrl(config, account) : null;
  const ethHuman = human(balances?.eth, 18);
  const baseHuman = human(balances?.base, config.baseDecimals);
  const quoteHuman = human(balances?.quote, config.quoteDecimals);
  const lpSharesHuman = human(balances?.lpShares, 18);
  const lowGas = Boolean(
    account && !wrongNetwork && balances && balances.eth < LOW_GAS_THRESHOLD_WEI,
  );

  const activeConnectingName = useMemo(() => {
    if (!connectingWalletId) return null;
    const found = detectedWallets.find((w) => w.id === connectingWalletId);
    return found?.name ?? 'your wallet';
  }, [connectingWalletId, detectedWallets]);

  return (
    <dialog
      ref={dialogRef}
      closedby="any"
      aria-labelledby="wallet-connect-modal-title"
      data-testid="wallet-connect-dialog"
      className="wallet-dialog"
    >
      {/* Editorial Ledger Header Band */}
      <div className="flex items-start justify-between gap-4 border-b-2 border-ink bg-paper px-5 py-4">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center border border-ink bg-ink text-paper">
            <Wallet className="h-5 w-5" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <div className="eyebrow">
              {showingAccount
                ? 'Active settlement wallet'
                : `${getChainLabel(config.chainId)} · EIP-6963`}
            </div>
            <h1
              id="wallet-connect-modal-title"
              className="mt-1 font-display text-xl font-bold leading-tight text-ink"
            >
              {showingAccount
                ? activeWallet?.name ?? 'Connected wallet'
                : account
                  ? 'Switch wallet'
                  : UI_LABELS.connectWallet}
            </h1>
            <p className="mt-1 text-xs leading-snug text-ink-muted sm:text-sm">
              {showingAccount
                ? 'Inspect balances, verify Sepolia network status, or switch wallets.'
                : 'Choose a browser wallet to sign uniform-price orders, faucet claims, and payouts.'}
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={requestClose}
          autoFocus={showingAccount || detectedWallets.length === 0}
          aria-label="Close wallet dialog"
          data-testid="wallet-modal-close"
          className="tap-target inline-flex w-11 shrink-0 items-center justify-center border border-rule-strong bg-paper-bright text-ink-muted transition hover:border-ink hover:text-ink"
        >
          <X className="h-5 w-5" aria-hidden="true" />
        </button>
      </div>

      {/* Scrollable Modal Body */}
      <div className="flex-1 space-y-4 overflow-y-auto p-5">
        {/* Inline Connecting Banner */}
        {isConnecting && (
          <div
            role="status"
            data-testid="wallet-modal-connecting-banner"
            className="flex items-center gap-3 border-l-2 border-cobalt-600 bg-cobalt-50 px-3.5 py-3 text-sm text-cobalt-800"
          >
            <Loader2 className="h-4 w-4 shrink-0 animate-spin text-cobalt-700" aria-hidden="true" />
            <div className="min-w-0">
              <div className="font-bold text-ink">
                Approve connection in {activeConnectingName ?? 'your wallet'}…
              </div>
              <div className="mt-0.5 text-xs text-ink-soft">
                Unlock your extension and accept the Sepolia network request if prompted.
              </div>
            </div>
          </div>
        )}

        {/* Inline Error Banner */}
        {connectError && (
          <div
            role="alert"
            data-testid="wallet-modal-error"
            className="flex items-start justify-between gap-2.5 border-l-2 border-vermilion-500 bg-vermilion-50 px-3.5 py-3 text-sm text-vermilion-800"
          >
            <div className="flex min-w-0 items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-vermilion-600" aria-hidden="true" />
              <span className="break-words leading-snug">{connectError}</span>
            </div>
            <button
              type="button"
              onClick={() => setConnectError(null)}
              className="shrink-0 border border-current px-2 py-0.5 font-mono text-xs font-bold opacity-80 transition hover:opacity-100"
            >
              Dismiss
            </button>
          </div>
        )}

        {showingAccount && account ? (
          /* ================= CONNECTED ACCOUNT VIEW ================= */
          <div data-testid="wallet-modal-account-view" className="space-y-4">
            {/* Identity & Quick Tools */}
            <div className="border border-ink bg-paper-soft p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3">
                  <WalletBadgeIcon wallet={activeWallet} />
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        data-testid="wallet-modal-address"
                        className="font-mono text-base font-bold text-ink"
                      >
                        {shortenAddress(account)}
                      </span>
                      <span
                        className={`inline-flex items-center gap-1.5 border px-2 py-0.5 font-mono text-[11px] font-bold uppercase ${
                          wrongNetwork
                            ? 'border-vermilion-500/60 bg-vermilion-50 text-vermilion-800'
                            : 'border-pine-600/40 bg-pine-50 text-pine-700'
                        }`}
                      >
                        <span
                          className={`h-1.5 w-1.5 rounded-full ${
                            wrongNetwork ? 'bg-vermilion-500' : 'bg-pine-500'
                          }`}
                        />
                        {wrongNetwork
                          ? `Chain #${walletChainId ?? '?'}`
                          : getChainLabel(config.chainId)}
                      </span>
                    </div>
                    <p className="mt-1 break-all font-mono text-[11px] text-ink-muted">
                      {account}
                    </p>
                  </div>
                </div>

                <div className="flex shrink-0 items-center gap-1.5">
                  <button
                    type="button"
                    data-testid="wallet-modal-copy"
                    onClick={() => void handleCopyAddress()}
                    className="inline-flex min-h-[36px] items-center gap-1.5 border border-rule-strong bg-paper-bright px-2.5 font-mono text-xs font-bold text-ink transition hover:border-ink"
                  >
                    {copied ? (
                      <>
                        <Check className="h-3.5 w-3.5 text-pine-700" aria-hidden="true" />
                        <span className="text-pine-700">Copied</span>
                      </>
                    ) : (
                      <>
                        <Copy className="h-3.5 w-3.5 text-ink-muted" aria-hidden="true" />
                        <span>Copy</span>
                      </>
                    )}
                  </button>
                  {explorerAccountUrl && (
                    <a
                      href={explorerAccountUrl}
                      target="_blank"
                      rel="noreferrer"
                      aria-label="View address on Sepolia Etherscan"
                      className="inline-flex h-9 w-9 items-center justify-center border border-rule-strong bg-paper-bright text-ink-muted transition hover:border-ink hover:text-ink"
                    >
                      <ExternalLink className="h-4 w-4" aria-hidden="true" />
                    </a>
                  )}
                </div>
              </div>

              {wrongNetwork && (
                <div className="mt-3.5 space-y-2.5 border-t border-rule pt-3">
                  <div className="flex items-start gap-2 text-xs leading-snug text-vermilion-800">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-vermilion-600" aria-hidden="true" />
                    <span>
                      Your wallet is on Chain #{walletChainId ?? '?'}. FairBatch settles on{' '}
                      <strong>{getChainLabel(config.chainId)}</strong> (Chain ID {config.chainId}).
                    </span>
                  </div>
                  <button
                    type="button"
                    data-testid="wallet-modal-switch-network"
                    disabled={isSwitchingNet}
                    onClick={() => void handleSwitchNetwork()}
                    className="tap-target inline-flex w-full items-center justify-center gap-2 bg-vermilion-500 px-4 font-display text-sm font-bold text-[#FBF8F0] transition hover:bg-vermilion-600 disabled:opacity-50"
                  >
                    {isSwitchingNet ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                        <span>Switching to Sepolia…</span>
                      </>
                    ) : (
                      <span>{UI_LABELS.switchToSepolia}</span>
                    )}
                  </button>
                </div>
              )}
            </div>

            {/* Balance Ledger Grid */}
            <div>
              <div className="mb-2 flex items-center justify-between">
                <span className="eyebrow">Sepolia wallet balances</span>
                <span className="font-mono text-[11px] text-ink-faint">Live RPC</span>
              </div>
              <div className="grid grid-cols-2 gap-px border border-rule bg-rule">
                <div className="bg-paper-bright px-3.5 py-2.5">
                  <div className="font-mono text-[11px] uppercase tracking-label text-ink-muted">
                    Sepolia ETH
                  </div>
                  <div className="mt-0.5 font-mono text-sm font-bold text-ink tabular-nums">
                    {formatTokenAmount(ethHuman, 'eth')} ETH
                  </div>
                </div>
                <div className="bg-paper-bright px-3.5 py-2.5">
                  <div className="font-mono text-[11px] uppercase tracking-label text-ink-muted">
                    {config.baseSymbol}
                  </div>
                  <div className="mt-0.5 font-mono text-sm font-bold text-ink tabular-nums">
                    {formatTokenAmount(baseHuman, 'base')} {config.baseSymbol}
                  </div>
                </div>
                <div className="bg-paper-bright px-3.5 py-2.5">
                  <div className="font-mono text-[11px] uppercase tracking-label text-ink-muted">
                    {config.quoteSymbol}
                  </div>
                  <div className="mt-0.5 font-mono text-sm font-bold text-ink tabular-nums">
                    {formatTokenAmount(quoteHuman, 'quote')} {config.quoteSymbol}
                  </div>
                </div>
                <div className="bg-paper-bright px-3.5 py-2.5">
                  <div className="font-mono text-[11px] uppercase tracking-label text-ink-muted">
                    LP Shares
                  </div>
                  <div className="mt-0.5 font-mono text-sm font-bold text-plum-700 tabular-nums">
                    {formatTokenAmount(lpSharesHuman, 'shares')} shares
                  </div>
                </div>
              </div>
            </div>

            {lowGas && (
              <div className="flex flex-wrap items-center justify-between gap-2 border-l-2 border-brass-600 bg-brass-50 px-3.5 py-2.5 text-xs text-brass-900">
                <span className="inline-flex items-center gap-1.5 font-medium">
                  <Fuel className="h-3.5 w-3.5 shrink-0 text-brass-700" aria-hidden="true" />
                  <span>Low Sepolia ETH for gas. Claim free testnet ETH:</span>
                </span>
                <div className="flex flex-wrap items-center gap-1.5">
                  {PUBLIC_SEPOLIA_FAUCETS.map((f) => (
                    <a
                      key={f.url}
                      href={f.url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 border border-brass-700 bg-paper-bright px-2 py-0.5 font-mono text-[11px] font-bold text-brass-900 transition hover:bg-brass-100"
                    >
                      <span>{f.name}</span>
                      <ExternalLink className="h-3 w-3" aria-hidden="true" />
                    </a>
                  ))}
                </div>
              </div>
            )}

            {/* Switch Wallet / Disconnect Actions */}
            <div className="grid gap-2.5 sm:grid-cols-2">
              <button
                type="button"
                data-testid="wallet-modal-switch-wallet"
                onClick={() => {
                  setConnectError(null);
                  setView('connect');
                }}
                className="tap-target inline-flex items-center justify-center gap-2 border border-ink bg-ink px-4 font-display text-sm font-bold text-paper transition hover:bg-ink-soft"
              >
                <RefreshCw className="h-4 w-4" aria-hidden="true" />
                <span>Switch wallet</span>
              </button>
              <button
                type="button"
                data-testid="wallet-modal-disconnect"
                onClick={handleDisconnect}
                className="tap-target inline-flex items-center justify-center gap-2 border border-rule-strong bg-paper-bright px-4 font-display text-sm font-bold text-ink-soft transition hover:border-vermilion-600 hover:bg-vermilion-50 hover:text-vermilion-800"
              >
                <LogOut className="h-4 w-4" aria-hidden="true" />
                <span>Disconnect</span>
              </button>
            </div>
          </div>
        ) : (
          /* ================= WALLET PICKER VIEW ================= */
          <div data-testid="wallet-modal-picker-view" className="space-y-4">
            {account && (
              <div className="flex items-center justify-between gap-2 border border-rule bg-paper-soft px-3 py-2 text-xs">
                <span className="font-mono text-ink-muted">
                  Currently connected:{' '}
                  <strong className="text-ink">{shortenAddress(account)}</strong>
                </span>
                <button
                  type="button"
                  onClick={() => setView('account')}
                  className="inline-flex items-center gap-1 font-sans text-xs font-bold text-cobalt-700 underline decoration-dotted underline-offset-2 hover:text-ink"
                >
                  <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>Back to account</span>
                </button>
              </div>
            )}

            {/* Section 1: Detected Browser Wallets (EIP-6963 + Legacy) */}
            <section aria-label="Detected browser wallets" className="space-y-2.5">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="eyebrow">Detected in this browser</span>
                  <span
                    data-testid="wallet-modal-detected-count"
                    className={`border px-1.5 py-0.5 font-mono text-[11px] font-bold ${
                      detectedWallets.length > 0
                        ? 'border-pine-600/40 bg-pine-50 text-pine-700'
                        : 'border-rule bg-paper-soft text-ink-muted'
                    }`}
                  >
                    {detectedWallets.length} ready
                  </span>
                </div>
                <button
                  type="button"
                  data-testid="wallet-modal-rescan"
                  onClick={handleRescan}
                  disabled={isConnecting}
                  className="inline-flex min-h-[32px] items-center gap-1.5 border border-rule-strong bg-paper-soft px-2.5 font-mono text-[11px] font-bold uppercase text-ink-soft transition hover:border-ink hover:text-ink disabled:opacity-40"
                >
                  <RefreshCw
                    className={`h-3 w-3 ${rescanning ? 'animate-spin' : ''}`}
                    aria-hidden="true"
                  />
                  <span>Re-scan</span>
                </button>
              </div>

              {detectedWallets.length > 0 ? (
                <ul
                  data-testid="wallet-modal-detected-list"
                  className="space-y-2"
                >
                  {detectedWallets.map((wallet, index) => {
                    const isThisConnecting = connectingWalletId === wallet.id;
                    const isCurrentActive = Boolean(
                      account &&
                        activeWallet &&
                        (activeWallet.id === wallet.id ||
                          activeWallet.rdns === wallet.rdns),
                    );
                    return (
                      <li key={wallet.id}>
                        <button
                          type="button"
                          autoFocus={index === 0}
                          disabled={isConnecting}
                          data-testid={`wallet-option-${wallet.rdns}`}
                          onClick={() => void handleSelectWallet(wallet)}
                          className={`tap-target group flex w-full items-center justify-between gap-3 border px-3.5 py-3 text-left transition disabled:cursor-not-allowed disabled:opacity-60 ${
                            isCurrentActive
                              ? 'border-pine-600 bg-pine-50/60 hover:bg-pine-50'
                              : 'border-rule-strong bg-paper-bright hover:border-ink hover:bg-paper-soft'
                          }`}
                        >
                          <div className="flex min-w-0 items-center gap-3">
                            <WalletBadgeIcon wallet={wallet} />
                            <div className="min-w-0">
                              <div className="truncate font-display text-sm font-bold text-ink">
                                {wallet.name}
                              </div>
                              <div className="mt-0.5 flex items-center gap-1.5 font-mono text-[11px] text-ink-muted">
                                <span>
                                  {wallet.source === 'eip6963'
                                    ? 'EIP-6963 verified'
                                    : 'Browser injected'}
                                </span>
                                {wallet.source === 'eip6963' && (
                                  <span className="truncate text-ink-faint">· {wallet.rdns}</span>
                                )}
                              </div>
                            </div>
                          </div>

                          <div className="flex shrink-0 items-center gap-2">
                            {isThisConnecting ? (
                              <span className="inline-flex items-center gap-1.5 border border-cobalt-600/50 bg-cobalt-50 px-2 py-0.5 font-mono text-[11px] font-bold uppercase text-cobalt-700">
                                <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                                <span>Connecting</span>
                              </span>
                            ) : isCurrentActive ? (
                              <span className="inline-flex items-center gap-1 border border-pine-600/40 bg-pine-50 px-2 py-0.5 font-mono text-[11px] font-bold uppercase text-pine-700">
                                <span className="h-1.5 w-1.5 rounded-full bg-pine-500" />
                                <span>Active</span>
                              </span>
                            ) : (
                              <span className="border border-pine-600/40 bg-pine-50 px-2 py-0.5 font-mono text-[11px] font-bold uppercase text-pine-700">
                                Detected
                              </span>
                            )}
                            <ArrowRight
                              className="h-4 w-4 text-ink-muted transition group-hover:translate-x-0.5 group-hover:text-ink"
                              aria-hidden="true"
                            />
                          </div>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <div
                  data-testid="wallet-modal-empty-state"
                  className="border-l-2 border-brass-600 bg-brass-50 px-4 py-3.5 text-sm text-brass-900"
                >
                  <div className="font-display text-sm font-bold text-ink">
                    No browser wallet extension detected yet
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-ink-soft">
                    Install one of the Ethereum wallets below, then refresh or click{' '}
                    <strong>Re-scan</strong>. On mobile, open FairBatch inside your wallet&apos;s
                    built-in browser.
                  </p>
                </div>
              )}
            </section>

            {/* Section 2: Install / Popular Ethereum Wallets */}
            {undetectedRecommended.length > 0 && (
              <section
                aria-label="Install an Ethereum wallet"
                data-testid="wallet-modal-install-grid"
                className="space-y-2"
              >
                <div className="flex items-center justify-between">
                  <span className="eyebrow">
                    {detectedWallets.length === 0 ? 'Install a wallet' : 'More compatible wallets'}
                  </span>
                  <span className="font-mono text-[11px] text-ink-faint">Opens official site</span>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  {undetectedRecommended.map((rec) => (
                    <a
                      key={rec.id}
                      href={rec.url}
                      target="_blank"
                      rel="noreferrer"
                      className="group flex items-center justify-between gap-2.5 border border-rule bg-paper-soft px-3 py-2.5 transition hover:border-ink hover:bg-paper-bright"
                    >
                      <div className="flex min-w-0 items-center gap-2.5">
                        <span
                          className={`flex h-8 w-8 shrink-0 items-center justify-center border font-mono text-xs font-bold ${rec.accentClass}`}
                          aria-hidden="true"
                        >
                          {rec.monogram}
                        </span>
                        <div className="min-w-0">
                          <div className="truncate font-display text-sm font-bold text-ink">
                            {rec.name}
                          </div>
                          <div className="truncate text-[11px] text-ink-muted">
                            {rec.tagline}
                          </div>
                        </div>
                      </div>
                      <ExternalLink
                        className="h-3.5 w-3.5 shrink-0 text-ink-muted transition group-hover:text-ink"
                        aria-hidden="true"
                      />
                    </a>
                  ))}
                </div>
              </section>
            )}
          </div>
        )}

        {/* Network, Alchemy RPC & Non-Custodial Footer Strip */}
        <section
          aria-label="Network and security details"
          data-testid="wallet-modal-network-strip"
          className="space-y-2.5 border border-rule bg-paper-soft px-3.5 py-3 text-xs"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 font-mono font-bold text-ink">
              <span className="h-2 w-2 rounded-full bg-pine-500" />
              <span>
                {getChainLabel(config.chainId)} · Chain ID {config.chainId}
              </span>
            </div>
            {isAlchemyRpc && (
              <span className="inline-flex items-center gap-1 border border-cobalt-600/40 bg-cobalt-50 px-2 py-0.5 font-mono text-[10px] font-bold uppercase text-cobalt-700">
                <Sparkles className="h-3 w-3" aria-hidden="true" />
                <span>Alchemy RPC</span>
              </span>
            )}
          </div>

          <div className="break-all font-mono text-[11px] text-ink-muted">
            RPC: {maskedPrimaryRpc}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-rule pt-2 text-[11px] text-ink-muted">
            <span className="inline-flex items-center gap-1.5">
              <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-pine-700" aria-hidden="true" />
              <span>Non-custodial · keys never leave your wallet</span>
            </span>
            <div className="flex flex-wrap items-center gap-2">
              {PUBLIC_SEPOLIA_FAUCETS.map((faucet) => (
                <a
                  key={faucet.url}
                  href={faucet.url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 font-mono text-[11px] font-bold text-cobalt-700 underline decoration-dotted underline-offset-2 hover:text-ink"
                >
                  <span>{faucet.name}</span>
                  <ExternalLink className="h-2.5 w-2.5" aria-hidden="true" />
                </a>
              ))}
            </div>
          </div>
        </section>
      </div>
    </dialog>
  );
};
