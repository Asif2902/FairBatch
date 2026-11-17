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
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm"
    >
      <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-slate-700/80 bg-[#0D1321] shadow-2xl">
        <div className="flex items-center justify-between border-b border-slate-800 px-6 py-4">
          <div className="flex items-center gap-2.5">
            <Globe className="h-5 w-5 text-cyan-400" aria-hidden="true" />
            <div>
              <h2
                id="contract-config-modal-title"
                className="text-base font-bold text-white"
              >
                Contract &amp; Network Readiness Configuration
              </h2>
              <p className="text-xs text-slate-400">
                Plug in deployed Sepolia, Hoodi, Anvil, or Mainnet contract addresses at runtime
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close Contract Configuration Modal"
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-5 p-6">
          {/* Fe 26.5 Artifacts & Wallet Bar */}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-xl border border-slate-800 bg-[#111827] p-3.5">
              <div className="flex items-center gap-2 text-xs font-semibold text-slate-200">
                <FileCode2 className="h-4 w-4 text-emerald-400" />
                <span>Compiled Fe 26.5.0 Artifacts (`out/`)</span>
              </div>
              <p className="mt-1 font-mono text-[11px] text-slate-400">
                {health.fe_artifacts_present
                  ? `Detected (${health.fe_artifacts.length || 2} artifacts)`
                  : 'Pending `fe build` output'}
              </p>
              {health.fe_artifacts.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {health.fe_artifacts.slice(0, 4).map((art) => (
                    <span
                      key={art}
                      className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[10px] text-emerald-300"
                    >
                      {art}
                    </span>
                  ))}
                </div>
              )}
            </div>

            <div className="rounded-xl border border-slate-800 bg-[#111827] p-3.5">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-xs font-semibold text-slate-200">
                  <Wallet className="h-4 w-4 text-cyan-400" />
                  <span>EIP-1193 Browser Wallet</span>
                </span>
                {browserWalletAddress && (
                  <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 font-mono text-[10px] text-emerald-300">
                    {shortenAddress(browserWalletAddress)}
                  </span>
                )}
              </div>
              <p className="mt-1 text-[11px] text-slate-400">
                Sign real `eth_signTypedData_v4` intents via MetaMask/Rabby or use Demo Wallets.
              </p>
              <button
                type="button"
                onClick={handleConnectWallet}
                className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-cyan-500/40 bg-cyan-500/15 px-3 py-1 text-xs font-semibold text-cyan-300 hover:bg-cyan-500/25"
              >
                <Link2 className="h-3.5 w-3.5" />
                <span>
                  {browserWalletAddress ? 'Reconnect Wallet' : 'Connect Injected Wallet'}
                </span>
              </button>
            </div>
          </div>

          {/* Cancun / EIP-1153 Notice */}
          <div className="flex items-start gap-2.5 rounded-xl border border-amber-500/25 bg-amber-500/10 p-3 text-xs text-amber-200">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
            <div>
              <span className="font-semibold">EVM Cancun Opcode Compatibility:</span>{' '}
              FairBatch uses Fe 26.5 `std::evm::mutex::Mutex` (`TLOAD`/`TSTORE`, EIP-1153) and `PUSH0` (EIP-3855).{' '}
              <strong>Mainnet, Sepolia, Hoodi, and Anvil</strong> support Cancun natively; deprecated Goerli/Holesky testnets are sunset.
            </div>
          </div>

          {/* Quick Network Presets */}
          <div>
            <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-slate-400">
              Quick Network Templates
            </span>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
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
                  className="rounded-lg border border-slate-700/80 bg-[#111827] px-2.5 py-2 text-left text-[11px] font-medium text-slate-200 transition hover:border-cyan-500/50 hover:bg-slate-800"
                >
                  <div className="font-semibold text-white">{preset.label.split(' (')[0]}</div>
                  <div className="font-mono text-[10px] text-slate-400">
                    Chain ID: {preset.chainId}
                  </div>
                </button>
              ))}
            </div>
          </div>

          <form onSubmit={handleSubmit} className="space-y-3.5">
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="sm:col-span-2">
                <label
                  htmlFor="cfg-rpc-url"
                  className="mb-1 block text-xs font-medium text-slate-300"
                >
                  JSON-RPC Endpoint (`RPC_URL`)
                </label>
                <input
                  id="cfg-rpc-url"
                  type="text"
                  value={rpcUrl}
                  onChange={(e) => setRpcUrl(e.target.value)}
                  placeholder="https://ethereum-sepolia-rpc.publicnode.com"
                  className="w-full rounded-lg border border-slate-700 bg-[#090D16] px-3 py-2 font-mono text-xs text-slate-100 focus:border-cyan-400 focus:outline-none"
                />
              </div>
              <div>
                <label
                  htmlFor="cfg-chain-id"
                  className="mb-1 block text-xs font-medium text-slate-300"
                >
                  Chain ID (`CHAIN_ID`)
                </label>
                <input
                  id="cfg-chain-id"
                  type="number"
                  value={chainId}
                  onChange={(e) => setChainId(e.target.value)}
                  className="w-full rounded-lg border border-slate-700 bg-[#090D16] px-3 py-2 font-mono text-xs text-slate-100 focus:border-cyan-400 focus:outline-none"
                />
              </div>
            </div>

            <div>
              <label
                htmlFor="cfg-fairbatch-addr"
                className="mb-1 block text-xs font-medium text-slate-300"
              >
                FairBatch Contract Address (`FAIRBATCH_ADDRESS`)
              </label>
              <input
                id="cfg-fairbatch-addr"
                type="text"
                value={fairBatchAddr}
                onChange={(e) => setFairBatchAddr(e.target.value)}
                placeholder="0x0000000000000000000000000000000000000000"
                className="w-full rounded-lg border border-slate-700 bg-[#090D16] px-3 py-2 font-mono text-xs text-slate-100 focus:border-cyan-400 focus:outline-none"
              />
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label
                  htmlFor="cfg-base-addr"
                  className="mb-1 block text-xs font-medium text-slate-300"
                >
                  Base Token WETH (18 decimals)
                </label>
                <input
                  id="cfg-base-addr"
                  type="text"
                  value={baseTokenAddr}
                  onChange={(e) => setBaseTokenAddr(e.target.value)}
                  className="w-full rounded-lg border border-slate-700 bg-[#090D16] px-3 py-2 font-mono text-xs text-slate-100 focus:border-cyan-400 focus:outline-none"
                />
              </div>
              <div>
                <label
                  htmlFor="cfg-quote-addr"
                  className="mb-1 block text-xs font-medium text-slate-300"
                >
                  Quote Token USDC (6 decimals)
                </label>
                <input
                  id="cfg-quote-addr"
                  type="text"
                  value={quoteTokenAddr}
                  onChange={(e) => setQuoteTokenAddr(e.target.value)}
                  className="w-full rounded-lg border border-slate-700 bg-[#090D16] px-3 py-2 font-mono text-xs text-slate-100 focus:border-cyan-400 focus:outline-none"
                />
              </div>
            </div>

            {statusMsg && (
              <div className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-300">
                <CheckCircle2 className="h-4 w-4 shrink-0" />
                <span>{statusMsg}</span>
              </div>
            )}

            {walletErr && (
              <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
                {walletErr}
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg border border-slate-700 px-4 py-2 text-xs font-medium text-slate-300 hover:bg-slate-800"
              >
                Close
              </button>
              <button
                type="submit"
                disabled={saving}
                className="rounded-lg bg-emerald-500 px-4 py-2 text-xs font-bold text-slate-950 transition hover:bg-emerald-400 disabled:opacity-50"
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
