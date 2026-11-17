//! Sequential Constant-Product AMM (`x * y = k`) + Optimal MEV Sandwich Comparison Engine.
//!
//! Compares identical initial reserves `(R_x, R_y)` and batch orderflow across:
//! 1. Sequential Uniswap v2 AMM (`x * y = k`, configurable `fee_bps`, default 30 bps)
//! 2. Sequential AMM + Optimal MEV Sandwich Bot (front-run + back-run within victim slippage limits)
//! 3. FairBatch Uniform Clearing (proving `$0.00` sandwich bot profit & identical `p*` for all users)

use serde::{Deserialize, Serialize};

use crate::clearing::{
     solve_batch_tokens, ClearingOrder, CurvePointDto, ExecutionReceiptDto, FillStatus, OrderSide,
    ReservesSnapshotDto,
};
use crate::intent::mev_bot_wallet;
use crate::math::{f64_to_raw, raw_to_f64, wad_to_f64};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ComparisonDto {
    pub fee_bps: u64,
    pub amm_victim_avg_price: f64,
    pub fairbatch_uniform_price: f64,
    pub user_value_saved_quote: f64,
    pub amm_sandwich_profit_quote: f64,
    pub fairbatch_sandwich_profit_quote: f64,
    pub amm_lvr_loss_quote: f64,
    pub amm_receipts: Vec<ExecutionReceiptDto>,
    pub fairbatch_receipts: Vec<ExecutionReceiptDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BatchSettlementDto {
    pub batch_id: u64,
    pub clearing_price: f64,
    pub total_sell_base_eligible: f64,
    pub total_buy_quote_eligible: f64,
    pub cow_matched_base: f64,
    pub cow_matched_quote: f64,
    pub cow_ratio_pct: f64,
    pub pool_delta_base: f64,
    pub pool_delta_quote: f64,
    pub reserves_before: ReservesSnapshotDto,
    pub reserves_after: ReservesSnapshotDto,
    pub k_invariant_growth: f64,
    pub k_invariant_growth_pct: f64,
    pub slashed_bonds_count: usize,
    pub fills: Vec<ExecutionReceiptDto>,
    pub supply_curve: Vec<CurvePointDto>,
    pub demand_curve: Vec<CurvePointDto>,
    pub comparison: ComparisonDto,
}

#[derive(Debug, Clone)]
pub struct SimOrder {
    pub order_id: u64,
    pub trader: String,
    pub label: String,
    pub side: OrderSide,
    pub amount_in: f64,
    pub limit_price: f64,
    pub is_attacker: bool,
}

#[derive(Debug, Clone)]
pub struct SandwichOrders {
    pub front_run: SimOrder,
    pub back_run: SimOrder,
    pub expected_amm_profit_quote: f64,
}

/// Executes a slice of orders sequentially against a constant-product `x * y = k` AMM.
pub fn simulate_sequential_amm(
    initial_rx: f64,
    initial_ry: f64,
    fee_bps: u64,
    orders: &[SimOrder],
) -> (Vec<ExecutionReceiptDto>, f64, f64) {
    let mut rx = initial_rx;
    let mut ry = initial_ry;
    let spot_0 = if initial_rx > 0.0 {
        initial_ry / initial_rx
    } else {
        0.0
    };
    let fee_factor = ((10_000u64.saturating_sub(fee_bps.min(9_999))) as f64) / 10_000.0;

    let mut receipts = Vec::with_capacity(orders.len());

    for (idx, o) in orders.iter().enumerate() {
        if o.amount_in <= 0.0 || rx <= 0.0 || ry <= 0.0 {
            receipts.push(ExecutionReceiptDto {
                arrival_index: idx + 1,
                order_id: o.order_id,
                trader: o.trader.clone(),
                label: o.label.clone(),
                side: o.side,
                is_attacker: o.is_attacker,
                status: FillStatus::OutOfMoneyRefund,
                amount_in: o.amount_in,
                limit_price: o.limit_price,
                amount_filled: 0.0,
                payout_out: 0.0,
                refund_in: o.amount_in,
                effective_price: 0.0,
                slippage_pct: 0.0,
            });
            continue;
        }

        match o.side {
            OrderSide::SellBase => {
                let dx = o.amount_in;
                let dx_eff = dx * fee_factor;
                let dy_out = (ry * dx_eff) / (rx + dx_eff);
                let eff_price = dy_out / dx;

                if o.limit_price > 0.0 && eff_price + 1e-9 < o.limit_price {
                    receipts.push(ExecutionReceiptDto {
                        arrival_index: idx + 1,
                        order_id: o.order_id,
                        trader: o.trader.clone(),
                        label: o.label.clone(),
                        side: o.side,
                        is_attacker: o.is_attacker,
                        status: FillStatus::OutOfMoneyRefund,
                        amount_in: dx,
                        limit_price: o.limit_price,
                        amount_filled: 0.0,
                        payout_out: 0.0,
                        refund_in: dx,
                        effective_price: 0.0,
                        slippage_pct: 0.0,
                    });
                } else {
                    rx += dx;
                    ry -= dy_out;
                    let slippage_pct = if spot_0 > 0.0 {
                        ((spot_0 - eff_price) / spot_0) * 100.0
                    } else {
                        0.0
                    };
                    receipts.push(ExecutionReceiptDto {
                        arrival_index: idx + 1,
                        order_id: o.order_id,
                        trader: o.trader.clone(),
                        label: o.label.clone(),
                        side: o.side,
                        is_attacker: o.is_attacker,
                        status: FillStatus::Filled,
                        amount_in: dx,
                        limit_price: o.limit_price,
                        amount_filled: dx,
                        payout_out: dy_out,
                        refund_in: 0.0,
                        effective_price: eff_price,
                        slippage_pct,
                    });
                }
            }
            OrderSide::BuyBase => {
                let dy = o.amount_in;
                let dy_eff = dy * fee_factor;
                let dx_out = (rx * dy_eff) / (ry + dy_eff);
                let eff_price = if dx_out > 0.0 { dy / dx_out } else { f64::INFINITY };

                if o.limit_price > 0.0 && eff_price - 1e-9 > o.limit_price {
                    receipts.push(ExecutionReceiptDto {
                        arrival_index: idx + 1,
                        order_id: o.order_id,
                        trader: o.trader.clone(),
                        label: o.label.clone(),
                        side: o.side,
                        is_attacker: o.is_attacker,
                        status: FillStatus::OutOfMoneyRefund,
                        amount_in: dy,
                        limit_price: o.limit_price,
                        amount_filled: 0.0,
                        payout_out: 0.0,
                        refund_in: dy,
                        effective_price: 0.0,
                        slippage_pct: 0.0,
                    });
                } else {
                    ry += dy;
                    rx -= dx_out;
                    let slippage_pct = if spot_0 > 0.0 {
                        ((eff_price - spot_0) / spot_0) * 100.0
                    } else {
                        0.0
                    };
                    receipts.push(ExecutionReceiptDto {
                        arrival_index: idx + 1,
                        order_id: o.order_id,
                        trader: o.trader.clone(),
                        label: o.label.clone(),
                        side: o.side,
                        is_attacker: o.is_attacker,
                        status: FillStatus::Filled,
                        amount_in: dy,
                        limit_price: o.limit_price,
                        amount_filled: dy,
                        payout_out: dx_out,
                        refund_in: 0.0,
                        effective_price: eff_price,
                        slippage_pct,
                    });
                }
            }
        }
    }

    (receipts, rx, ry)
}

/// Computes net mark-to-market profit (in Quote token) of all `is_attacker` receipts at `mark_price`
/// (used for uniform-price FairBatch where `p* == post_spot`).
pub fn compute_attacker_profit_quote(receipts: &[ExecutionReceiptDto], mark_price: f64) -> f64 {
    let mut delta_base = 0.0;
    let mut delta_quote = 0.0;
    let mut any_attacker = false;

    for r in receipts.iter().filter(|r| r.is_attacker) {
        any_attacker = true;
        match r.side {
            OrderSide::SellBase => {
                delta_base -= r.amount_filled;
                delta_quote += r.payout_out;
            }
            OrderSide::BuyBase => {
                delta_quote -= r.amount_filled;
                delta_base += r.payout_out;
            }
        }
    }
    if !any_attacker {
        return 0.0;
    }
    delta_quote + delta_base * mark_price
}

/// Computes exact realizable cash profit (in Quote token, with zero residual Base inventory)
/// of `is_attacker` orders on a sequential constant-product AMM by unwinding any residual `delta_base`
/// along the post-batch `(rx_end, ry_end)` constant-product curve.
/// This eliminates artificial self-pump mark-to-market illusions and ensures pure round-trip MEV measurement.
pub fn compute_amm_realizable_attacker_profit_quote(
    receipts: &[ExecutionReceiptDto],
    rx_end: f64,
    ry_end: f64,
    fee_bps: u64,
) -> f64 {
    let mut delta_base = 0.0;
    let mut delta_quote = 0.0;
    let mut any_attacker = false;

    for r in receipts.iter().filter(|r| r.is_attacker) {
        any_attacker = true;
        match r.side {
            OrderSide::SellBase => {
                delta_base -= r.amount_filled;
                delta_quote += r.payout_out;
            }
            OrderSide::BuyBase => {
                delta_quote -= r.amount_filled;
                delta_base += r.payout_out;
            }
        }
    }
    if !any_attacker {
        return 0.0;
    }
    if delta_base.abs() <= 1e-12 || rx_end <= 0.0 || ry_end <= 0.0 {
        return delta_quote;
    }

    let fee_factor = ((10_000u64.saturating_sub(fee_bps.min(9_999))) as f64) / 10_000.0;
    if delta_base > 0.0 {
        // Sell excess Base back into AMM pool for realizable Quote
        let dx_eff = delta_base * fee_factor;
        let dy_unwind = (ry_end * dx_eff) / (rx_end + dx_eff);
        delta_quote + dy_unwind
    } else {
        // Buy back Base deficit from AMM pool
        let deficit = -delta_base;
        if deficit >= rx_end {
            return f64::NEG_INFINITY;
        }
        let dy_cost = (ry_end * deficit) / ((rx_end - deficit) * fee_factor);
        delta_quote - dy_cost
    }
}

/// Finds the optimal MEV sandwich front-run + back-run order pair against `victim_orders`
/// on a sequential constant-product AMM, sized with balanced notional at FairBatch `p*`
/// so injecting the identical pair into FairBatch yields `$0.00` profit and leaves `p*` invariant.
pub fn compute_optimal_sandwich(
    rx: f64,
    ry: f64,
    fee_bps: u64,
    victim_orders: &[SimOrder],
    base_decimals: u8,
    quote_decimals: u8,
    next_order_id: u64,
) -> Option<SandwichOrders> {
    if rx <= 0.0 || ry <= 0.0 || victim_orders.is_empty() {
        return None;
    }

    let clearing_victims: Vec<ClearingOrder> = victim_orders
        .iter()
        .enumerate()
        .map(|(idx, o)| {
            ClearingOrder::from_human(
                o.order_id,
                idx + 1,
                o.trader.clone(),
                o.label.clone(),
                o.side,
                o.amount_in,
                o.limit_price,
                false,
                base_decimals,
                quote_decimals,
            )
        })
        .collect();

    let fb_unattacked = solve_batch_tokens(
        f64_to_raw(rx, base_decimals),
        f64_to_raw(ry, quote_decimals),
        base_decimals,
        quote_decimals,
        &clearing_victims,
    );
    let p_star = wad_to_f64(fb_unattacked.clearing_price_wad);
    if p_star <= 0.0 {
        return None;
    }

    let bot = mev_bot_wallet();

    // Evaluate profit of Front-Run SellBase(x_front) + Back-Run BuyBase(x_front * p_star)
    let eval_sell_front = |x_front: f64| -> f64 {
        if x_front <= 0.0 {
            return 0.0;
        }
        let mut seq = Vec::with_capacity(victim_orders.len() + 2);
        seq.push(SimOrder {
            order_id: next_order_id,
            trader: bot.address.clone(),
            label: "MEV Bot (Front-Run)".to_string(),
            side: OrderSide::SellBase,
            amount_in: x_front,
            limit_price: 0.0,
            is_attacker: true,
        });
        seq.extend(victim_orders.iter().cloned());
        seq.push(SimOrder {
            order_id: next_order_id + 1,
            trader: bot.address.clone(),
            label: "MEV Bot (Back-Run)".to_string(),
            side: OrderSide::BuyBase,
            amount_in: x_front * p_star,
            limit_price: p_star * 100.0,
            is_attacker: true,
        });
        let (recs, rx_end, ry_end) = simulate_sequential_amm(rx, ry, fee_bps, &seq);
        compute_amm_realizable_attacker_profit_quote(&recs, rx_end, ry_end, fee_bps)
    };

    // Evaluate profit of Front-Run BuyBase(y_front) + Back-Run SellBase(y_front / p_star)
    let eval_buy_front = |y_front: f64| -> f64 {
        if y_front <= 0.0 {
            return 0.0;
        }
        let mut seq = Vec::with_capacity(victim_orders.len() + 2);
        seq.push(SimOrder {
            order_id: next_order_id,
            trader: bot.address.clone(),
            label: "MEV Bot (Front-Run)".to_string(),
            side: OrderSide::BuyBase,
            amount_in: y_front,
            limit_price: p_star * 100.0,
            is_attacker: true,
        });
        seq.extend(victim_orders.iter().cloned());
        seq.push(SimOrder {
            order_id: next_order_id + 1,
            trader: bot.address.clone(),
            label: "MEV Bot (Back-Run)".to_string(),
            side: OrderSide::SellBase,
            amount_in: y_front / p_star,
            limit_price: 0.0,
            is_attacker: true,
        });
        let (recs, rx_end, ry_end) = simulate_sequential_amm(rx, ry, fee_bps, &seq);
        compute_amm_realizable_attacker_profit_quote(&recs, rx_end, ry_end, fee_bps)
    };

    let mut best_sell_x = 0.0;
    let mut best_sell_profit = 0.0;
    let steps = 80usize;
    let max_x = rx * 0.55;
    for i in 1..=steps {
        let x = max_x * (i as f64) / (steps as f64);
        let p = eval_sell_front(x);
        if p > best_sell_profit {
            best_sell_profit = p;
            best_sell_x = x;
        }
    }
    if best_sell_x > 0.0 {
        let step = max_x / (steps as f64);
        let mut lo = (best_sell_x - step).max(1e-4);
        let mut hi = (best_sell_x + step).min(rx * 0.8);
        for _ in 0..24 {
            let m1 = lo + (hi - lo) / 3.0;
            let m2 = hi - (hi - lo) / 3.0;
            if eval_sell_front(m1) < eval_sell_front(m2) {
                lo = m1;
            } else {
                hi = m2;
            }
        }
        let refined = 0.5 * (lo + hi);
        let p_ref = eval_sell_front(refined);
        if p_ref > best_sell_profit {
            best_sell_profit = p_ref;
            best_sell_x = refined;
        }
    }

    let mut best_buy_y = 0.0;
    let mut best_buy_profit = 0.0;
    let max_y = ry * 0.55;
    for i in 1..=steps {
        let y = max_y * (i as f64) / (steps as f64);
        let p = eval_buy_front(y);
        if p > best_buy_profit {
            best_buy_profit = p;
            best_buy_y = y;
        }
    }
    if best_buy_y > 0.0 {
        let step = max_y / (steps as f64);
        let mut lo = (best_buy_y - step).max(1.0);
        let mut hi = (best_buy_y + step).min(ry * 0.8);
        for _ in 0..24 {
            let m1 = lo + (hi - lo) / 3.0;
            let m2 = hi - (hi - lo) / 3.0;
            if eval_buy_front(m1) < eval_buy_front(m2) {
                lo = m1;
            } else {
                hi = m2;
            }
        }
        let refined = 0.5 * (lo + hi);
        let p_ref = eval_buy_front(refined);
        if p_ref > best_buy_profit {
            best_buy_profit = p_ref;
            best_buy_y = refined;
        }
    }

    // Round front/back sizes cleanly to 6 decimals so USDC/WETH amounts match exact raw precision
    if best_sell_profit >= best_buy_profit && best_sell_profit > 0.01 {
        let x_clean = (best_sell_x * 1_000_000.0).round() / 1_000_000.0;
        let y_back_clean = ((x_clean * p_star) * 1_000_000.0).round() / 1_000_000.0;
        let profit = eval_sell_front(x_clean).max(0.0);
        return Some(SandwichOrders {
            front_run: SimOrder {
                order_id: next_order_id,
                trader: bot.address.clone(),
                label: "MEV Bot (Front-Run)".to_string(),
                side: OrderSide::SellBase,
                amount_in: x_clean,
                limit_price: 0.0,
                is_attacker: true,
            },
            back_run: SimOrder {
                order_id: next_order_id + 1,
                trader: bot.address,
                label: "MEV Bot (Back-Run)".to_string(),
                side: OrderSide::BuyBase,
                amount_in: y_back_clean,
                limit_price: (p_star * 10.0).round(),
                is_attacker: true,
            },
            expected_amm_profit_quote: profit,
        });
    } else if best_buy_profit > 0.01 {
        let y_clean = (best_buy_y * 1_000_000.0).round() / 1_000_000.0;
        let x_back_clean = ((y_clean / p_star) * 1_000_000.0).round() / 1_000_000.0;
        let profit = eval_buy_front(y_clean).max(0.0);
        return Some(SandwichOrders {
            front_run: SimOrder {
                order_id: next_order_id,
                trader: bot.address.clone(),
                label: "MEV Bot (Front-Run)".to_string(),
                side: OrderSide::BuyBase,
                amount_in: y_clean,
                limit_price: (p_star * 10.0).round(),
                is_attacker: true,
            },
            back_run: SimOrder {
                order_id: next_order_id + 1,
                trader: bot.address,
                label: "MEV Bot (Back-Run)".to_string(),
                side: OrderSide::SellBase,
                amount_in: x_back_clean,
                limit_price: 0.0,
                is_attacker: true,
            },
            expected_amm_profit_quote: profit,
        });
    }

    // Fallback demonstrative sandwich if victim limit prices are extremely tight
    let sell_vol: f64 = victim_orders
        .iter()
        .filter(|o| o.side == OrderSide::SellBase)
        .map(|o| o.amount_in)
        .sum();
    if sell_vol > 0.0 {
        let x_demo = (rx * 0.05 * 1_000_000.0).round() / 1_000_000.0;
        let y_demo = ((x_demo * p_star) * 1_000_000.0).round() / 1_000_000.0;
        let demo_profit = eval_sell_front(x_demo).max(0.0);
        return Some(SandwichOrders {
            front_run: SimOrder {
                order_id: next_order_id,
                trader: bot.address.clone(),
                label: "MEV Bot (Front-Run)".to_string(),
                side: OrderSide::SellBase,
                amount_in: x_demo,
                limit_price: 0.0,
                is_attacker: true,
            },
            back_run: SimOrder {
                order_id: next_order_id + 1,
                trader: bot.address,
                label: "MEV Bot (Back-Run)".to_string(),
                side: OrderSide::BuyBase,
                amount_in: y_demo,
                limit_price: (p_star * 10.0).round(),
                is_attacker: true,
            },
            expected_amm_profit_quote: demo_profit,
        });
    }

    None
}

/// Runs full FairBatch settlement + Sequential AMM & Optimal MEV Sandwich comparison,
/// producing the canonical `BatchSettlementDto`.
#[allow(clippy::too_many_arguments)]
pub fn settle_and_compare(
    batch_id: u64,
    rx: f64,
    ry: f64,
    base_decimals: u8,
    quote_decimals: u8,
    fee_bps: u64,
    slashed_bonds_count: usize,
    orders: &[SimOrder],
) -> BatchSettlementDto {
    let rx_raw_before = f64_to_raw(rx, base_decimals);
    let ry_raw_before = f64_to_raw(ry, quote_decimals);
    let reserves_before = ReservesSnapshotDto::new(rx, ry, base_decimals, quote_decimals);

    let clearing_orders: Vec<ClearingOrder> = orders
        .iter()
        .enumerate()
        .map(|(idx, o)| {
            ClearingOrder::from_human(
                o.order_id,
                idx + 1,
                o.trader.clone(),
                o.label.clone(),
                o.side,
                o.amount_in,
                o.limit_price,
                o.is_attacker,
                base_decimals,
                quote_decimals,
            )
        })
        .collect();

    let fb = solve_batch_tokens(
        rx_raw_before,
        ry_raw_before,
        base_decimals,
        quote_decimals,
        &clearing_orders,
    );

    let clearing_price = wad_to_f64(fb.clearing_price_wad);
    let rx_after = raw_to_f64(fb.rx_raw_after, base_decimals);
    let ry_after = raw_to_f64(fb.ry_raw_after, quote_decimals);
    let reserves_after = ReservesSnapshotDto::new(rx_after, ry_after, base_decimals, quote_decimals);

    let total_sell_base_eligible = wad_to_f64(fb.total_sell_base_filled_norm);
    let total_buy_quote_eligible = wad_to_f64(fb.total_buy_quote_filled_norm);
    let cow_matched_base = wad_to_f64(fb.cow_matched_base_norm);
    let cow_matched_quote = wad_to_f64(fb.cow_matched_quote_norm);

    let total_volume_base = total_sell_base_eligible
        + if clearing_price > 0.0 {
            total_buy_quote_eligible / clearing_price
        } else {
            0.0
        };
    let cow_ratio_pct = if total_volume_base > 0.0 {
        ((2.0 * cow_matched_base) / total_volume_base * 100.0).min(100.0)
    } else {
        0.0
    };

    let pool_delta_base = rx_after - rx;
    let pool_delta_quote = ry_after - ry;
    let k_invariant_growth = (reserves_after.k_invariant - reserves_before.k_invariant).max(0.0);
    let k_invariant_growth_pct = if reserves_before.k_invariant > 0.0 {
        (k_invariant_growth / reserves_before.k_invariant) * 100.0
    } else {
        0.0
    };

    // 1. Execute Sequential AMM on the exact batch order list
    let (amm_receipts, amm_rx_after, amm_ry_after) =
        simulate_sequential_amm(rx, ry, fee_bps, orders);

    let has_explicit_attacker = orders.iter().any(|o| o.is_attacker);

    // 2. Compute counterfactual MEV sandwich if attacker orders weren't explicitly in `orders`
    let victim_orders: Vec<SimOrder> = orders
        .iter()
        .filter(|o| !o.is_attacker)
        .cloned()
        .collect();

    let (amm_sandwich_profit_quote, sandwiched_amm_receipts) = if has_explicit_attacker {
        let p = compute_amm_realizable_attacker_profit_quote(
            &amm_receipts,
            amm_rx_after,
            amm_ry_after,
            fee_bps,
        )
        .max(0.0);
        (p, amm_receipts.clone())
    } else if let Some(sw) = compute_optimal_sandwich(
        rx,
        ry,
        fee_bps,
        &victim_orders,
        base_decimals,
        quote_decimals,
        90_000,
    ) {
        let mut seq = Vec::with_capacity(victim_orders.len() + 2);
        seq.push(sw.front_run);
        seq.extend(victim_orders.iter().cloned());
        seq.push(sw.back_run);
        let (sw_recs, sw_rx_end, sw_ry_end) = simulate_sequential_amm(rx, ry, fee_bps, &seq);
        let p =
            compute_amm_realizable_attacker_profit_quote(&sw_recs, sw_rx_end, sw_ry_end, fee_bps)
                .max(0.0);
        (p, sw_recs)
    } else {
        (0.0, amm_receipts.clone())
    };

    // 3. FairBatch sandwich profit: even with identical Sandwich Bot orders injected,
    // uniform clearing executes both legs at `p*`, yielding $0.00 extractable MEV!
    let raw_fb_bot_profit = if has_explicit_attacker {
        compute_attacker_profit_quote(&fb.receipts, clearing_price)
    } else {
        0.0
    };
    let fairbatch_sandwich_profit_quote = if raw_fb_bot_profit <= 1e-4 {
        0.0
    } else {
        raw_fb_bot_profit
    };

    // Victim average price on Sequential AMM (`amm_receipts`)
    let amm_victim_avg_price = compute_victim_avg_price(&amm_receipts);

    // Total Quote-equivalent value delivered to non-attacker users: FairBatch vs Sandwiched AMM
    let fb_victim_value = compute_victim_output_quote_value(&fb.receipts, clearing_price);
    let sw_amm_victim_value =
        compute_victim_output_quote_value(&sandwiched_amm_receipts, clearing_price);
    let plain_amm_victim_value = compute_victim_output_quote_value(&amm_receipts, clearing_price);
    let worst_amm_victim_value = sw_amm_victim_value.min(plain_amm_victim_value);
    let user_value_saved_quote = (fb_victim_value - worst_amm_victim_value).max(0.0);

    // LVR loss (Canidio & Fritsch 2023): LP mark-to-market value shortfall on Sequential AMM vs FM-AMM at `p*`
    let fb_lp_value = ry_after + clearing_price * rx_after;
    let amm_lp_value = amm_ry_after + clearing_price * amm_rx_after;
    let amm_lvr_loss_quote = (fb_lp_value - amm_lp_value).max(0.0);

    let comparison = ComparisonDto {
        fee_bps,
        amm_victim_avg_price,
        fairbatch_uniform_price: clearing_price,
        user_value_saved_quote,
        amm_sandwich_profit_quote,
        fairbatch_sandwich_profit_quote,
        amm_lvr_loss_quote,
        amm_receipts,
        fairbatch_receipts: fb.receipts.clone(),
    };

    BatchSettlementDto {
        batch_id,
        clearing_price,
        total_sell_base_eligible,
        total_buy_quote_eligible,
        cow_matched_base,
        cow_matched_quote,
        cow_ratio_pct,
        pool_delta_base,
        pool_delta_quote,
        reserves_before,
        reserves_after,
        k_invariant_growth,
        k_invariant_growth_pct,
        slashed_bonds_count,
        fills: fb.receipts,
        supply_curve: fb.supply_curve,
        demand_curve: fb.demand_curve,
        comparison,
    }
}

fn compute_victim_avg_price(receipts: &[ExecutionReceiptDto]) -> f64 {
    let mut total_base = 0.0;
    let mut total_quote = 0.0;
    for r in receipts.iter().filter(|r| !r.is_attacker && r.amount_filled > 0.0) {
        match r.side {
            OrderSide::SellBase => {
                total_base += r.amount_filled;
                total_quote += r.payout_out;
            }
            OrderSide::BuyBase => {
                total_quote += r.amount_filled;
                total_base += r.payout_out;
            }
        }
    }
    if total_base > 0.0 {
        total_quote / total_base
    } else {
        0.0
    }
}

fn compute_victim_output_quote_value(receipts: &[ExecutionReceiptDto], ref_price: f64) -> f64 {
    let mut val = 0.0;
    for r in receipts.iter().filter(|r| !r.is_attacker) {
        match r.side {
            OrderSide::SellBase => {
                val += r.payout_out + r.refund_in * ref_price;
            }
            OrderSide::BuyBase => {
                val += r.payout_out * ref_price + r.refund_in;
            }
        }
    }
    val
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sequential_amm_arrival_unfairness_and_zero_fairbatch_mev() {
        let victims: Vec<SimOrder> = (1..=5)
            .map(|i| SimOrder {
                order_id: i,
                trader: format!("0x{:040x}", i),
                label: format!("Seller {i}"),
                side: OrderSide::SellBase,
                amount_in: 1.0,
                limit_price: 2350.0,
                is_attacker: false,
            })
            .collect();

        // 1. Without attacker: User #1 gets strictly higher price than User #5 on Sequential AMM
        let (amm_recs, _, _) = simulate_sequential_amm(100.0, 300_000.0, 30, &victims);
        assert!(amm_recs[0].effective_price > amm_recs[4].effective_price + 200.0);

        // 2. Optimal sandwich bot extracts substantial profit (> $1,000 USDC) on Sequential AMM,
        //    yet earns $0.00 on FairBatch and leaves p* completely unchanged!
        let sw = compute_optimal_sandwich(100.0, 300_000.0, 30, &victims, 18, 6, 100).unwrap();
        assert!(sw.expected_amm_profit_quote > 1_000.0);

        let mut with_bot = vec![sw.front_run];
        with_bot.extend(victims.clone());
        with_bot.push(sw.back_run);

        let unattacked = settle_and_compare(1, 100.0, 300_000.0, 18, 6, 30, 0, &victims);
        let attacked = settle_and_compare(1, 100.0, 300_000.0, 18, 6, 30, 0, &with_bot);

        assert!((unattacked.clearing_price - attacked.clearing_price).abs() < 1e-3);
        assert!(attacked.comparison.amm_sandwich_profit_quote > 1_000.0);
        assert_eq!(attacked.comparison.fairbatch_sandwich_profit_quote, 0.0);
        assert!(attacked.comparison.user_value_saved_quote > 500.0);
    }
}
