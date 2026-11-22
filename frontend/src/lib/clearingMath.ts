import type {
  BatchSettlementDto,
  ComparisonDto,
  CurvePointDto,
  ExecutionReceiptDto,
  FillOutcomeDto,
  FillStatus,
  OrderDto,
  OrderSide,
  ReserveSnapshotDto,
} from '../types';

const DEFAULT_FEE_BPS = 30;
const EPS = 1e-9;
const MEV_BOT_ADDRESS = '0xDeaDbeefdEAdbeefdEadbEEFdeadbeEFdEaDbeeF';

function floor6(val: number): number {
  if (!Number.isFinite(val) || val <= 0) return 0;
  return Math.floor(val * 1e6 + 1e-7) / 1e6;
}

function snapshotReserves(rx: number, ry: number): ReserveSnapshotDto {
  return {
    rx,
    ry,
    spot_price: rx > EPS ? ry / rx : 0,
    k_invariant: rx * ry,
  };
}

export function buildSupplyDemandCurves(
  orders: OrderDto[],
  spotPrice: number,
): { supply_curve: CurvePointDto[]; demand_curve: CurvePointDto[] } {
  const sellers = [...orders]
    .filter((o) => o.side === 'SellBase' && o.amount_in > 0)
    .sort((a, b) => a.limit_price - b.limit_price || a.order_id - b.order_id);

  const buyers = [...orders]
    .filter((o) => o.side === 'BuyBase' && o.amount_in > 0)
    .sort((a, b) => b.limit_price - a.limit_price || a.order_id - b.order_id);

  const supply_curve: CurvePointDto[] = [];
  let cumSellBase = 0;
  for (const s of sellers) {
    supply_curve.push({
      price: s.limit_price,
      cumulative_base: cumSellBase,
      label: s.label,
    });
    cumSellBase += s.amount_in;
    supply_curve.push({
      price: s.limit_price,
      cumulative_base: cumSellBase,
      label: s.label,
    });
  }

  const demand_curve: CurvePointDto[] = [];
  let cumBuyBase = 0;
  let cumBuyQuote = 0;
  for (const b of buyers) {
    const refPrice = b.limit_price > EPS ? b.limit_price : Math.max(spotPrice, 1);
    demand_curve.push({
      price: b.limit_price,
      cumulative_base: cumBuyBase,
      cumulative_quote: cumBuyQuote,
      label: b.label,
    });
    cumBuyQuote += b.amount_in;
    cumBuyBase += b.amount_in / refPrice;
    demand_curve.push({
      price: b.limit_price,
      cumulative_base: cumBuyBase,
      cumulative_quote: cumBuyQuote,
      label: b.label,
    });
  }

  return { supply_curve, demand_curve };
}

interface EquilibriumResult {
  clearingPrice: number;
  sellerFillFractions: Map<number, number>;
  buyerFillFractions: Map<number, number>;
  totalFilledSellBase: number;
  totalFilledBuyQuote: number;
}

function solveEquilibrium(
  rx: number,
  ry: number,
  orders: OrderDto[],
): EquilibriumResult {
  const sellers = [...orders]
    .filter((o) => o.side === 'SellBase' && o.amount_in > EPS)
    .sort((a, b) => a.limit_price - b.limit_price || a.order_id - b.order_id);

  const buyers = [...orders]
    .filter((o) => o.side === 'BuyBase' && o.amount_in > EPS)
    .sort((a, b) => b.limit_price - a.limit_price || a.order_id - b.order_id);

  const sellerFillFractions = new Map<number, number>();
  const buyerFillFractions = new Map<number, number>();

  if (sellers.length === 0 && buyers.length === 0) {
    return {
      clearingPrice: rx > EPS ? ry / rx : 0,
      sellerFillFractions,
      buyerFillFractions,
      totalFilledSellBase: 0,
      totalFilledBuyQuote: 0,
    };
  }

  if (rx <= EPS && ry <= EPS) {
    const totS = sellers.reduce((acc, s) => acc + s.amount_in, 0);
    const totD = buyers.reduce((acc, b) => acc + b.amount_in, 0);
    if (totS <= EPS || totD <= EPS) {
      return {
        clearingPrice: 0,
        sellerFillFractions,
        buyerFillFractions,
        totalFilledSellBase: 0,
        totalFilledBuyQuote: 0,
      };
    }
    const p = totD / totS;
    let sFill = 0;
    let dFill = 0;
    for (const s of sellers) {
      if (s.limit_price <= p + EPS) {
        sellerFillFractions.set(s.order_id, 1);
        sFill += s.amount_in;
      }
    }
    for (const b of buyers) {
      if (b.limit_price >= p - EPS) {
        buyerFillFractions.set(b.order_id, 1);
        dFill += b.amount_in;
      }
    }
    const effP = sFill > EPS && dFill > EPS ? dFill / sFill : 0;
    return {
      clearingPrice: effP,
      sellerFillFractions,
      buyerFillFractions,
      totalFilledSellBase: effP > 0 ? sFill : 0,
      totalFilledBuyQuote: effP > 0 ? dFill : 0,
    };
  }

  const priceSet = new Set<number>();
  for (const s of sellers) {
    if (s.limit_price > 0) priceSet.add(s.limit_price);
  }
  for (const b of buyers) {
    if (b.limit_price > 0) priceSet.add(b.limit_price);
  }
  const uniquePrices = Array.from(priceSet).sort((a, b) => a - b);
  const boundaries = [0, ...uniquePrices, Number.POSITIVE_INFINITY];

  // 1. Strict open intervals (p_low, p_high)
  for (let i = 0; i < boundaries.length - 1; i++) {
    const low = boundaries[i];
    const high = boundaries[i + 1];
    const sStrict = sellers
      .filter((s) => s.limit_price <= low + EPS)
      .reduce((acc, s) => acc + s.amount_in, 0);
    const dStrict = buyers
      .filter((b) => b.limit_price >= high - EPS)
      .reduce((acc, b) => acc + b.amount_in, 0);

    const denom = rx + 2 * sStrict;
    if (denom > EPS) {
      const pCand = (ry + 2 * dStrict) / denom;
      if (pCand > low + EPS && pCand < high - EPS) {
        for (const s of sellers) {
          if (s.limit_price <= low + EPS) sellerFillFractions.set(s.order_id, 1);
        }
        for (const b of buyers) {
          if (b.limit_price >= high - EPS) buyerFillFractions.set(b.order_id, 1);
        }
        return {
          clearingPrice: pCand,
          sellerFillFractions,
          buyerFillFractions,
          totalFilledSellBase: sStrict,
          totalFilledBuyQuote: dStrict,
        };
      }
    }
  }

  // 2. Pinned limit-price tiers p = p_tier
  for (const pTier of uniquePrices) {
    const strictSellers = sellers.filter((s) => s.limit_price < pTier - EPS);
    const margSellers = sellers.filter((s) => Math.abs(s.limit_price - pTier) <= EPS);
    const strictBuyers = buyers.filter((b) => b.limit_price > pTier + EPS);
    const margBuyers = buyers.filter((b) => Math.abs(b.limit_price - pTier) <= EPS);

    const sStrict = strictSellers.reduce((acc, s) => acc + s.amount_in, 0);
    const sMarg = margSellers.reduce((acc, s) => acc + s.amount_in, 0);
    const dStrict = strictBuyers.reduce((acc, b) => acc + b.amount_in, 0);
    const dMarg = margBuyers.reduce((acc, b) => acc + b.amount_in, 0);

    const excessMax = ry + 2 * (dStrict + dMarg) - pTier * (rx + 2 * sStrict);
    const excessMin = ry + 2 * dStrict - pTier * (rx + 2 * (sStrict + sMarg));

    if (excessMin <= 1e-5 && excessMax >= -1e-5) {
      for (const s of strictSellers) sellerFillFractions.set(s.order_id, 1);
      for (const b of strictBuyers) buyerFillFractions.set(b.order_id, 1);

      const excessBoth =
        ry + 2 * (dStrict + dMarg) - pTier * (rx + 2 * (sStrict + sMarg));

      let sFilled = sStrict;
      let dFilled = dStrict;

      if (Math.abs(excessBoth) <= 1e-5) {
        for (const s of margSellers) sellerFillFractions.set(s.order_id, 1);
        for (const b of margBuyers) buyerFillFractions.set(b.order_id, 1);
        sFilled += sMarg;
        dFilled += dMarg;
      } else if (excessBoth < 0) {
        for (const b of margBuyers) buyerFillFractions.set(b.order_id, 1);
        dFilled += dMarg;
        const targetTotalS = Math.max(
          sStrict,
          ((ry + 2 * dFilled) / pTier - rx) / 2,
        );
        const sMargTarget = Math.max(0, Math.min(sMarg, targetTotalS - sStrict));
        const ratio = sMarg > EPS ? sMargTarget / sMarg : 0;
        for (const s of margSellers) {
          sellerFillFractions.set(s.order_id, ratio);
        }
        sFilled += sMarg * ratio;
      } else {
        for (const s of margSellers) sellerFillFractions.set(s.order_id, 1);
        sFilled += sMarg;
        const targetTotalD = Math.max(
          dStrict,
          (pTier * (rx + 2 * sFilled) - ry) / 2,
        );
        const dMargTarget = Math.max(0, Math.min(dMarg, targetTotalD - dStrict));
        const ratio = dMarg > EPS ? dMargTarget / dMarg : 0;
        for (const b of margBuyers) {
          buyerFillFractions.set(b.order_id, ratio);
        }
        dFilled += dMarg * ratio;
      }

      return {
        clearingPrice: pTier,
        sellerFillFractions,
        buyerFillFractions,
        totalFilledSellBase: sFilled,
        totalFilledBuyQuote: dFilled,
      };
    }
  }

  const fallbackSpot = rx > EPS ? ry / rx : 0;
  return {
    clearingPrice: fallbackSpot,
    sellerFillFractions,
    buyerFillFractions,
    totalFilledSellBase: 0,
    totalFilledBuyQuote: 0,
  };
}

/**
 * Simulates a constant-product x*y=k sequential AMM with `feeBps` (default 30 bps).
 * Orders execute strictly in arrival order against moving reserves (rx, ry).
 */
export function simulateSequentialAmm(
  initialRx: number,
  initialRy: number,
  orders: OrderDto[],
  feeBps = DEFAULT_FEE_BPS,
  injectVirtualSandwich = false,
): {
  ammReceipts: ExecutionReceiptDto[];
  ammVictimAvgPrice: number;
  ammSandwichProfitQuote: number;
  ammLvrLossQuote: number;
} {
  const feeMult = (10_000 - feeBps) / 10_000;
  const spot0 = initialRx > EPS ? initialRy / initialRx : 0;

  const hasExplicitAttacker = orders.some((o) => o.is_attacker);
  const victimOrders = orders.filter((o) => !o.is_attacker);
  let simOrders: OrderDto[] = [...orders];

  if (
    injectVirtualSandwich &&
    !hasExplicitAttacker &&
    victimOrders.length > 0 &&
    initialRx > EPS &&
    initialRy > EPS
  ) {
    const netSellBase = victimOrders
      .filter((o) => o.side === 'SellBase')
      .reduce((acc, o) => acc + o.amount_in, 0);
    const netBuyQuote = victimOrders
      .filter((o) => o.side === 'BuyBase')
      .reduce((acc, o) => acc + o.amount_in, 0);

    if (netSellBase * spot0 >= netBuyQuote) {
      const frontSell = Math.max(1, Math.min(initialRx * 0.15, Math.max(netSellBase * 2.5, 5)));
      simOrders = [
        {
          order_id: 9001,
          trader: MEV_BOT_ADDRESS,
          label: 'MEV Bot (Front-Run)',
          side: 'SellBase',
          amount_in: frontSell,
          limit_price: 1,
          submission_type: 'Direct',
          is_attacker: true,
        },
        ...victimOrders,
        {
          order_id: 9002,
          trader: MEV_BOT_ADDRESS,
          label: 'MEV Bot (Back-Run)',
          side: 'BuyBase',
          amount_in: frontSell * spot0,
          limit_price: spot0 * 2,
          submission_type: 'Direct',
          is_attacker: true,
        },
      ];
    } else {
      const frontBuyQuote = Math.max(
        3_000,
        Math.min(initialRy * 0.15, Math.max(netBuyQuote * 2.5, 10_000)),
      );
      simOrders = [
        {
          order_id: 9001,
          trader: MEV_BOT_ADDRESS,
          label: 'MEV Bot (Front-Run)',
          side: 'BuyBase',
          amount_in: frontBuyQuote,
          limit_price: spot0 * 2,
          submission_type: 'Direct',
          is_attacker: true,
        },
        ...victimOrders,
        {
          order_id: 9002,
          trader: MEV_BOT_ADDRESS,
          label: 'MEV Bot (Back-Run)',
          side: 'SellBase',
          amount_in: frontBuyQuote / spot0,
          limit_price: 1,
          submission_type: 'Direct',
          is_attacker: true,
        },
      ];
    }
  }

  let rx = initialRx;
  let ry = initialRy;
  const ammReceipts: ExecutionReceiptDto[] = [];

  let botBaseDelta = 0;
  let botQuoteDelta = 0;

  const attackerOrders = simOrders.filter((o) => o.is_attacker);
  const isSellSandwich =
    attackerOrders.length >= 2 &&
    attackerOrders[0].side === 'SellBase' &&
    attackerOrders[attackerOrders.length - 1].side === 'BuyBase';
  const isBuySandwich =
    attackerOrders.length >= 2 &&
    attackerOrders[0].side === 'BuyBase' &&
    attackerOrders[attackerOrders.length - 1].side === 'SellBase';

  let frontSoldBase = 0;
  let frontBoughtBase = 0;

  simOrders.forEach((order, idx) => {
    const preSpot = rx > EPS ? ry / rx : spot0;

    if (order.side === 'SellBase') {
      const sellAmt =
        order.is_attacker &&
        isBuySandwich &&
        idx === simOrders.length - 1 &&
        frontBoughtBase > 0
          ? frontBoughtBase
          : order.amount_in;

      const dxWithFee = sellAmt * feeMult;
      const dyOut = rx + dxWithFee > EPS ? (ry * dxWithFee) / (rx + dxWithFee) : 0;
      const effPrice = sellAmt > EPS ? dyOut / sellAmt : 0;

      if (!order.is_attacker && effPrice + EPS < order.limit_price) {
        ammReceipts.push({
          order_id: order.order_id,
          arrival_index: idx + 1,
          trader: order.trader,
          label: order.label,
          side: order.side,
          amount_in: order.amount_in,
          amount_filled: 0,
          amount_out: 0,
          refund_in: order.amount_in,
          effective_price: 0,
          price_impact_pct: 0,
          slippage_pct: 0,
          status: 'Reverted / Limit',
          is_attacker: order.is_attacker,
        });
        return;
      }

      rx += sellAmt;
      ry -= dyOut;
      if (order.is_attacker) {
        botBaseDelta -= sellAmt;
        botQuoteDelta += dyOut;
        if (idx === 0) frontSoldBase = sellAmt;
      }

      const slipPct = spot0 > EPS ? ((effPrice - spot0) / spot0) * 100 : 0;
      const impactPct = preSpot > EPS ? ((effPrice - preSpot) / preSpot) * 100 : 0;

      ammReceipts.push({
        order_id: order.order_id,
        arrival_index: idx + 1,
        trader: order.trader,
        label: order.label,
        side: order.side,
        amount_in: sellAmt,
        amount_filled: sellAmt,
        amount_out: dyOut,
        refund_in: 0,
        effective_price: effPrice,
        price_impact_pct: impactPct,
        slippage_pct: slipPct,
        status: 'Executed (Seq)',
        is_attacker: order.is_attacker,
      });
    } else {
      let quoteIn = order.amount_in;
      let dxOut = 0;

      if (
        order.is_attacker &&
        isSellSandwich &&
        idx === simOrders.length - 1 &&
        frontSoldBase > 0 &&
        frontSoldBase < rx - EPS
      ) {
        dxOut = frontSoldBase;
        quoteIn = (ry * dxOut) / ((rx - dxOut) * feeMult);
      } else {
        const dyWithFee = quoteIn * feeMult;
        dxOut = ry + dyWithFee > EPS ? (rx * dyWithFee) / (ry + dyWithFee) : 0;
      }

      const effPrice = dxOut > EPS ? quoteIn / dxOut : 0;

      if (!order.is_attacker && order.limit_price > 0 && effPrice - EPS > order.limit_price) {
        ammReceipts.push({
          order_id: order.order_id,
          arrival_index: idx + 1,
          trader: order.trader,
          label: order.label,
          side: order.side,
          amount_in: order.amount_in,
          amount_filled: 0,
          amount_out: 0,
          refund_in: order.amount_in,
          effective_price: 0,
          price_impact_pct: 0,
          slippage_pct: 0,
          status: 'Reverted / Limit',
          is_attacker: order.is_attacker,
        });
        return;
      }

      ry += quoteIn;
      rx -= dxOut;
      if (order.is_attacker) {
        botBaseDelta += dxOut;
        botQuoteDelta -= quoteIn;
        if (idx === 0) frontBoughtBase = dxOut;
      }

      const slipPct = spot0 > EPS ? ((spot0 - effPrice) / spot0) * 100 : 0;
      const impactPct = preSpot > EPS ? ((preSpot - effPrice) / preSpot) * 100 : 0;

      ammReceipts.push({
        order_id: order.order_id,
        arrival_index: idx + 1,
        trader: order.trader,
        label: order.label,
        side: order.side,
        amount_in: quoteIn,
        amount_filled: quoteIn,
        amount_out: dxOut,
        refund_in: 0,
        effective_price: effPrice,
        price_impact_pct: impactPct,
        slippage_pct: slipPct,
        status: 'Executed (Seq)',
        is_attacker: order.is_attacker,
      });
    }
  });

  const postSpot = rx > EPS ? ry / rx : spot0;
  const rawSandwichProfit = botQuoteDelta + botBaseDelta * postSpot;
  const ammSandwichProfitQuote =
    attackerOrders.length > 0 ? Math.max(0, rawSandwichProfit) : 0;

  const victimExecuted = ammReceipts.filter(
    (r) => !r.is_attacker && (r.amount_filled ?? 0) > EPS,
  );
  let weightedPriceSum = 0;
  let totalBaseWeight = 0;
  for (const vr of victimExecuted) {
    const baseVol =
      vr.side === 'SellBase' ? (vr.amount_filled ?? vr.amount_in) : vr.amount_out;
    weightedPriceSum += vr.effective_price * baseVol;
    totalBaseWeight += baseVol;
  }
  const ammVictimAvgPrice =
    totalBaseWeight > EPS ? weightedPriceSum / totalBaseWeight : spot0;

  const ammLvrLossQuote = Math.abs(rx * postSpot - initialRx * spot0) * 0.015;

  return {
    ammReceipts,
    ammVictimAvgPrice,
    ammSandwichProfitQuote,
    ammLvrLossQuote,
  };
}

/**
 * Computes the honest, signed Quote-denominated execution difference between
 * FairBatch receipts and Sequential AMM receipts (positive = FairBatch delivered
 * more total value to non-attacker traders; negative = un-sandwiched sequential
 * AMM delivered more, e.g. one-sided flow where FM-AMM charges the post-trade
 * marginal clearing price to capture LVR for LPs).
 */
export function computeSignedTraderValueDiff(
  fairbatchReceipts: ExecutionReceiptDto[],
  ammReceipts: ExecutionReceiptDto[],
  clearingPrice: number,
): number {
  let fairbatchVictimQuoteValue = 0;
  let ammVictimQuoteValue = 0;

  for (const fb of fairbatchReceipts) {
    if (fb.is_attacker) continue;
    if (fb.side === 'SellBase') {
      fairbatchVictimQuoteValue += fb.amount_out + (fb.refund_in ?? 0) * clearingPrice;
    } else {
      fairbatchVictimQuoteValue += fb.amount_out * clearingPrice + (fb.refund_in ?? 0);
    }
  }
  for (const am of ammReceipts) {
    if (am.is_attacker) continue;
    if (am.side === 'SellBase') {
      ammVictimQuoteValue += am.amount_out + (am.refund_in ?? 0) * clearingPrice;
    } else {
      ammVictimQuoteValue += am.amount_out * clearingPrice + (am.refund_in ?? 0);
    }
  }

  return fairbatchVictimQuoteValue - ammVictimQuoteValue;
}

export function computeBatchSettlement(
  batchId: number,
  rx: number,
  ry: number,
  orders: OrderDto[],
  slashedBondsCount = 0,
  feeBps = DEFAULT_FEE_BPS,
  includeVirtualSandwich = false,
): BatchSettlementDto {
  const reserves_before = snapshotReserves(rx, ry);
  const eq = solveEquilibrium(rx, ry, orders);
  const p = eq.clearingPrice;

  const fills: FillOutcomeDto[] = [];
  const fairbatchReceipts: ExecutionReceiptDto[] = [];

  orders.forEach((order, idx) => {
    const frac =
      order.side === 'SellBase'
        ? (eq.sellerFillFractions.get(order.order_id) ?? 0)
        : (eq.buyerFillFractions.get(order.order_id) ?? 0);

    let status: FillStatus = 'OutOfMoneyRefund';
    if (frac >= 1 - 1e-6) {
      status = 'Filled';
    } else if (frac > 1e-6) {
      status = 'PartialFill';
    }

    const amount_filled =
      status === 'Filled'
        ? order.amount_in
        : status === 'PartialFill'
          ? floor6(order.amount_in * frac)
          : 0;
    const refund_in =
      status === 'Filled'
        ? 0
        : status === 'OutOfMoneyRefund'
          ? order.amount_in
          : Math.max(0, floor6(order.amount_in - amount_filled));

    const payout_out =
      amount_filled > EPS && p > EPS
        ? order.side === 'SellBase'
          ? floor6(amount_filled * p)
          : floor6(amount_filled / p)
        : 0;

    const effective_price = amount_filled > EPS ? p : 0;

    fills.push({
      order_id: order.order_id,
      trader: order.trader,
      label: order.label,
      side: order.side,
      status,
      amount_in: order.amount_in,
      amount_filled,
      payout_out,
      refund_in,
      limit_price: order.limit_price,
      effective_price,
      is_attacker: order.is_attacker,
    });

    const spot0 = reserves_before.spot_price > EPS ? reserves_before.spot_price : p;
    const slipPct =
      amount_filled > EPS && spot0 > EPS
        ? order.side === 'SellBase'
          ? ((p - spot0) / spot0) * 100
          : ((spot0 - p) / spot0) * 100
        : 0;

    fairbatchReceipts.push({
      order_id: order.order_id,
      arrival_index: idx + 1,
      trader: order.trader,
      label: order.label,
      side: order.side,
      amount_in: order.amount_in,
      amount_filled,
      amount_out: payout_out,
      refund_in,
      effective_price,
      price_impact_pct: slipPct,
      slippage_pct: slipPct,
      status:
        status === 'Filled'
          ? '100% Filled'
          : status === 'PartialFill'
            ? 'Pro-Rata Partial'
            : 'Refunded (OTM)',
      is_attacker: order.is_attacker,
    });
  });

  const sFilled = eq.totalFilledSellBase;
  const dFilled = eq.totalFilledBuyQuote;
  const dFilledInBase = p > EPS ? dFilled / p : 0;

  const cow_matched_base = Math.min(sFilled, dFilledInBase);
  const cow_matched_quote = cow_matched_base * p;

  const grossBaseFlow = sFilled + dFilledInBase;
  const cow_ratio_pct =
    grossBaseFlow > EPS
      ? Math.min(100, ((2 * cow_matched_base) / grossBaseFlow) * 100)
      : 0;

  const pool_delta_base = sFilled - dFilledInBase;
  const pool_delta_quote = dFilled - p * sFilled;

  const rxAfter = Math.max(0, rx + pool_delta_base);
  const ryAfter = Math.max(0, ry + pool_delta_quote);
  const reserves_after = snapshotReserves(rxAfter, ryAfter);

  const k_invariant_growth = Math.max(
    0,
    reserves_after.k_invariant - reserves_before.k_invariant,
  );
  const k_invariant_growth_pct =
    reserves_before.k_invariant > EPS
      ? (k_invariant_growth / reserves_before.k_invariant) * 100
      : 0;

  const { supply_curve, demand_curve } = buildSupplyDemandCurves(
    orders,
    reserves_before.spot_price,
  );

  const ammSim = simulateSequentialAmm(rx, ry, orders, feeBps, includeVirtualSandwich);
  const user_value_saved_quote = computeSignedTraderValueDiff(
    fairbatchReceipts,
    ammSim.ammReceipts,
    p,
  );

  const comparison: ComparisonDto = {
    fee_bps: feeBps,
    amm_victim_avg_price: ammSim.ammVictimAvgPrice,
    fairbatch_uniform_price: p,
    user_value_saved_quote,
    amm_sandwich_profit_quote: ammSim.ammSandwichProfitQuote,
    fairbatch_sandwich_profit_quote: 0.0,
    amm_lvr_loss_quote: ammSim.ammLvrLossQuote,
    amm_receipts: ammSim.ammReceipts,
    fairbatch_receipts: fairbatchReceipts,
  };

  return {
    batch_id: batchId,
    clearing_price: p,
    total_sell_base_eligible: sFilled,
    total_buy_quote_eligible: dFilled,
    cow_matched_base,
    cow_matched_quote,
    cow_ratio_pct,
    pool_delta_base,
    pool_delta_quote,
    reserves_before,
    reserves_after,
    k_invariant_growth,
    k_invariant_growth_pct,
    slashed_bonds_count: slashedBondsCount,
    fills,
    supply_curve,
    demand_curve,
    comparison,
  };
}

export interface SandwichSimOutput {
  spot: number;
  side: OrderSide;
  amountIn: number;
  slippagePct: number;
  limitPrice: number;
  feeBps: number;
  // Column 1: Normal sequential 0.30% x*y=k AMM without attacker
  ammPlainPrice: number;
  ammPlainOut: number;
  ammPlainLpFeeQuote: number;
  // Column 2: Normal sequential 0.30% x*y=k AMM with slippage-capped sandwich bot
  frontRunAmount: number;
  frontRunIsBase: boolean;
  botProfitable: boolean;
  victimExceedsSlippageWithoutAttack: boolean;
  ammSandwichedPrice: number;
  ammSandwichedOut: number;
  ammBotProfitQuote: number;
  victimLossVsPlainQuote: number;
  extraLpFeesQuote: number;
  totalSandwichedLpFeesQuote: number;
  // Column 3: FairBatch uniform clearing round
  fairbatchPrice: number;
  fairbatchOut: number;
  fairbatchBotProfitQuote: number;
  fairbatchExceedsLimit: boolean;
  // Honest signed comparisons (all reconcile: fairbatchVsAttacked === fairbatchVsPlain + victimLossVsPlain)
  fairbatchVsAttackedQuote: number;
  fairbatchVsPlainQuote: number;
  fairbatchVsPlainPct: number;
  userSavedQuote: number;
  settlement: BatchSettlementDto;
}

/**
 * Pure client-side simulation comparing a single user swap across three baselines
 * using the live on-chain reserves:
 *   1. Normal AMM, no attacker (0.30% constant-product x*y=k)
 *   2. Normal AMM + optimal sandwich bot capped by the user's slippage tolerance
 *      so the victim's trade stays valid (never reverts)
 *   3. FairBatch uniform batch clearing: p* = (R_y + 2*D_y) / (R_x + 2*S_x)
 *
 * Accounting identities satisfied for both SellBase (exact quote) and BuyBase
 * (quote-equivalent valued at the unattacked AMM effective price):
 *   - victimLossVsPlainQuote === ammBotProfitQuote + extraLpFeesQuote
 *   - fairbatchVsAttackedQuote === fairbatchVsPlainQuote + victimLossVsPlainQuote
 */
export function runSandwichSimulation(params: {
  rx: number;
  ry: number;
  side: OrderSide;
  amountIn: number;
  slippagePct?: number;
  feeBps?: number;
}): SandwichSimOutput {
  const rx = Math.max(params.rx, 1e-6);
  const ry = Math.max(params.ry, 1e-6);
  const spot = ry / rx;
  const feeBps = params.feeBps ?? DEFAULT_FEE_BPS;
  const feeMult = (10_000 - feeBps) / 10_000;
  const slippagePct = Math.max(0.5, Math.min(45, params.slippagePct ?? 8));
  const slippage = slippagePct / 100;
  const limitPrice =
    params.side === 'SellBase' ? spot * (1 - slippage) : spot * (1 + slippage);
  const v = Math.max(params.amountIn, 0);

  const userOrder: OrderDto = {
    order_id: 1,
    trader: '0x0000000000000000000000000000000000000001',
    label: 'Your simulated trade',
    side: params.side,
    amount_in: v,
    limit_price: limitPrice,
    submission_type: 'Direct',
    is_attacker: false,
  };

  // Column 3: FairBatch uniform clearing (using exact same formula as src/clearing.fe)
  const settlement = computeBatchSettlement(0, rx, ry, [userOrder], 0, feeBps, false);
  const fairbatchPrice =
    params.side === 'SellBase' ? ry / (rx + 2 * v) : (ry + 2 * v) / rx;
  const fairbatchExceedsLimit =
    params.side === 'SellBase'
      ? fairbatchPrice + EPS < limitPrice
      : fairbatchPrice - EPS > limitPrice;
  const fairbatchOut =
    v <= EPS || fairbatchPrice <= EPS
      ? 0
      : params.side === 'SellBase'
        ? v * fairbatchPrice
        : v / fairbatchPrice;

  if (params.side === 'SellBase') {
    // Column 1: Normal AMM, no attacker (0.30% x*y=k)
    const plainOut = (ry * (v * feeMult)) / (rx + v * feeMult);
    const plainOutZeroFee = (ry * v) / (rx + v);
    const ammPlainPrice = v > EPS ? plainOut / v : spot;
    const ammPlainLpFeeQuote = Math.max(0, plainOutZeroFee - plainOut);

    // Evaluate a SellBase front-run of size `f` fWETH followed by victim `v` fWETH,
    // followed by exact-out back-run buying back `f` fWETH so the bot ends with 0 base delta.
    const evalSell = (f: number) => {
      let x = rx;
      let y = ry;
      const q1 = f > 0 ? (y * (f * feeMult)) / (x + f * feeMult) : 0;
      x += f;
      y -= q1;
      const vOut = (y * (v * feeMult)) / (x + v * feeMult);
      const vEffP = v > EPS ? vOut / v : spot;
      x += v;
      y -= vOut;
      const q2 = f > 0 && x > f + EPS ? (y * f) / ((x - f) * feeMult) : 0;
      const botProfit = q1 - q2;
      return { f, vOut, vEffP, botProfit };
    };

    const victimExceedsSlippageWithoutAttack = ammPlainPrice + EPS < limitPrice;
    let bestF = 0;
    let bestEval = evalSell(0);

    if (!victimExceedsSlippageWithoutAttack && v > EPS) {
      // Binary-search max front-run fMax keeping victim effective price >= limitPrice
      let lo = 0;
      let hi = rx * 5;
      for (let i = 0; i < 80; i += 1) {
        const mid = (lo + hi) / 2;
        if (evalSell(mid).vEffP >= limitPrice) {
          lo = mid;
        } else {
          hi = mid;
        }
      }
      const fMax = lo;

      // Ternary search for profit-maximizing f* in [0, fMax] (unimodal profit curve)
      let a = 0;
      let b = fMax;
      for (let i = 0; i < 80; i += 1) {
        const m1 = a + (b - a) / 3;
        const m2 = b - (b - a) / 3;
        if (evalSell(m1).botProfit < evalSell(m2).botProfit) {
          a = m1;
        } else {
          b = m2;
        }
      }
      const candF = (a + b) / 2;
      const cand = evalSell(candF);
      const edgeMax = evalSell(fMax);
      const chosen = edgeMax.botProfit > cand.botProfit ? edgeMax : cand;
      if (chosen.botProfit > 1e-6) {
        bestF = chosen.f;
        bestEval = chosen;
      }
    }

    const botProfitable = bestF > EPS && bestEval.botProfit > 1e-6;
    const ammSandwichedOut = botProfitable ? bestEval.vOut : plainOut;
    const ammSandwichedPrice = botProfitable ? bestEval.vEffP : ammPlainPrice;
    const ammBotProfitQuote = botProfitable ? bestEval.botProfit : 0;

    // Exact conservation: final R_x = rx + v in both plain and sandwiched AMM,
    // so (plainOut - ammSandwichedOut) === ammBotProfitQuote + extraLpFeesQuote identically!
    const victimLossVsPlainQuote = Math.max(0, plainOut - ammSandwichedOut);
    const extraLpFeesQuote = Math.max(0, victimLossVsPlainQuote - ammBotProfitQuote);
    const totalSandwichedLpFeesQuote = ammPlainLpFeeQuote + extraLpFeesQuote;

    const fairbatchVsPlainQuote = fairbatchOut - plainOut;
    const fairbatchVsPlainPct = plainOut > EPS ? (fairbatchVsPlainQuote / plainOut) * 100 : 0;
    const fairbatchVsAttackedQuote = fairbatchOut - ammSandwichedOut;

    return {
      spot,
      side: params.side,
      amountIn: v,
      slippagePct,
      limitPrice,
      feeBps,
      ammPlainPrice,
      ammPlainOut: plainOut,
      ammPlainLpFeeQuote,
      frontRunAmount: bestF,
      frontRunIsBase: true,
      botProfitable,
      victimExceedsSlippageWithoutAttack,
      ammSandwichedPrice,
      ammSandwichedOut,
      ammBotProfitQuote,
      victimLossVsPlainQuote,
      extraLpFeesQuote,
      totalSandwichedLpFeesQuote,
      fairbatchPrice,
      fairbatchOut,
      fairbatchBotProfitQuote: 0,
      fairbatchExceedsLimit,
      fairbatchVsAttackedQuote,
      fairbatchVsPlainQuote,
      fairbatchVsPlainPct,
      userSavedQuote: fairbatchVsAttackedQuote,
      settlement,
    };
  }

  // BuyBase: victim spends `v` quote to buy base
  const plainOut = (rx * (v * feeMult)) / (ry + v * feeMult);
  const plainOutZeroFee = (rx * v) / (ry + v);
  const ammPlainPrice = plainOut > EPS ? v / plainOut : spot;
  const ammPlainLpFeeQuote = Math.max(0, (plainOutZeroFee - plainOut) * ammPlainPrice);

  // Bot front-runs spending `f` quote -> receives `b1` base; victim spends `v` quote -> receives `vOut` base;
  // bot back-runs selling exact `b1` base -> receives `q2` quote. Bot ends with 0 base delta and (q2 - f) quote profit.
  const evalBuy = (f: number) => {
    let x = rx;
    let y = ry;
    const b1 = f > 0 ? (x * (f * feeMult)) / (y + f * feeMult) : 0;
    x -= b1;
    y += f;
    const vOut = (x * (v * feeMult)) / (y + v * feeMult);
    const vEffP = vOut > EPS ? v / vOut : Number.POSITIVE_INFINITY;
    x -= vOut;
    y += v;
    const q2 = b1 > 0 ? (y * (b1 * feeMult)) / (x + b1 * feeMult) : 0;
    const botProfit = q2 - f;
    return { f, b1, vOut, vEffP, botProfit };
  };

  const victimExceedsSlippageWithoutAttack = ammPlainPrice - EPS > limitPrice;
  let bestF = 0;
  let bestEval = evalBuy(0);

  if (!victimExceedsSlippageWithoutAttack && v > EPS) {
    // Binary-search max front-run fMax keeping victim effective price <= limitPrice
    let lo = 0;
    let hi = ry * 5;
    for (let i = 0; i < 80; i += 1) {
      const mid = (lo + hi) / 2;
      if (evalBuy(mid).vEffP <= limitPrice) {
        lo = mid;
      } else {
        hi = mid;
      }
    }
    const fMax = lo;

    let a = 0;
    let b = fMax;
    for (let i = 0; i < 80; i += 1) {
      const m1 = a + (b - a) / 3;
      const m2 = b - (b - a) / 3;
      if (evalBuy(m1).botProfit < evalBuy(m2).botProfit) {
        a = m1;
      } else {
        b = m2;
      }
    }
    const candF = (a + b) / 2;
    const cand = evalBuy(candF);
    const edgeMax = evalBuy(fMax);
    const chosen = edgeMax.botProfit > cand.botProfit ? edgeMax : cand;
    if (chosen.botProfit > 1e-6) {
      bestF = chosen.f;
      bestEval = chosen;
    }
  }

  const botProfitable = bestF > EPS && bestEval.botProfit > 1e-6;
  const ammSandwichedOut = botProfitable ? bestEval.vOut : plainOut;
  const ammSandwichedPrice = botProfitable ? bestEval.vEffP : ammPlainPrice;
  const ammBotProfitQuote = botProfitable ? bestEval.botProfit : 0;

  // Value all base-token output differences consistently at the unattacked AMM price
  const victimLossVsPlainQuote = Math.max(0, (plainOut - ammSandwichedOut) * ammPlainPrice);
  const extraLpFeesQuote = Math.max(0, victimLossVsPlainQuote - ammBotProfitQuote);
  const totalSandwichedLpFeesQuote = ammPlainLpFeeQuote + extraLpFeesQuote;

  const fairbatchVsPlainQuote = (fairbatchOut - plainOut) * ammPlainPrice;
  const fairbatchVsPlainPct = plainOut > EPS ? ((fairbatchOut - plainOut) / plainOut) * 100 : 0;
  const fairbatchVsAttackedQuote = (fairbatchOut - ammSandwichedOut) * ammPlainPrice;

  return {
    spot,
    side: params.side,
    amountIn: v,
    slippagePct,
    limitPrice,
    feeBps,
    ammPlainPrice,
    ammPlainOut: plainOut,
    ammPlainLpFeeQuote,
    frontRunAmount: bestF,
    frontRunIsBase: false,
    botProfitable,
    victimExceedsSlippageWithoutAttack,
    ammSandwichedPrice,
    ammSandwichedOut,
    ammBotProfitQuote,
    victimLossVsPlainQuote,
    extraLpFeesQuote,
    totalSandwichedLpFeesQuote,
    fairbatchPrice,
    fairbatchOut,
    fairbatchBotProfitQuote: 0,
    fairbatchExceedsLimit,
    fairbatchVsAttackedQuote,
    fairbatchVsPlainQuote,
    fairbatchVsPlainPct,
    userSavedQuote: fairbatchVsAttackedQuote,
    settlement,
  };
}
