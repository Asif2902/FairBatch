//! Pure functional Hybrid Coincidence of Wants (CoW) + Function-Maximizing AMM (FM-AMM)
//! uniform batch clearing solver mirroring `src/clearing.fe`.
//!
//! Key Mathematical Guarantees:
//! 1. Order-Permutation Invariance: sellers sort ascending by `limit_price`, buyers descending.
//! 2. Closed-Form Equilibrium Price: `p* = floor((R_y + 2 * D_y) * WAD / (R_x + 2 * S_x))`.
//! 3. Marginal Limit-Price Pinning: if full inclusion of a limit tier crosses its own `p_limit`,
//!    pins `p* = p_limit` and allocates floor-rounded pro-rata partial fills across the excess side.
//! 4. Liquidity-Nondecreasing (LND) Invariant: `R_x' * R_y' >= R_x * R_y` for every batch.
//! 5. Solvency: all payouts and partial refunds round strictly DOWN to native token atoms.

use serde::{Deserialize, Serialize};

use crate::math::{
    denormalize_floor, f64_to_raw, f64_to_wad, mul_div, mul_div_ceil, normalize_raw, raw_to_f64,
    wad_to_f64, U256, WAD,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum OrderSide {
    SellBase,
    BuyBase,
}

impl OrderSide {
    #[inline]
    pub const fn as_u8(self) -> u8 {
        match self {
            Self::SellBase => 0,
            Self::BuyBase => 1,
        }
    }

    pub fn from_u8(v: u8) -> Option<Self> {
        match v {
            0 => Some(Self::SellBase),
            1 => Some(Self::BuyBase),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SubmissionType {
    Direct,
    CommitReveal,
    Eip712Intent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum FillStatus {
    Filled,
    PartialFill,
    OutOfMoneyRefund,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CurvePointDto {
    pub price: f64,
    pub cumulative_base: f64,
    pub cumulative_quote: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReservesSnapshotDto {
    pub rx: f64,
    pub ry: f64,
    pub spot_price: f64,
    pub k_invariant: f64,
    pub base_symbol: String,
    pub quote_symbol: String,
    pub base_decimals: u8,
    pub quote_decimals: u8,
}

impl ReservesSnapshotDto {
    pub fn new(rx: f64, ry: f64, base_decimals: u8, quote_decimals: u8) -> Self {
        let spot_price = if rx > 0.0 { ry / rx } else { 0.0 };
        let k_invariant = rx * ry;
        Self {
            rx,
            ry,
            spot_price,
            k_invariant,
            base_symbol: "WETH".to_string(),
            quote_symbol: "USDC".to_string(),
            base_decimals,
            quote_decimals,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecutionReceiptDto {
    pub arrival_index: usize,
    pub order_id: u64,
    pub trader: String,
    pub label: String,
    pub side: OrderSide,
    pub is_attacker: bool,
    pub status: FillStatus,
    pub amount_in: f64,
    pub limit_price: f64,
    pub amount_filled: f64,
    pub payout_out: f64,
    pub refund_in: f64,
    pub effective_price: f64,
    pub slippage_pct: f64,
}

/// Exact integer order input for `solve_batch_tokens`.
#[derive(Debug, Clone)]
pub struct ClearingOrder {
    pub order_id: u64,
    pub arrival_index: usize,
    pub trader: String,
    pub label: String,
    pub side: OrderSide,
    pub amount_in_raw: u128,
    pub limit_price_wad: u128,
    pub is_attacker: bool,
}

impl ClearingOrder {
    #[allow(clippy::too_many_arguments)]
    pub fn from_human(
        order_id: u64,
        arrival_index: usize,
        trader: String,
        label: String,
        side: OrderSide,
        amount_in: f64,
        limit_price: f64,
        is_attacker: bool,
        base_decimals: u8,
        quote_decimals: u8,
    ) -> Self {
        let in_decimals = match side {
            OrderSide::SellBase => base_decimals,
            OrderSide::BuyBase => quote_decimals,
        };
        Self {
            order_id,
            arrival_index,
            trader,
            label,
            side,
            amount_in_raw: f64_to_raw(amount_in, in_decimals),
            limit_price_wad: f64_to_wad(limit_price),
            is_attacker,
        }
    }
}

/// Exact integer fill outcome mirroring `FillOutcome` in `src/types.fe`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawFillOutcome {
    pub order_id: u64,
    pub arrival_index: usize,
    pub side: OrderSide,
    pub status: FillStatus,
    pub amount_in_raw: u128,
    pub amount_filled_raw: u128,
    pub payout_out_raw: u128,
    pub refund_in_raw: u128,
}

/// Exact integer settlement output of `solve_batch_tokens`.
#[derive(Debug, Clone)]
pub struct RawClearingOutcome {
    pub clearing_price_wad: u128,
    pub total_sell_base_filled_norm: u128,
    pub total_buy_quote_filled_norm: u128,
    pub cow_matched_base_norm: u128,
    pub cow_matched_quote_norm: u128,
    pub rx_raw_before: u128,
    pub ry_raw_before: u128,
    pub rx_raw_after: u128,
    pub ry_raw_after: u128,
    pub lnd_invariant_holds: bool,
    pub raw_fills: Vec<RawFillOutcome>,
    pub receipts: Vec<ExecutionReceiptDto>,
    pub supply_curve: Vec<CurvePointDto>,
    pub demand_curve: Vec<CurvePointDto>,
}

/// Computes candidate equilibrium price `p*` (in WAD) given normalized reserves `(rx, ry)`
/// and normalized active order sums `(s_norm, d_norm)`.
#[inline]
fn closed_form_price_wad(rx_norm: u128, ry_norm: u128, s_norm: u128, d_norm: u128) -> u128 {
    if rx_norm == 0 && ry_norm == 0 {
        if s_norm == 0 {
            return if d_norm > 0 { u128::MAX } else { 0 };
        }
        if d_norm == 0 {
            return 0;
        }
        return mul_div(d_norm, WAD, s_norm);
    }

    let num_quote = ry_norm
        .checked_add(d_norm.checked_mul(2).expect("2*D overflow"))
        .expect("R_y + 2*D overflow");
    let den_base = rx_norm
        .checked_add(s_norm.checked_mul(2).expect("2*S overflow"))
        .expect("R_x + 2*S overflow");
    if den_base == 0 {
        return if num_quote > 0 { u128::MAX } else { 0 };
    }
    mul_div(num_quote, WAD, den_base)
}

#[derive(Debug, Clone, Copy)]
enum EquilibriumKind {
    NoMatch { spot_wad: u128 },
    Interior { price_wad: u128 },
    Pinned {
        price_wad: u128,
        s_marg_cap_norm: u128,
        s_marg_total_norm: u128,
        d_marg_cap_norm: u128,
        d_marg_total_norm: u128,
    },
}

/// Pure deterministic batch solver operating in exact integer WAD & token atom units.
pub fn solve_batch_tokens(
    rx_raw: u128,
    ry_raw: u128,
    base_decimals: u8,
    quote_decimals: u8,
    orders: &[ClearingOrder],
) -> RawClearingOutcome {
    let rx_norm = normalize_raw(rx_raw, base_decimals);
    let ry_norm = normalize_raw(ry_raw, quote_decimals);
    let spot_wad = if rx_norm > 0 && ry_norm > 0 {
        mul_div(ry_norm, WAD, rx_norm)
    } else {
        0
    };

    // Partition and sort non-dust orders deterministically:
    // - Sellers ascending by limit_price_wad
    // - Buyers descending by limit_price_wad
    let mut sellers: Vec<(usize, u128)> = Vec::new();
    let mut buyers: Vec<(usize, u128)> = Vec::new();

    for (idx, o) in orders.iter().enumerate() {
        if o.amount_in_raw == 0 {
            continue;
        }
        match o.side {
            OrderSide::SellBase => {
                let norm = normalize_raw(o.amount_in_raw, base_decimals);
                sellers.push((idx, norm));
            }
            OrderSide::BuyBase => {
                let norm = normalize_raw(o.amount_in_raw, quote_decimals);
                buyers.push((idx, norm));
            }
        }
    }

    sellers.sort_by(|(a_i, _), (b_i, _)| {
        orders[*a_i]
            .limit_price_wad
            .cmp(&orders[*b_i].limit_price_wad)
            .then_with(|| orders[*a_i].order_id.cmp(&orders[*b_i].order_id))
    });

    buyers.sort_by(|(a_i, _), (b_i, _)| {
        orders[*b_i]
            .limit_price_wad
            .cmp(&orders[*a_i].limit_price_wad)
            .then_with(|| orders[*a_i].order_id.cmp(&orders[*b_i].order_id))
    });

    let supply_curve = build_supply_curve(orders, &sellers, base_decimals);
    let demand_curve = build_demand_curve(orders, &buyers, quote_decimals);

    // Collect distinct sorted candidate limit prices across all active orders.
    let mut levels: Vec<u128> = Vec::with_capacity(sellers.len() + buyers.len());
    for &(idx, _) in &sellers {
        levels.push(orders[idx].limit_price_wad);
    }
    for &(idx, _) in &buyers {
        levels.push(orders[idx].limit_price_wad);
    }
    levels.sort_unstable();
    levels.dedup();

    let eq = find_equilibrium(rx_norm, ry_norm, spot_wad, orders, &sellers, &buyers, &levels);

    // Allocate exact floor-rounded raw fills and refunds in original order slice layout.
    let mut raw_fills: Vec<RawFillOutcome> = Vec::with_capacity(orders.len());
    let mut seller_filled_raw_vec = vec![0u128; orders.len()];
    let mut buyer_filled_raw_vec = vec![0u128; orders.len()];

    let clearing_price_wad = match eq {
        EquilibriumKind::NoMatch { spot_wad: p } => p,
        EquilibriumKind::Interior { price_wad } => price_wad,
        EquilibriumKind::Pinned { price_wad, .. } => price_wad,
    };

    for (idx, o) in orders.iter().enumerate() {
        if o.amount_in_raw == 0 {
            continue;
        }
        match eq {
            EquilibriumKind::NoMatch { .. } => {}
            EquilibriumKind::Interior { price_wad } => {
                if price_wad > 0 {
                    match o.side {
                        OrderSide::SellBase if o.limit_price_wad <= price_wad => {
                            seller_filled_raw_vec[idx] = o.amount_in_raw;
                        }
                        OrderSide::BuyBase if o.limit_price_wad >= price_wad => {
                            buyer_filled_raw_vec[idx] = o.amount_in_raw;
                        }
                        _ => {}
                    }
                }
            }
            EquilibriumKind::Pinned {
                price_wad,
                s_marg_cap_norm,
                s_marg_total_norm,
                d_marg_cap_norm,
                d_marg_total_norm,
            } => {
                if price_wad > 0 {
                    match o.side {
                        OrderSide::SellBase => {
                            if o.limit_price_wad < price_wad {
                                seller_filled_raw_vec[idx] = o.amount_in_raw;
                            } else if o.limit_price_wad == price_wad && s_marg_total_norm > 0 {
                                seller_filled_raw_vec[idx] = if s_marg_cap_norm >= s_marg_total_norm
                                {
                                    o.amount_in_raw
                                } else {
                                    mul_div(o.amount_in_raw, s_marg_cap_norm, s_marg_total_norm)
                                };
                            }
                        }
                        OrderSide::BuyBase => {
                            if o.limit_price_wad > price_wad {
                                buyer_filled_raw_vec[idx] = o.amount_in_raw;
                            } else if o.limit_price_wad == price_wad && d_marg_total_norm > 0 {
                                buyer_filled_raw_vec[idx] = if d_marg_cap_norm >= d_marg_total_norm
                                {
                                    o.amount_in_raw
                                } else {
                                    mul_div(o.amount_in_raw, d_marg_cap_norm, d_marg_total_norm)
                                };
                            }
                        }
                    }
                }
            }
        }
    }

    let pure_p2p = rx_raw == 0 && ry_raw == 0;

    // Pass 1b: When `!pure_p2p`, filter out dust fills that would denormalize to `0` raw output
    // at `p_star` BEFORE finalizing `total_sell_filled_raw` / `total_buy_filled_raw`.
    if !pure_p2p && clearing_price_wad > 0 {
        for idx in 0..orders.len() {
            if seller_filled_raw_vec[idx] > 0 {
                let filled_norm = normalize_raw(seller_filled_raw_vec[idx], base_decimals);
                let est_out_norm = mul_div(filled_norm, clearing_price_wad, WAD);
                if denormalize_floor(est_out_norm, quote_decimals) == 0 {
                    seller_filled_raw_vec[idx] = 0;
                }
            }
            if buyer_filled_raw_vec[idx] > 0 {
                let filled_norm = normalize_raw(buyer_filled_raw_vec[idx], quote_decimals);
                let est_out_norm = mul_div(filled_norm, WAD, clearing_price_wad);
                if denormalize_floor(est_out_norm, base_decimals) == 0 {
                    buyer_filled_raw_vec[idx] = 0;
                }
            }
        }
    }

    let mut total_sell_filled_raw: u128 = seller_filled_raw_vec.iter().copied().sum();
    let mut total_buy_filled_raw: u128 = buyer_filled_raw_vec.iter().copied().sum();

    let effective_match = if pure_p2p {
        total_sell_filled_raw > 0 && total_buy_filled_raw > 0
    } else {
        !matches!(eq, EquilibriumKind::NoMatch { .. })
            && clearing_price_wad > 0
            && (total_sell_filled_raw > 0 || total_buy_filled_raw > 0)
    };

    if !effective_match {
        seller_filled_raw_vec.fill(0);
        buyer_filled_raw_vec.fill(0);
        total_sell_filled_raw = 0;
        total_buy_filled_raw = 0;
    }

    let effective_clearing_price_wad = if !effective_match && pure_p2p {
        0
    } else {
        clearing_price_wad
    };

    let total_sell_norm = normalize_raw(total_sell_filled_raw, base_decimals);
    let total_buy_norm = normalize_raw(total_buy_filled_raw, quote_decimals);

    // Directional execution price bounds (`p_sell <= p_exact <= p_buy`) mirroring `src/clearing.fe`:
    // prevents discrete floor-truncation of `p_star` or marginal input atoms from violating LND or solvency.
    let (p_sell_wad, p_buy_wad) = if !effective_match {
        (0u128, 0u128)
    } else if pure_p2p {
        let p_exec_floor = mul_div(total_buy_norm, WAD, total_sell_norm);
        let p_exec_ceil = mul_div_ceil(total_buy_norm, WAD, total_sell_norm);
        (
            effective_clearing_price_wad.min(p_exec_floor),
            effective_clearing_price_wad.max(p_exec_ceil),
        )
    } else {
        let numer = ry_norm + 2 * total_buy_norm;
        let denom = rx_norm + 2 * total_sell_norm;
        let p_exec_floor = mul_div(numer, WAD, denom);
        let p_exec_ceil = mul_div_ceil(numer, WAD, denom);
        (
            effective_clearing_price_wad.min(p_exec_floor),
            effective_clearing_price_wad.max(p_exec_ceil),
        )
    };

    let mut total_seller_payout_quote_raw = 0u128;
    let mut total_buyer_payout_base_raw = 0u128;
    let mut receipts: Vec<ExecutionReceiptDto> = Vec::with_capacity(orders.len());

    let ref_spot_f64 = if spot_wad > 0 {
        wad_to_f64(spot_wad)
    } else {
        wad_to_f64(effective_clearing_price_wad)
    };

    // Pass 2: Compute floor-rounded payouts and refunds for every order.
    for (idx, o) in orders.iter().enumerate() {
        let (in_dec, out_dec) = match o.side {
            OrderSide::SellBase => (base_decimals, quote_decimals),
            OrderSide::BuyBase => (quote_decimals, base_decimals),
        };

        let filled_raw = match o.side {
            OrderSide::SellBase => seller_filled_raw_vec[idx],
            OrderSide::BuyBase => buyer_filled_raw_vec[idx],
        };

        let payout_raw = if filled_raw == 0 || !effective_match {
            0
        } else {
            let filled_norm = normalize_raw(filled_raw, in_dec);
            let payout_norm = match o.side {
                OrderSide::SellBase => {
                    let mut p = mul_div(filled_norm, p_sell_wad, WAD);
                    if pure_p2p && total_sell_norm > 0 {
                        p = p.min(mul_div(filled_norm, total_buy_norm, total_sell_norm));
                    }
                    p
                }
                OrderSide::BuyBase => {
                    let mut p = if p_buy_wad > 0 {
                        mul_div(filled_norm, WAD, p_buy_wad)
                    } else {
                        0
                    };
                    if pure_p2p && total_buy_norm > 0 {
                        p = p.min(mul_div(filled_norm, total_sell_norm, total_buy_norm));
                    }
                    p
                }
            };
            denormalize_floor(payout_norm, out_dec)
        };

        let refund_raw = o.amount_in_raw - filled_raw;
        let status = if filled_raw == 0 {
            FillStatus::OutOfMoneyRefund
        } else if filled_raw == o.amount_in_raw {
            FillStatus::Filled
        } else {
            FillStatus::PartialFill
        };

        match o.side {
            OrderSide::SellBase => {
                total_seller_payout_quote_raw += payout_raw;
            }
            OrderSide::BuyBase => {
                total_buyer_payout_base_raw += payout_raw;
            }
        }

        let amount_in_f64 = raw_to_f64(o.amount_in_raw, in_dec);
        let amount_filled_f64 = raw_to_f64(filled_raw, in_dec);
        let payout_out_f64 = raw_to_f64(payout_raw, out_dec);
        let refund_in_f64 = raw_to_f64(refund_raw, in_dec);
        let limit_price_f64 = wad_to_f64(o.limit_price_wad);

        let effective_price = if filled_raw == 0 {
            0.0
        } else {
            match o.side {
                OrderSide::SellBase => {
                    if amount_filled_f64 > 0.0 {
                        payout_out_f64 / amount_filled_f64
                    } else {
                        0.0
                    }
                }
                OrderSide::BuyBase => {
                    if payout_out_f64 > 0.0 {
                        amount_filled_f64 / payout_out_f64
                    } else {
                        0.0
                    }
                }
            }
        };

        let slippage_pct = if filled_raw == 0 || ref_spot_f64 <= 0.0 {
            0.0
        } else {
            match o.side {
                OrderSide::SellBase => ((ref_spot_f64 - effective_price) / ref_spot_f64) * 100.0,
                OrderSide::BuyBase => ((effective_price - ref_spot_f64) / ref_spot_f64) * 100.0,
            }
        };

        raw_fills.push(RawFillOutcome {
            order_id: o.order_id,
            arrival_index: o.arrival_index,
            side: o.side,
            status,
            amount_in_raw: o.amount_in_raw,
            amount_filled_raw: filled_raw,
            payout_out_raw: payout_raw,
            refund_in_raw: refund_raw,
        });

        receipts.push(ExecutionReceiptDto {
            arrival_index: o.arrival_index,
            order_id: o.order_id,
            trader: o.trader.clone(),
            label: o.label.clone(),
            side: o.side,
            is_attacker: o.is_attacker,
            status,
            amount_in: amount_in_f64,
            limit_price: limit_price_f64,
            amount_filled: amount_filled_f64,
            payout_out: payout_out_f64,
            refund_in: refund_in_f64,
            effective_price,
            slippage_pct,
        });
    }

    assert!(
        rx_raw + total_sell_filled_raw >= total_buyer_payout_base_raw,
        "solvency violation: insufficient base reserve"
    );
    assert!(
        ry_raw + total_buy_filled_raw >= total_seller_payout_quote_raw,
        "solvency violation: insufficient quote reserve"
    );

    let rx_raw_after = if pure_p2p {
        0
    } else {
        rx_raw + total_sell_filled_raw - total_buyer_payout_base_raw
    };
    let ry_raw_after = if pure_p2p {
        0
    } else {
        ry_raw + total_buy_filled_raw - total_seller_payout_quote_raw
    };

    let rx_norm_after = normalize_raw(rx_raw_after, base_decimals);
    let ry_norm_after = normalize_raw(ry_raw_after, quote_decimals);

    let k_before_u256 = U256::mul_u128(rx_norm, ry_norm);
    let k_after_u256 = U256::mul_u128(rx_norm_after, ry_norm_after);
    let lnd_invariant_holds = k_after_u256 >= k_before_u256;
    assert!(
        lnd_invariant_holds,
        "FM-AMM LND invariant violated: k_after < k_before"
    );

    let total_sell_base_filled_norm = normalize_raw(total_sell_filled_raw, base_decimals);
    let total_buy_quote_filled_norm = normalize_raw(total_buy_filled_raw, quote_decimals);

    let buy_in_base_equiv_norm = if effective_clearing_price_wad > 0 {
        mul_div(total_buy_quote_filled_norm, WAD, effective_clearing_price_wad)
    } else {
        0
    };
    let cow_matched_base_norm = total_sell_base_filled_norm.min(buy_in_base_equiv_norm);
    let cow_matched_quote_norm = if effective_clearing_price_wad > 0 {
        mul_div(cow_matched_base_norm, effective_clearing_price_wad, WAD)
            .min(total_buy_quote_filled_norm)
    } else {
        0
    };

    RawClearingOutcome {
        clearing_price_wad: effective_clearing_price_wad,
        total_sell_base_filled_norm,
        total_buy_quote_filled_norm,
        cow_matched_base_norm,
        cow_matched_quote_norm,
        rx_raw_before: rx_raw,
        ry_raw_before: ry_raw,
        rx_raw_after,
        ry_raw_after,
        lnd_invariant_holds,
        raw_fills,
        receipts,
        supply_curve,
        demand_curve,
    }
}

/// Exact 256-bit comparison `(ry + 2 * dy) * WAD >= p * (rx + 2 * sx)` mirroring `demand_ge_supply` in `src/clearing.fe`.
#[inline]
fn demand_ge_supply(rx_norm: u128, ry_norm: u128, sx_norm: u128, dy_norm: u128, p_wad: u128) -> bool {
    let lhs = U256::mul_u128(ry_norm + 2 * dy_norm, WAD);
    let rhs = U256::mul_u128(p_wad, rx_norm + 2 * sx_norm);
    lhs >= rhs
}

/// Exact 256-bit comparison `(ry + 2 * dy) * WAD <= p * (rx + 2 * sx)` mirroring `demand_le_supply` in `src/clearing.fe`.
#[inline]
fn demand_le_supply(rx_norm: u128, ry_norm: u128, sx_norm: u128, dy_norm: u128, p_wad: u128) -> bool {
    let lhs = U256::mul_u128(ry_norm + 2 * dy_norm, WAD);
    let rhs = U256::mul_u128(p_wad, rx_norm + 2 * sx_norm);
    lhs <= rhs
}

fn find_equilibrium(
    rx_norm: u128,
    ry_norm: u128,
    spot_wad: u128,
    orders: &[ClearingOrder],
    sellers: &[(usize, u128)],
    buyers: &[(usize, u128)],
    levels: &[u128],
) -> EquilibriumKind {
    let pure_p2p = rx_norm == 0 && ry_norm == 0;

    if sellers.is_empty() && buyers.is_empty() {
        return EquilibriumKind::NoMatch { spot_wad };
    }

    // Pure P2P (`R_x == 0 && R_y == 0`) requires crossing two-sided flow.
    if pure_p2p {
        if sellers.is_empty() || buyers.is_empty() {
            return EquilibriumKind::NoMatch { spot_wad: 0 };
        }
        let min_ask = orders[sellers[0].0].limit_price_wad;
        let max_bid = orders[buyers[0].0].limit_price_wad;
        if max_bid < min_ask {
            return EquilibriumKind::NoMatch { spot_wad: 0 };
        }
    }

    let pos_levels: Vec<u128> = levels.iter().copied().filter(|&p| p > 0).collect();
    if pos_levels.is_empty() {
        let total_sx: u128 = sellers.iter().map(|&(_, n)| n).sum();
        let p_star = if pure_p2p {
            0
        } else {
            closed_form_price_wad(rx_norm, ry_norm, total_sx, 0)
        };
        if p_star == 0 || total_sx == 0 {
            return EquilibriumKind::NoMatch { spot_wad };
        }
        return EquilibriumKind::Interior { price_wad: p_star };
    }

    // 1. Check lowest open interval `(0, c_0)`
    let c0 = pos_levels[0];
    let s_lt_c0: u128 = sellers
        .iter()
        .filter(|&&(idx, _)| orders[idx].limit_price_wad < c0)
        .map(|&(_, n)| n)
        .sum();
    let dy_i0: u128 = buyers
        .iter()
        .filter(|&&(idx, _)| orders[idx].limit_price_wad >= c0)
        .map(|&(_, n)| n)
        .sum();
    if (ry_norm + 2 * dy_i0 > 0) && !demand_ge_supply(rx_norm, ry_norm, s_lt_c0, dy_i0, c0) {
        let p_star = closed_form_price_wad(rx_norm, ry_norm, s_lt_c0, dy_i0);
        if p_star == 0 || (s_lt_c0 == 0 && dy_i0 == 0) {
            return EquilibriumKind::NoMatch { spot_wad };
        }
        return EquilibriumKind::Interior { price_wad: p_star };
    }

    // 2. Walk each critical price `c_t` and open interval `(c_t, c_{t+1})` identically to `src/clearing.fe`
    let q = pos_levels.len();
    for t in 0..q {
        let p_lim = pos_levels[t];
        let s_lt: u128 = sellers
            .iter()
            .filter(|&&(idx, _)| orders[idx].limit_price_wad < p_lim)
            .map(|&(_, n)| n)
            .sum();
        let s_eq: u128 = sellers
            .iter()
            .filter(|&&(idx, _)| orders[idx].limit_price_wad == p_lim)
            .map(|&(_, n)| n)
            .sum();
        let b_gt: u128 = buyers
            .iter()
            .filter(|&&(idx, _)| orders[idx].limit_price_wad > p_lim)
            .map(|&(_, n)| n)
            .sum();
        let b_eq: u128 = buyers
            .iter()
            .filter(|&&(idx, _)| orders[idx].limit_price_wad == p_lim)
            .map(|&(_, n)| n)
            .sum();

        let left_ok = demand_ge_supply(rx_norm, ry_norm, s_lt, b_gt + b_eq, p_lim);
        let right_ok = demand_le_supply(rx_norm, ry_norm, s_lt + s_eq, b_gt, p_lim);

        if left_ok && right_ok {
            let full_both_ge =
                demand_ge_supply(rx_norm, ry_norm, s_lt + s_eq, b_gt + b_eq, p_lim);
            let full_both_le =
                demand_le_supply(rx_norm, ry_norm, s_lt + s_eq, b_gt + b_eq, p_lim);

            let (s_marg_cap, d_marg_cap) = if full_both_ge && full_both_le {
                (s_eq, b_eq)
            } else if full_both_le {
                let d_filled = b_gt + b_eq;
                let target_rx_plus_2sx = mul_div(ry_norm + 2 * d_filled, WAD, p_lim);
                let s_cap = if target_rx_plus_2sx > rx_norm {
                    let max_sx = (target_rx_plus_2sx - rx_norm) / 2;
                    if max_sx > s_lt {
                        (max_sx - s_lt).min(s_eq)
                    } else {
                        0
                    }
                } else {
                    0
                };
                (s_cap, b_eq)
            } else {
                let s_filled = s_lt + s_eq;
                let target_ry_plus_2dy = mul_div(p_lim, rx_norm + 2 * s_filled, WAD);
                let d_cap = if target_ry_plus_2dy > ry_norm {
                    let max_dy = (target_ry_plus_2dy - ry_norm) / 2;
                    if max_dy > b_gt {
                        (max_dy - b_gt).min(b_eq)
                    } else {
                        0
                    }
                } else {
                    0
                };
                (s_eq, d_cap)
            };

            if s_lt + s_marg_cap == 0 && b_gt + d_marg_cap == 0 {
                return EquilibriumKind::NoMatch {
                    spot_wad: if pure_p2p { 0 } else { p_lim },
                };
            }

            return EquilibriumKind::Pinned {
                price_wad: p_lim,
                s_marg_cap_norm: s_marg_cap,
                s_marg_total_norm: s_eq,
                d_marg_cap_norm: d_marg_cap,
                d_marg_total_norm: b_eq,
            };
        }

        let sx_open = s_lt + s_eq;
        let dy_open = b_gt;
        let in_open = if t + 1 < q {
            !demand_ge_supply(rx_norm, ry_norm, sx_open, dy_open, pos_levels[t + 1])
        } else {
            true
        };

        if in_open {
            let p_star = if pure_p2p && (sx_open == 0 || dy_open == 0) {
                0
            } else {
                closed_form_price_wad(rx_norm, ry_norm, sx_open, dy_open)
            };
            if p_star == 0 || (sx_open == 0 && dy_open == 0) {
                return EquilibriumKind::NoMatch {
                    spot_wad: if pure_p2p { 0 } else { p_star },
                };
            }
            if p_star == p_lim {
                return EquilibriumKind::Pinned {
                    price_wad: p_star,
                    s_marg_cap_norm: s_eq,
                    s_marg_total_norm: s_eq,
                    d_marg_cap_norm: 0,
                    d_marg_total_norm: b_eq,
                };
            }
            return EquilibriumKind::Interior { price_wad: p_star };
        }
    }

    EquilibriumKind::NoMatch { spot_wad }
}

fn build_supply_curve(
    orders: &[ClearingOrder],
    sellers: &[(usize, u128)],
    base_decimals: u8,
) -> Vec<CurvePointDto> {
    let mut curve = Vec::new();
    let mut cum_base = 0.0;
    let mut cum_quote = 0.0;

    let mut i = 0;
    while i < sellers.len() {
        let p_wad = orders[sellers[i].0].limit_price_wad;
        let price = wad_to_f64(p_wad);
        let mut tier_base = 0.0;
        while i < sellers.len() && orders[sellers[i].0].limit_price_wad == p_wad {
            tier_base += raw_to_f64(orders[sellers[i].0].amount_in_raw, base_decimals);
            i += 1;
        }
        cum_base += tier_base;
        cum_quote += tier_base * price;
        curve.push(CurvePointDto {
            price,
            cumulative_base: cum_base,
            cumulative_quote: cum_quote,
        });
    }
    curve
}

fn build_demand_curve(
    orders: &[ClearingOrder],
    buyers: &[(usize, u128)],
    quote_decimals: u8,
) -> Vec<CurvePointDto> {
    let mut curve = Vec::new();
    let mut cum_base = 0.0;
    let mut cum_quote = 0.0;

    let mut i = 0;
    while i < buyers.len() {
        let p_wad = orders[buyers[i].0].limit_price_wad;
        let price = wad_to_f64(p_wad);
        let mut tier_quote = 0.0;
        while i < buyers.len() && orders[buyers[i].0].limit_price_wad == p_wad {
            tier_quote += raw_to_f64(orders[buyers[i].0].amount_in_raw, quote_decimals);
            i += 1;
        }
        cum_quote += tier_quote;
        if price > 0.0 {
            cum_base += tier_quote / price;
        }
        curve.push(CurvePointDto {
            price,
            cumulative_base: cum_base,
            cumulative_quote: cum_quote,
        });
    }
    curve
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mk_order(id: u64, side: OrderSide, amount: f64, limit: f64) -> ClearingOrder {
        ClearingOrder::from_human(
            id,
            id as usize,
            format!("0x{:040x}", id),
            format!("Trader{}", id),
            side,
            amount,
            limit,
            false,
            18,
            6,
        )
    }

    #[test]
    fn test_five_eth_sellers_uniform_clearing_and_lnd() {
        let rx_raw = f64_to_raw(100.0, 18);
        let ry_raw = f64_to_raw(300_000.0, 6);
        let orders: Vec<_> = (1..=5)
            .map(|id| mk_order(id, OrderSide::SellBase, 1.0, 2000.0))
            .collect();

        let res = solve_batch_tokens(rx_raw, ry_raw, 18, 6, &orders);

        // Exact WAD price: floor(300_000 * 10^18 / 110) = 2727_272727272727272727
        assert_eq!(res.clearing_price_wad, 2_727_272_727_272_727_272_727u128);
        assert!(res.lnd_invariant_holds);
        assert_eq!(res.rx_raw_after, f64_to_raw(105.0, 18));

        // Every single seller receives bit-for-bit identical 6-decimal USDC payout (2,727.272727 USDC)
        for fill in &res.raw_fills {
            assert_eq!(fill.status, FillStatus::Filled);
            assert_eq!(fill.payout_out_raw, 2_727_272_727u128);
            assert_eq!(fill.refund_in_raw, 0);
        }
    }

    #[test]
    fn test_order_permutation_invariance() {
        let rx_raw = f64_to_raw(100.0, 18);
        let ry_raw = f64_to_raw(300_000.0, 6);
        let orders_a = vec![
            mk_order(1, OrderSide::SellBase, 2.5, 2500.0),
            mk_order(2, OrderSide::BuyBase, 9000.0, 3200.0),
            mk_order(3, OrderSide::SellBase, 1.5, 2700.0),
            mk_order(4, OrderSide::SellBase, 3.0, 3400.0),
        ];
        let orders_b = vec![
            orders_a[3].clone(),
            orders_a[1].clone(),
            orders_a[2].clone(),
            orders_a[0].clone(),
        ];

        let res_a = solve_batch_tokens(rx_raw, ry_raw, 18, 6, &orders_a);
        let res_b = solve_batch_tokens(rx_raw, ry_raw, 18, 6, &orders_b);
        assert_eq!(res_a.clearing_price_wad, res_b.clearing_price_wad);
        assert_eq!(res_a.rx_raw_after, res_b.rx_raw_after);
        assert_eq!(res_a.ry_raw_after, res_b.ry_raw_after);
    }

    #[test]
    fn test_balanced_cow_zero_slippage_zero_pool_impact() {
        let rx_raw = f64_to_raw(100.0, 18);
        let ry_raw = f64_to_raw(300_000.0, 6);
        let orders = vec![
            mk_order(1, OrderSide::SellBase, 2.0, 2800.0),
            mk_order(2, OrderSide::SellBase, 3.0, 2900.0),
            mk_order(3, OrderSide::BuyBase, 6_000.0, 3200.0),
            mk_order(4, OrderSide::BuyBase, 9_000.0, 3100.0),
        ];

        let res = solve_batch_tokens(rx_raw, ry_raw, 18, 6, &orders);
        assert_eq!(res.clearing_price_wad, 3_000 * WAD);
        assert_eq!(res.cow_matched_base_norm, 5 * WAD);
        assert_eq!(res.cow_matched_quote_norm, 15_000 * WAD);
        assert_eq!(res.rx_raw_after, rx_raw);
        assert_eq!(res.ry_raw_after, ry_raw);
    }

    #[test]
    fn test_marginal_limit_price_pinning_and_pro_rata_partial_fills() {
        let rx_raw = f64_to_raw(100.0, 18);
        let ry_raw = f64_to_raw(300_000.0, 6);
        // Two sellers at 2800.0 offering 5 ETH each (10 ETH total); full fill would push p* to 2500 < 2800!
        let orders = vec![
            mk_order(1, OrderSide::SellBase, 5.0, 2800.0),
            mk_order(2, OrderSide::SellBase, 5.0, 2800.0),
            mk_order(3, OrderSide::SellBase, 2.0, 3200.0), // OTM -> 100% refund
        ];

        let res = solve_batch_tokens(rx_raw, ry_raw, 18, 6, &orders);
        assert_eq!(res.clearing_price_wad, 2_800 * WAD);
        assert!(res.lnd_invariant_holds);

        assert_eq!(res.raw_fills[0].status, FillStatus::PartialFill);
        assert_eq!(res.raw_fills[1].status, FillStatus::PartialFill);
        assert_eq!(
            res.raw_fills[0].amount_filled_raw,
            res.raw_fills[1].amount_filled_raw
        );
        assert_eq!(
            res.raw_fills[0].amount_filled_raw + res.raw_fills[0].refund_in_raw,
            res.raw_fills[0].amount_in_raw
        );
        assert_eq!(res.raw_fills[2].status, FillStatus::OutOfMoneyRefund);
        assert_eq!(res.raw_fills[2].refund_in_raw, res.raw_fills[2].amount_in_raw);
    }

    #[test]
    fn test_pure_p2p_zero_reserves_mode() {
        let orders = vec![
            mk_order(1, OrderSide::SellBase, 4.0, 2900.0),
            mk_order(2, OrderSide::BuyBase, 12_000.0, 3100.0),
        ];
        let res = solve_batch_tokens(0, 0, 18, 6, &orders);
        assert_eq!(res.clearing_price_wad, 3_000 * WAD);
        assert_eq!(res.rx_raw_after, 0);
        assert_eq!(res.ry_raw_after, 0);
        assert_eq!(res.raw_fills[0].payout_out_raw, 12_000_000_000);
        assert_eq!(res.raw_fills[1].payout_out_raw, 4 * WAD);
    }

    #[test]
    fn test_counterexample_a_buyer_denominator_floor_truncation_lnd() {
        // 18d/18d: rx = 3*WAD, ry = 10_000*WAD; Seller 30_000*WAD @ 0, Buyer 100_000_000*WAD @ 5_000*WAD
        let orders = vec![
            ClearingOrder {
                order_id: 1,
                arrival_index: 1,
                trader: format!("0x{:040x}", 1),
                label: "Seller".to_string(),
                side: OrderSide::SellBase,
                amount_in_raw: 30_000 * WAD,
                limit_price_wad: 0,
                is_attacker: false,
            },
            ClearingOrder {
                order_id: 2,
                arrival_index: 2,
                trader: format!("0x{:040x}", 2),
                label: "Buyer".to_string(),
                side: OrderSide::BuyBase,
                amount_in_raw: 100_000_000 * WAD,
                limit_price_wad: 5_000 * WAD,
                is_attacker: false,
            },
        ];

        let res = solve_batch_tokens(3 * WAD, 10_000 * WAD, 18, 18, &orders);
        assert_eq!(
            res.clearing_price_wad,
            3_333_333_333_333_333_333_333u128
        );
        assert!(res.lnd_invariant_holds);
        assert!(res.rx_raw_after >= 3 * WAD);
        assert!(res.ry_raw_after >= 10_000 * WAD);
    }

    #[test]
    fn test_counterexample_b_buyer_denominator_tiny_reserve_solvency() {
        // 18d/18d: rx = 1, ry = 3_333; Seller 30_000*WAD @ 0, Buyer 100_000_000*WAD @ 5_000*WAD
        let orders = vec![
            ClearingOrder {
                order_id: 1,
                arrival_index: 1,
                trader: format!("0x{:040x}", 1),
                label: "Seller".to_string(),
                side: OrderSide::SellBase,
                amount_in_raw: 30_000 * WAD,
                limit_price_wad: 0,
                is_attacker: false,
            },
            ClearingOrder {
                order_id: 2,
                arrival_index: 2,
                trader: format!("0x{:040x}", 2),
                label: "Buyer".to_string(),
                side: OrderSide::BuyBase,
                amount_in_raw: 100_000_000 * WAD,
                limit_price_wad: 5_000 * WAD,
                is_attacker: false,
            },
        ];

        let res = solve_batch_tokens(1, 3_333, 18, 18, &orders);
        assert!(res.lnd_invariant_holds);
        assert!(res.raw_fills[1].payout_out_raw <= 1 + 30_000 * WAD);
    }

    #[test]
    fn test_counterexample_c_pinned_marginal_tier_pro_rata_input_truncation_lnd() {
        // 18d/18d: rx = 100*WAD, ry = 100*WAD; 1 Seller 30_000*WAD @ 0.9*WAD, 7 Buyers 5_000*WAD @ 1.0*WAD
        let mut orders = vec![ClearingOrder {
            order_id: 1,
            arrival_index: 1,
            trader: format!("0x{:040x}", 1),
            label: "Seller".to_string(),
            side: OrderSide::SellBase,
            amount_in_raw: 30_000 * WAD,
            limit_price_wad: 900_000_000_000_000_000u128,
            is_attacker: false,
        }];
        for id in 2..=8 {
            orders.push(ClearingOrder {
                order_id: id,
                arrival_index: id as usize,
                trader: format!("0x{:040x}", id),
                label: format!("Buyer{id}"),
                side: OrderSide::BuyBase,
                amount_in_raw: 5_000 * WAD,
                limit_price_wad: WAD,
                is_attacker: false,
            });
        }

        let res = solve_batch_tokens(100 * WAD, 100 * WAD, 18, 18, &orders);
        assert_eq!(res.clearing_price_wad, WAD);
        assert!(res.lnd_invariant_holds);
    }

    #[test]
    fn test_six_decimal_dust_zero_output_refunded_in_pass1() {
        // 1,000 wei WETH sold against 100 WETH / 300,000 USDC (6d):
        // 1,000 * 3000 / 10^12 = 0 raw USDC -> must zero fill in Pass 1 and refund 100%
        let rx_raw = f64_to_raw(100.0, 18);
        let ry_raw = f64_to_raw(300_000.0, 6);
        let orders = vec![ClearingOrder {
            order_id: 1,
            arrival_index: 1,
            trader: format!("0x{:040x}", 1),
            label: "DustSeller".to_string(),
            side: OrderSide::SellBase,
            amount_in_raw: 1_000,
            limit_price_wad: 0,
            is_attacker: false,
        }];

        let res = solve_batch_tokens(rx_raw, ry_raw, 18, 6, &orders);
        assert_eq!(res.raw_fills[0].status, FillStatus::OutOfMoneyRefund);
        assert_eq!(res.raw_fills[0].amount_filled_raw, 0);
        assert_eq!(res.raw_fills[0].payout_out_raw, 0);
        assert_eq!(res.raw_fills[0].refund_in_raw, 1_000);
        assert_eq!(res.rx_raw_after, rx_raw);
        assert_eq!(res.ry_raw_after, ry_raw);
    }
}
