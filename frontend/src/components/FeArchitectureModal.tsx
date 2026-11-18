import React, { useState } from 'react';
import {
  CheckCircle2,
  Code2,
  Cpu,
  Lock,
  Scale,
  ShieldCheck,
  X,
} from 'lucide-react';

interface FeArchitectureModalProps {
  isOpen: boolean;
  onClose: () => void;
}

interface ArchTab {
  id: string;
  label: string;
  badge: string;
  summary: string;
  code: string;
  highlights: string[];
}

const ARCH_TABS: ArchTab[] = [
  {
    id: 'pure-clearing',
    label: 'Zero-Effect solve_batch',
    badge: '0 uses clauses',
    summary:
      'Fe 26.5 capability-based effect tracking enforces at compile time that FairBatch’s pricing & allocation solver cannot read/mutate storage, emit logs, touch msg.sender, or make external calls.',
    code: `// src/clearing.fe — Compiler-enforced pure equilibrium engine
use core::fixed::Wad
use core::num::mul_div
use core::ptr::MemVec
use core::sort::{reverse, sort}

pub fn solve_batch(
    reserves_base: u256,
    reserves_quote: u256,
    mut orders: MemVec<Order>
) -> BatchSolution {
    // NO \`uses (...)\` clause! Compiler forbids storage, Call, Log, or Ctx.
    sort(mut orders) // Canonical price-priority ordering in memory
    // p* = (R_y + 2 * D_y) / (R_x + 2 * S_x) in 18-decimal Wad space
    let p_star = Wad::from_ratio(ry_plus_2dy, rx_plus_2sx)
    ...
}`,
    highlights: [
      'Zero hidden state dependencies: identical inputs produce bit-for-bit identical p* and pro-rata fills.',
      'Canonical core::sort::sort eliminates mempool arrival-order priority.',
      'Auditors verify isolation from reentrancy & storage corruption in one glance at the signature.',
    ],
  },
  {
    id: 'wad-solvency',
    label: 'Wad + Solvency Math',
    badge: 'core::fixed::Wad',
    summary:
      'Every payout and partial-fill refund uses 512-bit intermediate floor division (`core::num::mul_div`) and decimal scaling between 18-decimal WETH and 6-decimal USDC.',
    code: `// src/math.fe — 512-bit overflow-safe Wad & multi-decimal normalization
use core::fixed::Wad
use core::num::mul_div

pub fn normalize_amount(raw_amt: u256, decimals: u8) -> u256 {
    let scale = 10 ** (18 - (decimals as u256))
    raw_amt * scale
}

pub fn denormalize_floor(norm_amt: u256, decimals: u8) -> u256 {
    let scale = 10 ** (18 - (decimals as u256))
    mul_div(norm_amt, 1, scale) // Strict floor rounding: sum(payouts) <= escrow
}`,
    highlights: [
      'Strict floor-rounding invariant guarantees sum(user_payouts) + pool_after <= total_escrowed to the last atom.',
      'Seamless normalization of 18-decimal WETH against 6-decimal Mainnet/Sepolia USDC.',
      'Liquidity-Nondecreasing (LND) proof: R_x′ · R_y′ - R_x · R_y = (p*·R_x - R_y)² / (4·p*) >= 0.',
    ],
  },
  {
    id: 'transient-mutex',
    label: 'EIP-1153 Mutex & Pull Claims',
    badge: 'TLOAD / TSTORE',
    summary:
      'Cancun transient storage (`std::evm::mutex::Mutex`) guards token transfers for ~100 gas instead of 5,000+ gas SSTORE locks, paired with pull-over-push claims and Multicall.',
    code: `// src/lib.fe — Granular uses(...) + EIP-1153 Transient Mutex + Multicall
use std::evm::mutex::Mutex
use std::evm::erc20::safe_transfer
use std::evm::multicall::{MulticallMsg, multicall}

pub contract FairBatch {
    mut lock: Mutex<u256>
    ...
    recv FairBatchMsg {
        Claim { batch_id, order_id } -> (u256, u256)
            uses (ctx: Ctx, call: mut Call, mut lock, mut claims)
        {
            lock.lock() // Cancun EIP-1153 TSTORE reentrancy guard
            // Pull-over-push: one blacklisted USDC user never blocks batch settlement!
            safe_transfer(token: quote, receiver: ctx.caller(), amount: out_amt)
            lock.unlock()
            (base_out, quote_out)
        }
    }
}`,
    highlights: [
      'Pull-over-push claims prevent a single blacklisted USDC address from reverting settle_batch() for everyone.',
      'std::evm::multicall enables 1-tx batch claiming across multiple settled auctions.',
      'Typed units (Wei, Timestamp, Duration) prevent unit-confusion vulnerabilities.',
    ],
  },
  {
    id: 'eip712-intents',
    label: 'EIP-712 & Sealed Commits',
    badge: 'std::evm::eip712',
    summary:
      'Dual pre-settlement privacy: keccak256 Commit-Reveal with Wei anti-free-option bonds plus EIP-712 Domain-separated secp256k1 Signed Intents.',
    code: `// src/intent.fe — Native Fe 26.5 EIP-712 & Signature Recovery
use core::bytes::keccak
use std::evm::crypto::keccak_words
use std::evm::eip712::Domain
use std::evm::signature::recover

const SIGNED_ORDER_TYPEHASH: u256 = keccak(
    "SignedOrder(address trader,uint8 side,uint256 amountIn,uint256 limitPrice,uint256 batchId,uint256 nonce,uint256 deadline)"
)

pub fn verify_intent(...) -> bool uses (ctx: Ctx) {
    let domain = Domain::new(name_hash: keccak("FairBatch"), version_hash: keccak("1"))
    let digest = domain.digest(struct_hash: order_struct_hash)
    recover(digest: digest, sig.payload_span()) == Option::Some(trader)
}`,
    highlights: [
      'Domain separator binds chainId and verifyingContract against cross-chain & fork replay.',
      'Per-trader monotonic nonces + Timestamp deadlines protect gasless solver-relayed intents.',
      'Unrevealed commit bonds are slashable after reveal_deadline to eliminate free-option griefing.',
    ],
  },
];

export const FeArchitectureModal: React.FC<FeArchitectureModalProps> = ({
  isOpen,
  onClose,
}) => {
  const [activeTabId, setActiveTabId] = useState<string>(ARCH_TABS[0].id);

  if (!isOpen) return null;

  const currentTab =
    ARCH_TABS.find((t) => t.id === activeTabId) ?? ARCH_TABS[0];

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="fe-arch-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/65 p-4 backdrop-blur-sm"
    >
      <div className="max-h-[90vh] w-full max-w-3xl overflow-y-auto border border-ink bg-paper-bright shadow-2xl">
        <div className="flex items-start justify-between gap-4 border-b-2 border-ink bg-paper px-5 py-4">
          <div className="flex items-start gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center border border-ink bg-ink text-paper">
              <Code2 className="h-4 w-4" aria-hidden="true" />
            </div>
            <div>
              <div className="eyebrow">Architecture inspector</div>
              <h2
                id="fe-arch-modal-title"
                className="mt-1 font-display text-xl font-bold leading-tight tracking-tight text-ink"
              >
                Why Fe 26.5.0?
              </h2>
              <p className="mt-0.5 text-[11px] text-ink-muted">
                Capability-based <code>uses</code> effects, <code>Wad</code> fixed-point
                math, EIP-1153 <code>Mutex</code>, and EIP-712 intents.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close Fe Architecture Inspector"
            className="border border-rule-strong p-1.5 text-ink-muted transition hover:border-ink hover:text-ink"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-5">
          {/* Proof tabs */}
          <div className="grid grid-cols-2 gap-px border border-rule bg-rule sm:grid-cols-4">
            {ARCH_TABS.map((tab) => {
              const selected = tab.id === activeTabId;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveTabId(tab.id)}
                  className={`relative px-2.5 py-2 text-left transition ${
                    selected
                      ? 'bg-ink text-paper'
                      : 'bg-paper-bright text-ink-muted hover:bg-paper-soft hover:text-ink'
                  }`}
                >
                  {selected && (
                    <span className="absolute inset-x-0 top-0 h-[2px] bg-vermilion-500" />
                  )}
                  <div className="font-display text-[11px] font-bold leading-tight">
                    {tab.label}
                  </div>
                  <div
                    className={`mt-1 font-mono text-[8.5px] uppercase tracking-[0.06em] ${
                      selected ? 'text-paper/55' : 'text-ink-faint'
                    }`}
                  >
                    {tab.badge}
                  </div>
                </button>
              );
            })}
          </div>

          <div className="mt-4 space-y-4">
            <p className="border-l-2 border-vermilion-500 pl-3 text-[11.5px] leading-relaxed text-ink-soft">
              {currentTab.summary}
            </p>

            <div className="border border-ink bg-ink">
              <div className="flex items-center justify-between gap-2 border-b border-paper/15 px-3 py-1.5">
                <span className="font-mono text-[8.5px] font-bold uppercase tracking-label text-paper/60">
                  {currentTab.label}
                </span>
                <span className="font-mono text-[8.5px] uppercase tracking-[0.08em] text-paper/40">
                  {currentTab.badge}
                </span>
              </div>
              <pre className="overflow-x-auto p-4 font-mono text-[10.5px] leading-relaxed text-pine-200">
                <code>{currentTab.code}</code>
              </pre>
            </div>

            <div className="border border-rule bg-paper-soft p-3.5">
              <div className="mb-2 flex items-center gap-1.5 font-mono text-[9px] font-bold uppercase tracking-label text-ink-soft">
                <ShieldCheck className="h-3.5 w-3.5 text-pine-700" />
                <span>Security &amp; mechanism guarantees</span>
              </div>
              <ul className="space-y-1.5">
                {currentTab.highlights.map((item) => (
                  <li
                    key={item}
                    className="flex items-start gap-2 text-[10.5px] leading-relaxed text-ink-soft"
                  >
                    <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0 text-pine-700" />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </div>

            <div className="grid grid-cols-3 gap-px border border-rule bg-rule text-center">
              <div className="bg-paper-bright p-2.5">
                <Cpu className="mx-auto mb-1 h-3.5 w-3.5 text-pine-700" />
                <div className="font-display text-[11px] font-bold text-ink">
                  Pure Pricing
                </div>
                <div className="mt-0.5 font-mono text-[8.5px] text-ink-muted">
                  Zero `uses` side effects
                </div>
              </div>
              <div className="bg-paper-bright p-2.5">
                <Scale className="mx-auto mb-1 h-3.5 w-3.5 text-cobalt-700" />
                <div className="font-display text-[11px] font-bold text-ink">
                  Floor Solvency
                </div>
                <div className="mt-0.5 font-mono text-[8.5px] text-ink-muted">
                  512-bit `mul_div`
                </div>
              </div>
              <div className="bg-paper-bright p-2.5">
                <Lock className="mx-auto mb-1 h-3.5 w-3.5 text-brass-700" />
                <div className="font-display text-[11px] font-bold text-ink">
                  Cancun Ready
                </div>
                <div className="mt-0.5 font-mono text-[8.5px] text-ink-muted">
                  EIP-1153 `TSTORE`
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
