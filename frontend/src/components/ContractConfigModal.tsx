import React, { useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  Globe,
  Link2,
  LogOut,
  RefreshCw,
  Wallet,
  X,
} from 'lucide-react';
import type { RuntimeConfig } from '../onchain/config';
import { explorerAddressUrl } from '../onchain/config';
import { getChainLabel, shortenAddress } from '../lib/format';

interface ContractConfigModalProps {
  isOpen: boolean;
  config: RuntimeConfig;
  account: string | null;
  walletChainId: number | null;
  wrongNetwork: boolean;
  busyAction: string | null;
  onClose: () => void;
  onConnect: () => Promise<void>;
  onDisconnect: () => void;
}

export const ContractConfigModal: React.FC<ContractConfigModalProps> = ({
  isOpen,
  config,
  account,
  walletChainId,
  wrongNetwork,
  busyAction,
  onClose,
  onConnect,
  onDisconnect,
}) => {
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [walletError, setWalletError] = useState<string | null>(null);

  if (!isOpen) return null;

  const busy = busyAction !== null;

  const handleConnect = async () => {
    setWalletError(null);
    setStatusMsg(null);
    try {
      await onConnect();
      setStatusMsg('Wallet authorised for Ethereum Sepolia transactions.');
    } catch (err) {
      setWalletError(err instanceof Error ? err.message : 'Failed to connect wallet');
    }
  };

  const contractRows: Array<{ label: string; detail: string; address: string }> = [
    {
      label: 'FairBatch Exchange',
      detail: 'Uniform batch clearing + optional LP locking',
      address: config.fairBatch,
    },
    {
      label: 'Sepolia Faucet',
      detail: '1 fWETH + 100 fUSDC per wallet every 12h',
      address: config.faucet,
    },
    {
      label: `Base Token · ${config.baseSymbol}`,
      detail: `${config.baseDecimals} decimals`,
      address: config.baseToken,
    },
    {
      label: `Quote Token · ${config.quoteSymbol}`,
      detail: `${config.quoteDecimals} decimals`,
      address: config.quoteToken,
    },
  ];

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="contract-config-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/65 p-4 backdrop-blur-sm"
    >
      <div className="max-h-[90vh] w-full max-w-3xl overflow-y-auto border border-ink bg-paper-bright shadow-2xl">
        <div className="flex items-start justify-between gap-4 border-b-2 border-ink bg-paper px-5 py-4">
          <div className="flex items-start gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center border border-ink bg-ink text-paper">
              <Globe className="h-4 w-4" aria-hidden="true" />
            </div>
            <div>
              <div className="eyebrow">Global Sepolia configuration</div>
              <h2
                id="contract-config-modal-title"
                className="mt-1 font-display text-xl font-bold leading-tight tracking-tight text-ink"
              >
                Contract &amp; network readiness
              </h2>
              <p className="mt-0.5 text-[11px] text-ink-muted">
                Loaded directly from the shared repository config{' '}
                <code className="font-mono text-ink-soft">config/deployment.json</code> (Ethereum
                Sepolia only).
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close Contract Configuration Modal"
            className="border border-rule-strong p-1.5 text-ink-muted transition hover:border-ink hover:text-ink"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 p-5">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="border border-rule bg-paper-soft p-3">
              <div className="flex items-center gap-1.5 font-mono text-[9px] font-bold uppercase tracking-label text-ink-soft">
                <Link2 className="h-3.5 w-3.5 text-cobalt-700" />
                <span>Target network</span>
              </div>
              <p className="mt-1 font-mono text-[11px] font-bold text-ink">
                {getChainLabel(config.chainId)} · Chain ID {config.chainId}
              </p>
              <p className="mt-0.5 break-all font-mono text-[9.5px] text-ink-muted">
                RPC: {config.rpcUrl}
              </p>
              <p className="mt-0.5 font-mono text-[9.5px] text-ink-faint">
                Deployer: {shortenAddress(config.deployer)} · Block #{config.deploymentBlock.toString()}
              </p>
            </div>

            <div className="border border-rule bg-paper-soft p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 font-mono text-[9px] font-bold uppercase tracking-label text-ink-soft">
                  <Wallet className="h-3.5 w-3.5 text-cobalt-700" />
                  <span>Injected wallet</span>
                </span>
                {account && (
                  <span className="border border-pine-600/30 bg-pine-50 px-1.5 py-0.5 font-mono text-[9px] text-pine-700">
                    {shortenAddress(account)}
                  </span>
                )}
              </div>
              <p className="mt-1 text-[10px] leading-snug text-ink-muted">
                {account
                  ? wrongNetwork
                    ? `Wallet is on chain ${walletChainId ?? '?'}; FairBatch requires Ethereum Sepolia (${config.chainId}). Reconnect to switch.`
                    : 'Signing orders, commitments, LP locks, faucet claims and settlements on Sepolia.'
                  : 'Connect MetaMask, Rabby, or another EIP-1193 wallet on Ethereum Sepolia.'}
              </p>
              {account ? (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <button
                    type="button"
                    onClick={() => void handleConnect()}
                    disabled={busy}
                    className="inline-flex items-center gap-1.5 border border-cobalt-600/40 bg-cobalt-50 px-2.5 py-1 font-mono text-[9px] font-bold uppercase tracking-[0.06em] text-cobalt-700 transition hover:bg-cobalt-100 disabled:opacity-40"
                  >
                    <RefreshCw className="h-3 w-3" />
                    <span>Switch / reconnect</span>
                  </button>
                  <button
                    type="button"
                    onClick={onDisconnect}
                    className="inline-flex items-center gap-1.5 border border-rule-strong px-2.5 py-1 font-mono text-[9px] font-bold uppercase tracking-[0.06em] text-ink-muted transition hover:border-ink hover:text-ink"
                  >
                    <LogOut className="h-3 w-3" />
                    <span>Disconnect</span>
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => void handleConnect()}
                  disabled={busy}
                  className="mt-2 inline-flex items-center gap-1.5 border border-cobalt-600/40 bg-cobalt-50 px-2.5 py-1 font-mono text-[9px] font-bold uppercase tracking-[0.06em] text-cobalt-700 transition hover:bg-cobalt-100 disabled:opacity-40"
                >
                  <Link2 className="h-3 w-3" />
                  <span>Connect injected wallet</span>
                </button>
              )}
            </div>
          </div>

          <div className="flex items-start gap-2.5 border-l-2 border-brass-500 bg-brass-50 px-3 py-2.5 text-[10.5px] leading-relaxed text-brass-900">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brass-700" />
            <div>
              <span className="font-bold">EVM Cancun opcode compatibility:</span>{' '}
              FairBatch and Faucet use Fe 26.5 <code>std::evm::mutex::Mutex</code> (
              <code>TLOAD</code>/<code>TSTORE</code>, EIP-1153) and <code>PUSH0</code> (EIP-3855) on
              Ethereum Sepolia.
            </div>
          </div>

          <div>
            <span className="eyebrow mb-2 block">Deployed Sepolia Contracts</span>
            <div className="divide-y divide-rule border border-rule bg-paper">
              {contractRows.map((row) => {
                const url = explorerAddressUrl(config, row.address);
                return (
                  <div
                    key={row.label}
                    className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5"
                  >
                    <div>
                      <div className="font-display text-[12px] font-bold text-ink">
                        {row.label}
                      </div>
                      <div className="font-mono text-[9px] text-ink-muted">{row.detail}</div>
                    </div>
                    <div className="flex items-center gap-2">
                      <code className="break-all font-mono text-[10px] text-ink-soft">
                        {row.address}
                      </code>
                      {url && (
                        <a
                          href={url}
                          target="_blank"
                          rel="noreferrer"
                          aria-label={`View ${row.label} on Etherscan`}
                          className="border border-rule-strong p-1 text-ink-muted transition hover:border-ink hover:text-ink"
                        >
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {statusMsg && (
            <div className="flex items-center gap-2 border-l-2 border-pine-600 bg-pine-50 px-3 py-2 text-[10.5px] text-pine-800">
              <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
              <span>{statusMsg}</span>
            </div>
          )}

          {walletError && (
            <div className="border-l-2 border-vermilion-500 bg-vermilion-50 px-3 py-2 text-[10.5px] text-vermilion-800">
              {walletError}
            </div>
          )}

          <div className="flex justify-end border-t border-rule pt-3">
            <button
              type="button"
              onClick={onClose}
              className="border border-ink bg-ink px-3.5 py-1.5 font-mono text-[9px] font-bold uppercase tracking-[0.06em] text-paper transition hover:bg-ink-soft"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
