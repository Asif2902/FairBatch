import { describe, expect, it } from 'vitest';
import {
  computeBatchSettlement,
  DEMO_WALLETS,
  fallbackStore,
  resolveEnvHealthDefaults,
} from '../lib/fallbackEngine';
import {
  computeLocalCommitmentHash,
  keccak256Utf8,
} from '../lib/keccak';
import type { OrderDto } from '../types';

describe('Keccak-256 & Cryptographic Primitives', () => {
  it('matches canonical Ethereum keccak256("") and Fe 26.5 EIP-712 typehashes', () => {
    expect(keccak256Utf8('')).toBe(
      '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470',
    );
    expect(keccak256Utf8('FairBatch')).toBe(
      '0xbfc8188869712178434ae4bf52a3a78c858fb11b896cf2025bf6cc70fc65617c',
    );
    expect(
      keccak256Utf8(
        'SignedOrder(address trader,uint8 side,uint256 amountIn,uint256 limitPrice,uint256 batchId,uint256 nonce,uint256 deadline)',
      ),
    ).toBe(
      '0x533cd46d2f02704a53b40b6efd823ebfb6860646a4f98544ac1c2cbc83db34a8',
    );
  });

  it('produces deterministic 32-byte commitment hashes sensitive to salt and limit price', () => {
    const h1 = computeLocalCommitmentHash({
      batch_id: 1,
      trader: DEMO_WALLETS[0].address,
      side: 'SellBase',
      amount_in: 2.5,
      limit_price: 2700,
      salt: '0x' + '11'.repeat(32),
    });
    const h2 = computeLocalCommitmentHash({
      batch_id: 1,
      trader: DEMO_WALLETS[0].address,
      side: 'SellBase',
      amount_in: 2.5,
      limit_price: 2700,
      salt: '0x' + '22'.repeat(32),
    });
    expect(h1).toMatch(/^0x[0-9a-f]{64}$/);
    expect(h1).not.toBe(h2);
  });
});

describe('Hybrid CoW + FM-AMM Batch Clearing Engine', () => {
  it('clears 5 ETH sellers at uniform p* = 2727.2727... with strict LND growth', () => {
    const state = fallbackStore.loadPreset('five_sellers', false, {
      rx: 100,
      ry: 300_000,
    });
    const settlement = computeBatchSettlement(1, 100, 300_000, state.orders);

    expect(settlement.clearing_price).toBeCloseTo(2727.272727, 4);
    expect(settlement.fills).toHaveLength(5);

    const firstPayout = settlement.fills[0].payout_out;
    for (const fill of settlement.fills) {
      expect(fill.status).toBe('Filled');
      expect(fill.payout_out).toBe(firstPayout);
      expect(fill.effective_price).toBeCloseTo(2727.272727, 4);
    }

    expect(settlement.reserves_after.k_invariant).toBeGreaterThan(
      settlement.reserves_before.k_invariant,
    );
  });

  it('satisfies order-permutation invariance across arbitrary arrival shuffles', () => {
    const baseOrders: OrderDto[] = [
      {
        order_id: 1,
        trader: DEMO_WALLETS[0].address,
        label: 'Alice',
        side: 'SellBase',
        amount_in: 3.0,
        limit_price: 2600,
        submission_type: 'Direct',
        is_attacker: false,
      },
      {
        order_id: 2,
        trader: DEMO_WALLETS[1].address,
        label: 'Bob',
        side: 'BuyBase',
        amount_in: 6000,
        limit_price: 3150,
        submission_type: 'Eip712Intent',
        is_attacker: false,
      },
      {
        order_id: 3,
        trader: DEMO_WALLETS[2].address,
        label: 'Carol',
        side: 'SellBase',
        amount_in: 1.5,
        limit_price: 2750,
        submission_type: 'CommitReveal',
        is_attacker: false,
      },
    ];

    const reversed = [...baseOrders].reverse();
    const s1 = computeBatchSettlement(1, 100, 300_000, baseOrders);
    const s2 = computeBatchSettlement(1, 100, 300_000, reversed);

    expect(s1.clearing_price).toBeCloseTo(s2.clearing_price, 9);
    for (const f1 of s1.fills) {
      const f2 = s2.fills.find((x) => x.order_id === f1.order_id)!;
      expect(f2.payout_out).toBe(f1.payout_out);
      expect(f2.refund_in).toBe(f1.refund_in);
    }
  });

  it('crosses Balanced CoW 100% peer-to-peer at $3,000.00 with zero reserve impact', () => {
    const state = fallbackStore.loadPreset('cow_balanced', false, {
      rx: 100,
      ry: 300_000,
    });
    const settlement = computeBatchSettlement(1, 100, 300_000, state.orders);

    expect(settlement.clearing_price).toBeCloseTo(3000.0, 4);
    expect(settlement.cow_ratio_pct).toBeCloseTo(100.0, 2);
    expect(settlement.reserves_after.rx).toBeCloseTo(100.0, 6);
    expect(settlement.reserves_after.ry).toBeCloseTo(300_000.0, 4);
  });

  it('pins marginal limit tier at $2,800.00 with pro-rata partial fills and 100% OTM refund', () => {
    const state = fallbackStore.loadPreset('marginal_pro_rata', false, {
      rx: 100,
      ry: 300_000,
    });
    const settlement = computeBatchSettlement(1, 100, 300_000, state.orders);

    expect(settlement.clearing_price).toBeCloseTo(2800.0, 4);

    const statuses = settlement.fills.map((f) => f.status);
    expect(statuses).toContain('Filled');
    expect(statuses).toContain('PartialFill');
    expect(statuses).toContain('OutOfMoneyRefund');

    const otmDave = settlement.fills.find((f) => f.label.includes('Dave'))!;
    expect(otmDave.status).toBe('OutOfMoneyRefund');
    expect(otmDave.refund_in).toBe(2.0);
    expect(otmDave.payout_out).toBe(0);

    const expectedCowRatio =
      ((2 * settlement.cow_matched_base) /
        (settlement.total_sell_base_eligible +
          settlement.total_buy_quote_eligible / settlement.clearing_price)) *
      100;
    expect(settlement.cow_ratio_pct).toBeCloseTo(expectedCowRatio, 4);
  });

  it('eliminates MEV sandwich profit ($0.00 on FairBatch vs >$1,000 on Sequential AMM)', () => {
    const state = fallbackStore.loadPreset('five_sellers', true, {
      rx: 100,
      ry: 300_000,
    });
    const settlement = computeBatchSettlement(1, 100, 300_000, state.orders);

    expect(settlement.clearing_price).toBeCloseTo(2727.272727, 4);
    expect(settlement.comparison.amm_sandwich_profit_quote).toBeGreaterThan(1000);
    expect(settlement.comparison.fairbatch_sandwich_profit_quote).toBe(0);

    const margSandwich = fallbackStore.loadPreset('marginal_pro_rata', true, {
      rx: 100,
      ry: 300_000,
    });
    const margSettlement = computeBatchSettlement(
      1,
      100,
      300_000,
      margSandwich.orders,
    );
    expect(margSettlement.clearing_price).toBeCloseTo(2800.0, 4);
    expect(margSettlement.comparison.fairbatch_sandwich_profit_quote).toBe(0);
  });

  it('resolves Sepolia VITE_* environment defaults cleanly for zero and deployed contract addresses', () => {
    const unsetDefaults = resolveEnvHealthDefaults({
      VITE_CHAIN_ID: '11155111',
      VITE_RPC_URL: 'https://ethereum-sepolia-rpc.publicnode.com',
      VITE_FAIRBATCH_ADDRESS: '0x0000000000000000000000000000000000000000',
      VITE_BASE_TOKEN_ADDRESS: '0x0000000000000000000000000000000000000000',
      VITE_QUOTE_TOKEN_ADDRESS: '0x0000000000000000000000000000000000000000',
    });
    expect(unsetDefaults.chainId).toBe(11155111);
    expect(unsetDefaults.contracts.deployed).toBe(false);
    expect(unsetDefaults.contracts.base_token).toBe(
      '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14',
    );

    const deployedDefaults = resolveEnvHealthDefaults({
      VITE_CHAIN_ID: '11155111',
      VITE_RPC_URL: 'https://ethereum-sepolia-rpc.publicnode.com',
      VITE_FAIRBATCH_ADDRESS: '0xAbCdEf0123456789AbCdEf0123456789AbCdEf01',
      VITE_BASE_TOKEN_ADDRESS: '0x1111111111111111111111111111111111111111',
      VITE_QUOTE_TOKEN_ADDRESS: '0x2222222222222222222222222222222222222222',
    });
    expect(deployedDefaults.contracts.deployed).toBe(true);
    expect(deployedDefaults.contracts.fair_batch).toBe(
      '0xAbCdEf0123456789AbCdEf0123456789AbCdEf01',
    );
    expect(deployedDefaults.contracts.base_token).toBe(
      '0x1111111111111111111111111111111111111111',
    );
  });
});
