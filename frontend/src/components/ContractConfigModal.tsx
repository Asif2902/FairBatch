import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Globe,
  Link2,
  LogOut,
  RefreshCw,
  Wallet,
  X,
} from 'lucide-react';
import { getAddress, isAddress, zeroAddress } from 'viem';
import type { RuntimeConfig } from '../onchain/config';
import { getChainLabel, shortenAddress } from '../lib/format';

interface ContractConfigModalProps {
  isOpen: boolean;
  config: RuntimeConfig;
  account: string | null;
  walletChainId: number | null;
  wrongNetwork: boolean;
  busyAction: string | null;
  onClose: () => void;
  onSaveConfig: (partial: Partial<RuntimeConfig>) => void;
  onResetConfig: () => void;
  onConnect: () => Promise<void>;
  onDisconnect: () => void;
}

const NETWORK_PRESETS: Array<{
  label: string;
  hint: string;
  chainId: number;
  rpcUrl: string;
  explorerUrl: string;
  fairBatch: string;
  baseToken: string;
  quoteToken: string;
}> = [
  {
    label: 'Ethereum Sepolia',
    hint: 'Live deployment',
    chainId: 11155111,
    rpcUrl: 'https://ethereum-sepolia-rpc.publicnode.com',
    explorerUrl: 'https://sepolia.etherscan.io',
    fairBatch: '0x60122518eccbeeb247cd42b0201f244432c7600d',
    baseToken: '0xe72678fb21267fbb5c02c59496f04a86a7d8d56b',
    quoteToken: '0x0384fb6158fb2e5ea021af6f8fa3e81daeb075f0',
  },
  {
    label: 'Local Anvil',
    hint: 'Developer chain',
    chainId: 31337,
    rpcUrl: 'http://127.0.0.1:8545',
    explorerUrl: '',
    fairBatch: '0x0000000000000000000000000000000000000000',
    baseToken: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
    quoteToken: '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512',
  },
];

function validAddress(value: string): boolean {
  return isAddress(value.trim()) && getAddress(value.trim()) !== zeroAddress;
}

export const ContractConfigModal: React.FC<ContractConfigModalProps> = ({
  isOpen,
  config,
  account,
  walletChainId,
  wrongNetwork,
  busyAction,
  onClose,
  onSaveConfig,
  onResetConfig,
  onConnect,
  onDisconnect,
}) => {
  const [rpcUrl, setRpcUrl] = useState<string>(config.rpcUrl);
  const [chainId, setChainId] = useState<string>(String(config.chainId));
  const [fairBatchAddr, setFairBatchAddr] = useState<string>(config.fairBatch);
  const [baseTokenAddr, setBaseTokenAddr] = useState<string>(config.baseToken);
  const [quoteTokenAddr, setQuoteTokenAddr] = useState<string>(config.quoteToken);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setRpcUrl(config.rpcUrl);
    setChainId(String(config.chainId));
    setFairBatchAddr(config.fairBatch);
    setBaseTokenAddr(config.baseToken);
    setQuoteTokenAddr(config.quoteToken);
    setStatusMsg(null);
    setFormError(null);
  }, [isOpen, config]);

  if (!isOpen) return null;

  const busy = busyAction !== null;

  const handleConnect = async () => {
    setFormError(null);
    try {
      await onConnect();
      setStatusMsg('Wallet authorised for on-chain transactions.');
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to connect wallet');
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setStatusMsg(null);
    const parsedChainId = Number.parseInt(chainId, 10);
    if (!Number.isFinite(parsedChainId) || parsedChainId <= 0) {
      setFormError('Chain ID must be a positive integer.');
      return;
    }
    if (!/^https?:\/\//i.test(rpcUrl.trim())) {
      setFormError('JSON-RPC endpoint must be an http(s) URL.');
      return;
    }
    if (!validAddress(fairBatchAddr)) {
      setFormError('Enter the deployed FairBatch contract address (not the zero address).');
      return;
    }
    if (!validAddress(baseTokenAddr) || !validAddress(quoteTokenAddr)) {
      setFormError('Enter valid base and quote token contract addresses.');
      return;
    }
    onSaveConfig({
      chainId: parsedChainId,
      rpcUrl: rpcUrl.trim(),
      explorerUrl: NETWORK_PRESETS.find((p) => p.chainId === parsedChainId)?.explorerUrl ??
        (parsedChainId === 11155111 ? 'https://sepolia.etherscan.io' : ''),
      fairBatch: getAddress(fairBatchAddr.trim()),
      baseToken: getAddress(baseTokenAddr.trim()),
      quoteToken: getAddress(quoteTokenAddr.trim()),
    });
    onClose();
  };

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
              <div className="eyebrow">Runtime configuration</div>
              <h2
                id="contract-config-modal-title"
                className="mt-1 font-display text-xl font-bold leading-tight tracking-tight text-ink"
              >
                Contract &amp; network readiness
              </h2>
              <p className="mt-0.5 text-[11px] text-ink-muted">
                Point this terminal at any EVM deployment of FairBatch. Values are
                stored locally in this browser.
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
                <span>Live deployment</span>
              </div>
              <p className="mt-1 font-mono text-[10px] text-ink-muted">
                {getChainLabel(config.chainId)}
              </p>
              <p className="mt-0.5 break-all font-mono text-[10px] text-ink-soft">
                {config.fairBatch}
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
                    ? `Wallet is on chain ${walletChainId ?? '?'}; FairBatch expects ${config.chainId}. Reconnect to switch.`
                    : 'Signing orders, commitments, settlements and claims with this wallet.'
                  : 'Connect MetaMask, Rabby, or another EIP-1193 wallet to submit transactions.'}
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
              FairBatch uses Fe 26.5 <code>std::evm::mutex::Mutex</code> (`TLOAD`/`TSTORE`,
              EIP-1153) and `PUSH0` (EIP-3855). The target chain must support Cancun.
            </div>
          </div>

          <div>
            <span className="eyebrow mb-1.5 block">Quick network templates</span>
            <div className="grid grid-cols-2 gap-px border border-rule bg-rule sm:grid-cols-4">
              {NETWORK_PRESETS.map((preset) => (
                <button
                  key={preset.chainId}
                  type="button"
                  onClick={() => {
                    setChainId(String(preset.chainId));
                    setRpcUrl(preset.rpcUrl);
                    setFairBatchAddr(preset.fairBatch);
                    setBaseTokenAddr(preset.baseToken);
                    setQuoteTokenAddr(preset.quoteToken);
                    setFormError(null);
                  }}
                  className="bg-paper-bright px-2.5 py-2 text-left transition hover:bg-paper-soft"
                >
                  <div className="font-display text-[11px] font-bold text-ink">
                    {preset.label}
                  </div>
                  <div className="mt-0.5 font-mono text-[9px] text-ink-muted">
                    {preset.hint} · chain {preset.chainId}
                  </div>
                </button>
              ))}
              <div className="flex items-center bg-paper-bright px-2.5 py-2 font-mono text-[9px] leading-snug text-ink-faint">
                Or edit the fields below for a custom deployment.
              </div>
            </div>
          </div>

          <form onSubmit={handleSubmit} className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="sm:col-span-2">
                <label
                  htmlFor="cfg-rpc-url"
                  className="mb-1 block font-mono text-[9px] font-bold uppercase tracking-label text-ink-muted"
                >
                  JSON-RPC endpoint
                </label>
                <input
                  id="cfg-rpc-url"
                  type="text"
                  value={rpcUrl}
                  onChange={(e) => setRpcUrl(e.target.value)}
                  placeholder="https://ethereum-sepolia-rpc.publicnode.com"
                  className="w-full border border-rule-strong bg-paper px-2.5 py-2 font-mono text-[11px] text-ink transition focus:border-cobalt-600 focus:outline-none"
                />
              </div>
              <div>
                <label
                  htmlFor="cfg-chain-id"
                  className="mb-1 block font-mono text-[9px] font-bold uppercase tracking-label text-ink-muted"
                >
                  Chain ID
                </label>
                <input
                  id="cfg-chain-id"
                  type="number"
                  value={chainId}
                  onChange={(e) => setChainId(e.target.value)}
                  className="w-full border border-rule-strong bg-paper px-2.5 py-2 font-mono text-[11px] text-ink transition focus:border-cobalt-600 focus:outline-none"
                />
              </div>
            </div>

            <div>
              <label
                htmlFor="cfg-fairbatch-addr"
                className="mb-1 block font-mono text-[9px] font-bold uppercase tracking-label text-ink-muted"
              >
                FairBatch contract address
              </label>
              <input
                id="cfg-fairbatch-addr"
                type="text"
                value={fairBatchAddr}
                onChange={(e) => setFairBatchAddr(e.target.value)}
                placeholder="0x0000000000000000000000000000000000000000"
                className="w-full border border-rule-strong bg-paper px-2.5 py-2 font-mono text-[11px] text-ink transition focus:border-cobalt-600 focus:outline-none"
              />
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label
                  htmlFor="cfg-base-addr"
                  className="mb-1 block font-mono text-[9px] font-bold uppercase tracking-label text-ink-muted"
                >
                  Base token · {config.baseSymbol} ({config.baseDecimals} decimals)
                </label>
                <input
                  id="cfg-base-addr"
                  type="text"
                  value={baseTokenAddr}
                  onChange={(e) => setBaseTokenAddr(e.target.value)}
                  className="w-full border border-rule-strong bg-paper px-2.5 py-2 font-mono text-[11px] text-ink transition focus:border-cobalt-600 focus:outline-none"
                />
              </div>
              <div>
                <label
                  htmlFor="cfg-quote-addr"
                  className="mb-1 block font-mono text-[9px] font-bold uppercase tracking-label text-ink-muted"
                >
                  Quote token · {config.quoteSymbol} ({config.quoteDecimals} decimals)
                </label>
                <input
                  id="cfg-quote-addr"
                  type="text"
                  value={quoteTokenAddr}
                  onChange={(e) => setQuoteTokenAddr(e.target.value)}
                  className="w-full border border-rule-strong bg-paper px-2.5 py-2 font-mono text-[11px] text-ink transition focus:border-cobalt-600 focus:outline-none"
                />
              </div>
            </div>

            {statusMsg && (
              <div className="flex items-center gap-2 border-l-2 border-pine-600 bg-pine-50 px-3 py-2 text-[10.5px] text-pine-800">
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                <span>{statusMsg}</span>
              </div>
            )}

            {formError && (
              <div className="border-l-2 border-vermilion-500 bg-vermilion-50 px-3 py-2 text-[10.5px] text-vermilion-800">
                {formError}
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-rule pt-3">
              <button
                type="button"
                onClick={() => {
                  onResetConfig();
                  onClose();
                }}
                className="inline-flex items-center gap-1.5 border border-rule-strong px-2.5 py-1.5 font-mono text-[9px] font-bold uppercase tracking-[0.06em] text-ink-muted transition hover:border-ink hover:text-ink"
              >
                <RefreshCw className="h-3 w-3" />
                <span>Reset to Sepolia defaults</span>
              </button>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="border border-rule-strong px-3 py-1.5 font-mono text-[9px] font-bold uppercase tracking-[0.06em] text-ink-muted transition hover:border-ink hover:text-ink"
                >
                  Close
                </button>
                <button
                  type="submit"
                  disabled={busy}
                  className="border border-pine-700 bg-pine-600 px-3.5 py-1.5 font-mono text-[9px] font-bold uppercase tracking-[0.06em] text-paper transition hover:bg-pine-700 disabled:opacity-50"
                >
                  Save contract config
                </button>
              </div>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
};
