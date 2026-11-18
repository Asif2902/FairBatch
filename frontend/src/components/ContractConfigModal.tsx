import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  FileCode2,
  Globe,
  Link2,
  Wallet,
  X,
} from 'lucide-react';
import type {
  ContractConfigUpdatePayload,
  HealthResponse,
} from '../types';
import { shortenAddress } from '../lib/format';

interface EthereumProvider {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
}

declare global {
  interface Window {
    ethereum?: EthereumProvider;
  }
}

interface ContractConfigModalProps {
  isOpen: boolean;
  health: HealthResponse;
  browserWalletAddress: string | null;
  onClose: () => void;
  onSaveConfig: (payload: ContractConfigUpdatePayload) => Promise<void>;
  onConnectBrowserWallet: (address: string) => void;
}

const NETWORK_PRESETS = [
  {
    label: 'Ethereum Sepolia (Live Deployed)',
    chainId: 11155111,
    rpcUrl: 'https://ethereum-sepolia-rpc.publicnode.com',
    fairBatch: '0x60122518eccbeeb247cd42b0201f244432c7600d',
    baseToken: '0xe72678fb21267fbb5c02c59496f04a86a7d8d56b',
    quoteToken: '0x0384fb6158fb2e5ea021af6f8fa3e81daeb075f0',
  },
  {
    label: 'Ethereum Hoodi (Cancun/Prague)',
    chainId: 560048,
    rpcUrl: 'https://rpc.hoodi.ethpandaops.io',
    fairBatch: '0x0000000000000000000000000000000000000000',
    baseToken: '0x0000000000000000000000000000000000000000',
    quoteToken: '0x0000000000000000000000000000000000000000',
  },
  {
    label: 'Local Anvil EVM (31337)',
    chainId: 31337,
    rpcUrl: 'http://127.0.0.1:8545',
    fairBatch: '0x0000000000000000000000000000000000000000',
    baseToken: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
    quoteToken: '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512',
  },
  {
    label: 'Ethereum Mainnet (1)',
    chainId: 1,
    rpcUrl: 'https://ethereum-rpc.publicnode.com',
    fairBatch: '0x0000000000000000000000000000000000000000',
    baseToken: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    quoteToken: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  },
];

export const ContractConfigModal: React.FC<ContractConfigModalProps> = ({
  isOpen,
  health,
  browserWalletAddress,
  onClose,
  onSaveConfig,
  onConnectBrowserWallet,
}) => {
  const [rpcUrl, setRpcUrl] = useState<string>(health.rpc_url ?? '');
  const [chainId, setChainId] = useState<string>(String(health.chain_id || 11155111));
  const [fairBatchAddr, setFairBatchAddr] = useState<string>(
    health.contracts.fair_batch,
  );
  const [baseTokenAddr, setBaseTokenAddr] = useState<string>(
    health.contracts.base_token,
  );
  const [quoteTokenAddr, setQuoteTokenAddr] = useState<string>(
    health.contracts.quote_token,
  );
  const [saving, setSaving] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [walletErr, setWalletErr] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setRpcUrl(health.rpc_url ?? '');
      setChainId(String(health.chain_id || 11155111));
      setFairBatchAddr(health.contracts.fair_batch);
      setBaseTokenAddr(health.contracts.base_token);
      setQuoteTokenAddr(health.contracts.quote_token);
      setStatusMsg(null);
      setWalletErr(null);
    }
  }, [isOpen, health]);

  if (!isOpen) return null;

  const handleConnectWallet = async () => {
    setWalletErr(null);
    if (!window.ethereum) {
      setWalletErr(
        'No EIP-1193 wallet extension detected. Use the 5 pre-funded secp256k1 Demo Wallets in the top bar!',
      );
      return;
    }
    try {
      const accounts = (await window.ethereum.request({
        method: 'eth_requestAccounts',
      })) as string[];
      if (Array.isArray(accounts) && accounts[0]) {
        onConnectBrowserWallet(accounts[0]);
        setStatusMsg(`Connected EIP-1193 wallet ${shortenAddress(accounts[0])}`);
      }
    } catch (err) {
      setWalletErr(
        err instanceof Error ? err.message : 'Failed to connect browser wallet',
      );
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setStatusMsg(null);
    try {
      await onSaveConfig({
        rpc_url: rpcUrl.trim(),
        chain_id: Number.parseInt(chainId, 10) || 11155111,
        fair_batch: fairBatchAddr.trim(),
        base_token: baseTokenAddr.trim(),
        quote_token: quoteTokenAddr.trim(),
      });
      setStatusMsg('Runtime contract & RPC bridge configuration updated.');
    } catch (err) {
      setWalletErr(err instanceof Error ? err.message : 'Failed to update config');
    } finally {
      setSaving(false);
    }
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
                Plug in deployed Sepolia, Hoodi, Anvil, or Mainnet addresses at runtime.
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
          {/* Build artifacts & injected wallet */}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="border border-rule bg-paper-soft p-3">
              <div className="flex items-center gap-1.5 font-mono text-[9px] font-bold uppercase tracking-label text-ink-soft">
                <FileCode2 className="h-3.5 w-3.5 text-pine-700" />
                <span>Fe 26.5.0 artifacts (out/)</span>
              </div>
              <p className="mt-1 font-mono text-[10px] text-ink-muted">
                {health.fe_artifacts_present
                  ? `Detected (${health.fe_artifacts.length || 2} artifacts)`
                  : 'Pending `fe build` output'}
              </p>
              {health.fe_artifacts.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {health.fe_artifacts.slice(0, 4).map((art) => (
                    <span
                      key={art}
                      className="border border-pine-600/30 bg-pine-50 px-1.5 py-0.5 font-mono text-[9px] text-pine-700"
                    >
                      {art}
                    </span>
                  ))}
                </div>
              )}
            </div>

            <div className="border border-rule bg-paper-soft p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 font-mono text-[9px] font-bold uppercase tracking-label text-ink-soft">
                  <Wallet className="h-3.5 w-3.5 text-cobalt-700" />
                  <span>EIP-1193 browser wallet</span>
                </span>
                {browserWalletAddress && (
                  <span className="border border-pine-600/30 bg-pine-50 px-1.5 py-0.5 font-mono text-[9px] text-pine-700">
                    {shortenAddress(browserWalletAddress)}
                  </span>
                )}
              </div>
              <p className="mt-1 text-[10px] leading-snug text-ink-muted">
                Sign real `eth_signTypedData_v4` intents via MetaMask/Rabby, or use demo wallets.
              </p>
              <button
                type="button"
                onClick={handleConnectWallet}
                className="mt-2 inline-flex items-center gap-1.5 border border-cobalt-600/40 bg-cobalt-50 px-2.5 py-1 font-mono text-[9px] font-bold uppercase tracking-[0.06em] text-cobalt-700 transition hover:bg-cobalt-100"
              >
                <Link2 className="h-3 w-3" />
                <span>
                  {browserWalletAddress ? 'Reconnect Wallet' : 'Connect Injected Wallet'}
                </span>
              </button>
            </div>
          </div>

          {/* Cancun / EIP-1153 notice */}
          <div className="flex items-start gap-2.5 border-l-2 border-brass-500 bg-brass-50 px-3 py-2.5 text-[10.5px] leading-relaxed text-brass-900">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brass-700" />
            <div>
              <span className="font-bold">EVM Cancun opcode compatibility:</span>{' '}
              FairBatch uses Fe 26.5 <code>std::evm::mutex::Mutex</code> (`TLOAD`/`TSTORE`,
              EIP-1153) and `PUSH0` (EIP-3855).{' '}
              <strong>Mainnet, Sepolia, Hoodi, and Anvil</strong> support Cancun natively;
              deprecated Goerli/Holesky testnets are sunset.
            </div>
          </div>

          {/* Network templates */}
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
                  }}
                  className="bg-paper-bright px-2.5 py-2 text-left transition hover:bg-paper-soft"
                >
                  <div className="font-display text-[11px] font-bold text-ink">
                    {preset.label.split(' (')[0]}
                  </div>
                  <div className="mt-0.5 font-mono text-[9px] text-ink-muted">
                    Chain ID: {preset.chainId}
                  </div>
                </button>
              ))}
            </div>
          </div>

          <form onSubmit={handleSubmit} className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="sm:col-span-2">
                <label
                  htmlFor="cfg-rpc-url"
                  className="mb-1 block font-mono text-[9px] font-bold uppercase tracking-label text-ink-muted"
                >
                  JSON-RPC endpoint (`RPC_URL`)
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
                  Chain ID (`CHAIN_ID`)
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
                FairBatch Contract Address (`FAIRBATCH_ADDRESS`)
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
                  Base token WETH (18 decimals)
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
                  Quote token USDC (6 decimals)
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

            {walletErr && (
              <div className="border-l-2 border-vermilion-500 bg-vermilion-50 px-3 py-2 text-[10.5px] text-vermilion-800">
                {walletErr}
              </div>
            )}

            <div className="flex items-center justify-end gap-2 border-t border-rule pt-3">
              <button
                type="button"
                onClick={onClose}
                className="border border-rule-strong px-3 py-1.5 font-mono text-[9px] font-bold uppercase tracking-[0.06em] text-ink-muted transition hover:border-ink hover:text-ink"
              >
                Close
              </button>
              <button
                type="submit"
                disabled={saving}
                className="border border-pine-700 bg-pine-600 px-3.5 py-1.5 font-mono text-[9px] font-bold uppercase tracking-[0.06em] text-paper transition hover:bg-pine-700 disabled:opacity-50"
              >
                {saving ? 'Applying…' : 'Save Contract Config'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
};
