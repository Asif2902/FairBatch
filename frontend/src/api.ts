import type {
  BatchSettlementDto,
  ComparisonDto,
  ContractConfigUpdatePayload,
  CurvePointDto,
  ExecutionReceiptDto,
  FillOutcomeDto,
  HealthResponse,
  OrderDto,
  OrderSide,
  PresetId,
  ReserveSnapshotDto,
  SignedDemoIntentResponse,
  StateResponse,
} from './types';
import { computeBatchSettlement, fallbackStore } from './lib/fallbackEngine';
import { computeLocalCommitmentHash } from './lib/keccak';

function num(v: unknown, fallback = 0): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeReserveSnapshot(raw: unknown): ReserveSnapshotDto {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const rx = num(obj.rx, 100);
  const ry = num(obj.ry, 300_000);
  const spot_price = num(obj.spot_price, rx > 0 ? ry / rx : 0);
  const k_invariant = num(obj.k_invariant, rx * ry);
  return { rx, ry, spot_price, k_invariant };
}

function normalizeCurvePoint(raw: unknown): CurvePointDto {
  const obj = (raw ?? {}) as Record<string, unknown>;
  return {
    price: num(obj.price ?? obj.limit_price),
    cumulative_base: num(obj.cumulative_base ?? obj.volume_base ?? obj.base_volume ?? obj.quantity),
    cumulative_quote:
      obj.cumulative_quote !== undefined || obj.volume_quote !== undefined
        ? num(obj.cumulative_quote ?? obj.volume_quote)
        : undefined,
    label: typeof obj.label === 'string' ? obj.label : undefined,
  };
}

function normalizeReceipt(raw: unknown, idx: number): ExecutionReceiptDto {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const side: OrderSide = obj.side === 'BuyBase' ? 'BuyBase' : 'SellBase';
  const amount_in = num(obj.amount_in);
  const amount_out = num(obj.amount_out ?? obj.payout_out);
  return {
    order_id: num(obj.order_id, idx + 1),
    arrival_index: num(obj.arrival_index ?? obj.position, idx + 1),
    trader: String(obj.trader ?? ''),
    label: String(obj.label ?? `Order #${idx + 1}`),
    side,
    amount_in,
    amount_filled:
      obj.amount_filled !== undefined ? num(obj.amount_filled) : amount_in,
    amount_out,
    refund_in: obj.refund_in !== undefined ? num(obj.refund_in) : 0,
    effective_price: num(obj.effective_price),
    price_impact_pct:
      obj.price_impact_pct !== undefined
        ? num(obj.price_impact_pct)
        : obj.slippage_pct !== undefined
          ? num(obj.slippage_pct)
          : 0,
    slippage_pct:
      obj.slippage_pct !== undefined
        ? num(obj.slippage_pct)
        : obj.price_impact_pct !== undefined
          ? num(obj.price_impact_pct)
          : 0,
    status: String(obj.status ?? 'Filled'),
    is_attacker: Boolean(obj.is_attacker),
  };
}

function normalizeFill(raw: unknown, idx: number): FillOutcomeDto {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const rawStatus = String(obj.status ?? 'Filled');
  const status =
    rawStatus === 'PartialFill' || rawStatus === 'OutOfMoneyRefund'
      ? rawStatus
      : 'Filled';
  return {
    order_id: num(obj.order_id, idx + 1),
    trader: String(obj.trader ?? ''),
    label: String(obj.label ?? `Order #${idx + 1}`),
    side: obj.side === 'BuyBase' ? 'BuyBase' : 'SellBase',
    status,
    amount_in: num(obj.amount_in),
    amount_filled: num(obj.amount_filled),
    payout_out: num(obj.payout_out ?? obj.amount_out),
    refund_in: num(obj.refund_in),
    limit_price: num(obj.limit_price),
    effective_price: num(obj.effective_price),
    is_attacker: Boolean(obj.is_attacker),
  };
}

export function normalizeSettlement(raw: unknown): BatchSettlementDto {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const compRaw = (obj.comparison ?? {}) as Record<string, unknown>;

  const comparison: ComparisonDto = {
    fee_bps: num(compRaw.fee_bps, 30),
    amm_victim_avg_price: num(compRaw.amm_victim_avg_price),
    fairbatch_uniform_price: num(
      compRaw.fairbatch_uniform_price,
      num(obj.clearing_price),
    ),
    user_value_saved_quote: num(compRaw.user_value_saved_quote),
    amm_sandwich_profit_quote: num(compRaw.amm_sandwich_profit_quote),
    fairbatch_sandwich_profit_quote: num(compRaw.fairbatch_sandwich_profit_quote, 0),
    amm_lvr_loss_quote: num(compRaw.amm_lvr_loss_quote),
    amm_receipts: Array.isArray(compRaw.amm_receipts)
      ? compRaw.amm_receipts.map((r, i) => normalizeReceipt(r, i))
      : [],
    fairbatch_receipts: Array.isArray(compRaw.fairbatch_receipts)
      ? compRaw.fairbatch_receipts.map((r, i) => normalizeReceipt(r, i))
      : [],
  };

  return {
    batch_id: num(obj.batch_id, 1),
    clearing_price: num(obj.clearing_price),
    total_sell_base_eligible: num(obj.total_sell_base_eligible),
    total_buy_quote_eligible: num(obj.total_buy_quote_eligible),
    cow_matched_base: num(obj.cow_matched_base),
    cow_matched_quote: num(obj.cow_matched_quote),
    cow_ratio_pct: num(obj.cow_ratio_pct),
    pool_delta_base: num(obj.pool_delta_base),
    pool_delta_quote: num(obj.pool_delta_quote),
    reserves_before: normalizeReserveSnapshot(obj.reserves_before),
    reserves_after: normalizeReserveSnapshot(obj.reserves_after),
    k_invariant_growth: num(obj.k_invariant_growth),
    k_invariant_growth_pct: num(obj.k_invariant_growth_pct),
    slashed_bonds_count: num(obj.slashed_bonds_count),
    fills: Array.isArray(obj.fills)
      ? obj.fills.map((f, i) => normalizeFill(f, i))
      : [],
    supply_curve: Array.isArray(obj.supply_curve)
      ? obj.supply_curve.map(normalizeCurvePoint)
      : [],
    demand_curve: Array.isArray(obj.demand_curve)
      ? obj.demand_curve.map(normalizeCurvePoint)
      : [],
    comparison,
  };
}

export function normalizeState(raw: unknown): StateResponse {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const resRaw = (obj.reserves ?? {}) as Record<string, unknown>;
  const rx = num(resRaw.rx, 100);
  const ry = num(resRaw.ry, 300_000);

  return {
    batch_id: num(obj.batch_id, 1),
    phase:
      obj.phase === 'Reveal' || obj.phase === 'Settled' ? obj.phase : 'Open',
    commit_duration_secs: num(obj.commit_duration_secs, 60),
    reveal_duration_secs: num(obj.reveal_duration_secs, 45),
    phase_remaining_secs: num(obj.phase_remaining_secs, 45),
    reserves: {
      rx,
      ry,
      spot_price: num(resRaw.spot_price, rx > 0 ? ry / rx : 0),
      k_invariant: num(resRaw.k_invariant, rx * ry),
      base_symbol: String(resRaw.base_symbol ?? 'WETH'),
      quote_symbol: String(resRaw.quote_symbol ?? 'USDC'),
      base_decimals: num(resRaw.base_decimals, 18),
      quote_decimals: num(resRaw.quote_decimals, 6),
    },
    demo_wallets: Array.isArray(obj.demo_wallets)
      ? (obj.demo_wallets as StateResponse['demo_wallets'])
      : fallbackStore.getState().demo_wallets,
    commitments: Array.isArray(obj.commitments)
      ? (obj.commitments as StateResponse['commitments'])
      : [],
    orders: Array.isArray(obj.orders)
      ? (obj.orders as StateResponse['orders'])
      : [],
    claimable: Array.isArray(obj.claimable)
      ? (obj.claimable as StateResponse['claimable'])
      : [],
    settled_history: Array.isArray(obj.settled_history)
      ? obj.settled_history.map(normalizeSettlement)
      : [],
  };
}

class BackendUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackendUnreachableError';
  }
}

async function requestJson<T>(
  path: string,
  options?: RequestInit,
): Promise<T> {
  if (typeof globalThis.fetch !== 'function') {
    throw new BackendUnreachableError('fetch unavailable');
  }

  let response: Response;
  try {
    response = await globalThis.fetch(path, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(options?.headers ?? {}),
      },
    });
  } catch (err) {
    throw new BackendUnreachableError(
      err instanceof Error ? err.message : 'Network error',
    );
  }

  // Vite dev proxy returns 502/503/504, or 500/404 with empty or HTML proxy text,
  // when the Rust backend at 127.0.0.1:3001 is down. Treat those as unreachable
  // so the browser fallback engine can take over without surfacing a raw status.
  if (response.status === 502 || response.status === 503 || response.status === 504) {
    throw new BackendUnreachableError(`Gateway status ${response.status}`);
  }

  const text = await response.text();
  if (!response.ok) {
    const proxyFailureText =
      text.trim() === '' ||
      text.includes('<!DOCTYPE') ||
      text.includes('Cannot ') ||
      text.includes('ECONNREFUSED') ||
      text.toLowerCase().includes('proxy');
    if (
      (response.status === 404 || response.status === 500) &&
      proxyFailureText
    ) {
      throw new BackendUnreachableError('API route not mounted');
    }
    let parsedMessage = text;
    try {
      const errJson = JSON.parse(text) as Record<string, unknown>;
      if (typeof errJson.error === 'string') parsedMessage = errJson.error;
      else if (typeof errJson.message === 'string') parsedMessage = errJson.message;
    } catch {
      // keep raw text
    }
    throw new Error(parsedMessage || `HTTP ${response.status}`);
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new BackendUnreachableError('Invalid JSON response from server');
  }
}

export const fairBatchApi = {
  async getHealth(): Promise<{ health: HealthResponse; isLiveBackend: boolean }> {
    try {
      const raw = await requestJson<HealthResponse>('/api/health');
      return {
        health: {
          status: raw.status ?? 'ok',
          execution_mode: raw.execution_mode ?? 'local_engine',
          rpc_url: raw.rpc_url ?? null,
          chain_id: num(raw.chain_id, 31337),
          contracts: {
            fair_batch:
              raw.contracts?.fair_batch ??
              '0x0000000000000000000000000000000000000000',
            base_token:
              raw.contracts?.base_token ??
              '0x0000000000000000000000000000000000000000',
            quote_token:
              raw.contracts?.quote_token ??
              '0x0000000000000000000000000000000000000000',
            deployed: Boolean(raw.contracts?.deployed),
          },
          fe_artifacts_present: Boolean(raw.fe_artifacts_present),
          fe_artifacts: Array.isArray(raw.fe_artifacts) ? raw.fe_artifacts : [],
        },
        isLiveBackend: true,
      };
    } catch (err) {
      if (err instanceof BackendUnreachableError) {
        return { health: fallbackStore.getHealth(), isLiveBackend: false };
      }
      throw err;
    }
  },

  async getState(): Promise<{ state: StateResponse; isLiveBackend: boolean }> {
    try {
      const raw = await requestJson<unknown>('/api/state');
      return { state: normalizeState(raw), isLiveBackend: true };
    } catch (err) {
      if (err instanceof BackendUnreachableError) {
        return { state: fallbackStore.getState(), isLiveBackend: false };
      }
      throw err;
    }
  },

  async submitDirectOrder(payload: {
    trader: string;
    label?: string;
    side: OrderSide;
    amount_in: number;
    limit_price: number;
  }): Promise<StateResponse> {
    try {
      const raw = await requestJson<unknown>('/api/orders/direct', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      return normalizeState(raw);
    } catch (err) {
      if (err instanceof BackendUnreachableError) {
        return fallbackStore.addDirectOrder(payload);
      }
      throw err;
    }
  },

  async computeCommitmentHash(payload: {
    trader: string;
    batch_id: number;
    side: OrderSide;
    amount_in: number;
    limit_price: number;
    salt: string;
  }): Promise<{ commitment_hash: string }> {
    try {
      return await requestJson<{ commitment_hash: string }>(
        '/api/orders/compute-hash',
        {
          method: 'POST',
          body: JSON.stringify(payload),
        },
      );
    } catch (err) {
      if (err instanceof BackendUnreachableError) {
        return {
          commitment_hash: computeLocalCommitmentHash(payload),
        };
      }
      throw err;
    }
  },

  async commitOrder(payload: {
    trader: string;
    commitment_hash: string;
    bond_eth: number;
  }): Promise<{ commit_id: number; state: StateResponse }> {
    try {
      const raw = await requestJson<{ commit_id: number; state: unknown }>(
        '/api/orders/commit',
        {
          method: 'POST',
          body: JSON.stringify(payload),
        },
      );
      return {
        commit_id: num(raw.commit_id, 1),
        state: normalizeState(raw.state),
      };
    } catch (err) {
      if (err instanceof BackendUnreachableError) {
        return fallbackStore.commitOrder(payload);
      }
      throw err;
    }
  },

  async revealOrder(payload: {
    commit_id: number;
    trader: string;
    side: OrderSide;
    amount_in: number;
    limit_price: number;
    salt: string;
    label?: string;
  }): Promise<StateResponse> {
    try {
      const raw = await requestJson<unknown>('/api/orders/reveal', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      return normalizeState(raw);
    } catch (err) {
      if (err instanceof BackendUnreachableError) {
        return fallbackStore.revealOrder(payload);
      }
      throw err;
    }
  },

  async signDemoIntent(payload: {
    demo_account_index: number;
    side: OrderSide;
    amount_in: number;
    limit_price: number;
    batch_id: number;
    deadline: number;
  }): Promise<SignedDemoIntentResponse> {
    try {
      return await requestJson<SignedDemoIntentResponse>(
        '/api/orders/sign-demo-intent',
        {
          method: 'POST',
          body: JSON.stringify(payload),
        },
      );
    } catch (err) {
      if (err instanceof BackendUnreachableError) {
        return fallbackStore.signDemoIntent(payload);
      }
      throw err;
    }
  },

  async submitSignedIntent(payload: {
    trader: string;
    side: OrderSide;
    amount_in: number;
    limit_price: number;
    batch_id: number;
    nonce: number;
    deadline: number;
    signature: string;
    label?: string;
  }): Promise<StateResponse> {
    try {
      const raw = await requestJson<unknown>('/api/orders/intent', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      return normalizeState(raw);
    } catch (err) {
      if (err instanceof BackendUnreachableError) {
        return fallbackStore.submitSignedIntent(payload);
      }
      throw err;
    }
  },

  async loadPreset(payload: {
    preset: PresetId;
    include_sandwich_bot: boolean;
    reset_reserves?: { rx: number; ry: number };
  }): Promise<StateResponse> {
    try {
      const raw = await requestJson<unknown>('/api/presets/load', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      return normalizeState(raw);
    } catch (err) {
      if (err instanceof BackendUnreachableError) {
        return fallbackStore.loadPreset(
          payload.preset,
          payload.include_sandwich_bot,
          payload.reset_reserves,
        );
      }
      throw err;
    }
  },

  async advanceBatch(): Promise<StateResponse> {
    try {
      const raw = await requestJson<unknown>('/api/batch/advance', {
        method: 'POST',
        body: JSON.stringify({}),
      });
      return normalizeState(raw);
    } catch (err) {
      if (err instanceof BackendUnreachableError) {
        return fallbackStore.advancePhase();
      }
      throw err;
    }
  },

  async settleBatch(): Promise<{
    settlement: BatchSettlementDto;
    state: StateResponse;
  }> {
    try {
      const raw = await requestJson<{ settlement: unknown; state: unknown }>(
        '/api/batch/settle',
        {
          method: 'POST',
          body: JSON.stringify({}),
        },
      );
      return {
        settlement: normalizeSettlement(raw.settlement),
        state: normalizeState(raw.state),
      };
    } catch (err) {
      if (err instanceof BackendUnreachableError) {
        return fallbackStore.settleBatch();
      }
      throw err;
    }
  },

  async claimBatch(payload: {
    trader: string;
    claims: Array<{ batch_id: number; order_id: number }>;
  }): Promise<{
    claimed_base: number;
    claimed_quote: number;
    state: StateResponse;
  }> {
    try {
      const raw = await requestJson<{
        claimed_base: number;
        claimed_quote: number;
        state: unknown;
      }>('/api/batch/claim', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      return {
        claimed_base: num(raw.claimed_base),
        claimed_quote: num(raw.claimed_quote),
        state: normalizeState(raw.state),
      };
    } catch (err) {
      if (err instanceof BackendUnreachableError) {
        return fallbackStore.claimBatch(payload);
      }
      throw err;
    }
  },

  async compareStateless(payload: {
    rx: number;
    ry: number;
    fee_bps: number;
    include_sandwich_bot: boolean;
    orders: OrderDto[];
  }): Promise<{ settlement: BatchSettlementDto }> {
    try {
      const raw = await requestJson<{ settlement: unknown }>('/api/compare', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      return { settlement: normalizeSettlement(raw.settlement) };
    } catch (err) {
      if (err instanceof BackendUnreachableError) {
        return {
          settlement: computeBatchSettlement(
            0,
            payload.rx,
            payload.ry,
            payload.orders,
            0,
            payload.fee_bps,
            payload.include_sandwich_bot,
          ),
        };
      }
      throw err;
    }
  },

  async updateContractConfig(
    payload: ContractConfigUpdatePayload,
  ): Promise<HealthResponse> {
    try {
      const raw = await requestJson<HealthResponse>('/api/config/contracts', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      return raw;
    } catch (err) {
      if (err instanceof BackendUnreachableError) {
        return fallbackStore.updateContractConfig(payload);
      }
      throw err;
    }
  },

  async resetPool(payload?: { rx?: number; ry?: number }): Promise<StateResponse> {
    try {
      const raw = await requestJson<unknown>('/api/reset', {
        method: 'POST',
        body: JSON.stringify(payload ?? {}),
      });
      return normalizeState(raw);
    } catch (err) {
      if (err instanceof BackendUnreachableError) {
        return fallbackStore.reset(payload?.rx, payload?.ry);
      }
      throw err;
    }
  },
};
