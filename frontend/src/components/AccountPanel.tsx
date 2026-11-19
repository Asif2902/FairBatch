import React from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Droplets,
  ExternalLink,
  Link2,
  LogOut,
  ShieldCheck,
  Wallet,
} from 'lucide-react';
import { formatUnits } from 'viem';
import type { RuntimeConfig } from '../onchain/config';
import type { WalletAllowances, WalletBalances } from '../onchain/state';
import { formatToken, getChainLabel, shortenAddress } from '../lib/format';

interface AccountPanelProps {
  config: RuntimeConfig;
  account: string | null;
  walletChainId: number | null;
  wrongNetwork: boolean;
  balances: WalletBalances | null;
  allowances: WalletAllowances | null;
  busyAction: string | null;
  faucetEnabled: boolean;
  onConnect: () => Promise<void>;
  onDisconnect: () => void;
  onFaucet: (token: 'base' | 'quote') => Promise<void>;
  onApprove: (token: 'base' | 'quote') => Promise<void>;
}

function human(raw: bigint | undefined, decimals: number): number {
  if (raw === undefined) return 0;
  return Number(formatUnits(raw, decimals));
}

export const AccountPanel: React.FC<AccountPanelProps> = ({
  config,
  account,
  walletChainId,
  wrongNetwork,
  balances,
  allowances,
  busyAction,
  faucetEnabled,
  onConnect,
  onDisconnect,
  onFaucet,
  onApprove,
}) => {
  const busy = busyAction !== null;
  const connected = Boolean(account);

  return (
    <section aria-label="Connected wallet and balances" className="ledger-panel overflow-hidden">
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-rule px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <Wallet className="h-3 w-3 text-cobalt-700" aria-hidden="true" />
            <span className="eyebrow">Settlement account</span>
          </div>
          <h2 className="mt-1 font-display text-xl font-bold leading-tight tracking-tight text-ink">
            {connected ? 'On-chain wallet' : 'Connect a wallet'}
          </h2>
        </div>
        <span
          className={`inline-flex items-center gap-1.5 border px-2 py-1 font-mono text-[8.5px] font-bold uppercase tracking-[0.08em] ${
            connected
              ? 'border-pine-600/40 bg-pine-50 text-pine-700'
              : 'border-brass-600/50 bg-brass-50 text-brass-700'
          }`}
        >
          <span className={`h-1.5 w-1.5 ${connected ? 'bg-pine-500' : 'bg-brass-500'}`} />
          {connected ? 'Connected' : 'Read-only'}
        </span>
      </div>

      <div className="space-y-3 p-4">
        {!connected ? (
          <>
            <p className="text-[11px] leading-relaxed text-ink-muted">
              Every order, reveal, settlement and claim is a signed transaction. Connect an
              injected EIP-1193 wallet on{' '}
              <strong className="text-ink">{getChainLabel(config.chainId)}</strong> to trade
              against the deployed FairBatch contract.
            </p>
            <button
              type="button"
              data-testid="account-connect-button"
              disabled={busy}
              onClick={() => void onConnect()}
              className="inline-flex w-full items-center justify-center gap-2 border border-ink bg-ink px-3 py-2.5 font-display text-sm font-bold text-paper transition hover:bg-ink-soft disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Link2 className="h-4 w-4" aria-hidden="true" />
              <span>{busyAction === 'connect' ? 'Connecting…' : 'Connect injected wallet'}</span>
            </button>
            <p className="border-t border-rule pt-2 font-mono text-[9px] leading-relaxed text-ink-faint">
              RPC · {config.rpcUrl.replace(/^https?:\/\//, '').split('/')[0]} ·{' '}
              {shortenAddress(config.fairBatch)}
            </p>
          </>
        ) : (
          <>
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="font-mono text-[11px] font-bold text-ink">
                  {shortenAddress(account ?? '')}
                </div>
                <div className="mt-0.5 font-mono text-[9px] text-ink-faint">
                  {getChainLabel(config.chainId)}
                  {walletChainId !== null && walletChainId !== config.chainId
                    ? ` · wallet on ${getChainLabel(walletChainId)}`
                    : ''}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <a
                  href={`${config.explorerUrl}/address/${account}`}
                  target="_blank"
                  rel="noreferrer"
                  aria-label="Open wallet on explorer"
                  className="border border-rule p-1.5 text-ink-faint transition hover:border-ink hover:text-ink"
                >
                  <ExternalLink className="h-3 w-3" />
                </a>
                <button
                  type="button"
                  onClick={onDisconnect}
                  aria-label="Disconnect wallet"
                  className="border border-rule p-1.5 text-ink-faint transition hover:border-ink hover:text-ink"
                >
                  <LogOut className="h-3 w-3" />
                </button>
              </div>
            </div>

            {wrongNetwork && (
              <div className="flex items-start gap-2 border-l-2 border-vermilion-500 bg-vermilion-50 px-2.5 py-2 text-[10.5px] leading-snug text-vermilion-800">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <div>
                  Wallet network mismatch. Reconnect to switch the wallet to{' '}
                  {getChainLabel(config.chainId)}.
                  <button
                    type="button"
                    onClick={() => void onConnect()}
                    className="ml-1 font-bold underline decoration-dotted underline-offset-2"
                  >
                    Switch
                  </button>
                </div>
              </div>
            )}

            <div className="grid grid-cols-2 gap-px border border-rule bg-rule">
              <div className="bg-paper-bright p-2.5">
                <div className="font-mono text-[8px] uppercase tracking-label text-ink-faint">
                  Sepolia ETH
                </div>
                <div className="mt-1 font-mono text-[12px] font-bold text-ink tabular-nums">
                  {formatToken(human(balances?.eth, 18), 4)}
                </div>
              </div>
              <div className="bg-paper-bright p-2.5">
                <div className="font-mono text-[8px] uppercase tracking-label text-ink-faint">
                  LP shares
                </div>
                <div className="mt-1 font-mono text-[12px] font-bold text-plum-700 tabular-nums">
                  {formatToken(human(balances?.lpShares, 18), 2)}
                </div>
              </div>
              <div className="bg-paper-bright p-2.5">
                <div className="font-mono text-[8px] uppercase tracking-label text-ink-faint">
                  {config.baseSymbol} balance
                </div>
                <div
                  data-testid="account-balance-base"
                  className="mt-1 font-mono text-[12px] font-bold text-ink tabular-nums"
                >
                  {formatToken(human(balances?.base, config.baseDecimals), 3)}
                </div>
                <div className="mt-1 flex items-center gap-1 font-mono text-[8px] text-ink-faint">
                  {allowances && allowances.base > 0n ? (
                    <>
                      <CheckCircle2 className="h-2.5 w-2.5 text-pine-600" />
                      approved
                    </>
                  ) : (
                    <>
                      <ShieldCheck className="h-2.5 w-2.5 text-brass-600" />
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void onApprove('base')}
                        className="underline decoration-dotted underline-offset-2 hover:text-ink"
                      >
                        approve
                      </button>
                    </>
                  )}
                </div>
              </div>
              <div className="bg-paper-bright p-2.5">
                <div className="font-mono text-[8px] uppercase tracking-label text-ink-faint">
                  {config.quoteSymbol} balance
                </div>
                <div
                  data-testid="account-balance-quote"
                  className="mt-1 font-mono text-[12px] font-bold text-ink tabular-nums"
                >
                  {formatToken(human(balances?.quote, config.quoteDecimals), 2)}
                </div>
                <div className="mt-1 flex items-center gap-1 font-mono text-[8px] text-ink-faint">
                  {allowances && allowances.quote > 0n ? (
                    <>
                      <CheckCircle2 className="h-2.5 w-2.5 text-pine-600" />
                      approved
                    </>
                  ) : (
                    <>
                      <ShieldCheck className="h-2.5 w-2.5 text-brass-600" />
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void onApprove('quote')}
                        className="underline decoration-dotted underline-offset-2 hover:text-ink"
                      >
                        approve
                      </button>
                    </>
                  )}
                </div>
              </div>
            </div>

            {faucetEnabled && (
              <div className="border border-brass-500/40 bg-brass-50/60 p-2.5">
                <div className="flex items-center gap-1.5 font-mono text-[9px] font-bold uppercase tracking-label text-brass-700">
                  <Droplets className="h-3 w-3" />
                  Testnet faucet
                </div>
                <div className="mt-2 grid grid-cols-2 gap-1.5">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void onFaucet('base')}
                    className="border border-brass-600/50 bg-paper-bright px-2 py-1.5 font-mono text-[9px] font-bold uppercase tracking-[0.06em] text-brass-800 transition hover:bg-brass-100 disabled:opacity-40"
                  >
                    Mint 10 {config.baseSymbol}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void onFaucet('quote')}
                    className="border border-brass-600/50 bg-paper-bright px-2 py-1.5 font-mono text-[9px] font-bold uppercase tracking-[0.06em] text-brass-800 transition hover:bg-brass-100 disabled:opacity-40"
                  >
                    Mint 30,000 {config.quoteSymbol}
                  </button>
                </div>
                <p className="mt-1.5 font-mono text-[8.5px] leading-relaxed text-ink-faint">
                  Mock tokens mint to this wallet and approve FairBatch in one call.
                </p>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
};
